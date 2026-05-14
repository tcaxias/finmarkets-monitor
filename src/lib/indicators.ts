// Indicator series types and the (pure) RSI/price divergence detector.
//
// History: this file used to wrap the `technicalindicators` npm package
// for RSI/MACD computation. As of migration v3 those indicators are
// computed in pure DuckDB SQL (recursive CTEs) and materialised into
// the `indicators_rsi` / `indicators_macd` tables — see
// `sqlIndicators.ts` for the write side (`materializeRsi`,
// `materializeMacd`, `refreshIndicators`) and the read side (`readRsi`,
// `readMacd`).
//
// What stayed here:
//   - The point types (`RsiPoint`, `MacdPoint`, `ClosePoint`,
//     `DivergenceFlag`) so existing imports don't churn.
//   - `detectRsiDivergence`, which is a pure function over already-
//     computed RSI + close arrays. It needs no DuckDB and tests cleanly
//     in the vitest harness without a worker.

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
