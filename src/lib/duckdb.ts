// DuckDB-WASM initialization.
// Reference: https://duckdb.org/docs/api/wasm/instantiation
// OPFS persistence: https://duckdb.org/docs/api/wasm/persistence
//
// DuckDB-WASM binary loading strategy:
// - Workers (~800 KB each) are bundled via Vite ?url imports — small enough for
//   Cloudflare Pages' 25 MiB per-file upload limit and required to be same-origin
//   in some browsers.
// - WASM blobs (35-41 MB each) exceed the 25 MiB Pages limit. We load them from
//   jsDelivr's npm mirror, which serves the same files DuckDB-WASM ships in its
//   npm package. The version is pinned to match our installed npm dependency to
//   avoid silent ABI drift.
import * as duckdb from '@duckdb/duckdb-wasm';

import mvp_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import eh_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import { runtimeState } from './runtimeState.svelte';
import { runMigrations } from './migrations';

// Keep this version in sync with the installed @duckdb/duckdb-wasm in package.json.
// If you bump the npm dependency, also bump this constant. Mismatch = subtle ABI bugs.
const DUCKDB_WASM_VERSION = '1.33.1-dev45.0';
const DUCKDB_CDN_BASE = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_WASM_VERSION}/dist`;
const duckdb_wasm = `${DUCKDB_CDN_BASE}/duckdb-mvp.wasm`;
const duckdb_wasm_eh = `${DUCKDB_CDN_BASE}/duckdb-eh.wasm`;

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

// Persistence status (OPFS vs in-memory) lives on
// `runtimeState.isPersistent`. Components read it reactively from
// runtimeState.svelte.ts directly — no wrapper needed here.

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
    console.info(`DuckDB-WASM loading from CDN: ${DUCKDB_CDN_BASE}`);
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
        runtimeState.isPersistent = true;
      } catch (err) {
        console.warn(
          'OPFS persistence unavailable; falling back to in-memory DuckDB.',
          err,
        );
        runtimeState.isPersistent = false;
        // No explicit open() needed for in-memory — instantiate already gave us one.
      }
    } else {
      console.warn(
        'OPFS API not detected; using in-memory DuckDB (data will not survive reload).',
      );
      runtimeState.isPersistent = false;
    }

    const version = await db.getVersion();
    console.log(
      `DuckDB ready (v${version}) — storage: ${runtimeState.isPersistent ? 'OPFS' : 'in-memory'}`,
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
 * Idempotent schema bootstrap. Delegates to the migrations runner
 * (`migrations.ts`), which applies any pending versioned migrations and
 * records the result in the `_meta` table. Safe to call repeatedly; the
 * promise is memoized so the migration loop only runs once per process.
 *
 * If a connection is passed in, we use it. Otherwise we open a temporary
 * connection and close it in a `finally` so we don't leak handles into the
 * DuckDB-WASM worker.
 *
 * Tests / `clearCache` may need to reset the memo after dropping tables —
 * use `resetSchemaMemo()`.
 */
export async function ensureSchema(
  conn?: duckdb.AsyncDuckDBConnection,
): Promise<void> {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    let c: duckdb.AsyncDuckDBConnection;
    let ownConnection = false;
    if (conn) {
      c = conn;
    } else {
      c = await (await getDb()).connect();
      ownConnection = true;
    }
    try {
      await runMigrations(c);
    } finally {
      if (ownConnection) {
        await c.close().catch((err) => {
          console.warn('ensureSchema: failed to close ad-hoc connection', err);
        });
      }
    }
  })();
  return schemaPromise;
}

/**
 * Clear the memoized `ensureSchema` promise. Call this *after* dropping
 * schema-bearing tables (notably `_meta`) so the next `ensureSchema()` call
 * re-runs migrations from scratch instead of returning the resolved-no-op
 * promise from the prior bootstrap.
 *
 * Only `clearCache` (and tests) should need this.
 */
export function resetSchemaMemo(): void {
  schemaPromise = null;
}

export async function getVersion(): Promise<string> {
  const db = await getDb();
  return db.getVersion();
}
