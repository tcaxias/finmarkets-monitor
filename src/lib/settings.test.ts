// Tests for the multi-position settings module.
//
// We exercise the pure helpers (`validatePosition`, `loadOrMigrate`,
// `genId`) directly. For the reactive store + mutation helpers
// (`addPosition`, `removePosition`, `updatePosition`, `setActive`) we use
// the live `settings` $state — Vitest lets us import from a `.svelte.ts`
// file and rune state works in the test runner because Svelte's compiler
// runs during the import via the Vite plugin.
//
// Note: tests share the same `settings` proxy across `it` blocks. We
// reset it in `beforeEach` to a known-empty state so test order doesn't
// matter. Per-test isolation matters more here than reset speed.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  settings,
  addPosition,
  removePosition,
  updatePosition,
  setActive,
  getActivePosition,
  getPositionByTicker,
  validatePosition,
  loadOrMigrate,
  genId,
  reset,
} from './settings.svelte';

// ---------- localStorage shim ----------
//
// Vitest's default jsdom-like environment is opt-in; we keep this test
// suite environment-light by providing a minimal in-memory localStorage
// before the module under test reads from it. (`loadOrMigrate` runs
// at module import time when called explicitly.)

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
  key(i: number): string | null {
    return Array.from(this.map.keys())[i] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
}

// vi.stubGlobal lets Vitest restore between tests if needed; for our
// purposes a single shared store is fine since we reset it ourselves.
const memStorage = new MemoryStorage();
vi.stubGlobal('localStorage', memStorage);

const STORAGE_KEY = 'finmarkets-monitor:settings';

beforeEach(() => {
  memStorage.clear();
  reset();
});

// ---------- genId ----------

describe('genId', () => {
  it('returns a non-empty short string', () => {
    const id = genId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(3);
    expect(id.length).toBeLessThan(40);
  });

  it('produces unique values across rapid calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(genId());
    expect(ids.size).toBe(100);
  });
});

// ---------- validatePosition ----------

