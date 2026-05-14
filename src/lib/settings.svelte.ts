// Reactive settings store backed by localStorage.
//
// Phase A multi-ticker rewrite: settings now hold a list of `Position`s
// instead of a single ticker scalar. Existing single-ticker localStorage
// payloads are migrated forward to `positions[0]` on first load.
//
// Uses Svelte 5 runes — file must end in `.svelte.ts`.

const STORAGE_KEY = 'finmarkets-monitor:settings';

export interface Position {
  id: string;
  ticker: string; // uppercase, validated alnum 1-10 chars
  vestPrice: number;
  shares: number;
  taxRate: number;
  taxDueDate: string; // ISO YYYY-MM-DD or ''
}

export interface SettingsState {
  apiKey: string;
  positions: Position[];
  /** id of the position whose per-ticker views are shown; null = portfolio overview. */
  activePositionId: string | null;
}

const defaultsState: SettingsState = {
  apiKey: '',
  positions: [],
  activePositionId: null,
};

// ---------- id generation ----------

/**
 * Short, collision-resistant id. We don't need cryptographic strength —
 * positions are local to one browser profile and there are at most a
 * handful — so a base36 timestamp + small random suffix is plenty.
 *
 * `crypto.randomUUID()` is preferred when available (modern browsers,
 * secure contexts) since it eliminates clock-collision risk entirely.
 */
export function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    // First 8 chars of a UUID give us 32 bits of entropy — more than enough
    // for tens of positions per profile.
    return crypto.randomUUID().slice(0, 8);
  }
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(4, '0');
  return `${t}${r}`;
}

// ---------- validation regex (declared early so loadOrMigrate can use it) ----------

/** Ticker validation: 1-10 alphanumeric chars after trim+uppercase. */
const TICKER_RE = /^[A-Z0-9]{1,10}$/;

// ---------- migration / load ----------

interface LegacySettings {
  ticker?: string;
  vestPrice?: number;
  shares?: number;
  taxRate?: number;
  apiKey?: string;
  taxDueDate?: string;
}

/**
 * Load settings from localStorage, migrating the legacy single-ticker shape
 * to the new positions[] shape if needed. Idempotent — calling twice on a
 * migrated payload is a no-op.
 *
 * Migration rules:
 *   - has `positions` field        → already migrated, load as-is
 *   - has `ticker` field           → wrap as positions[0], save back
 *   - corrupt / missing / no shape → return empty defaults (no save)
 */
export function loadOrMigrate(): SettingsState {
  if (typeof localStorage === 'undefined') return cloneDefaults();
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return cloneDefaults();
  }
  if (!raw) return cloneDefaults();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return cloneDefaults();
  }
  if (!parsed || typeof parsed !== 'object') return cloneDefaults();

  // Already-new shape: trust the `positions` array marker.
  if (Array.isArray((parsed as { positions?: unknown }).positions)) {
    const next = parsed as Partial<SettingsState>;
    const positions = (next.positions ?? []).filter(isValidPosition);
    // Normalize activePositionId: must reference a position that actually
    // survived validation. Stale ids (manual localStorage edits, deleted
    // positions in another tab) get rewritten to the first remaining
    // position or null, so the UI never sits in "no tab selected" limbo.
    const rawActive =
      typeof next.activePositionId === 'string' ? next.activePositionId : null;
    const activePositionId =
      rawActive !== null && positions.some((p) => p.id === rawActive)
        ? rawActive
        : (positions[0]?.id ?? null);
    return {
      apiKey: typeof next.apiKey === 'string' ? next.apiKey : '',
      positions,
      activePositionId,
    };
  }

  // Legacy shape: presence of `ticker` is the marker. Migrate even if
  // ticker is empty so the user keeps their apiKey.
  if ('ticker' in (parsed as object) || 'apiKey' in (parsed as object)) {
    const legacy = parsed as LegacySettings;
    const ticker = (legacy.ticker ?? '').trim().toUpperCase();
    const positions: Position[] = [];
    // Only carry forward a position if there's a real, well-shaped
    // ticker. Empty would fail validation and just clutter the UI; a
    // malformed ticker (e.g. 'BRK.B' from a legacy payload that
    // pre-dated the strict regex) would later trip assertSafeTicker
    // in the SQL layer and break the indicator path silently.
    if (ticker && TICKER_RE.test(ticker)) {
      positions.push({
        id: genId(),
        ticker,
        vestPrice: numberOr(legacy.vestPrice, 0),
        shares: numberOr(legacy.shares, 0),
        taxRate: numberOr(legacy.taxRate, 0.45),
        taxDueDate: typeof legacy.taxDueDate === 'string' ? legacy.taxDueDate : '',
      });
    }
    const migrated: SettingsState = {
      apiKey: typeof legacy.apiKey === 'string' ? legacy.apiKey : '',
      positions,
      activePositionId: positions[0]?.id ?? null,
    };
    // Persist the migration immediately so the next load short-circuits
    // through the new-shape branch.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    } catch {
      /* ignore quota or disabled storage */
    }
    return migrated;
  }

  return cloneDefaults();
}

