<script lang="ts">
  // Portfolio-mode wrapper around ReviewExport.
  //
  // Why this exists: the Sunday review methodology is intentionally
  // per-position (each position has its own Pcover, blackout window,
  // tax due date, witness verdict). A "portfolio review" that
  // aggregates across positions doesn't fit the framework — you can't
  // trim "the portfolio," you trim a specific ticker.
  //
  // But "click into the ticker tab first, scroll to Review" is friction
  // when you just want to generate one review. This wrapper offers a
  // ticker-picker so you can stay in Portfolio mode and generate a
  // per-ticker review for any of your positions in one fewer click.
  //
  // Renders nothing when there are no positions (the PortfolioOverview
  // already shows its own "Add positions" placeholder above).

  import { settings } from '../lib/settings.svelte';
  import ReviewExport from './ReviewExport.svelte';

  // The ticker the wrapper is currently focused on. Defaults to the
  // first position; user can switch via the dropdown. Persistence is
  // intentional: stays put across re-renders so a user mid-review
  // doesn't lose their selection when settings.positions reactively
  // updates.
  let pickedTicker = $state<string>('');

  // On mount and whenever positions change, ensure pickedTicker is a
  // valid choice. If the current pick was deleted, fall back to the
  // first available position.
  $effect(() => {
    const tickers = settings.positions.map((p) => p.ticker);
    if (tickers.length === 0) {
      pickedTicker = '';
    } else if (!tickers.includes(pickedTicker)) {
      pickedTicker = tickers[0];
    }
  });
</script>

{#if settings.positions.length > 0}
  <div class="portfolio-review">
    <header class="header">
      <h2>Sunday Weekly Review</h2>
      <span class="hint">
        Per-ticker review accessible from Portfolio mode. The methodology is
        intentionally per-position — pick a ticker to generate its review.
      </span>
    </header>

    <div class="picker-row">
      <label class="picker-label" for="review-ticker-picker">For ticker:</label>
      <select
        id="review-ticker-picker"
        class="ticker-select"
        bind:value={pickedTicker}
        aria-label="Select position for Sunday review"
      >
        {#each settings.positions as pos (pos.id)}
          <option value={pos.ticker}>{pos.ticker}</option>
        {/each}
      </select>
    </div>

    {#if pickedTicker}
      {#key pickedTicker}
        <ReviewExport ticker={pickedTicker} />
      {/key}
    {/if}
  </div>
{/if}

<style>
  .portfolio-review {
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

  .picker-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 0;
  }

  .picker-label {
    font-size: 13px;
    color: var(--muted);
    font-weight: 500;
  }

  .ticker-select {
    background: var(--surface-inset, #0f1419);
    color: var(--text, #e5e7eb);
    border: 1px solid var(--border, #2e303a);
    border-radius: 4px;
    padding: 6px 10px;
    font-size: 13px;
    font-family: var(--mono, ui-monospace, Consolas, monospace);
    cursor: pointer;
    min-width: 100px;
  }

  .ticker-select:focus-visible {
    outline: 2px solid var(--info, #3b82f6);
    outline-offset: 1px;
  }

  .ticker-select:hover {
    border-color: var(--border-strong, #3a3d4a);
  }
</style>
