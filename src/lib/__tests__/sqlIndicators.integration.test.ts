// Integration tests for `materializeRsi` / `materializeMacd`.
//
// These run the actual recursive-CTE SQL strings (mirrored verbatim
// from `src/lib/sqlIndicators.ts` into `duckdb-fixture.materializeRsiSql`
// / `materializeMacdSql`) against a real DuckDB engine. They catch the
// class of bugs that the existing unit tests in `screener.test.ts` etc.
// can't see: SQL parse errors, runtime errors, and mathematical
// nonsense (e.g. RSI not pinning to 100 on a monotonic uptrend).
//
// The most important test in this file is the LAST one
// ("rejects WITHOUT the RECURSIVE keyword") — it pins the regression
// that triggered this whole effort. If a future tidy-up removes the
// keyword again, that test fails immediately at build time instead of
// the bug shipping silently.

import { describe, it, expect, afterEach } from 'vitest';
import {
  bootFixture,
  insertSyntheticOhlcv,
  materializeRsiSql,
  materializeMacdSql,
  type FixtureDb,
} from './duckdb-fixture';

let fixture: FixtureDb | null = null;

afterEach(async () => {
  if (fixture) {
    await fixture.close();
    fixture = null;
  }
});

describe('materializeRsi (integration)', () => {
  it('produces RSI rows for a ticker with >=15 bars', async () => {
    fixture = await bootFixture();
    await insertSyntheticOhlcv(fixture, 'AAPL', 50, { trend: 0.5 });

    await fixture.query(materializeRsiSql('AAPL', 14));

    const rows = await fixture.query(
      `SELECT COUNT(*) AS c FROM indicators_rsi WHERE ticker = 'AAPL'`,
    );
    // 50 bars → ROW_NUMBER 1..50, changes has rn 2..50, seed at rn=15,
    // recursive walks to rn=50 → 50-15+1 = 36 RSI rows.
    expect(rows[0].c).toBe(36);
  });

  it('returns 100 for monotonically rising closes (all gains, no losses)', async () => {
    fixture = await bootFixture();
    await insertSyntheticOhlcv(fixture, 'UP', 30, {
      startClose: 100,
      trend: 1.0,
      noise: 0,
    });
    await fixture.query(materializeRsiSql('UP', 14));

    // Wilder's RSI: when avg_loss = 0 the formula divides by zero; the
    // SQL has an explicit CASE that pins the value to 100.0. Pure
    // uptrend → every loss is 0 → every RSI value should be exactly
    // 100. Use min/max rather than every-row equality so the test
    // failure message tells us the magnitude of any drift.
    const stats = await fixture.query(
      `SELECT MIN(value) AS min_v, MAX(value) AS max_v, COUNT(*) AS c
       FROM indicators_rsi WHERE ticker = 'UP'`,
    );
    expect(stats[0].c).toBeGreaterThan(0);
    expect(stats[0].min_v).toBeCloseTo(100, 6);
    expect(stats[0].max_v).toBeCloseTo(100, 6);
  });

  it('returns 0 for monotonically falling closes (all losses, no gains)', async () => {
    fixture = await bootFixture();
    await insertSyntheticOhlcv(fixture, 'DOWN', 30, {
      startClose: 200,
      trend: -1.0,
      noise: 0,
    });
    await fixture.query(materializeRsiSql('DOWN', 14));

    // Pure downtrend → every gain is 0 → avg_gain stays 0 forever →
    // numerator (avg_gain / avg_loss) = 0 → RSI = 100 - 100/(1+0) = 0.
    // Allow a tiny floating-point tolerance because the EWMA has a
    // few rounds of /14 division.
    const stats = await fixture.query(
      `SELECT MIN(value) AS min_v, MAX(value) AS max_v, COUNT(*) AS c
       FROM indicators_rsi WHERE ticker = 'DOWN'`,
    );
    expect(stats[0].c).toBeGreaterThan(0);
    expect(stats[0].min_v).toBeCloseTo(0, 6);
    expect(stats[0].max_v).toBeCloseTo(0, 6);
  });

  it('produces values in [0, 100] for noisy input', async () => {
    fixture = await bootFixture();
    await insertSyntheticOhlcv(fixture, 'NOISY', 100, {
      startClose: 100,
      trend: 0.0,
      noise: 5.0,
      seed: 42,
    });
    await fixture.query(materializeRsiSql('NOISY', 14));

    const stats = await fixture.query(
      `SELECT MIN(value) AS min_v, MAX(value) AS max_v
       FROM indicators_rsi WHERE ticker = 'NOISY'`,
    );
    expect(stats[0].min_v as number).toBeGreaterThanOrEqual(0);
    expect(stats[0].max_v as number).toBeLessThanOrEqual(100);
  });

  it('rejects WITHOUT the RECURSIVE keyword (regression test)', async () => {
    fixture = await bootFixture();
    await insertSyntheticOhlcv(fixture, 'AAPL', 50);

    // Same SQL minus the RECURSIVE keyword. We expect this to throw at
    // parse time with a "use WITH RECURSIVE" binder error. Pinning
    // this regression so a future "tidy-up" that drops the keyword
    // fails the build instead of shipping silently (which is exactly
    // what happened in the v3/v4 push that prompted this whole test
    // file's existence).
    const broken = materializeRsiSql('AAPL', 14).replace(
      'WITH RECURSIVE',
      'WITH',
    );
    await expect(fixture.query(broken)).rejects.toThrow(/RECURSIVE/i);
  });
});

