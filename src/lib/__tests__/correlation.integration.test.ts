// Integration tests for the pairwise correlation matrix query in
// `src/lib/queries.ts` (`getCorrelationMatrix`).
//
// Same extract-and-execute strategy as the other integration files:
// the per-pair SQL is duplicated inline and run against a real
// in-memory DuckDB engine via `bootFixture`. The bug class we protect
// against is "the SQL string is invalid" plus "the math doesn't pin
// to the textbook value when fed a deterministic input".
//
// What we exercise:
//   - Two perfectly correlated series (identical closes) → r = +1.0,
//     bars_overlap = N - 1
//   - Two perfectly inversely correlated series (mirrored log returns)
//     → r = -1.0
//   - Insufficient overlap (< 30 bars) → caller treats as null
//   - Independent (orthogonal) series produce |r| << 1, bars_overlap
//     reflects the JOIN size when histories don't fully overlap
//
// These tests duplicate the per-pair SQL rather than calling the
// production helper because vitest can't load DuckDB-WASM (the
// production helper uses `getConn` which connects to the WASM
// engine). The duplication is mechanical — if the production query
// changes shape, the test should be updated in lockstep.

import { describe, it, expect, afterEach } from 'vitest';
import {
  bootFixture,
  insertSyntheticOhlcv,
  type FixtureDb,
} from './duckdb-fixture';

let fixture: FixtureDb | null = null;

afterEach(async () => {
  if (fixture) {
    await fixture.close();
    fixture = null;
  }
});

/**
 * Inline the per-pair correlation SQL. Mirrors the body of
 * `getCorrelationMatrix` in `src/lib/queries.ts`. Tickers are
 * interpolated directly (validated upstream by the production
 * helper's TICKER_RE check; tests use synthetic safe tickers).
 */
function pairCorrelationSql(a: string, b: string, windowBars = 60): string {
  return `
    WITH returns_a AS (
      SELECT
        dt,
        ln(close / NULLIF(LAG(close) OVER (ORDER BY dt), 0)) AS r
      FROM ohlcv WHERE ticker = '${a}'
    ),
    returns_b AS (
      SELECT
        dt,
        ln(close / NULLIF(LAG(close) OVER (ORDER BY dt), 0)) AS r
      FROM ohlcv WHERE ticker = '${b}'
    ),
    paired AS (
      SELECT a.dt, a.r AS ra, b.r AS rb,
        ROW_NUMBER() OVER (ORDER BY a.dt DESC) AS rn
      FROM returns_a a
      JOIN returns_b b ON a.dt = b.dt
      WHERE a.r IS NOT NULL AND b.r IS NOT NULL
    ),
    windowed AS (
      SELECT * FROM paired WHERE rn <= ${windowBars}
    )
    SELECT
      CORR(ra, rb) AS correlation,
      COUNT(*) AS bars_overlap
    FROM windowed
  `;
}

/**
 * Insert an explicit close-price series for `ticker`. Open/high/low
 * are deterministically derived from the close (correlation cares
 * only about close-to-close log returns). Used where we need exact
 * control over the price path — the synthetic helper's linear-trend
 * shape isn't expressive enough for the inverse-correlation test.
 */
function insertExplicitCloses(
  fixture: FixtureDb,
  ticker: string,
  closes: number[],
  startDate = '2024-01-01',
): Promise<unknown> {
  const startMs = new Date(startDate + 'T00:00:00Z').getTime();
  const dayMs = 86_400_000;
  const values = closes.map((close, i) => {
    const dt = new Date(startMs + i * dayMs).toISOString().slice(0, 10);
    const open = close - 0.05;
    const high = close + 0.2;
    const low = close - 0.2;
    return `('${ticker}', DATE '${dt}', ${open.toFixed(6)}, ${high.toFixed(6)}, ${low.toFixed(6)}, ${close.toFixed(6)}, 1000000)`;
  });
  return fixture.query(
    `INSERT INTO ohlcv (ticker, dt, open, high, low, close, volume) VALUES ${values.join(', ')}`,
  );
}

