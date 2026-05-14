// Integration tests for window-function-based query helpers in
// `src/lib/queries.ts` (currently: VWAP).
//
// These run the actual SQL strings against a real DuckDB engine via
// the duckdb-fixture infrastructure introduced in commit 403b4a9.
// Same strategy as `sqlIndicators.integration.test.ts`: the SQL is
// duplicated here (kept in sync with the production module) so we
// catch parse errors and execution-time bugs without needing a
// pluggable connection adapter.
//
// VWAP is a non-recursive rolling aggregate (unlike RSI/MACD), so the
// duplicated SQL is short — under 20 lines and trivially auditable
// against `getVwap` in queries.ts.

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

// Inline the VWAP windowed-aggregate SQL. Mirrors the body of
// `getVwap` in src/lib/queries.ts (without the `since` outer predicate
// since these tests check the inner computation directly).
function vwapSql(ticker: string, period = 20): string {
  return `
    WITH w AS (
      SELECT
        epoch(dt)::BIGINT AS time,
        SUM(COALESCE(close * volume, 0)) OVER (
          ORDER BY dt
          ROWS BETWEEN ${period - 1} PRECEDING AND CURRENT ROW
        ) AS num,
        SUM(COALESCE(volume, 0)) OVER (
          ORDER BY dt
          ROWS BETWEEN ${period - 1} PRECEDING AND CURRENT ROW
        ) AS den,
        COUNT(*) OVER (
          ORDER BY dt
          ROWS BETWEEN ${period - 1} PRECEDING AND CURRENT ROW
        ) AS w_size
      FROM ohlcv
      WHERE ticker = '${ticker}'
    )
    SELECT time, num / NULLIF(den, 0) AS value
    FROM w
    WHERE w_size >= ${period} AND den > 0
    ORDER BY time
  `;
}

describe('VWAP (integration)', () => {
  it('produces (count - period + 1) rows with full warmup', async () => {
    fixture = await bootFixture();
    // 50 bars, deterministic linear closes. With a 20-period rolling
    // window the first 19 bars don't have enough history; expect
    // 50 - 20 + 1 = 31 output rows.
    await insertSyntheticOhlcv(fixture, 'AAPL', 50, { trend: 1.0, noise: 0 });

    const rows = await fixture.query(vwapSql('AAPL', 20));
    expect(rows.length).toBe(31);
  });

  it('VWAP values strictly increase on a monotonic uptrend', async () => {
    fixture = await bootFixture();
    // Linear up-trend, no noise, ~constant volume from the synthetic
    // inserter (1M + small jitter). VWAP collapses to (≈) SMA in this
    // regime, and SMA on a strictly-increasing series is strictly
    // increasing — same expectation holds for VWAP here.
    await insertSyntheticOhlcv(fixture, 'AAPL', 50, { trend: 1.0, noise: 0 });

    const rows = await fixture.query(vwapSql('AAPL', 20));
    expect(rows.length).toBeGreaterThan(1);
    for (let i = 1; i < rows.length; i++) {
      expect(Number(rows[i].value)).toBeGreaterThan(Number(rows[i - 1].value));
    }
  });

  it('high-volume bars pull VWAP toward their close more than low-volume bars', async () => {
    // The defining property of VWAP vs. SMA: a single high-volume bar
    // should shift the average more than a single low-volume bar at
    // the same close offset. We construct two minimal fixtures that
    // differ only in WHERE the volume spike sits and assert the VWAP
    // diverges in the expected direction.
    fixture = await bootFixture();

    // Bars 1..20 at price=100, volume=1M. Bar 20 = today.
    // Two scenarios encoded with different tickers in the same DB:
    //   HI_HI: bar 20 has price=110 with volume=10M (high price, high vol)
    //   HI_LO: bar 20 has price=110 with volume=100K (high price, low vol)
    // After 20 bars the VWAP for HI_HI must sit closer to 110 than HI_LO.
    const dt = (i: number): string => {
      const ms = new Date('2024-01-01T00:00:00Z').getTime() + (i - 1) * 86_400_000;
      return new Date(ms).toISOString().slice(0, 10);
    };
    const baseRows: string[] = [];
    const hiloRows: string[] = [];
    for (let i = 1; i <= 19; i++) {
      baseRows.push(`('HI_HI', DATE '${dt(i)}', 100, 100, 100, 100, 1000000)`);
      hiloRows.push(`('HI_LO', DATE '${dt(i)}', 100, 100, 100, 100, 1000000)`);
    }
    // Bar 20 — same close (110), divergent volume.
    baseRows.push(`('HI_HI', DATE '${dt(20)}', 110, 110, 110, 110, 10000000)`);
    hiloRows.push(`('HI_LO', DATE '${dt(20)}', 110, 110, 110, 110, 100000)`);
    await fixture.query(
      `INSERT INTO ohlcv (ticker, dt, open, high, low, close, volume) VALUES ${baseRows.join(', ')}, ${hiloRows.join(', ')}`,
    );

    const hiHi = await fixture.query(vwapSql('HI_HI', 20));
    const hiLo = await fixture.query(vwapSql('HI_LO', 20));
    expect(hiHi.length).toBe(1);
    expect(hiLo.length).toBe(1);
    // High-volume bar drags VWAP further from the 100-baseline.
    expect(Number(hiHi[0].value)).toBeGreaterThan(Number(hiLo[0].value));
  });

  it('NULL volume contributes zero to both numerator and denominator (no NaN, no crash)', async () => {
    // Twelve Data occasionally returns NULL volume on holiday bars.
    // The COALESCE in the production query treats those as
    // "contributes 0" — they're effectively skipped from the weighted
    // average. Without COALESCE, a single NULL would propagate
    // through SUM and the entire window's VWAP would be NULL.
    fixture = await bootFixture();
    await insertSyntheticOhlcv(fixture, 'AAPL', 30, { trend: 1.0, noise: 0 });
    // Null out a handful of mid-window volumes.
    await fixture.query(
      `UPDATE ohlcv SET volume = NULL WHERE ticker = 'AAPL' AND dt IN (DATE '2024-01-10', DATE '2024-01-15', DATE '2024-01-20')`,
    );

    const rows = await fixture.query(vwapSql('AAPL', 20));
    // Should still produce rows for windows where at least one bar has
    // non-NULL volume — every window of 20 bars here has 17+ valid
    // volumes, so all warmup-cleared bars produce values.
    expect(rows.length).toBe(11);
    // Every value must be a finite number — no NULL/NaN leakage.
    for (const r of rows) {
      const v = Number(r.value);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });
});
