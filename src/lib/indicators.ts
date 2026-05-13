// Technical indicators (RSI, MACD) and basic divergence detection.
//
// We use the `technicalindicators` npm package for RSI and MACD instead of
// computing them in DuckDB SQL. Wilder's RSI smoothing and MACD's chained
// EMAs are recursive: each bar's value depends on the previous bar's
// computed value, which is awkward to express as a window function and
// requires either a recursive CTE (with edge-case behaviour in DuckDB-WASM)
// or hand-rolled SQL that's very easy to get subtly wrong. A vetted
// library that matches TradingView outputs is the safer call.
//
// SMA, volume aggregation, and threshold queries remain in DuckDB SQL
// (see `queries.ts`) — those are simple windows and benefit from running
// close to the data.

import { RSI, MACD } from 'technicalindicators';
import { getConn } from './duckdb';

export interface RsiPoint {
  time: number; // unix seconds
  value: number;
}

export interface MacdPoint {
  time: number; // unix seconds
  macd: number;
  signal: number;
  histogram: number;
}

export interface ClosePoint {
  time: number;
  close: number;
}

// Coerce DuckDB BIGINT (BigInt) and DOUBLE (Number) scalars to plain Number.
// Lightweight Charts and the indicator library both choke on BigInt.
function toNum(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  return Number(v);
}

/**
 * Pull (time, close) pairs for `ticker` ordered by date. Shared input for
 * both RSI and MACD so we don't double-query.
 */
export async function getCloses(ticker: string): Promise<ClosePoint[]> {
  const conn = await getConn();
  const stmt = await conn.prepare(
    `SELECT epoch(dt)::BIGINT AS time, close
     FROM ohlcv
     WHERE ticker = ?
     ORDER BY dt`,
  );
  try {
    const tbl = await stmt.query(ticker);
    return tbl.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return { time: toNum(r.time), close: toNum(r.close) };
    });
  } finally {
    await stmt.close();
  }
}

/**
 * RSI(period) using Wilder's smoothing (the library's default).
 *
 * The library returns `closes.length - period` values (it skips the warmup
 * window). We align each output to the close it was computed from by
 * applying `offset = closes.length - result.length` as the index shift.
 */