describe('validatePosition', () => {
  function valid() {
    return {
      ticker: 'AAPL',
      vestPrice: 150,
      shares: 100,
      taxRate: 0.45,
      taxDueDate: '2026-12-31',
    };
  }

  it('accepts a clean position with no errors', () => {
    expect(validatePosition(valid())).toEqual([]);
  });

  it('accepts an empty taxDueDate (optional)', () => {
    expect(validatePosition({ ...valid(), taxDueDate: '' })).toEqual([]);
  });

  it('rejects ticker with spaces or special chars', () => {
    expect(validatePosition({ ...valid(), ticker: 'A B' })).toEqual([
      expect.objectContaining({ field: 'ticker' }),
    ]);
    expect(validatePosition({ ...valid(), ticker: 'BRK.B' })).toEqual([
      expect.objectContaining({ field: 'ticker' }),
    ]);
  });

  it('rejects empty ticker', () => {
    expect(validatePosition({ ...valid(), ticker: '' })).toEqual([
      expect.objectContaining({ field: 'ticker' }),
    ]);
  });

  it('rejects ticker longer than 10 chars', () => {
    expect(validatePosition({ ...valid(), ticker: 'ABCDEFGHIJK' })).toEqual([
      expect.objectContaining({ field: 'ticker' }),
    ]);
  });

  // vest/shares/taxRate are now OPTIONAL (zero = "not configured").
  // Generic equity monitoring needs only a ticker; the tax overhang
  // framework is for users who explicitly want it.
  it('accepts zero vest price (means "not tracking taxes")', () => {
    expect(validatePosition({ ...valid(), vestPrice: 0 })).toEqual([]);
  });

  it('rejects negative vest price', () => {
    expect(validatePosition({ ...valid(), vestPrice: -1 })).toEqual([
      expect.objectContaining({ field: 'vestPrice' }),
    ]);
  });

  it('accepts zero shares (means "not tracking taxes")', () => {
    expect(validatePosition({ ...valid(), shares: 0 })).toEqual([]);
  });

  it('rejects negative shares', () => {
    expect(validatePosition({ ...valid(), shares: -5 })).toEqual([
      expect.objectContaining({ field: 'shares' }),
    ]);
  });

  it('accepts tax rate of 0 or 1 (boundary inclusive)', () => {
    expect(validatePosition({ ...valid(), taxRate: 0 })).toEqual([]);
    expect(validatePosition({ ...valid(), taxRate: 1 })).toEqual([]);
  });

  it('rejects tax rate outside [0, 1]', () => {
    expect(validatePosition({ ...valid(), taxRate: -0.1 })).toEqual([
      expect.objectContaining({ field: 'taxRate' }),
    ]);
    expect(validatePosition({ ...valid(), taxRate: 1.1 })).toEqual([
      expect.objectContaining({ field: 'taxRate' }),
    ]);
  });

  it('accepts a ticker-only position with all tax fields zero/empty', () => {
    expect(
      validatePosition({
        ticker: 'AAPL',
        vestPrice: 0,
        shares: 0,
        taxRate: 0,
        taxDueDate: '',
      }),
    ).toEqual([]);
  });

  it('rejects an unparseable taxDueDate', () => {
    expect(validatePosition({ ...valid(), taxDueDate: 'not-a-date' })).toEqual([
      expect.objectContaining({ field: 'taxDueDate' }),
    ]);
  });

  // Strict UTC round-trip: catches dates that JS would silently normalize
  // (Feb 30 → Mar 2, month 13 → next year). Mirrors viewState's isValidAsOf.
  it('rejects taxDueDate with an impossible day (Feb 30)', () => {
    expect(validatePosition({ ...valid(), taxDueDate: '2026-02-30' })).toEqual([
      expect.objectContaining({ field: 'taxDueDate' }),
    ]);
  });

  it('rejects taxDueDate with an impossible month (month 13)', () => {
    expect(validatePosition({ ...valid(), taxDueDate: '2026-13-01' })).toEqual([
      expect.objectContaining({ field: 'taxDueDate' }),
    ]);
  });

  it('accepts a real calendar date for taxDueDate', () => {
    expect(validatePosition({ ...valid(), taxDueDate: '2026-04-15' })).toEqual([]);
  });

  it('returns multiple errors when multiple fields are bad', () => {
    const errs = validatePosition({
      ticker: '!!',
      vestPrice: -1,
      shares: -2,
      taxRate: 2,
      taxDueDate: 'bad',
    });
    expect(errs.length).toBe(5);
  });
});

// ---------- loadOrMigrate ----------

