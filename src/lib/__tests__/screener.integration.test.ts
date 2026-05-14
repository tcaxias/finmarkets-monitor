// Integration tests for the SCREENS catalog.
//
// Runs each screen's `buildSql` output against a real DuckDB engine
// pre-loaded with synthetic OHLCV + materialised RSI/MACD indicators.
// The bug class we're protecting against is "the SQL string itself
// is invalid". We don't assert on EXACT result rows for synthetic
// data — for that we'd need to construct fixtures that hit each
// screen's threshold deliberately, which is too brittle. We assert
// that:
//
//   1. Each screen's SQL parses and executes without throwing
//      (against fixture data with all required tables/views populated).
//   2. The Pcover screen's empty-tracked-positions branch returns
//      zero rows but doesn't throw.
//   3. Empty positions list produces SQL that executes safely.

import { describe, it, expect, afterEach } from 'vitest';
import {
  bootFixture,
  insertSyntheticOhlcv,
  populateIndicators,
  type FixtureDb,
} from './duckdb-fixture';
import { SCREENS } from '../screener';
import type { Position } from '../settings.svelte';

let fixture: FixtureDb | null = null;

afterEach(async () => {
  if (fixture) {
    await fixture.close();
    fixture = null;
  }
});

function pos(overrides: Partial<Position> = {}): Position {
  return {
    id: 'p1',
    ticker: 'AAPL',
    vestPrice: 100,
    shares: 100,
    taxRate: 0.4,
    taxDueDate: '',
    ...overrides,
  };
}

describe('SCREENS (integration: each builds executable SQL)', () => {
  // One test per screen. Generated in a loop so a new screen
  // automatically gets coverage. Per-test timeout bumped to 15s
  // because the 250-bar × 2-ticker fixture + recursive-CTE
  // indicator population is ~1s of real SQL work and the default
  // 5s budget is tight when CI machines run multiple test files
  // in parallel.
  for (const screen of SCREENS) {
    it(
      `${screen.id}: SQL executes without error against fixture data`,
      async () => {
        fixture = await bootFixture();
        // 250 bars is enough for sma200 + indicator warmups. Two
        // tickers so we exercise the IN-list interpolation path.
        await insertSyntheticOhlcv(fixture, 'AAPL', 250, { trend: 0.3 });
        await insertSyntheticOhlcv(fixture, 'NVDA', 250, { trend: 0.5 });
        await populateIndicators(fixture, ['AAPL', 'NVDA']);

        const positions: Position[] = [
          pos({ id: '1', ticker: 'AAPL' }),
          pos({ id: '2', ticker: 'NVDA', vestPrice: 200, shares: 50 }),
        ];

        const sql = screen.buildSql(positions);
        const rows = await fixture.query(sql);
        // Result can be empty — synthetic data won't hit every
        // threshold. We only require that the query executed and
        // returned an array.
        expect(Array.isArray(rows)).toBe(true);
      },
      15_000,
    );
  }

  it('all screens execute safely with an empty positions list', async () => {
    fixture = await bootFixture();
    // No fixture data needed — empty positions → IN ('') matches no
    // ticker and the queries should return zero rows without parsing
    // errors.
    for (const screen of SCREENS) {
      const sql = screen.buildSql([]);
      const rows = await fixture.query(sql);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(0);
    }
  });

  it('Pcover screen returns 0 rows when no positions are tax-tracked', async () => {
    fixture = await bootFixture();
    await insertSyntheticOhlcv(fixture, 'AAPL', 250);
    await populateIndicators(fixture, ['AAPL']);

    const screen = SCREENS.find((s) => s.id === 'near-pcover');
    expect(screen).toBeDefined();
    // Position with vestPrice=0 → not tax-tracked → screen short-
    // circuits with `WHERE FALSE`. The empty result must still be a
    // valid result set with the expected columns (so the caller's
    // column projection doesn't blow up).
    const positions: Position[] = [
      pos({ ticker: 'AAPL', vestPrice: 0, shares: 0, taxRate: 0 }),
    ];
    const rows = await fixture.query(screen!.buildSql(positions));
    expect(rows).toEqual([]);
  });

  it('current_snapshot view returns one row per ticker', async () => {
    // Direct exercise of the v2 migration view — pinning the
    // assertion that `current_snapshot` collapses ohlcv to one row per
    // ticker (the `MAX(dt) GROUP BY ticker` invariant).
    fixture = await bootFixture();
    await insertSyntheticOhlcv(fixture, 'AAPL', 30);
    await insertSyntheticOhlcv(fixture, 'NVDA', 50);
    await insertSyntheticOhlcv(fixture, 'GOOG', 10);

    const rows = await fixture.query(
      `SELECT ticker, row_count FROM current_snapshot ORDER BY ticker`,
    );
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.ticker)).toEqual(['AAPL', 'GOOG', 'NVDA']);
    // row_count column must reflect the actual per-ticker bar count
    // (the COUNT(*) correlated subquery in the v2 view).
    const byTicker = Object.fromEntries(
      rows.map((r) => [r.ticker as string, r.row_count]),
    );
    expect(byTicker.AAPL).toBe(30);
    expect(byTicker.NVDA).toBe(50);
    expect(byTicker.GOOG).toBe(10);
  });
});
