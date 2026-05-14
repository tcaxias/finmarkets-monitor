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
import { refreshIndicators } from './sqlIndicators';
import {
  fetchDailyOhlcv,
  fetchEarnings,
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
  /** Per-ticker count of stored earnings_events rows. */
  earningsRowCount: Record<string, number>;
  /** Per-ticker last successful earnings refresh timestamp. */
  earningsLastFetched: Record<string, Date | null>;
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
  earningsRowCount: {},
  earningsLastFetched: {},
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
    // Recompute the materialised RSI/MACD tables for this ticker. The
    // OHLCV insert above is the source of truth — even if indicators
    // fail to materialise, the chart renders correctly. We previously
    // swallowed errors silently to console.warn, which let a real bug
    // (missing WITH RECURSIVE keyword in the CTE) hide for an entire
    // commit cycle. Now we surface the error to dataState.error so the
    // user sees it in the UI, but we still don't reject the refresh
    // (`ok = true` runs below) — that way the OHLCV data is present and
    // usable while the user can investigate the indicator failure.
    try {
      await refreshIndicators(ticker);
    } catch (indErr) {
      const msg = indErr instanceof Error ? indErr.message : String(indErr);
      console.warn(
        'Indicator refresh failed (chart will still render OHLCV; investigate):',
        indErr,
      );
      dataState.error = `Indicator refresh failed for ${ticker}: ${msg}`;
    }
    // Earnings refresh is best-effort: a Twelve Data /earnings hiccup
    // (rate limit, malformed payload, network blip) must NOT block the
    // OHLCV refresh. The function logs to console.warn on failure and
    // intentionally does NOT touch dataState.error — earnings markers
    // are auxiliary annotation, not core data.
    await refreshEarnings(ticker);
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

// Ticker shape check used by `refreshEarnings` before quoting the
// ticker into a SQL string for the COUNT lookup. The schema permits
// any VARCHAR but everything inserted via the app passes the validator
// in settings.svelte.ts. Inlined here to avoid a dependency cycle
// against the reactive settings store.
const REFRESH_EARNINGS_TICKER_RE = /^[A-Z0-9]{1,10}$/;

/**
 * Fetch earnings events for `ticker` from Twelve Data and persist them
 * to the `earnings_events` table. Best-effort — never throws or
 * surfaces to dataState.error. Logs failures to console.warn so a user
 * who notices missing markers can investigate via devtools.
 *
 * Why best-effort: earnings annotations are auxiliary chart decoration.
 * The OHLCV refresh path is the source of truth and must not be
 * blocked by an /earnings endpoint hiccup (rate limit, malformed
 * response, etc).
 *
 * Idempotency: uses INSERT OR REPLACE on the (ticker, dt) PK so
 * re-fetches overwrite the prior row rather than producing duplicates.
 * Per-call cost: 1 Twelve Data API credit.
 */
export async function refreshEarnings(ticker: string): Promise<void> {
  const t = ticker.trim().toUpperCase();
  const apiKey = settings.apiKey.trim();
  if (!apiKey || !t) return;
  // Validate ticker shape before any SQL — defence in depth, even
  // though everything that reaches here came through validated paths.
  if (!REFRESH_EARNINGS_TICKER_RE.test(t)) {
    console.warn(`refreshEarnings: skipping malformed ticker '${t}'`);
    return;
  }
  try {
    const { events } = await fetchEarnings(t, apiKey);
    if (events.length === 0) {
      // Empty response is legitimate — many tickers have no earnings
      // history within Twelve Data's coverage window. Update the
      // count to 0 so the UI can render "no earnings data" affordances.
      dataState.earningsRowCount[t] = 0;
      dataState.earningsLastFetched[t] = new Date();
      return;
    }
    await ensureSchema();
    const conn = await getConn();
    await conn.query('BEGIN TRANSACTION');
    try {
      // INSERT OR REPLACE so re-fetches update existing rows in place
      // rather than producing PK conflicts.
      const stmt = await conn.prepare(
        `INSERT OR REPLACE INTO earnings_events
         (ticker, dt, time_of_day, eps_estimate, eps_actual, surprise_pct, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      );
      try {
        for (const e of events) {
          await stmt.query(
            t,
            e.date,
            e.timeOfDay,
            e.epsEstimate,
            e.epsActual,
            e.surprisePct,
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
    // Inline the ticker (already shape-validated above) since DuckDB-
    // WASM's bind types don't always recognise plain JS strings as
    // VARCHAR comparison operands here. Single-tick injection isn't
    // possible after the regex gate.
    const countResult = await conn.query(
      `SELECT COUNT(*) AS c FROM earnings_events WHERE ticker = '${t}'`,
    );
    const rows = countResult.toArray().map((r) => r.toJSON() as { c: bigint });
    dataState.earningsRowCount[t] = Number(rows[0]?.c ?? 0);
    dataState.earningsLastFetched[t] = new Date();
  } catch (err) {
    // Best-effort path. Don't surface to dataState.error — earnings
    // are auxiliary, OHLCV is what matters. If the user wants to
    // investigate a missing/empty earnings widget they can check the
    // browser console.
    console.warn(`Earnings refresh failed for ${ticker}:`, err);
  }
}

export async function clearCache(): Promise<void> {
  const conn = await getConn();
  // Drop the view first (depends on ohlcv), then the data tables, then the
  // migrations meta table. Resetting `_meta` is what forces the migration
  // path to rebuild everything from version 0 — without it, `runMigrations`
  // would skip every step because `schema_version` still equals the latest.
  await conn.query('DROP VIEW IF EXISTS current_snapshot');
  // Drop indicator tables before the ohlcv base table — they have no
  // dependency on each other or on ohlcv (they're just keyed by ticker)
  // but ordering them here keeps the intent explicit: derived tables
  // first, base tables next, _meta last so the migrations system has
  // to rebuild from scratch.
  await conn.query('DROP TABLE IF EXISTS indicators_rsi');
  await conn.query('DROP TABLE IF EXISTS indicators_macd');
  await conn.query('DROP TABLE IF EXISTS earnings_events');
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
  dataState.earningsRowCount = {};
  dataState.earningsLastFetched = {};
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
