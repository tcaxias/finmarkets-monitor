<script lang="ts">
  import { settings, save } from '../lib/settings.svelte';
  import { computeThresholds, daysUntil, formatUsd } from '../lib/math';

  let showApiKey = $state(false);

  const thresholds = $derived(
    computeThresholds(settings.vestPrice, settings.shares, settings.taxRate),
  );
  const daysLeft = $derived(daysUntil(settings.taxDueDate));

  // Settings are "configured" once the user has saved a vest price and
  // share count. We use that as the signal to default the panel to
  // collapsed — first-time users see the form open; returning users see
  // a one-line summary that they can click to edit.
  const configured = $derived(settings.vestPrice > 0 && settings.shares > 0);

  // `<details open>` is a static HTML attribute, but we want the panel to
  // start closed only once the user has configured the position. The
  // `defaultOpen` snapshot is captured once on mount so re-saving doesn't
  // collapse the panel mid-edit.
  let defaultOpen = $state(true);
  $effect(() => {
    // Capture the configured-ness on mount only.
    defaultOpen = !configured;
  });

  // Persist on every change.
  $effect(() => {
    // Touch each field so the effect re-runs when any of them change.
    settings.ticker;
    settings.vestPrice;
    settings.shares;
    settings.taxRate;
    settings.apiKey;
    settings.taxDueDate;
    save();
  });

  function fmtDays(n: number): string {
    if (!Number.isFinite(n)) return '—';
    if (n < 0) return `${Math.abs(n)} day${Math.abs(n) === 1 ? '' : 's'} overdue`;
    if (n === 0) return 'today';
    return `${n} day${n === 1 ? '' : 's'}`;
  }

  // One-line summary shown in the collapsed `<summary>` element.
  function summaryLine(): string {
    const t = settings.ticker || '—';
    const v = settings.vestPrice > 0 ? `$${settings.vestPrice.toFixed(2)} vest` : 'no vest';
    const s = settings.shares > 0 ? `${settings.shares} shares` : 'no shares';
    const tax = `${(settings.taxRate * 100).toFixed(0)}% tax`;
    return `${t}, ${v}, ${s}, ${tax} — click to edit`;
  }
</script>

<details class="settings" open={defaultOpen} id="settings">
  <summary class="settings-summary">
    <span class="summary-label">Settings:</span>
    <span class="summary-line">{summaryLine()}</span>
  </summary>

  <div class="settings-body">
    <fieldset>
      <legend>Position</legend>

      <label>
        <span>Ticker</span>
        <input type="text" bind:value={settings.ticker} placeholder="AAPL" autocomplete="off" />
      </label>

      <label>
        <span>Vest price (USD)</span>
        <input type="number" step="0.01" min="0" bind:value={settings.vestPrice} />
      </label>

      <label>
        <span>Shares</span>
        <input type="number" step="1" min="0" bind:value={settings.shares} />
      </label>

      <label>
        <span>Tax rate ({(settings.taxRate * 100).toFixed(1)}%)</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.005"
          bind:value={settings.taxRate}
        />
      </label>

      <label>
        <span>Tax due date</span>
        <input type="date" bind:value={settings.taxDueDate} />
      </label>
    </fieldset>

    <fieldset>
      <legend>Twelve Data API</legend>

      <label>
        <span>API key</span>
        <span class="api-key">
          <input
            type={showApiKey ? 'text' : 'password'}
            bind:value={settings.apiKey}
            autocomplete="off"
            spellcheck="false"
          />
          <button type="button" onclick={() => (showApiKey = !showApiKey)}>
            {showApiKey ? 'Hide' : 'Show'}
          </button>
        </span>
      </label>

      <p class="hint">
        Get a free Twelve Data API key at
        <a href="https://twelvedata.com/" target="_blank" rel="noopener noreferrer"
          >twelvedata.com</a
        >
        (800 req/day on free tier).
      </p>
    </fieldset>

    <fieldset>
      <legend>Computed</legend>
      <dl>
        <dt>Total tax</dt>
        <dd>{formatUsd(thresholds.tax)}</dd>

        <dt>Pcover</dt>
        <dd>{formatUsd(thresholds.pcover)}</dd>

        <dt>Pcover +20%</dt>
        <dd>{formatUsd(thresholds.pcoverPlus20)}</dd>

        <dt>Pbreakeven</dt>
        <dd>{formatUsd(thresholds.pbreakeven)}</dd>

        <dt>Days until tax due</dt>
        <dd>{fmtDays(daysLeft)}</dd>
      </dl>
    </fieldset>
  </div>
</details>

<style>
  .settings {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-secondary);
    font-size: 14px;
    text-align: left;
    overflow: hidden;
  }

  /* The <summary> element is the always-visible header. We restyle it to
     act like a panel heading with an inline one-liner. */
  .settings-summary {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 14px 20px;
    cursor: pointer;
    font-size: 14px;
    list-style: none;
    user-select: none;
  }

  .settings-summary::-webkit-details-marker {
    display: none;
  }

  /* Add a custom disclosure caret so users have a visual affordance. */
  .settings-summary::before {
    content: '▸';
    color: var(--muted);
    font-size: 11px;
    transition: transform 0.15s ease;
    display: inline-block;
  }

  .settings[open] > .settings-summary::before {
    transform: rotate(90deg);
  }

  .settings-summary:hover {
    background: rgba(255, 255, 255, 0.02);
  }

  .summary-label {
    color: var(--text);
    font-weight: 600;
    font-size: 16px;
  }

  .summary-line {
    color: var(--muted);
    font-size: 13px;
  }

  .settings-body {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 0 20px 20px;
    border-top: 1px solid var(--border);
    padding-top: 16px;
  }

  fieldset {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px 16px 16px;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  legend {
    padding: 0 6px;
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  label {
    display: grid;
    grid-template-columns: 160px 1fr;
    align-items: center;
    gap: 12px;
  }

  label > span:first-child {
    color: var(--muted);
  }

  input[type='text'],
  input[type='number'],
  input[type='password'],
  input[type='date'] {
    background: var(--surface-inset);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    color: var(--text);
    font-family: inherit;
    font-size: 14px;
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
  }

  input[type='range'] {
    width: 100%;
  }

  .api-key {
    display: flex;
    gap: 8px;
  }

  .api-key input {
    flex: 1;
  }

  button {
    background: var(--border);
    color: var(--text);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 6px 12px;
    cursor: pointer;
    font-size: 13px;
    transition: background 0.12s ease;
  }

  button:hover {
    background: var(--border-strong);
  }

  dl {
    display: grid;
    grid-template-columns: 160px 1fr;
    gap: 6px 12px;
    margin: 0;
  }

  dt {
    color: var(--muted);
  }

  dd {
    margin: 0;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .hint {
    grid-column: 1 / -1;
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--muted);
  }

  .hint a {
    color: var(--link);
  }
</style>
