<script lang="ts">
  // Per-ticker alerts management panel.
  //
  // Three sections:
  //   1. Active rules — table of all alerts for the active ticker
  //      with enable toggle, edit, delete affordances.
  //   2. Recent fires — last 10 fires for this ticker, with an
  //      acknowledge button per row + clear-acknowledged bulk action.
  //   3. Add-alert form — inline form to create a new rule (ticker
  //      locked to active position).
  //   4. Browser-notification permission status — small subsection
  //      with a "Request permission" button when not granted.
  //
  // Why per-ticker (not portfolio-wide): every alert IS per-ticker
  // (the schema requires `ticker NOT NULL`), so the natural surface
  // is the per-ticker view. The data layer's evaluator runs alerts
  // on every refresh regardless of which view the user is parked on.
  //
  // Refreshes happen on:
  //   - mount (load the rules + fires for this ticker)
  //   - any successful CRUD operation (re-list)
  //   - the active position changing (re-list for new ticker)
  //   - data state advancing (lastFetched watermark) — picks up new
  //     fires that happened during a refresh while the panel is open.

  import {
    listAlerts,
    listFires,
    createAlert,
    deleteAlert,
    setAlertEnabled,
    acknowledgeFire,
    clearAcknowledgedFires,
    type AlertRule,
    type AlertFire,
    type AlertMetric,
    type AlertOperator,
  } from '../lib/alerts';
  import { getActivePosition, settings } from '../lib/settings.svelte';
  import { dataState } from '../lib/data.svelte';
  import {
    getNotificationPermission,
    requestNotificationPermission,
    type NotificationPermissionStatus,
  } from '../lib/notifications.svelte';

  // Active position lookup — same pattern as the other per-ticker
  // panels. When no active position, we render a placeholder.
  const activePosition = $derived.by(() => {
    settings.activePositionId;
    settings.positions.length;
    return getActivePosition();
  });

  let allAlerts = $state<AlertRule[]>([]);
  let allFires = $state<AlertFire[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);

  // Per-active-ticker filtered slices. Derived rather than re-queried
  // because list operations are cheap and listing-all-then-filter keeps
  // the data layer simple.
  const tickerAlerts = $derived.by(() => {
    const t = activePosition?.ticker ?? '';
    return allAlerts.filter((a) => a.ticker === t);
  });
  const tickerFires = $derived.by(() => {
    const t = activePosition?.ticker ?? '';
    return allFires.filter((f) => f.ticker === t).slice(0, 10);
  });

  // Browser notification permission. Tracked as state so the
  // "Request permission" button can update the displayed status
  // immediately after the user responds to the OS prompt.
  let permission = $state<NotificationPermissionStatus>('default');

  // Add-alert form state. ticker is locked to active position; the
  // user can't change it (the form is contextual). Defaults pick the
  // most-common case (close + crosses_below) so first-time use is one
  // click + a number.
  let formOpen = $state(false);
  let formMetric = $state<AlertMetric>('close');
  let formOperator = $state<AlertOperator>('crosses_below');
  let formThreshold = $state<number>(0);
  let formThresholdHigh = $state<number | null>(null);
  let formLabel = $state('');
  let formError = $state<string | null>(null);

  // Whether the form's threshold-high input should be visible. Only
  // band ops use it.
  const isBandOp = $derived(
    formOperator === 'enters_band' || formOperator === 'exits_band',
  );

  // Refresh from DB. Best-effort — surfaces error to loadError but
  // never throws.
  async function refresh(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      const [a, f] = await Promise.all([listAlerts(), listFires({ limit: 50 })]);
      allAlerts = a;
      allFires = f;
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
      console.error('AlertsPanel: refresh failed', err);
    } finally {
      loading = false;
    }
  }

  // Initial load + permission status read.
  $effect(() => {
    permission = getNotificationPermission();
    void refresh();
  });

  // Re-refresh when the data watermark advances (a refresh just
  // landed → potentially new fires) or when the active position
  // changes (different ticker → different rule list to display).
  $effect(() => {
    void dataState.lastFetched;
    void activePosition?.ticker;
    void refresh();
  });

  async function onCreateAlert(): Promise<void> {
    if (!activePosition) return;
    formError = null;
    try {
      await createAlert({
        ticker: activePosition.ticker,
        metric: formMetric,
        operator: formOperator,
        threshold: formThreshold,
        thresholdBandHigh: isBandOp ? formThresholdHigh : null,
        enabled: true,
        label: formLabel.trim() || null,
      });
      // Reset form to sensible defaults; close.
      formMetric = 'close';
      formOperator = 'crosses_below';
      formThreshold = 0;
      formThresholdHigh = null;
      formLabel = '';
      formOpen = false;
      await refresh();
    } catch (err) {
      formError = err instanceof Error ? err.message : String(err);
    }
  }

  async function onToggleEnabled(rule: AlertRule): Promise<void> {
    try {
      await setAlertEnabled(rule.id, !rule.enabled);
      await refresh();
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
  }

  async function onDeleteAlert(rule: AlertRule): Promise<void> {
    // Confirm via native confirm() — keeps the panel free of a modal
    // component for what should be a rare destructive action.
    if (!confirm(`Delete alert "${rule.label ?? rule.id}"? This also clears its fire history.`)) {
      return;
    }
    try {
      await deleteAlert(rule.id);
      await refresh();
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
  }

  async function onAcknowledgeFire(fire: AlertFire): Promise<void> {
    try {
      await acknowledgeFire(fire.id);
      await refresh();
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
  }

  async function onClearAcknowledged(): Promise<void> {
    try {
      await clearAcknowledgedFires();
      await refresh();
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
  }

  async function onRequestPermission(): Promise<void> {
    permission = await requestNotificationPermission();
  }

  // Display helpers.
  const metricLabels: Record<AlertMetric, string> = {
    close: 'Close',
    rsi: 'RSI(14)',
    macd_hist: 'MACD histogram',
    distance_from_pcover_pct: 'Distance from Pcover (%)',
    drawdown_pct: 'Drawdown (%)',
  };

  const operatorLabels: Record<AlertOperator, string> = {
    crosses_above: 'crosses above',
    crosses_below: 'crosses below',
    enters_band: 'enters band',
    exits_band: 'exits band',
  };

  function fmtThreshold(rule: AlertRule): string {
    if (rule.operator === 'enters_band' || rule.operator === 'exits_band') {
      return `[${rule.threshold.toFixed(2)}, ${(rule.thresholdBandHigh ?? 0).toFixed(2)}]`;
    }
    return rule.threshold.toFixed(2);
  }

  function fmtFireDate(d: Date): string {
    // Short date+time for the fires log — enough info to scan, not so
    // much it crowds the row.
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
</script>

<section class="alerts-panel">
  <header class="panel-header">
    <div>
      <h2>Alerts</h2>
      <p class="hint">
        Edge-triggered alerts on the active ticker. Fire once per
        threshold-crossing event; both an in-app toast and a browser
        notification are emitted.
      </p>
    </div>
    {#if activePosition}
      <button
        type="button"
        class="add-button"
        onclick={() => {
          formOpen = !formOpen;
          formError = null;
        }}
      >
        {formOpen ? 'Cancel' : '+ Add alert'}
      </button>
    {/if}
  </header>

  {#if !activePosition}
    <div class="placeholder">Select a position to manage its alerts.</div>
  {:else}
    {#if loadError}
      <div class="banner error" role="alert">{loadError}</div>
    {/if}

    <!-- Browser notification permission status. The button is the
         user-gesture entrypoint — Chrome/Firefox/Safari all gate
         requestPermission() behind a user click. -->
    <div class="permission-row" data-status={permission}>
      <span class="permission-label">Browser notifications:</span>
      {#if permission === 'granted'}
        <span class="permission-status granted">granted ✓</span>
      {:else if permission === 'denied'}
        <span class="permission-status denied">denied (re-enable in browser settings)</span>
      {:else if permission === 'unsupported'}
        <span class="permission-status unsupported">unsupported in this browser</span>
      {:else}
        <span class="permission-status default">not granted</span>
        <button type="button" class="permission-button" onclick={onRequestPermission}>
          Request permission
        </button>
      {/if}
    </div>

    {#if formOpen}
      <form
        class="add-form"
        onsubmit={(e) => {
          e.preventDefault();
          void onCreateAlert();
        }}
      >
        <div class="field">
          <label for="alert-ticker-display">Ticker</label>
          <input
            id="alert-ticker-display"
            type="text"
            value={activePosition.ticker}
            disabled
            class="disabled"
          />
        </div>
        <div class="field">
          <label for="alert-metric">Metric</label>
          <select id="alert-metric" bind:value={formMetric}>
            {#each Object.entries(metricLabels) as [val, label] (val)}
              <option value={val}>{label}</option>
            {/each}
          </select>
        </div>
        <div class="field">
          <label for="alert-operator">Operator</label>
          <select id="alert-operator" bind:value={formOperator}>
            {#each Object.entries(operatorLabels) as [val, label] (val)}
              <option value={val}>{label}</option>
            {/each}
          </select>
        </div>
        <div class="field">
          <label for="alert-threshold">Threshold</label>
          <input
            id="alert-threshold"
            type="number"
            step="any"
            bind:value={formThreshold}
          />
        </div>
        {#if isBandOp}
          <div class="field">
            <label for="alert-threshold-high">Threshold high (band)</label>
            <input
              id="alert-threshold-high"
              type="number"
              step="any"
              bind:value={formThresholdHigh}
            />
          </div>
        {/if}
        <div class="field wide">
          <label for="alert-label">Label (optional)</label>
          <input
            id="alert-label"
            type="text"
            placeholder="e.g. 'Pcover risk'"
            bind:value={formLabel}
          />
        </div>
        {#if formError}
          <div class="banner error form-error" role="alert">{formError}</div>
        {/if}
        <div class="form-actions">
          <button type="submit" class="save-button">Save alert</button>
        </div>
      </form>
    {/if}

    <h3 class="section-title">Active rules</h3>
    {#if tickerAlerts.length === 0}
      <div class="placeholder small">
        No alerts for {activePosition.ticker}. Click "+ Add alert" to create one.
      </div>
    {:else}
      <div class="table-wrap">
        <table class="rules-table">
          <thead>
            <tr>
              <th>On</th>
              <th>Label</th>
              <th>Rule</th>
              <th class="num">Last value</th>
              <th>State</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each tickerAlerts as rule (rule.id)}
              <tr class:disabled={!rule.enabled}>
                <td>
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onchange={() => onToggleEnabled(rule)}
                    aria-label={rule.enabled ? 'Disable alert' : 'Enable alert'}
                  />
                </td>
                <td class="label-cell">{rule.label ?? '—'}</td>
                <td>
                  <span class="rule-text">
                    {metricLabels[rule.metric]} {operatorLabels[rule.operator]}
                    <strong>{fmtThreshold(rule)}</strong>
                  </span>
                </td>
                <td class="num mono">
                  {rule.lastEvaluatedValue !== null
                    ? rule.lastEvaluatedValue.toFixed(2)
                    : '—'}
                </td>
                <td class="state mono" data-state={rule.lastState ?? 'none'}>
                  {rule.lastState ?? '—'}
                </td>
                <td class="actions">
                  <button
                    type="button"
                    class="delete-button"
                    onclick={() => onDeleteAlert(rule)}
                    aria-label="Delete alert"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <div class="fires-section">
      <div class="fires-header">
        <h3 class="section-title">Recent fires</h3>
        {#if tickerFires.some((f) => f.acknowledged)}
          <button
            type="button"
            class="ack-clear-button"
            onclick={onClearAcknowledged}
          >
            Clear acknowledged
          </button>
        {/if}
      </div>
      {#if tickerFires.length === 0}
        <div class="placeholder small">No fires yet for {activePosition.ticker}.</div>
      {:else}
        <div class="table-wrap">
          <table class="fires-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Message</th>
                <th class="num">Observed</th>
                <th class="num">Threshold</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each tickerFires as fire (fire.id)}
                <tr class:acknowledged={fire.acknowledged}>
                  <td class="mono small">{fmtFireDate(fire.firedAt)}</td>
                  <td class="message-cell">{fire.message}</td>
                  <td class="num mono">{fire.observedValue.toFixed(2)}</td>
                  <td class="num mono">{fire.threshold.toFixed(2)}</td>
                  <td class="actions">
                    {#if !fire.acknowledged}
                      <button
                        type="button"
                        class="ack-button"
                        onclick={() => onAcknowledgeFire(fire)}
                      >
                        Ack
                      </button>
                    {:else}
                      <span class="ack-label">acked</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .alerts-panel {
    display: flex;
    flex-direction: column;
    gap: var(--gap);
    padding: var(--gap-lg);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--gap-lg);
    flex-wrap: wrap;
  }

  h2 {
    margin: 0 0 4px 0;
    font-size: 16px;
    color: var(--text);
  }

  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
    max-width: 60ch;
  }

  .add-button {
    background: var(--surface-inset);
    color: var(--text);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 6px 14px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.12s ease;
  }

  .add-button:hover,
  .add-button:focus-visible {
    background: var(--border);
  }

  .placeholder {
    padding: 20px;
    text-align: center;
    color: var(--muted);
    font-size: 13px;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-sm);
  }

  .placeholder.small {
    padding: 12px;
    font-size: 12px;
  }

  .banner.error {
    padding: 8px 12px;
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.4);
    border-radius: var(--radius-sm);
    color: #fca5a5;
    font-size: 13px;
  }

  .permission-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    background: var(--surface-inset);
    border-radius: var(--radius-sm);
    font-size: 13px;
  }

  .permission-label {
    color: var(--muted);
  }

  .permission-status.granted {
    color: #86efac;
    font-family: var(--mono);
  }

  .permission-status.denied,
  .permission-status.unsupported {
    color: #fca5a5;
    font-family: var(--mono);
  }

  .permission-status.default {
    color: var(--muted);
    font-family: var(--mono);
  }

  .permission-button {
    background: rgba(59, 130, 246, 0.18);
    color: #93c5fd;
    border: 1px solid rgba(59, 130, 246, 0.4);
    border-radius: var(--radius-sm);
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
    margin-left: auto;
  }

  .permission-button:hover,
  .permission-button:focus-visible {
    background: rgba(59, 130, 246, 0.32);
  }

  .add-form {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    padding: 14px;
    background: var(--surface-inset);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .field.wide {
    grid-column: 1 / -1;
  }

  .field label {
    font-size: 12px;
    color: var(--muted);
  }

  .field input,
  .field select {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    font-size: 13px;
    font-family: inherit;
  }

  .field input.disabled,
  .field input:disabled {
    background: var(--surface-inset);
    color: var(--muted);
  }

  .form-error {
    grid-column: 1 / -1;
  }

  .form-actions {
    grid-column: 1 / -1;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .save-button {
    background: rgba(34, 197, 94, 0.2);
    color: #86efac;
    border: 1px solid rgba(34, 197, 94, 0.4);
    border-radius: var(--radius-sm);
    padding: 6px 14px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }

  .save-button:hover,
  .save-button:focus-visible {
    background: rgba(34, 197, 94, 0.35);
  }

  .section-title {
    margin: 8px 0 4px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .table-wrap {
    overflow-x: auto;
  }

  .rules-table,
  .fires-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  .rules-table th,
  .rules-table td,
  .fires-table th,
  .fires-table td {
    padding: 8px 10px;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }

  .rules-table th,
  .fires-table th {
    font-size: 11px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }

  .num {
    text-align: right;
  }

  .mono {
    font-family: var(--mono);
  }

  .small {
    font-size: 12px;
  }

  tr.disabled {
    opacity: 0.55;
  }

  tr.acknowledged {
    opacity: 0.6;
  }

  .label-cell {
    color: var(--text-secondary);
  }

  .rule-text {
    color: var(--text);
  }

  .rule-text strong {
    font-family: var(--mono);
    color: var(--text);
  }

  .state[data-state='above'] {
    color: #86efac;
  }
  .state[data-state='below'] {
    color: #fca5a5;
  }
  .state[data-state='inside'] {
    color: #93c5fd;
  }
  .state[data-state='outside'] {
    color: var(--muted);
  }
  .state[data-state='none'] {
    color: var(--muted);
  }

  .actions {
    text-align: right;
    white-space: nowrap;
  }

  .delete-button {
    background: transparent;
    color: #fca5a5;
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: var(--radius-sm);
    padding: 3px 10px;
    font-size: 12px;
    cursor: pointer;
  }

  .delete-button:hover,
  .delete-button:focus-visible {
    background: rgba(239, 68, 68, 0.15);
  }

  .ack-button {
    background: rgba(59, 130, 246, 0.18);
    color: #93c5fd;
    border: 1px solid rgba(59, 130, 246, 0.4);
    border-radius: var(--radius-sm);
    padding: 3px 10px;
    font-size: 12px;
    cursor: pointer;
  }

  .ack-button:hover,
  .ack-button:focus-visible {
    background: rgba(59, 130, 246, 0.32);
  }

  .ack-label {
    color: var(--muted);
    font-size: 11px;
    font-style: italic;
  }

  .fires-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .fires-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }

  .ack-clear-button {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 3px 10px;
    font-size: 11px;
    cursor: pointer;
  }

  .ack-clear-button:hover,
  .ack-clear-button:focus-visible {
    color: var(--text);
    background: var(--surface-inset);
  }

  .message-cell {
    color: var(--text-secondary);
    word-break: break-word;
  }
</style>
