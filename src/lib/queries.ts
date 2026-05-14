// Pure SQL query helpers for chart data.
//
// All time values are returned as unix seconds (Number, not BigInt) so they
// can be passed straight to Lightweight Charts as `UTCTimestamp`. DuckDB
// returns BIGINT columns as native JS BigInt; we convert at the boundary.
//
// SMA warmup is filtered server-side via QUALIFY so the partial-window values
// (mathematically wrong as a "true" SMA) never reach the chart.
//
// `asOf` and `since` filters compose: callers may pass either or both.
//   - `asOf`: upper bound on the date column (`dt <= CAST(? AS DATE)`)
//   - `since`: lower bound on the date column (`dt >= CAST(? AS DATE)`)
// Both are CAST to DATE explicitly because DuckDB-WASM's bind-type
// inference would otherwise see a JS string and bind as VARCHAR — comparing
// VARCHAR to DATE triggers the "invalid date" runtime error we hit in af22d1f.

import { getConn } from './duckdb';

export interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface MaPoint {
  time: number;
  value: number;
}

export interface VolumeBar {
  time: number;
  // `null` when the source row had no volume (e.g. older Twelve Data bars
  // sometimes omit the field). Consumers MUST distinguish "no data" from
  // zero — coercing to 0 silently corrupts averages and the
  // accumulation/distribution witness.
  value: number | null;
  color: string;
}

const VOLUME_UP = '#26a69a';
const VOLUME_DOWN = '#ef5350';

// Coerce DuckDB-returned scalars (which may be BigInt for BIGINT columns or
// Number for DOUBLE) to plain Number. Lightweight Charts will silently
// misrender — or throw — if handed a BigInt.
function toNum(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  return Number(v);
}

// Like `toNum` but preserves null/undefined as null. Used for nullable
// columns (volume) where downstream math depends on knowing "missing"
// vs "zero" — a missing bar shouldn't drag a 20-day average down.
function toNullableNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = toNum(v);
  return Number.isFinite(n) ? n : null;
}

// Coerce a DuckDB DATE/TIMESTAMP cell to an ISO-8601 date string
// ("YYYY-MM-DD"). Mirrors `formatDate` in data.svelte.ts; kept local
// here so queries.ts has no dependency on the reactive data layer.
//
// DuckDB-WASM may surface DATE values as JS Date objects, ISO strings,
// or epoch-day integers depending on driver internals — we accept all
// three and emit `''` for anything we can't parse rather than throwing.
function formatDateValue(v: unknown): string {
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
    // Heuristic: if the magnitude looks like ms-since-epoch keep as-is,
    // otherwise treat it as days-since-epoch (DuckDB's DATE storage).
    const ms = Math.abs(n) > 1_000_000 ? n : n * 86_400_000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  return '';
}

/**
 * Build the WHERE clause and matching parameter array for a daily-table
 * query that's filtered by ticker plus optional asOf upper bound and
 * since lower bound. Centralised so each query function isn't
 * repeating the same five-branch ladder.
 */
function dailyWhere(
  ticker: string,
  asOf: string | null | undefined,
  since: string | null | undefined,
): { clause: string; params: unknown[] } {
  let clause = `WHERE ticker = ?`;
  const params: unknown[] = [ticker];
  if (since) {
    clause += ` AND dt >= CAST(? AS DATE)`;
    params.push(since);
  }
  if (asOf) {
    clause += ` AND dt <= CAST(? AS DATE)`;
    params.push(asOf);
  }
  return { clause, params };
}

export async function getCandles(
  ticker: string,
  asOf?: string | null,
  since?: string | null,
): Promise<Candle[]> {
  const conn = await getConn();
  const { clause, params } = dailyWhere(ticker, asOf, since);
  const sql = `
    SELECT
      epoch(dt)::BIGINT AS time,
      open, high, low, close
    FROM ohlcv
    ${clause}
    ORDER BY dt
  `;
  const stmt = await conn.prepare(sql);
  try {
    const tbl = await stmt.query(...params);
    return tbl.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return {
        time: toNum(r.time),
        open: toNum(r.open),
        high: toNum(r.high),
        low: toNum(r.low),
        close: toNum(r.close),
      };
    });
  } finally {
    await stmt.close();
  }
}