export function computeRsi(closes: ClosePoint[], period = 14): RsiPoint[] {
  if (closes.length <= period) return [];
  const values = closes.map((c) => c.close);
  const result = RSI.calculate({ values, period });
  const offset = closes.length - result.length;
  const out: RsiPoint[] = [];
  for (let i = 0; i < result.length; i++) {
    const v = result[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    out.push({ time: closes[i + offset].time, value: v });
  }
  return out;
}

export async function getRsi(ticker: string, period = 14): Promise<RsiPoint[]> {
  const closes = await getCloses(ticker);
  return computeRsi(closes, period);
}

/**
 * MACD(fast, slow, signal). `slow` is the dominant warmup window; the
 * library's output is shorter than the input by approximately
 * (slow + signal - 2) bars.
 */
export function computeMacd(
  closes: ClosePoint[],
  fast = 12,
  slow = 26,
  signal = 9,
): MacdPoint[] {
  if (closes.length <= slow + signal) return [];
  const values = closes.map((c) => c.close);
  const result = MACD.calculate({
    values,
    fastPeriod: fast,
    slowPeriod: slow,
    signalPeriod: signal,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const offset = closes.length - result.length;
  const out: MacdPoint[] = [];
  for (let i = 0; i < result.length; i++) {
    const r = result[i];
    // The library only sets a key when its value is truthy (its codegen
    // skips zero/undefined), so on flat or warmup bars `signal` and
    // `histogram` may be missing even when MACD itself has a value.
    // Wait until the MACD line itself is defined — that's the signal that
    // both EMAs have warmed up. Treat missing signal/histogram as 0 so
    // the chart shows the typical "flat through the signal warmup, then
    // diverges" shape rather than a gap.
    if (typeof r.MACD !== 'number') continue;
    out.push({
      time: closes[i + offset].time,
      macd: r.MACD,
      signal: typeof r.signal === 'number' ? r.signal : 0,
      histogram: typeof r.histogram === 'number' ? r.histogram : 0,
    });
  }
  return out;
}

export async function getMacd(
  ticker: string,
  fast = 12,
  slow = 26,
  signal = 9,
): Promise<MacdPoint[]> {
  const closes = await getCloses(ticker);
  return computeMacd(closes, fast, slow, signal);
}

// ---------- Divergence detection ----------

export interface DivergenceFlag {
  bearish: boolean;
  bullish: boolean;
  description: string;
}

/**
 * Naive RSI/price divergence over the last `lookback` bars.
 *
 *  - Bearish: price prints a higher high while RSI prints a lower high.
 *  - Bullish: price prints a lower low while RSI prints a higher low.
 *
 * "v1" algorithm: in the lookback window, find the indices of the two
 * highest closes and the two lowest closes, then compare RSI at those same
 * timestamps. This is intentionally simple — it'll generate false positives
 * around noisy ranges, but it's transparent and good enough for a personal
 * dashboard. Real "swing-point" detection (Williams fractals, ZigZag) is a
 * later milestone.
 *
 * Returns `{bearish: false, bullish: false}` when the window is too short
 * or peaks can't be aligned with RSI samples.
 */
export function detectRsiDivergence(
  rsi: RsiPoint[],
  closes: ClosePoint[],
  lookback = 30,
): DivergenceFlag {
  const empty: DivergenceFlag = { bearish: false, bullish: false, description: '' };
  if (rsi.length < 4 || closes.length < 4) return empty;

  // Index RSI by time so we can sample it at price-peak timestamps.
  const rsiByTime = new Map<number, number>();
  for (const p of rsi) rsiByTime.set(p.time, p.value);

  // Restrict to the lookback window where RSI is also defined: clip closes
  // to those whose time appears in the RSI series.
  const startTime = rsi[0].time;
  const window = closes
    .filter((c) => c.time >= startTime)
    .slice(-lookback);
  if (window.length < 4) return empty;

  // Top-2 highs and bottom-2 lows by close, kept in original (time-ascending)
  // order so "earlier vs later" comparisons make sense.
  const byCloseDesc = [...window].sort((a, b) => b.close - a.close);
  const top2 = byCloseDesc.slice(0, 2).sort((a, b) => a.time - b.time);
  const byCloseAsc = [...window].sort((a, b) => a.close - b.close);
  const bot2 = byCloseAsc.slice(0, 2).sort((a, b) => a.time - b.time);

  let bearish = false;
  let bullish = false;

  if (top2.length === 2) {
    const [earlier, later] = top2;
    const rsiEarlier = rsiByTime.get(earlier.time);
    const rsiLater = rsiByTime.get(later.time);
    // Higher high in price + lower high in RSI = bearish divergence.
    if (
      typeof rsiEarlier === 'number' &&
      typeof rsiLater === 'number' &&
      later.close > earlier.close &&
      rsiLater < rsiEarlier
    ) {
      bearish = true;
    }
  }

  if (bot2.length === 2) {
    const [earlier, later] = bot2;
    const rsiEarlier = rsiByTime.get(earlier.time);
    const rsiLater = rsiByTime.get(later.time);
    // Lower low in price + higher low in RSI = bullish divergence.
    if (
      typeof rsiEarlier === 'number' &&
      typeof rsiLater === 'number' &&
      later.close < earlier.close &&
      rsiLater > rsiEarlier
    ) {
      bullish = true;
    }
  }

  let description = '';
  if (bearish && bullish) description = 'Mixed divergence';
  else if (bearish) description = 'Bearish divergence';
  else if (bullish) description = 'Bullish divergence';

  return { bearish, bullish, description };
}
