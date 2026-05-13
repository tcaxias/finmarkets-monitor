// Tests for the Sunday weekly-review markdown generator.
//
// We synthesize the typed inputs directly — no DuckDB. Each test pins a
// distinct property of the output: section presence, auto-fill correctness,
// blank-judgment markers, red-flag triggering, and footer presence.
//
// Why string assertions: the document is human-readable markdown and its
// section headers are part of the contract (we promise to mirror the
// canonical template). String matching is the right level of granularity —
// a structural parser would be overkill and would obscure regressions in
// the literal header text.

import { describe, it, expect } from 'vitest';
import { generateSundayReview, type ReviewInputs } from './sundayReview';
import { computeThresholds } from './math';
import type { Candle, MaPoint } from './queries';
import type { RsiPoint, MacdPoint } from './indicators';
import type { WitnessSummary } from './witnesses';

// ---------- builders ----------

/**
 * Build a synthetic ReviewInputs with sensible defaults. Each test
 * overrides only the fields it cares about. Default scenario: comfortably
 * above Pcover+20%, neutral witnesses, ~150 days until tax due.
 */
function makeInputs(overrides: Partial<ReviewInputs> = {}): ReviewInputs {
  // 30 daily candles, slightly rising, last close ≈ $35.
  const candles: Candle[] = Array.from({ length: 30 }, (_, i) => ({
    time: 1700000000 + i * 86400,
    open: 30 + i * 0.15,
    high: 30 + i * 0.15 + 0.5,
    low: 30 + i * 0.15 - 0.3,
    close: 30 + i * 0.15 + 0.2,
  }));

  const sma20: MaPoint[] = candles.slice(-15).map((c, i) => ({
    time: c.time,
    value: 32 + i * 0.1,
  }));
  const sma200: MaPoint[] = candles.slice(-15).map((c, i) => ({
    time: c.time,
    value: 28 + i * 0.05,
  }));

  // Default volume: flat-ish around 1M, so no week-vs-50-day signal fires.
  const volume = candles.map((c) => ({
    time: c.time,
    value: 1_000_000,
    color: c.close >= c.open ? '#26a69a' : '#ef5350',
  }));

  const rsi: RsiPoint[] = candles.slice(-14).map((c, i) => ({
    time: c.time,
    value: 55 + i * 0.2,
  }));

  const macd: MacdPoint[] = candles.slice(-10).map((c, i) => ({
    time: c.time,
    macd: 0.1 + i * 0.05,
    signal: 0.05 + i * 0.04,
    histogram: 0.05 + i * 0.01,
  }));

  const witnesses: WitnessSummary = {
    trend: { verdict: 'neutral', reason: 'Mixed' },
    volume: { verdict: 'neutral', reason: 'Flat' },
    indicators: { verdict: 'neutral', reason: 'Mixed' },
    conviction: 'neutral',
    convictionLabel: 'No conviction (0 bullish, 0 bearish, 3 neutral)',
    recommendation: 'Hold and wait — mixed signals',
  };

  // Vest price $50, 100 shares, 45% tax → Pcover = 22.50, Pcover+20% = 27.00.
  // Default candles top out around $35, so we're comfortably above both.
  const thresholds = computeThresholds(50, 100, 0.45);

  // Default tax due date: ~150 days out from a fixed reference review date.
  const reviewDate = new Date('2026-05-13T12:00:00Z');
  const taxDueDate = '2026-10-10';

  return {
    ticker: 'AAPL',
    reviewDate,
    thresholds,
    taxDueDate,
    candles,
    sma20,
    sma200,
    volume,
    rsi,
    macd,
    witnesses,
    ...overrides,
  };
}

// ---------- core structure ----------

