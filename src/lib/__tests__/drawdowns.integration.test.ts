// Integration tests for the rolling-252-day drawdown query in
// `src/lib/queries.ts` (`getDrawdowns`).
//
// Same strategy as `queries.integration.test.ts` and the other
// integration files: we duplicate the SQL inline (kept in sync with
// the production module) and execute it against a real DuckDB engine
// via `bootFixture`. The bug class we protect against is "the SQL
// string is invalid" — JS marshalling is covered by the production
// runtime path and not what these tests are for.
//
// What we exercise:
//   - At-high case        → drawdown ≈ 0
//   - In-drawdown case    → drawdown is negative with the expected magnitude
//   - Short-history case  → window degrades gracefully (no NaN, no zero rows)
//   - Per-ticker isolation → multi-ticker fixtures don't bleed across PARTITION
//   - Days-since-high     → counts trading bars since the high was set

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
 * Inline the drawdown SQL. Mirrors the body of `getDrawdowns` in
 * `src/lib/queries.ts`. Kept short enough to audit at a glance —
 * if the production query changes shape, this stays in sync the same
 * way the other integration tests do (mechanical duplication, not a
 * pluggable adapter).
 */
function drawdownsSql(): string {
  return `
    WITH ranked AS (
      SELECT
        ticker,
        dt,
        close,
        MAX(close) OVER (
          PARTITION BY ticker ORDER BY dt
          ROWS BETWEEN 251 PRECEDING AND CURRENT ROW
        ) AS rolling_high,
        ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY dt DESC) AS rn
      FROM ohlcv
    ),
    high_dates AS (
      SELECT
        ticker,
        MAX(dt) AS high_dt
      FROM ranked
      WHERE rn <= 252 AND close = rolling_high
      GROUP BY ticker
    )
    SELECT
      r.ticker,
      r.close AS latest_close,
      r.rolling_high,
      100.0 * (r.close - r.rolling_high) / r.rolling_high AS drawdown_pct,
      (
        SELECT COUNT(*) FROM ohlcv o2
        WHERE o2.ticker = r.ticker
          AND o2.dt > h.high_dt
          AND o2.dt <= r.dt
      ) AS days_since_high
    FROM ranked r
    JOIN high_dates h ON h.ticker = r.ticker
    WHERE r.rn = 1
    ORDER BY r.ticker
  `;
}

