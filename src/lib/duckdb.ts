// DuckDB-WASM initialization with Vite asset URLs.
// Reference: https://duckdb.org/docs/api/wasm/instantiation
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

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;
let connPromise: Promise<duckdb.AsyncDuckDBConnection> | null = null;

export async function getDb(): Promise<duckdb.AsyncDuckDB> {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
    const worker = new Worker(bundle.mainWorker!);
    const logger = new duckdb.ConsoleLogger();
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    const version = await db.getVersion();
    console.log(`DuckDB ready (v${version})`);
    return db;
  })();
  return dbPromise;
}

export async function getConn(): Promise<duckdb.AsyncDuckDBConnection> {
  if (connPromise) return connPromise;
  connPromise = (async () => {
    const db = await getDb();
    return db.connect();
  })();
  return connPromise;
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