describe('generateSundayReview — structure', () => {
  it('produces a non-empty string', () => {
    const out = generateSundayReview(makeInputs());
    expect(out).toBeTruthy();
    expect(out.length).toBeGreaterThan(500);
  });

  it('contains all 10 numbered section headers in order', () => {
    const out = generateSundayReview(makeInputs());
    const headers = [
      '### 1. Tradeability gate',
      '### 2. Time-pressure check',
      '### 3. Price snapshot',
      '### 4. Trend & MA check',
      '### 5. Support & resistance check',
      '### 6. Volume check',
      '### 7. Indicator check',
      '### 8. Three-witness summary',
      '### 9. Decision',
      '### 10. Calendar items for the week ahead',
    ];
    let lastIdx = -1;
    for (const h of headers) {
      const idx = out.indexOf(h);
      expect(idx, `header ${h} missing`).toBeGreaterThan(-1);
      expect(idx, `header ${h} out of order`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it('contains the top-of-doc banner with ticker and ISO date', () => {
    const out = generateSundayReview(makeInputs());
    expect(out).toContain('# AAPL Weekly Review — Auto-Generated 2026-05-13');
    expect(out).toContain('NOT a substitute for personal judgment');
  });

  it('contains the pre-flight, cognitive integrity, and red-flag triggers sections', () => {
    const out = generateSundayReview(makeInputs());
    expect(out).toContain('## Pre-flight');
    expect(out).toContain('## Cognitive integrity checks');
    expect(out).toContain('## Red-flag triggers');
  });

  it('contains the auto-fill summary footer at the end', () => {
    const out = generateSundayReview(makeInputs());
    expect(out).toContain('## Auto-fill summary');
    expect(out).toContain('Generated at: 2026-05-13T12:00:00Z');
    expect(out).toContain('Witnesses: No conviction');
    expect(out).toContain('Recommendation: Hold and wait');
    // Footer should be the last section.
    const footerIdx = out.indexOf('## Auto-fill summary');
    expect(footerIdx).toBeGreaterThan(out.indexOf('## Red-flag triggers'));
  });
});

// ---------- auto-fill correctness ----------

describe('generateSundayReview — auto-fill', () => {
  it('fills latest close in the price snapshot', () => {
    const inputs = makeInputs();
    const latest = inputs.candles[inputs.candles.length - 1].close;
    const expected = `$${latest.toFixed(2)}`;
    const out = generateSundayReview(inputs);
    expect(out).toContain(`AAPL close (Friday): ${expected}`);
  });

  it('fills the week-change percentage', () => {
    const out = generateSundayReview(makeInputs());
    // Default series rises ~$0.15/bar — should produce a small positive %.
    expect(out).toMatch(/Week change: \+\d+\.\d{2}%/);
  });

  it('fills RSI value and checks the right bucket', () => {
    const inputs = makeInputs();
    const rsiVal = inputs.rsi[inputs.rsi.length - 1].value;
    const out = generateSundayReview(inputs);
    expect(out).toContain(`Current value: ${rsiVal.toFixed(0)}`);
    // Default RSI tops at ~57.6, so 50–70 bucket should be checked.
    expect(out).toMatch(/\[x\] 50–70 \(bullish\)/);
  });

  it('auto-fills MA values and slope checkboxes', () => {
    const inputs = makeInputs();
    const ma20 = inputs.sma20[inputs.sma20.length - 1].value;
    const out = generateSundayReview(inputs);
    expect(out).toContain(`20-day MA value: $${ma20.toFixed(2)}`);
    // Default sma20 is rising → "[x] up" should appear in the 20-MA line.
    const ma20Line = out
      .split('\n')
      .find((l) => l.startsWith('- 20-day MA value:'));
    expect(ma20Line).toBeTruthy();
    expect(ma20Line!).toContain('[x] up');
  });

  it('auto-checks the time-pressure bucket based on days until tax due', () => {
    // 90–180 day bucket: pick a date ~150 days from a fixed review date.
    const reviewDate = new Date('2026-05-13T12:00:00Z');
    const out = generateSundayReview(
      makeInputs({ reviewDate, taxDueDate: '2026-10-10' }),
    );
    // The 90–180 bucket should be checked; the others should not.
    expect(out).toMatch(/\[x\] 90–180 days/);
    expect(out).toMatch(/\[ \] >180 days/);
    expect(out).toMatch(/\[ \] 30–90 days/);
    expect(out).toMatch(/\[ \] <30 days/);
  });

  it('reflects witness conviction in section 8 tally', () => {
    const witnesses: WitnessSummary = {
      trend: { verdict: 'bearish', reason: 'down' },
      volume: { verdict: 'bearish', reason: 'distribution' },
      indicators: { verdict: 'bearish', reason: 'down' },
      conviction: 'high-bearish',
      convictionLabel: 'High-conviction bearish (3/3 witnesses)',
      recommendation: 'Review exit plan against Pcover thresholds',
    };
    const out = generateSundayReview(makeInputs({ witnesses }));
    // All three table rows should have bearish checked.
    expect(out).toMatch(/Trend.*\[x\] \| \[ \]/);
    expect(out).toMatch(/Volume.*\[x\] \| \[ \]/);
    expect(out).toMatch(/Indicators.*\[x\] \| \[ \]/);
    // Conviction bucket: 3 bearish → high-conviction bearish checked.
    expect(out).toMatch(/\[x\] 3 bearish witnesses/);
  });
});

// ---------- judgment-only sections ----------

describe('generateSundayReview — judgment markers', () => {
  it('leaves section 1 (tradeability) checkboxes all unchecked', () => {
    const out = generateSundayReview(makeInputs());
    const section = sliceSection(out, '### 1. Tradeability gate', '### 2.');
    // All four checkboxes should be `[ ]` — no `[x]` in this section.
    expect(section).not.toMatch(/\[x\]/);
  });

  it('leaves section 5 (S/R) blank with explanatory note', () => {
    const out = generateSundayReview(makeInputs());
    const section = sliceSection(out, '### 5. Support & resistance', '### 6.');
    expect(section).toContain('auto-detection out of scope');
    expect(section).toContain('$______');
    expect(section).not.toMatch(/\[x\]/);
  });

  it('leaves section 9 (decision) all unchecked', () => {
    const out = generateSundayReview(makeInputs());
    const section = sliceSection(out, '### 9. Decision', '### 10.');
    expect(section).not.toMatch(/\[x\]/);
    expect(section).toContain('______');
  });

  it('leaves section 10 (calendar) and cognitive integrity all blank', () => {
    const out = generateSundayReview(makeInputs());
    const cal = sliceSection(out, '### 10. Calendar', '## Cognitive');
    expect(cal).not.toMatch(/\[x\]/);
    expect(cal).toContain('______');

    const cog = sliceSection(out, '## Cognitive integrity', '## Red-flag');
    expect(cog).not.toMatch(/\[x\]/);
  });
});

// ---------- red-flag activation ----------

describe('generateSundayReview — red-flag triggers', () => {
  it('emits a WARNING banner and "yes" tally when latest close is below Pcover+20%', () => {
    const inputs = makeInputs();
    // Push the last candle below Pcover+20% (= $27.00 with default thresholds).
    inputs.candles[inputs.candles.length - 1] = {
      ...inputs.candles[inputs.candles.length - 1],
      close: 25.0,
      open: 26.0,
    };
    const out = generateSundayReview(inputs);
    expect(out).toContain('⚠️ **WARNING — red-flag triggers active');
    expect(out).toMatch(/below Pcover\+20%/);
    // The "are any active" question should be auto-answered "yes".
    expect(out).toMatch(/\*\*Are any active right now\?\*\* \[x\] yes/);
  });

  it('does NOT emit the WARNING banner when comfortably above thresholds', () => {
    const out = generateSundayReview(makeInputs());
    expect(out).not.toContain('⚠️ **WARNING');
    expect(out).toMatch(/\*\*Are any active right now\?\*\* \[ \] yes  \[x\] no/);
  });

  it('flags both the Pcover+20% break AND the sub-$20 red-volume rule when applicable', () => {
    const inputs = makeInputs();
    const lastIdx = inputs.candles.length - 1;
    // Crash the last candle below $20 with high volume on a red day.
    inputs.candles[lastIdx] = {
      ...inputs.candles[lastIdx],
      open: 22,
      close: 18, // red day, sub-$20
    };
    inputs.volume[lastIdx] = {
      ...inputs.volume[lastIdx],
      value: 5_000_000, // way above the trailing avg of 1M
    };
    const out = generateSundayReview(inputs);
    expect(out).toContain('below Pcover+20%');
    expect(out).toContain('below $20.00 with elevated red volume');
  });
});

// ---------- helpers ----------

/**
 * Pull the substring between two header markers. Forgiving by design — if
 * the end marker isn't found, returns to end of string. Used to scope
 * "no checkbox should be checked" assertions to a specific section.
 */
function sliceSection(text: string, startMarker: string, endMarker: string): string {
  const startIdx = text.indexOf(startMarker);
  if (startIdx < 0) throw new Error(`Section start "${startMarker}" not found`);
  const endIdx = text.indexOf(endMarker, startIdx + startMarker.length);
  return endIdx < 0 ? text.slice(startIdx) : text.slice(startIdx, endIdx);
}
