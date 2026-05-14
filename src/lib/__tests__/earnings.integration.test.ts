// Integration tests for the earnings_events table introduced by
// migration v6, plus the SQL shape used by `getEarnings` in queries.ts.
//
// Same strategy as the other integration suites: extract the SQL into
// the test fixture and execute it against a real DuckDB engine via
// `@duckdb/node-api`. The fixture's `applyMigrations` already creates
// the table with the v6 DDL — these tests exercise insert / replace /
// query semantics on top of it.

import { describe, it, expect, afterEach } from 'vitest';
import { bootFixture, type FixtureDb } from './duckdb-fixture';

let fixture: FixtureDb | null = null;

afterEach(async () => {
  if (fixture) {
    await fixture.close();
    fixture = null;
  }
});

describe('earnings_events table + getEarnings query (integration)', () => {
  it('inserts and retrieves earnings events ordered by date', async () => {
    fixture = await bootFixture();

    // Three events for AAPL across one fiscal year. Mix of positive
    // and negative surprises so the read-back assertions can pin
    // the sign on each row.
    await fixture.query(`
      INSERT INTO earnings_events
        (ticker, dt, time_of_day, eps_estimate, eps_actual, surprise_pct, fetched_at)
      VALUES
        ('AAPL', DATE '2025-01-30', 'After Market', 1.45, 1.52, 4.83, CURRENT_TIMESTAMP),
        ('AAPL', DATE '2025-04-30', 'After Market', 1.55, 1.60, 3.23, CURRENT_TIMESTAMP),
        ('AAPL', DATE '2025-07-30', 'After Market', 1.48, 1.42, -4.05, CURRENT_TIMESTAMP)
    `);

    // Mirrors the SELECT shape of `getEarnings`. Casting the date to
    // an ISO string here keeps the assertion tier-pure (no DuckDB
    // {days: N} object leaks into the test).
    const rows = await fixture.query(`
      SELECT
        strftime(dt, '%Y-%m-%d') AS dt,
        epoch(dt)::BIGINT AS time,
        time_of_day,
        eps_estimate,
        eps_actual,
        surprise_pct
      FROM earnings_events
      WHERE ticker = 'AAPL'
      ORDER BY dt
    `);

    expect(rows.length).toBe(3);
    expect(rows[0].dt).toBe('2025-01-30');
    expect(rows[0].time_of_day).toBe('After Market');
    expect(Number(rows[0].surprise_pct)).toBeCloseTo(4.83, 2);
    expect(Number(rows[2].surprise_pct)).toBeCloseTo(-4.05, 2);
  });

  it('handles INSERT OR REPLACE on the (ticker, dt) PK', async () => {
    fixture = await bootFixture();

    // First insert: estimate 1.40, actual 1.45.
    await fixture.query(`
      INSERT INTO earnings_events VALUES
        ('AAPL', DATE '2025-04-30', 'After Market', 1.40, 1.45, 3.57, CURRENT_TIMESTAMP)
    `);

    // Re-fetch: same date, corrected estimate / actual / surprise.
    // The data layer's refreshEarnings() uses INSERT OR REPLACE so
    // re-fetches don't produce duplicates — exercise that here.
    await fixture.query(`
      INSERT OR REPLACE INTO earnings_events VALUES
        ('AAPL', DATE '2025-04-30', 'After Market', 1.42, 1.48, 4.23, CURRENT_TIMESTAMP)
    `);

    const rows = await fixture.query(`
      SELECT
        eps_estimate, eps_actual, surprise_pct,
        COUNT(*) OVER () AS row_count
      FROM earnings_events
      WHERE ticker = 'AAPL' AND dt = DATE '2025-04-30'
    `);

    expect(rows.length).toBe(1);
    expect(Number(rows[0].row_count)).toBe(1);
    expect(Number(rows[0].eps_estimate)).toBeCloseTo(1.42, 2);
    expect(Number(rows[0].eps_actual)).toBeCloseTo(1.48, 2);
    expect(Number(rows[0].surprise_pct)).toBeCloseTo(4.23, 2);
  });

  it('respects the asOf upper bound (historical view)', async () => {
    // In historical view we don't want a marker for an earnings release
    // that hadn't happened yet on the as-of date. This pins that
    // semantic at the SQL level.
    fixture = await bootFixture();

    await fixture.query(`
      INSERT INTO earnings_events VALUES
        ('AAPL', DATE '2025-01-30', 'After Market', 1.45, 1.52, 4.83, CURRENT_TIMESTAMP),
        ('AAPL', DATE '2025-04-30', 'After Market', 1.55, 1.60, 3.23, CURRENT_TIMESTAMP),
        ('AAPL', DATE '2025-07-30', 'After Market', 1.48, 1.42, -4.05, CURRENT_TIMESTAMP)
    `);

    const rows = await fixture.query(`
      SELECT strftime(dt, '%Y-%m-%d') AS dt
      FROM earnings_events
      WHERE ticker = 'AAPL' AND dt <= CAST('2025-05-01' AS DATE)
      ORDER BY dt
    `);

    expect(rows.length).toBe(2);
    expect(rows[0].dt).toBe('2025-01-30');
    expect(rows[1].dt).toBe('2025-04-30');
  });

  it('respects the since lower bound (timeframe windowing)', async () => {
    // The chart's timeframe filter (1M / 3M / 6M etc.) clips earnings
    // markers to the visible window so the marker plugin doesn't emit
    // 30+ circles when the user is on a 6M view.
    fixture = await bootFixture();

    await fixture.query(`
      INSERT INTO earnings_events VALUES
        ('AAPL', DATE '2024-01-30', 'After Market', 1.30, 1.40, 7.69, CURRENT_TIMESTAMP),
        ('AAPL', DATE '2025-01-30', 'After Market', 1.45, 1.52, 4.83, CURRENT_TIMESTAMP),
        ('AAPL', DATE '2025-07-30', 'After Market', 1.48, 1.42, -4.05, CURRENT_TIMESTAMP)
    `);

    const rows = await fixture.query(`
      SELECT strftime(dt, '%Y-%m-%d') AS dt
      FROM earnings_events
      WHERE ticker = 'AAPL' AND dt >= CAST('2025-01-01' AS DATE)
      ORDER BY dt
    `);

    expect(rows.length).toBe(2);
    expect(rows[0].dt).toBe('2025-01-30');
    expect(rows[1].dt).toBe('2025-07-30');
  });

  it('preserves NULL eps fields for unconfirmed / pre-release events', async () => {
    // Twelve Data legitimately returns NULL/empty estimate or actual
    // for unconfirmed reports. The schema's DOUBLE columns are
    // nullable; `getEarnings` surfaces these as `null` so the widget
    // can render '—' rather than '$NaN'.
    fixture = await bootFixture();

    await fixture.query(`
      INSERT INTO earnings_events VALUES
        ('NEW', DATE '2026-08-15', NULL, NULL, NULL, NULL, CURRENT_TIMESTAMP)
    `);

    const rows = await fixture.query(`
      SELECT eps_estimate, eps_actual, surprise_pct, time_of_day
      FROM earnings_events
      WHERE ticker = 'NEW'
    `);

    expect(rows.length).toBe(1);
    expect(rows[0].eps_estimate).toBeNull();
    expect(rows[0].eps_actual).toBeNull();
    expect(rows[0].surprise_pct).toBeNull();
    expect(rows[0].time_of_day).toBeNull();
  });
});
