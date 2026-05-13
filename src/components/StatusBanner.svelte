<script lang="ts">
  // Always-visible at-a-glance status bar. Single horizontal row showing
  // ticker, current price, day change, Pcover headroom, last-fetched
  // timestamp, and the witness conviction dot.
  //
  // All data is read from the shared `evalState` cache (populated by
  // `lib/evaluation.svelte.ts`) and the existing `dataState` / `settings`
  // stores. No queries are issued from this component — it's a pure
  // projection of state computed elsewhere.
  //
  // When no data is loaded we degrade gracefully to a one-line muted
  // message instead of showing dashes everywhere.

  import { evalState } from '../lib/evaluation.svelte';
  import { dataState } from '../lib/data.svelte';
  import { settings } from '../lib/settings.svelte';
  import { computeThresholds } from '../lib/math';

  // Keep a "now" tick so the relative-time string updates without us having
  // to re-poll on every render. One-minute granularity is plenty for a
  // "X minutes ago" display.
  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => {
      now = Date.now();
    }, 60_000);
    return () => clearInterval(id);
  });

  const ticker = $derived(settings.ticker.trim().toUpperCase() || '—');

  const thresholds = $derived(
    computeThresholds(settings.vestPrice, settings.shares, settings.taxRate),
  );

  const hasData = $derived(
    evalState.latestClose !== null && dataState.rowCount > 0,
  );

  const dayChange = $derived.by(() => {
    if (evalState.latestClose === null || evalState.prevClose === null) {
      return null;
    }
    const abs = evalState.latestClose - evalState.prevClose;
    const pct = evalState.prevClose === 0 ? 0 : (abs / evalState.prevClose) * 100;
    return { abs, pct, direction: abs > 0 ? 'up' : abs < 0 ? 'down' : 'flat' };
  });

  // Pcover state: green when comfortably above (>20% headroom), amber when
  // approaching (within 20%), red when at or below. We compute the gap from
  // current price to the cover threshold; positive = cushion, negative =
  // underwater.
  const pcoverState = $derived.by(() => {
    const price = evalState.latestClose;
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
    // > 24h: switch to absolute date+time so the user knows exactly how
    // stale the data is.
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }

  // Map conviction enum → dot-class + short label suitable for the banner.
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
  {#if !hasData}
    <span class="ticker-pill">{ticker}</span>
    <span class="muted-msg">
      Awaiting data — open Settings + Data panels to begin
    </span>
  {:else}
    <span class="ticker-pill">{ticker}</span>

    <span class="price">{fmtPrice(evalState.latestClose)}</span>

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

    <span class="sep" aria-hidden="true"></span>

    <span class="block">
      <span class="block-label">Updated</span>
      <span class="block-value">{fmtTimeAgo(dataState.lastFetched, now)}</span>
    </span>

    <span class="sep" aria-hidden="true"></span>

    <span class="block conviction">
      <span class={convictionDotClass(evalState.summary?.conviction ?? null)}></span>
      <span class="block-value">
        {shortConvictionLabel(evalState.summary?.conviction ?? null)}
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
