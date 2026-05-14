<script lang="ts">
  // Anomalies panel — Portfolio-mode only.
  //
  // Renders the three predefined cross-ticker anomaly detectors as
  // one-click buttons grouped by category (Volume / Price / Regime).
  // On click, the panel runs the detector against the user's current
  // positions and displays the result rows in a compact table.
  //
  // Visual + UX symmetry with ScreenerPanel: same layout, same idle/
  // loading/error/empty states, same stale-response guard. The one
  // notable addition is the `zscore` cell format, which colour-codes
  // the magnitude (yellow at ≥3, orange at ≥4, red at ≥5) so the
  // most surprising bars draw the eye without further interaction.
  //
  // Lazy execution: queries don't run on mount — only on click.
  // Result state is per-instance, so navigating away and back resets
  // to the empty state (intentional — a stale "result from 5 minutes
  // ago" row would be misleading after a refresh).

  import { settings } from '../lib/settings.svelte';
  import {
    ANOMALIES,
    runAnomaly,
    type AnomalyDefinition,
    type AnomalyRow,
  } from '../lib/anomalies';

  let activeAnomalyId = $state<string | null>(null);
  let rows = $state<AnomalyRow[]>([]);
  let runState = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
  let errorMsg = $state<string>('');
  // Bumped on every click so re-clicking the active selection still
  // re-runs the detector (e.g. after a fresh data pull). Without this,
  // the $effect would see no change in `activeAnomaly` and skip.
  let runNonce = $state(0);

  const activeAnomaly = $derived<AnomalyDefinition | null>(
    activeAnomalyId
      ? ANOMALIES.find((a) => a.id === activeAnomalyId) ?? null
      : null,
  );

  // Group detectors by category for the trigger grid. Order is fixed
  // by declaration order in ANOMALIES (so Volume / Price / Regime
  // render in the order the user sees in anomalies.ts).
  const grouped = $derived.by(() => {
    const out: Record<'volume' | 'price' | 'regime', AnomalyDefinition[]> = {
      volume: [],
      price: [],
      regime: [],
    };
    for (const a of ANOMALIES) out[a.category].push(a);
    return out;
  });

  const categoryLabels: Record<'volume' | 'price' | 'regime', string> = {
    volume: 'Volume',
    price: 'Price',
    regime: 'Regime',
  };

  // Run the active detector whenever it changes OR runNonce bumps
  // (re-click on the same selection). We intentionally don't re-run on
  // settings.positions changes mid-result — the user clicked for a
  // snapshot, and surprise re-runs would erase their place.
  $effect(() => {
    void runNonce; // dependency: re-run on re-click
    const anomaly = activeAnomaly;
    if (!anomaly) return;
    const myNonce = runNonce;
    runState = 'loading';
    errorMsg = '';
    rows = [];
    // Snapshot positions at click-time so an in-flight settings change
    // can't race with the query.
    const snapshot = settings.positions.slice();
    runAnomaly(anomaly, snapshot)
      .then((result) => {
        // Stale-response guard: if the user clicked another detector OR
        // re-clicked (bumping runNonce) while this one was running,
        // drop the result silently.
        if (activeAnomalyId !== anomaly.id || runNonce !== myNonce) return;
        rows = result;
        runState = 'ready';
      })
      .catch((err: unknown) => {
        if (activeAnomalyId !== anomaly.id || runNonce !== myNonce) return;
        errorMsg = err instanceof Error ? err.message : String(err);
        runState = 'error';
      });
  });

  function pick(id: string): void {
    activeAnomalyId = id;
    runNonce += 1;
  }

  function clear(): void {
    activeAnomalyId = null;
    rows = [];
    runState = 'idle';
    errorMsg = '';
  }

  // Formatting helpers — kept local for visual + idiom symmetry with
  // ScreenerPanel. The 'zscore' branch is the only addition over the
  // shared formatter shape.
  function fmtCell(value: string | number | null, format: string | undefined): string {
    if (value === null || value === undefined) return '—';
    if (format === 'price') {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return '—';
      return `$${n.toFixed(2)}`;
    }
    if (format === 'pct') {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return '—';
      const sign = n >= 0 ? '+' : '−';
      return `${sign}${Math.abs(n).toFixed(2)}%`;
    }
    if (format === 'number') {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return '—';
      // Volume columns can be in the millions — thousands-separators
      // keep them readable. We pick "no decimals" for >= 1000 and 2
      // decimals otherwise so non-volume numerics don't look weird.
      if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
      return n.toFixed(2);
    }
    if (format === 'zscore') {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return '—';
      return n.toFixed(1);
    }
    // 'date' and 'string' (and undefined) just stringify.
    return String(value);
  }

  function pctTone(value: string | number | null): 'up' | 'down' | 'flat' {
    if (value === null || value === undefined) return 'flat';
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return 'flat';
    if (n > 0) return 'up';
    if (n < 0) return 'down';
    return 'flat';
  }

  // Z-score severity bucketing. Thresholds match the convention in the
  // detector's description: 3 is unusual, 4 is rare, 5+ is exceptional.
  // CSS uses these as data attribute selectors for colour-coding.
  function zscoreTone(value: string | number | null): 'low' | 'mid' | 'high' | 'extreme' {
    if (value === null || value === undefined) return 'low';
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return 'low';
    if (n >= 5) return 'extreme';
    if (n >= 4) return 'high';
    if (n >= 3) return 'mid';
    return 'low';
  }
