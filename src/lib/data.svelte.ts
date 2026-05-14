// Data pipeline: fetch from Twelve Data → persist into DuckDB → expose reactive state.
//
// Phase A multi-ticker rewrite: `refreshData` and `refreshState` now take
// a ticker argument explicitly. The reactive `dataState` keeps a single
// "last operation" view (loading/error/lastFetched) plus a per-ticker
// row-count map so the DataPanel can show progress for "Refresh all"
// without each per-ticker view fighting for the same scalar fields.
//
// Uses Svelte 5 runes — file must end in `.svelte.ts`.

import { settings } from './settings.svelte';
import { ensureSchema, getConn, resetSchemaMemo } from './duckdb';
import {
  fetchDailyOhlcv,
  fetchIntradayOhlcv,
  TwelveDataError,
  type OhlcvRow,
  type IntradayRow,
} from './twelvedata';

export interface DataState {
  loading: boolean;
  /** Most recent successful refresh time across all tickers. */
  lastFetched: Date | null;
  /** Per-ticker row count in DuckDB; populated lazily on first refreshState. */
  rowCount: Record<string, number>;
  /** Per-ticker latest fetch timestamp from fetch_log (ok status). */
  lastFetchedByTicker: Record<string, Date | null>;
  /** Per-ticker latest close + date for footer/data panel display. */
  latestCloseByTicker: Record<string, number | null>;
  latestDateByTicker: Record<string, string | null>;
  error: string | null;
  /** Progress for multi-position refresh; null when idle or single-ticker. */
  refreshProgress: { current: number; total: number; ticker: string } | null;
  /** Per-ticker latest intraday refresh timestamp (separate from daily). */
  intradayLastFetched: Record<string, Date | null>;
  /** Per-ticker intraday row count (today's bars). */
  intradayRowCount: Record<string, number>;
  /** Set while an intraday refresh is in flight (independent of `loading`). */
  intradayLoading: boolean;
}

export const dataState = $state<DataState>({
  loading: false,
  lastFetched: null,
  rowCount: {},
  lastFetchedByTicker: {},
  latestCloseByTicker: {},
  latestDateByTicker: {},
  error: null,
  refreshProgress: null,
  intradayLastFetched: {},
  intradayRowCount: {},
  intradayLoading: false,
});

// Debounce: prevent runaway clicks against an 8-req/min free tier.
const REFRESH_COOLDOWN_MS = 10_000;
let lastRefreshAt = 0;

// Twelve Data free-tier rate limit. Spacing requests by ~8s keeps us
// under 8 requests per rolling 60s window with a small safety margin.
const RATE_LIMIT_SPACING_MS = 8_000;
const RATE_LIMIT_FREE_THRESHOLD = 7; // up to this many positions = no spacing

export function refreshCooldownRemainingMs(): number {
  const elapsed = Date.now() - lastRefreshAt;
  return Math.max(0, REFRESH_COOLDOWN_MS - elapsed);
}

/**
 * Refresh a single ticker. Validates inputs, respects the cooldown, and
 * keeps `dataState` in sync. Returns `true` on success, `false` on any
 * validated failure (cooldown, missing key/ticker, fetch error).
 */
export async function refreshData(tickerArg?: string): Promise<boolean> {
  if (dataState.loading) return false;

  const remaining = refreshCooldownRemainingMs();
  if (remaining > 0) {
    dataState.error = `Please wait ${Math.ceil(remaining / 1000)}s before refreshing again.`;
    return false;
  }

  const ticker = (tickerArg ?? '').trim().toUpperCase();
  const apiKey = settings.apiKey.trim();

  if (!apiKey) {
    dataState.error = 'API key is required. Add one in Settings.';
    return false;
  }
  if (!ticker) {
    dataState.error = 'Ticker is required.';
    return false;
  }

  dataState.loading = true;
  dataState.error = null;
  lastRefreshAt = Date.now();

  let rowsInserted = 0;
  let status = 'ok';
  let ok = false;

  try {
    const { rows } = await fetchDailyOhlcv(ticker, apiKey, 500);
    rowsInserted = await insertRows(ticker, rows);
    try {
      await logFetch(ticker, rowsInserted, status);
    } catch (logErr) {
      console.warn('Failed to write fetch_log (non-fatal):', logErr);
    }
    await refreshState(ticker);
    ok = true;
  } catch (err) {
    status = 'error';
    if (err instanceof TwelveDataError) {
      dataState.error = `Twelve Data ${err.code ? `(${err.code}) ` : ''}${err.message}`;
    } else {
      dataState.error = err instanceof Error ? err.message : String(err);
    }
    try {
      await logFetch(ticker, 0, status);
    } catch (logErr) {
      console.warn('fetch_log insert failed', logErr);
    }
  } finally {
    dataState.loading = false;
  }
  return ok;
}

