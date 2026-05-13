// Data pipeline: fetch from Twelve Data → persist into DuckDB → expose reactive state.
// Uses Svelte 5 runes — file must end in `.svelte.ts`.

import { settings } from './settings.svelte';
import { ensureSchema, getConn } from './duckdb';
import { fetchDailyOhlcv, TwelveDataError, type OhlcvRow } from './twelvedata';

export const dataState = $state({
  loading: false,
  lastFetched: null as Date | null,
  rowCount: 0,
  latestClose: null as number | null,
  latestDate: null as string | null,
  error: null as string | null,
});

// Debounce: prevent runaway clicks against an 8-req/min free tier.
const REFRESH_COOLDOWN_MS = 10_000;
let lastRefreshAt = 0;

export function refreshCooldownRemainingMs(): number {
  const elapsed = Date.now() - lastRefreshAt;
  return Math.max(0, REFRESH_COOLDOWN_MS - elapsed);
}

export async function refreshData(): Promise<void> {
  if (dataState.loading) return;

  const remaining = refreshCooldownRemainingMs();
  if (remaining > 0) {
    dataState.error = `Please wait ${Math.ceil(remaining / 1000)}s before refreshing again.`;
    return;
  }

  const ticker = settings.ticker.trim();
  const apiKey = settings.apiKey.trim();

  if (!apiKey) {
    dataState.error = 'API key is required. Add one in Settings.';
    return;
  }
  if (!ticker) {
    dataState.error = 'Ticker is required. Set one in Settings.';
    return;
  }

  dataState.loading = true;
  dataState.error = null;
  lastRefreshAt = Date.now();

  let rowsInserted = 0;
  let status = 'ok';

  try {
    const { rows } = await fetchDailyOhlcv(ticker, apiKey, 500);
    rowsInserted = await insertRows(ticker, rows);
    // logFetch is best-effort: a failure here MUST NOT mark the refresh
    // as failed when the data was inserted successfully. The audit log
    // is informational; the user-visible state should reflect what's in
    // the data table.
    try {
      await logFetch(ticker, rowsInserted, status);
    } catch (logErr) {
      console.warn('Failed to write fetch_log (non-fatal):', logErr);
    }
    await refreshState();
  } catch (err) {
    status = 'error';
    if (err instanceof TwelveDataError) {
      dataState.error = `Twelve Data ${err.code ? `(${err.code}) ` : ''}${err.message}`;
    } else {
      dataState.error = err instanceof Error ? err.message : String(err);
    }
    // Best-effort log of the failure; never let logging mask the original error.
    try {
      await logFetch(ticker, 0, status);
    } catch (logErr) {
      console.warn('fetch_log insert failed', logErr);
    }
  } finally {
    dataState.loading = false;
  }
}

/**
 * Insert rows using a prepared statement inside a transaction. INSERT OR REPLACE
 * keeps the latest fetch authoritative when the same (ticker, dt) is fetched twice.
 *
 * For ~500 rows this is well within DuckDB-WASM's prepared-statement budget; we
 * could collapse to a single multi-row VALUES list but the per-row prepare avoids
 * SQL-injection risk and keeps the code straightforward.
 */
