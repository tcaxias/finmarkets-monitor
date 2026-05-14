<script lang="ts">
  // Fixed-position toast stack at top-right of the viewport.
  //
  // Listens to `toastsState.items` (Svelte 5 rune state from the
  // notifications module) and renders one card per active toast.
  // Each toast has a dismiss button; auto-dismissal is handled inside
  // `addToast` via setTimeout, so we just watch the state here.
  //
  // Tone styling: 'alert' is the loud red used for fire events;
  // 'warn' is amber, 'success' green, 'info' neutral. Matches the
  // existing palette of the historical-banner and other status pills
  // throughout the app.

  import { toastsState, dismissToast, type ToastTone } from '../lib/notifications.svelte';

  // Tone → CSS-friendly class fragment. Plain string lookup so the
  // template stays clean and the CSS rules are explicit per tone.
  const toneClass: Record<ToastTone, string> = {
    info: 'tone-info',
    success: 'tone-success',
    warn: 'tone-warn',
    alert: 'tone-alert',
  };
</script>

{#if toastsState.items.length > 0}
  <div class="toast-stack" role="region" aria-label="Notifications" aria-live="polite">
    {#each toastsState.items as toast (toast.id)}
      <div class="toast {toneClass[toast.tone]}" role="status">
        <div class="toast-body">
          <div class="toast-title">{toast.title}</div>
          <div class="toast-message">{toast.body}</div>
        </div>
        <button
          type="button"
          class="toast-close"
          aria-label="Dismiss notification"
          onclick={() => dismissToast(toast.id)}
        >
          ✕
        </button>
      </div>
    {/each}
  </div>
{/if}

<style>
  /* Fixed top-right; high z-index so it floats over the sticky
     navigation, the historical banner, panels — everything. The 80px
     top offset clears both the page-nav (top:0, ~42px) and the
     historical-banner (top:42px, ~38px) when in historical mode.
     In live mode the offset is harmless (just a bit more whitespace
     from the page top). */
  .toast-stack {
    position: fixed;
    top: 80px;
    right: 16px;
    z-index: 100;
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 360px;
    width: calc(100% - 32px); /* mobile: shrink to fit */
    pointer-events: none; /* let clicks pass through gaps to the page */
  }

  .toast {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-left-width: 4px;
    border-radius: var(--radius-sm);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
    color: var(--text);
    font-size: 13px;
    line-height: 1.45;
    pointer-events: auto; /* re-enable on the toast itself */
    /* Slide-in animation — small, non-distracting. */
    animation: toast-in 180ms ease-out;
  }

  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateX(20px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  .toast-body {
    flex: 1;
    min-width: 0;
  }

  .toast-title {
    font-weight: 600;
    margin-bottom: 2px;
    color: var(--text);
  }

  .toast-message {
    color: var(--text-secondary);
    word-wrap: break-word;
  }

  .toast-close {
    background: transparent;
    border: none;
    color: var(--muted);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 3px;
    transition:
      background 0.12s ease,
      color 0.12s ease;
  }

  .toast-close:hover,
  .toast-close:focus-visible {
    color: var(--text);
    background: var(--surface-inset);
  }

  /* Tone palette — left border + subtle background tint matches the
     conventional "status pill" pattern used elsewhere in the app. */
  .tone-alert {
    border-left-color: #ef4444;
    background: rgba(239, 68, 68, 0.08);
  }

  .tone-warn {
    border-left-color: #f59e0b;
    background: rgba(245, 158, 11, 0.08);
  }

  .tone-success {
    border-left-color: #22c55e;
    background: rgba(34, 197, 94, 0.08);
  }

  .tone-info {
    border-left-color: #3b82f6;
    background: rgba(59, 130, 246, 0.08);
  }
</style>
