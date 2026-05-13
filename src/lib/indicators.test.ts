// Smoke tests for the indicator wrappers. These don't exercise DuckDB —
// they validate that our adapters around `technicalindicators` produce
// sensible numbers for inputs with known analytic limits.
//
// Reference behaviour:
//   - RSI of monotonically rising closes → 100
//   - RSI of monotonically falling closes → 0
//   - RSI of constant closes → no output (avg gain == avg loss == 0;
//     library skips the warmup and returns nothing meaningful)
//   - MACD of constant closes → MACD/signal/hist all 0
//   - Divergence detector: bearish on a higher high + lower RSI high
//
// We use Vitest because Vite already powers the build pipeline.

import { describe, it, expect } from 'vitest';
import {
  computeRsi,
  computeMacd,
  detectRsiDivergence,
  type ClosePoint,
  type RsiPoint,
} from './indicators';

function makeCloses(values: number[], startTime = 1_700_000_000): ClosePoint[] {
  // 86400 = one day in seconds; arbitrary but realistic spacing.
  return values.map((close, i) => ({ time: startTime + i * 86_400, close }));
}

describe('computeRsi', () => {
  it('returns RSI ~100 for monotonically rising closes', () => {
    const closes = makeCloses(Array.from({ length: 30 }, (_, i) => i + 1));
    const rsi = computeRsi(closes, 14);
    expect(rsi.length).toBeGreaterThan(0);
    const last = rsi[rsi.length - 1].value;
    expect(last).toBeGreaterThan(99.9);
    expect(last).toBeLessThanOrEqual(100);
  });

  it('returns RSI ~0 for monotonically falling closes', () => {
    const closes = makeCloses(Array.from({ length: 30 }, (_, i) => 100 - i));
    const rsi = computeRsi(closes, 14);
    expect(rsi.length).toBeGreaterThan(0);
    const last = rsi[rsi.length - 1].value;
    expect(last).toBeGreaterThanOrEqual(0);
    expect(last).toBeLessThan(0.1);
  });

  it('handles constant closes without crashing', () => {
    // With zero gains AND zero losses the library returns NaN/undefined,
    // which our wrapper filters out. The contract is "no crash"; an empty
    // result is acceptable.
    const closes = makeCloses(new Array(30).fill(50));
    const rsi = computeRsi(closes, 14);
    // Either empty or every entry finite — neither crashes the chart.
    for (const p of rsi) {
      expect(Number.isFinite(p.value)).toBe(true);
    }
  });

  it('returns empty when input is shorter than the warmup window', () => {
    const closes = makeCloses([1, 2, 3, 4, 5]);
    expect(computeRsi(closes, 14)).toEqual([]);
  });

  it('aligns RSI timestamps to the closes they were computed from', () => {
    const closes = makeCloses(Array.from({ length: 30 }, (_, i) => i + 1));
    const rsi = computeRsi(closes, 14);
    // Every RSI timestamp must exist in the input closes; the last RSI
    // timestamp must equal the last close timestamp.
    const closeTimes = new Set(closes.map((c) => c.time));
    for (const p of rsi) expect(closeTimes.has(p.time)).toBe(true);
    expect(rsi[rsi.length - 1].time).toBe(closes[closes.length - 1].time);
  });
});

describe('computeMacd', () => {
  it('returns all-zero MACD/signal/histogram for constant closes', () => {
    const closes = makeCloses(new Array(60).fill(100));
    const macd = computeMacd(closes, 12, 26, 9);
    expect(macd.length).toBeGreaterThan(0);
    for (const p of macd) {
      expect(Math.abs(p.macd)).toBeLessThan(1e-9);
      expect(Math.abs(p.signal)).toBeLessThan(1e-9);
      expect(Math.abs(p.histogram)).toBeLessThan(1e-9);
    }
  });

  it('returns positive MACD for steadily rising closes', () => {
    const closes = makeCloses(Array.from({ length: 80 }, (_, i) => 100 + i));
    const macd = computeMacd(closes, 12, 26, 9);
    expect(macd.length).toBeGreaterThan(0);
    const last = macd[macd.length - 1];
    // Fast EMA leads slow EMA upward → MACD line is positive.
    expect(last.macd).toBeGreaterThan(0);
  });

  it('returns negative MACD for steadily falling closes', () => {
    const closes = makeCloses(Array.from({ length: 80 }, (_, i) => 200 - i));
    const macd = computeMacd(closes, 12, 26, 9);
    expect(macd.length).toBeGreaterThan(0);
    const last = macd[macd.length - 1];
    expect(last.macd).toBeLessThan(0);
  });

  it('returns empty when input is shorter than the warmup window', () => {
    const closes = makeCloses(Array.from({ length: 20 }, (_, i) => i));
    expect(computeMacd(closes, 12, 26, 9)).toEqual([]);
  });
});

describe('detectRsiDivergence', () => {
  it('flags bearish divergence: higher price high + lower RSI high', () => {
    // Construct a synthetic RSI/price pair with a clear bearish divergence:
    // the second peak is higher in price but lower in RSI.
    const closes: ClosePoint[] = [
      { time: 1, close: 100 },
      { time: 2, close: 110 }, // peak 1 (price)
      { time: 3, close: 105 },
      { time: 4, close: 115 }, // peak 2 (price, higher)
      { time: 5, close: 108 },
    ];
    const rsi: RsiPoint[] = [
      { time: 1, value: 50 },
      { time: 2, value: 80 }, // RSI peak 1 (high)
      { time: 3, value: 60 },
      { time: 4, value: 65 }, // RSI peak 2 (lower)
      { time: 5, value: 55 },
    ];
    const flag = detectRsiDivergence(rsi, closes, 30);
    expect(flag.bearish).toBe(true);
    expect(flag.description).toContain('Bearish');
  });

  it('flags bullish divergence: lower price low + higher RSI low', () => {
    const closes: ClosePoint[] = [
      { time: 1, close: 100 },
      { time: 2, close: 80 }, // trough 1
      { time: 3, close: 90 },
      { time: 4, close: 75 }, // trough 2 (lower)
      { time: 5, close: 85 },
    ];
    const rsi: RsiPoint[] = [
      { time: 1, value: 50 },
      { time: 2, value: 25 }, // RSI trough 1 (low)
      { time: 3, value: 40 },
      { time: 4, value: 30 }, // RSI trough 2 (higher)
      { time: 5, value: 45 },
    ];
    const flag = detectRsiDivergence(rsi, closes, 30);
    expect(flag.bullish).toBe(true);
    expect(flag.description).toContain('Bullish');
  });

  it('returns no divergence for an empty input', () => {
    expect(detectRsiDivergence([], [], 30)).toEqual({
      bearish: false,
      bullish: false,
      description: '',
    });
  });

  it('returns no divergence when price and RSI move in lockstep', () => {
    const closes: ClosePoint[] = Array.from({ length: 30 }, (_, i) => ({
      time: i + 1,
      close: 100 + i,
    }));
    const rsi: RsiPoint[] = Array.from({ length: 30 }, (_, i) => ({
      time: i + 1,
      value: 50 + i,
    }));
    const flag = detectRsiDivergence(rsi, closes, 30);
    expect(flag.bearish).toBe(false);
    expect(flag.bullish).toBe(false);
  });
});
