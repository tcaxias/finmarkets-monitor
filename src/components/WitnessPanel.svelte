<script lang="ts">
  // Three-witness conviction widget for the active position.
  //
  // Phase A multi-ticker rewrite: reads from `getEval(activeTicker)` instead
  // of the old singleton evalState. When no position is active (portfolio
  // overview mode) renders a hint placeholder.

  import { getEval } from '../lib/evaluation.svelte';
  import { settings, getActivePosition } from '../lib/settings.svelte';

  const activePosition = $derived.by(() => {
    settings.activePositionId;
    settings.positions.length;
    return getActivePosition();
  });

  // App.svelte ensures slice exists; getEval here is a pure read.
  const slice = $derived(activePosition ? getEval(activePosition.ticker) : null);

  function dotClass(verdict: 'bullish' | 'bearish' | 'neutral'): string {
    if (verdict === 'bullish') return 'dot dot-bullish';
    if (verdict === 'bearish') return 'dot dot-bearish';
    return 'dot dot-neutral';
  }

  function verdictLabel(verdict: 'bullish' | 'bearish' | 'neutral'): string {
    return verdict.charAt(0).toUpperCase() + verdict.slice(1);
  }
</script>

<section class="witness-panel" id="witnesses">
  <header class="panel-header">
    <h2>Three-Witness Conviction</h2>
    {#if slice?.loading}
      <span class="status">Computing…</span>
    {/if}
  </header>

  {#if !activePosition}
    <div class="placeholder">
      Select a position from the tabs above to view its witnesses.
    </div>
  {:else if slice?.error}
    <div class="banner error" role="alert">Witness evaluation failed: {slice.error}</div>
  {:else if !slice?.summary}
    <div class="placeholder">Awaiting data — refresh to compute witnesses.</div>
  {:else}
    <div class="witness-rows">
      <div class="witness-row">
        <span class="witness-name">Trend</span>
        <span class={dotClass(slice.summary.trend.verdict)}></span>
        <span class="verdict">{verdictLabel(slice.summary.trend.verdict)}</span>
        <span class="reason">{slice.summary.trend.reason}</span>
      </div>

      <div class="witness-row">
        <span class="witness-name">Volume</span>
        <span class={dotClass(slice.summary.volume.verdict)}></span>
        <span class="verdict">{verdictLabel(slice.summary.volume.verdict)}</span>
        <span class="reason">{slice.summary.volume.reason}</span>
      </div>

      <div class="witness-row">
        <span class="witness-name">Indicators</span>
        <span class={dotClass(slice.summary.indicators.verdict)}></span>
        <span class="verdict">{verdictLabel(slice.summary.indicators.verdict)}</span>
        <span class="reason">{slice.summary.indicators.reason}</span>
      </div>
    </div>

    <div class="conviction-box" data-conviction={slice.summary.conviction}>
      <div class="conviction-label">{slice.summary.convictionLabel}</div>
      <div class="conviction-recommendation">{slice.summary.recommendation}</div>
    </div>
  {/if}
</section>

<style>
  .witness-panel {
    display: flex;
    flex-direction: column;
    gap: var(--gap);
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

  .status {
    font-size: 12px;
    color: var(--muted);
  }

  .placeholder {
    padding: 16px;
    background: rgba(15, 20, 25, 0.6);
    border: 1px dashed var(--border-strong);
    border-radius: 6px;
    color: var(--muted);
    text-align: center;
    font-size: 13px;
  }

  .banner {
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 13px;
    border: 1px solid transparent;
  }

  .banner.error {
    background: var(--bear-soft);
    border-color: rgba(239, 68, 68, 0.4);
    color: #fca5a5;
  }

  .witness-rows {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .witness-row {
    display: grid;
    grid-template-columns: 100px 14px 80px 1fr;
    align-items: center;
    gap: 10px;
    padding: 8px 4px;
    border-bottom: 1px solid #2a2c35;
  }

  .witness-row:last-child {
    border-bottom: none;
  }

  .witness-name {
    color: var(--muted);
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    display: inline-block;
  }

  .dot-bullish {
    background: var(--bull);
    box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.2);
  }

  .dot-bearish {
    background: var(--bear);
    box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.2);
  }

  .dot-neutral {
    background: var(--neutral);
    box-shadow: 0 0 0 2px rgba(107, 114, 128, 0.2);
  }

  .verdict {
    font-weight: 600;
    color: var(--text);
  }

  .reason {
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .conviction-box {
    padding: 14px 16px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface-2);
  }

  .conviction-box[data-conviction='high-bullish'] {
    background: var(--bull-soft);
    border-color: rgba(34, 197, 94, 0.55);
  }

  .conviction-box[data-conviction='moderate-bullish'] {
    background: rgba(34, 197, 94, 0.08);
    border-color: rgba(34, 197, 94, 0.35);
  }

  .conviction-box[data-conviction='neutral'] {
    background: #23252e;
    border-color: var(--border-strong);
  }

  .conviction-box[data-conviction='moderate-bearish'] {
    background: rgba(239, 68, 68, 0.08);
    border-color: rgba(239, 68, 68, 0.35);
  }

  .conviction-box[data-conviction='high-bearish'] {
    background: var(--bear-soft);
    border-color: rgba(239, 68, 68, 0.55);
  }

  .conviction-label {
    font-size: 16px;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 4px;
  }

  .conviction-recommendation {
    font-size: 13px;
    color: #cbd5e1;
  }
</style>
