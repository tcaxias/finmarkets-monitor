<script lang="ts">
  // Backtest panel — per-ticker view only.
  //
  // Two distinct sections, both scoped to the active position:
  //
  //   1. Historical Conviction chart — Lightweight Charts step-line of
  //      the witness verdict over the last 250 bars, mapped to -2..2
  //      via CONVICTION_NUMERIC. Step-line (not smooth) so the verdict
  //      transitions read as discrete events, not a continuous trend.
  //      Stats strip above the chart: % time bullish / bearish / neutral
  //      and the count of verdict transitions over the window.
  //
  //   2. Example queries — three predefined SQL backtest queries the
  //      user can run with one click against their own OHLCV +
  //      indicator history. Mirrors the Screener UX (button grid →
  //      results table) so the visual idiom is consistent across
  //      Portfolio (cross-ticker) and per-ticker (single-ticker)
  //      analytics.
  //
  // Lifecycle:
  //   - Both sections re-load when the active position changes (the
  //     query result table is cleared on ticker switch — a stale "BNX
  //     Bullish Fridays" listing under the AAPL header would be a
  //     foot-gun). Conviction is recomputed automatically; queries
  //     stay idle until the user clicks a button (lazy execution
  //     mirrors ScreenerPanel).
  //   - Conviction recompute is in-flight-guarded by ticker so a rapid
  //     tab-switch doesn't race itself.
  //   - Renders an empty-state hint when the active ticker has fewer
  //     than MIN_BARS_FOR_BACKTEST bars (the trend witness needs the
  //     200-MA so anything shorter would either be neutral-flat or
  //     misleading).

  import {
    createChart,
    LineSeries,
    LineStyle,
    LineType,
    CrosshairMode,
    type IChartApi,
    type ISeriesApi,
    type IPriceLine,
    type UTCTimestamp,
    type LineData,
  } from 'lightweight-charts';

  import { settings, getActivePosition } from '../lib/settings.svelte';
  import { dataState } from '../lib/data.svelte';
  import {
    BACKTEST_QUERIES,
    computeHistoricalConviction,
    runBacktest,
    MIN_BARS_FOR_BACKTEST,
    type BacktestQueryDefinition,
    type BacktestRow,
    type HistoricalConvictionPoint,
  } from '../lib/backtest';

  // ---- Active position / row count ----

  const activePosition = $derived.by(() => {
    settings.activePositionId;
    settings.positions.length;
    return getActivePosition();
  });

  const activeTicker = $derived(activePosition?.ticker ?? '');
  const rowCount = $derived(
    activeTicker ? dataState.rowCount[activeTicker] ?? 0 : 0,
  );

  // ---- Conviction series state ----

  let convictionState = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
  let convictionError = $state<string>('');
  let conviction = $state<HistoricalConvictionPoint[]>([]);

  // Per-ticker in-flight guard so a rapid tab switch doesn't race.
  let convictionRequest = 0;

  $effect(() => {
    const ticker = activeTicker;
    // Track row count so we re-fetch after a refresh (matches the
    // pattern in App.svelte for the per-ticker recompute effect).
    const _rc = rowCount;
    void _rc;
    if (!ticker || rowCount < MIN_BARS_FOR_BACKTEST) {
      conviction = [];
      convictionState = 'idle';
      convictionError = '';
      return;
    }

    const requestId = ++convictionRequest;
    convictionState = 'loading';
    convictionError = '';
    computeHistoricalConviction(ticker, 250)
      .then((points) => {
        if (requestId !== convictionRequest) return; // stale
        conviction = points;
        convictionState = 'ready';
      })
      .catch((err: unknown) => {
        if (requestId !== convictionRequest) return;
        convictionError = err instanceof Error ? err.message : String(err);
        convictionState = 'error';
      });
  });

  // ---- Stats strip ----

  interface ConvictionStats {
    bullishPct: number;
    bearishPct: number;
    neutralPct: number;
    transitions: number;
    n: number;
  }

  const stats = $derived.by<ConvictionStats>(() => {
    if (conviction.length === 0) {
      return {
        bullishPct: 0,
        bearishPct: 0,
        neutralPct: 0,
        transitions: 0,
        n: 0,
      };
    }
    let bull = 0;
    let bear = 0;
    let neut = 0;
    let transitions = 0;
    for (let i = 0; i < conviction.length; i++) {
      const p = conviction[i];
      if (p.numeric > 0) bull++;
      else if (p.numeric < 0) bear++;
      else neut++;
      if (i > 0 && conviction[i].conviction !== conviction[i - 1].conviction) {
        transitions++;
      }
    }
    const n = conviction.length;
    return {
      bullishPct: (100 * bull) / n,
      bearishPct: (100 * bear) / n,
      neutralPct: (100 * neut) / n,
      transitions,
      n,
    };
  });

  // ---- Chart wiring ----

  let chartContainer: HTMLDivElement | undefined = $state();
  let chart: IChartApi | undefined;
  let convSeries: ISeriesApi<'Line'> | undefined;
  let zeroLine: IPriceLine | undefined;
  let resizeObserver: ResizeObserver | undefined;

  const COLORS = {
    bg: '#0f1419',
    grid: '#222222',
    text: '#cccccc',
    border: '#2e303a',
    bull: '#22c55e',
    bear: '#ef5350',
    zero: '#6b7280',
    line: '#9b59b6',
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
      rightPriceScale: {
        borderColor: COLORS.border,
        // Pin the visible price scale to -2..2. Without this Lightweight
        // Charts auto-scales to the data range, which on a flat-neutral
        // series would zoom in on micro-jitter and lose the regime
        // context the chart exists to show.
        autoScale: false,
      },
      timeScale: { borderColor: COLORS.border, timeVisible: false },
    });

    convSeries = chart.addSeries(LineSeries, {
      color: COLORS.line,
      lineWidth: 2,
      // Step-line so verdict transitions render as visible jumps rather
      // than slopes — conviction is a categorical value, treating it as
      // continuous would be misleading.
      lineStyle: LineStyle.Solid,
      lineType: LineType.WithSteps,
      priceLineVisible: false,
      lastValueVisible: true,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    });

    zeroLine = convSeries.createPriceLine({
      price: 0,
      color: COLORS.zero,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: '0',
    });
  }

  function renderConviction(): void {
    if (!chart || !convSeries) return;
    if (conviction.length === 0) {
      convSeries.setData([]);
      return;
    }
    const data: LineData[] = conviction.map((p) => ({
      time: p.time as UTCTimestamp,
      value: p.numeric,
      // Per-point color by sign — green above 0, red below 0, muted at 0.
      // Lightweight Charts honours per-point color on Line series via
      // the `color` field on LineData (v5+).
      color:
        p.numeric > 0 ? COLORS.bull : p.numeric < 0 ? COLORS.bear : COLORS.zero,
    })) as LineData[];
    convSeries.setData(data);
    chart.timeScale().fitContent();
    // Re-pin the price scale to a slightly padded -2..2 so the top/bottom
    // labels for high-bullish (2) and high-bearish (-2) stay visible.
    chart
      .priceScale('right')
      .applyOptions({ autoScale: false });
    convSeries.applyOptions({
      autoscaleInfoProvider: () => ({
        priceRange: { minValue: -2.2, maxValue: 2.2 },
      }),
    });
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
    renderConviction();
    return () => {
      resizeObserver?.disconnect();
      resizeObserver = undefined;
      if (zeroLine && convSeries) {
        convSeries.removePriceLine(zeroLine);
        zeroLine = undefined;
      }
      chart?.remove();
      chart = undefined;
      convSeries = undefined;
    };
  });

  $effect(() => {
    // Re-render when conviction series changes (length signal is enough
    // because we always replace the array wholesale on each compute).
    const _len = conviction.length;
    void _len;
    if (chart) renderConviction();
  });

  // ---- Example query runner ----

  let activeQueryId = $state<string | null>(null);
  let queryRows = $state<BacktestRow[]>([]);
  let queryState = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
  let queryError = $state<string>('');
  // Bumped on every click so re-clicking the active query re-runs it
  // (e.g. after a fresh data pull). Without this, the $effect would see
  // no change in `activeQuery` and skip the re-run.
  let queryNonce = $state(0);

  const activeQuery = $derived<BacktestQueryDefinition | null>(
    activeQueryId
      ? BACKTEST_QUERIES.find((q) => q.id === activeQueryId) ?? null
      : null,
  );

  // Reset the query result whenever the active ticker changes — a
  // result table from a previous ticker under the new ticker's header
  // would be misleading.
  $effect(() => {
    void activeTicker;
    activeQueryId = null;
    queryRows = [];
    queryState = 'idle';
    queryError = '';
  });

  $effect(() => {
    void queryNonce; // dependency: re-run on re-click
    const q = activeQuery;
    const ticker = activeTicker;
    if (!q || !ticker) return;
    queryState = 'loading';
    queryError = '';
    queryRows = [];
    const requestedId = q.id;
    const myNonce = queryNonce;
    runBacktest(q, ticker)
      .then((rows) => {
        // Stale-response guard: ticker swap, query swap, or re-click
        // (bumping queryNonce) all invalidate the in-flight response.
        if (activeQueryId !== requestedId || queryNonce !== myNonce) return;
        queryRows = rows;
        queryState = 'ready';
      })
      .catch((err: unknown) => {
        if (activeQueryId !== requestedId || queryNonce !== myNonce) return;
        queryError = err instanceof Error ? err.message : String(err);
        queryState = 'error';
      });
  });

  function pickQuery(id: string): void {
    activeQueryId = id;
    queryNonce += 1;
  }

  function clearQuery(): void {
    activeQueryId = null;
    queryRows = [];
    queryState = 'idle';
    queryError = '';
  }

  // ---- Cell formatting (mirrors ScreenerPanel for visual parity) ----

  function fmtCell(
    value: string | number | null,
    format: string | undefined,
  ): string {
    if (value === null || value === undefined) return '—';
    if (format === 'price') {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return '—';
      return `$${n.toFixed(2)}`;
    }
    if (format === 'pct') {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return '—';
      const sign = n >= 0 ? '+' : '−';
      return `${sign}${Math.abs(n).toFixed(2)}%`;
    }
    if (format === 'number') {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return '—';
      return n.toFixed(2);
    }
    return String(value);
  }

  function pctTone(value: string | number | null): 'up' | 'down' | 'flat' {
    if (value === null || value === undefined) return 'flat';
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return 'flat';
    if (n > 0) return 'up';
    if (n < 0) return 'down';
    return 'flat';
  }
