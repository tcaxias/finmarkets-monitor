<script lang="ts">
  // Lazy loader for ScreenerPanel. Splits the panel + its sql/screener
  // module into a separate Vite chunk that loads only when this wrapper
  // is mounted (i.e. when the user is on the Portfolio overview tab and
  // the page renders the screener section). The dynamic import() is
  // what tells Vite/rolldown to emit a separate chunk for this branch
  // of the module graph.

  import { onMount } from 'svelte';
  import type { ComponentType } from 'svelte';

  let Cmp: ComponentType | null = $state(null);
  let loadError: string | null = $state(null);

  onMount(() => {
    import('../ScreenerPanel.svelte')
      .then((m) => {
        Cmp = m.default as unknown as ComponentType;
      })
      .catch((err) => {
        loadError = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error('LazyScreenerPanel: load failed', err);
      });
  });
</script>

{#if loadError}
  <div class="lazy-error" role="alert">
    Failed to load Screener: {loadError}
  </div>
{:else if Cmp}
  <!-- Svelte 5 runes mode: components are dynamic by default. Render
       the resolved module's default export directly via the capitalised
       state variable (no `<svelte:component>` shim needed). -->
  <Cmp />
{:else}
  <div class="lazy-loading" aria-live="polite">Loading screener…</div>
{/if}

<style>
  .lazy-loading {
    padding: 20px;
    text-align: center;
    color: var(--muted, #9ca3af);
    font-size: 13px;
  }
  .lazy-error {
    padding: 12px 16px;
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.4);
    border-radius: 6px;
    color: #fca5a5;
    font-size: 13px;
  }
</style>
