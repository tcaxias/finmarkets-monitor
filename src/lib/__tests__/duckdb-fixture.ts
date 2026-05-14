// Test fixture for executing SQL strings against a real DuckDB engine
// inside vitest. Uses `@duckdb/node-api` (the official Node binding,
// devDependency only) so SQL validation happens at test time rather
// than at deploy time.
//
// Why we need this:
//
// - vitest can't load DuckDB-WASM (no real workers, no OPFS). The
//   pre-existing unit tests for migrations / screener / anomalies /
//   backtest only assert on the SHAPE of the SQL string ("contains
//   `WHERE rsi > 70`"), never that DuckDB will actually accept it.
// - That gap shipped a `WITH RECURSIVE`-missing bug to production
//   (silently swallowed by the data layer's try/catch). The Node
//   binding speaks the same SQL dialect as DuckDB-WASM — running the
//   exact strings against a real engine catches the entire class of
//   parse-time and execution-time errors before deploy.
//
// Strategy: extract-and-execute (rather than adapter-pattern wrap of
// `getConn`). The bug class we need to protect against is "the SQL
// string itself is invalid". The JS marshalling layer (toJSON, BigInt
// coercion, etc.) already works at runtime and isn't the failure mode
// we need to test. The cost is some SQL duplication between the
// production modules and these test fixtures; the alternative
// (refactoring `sqlIndicators.ts` etc. to accept a pluggable
// connection type) was scoped out of this change.

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

/**
 * Coerced row shape: BigInt → Number, DATE-shaped objects → ISO date
 * string, everything else → pass-through. Mirrors the coercion the
 * production runners (`runScreen`, `runAnomaly`, `runBacktest`) apply,
 * so test assertions can use plain JS numbers/strings without
 * special-casing DuckDB return types.
 */
export type FixtureRow = Record<string, unknown>;

export interface FixtureDb {
  conn: DuckDBConnection;
  /** Execute a SQL string, return rows as plain objects. */
  query(sql: string): Promise<FixtureRow[]>;
  /** Tear down the in-memory DB. Call in afterEach or afterAll. */
  close(): Promise<void>;
}

/**
 * DuckDB's epoch-day for 1970-01-01 in the {days: N} object the Node
 * binding hands back for DATE columns. We convert by adding N days to
 * the Unix epoch and slicing the ISO string. UTC throughout so a
 * test running in a non-UTC timezone doesn't shift dates by a day.
 */
function daysToIsoDate(days: number): string {
  const ms = days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Coerce a single cell value from DuckDB-Node's native shape into a
 * plain JS value suitable for test assertions:
 *   - BigInt        → Number (safe for our small synthetic datasets)
 *   - {days: N}     → 'YYYY-MM-DD'  (DATE column)
 *   - {value, ...}  → Number (DECIMAL — we only deal in small magnitudes)
 *   - everything else → as-is
 */
function coerceCell(v: unknown): unknown {
  if (v == null) return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // DATE → {days: N}
    if (typeof o.days === 'number' && Object.keys(o).length === 1) {
      return daysToIsoDate(o.days);
    }
    // DECIMAL → {width, scale, value} where value is a BigInt of the
    // unscaled integer. Convert to Number — fine for our synthetic
    // ranges; if a future test needs full precision it can read the
    // raw {width, scale, value} via FixtureDb.conn directly.
    if ('width' in o && 'scale' in o && 'value' in o) {
      const scale = Number(o.scale);
      const value = typeof o.value === 'bigint' ? Number(o.value) : Number(o.value);
      return value / Math.pow(10, scale);
    }
  }
  return v;
}

/**
 * Boot a fresh in-memory DuckDB instance and apply the project's
 * schema migrations against it. Each call returns an independent
 * database — safe to use one per test (cheap: in-memory, ~10ms).
 */
export async function bootFixture(): Promise<FixtureDb> {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();

  const fixture: FixtureDb = {
    conn,
    query: async (sql: string) => {
      const reader = await conn.runAndReadAll(sql);
      const rawRows = reader.getRowObjects() as Record<string, unknown>[];
      return rawRows.map((row) => {
        const out: FixtureRow = {};
        for (const [k, v] of Object.entries(row)) {
          out[k] = coerceCell(v);
        }
        return out;
      });
    },
    close: async () => {
      // disconnectSync is the Node binding's tear-down — synchronous
      // despite the async wrapper around it. We await for symmetry
      // with WASM's AsyncDuckDBConnection.close().
      conn.disconnectSync();
    },
  };

  await applyMigrations(fixture);
  return fixture;
}

