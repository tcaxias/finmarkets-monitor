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
});
