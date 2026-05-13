// Reactive settings store backed by localStorage.
// Uses Svelte 5 runes — file must end in `.svelte.ts`.

const STORAGE_KEY = 'finmarkets-monitor:settings';

export interface Settings {
  ticker: string;
  vestPrice: number;
  shares: number;
  taxRate: number;
  apiKey: string;
  taxDueDate: string; // ISO date (YYYY-MM-DD)
}

const defaults: Settings = {
  ticker: '',
  vestPrice: 0,
  shares: 0,
  taxRate: 0.45,
  apiKey: '',
  taxDueDate: '',
};

function load(): Settings {
  if (typeof localStorage === 'undefined') return { ...defaults };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults };
  } catch {
    return { ...defaults };
  }
}

export const settings = $state<Settings>(load());

export function save(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function reset(): void {
  Object.assign(settings, defaults);
  save();
}
