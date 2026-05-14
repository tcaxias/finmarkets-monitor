// Three-witness conviction evaluator.
//
// The "three witnesses" are Trend, Volume, and Indicators. Each is evaluated
// independently (pure function, no shared state) and produces a verdict
// (bullish / bearish / neutral) plus a one-line reason. `summarize` then
// tallies the three verdicts into an overall conviction level.
//
// The methodology is documented in `~/docs/finmarkets/monitoring-guide.md`
// Phase 3 ("three-witness rule"). The TL;DR:
//
//   3 of 3 same direction → high-conviction in that direction
//   2 of 3 same direction → moderate conviction
//   1 of 3 (mixed) or all neutral → no conviction, hold and wait
//
// All functions in this file are pure — no DOM, no Svelte runes, no side
// effects. That keeps them trivially testable and lets the component layer
// own all reactivity.
//
// The MACD-over-RSI tiebreak is from the weekly review template: when RSI
// and MACD disagree, weight MACD because it's the trend-following one and
// trend dominates over momentum on the holding-period horizon.

import type { Candle, MaPoint, VolumeBar } from './queries';
import type { RsiPoint, MacdPoint } from './indicators';

export type Verdict = 'bullish' | 'bearish' | 'neutral';

export interface WitnessResult {
  verdict: Verdict;
  reason: string;
}

export type Conviction =
  | 'high-bullish'
  | 'moderate-bullish'
  | 'neutral'
  | 'moderate-bearish'
  | 'high-bearish';

export interface WitnessSummary {
  trend: WitnessResult;
  volume: WitnessResult;
  indicators: WitnessResult;
  conviction: Conviction;
  convictionLabel: string;
  recommendation: string;
}

// How many bars back we look to compute MA slope. 5 ≈ a trading week — long
// enough to filter daily noise, short enough that recent inflections show up.
const MA_SLOPE_LOOKBACK = 5;

// Volume witness window: count accumulation/distribution days over the last
// ~10 trading sessions (two weeks). Short enough to be "current".
const VOLUME_LOOKBACK = 10;

// Rolling-average window for "high volume" classification. 20 trading days ≈
// one calendar month — the standard reference for "average volume" on daily
// charts. We compute it ending at each bar (not just the last bar) so each
// day's classification is anchored to its contemporaneous baseline.
const VOLUME_AVG_WINDOW = 20;

// Minimum margin between accumulation and distribution day counts before we
// call the witness. A 2+ majority avoids flipping the verdict on a single
// noisy day.
const VOLUME_MAJORITY_MARGIN = 2;

/**
 * Trend witness: where price sits relative to the 20-MA and 200-MA, plus
 * the slope of each MA.
 *
 *  - Bullish: close > 20-MA > 200-MA AND both MAs sloping up
 *  - Bearish: close < 20-MA < 200-MA AND both MAs sloping down
 *  - Neutral: anything in between (chop, regime-change-in-progress, etc.)
 *
 * Returns a neutral verdict with an explanatory reason if any input series
 * is too short to evaluate.
 */
export function evaluateTrend(
  candles: Candle[],
  sma20: MaPoint[],
  sma200: MaPoint[],
): WitnessResult {
  if (candles.length === 0 || sma20.length === 0 || sma200.length === 0) {
    return { verdict: 'neutral', reason: 'Insufficient data for trend evaluation' };
  }

  const close = candles[candles.length - 1].close;
  const ma20 = sma20[sma20.length - 1].value;
  const ma200 = sma200[sma200.length - 1].value;

  const slope20 = maSlope(sma20);
  const slope200 = maSlope(sma200);

  const slope20Label = slopeLabel(slope20);
  const slope200Label = slopeLabel(slope200);

  const reason =
    `Price ${fmtPrice(close)} vs 20-MA ${fmtPrice(ma20)} (slope: ${slope20Label}), ` +
    `200-MA ${fmtPrice(ma200)} (slope: ${slope200Label})`;

  // Bullish: clean stack with both MAs trending up.
  if (close > ma20 && ma20 > ma200 && slope20 > 0 && slope200 > 0) {
    return { verdict: 'bullish', reason };
  }
  // Bearish: clean inverted stack with both MAs trending down.
  if (close < ma20 && ma20 < ma200 && slope20 < 0 && slope200 < 0) {
    return { verdict: 'bearish', reason };
  }
  // Anything else — partial agreement, mixed slopes, price between the MAs —
  // is "chop" and we don't claim a verdict.
  return { verdict: 'neutral', reason };
}

/**
 * Volume witness: are recent up-days driven by above-average volume
 * (accumulation) or are recent down-days driven by above-average volume
 * (distribution)?
 *
 * For each of the last ~10 candles we classify the day as up/down using
 * `close >= open` and compare its volume to a trailing 20-day average ending
 * at that bar. We then count "high-volume green" vs "high-volume red" days
 * and require a margin of 2+ to call the verdict — single-day spikes
 * shouldn't dominate.
 */
