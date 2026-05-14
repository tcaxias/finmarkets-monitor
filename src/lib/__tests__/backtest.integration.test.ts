// Integration tests for the BACKTEST_QUERIES catalog.
//
// Same pattern as the screener / anomalies integration tests:
// execute each query's `buildSql` output against a real DuckDB engine
// pre-loaded with synthetic OHLCV + materialised RSI/MACD. Backtest
// queries are per-ticker (not per-positions-list), which is the only
// shape difference from the screener tests.

import { describe, it, expect, afterEach } from 'vitest';
import {
  bootFixture,
  insertSyntheticOhlcv,
  populateIndicators,
  type FixtureDb,
} from './duckdb-fixture';
import { BACKTEST_QUERIES } from '../backtest';

let fixture: FixtureDb | null = null;

afterEach(async () => {
  if (fixture) {
    await fixture.close();
    fixture = null;
  }
});

describe('BACKTEST_QUERIES (integration: each builds executable SQL)', () => {
  for (const query of BACKTEST_QUERIES) {
    it(
      `${query.id}: SQL executes without error against fixture data`,
      async () => {
        fixture = await bootFixture();
        // Backtest queries reach further back than screener queries
        // (e.g. `bullish-fridays-2025` filters by year=2025). Seed a
        // window that includes 2025 calendar dates so the date-extract
        // predicates have data to filter against.
        await insertSyntheticOhlcv(fixture, 'AAPL', 400, {
          startDate: '2024-06-01',
          trend: 0.2,
          noise: 0.5,
          seed: 13,
        });
        await populateIndicators(fixture, ['AAPL']);

        const sql = query.buildSql('AAPL');
        const rows = await fixture.query(sql);
        // Result can be empty for synthetic data — what matters is
        // the SQL executed. The `bullish-fridays-2025` query in
        // particular depends on the specific shape of the synthetic
        // series; we don't pin row counts here.
        expect(Array.isArray(rows)).toBe(true);
      },
      15_000,
    );
  }

  it('best-30d-windows: returns up to 10 rows ranked by return_pct DESC', async () => {
    // Targeted check on the LIMIT and ORDER BY of the rolling-window
    // query. Synthetic uptrend → every 30-day return is positive →
    // we should get exactly 10 rows (the LIMIT) sorted descending.
    fixture = await bootFixture();
    await insertSyntheticOhlcv(fixture, 'AAPL', 200, {
      startDate: '2024-01-01',
      trend: 0.5,
      noise: 0.0,
    });

    const query = BACKTEST_QUERIES.find((q) => q.id === 'best-30d-windows');
    expect(query).toBeDefined();
    const rows = await fixture.query(query!.buildSql('AAPL'));
    expect(rows.length).toBeLessThanOrEqual(10);
    expect(rows.length).toBeGreaterThan(0);
    // Sort invariant: returns must be monotonically non-increasing.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].return_pct as number).toBeLessThanOrEqual(
        rows[i - 1].return_pct as number,
      );
    }
  });

  describe('post-earnings-drift backtest query', () => {
    // These tests pin the forward-return arithmetic against a
    // deterministic linear-trend OHLCV series. With trend=1 and
    // noise=0, close[i] = 100 + i, so for any earnings_rn the
    // return is exactly known — any drift means the SQL is wrong.

    it('computes forward returns from earnings dates correctly', async () => {
      fixture = await bootFixture();
      // 100 daily bars starting 2024-01-01. Bar 0 (2024-01-01) → 100,
      // bar 29 (2024-01-30) → 129, bar 45 (2024-02-15) → 145.
      // Note: insertSyntheticOhlcv uses CALENDAR days (incl. weekends),
      // and the SQL's "+1/+5/+20" are ROW_NUMBER offsets — i.e. trading
      // days as DuckDB sees them, which is whatever's in OHLCV. With
      // a synthetic series of consecutive calendar days they're 1:1.
      await insertSyntheticOhlcv(fixture, 'AAPL', 100, {
        startDate: '2024-01-01',
        startClose: 100,
        trend: 1,
        noise: 0,
      });
      await fixture.query(`
        INSERT INTO earnings_events (ticker, dt, time_of_day, eps_estimate, eps_actual, surprise_pct, fetched_at) VALUES
          ('AAPL', DATE '2024-01-30', 'After Market', 1.40, 1.45, 3.57, CURRENT_TIMESTAMP),
          ('AAPL', DATE '2024-02-15', 'Before Market', 0.50, 0.45, -10.0, CURRENT_TIMESTAMP)
      `);

      const query = BACKTEST_QUERIES.find(
        (q) => q.id === 'post-earnings-drift',
      );
      expect(query).toBeDefined();
      const rows = await fixture.query(query!.buildSql('AAPL'));

      // Two earnings, both have full +20d window in the 100-bar series.
      expect(rows.length).toBe(2);

      // ORDER BY earnings_dt DESC → row 0 = 2024-02-15 (miss),
      // row 1 = 2024-01-30 (beat).
      expect(rows[0].direction).toBe('miss');
      expect(rows[1].direction).toBe('beat');

      // Numerical pin on the 5-day forward return from 2024-01-30.
      // earnings_close (rn=30, bar index 29) = 129.
      // close_5d (rn=35, bar index 34) = 134.
      // return_5d_pct = (134 - 129) / 129 * 100 ≈ 3.876%.
      expect(Number(rows[1].return_5d_pct)).toBeCloseTo(3.876, 2);

      // Numerical pin on the 1-day and 20-day forward returns too —
      // arithmetic is exact under linear trend so any drift signals
      // an off-by-one in the ROW_NUMBER offsets.
      // close_1d (rn=31) = 130 → (130-129)/129*100 ≈ 0.7752%.
      expect(Number(rows[1].return_1d_pct)).toBeCloseTo(0.7752, 3);
      // close_20d (rn=50) = 149 → (149-129)/129*100 ≈ 15.5039%.
      expect(Number(rows[1].return_20d_pct)).toBeCloseTo(15.5039, 3);

      // Pinned EPS surprise pass-through (round-trip from the insert).
      expect(Number(rows[1].surprise_pct)).toBeCloseTo(3.57, 2);
      expect(Number(rows[1].eps_actual)).toBeCloseTo(1.45, 2);
    });

    it('returns NULL forward returns when future bars are missing', async () => {
      // Earnings on bar 27 of a 30-bar series → only 2 future bars
      // exist. The +1d return is computable; +5d and +20d should be
      // NULL because the correlated subquery finds no row at rn=33 or
      // rn=48. The row itself still appears (the WHERE filters on
      // earnings_close, which is present, not on future closes).
      fixture = await bootFixture();
      await insertSyntheticOhlcv(fixture, 'AAPL', 30, {
        startDate: '2024-01-01',
        startClose: 100,
        trend: 1,
        noise: 0,
      });
      // 2024-01-28 is bar index 27 → rn=28. close = 127. close_1d
      // (rn=29) = 128 → return ≈ 0.7874%.
      await fixture.query(`
        INSERT INTO earnings_events (ticker, dt, time_of_day, eps_estimate, eps_actual, surprise_pct, fetched_at) VALUES
          ('AAPL', DATE '2024-01-28', 'After Market', 1.0, 1.1, 10.0, CURRENT_TIMESTAMP)
      `);

      const query = BACKTEST_QUERIES.find(
        (q) => q.id === 'post-earnings-drift',
      );
      const rows = await fixture.query(query!.buildSql('AAPL'));

      expect(rows.length).toBe(1);
      expect(rows[0].direction).toBe('beat');
      expect(Number(rows[0].return_1d_pct)).toBeCloseTo(0.7874, 3);
      // No bar at rn=33 → NULL preserved by the correlated subquery.
      expect(rows[0].return_5d_pct).toBeNull();
      expect(rows[0].return_20d_pct).toBeNull();
    });

    it('skips earnings events with no matching OHLCV bar (INNER JOIN)', async () => {
      // Earnings released on a date with no OHLCV bar (e.g. ticker
      // wasn't being tracked yet). Should silently drop those events
      // — they have no T=0 close to anchor the forward returns
      // against. This is the inner-JOIN behaviour, deliberate.
      fixture = await bootFixture();
      await insertSyntheticOhlcv(fixture, 'AAPL', 50, {
        startDate: '2024-01-01',
        startClose: 100,
        trend: 1,
        noise: 0,
      });
      await fixture.query(`
        INSERT INTO earnings_events (ticker, dt, time_of_day, eps_estimate, eps_actual, surprise_pct, fetched_at) VALUES
          ('AAPL', DATE '2023-10-15', 'After Market', 1.0, 1.1, 10.0, CURRENT_TIMESTAMP),
          ('AAPL', DATE '2024-01-30', 'After Market', 1.0, 1.1, 10.0, CURRENT_TIMESTAMP)
      `);

      const query = BACKTEST_QUERIES.find(
        (q) => q.id === 'post-earnings-drift',
      );
      const rows = await fixture.query(query!.buildSql('AAPL'));

      // Only the 2024-01-30 event has a matching OHLCV bar.
      expect(rows.length).toBe(1);
      expect(rows[0].earnings_dt).toBe('2024-01-30');
    });
  });
});