function cloneDefaults(): SettingsState {
  return { apiKey: '', positions: [], activePositionId: null };
}

function numberOr(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function isValidPosition(p: unknown): p is Position {
  if (!p || typeof p !== 'object') return false;
  const x = p as Record<string, unknown>;
  if (
    !(
      typeof x.id === 'string' &&
      typeof x.ticker === 'string' &&
      typeof x.vestPrice === 'number' &&
      typeof x.shares === 'number' &&
      typeof x.taxRate === 'number' &&
      typeof x.taxDueDate === 'string'
    )
  ) {
    return false;
  }
  // Ticker shape check — same TICKER_RE that validatePosition uses, but
  // applied here on the load path so a corrupted localStorage payload
  // (manual edit, dev tools, malicious extension) can't smuggle a
  // ticker like 'ab.cd' past us into the SQL layer where assertSafeTicker
  // would throw at runtime. Silent filter rather than throw — load
  // shouldn't fail catastrophically over one bad row.
  if (!TICKER_RE.test(x.ticker as string)) return false;
  return true;
}

// ---------- reactive store ----------

export const settings = $state<SettingsState>(loadOrMigrate());

export function save(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    // `$state` proxies serialize fine through JSON.stringify.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore quota or disabled storage */
  }
}

export function reset(): void {
  settings.apiKey = '';
  settings.positions = [];
  settings.activePositionId = null;
  save();
}

// ---------- validation ----------

// TICKER_RE declared above (used by isValidPosition during loadOrMigrate).

export interface ValidationError {
  field: 'ticker' | 'vestPrice' | 'shares' | 'taxRate' | 'taxDueDate';
  message: string;
}

/**
 * Validate a position's user-entered fields. Returns an array of errors;
 * empty array means valid. Callers should normalize ticker to uppercase
 * BEFORE calling — validation is strict about format.
 *
 * Only `ticker` is required. The vest/shares/tax fields are an OPTIONAL
 * tax-tracking layer for users monitoring an RSU-style position with a
 * known tax overhang; users who just want generic equity monitoring can
 * leave them at 0/'' and downstream UI gracefully hides the
 * Pcover/exit-framework features.
 *
 * Bounds checks still apply when a value IS provided:
 *   - vestPrice / shares: must be >= 0 if non-zero (no negatives)
 *   - taxRate: must be in [0, 1] if any value (zero = "not configured")
 *   - taxDueDate: if non-empty, must be a valid YYYY-MM-DD calendar date
 */
export function validatePosition(p: Omit<Position, 'id'>): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!TICKER_RE.test(p.ticker)) {
    errors.push({
      field: 'ticker',
      message: 'Ticker must be 1-10 alphanumeric characters (uppercase).',
    });
  }
  if (!Number.isFinite(p.vestPrice) || p.vestPrice < 0) {
    errors.push({
      field: 'vestPrice',
      message: 'Vest price must be 0 or greater (leave 0 if not tracking taxes).',
    });
  }
  if (!Number.isFinite(p.shares) || p.shares < 0) {
    errors.push({
      field: 'shares',
      message: 'Shares must be 0 or greater (leave 0 if not tracking taxes).',
    });
  }
  if (!Number.isFinite(p.taxRate) || p.taxRate < 0 || p.taxRate > 1) {
    errors.push({
      field: 'taxRate',
      message: 'Tax rate must be between 0 and 1 (inclusive).',
    });
  }
  if (p.taxDueDate) {
    if (!isValidIsoDate(p.taxDueDate)) {
      errors.push({
        field: 'taxDueDate',
        message: 'Tax due date must be a valid YYYY-MM-DD date.',
      });
    }
  }
  return errors;
}

