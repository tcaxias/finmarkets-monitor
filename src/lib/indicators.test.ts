// Tests for the pure parts of indicators.ts.
//
// History: this file used to also test `computeRsi` / `computeMacd`
// against the `technicalindicators` npm package. Those wrappers were
// removed in the migration-v3 commit (RSI/MACD now compute in DuckDB
// SQL via recursive CTEs — see `sqlIndicators.ts`). Testing the SQL
// implementations would require booting DuckDB-WASM in the vitest
// runner, which doesn't have a worker or OPFS. We rely on manual
// post-deploy verification (compare a few RSI/MACD values against the
// prior deployment) for SQL-implementation parity.
//
// What's left here: the `detectRsiDivergence` test suite. It's a pure
// function over already-computed RsiPoint and ClosePoint arrays, so
// it tests cleanly without any database dependency.
//
// We use Vitest because Vite already powers the build pipeline.

import { describe, it, expect } from 'vitest';
import {
  detectRsiDivergence,
  type ClosePoint,
  type RsiPoint,
} from './indicators';

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
