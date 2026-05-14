// Pure-function tests for the Backtest module.
//
// Two surfaces under test:
//
//   1. The `BACKTEST_QUERIES` SQL builders — same approach as
//      `screener.test.ts`. We don't run the queries here (vitest
//      doesn't load DuckDB-WASM), we lock down the structural
//      invariants of each query: right tables, right WHERE filter,
//      ticker safely interpolated.
//
//   2. The `computeConvictionSeries` pure helper — synthetic series
//      built in the test, no DuckDB. We craft a sequence where the
//      trend regime flips mid-window and assert the resulting
//      conviction transitions match. This proves the per-bar
//      "as-of" slicing is correct without relying on the live
//      indicator pipeline.
//
// Tests deliberately do NOT cover `runBacktest` or
// `computeHistoricalConviction` themselves — those are thin shims
// over the helper + DuckDB I/O and are integration-tested by
// clicking through the BacktestPanel in the running app.

import { describe, it, expect } from 'vitest';
import type { Candle, MaPoint, VolumeBar } from './queries';
import type { RsiPoint, MacdPoint } from './indicators';
import {
  BACKTEST_QUERIES,
  CONVICTION_NUMERIC,
  MIN_BARS_FOR_BACKTEST,
  computeConvictionSeries,
  getBacktestQueryById,
} from './backtest';
import type { Conviction } from './witnesses';

// ---------- BACKTEST_QUERIES catalog ----------

describe('BACKTEST_QUERIES catalog', () => {
  it('exports three predefined queries', () => {
    expect(BACKTEST_QUERIES).toHaveLength(3);
  });

  it('every query has a unique id', () => {
    const ids = BACKTEST_QUERIES.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every query has label, description, and at least one column', () => {
    for (const q of BACKTEST_QUERIES) {
      expect(q.label.length).toBeGreaterThan(0);
      expect(q.description.length).toBeGreaterThan(20);
      expect(q.columns.length).toBeGreaterThan(0);
    }
  });

  it('every query.buildSql produces non-empty SQL', () => {
    for (const q of BACKTEST_QUERIES) {
      const sql = q.buildSql('AAPL');
      expect(sql.trim().length).toBeGreaterThan(0);
    }
  });

  it('every query.buildSql interpolates the ticker as a quoted string', () => {
    for (const q of BACKTEST_QUERIES) {
      const sql = q.buildSql('NVDA');
      expect(sql).toContain("'NVDA'");
    }
  });

  it('column format hints are restricted to the supported set', () => {
    const allowed = new Set(['price', 'pct', 'number', 'date', 'string']);
    for (const q of BACKTEST_QUERIES) {
      for (const col of q.columns) {
        if (col.format !== undefined) {
          expect(allowed.has(col.format)).toBe(true);
        }
      }
    }
  });
});

describe('getBacktestQueryById', () => {
  it('returns the query for a known id', () => {
    expect(getBacktestQueryById('bullish-fridays-2025')?.id).toBe(
      'bullish-fridays-2025',
    );
  });

  it('returns undefined for an unknown id', () => {
    expect(getBacktestQueryById('does-not-exist')).toBeUndefined();
  });
});

// ---------- per-query SQL invariants ----------

describe('bullish-fridays-2025 query', () => {
  const q = getBacktestQueryById('bullish-fridays-2025')!;

  it('filters on year = 2025 AND Friday (dow = 5)', () => {
    const sql = q.buildSql('AAPL');
    expect(sql).toContain("EXTRACT('year' FROM s.dt) = 2025");
    expect(sql).toContain("EXTRACT('dow' FROM s.dt) = 5");
  });

  it('requires both bullish-momentum AND bullish-trend conditions', () => {
    const sql = q.buildSql('AAPL');
    // RSI > 50 (momentum) AND close > 20-MA (trend) — both must be true.
    expect(sql).toContain('r.value > 50');
    expect(sql).toContain('s.close > s.value');
  });

  it('joins indicators_rsi at period = 14', () => {
    const sql = q.buildSql('AAPL');
    expect(sql).toContain('indicators_rsi');
    expect(sql).toContain('r.period = 14');
  });

  it('uses a 20-bar rolling SMA window (19 PRECEDING)', () => {
    const sql = q.buildSql('AAPL');
    expect(sql).toContain('19 PRECEDING');
  });
});

