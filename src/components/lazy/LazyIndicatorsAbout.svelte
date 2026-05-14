<script lang="ts">
  // Lazy loader for IndicatorsAbout. The original component is hidden
  // inside a <details> element collapsed by default, so the indicator
  // description copy (INDICATOR_DESCRIPTIONS) and the panel markup
  // never need to be in the entry chunk for the first paint.

  import { onMount } from 'svelte';
  import type { ComponentType } from 'svelte';

  let Cmp: ComponentType | null = $state(null);
  let loadError: string | null = $state(null);

  onMount(() => {
    import('../IndicatorsAbout.svelte')
      .then((m) => {
        Cmp = m.default as unknown as ComponentType;
      })
      .catch((err) => {
        loadError = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error('LazyIndicatorsAbout: load failed', err);
      });
  });
</script>

{#if loadError}
  <div class="lazy-error" role="alert">
    Failed to load indicator notes: {loadError}
  </div>
{:else if Cmp}
  <!-- Svelte 5 runes mode: components are dynamic by default. Render
       the resolved module's default export directly via the capitalised
       state variable (no `<svelte:component>` shim needed). -->
  <Cmp />
{:else}
  <div class="lazy-loading" aria-live="polite">Loading indicator notes…</div>
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
