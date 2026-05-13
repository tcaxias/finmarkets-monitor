<script lang="ts">
  // Historical view (backtest) controls.
  //
  // Phase B: a thin horizontal strip rendered between the page nav and
  // the StatusBanner. Lets the user pick a past calendar day; the entire
  // app then re-evaluates as if today were that day.
  //
  // Two action buttons:
  //   - Apply → calls setAsOfDate(pendingDate). Triggers App.svelte's
  //     effect that recomputes every ticker.
  //   - Live  → clears the as-of date and returns to live mode.
  //
  // The pending date defaults to either the current as-of date (when
  // historical) or today (when live), so the picker is always primed
  // with a sensible starting point.

  import { viewState, setAsOfDate, daysAgo } from '../lib/viewState.svelte';

  // Local pending state — the input is uncontrolled until "Apply" is
  // clicked. Two-way binding wouldn't work anyway because viewState
  // shouldn't change just because the user opened the date picker.
  let pendingDate = $state<string>('');
  let rejected = $state(false);

  // Today's local-tz iso string, used both as the input's `max` (so the
  // calendar picker greys out future days) and the default value when
  // no historical view is set.
  function todayIso(): string {
    const d = new Date();
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    ].join('-');
  }

  const today = $derived(todayIso());

  // Initialize / re-sync the pending value whenever the as-of date
  // changes externally (e.g. another component cleared it). Without this
  // effect the input would keep showing a stale "applied" value after
  // someone clicked "Live".
  $effect(() => {
    pendingDate = viewState.asOfDate ?? today;
  });

  function onApply(): void {
    rejected = false;
    if (!pendingDate) return;
    const ok = setAsOfDate(pendingDate);
    if (!ok) {
      // Validation failed (future date or malformed). Flash the input
      // briefly via a CSS class hook; auto-clear after 2s.
      rejected = true;
      setTimeout(() => {
        rejected = false;
      }, 2000);
    }
  }

  function onLive(): void {
    rejected = false;
    setAsOfDate(null);
    pendingDate = today;
  }

  const isHistorical = $derived(viewState.asOfDate !== null);
  const ago = $derived(daysAgo());
</script>

<div class="historical-controls" aria-label="Historical view controls">
  <span class="label">As-of date:</span>

  <input
    type="date"
    bind:value={pendingDate}
    max={today}
    class="date-input"
    class:rejected
    aria-label="Pick the as-of date for historical view"
  />

  <button type="button" onclick={onApply} class="primary">Apply</button>
  <button type="button" onclick={onLive} class="ghost" disabled={!isHistorical}>
    Live
  </button>

  {#if isHistorical}
    <span class="badge" aria-live="polite">
      <span class="badge-arrow" aria-hidden="true">«</span>
      Historical view: {viewState.asOfDate}
      {#if ago > 0}
        <span class="badge-ago">({ago} day{ago === 1 ? '' : 's'} ago)</span>
      {/if}
    </span>
  {/if}
</div>

<style>
  .historical-controls {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--gap-sm);
    padding: 8px var(--gap-lg);
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    color: var(--text-secondary);
    font-size: 13px;
  }

  .label {
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-right: 4px;
  }

  .date-input {
    background: var(--surface-inset);
    color: var(--text);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 4px 8px;
    font-family: var(--mono);
    font-size: 12px;
    color-scheme: dark;
  }

  .date-input.rejected {
    border-color: var(--bear);
    background: var(--bear-soft);
  }

  button {
    border-radius: var(--radius-sm);
    padding: 5px 12px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    border: 1px solid transparent;
    transition: background 0.12s ease;
  }

  button.primary {
    background: var(--info);
    color: var(--text);
    border-color: #1d4ed8;
  }

  button.primary:hover:not(:disabled) {
    background: #1d4ed8;
  }

  button.ghost {
    background: var(--border);
    color: var(--text);
    border-color: var(--border-strong);
  }

  button.ghost:hover:not(:disabled) {
    background: var(--border-strong);
  }

  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    padding: 4px 10px;
    background: var(--warn-soft);
    border: 1px solid rgba(245, 158, 11, 0.4);
    border-radius: var(--radius-sm);
    color: #fde68a;
    font-size: 12px;
    font-family: var(--mono);
  }

  .badge-arrow {
    font-size: 14px;
    line-height: 1;
  }

  .badge-ago {
    color: #fcd34d;
    opacity: 0.85;
    margin-left: 2px;
  }
</style>