describe('materializeMacd (integration)', () => {
  it('produces MACD rows for a ticker with enough bars (slow + signal warmup)', async () => {
    fixture = await bootFixture();
    await insertSyntheticOhlcv(fixture, 'AAPL', 100, { trend: 0.5 });

    await fixture.query(materializeMacdSql('AAPL', 12, 26, 9));

    const rows = await fixture.query(
      `SELECT COUNT(*) AS c FROM indicators_macd WHERE ticker = 'AAPL'`,
    );
    // 100 bars → macd_line defined from rn=26 → macd_rn 1..75 →
    // signal_seed at macd_rn=9, recursive walks to macd_rn=75 →
    // 75-9+1 = 67 rows.
    expect(rows[0].c).toBe(67);
  });

  it('produces no MACD rows when input has fewer bars than slow period', async () => {
    fixture = await bootFixture();
    await insertSyntheticOhlcv(fixture, 'SHORT', 20, { trend: 0.5 });
    await fixture.query(materializeMacdSql('SHORT', 12, 26, 9));

    // 20 bars < slow_period(26) → fast_seed produces a row but
    // slow_seed has no rn=26 row, so the seed is empty → entire
    // recursive chain is empty → macd_line_calc is empty → 0 rows.
    const rows = await fixture.query(
      `SELECT COUNT(*) AS c FROM indicators_macd WHERE ticker = 'SHORT'`,
    );
    expect(rows[0].c).toBe(0);
  });

  it('histogram is consistent with macd_line - signal_line', async () => {
    fixture = await bootFixture();
    await insertSyntheticOhlcv(fixture, 'AAPL', 100, {
      trend: 0.2,
      noise: 1.0,
      seed: 7,
    });
    await fixture.query(materializeMacdSql('AAPL', 12, 26, 9));

    // Internal consistency check: histogram must equal macd_line -
    // signal_line. Catches a future refactor that changes one but not
    // the other.
    const drift = await fixture.query(`
      SELECT MAX(ABS(histogram - (macd_line - signal_line))) AS max_drift
      FROM indicators_macd WHERE ticker = 'AAPL'
    `);
    expect(drift[0].max_drift as number).toBeLessThan(1e-9);
  });

  it('rejects WITHOUT the RECURSIVE keyword (regression test)', async () => {
    fixture = await bootFixture();
    await insertSyntheticOhlcv(fixture, 'AAPL', 100);

    const broken = materializeMacdSql('AAPL', 12, 26, 9).replace(
      'WITH RECURSIVE',
      'WITH',
    );
    await expect(fixture.query(broken)).rejects.toThrow(/RECURSIVE/i);
  });
});
