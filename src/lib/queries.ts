// Pure SQL query helpers for chart data.
//
// All time values are returned as unix seconds (Number, not BigInt) so they
// can be passed straight to Lightweight Charts as `UTCTimestamp`. DuckDB
// returns BIGINT columns as native JS BigInt; we convert at the boundary.
//
// SMA warmup is filtered server-side via QUALIFY so the partial-window values
// (mathematically wrong as a "true" SMA) never reach the chart.

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

export async function getCandles(
  ticker: string,
  asOf?: string | null,
): Promise<Candle[]> {
  const conn = await getConn();
  // Phase B: when `asOf` is set, filter to bars dated on or before that
  // calendar day. We CAST(? AS DATE) explicitly because the DuckDB-WASM
  // bind layer infers `?` parameter types from the value's JS type, and
  // strings would otherwise bind as VARCHAR — comparing VARCHAR to a
  // DATE column triggers the "invalid date" parameter error we hit in
  // af22d1f. The cast forces the comparison into DATE space.
  const sql = asOf
    ? `SELECT
         epoch(dt)::BIGINT AS time,
         open, high, low, close
       FROM ohlcv
       WHERE ticker = ? AND dt <= CAST(? AS DATE)
       ORDER BY dt`
    : `SELECT
         epoch(dt)::BIGINT AS time,
         open, high, low, close
       FROM ohlcv
       WHERE ticker = ?
       ORDER BY dt`;
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

export async function getSma(
  ticker: string,
  period: number,
  asOf?: string | null,
): Promise<MaPoint[]> {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`getSma: period must be a positive integer (got ${period})`);
  }
  const conn = await getConn();
  // `period` is inlined: it's a fixed constant (20 or 200), never user input.
  // Inlining keeps the window-frame syntactically valid (DuckDB rejects bind
  // parameters inside ROWS BETWEEN ... PRECEDING).
  //
  // Phase B: the `asOf` filter goes inside the SELECT subquery so the
  // SMA window is computed only over bars that existed on that date —
  // otherwise the trailing N rows of the as-of slice would borrow
  // values from the future.
  const whereClause = asOf
    ? `WHERE ticker = ? AND dt <= CAST(? AS DATE)`
    : `WHERE ticker = ?`;
  const sql = `
    SELECT
      epoch(dt)::BIGINT AS time,
      AVG(close) OVER (
        ORDER BY dt
        ROWS BETWEEN ${period - 1} PRECEDING AND CURRENT ROW
      ) AS value
    FROM ohlcv
    ${whereClause}
    QUALIFY COUNT(*) OVER (
      ORDER BY dt
      ROWS BETWEEN ${period - 1} PRECEDING AND CURRENT ROW
    ) >= ${period}
    ORDER BY dt
  `;
  const stmt = await conn.prepare(sql);
  try {
    const tbl = asOf ? await stmt.query(ticker, asOf) : await stmt.query(ticker);
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
): Promise<VolumeBar[]> {
  const conn = await getConn();
  const sql = asOf
    ? `SELECT
         epoch(dt)::BIGINT AS time,
         volume,
         close >= open AS up
       FROM ohlcv
       WHERE ticker = ? AND dt <= CAST(? AS DATE)
       ORDER BY dt`
    : `SELECT
         epoch(dt)::BIGINT AS time,
         volume,
         close >= open AS up
       FROM ohlcv
       WHERE ticker = ?
       ORDER BY dt`;
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
