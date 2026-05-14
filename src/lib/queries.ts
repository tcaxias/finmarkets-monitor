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
  // When `asOf` is set, restrict to bars on that calendar day. When
  // not set, return everything in the table for the ticker — callers
  // typically refresh before reading, so what's there is "today".
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
       WHERE ticker = ?
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
       WHERE ticker = ?
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
