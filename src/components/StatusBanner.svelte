<script lang="ts">
  // Always-visible at-a-glance status bar for the active position.
  //
  // Phase A multi-ticker rewrite: derives the active position from
  // `settings.activePositionId`, then reads its evaluation slice via
  // `getEval(position.ticker)`. When no position is active (portfolio
  // overview mode) or the active position has no data yet, the banner
  // degrades gracefully to a neutral hint message.

  import { getEval } from '../lib/evaluation.svelte';
  import { dataState } from '../lib/data.svelte';
  import { settings, getActivePosition } from '../lib/settings.svelte';
  import { computeThresholds } from '../lib/math';
  import TickerLinks from './TickerLinks.svelte';

  // Keep a "now" tick so the relative-time string updates without us having
  // to re-poll on every render. One-minute granularity is plenty.
  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => {
      now = Date.now();
    }, 60_000);
    return () => clearInterval(id);
  });

  // Touch the relevant settings slots so the $derived re-runs when the
  // user switches positions or edits one. `getActivePosition()` is a
  // read-only helper, not a rune itself.
  const activePosition = $derived.by(() => {
    settings.activePositionId;
    settings.positions.length;
    return getActivePosition();
  });

  const ticker = $derived(activePosition?.ticker ?? '');

  // App.svelte ensures a slice exists for every configured position via
  // ensureSlice(); getEval is therefore a pure read here and Svelte's
  // reactivity tracks the ticker → slice dependency cleanly.
  const slice = $derived(ticker ? getEval(ticker) : null);

  const thresholds = $derived(
    activePosition
      ? computeThresholds(activePosition.vestPrice, activePosition.shares, activePosition.taxRate)
      : computeThresholds(0, 0, 0),
  );

  const hasData = $derived(
    !!slice && slice.latestClose !== null && (dataState.rowCount[ticker] ?? 0) > 0,
  );

  const dayChange = $derived.by(() => {
    if (!slice) return null;
    if (slice.latestClose === null || slice.prevClose === null) return null;
    const abs = slice.latestClose - slice.prevClose;
    const pct = slice.prevClose === 0 ? 0 : (abs / slice.prevClose) * 100;
    return { abs, pct, direction: abs > 0 ? 'up' : abs < 0 ? 'down' : 'flat' };
  });

  // Pcover state: green when comfortably above (>20% headroom), amber when
  // approaching (within 20%), red when at or below.
  const pcoverState = $derived.by(() => {
    const price = slice?.latestClose ?? null;
    const pcover = thresholds.pcover;
    if (price === null || !Number.isFinite(pcover) || pcover <= 0) {
      return { tone: 'muted' as const, cushion: null as number | null };
    }
    const cushion = price - pcover;
    const headroomPct = pcover > 0 ? (cushion / pcover) * 100 : 0;
    let tone: 'good' | 'warn' | 'bad';
    if (cushion <= 0) tone = 'bad';
    else if (headroomPct < 20) tone = 'warn';
    else tone = 'good';
    return { tone, cushion };
  });

  const lastFetched = $derived(
    ticker ? (dataState.lastFetchedByTicker[ticker] ?? null) : null,
  );

  function fmtPrice(v: number | null): string {
    if (v === null || !Number.isFinite(v)) return '—';
    return `$${v.toFixed(2)}`;
  }

  function fmtSignedPrice(v: number): string {
    const sign = v >= 0 ? '+' : '−';
    return `${sign}$${Math.abs(v).toFixed(2)}`;
  }

  function fmtSignedPct(v: number): string {
    const sign = v >= 0 ? '+' : '−';
    return `${sign}${Math.abs(v).toFixed(2)}%`;
  }

  function fmtTimeAgo(d: Date | null, nowMs: number): string {
    if (!d) return 'Never';
    const diffMs = nowMs - d.getTime();
    const diffMin = Math.round(diffMs / 60_000);
    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin} min ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }

  function convictionDotClass(c: string | null): string {
    switch (c) {
      case 'high-bullish':
      case 'moderate-bullish':
        return 'dot dot-bull';
      case 'high-bearish':
      case 'moderate-bearish':
        return 'dot dot-bear';
      default:
        return 'dot dot-neutral';
    }
  }

  function shortConvictionLabel(c: string | null): string {
    switch (c) {
      case 'high-bullish':
        return 'High-bullish (3/3)';
      case 'moderate-bullish':
        return 'Moderate-bullish (2/3)';
      case 'high-bearish':
        return 'High-bearish (3/3)';
      case 'moderate-bearish':
        return 'Moderate-bearish (2/3)';
      case 'neutral':
        return 'No conviction';
      default:
        return 'Awaiting';
    }
  }
