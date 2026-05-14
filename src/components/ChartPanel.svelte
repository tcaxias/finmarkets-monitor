<script lang="ts">
  // Lightweight Charts v5 — note the v5 API uses `addSeries(SeriesDef, opts)`
  // with imported series definition constants instead of v4's shorthand
  // methods.
  //
  // Phase A multi-ticker rewrite: reads from `getEval(activeTicker)` and
  // computes thresholds from the active position's vest data. Renders a
  // placeholder when no position is active.
  import {
    createChart,
    CandlestickSeries,
    HistogramSeries,
    LineSeries,
    LineStyle,
    CrosshairMode,
    type IChartApi,
    type ISeriesApi,
    type IPriceLine,
    type UTCTimestamp,
    type CandlestickData,
    type LineData,
    type HistogramData,
  } from 'lightweight-charts';

  import { settings, getActivePosition } from '../lib/settings.svelte';
  import { computeThresholds, type Thresholds } from '../lib/math';
  import { getEval } from '../lib/evaluation.svelte';

  let chartContainer: HTMLDivElement | undefined = $state();
  let chart: IChartApi | undefined;
  let candleSeries: ISeriesApi<'Candlestick'> | undefined;
  let sma20Series: ISeriesApi<'Line'> | undefined;
  let sma200Series: ISeriesApi<'Line'> | undefined;
  let volumeSeries: ISeriesApi<'Histogram'> | undefined;
  let priceLines: IPriceLine[] = [];
  let resizeObserver: ResizeObserver | undefined;

  let hasData = $state(false);
  let loadError = $state<string | null>(null);

  const activePosition = $derived.by(() => {
    settings.activePositionId;
    settings.positions.length;
    return getActivePosition();
  });

  // App.svelte's positions $effect ensures the slice exists before this
  // runs — getEval is a pure read and Svelte tracks the slice properties
  // we read in downstream $effects/derived.
  const slice = $derived(activePosition ? getEval(activePosition.ticker) : null);

  const COLORS = {
    bg: '#0f1419',
    grid: '#222222',
    text: '#cccccc',
    border: '#2e303a',
    upWick: '#26a69a',
    downWick: '#ef5350',
    sma20: '#f5d76e',
    sma200: '#ef5350',
    pcover: '#ef5350',
    pcoverPlus: '#f59e0b',
    breakeven: '#9ca3af',
  };

  function buildChart(container: HTMLDivElement): void {
    chart = createChart(container, {
      width: container.clientWidth,
      height: 500,
      layout: {
        background: { color: COLORS.bg },
        textColor: COLORS.text,
      },
      grid: {
        vertLines: { color: COLORS.grid },
        horzLines: { color: COLORS.grid },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: COLORS.border },
      timeScale: { borderColor: COLORS.border, timeVisible: false },
    });

    candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: COLORS.upWick,
      downColor: COLORS.downWick,
      borderUpColor: COLORS.upWick,
      borderDownColor: COLORS.downWick,
      wickUpColor: COLORS.upWick,
      wickDownColor: COLORS.downWick,
    });

    sma20Series = chart.addSeries(LineSeries, {
      color: COLORS.sma20,
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    sma200Series = chart.addSeries(LineSeries, {
      color: COLORS.sma200,
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.7, bottom: 0 },
    });
  }

  /** Render the chart from the active position's slice of the eval cache. */
  function renderFromCache(): void {
    if (!chart || !candleSeries || !sma20Series || !sma200Series || !volumeSeries) {
      return;
    }

    if (!slice || slice.candles.length === 0) {
      hasData = false;
      candleSeries.setData([]);
      sma20Series.setData([]);
      sma200Series.setData([]);
      volumeSeries.setData([]);
      return;
    }

    const candles = slice.candles;
    const sma20 = slice.sma20;
    const sma200 = slice.sma200;
    const vol = slice.volume;

    loadError = null;
    candleSeries.setData(
      candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })) as CandlestickData[],
    );
    sma20Series.setData(
      sma20.map((p) => ({ ...p, time: p.time as UTCTimestamp })) as LineData[],
    );
    sma200Series.setData(
      sma200.map((p) => ({ ...p, time: p.time as UTCTimestamp })) as LineData[],
    );
    volumeSeries.setData(
      vol
        .filter((v): v is { time: number; value: number; color: string } => v.value !== null)
        .map((v) => ({ ...v, time: v.time as UTCTimestamp })) as HistogramData[],
    );

    hasData = true;
    chart.timeScale().fitContent();
  }

  function clearPriceLines(): void {
    if (!candleSeries) return;
    for (const line of priceLines) {
      candleSeries.removePriceLine(line);
    }
    priceLines = [];
  }

  function applyPriceLines(thresholds: Thresholds): void {
    if (!candleSeries) return;
    clearPriceLines();
    if (!Number.isFinite(thresholds.pbreakeven) || thresholds.pbreakeven <= 0) {
      return;
    }
    priceLines.push(
      candleSeries.createPriceLine({
        price: thresholds.pcover,
        color: COLORS.pcover,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Pcover',
      }),
      candleSeries.createPriceLine({
        price: thresholds.pcoverPlus20,
        color: COLORS.pcoverPlus,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Pcover+20%',
      }),
      candleSeries.createPriceLine({
        price: thresholds.pbreakeven,
        color: COLORS.breakeven,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Vest',
      }),
    );
  }

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

    renderFromCache();
    if (activePosition) {
      const t = computeThresholds(
        activePosition.vestPrice,
        activePosition.shares,
        activePosition.taxRate,
      );
      applyPriceLines(t);
    }

    return () => {
      resizeObserver?.disconnect();
      resizeObserver = undefined;
      clearPriceLines();
      chart?.remove();
      chart = undefined;
      candleSeries = undefined;
      sma20Series = undefined;
      sma200Series = undefined;
      volumeSeries = undefined;
    };
  });

  // Re-render whenever the active position's slice generation bumps OR
  // the active position itself changes (different ticker → different slice).
  $effect(() => {
    const _gen = slice?.generation ?? 0;
    const _ticker = activePosition?.ticker ?? '';
    void _gen;
    void _ticker;
    if (chart) {
      renderFromCache();
    }
  });

  // Recompute price lines whenever any threshold input changes on the
  // active position.
  $effect(() => {
    if (!activePosition) return;
    const t = computeThresholds(
      activePosition.vestPrice,
      activePosition.shares,
      activePosition.taxRate,
    );
    if (chart && candleSeries) {
      applyPriceLines(t);
    }
  });
</script>

<section class="chart-panel">
  <h2>Chart</h2>

  {#if !activePosition}
    <div class="placeholder-static">
      Select a position from the tabs above to view its chart.
    </div>
  {:else}
    {#if loadError}
      <div class="banner error" role="alert">Chart load failed: {loadError}</div>
    {/if}

    <div class="chart-wrapper">
      <div class="chart-container" bind:this={chartContainer}></div>

      {#if !hasData}
        <div class="placeholder">
          No data — click <strong>Refresh data</strong> to fetch.
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .chart-panel {
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

  .chart-wrapper {
    position: relative;
    width: 100%;
    min-height: 500px;
  }

  .chart-container {
    width: 100%;
    height: 500px;
  }

  .placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(15, 20, 25, 0.85);
    color: #9ca3af;
    font-size: 14px;
    pointer-events: none;
    border-radius: 4px;
  }

  .placeholder-static {
    padding: 40px;
    background: rgba(15, 20, 25, 0.6);
    border: 1px dashed #3a3d4a;
    border-radius: 6px;
    color: #9ca3af;
    text-align: center;
    font-size: 13px;
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
