<script lang="ts">
  // MACD(12, 26, 9) chart: MACD line + signal line + histogram, with a
  // crossover badge when the most recent bar flipped sign.
  //
  // Like RsiPanel, this is its own Lightweight Charts instance — we'll
  // wire cross-pane time-axis sync in M7.
  import {
    createChart,
    LineSeries,
    HistogramSeries,
    LineStyle,
    CrosshairMode,
    type IChartApi,
    type ISeriesApi,
    type IPriceLine,
    type UTCTimestamp,
    type LineData,
    type HistogramData,
  } from 'lightweight-charts';

  import { evalState } from '../lib/evaluation.svelte';
  import type { MacdPoint } from '../lib/indicators';

  let chartContainer: HTMLDivElement | undefined = $state();
  let chart: IChartApi | undefined;
  let macdSeries: ISeriesApi<'Line'> | undefined;
  let signalSeries: ISeriesApi<'Line'> | undefined;
  let histSeries: ISeriesApi<'Histogram'> | undefined;
  let zeroLine: IPriceLine | undefined;
  let resizeObserver: ResizeObserver | undefined;

  let hasData = $state(false);
  let loadError = $state<string | null>(null);
  let latest = $state<MacdPoint | null>(null);
  let crossover = $state<'bullish' | 'bearish' | null>(null);

  const COLORS = {
    bg: '#0f1419',
    grid: '#222222',
    text: '#cccccc',
    border: '#2e303a',
    macd: '#2196f3',
    signal: '#ff9800',
    histPos: '#26a69a',
    histNeg: '#ef5350',
    zero: '#6b7280',
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
      rightPriceScale: { borderColor: COLORS.border },
      timeScale: { borderColor: COLORS.border, timeVisible: false },
    });

    // Histogram first so the lines render above it. All three series share
    // the same right price scale — MACD/signal/hist are all in price-delta
    // units and overlay naturally.
    histSeries = chart.addSeries(HistogramSeries, {
      priceLineVisible: false,
      lastValueVisible: false,
      // No `priceFormat: {type:'volume'}` here — that would round to whole
      // numbers, which destroys MACD histogram precision (typically ~0.01).
    });

    macdSeries = chart.addSeries(LineSeries, {
      color: COLORS.macd,
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: true,
    });

    signalSeries = chart.addSeries(LineSeries, {
      color: COLORS.signal,
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: true,
    });

    // Zero reference line — anchors the eye to "MACD above/below zero",
    // which matters as much as MACD-vs-signal.
    zeroLine = macdSeries.createPriceLine({
      price: 0,
      color: COLORS.zero,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
      title: '0',
    });
  }

  /**
   * Detect a sign-flip in (macd - signal) between the last two bars.
   * Bullish: histogram crossed from negative to positive (MACD broke
   * above signal). Bearish: the inverse. Anything else returns null.
   */
  function detectCrossover(macd: MacdPoint[]): 'bullish' | 'bearish' | null {
    if (macd.length < 2) return null;
    const a = macd[macd.length - 2].histogram;
    const b = macd[macd.length - 1].histogram;
    if (a < 0 && b >= 0) return 'bullish';
    if (a > 0 && b <= 0) return 'bearish';
    return null;
  }

  /** Render from the shared evaluation cache. */
  function renderFromCache(): void {
    if (!chart || !macdSeries || !signalSeries || !histSeries) return;

    const macd = evalState.macd;

    if (macd.length === 0) {
      hasData = false;
      latest = null;
      crossover = null;
      macdSeries.setData([]);
      signalSeries.setData([]);
      histSeries.setData([]);
      return;
    }

    loadError = null;
    macdSeries.setData(
      macd.map((p) => ({ time: p.time as UTCTimestamp, value: p.macd })) as LineData[],
    );
    signalSeries.setData(
      macd.map((p) => ({ time: p.time as UTCTimestamp, value: p.signal })) as LineData[],
    );
    histSeries.setData(
      macd.map((p) => ({
        time: p.time as UTCTimestamp,
        value: p.histogram,
        color: p.histogram >= 0 ? COLORS.histPos : COLORS.histNeg,
      })) as HistogramData[],
    );

    latest = macd[macd.length - 1];
    crossover = detectCrossover(macd);
    hasData = true;
    chart.timeScale().fitContent();
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

    return () => {
      resizeObserver?.disconnect();
      resizeObserver = undefined;
      if (zeroLine && macdSeries) {
        macdSeries.removePriceLine(zeroLine);
        zeroLine = undefined;
      }
      chart?.remove();
      chart = undefined;
      macdSeries = undefined;
      signalSeries = undefined;
      histSeries = undefined;
    };
  });

  $effect(() => {
    const _gen = evalState.generation;
    void _gen;
    if (chart) {
      renderFromCache();
    }
  });
</script>

<section class="macd-panel">
  <header class="panel-header">
    <h2>MACD(12, 26, 9)</h2>
    <div class="readouts">
      {#if latest}
        <span class="metric">
          <span class="metric-label">MACD</span>
          <span class="metric-value" style="color: {COLORS.macd}">
            {latest.macd.toFixed(3)}
          </span>
        </span>
        <span class="metric">
          <span class="metric-label">Signal</span>
          <span class="metric-value" style="color: {COLORS.signal}">
            {latest.signal.toFixed(3)}
          </span>
        </span>
        <span class="metric">
          <span class="metric-label">Hist</span>
          <span
            class="metric-value"
            style="color: {latest.histogram >= 0 ? COLORS.histPos : COLORS.histNeg}"
          >
            {latest.histogram.toFixed(3)}
          </span>
        </span>
      {/if}
      {#if crossover}
        <span class="crossover-badge" class:bullish={crossover === 'bullish'} class:bearish={crossover === 'bearish'}>
          {crossover === 'bullish' ? 'Bullish crossover' : 'Bearish crossover'}
        </span>
      {/if}
    </div>
  </header>

  {#if loadError}
    <div class="banner error" role="alert">MACD load failed: {loadError}</div>
  {/if}

  <div class="chart-wrapper">
    <div class="chart-container" bind:this={chartContainer}></div>

    {#if !hasData}
      <div class="placeholder">No MACD data yet — fetch some history first.</div>
    {/if}
  </div>
</section>

<style>
  .macd-panel {
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
    gap: 14px;
    flex-wrap: wrap;
  }

  .metric {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
  }

  .metric-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #9ca3af;
  }

  .metric-value {
    font-family: ui-monospace, Consolas, monospace;
    font-size: 14px;
    font-weight: 600;
  }

  .crossover-badge {
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid transparent;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .crossover-badge.bullish {
    background: rgba(34, 197, 94, 0.15);
    border-color: rgba(34, 197, 94, 0.5);
    color: #86efac;
  }

  .crossover-badge.bearish {
    background: rgba(239, 83, 80, 0.15);
    border-color: rgba(239, 83, 80, 0.5);
    color: #fca5a5;
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
