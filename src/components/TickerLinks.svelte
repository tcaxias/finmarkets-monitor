<script lang="ts">
  // Compact dropdown of external per-ticker links (Yahoo, MarketWatch,
  // Stocktwits, Earnings Whispers). Used in StatusBanner next to the
  // active ticker pill, and in PortfolioOverview's ticker cell.
  //
  // Renders as a `<details>` so the dropdown state is native and
  // keyboard-accessible — no custom focus trap needed. Click outside
  // the summary closes via native browser handling for inline details.
  //
  // All links open in a new tab with rel="noopener noreferrer".

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
  <details class="ticker-links" data-size={size}>
    <summary aria-label="External links for {ticker}" title="External links">
      <span class="link-icon" aria-hidden="true">↗</span>
      {#if size === 'md'}<span class="links-label">Links</span>{/if}
    </summary>
    <ul class="link-menu" role="menu">
      {#each links as link (link.id)}
        <li role="none">
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            role="menuitem"
          >
            {link.label}
            <span class="ext-icon" aria-hidden="true">↗</span>
          </a>
        </li>
      {/each}
    </ul>
  </details>
{/if}

<style>
  .ticker-links {
    position: relative;
    display: inline-block;
  }

  .ticker-links > summary {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    background: var(--surface-inset, #1a1b22);
    border: 1px solid var(--border, #2e303a);
    border-radius: 4px;
    color: var(--text, #e5e7eb);
    cursor: pointer;
    font-size: 12px;
    line-height: 1.4;
    list-style: none;
    user-select: none;
    transition: background 0.12s ease, border-color 0.12s ease;
  }

  .ticker-links[data-size='sm'] > summary {
    padding: 1px 6px;
    font-size: 11px;
  }

  .ticker-links > summary::-webkit-details-marker {
    display: none;
  }

  .ticker-links > summary::after {
    content: '▾';
    font-size: 9px;
    color: var(--muted, #9ca3af);
  }

  .ticker-links[open] > summary::after {
    content: '▴';
  }

  .ticker-links > summary:hover {
    background: var(--border, #2e303a);
    border-color: var(--border-strong, #3a3d4a);
  }

  .link-icon {
    color: var(--muted, #9ca3af);
    font-size: 11px;
  }

  .links-label {
    color: var(--text, #e5e7eb);
  }

  .link-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 30;
    list-style: none;
    margin: 0;
    padding: 4px;
    background: var(--surface, #0f1419);
    border: 1px solid var(--border-strong, #3a3d4a);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    min-width: 180px;
  }

  .link-menu li {
    margin: 0;
  }

  .link-menu a {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 10px;
    color: var(--text, #e5e7eb);
    text-decoration: none;
    font-size: 13px;
    border-radius: 4px;
    transition: background 0.1s ease;
  }

  .link-menu a:hover,
  .link-menu a:focus-visible {
    background: var(--border, #2e303a);
    outline: none;
  }

  .ext-icon {
    color: var(--muted, #9ca3af);
    font-size: 11px;
  }
</style>