describe('best-30d-windows query', () => {
  const q = getBacktestQueryById('best-30d-windows')!;

  it('uses LAG(_, 30) to look back 30 trading days', () => {
    const sql = q.buildSql('AAPL');
    expect(sql).toContain('LAG(dt, 30)');
    expect(sql).toContain('LAG(close, 30)');
  });

  it('orders descending by return_pct and limits to 10', () => {
    const sql = q.buildSql('AAPL');
    expect(sql).toMatch(/ORDER BY\s+return_pct DESC/);
    expect(sql).toMatch(/LIMIT\s+10/);
  });

  it('skips the warmup rows where the 30-day lag is null', () => {
    const sql = q.buildSql('AAPL');
    // Without this the first 30 bars would emit NULL/NULL/NaN rows.
    expect(sql).toContain('start_dt IS NOT NULL');
  });

  it('computes return as a percentage off the start_close', () => {
    const sql = q.buildSql('AAPL');
    expect(sql).toContain(
      '100.0 * (end_close - start_close) / start_close',
    );
  });
});

describe('rsi-extremes-followup query', () => {
  const q = getBacktestQueryById('rsi-extremes-followup')!;

  it('flags both extremes (RSI > 70 OR RSI < 30)', () => {
    const sql = q.buildSql('AAPL');
    expect(sql).toContain('a.rsi > 70 OR a.rsi < 30');
  });

  it('classifies the signal_type as overbought vs oversold', () => {
    const sql = q.buildSql('AAPL');
    expect(sql).toContain(
      "CASE WHEN a.rsi > 70 THEN 'overbought' ELSE 'oversold' END",
    );
  });

  it('joins each signal bar to the bar 10 trading days later', () => {
    const sql = q.buildSql('AAPL');
    // ROW_NUMBER per ticker by date, then self-join b.rn = a.rn + 10.
    expect(sql).toContain('ROW_NUMBER()');
    expect(sql).toContain('b.rn = a.rn + 10');
  });

  it('drops signals whose 10-day-future bar does not exist yet', () => {
    const sql = q.buildSql('AAPL');
    // LEFT JOIN + WHERE future_close IS NOT NULL — recent signals at
    // the tail of history have no future bar to compare against.
    expect(sql).toContain('LEFT JOIN');
    expect(sql).toContain('future_close IS NOT NULL');
  });

  it('limits to the most recent 25 signals', () => {
    const sql = q.buildSql('AAPL');
    expect(sql).toMatch(/ORDER BY\s+signal_dt DESC/);
    expect(sql).toMatch(/LIMIT\s+25/);
  });
});

// ---------- CONVICTION_NUMERIC mapping ----------

describe('CONVICTION_NUMERIC', () => {
  it('covers all 5 verdict levels', () => {
    const verdicts: Conviction[] = [
      'high-bullish',
      'moderate-bullish',
      'neutral',
      'moderate-bearish',
      'high-bearish',
    ];
    for (const v of verdicts) {
      expect(CONVICTION_NUMERIC).toHaveProperty(v);
      expect(typeof CONVICTION_NUMERIC[v]).toBe('number');
    }
  });

  it('is symmetric around neutral (0)', () => {
    expect(CONVICTION_NUMERIC['high-bullish']).toBe(2);
    expect(CONVICTION_NUMERIC['moderate-bullish']).toBe(1);
    expect(CONVICTION_NUMERIC['neutral']).toBe(0);
    expect(CONVICTION_NUMERIC['moderate-bearish']).toBe(-1);
    expect(CONVICTION_NUMERIC['high-bearish']).toBe(-2);
  });

  it('exposes a non-trivial minimum-bars guard', () => {
    // Sanity: the panel relies on this constant being meaningful.
    // The trend witness needs the 200-MA so the floor must be >= 200.
    expect(MIN_BARS_FOR_BACKTEST).toBeGreaterThanOrEqual(200);
  });
});

// ---------- computeConvictionSeries ----------
//
// Synthetic-data tests for the per-bar witness loop. Each series is
// built so the witness verdicts are deterministic at every step, and
// we assert on the resulting (conviction, numeric) sequence.

