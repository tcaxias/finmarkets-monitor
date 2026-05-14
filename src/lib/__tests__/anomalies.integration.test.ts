// Integration tests for the ANOMALIES catalog.
//
// Same pattern as `screener.integration.test.ts`: execute each
// detector's `buildSql` output against a real DuckDB engine pre-loaded
// with synthetic OHLCV. We assert the SQL parses and executes (and
// returns a valid result set), not on the exact rows — the detectors'
// thresholds (z-score >= 3, gap >= 2%, golden/death cross) are too
// brittle to hit reliably with bulk synthetic data without inflating
// the fixture size.

import { describe, it, expect, afterEach } from 'vitest';
import { bootFixture, insertSyntheticOhlcv, type FixtureDb } from './duckdb-fixture';
import { ANOMALIES } from '../anomalies';
import type { Position } from '../settings.svelte';

let fixture: FixtureDb | null = null;

afterEach(async () => {
  if (fixture) {
    await fixture.close();
    fixture = null;
  }
});

function pos(ticker: string): Position {
  return {
    id: ticker,
    ticker,
    vestPrice: 0,
    shares: 0,
    taxRate: 0,
    taxDueDate: '',
  };
}

describe('ANOMALIES (integration: each builds executable SQL)', () => {
  for (const anomaly of ANOMALIES) {
    it(
      `${anomaly.id}: SQL executes without error`,
      async () => {
        fixture = await bootFixture();
        // 250 bars of moderately noisy data so the volume z-score and
        // 50/200-cross detectors have a meaningful baseline window.
        await insertSyntheticOhlcv(fixture, 'AAPL', 250, {
          trend: 0.2,
          noise: 1.0,
          seed: 11,
        });
        await insertSyntheticOhlcv(fixture, 'NVDA', 250, {
          trend: 0.5,
          noise: 2.0,
          seed: 22,
        });

        const positions = [pos('AAPL'), pos('NVDA')];
        const sql = anomaly.buildSql(positions);
        const rows = await fixture.query(sql);
        expect(Array.isArray(rows)).toBe(true);
      },
      15_000,
    );
  }

  it('all anomalies execute safely with an empty positions list', async () => {
    fixture = await bootFixture();
    for (const anomaly of ANOMALIES) {
      const sql = anomaly.buildSql([]);
      const rows = await fixture.query(sql);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(0);
    }
  });

  it('volume-zscore: detects synthetically-injected volume spike', async () => {
    // Verifies the detector actually fires when given an obvious
    // anomaly. Insert 200 normal bars plus one with 100× volume in
    // the trailing-30-day window, then assert at least one row comes
    // back. Catches the case where a future refactor accidentally
    // inverts the comparison or the windowing.
    fixture = await bootFixture();
    await insertSyntheticOhlcv(fixture, 'SPIKE', 200, {
      trend: 0.0,
      noise: 0.5,
      seed: 5,
    });
    // Inject a single huge-volume bar at the end (within the 30-bar
    // recency filter).
    await fixture.query(`
      DELETE FROM ohlcv WHERE ticker = 'SPIKE' AND dt = (
        SELECT MAX(dt) FROM ohlcv WHERE ticker = 'SPIKE'
      )
    `);
    const lastDt = (
      await fixture.query(
        `SELECT MAX(dt) AS d FROM ohlcv WHERE ticker = 'SPIKE'`,
      )
    )[0].d as string;
    // One day after lastDt, with ~100× the typical volume.
    const nextDate = new Date(
      new Date(lastDt + 'T00:00:00Z').getTime() + 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    await fixture.query(`
      INSERT INTO ohlcv VALUES
        ('SPIKE', DATE '${nextDate}', 100.0, 100.5, 99.5, 100.2, 100000000)
    `);

    const detector = ANOMALIES.find((a) => a.id === 'volume-zscore-3');
    expect(detector).toBeDefined();
    const rows = await fixture.query(detector!.buildSql([pos('SPIKE')]));
    expect(rows.length).toBeGreaterThan(0);
    // The injected bar should be the top hit (highest z-score).
    expect(rows[0].ticker).toBe('SPIKE');
    expect(rows[0].zscore as number).toBeGreaterThan(3);
  });
});
