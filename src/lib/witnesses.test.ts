// Tests for the three-witness conviction evaluator.
//
// These tests synthesize the typed inputs directly — no DuckDB. Each test
// constructs a clean scenario (clean bullish, clean bearish, mixed, etc.)
// and asserts both the per-witness verdict and the rolled-up conviction.
//
// Synthetic data conventions:
//   - timestamps are 1-second-spaced (good enough; only ordering matters)
//   - candle.color is computed by the queries layer in production; the
//     volume witness in this codebase reads close/open from the candle
//     directly, so we don't need to thread color through.

import { describe, it, expect } from 'vitest';
import type { Candle, MaPoint, VolumeBar } from './queries';
import type { RsiPoint, MacdPoint } from './indicators';
import {
  evaluateTrend,
  evaluateVolume,
  evaluateIndicators,
  summarize,
} from './witnesses';

// ---------- builders ----------

function risingCandles(n: number, start = 100, step = 1): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: i + 1,
    open: start + i * step - step / 2,
    high: start + i * step + step / 2,
    low: start + i * step - step,
    close: start + i * step + step / 2, // close > open → green
  }));
}

function fallingCandles(n: number, start = 200, step = 1): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: i + 1,
    open: start - i * step + step / 2,
    high: start - i * step + step,
    low: start - i * step - step / 2,
    close: start - i * step - step / 2, // close < open → red
  }));
}

function ma(series: number[]): MaPoint[] {
  return series.map((value, i) => ({ time: i + 1, value }));
}

function bullishVolumeBars(candles: Candle[]): VolumeBar[] {
  // Accumulation pattern: high volume on green days, low volume on red days.
  // Set base volume well below the 20-day average we'll compute.
  return candles.map((c, i) => ({
    time: c.time,
    value: c.close >= c.open ? 2_000_000 : 500_000,
    color: c.close >= c.open ? '#26a69a' : '#ef5350',
    // Bias older bars to a steady mid-range volume so the trailing avg
    // sits between the two regimes — needs `i` for that bias.
    ...(i < candles.length - 15 ? { value: 1_000_000 } : {}),
  })).map((v, i) => ({
    // Re-emit with a clean shape. The conditional spread above doesn't
    // actually apply because TS object spread orders the explicit `value`
    // first. We do the bias here instead.
    time: v.time,
    value: i < candles.length - 15 ? 1_000_000 : v.value,
    color: v.color,
  }));
}

function bearishVolumeBars(candles: Candle[]): VolumeBar[] {
  // Distribution pattern: high volume on red days, low volume on green days.
  return candles.map((c, i) => ({
    time: c.time,
    value:
      i < candles.length - 15
        ? 1_000_000
        : c.close < c.open
          ? 2_000_000
          : 500_000,
    color: c.close >= c.open ? '#26a69a' : '#ef5350',
  }));
}

function mixedVolumeBars(candles: Candle[]): VolumeBar[] {
  // Flat volume → no accumulation/distribution signal.
  return candles.map((c) => ({
    time: c.time,
    value: 1_000_000,
    color: c.close >= c.open ? '#26a69a' : '#ef5350',
  }));
}

// ---------- evaluateTrend ----------

describe('evaluateTrend', () => {
  it('flags bullish on price > 20-MA > 200-MA with both MAs rising', () => {
    const candles = risingCandles(50);
    const last = candles[candles.length - 1].close;
    // 20-MA and 200-MA both rising and stacked below price.
    const sma20 = ma(Array.from({ length: 30 }, (_, i) => last - 5 + i * 0.1));
    const sma200 = ma(Array.from({ length: 30 }, (_, i) => last - 10 + i * 0.05));
    const result = evaluateTrend(candles, sma20, sma200);
    expect(result.verdict).toBe('bullish');
    expect(result.reason).toContain('slope: up');
  });

  it('flags bearish on price < 20-MA < 200-MA with both MAs falling', () => {
    const candles = fallingCandles(50);
    const last = candles[candles.length - 1].close;
    const sma20 = ma(Array.from({ length: 30 }, (_, i) => last + 5 - i * 0.1));
    const sma200 = ma(Array.from({ length: 30 }, (_, i) => last + 10 - i * 0.05));
    const result = evaluateTrend(candles, sma20, sma200);
    expect(result.verdict).toBe('bearish');
    expect(result.reason).toContain('slope: down');
  });

  it('returns neutral when MAs are stacked but slopes are flat', () => {
    const candles = risingCandles(50);
    const last = candles[candles.length - 1].close;
    // Flat MAs: stacked correctly but no slope.
    const sma20 = ma(new Array(30).fill(last - 5));
    const sma200 = ma(new Array(30).fill(last - 10));
    const result = evaluateTrend(candles, sma20, sma200);
    expect(result.verdict).toBe('neutral');
  });

  it('returns neutral with insufficient data', () => {
    expect(evaluateTrend([], [], []).verdict).toBe('neutral');
  });
});