describe('loadOrMigrate', () => {
  it('returns empty defaults when localStorage is empty', () => {
    memStorage.clear();
    const s = loadOrMigrate();
    expect(s).toEqual({ apiKey: '', positions: [], activePositionId: null });
  });

  it('returns empty defaults when JSON is corrupt', () => {
    memStorage.setItem(STORAGE_KEY, '{not-json');
    const s = loadOrMigrate();
    expect(s.positions).toEqual([]);
    expect(s.apiKey).toBe('');
  });

  it('migrates the legacy single-ticker shape into positions[0]', () => {
    const legacy = {
      ticker: 'aapl',
      vestPrice: 50,
      shares: 100,
      taxRate: 0.45,
      apiKey: 'abc123',
      taxDueDate: '2026-10-10',
    };
    memStorage.setItem(STORAGE_KEY, JSON.stringify(legacy));
    const s = loadOrMigrate();
    expect(s.apiKey).toBe('abc123');
    expect(s.positions.length).toBe(1);
    expect(s.positions[0].ticker).toBe('AAPL');
    expect(s.positions[0].vestPrice).toBe(50);
    expect(s.positions[0].shares).toBe(100);
    expect(s.positions[0].taxRate).toBe(0.45);
    expect(s.positions[0].taxDueDate).toBe('2026-10-10');
    expect(s.activePositionId).toBe(s.positions[0].id);
  });

  it('migration is idempotent — second call sees the new shape and is a no-op', () => {
    const legacy = {
      ticker: 'AAPL',
      vestPrice: 150,
      shares: 50,
      taxRate: 0.4,
      apiKey: 'k',
      taxDueDate: '',
    };
    memStorage.setItem(STORAGE_KEY, JSON.stringify(legacy));
    const first = loadOrMigrate();
    // Second call should read the migrated value back unchanged.
    const second = loadOrMigrate();
    expect(second).toEqual(first);
    expect(second.positions[0].id).toBe(first.positions[0].id);
  });

  it('migration writes the new shape back to localStorage immediately', () => {
    memStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ticker: 'NVDA', vestPrice: 100, shares: 10, taxRate: 0.3, apiKey: '' }),
    );
    loadOrMigrate();
    const stored = JSON.parse(memStorage.getItem(STORAGE_KEY)!);
    expect(stored.positions).toBeInstanceOf(Array);
    expect(stored.positions[0].ticker).toBe('NVDA');
    expect(stored.ticker).toBeUndefined();
  });

  it('loads new-shape payloads as-is without re-migration', () => {
    const fresh = {
      apiKey: 'xyz',
      positions: [
        {
          id: 'abc12345',
          ticker: 'TSLA',
          vestPrice: 200,
          shares: 25,
          taxRate: 0.35,
          taxDueDate: '',
        },
      ],
      activePositionId: 'abc12345',
    };
    memStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
    const s = loadOrMigrate();
    expect(s).toEqual(fresh);
  });

  it('drops invalid positions from a corrupted new-shape payload', () => {
    memStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        apiKey: '',
        positions: [
          { id: 'a', ticker: 'OK', vestPrice: 1, shares: 1, taxRate: 0.4, taxDueDate: '' },
          { ticker: 'NO_ID' }, // missing required fields
        ],
        activePositionId: 'a',
      }),
    );
    const s = loadOrMigrate();
    expect(s.positions.length).toBe(1);
    expect(s.positions[0].ticker).toBe('OK');
  });

  // Defence-in-depth: a position with all the right keys but a ticker
  // that fails TICKER_RE (e.g. one that snuck in from a pre-strict
  // legacy payload, a manual localStorage edit, or a malicious browser
  // extension) must be filtered out at load time so it never reaches
  // sqlIndicators.assertSafeTicker (which would throw at runtime).
  it('drops new-shape positions with malformed tickers', () => {
    memStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        apiKey: '',
        positions: [
          { id: 'a', ticker: 'AAPL', vestPrice: 1, shares: 1, taxRate: 0.4, taxDueDate: '' },
          // 'ab.cd' has a dot — fails /^[A-Z0-9]{1,10}$/ for two reasons
          // (dot, lowercase). Either alone would also reject it.
          { id: 'b', ticker: 'ab.cd', vestPrice: 1, shares: 1, taxRate: 0.4, taxDueDate: '' },
          { id: 'c', ticker: 'TOO_LONG_TICKER_HERE', vestPrice: 1, shares: 1, taxRate: 0.4, taxDueDate: '' },
        ],
        activePositionId: 'a',
      }),
    );
    const s = loadOrMigrate();
    expect(s.positions.length).toBe(1);
    expect(s.positions[0].ticker).toBe('AAPL');
  });

  it('handles legacy payload with no ticker (only apiKey) — keeps key, no position', () => {
    memStorage.setItem(STORAGE_KEY, JSON.stringify({ apiKey: 'k', ticker: '' }));
    const s = loadOrMigrate();
    expect(s.apiKey).toBe('k');
    expect(s.positions.length).toBe(0);
    expect(s.activePositionId).toBe(null);
  });

  // Stale activePositionId guard: if the saved id doesn't reference a
  // surviving position (manual edit, deletion in another tab, dropped
  // by isValidPosition), fall back to positions[0]?.id ?? null so the
  // UI never sits in "no tab selected" limbo.
  it('normalizes activePositionId when it references a missing id (falls back to first)', () => {
    memStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        apiKey: '',
        positions: [
          { id: 'real-1', ticker: 'AAPL', vestPrice: 1, shares: 1, taxRate: 0.4, taxDueDate: '' },
          { id: 'real-2', ticker: 'NVDA', vestPrice: 1, shares: 1, taxRate: 0.4, taxDueDate: '' },
        ],
        activePositionId: 'ghost-id-that-does-not-exist',
      }),
    );
    const s = loadOrMigrate();
    expect(s.activePositionId).toBe('real-1');
  });

  it('normalizes activePositionId to null when positions are empty', () => {
    memStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        apiKey: '',
        positions: [],
        activePositionId: 'orphan',
      }),
    );
    const s = loadOrMigrate();
    expect(s.activePositionId).toBe(null);
  });
});

