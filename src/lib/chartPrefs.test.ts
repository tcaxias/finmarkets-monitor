import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// chartPrefs uses module-level $state and reads localStorage at import
// time. We need to (a) install a localStorage shim before importing,
// and (b) re-import a fresh module per test so the persisted blob
// drives the initial state — otherwise a single prefs instance leaks
// across tests and we can't validate the load path.

interface MemStorage {
  store: Map<string, string>;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  clear(): void;
}

function installLocalStorage(initial?: Record<string, string>): MemStorage {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  const ls: MemStorage = {
    store,
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    setItem: (k, v) => {
      store.set(k, String(v));
    },
    removeItem: (k) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  };
  // Stamp it on globalThis where browser code looks for it. Intentionally
  // assigning to a not-strictly-typed global; any implementation that
  // hits localStorage will land here.
  (globalThis as unknown as { localStorage: MemStorage }).localStorage = ls;
  return ls;
}

function uninstallLocalStorage(): void {
  delete (globalThis as unknown as { localStorage?: MemStorage }).localStorage;
}

async function freshModule(): Promise<typeof import('./chartPrefs.svelte')> {
  // Vitest caches modules per worker — clear it so the load function
  // re-reads the freshly-installed localStorage on next import.
  vi.resetModules();
  return await import('./chartPrefs.svelte');
}

const STORAGE_KEY = 'finmarkets-monitor:chartPrefs';

