<script lang="ts">
  // Application root.
  //
  // Phase A multi-ticker layout:
  //   Header → StatusBanner → PositionTabs (sticky) →
  //     [PortfolioOverview] OR [WitnessPanel + ChartPanel + RsiPanel +
  //                              MacdPanel + ReviewExport] →
  //   PositionsPanel → DataPanel → About / footer
  //
  // The shared evaluation cache (`evalState.byTicker`) is now per-ticker.
  // We trigger `recomputeOne(activeTicker)` whenever the active position
  // changes or its data refreshes, plus a one-shot `recomputeAll()` for
  // any other tickers whose data was just refreshed (so the portfolio
  // overview stays current even when the user is parked on a single
  // ticker view).

  import StatusBanner from './components/StatusBanner.svelte';
  import HistoricalControls from './components/HistoricalControls.svelte';
  import PositionTabs from './components/PositionTabs.svelte';
  import PortfolioOverview from './components/PortfolioOverview.svelte';
  import PortfolioCharts from './components/PortfolioCharts.svelte';
  import PositionsPanel from './components/PositionsPanel.svelte';
  import DataPanel from './components/DataPanel.svelte';
  import WitnessPanel from './components/WitnessPanel.svelte';
  import ChartToolbar from './components/ChartToolbar.svelte';
  import ChartPanel from './components/ChartPanel.svelte';
  import RsiPanel from './components/RsiPanel.svelte';
  import MacdPanel from './components/MacdPanel.svelte';
  import IndicatorsAbout from './components/IndicatorsAbout.svelte';
  import ReviewExport from './components/ReviewExport.svelte';
  import { getDb, getVersion } from './lib/duckdb';
  import { refreshState, dataState } from './lib/data.svelte';
  import { settings, getActivePosition } from './lib/settings.svelte';
  import { ensureSlice, getEval, recomputeAll, recomputeOne } from './lib/evaluation.svelte';
  import { viewState, setAsOfDate, daysAgo } from './lib/viewState.svelte';
  import { chartPrefs } from './lib/chartPrefs.svelte';

  let dbStatus = $state<'loading' | 'ready' | 'error'>('loading');
  let dbVersion = $state<string>('');
  let dbError = $state<string>('');

  $effect(() => {
    (async () => {
      try {
        await getDb();
        dbVersion = await getVersion();
        dbStatus = 'ready';
        // Pull persisted OPFS data into reactive state for every position
        // so the overview shows row counts without forcing a refresh.
        await refreshState();
        // Compute slices for every position so the overview table can
        // render conviction + price immediately on load.
        await recomputeAll();
      } catch (err) {
        dbStatus = 'error';
        dbError = err instanceof Error ? err.message : String(err);
        console.error('DuckDB init failed', err);
      }
    })();
  });

  const activePosition = $derived.by(() => {
    settings.activePositionId;
    settings.positions.length;
    return getActivePosition();
  });

  // Eagerly ensure a slice exists in evalState.byTicker for every
  // configured position. This is the canonical insertion point — by
  // doing it here (centrally) instead of lazily in getEval, consumer
  // components can read getEval(ticker) inside $derived blocks without
  // the historical "void evalState.byTicker" reactivity touch.
  $effect(() => {
    for (const p of settings.positions) {
      ensureSlice(p.ticker);
    }
  });

  // Per-ticker recompute trigger. Watches active position's ticker and
  // its row count so that a successful refresh re-runs the evaluation
  // for that ticker.
  $effect(() => {
    const t = activePosition?.ticker ?? '';
    const _rowCount = t ? dataState.rowCount[t] ?? 0 : 0;
    const _fetched = t ? dataState.lastFetchedByTicker[t] ?? null : null;
    void _rowCount;
    void _fetched;
    if (dbStatus === 'ready' && t) {
      void recomputeOne(t);
    }
  });

  // When the global `lastFetched` watermark advances (any ticker just
  // got fresh data), recompute every slice so the overview stays current
  // even if the user is parked on a per-ticker view.
  $effect(() => {
    const _watermark = dataState.lastFetched;
    void _watermark;
    if (dbStatus === 'ready') {
      void recomputeAll();
    }
  });

  // Phase B: when the historical-view as-of date changes, every ticker's
  // cached slice is now stale (its truncation point moved). Re-run all
  // slices so the overview AND any per-ticker view reflect the new
  // viewpoint without a manual refresh.
  $effect(() => {
    const _asOf = viewState.asOfDate;
    void _asOf;
    if (dbStatus === 'ready') {
      void recomputeAll();
    }
  });

  // Timeframe change → every slice is windowed differently (or, for
  // '1D', sourced from a different table entirely). Same fan-out as
  // the asOf effect.
  $effect(() => {
    void chartPrefs.timeframe;
    if (dbStatus === 'ready') {
      void recomputeAll();
    }
  });

  // Intraday-refresh trigger. The intraday refresh path writes to
  // ohlcv_intraday and updates dataState.intradayLastFetched, but the
  // daily refresh effect above only watches `rowCount` and
  // `lastFetchedByTicker` — neither moves when intraday lands. Without
  // this dedicated effect, hitting "Refresh intraday" updates the
  // database but the chart stays on stale 1D data (review Major #1).
  $effect(() => {
    const t = activePosition?.ticker ?? '';
    const _intradayFetched = t ? dataState.intradayLastFetched[t] ?? null : null;
    void _intradayFetched;
    if (dbStatus === 'ready' && t && chartPrefs.timeframe === '1D') {
      void recomputeOne(t);
    }
  });

  function onReturnToLive(): void {
    setAsOfDate(null);
  }

  const ago = $derived(daysAgo());

  // Dynamic document title: "<TICKER> $20.97 — Monitor" for the active
  // position; falls back to "Portfolio — Monitor" in overview mode.
  $effect(() => {
    if (!activePosition) {
      document.title = 'Portfolio — Monitor';
      return;
    }
    const t = activePosition.ticker;
    const slice = getEval(t);
    const price = slice.latestClose;
    if (price !== null && Number.isFinite(price)) {
      document.title = `${t} $${price.toFixed(2)} — Monitor`;
    } else {
      document.title = `${t} — Monitor`;
    }
  });

  const headerTitle = $derived(
    activePosition ? `${activePosition.ticker} Monitor` : 'Finmarkets Monitor',
  );
