<script lang="ts">
  // Stack of per-position charts shown in Portfolio overview mode. Each
  // card is a header (ticker + drill-in button) plus a ChartPanel locked
  // to that ticker. The shared ChartToolbar at the top means timeframe
  // and series toggles apply to ALL charts at once — useful when
  // comparing positions side by side.
  //
  // Renders nothing when there are no positions (the PortfolioOverview
  // already shows its own "Add positions" placeholder above us).

  import { settings, setActive } from '../lib/settings.svelte';
  import ChartToolbar from './ChartToolbar.svelte';
  import ChartPanel from './ChartPanel.svelte';

  function drillInto(id: string): void {
    setActive(id);
  }
</script>

{#if settings.positions.length > 0}
  <div class="portfolio-charts">
    <header class="header">
      <h2>Charts</h2>
      <span class="hint">
        Timeframe and series toggles below apply to every chart. Click a ticker
        header to drill into the per-position view (witnesses, indicators, review).
      </span>
    </header>

    <ChartToolbar />

    <div class="cards">
      {#each settings.positions as pos (pos.id)}
        <article class="card">
          <header class="card-header">
            <button
              type="button"
              class="ticker-link"
              onclick={() => drillInto(pos.id)}
              title="Open {pos.ticker} per-position view"
            >
              {pos.ticker}
            </button>
          </header>
          <ChartPanel ticker={pos.ticker} />
        </article>
      {/each}
    </div>
  </div>
{/if}

<style>
  .portfolio-charts {
    display: flex;
    flex-direction: column;
    gap: var(--gap, 12px);
    width: 100%;
  }

  .header {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .header h2 {
    margin: 0;
    font-size: 18px;
    color: var(--text);
  }

  .hint {
    font-size: 12px;
    color: var(--muted);
  }

  .cards {
    display: flex;
    flex-direction: column;
    gap: var(--gap-lg, 16px);
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--gap);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .card-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .ticker-link {
    background: transparent;
    border: none;
    color: var(--info);
    font-family: var(--mono);
    font-weight: 600;
    font-size: 16px;
    padding: 0;
    cursor: pointer;
    text-decoration: none;
  }

  .ticker-link:hover {
    text-decoration: underline;
  }
</style>