describe('chartPrefs', () => {
  beforeEach(() => {
    installLocalStorage();
  });
  afterEach(() => {
    uninstallLocalStorage();
  });

  describe('defaults', () => {
    it('has the documented default shape on a fresh load', async () => {
      const mod = await freshModule();
      expect(mod.chartPrefs.timeframe).toBe('1Y');
      expect(mod.chartPrefs.showSma20).toBe(true);
      expect(mod.chartPrefs.showSma50).toBe(false);
      expect(mod.chartPrefs.showSma200).toBe(true);
      expect(mod.chartPrefs.showVolume).toBe(true);
      expect(mod.chartPrefs.showPcoverLines).toBe(true);
      expect(mod.chartPrefs.showVestLine).toBe(true);
      expect(mod.chartPrefs.showRsiPane).toBe(true);
      expect(mod.chartPrefs.showMacdPane).toBe(true);
    });
  });

  describe('persistence', () => {
    it('setTimeframe writes to localStorage under the documented key', async () => {
      const mod = await freshModule();
      mod.setTimeframe('3M');
      const raw = (globalThis as unknown as { localStorage: MemStorage }).localStorage.getItem(
        STORAGE_KEY,
      );
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!).timeframe).toBe('3M');
    });

    it('toggle flips the boolean and persists', async () => {
      const mod = await freshModule();
      const initial = mod.chartPrefs.showSma50;
      mod.toggle('showSma50');
      expect(mod.chartPrefs.showSma50).toBe(!initial);
      const raw = (globalThis as unknown as { localStorage: MemStorage }).localStorage.getItem(
        STORAGE_KEY,
      );
      expect(JSON.parse(raw!).showSma50).toBe(!initial);
    });

    it('rehydrates state from a previously-persisted blob', async () => {
      installLocalStorage({
        [STORAGE_KEY]: JSON.stringify({
          timeframe: '6M',
          showSma20: false,
          showSma50: true,
          showSma200: false,
          showVolume: false,
          showPcoverLines: false,
          showVestLine: false,
          showRsiPane: false,
          showMacdPane: false,
        }),
      });
      const mod = await freshModule();
      expect(mod.chartPrefs.timeframe).toBe('6M');
      expect(mod.chartPrefs.showSma20).toBe(false);
      expect(mod.chartPrefs.showSma50).toBe(true);
      expect(mod.chartPrefs.showSma200).toBe(false);
      expect(mod.chartPrefs.showVolume).toBe(false);
      expect(mod.chartPrefs.showPcoverLines).toBe(false);
      expect(mod.chartPrefs.showVestLine).toBe(false);
      expect(mod.chartPrefs.showRsiPane).toBe(false);
      expect(mod.chartPrefs.showMacdPane).toBe(false);
    });

    it('falls back to defaults when localStorage holds garbage JSON', async () => {
      installLocalStorage({ [STORAGE_KEY]: 'not-json{' });
      const mod = await freshModule();
      expect(mod.chartPrefs.timeframe).toBe('1Y');
      expect(mod.chartPrefs.showSma20).toBe(true);
    });

    it('falls back to defaults when localStorage holds a non-object', async () => {
      installLocalStorage({ [STORAGE_KEY]: JSON.stringify(42) });
      const mod = await freshModule();
      expect(mod.chartPrefs.timeframe).toBe('1Y');
    });

    it('ignores unknown keys in the persisted blob', async () => {
      installLocalStorage({
        [STORAGE_KEY]: JSON.stringify({
          timeframe: '3M',
          ohnoesUnknown: 42,
          showSma20: false,
        }),
      });
      const mod = await freshModule();
      expect(mod.chartPrefs.timeframe).toBe('3M');
      expect(mod.chartPrefs.showSma20).toBe(false);
      // Unknown key should not have leaked onto the prefs object.
      expect((mod.chartPrefs as unknown as Record<string, unknown>).ohnoesUnknown).toBeUndefined();
    });

    it('falls back to defaults when timeframe is invalid', async () => {
      installLocalStorage({
        [STORAGE_KEY]: JSON.stringify({ timeframe: 'bogus', showSma20: false }),
      });
      const mod = await freshModule();
      expect(mod.chartPrefs.timeframe).toBe('1Y');
      // But valid keys still load.
      expect(mod.chartPrefs.showSma20).toBe(false);
    });

    it('setTimeframe rejects an invalid timeframe (no-op)', async () => {
      const mod = await freshModule();
      const before = mod.chartPrefs.timeframe;
      mod.setTimeframe('does-not-exist' as unknown as 'YTD');
      expect(mod.chartPrefs.timeframe).toBe(before);
    });
  });

  describe('resetPrefs', () => {
    it('restores the default shape', async () => {
      const mod = await freshModule();
      mod.setTimeframe('3M');
      mod.toggle('showSma50');
      mod.toggle('showVolume');
      mod.resetPrefs();
      expect(mod.chartPrefs.timeframe).toBe('1Y');
      expect(mod.chartPrefs.showSma50).toBe(false);
      expect(mod.chartPrefs.showVolume).toBe(true);
    });
  });

  describe('timeframeSince', () => {
    // Anchor reference deliberately mid-month, mid-year so off-by-one
    // bugs in the date math surface obviously.
    const REF = new Date(Date.UTC(2025, 5, 15)); // 2025-06-15

    it('returns null for All', async () => {
      const mod = await freshModule();
      expect(mod.timeframeSince('All', REF)).toBeNull();
    });

    it('returns null for 1D (intraday-only signal)', async () => {
      const mod = await freshModule();
      expect(mod.timeframeSince('1D', REF)).toBeNull();
    });

    it('returns YTD = Jan 1 of reference year', async () => {
      const mod = await freshModule();
      expect(mod.timeframeSince('YTD', REF)).toBe('2025-01-01');
    });

    it('returns 1M = ref - 1 month', async () => {
      const mod = await freshModule();
      expect(mod.timeframeSince('1M', REF)).toBe('2025-05-15');
    });

    it('returns 3M = ref - 3 months', async () => {
      const mod = await freshModule();
      expect(mod.timeframeSince('3M', REF)).toBe('2025-03-15');
    });

    it('returns 6M = ref - 6 months', async () => {
      const mod = await freshModule();
      expect(mod.timeframeSince('6M', REF)).toBe('2024-12-15');
    });

    it('returns 1Y = ref - 1 year', async () => {
      const mod = await freshModule();
      expect(mod.timeframeSince('1Y', REF)).toBe('2024-06-15');
    });

    it('returns 2Y = ref - 2 years', async () => {
      const mod = await freshModule();
      expect(mod.timeframeSince('2Y', REF)).toBe('2023-06-15');
    });
  });
});