// ---------- mutation helpers ----------

describe('addPosition', () => {
  it('appends a new position with a generated id', () => {
    const before = settings.positions.length;
    const added = addPosition({
      ticker: 'AAPL',
      vestPrice: 150,
      shares: 10,
      taxRate: 0.4,
      taxDueDate: '',
    });
    expect(settings.positions.length).toBe(before + 1);
    expect(added.id).toBeTruthy();
    expect(settings.positions[before].id).toBe(added.id);
  });

  it('uppercases the ticker on insert', () => {
    const p = addPosition({
      ticker: 'aapl',
      vestPrice: 150,
      shares: 10,
      taxRate: 0.4,
      taxDueDate: '',
    });
    expect(p.ticker).toBe('AAPL');
  });

  it('promotes the first position to active automatically', () => {
    expect(settings.activePositionId).toBe(null);
    const p = addPosition({
      ticker: 'AAPL',
      vestPrice: 150,
      shares: 10,
      taxRate: 0.4,
      taxDueDate: '',
    });
    expect(settings.activePositionId).toBe(p.id);
  });

  it('does not override the active position when adding subsequent positions', () => {
    const a = addPosition({
      ticker: 'AAPL',
      vestPrice: 150,
      shares: 10,
      taxRate: 0.4,
      taxDueDate: '',
    });
    addPosition({
      ticker: 'TSLA',
      vestPrice: 200,
      shares: 5,
      taxRate: 0.4,
      taxDueDate: '',
    });
    expect(settings.activePositionId).toBe(a.id);
  });
});

describe('removePosition', () => {
  it('removes the position with the given id', () => {
    const a = addPosition({
      ticker: 'A',
      vestPrice: 1,
      shares: 1,
      taxRate: 0.4,
      taxDueDate: '',
    });
    const b = addPosition({
      ticker: 'B',
      vestPrice: 1,
      shares: 1,
      taxRate: 0.4,
      taxDueDate: '',
    });
    removePosition(a.id);
    expect(settings.positions.length).toBe(1);
    expect(settings.positions[0].id).toBe(b.id);
  });

  it('promotes the first remaining position to active when the active was removed', () => {
    const a = addPosition({
      ticker: 'A',
      vestPrice: 1,
      shares: 1,
      taxRate: 0.4,
      taxDueDate: '',
    });
    const b = addPosition({
      ticker: 'B',
      vestPrice: 1,
      shares: 1,
      taxRate: 0.4,
      taxDueDate: '',
    });
    expect(settings.activePositionId).toBe(a.id);
    removePosition(a.id);
    expect(settings.activePositionId).toBe(b.id);
  });

  it('sets active to null when the last position is removed', () => {
    const a = addPosition({
      ticker: 'A',
      vestPrice: 1,
      shares: 1,
      taxRate: 0.4,
      taxDueDate: '',
    });
    removePosition(a.id);
    expect(settings.activePositionId).toBe(null);
  });

  it('leaves active unchanged when removing a non-active position', () => {
    const a = addPosition({
      ticker: 'A',
      vestPrice: 1,
      shares: 1,
      taxRate: 0.4,
      taxDueDate: '',
    });
    const b = addPosition({
      ticker: 'B',
      vestPrice: 1,
      shares: 1,
      taxRate: 0.4,
      taxDueDate: '',
    });
    removePosition(b.id);
    expect(settings.activePositionId).toBe(a.id);
  });

  it('is a no-op on unknown id', () => {
    addPosition({
      ticker: 'A',
      vestPrice: 1,
      shares: 1,
      taxRate: 0.4,
      taxDueDate: '',
    });
    removePosition('nope');
    expect(settings.positions.length).toBe(1);
  });
});

