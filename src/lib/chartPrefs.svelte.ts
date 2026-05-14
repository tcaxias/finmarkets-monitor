// Reactive chart UI preferences. Persisted to localStorage so a reload
// keeps the user's chosen timeframe and series visibility.
//
// Why a dedicated module: the chart toolbar, ChartPanel, RsiPanel,
// MacdPanel and the evaluation cache all need to react to the same set
// of toggles. Making this a single $state lets every consumer subscribe
// without a bespoke prop-drill or event bus.
//
// Storage shape is stable — we ignore unknown keys on read and merge
// over DEFAULTS so adding new toggles in the future never crashes an
// older persisted blob.
//
// Uses Svelte 5 runes — file must end in `.svelte.ts`.

export type Timeframe = '1D' | '1M' | '3M' | '6M' | 'YTD' | '1Y' | '2Y' | 'All';

export interface ChartPrefs {
  timeframe: Timeframe;
  showSma20: boolean;
  showSma50: boolean;
  showSma200: boolean;
  showVwap: boolean;
  showVolume: boolean;
  /** Pcover and Pcover+20% horizontal price lines (RSU exit framework). */
  showPcoverLines: boolean;
  /** Vest-date FMV horizontal price line (RSU basis reference). */
  showVestLine: boolean;
  showRsiPane: boolean;
  showMacdPane: boolean;
  /** Earnings event markers above the price bars. Default on. */
  showEarnings: boolean;
}

const DEFAULTS: ChartPrefs = {
  timeframe: '1Y',
  showSma20: true,
  showSma50: false,
  showSma200: true,
  // VWAP defaults off — it's an additional overlay alongside the SMAs,
  // not a core series. Users opt in if they care about
  // volume-weighted "fair value" reference.
  showVwap: false,
  showVolume: true,
  showPcoverLines: true,
  showVestLine: true,
  showRsiPane: true,
  showMacdPane: true,
  // Earnings markers default ON — they're high-signal annotations
  // (gap moves the day after earnings tend to set the next regime)
  // and small enough that they don't clutter the chart at any zoom.
  showEarnings: true,
};

const STORAGE_KEY = 'finmarkets-monitor:chartPrefs';

const VALID_TIMEFRAMES: ReadonlySet<Timeframe> = new Set([
  '1D',
  '1M',
  '3M',
  '6M',
  'YTD',
  '1Y',
  '2Y',
  'All',
]);

function loadFromStorage(): ChartPrefs {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULTS };
    const obj = parsed as Record<string, unknown>;
    const out: ChartPrefs = { ...DEFAULTS };
    // Only copy keys we recognise; this keeps the schema forward-
    // compatible and ignores garbage from older or hand-edited blobs.
    if (typeof obj.timeframe === 'string' && VALID_TIMEFRAMES.has(obj.timeframe as Timeframe)) {
      out.timeframe = obj.timeframe as Timeframe;
    }
    for (const key of [
      'showSma20',
      'showSma50',
      'showSma200',
      'showVwap',
      'showVolume',
      'showPcoverLines',
      'showVestLine',
      'showRsiPane',
      'showMacdPane',
      'showEarnings',
    ] as const) {
      if (typeof obj[key] === 'boolean') {
        out[key] = obj[key] as boolean;
      }
    }
    return out;
  } catch {
    // Corrupt JSON or storage access denied — fall back to defaults
    // rather than crashing the app boot.
    return { ...DEFAULTS };
  }
}

export const chartPrefs = $state<ChartPrefs>(loadFromStorage());

function persist(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chartPrefs));
  } catch {
    // Quota or privacy mode — silently drop. The next load will fall
    // back to defaults; that's an acceptable tradeoff for a personal
    // dashboard.
  }
}

export function setTimeframe(tf: Timeframe): void {
  if (!VALID_TIMEFRAMES.has(tf)) return;
  chartPrefs.timeframe = tf;
  persist();
}

export function toggle(key: keyof Omit<ChartPrefs, 'timeframe'>): void {
  chartPrefs[key] = !chartPrefs[key];
  persist();
}

export function resetPrefs(): void {
  Object.assign(chartPrefs, DEFAULTS);
  persist();
}

/**
 * Compute the `since` ISO date for the current timeframe, given a
 * reference date (typically today).
 *
 * Returns `null` for `'All'` (no filter) and `'1D'` (caller branches on
 * 1D before invoking this — 1D uses a separate intraday data source,
 * not a daily-table date filter).
 *
 * `'YTD'` returns Jan 1 of the reference year.
 *
 * All other windows return reference - N (calendar months/years).
 */
export function timeframeSince(tf: Timeframe, reference: Date): string | null {
  if (tf === 'All' || tf === '1D') return null;
  const r = new Date(reference.getTime());
  // Normalize to UTC midnight so the slice math is timezone-stable.
  const y = r.getUTCFullYear();
  const m = r.getUTCMonth();
  const d = r.getUTCDate();
  let since: Date;
  switch (tf) {
    case '1M':
      since = new Date(Date.UTC(y, m - 1, d));
      break;
    case '3M':
      since = new Date(Date.UTC(y, m - 3, d));
      break;
    case '6M':
      since = new Date(Date.UTC(y, m - 6, d));
      break;
    case 'YTD':
      since = new Date(Date.UTC(y, 0, 1));
      break;
    case '1Y':
      since = new Date(Date.UTC(y - 1, m, d));
      break;
    case '2Y':
      since = new Date(Date.UTC(y - 2, m, d));
      break;
    default:
      return null;
  }
  return since.toISOString().slice(0, 10);
}

// Internal export for tests — lets us assert the defaults shape without
// hardcoding a duplicate copy in the spec file.
export const __DEFAULTS_FOR_TEST = DEFAULTS;
export const __STORAGE_KEY_FOR_TEST = STORAGE_KEY;
