
<script lang="ts">
  // Collapsible "About these indicators" panel rendered below the
  // momentum panes. Pure documentation — sources from
  // INDICATOR_DESCRIPTIONS so the toolbar tooltips and this panel can
  // never drift out of sync.

  import { INDICATOR_DESCRIPTIONS } from '../lib/indicatorDescriptions';

  // Render order. Reads as a top-to-bottom narrative: visible bars
  // first, then averages, then momentum panes, then the RSU framework
  // lines.
  const ENTRY_ORDER = [
    'candles',
    'volume',
    'sma20',
    'sma50',
    'sma200',
    'vwap',
    'rsi',
    'macd',
    'pcover',
    'vest',
  ] as const;
</script>

<details class="indicators-about">
  <summary>About these indicators</summary>
  <dl class="entries">
    {#each ENTRY_ORDER as key (key)}
      <dt>{INDICATOR_DESCRIPTIONS[key].label}</dt>
      <dd>{INDICATOR_DESCRIPTIONS[key].description}</dd>
    {/each}
  </dl>
</details>

<style>
  .indicators-about {
    background: var(--surface, #1a1b22);
    border: 1px solid var(--border, #2e303a);
    border-radius: var(--radius, 8px);
    padding: 12px 18px;
    color: var(--text-secondary, #cbd5e1);
    font-size: 13px;
  }

  .indicators-about summary {
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    color: var(--text, #e5e7eb);
    list-style: none;
    user-select: none;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .indicators-about summary::-webkit-details-marker {
    display: none;
  }

  .indicators-about summary::before {
    content: '▸';
    color: var(--muted, #9ca3af);
    font-size: 11px;
    transition: transform 0.15s ease;
    display: inline-block;
  }

  .indicators-about[open] > summary::before {
    transform: rotate(90deg);
  }

  .entries {
    margin: 12px 0 0;
    padding: 0;
    display: grid;
    grid-template-columns: minmax(140px, 200px) 1fr;
    column-gap: 16px;
    row-gap: 8px;
    color: var(--muted, #9ca3af);
    line-height: 1.55;
  }

  dt {
    font-weight: 600;
    color: var(--text, #e5e7eb);
    font-size: 13px;
  }

  dd {
    margin: 0;
    color: var(--text-secondary, #cbd5e1);
  }

  /* On narrow widths collapse the two columns into a stacked layout
     so each definition wraps cleanly without horizontal overflow. */
  @media (max-width: 600px) {
    .entries {
      grid-template-columns: 1fr;
      row-gap: 4px;
    }
    dt {
      margin-top: 8px;
    }
  }
</style>
