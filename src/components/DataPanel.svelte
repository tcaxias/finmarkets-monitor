<script lang="ts">
  // Data panel — refresh controls.
  //
  // Phase A multi-ticker rewrite: the primary "Refresh data" button targets
  // the active position; "Refresh all" walks every configured position
  // sequentially with rate-limit-aware spacing.

  import { dataState, refreshData, refreshAll, clearCache } from '../lib/data.svelte';
  import { runtimeState } from '../lib/runtimeState.svelte';
  import { settings, getActivePosition } from '../lib/settings.svelte';

  let clearing = $state(false);

  const activePosition = $derived.by(() => {
    settings.activePositionId;
    settings.positions.length;
    return getActivePosition();
  });

  const canRefreshActive = $derived(
    !dataState.loading &&
      settings.apiKey.trim() !== '' &&
      activePosition !== null,
  );

  const canRefreshAll = $derived(
    !dataState.loading &&
      settings.apiKey.trim() !== '' &&
      settings.positions.length > 0,
  );

  async function onRefreshActive(): Promise<void> {
    if (!activePosition) return;
    await refreshData(activePosition.ticker);
  }

  async function onRefreshAll(): Promise<void> {
    await refreshAll();
  }

  async function onClear(): Promise<void> {
    if (clearing) return;
    if (!confirm('Drop all cached OHLCV data? This cannot be undone.')) return;
    clearing = true;
    try {
      await clearCache();
    } finally {
      clearing = false;
    }
  }

  function fmtTime(d: Date | null): string {
    if (!d) return 'Never';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  function fmtPrice(n: number | null | undefined): string {
    if (n === null || n === undefined) return '—';
    return `$${n.toFixed(2)}`;
  }

  // Aggregate row count across all known tickers — gives the user a
  // quick sense of total data volume without listing each ticker.
  const totalRows = $derived(
    Object.values(dataState.rowCount).reduce((sum, n) => sum + n, 0),
  );

  // For the active position's per-ticker latest close display.
  const activeTicker = $derived(activePosition?.ticker ?? '');
  const activeRowCount = $derived(activeTicker ? (dataState.rowCount[activeTicker] ?? 0) : 0);
  const activeLatestClose = $derived(
    activeTicker ? (dataState.latestCloseByTicker[activeTicker] ?? null) : null,
  );
  const activeLatestDate = $derived(
    activeTicker ? (dataState.latestDateByTicker[activeTicker] ?? null) : null,
  );
  const activeLastFetched = $derived(
    activeTicker ? (dataState.lastFetchedByTicker[activeTicker] ?? null) : null,
  );
</script>

<section class="data-panel">
  <h2>Market Data</h2>

  <div class="row actions">
    <button type="button" onclick={onRefreshActive} disabled={!canRefreshActive}>
      {#if dataState.loading && !dataState.refreshProgress}
        Refreshing…
      {:else}
        Refresh {activeTicker || 'active'}
      {/if}
    </button>
    <button type="button" onclick={onRefreshAll} disabled={!canRefreshAll}>
      {#if dataState.refreshProgress}
        Refreshing {dataState.refreshProgress.current}/{dataState.refreshProgress.total}: {dataState.refreshProgress.ticker}…
      {:else}
        Refresh all
      {/if}
    </button>
    <button type="button" class="ghost" onclick={onClear} disabled={clearing || dataState.loading}>
      {clearing ? 'Clearing…' : 'Clear cache'}
    </button>
  </div>

  {#if dataState.error}
    <div class="banner error" role="alert">{dataState.error}</div>
  {/if}

  <dl>
    <dt>Active position</dt>
    <dd>
      {#if activePosition}
        {activeTicker}
        <span class="muted">— last fetched {fmtTime(activeLastFetched)}</span>
      {:else}
        <span class="muted">None (portfolio overview)</span>
      {/if}
    </dd>

    <dt>Rows for {activeTicker || 'active'}</dt>
    <dd>{activeRowCount}</dd>

    <dt>Latest close</dt>
    <dd>
      {#if activeLatestClose !== null && activeLatestDate}
        {fmtPrice(activeLatestClose)} on {activeLatestDate}
      {:else}
        —
      {/if}
    </dd>

    <dt>Total rows (all tickers)</dt>
    <dd>{totalRows}</dd>

    <dt>Storage</dt>
    <dd class="storage" data-persistent={runtimeState.isPersistent}>
      {#if runtimeState.isPersistent}
        Persistent (OPFS)
      {:else}
        In-memory (data will not survive reload)
      {/if}
    </dd>
  </dl>
</section>

<style>
  .data-panel {
    display: flex;
    flex-direction: column;
    gap: 14px;
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

  .row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }

  button {
    background: #2563eb;
    color: #f3f4f6;
    border: 1px solid #1d4ed8;
    border-radius: 4px;
    padding: 8px 14px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
  }

  button:hover:not(:disabled) {
    background: #1d4ed8;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  button.ghost {
    background: #2e303a;
    border-color: #3a3d4a;
    font-weight: 400;
  }

  button.ghost:hover:not(:disabled) {
    background: #3a3d4a;
  }

  .banner {
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 13px;
    border: 1px solid transparent;
  }

  .banner.error {
    background: rgba(239, 68, 68, 0.12);
    border-color: rgba(239, 68, 68, 0.4);
    color: #fca5a5;
  }

  dl {
    display: grid;
    grid-template-columns: 200px 1fr;
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

  .muted {
    color: #9ca3af;
    font-size: 12px;
  }

  .storage[data-persistent='true'] {
    color: #86efac;
  }

  .storage[data-persistent='false'] {
    color: #fde68a;
  }
</style>
