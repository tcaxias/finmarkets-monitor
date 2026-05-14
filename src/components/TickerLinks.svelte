
<script lang="ts">
  // Inline horizontal row of small pill links for the per-ticker
  // external resources (Yahoo, MarketWatch, Stocktwits, Earnings
  // Whispers).
  //
  // Always visible — no dropdown wrapper. The previous `<details>`
  // version hid the links behind an extra click; in StatusBanner the
  // user wants them at-a-glance, so they live as a flat row of pills.
  //
  // The `size` prop is preserved (sm/md) for downstream layouts that
  // may want a denser variant; today both render the same inline-row
  // shape but `sm` shrinks the padding/font slightly. Adjust here, not
  // at the call site.

  import { getExternalLinks } from '../lib/externalLinks';

  interface Props {
    ticker: string;
    /** Visual size variant: 'sm' for table cells, 'md' for the status banner. */
    size?: 'sm' | 'md';
  }

  let { ticker, size = 'md' }: Props = $props();

  const links = $derived(getExternalLinks(ticker));
</script>

{#if links.length > 0}
  <span class="ticker-links" data-size={size}>
    <span class="link-icon" aria-hidden="true">↗</span>
    {#each links as link, i (link.id)}
      {#if i > 0}<span class="sep" aria-hidden="true">·</span>{/if}
      <a
        class="pill"
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`Open ${link.label} in a new tab`}
      >
        {link.label}
      </a>
    {/each}
  </span>
{/if}

<style>
  .ticker-links {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    font-size: 12px;
    line-height: 1.4;
  }

  .ticker-links[data-size='sm'] {
    font-size: 11px;
    gap: 3px;
  }

  .link-icon {
    color: var(--muted, #9ca3af);
    margin-right: 2px;
  }

  .sep {
    color: var(--muted, #9ca3af);
    user-select: none;
  }

  .pill {
    display: inline-block;
    padding: 2px 6px;
    background: var(--surface-inset, #1a1b22);
    border: 1px solid var(--border, #2e303a);
    border-radius: 3px;
    color: var(--text, #e5e7eb);
    text-decoration: none;
    transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
    white-space: nowrap;
  }

  .ticker-links[data-size='sm'] .pill {
    padding: 1px 5px;
  }

  .pill:hover,
  .pill:focus-visible {
    background: var(--border, #2e303a);
    border-color: var(--border-strong, #3a3d4a);
    color: var(--text, #e5e7eb);
    outline: none;
  }
</style>
