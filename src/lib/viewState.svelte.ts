// Historical view (backtest) mode state.
//
// Phase B: lets the entire app pretend "today" is some past date. When
// `asOfDate` is set, the query/indicator layer truncates each ticker's
// series at that date and the UI reflects what the conviction model
// would have said on that day.
//
// Persistence: stored in localStorage so a backtest survives reloads —
// users may want to keep a historical view open across browser sessions
// while comparing notes against the canonical guide.
//
// Uses Svelte 5 runes — file must end in `.svelte.ts`.

const STORAGE_KEY = 'finmarkets-monitor:viewState';

/**
 * Reactive view state.
 *
 * `asOfDate` is `null` in live mode (latest data available) or an ISO
 * `yyyy-mm-dd` string in historical mode. Validation on writes (via
 * `setAsOfDate`) guarantees the format and that the date is not in the
 * future, so consumers can trust the shape and skip re-checking.
 */
export const viewState = $state<{
  asOfDate: string | null;
}>(loadFromStorage());

// ---------- validation helpers ----------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Today as a yyyy-mm-dd string in the local timezone. Local timezone is
 * the right choice because the user's mental model is "I want to see
 * what the dashboard looked like on the calendar day I picked," and the
 * `<input type="date">` returns a local-calendar value.
 */
function todayIso(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Validate the input. Returns true iff the string is a syntactically
 * valid yyyy-mm-dd that resolves to a real calendar day on or before
 * today (local timezone).
 */
function isValidAsOf(iso: string): boolean {
  if (!ISO_DATE_RE.test(iso)) return false;
  // Construct the date in UTC to avoid the off-by-one that local-tz
  // construction causes for negative-offset zones at midnight, then
  // compare against today's calendar string (also local). The relevant
  // comparison is calendar-day, not instant-in-time.
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return false;
  // Round-trip check to catch impossible dates like 2026-02-30 (which
  // JS happily normalizes to March 2 without complaint).
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return false;
  }
  return iso <= todayIso();
}

// ---------- public API ----------

/**
 * Set the as-of date for historical view, or pass `null` to return to
 * live mode. Invalid input (bad format, future date, malformed
 * calendar) is silently rejected — the UI's `<input type="date">`
 * already constrains the format, and we don't want a toast spam loop
 * if a stale localStorage value sneaks in.
 *
 * Returns `true` on success, `false` if the input was rejected. The
 * caller can use this to decide whether to flash an inline hint.
 */
export function setAsOfDate(iso: string | null): boolean {
  if (iso === null) {
    viewState.asOfDate = null;
    persist();
    return true;
  }
  if (typeof iso !== 'string' || !isValidAsOf(iso)) {
    return false;
  }
  viewState.asOfDate = iso;
  persist();
  return true;
}

/** True when the dashboard is in historical (as-of) mode. */
export function isHistorical(): boolean {
  return viewState.asOfDate !== null;
}

/**
 * Days between today (local) and the active asOfDate. Returns 0 when
 * not historical, or when asOfDate equals today. Used by the banner to
 * render the "(N days ago)" suffix without each component recomputing
 * the diff.
 */
export function daysAgo(): number {
  if (viewState.asOfDate === null) return 0;
  const today = todayIso();
  // Both strings are yyyy-mm-dd, so lexicographic ordering matches
  // chronological ordering. Diff via Date for accurate day count even
  // across DST boundaries.
  const [y1, m1, d1] = viewState.asOfDate.split('-').map(Number);
  const [y2, m2, d2] = today.split('-').map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

// ---------- persistence ----------

function persist(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ asOfDate: viewState.asOfDate }));
  } catch {
    /* quota or disabled storage — tolerable, view just won't survive reload */
  }
}

function loadFromStorage(): { asOfDate: string | null } {
  if (typeof localStorage === 'undefined') return { asOfDate: null };
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return { asOfDate: null };
  }
  if (!raw) return { asOfDate: null };
  try {
    const parsed = JSON.parse(raw) as { asOfDate?: unknown };
    const v = parsed?.asOfDate;
    if (typeof v === 'string' && isValidAsOf(v)) {
      return { asOfDate: v };
    }
    return { asOfDate: null };
  } catch {
    return { asOfDate: null };
  }
}
