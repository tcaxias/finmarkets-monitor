<script lang="ts">
  // Phase A multi-ticker: portfolio overview table.
  //
  // Renders one row per configured position with at-a-glance metrics
  // computed from each position's evaluation slice. Sortable by clicking
  // a header. When a position has no data yet, displays "—" with a hint
  // to refresh.

  import { settings, setActive, type Position } from '../lib/settings.svelte';
  import { getEval } from '../lib/evaluation.svelte';
  import { dataState } from '../lib/data.svelte';
  import { viewState } from '../lib/viewState.svelte';
  import { computeThresholds } from '../lib/math';
  import { getDrawdowns, type DrawdownRow } from '../lib/queries';
  // TickerLinks intentionally NOT imported here — the per-row external
  // links crowded the dense overview table. Kept available in
  // StatusBanner only for now.

  type SortKey =
    | 'ticker'
    | 'price'
    | 'dayChange'
    | 'pcover'
    | 'distance'
    | 'drawdown'
    | 'conviction'
    | 'updated';

  let sortKey = $state<SortKey>('ticker');
  let sortDir = $state<'asc' | 'desc'>('asc');

  // Tick "now" each minute so the relative-time column stays fresh.
  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => {
      now = Date.now();
    }, 60_000);
    return () => clearInterval(id);
  });

  // Per-ticker drawdown from the rolling 252-trading-day high. Computed
  // server-side via a single SQL pass over the ohlcv table — see
  // `getDrawdowns` in queries.ts. We refetch whenever the data
  // watermark changes (any ticker refresh bumps `dataState.lastFetched`)
  // so the column stays in sync with the rest of the table.
  //
  // The fetch is best-effort: a query error leaves the map empty and
  // each row falls through to the "—" placeholder rather than blocking
  // the rest of the panel. We log to console.warn so a developer can
  // see what failed; we intentionally do not surface a UI banner —
  // drawdown is auxiliary, not a blocker for the core overview.
  let drawdowns = $state<Record<string, DrawdownRow>>({});
  $effect(() => {
    // Register dependency on the global lastFetched watermark so the
    // map refreshes after every successful refresh. Reading
    // `settings.positions.length` registers a dep on the position
    // count too, so adding a new ticker triggers a refetch even
    // before its first data refresh (the new ticker just won't be in
    // the result yet — that's fine, falls through to "—").
    void dataState.lastFetched;
    void settings.positions.length;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await getDrawdowns();
        if (cancelled) return;
        const next: Record<string, DrawdownRow> = {};
        for (const r of rows) next[r.ticker] = r;
        drawdowns = next;
      } catch (err) {
        if (cancelled) return;
        // Intentionally non-fatal — drawdown is decorative, not core.
        console.warn('getDrawdowns failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  interface Row {
    pos: Position;
    price: number | null;
    dayChangePct: number | null;
    pcover: number;
    distance: number | null; // price - pcover
    distanceTone: 'good' | 'warn' | 'bad' | 'muted';
    drawdownPct: number | null;
    daysSinceHigh: number | null;
    drawdownTone: 'good' | 'muted' | 'warn' | 'bad';
    conviction: string | null;
    convictionRank: number;
    updated: Date | null;
  }

  /**
   * Map a drawdown percent (≤ 0) to a severity tone. Thresholds match
   * the spec: > -5% green (near high), -5..-15 muted (normal pullback),
   * -15..-30 amber (notable), < -30 red (significant). `null` (no data)
   * collapses to muted.
   */
  function drawdownTone(
    pct: number | null,
  ): 'good' | 'muted' | 'warn' | 'bad' {
    if (pct === null || !Number.isFinite(pct)) return 'muted';
    if (pct > -5) return 'good';
    if (pct > -15) return 'muted';
    if (pct > -30) return 'warn';
    return 'bad';
  }

  // Map conviction enum → numeric rank for sorting (most bullish = 4,
  // most bearish = 0, unknown = -1).
  function convictionRank(c: string | null): number {
    switch (c) {
      case 'high-bullish':
        return 4;
      case 'moderate-bullish':
        return 3;
      case 'neutral':
        return 2;
      case 'moderate-bearish':
        return 1;
      case 'high-bearish':
        return 0;
      default:
        return -1;
    }
  }

  function convictionDotClass(c: string | null): string {
    switch (c) {
      case 'high-bullish':
      case 'moderate-bullish':
        return 'dot dot-bull';
      case 'high-bearish':
      case 'moderate-bearish':
        return 'dot dot-bear';
      case 'neutral':
        return 'dot dot-neutral';
      default:
        return 'dot dot-empty';
    }
  }

  function convictionShort(c: string | null): string {
    switch (c) {
      case 'high-bullish':
        return 'High-bullish';
      case 'moderate-bullish':
        return 'Moderate-bullish';
      case 'high-bearish':
        return 'High-bearish';
      case 'moderate-bearish':
        return 'Moderate-bearish';
      case 'neutral':
        return 'Neutral';
      default:
        return '—';
    }
  }

  const rows = $derived.by((): Row[] => {
    // App.svelte's positions $effect ensures a slice exists for every
    // configured position, so getEval here is a pure read. Iterating
    // settings.positions registers a dependency on the array's identity
    // (added/removed positions trigger re-derive); reading slice
    // properties below registers per-property dependencies for refresh.
    void dataState.lastFetchedByTicker;
    return settings.positions.map((pos) => {
      const slice = getEval(pos.ticker);
      const thresholds = computeThresholds(pos.vestPrice, pos.shares, pos.taxRate);
      const price = slice.latestClose;
      const prev = slice.prevClose;
      const dayChangePct =
        price !== null && prev !== null && prev !== 0 ? ((price - prev) / prev) * 100 : null;
      const distance = price !== null ? price - thresholds.pcover : null;

      // Tone scheme matches StatusBanner: green if comfortably above
      // (>20% headroom on Pcover), amber within 20%, red at/below.
      let distanceTone: 'good' | 'warn' | 'bad' | 'muted' = 'muted';
      if (distance !== null && thresholds.pcover > 0) {
        const headroomPct = (distance / thresholds.pcover) * 100;
        if (distance <= 0) distanceTone = 'bad';
        else if (headroomPct < 20) distanceTone = 'warn';
        else distanceTone = 'good';
      }
      const conviction = slice.summary?.conviction ?? null;
      const dd = drawdowns[pos.ticker];
      const drawdownPct = dd ? dd.drawdownPct : null;
      const daysSinceHigh = dd ? dd.daysSinceHigh : null;
      return {
        pos,
        price,
        dayChangePct,
        pcover: thresholds.pcover,
        distance,
        distanceTone,
        drawdownPct,
        daysSinceHigh,
        drawdownTone: drawdownTone(drawdownPct),
        conviction,
        convictionRank: convictionRank(conviction),
        updated: dataState.lastFetchedByTicker[pos.ticker] ?? null,
      };
    });
  });

  function compareRows(a: Row, b: Row): number {
    const dir = sortDir === 'asc' ? 1 : -1;
    switch (sortKey) {
      case 'ticker':
        return dir * a.pos.ticker.localeCompare(b.pos.ticker);
      case 'price':
        return cmpNullableDirected(a.price, b.price, dir);
      case 'dayChange':
        return cmpNullableDirected(a.dayChangePct, b.dayChangePct, dir);
      case 'pcover':
        return dir * (a.pcover - b.pcover);
      case 'distance':
        return cmpNullableDirected(a.distance, b.distance, dir);
      case 'drawdown':
        return cmpNullableDirected(a.drawdownPct, b.drawdownPct, dir);
      case 'conviction':
        return dir * (a.convictionRank - b.convictionRank);
      case 'updated': {
        const at = a.updated?.getTime() ?? 0;
        const bt = b.updated?.getTime() ?? 0;
        return dir * (at - bt);
      }
    }
  }

  /**
   * Nullable comparator with direction-independent null placement: nulls
   * always sort last regardless of `dir`, so empty/no-data rows stay
   * grouped at the bottom whether the user is sorting asc or desc.
   *
   * The previous implementation multiplied the null comparison by `dir`,
   * which floated nulls to the top in descending mode (review Major #2).
   */
  function cmpNullableDirected(
    a: number | null,
    b: number | null,
    dir: 1 | -1,
  ): number {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return dir * (a - b);
  }

  const sortedRows = $derived([...rows].sort(compareRows));

  function toggleSort(k: SortKey): void {
    if (sortKey === k) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = k;
      sortDir = 'asc';
    }
  }

  function fmtPrice(v: number | null): string {
    if (v === null || !Number.isFinite(v)) return '—';
    return `$${v.toFixed(2)}`;
  }

  function fmtPct(v: number | null): string {
    if (v === null || !Number.isFinite(v)) return '—';
    const sign = v >= 0 ? '+' : '−';
    return `${sign}${Math.abs(v).toFixed(2)}%`;
  }

  function fmtDistance(v: number | null): string {
    if (v === null || !Number.isFinite(v)) return '—';
    const sign = v >= 0 ? '+' : '−';
    return `${sign}$${Math.abs(v).toFixed(2)}`;
  }

  /**
   * Format a drawdown percent as e.g. "−22.4%". Always renders the
   * unicode minus (matches `fmtPct` and `fmtDistance`); a value of 0 or
   * a tiny positive due to FP noise renders as "0.0%" without a sign.
   */
  function fmtDrawdownPct(v: number | null): string {
    if (v === null || !Number.isFinite(v)) return '—';
    if (v >= 0) return '0.0%';
    return `−${Math.abs(v).toFixed(1)}%`;
  }

  function fmtDaysSinceHigh(v: number | null): string {
    if (v === null || !Number.isFinite(v)) return '';
    return v === 0 ? 'at high' : `${v}d`;
  }

  function fmtRelative(d: Date | null): string {
    if (!d) return '—';
    const diffMin = Math.round((now - d.getTime()) / 60_000);
    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin} min ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.round(diffHr / 24);
    return `${diffDay}d ago`;
  }

  function dayDir(v: number | null): 'up' | 'down' | 'flat' | 'none' {
    if (v === null) return 'none';
    if (v > 0) return 'up';
    if (v < 0) return 'down';
    return 'flat';
  }

  function sortIndicator(k: SortKey): string {
    if (sortKey !== k) return '';
    return sortDir === 'asc' ? ' ▲' : ' ▼';
  }

  function jumpInto(id: string): void {
    setActive(id);
  }
