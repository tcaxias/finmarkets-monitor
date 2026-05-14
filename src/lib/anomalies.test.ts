// Pure-function tests for the Anomaly Detection SQL builders.
//
// Same harness model as screener.test.ts: vitest doesn't load
// DuckDB-WASM (no worker, no OPFS), so we lock down the structural
// invariants of each detector's generated SQL — the right window
// function, the right threshold predicate, safe handling of empty
// inputs, correct ticker quoting. Live SQL behaviour is integration-
// tested by clicking the detector in the running app.
import { describe, it, expect } from 'vitest';
import { ANOMALIES, getAnomalyById } from './anomalies';
import type { Position } from './settings.svelte';

function pos(overrides: Partial<Position> = {}): Position {
  return {
    id: 'p1',
    ticker: 'AAPL',
    vestPrice: 0,
    shares: 0,
    taxRate: 0,
    taxDueDate: '',
    ...overrides,
  };
}

describe('ANOMALIES catalog', () => {
  it('exports three predefined detectors', () => {
    expect(ANOMALIES).toHaveLength(3);
  });

  it('every detector has a unique id', () => {
    const ids = ANOMALIES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every detector has label, description, category, buildSql, and at least one column', () => {
    for (const a of ANOMALIES) {
      expect(a.id.length).toBeGreaterThan(0);
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.description.length).toBeGreaterThan(10);
      expect(['volume', 'price', 'regime']).toContain(a.category);
      expect(typeof a.buildSql).toBe('function');
      expect(a.columns.length).toBeGreaterThan(0);
    }
  });

  it('every detector covers exactly one of the three categories', () => {
    // Sanity check that the brief was honoured: one volume, one price,
    // one regime detector — not two volume and zero regime.
    const cats = new Set(ANOMALIES.map((a) => a.category));
    expect(cats.has('volume')).toBe(true);
    expect(cats.has('price')).toBe(true);
    expect(cats.has('regime')).toBe(true);
  });

  it('every detector.buildSql tolerates an empty positions array', () => {
    for (const a of ANOMALIES) {
      // Must not throw; must emit syntactically valid SQL whose IN
      // list matches no real ticker (the empty-string sentinel).
      expect(() => a.buildSql([])).not.toThrow();
      const sql = a.buildSql([]);
      expect(sql.trim().length).toBeGreaterThan(0);
      expect(sql).toContain("IN ('')");
    }
  });
});

describe('getAnomalyById', () => {
  it('returns the detector for a known id', () => {
    expect(getAnomalyById('volume-zscore-3')?.id).toBe('volume-zscore-3');
    expect(getAnomalyById('price-gaps')?.id).toBe('price-gaps');
    expect(getAnomalyById('regime-shifts')?.id).toBe('regime-shifts');
  });

  it('returns undefined for an unknown id', () => {
    expect(getAnomalyById('does-not-exist')).toBeUndefined();
  });
});

describe('volume-zscore-3 SQL', () => {
  const detector = getAnomalyById('volume-zscore-3')!;

  it('quotes a single ticker into the IN list', () => {
    const sql = detector.buildSql([pos({ ticker: 'NVDA' })]);
    expect(sql).toContain("'NVDA'");
  });

  it('comma-separates multiple tickers in the IN list', () => {
    const sql = detector.buildSql([
      pos({ ticker: 'AAPL' }),
      pos({ id: 'p2', ticker: 'MSFT' }),
    ]);
    expect(sql).toContain("'AAPL'");
    expect(sql).toContain("'MSFT'");
    // The comma-joined form (quoteTicker output, comma-separated).
    expect(sql).toMatch(/'AAPL',\s*'MSFT'/);
  });

  it('uses STDDEV_SAMP and AVG over a 60-bar trailing window excluding the current bar', () => {
    const sql = detector.buildSql([pos()]);
    expect(sql).toContain('STDDEV_SAMP(volume)');
    expect(sql).toContain('AVG(volume)');
    // The PRECEDING window excludes the current bar so the stat
    // doesn't contaminate its own reference distribution.
    expect(sql).toContain('60 PRECEDING AND 1 PRECEDING');
  });

  it('filters on z-score >= 3.0 in the last 30 days', () => {
    const sql = detector.buildSql([pos()]);
    expect(sql).toContain('>= 3.0');
    expect(sql).toContain('rn <= 30');
  });

  it('guards against zero stddev (degenerate identical-volume window)', () => {
    const sql = detector.buildSql([pos()]);
    expect(sql).toContain('sd_vol > 0');
  });
});

