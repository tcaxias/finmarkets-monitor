<script lang="ts">
  // Screener panel — Portfolio-mode only.
  //
  // Renders the six predefined cross-ticker SQL screens as one-click
  // buttons grouped by category (Momentum / Trend / Risk). On click,
  // the panel runs the screen against the user's current positions and
  // displays the result rows in a compact table below.
  //
  // Lazy execution: queries don't run on mount — they only run when the
  // user picks a screen. Each click swaps `activeScreenId` and re-fires
  // the runner via the $effect below. Result state is per-instance, so
  // navigating away from the panel and back resets to the empty state
  // (intentional — a stale "result from 5 minutes ago" row would be
  // misleading after a refresh).
  //
  // Visual style mirrors PortfolioOverview: same surface/border/radius
  // tokens, same header treatment, same table conventions.

  import { settings } from '../lib/settings.svelte';
  import {
    SCREENS,
    runScreen,
    type ScreenDefinition,
    type ScreenRow,
  } from '../lib/screener';

  let activeScreenId = $state<string | null>(null);
  let rows = $state<ScreenRow[]>([]);
  let runState = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
  let errorMsg = $state<string>('');
  // Bumped on every click so re-clicking the active selection still
  // re-runs the query. Without this, the $effect below would see no
  // change in `activeScreen` and skip the re-run — annoying when the
  // user added a position and wants to re-evaluate the same screen.
  let runNonce = $state(0);

  const activeScreen = $derived<ScreenDefinition | null>(
    activeScreenId ? SCREENS.find((s) => s.id === activeScreenId) ?? null : null,
  );

  // Group screens by category for the trigger grid. Order is fixed by
  // declaration order in SCREENS (so Momentum / Trend / Risk render in
  // the order the user sees in screener.ts).
  const grouped = $derived.by(() => {
    const out: Record<'momentum' | 'trend' | 'risk', ScreenDefinition[]> = {
      momentum: [],
      trend: [],
      risk: [],
    };
    for (const s of SCREENS) out[s.category].push(s);
    return out;
  });

  const categoryLabels: Record<'momentum' | 'trend' | 'risk', string> = {
    momentum: 'Momentum',
    trend: 'Trend',
    risk: 'Risk',
  };

  // Run the active screen whenever it changes OR runNonce bumps
  // (re-click on the same selection). We intentionally don't re-run
  // on settings.positions changes mid-result — the user clicked for a
  // snapshot, and surprise re-runs would erase their place. Next
  // explicit click picks up the new positions.
  $effect(() => {
    void runNonce; // dependency: re-run on re-click
    const screen = activeScreen;
    if (!screen) return;
    const myNonce = runNonce;
    runState = 'loading';
    errorMsg = '';
    rows = [];
    // Snapshot positions at click-time so an in-flight settings change
    // can't race with the query.
    const snapshot = settings.positions.slice();
    runScreen(screen, snapshot)
      .then((result) => {
        // Stale-response guard: if the user clicked another screen OR
        // re-clicked (bumping runNonce) while this one was running,
        // drop the result silently.
        if (activeScreenId !== screen.id || runNonce !== myNonce) return;
        rows = result;
        runState = 'ready';
      })
      .catch((err: unknown) => {
        if (activeScreenId !== screen.id || runNonce !== myNonce) return;
        errorMsg = err instanceof Error ? err.message : String(err);
        runState = 'error';
      });
  });

  function pick(id: string): void {
    activeScreenId = id;
    runNonce += 1;
  }

  function clear(): void {
    activeScreenId = null;
    rows = [];
    runState = 'idle';
    errorMsg = '';
  }

  // Formatting helpers — kept local so this component has no styling
  // coupling with PortfolioOverview's own copies.
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
      return n.toFixed(2);
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
</script>

<section class="screener-panel">
  <header class="panel-header">
    <div>
      <h2>Screener</h2>
      <p class="subtitle">
        One-click cross-ticker SQL screens against your current positions.
      </p>
    </div>
    <span class="count">
      {settings.positions.length} position{settings.positions.length === 1 ? '' : 's'}
    </span>
  </header>

  {#if settings.positions.length === 0}
    <div class="placeholder">
      Add positions in the panel below to enable the Screener.
    </div>
  {:else}
    <div class="screen-grid">
      {#each (['momentum', 'trend', 'risk'] as const) as cat (cat)}
        <div class="category">
          <h3 class="category-label" data-category={cat}>{categoryLabels[cat]}</h3>
          <div class="buttons">
            {#each grouped[cat] as screen (screen.id)}
              <button
                type="button"
                class="screen-button"
                class:active={activeScreenId === screen.id}
                title={screen.description}
                onclick={() => pick(screen.id)}
              >
                <span class="label">{screen.label}</span>
                <span class="info" aria-hidden="true">?</span>
              </button>
            {/each}
          </div>
        </div>
      {/each}
    </div>

    {#if activeScreen}
      <div class="results">
        <div class="results-header">
          <div>
            <h3>{activeScreen.label}</h3>
            <p class="screen-description">{activeScreen.description}</p>
          </div>
          <button type="button" class="clear-button" onclick={clear}>Clear</button>
        </div>

        {#if runState === 'loading'}
          <div class="status-row">Running screen…</div>
        {:else if runState === 'error'}
          <div class="error-banner">
            Screen failed: {errorMsg}
          </div>
        {:else if runState === 'ready' && rows.length === 0}
          <div class="status-row empty">
            No matching positions.
          </div>
        {:else if runState === 'ready'}
          <div class="table-wrap">
            <table class="screener-table">
              <thead>
                <tr>
                  {#each activeScreen.columns as col (col.key)}
                    <th>{col.label}</th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each rows as row, i (i)}
                  <tr>
                    {#each activeScreen.columns as col (col.key)}
                      {#if col.format === 'pct'}
                        <td class="mono pct" data-tone={pctTone(row[col.key])}>
                          {fmtCell(row[col.key], col.format)}
                        </td>
                      {:else if col.format === 'string'}
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
              {rows.length} match{rows.length === 1 ? '' : 'es'}
            </p>
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</section>

<style>
  .screener-panel {
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

  .screen-grid {
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

  .category-label[data-category='momentum'] {
    color: #93c5fd;
  }
  .category-label[data-category='trend'] {
    color: #86efac;
  }
  .category-label[data-category='risk'] {
    color: #fcd34d;
  }

  .buttons {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .screen-button {
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

  .screen-button:hover,
  .screen-button:focus-visible {
    background: rgba(30, 40, 50, 0.7);
    border-color: var(--border-strong);
  }

  .screen-button.active {
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

  .screen-description {
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

  .screener-table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }

  .screener-table th {
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

  .screener-table td {
    padding: 8px;
    border-bottom: 1px solid #2a2c35;
    color: var(--text);
    font-size: 13px;
  }

  .screener-table tr:last-child td {
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

  .row-count {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 11px;
    text-align: right;
    font-family: var(--mono);
  }
</style>
