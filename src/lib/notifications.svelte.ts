// Notification surfaces for the alerts feature.
//
// Two sinks:
//   1. In-app toast queue (always works; renders a fixed-position
//      stack at the top-right of the screen via ToastContainer).
//   2. Browser Notification API (OS-level; requires permission).
//
// Permission strategy:
//   The Notification API permission prompt MUST be triggered by user
//   interaction. Chrome / Firefox / Safari all gate `Notification.
//   requestPermission()` behind a "user gesture" check; calling it on
//   page load gets blocked + auto-denied + flagged as a UX antipattern
//   in the browser console. So we expose a `requestNotificationPermission()`
//   function that the AlertsPanel calls from a click handler.
//
// Graceful degradation:
//   The Notification API doesn't exist in some environments (older
//   Safari, headless Chrome in some configs, server-side render). All
//   the wrapper functions return safe no-op values when the API isn't
//   present. Toasts continue to work regardless — they're just DOM,
//   no platform API needed.
//
// Uses Svelte 5 runes — file must end in `.svelte.ts`.

// ---------- toast types + state ----------

export type ToastTone = 'info' | 'success' | 'warn' | 'alert';

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  body: string;
  createdAt: Date;
  /** Time-to-live in milliseconds. 0 = persistent until user dismisses. */
  ttlMs: number;
}

/** Default TTL for an alert-fired toast — 30s. Long enough that the
 *  user is likely to see it even mid-task, short enough that it doesn't
 *  pile up indefinitely. The user can also click the X to dismiss
 *  early. Persistent (`ttlMs: 0`) is reserved for things the user
 *  MUST acknowledge. */
const DEFAULT_TOAST_TTL_MS = 30_000;

/** Reactive store of active toasts. Components read this directly
 *  (ToastContainer iterates `toastsState.items`). The shape is
 *  intentionally minimal — no need for derived signals here, the
 *  list itself is the source of truth. */
export const toastsState = $state<{ items: Toast[] }>({ items: [] });

/** Generate a short, collision-resistant id for a toast. Same pattern
 *  as alerts.ts and settings.svelte.ts — short UUID slice with a
 *  string-fallback for environments without crypto.randomUUID. */
function toastId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().slice(0, 8);
  }
  return Date.now().toString(36) + Math.floor(Math.random() * 0xffff).toString(36);
}

// Track active timeouts so we can clean them up if a toast is
// dismissed early — without this, calling `dismissToast` and then
// the timer would error trying to remove an already-gone item from
// the queue (cosmetic only — the splice is a no-op — but cleaner
// to clear).
const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Add a toast to the queue. Returns the generated id (useful for
 * programmatic dismissal). Auto-dismisses after `ttlMs` (default 30s);
 * pass `ttlMs: 0` for a persistent toast that requires manual
 * dismissal.
 */
export function addToast(input: Omit<Toast, 'id' | 'createdAt'>): string {
  const id = toastId();
  const toast: Toast = {
    id,
    tone: input.tone,
    title: input.title,
    body: input.body,
    createdAt: new Date(),
    ttlMs: input.ttlMs,
  };
  toastsState.items.push(toast);

  // Schedule the auto-dismiss only if ttl is positive. ttlMs=0 →
  // persistent until manual dismissal.
  if (toast.ttlMs > 0) {
    const timer = setTimeout(() => {
      dismissToast(id);
    }, toast.ttlMs);
    activeTimers.set(id, timer);
  }

  return id;
}

/** Remove a toast from the queue. Idempotent — calling with an
 *  unknown id is a no-op (the toast may have already been
 *  auto-dismissed). */
export function dismissToast(id: string): void {
  const idx = toastsState.items.findIndex((t) => t.id === id);
  if (idx >= 0) {
    toastsState.items.splice(idx, 1);
  }
  const timer = activeTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    activeTimers.delete(id);
  }
}

// (clearToasts not currently surfaced — the toast queue self-prunes
// via setTimeout-driven dismissal. If/when a "Clear all" affordance
// lands in the UI, restore the export and clean both `toastsState.items`
// and `activeTimers` here.)

// ---------- browser Notification API ----------

export type NotificationPermissionStatus =
  | 'granted'
  | 'denied'
  | 'default'
  | 'unsupported';

/** True iff the browser exposes a working Notification constructor. */
function notificationsSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.Notification !== 'undefined' &&
    // Some Safari / WebView environments expose `Notification` as a
    // value but the `requestPermission` static is missing. Guard
    // against that since we can't usefully request anything in that
    // configuration.
    typeof window.Notification.requestPermission === 'function'
  );
}

/**
 * Read the current permission status. Returns 'unsupported' when the
 * Notification API isn't available in this environment. Components
 * should treat 'denied' and 'unsupported' identically for UI purposes
 * (no point offering a "request permission" button in either case).
 */
export function getNotificationPermission(): NotificationPermissionStatus {
  if (!notificationsSupported()) return 'unsupported';
  // `Notification.permission` is a string union: 'granted' | 'denied'
  // | 'default'. The cast is safe — we just type-narrowed via the
  // notificationsSupported guard.
  return window.Notification.permission as NotificationPermissionStatus;
}

/**
 * Request notification permission from the user. MUST be called from
 * a user gesture handler (button onclick) — browsers reject calls made
 * from page load / setTimeout / fetch resolution.
 *
 * Returns the new permission state. Safe to call when already granted
 * (returns immediately with 'granted' — the spec spec is idempotent).
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionStatus> {
  if (!notificationsSupported()) return 'unsupported';
  try {
    const result = await window.Notification.requestPermission();
    return result as NotificationPermissionStatus;
  } catch (err) {
    // Older Safari throws on requestPermission instead of returning
    // a rejected promise. Treat as denied.
    console.warn('notifications: requestPermission threw', err);
    return 'denied';
  }
}

/**
 * Fire an OS-level browser notification. Returns true if shown,
 * false if blocked (no permission, unsupported, or constructor
 * threw).
 *
 * Best-effort — never throws. The caller should ALSO add a toast
 * via `addToast` so the user gets the alert even when the browser
 * notification is blocked.
 */
export function fireBrowserNotification(
  title: string,
  body: string,
  opts: NotificationOptions = {},
): boolean {
  if (!notificationsSupported()) return false;
  if (window.Notification.permission !== 'granted') return false;
  try {
    // The Notification constructor itself is what surfaces the OS
    // notification — no `.show()` method needed. We don't keep a
    // reference because we don't currently use the `onclick`,
    // `onshow`, or `onerror` events. If we wanted "click the
    // notification to focus the tab", we'd hold a reference and wire
    // its `onclick` to `window.focus()`.
    new window.Notification(title, { body, ...opts });
    return true;
  } catch (err) {
    console.warn('notifications: fireBrowserNotification threw', err);
    return false;
  }
}