</script>

<section class="portfolio-overview">
  <header class="panel-header">
    <h2>Portfolio Overview</h2>
    <div class="header-meta">
      {#if viewState.asOfDate !== null}
        <span class="as-of-tag" title="Historical view active">
          As of {viewState.asOfDate}
        </span>
      {/if}
      <span class="count">
        {settings.positions.length} position{settings.positions.length === 1 ? '' : 's'}
      </span>
    </div>
  </header>

  {#if settings.positions.length === 0}
    <div class="placeholder">
      Add positions in the panel below to populate the portfolio view.
    </div>
  {:else}
    <div class="table-wrap">
      <table class="overview-table">
        <thead>
          <tr>
            <th onclick={() => toggleSort('ticker')}>Ticker{sortIndicator('ticker')}</th>
            <th onclick={() => toggleSort('price')}>Latest Price{sortIndicator('price')}</th>
            <th onclick={() => toggleSort('dayChange')}>Day Change{sortIndicator('dayChange')}</th>
            <th onclick={() => toggleSort('pcover')}>Pcover{sortIndicator('pcover')}</th>
            <th onclick={() => toggleSort('distance')}>Distance{sortIndicator('distance')}</th>
            <th
              onclick={() => toggleSort('drawdown')}
              title="Current % off the rolling 252-trading-day (≈52-week) high"
            >Drawdown{sortIndicator('drawdown')}</th>
            <th onclick={() => toggleSort('conviction')}>Conviction{sortIndicator('conviction')}</th>
            <th onclick={() => toggleSort('updated')}>Last Updated{sortIndicator('updated')}</th>
          </tr>
        </thead>
        <tbody>
          {#each sortedRows as row (row.pos.id)}
            <tr>
              <td class="ticker-cell">
                <button
                  type="button"
                  class="ticker-link"
                  onclick={() => jumpInto(row.pos.id)}
                  title="Open {row.pos.ticker} per-ticker view"
                >
                  {row.pos.ticker}
                </button>
              </td>
              <td class="mono">{fmtPrice(row.price)}</td>
              <td class="mono day-change" data-direction={dayDir(row.dayChangePct)}>
                {fmtPct(row.dayChangePct)}
              </td>
              <td class="mono">{row.pcover > 0 ? fmtPrice(row.pcover) : '—'}</td>
              <td class="mono distance" data-tone={row.distanceTone}>
                {#if row.pcover > 0 && row.distance !== null}
                  {fmtDistance(row.distance)}
                  <span class="cushion-tag">
                    {row.distance >= 0 ? 'cushion' : 'underwater'}
                  </span>
                {:else}
                  —
                {/if}
              </td>
              <td
                class="mono drawdown"
                data-tone={row.drawdownTone}
                title={row.drawdownPct !== null
                  ? `52w high $${(drawdowns[row.pos.ticker]?.rolling52wHigh ?? 0).toFixed(2)} — ${row.daysSinceHigh}d ago`
                  : ''}
              >
                {#if row.drawdownPct !== null}
                  {fmtDrawdownPct(row.drawdownPct)}
                  <span class="dd-days">{fmtDaysSinceHigh(row.daysSinceHigh)}</span>
                {:else}
                  —
                {/if}
              </td>
              <td class="conviction-cell">
                <span class={convictionDotClass(row.conviction)}></span>
                <span>{convictionShort(row.conviction)}</span>
              </td>
              <td class="mono updated-cell">
                {fmtRelative(row.updated)}
                {#if row.updated === null}
                  <span class="hint">refresh data</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .portfolio-overview {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: var(--gap-lg);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-secondary);
    font-size: 14px;
    text-align: left;
  }

  .panel-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }

  h2 {
    margin: 0;
    font-size: 18px;
    color: var(--text);
  }

  .count {
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .header-meta {
    display: inline-flex;
    align-items: center;
    gap: 10px;
  }

  .as-of-tag {
    font-size: 11px;
    font-family: var(--mono);
    color: #fde68a;
    background: var(--warn-soft);
    border: 1px solid rgba(245, 158, 11, 0.4);
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    text-transform: none;
    letter-spacing: 0;
  }

  .placeholder {
    padding: 24px;
    background: rgba(15, 20, 25, 0.6);
    border: 1px dashed var(--border-strong);
    border-radius: 6px;
    color: var(--muted);
    text-align: center;
    font-size: 13px;
  }

  .table-wrap {
    overflow-x: auto;
  }

  .overview-table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }

  .overview-table th {
    text-align: left;
    color: var(--muted);
    font-weight: 500;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 8px;
    border-bottom: 1px solid var(--border-strong);
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
  }

  .overview-table th:hover {
    color: var(--text);
  }

  .overview-table td {
    padding: 10px 8px;
    border-bottom: 1px solid #2a2c35;
    color: var(--text);
    font-size: 13px;
  }

  .overview-table tr:last-child td {
    border-bottom: none;
  }

  .mono {
    font-family: var(--mono);
  }

  .ticker-cell {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .ticker-link {
    background: transparent;
    border: none;
    color: var(--info);
    font-family: var(--mono);
    font-weight: 600;
    font-size: 13px;
    padding: 0;
    cursor: pointer;
    text-decoration: none;
  }

  .ticker-link:hover {
    text-decoration: underline;
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
  .day-change[data-direction='none'] {
    color: var(--muted);
  }

  .distance[data-tone='good'] {
    color: var(--bull);
  }
  .distance[data-tone='warn'] {
    color: var(--warn);
  }
  .distance[data-tone='bad'] {
    color: var(--bear);
  }
  .distance[data-tone='muted'] {
    color: var(--muted);
  }

  .drawdown[data-tone='good'] {
    color: var(--bull);
  }
  .drawdown[data-tone='warn'] {
    color: var(--warn);
  }
  .drawdown[data-tone='bad'] {
    color: var(--bear);
  }
  .drawdown[data-tone='muted'] {
    color: var(--text-secondary);
  }

  .dd-days {
    color: var(--muted);
    font-size: 11px;
    margin-left: 4px;
    font-family: var(--sans);
    letter-spacing: 0;
  }

  .cushion-tag {
    color: var(--muted);
    font-size: 11px;
    text-transform: lowercase;
    margin-left: 4px;
    font-family: var(--sans);
    letter-spacing: 0;
  }

  .conviction-cell {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
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
  .dot-empty {
    background: transparent;
    border: 1px dashed var(--border-strong);
  }

  .updated-cell {
    white-space: nowrap;
  }

  .hint {
    color: var(--muted);
    font-size: 11px;
    font-style: italic;
    margin-left: 6px;
    font-family: var(--sans);
  }
</style>