export async function getSma(
  ticker: string,
  period: number,
  asOf?: string | null,
  since?: string | null,
): Promise<MaPoint[]> {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`getSma: period must be a positive integer (got ${period})`);
  }
  const conn = await getConn();
  // `period` is inlined: it's a fixed constant (20/50/200), never user input.
  // Inlining keeps the window-frame syntactically valid (DuckDB rejects bind
  // parameters inside ROWS BETWEEN ... PRECEDING).
  //
  // The `asOf` filter goes inside the SELECT so the SMA window is
  // computed only over bars that existed on that date — otherwise the
  // trailing N rows of the as-of slice would borrow values from the
  // future.
  //
  // The `since` filter is applied as an OUTER predicate (post-window)
  // so the moving average over an N-bar window still uses bars *before*
  // `since` for warmup — only the OUTPUT rows are clipped to the
  // requested range. Filtering inside the window would chop the warmup
  // and produce a leading gap that's mathematically wrong.
  const { clause: asOfClause, params: asOfParams } = dailyWhere(ticker, asOf, null);
  const sql = `
    SELECT * FROM (
      SELECT
        dt,
        epoch(dt)::BIGINT AS time,
        AVG(close) OVER (
          ORDER BY dt
          ROWS BETWEEN ${period - 1} PRECEDING AND CURRENT ROW
        ) AS value
      FROM ohlcv
      ${asOfClause}
      QUALIFY COUNT(*) OVER (
        ORDER BY dt
        ROWS BETWEEN ${period - 1} PRECEDING AND CURRENT ROW
      ) >= ${period}
    )
    ${since ? 'WHERE dt >= CAST(? AS DATE)' : ''}
    ORDER BY dt
  `;
  const params = since ? [...asOfParams, since] : asOfParams;
  const stmt = await conn.prepare(sql);
  try {
    const tbl = await stmt.query(...params);
    return tbl.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return { time: toNum(r.time), value: toNum(r.value) };
    });
  } finally {
    await stmt.close();
  }
}

export interface VwapPoint {
  time: number; // unix seconds
  value: number;
}

/**
 * Rolling N-day Volume-Weighted Average Price.
 *
 *   VWAP_t = SUM(close * volume) / SUM(volume) over the trailing N bars.
 *
 * Returns one point per bar where N preceding bars are available
 * (warmup window: skips bars where the rolling window isn't full,
 * matching the SMA contract above).
 *
 * Uses DuckDB's window functions; no recursive CTE needed — VWAP is
 * just a weighted moving average, not a smoothed indicator like
 * RSI/MACD where each value depends on the previous.
 *
 * Volume can be NULL for some bars (Twelve Data occasionally returns
 * empty volume — see `toNullableNum` in this file). Bars with NULL
 * volume contribute 0 to both numerator and denominator via
 * COALESCE, which is the correct behavior — they're effectively
 * skipped from the weighted average rather than crashing the query
 * or polluting the result with NULL arithmetic.
 *
 * `asOf` and `since` follow the same windowing rules as `getSma`:
 * `asOf` filters inside the SELECT (so the rolling window doesn't
 * borrow from the future), `since` is applied as an outer predicate
 * (so the N-bar warmup still uses bars before `since` — only the
 * OUTPUT rows are clipped to the requested range).
 */
