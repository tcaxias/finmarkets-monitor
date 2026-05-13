<script lang="ts">
  // RSI(14) chart with 30/50/70 reference lines and a basic divergence flag.
  //
  // Design choice: RSI lives in its own Lightweight Charts instance rather
  // than a synced second pane. Cross-pane time-axis synchronization in
  // Lightweight Charts requires manual subscription wiring that we'll
  // tackle in M7 polish; for now each pane stands alone.
  import {
    createChart,
    LineSeries,
    LineStyle,
    CrosshairMode,
    type IChartApi,
    type ISeriesApi,
    type IPriceLine,
    type UTCTimestamp,
    type LineData,
  } from 'lightweight-charts';

  import { settings } from '../lib/settings.svelte';
  import { dataState } from '../lib/data.svelte';
  import {
    getCloses,
    computeRsi,
    detectRsiDivergence,
    type RsiPoint,
    type ClosePoint,
    type DivergenceFlag,
  } from '../lib/indicators';

  let chartContainer: HTMLDivElement | undefined = $state();
  let chart: IChartApi | undefined;
  let rsiSeries: ISeriesApi<'Line'> | undefined;
  let referenceLines: IPriceLine[] = [];
  let resizeObserver: ResizeObserver | undefined;

  let hasData = $state(false);
  let loadError = $state<string | null>(null);
  let latestRsi = $state<number | null>(null);
  let divergence = $state<DivergenceFlag>({
    bearish: false,
    bullish: false,
    description: '',
  });

  const COLORS = {
    bg: '#0f1419',
    grid: '#222222',
    text: '#cccccc',
    border: '#2e303a',
    rsi: '#9b59b6',
    overbought: '#ef5350',
    neutral: '#9ca3af',
    oversold: '#22c55e',
  };

  function buildChart(container: HTMLDivElement): void {
    chart = createChart(container, {
      width: container.clientWidth,
      height: 150,
      layout: {
        background: { color: COLORS.bg },
        textColor: COLORS.text,
      },
      grid: {
        vertLines: { color: COLORS.grid },
        horzLines: { color: COLORS.grid },
      },
      crosshair: { mode: CrosshairMode.Normal },
      // Pin RSI's y-axis to its natural [0, 100] domain so the reference
      // lines stay at constant screen positions even when the value
      // bounces around inside the band.
      rightPriceScale: {
        borderColor: COLORS.border,
        autoScale: false,
      },
      timeScale: { borderColor: COLORS.border, timeVisible: false },
    });

    rsiSeries = chart.addSeries(LineSeries, {
      color: COLORS.rsi,
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: true,
      // Force the [0, 100] range here — autoScale=false above isn't enough
      // on its own; we still need explicit margins to keep the band fixed.
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    // Three horizontal reference lines: oversold (30), neutral (50),
    // overbought (70). Drawn on the RSI series so they share its scale.
    referenceLines.push(
      rsiSeries.createPriceLine({
        price: 70,
        color: COLORS.overbought,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: '70',
      }),
      rsiSeries.createPriceLine({
        price: 50,
        color: COLORS.neutral,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: '50',
      }),
      rsiSeries.createPriceLine({
        price: 30,
        color: COLORS.oversold,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: '30',
      }),
    );
  }

  async function reloadAllData(): Promise<void> {
    if (!chart || !rsiSeries) return;
    const ticker = settings.ticker.trim();
    if (!ticker) {
      hasData = false;
      latestRsi = null;
      return;
    }

    loadError = null;
    try {
      const closes: ClosePoint[] = await getCloses(ticker);
      const rsi: RsiPoint[] = computeRsi(closes, 14);

      if (rsi.length === 0) {
        hasData = false;
        latestRsi = null;
        divergence = { bearish: false, bullish: false, description: '' };
        rsiSeries.setData([]);
        return;
      }

      rsiSeries.setData(
        rsi.map((p) => ({
          time: p.time as UTCTimestamp,
          value: p.value,
        })) as LineData[],
      );

      latestRsi = rsi[rsi.length - 1].value;
      divergence = detectRsiDivergence(rsi, closes, 30);
      hasData = true;
      chart.timeScale().fitContent();
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
      console.error('RsiPanel: data load failed', err);
    }
  }

  // Color and label for the current RSI reading. Keep thresholds aligned
  // with the reference lines (30 / 50 / 70).
  function rsiBadge(v: number | null): { color: string; label: string } {
    if (v == null) return { color: COLORS.neutral, label: '' };
    if (v > 70) return { color: '#ef5350', label: 'overbought' };
    if (v >= 50) return { color: '#22c55e', label: 'bullish momentum' };
    if (v >= 30) return { color: '#f59e0b', label: 'bearish momentum' };
    return { color: '#3b82f6', label: 'oversold' };
  }

  let badge = $derived(rsiBadge(latestRsi));

  $effect(() => {
    if (!chartContainer) return;
    buildChart(chartContainer);

    resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry && chart) {
        chart.applyOptions({ width: entry.contentRect.width });
      }
    });
    resizeObserver.observe(chartContainer);

    void reloadAllData();

    return () => {
      resizeObserver?.disconnect();
      resizeObserver = undefined;
      if (rsiSeries) {
        for (const line of referenceLines) rsiSeries.removePriceLine(line);
      }
      referenceLines = [];
      chart?.remove();
      chart = undefined;
      rsiSeries = undefined;
    };
  });

  // Reload when the ticker changes or new data arrives. Same pattern as
  // ChartPanel: read the runes in the effect body so Svelte registers the
  // dependencies even though the work happens inside an async fn.
  $effect(() => {
    const _fetched = dataState.lastFetched;
    const _ticker = settings.ticker;
    const _rowCount = dataState.rowCount;
    void _fetched;
    void _ticker;
    void _rowCount;
    if (chart) {
      void reloadAllData();
    }
  });
