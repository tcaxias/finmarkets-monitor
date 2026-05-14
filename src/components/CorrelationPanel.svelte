<script lang="ts">
  // Pairwise correlation matrix panel.
  //
  // Renders an N×N grid of trailing-60-day Pearson correlations of
  // daily log returns across every configured position. Heat-map by
  // default (green = positive, red = negative, intensity = |r|);
  // toggleable to a numeric display.
  //
  // Why: "are my positions actually diversified, or are they all moving
  // together?" is a real diversification question that can't be
  // answered by eyeballing individual charts. A correlation matrix is
  // the standard quant tool for it.
  //
  // Cells with < 30 overlapping bars in the window render "—" — below
  // that threshold the point estimate is too noisy to be useful (see
  // `getCorrelationMatrix` in queries.ts).

  import { settings } from '../lib/settings.svelte';
  import { dataState } from '../lib/data.svelte';
  import { getCorrelationMatrix, type CorrelationPair } from '../lib/queries';

  let pairs = $state<CorrelationPair[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let displayMode = $state<'heatmap' | 'numbers'>('heatmap');

  // Sorted, deduped, uppercased tickers from settings.positions.
  // Reactive — re-runs when positions list changes.
  const tickers = $derived.by(() => {
    const set = new Set<string>();
    for (const p of settings.positions) {
      const t = p.ticker.trim().toUpperCase();
      if (t) set.add(t);
    }
    return [...set].sort();
  });

  // Quick lookup for cell rendering: stored both directions so
  // `getCell(A,B)` and `getCell(B,A)` both hit (matrix is symmetric).
  const pairLookup = $derived.by(() => {
    const m = new Map<string, CorrelationPair>();
    for (const p of pairs) {
      m.set(`${p.tickerA}|${p.tickerB}`, p);
      m.set(`${p.tickerB}|${p.tickerA}`, p);
    }
    return m;
  });

  function getCell(
    ra: string,
    rb: string,
  ): { value: number | null; barsOverlap: number } {
    if (ra === rb) return { value: 1.0, barsOverlap: Infinity };
    const p = pairLookup.get(`${ra}|${rb}`);
    if (!p) return { value: null, barsOverlap: 0 };
    return { value: p.correlation, barsOverlap: p.barsOverlap };
  }

  // Heat-map palette: green (positive) -> dark gray (~0) -> red
  // (negative). Intensity (saturation + darkness) tracks |r| so a
  // strong correlation visually pops vs a near-zero one. Insufficient-
  // data cells are a flat muted gray so they're clearly distinguishable
  // from "computed and small".
  function cellTone(v: number | null): string {
    if (v === null) return 'rgba(120, 120, 120, 0.15)';
    const intensity = Math.min(Math.abs(v), 1); // 0..1
    const hue = v >= 0 ? 145 : 0;               // green-ish / red
    const saturation = Math.round(intensity * 55);
    const lightness = 22 + (1 - intensity) * 16; // dark when strong
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  }

  async function refresh(): Promise<void> {
    if (tickers.length < 2) {
      pairs = [];
      return;
    }
    loading = true;
    loadError = null;
    try {
      pairs = await getCorrelationMatrix(tickers, 60);
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
      console.error('CorrelationPanel: refresh failed', err);
    } finally {
      loading = false;
    }
  }

  // Re-fetch when the ticker set changes or any ticker just got fresh
  // OHLCV data. `dataState.lastFetched` is the global watermark that
  // advances on any successful refresh, mirroring how StatusBanner /
  // PortfolioOverview observe data freshness.
  $effect(() => {
    void tickers;
    void dataState.lastFetched;
    void refresh();
  });
</script>

<section class="correlation-panel">
  <header class="panel-header">
    <div>
      <h2>Position Correlations</h2>
      <p class="hint">
        60-day rolling Pearson correlation of daily log returns. Cells
        with insufficient overlap (&lt; 30 bars) shown as &mdash;.
      </p>
    </div>
    <div class="controls">
      <label class="display-toggle">
        <input
          type="radio"
          name="corr-display"
          value="heatmap"
          checked={displayMode === 'heatmap'}
          onchange={() => (displayMode = 'heatmap')}
        />
        Heat map
      </label>
      <label class="display-toggle">
        <input
          type="radio"
          name="corr-display"
          value="numbers"
          checked={displayMode === 'numbers'}
          onchange={() => (displayMode = 'numbers')}
        />
        Numbers
      </label>
    </div>
  </header>

  {#if tickers.length < 2}
    <div class="placeholder">
      Add at least 2 positions to see correlations.
    </div>
  {:else if loading && pairs.length === 0}
    <div class="placeholder">Computing correlations…</div>
  {:else if loadError}
    <div class="banner error" role="alert">{loadError}</div>
  {:else}
    <div class="matrix-wrap">
      <table class="matrix">
        <thead>
          <tr>
            <th></th>
            {#each tickers as t (t)}
              <th>{t}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each tickers as ra (ra)}
            <tr>
              <th>{ra}</th>
              {#each tickers as rb (rb)}
                {@const cell = getCell(ra, rb)}
                <td
                  class="cell"
                  data-mode={displayMode}
                  style="background: {cellTone(cell.value)}"
                  title={cell.value !== null
                    ? `${ra} vs ${rb}: ${cell.value.toFixed(3)} (${cell.barsOverlap === Infinity ? 'self' : cell.barsOverlap + ' bars'})`
                    : `${ra} vs ${rb}: insufficient overlap (${cell.barsOverlap} bars)`}
                >
                  {#if displayMode === 'numbers'}
                    {cell.value !== null ? cell.value.toFixed(2) : '—'}
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .correlation-panel {
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

  .controls {
    display: flex;
    gap: 12px;
  }

  .display-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--muted);
    cursor: pointer;
  }

  .display-toggle input[type='radio'] {
    cursor: pointer;
  }

  .placeholder {
    padding: 20px;
    text-align: center;
    color: var(--muted);
    font-size: 13px;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-sm);
  }

  .banner.error {
    padding: 8px 12px;
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.4);
    border-radius: var(--radius-sm);
    color: #fca5a5;
    font-size: 13px;
  }

  .matrix-wrap {
    overflow-x: auto;
  }

  .matrix {
    border-collapse: separate;
    border-spacing: 2px;
  }

  .matrix th {
    padding: 6px 10px;
    background: var(--surface-inset);
    color: var(--text);
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
  }

  .matrix thead th {
    text-align: center;
  }

  .matrix tbody th {
    text-align: right;
  }

  .cell {
    width: 60px;
    height: 36px;
    text-align: center;
    color: #f3f4f6;
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    border-radius: 3px;
  }
</style>