/**
 * Apply the migration sequence against `fixture`. Inlined here rather
 * than imported from `src/lib/migrations.ts` because that module
 * imports `@duckdb/duckdb-wasm` types — loading it under vitest would
 * require WASM/worker shims we don't want. The trade-off is documented
 * duplication: when adding a new migration to migrations.ts, mirror
 * the relevant DDL here. The duplication is mechanical and cheap; the
 * alternative (no migration coverage at all) was the status quo.
 *
 * Ordering matches `MIGRATIONS` in src/lib/migrations.ts:
 *   v1 → baseline tables (ohlcv, ohlcv_intraday, fetch_log)
 *   v2 → current_snapshot view
 *   v3 → indicators_rsi, indicators_macd
 *   v4 → backfill (no-op on empty fixture; SQL parse path covered)
 *   v5 → backfill (same)
 */
async function applyMigrations(fixture: FixtureDb): Promise<void> {
  // v1
  await fixture.query(`
    CREATE TABLE IF NOT EXISTS ohlcv (
      ticker VARCHAR NOT NULL,
      dt DATE NOT NULL,
      open DOUBLE NOT NULL,
      high DOUBLE NOT NULL,
      low DOUBLE NOT NULL,
      close DOUBLE NOT NULL,
      volume BIGINT,
      PRIMARY KEY (ticker, dt)
    )
  `);
  await fixture.query(`
    CREATE TABLE IF NOT EXISTS ohlcv_intraday (
      ticker VARCHAR NOT NULL,
      ts TIMESTAMP NOT NULL,
      open DOUBLE NOT NULL,
      high DOUBLE NOT NULL,
      low DOUBLE NOT NULL,
      close DOUBLE NOT NULL,
      volume BIGINT,
      PRIMARY KEY (ticker, ts)
    )
  `);
  await fixture.query(`
    CREATE TABLE IF NOT EXISTS fetch_log (
      ticker VARCHAR NOT NULL,
      fetched_at TIMESTAMP NOT NULL,
      rows_inserted INTEGER NOT NULL,
      status VARCHAR NOT NULL
    )
  `);

  // v2 — current_snapshot view (uses ohlcv from v1).
  await fixture.query(`
    CREATE OR REPLACE VIEW current_snapshot AS
    WITH latest AS (
      SELECT ticker, MAX(dt) AS latest_dt FROM ohlcv GROUP BY ticker
    )
    SELECT
      o.ticker,
      o.dt AS latest_dt,
      o.open AS latest_open,
      o.high AS latest_high,
      o.low AS latest_low,
      o.close AS latest_close,
      o.volume AS latest_volume,
      (SELECT close FROM ohlcv o2
        WHERE o2.ticker = o.ticker AND o2.dt < o.dt
        ORDER BY o2.dt DESC LIMIT 1) AS prev_close,
      (SELECT COUNT(*) FROM ohlcv o3 WHERE o3.ticker = o.ticker) AS row_count
    FROM ohlcv o
    JOIN latest l ON l.ticker = o.ticker AND l.latest_dt = o.dt
  `);

  // v3 — indicator tables.
  await fixture.query(`
    CREATE TABLE IF NOT EXISTS indicators_rsi (
      ticker VARCHAR NOT NULL,
      dt DATE NOT NULL,
      period INTEGER NOT NULL,
      value DOUBLE NOT NULL,
      PRIMARY KEY (ticker, dt, period)
    )
  `);
  await fixture.query(`
    CREATE TABLE IF NOT EXISTS indicators_macd (
      ticker VARCHAR NOT NULL,
      dt DATE NOT NULL,
      fast_period INTEGER NOT NULL,
      slow_period INTEGER NOT NULL,
      signal_period INTEGER NOT NULL,
      macd_line DOUBLE,
      signal_line DOUBLE,
      histogram DOUBLE,
      PRIMARY KEY (ticker, dt, fast_period, slow_period, signal_period)
    )
  `);

  // v4 / v5 — backfill migrations. Both are no-ops on an empty fixture
  // (the LEFT JOIN finds zero tickers needing backfill), but the SQL
  // parse path runs. Tests that want indicator data populate it via
  // `materializeRsiSql` / `materializeMacdSql` below.
}