/**
 * Build a rising candle series. Each bar is green (close > open) with
 * a constant per-bar step. Time stamps are 1-second-spaced — only
 * ordering matters for the witness logic.
 */
function risingCandles(n: number, start = 100, step = 0.5): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: i + 1,
    open: start + i * step - step / 2,
    high: start + i * step + step / 2,
    low: start + i * step - step,
    close: start + i * step + step / 2,
  }));
}

/** SMA-shaped helper: emit `(time = i+1, value = values[i])`. */
function ma(values: number[]): MaPoint[] {
  return values.map((value, i) => ({ time: i + 1, value }));
}

/** Volume bars sized to match `candles` length, all neutral volume. */
function flatVolume(candles: Candle[]): VolumeBar[] {
  return candles.map((c) => ({
    time: c.time,
    value: 1_000_000,
    color: c.close >= c.open ? '#26a69a' : '#ef5350',
  }));
}

describe('computeConvictionSeries', () => {
  it('returns one point per bar in the lookback window', () => {
    const candles = risingCandles(50);
    const series = computeConvictionSeries(
      candles,
      ma(new Array(50).fill(100)),
      ma(new Array(50).fill(95)),
      flatVolume(candles),
      [],
      [],
      20,
    );
    expect(series).toHaveLength(20);
  });

  it('clips the lookback to available bars when shorter than requested', () => {
    const candles = risingCandles(10);
    const series = computeConvictionSeries(
      candles,
      ma(new Array(10).fill(100)),
      ma(new Array(10).fill(95)),
      flatVolume(candles),
      [],
      [],
      250,
    );
    // 10 bars available, 250 requested — should still produce 10 points.
    expect(series).toHaveLength(10);
  });

  it('emits time-ordered points with consistent dt strings', () => {
    const candles = risingCandles(30);
    const series = computeConvictionSeries(
      candles,
      ma(new Array(30).fill(100)),
      ma(new Array(30).fill(95)),
      flatVolume(candles),
      [],
      [],
      30,
    );
    for (let i = 1; i < series.length; i++) {
      expect(series[i].time).toBeGreaterThan(series[i - 1].time);
    }
    // dt is always a 10-char ISO date.
    for (const p of series) {
      expect(p.dt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('numeric value matches CONVICTION_NUMERIC for every emitted point', () => {
    const candles = risingCandles(15);
    const series = computeConvictionSeries(
      candles,
      ma(new Array(15).fill(100)),
      ma(new Array(15).fill(95)),
      flatVolume(candles),
      [],
      [],
      15,
    );
    for (const p of series) {
      expect(p.numeric).toBe(CONVICTION_NUMERIC[p.conviction]);
    }
  });

  it('flags high-bullish when all three witnesses agree on bullish at the latest bar', () => {
    // Build a sequence with a clear bullish stack: rising price, rising
    // 20-MA below price, rising 200-MA below the 20-MA, accumulation
    // volume in the last 10 bars, RSI > 50 rising, MACD > 0.
    const candles: Candle[] = [
      // 15 background bars at neutral volume baseline
      ...risingCandles(15, 100, 0.1),
      // 10 bars: most green with high volume (accumulation)
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

    // SMAs: 20 stacked just below price, 200 stacked further below;
    // both rising. Use enough length so .filter(time<=t) at the last
    // bar still yields >= MA_SLOPE_LOOKBACK points.
    const sma20 = ma(
      Array.from({ length: candles.length }, (_, i) => 100 + i * 0.05),
    );
    const sma200 = ma(
      Array.from({ length: candles.length }, (_, i) => 95 + i * 0.02),
    );

    // Volume: low background, high on green days in the tail.
    const volume: VolumeBar[] = candles.map((c, i) => ({
      time: c.time,
      value:
        i < candles.length - 10
          ? 1_000_000
          : c.close >= c.open
            ? 2_000_000
            : 500_000,
      color: c.close >= c.open ? '#26a69a' : '#ef5350',
    }));

    // RSI rising above 50, MACD line above zero with expanding histogram.
    const rsi: RsiPoint[] = candles.map((c, i) => ({
      time: c.time,
      value: 52 + i * 0.5,
    }));
    const macd: MacdPoint[] = candles.map((c, i) => ({
      time: c.time,
      macd: 0.5 + i * 0.05,
      signal: 0.4 + i * 0.04,
      histogram: 0.1 + i * 0.01,
    }));

    const series = computeConvictionSeries(
      candles,
      sma20,
      sma200,
      volume,
      rsi,
      macd,
      5, // last 5 bars only — focus on the strongly-bullish tail
    );

    // Every point in the bullish tail should be 'high-bullish' (all
    // three witnesses agree). Exactly 3-of-3 = high-bullish per
    // summarize().
    expect(series).toHaveLength(5);
    expect(series[series.length - 1].conviction).toBe('high-bullish');
    expect(series[series.length - 1].numeric).toBe(2);
  });

  it('detects a regime transition when trend + indicators flip from neutral to bullish', () => {
    // Synthesize 30 bars where the first 10 are flat (neutral on every
    // witness) and the last 20 ramp into a bullish stack with rising
    // RSI and positive MACD. The conviction series should show at
    // least one transition from neutral to a bullish verdict.
    //
    // Why we need RSI + MACD here: with only trend bullish (1-of-3)
    // and the other two neutral, summarize() returns neutral per the
    // "2-of-3 needed" rule. To get a flip in the final conviction we
    // need at least two witnesses to land bullish, so we provide
    // bullish RSI + MACD across the rising part.
    const flatPart = Array.from({ length: 10 }, (_, i) => ({
      time: i + 1,
      open: 100,
      high: 100.1,
      low: 99.9,
      close: 100,
    })) as Candle[];
    const risingPart = Array.from({ length: 20 }, (_, i) => ({
      time: 11 + i,
      open: 100 + i * 0.5,
      high: 100.5 + i * 0.5,
      low: 99.8 + i * 0.5,
      close: 100.4 + i * 0.5,
    })) as Candle[];
    const candles = [...flatPart, ...risingPart];

    // SMAs that stay stacked below price across the rising part.
    const sma20 = ma(
      Array.from({ length: candles.length }, (_, i) =>
        i < 10 ? 99.5 : 99.5 + (i - 10) * 0.4,
      ),
    );
    const sma200 = ma(
      Array.from({ length: candles.length }, (_, i) =>
        i < 10 ? 99 : 99 + (i - 10) * 0.2,
      ),
    );
    const volume = flatVolume(candles);

    // RSI: flat at 50 in the first 10 bars (neither rising nor above 50
    // by enough to flag bullish), then ramping above 50 in the rising
    // part. MACD: zero/flat in flat part, positive in rising part.
    const rsi: RsiPoint[] = candles.map((c, i) => ({
      time: c.time,
      value: i < 10 ? 50 : 52 + (i - 10) * 0.8,
    }));
    const macd: MacdPoint[] = candles.map((c, i) => ({
      time: c.time,
      macd: i < 10 ? 0 : 0.2 + (i - 10) * 0.05,
      signal: i < 10 ? 0 : 0.15 + (i - 10) * 0.04,
      histogram: i < 10 ? 0 : 0.05 + (i - 10) * 0.01,
    }));

    const series = computeConvictionSeries(
      candles,
      sma20,
      sma200,
      volume,
      rsi,
      macd,
      candles.length,
    );

    // At least one verdict transition somewhere in the window.
    const transitions = series.reduce<number>((count, p, i) => {
      if (i === 0) return 0;
      return count + (p.conviction !== series[i - 1].conviction ? 1 : 0);
    }, 0);
    expect(transitions).toBeGreaterThan(0);

    // The series should contain more than one distinct conviction
    // verdict — proves the per-bar slicing actually moves the witness
    // outputs as bars accumulate.
    const distinctConvictions = new Set(series.map((p) => p.conviction));
    expect(distinctConvictions.size).toBeGreaterThan(1);

    // The last bar (deep in the rising part with bullish trend AND
    // bullish indicators) should land on at least moderate-bullish.
    const last = series[series.length - 1];
    expect(['moderate-bullish', 'high-bullish']).toContain(last.conviction);
  });
});