/**
 * Whether a position has the optional tax-tracking layer configured.
 * Used by UI components to decide whether to show Pcover, distance, and
 * other RSU-specific framing — none of which makes sense without a
 * non-zero vest price + shares + tax rate.
 */
export function hasTaxTracking(p: Position): boolean {
  return p.vestPrice > 0 && p.shares > 0 && p.taxRate > 0;
}

/**
 * Strict ISO yyyy-mm-dd validation with calendar round-trip. Rejects
 * impossible dates that JS would otherwise normalize (e.g. Feb 30 → Mar 2).
 * Mirrors the pattern used by viewState.svelte.ts:isValidAsOf.
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(iso: string): boolean {
  if (!ISO_DATE_RE.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return false;
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

// ---------- mutation helpers ----------

/**
 * Append a new position. Generates the id; caller provides the rest.
 * No validation here — call `validatePosition` first if input came from
 * the user. Returns the inserted position (with its new id) so callers
 * can immediately mark it active or scroll to it.
 */
export function addPosition(input: Omit<Position, 'id'>): Position {
  const next: Position = {
    id: genId(),
    ticker: input.ticker.trim().toUpperCase(),
    vestPrice: input.vestPrice,
    shares: input.shares,
    taxRate: input.taxRate,
    taxDueDate: input.taxDueDate,
  };
  settings.positions.push(next);
  // If nothing was active before, promote the new one. Common case for
  // first-time users.
  if (settings.activePositionId === null) {
    settings.activePositionId = next.id;
  }
  save();
  return next;
}

/**
 * Remove the position with the given id. If it was the active one, the
 * first remaining position takes over (or null if none remain).
 */
export function removePosition(id: string): void {
  const idx = settings.positions.findIndex((p) => p.id === id);
  if (idx < 0) return;
  settings.positions.splice(idx, 1);
  if (settings.activePositionId === id) {
    settings.activePositionId = settings.positions[0]?.id ?? null;
  }
  save();
}

/**
 * Patch an existing position in place. Unknown fields are ignored. Ticker,
 * if provided, is normalized to uppercase.
 */
export function updatePosition(id: string, patch: Partial<Omit<Position, 'id'>>): void {
  const pos = settings.positions.find((p) => p.id === id);
  if (!pos) return;
  if (patch.ticker !== undefined) pos.ticker = patch.ticker.trim().toUpperCase();
  if (patch.vestPrice !== undefined) pos.vestPrice = patch.vestPrice;
  if (patch.shares !== undefined) pos.shares = patch.shares;
  if (patch.taxRate !== undefined) pos.taxRate = patch.taxRate;
  if (patch.taxDueDate !== undefined) pos.taxDueDate = patch.taxDueDate;
  save();
}

/**
 * Set the active position. `null` switches to portfolio overview mode.
 * Unknown ids are silently ignored — that keeps stale references (e.g.
 * after a delete in another tab) from breaking the UI.
 */
export function setActive(id: string | null): void {
  if (id === null) {
    settings.activePositionId = null;
    save();
    return;
  }
  const exists = settings.positions.some((p) => p.id === id);
  if (!exists) return;
  settings.activePositionId = id;
  save();
}

/** Convenience reader for the currently-active position, if any. */
export function getActivePosition(): Position | null {
  if (settings.activePositionId === null) return null;
  return settings.positions.find((p) => p.id === settings.activePositionId) ?? null;
}

/** Look up a position by ticker (case-insensitive). */
export function getPositionByTicker(ticker: string): Position | null {
  const t = ticker.trim().toUpperCase();
  return settings.positions.find((p) => p.ticker === t) ?? null;
}