</script>

<section class="backtest-panel" id="backtest">
  <header class="panel-header">
    <div>
      <h2>Backtest</h2>
      <p class="subtitle">
        Historical conviction over time + one-click example queries against your
        own data.
      </p>
    </div>
    {#if activeTicker}
      <span class="count">{activeTicker}</span>
    {/if}
  </header>

  {#if !activePosition}
    <div class="placeholder">
      Select a position from the tabs above to view its backtest.
    </div>
  {:else if rowCount < MIN_BARS_FOR_BACKTEST}
    <div class="placeholder">
      Need at least {MIN_BARS_FOR_BACKTEST} bars of history before backtests are meaningful
      ({rowCount} loaded). Refresh more history from the Data panel below.
    </div>
  {:else}
    <!-- Section A: Historical Conviction -->
    <div class="section">
      <div class="section-header">
        <h3>Historical Conviction</h3>
        <p class="section-subtitle">
          The witness verdict over the last {stats.n || 250} daily bars. Mapped to
          a −2..+2 axis: high-bullish (+2), moderate-bullish (+1), neutral (0), moderate-bearish
          (−1), high-bearish (−2).
        </p>
      </div>

      {#if convictionState === 'loading'}
        <div class="status-row">Computing conviction history…</div>
      {:else if convictionState === 'error'}
        <div class="error-banner">Conviction failed: {convictionError}</div>
      {:else if convictionState === 'ready' && conviction.length === 0}
        <div class="status-row empty">No conviction history available.</div>
      {/if}

      {#if convictionState === 'ready' && conviction.length > 0}
        <div class="stats-strip" aria-label="Conviction statistics">
          <div class="stat">
            <span class="stat-label">Bullish</span>
            <span class="stat-value bull">{stats.bullishPct.toFixed(1)}%</span>
          </div>
          <div class="stat">
            <span class="stat-label">Bearish</span>
            <span class="stat-value bear">{stats.bearishPct.toFixed(1)}%</span>
          </div>
          <div class="stat">
            <span class="stat-label">Neutral</span>
            <span class="stat-value neutral">{stats.neutralPct.toFixed(1)}%</span>
          </div>
          <div class="stat">
            <span class="stat-label">Transitions</span>
            <span class="stat-value">{stats.transitions}</span>
          </div>
        </div>
      {/if}

      <div class="chart-wrapper">
        <div class="chart-container" bind:this={chartContainer}></div>
        {#if convictionState !== 'ready' || conviction.length === 0}
          <div class="placeholder-overlay">
            {#if convictionState === 'loading'}
              Computing…
            {:else if convictionState === 'error'}
              Chart unavailable.
            {:else}
              No data.
            {/if}
          </div>
        {/if}
      </div>
    </div>

    <!-- Section B: Example queries -->
    <div class="section">
      <div class="section-header">
        <h3>Example Queries</h3>
        <p class="section-subtitle">
          Predefined backtests that JOIN your OHLCV history with the materialised
          indicator tables. One click each.
        </p>
      </div>

      <div class="buttons">
        {#each BACKTEST_QUERIES as q (q.id)}
          <button
            type="button"
            class="query-button"
            class:active={activeQueryId === q.id}
            title={q.description}
            onclick={() => pickQuery(q.id)}
          >
            <span class="label">{q.label}</span>
            <span class="info" aria-hidden="true">?</span>
          </button>
        {/each}
      </div>

      {#if activeQuery}
        <div class="results">
          <div class="results-header">
            <div>
              <h4>{activeQuery.label}</h4>
              <p class="query-description">{activeQuery.description}</p>
            </div>
            <button type="button" class="clear-button" onclick={clearQuery}>
              Clear
            </button>
          </div>

          {#if queryState === 'loading'}
            <div class="status-row">Running query…</div>
          {:else if queryState === 'error'}
            <div class="error-banner">Query failed: {queryError}</div>
          {:else if queryState === 'ready' && queryRows.length === 0}
            <div class="status-row empty">No matching rows.</div>
          {:else if queryState === 'ready'}
            <div class="table-wrap">
              <table class="results-table">
                <thead>
                  <tr>
                    {#each activeQuery.columns as col (col.key)}
                      <th>{col.label}</th>
                    {/each}
                  </tr>
                </thead>
                <tbody>
                  {#each queryRows as row, i (i)}
                    <tr>
                      {#each activeQuery.columns as col (col.key)}
                        {#if col.format === 'pct'}
                          <td class="mono pct" data-tone={pctTone(row[col.key])}>
                            {fmtCell(row[col.key], col.format)}
                          </td>
                        {:else}
                          <td class="mono">{fmtCell(row[col.key], col.format)}</td>
                        {/if}
                      {/each}
                    </tr>
                  {/each}
                </tbody>
              </table>
              <p class="row-count">
                {queryRows.length} row{queryRows.length === 1 ? '' : 's'}
              </p>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .backtest-panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: var(--gap-lg);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-secondary);
    font-size: 14px;
    text-align: left;
  }

  .panel-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  h2 {
    margin: 0;
    font-size: 18px;
    color: var(--text);
  }

  .subtitle {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 12px;
  }

  .count {
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    white-space: nowrap;
    font-family: var(--mono);
    font-weight: 600;
  }

  .placeholder {
    padding: 24px;
    background: rgba(15, 20, 25, 0.6);
    border: 1px dashed var(--border-strong);
    border-radius: 6px;
    color: var(--muted);
    text-align: center;
    font-size: 13px;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }

  .section:first-of-type {
    border-top: none;
    padding-top: 0;
  }

  .section-header h3 {
    margin: 0;
    font-size: 15px;
    color: var(--text);
  }

  .section-subtitle {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
  }

  .stats-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 18px;
    padding: 10px 12px;
    background: rgba(15, 20, 25, 0.6);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .stat {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
  }

  .stat-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }

  .stat-value {
    font-family: var(--mono);
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }

  .stat-value.bull {
    color: var(--bull);
  }
  .stat-value.bear {
    color: var(--bear);
  }
  .stat-value.neutral {
    color: var(--muted-strong);
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

  .placeholder-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(15, 20, 25, 0.85);
    color: var(--muted);
    font-size: 13px;
    pointer-events: none;
    border-radius: 4px;
  }

  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .query-button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(15, 20, 25, 0.6);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 13px;
    font-family: var(--sans);
    text-align: left;
    cursor: pointer;
    transition:
      background 0.12s ease,
      border-color 0.12s ease;
    flex: 1 1 220px;
  }

  .query-button:hover,
  .query-button:focus-visible {
    background: rgba(30, 40, 50, 0.7);
    border-color: var(--border-strong);
  }

  .query-button.active {
    background: rgba(59, 130, 246, 0.15);
    border-color: var(--info);
  }

  .label {
    flex: 1;
    line-height: 1.3;
  }

  .info {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.08);
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    line-height: 16px;
    text-align: center;
    cursor: help;
  }

  .results {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }

  .results-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .results-header h4 {
    margin: 0;
    font-size: 14px;
    color: var(--text);
  }

  .query-description {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 12px;
    max-width: 720px;
    line-height: 1.5;
  }

  .clear-button {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
    transition:
      color 0.12s ease,
      border-color 0.12s ease;
  }

  .clear-button:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }

  .status-row {
    padding: 16px;
    background: rgba(15, 20, 25, 0.4);
    border: 1px dashed var(--border);
    border-radius: 6px;
    color: var(--muted);
    text-align: center;
    font-size: 13px;
  }

  .status-row.empty {
    color: var(--muted);
  }

  .error-banner {
    padding: 12px 16px;
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.4);
    border-radius: 6px;
    color: #fca5a5;
    font-size: 13px;
    font-family: var(--mono);
  }

  .table-wrap {
    overflow-x: auto;
  }

  .results-table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }

  .results-table th {
    text-align: left;
    color: var(--muted);
    font-weight: 500;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 8px;
    border-bottom: 1px solid var(--border-strong);
    white-space: nowrap;
  }

  .results-table td {
    padding: 8px;
    border-bottom: 1px solid #2a2c35;
    color: var(--text);
    font-size: 13px;
  }

  .results-table tr:last-child td {
    border-bottom: none;
  }

  .mono {
    font-family: var(--mono);
  }

  .pct[data-tone='up'] {
    color: var(--bull);
  }
  .pct[data-tone='down'] {
    color: var(--bear);
  }
  .pct[data-tone='flat'] {
    color: var(--muted);
  }

  .row-count {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 11px;
    text-align: right;
    font-family: var(--mono);
  }
</style>