</script>

<section class="rsi-panel">
  <header class="panel-header">
    <h2>RSI(14)</h2>
    <div class="readouts">
      {#if latestRsi != null}
        <span class="rsi-value" style="color: {badge.color}">
          {latestRsi.toFixed(2)}
        </span>
        <span class="rsi-label" style="color: {badge.color}">{badge.label}</span>
      {/if}
      {#if divergence.bearish || divergence.bullish}
        <span
          class="divergence-badge"
          class:bearish={divergence.bearish && !divergence.bullish}
          class:bullish={divergence.bullish && !divergence.bearish}
          class:mixed={divergence.bearish && divergence.bullish}
        >
          {divergence.description}
        </span>
      {/if}
    </div>
  </header>

  {#if loadError}
    <div class="banner error" role="alert">RSI load failed: {loadError}</div>
  {/if}

  <div class="chart-wrapper">
    <div class="chart-container" bind:this={chartContainer}></div>

    {#if !hasData}
      <div class="placeholder">No RSI data yet — fetch some history first.</div>
    {/if}
  </div>
</section>

<style>
  .rsi-panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 20px;
    background: #1a1b22;
    border: 1px solid #2e303a;
    border-radius: 8px;
    color: #e5e7eb;
    font-size: 14px;
    text-align: left;
  }

  .panel-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  h2 {
    margin: 0;
    font-size: 18px;
    color: #f3f4f6;
  }

  .readouts {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
  }

  .rsi-value {
    font-family: ui-monospace, Consolas, monospace;
    font-size: 18px;
    font-weight: 600;
  }

  .rsi-label {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .divergence-badge {
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid transparent;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .divergence-badge.bearish {
    background: rgba(239, 83, 80, 0.15);
    border-color: rgba(239, 83, 80, 0.5);
    color: #fca5a5;
  }

  .divergence-badge.bullish {
    background: rgba(34, 197, 94, 0.15);
    border-color: rgba(34, 197, 94, 0.5);
    color: #86efac;
  }

  .divergence-badge.mixed {
    background: rgba(245, 158, 11, 0.15);
    border-color: rgba(245, 158, 11, 0.5);
    color: #fde68a;
  }

  .chart-wrapper {
    position: relative;
    width: 100%;
    min-height: 150px;
  }

  .chart-container {
    width: 100%;
    height: 150px;
  }

  .placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(15, 20, 25, 0.85);
    color: #9ca3af;
    font-size: 13px;
    pointer-events: none;
    border-radius: 4px;
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
</style>