async function insertRows(ticker: string, rows: OhlcvRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  await ensureSchema();
  const conn = await getConn();

  await conn.query('BEGIN TRANSACTION');
  try {
    const stmt = await conn.prepare(
      `INSERT OR REPLACE INTO ohlcv (ticker, dt, open, high, low, close, volume)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      for (const r of rows) {
        await stmt.query(
          ticker,
          r.dt,
          r.open,
          r.high,
          r.low,
          r.close,
          r.volume,
        );
      }
    } finally {
      await stmt.close();
    }
    await conn.query('COMMIT');
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  }

  return rows.length;
}

async function logFetch(
  ticker: string,
  rowsInserted: number,
  status: string,
): Promise<void> {
  await ensureSchema();
  const conn = await getConn();
  const stmt = await conn.prepare(
    `INSERT INTO fetch_log (ticker, fetched_at, rows_inserted, status)
     VALUES (?, CURRENT_TIMESTAMP, ?, ?)`,
  );
  try {
    await stmt.query(ticker, rowsInserted, status);
  } finally {
    await stmt.close();
  }
}

/**
 * Recompute derived state from the database. Cheap; safe to call after any
 * mutation or on initial load to surface previously-persisted OPFS data.
 */
export async function refreshState(): Promise<void> {
  await ensureSchema();
  const conn = await getConn();
  const ticker = settings.ticker.trim();

  if (!ticker) {
    dataState.rowCount = 0;
    dataState.latestClose = null;
    dataState.latestDate = null;
    dataState.lastFetched = null;
    return;
  }

  // One round-trip: get count, latest date, and latest close together.
  // Avoids passing a JS-formatted date back into a parameterized DATE column,
  // which DuckDB-WASM can reject as "invalid date" depending on Arrow encoding.
  const stmt = await conn.prepare(
    `SELECT
       (SELECT COUNT(*)::INTEGER FROM ohlcv WHERE ticker = ?) AS row_count,
       (SELECT dt FROM ohlcv WHERE ticker = ? ORDER BY dt DESC LIMIT 1) AS latest_dt,
       (SELECT close FROM ohlcv WHERE ticker = ? ORDER BY dt DESC LIMIT 1) AS latest_close`,
  );
  let row:
    | { row_count: number; latest_dt: unknown; latest_close: unknown }
    | undefined;
  try {
    const tbl = await stmt.query(ticker, ticker, ticker);
    row = tbl.toArray().map((r) => ({ ...r.toJSON() }))[0] as
      | { row_count: number; latest_dt: unknown; latest_close: unknown }
      | undefined;
  } finally {
    await stmt.close();
  }

  const rowCount = Number(row?.row_count ?? 0);
  dataState.rowCount = rowCount;

  if (rowCount > 0 && row) {
    dataState.latestDate = formatDate(row.latest_dt);
    dataState.latestClose = row.latest_close == null ? null : Number(row.latest_close);
  } else {
    dataState.latestClose = null;
    dataState.latestDate = null;
  }

  // Most-recent successful fetch from the audit log.
  const logStmt = await conn.prepare(
    `SELECT fetched_at FROM fetch_log
     WHERE ticker = ? AND status = 'ok'
     ORDER BY fetched_at DESC LIMIT 1`,
  );
  try {
    const tbl = await logStmt.query(ticker);
    const row = tbl.toArray().map((r) => ({ ...r.toJSON() }))[0] as
      | { fetched_at: unknown }
      | undefined;
    dataState.lastFetched = row ? toDate(row.fetched_at) : null;
  } finally {
    await logStmt.close();
  }
}

export async function clearCache(): Promise<void> {
  const conn = await getConn();
  await conn.query('DROP TABLE IF EXISTS ohlcv');
  await conn.query('DROP TABLE IF EXISTS fetch_log');
  // Reset memoized schema bootstrap so the next call recreates the tables.
  // We re-run the DDL here directly so callers don't need to know about the
  // memoization detail.
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
    CREATE TABLE IF NOT EXISTS fetch_log (
      ticker VARCHAR NOT NULL,
      fetched_at TIMESTAMP NOT NULL,
      rows_inserted INTEGER NOT NULL,
      status VARCHAR NOT NULL
    );
  `);
  await refreshState();
}

// --- helpers ---

function formatDate(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) {
    return Number.isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : '';
  }
  if (typeof v === 'string') {
    // Already-ISO date; trim time portion if present.
    const trimmed = v.trim();
    // Validate it parses to a real date before trusting it.
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return trimmed.slice(0, 10);
    return '';
  }
  // DuckDB DATE via Arrow comes back as either:
  //   - number = days since 1970-01-01
  //   - bigint = same, or sometimes ms-since-epoch in some Arrow versions
  // Heuristic: any value > ~1e6 is too large to be days (would be year ~4700+),
  // so treat it as ms. Anything smaller is days.
  if (typeof v === 'number' || typeof v === 'bigint') {
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    const ms = Math.abs(n) > 1_000_000 ? n : n * 86_400_000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  return '';
}

function toDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'bigint') return new Date(Number(v));
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}
