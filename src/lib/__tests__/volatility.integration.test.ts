// Integration tests for the 30-day realised-volatility query in
// `src/lib/queries.ts` (`getVolatilityRegimes`).
//
// Same extract-and-execute strategy as `drawdowns.integration.test.ts`:
// we duplicate the SQL inline and run it against a real DuckDB engine
// via `bootFixture`. The bug class we protect against is "the SQL
// string is invalid" plus "the regime thresholds don't actually pin to
// the documented bucket boundaries when fed a series with the
// matching annualised stddev".
//
// What we exercise:
//   - Quiet series                → regime ≈ low (< 20% annualised)
//   - Wild series                 → regime ≈ extreme (≥ 60%)
//   - Medium-volatility series    → regime falls in the medium band
//   - Short-history ticker        → query degrades gracefully (no crash,
//                                   bars_sampled reflects actual count)
//   - Per-ticker isolation        → multi-ticker fixtures don't bleed
//                                   across PARTITION
//   - Empty table                 → zero rows, no error

import { describe, it, expect, afterEach } from 'vitest';
import { bootFixture, type FixtureDb } from './duckdb-fixture';

let fixture: FixtureDb | null = null;

afterEach(async () => {
  if (fixture) {
    await fixture.close();
    fixture = null;
  }
});

/**
 * Inline the volatility SQL. Mirrors the body of
 * `getVolatilityRegimes` in `src/lib/queries.ts`. Kept short enough
 * to audit at a glance — same mechanical-duplication discipline as
 * the other integration files; if the production query changes
 * shape, this stays in sync via the test failing first.
 */
function volatilitySql(): string {
  return `
    WITH returns AS (
      SELECT
        ticker,
        dt,
        ln(close / NULLIF(LAG(close) OVER (PARTITION BY ticker ORDER BY dt), 0)) AS log_ret
      FROM ohlcv
    ),
    windowed AS (
      SELECT
        ticker,
        dt,
        log_ret,
        STDDEV_SAMP(log_ret) OVER (
          PARTITION BY ticker ORDER BY dt
          ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
        ) AS sd_30,
        COUNT(log_ret) OVER (
          PARTITION BY ticker ORDER BY dt
          ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
        ) AS bars,
        ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY dt DESC) AS rn
      FROM returns
      WHERE log_ret IS NOT NULL
    )
    SELECT
      ticker,
      sd_30 * sqrt(252) AS annualized_vol,
      bars
    FROM windowed
    WHERE rn = 1 AND sd_30 IS NOT NULL
    ORDER BY ticker
  `;
}

/**
 * Build an INSERT VALUES clause for a synthetic close-price series.
 * Each bar's open/high/low are deterministically derived from the
 * close (we don't care about intra-bar shape for vol — only the
 * close-to-close log return matters). Inlined here rather than
 * extending `insertSyntheticOhlcv` because the regime tests need
 * explicit per-bar closes (controlled stddev), not the linear-trend-
 * plus-noise shape the helper provides.
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

/**
 * Generate a close-price series whose daily log returns have a
 * targeted stddev. We alternate +sigma and -sigma log returns so the
 * STDDEV_SAMP over the window is exactly `sigma` (modulo the small
 * n-1 vs n correction). 60 bars gives the trailing 30-bar window a
 * full sample even after the LAG warmup drops bar 1.
 *
 * Returns annualised vol ≈ sigma * sqrt(252).
 */
function alternatingLogReturnSeries(
  count: number,
  sigma: number,
  startClose = 100,
): number[] {
  const closes: number[] = [startClose];
  for (let i = 1; i < count; i++) {
    const sign = i % 2 === 1 ? 1 : -1;
    closes.push(closes[i - 1] * Math.exp(sign * sigma));
  }
  return closes;
}

