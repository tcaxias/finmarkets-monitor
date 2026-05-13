// DuckDB-WASM initialization with Vite asset URLs.
// Reference: https://duckdb.org/docs/api/wasm/instantiation
// OPFS persistence: https://duckdb.org/docs/api/wasm/persistence
import * as duckdb from '@duckdb/duckdb-wasm';

import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvp_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import duckdb_wasm_eh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import eh_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
  mvp: {
    mainModule: duckdb_wasm,
    mainWorker: mvp_worker,
  },
  eh: {
    mainModule: duckdb_wasm_eh,
    mainWorker: eh_worker,
  },
};

const OPFS_DB_PATH = 'opfs://finmarkets.db';

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;
let connPromise: Promise<duckdb.AsyncDuckDBConnection> | null = null;
let schemaPromise: Promise<void> | null = null;

// Whether the active database persists across reloads (OPFS) or is volatile.
// Set during init; default false until proven persistent.
export let isPersistent = false;

function opfsAvailable(): boolean {
  // OPFS lives on navigator.storage.getDirectory(). Some private-mode browsers
  // expose `navigator.storage` but throw on getDirectory(); we detect best-effort here
  // and let the actual `db.open()` call surface deeper failures.
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage !== 'undefined' &&
    typeof navigator.storage.getDirectory === 'function'
  );
}

export async function getDb(): Promise<duckdb.AsyncDuckDB> {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
    const worker = new Worker(bundle.mainWorker!);
    const logger = new duckdb.ConsoleLogger();
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

    // Try to open the OPFS-backed database. If it fails (Safari quirks, private
    // browsing, missing API), fall back to in-memory and log a warning.
    if (opfsAvailable()) {
      try {
        await db.open({
          path: OPFS_DB_PATH,
          accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
        });
        isPersistent = true;
      } catch (err) {
        console.warn(
          'OPFS persistence unavailable; falling back to in-memory DuckDB.',
          err,
        );
        isPersistent = false;
        // No explicit open() needed for in-memory — instantiate already gave us one.
      }
    } else {
      console.warn(
        'OPFS API not detected; using in-memory DuckDB (data will not survive reload).',
      );
      isPersistent = false;
    }

    const version = await db.getVersion();
    console.log(
      `DuckDB ready (v${version}) — storage: ${isPersistent ? 'OPFS' : 'in-memory'}`,
    );
    return db;
  })();
  return dbPromise;
}

export async function getConn(): Promise<duckdb.AsyncDuckDBConnection> {
  if (connPromise) return connPromise;
  connPromise = (async () => {
    const db = await getDb();
    const conn = await db.connect();
    // Ensure schema once per process.
    await ensureSchema(conn);
    return conn;
  })();
  return connPromise;
}

/**
 * Idempotent schema bootstrap. Safe to call repeatedly; CREATE TABLE IF NOT EXISTS
 * makes this cheap on subsequent loads when OPFS already has the tables.
 */
export async function ensureSchema(
  conn?: duckdb.AsyncDuckDBConnection,
): Promise<void> {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const c = conn ?? (await (await getDb()).connect());
    await c.query(`
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
    await c.query(`
      CREATE TABLE IF NOT EXISTS fetch_log (
        ticker VARCHAR NOT NULL,
        fetched_at TIMESTAMP NOT NULL,
        rows_inserted INTEGER NOT NULL,
        status VARCHAR NOT NULL
      );
    `);
  })();
  return schemaPromise;
}

export async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const conn = await getConn();
  const result = await conn.query(sql);
  // toArray() returns Arrow rows; spread them into plain JS objects.
  return result.toArray().map((row) => ({ ...row.toJSON() })) as T[];
}

export async function getVersion(): Promise<string> {
  const db = await getDb();
  return db.getVersion();
}