</script>

<div class="page" class:historical={viewState.asOfDate !== null}>
  <header class="site-header">
    <div class="container narrow">
      <h1>{headerTitle}</h1>
      <p class="subtitle">Personal reference tool</p>
      <p class="db-status" data-status={dbStatus}>
        {#if dbStatus === 'loading'}
          Loading DuckDB…
        {:else if dbStatus === 'ready'}
          DuckDB ready (v{dbVersion})
        {:else}
          DuckDB error: {dbError}
        {/if}
      </p>
    </div>
  </header>

  <nav class="page-nav" aria-label="In-page navigation">
    <div class="container narrow nav-inner">
      <a href="#status">Status</a>
      {#if !activePosition && settings.positions.length > 0}
        <a href="#overview">Overview</a>
        <a href="#chart">Charts</a>
      {/if}
      {#if activePosition}
        <a href="#witnesses">Witnesses</a>
        <a href="#chart">Chart</a>
        <a href="#indicators">Indicators</a>
        <a href="#review">Review</a>
      {/if}
      <a href="#positions">Positions</a>
      <a href="#data">Data</a>
    </div>
  </nav>

  <HistoricalControls />

  <main>
    {#if viewState.asOfDate !== null}
      <section class="historical-banner-wrap" aria-live="polite">
        <div class="container narrow historical-banner">
          <span class="historical-banner-arrow" aria-hidden="true">«</span>
          <span class="historical-banner-text">
            <strong>Historical view: {viewState.asOfDate}</strong>
            {#if ago > 0}
              <span class="historical-banner-ago">({ago} day{ago === 1 ? '' : 's'} ago)</span>
            {/if}
            — analysis reflects data as-of that date.
          </span>
          <button type="button" class="historical-banner-button" onclick={onReturnToLive}>
            Return to Live
          </button>
        </div>
      </section>
    {/if}

    <section class="container narrow stack" id="status">
      <StatusBanner />
    </section>

    <PositionTabs />

    {#if !activePosition}
      <section class="container wide stack" id="overview">
        <PortfolioOverview />
      </section>
      <section class="container wide stack" id="chart">
        <PortfolioCharts />
      </section>
    {:else}
      <section class="container narrow stack" id="witnesses">
        <WitnessPanel />
      </section>

      <section class="container wide stack" id="chart">
        <ChartToolbar />
        <ChartPanel />
      </section>

      <section class="container wide stack" id="indicators">
        <!-- RSI/MACD are daily concepts. In 1D (intraday) mode the
             slice's rsi/macd arrays are empty, so we suppress the panes
             entirely rather than render empty placeholders. The toggle
             state is preserved in chartPrefs, so flipping back to a
             daily timeframe restores the panes (review Polish #1). -->
        {#if chartPrefs.showRsiPane && chartPrefs.timeframe !== '1D'}<RsiPanel />{/if}
        {#if chartPrefs.showMacdPane && chartPrefs.timeframe !== '1D'}<MacdPanel />{/if}
        <IndicatorsAbout />
      </section>

      <section class="container narrow stack" id="review">
        <ReviewExport />
      </section>
    {/if}

    <section class="container narrow stack" id="positions">
      <PositionsPanel />
    </section>

    <section class="container narrow stack" id="data">
      <DataPanel />
    </section>

    <section class="container narrow stack">
      <details class="about-block">
        <summary>About this app</summary>
        <div class="about-body">
          <p>
            <strong>Finmarkets Monitor</strong> is a personal browser-based dashboard for
            monitoring equity positions with a tax-overhang exit framework. It
            fetches daily OHLCV from Twelve Data, persists it locally via DuckDB-WASM
            (OPFS), and renders the three-witness conviction model from the companion
            methodology docs.
          </p>
          <p>
            All data and settings stay in the browser; nothing is uploaded. The
            mechanical scoring is intentionally transparent — the same inputs always
            produce the same outputs, which you can verify by reading the source.
          </p>
          <p>Companion documents (local references, will not resolve in the browser):</p>
          <ul>
            <li>
              <code>~/docs/finmarkets/monitoring-guide.md</code> — three-phase
              educational guide
            </li>
            <li>
              <code>~/docs/finmarkets/weekly-review.md</code> — Sunday
              checklist template
            </li>
          </ul>
          <p>App version 0.2.0 — see README.md for setup and stack details.</p>
        </div>
      </details>
    </section>

    <footer class="disclaimer">
      <div class="container narrow">
        <p>
          Educational use only. Not investment, tax, or legal advice. Verify all data
          against authoritative sources. For personal financial decisions, consult a
          licensed advisor or CPA.
        </p>
        <p class="meta">
          App version 0.2.0 · Data: Twelve Data · Storage: DuckDB-WASM (OPFS)
        </p>
      </div>
    </footer>
  </main>
</div>

<style>
  .page {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .site-header {
    padding: var(--gap-xl) 0 var(--gap-lg);
  }

  .container {
    width: 100%;
    margin: 0 auto;
    padding: 0 var(--gap-lg);
  }

  .container.narrow {
    max-width: var(--col-narrow);
  }

  .container.wide {
    max-width: var(--col-wide);
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--gap-lg);
    margin-bottom: var(--gap-lg);
  }

  h1 {
    margin: 0;
    font-size: 28px;
    color: var(--text);
    letter-spacing: -0.02em;
  }

  .subtitle {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 14px;
  }

  .db-status {
    margin: 12px 0 0;
    font-size: 13px;
    font-family: var(--mono);
    color: var(--muted);
  }

  .db-status[data-status='ready'] {
    color: #86efac;
  }

  .db-status[data-status='error'] {
    color: #fca5a5;
  }

  .page-nav {
    position: sticky;
    top: 0;
    z-index: 10;
    background: rgba(11, 12, 16, 0.85);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    margin-bottom: var(--gap-lg);
  }

  .nav-inner {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-lg);
    padding-top: 10px;
    padding-bottom: 10px;
  }

  .nav-inner a {
    color: var(--muted);
    text-decoration: none;
    font-size: 13px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 2px 0;
    border-bottom: 1px solid transparent;
    transition:
      color 0.12s ease,
      border-color 0.12s ease;
  }

  .nav-inner a:hover,
  .nav-inner a:focus-visible {
    color: var(--text);
    border-bottom-color: var(--info);
  }

  main {
    flex: 1;
    padding-bottom: var(--gap-xl);
  }

  /* Historical-view banner: amber/warn tone so the user can't miss that
     the dashboard is in backtest mode. Sticky directly under the
     page-nav (top:0, ~42px tall) so it stays visible while scrolling
     through lower sections — losing track of historical mode mid-scroll
     is a real foot-gun (review Polish #2). When this banner is present
     we push PositionTabs further down via the global rule below. */
  .historical-banner-wrap {
    position: sticky;
    top: 42px;
    z-index: 9;
    background: var(--warn-soft);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border-bottom: 1px solid rgba(245, 158, 11, 0.4);
    /* No bottom margin in historical mode — keeps the sticky stack tight
       against PositionTabs without a transparent gap. */
    margin-bottom: 0;
  }

  /* When the page is in historical mode, shift the sticky PositionTabs
     down by the banner's approximate height (~38px) so the two sticky
     bands stack without overlap. Uses :global() because PositionTabs
     is a child component and its styles are scoped. */
  .page.historical :global(.position-tabs) {
    top: 80px;
  }

  .historical-banner {
    display: flex;
    align-items: center;
    gap: var(--gap);
    padding: 10px var(--gap-lg);
    color: #fde68a;
    font-size: 14px;
    flex-wrap: wrap;
  }

  .historical-banner-arrow {
    font-size: 18px;
    line-height: 1;
    color: #fcd34d;
  }

  .historical-banner-text {
    flex: 1;
    min-width: 0;
  }

  .historical-banner-text strong {
    color: #fef3c7;
    font-family: var(--mono);
  }

  .historical-banner-ago {
    color: #fcd34d;
    margin-left: 4px;
  }

  .historical-banner-button {
    background: rgba(245, 158, 11, 0.2);
    color: #fef3c7;
    border: 1px solid rgba(245, 158, 11, 0.5);
    border-radius: var(--radius-sm);
    padding: 5px 12px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    transition: background 0.12s ease;
  }

  .historical-banner-button:hover {
    background: rgba(245, 158, 11, 0.35);
  }

  .about-block {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 20px;
    color: var(--text-secondary);
  }

  .about-block summary {
    cursor: pointer;
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
    list-style: none;
    user-select: none;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .about-block summary::-webkit-details-marker {
    display: none;
  }

  .about-block summary::before {
    content: '▸';
    color: var(--muted);
    font-size: 11px;
    transition: transform 0.15s ease;
    display: inline-block;
  }

  .about-block[open] > summary::before {
    transform: rotate(90deg);
  }

  .about-body {
    margin-top: 12px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--text-secondary);
  }

  .about-body p {
    margin: 0 0 10px;
  }

  .about-body ul {
    margin: 6px 0 10px;
    padding-left: 18px;
  }

  .about-body code {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text);
    background: var(--surface-inset);
    padding: 1px 5px;
    border-radius: 3px;
  }

  .disclaimer {
    margin-top: var(--gap-xl);
    padding: var(--gap-lg) 0;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
    text-align: center;
    line-height: 1.5;
  }

  .disclaimer p {
    margin: 0 0 6px;
  }

  .disclaimer .meta {
    color: var(--muted-strong);
    font-family: var(--mono);
    font-size: 11px;
  }
</style>
