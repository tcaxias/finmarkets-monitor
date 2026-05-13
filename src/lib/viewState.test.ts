// Tests for the historical-view (asOfDate) state module.
//
// Mirrors the test style of settings.test.ts: stub localStorage in
// memory, exercise the pure helpers + the reactive proxy, reset
// between cases for isolation.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { viewState, setAsOfDate, isHistorical, daysAgo } from './viewState.svelte';

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

const memStorage = new MemoryStorage();
vi.stubGlobal('localStorage', memStorage);

const STORAGE_KEY = 'finmarkets-monitor:viewState';

beforeEach(() => {
  memStorage.clear();
  // Reset the live state so test order doesn't matter. We can't re-import
  // the module to get a fresh proxy, so mutate it directly.
  viewState.asOfDate = null;
});

// Compute today's local-tz iso for tests that need a "valid past date".
function todayIso(): string {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

// ---------- setAsOfDate ----------

describe('setAsOfDate', () => {
  it('clears the as-of date when called with null', () => {
    setAsOfDate('2026-01-15');
    expect(viewState.asOfDate).toBe('2026-01-15');
    const ok = setAsOfDate(null);
    expect(ok).toBe(true);
    expect(viewState.asOfDate).toBe(null);
  });

  it('accepts a valid past ISO date', () => {
    const past = isoDaysAgo(30);
    const ok = setAsOfDate(past);
    expect(ok).toBe(true);
    expect(viewState.asOfDate).toBe(past);
  });

  it('accepts today as a valid as-of date', () => {
    const today = todayIso();
    const ok = setAsOfDate(today);
    expect(ok).toBe(true);
    expect(viewState.asOfDate).toBe(today);
  });

  it('rejects a future date', () => {
    const future = isoDaysAgo(-30);
    const ok = setAsOfDate(future);
    expect(ok).toBe(false);
    expect(viewState.asOfDate).toBe(null);
  });

  it('rejects malformed ISO strings', () => {
    expect(setAsOfDate('not-a-date')).toBe(false);
    expect(setAsOfDate('2026/01/15')).toBe(false);
    expect(setAsOfDate('26-01-15')).toBe(false);
    expect(setAsOfDate('2026-1-1')).toBe(false);
    expect(setAsOfDate('')).toBe(false);
    expect(viewState.asOfDate).toBe(null);
  });

  it('rejects impossible calendar dates (e.g. Feb 30)', () => {
    expect(setAsOfDate('2026-02-30')).toBe(false);
    expect(setAsOfDate('2026-13-01')).toBe(false);
    expect(setAsOfDate('2026-00-15')).toBe(false);
    expect(viewState.asOfDate).toBe(null);
  });

  it('persists a successful set to localStorage', () => {
    const past = isoDaysAgo(7);
    setAsOfDate(past);
    const stored = JSON.parse(memStorage.getItem(STORAGE_KEY)!);
    expect(stored.asOfDate).toBe(past);
  });

  it('persists a clear (null) to localStorage', () => {
    setAsOfDate(isoDaysAgo(7));
    setAsOfDate(null);
    const stored = JSON.parse(memStorage.getItem(STORAGE_KEY)!);
    expect(stored.asOfDate).toBe(null);
  });

  it('does not persist a rejected value', () => {
    setAsOfDate('garbage');
    expect(memStorage.getItem(STORAGE_KEY)).toBe(null);
  });
});

// ---------- isHistorical ----------

describe('isHistorical', () => {
  it('returns false in live mode', () => {
    expect(isHistorical()).toBe(false);
  });

  it('returns true after setting a valid as-of date', () => {
    setAsOfDate(isoDaysAgo(14));
    expect(isHistorical()).toBe(true);
  });

  it('returns false again after clearing', () => {
    setAsOfDate(isoDaysAgo(14));
    setAsOfDate(null);
    expect(isHistorical()).toBe(false);
  });
});

// ---------- daysAgo ----------

describe('daysAgo', () => {
  it('returns 0 in live mode', () => {
    expect(daysAgo()).toBe(0);
  });

  it('returns 0 when as-of date is today', () => {
    setAsOfDate(todayIso());
    expect(daysAgo()).toBe(0);
  });

  it('returns the day delta for past dates', () => {
    setAsOfDate(isoDaysAgo(7));
    expect(daysAgo()).toBe(7);
    setAsOfDate(isoDaysAgo(30));
    expect(daysAgo()).toBe(30);
  });
});