// ---------- evaluateVolume ----------

describe('evaluateVolume', () => {
  it('flags bullish accumulation: high volume on green days', () => {
    // Build a sequence where the last ~10 bars alternate but green days
    // get heavy volume and red days get light volume.
    const candles: Candle[] = [
      // 15 background bars at neutral volume (built into bullishVolumeBars)
      ...risingCandles(15, 100, 0.1),
      // Then 10 bars: 7 green (high vol), 3 red (low vol)
      { time: 16, open: 102, high: 103, low: 101.5, close: 102.5 },
      { time: 17, open: 102.5, high: 103.5, low: 102, close: 103 },
      { time: 18, open: 103, high: 103.2, low: 102, close: 102.2 }, // red
      { time: 19, open: 102.2, high: 103, low: 102, close: 102.8 },
      { time: 20, open: 102.8, high: 104, low: 102.5, close: 103.7 },
      { time: 21, open: 103.7, high: 104.5, low: 103, close: 104.2 },
      { time: 22, open: 104.2, high: 104.5, low: 103.5, close: 103.8 }, // red
      { time: 23, open: 103.8, high: 105, low: 103.5, close: 104.7 },
      { time: 24, open: 104.7, high: 105.5, low: 104, close: 105.2 },
      { time: 25, open: 105.2, high: 106, low: 104.8, close: 105.7 },
    ].map((c, i) => ({ ...c, time: i + 1 }));

    const volume = bullishVolumeBars(candles);
    const result = evaluateVolume(candles, volume);
    expect(result.verdict).toBe('bullish');
    expect(result.reason).toContain('Accumulation');
  });

  it('flags bearish distribution: high volume on red days', () => {
    const candles: Candle[] = [
      ...fallingCandles(15, 105, 0.1),
      { time: 16, open: 103.5, high: 104, low: 102.5, close: 102.8 }, // red
      { time: 17, open: 102.8, high: 103, low: 102, close: 102.2 }, // red
      { time: 18, open: 102.2, high: 102.5, low: 101.5, close: 102 }, // red
      { time: 19, open: 102, high: 102.5, low: 101.8, close: 102.3 }, // green
      { time: 20, open: 102.3, high: 102.5, low: 101, close: 101.2 }, // red
      { time: 21, open: 101.2, high: 101.5, low: 100, close: 100.3 }, // red
      { time: 22, open: 100.3, high: 100.8, low: 100, close: 100.5 }, // green
      { time: 23, open: 100.5, high: 100.7, low: 99.5, close: 99.8 }, // red
      { time: 24, open: 99.8, high: 100, low: 99, close: 99.2 }, // red
      { time: 25, open: 99.2, high: 99.5, low: 98.5, close: 98.7 }, // red
    ].map((c, i) => ({ ...c, time: i + 1 }));

    const volume = bearishVolumeBars(candles);
    const result = evaluateVolume(candles, volume);
    expect(result.verdict).toBe('bearish');
    expect(result.reason).toContain('Distribution');
  });

  it('returns neutral when volume is flat (no accumulation/distribution edge)', () => {
    const candles = risingCandles(25, 100, 0.5);
    const volume = mixedVolumeBars(candles);
    const result = evaluateVolume(candles, volume);
    expect(result.verdict).toBe('neutral');
  });

  it('returns neutral with empty inputs', () => {
    expect(evaluateVolume([], []).verdict).toBe('neutral');
  });
});

// ---------- evaluateIndicators ----------