/**
 * Refresh every configured position sequentially, with rate-limit-aware
 * spacing (~8s between calls when there are more than 7 positions, since
 * Twelve Data's free tier is 8 req/min).
 *
 * Reports progress through `dataState.refreshProgress` so the DataPanel
 * can show "Refreshing 2/4: AAPL…". Cooldown is bypassed between calls
 * within this batch — the spacing replaces it.
 */
export async function refreshAll(): Promise<void> {
  if (dataState.loading) return;
  const apiKey = settings.apiKey.trim();
  if (!apiKey) {
    dataState.error = 'API key is required. Add one in Settings.';
    return;
  }
  const tickers = settings.positions.map((p) => p.ticker.trim().toUpperCase()).filter(Boolean);
  if (tickers.length === 0) {
    dataState.error = 'No positions configured. Add one in the Positions panel.';
    return;
  }

  const needsSpacing = tickers.length > RATE_LIMIT_FREE_THRESHOLD;
  dataState.refreshProgress = { current: 0, total: tickers.length, ticker: tickers[0] };
  dataState.error = null;

  for (let i = 0; i < tickers.length; i++) {
    const t = tickers[i];
    dataState.refreshProgress = { current: i + 1, total: tickers.length, ticker: t };
    // Force-refresh by resetting the cooldown clock — the explicit spacing
    // below handles rate limiting for the batch case.
    lastRefreshAt = 0;
    await refreshData(t);
    if (needsSpacing && i < tickers.length - 1) {
      await sleep(RATE_LIMIT_SPACING_MS);
    }
  }

  dataState.refreshProgress = null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Refresh today's intraday (5-minute) bars for one ticker.
 *
 * Independent of the daily-refresh cooldown — intraday is its own
 * call budget against the same Twelve Data quota, and the user
 * triggers it explicitly from the chart toolbar's "1D" view. We do
 * still respect `dataState.intradayLoading` to prevent double-clicks
 * from issuing two requests.
 *
 * Logs to fetch_log with status `'ok-intraday'` (or `'error-intraday'`)
 * so the audit log can distinguish the two refresh paths without
 * reverse-engineering the call site.
 */
export async function refreshIntradayData(tickerArg?: string): Promise<boolean> {
  if (dataState.intradayLoading) return false;

  const ticker = (tickerArg ?? '').trim().toUpperCase();
  const apiKey = settings.apiKey.trim();

  if (!apiKey) {
    dataState.error = 'API key is required. Add one in Settings.';
    return false;
  }
  if (!ticker) {
    dataState.error = 'Ticker is required.';
    return false;
  }

  dataState.intradayLoading = true;
  dataState.error = null;

  let rowsInserted = 0;
  let status = 'ok-intraday';
  let ok = false;

  try {
    // 78 bars ≈ one US trading session (6.5h × 12 bars/h) at 5min.
    const { rows } = await fetchIntradayOhlcv(ticker, apiKey, '5min', 78);
    rowsInserted = await insertIntradayRows(ticker, rows);
    try {
      await logFetch(ticker, rowsInserted, status);
    } catch (logErr) {
      console.warn('Failed to write fetch_log (non-fatal):', logErr);
    }
    await refreshIntradayState(ticker);
    ok = true;
  } catch (err) {
    status = 'error-intraday';
    if (err instanceof TwelveDataError) {
      dataState.error = `Twelve Data ${err.code ? `(${err.code}) ` : ''}${err.message}`;
    } else {
      dataState.error = err instanceof Error ? err.message : String(err);
    }
    try {
      await logFetch(ticker, 0, status);
    } catch (logErr) {
      console.warn('fetch_log insert failed', logErr);
    }
  } finally {
    dataState.intradayLoading = false;
  }
  return ok;
}

async function insertIntradayRows(ticker: string, rows: IntradayRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  await ensureSchema();
  const conn = await getConn();

  await conn.query('BEGIN TRANSACTION');
  try {
    const stmt = await conn.prepare(
      `INSERT OR REPLACE INTO ohlcv_intraday (ticker, ts, open, high, low, close, volume)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      for (const r of rows) {
        await stmt.query(
          ticker,
          r.ts,
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

/**
 * Refresh `dataState.intraday*` fields for one ticker by re-querying
 * today's intraday row count and the latest fetch timestamp.
 */
export async function refreshIntradayState(tickerArg?: string): Promise<void> {
  await ensureSchema();
  const conn = await getConn();
  const tickers = tickerArg
    ? [tickerArg.trim().toUpperCase()].filter(Boolean)
    : settings.positions.map((p) => p.ticker.trim().toUpperCase()).filter(Boolean);

  for (const ticker of tickers) {
    const stmt = await conn.prepare(
      `SELECT COUNT(*)::INTEGER AS row_count
       FROM ohlcv_intraday
       WHERE ticker = ? AND date(ts) = CURRENT_DATE`,
    );
    try {
      const tbl = await stmt.query(ticker);
      const r = tbl.toArray().map((row) => ({ ...row.toJSON() }))[0] as
        | { row_count: number }
        | undefined;
      dataState.intradayRowCount[ticker] = Number(r?.row_count ?? 0);
    } finally {
      await stmt.close();
    }

    const logStmt = await conn.prepare(
      `SELECT fetched_at FROM fetch_log
       WHERE ticker = ? AND status = 'ok-intraday'
       ORDER BY fetched_at DESC LIMIT 1`,
    );
    try {
      const tbl = await logStmt.query(ticker);
      const r = tbl.toArray().map((row) => ({ ...row.toJSON() }))[0] as
        | { fetched_at: unknown }
        | undefined;
      dataState.intradayLastFetched[ticker] = r ? toDate(r.fetched_at) : null;
    } finally {
      await logStmt.close();
    }
  }
}

/**
 * Insert rows using a prepared statement inside a transaction. INSERT OR REPLACE
 * keeps the latest fetch authoritative when the same (ticker, dt) is fetched twice.
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
 * Recompute derived state for one ticker from the database. When called
 * without a ticker, refreshes all configured positions (used on app boot
 * to pull persisted OPFS data into reactive state).
 */
export async function refreshState(tickerArg?: string): Promise<void> {
  await ensureSchema();
  const conn = await getConn();

  const tickers = tickerArg
    ? [tickerArg.trim().toUpperCase()].filter(Boolean)
    : settings.positions.map((p) => p.ticker.trim().toUpperCase()).filter(Boolean);

  for (const ticker of tickers) {
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
    dataState.rowCount[ticker] = rowCount;
    if (rowCount > 0 && row) {
      dataState.latestDateByTicker[ticker] = formatDate(row.latest_dt);
      dataState.latestCloseByTicker[ticker] =
        row.latest_close == null ? null : Number(row.latest_close);
    } else {
      dataState.latestCloseByTicker[ticker] = null;
      dataState.latestDateByTicker[ticker] = null;
    }

    const logStmt = await conn.prepare(
      `SELECT fetched_at FROM fetch_log
       WHERE ticker = ? AND status = 'ok'
       ORDER BY fetched_at DESC LIMIT 1`,
    );
    try {
      const tbl = await logStmt.query(ticker);
      const r = tbl.toArray().map((row) => ({ ...row.toJSON() }))[0] as
        | { fetched_at: unknown }
        | undefined;
      const d = r ? toDate(r.fetched_at) : null;
      dataState.lastFetchedByTicker[ticker] = d;
      // Bump the "global" lastFetched watermark so consumers tracking it as
      // a single reactivity dep still re-render when any ticker refreshes.
      if (d && (!dataState.lastFetched || d.getTime() > dataState.lastFetched.getTime())) {
        dataState.lastFetched = d;
      }
    } finally {
      await logStmt.close();
    }
  }
}

export async function clearCache(): Promise<void> {
  const conn = await getConn();
  // Drop the view first (depends on ohlcv), then the data tables, then the
  // migrations meta table. Resetting `_meta` is what forces the migration
  // path to rebuild everything from version 0 — without it, `runMigrations`
  // would skip every step because `schema_version` still equals the latest.
  await conn.query('DROP VIEW IF EXISTS current_snapshot');
  await conn.query('DROP TABLE IF EXISTS ohlcv');
  await conn.query('DROP TABLE IF EXISTS ohlcv_intraday');
  await conn.query('DROP TABLE IF EXISTS fetch_log');
  await conn.query('DROP TABLE IF EXISTS _meta');
  // The schemaPromise resolved during boot — reset it so the next call
  // re-runs the migration sequence on the cleared database.
  resetSchemaMemo();
  await ensureSchema(conn);
  // Reset all per-ticker tracking — the tables are now empty.
  dataState.rowCount = {};
  dataState.lastFetchedByTicker = {};
  dataState.latestCloseByTicker = {};
  dataState.latestDateByTicker = {};
  dataState.intradayRowCount = {};
  dataState.intradayLastFetched = {};
  dataState.lastFetched = null;
  await refreshState();
}

// --- helpers ---

function formatDate(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) {
    return Number.isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : '';
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return trimmed.slice(0, 10);
    return '';
  }
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