/**
 * Insert synthetic OHLCV bars for `ticker`. Closes follow a linear
 * trend with optional reproducible noise. Useful for indicator tests
 * that need enough bars to clear the RSI/MACD warmup windows.
 *
 * Reproducible noise (seeded `mulberry32`) so a flaky test failure is
 * actually a code regression and not "the random walk happened to
 * land outside our tolerance today".
 */
export async function insertSyntheticOhlcv(
  fixture: FixtureDb,
  ticker: string,
  count: number,
  options: {
    /** ISO date for the first bar; defaults to 2024-01-01. */
    startDate?: string;
    /** Close on bar 1; defaults to 100. */
    startClose?: number;
    /** Close delta per bar (positive = uptrend); defaults to 0.1. */
    trend?: number;
    /** ± noise added to each close; defaults to 0 (deterministic). */
    noise?: number;
    /** RNG seed for reproducible noise; defaults to 1. */
    seed?: number;
  } = {},
): Promise<void> {
  const startDate = options.startDate ?? '2024-01-01';
  const startClose = options.startClose ?? 100;
  const trend = options.trend ?? 0.1;
  const noise = options.noise ?? 0;
  const seed = options.seed ?? 1;

  // mulberry32 — a tiny seeded PRNG. We don't need cryptographic
  // strength; we need "different bars get different small offsets and
  // tomorrow's noise is the same as today's noise for a given seed."
  let s = seed >>> 0;
  const rng = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const startMs = new Date(startDate + 'T00:00:00Z').getTime();
  const dayMs = 86_400_000;

  const values: string[] = [];
  for (let i = 0; i < count; i++) {
    const dtMs = startMs + i * dayMs;
    const dt = new Date(dtMs).toISOString().slice(0, 10);
    const close =
      startClose + i * trend + (noise > 0 ? (rng() - 0.5) * 2 * noise : 0);
    const open = close - 0.05;
    const high = close + 0.2;
    const low = close - 0.2;
    const volume = 1_000_000 + Math.floor(rng() * 500_000);
    values.push(
      `('${ticker}', DATE '${dt}', ${open.toFixed(4)}, ${high.toFixed(4)}, ${low.toFixed(4)}, ${close.toFixed(4)}, ${volume})`,
    );
  }
  if (values.length === 0) return;
  await fixture.query(
    `INSERT INTO ohlcv (ticker, dt, open, high, low, close, volume) VALUES ${values.join(', ')}`,
  );
}

/**
 * Generate the RSI(14) materialise-INSERT SQL for `ticker`. Mirrors
 * `materializeRsi` in `src/lib/sqlIndicators.ts`. Exported as a string
 * builder so test files can also use it as the "deliberately broken
 * — drop RECURSIVE" base in regression tests.
 */
export function materializeRsiSql(ticker: string, period = 14): string {
  return `
    INSERT INTO indicators_rsi (ticker, dt, period, value)
    WITH RECURSIVE ordered AS (
      SELECT
        dt,
        close,
        LAG(close) OVER (ORDER BY dt) AS prev_close,
        ROW_NUMBER() OVER (ORDER BY dt) AS rn
      FROM ohlcv
      WHERE ticker = '${ticker}'
    ),
    changes AS (
      SELECT rn, dt,
        GREATEST(close - prev_close, 0) AS gain,
        GREATEST(prev_close - close, 0) AS loss
      FROM ordered WHERE prev_close IS NOT NULL
    ),
    seed AS (
      SELECT ${period + 1} AS rn,
        AVG(gain) AS avg_gain, AVG(loss) AS avg_loss
      FROM changes WHERE rn BETWEEN 2 AND ${period + 1}
    ),
    recursive_rsi (rn, avg_gain, avg_loss) AS (
      SELECT rn, avg_gain, avg_loss FROM seed
      UNION ALL
      SELECT c.rn,
        (r.avg_gain * ${period - 1} + c.gain) / ${period}.0,
        (r.avg_loss * ${period - 1} + c.loss) / ${period}.0
      FROM recursive_rsi r
      JOIN changes c ON c.rn = r.rn + 1
    )
    SELECT '${ticker}' AS ticker, c.dt, ${period} AS period,
      CASE WHEN r.avg_loss = 0 THEN 100.0
        ELSE 100.0 - (100.0 / (1.0 + r.avg_gain / r.avg_loss))
      END AS value
    FROM recursive_rsi r
    JOIN changes c ON c.rn = r.rn
  `;
}