</script>

<section class="anomalies-panel">
  <header class="panel-header">
    <div>
      <h2>Anomalies</h2>
      <p class="subtitle">
        Cross-ticker SQL detectors for unusual volume, price gaps, and regime shifts.
      </p>
    </div>
    <span class="count">
      {settings.positions.length} position{settings.positions.length === 1 ? '' : 's'}
    </span>
  </header>

  {#if settings.positions.length === 0}
    <div class="placeholder">
      Add positions in the panel below to enable Anomaly Detection.
    </div>
  {:else}
    <div class="anomaly-grid">
      {#each (['volume', 'price', 'regime'] as const) as cat (cat)}
        <div class="category">
          <h3 class="category-label" data-category={cat}>{categoryLabels[cat]}</h3>
          <div class="buttons">
            {#each grouped[cat] as anomaly (anomaly.id)}
              <button
                type="button"
                class="anomaly-button"
                class:active={activeAnomalyId === anomaly.id}
                title={anomaly.description}
                onclick={() => pick(anomaly.id)}
              >
                <span class="label">{anomaly.label}</span>
                <span class="info" aria-hidden="true">?</span>
              </button>
            {/each}
          </div>
        </div>
      {/each}
    </div>

    {#if activeAnomaly}
      <div class="results">
        <div class="results-header">
          <div>
            <h3>{activeAnomaly.label}</h3>
            <p class="anomaly-description">{activeAnomaly.description}</p>
          </div>
          <button type="button" class="clear-button" onclick={clear}>Clear</button>
        </div>

        {#if runState === 'loading'}
          <div class="status-row">Running detector…</div>
        {:else if runState === 'error'}
          <div class="error-banner">
            Detector failed: {errorMsg}
          </div>
        {:else if runState === 'ready' && rows.length === 0}
          <div class="status-row empty">
            No anomalies detected in the configured window.
          </div>
        {:else if runState === 'ready'}
          <div class="table-wrap">
            <table class="anomalies-table">
              <thead>
                <tr>
                  {#each activeAnomaly.columns as col (col.key)}
                    <th>{col.label}</th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each rows as row, i (i)}
                  <tr>
                    {#each activeAnomaly.columns as col (col.key)}
                      {#if col.format === 'pct'}
                        <td class="mono pct" data-tone={pctTone(row[col.key])}>
                          {fmtCell(row[col.key], col.format)}
                        </td>
                      {:else if col.format === 'zscore'}
                        <td class="mono zscore" data-tone={zscoreTone(row[col.key])}>
                          {fmtCell(row[col.key], col.format)}
                        </td>
                      {:else if col.format === 'string' && col.key === 'ticker'}
                        <td class="ticker-cell mono">
                          {fmtCell(row[col.key], col.format)}
                        </td>
                      {:else}
                        <td class="mono">{fmtCell(row[col.key], col.format)}</td>
                      {/if}
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
            <p class="row-count">
              {rows.length} anomal{rows.length === 1 ? 'y' : 'ies'}
            </p>
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</section>

<style>
  .anomalies-panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: var(--gap-lg);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-secondary);
    font-size: 14px;
    text-align: left;
  }

  .panel-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  h2 {
    margin: 0;
    font-size: 18px;
    color: var(--text);
  }

  .subtitle {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 12px;
  }

  .count {
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    white-space: nowrap;
  }

  .placeholder {
    padding: 24px;
    background: rgba(15, 20, 25, 0.6);
    border: 1px dashed var(--border-strong);
    border-radius: 6px;
    color: var(--muted);
    text-align: center;
    font-size: 13px;
  }

  .anomaly-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 16px;
  }

  .category {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .category-label {
    margin: 0;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
    color: var(--muted);
  }

  /* Volume = blue (liquidity), Price = green (movement), Regime =
     amber (long-term trend) — distinct from Screener's palette so the
     two panels read as related but different at a glance. */
  .category-label[data-category='volume'] {
    color: #93c5fd;
  }
  .category-label[data-category='price'] {
    color: #86efac;
  }
  .category-label[data-category='regime'] {
    color: #fcd34d;
  }

  .buttons {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .anomaly-button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(15, 20, 25, 0.6);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 13px;
    font-family: var(--sans);
    text-align: left;
    cursor: pointer;
    transition:
      background 0.12s ease,
      border-color 0.12s ease;
  }

  .anomaly-button:hover,
  .anomaly-button:focus-visible {
    background: rgba(30, 40, 50, 0.7);
    border-color: var(--border-strong);
  }

  .anomaly-button.active {
    background: rgba(59, 130, 246, 0.15);
    border-color: var(--info);
    color: var(--text);
  }

  .label {
    flex: 1;
    line-height: 1.3;
  }

  .info {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.08);
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    line-height: 16px;
    text-align: center;
    cursor: help;
  }

  .results {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }

  .results-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .results-header h3 {
    margin: 0;
    font-size: 15px;
    color: var(--text);
  }

  .anomaly-description {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 12px;
    max-width: 720px;
    line-height: 1.5;
  }

  .clear-button {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
    transition:
      color 0.12s ease,
      border-color 0.12s ease;
  }

  .clear-button:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }

  .status-row {
    padding: 16px;
    background: rgba(15, 20, 25, 0.4);
    border: 1px dashed var(--border);
    border-radius: 6px;
    color: var(--muted);
    text-align: center;
    font-size: 13px;
  }

  .status-row.empty {
    color: var(--muted);
  }

  .error-banner {
    padding: 12px 16px;
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.4);
    border-radius: 6px;
    color: #fca5a5;
    font-size: 13px;
    font-family: var(--mono);
  }

  .table-wrap {
    overflow-x: auto;
  }

  .anomalies-table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }

  .anomalies-table th {
    text-align: left;
    color: var(--muted);
    font-weight: 500;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 8px;
    border-bottom: 1px solid var(--border-strong);
    white-space: nowrap;
  }

  .anomalies-table td {
    padding: 8px;
    border-bottom: 1px solid #2a2c35;
    color: var(--text);
    font-size: 13px;
  }

  .anomalies-table tr:last-child td {
    border-bottom: none;
  }

  .mono {
    font-family: var(--mono);
  }

  .ticker-cell {
    color: var(--info);
    font-weight: 600;
  }

  .pct[data-tone='up'] {
    color: var(--bull);
  }
  .pct[data-tone='down'] {
    color: var(--bear);
  }
  .pct[data-tone='flat'] {
    color: var(--muted);
  }

  /* Z-score severity colouring: at ≥3 the bar is unusual (yellow), at
     ≥4 it's rare (orange), at ≥5 it's exceptional (red). Below 3 we
     never render — the detector filters those out — but we keep a
     defensive 'low' bucket in the tone helper so the data attribute
     is always meaningful. */
  .zscore {
    font-weight: 600;
  }
  .zscore[data-tone='low'] {
    color: var(--text);
  }
  .zscore[data-tone='mid'] {
    color: #fcd34d;
  }
  .zscore[data-tone='high'] {
    color: #fb923c;
  }
  .zscore[data-tone='extreme'] {
    color: #f87171;
  }

  .row-count {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 11px;
    text-align: right;
    font-family: var(--mono);
  }
</style>
