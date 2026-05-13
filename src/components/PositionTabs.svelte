<script lang="ts">
  // Sticky tab bar: one tab per configured position plus a "Portfolio"
  // tab that switches to the overview table.
  //
  // Phase A multi-ticker. Keyboard navigation (arrow keys) is supported
  // as a nice-to-have — focus a tab and use Left/Right to move.

  import { settings, setActive } from '../lib/settings.svelte';

  let tabRefs: HTMLButtonElement[] = $state([]);

  function selectPortfolio(): void {
    setActive(null);
  }

  function selectPosition(id: string): void {
    setActive(id);
  }

  function onKey(e: KeyboardEvent, idx: number, total: number): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next =
      e.key === 'ArrowLeft'
        ? (idx - 1 + total) % total
        : (idx + 1) % total;
    tabRefs[next]?.focus();
    tabRefs[next]?.click();
  }

  // Reactive tab list. Index 0 is always Portfolio; positions follow.
  const tabs = $derived.by(() => {
    const list: { id: string | null; label: string }[] = [
      { id: null, label: 'Portfolio' },
    ];
    for (const p of settings.positions) {
      list.push({ id: p.id, label: p.ticker });
    }
    return list;
  });
</script>

<nav class="position-tabs" aria-label="Position tabs">
  <div class="tabs-inner">
    {#if settings.positions.length === 0}
      <span class="hint">Add a position in the Positions panel below.</span>
    {/if}
    {#each tabs as tab, i (tab.id ?? '__portfolio__')}
      {@const isActive =
        tab.id === null
          ? settings.activePositionId === null
          : settings.activePositionId === tab.id}
      <button
        bind:this={tabRefs[i]}
        type="button"
        class="tab"
        class:active={isActive}
        class:portfolio={tab.id === null}
        aria-pressed={isActive}
        onclick={() =>
          tab.id === null ? selectPortfolio() : selectPosition(tab.id)}
        onkeydown={(e) => onKey(e, i, tabs.length)}
      >
        {tab.label}
      </button>
    {/each}
  </div>
</nav>

<style>
  .position-tabs {
    position: sticky;
    /* Sit just below the page-nav (which is at top:0). 42px is roughly
       the page-nav's height including padding — when the viewport scrolls,
       both stay glued. */
    top: 42px;
    z-index: 9;
    background: rgba(11, 12, 16, 0.92);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--border);
    margin-bottom: var(--gap-lg);
  }

  .tabs-inner {
    width: 100%;
    max-width: var(--col-wide);
    margin: 0 auto;
    padding: 8px var(--gap-lg);
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }

  .hint {
    color: var(--muted);
    font-size: 12px;
    font-style: italic;
    margin-right: 8px;
  }

  .tab {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 14px;
    cursor: pointer;
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.03em;
    transition:
      background 0.12s ease,
      color 0.12s ease,
      border-color 0.12s ease;
  }

  .tab:hover {
    background: var(--surface);
    color: var(--text);
  }

  .tab.active {
    background: var(--surface);
    color: var(--text);
    border-color: var(--info);
  }

  .tab.portfolio {
    /* Subtly distinguish the meta tab from per-ticker tabs. */
    text-transform: uppercase;
    font-size: 12px;
    letter-spacing: 0.08em;
  }

  .tab.portfolio.active {
    border-color: var(--bull);
  }
</style>