/**
 * Generate the MACD(12,26,9) materialise-INSERT SQL for `ticker`.
 * Mirrors `materializeMacd` in `src/lib/sqlIndicators.ts`.
 */
export function materializeMacdSql(
  ticker: string,
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): string {
  const fastK = 2.0 / (fastPeriod + 1);
  const slowK = 2.0 / (slowPeriod + 1);
  const signalK = 2.0 / (signalPeriod + 1);
  return `
    INSERT INTO indicators_macd
      (ticker, dt, fast_period, slow_period, signal_period, macd_line, signal_line, histogram)
    WITH RECURSIVE ordered AS (
      SELECT dt, close, ROW_NUMBER() OVER (ORDER BY dt) AS rn
      FROM ohlcv WHERE ticker = '${ticker}'
    ),
    fast_seed AS (
      SELECT ${fastPeriod} AS rn, AVG(close) AS ema
      FROM ordered WHERE rn BETWEEN 1 AND ${fastPeriod}
    ),
    fast_ema (rn, ema) AS (
      SELECT rn, ema FROM fast_seed
      UNION ALL
      SELECT o.rn, o.close * ${fastK} + f.ema * (1 - ${fastK})
      FROM fast_ema f JOIN ordered o ON o.rn = f.rn + 1
    ),
    slow_seed AS (
      SELECT ${slowPeriod} AS rn, AVG(close) AS ema
      FROM ordered WHERE rn BETWEEN 1 AND ${slowPeriod}
    ),
    slow_ema (rn, ema) AS (
      SELECT rn, ema FROM slow_seed
      UNION ALL
      SELECT o.rn, o.close * ${slowK} + s.ema * (1 - ${slowK})
      FROM slow_ema s JOIN ordered o ON o.rn = s.rn + 1
    ),
    macd_line_calc AS (
      SELECT f.rn, o.dt, f.ema - s.ema AS macd_line
      FROM fast_ema f
      JOIN slow_ema s ON s.rn = f.rn
      JOIN ordered o ON o.rn = f.rn
      WHERE f.rn >= ${slowPeriod}
    ),
    macd_with_seed_rn AS (
      SELECT rn, dt, macd_line,
        ROW_NUMBER() OVER (ORDER BY rn) AS macd_rn
      FROM macd_line_calc
    ),
    signal_seed AS (
      SELECT ${signalPeriod} AS macd_rn, AVG(macd_line) AS ema
      FROM macd_with_seed_rn WHERE macd_rn BETWEEN 1 AND ${signalPeriod}
    ),
    signal_ema (macd_rn, ema) AS (
      SELECT macd_rn, ema FROM signal_seed
      UNION ALL
      SELECT m.macd_rn, m.macd_line * ${signalK} + se.ema * (1 - ${signalK})
      FROM signal_ema se
      JOIN macd_with_seed_rn m ON m.macd_rn = se.macd_rn + 1
    )
    SELECT '${ticker}' AS ticker, m.dt,
      ${fastPeriod} AS fast_period, ${slowPeriod} AS slow_period, ${signalPeriod} AS signal_period,
      m.macd_line, se.ema AS signal_line,
      m.macd_line - se.ema AS histogram
    FROM signal_ema se
    JOIN macd_with_seed_rn m ON m.macd_rn = se.macd_rn
  `;
}

/**
 * Convenience: populate both indicator tables for a list of tickers.
 * Keeps screener / backtest tests concise.
 */
export async function populateIndicators(
  fixture: FixtureDb,
  tickers: string[],
): Promise<void> {
  for (const t of tickers) {
    await fixture.query(materializeRsiSql(t, 14));
    await fixture.query(materializeMacdSql(t, 12, 26, 9));
  }
}
