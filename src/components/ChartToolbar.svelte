
<script lang="ts">
  // Chart toolbar — timeframe buttons + per-series visibility toggles.
  //
  // Renders directly above ChartPanel. Two button groups:
  //   - Left: 8 timeframe buttons (1D, 1M, 3M, 6M, YTD, 1Y, 2Y, All).
  //   - Right: 8 toggles for the series (SMA20/50/200, Vol, Pcover,
  //     Vest, RSI pane, MACD pane).
  //
  // When timeframe is '1D':
  //   - SMA/RSI/MACD toggles are disabled (those concepts don't apply
  //     to intraday — see evaluation.svelte.ts).
  //   - A "Refresh intraday" button appears with a small note.
  //
  // The active timeframe and each enabled toggle render with a
  // highlighted background; the underlying state lives in chartPrefs.

  import {
    chartPrefs,
    setTimeframe,
    toggle,
    type Timeframe,
  } from '../lib/chartPrefs.svelte';
  import {
    INDICATOR_DESCRIPTIONS,
    type IndicatorKey,
  } from '../lib/indicatorDescriptions';
  import { dataState } from '../lib/data.svelte';
  import { settings, getActivePosition } from '../lib/settings.svelte';
  import { refreshIntradayData } from '../lib/data.svelte';

  const TIMEFRAMES: Timeframe[] = ['1D', '1M', '3M', '6M', 'YTD', '1Y', '2Y', 'All'];

  type ToggleKey =
    | 'showSma20'
    | 'showSma50'
    | 'showSma200'
    | 'showVwap'
    | 'showVolume'
    | 'showPcoverLines'
    | 'showVestLine'
    | 'showRsiPane'
    | 'showMacdPane'
    | 'showEarnings';

  interface ToggleDef {
    key: ToggleKey;
    short: string;
    indicator: IndicatorKey;
    /** True when this toggle is meaningless under intraday (1D) view. */
    dailyOnly: boolean;
  }

  const TOGGLES: ToggleDef[] = [
    { key: 'showSma20', short: 'SMA20', indicator: 'sma20', dailyOnly: true },
    { key: 'showSma50', short: 'SMA50', indicator: 'sma50', dailyOnly: true },
    { key: 'showSma200', short: 'SMA200', indicator: 'sma200', dailyOnly: true },
    { key: 'showVwap', short: 'VWAP', indicator: 'vwap', dailyOnly: true },
    // Earnings markers — daily-only (intraday slice has earnings = []).
    // Grouped with the trend overlays here because they're a price-axis
    // annotation in the same conceptual band as the moving averages.
    { key: 'showEarnings', short: 'Earnings', indicator: 'earnings', dailyOnly: true },
    { key: 'showVolume', short: 'Vol', indicator: 'volume', dailyOnly: false },
    { key: 'showPcoverLines', short: 'Pcover', indicator: 'pcover', dailyOnly: false },
    { key: 'showVestLine', short: 'Vest', indicator: 'vest', dailyOnly: false },
    { key: 'showRsiPane', short: 'RSI', indicator: 'rsi', dailyOnly: true },
    { key: 'showMacdPane', short: 'MACD', indicator: 'macd', dailyOnly: true },
  ];

  const activePosition = $derived.by(() => {
    settings.activePositionId;
    settings.positions.length;
    return getActivePosition();
  });

  const isIntraday = $derived(chartPrefs.timeframe === '1D');

  async function handleRefreshIntraday(): Promise<void> {
    if (!activePosition) return;
    await refreshIntradayData(activePosition.ticker);
  }
</script>

<div class="chart-toolbar" role="toolbar" aria-label="Chart controls">
  <div class="group timeframe-group" role="group" aria-label="Timeframe">
    {#each TIMEFRAMES as tf (tf)}
      <button
        type="button"
        class="tf-btn"
        class:active={chartPrefs.timeframe === tf}
        aria-pressed={chartPrefs.timeframe === tf}
        title={`Timeframe: ${tf}`}
        onclick={() => setTimeframe(tf)}
      >
        {tf}
      </button>
    {/each}
  </div>

  <div class="group toggle-group" role="group" aria-label="Series toggles">
    {#each TOGGLES as t (t.key)}
      {@const disabled = isIntraday && t.dailyOnly}
      {@const pressed = chartPrefs[t.key] && !disabled}
      <button
        type="button"
        class="toggle-btn"
        class:active={pressed}
        aria-pressed={pressed}
        {disabled}
        title={INDICATOR_DESCRIPTIONS[t.indicator].description}
        onclick={() => toggle(t.key)}
      >
        {t.short}
      </button>
    {/each}
  </div>

  {#if isIntraday}
    <div class="intraday-row">
      <span class="intraday-note">
        Intraday view — moving averages and momentum indicators apply to daily
        timeframes only.
      </span>
      <button
        type="button"
        class="refresh-intraday"
        onclick={handleRefreshIntraday}
        disabled={!activePosition || dataState.intradayLoading}
        title="Fetch today's 5-minute bars from Twelve Data"
      >
        {dataState.intradayLoading ? 'Refreshing…' : 'Refresh intraday'}
      </button>
    </div>
  {/if}
</div>

<style>
  .chart-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    background: var(--surface, #1a1b22);
    border: 1px solid var(--border, #2e303a);
    border-radius: var(--radius, 8px);
    margin-bottom: 10px;
  }

  .group {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
  }

  /* Push the toggle group to the right when there's room; on narrow
     widths the wrap drops it to the next line cleanly. */
  .toggle-group {
    margin-left: auto;
  }

  .tf-btn,
  .toggle-btn,
  .refresh-intraday {
    background: var(--surface-inset, #0f1419);
    color: var(--text, #e5e7eb);
    border: 1px solid var(--border, #2e303a);
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 12px;
    font-family: var(--mono, ui-monospace, Consolas, monospace);
    cursor: pointer;
    transition:
      background 0.12s ease,
      border-color 0.12s ease,
      color 0.12s ease,
      opacity 0.12s ease;
    line-height: 1.4;
  }

  .tf-btn:hover,
  .toggle-btn:hover:not(:disabled),
  .refresh-intraday:hover:not(:disabled) {
    background: var(--border, #2e303a);
    border-color: var(--border-strong, #3a3d4a);
  }

  .tf-btn.active {
    background: var(--info, #3b82f6);
    border-color: var(--info, #3b82f6);
    color: #ffffff;
  }

  .toggle-btn {
    color: var(--muted, #9ca3af);
    background: transparent;
  }

  .toggle-btn.active {
    background: var(--info, #3b82f6);
    border-color: var(--info, #3b82f6);
    color: #ffffff;
  }

  .toggle-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .intraday-row {
    flex-basis: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding-top: 6px;
    border-top: 1px dashed var(--border, #2e303a);
    margin-top: 2px;
  }

  .intraday-note {
    font-size: 12px;
    color: var(--muted, #9ca3af);
    flex: 1;
    min-width: 0;
  }

  .refresh-intraday {
    background: var(--surface-inset, #0f1419);
  }

  .refresh-intraday:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