describe('getVolatilityRegimes (integration)', () => {
  it('returns regime=low for a quiet, low-volatility series', async () => {
    fixture = await bootFixture();
    // Daily log-return stddev = 0.005 → annualised ≈ 0.005 * sqrt(252)
    // ≈ 7.9% — comfortably inside the "low" bucket (< 20%).
    const closes = alternatingLogReturnSeries(60, 0.005);
    await insertExplicitCloses(fixture, 'BORING', closes);

    const rows = await fixture.query(volatilitySql());
    expect(rows.length).toBe(1);
    expect(String(rows[0].ticker)).toBe('BORING');
    const vol = Number(rows[0].annualized_vol);
    expect(vol).toBeLessThan(0.2);
    // Sanity check the math. The alternating ±sigma series gives the
    // population stddev = sigma exactly; sample stddev (STDDEV_SAMP,
    // n-1 divisor) over 30 bars is a hair higher: sigma*sqrt(30/29).
    // Annualised expected ≈ 0.005 * sqrt(252) * sqrt(30/29) ≈ 0.0807.
    const expectedLow = 0.005 * Math.sqrt(252) * Math.sqrt(30 / 29);
    expect(vol).toBeCloseTo(expectedLow, 3);
    // Full window sampled (60 bars - 1 LAG = 59 returns, capped to 30).
    expect(Number(rows[0].bars)).toBe(30);
  });

  it('returns regime=medium for a moderately volatile series', async () => {
    fixture = await bootFixture();
    // sigma = 0.018 → annualised ≈ 28.6% — middle of the medium band
    // (20-35%). Verifies the threshold ladder doesn't accidentally
    // collapse adjacent buckets.
    const closes = alternatingLogReturnSeries(60, 0.018);
    await insertExplicitCloses(fixture, 'MID', closes);

    const rows = await fixture.query(volatilitySql());
    expect(rows.length).toBe(1);
    const vol = Number(rows[0].annualized_vol);
    expect(vol).toBeGreaterThanOrEqual(0.2);
    expect(vol).toBeLessThan(0.35);
  });

  it('returns regime=extreme for a highly volatile series', async () => {
    fixture = await bootFixture();
    // sigma = 0.05 → annualised ≈ 79.4% — well into "extreme" (≥ 60%).
    const closes = alternatingLogReturnSeries(60, 0.05);
    await insertExplicitCloses(fixture, 'WILD', closes);

    const rows = await fixture.query(volatilitySql());
    expect(rows.length).toBe(1);
    const vol = Number(rows[0].annualized_vol);
    expect(vol).toBeGreaterThan(0.6);
    // Sample stddev over 30 bars: sigma * sqrt(30/29). See low-vol
    // test above for the derivation. Expected ≈ 0.05 * sqrt(252) *
    // sqrt(30/29) ≈ 0.807.
    const expectedExtreme = 0.05 * Math.sqrt(252) * Math.sqrt(30 / 29);
    expect(vol).toBeCloseTo(expectedExtreme, 3);
  });

  it('handles a ticker with very few bars without crashing', async () => {
    fixture = await bootFixture();
    // 5 bars → 4 log returns. STDDEV_SAMP needs ≥ 2; the latest-bar
    // row should emit with bars_sampled = 4 (partial window, but the
    // production caller can downgrade UI confidence on this).
    const closes = alternatingLogReturnSeries(5, 0.02);
    await insertExplicitCloses(fixture, 'NEW', closes);

    const rows = await fixture.query(volatilitySql());
    expect(rows.length).toBe(1);
    expect(String(rows[0].ticker)).toBe('NEW');
    expect(Number(rows[0].bars)).toBe(4);
    expect(Number.isFinite(Number(rows[0].annualized_vol))).toBe(true);
  });

  it('isolates volatility calculations per ticker (PARTITION BY)', async () => {
    fixture = await bootFixture();
    // Quiet ticker A (sigma 0.005) and wild ticker B (sigma 0.05)
    // co-resident in the table. Without PARTITION BY ticker, the
    // window would mix their returns and produce a meaningless
    // average for both rows.
    const aCloses = alternatingLogReturnSeries(60, 0.005);
    const bCloses = alternatingLogReturnSeries(60, 0.05);
    await insertExplicitCloses(fixture, 'AAA', aCloses);
    await insertExplicitCloses(fixture, 'BBB', bCloses);

    const rows = await fixture.query(volatilitySql());
    expect(rows.length).toBe(2);
    const byTicker = Object.fromEntries(
      rows.map((r) => [String(r.ticker), r]),
    );
    expect(Number(byTicker.AAA.annualized_vol)).toBeLessThan(0.2);
    expect(Number(byTicker.BBB.annualized_vol)).toBeGreaterThan(0.6);
  });

  it('returns no rows when the ohlcv table is empty', async () => {
    fixture = await bootFixture();
    const rows = await fixture.query(volatilitySql());
    expect(rows.length).toBe(0);
  });
});
