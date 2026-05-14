// Pure-function tests for the Screener SQL builders.
//
// We don't run the queries here — vitest doesn't load DuckDB-WASM
// (no worker, no OPFS), and the materialised indicator tables only
// have data after a real fetch. Instead we lock down the structural
// invariants of each screen's generated SQL: the right comparison,
// the right table joins, safe handling of empty inputs, and correct
// numeric interpolation for the Pcover screen.
//
// Live SQL behaviour is integration-tested by clicking the screen in
// the running app; this suite catches regressions in the
// ScreenDefinition shape and the interpolation logic.
import { describe, it, expect } from 'vitest';
import { SCREENS, getScreenById } from './screener';
import type { Position } from './settings.svelte';
import { computeThresholds } from './math';

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

describe('SCREENS catalog', () => {
  it('exports six predefined screens', () => {
    expect(SCREENS).toHaveLength(6);
  });

  it('every screen has a unique id', () => {
    const ids = SCREENS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every screen has label, description, category, and at least one column', () => {
    for (const s of SCREENS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(10);
      expect(['momentum', 'trend', 'risk']).toContain(s.category);
      expect(s.columns.length).toBeGreaterThan(0);
    }
  });

  it('every screen.buildSql produces non-empty SQL for a typical input', () => {
    const positions = [pos({ ticker: 'AAPL' }), pos({ id: 'p2', ticker: 'MSFT' })];
    for (const s of SCREENS) {
      const sql = s.buildSql(positions);
      expect(sql.trim().length).toBeGreaterThan(0);
    }
  });

  it('every screen.buildSql tolerates an empty positions array', () => {
    for (const s of SCREENS) {
      // Must not throw. The Pcover screen returns the WHERE FALSE
      // no-op; the others emit `IN ('')` which matches no real ticker.
      expect(() => s.buildSql([])).not.toThrow();
      const sql = s.buildSql([]);
      expect(sql.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('getScreenById', () => {
  it('returns the screen for a known id', () => {
    expect(getScreenById('overbought')?.id).toBe('overbought');
  });

  it('returns undefined for an unknown id', () => {
    expect(getScreenById('does-not-exist')).toBeUndefined();
  });
});

describe('overbought screen SQL', () => {
  const screen = getScreenById('overbought')!;

  it('filters on RSI > 70', () => {
    const sql = screen.buildSql([pos()]);
    expect(sql).toContain('r.value > 70');
  });

  it('joins indicators_rsi at period = 14', () => {
    const sql = screen.buildSql([pos()]);
    expect(sql).toContain('indicators_rsi');
    expect(sql).toContain('r.period = 14');
  });

  it('interpolates the position ticker into the IN list', () => {
    const sql = screen.buildSql([pos({ ticker: 'NVDA' })]);
    expect(sql).toContain("'NVDA'");
  });
});

describe('oversold screen SQL', () => {
  const screen = getScreenById('oversold')!;

  it('filters on RSI < 30', () => {
    const sql = screen.buildSql([pos()]);
    expect(sql).toContain('r.value < 30');
  });

  it('orders ascending so the most-oversold sits at the top', () => {
    const sql = screen.buildSql([pos()]);
    expect(sql).toMatch(/ORDER BY\s+r\.value ASC/);
  });
});

describe('below-sma20 screen SQL', () => {
  const screen = getScreenById('below-sma20')!;

  it('uses a 20-bar trailing window', () => {
    const sql = screen.buildSql([pos()]);
    // "ROWS BETWEEN 19 PRECEDING AND CURRENT ROW" yields a 20-bar window.
    expect(sql).toContain('19 PRECEDING');
  });

  it('filters where latest_close is below the SMA', () => {
    const sql = screen.buildSql([pos()]);
    expect(sql).toContain('s.latest_close < m.value');
  });
});

describe('above-sma200 screen SQL', () => {
  const screen = getScreenById('above-sma200')!;

  it('uses a 200-bar trailing window', () => {
    const sql = screen.buildSql([pos()]);
    expect(sql).toContain('199 PRECEDING');
  });

  it('requires the window to be fully populated (w >= 200)', () => {
    const sql = screen.buildSql([pos()]);
    // Without this guard, tickers with < 200 bars of history would
    // surface a partial-window "SMA" that's mathematically wrong.
    expect(sql).toContain('m.w >= 200');
  });

  it('filters where latest_close is above the SMA', () => {
    const sql = screen.buildSql([pos()]);
    expect(sql).toContain('s.latest_close > m.value');
  });
});

describe('macd-bull-cross screen SQL', () => {
  const screen = getScreenById('macd-bull-cross')!;

  it('looks at the last 5 days only (rn <= 5)', () => {
    const sql = screen.buildSql([pos()]);
    expect(sql).toContain('rm.rn <= 5');
  });

  it('detects sign flip: prev_hist < 0 AND histogram > 0', () => {
    const sql = screen.buildSql([pos()]);
    expect(sql).toContain('rm.prev_hist < 0');
    expect(sql).toContain('rm.histogram > 0');
  });

  it('pins the canonical MACD periods (12, 26, 9)', () => {
    const sql = screen.buildSql([pos()]);
    expect(sql).toContain('fast_period = 12');
    expect(sql).toContain('slow_period = 26');
    expect(sql).toContain('signal_period = 9');
  });
});

describe('near-pcover screen SQL', () => {
  const screen = getScreenById('near-pcover')!;

  it('returns the WHERE FALSE no-op when no positions have tax tracking', () => {
    // Either no positions at all, or only positions that lack tax
    // tracking — both should hit the empty-result short-circuit.
    expect(screen.buildSql([])).toContain('WHERE FALSE');
    expect(screen.buildSql([pos({ ticker: 'AAPL' })])).toContain('WHERE FALSE');
    // Partial config (vestPrice but no shares) → still no tracking.
    expect(
      screen.buildSql([pos({ ticker: 'AAPL', vestPrice: 100 })]),
    ).toContain('WHERE FALSE');
  });

  it('includes only positions with full tax tracking configured', () => {
    const tracked = pos({
      ticker: 'AAPL',
      vestPrice: 100,
      shares: 10,
      taxRate: 0.45,
    });
    const untracked = pos({ id: 'p2', ticker: 'MSFT' });
    const sql = screen.buildSql([tracked, untracked]);
    expect(sql).toContain("'AAPL'");
    expect(sql).not.toContain("'MSFT'");
  });

  it('emits the correct Pcover value for each tracked position', () => {
    const tracked = pos({
      ticker: 'AAPL',
      vestPrice: 100,
      shares: 10,
      taxRate: 0.4,
    });
    const sql = screen.buildSql([tracked]);
    const expectedPcover = computeThresholds(100, 10, 0.4).pcover; // 40
    expect(sql).toContain(`('AAPL', ${expectedPcover})`);
  });

  it('filters on the 20% headroom band above Pcover', () => {
    const tracked = pos({
      ticker: 'AAPL',
      vestPrice: 100,
      shares: 10,
      taxRate: 0.45,
    });
    const sql = screen.buildSql([tracked]);
    // Within-20%-above means: price > pcover AND price <= pcover * 1.20.
    expect(sql).toContain('s.latest_close > u.pcover');
    expect(sql).toContain('s.latest_close <= u.pcover * 1.20');
  });

  it('builds a multi-row VALUES clause for multiple tracked positions', () => {
    const positions = [
      pos({ ticker: 'AAPL', vestPrice: 100, shares: 10, taxRate: 0.4 }),
      pos({ id: 'p2', ticker: 'MSFT', vestPrice: 50, shares: 20, taxRate: 0.5 }),
    ];
    const sql = positions.length ? SCREENS.find((s) => s.id === 'near-pcover')!.buildSql(positions) : '';
    expect(sql).toContain('VALUES');
    // Two tuples, comma-separated.
    expect(sql).toContain("('AAPL', 40)");
    expect(sql).toContain("('MSFT', 25)");
  });
});

describe('SQL ticker safety', () => {
  // Tickers are validated upstream as /^[A-Z0-9]{1,10}$/, but
  // quoteTicker still escapes single quotes as defence in depth.
  // We can't test the unsafe input at the public API level because
  // quoteTicker is not exported — but we can verify normal tickers
  // are wrapped in single quotes.
  it('wraps ticker in single quotes in IN list', () => {
    const screen = getScreenById('overbought')!;
    const sql = screen.buildSql([pos({ ticker: 'AAPL' })]);
    expect(sql).toContain("'AAPL'");
  });

  it('emits a non-matching IN list for empty positions (not a syntax error)', () => {
    const screen = getScreenById('overbought')!;
    const sql = screen.buildSql([]);
    // The empty-string sentinel — no valid uppercase ticker can equal it.
    expect(sql).toContain("IN ('')");
  });
});