describe('price-gaps SQL', () => {
  const detector = getAnomalyById('price-gaps')!;

  it('quotes a single ticker into the IN list', () => {
    const sql = detector.buildSql([pos({ ticker: 'TSLA' })]);
    expect(sql).toContain("'TSLA'");
  });

  it('uses LAG(close) to derive prev_close', () => {
    const sql = detector.buildSql([pos()]);
    expect(sql).toContain('LAG(close)');
  });

  it('filters on absolute gap >= 2% in the last 30 days', () => {
    const sql = detector.buildSql([pos()]);
    expect(sql).toContain('>= 2.0');
    expect(sql).toContain('rn <= 30');
    // Both directions covered by ABS().
    expect(sql).toContain('ABS(');
  });

  it('labels gap direction as gap-up or gap-down', () => {
    const sql = detector.buildSql([pos()]);
    expect(sql).toContain("'gap-up'");
    expect(sql).toContain("'gap-down'");
  });
});

describe('regime-shifts SQL', () => {
  const detector = getAnomalyById('regime-shifts')!;

  it('quotes a single ticker into the IN list', () => {
    const sql = detector.buildSql([pos({ ticker: 'GOOGL' })]);
    expect(sql).toContain("'GOOGL'");
  });

  it('computes 50-day and 200-day SMAs over their respective windows', () => {
    const sql = detector.buildSql([pos()]);
    expect(sql).toContain('49 PRECEDING AND CURRENT ROW');
    expect(sql).toContain('199 PRECEDING AND CURRENT ROW');
  });

  it('requires the 200-bar window to be fully populated (w200 >= 200)', () => {
    const sql = detector.buildSql([pos()]);
    // Without this guard, tickers with < 200 bars would surface a
    // partial-window "SMA200" that's mathematically wrong and would
    // fire bogus crossings.
    expect(sql).toContain('w200 >= 200');
  });

  it('detects sign-change crossings via LAG(sma50 - sma200)', () => {
    const sql = detector.buildSql([pos()]);
    expect(sql).toContain('LAG(sma50 - sma200)');
  });

  it('labels both regime events: golden-cross and death-cross', () => {
    const sql = detector.buildSql([pos()]);
    expect(sql).toContain("'golden-cross'");
    expect(sql).toContain("'death-cross'");
  });

  it('limits results to the last 90 trading days', () => {
    const sql = detector.buildSql([pos()]);
    expect(sql).toContain('rn <= 90');
  });
});

describe('SQL ticker safety (cross-detector)', () => {
  // Tickers are validated upstream as /^[A-Z0-9]{1,10}$/, but
  // quoteTicker still escapes single quotes as defence in depth.
  // We can't test the unsafe input at the public API level because
  // quoteTicker is not exported — we verify normal tickers wrap
  // correctly across every detector.
  it('every detector wraps tickers in single quotes in the IN list', () => {
    for (const a of ANOMALIES) {
      const sql = a.buildSql([pos({ ticker: 'AAPL' })]);
      expect(sql).toContain("'AAPL'");
    }
  });

  it('every detector emits a non-matching IN list for empty positions', () => {
    for (const a of ANOMALIES) {
      const sql = a.buildSql([]);
      // The empty-string sentinel — no valid uppercase ticker can equal it.
      expect(sql).toContain("IN ('')");
    }
  });
});