describe('evaluateIndicators', () => {
  it('flags bullish: RSI > 50 rising AND MACD > 0 expanding', () => {
    const rsi: RsiPoint[] = [
      { time: 1, value: 52 },
      { time: 2, value: 55 },
      { time: 3, value: 58 },
      { time: 4, value: 61 },
      { time: 5, value: 64 },
    ];
    const macd: MacdPoint[] = [
      { time: 1, macd: 0.1, signal: 0.05, histogram: 0.05 },
      { time: 2, macd: 0.2, signal: 0.08, histogram: 0.12 },
      { time: 3, macd: 0.35, signal: 0.12, histogram: 0.23 },
    ];
    const result = evaluateIndicators(rsi, macd);
    expect(result.verdict).toBe('bullish');
    expect(result.reason).toContain('rising');
    // Histogram detail now travels with a "strengthening/weakening" gloss
    // rather than the bare "expanding" label.
    expect(result.reason).toContain('strengthening');
  });

  it('flags bearish: RSI < 50 falling AND MACD < 0 expanding (negative)', () => {
    const rsi: RsiPoint[] = [
      { time: 1, value: 48 },
      { time: 2, value: 45 },
      { time: 3, value: 42 },
      { time: 4, value: 39 },
      { time: 5, value: 36 },
    ];
    const macd: MacdPoint[] = [
      { time: 1, macd: -0.1, signal: -0.05, histogram: -0.05 },
      { time: 2, macd: -0.25, signal: -0.1, histogram: -0.15 },
      { time: 3, macd: -0.4, signal: -0.15, histogram: -0.25 },
    ];
    const result = evaluateIndicators(rsi, macd);
    expect(result.verdict).toBe('bearish');
    expect(result.reason).toContain('falling');
    // MACD < 0 reads as "bearish" in the reason now (was "below zero").
    expect(result.reason).toContain('bearish');
  });

  it('tiebreak: RSI bullish but MACD bearish → follow MACD line sign (bearish)', () => {
    // RSI says bullish (>50, rising)…
    const rsi: RsiPoint[] = [
      { time: 1, value: 52 },
      { time: 2, value: 55 },
      { time: 3, value: 58 },
    ];
    // …but MACD line is below zero AND histogram expanding negatively.
    const macd: MacdPoint[] = [
      { time: 1, macd: -0.5, signal: -0.2, histogram: -0.3 },
      { time: 2, macd: -0.7, signal: -0.3, histogram: -0.4 },
      { time: 3, macd: -1.0, signal: -0.4, histogram: -0.6 },
    ];
    const result = evaluateIndicators(rsi, macd);
    // MACD line < 0 wins the tiebreak.
    expect(result.verdict).toBe('bearish');
  });

  it('tiebreak: RSI bullish, MACD line > 0 with histogram contracting → bullish (both positive)', () => {
    // Both RSI and MACD line agree (positive). Histogram contracting just
    // means the bullish trend is weakening — the verdict is still bullish
    // under the new policy (line sign is the baseline regime).
    const rsi: RsiPoint[] = [
      { time: 1, value: 52 },
      { time: 2, value: 55 },
      { time: 3, value: 60 },
    ];
    const macd: MacdPoint[] = [
      { time: 1, macd: 0.5, signal: 0.2, histogram: 0.3 },
      { time: 2, macd: 0.4, signal: 0.2, histogram: 0.2 }, // hist contracting
      { time: 3, macd: 0.35, signal: 0.2, histogram: 0.15 },
    ];
    const result = evaluateIndicators(rsi, macd);
    expect(result.verdict).toBe('bullish');
    expect(result.reason).toContain('weakening');
  });

  // New test: previously-undercalled bearish case.
  it('MACD < 0 with histogram contracting still reads as bearish (line sign is the regime)', () => {
    // RSI is neutral (50 / flat). MACD line is below zero but the
    // histogram is contracting (bearish trend losing steam). Old policy
    // gated MACD verdict on histogram expansion and would have returned
    // neutral; new policy returns bearish with a "weakening trend"
    // qualifier in the reason.
    const rsi: RsiPoint[] = [
      { time: 1, value: 50 },
      { time: 2, value: 50 },
      { time: 3, value: 50 },
    ];
    const macd: MacdPoint[] = [
      { time: 1, macd: -0.5, signal: -0.3, histogram: -0.2 },
      { time: 2, macd: -0.45, signal: -0.3, histogram: -0.15 }, // hist contracting (less negative)
      { time: 3, macd: -0.4, signal: -0.3, histogram: -0.10 },
    ];
    const result = evaluateIndicators(rsi, macd);
    expect(result.verdict).toBe('bearish');
    expect(result.reason).toContain('weakening');
    expect(result.reason).toContain('bearish');
  });

  // New test: bullish line, expanding histogram → strengthening trend gloss.
  it('MACD > 0 with histogram expanding reads as bullish + strengthening trend', () => {
    const rsi: RsiPoint[] = [
      { time: 1, value: 50 },
      { time: 2, value: 50 },
      { time: 3, value: 50 },
    ];
    const macd: MacdPoint[] = [
      { time: 1, macd: 0.2, signal: 0.05, histogram: 0.15 },
      { time: 2, macd: 0.4, signal: 0.10, histogram: 0.30 },
      { time: 3, macd: 0.6, signal: 0.15, histogram: 0.45 },
    ];
    const result = evaluateIndicators(rsi, macd);
    expect(result.verdict).toBe('bullish');
    expect(result.reason).toContain('strengthening');
  });

  it('returns neutral with empty inputs', () => {
    expect(evaluateIndicators([], []).verdict).toBe('neutral');
  });
});

