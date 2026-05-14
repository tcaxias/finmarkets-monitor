// Schema migrations for the OPFS-backed DuckDB database.
//
// Why a migrations system? Until now, `ensureSchema()` issued a fixed set of
// `CREATE TABLE IF NOT EXISTS` statements at boot. That worked for the
// initial three tables but doesn't generalise: as the schema grows
// (views, new columns, indexes), we need a way to apply changes
// incrementally to a database that may have been bootstrapped at any
// prior version, without dropping user data.
//
// Design:
// - A `_meta(key, value)` table records the current `schema_version`
//   (string-encoded for forward-compat with non-integer values).
// - Migrations are an ordered, append-only array. Each has a numeric
//   version, a human-readable description, and an `up` function.
// - Applied versions are skipped. Each migration runs in its own
//   transaction so a mid-migration crash leaves the DB at a recoverable
//   state of (version - 1) rather than half-applied.
// - Migrations must be idempotent or the application of v1 against an
//   already-bootstrapped database will fail. `CREATE TABLE IF NOT
//   EXISTS` and `CREATE OR REPLACE VIEW` are the safe primitives.
//
// Adding a migration: append to MIGRATIONS with `version = previous + 1`.
// Update the SCHEMA_VERSION pin in `migrations.test.ts`. Never edit a
// migration that has shipped — migrations are immutable history.
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';

interface Migration {
  version: number;
  description: string;
  up: (conn: AsyncDuckDBConnection) => Promise<void>;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description:
      'Initial baseline (ohlcv, ohlcv_intraday, fetch_log) — captures pre-migration state',
    up: async (conn) => {
      // Idempotent — these tables may already exist from before the migrations
      // system was introduced. CREATE TABLE IF NOT EXISTS makes this a no-op
      // for already-bootstrapped databases while still being correct for
      // fresh ones.
      await conn.query(`
        CREATE TABLE IF NOT EXISTS ohlcv (
          ticker VARCHAR NOT NULL,
          dt DATE NOT NULL,
          open DOUBLE NOT NULL,
          high DOUBLE NOT NULL,
          low DOUBLE NOT NULL,
          close DOUBLE NOT NULL,
          volume BIGINT,
          PRIMARY KEY (ticker, dt)
        );
      `);
      await conn.query(`
        CREATE TABLE IF NOT EXISTS ohlcv_intraday (
          ticker VARCHAR NOT NULL,
          ts TIMESTAMP NOT NULL,
          open DOUBLE NOT NULL,
          high DOUBLE NOT NULL,
          low DOUBLE NOT NULL,
          close DOUBLE NOT NULL,
          volume BIGINT,
          PRIMARY KEY (ticker, ts)
        );
      `);
      await conn.query(`
        CREATE TABLE IF NOT EXISTS fetch_log (
          ticker VARCHAR NOT NULL,
          fetched_at TIMESTAMP NOT NULL,
          rows_inserted INTEGER NOT NULL,
          status VARCHAR NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    description:
      'Add current_snapshot view (one row per ticker with latest close + prev close)',
    up: async (conn) => {
      // CREATE OR REPLACE so re-running the migration is safe. The view
      // resolves at query time, so a new column added to `ohlcv` later
      // doesn't require a view rebuild — but if we ever need to change
      // the projection, just bump SCHEMA_VERSION with another migration
      // that re-issues CREATE OR REPLACE VIEW.
      //
      // Per-ticker correlated subqueries are intentional: the alternative
      // (LAG(close) OVER (PARTITION BY ticker ORDER BY dt)) would require
      // reading the entire ohlcv table for one row per ticker. Subqueries
      // hit the (ticker, dt) primary key index directly.
      await conn.query(`
        CREATE OR REPLACE VIEW current_snapshot AS
        WITH latest AS (
          SELECT ticker, MAX(dt) AS latest_dt
          FROM ohlcv
          GROUP BY ticker
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
        JOIN latest l ON l.ticker = o.ticker AND l.latest_dt = o.dt;
      `);
    },
  },
  {
    version: 3,
    description:
      'Materialised RSI(14) and MACD(12,26,9) tables (computed in DuckDB SQL via recursive CTEs)',
    up: async (conn) => {
      // Why materialise instead of compute-on-read?
      // RSI/MACD are recursive (each bar depends on the previous bar's
      // smoothed value). DuckDB can express that as a recursive CTE, but
      // re-running it on every chart redraw is wasteful: the inputs only
      // change when new OHLCV rows are inserted. Materialising lets the
      // chart path become a pure indexed read of (ticker, dt) — tens of
      // microseconds instead of tens of milliseconds.
      //
      // Refresh policy is "rebuild on data change": after a successful
      // OHLCV insert, the data layer calls `refreshIndicators(ticker)`
      // (see sqlIndicators.ts) which DELETEs the prior rows for that
      // ticker and INSERTs the freshly-computed series. Cheap because
      // it's bounded to one ticker; correct because there's no
      // partial-update window where stale tail rows could leak.
      //
      // Schema notes:
      // - `period` (RSI) and `(fast_period, slow_period, signal_period)`
      //   (MACD) are part of the primary key so multiple period sets
      //   could coexist if we ever add e.g. RSI(7) for short-term work.
      // - macd_line / signal_line / histogram are NULLable because in
      //   principle a degenerate input (constant closes) yields zero
      //   for all three; we still write the row so the chart pane has
      //   a continuous time axis.
      await conn.query(`
        CREATE TABLE IF NOT EXISTS indicators_rsi (
          ticker VARCHAR NOT NULL,
          dt DATE NOT NULL,
          period INTEGER NOT NULL,
          value DOUBLE NOT NULL,
          PRIMARY KEY (ticker, dt, period)
        );
      `);
      await conn.query(`
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
        );
      `);
    },
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/**
 * Apply all pending migrations against `conn`. Idempotent: migrations
 * already recorded in `_meta.schema_version` are skipped. Each pending
 * migration runs in its own transaction so a failure in v(N) leaves the
 * DB at v(N-1) — safe to re-run from there once the bug is fixed.
 *
 * Throws (with a wrapped message identifying the failed version) if any
 * migration fails. The transaction is rolled back before the throw.
 */
export async function runMigrations(conn: AsyncDuckDBConnection): Promise<void> {
  // Bootstrap the meta table first. This is itself idempotent.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS _meta (
      key VARCHAR PRIMARY KEY,
      value VARCHAR NOT NULL
    );
  `);

  // Read current version (0 if never migrated).
  const result = await conn.query(
    `SELECT value FROM _meta WHERE key = 'schema_version' LIMIT 1`,
  );
  const rows = result.toArray().map((r) => r.toJSON() as { value: string });
  const current = rows.length > 0 ? parseInt(rows[0].value, 10) : 0;

  // Apply pending migrations in order. Each migration runs in its own
  // transaction so a failure in migration N doesn't leave the DB at a
  // half-applied state of N (we can re-run from N).
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    console.info(`migrations: applying v${m.version} — ${m.description}`);
    await conn.query('BEGIN TRANSACTION');
    try {
      await m.up(conn);
      // Upsert version. DuckDB supports ON CONFLICT.
      await conn.query(
        `INSERT INTO _meta (key, value) VALUES ('schema_version', '${m.version}')
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      );
      await conn.query('COMMIT');
      console.info(`migrations: v${m.version} applied`);
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => {});
      throw new Error(
        `migration v${m.version} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
