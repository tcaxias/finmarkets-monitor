<script lang="ts">
  // Lightweight Charts v5 — note the v5 API uses `addSeries(SeriesDef, opts)`
  // with imported series definition constants instead of v4's shorthand
  // methods.
  //
  // Series lifecycle:
  //   - Candles are always present.
  //   - SMA20 / SMA50 / SMA200 / Volume are CREATED on the fly when
  //     their toggle flips on, REMOVED when it flips off. The chart
  //     instance survives across these add/remove cycles; only the
  //     series API handles are recycled.
  //   - Pcover / Pcover+20% / Vest are PriceLines on the candle series
  //     (not series themselves), so they're cheap to recreate every
  //     time their toggle changes.
  //
  // For the intraday view (timeframe='1D') we enable `timeVisible: true`
  // on the time scale so HH:MM is rendered alongside the date.
  import {
    createChart,
    createSeriesMarkers,
    CandlestickSeries,
    HistogramSeries,
    LineSeries,
    LineStyle,
    CrosshairMode,
    type IChartApi,
    type ISeriesApi,
    type ISeriesMarkersPluginApi,
    type IPriceLine,
    type SeriesMarker,
    type Time,
    type UTCTimestamp,
    type CandlestickData,
    type LineData,
    type HistogramData,
  } from 'lightweight-charts';

  import {
    settings,
    getActivePosition,
    getPositionByTicker,
    type Position,
  } from '../lib/settings.svelte';
  import { computeThresholds, type Thresholds } from '../lib/math';
  import { getEval } from '../lib/evaluation.svelte';
  import { chartPrefs } from '../lib/chartPrefs.svelte';

  // Optional `ticker` prop. When provided, this chart locks to that
  // ticker (used by PortfolioCharts to render one card per position).
  // When omitted, falls back to the active position from settings
  // (the standard per-ticker view behavior).
  interface Props {
    ticker?: string;
  }
  let { ticker: tickerProp }: Props = $props();

  let chartContainer: HTMLDivElement | undefined = $state();
  let chart: IChartApi | undefined;
  let candleSeries: ISeriesApi<'Candlestick'> | undefined;
  let sma20Series: ISeriesApi<'Line'> | undefined;
  let sma50Series: ISeriesApi<'Line'> | undefined;
  let sma200Series: ISeriesApi<'Line'> | undefined;
  let vwapSeries: ISeriesApi<'Line'> | undefined;
  let volumeSeries: ISeriesApi<'Histogram'> | undefined;
  // Lightweight Charts v5 exposes markers via the createSeriesMarkers
  // PLUGIN — the v4 `series.setMarkers([])` shorthand was removed. We
  // hold the plugin handle so the prefs effect can update or clear
  // markers without rebuilding the candle series.
  let earningsMarkers: ISeriesMarkersPluginApi<Time> | undefined;
  let priceLines: IPriceLine[] = [];
  let resizeObserver: ResizeObserver | undefined;

  let hasData = $state(false);
  let loadError = $state<string | null>(null);

  // Resolve the position: explicit prop wins, fallback to active.
  // Touching settings.activePositionId / positions.length keeps the
  // derivation reactive to position-list changes.
  const activePosition = $derived.by((): Position | null => {
    settings.activePositionId;
    settings.positions.length;
    if (tickerProp) {
      return getPositionByTicker(tickerProp);
    }
    return getActivePosition();
  });

  const slice = $derived(activePosition ? getEval(activePosition.ticker) : null);

  const COLORS = {
    bg: '#0f1419',
    grid: '#222222',
    text: '#cccccc',
    border: '#2e303a',
    upWick: '#26a69a',
    downWick: '#ef5350',
    sma20: '#f5d76e',
    sma50: '#60a5fa',
    sma200: '#ef5350',
    // Purple — distinct from yellow SMA20 / blue SMA50 / red SMA200
    // so VWAP is unambiguous when overlaid alongside the SMAs.
    vwap: '#9b59b6',
    pcover: '#ef5350',
    pcoverPlus: '#f59e0b',
    breakeven: '#9ca3af',
    // Earnings marker palette — green/red signal positive/negative
    // EPS surprise, gray = no surprise data on the wire (estimate or
    // actual was missing). Same green/red as the up/down candle wicks
    // so the user's color memory works without re-learning a new
    // palette for the markers.
    earningsPositive: '#22c55e',
    earningsNegative: '#ef5350',
    earningsNeutral: '#9ca3af',
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
  }

  // ----- Series creation helpers -----
  // Each "ensure" function adds the series if absent; each "drop"
  // function removes it if present. Idempotent so the $effect that
  // syncs prefs → chart can call them on every change without checking.

  function ensureSma20(): void {
    if (!chart || sma20Series) return;
    sma20Series = chart.addSeries(LineSeries, {
      color: COLORS.sma20,
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: false,
    });
  }
  function dropSma20(): void {
    if (chart && sma20Series) {
      chart.removeSeries(sma20Series);
      sma20Series = undefined;
    }
  }

  function ensureSma50(): void {
    if (!chart || sma50Series) return;
    sma50Series = chart.addSeries(LineSeries, {
      color: COLORS.sma50,
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: false,
    });
  }
  function dropSma50(): void {
    if (chart && sma50Series) {
      chart.removeSeries(sma50Series);
      sma50Series = undefined;
    }
  }

  function ensureSma200(): void {
    if (!chart || sma200Series) return;
    sma200Series = chart.addSeries(LineSeries, {
      color: COLORS.sma200,
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: false,
    });
  }
  function dropSma200(): void {
    if (chart && sma200Series) {
      chart.removeSeries(sma200Series);
      sma200Series = undefined;
    }
  }

  function ensureVwap(): void {
    if (!chart || vwapSeries) return;
    vwapSeries = chart.addSeries(LineSeries, {
      color: COLORS.vwap,
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: false,
    });
  }
  function dropVwap(): void {
    if (chart && vwapSeries) {
      chart.removeSeries(vwapSeries);
      vwapSeries = undefined;
    }
  }

  /**
   * Apply the current earnings array to the candle series via the
   * markers plugin. Idempotent — creates the plugin handle on first
   * call, replaces the marker set on subsequent calls. Pass an empty
   * array to clear (the plugin stays attached but emits nothing).
   *
   * Earnings is daily-only; the slice's earnings array is empty in
   * intraday mode so the markers naturally clear on a 1D switch.
   */
  function applyEarningsMarkers(): void {
    if (!candleSeries) return;
    const showEarnings = chartPrefs.showEarnings;
    const isIntraday = slice?.isIntraday ?? false;
    const events = !showEarnings || isIntraday ? [] : (slice?.earnings ?? []);
    const markers: SeriesMarker<Time>[] = events.map((e) => ({
      time: e.time as UTCTimestamp,
      position: 'aboveBar' as const,
      color:
        e.surprisePct == null
          ? COLORS.earningsNeutral
          : e.surprisePct > 0
            ? COLORS.earningsPositive
            : e.surprisePct < 0
              ? COLORS.earningsNegative
              : COLORS.earningsNeutral,
      shape: 'circle' as const,
      // Single character — the chart marker plugin renders text inside
      // the shape. Keep it minimal so the markers don't overlap on
      // back-to-back quarterly releases at zoomed-out scales.
      text: 'E',
    }));
    if (!earningsMarkers) {
      earningsMarkers = createSeriesMarkers(candleSeries, markers);
    } else {
      earningsMarkers.setMarkers(markers);
    }
  }

  function ensureVolume(): void {
    if (!chart || volumeSeries) return;
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
  function dropVolume(): void {
    if (chart && volumeSeries) {
      chart.removeSeries(volumeSeries);
      volumeSeries = undefined;
    }
  }

  /**
   * Render the chart from the active position's slice of the eval cache.
   * Each series is fed only when it exists (the prefs effect ensures
   * presence) — passing data to a non-existent series is a silent no-op
   * here and avoids the "TypeError: cannot read properties of undefined"
   * we'd otherwise hit if a prefs flip raced ahead of the render.
   */
  function renderFromCache(): void {
    if (!chart || !candleSeries) {
      return;
    }

    if (!slice || slice.candles.length === 0) {
      hasData = false;
      candleSeries.setData([]);
      sma20Series?.setData([]);
      sma50Series?.setData([]);
      sma200Series?.setData([]);
      vwapSeries?.setData([]);
      volumeSeries?.setData([]);
      // Clear any leftover markers from a previously-rendered slice
      // so an empty-data state doesn't dangle stale earnings circles.
      earningsMarkers?.setMarkers([]);
      return;
    }

    const candles = slice.candles;
    loadError = null;
    candleSeries.setData(
      candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })) as CandlestickData[],
    );
    if (sma20Series) {
      sma20Series.setData(
        slice.sma20.map((p) => ({ ...p, time: p.time as UTCTimestamp })) as LineData[],
      );
    }
    if (sma50Series) {
      sma50Series.setData(
        slice.sma50.map((p) => ({ ...p, time: p.time as UTCTimestamp })) as LineData[],
      );
    }
    if (sma200Series) {
      sma200Series.setData(
        slice.sma200.map((p) => ({ ...p, time: p.time as UTCTimestamp })) as LineData[],
      );
    }
    if (vwapSeries) {
      vwapSeries.setData(
        slice.vwap.map((p) => ({ ...p, time: p.time as UTCTimestamp })) as LineData[],
      );
    }
    if (volumeSeries) {
      volumeSeries.setData(
        slice.volume
          .filter((v): v is { time: number; value: number; color: string } => v.value !== null)
          .map((v) => ({ ...v, time: v.time as UTCTimestamp })) as HistogramData[],
      );
    }

    // Earnings markers ride on top of the candle series (no separate
    // series). Refresh them every render so a slice generation bump
    // (new earnings landing from /earnings refresh) propagates.
    applyEarningsMarkers();

    // Toggle the time-scale's HH:MM visibility based on bar size — only
    // intraday slices need it. Doing it here (after data is set) keeps
    // the rendering reactively in sync with the slice's `isIntraday`.
    chart.applyOptions({
      timeScale: { borderColor: COLORS.border, timeVisible: slice.isIntraday },
    });

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
    if (chartPrefs.showPcoverLines) {
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
      );
    }
    if (chartPrefs.showVestLine) {
      priceLines.push(
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
  }

  // Sync chart series presence with chartPrefs. This $effect runs on
  // any prefs flip; the ensure/drop helpers are idempotent, and we
  // call renderFromCache() at the end so newly-added series get their
  // data immediately (otherwise they'd render empty until the next
  // recompute generation tick).
  //
  // Intraday: SMA series are dropped regardless of toggle state because
  // slice.smaXX arrays are empty in intraday mode anyway, and rendering
  // them would just clutter the chart with empty series.
  $effect(() => {
    if (!chart) return;

    const isIntraday = slice?.isIntraday ?? false;

    // Touch every prefs field we read so Svelte tracks the dependency.
    void chartPrefs.showSma20;
    void chartPrefs.showSma50;
    void chartPrefs.showSma200;
    void chartPrefs.showVwap;
    void chartPrefs.showVolume;
    // Earnings markers — toggling this just changes which markers
    // render against the existing candle series; no series lifecycle.
    void chartPrefs.showEarnings;

    if (chartPrefs.showSma20 && !isIntraday) ensureSma20();
    else dropSma20();

    if (chartPrefs.showSma50 && !isIntraday) ensureSma50();
    else dropSma50();

    if (chartPrefs.showSma200 && !isIntraday) ensureSma200();
    else dropSma200();

    // VWAP is a daily-only overlay (slice.vwap is empty in intraday
    // mode), and rendering an empty series would just clutter the chart.
    if (chartPrefs.showVwap && !isIntraday) ensureVwap();
    else dropVwap();

    if (chartPrefs.showVolume) ensureVolume();
    else dropVolume();

    renderFromCache();
  });

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

    // Initial series setup honours current prefs.
    if (chartPrefs.showSma20) ensureSma20();
    if (chartPrefs.showSma50) ensureSma50();
    if (chartPrefs.showSma200) ensureSma200();
    if (chartPrefs.showVwap) ensureVwap();
    if (chartPrefs.showVolume) ensureVolume();

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
      // Lightweight Charts cleans up child series automatically when
      // the chart is removed; we don't need to call dropX() here, but
      // we DO need to null out our handles so a stale ref from a
      // previous mount doesn't get reused.
      clearPriceLines();
      chart?.remove();
      chart = undefined;
      candleSeries = undefined;
      sma20Series = undefined;
      sma50Series = undefined;
      sma200Series = undefined;
      vwapSeries = undefined;
      volumeSeries = undefined;
      // The markers plugin attaches to the candle series — chart.remove()
      // tears down the series and the plugin with it, but null the
      // handle so a remount doesn't try to call setMarkers on a stale
      // reference attached to a now-disposed series.
      earningsMarkers = undefined;
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
  // active position OR the user toggles Pcover/Vest visibility.
  $effect(() => {
    void chartPrefs.showPcoverLines;
    void chartPrefs.showVestLine;
    if (!activePosition) {
      // Still clear any leftover lines from a previous active position.
      if (chart && candleSeries) clearPriceLines();
      return;
    }
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
          {#if slice?.isIntraday}
            No intraday data — click <strong>Refresh intraday</strong> on the toolbar.
          {:else}
            No data — click <strong>Refresh data</strong> to fetch.
          {/if}
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
