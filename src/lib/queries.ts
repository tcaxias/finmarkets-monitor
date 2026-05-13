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
  value: number;
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

export async function getCandles(ticker: string): Promise<Candle[]> {
  const conn = await getConn();
  const stmt = await conn.prepare(
    `SELECT
       epoch(dt)::BIGINT AS time,
       open, high, low, close
     FROM ohlcv
     WHERE ticker = ?
     ORDER BY dt`,
  );
  try {
    const tbl = await stmt.query(ticker);
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

export async function getSma(ticker: string, period: number): Promise<MaPoint[]> {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`getSma: period must be a positive integer (got ${period})`);
  }
  const conn = await getConn();
  // `period` is inlined: it's a fixed constant (20 or 200), never user input.
  // Inlining keeps the window-frame syntactically valid (DuckDB rejects bind
  // parameters inside ROWS BETWEEN ... PRECEDING).
  const sql = `
    SELECT
      epoch(dt)::BIGINT AS time,
      AVG(close) OVER (
        ORDER BY dt
        ROWS BETWEEN ${period - 1} PRECEDING AND CURRENT ROW
      ) AS value
    FROM ohlcv
    WHERE ticker = ?
    QUALIFY COUNT(*) OVER (
      ORDER BY dt
      ROWS BETWEEN ${period - 1} PRECEDING AND CURRENT ROW
    ) >= ${period}
    ORDER BY dt
  `;
  const stmt = await conn.prepare(sql);
  try {
    const tbl = await stmt.query(ticker);
    return tbl.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return { time: toNum(r.time), value: toNum(r.value) };
    });
  } finally {
    await stmt.close();
  }
}

export async function getVolumeBars(ticker: string): Promise<VolumeBar[]> {
  const conn = await getConn();
  const stmt = await conn.prepare(
    `SELECT
       epoch(dt)::BIGINT AS time,
       volume,
       close >= open AS up
     FROM ohlcv
     WHERE ticker = ?
     ORDER BY dt`,
  );
  try {
    const tbl = await stmt.query(ticker);
    return tbl.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return {
        time: toNum(r.time),
        value: toNum(r.volume),
        color: r.up ? VOLUME_UP : VOLUME_DOWN,
      };
    });
  } finally {
    await stmt.close();
  }
}