export function evaluateVolume(candles: Candle[], volume: VolumeBar[]): WitnessResult {
  if (candles.length === 0 || volume.length === 0) {
    return { verdict: 'neutral', reason: 'Insufficient data for volume evaluation' };
  }

  // Align candles to volume bars by timestamp. In practice both series come
  // from the same `ohlcv` table and are already aligned, but defensive
  // alignment keeps the function robust against future query changes.
  //
  // Volume is `number | null` — null means the source row had no volume,
  // which we must skip (not coerce to zero) so a missing bar doesn't drag
  // the trailing average toward zero and bias the witness.
  const volByTime = new Map<number, number | null>();
  for (const v of volume) volByTime.set(v.time, v.value);

  // Pre-compute trailing 20-day average volume ending at each candle index.
  // We use a simple O(n*w) loop because n is small (~500) and clarity
  // matters more than micro-optimization here. Null-volume bars are
  // excluded from both numerator and denominator.
  const avgVolumeAt: number[] = new Array(candles.length).fill(NaN);
  for (let i = 0; i < candles.length; i++) {
    const start = Math.max(0, i - VOLUME_AVG_WINDOW + 1);
    const slice = candles.slice(start, i + 1);
    let sum = 0;
    let n = 0;
    for (const c of slice) {
      const v = volByTime.get(c.time);
      if (typeof v === 'number') {
        sum += v;
        n++;
      }
    }
    avgVolumeAt[i] = n > 0 ? sum / n : NaN;
  }

  // Take the last `VOLUME_LOOKBACK` bars (or all of them if we have fewer).
  const start = Math.max(0, candles.length - VOLUME_LOOKBACK);
  let highVolGreen = 0;
  let highVolRed = 0;
  let evaluated = 0;

  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const vol = volByTime.get(c.time);
    const avg = avgVolumeAt[i];
    if (typeof vol !== 'number' || !Number.isFinite(avg) || avg === 0) continue;

    evaluated++;
    const isUp = c.close >= c.open;
    const isHighVol = vol > avg;

    if (isHighVol && isUp) highVolGreen++;
    else if (isHighVol && !isUp) highVolRed++;
  }

  if (evaluated === 0) {
    return { verdict: 'neutral', reason: 'No comparable volume data in lookback window' };
  }

  const reason =
    `${highVolGreen} high-volume up days vs ${highVolRed} high-volume down days ` +
    `(last ${evaluated} sessions)`;

  if (highVolGreen - highVolRed >= VOLUME_MAJORITY_MARGIN) {
    return { verdict: 'bullish', reason: `Accumulation: ${reason}` };
  }
  if (highVolRed - highVolGreen >= VOLUME_MAJORITY_MARGIN) {
    return { verdict: 'bearish', reason: `Distribution: ${reason}` };
  }
  return { verdict: 'neutral', reason: `Mixed: ${reason}` };
}

/**
 * Indicators witness: RSI direction + MACD posture, with a tiebreak that
 * weights MACD when the two disagree.
 *
 *  - RSI bullish if value > 50 AND rising; bearish if < 50 AND falling
 *  - MACD verdict is the **sign of the MACD line** (the baseline regime).
 *    The histogram modifies confidence (expanding = strengthening,
 *    contracting = weakening) but is reported in the reason string, NOT
 *    used as a gate on the direction. Per the companion guide: a MACD
 *    line below zero IS bearish even if the histogram is contracting —
 *    contracting just means the bearish trend is losing steam, not that
 *    it has flipped to neutral.
 *  - Tiebreak: if RSI and MACD agree → use that. If they disagree → follow
 *    MACD line sign (trend-following dominates momentum oscillator on the
 *    holding-period horizon). If MACD line is exactly zero → take RSI.
 */