</script>

<section class="status-banner" aria-label="Current position status">
  {#if !activePosition}
    <span class="muted-msg">
      Select a position from the tabs above, or add one in the Positions panel.
    </span>
  {:else if !hasData}
    <span class="ticker-pill">{ticker}</span>
    <TickerLinks {ticker} size="md" />
    <span class="muted-msg">
      Awaiting data — refresh in the Data panel below.
    </span>
  {:else if slice}
    <span class="ticker-pill">{ticker}</span>
    <TickerLinks {ticker} size="md" />

    <span class="price">{fmtPrice(slice.latestClose)}</span>

    {#if dayChange}
      <span class="day-change" data-direction={dayChange.direction}>
        <span class="arrow" aria-hidden="true">
          {dayChange.direction === 'up' ? '▲' : dayChange.direction === 'down' ? '▼' : '▬'}
        </span>
        <span>{fmtSignedPct(dayChange.pct)}</span>
        <span class="abs">({fmtSignedPrice(dayChange.abs)})</span>
        <span class="day-label">today</span>
      </span>
    {/if}

    {#if thresholds.pcover > 0}
      <span class="sep" aria-hidden="true"></span>

      <span class="block">
        <span class="block-label">Pcover</span>
        <span class="block-value" data-tone={pcoverState.tone}>
          {fmtPrice(thresholds.pcover)}
          {#if pcoverState.cushion !== null}
            <span class="cushion">
              ({pcoverState.cushion >= 0 ? '+' : '−'}${Math.abs(pcoverState.cushion).toFixed(2)}
              {pcoverState.cushion >= 0 ? 'cushion' : 'underwater'})
            </span>
          {/if}
        </span>
      </span>
    {/if}

    <span class="sep" aria-hidden="true"></span>

    <span class="block">
      <span class="block-label">Updated</span>
      <span class="block-value">{fmtTimeAgo(lastFetched, now)}</span>
    </span>

    <span class="sep" aria-hidden="true"></span>

    <span class="block conviction">
      <span class={convictionDotClass(slice.summary?.conviction ?? null)}></span>
      <span class="block-value">
        {shortConvictionLabel(slice.summary?.conviction ?? null)}
      </span>
    </span>
  {/if}
</section>

<style>
  .status-banner {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--gap);
    padding: var(--gap) var(--gap-lg);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    font-size: 14px;
    font-variant-numeric: tabular-nums;
  }

  .ticker-pill {
    display: inline-flex;
    align-items: center;
    padding: 2px 10px;
    background: #0a0b10;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.05em;
    color: var(--text);
  }

  .muted-msg {
    color: var(--muted);
    font-size: 13px;
  }

  .price {
    font-size: 22px;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.01em;
  }

  .day-change {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    font-size: 14px;
    font-weight: 500;
  }

  .day-change[data-direction='up'] {
    color: var(--bull);
  }
  .day-change[data-direction='down'] {
    color: var(--bear);
  }
  .day-change[data-direction='flat'] {
    color: var(--muted);
  }

  .arrow {
    font-size: 11px;
  }

  .abs {
    color: var(--muted);
    font-weight: 400;
    font-size: 12px;
  }

  .day-label {
    color: var(--muted);
    font-weight: 400;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .sep {
    width: 1px;
    align-self: stretch;
    background: var(--border);
    margin: 0 4px;
  }

  .block {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
  }

  .block-label {
    color: var(--muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .block-value {
    color: var(--text);
    font-size: 14px;
  }

  .block-value[data-tone='good'] {
    color: var(--bull);
  }
  .block-value[data-tone='warn'] {
    color: var(--warn);
  }
  .block-value[data-tone='bad'] {
    color: var(--bear);
  }
  .block-value[data-tone='muted'] {
    color: var(--muted);
  }

  .cushion {
    font-size: 12px;
    opacity: 0.85;
    margin-left: 2px;
  }

  .conviction {
    align-items: center;
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    display: inline-block;
  }

  .dot-bull {
    background: var(--bull);
    box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.2);
  }
  .dot-bear {
    background: var(--bear);
    box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.2);
  }
  .dot-neutral {
    background: var(--neutral);
    box-shadow: 0 0 0 2px rgba(107, 114, 128, 0.2);
  }
</style>
