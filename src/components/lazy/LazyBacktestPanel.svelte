<script lang="ts">
  // Lazy loader for BacktestPanel. Splits the panel + its backtest
  // helpers (BACKTEST_QUERIES, runBacktest, computeHistoricalConviction)
  // and its lightweight-charts mini-chart imports into a separate Vite
  // chunk. BacktestPanel only renders for the active-position view, so
  // there is no benefit to shipping it in the entry chunk.

  import { onMount } from 'svelte';
  import type { ComponentType } from 'svelte';

  let Cmp: ComponentType | null = $state(null);
  let loadError: string | null = $state(null);

  onMount(() => {
    import('../BacktestPanel.svelte')
      .then((m) => {
        Cmp = m.default as unknown as ComponentType;
      })
      .catch((err) => {
        loadError = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error('LazyBacktestPanel: load failed', err);
      });
  });
</script>

{#if loadError}
  <div class="lazy-error" role="alert">
    Failed to load Backtest: {loadError}
  </div>
{:else if Cmp}
  <!-- Svelte 5 runes mode: components are dynamic by default. Render
       the resolved module's default export directly via the capitalised
       state variable (no `<svelte:component>` shim needed). -->
  <Cmp />
{:else}
  <div class="lazy-loading" aria-live="polite">Loading backtest…</div>
{/if}

<style>
  .lazy-loading {
    padding: 20px;
    text-align: center;
    color: var(--muted, #9ca3af);
    font-size: 13px;
  }
  .lazy-error {
    padding: 12px 16px;
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.4);
    border-radius: 6px;
    color: #fca5a5;
    font-size: 13px;
  }
</style>