export function evaluateIndicators(rsi: RsiPoint[], macd: MacdPoint[]): WitnessResult {
  if (rsi.length === 0 || macd.length === 0) {
    return { verdict: 'neutral', reason: 'Insufficient data for indicator evaluation' };
  }

  // RSI direction: compare current to value 2 bars back (3-bar window).
  // Short enough to catch turns; long enough to filter single-bar noise.
  const rsiNow = rsi[rsi.length - 1].value;
  const rsiPrev = rsi.length >= 3 ? rsi[rsi.length - 3].value : rsi[0].value;
  const rsiRising = rsiNow > rsiPrev;
  const rsiFalling = rsiNow < rsiPrev;
  const rsiDirection = rsiRising ? 'rising' : rsiFalling ? 'falling' : 'flat';

  let rsiVerdict: Verdict = 'neutral';
  if (rsiNow > 50 && rsiRising) rsiVerdict = 'bullish';
  else if (rsiNow < 50 && rsiFalling) rsiVerdict = 'bearish';

  // MACD posture: histogram trend is strength-only (used in the reason
  // string), line sign is the verdict.
  const macdLast = macd[macd.length - 1];
  const macdPrev = macd.length >= 2 ? macd[macd.length - 2] : macdLast;
  const sameSign =
    Math.sign(macdLast.histogram) === Math.sign(macdPrev.histogram);
  const histExpanding = sameSign && Math.abs(macdLast.histogram) > Math.abs(macdPrev.histogram);
  const histContracting = sameSign && Math.abs(macdLast.histogram) < Math.abs(macdPrev.histogram);
  const histTrend = histExpanding ? 'expanding' : histContracting ? 'contracting' : 'flat';

  // MACD verdict by line sign — the baseline regime. Histogram is a
  // strength modifier (described in the reason string), not a gate.
  const macdVerdict: Verdict =
    macdLast.macd > 0 ? 'bullish' :
    macdLast.macd < 0 ? 'bearish' :
    'neutral';

  // Combine. When they agree → that. When MACD line is neutral (== 0) →
  // take RSI. When one is neutral and the other isn't → take the non-
  // neutral one. When they disagree → MACD wins.
  let combined: Verdict;
  if (rsiVerdict === macdVerdict) {
    combined = rsiVerdict;
  } else if (macdVerdict === 'neutral') {
    combined = rsiVerdict;
  } else if (rsiVerdict === 'neutral') {
    combined = macdVerdict;
  } else {
    // Genuine disagreement → MACD line sign wins.
    combined = macdVerdict;
  }

  // Reason string: include histogram state as colour on the MACD verdict
  // ("bearish, histogram contracting = weakening trend"). When the
  // histogram is expanding in the same direction as the line, that
  // strengthens the verdict; when contracting, the trend is weakening
  // but hasn't reversed.
  const macdSignLabel =
    macdVerdict === 'bullish' ? 'bullish' :
    macdVerdict === 'bearish' ? 'bearish' :
    'neutral';
  const histColour =
    histExpanding ? `histogram expanding = strengthening trend` :
    histContracting ? `histogram contracting = weakening trend` :
    `histogram flat`;
  const reason =
    `RSI ${rsiNow.toFixed(0)} (${rsiDirection}), ` +
    `MACD line ${macdLast.macd >= 0 ? '+' : ''}${macdLast.macd.toFixed(2)} ` +
    `(${macdSignLabel}, ${histColour})`;

  return { verdict: combined, reason };
}

/**
 * Tally the three witness verdicts into an overall conviction level.
 *
 * Mapping:
 *   3 bullish               → high-bullish
 *   2 bullish, 1 (other)    → moderate-bullish
 *   3 bearish               → high-bearish
 *   2 bearish, 1 (other)    → moderate-bearish
 *   anything else           → neutral
 *
 * The "1 of each non-neutral with 1 neutral" case (1 bullish, 1 bearish,
 * 1 neutral) maps to neutral — that's "no conviction, hold and wait" per
 * the guide.
 */
export function summarize(
  trend: WitnessResult,
  volume: WitnessResult,
  indicators: WitnessResult,
): WitnessSummary {
  const verdicts: Verdict[] = [trend.verdict, volume.verdict, indicators.verdict];
  const bullish = verdicts.filter((v) => v === 'bullish').length;
  const bearish = verdicts.filter((v) => v === 'bearish').length;

  let conviction: Conviction;
  let convictionLabel: string;
  let recommendation: string;

  if (bullish === 3) {
    conviction = 'high-bullish';
    convictionLabel = 'High-conviction bullish (3/3 witnesses)';
    recommendation = 'Hold; consider raising scaling sell levels';
  } else if (bearish === 3) {
    conviction = 'high-bearish';
    convictionLabel = 'High-conviction bearish (3/3 witnesses)';
    recommendation = 'Review exit plan against Pcover thresholds';
  } else if (bullish === 2 && bearish <= 1) {
    conviction = 'moderate-bullish';
    convictionLabel = `Moderate-conviction bullish (2/3 witnesses)`;
    recommendation = 'Hold; reduce size of any planned action';
  } else if (bearish === 2 && bullish <= 1) {
    conviction = 'moderate-bearish';
    convictionLabel = `Moderate-conviction bearish (2/3 witnesses)`;
    recommendation = 'Tighten stops; reduce size of any planned action';
  } else {
    // Covers: 0-0-3 neutral, 1-1-1 split, 1-0-2 with neutrals, etc. All map
    // to "no conviction" per the guide's "do not act on a single witness".
    conviction = 'neutral';
    convictionLabel = `No conviction (${bullish} bullish, ${bearish} bearish, ${3 - bullish - bearish} neutral)`;
    recommendation = 'Hold and wait — mixed signals';
  }

  return { trend, volume, indicators, conviction, convictionLabel, recommendation };
}

// --- helpers ---

function maSlope(series: MaPoint[]): number {
  if (series.length < 2) return 0;
  const last = series[series.length - 1].value;
  const lookbackIdx = Math.max(0, series.length - 1 - MA_SLOPE_LOOKBACK);
  const ref = series[lookbackIdx].value;
  return last - ref;
}

function slopeLabel(slope: number): 'up' | 'down' | 'flat' {
  // Tiny epsilon avoids labelling sub-cent drift as a real slope. The
  // threshold is intentionally loose — anything we'd consider "flat" on a
  // chart should land here.
  if (slope > 0.01) return 'up';
  if (slope < -0.01) return 'down';
  return 'flat';
}

function fmtPrice(v: number): string {
  return `$${v.toFixed(2)}`;
}