export async function getVwap(
  ticker: string,
  period: number = 20,
  asOf?: string | null,
  since?: string | null,
): Promise<VwapPoint[]> {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`getVwap: period must be a positive integer (got ${period})`);
  }
  const conn = await getConn();
  // `period` is inlined for the same reason as `getSma`: it's a fixed
  // constant (20), never user input, and DuckDB rejects bind parameters
  // inside ROWS BETWEEN ... PRECEDING.
  const { clause: asOfClause, params: asOfParams } = dailyWhere(ticker, asOf, null);
  const sql = `
    SELECT * FROM (
      WITH w AS (
        SELECT
          dt,
          epoch(dt)::BIGINT AS time,
          SUM(COALESCE(close * volume, 0)) OVER (
            ORDER BY dt
            ROWS BETWEEN ${period - 1} PRECEDING AND CURRENT ROW
          ) AS num,
          SUM(COALESCE(volume, 0)) OVER (
            ORDER BY dt
            ROWS BETWEEN ${period - 1} PRECEDING AND CURRENT ROW
          ) AS den,
          COUNT(*) OVER (
            ORDER BY dt
            ROWS BETWEEN ${period - 1} PRECEDING AND CURRENT ROW
          ) AS w_size
        FROM ohlcv
        ${asOfClause}
      )
      SELECT dt, time, num / NULLIF(den, 0) AS value
      FROM w
      WHERE w_size >= ${period} AND den > 0
    )
    ${since ? 'WHERE dt >= CAST(? AS DATE)' : ''}
    ORDER BY dt
  `;
  const params = since ? [...asOfParams, since] : asOfParams;
  const stmt = await conn.prepare(sql);
  try {
    const tbl = await stmt.query(...params);
    return tbl.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return { time: toNum(r.time), value: toNum(r.value) };
    });
  } finally {
    await stmt.close();
  }
}

export async function getVolumeBars(
  ticker: string,
  asOf?: string | null,
  since?: string | null,
): Promise<VolumeBar[]> {
  const conn = await getConn();
  const { clause, params } = dailyWhere(ticker, asOf, since);
  const sql = `
    SELECT
      epoch(dt)::BIGINT AS time,
      volume,
      close >= open AS up
    FROM ohlcv
    ${clause}
    ORDER BY dt
  `;
  const stmt = await conn.prepare(sql);
  try {
    const tbl = await stmt.query(...params);
    return tbl.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return {
        time: toNum(r.time),
        value: toNullableNum(r.volume),
        color: r.up ? VOLUME_UP : VOLUME_DOWN,
      };
    });
  } finally {
    await stmt.close();
  }
}

/**
 * Intraday candles for the active trading session (or for `asOf`'s
 * date when historical-view mode is on).
 *
 * Time is returned in unix seconds (matching the other query functions)
 * so Lightweight Charts can use it directly as `UTCTimestamp`. The
 * chart consumer is expected to enable `timeVisible: true` on its time
 * scale so the bar timestamps render with HH:MM granularity.
 */
export async function getIntradayCandles(
  ticker: string,
  asOf?: string | null,
): Promise<Candle[]> {
  const conn = await getConn();
  // Always bound by date. When `asOf` is set use it; otherwise restrict
  // to today (CURRENT_DATE). This prevents prior sessions persisted in
  // OPFS from leaking into the live "1D" view (review Major #2).
  const sql = asOf
    ? `SELECT
         epoch(ts)::BIGINT AS time,
         open, high, low, close
       FROM ohlcv_intraday
       WHERE ticker = ? AND date(ts) = CAST(? AS DATE)
       ORDER BY ts`
    : `SELECT
         epoch(ts)::BIGINT AS time,
         open, high, low, close
       FROM ohlcv_intraday
       WHERE ticker = ? AND date(ts) = CURRENT_DATE
       ORDER BY ts`;
  const stmt = await conn.prepare(sql);
  try {
    const tbl = asOf ? await stmt.query(ticker, asOf) : await stmt.query(ticker);
    return tbl.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return {
        time: toNum(r.time),
        open: toNum(r.open),
        high: toNum(r.high),
        low: toNum(r.low),
        close: toNum(r.close),
      };
    });
  } finally {
    await stmt.close();
  }
}

/**
 * Intraday volume bars (5-minute granularity by default). Same shape
 * as `getVolumeBars` — colour-coded by per-bar direction.
 */
export async function getIntradayVolumeBars(
  ticker: string,
  asOf?: string | null,
): Promise<VolumeBar[]> {
  const conn = await getConn();
  // Same date-bounding policy as getIntradayCandles: live mode must
  // restrict to CURRENT_DATE so prior sessions don't leak.
  const sql = asOf
    ? `SELECT
         epoch(ts)::BIGINT AS time,
         volume,
         close >= open AS up
       FROM ohlcv_intraday
       WHERE ticker = ? AND date(ts) = CAST(? AS DATE)
       ORDER BY ts`
    : `SELECT
         epoch(ts)::BIGINT AS time,
         volume,
         close >= open AS up
       FROM ohlcv_intraday
       WHERE ticker = ? AND date(ts) = CURRENT_DATE
       ORDER BY ts`;
  const stmt = await conn.prepare(sql);
  try {
    const tbl = asOf ? await stmt.query(ticker, asOf) : await stmt.query(ticker);
    return tbl.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return {
        time: toNum(r.time),
        value: toNullableNum(r.volume),
        color: r.up ? VOLUME_UP : VOLUME_DOWN,
      };
    });
  } finally {
    await stmt.close();
  }
}

