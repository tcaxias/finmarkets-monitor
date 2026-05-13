<script lang="ts">
  import { settings, save } from '../lib/settings.svelte';
  import { computeThresholds, daysUntil, formatUsd } from '../lib/math';

  let showApiKey = $state(false);

  const thresholds = $derived(
    computeThresholds(settings.vestPrice, settings.shares, settings.taxRate),
  );
  const daysLeft = $derived(daysUntil(settings.taxDueDate));

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
</script>

<section class="settings">
  <h2>Settings</h2>

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
</section>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 20px;
    background: #1a1b22;
    border: 1px solid #2e303a;
    border-radius: 8px;
    color: #e5e7eb;
    font-size: 14px;
    text-align: left;
  }

  h2 {
    margin: 0;
    font-size: 18px;
    color: #f3f4f6;
  }

  fieldset {
    border: 1px solid #2e303a;
    border-radius: 6px;
    padding: 12px 16px 16px;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  legend {
    padding: 0 6px;
    color: #9ca3af;
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
    color: #9ca3af;
  }

  input[type='text'],
  input[type='number'],
  input[type='password'],
  input[type='date'] {
    background: #0f1015;
    border: 1px solid #2e303a;
    border-radius: 4px;
    padding: 6px 8px;
    color: #f3f4f6;
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
    background: #2e303a;
    color: #f3f4f6;
    border: 1px solid #3a3d4a;
    border-radius: 4px;
    padding: 6px 12px;
    cursor: pointer;
    font-size: 13px;
  }

  button:hover {
    background: #3a3d4a;
  }

  dl {
    display: grid;
    grid-template-columns: 160px 1fr;
    gap: 6px 12px;
    margin: 0;
  }

  dt {
    color: #9ca3af;
  }

  dd {
    margin: 0;
    color: #f3f4f6;
    font-variant-numeric: tabular-nums;
  }
</style>