// ---------- summarize ----------

describe('summarize', () => {
  it('three bullish witnesses → high-bullish conviction', () => {
    const summary = summarize(
      { verdict: 'bullish', reason: 'trend up' },
      { verdict: 'bullish', reason: 'accumulation' },
      { verdict: 'bullish', reason: 'rsi/macd up' },
    );
    expect(summary.conviction).toBe('high-bullish');
    expect(summary.convictionLabel).toContain('3/3');
    expect(summary.convictionLabel).toContain('High-conviction bullish');
    expect(summary.recommendation).toContain('raising scaling sell levels');
  });

  it('three bearish witnesses → high-bearish conviction', () => {
    const summary = summarize(
      { verdict: 'bearish', reason: 'trend down' },
      { verdict: 'bearish', reason: 'distribution' },
      { verdict: 'bearish', reason: 'rsi/macd down' },
    );
    expect(summary.conviction).toBe('high-bearish');
    expect(summary.convictionLabel).toContain('3/3');
    expect(summary.recommendation).toContain('Pcover');
  });

  it('2 bullish + 1 bearish → moderate-bullish', () => {
    const summary = summarize(
      { verdict: 'bullish', reason: '' },
      { verdict: 'bullish', reason: '' },
      { verdict: 'bearish', reason: '' },
    );
    expect(summary.conviction).toBe('moderate-bullish');
    expect(summary.convictionLabel).toContain('2/3');
  });

  it('2 bullish + 1 neutral → moderate-bullish', () => {
    const summary = summarize(
      { verdict: 'bullish', reason: '' },
      { verdict: 'bullish', reason: '' },
      { verdict: 'neutral', reason: '' },
    );
    expect(summary.conviction).toBe('moderate-bullish');
  });

  it('2 bearish + 1 neutral → moderate-bearish', () => {
    const summary = summarize(
      { verdict: 'bearish', reason: '' },
      { verdict: 'bearish', reason: '' },
      { verdict: 'neutral', reason: '' },
    );
    expect(summary.conviction).toBe('moderate-bearish');
  });

  it('1 bullish + 1 bearish + 1 neutral → neutral (no conviction)', () => {
    const summary = summarize(
      { verdict: 'bullish', reason: '' },
      { verdict: 'bearish', reason: '' },
      { verdict: 'neutral', reason: '' },
    );
    expect(summary.conviction).toBe('neutral');
    expect(summary.recommendation).toContain('mixed');
  });

  it('all neutral → neutral conviction', () => {
    const summary = summarize(
      { verdict: 'neutral', reason: '' },
      { verdict: 'neutral', reason: '' },
      { verdict: 'neutral', reason: '' },
    );
    expect(summary.conviction).toBe('neutral');
  });
});