describe('getCorrelationMatrix (integration)', () => {
  it('returns 1.0 for two perfectly correlated series', async () => {
    fixture = await bootFixture();
    // Two tickers with IDENTICAL close paths → identical log returns
    // → Pearson correlation must be exactly 1.0. Using the synthetic
    // helper with noise=0 gives a deterministic linear trend; same
    // params for both tickers → same close sequence.
    await insertSyntheticOhlcv(fixture, 'AAA', 60, { trend: 1, noise: 0 });
    await insertSyntheticOhlcv(fixture, 'BBB', 60, { trend: 1, noise: 0 });

    const rows = await fixture.query(pairCorrelationSql('AAA', 'BBB', 60));
    expect(rows.length).toBe(1);
    // 60 closes → 59 log returns; INNER JOIN keeps all 59 (dates match).
    expect(Number(rows[0].bars_overlap)).toBe(59);
    expect(Number(rows[0].correlation)).toBeCloseTo(1.0, 5);
  });

  it('returns -1.0 for perfectly inversely correlated log returns', async () => {
    fixture = await bootFixture();
    // Build two close series whose daily log returns are the exact
    // negatives of each other. Series A: log returns alternate +0.01,
    // -0.01, +0.01, ... Series B: same magnitudes, opposite signs.
    // Pearson correlation of (x_t) and (-x_t) is -1.0.
    const startA = 100;
    const startB = 100;
    const closesA: number[] = [startA];
    const closesB: number[] = [startB];
    for (let i = 1; i < 60; i++) {
      const sign = i % 2 === 1 ? 1 : -1;
      const r = sign * 0.01;
      closesA.push(closesA[i - 1] * Math.exp(r));
      closesB.push(closesB[i - 1] * Math.exp(-r));
    }
    await insertExplicitCloses(fixture, 'POS', closesA);
    await insertExplicitCloses(fixture, 'NEG', closesB);

    const rows = await fixture.query(pairCorrelationSql('POS', 'NEG', 60));
    expect(rows.length).toBe(1);
    expect(Number(rows[0].bars_overlap)).toBe(59);
    expect(Number(rows[0].correlation)).toBeCloseTo(-1.0, 5);
  });

  it('handles tickers with insufficient overlap (caller treats as null)', async () => {
    fixture = await bootFixture();
    // AAA has 60 bars, BBB has only 5. The INNER JOIN by date keeps
    // only the dates that exist in both → 5 paired rows → 4 log
    // returns (one is dropped by the LAG warmup). The production
    // helper's null sentinel triggers when bars_overlap < 30; we
    // assert the raw COUNT here so the threshold logic stays in
    // queries.ts and we just verify the SQL produces the expected
    // shape.
    await insertSyntheticOhlcv(fixture, 'AAA', 60, { trend: 1, noise: 0 });
    await insertSyntheticOhlcv(fixture, 'BBB', 5, { trend: 1, noise: 0 });

    const rows = await fixture.query(pairCorrelationSql('AAA', 'BBB', 60));
    expect(rows.length).toBe(1);
    // 5 BBB bars → 4 paired log returns (LAG drops bar 1). Well below
    // the 30-bar threshold the production helper uses for null.
    const bars = Number(rows[0].bars_overlap);
    expect(bars).toBeLessThan(30);
    expect(bars).toBe(4);
  });

  it('respects the windowBars cap (only the most recent N pairs counted)', async () => {
    fixture = await bootFixture();
    // 200 bars per ticker, identical paths. windowBars=60 should clip
    // bars_overlap at exactly 60 (not 199). Pins the ROW_NUMBER /
    // rn <= windowBars window-trim behaviour — easy to break by
    // forgetting the trim and getting "all-time" correlation instead.
    await insertSyntheticOhlcv(fixture, 'AAA', 200, { trend: 1, noise: 0 });
    await insertSyntheticOhlcv(fixture, 'BBB', 200, { trend: 1, noise: 0 });

    const rows = await fixture.query(pairCorrelationSql('AAA', 'BBB', 60));
    expect(rows.length).toBe(1);
    expect(Number(rows[0].bars_overlap)).toBe(60);
    expect(Number(rows[0].correlation)).toBeCloseTo(1.0, 5);
  });

  it('produces near-zero correlation for independent noisy series', async () => {
    fixture = await bootFixture();
    // Two synthetic series with different RNG seeds. The signal-to-
    // noise ratio matters — pure noise (trend=0) at any meaningful
    // amplitude makes the daily log returns nearly independent
    // between tickers. We don't assert "exactly 0" (sample
    // correlation has variance) but |r| should comfortably be < 0.5.
    await insertSyntheticOhlcv(fixture, 'AAA', 120, {
      trend: 0,
      noise: 1,
      seed: 1,
    });
    await insertSyntheticOhlcv(fixture, 'BBB', 120, {
      trend: 0,
      noise: 1,
      seed: 9999,
    });

    const rows = await fixture.query(pairCorrelationSql('AAA', 'BBB', 60));
    expect(rows.length).toBe(1);
    const r = Number(rows[0].correlation);
    expect(Number.isFinite(r)).toBe(true);
    expect(Math.abs(r)).toBeLessThan(0.5);
  });
});
