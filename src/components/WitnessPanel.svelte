<script lang="ts">
  // Three-witness conviction widget — the most important "at a glance"
  // output for a daily 60-second check. All the heavy lifting (verdict
  // logic, conviction tally) lives in the pure functions in
  // `src/lib/witnesses.ts`; this component is just glue: pull the four
  // underlying series, call the four pure functions, render the result.
  //
  // Reactivity: re-evaluates whenever `dataState.lastFetched` or the
  // selected ticker changes. We read both inside the effect so Svelte 5
  // wires the dependencies correctly even though the work happens inside
  // an async closure (same pattern as RsiPanel/MacdPanel).

  import { settings } from '../lib/settings.svelte';
  import { dataState } from '../lib/data.svelte';
  import { getCandles, getSma, getVolumeBars } from '../lib/queries';
  import { getRsi, getMacd } from '../lib/indicators';
  import {
    evaluateTrend,
    evaluateVolume,
    evaluateIndicators,
    summarize,
    type WitnessSummary,
  } from '../lib/witnesses';

  let summary = $state<WitnessSummary | null>(null);
  let loading = $state(false);
  let loadError = $state<string | null>(null);

  async function recompute(): Promise<void> {
    const ticker = settings.ticker.trim();
    if (!ticker) {
      summary = null;
      return;
    }

    loading = true;
    loadError = null;
    try {
      // Fetch all series in parallel — they're independent reads.
      const [candles, sma20, sma200, volume, rsi, macd] = await Promise.all([
        getCandles(ticker),
        getSma(ticker, 20),
        getSma(ticker, 200),
        getVolumeBars(ticker),
        getRsi(ticker, 14),
        getMacd(ticker, 12, 26, 9),
      ]);

      if (candles.length === 0) {
        summary = null;
        return;
      }

      const trend = evaluateTrend(candles, sma20, sma200);
      const vol = evaluateVolume(candles, volume);
      const ind = evaluateIndicators(rsi, macd);
      summary = summarize(trend, vol, ind);
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
      console.error('WitnessPanel: recompute failed', err);
    } finally {
      loading = false;
    }
  }

  // Recompute on mount and whenever the data state changes. Reading the
  // runes inside the effect body (not just inside the async fn) is what
  // registers them as dependencies.
  $effect(() => {
    const _fetched = dataState.lastFetched;
    const _ticker = settings.ticker;
    const _rowCount = dataState.rowCount;
    void _fetched;
    void _ticker;
    void _rowCount;
    void recompute();
  });

  // Map verdict → dot color class. Kept as a function rather than a Map so
  // unknown values fall through harmlessly to neutral.
  function dotClass(verdict: 'bullish' | 'bearish' | 'neutral'): string {
    if (verdict === 'bullish') return 'dot dot-bullish';
    if (verdict === 'bearish') return 'dot dot-bearish';
    return 'dot dot-neutral';
  }

  // Title-case the verdict for display ("Bullish" not "bullish").
  function verdictLabel(verdict: 'bullish' | 'bearish' | 'neutral'): string {
    return verdict.charAt(0).toUpperCase() + verdict.slice(1);
  }
</script>

<section class="witness-panel">
  <header class="panel-header">
    <h2>Three-Witness Conviction</h2>
    {#if loading}
      <span class="status">Computing…</span>
    {/if}
  </header>

  {#if loadError}
    <div class="banner error" role="alert">Witness evaluation failed: {loadError}</div>
  {/if}

  {#if !summary}
    <div class="placeholder">Awaiting data — refresh to compute witnesses.</div>
  {:else}
    <div class="witness-rows">
      <div class="witness-row">
        <span class="witness-name">Trend</span>
        <span class={dotClass(summary.trend.verdict)}></span>
        <span class="verdict">{verdictLabel(summary.trend.verdict)}</span>
        <span class="reason">{summary.trend.reason}</span>
      </div>

      <div class="witness-row">
        <span class="witness-name">Volume</span>
        <span class={dotClass(summary.volume.verdict)}></span>
        <span class="verdict">{verdictLabel(summary.volume.verdict)}</span>
        <span class="reason">{summary.volume.reason}</span>
      </div>

      <div class="witness-row">
        <span class="witness-name">Indicators</span>
        <span class={dotClass(summary.indicators.verdict)}></span>
        <span class="verdict">{verdictLabel(summary.indicators.verdict)}</span>
        <span class="reason">{summary.indicators.reason}</span>
      </div>
    </div>

    <div class="conviction-box" data-conviction={summary.conviction}>
      <div class="conviction-label">{summary.convictionLabel}</div>
      <div class="conviction-recommendation">{summary.recommendation}</div>
    </div>
  {/if}
</section>

<style>
  .witness-panel {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 20px;
    background: #1a1b22;
    border: 1px solid #2e303a;
    border-radius: 8px;
    color: #e5e7eb;
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
    color: #f3f4f6;
  }

  .status {
    font-size: 12px;
    color: #9ca3af;
  }

  .placeholder {
    padding: 16px;
    background: rgba(15, 20, 25, 0.6);
    border: 1px dashed #3a3d4a;
    border-radius: 6px;
    color: #9ca3af;
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
    background: rgba(239, 68, 68, 0.12);
    border-color: rgba(239, 68, 68, 0.4);
    color: #fca5a5;
  }

  .witness-rows {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* Grid layout keeps the dot, verdict, and reason aligned across the
     three rows regardless of label/reason length. */
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
    color: #9ca3af;
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
    background: #22c55e;
    box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.2);
  }

  .dot-bearish {
    background: #ef4444;
    box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.2);
  }

  .dot-neutral {
    background: #6b7280;
    box-shadow: 0 0 0 2px rgba(107, 114, 128, 0.2);
  }

  .verdict {
    font-weight: 600;
    color: #f3f4f6;
  }

  .reason {
    color: #9ca3af;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  /* Conviction box is the headline output. Color-coded by direction with
     intensity indicating high vs moderate. */
  .conviction-box {
    padding: 14px 16px;
    border-radius: 8px;
    border: 1px solid #2e303a;
    background: #1f2128;
  }

  .conviction-box[data-conviction='high-bullish'] {
    background: rgba(34, 197, 94, 0.18);
    border-color: rgba(34, 197, 94, 0.55);
  }

  .conviction-box[data-conviction='moderate-bullish'] {
    background: rgba(34, 197, 94, 0.08);
    border-color: rgba(34, 197, 94, 0.35);
  }

  .conviction-box[data-conviction='neutral'] {
    background: #23252e;
    border-color: #3a3d4a;
  }

  .conviction-box[data-conviction='moderate-bearish'] {
    background: rgba(239, 68, 68, 0.08);
    border-color: rgba(239, 68, 68, 0.35);
  }

  .conviction-box[data-conviction='high-bearish'] {
    background: rgba(239, 68, 68, 0.18);
    border-color: rgba(239, 68, 68, 0.55);
  }

  .conviction-label {
    font-size: 16px;
    font-weight: 600;
    color: #f3f4f6;
    margin-bottom: 4px;
  }

  .conviction-recommendation {
    font-size: 13px;
    color: #cbd5e1;
  }
</style>