export interface SnapshotRow {
  ticker: string;
  /** ISO-8601 date ("YYYY-MM-DD") of the most recent bar. */
  latestDt: string;
  latestClose: number;
  /** Close from the bar immediately preceding `latestDt`, or null if
   *  this ticker has only one bar (no day-over-day delta computable). */
  prevClose: number | null;
  latestVolume: number | null;
  rowCount: number;
}

export interface EarningsEventRow {
  /** ISO yyyy-mm-dd date string for table display. */
  dt: string;
  /** Unix seconds for chart marker placement (matches the candle series time axis). */
  time: number;
  timeOfDay: string | null;
  epsEstimate: number | null;
  epsActual: number | null;
  surprisePct: number | null;
}

/**
 * Earnings events for `ticker`, optionally bounded by `asOf` (upper)
 * and `since` (lower) date filters. Same composition contract as
 * `getCandles` so chart consumers can pass the same window args and
 * get markers aligned to the visible bar range.
 *
 * `asOf` matters in historical-view mode (we don't want a marker for
 * an earnings release that hadn't happened yet on the as-of date).
 * `since` clips earnings older than the visible chart window so the
 * marker plugin doesn't emit a thousand circles when the user is on
 * a 1M view.
 */
export async function getEarnings(
  ticker: string,
  asOf?: string | null,
  since?: string | null,
): Promise<EarningsEventRow[]> {
  const conn = await getConn();
  let clause = `WHERE ticker = ?`;
  const params: unknown[] = [ticker];
  if (since) {
    clause += ` AND dt >= CAST(? AS DATE)`;
    params.push(since);
  }
  if (asOf) {
    clause += ` AND dt <= CAST(? AS DATE)`;
    params.push(asOf);
  }
  const sql = `
    SELECT
      dt,
      epoch(dt)::BIGINT AS time,
      time_of_day,
      eps_estimate,
      eps_actual,
      surprise_pct
    FROM earnings_events
    ${clause}
    ORDER BY dt
  `;
  const stmt = await conn.prepare(sql);
  try {
    const tbl = await stmt.query(...params);
    return tbl.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      const timeOfDayRaw = r.time_of_day;
      return {
        dt: formatDateValue(r.dt),
        time: toNum(r.time),
        timeOfDay:
          typeof timeOfDayRaw === 'string' && timeOfDayRaw.trim()
            ? timeOfDayRaw
            : null,
        epsEstimate: toNullableNum(r.eps_estimate),
        epsActual: toNullableNum(r.eps_actual),
        surprisePct: toNullableNum(r.surprise_pct),
      };
    });
  } finally {
    await stmt.close();
  }
}

/**
 * One row per ticker with the latest OHLCV plus prev_close. Backed by the
 * `current_snapshot` view (migration v2). Lets PortfolioOverview render
 * the table without N round trips — a single query returns everything
 * the overview needs to compute day-over-day deltas.
 *
 * Currently unused by the UI; introduced as infrastructure for the
 * upcoming Screener panel and a future PortfolioOverview migration.
 */
export async function getCurrentSnapshot(): Promise<SnapshotRow[]> {
  const conn = await getConn();
  const result = await conn.query(
    `SELECT ticker, latest_dt, latest_close, prev_close, latest_volume, row_count
     FROM current_snapshot
     ORDER BY ticker`,
  );
  return result.toArray().map((row) => {
    const r = row.toJSON() as Record<string, unknown>;
    return {
      ticker: String(r.ticker),
      latestDt: formatDateValue(r.latest_dt),
      latestClose: toNum(r.latest_close),
      prevClose: r.prev_close == null ? null : toNum(r.prev_close),
      latestVolume: toNullableNum(r.latest_volume),
      rowCount: toNum(r.row_count),
    };
  });
}