describe('getDrawdowns (integration)', () => {
  it('reports ~0% drawdown when the latest close is at the rolling high', async () => {
    fixture = await bootFixture();
    // Monotonically rising closes (deterministic, no noise) → the latest
    // bar IS the rolling high. Drawdown collapses to 0 and days-since-
    // high is 0 (the high IS today's bar).
    await insertSyntheticOhlcv(fixture, 'AAPL', 60, { trend: 1, noise: 0 });

    const rows = await fixture.query(drawdownsSql());
    expect(rows.length).toBe(1);
    expect(String(rows[0].ticker)).toBe('AAPL');
    expect(Number(rows[0].drawdown_pct)).toBeCloseTo(0, 2);
    expect(Number(rows[0].days_since_high)).toBe(0);
    // Latest close should equal the rolling high in this regime.
    expect(Number(rows[0].latest_close)).toBeCloseTo(
      Number(rows[0].rolling_high),
      6,
    );
  });

  it('reports the expected negative drawdown when latest close is below the rolling high', async () => {
    fixture = await bootFixture();
    // Two-segment fixture: 50 bars climbing 100 → 149, then 10 bars
    // dropping back to ~100. The high is bar 50 (close ≈ 149); the
    // latest close (bar 60) is ≈ 100 → drawdown ≈ -33%.
    //
    // Build the rows directly so we can pin the exact closes — using
    // `insertSyntheticOhlcv` twice would either need a new startDate
    // option or risk PK collisions. The hand-built INSERT is clearer.
    const dt = (i: number): string => {
      const ms = new Date('2024-01-01T00:00:00Z').getTime() + (i - 1) * 86_400_000;
      return new Date(ms).toISOString().slice(0, 10);
    };
    const values: string[] = [];
    // Climb: bars 1..50, close = 100 + (i-1) → peak 149 at i=50.
    for (let i = 1; i <= 50; i++) {
      const close = 100 + (i - 1);
      values.push(
        `('AAPL', DATE '${dt(i)}', ${close - 0.05}, ${close + 0.2}, ${close - 0.2}, ${close}, 1000000)`,
      );
    }
    // Drop: bars 51..60, close descending 145, 140, ..., 100.
    for (let i = 51; i <= 60; i++) {
      const close = 149 - (i - 50) * 5; // 144, 139, ..., 99
      values.push(
        `('AAPL', DATE '${dt(i)}', ${close - 0.05}, ${close + 0.2}, ${close - 0.2}, ${close}, 1000000)`,
      );
    }
    await fixture.query(
      `INSERT INTO ohlcv (ticker, dt, open, high, low, close, volume) VALUES ${values.join(', ')}`,
    );

    const rows = await fixture.query(drawdownsSql());
    expect(rows.length).toBe(1);
    const row = rows[0];
    // High is 149 (bar 50). Latest close is 99 (bar 60).
    expect(Number(row.rolling_high)).toBeCloseTo(149, 6);
    expect(Number(row.latest_close)).toBeCloseTo(99, 6);
    // Drawdown = 100 * (99 - 149) / 149 ≈ -33.557%.
    const expectedPct = (100 * (99 - 149)) / 149;
    expect(Number(row.drawdown_pct)).toBeCloseTo(expectedPct, 2);
    // 10 bars passed since the high (bars 51..60).
    expect(Number(row.days_since_high)).toBe(10);
  });

  it('handles tickers with fewer than 252 bars (window degrades gracefully)', async () => {
    fixture = await bootFixture();
    // Only 30 bars. The 252-bar rolling window will simply use what's
    // available — the production guarantee is "no fake zero drawdown
    // for new positions"; here every bar contributes and the latest
    // (highest) close is the rolling high.
    await insertSyntheticOhlcv(fixture, 'NEW', 30, { trend: 1, noise: 0 });

    const rows = await fixture.query(drawdownsSql());
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(String(row.ticker)).toBe('NEW');
    // Monotonic up → latest IS the high → drawdown ≈ 0, days_since_high 0.
    expect(Number(row.drawdown_pct)).toBeCloseTo(0, 2);
    expect(Number(row.days_since_high)).toBe(0);
    // No NaN/NULL leakage.
    expect(Number.isFinite(Number(row.latest_close))).toBe(true);
    expect(Number.isFinite(Number(row.rolling_high))).toBe(true);
  });

  it('isolates drawdown calculations per ticker (PARTITION BY)', async () => {
    fixture = await bootFixture();
    // Ticker A: monotonic up → 0% drawdown.
    // Ticker B: spike then drop → meaningful drawdown.
    // Without `PARTITION BY ticker` the rolling high would mix the
    // two series and corrupt both rows.
    await insertSyntheticOhlcv(fixture, 'AAA', 40, { trend: 1, noise: 0 });

    const dt = (i: number): string => {
      const ms = new Date('2024-01-01T00:00:00Z').getTime() + (i - 1) * 86_400_000;
      return new Date(ms).toISOString().slice(0, 10);
    };
    const bRows: string[] = [];
    for (let i = 1; i <= 30; i++) {
      // B: climb to 200 at bar 20, then crash to 100 at bar 30.
      const close = i <= 20 ? 100 + (i - 1) * 5 : 195 - (i - 20) * 9.5;
      bRows.push(
        `('BBB', DATE '${dt(i)}', ${close - 0.05}, ${close + 0.2}, ${close - 0.2}, ${close.toFixed(4)}, 1000000)`,
      );
    }
    await fixture.query(
      `INSERT INTO ohlcv (ticker, dt, open, high, low, close, volume) VALUES ${bRows.join(', ')}`,
    );

    const rows = await fixture.query(drawdownsSql());
    expect(rows.length).toBe(2);
    const byTicker = Object.fromEntries(rows.map((r) => [String(r.ticker), r]));
    // AAA: monotonic up → at high.
    expect(Number(byTicker.AAA.drawdown_pct)).toBeCloseTo(0, 2);
    // BBB: closed below its high → strictly negative drawdown.
    expect(Number(byTicker.BBB.drawdown_pct)).toBeLessThan(-10);
    // BBB peak was bar 20 (close 195); 10 bars have passed.
    expect(Number(byTicker.BBB.days_since_high)).toBe(10);
  });

  it('returns no rows when the ohlcv table is empty', async () => {
    fixture = await bootFixture();
    const rows = await fixture.query(drawdownsSql());
    expect(rows.length).toBe(0);
  });
});