describe('updatePosition', () => {
  it('patches the named fields and leaves others alone', () => {
    const p = addPosition({
      ticker: 'A',
      vestPrice: 10,
      shares: 5,
      taxRate: 0.4,
      taxDueDate: '',
    });
    updatePosition(p.id, { vestPrice: 20 });
    const found = settings.positions.find((x) => x.id === p.id)!;
    expect(found.vestPrice).toBe(20);
    expect(found.shares).toBe(5);
    expect(found.ticker).toBe('A');
  });

  it('uppercases ticker patches', () => {
    const p = addPosition({
      ticker: 'A',
      vestPrice: 10,
      shares: 5,
      taxRate: 0.4,
      taxDueDate: '',
    });
    updatePosition(p.id, { ticker: 'msft' });
    const found = settings.positions.find((x) => x.id === p.id)!;
    expect(found.ticker).toBe('MSFT');
  });

  it('is a no-op on unknown id', () => {
    addPosition({
      ticker: 'A',
      vestPrice: 10,
      shares: 5,
      taxRate: 0.4,
      taxDueDate: '',
    });
    expect(() => updatePosition('nope', { vestPrice: 99 })).not.toThrow();
  });
});

describe('setActive', () => {
  it('switches the active position to a known id', () => {
    const a = addPosition({
      ticker: 'A',
      vestPrice: 1,
      shares: 1,
      taxRate: 0.4,
      taxDueDate: '',
    });
    const b = addPosition({
      ticker: 'B',
      vestPrice: 1,
      shares: 1,
      taxRate: 0.4,
      taxDueDate: '',
    });
    setActive(b.id);
    expect(settings.activePositionId).toBe(b.id);
    setActive(a.id);
    expect(settings.activePositionId).toBe(a.id);
  });

  it('accepts null to switch to portfolio overview mode', () => {
    const a = addPosition({
      ticker: 'A',
      vestPrice: 1,
      shares: 1,
      taxRate: 0.4,
      taxDueDate: '',
    });
    expect(settings.activePositionId).toBe(a.id);
    setActive(null);
    expect(settings.activePositionId).toBe(null);
  });

  it('silently ignores unknown ids', () => {
    const a = addPosition({
      ticker: 'A',
      vestPrice: 1,
      shares: 1,
      taxRate: 0.4,
      taxDueDate: '',
    });
    setActive('nope');
    expect(settings.activePositionId).toBe(a.id);
  });
});

describe('getActivePosition / getPositionByTicker', () => {
  it('getActivePosition returns null when none is active', () => {
    expect(getActivePosition()).toBe(null);
  });

  it('getActivePosition returns the matching object when active', () => {
    const p = addPosition({
      ticker: 'AAPL',
      vestPrice: 150,
      shares: 10,
      taxRate: 0.4,
      taxDueDate: '',
    });
    expect(getActivePosition()?.id).toBe(p.id);
  });

  it('getPositionByTicker is case-insensitive', () => {
    addPosition({
      ticker: 'AAPL',
      vestPrice: 150,
      shares: 10,
      taxRate: 0.4,
      taxDueDate: '',
    });
    expect(getPositionByTicker('aapl')?.ticker).toBe('AAPL');
    expect(getPositionByTicker('  AAPL  ')?.ticker).toBe('AAPL');
    expect(getPositionByTicker('TSLA')).toBe(null);
  });
});

// ---------- localStorage persistence ----------

describe('persistence side effects', () => {
  it('addPosition persists to localStorage', () => {
    addPosition({
      ticker: 'AAPL',
      vestPrice: 150,
      shares: 10,
      taxRate: 0.4,
      taxDueDate: '',
    });
    const stored = JSON.parse(memStorage.getItem(STORAGE_KEY)!);
    expect(stored.positions[0].ticker).toBe('AAPL');
  });

  it('removePosition persists to localStorage', () => {
    const p = addPosition({
      ticker: 'AAPL',
      vestPrice: 150,
      shares: 10,
      taxRate: 0.4,
      taxDueDate: '',
    });
    removePosition(p.id);
    const stored = JSON.parse(memStorage.getItem(STORAGE_KEY)!);
    expect(stored.positions).toEqual([]);
  });
});
