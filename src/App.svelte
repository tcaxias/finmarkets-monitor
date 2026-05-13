<script lang="ts">
  // Application root. Composes the panels in weekly-review order:
  //
  //   Status → Settings → Data → Witnesses → Chart → Indicators → Review
  //
  // Layout uses two width tiers via CSS custom properties (`--col-narrow`
  // for control/text panels, `--col-wide` for charts). All panels live in
  // the same vertical column; only their internal `max-width` differs.
  //
  // Reactivity: a single `$effect` watches `dataState.lastFetched` and
  // `settings.ticker` and triggers `recompute()` on the shared evaluation
  // cache. This is the M7 architectural cleanup — previously each panel
  // ran its own queries; now they all read from `evalState`.

  import StatusBanner from './components/StatusBanner.svelte';
  import SettingsPanel from './components/SettingsPanel.svelte';
  import DataPanel from './components/DataPanel.svelte';
  import WitnessPanel from './components/WitnessPanel.svelte';
  import ChartPanel from './components/ChartPanel.svelte';
  import RsiPanel from './components/RsiPanel.svelte';
  import MacdPanel from './components/MacdPanel.svelte';
  import ReviewExport from './components/ReviewExport.svelte';
  import { getDb, getVersion } from './lib/duckdb';
  import { refreshState, dataState } from './lib/data.svelte';
  import { settings } from './lib/settings.svelte';
  import { evalState, recompute } from './lib/evaluation.svelte';

  let dbStatus = $state<'loading' | 'ready' | 'error'>('loading');
  let dbVersion = $state<string>('');
  let dbError = $state<string>('');

  $effect(() => {
    (async () => {
      try {
        await getDb();
        dbVersion = await getVersion();
        dbStatus = 'ready';
        // Pull any persisted OPFS data into reactive state so the UI is
        // accurate before the user touches anything.
        await refreshState();
      } catch (err) {
        dbStatus = 'error';
        dbError = err instanceof Error ? err.message : String(err);
        console.error('DuckDB init failed', err);
      }
    })();
  });

  // Single recompute trigger for the shared evaluation cache. Reading the
  // runes inside the effect body (not just inside the async fn) is what
  // registers them as dependencies — same pattern as the chart panels.
  $effect(() => {
    const _fetched = dataState.lastFetched;
    const _ticker = settings.ticker;
    const _rowCount = dataState.rowCount;
    void _fetched;
    void _ticker;
    void _rowCount;
    if (dbStatus === 'ready') {
      void recompute();
    }
  });

  // Dynamic document title: "AAPL $20.97 — Monitor". Updates as the latest
  // close changes, so a glance at the browser tab tells the user where price
  // is right now.
  $effect(() => {
    const t = settings.ticker.trim().toUpperCase() || 'Monitor';
    const price = evalState.latestClose;
    if (price !== null && Number.isFinite(price)) {
      document.title = `${t} $${price.toFixed(2)} — Monitor`;
    } else {
      document.title = `${t} — Monitor`;
    }
  });
</script>

<div class="page">
  <header class="site-header">
    <div class="container narrow">
      <h1>AAPL Monitor</h1>
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
      <a href="#settings">Settings</a>
      <a href="#data">Data</a>
      <a href="#witnesses">Witnesses</a>
      <a href="#chart">Chart</a>
      <a href="#indicators">Indicators</a>
      <a href="#review">Review</a>
    </div>
  </nav>

  <main>
    <section class="container narrow stack" id="status">
      <StatusBanner />
    </section>

    <section class="container narrow stack">
      <SettingsPanel />
    </section>

    <section class="container narrow stack" id="data">
      <DataPanel />
    </section>

    <section class="container narrow stack">
      <WitnessPanel />
    </section>

    <!-- Chart gets the full wide column so candles + 200-MA history are
         legible without horizontal scrolling. -->
    <section class="container wide stack" id="chart">
      <ChartPanel />
    </section>

    <section class="container wide stack" id="indicators">
      <RsiPanel />
      <MacdPanel />
    </section>

    <section class="container narrow stack">
      <ReviewExport />
    </section>

    <section class="container narrow stack">
      <details class="about-block">
        <summary>About this app</summary>
        <div class="about-body">
          <p>
            <strong>Finmarkets Monitor</strong> is a personal browser-based dashboard for
            monitoring a single equity position with a tax-overhang exit framework. It
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
              <code>~/docs/finmarkets/aapl-monitoring-guide.md</code> — three-phase
              educational guide
            </li>
            <li>
              <code>~/docs/finmarkets/aapl-weekly-review.md</code> — Sunday
              checklist template
            </li>
          </ul>
          <p>App version 0.1.0 — see README.md for setup and stack details.</p>
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
          App version 0.1.0 · Data: Twelve Data · Storage: DuckDB-WASM (OPFS)
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

  /* `stack` is a vertical-rhythm wrapper so each panel-bearing section
     has consistent breathing room. */
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

  /* Sticky nav bar. Uses backdrop-filter blur so panels scrolling underneath
     stay legible. */
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

  /* About-this-app block — same look as the SettingsPanel summary so the
     two collapsible sections feel of a piece. */
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
