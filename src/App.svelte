<script lang="ts">
  import SettingsPanel from './components/SettingsPanel.svelte';
  import DataPanel from './components/DataPanel.svelte';
  import ChartPanel from './components/ChartPanel.svelte';
  import StatusBanner from './components/StatusBanner.svelte';
  import { getDb, getVersion } from './lib/duckdb';
  import { refreshState } from './lib/data.svelte';
  import { settings } from './lib/settings.svelte';

  let dbStatus = $state<'loading' | 'ready' | 'error'>('loading');
  let dbVersion = $state<string>('');
  let dbError = $state<string>('');

  $effect(() => {
    (async () => {
      try {
        await getDb();
        dbVersion = await getVersion();
        dbStatus = 'ready';
        // Pull any persisted OPFS data into reactive state so the UI is accurate
        // before the user touches anything.
        await refreshState();
      } catch (err) {
        dbStatus = 'error';
        dbError = err instanceof Error ? err.message : String(err);
        console.error('DuckDB init failed', err);
      }
    })();
  });
</script>

<main>
  <header>
    <h1>AAPL Monitor</h1>
    <p class="subtitle">Personal Reference Tool</p>
    <p class="db-status" data-status={dbStatus}>
      {#if dbStatus === 'loading'}
        Loading DuckDB...
      {:else if dbStatus === 'ready'}
        DuckDB ready (v{dbVersion})
      {:else}
        DuckDB error: {dbError}
      {/if}
    </p>
  </header>

  <SettingsPanel />

  <DataPanel />

  <ChartPanel />

  {#if settings.apiKey.trim() === ''}
    <StatusBanner
      tone="info"
      message="Add your Twelve Data API key in Settings to fetch data."
    />
  {/if}
</main>

<style>
  main {
    max-width: 800px;
    margin: 0 auto;
    padding: 24px 20px 64px;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  header {
    text-align: left;
  }

  h1 {
    margin: 0;
    font-size: 28px;
    color: #f3f4f6;
    letter-spacing: -0.02em;
  }

  .subtitle {
    margin: 4px 0 0;
    color: #9ca3af;
    font-size: 14px;
  }

  .db-status {
    margin: 12px 0 0;
    font-size: 13px;
    font-family: ui-monospace, Consolas, monospace;
    color: #9ca3af;
  }

  .db-status[data-status='ready'] {
    color: #86efac;
  }

  .db-status[data-status='error'] {
    color: #fca5a5;
  }
</style>
