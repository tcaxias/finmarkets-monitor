<script lang="ts">
  // Sunday weekly-review export panel. Renders a "Generate" button that
  // reads the precomputed series + witness summary from `evalState` and
  // produces a pre-filled markdown document mirroring
  // `~/docs/finmarkets/aapl-weekly-review.md`.
  //
  // The generated markdown is shown in a read-only textarea so the user
  // can scroll through it before copying or downloading. Two action
  // buttons:
  //   - Copy to clipboard (uses navigator.clipboard.writeText)
  //   - Download .md (Blob + anchor click)
  //
  // Reactivity: when `dataState.lastFetched` or `settings.ticker` changes
  // after the user has generated a review, we mark the on-screen review
  // as "Stale" so the user knows to regenerate. We don't auto-regenerate
  // because the markdown can be long and the user should make an
  // explicit choice (and may have copied it already).
  //
  // M7 refactor: previously this panel ran its own queries. It now reads
  // from `evalState`, the shared cache populated by App's recompute
  // effect — same data the WitnessPanel and StatusBanner see.

  import { settings } from '../lib/settings.svelte';
  import { dataState } from '../lib/data.svelte';
  import { evalState } from '../lib/evaluation.svelte';
  import { computeThresholds } from '../lib/math';
  import { generateSundayReview } from '../lib/sundayReview';

  let markdown = $state<string>('');
  let generating = $state(false);
  let loadError = $state<string | null>(null);
  let copyFeedback = $state<string>('');
  // Snapshot of the data state at generation time. We compare against
  // current state in `$derived` to know when the on-screen review is stale.
  let generatedAtFetch = $state<Date | null>(null);
  let generatedAtTicker = $state<string>('');

  const canGenerate = $derived(
    !generating &&
      settings.ticker.trim() !== '' &&
      dataState.rowCount > 0 &&
      evalState.summary !== null,
  );

  // Stale when the underlying data has changed since the last generation.
  // Treated as "stale" only after a review has been generated (not on
  // first load); otherwise the badge would always show.
  const stale = $derived(
    markdown !== '' &&
      (generatedAtFetch?.getTime() !== dataState.lastFetched?.getTime() ||
        generatedAtTicker !== settings.ticker),
  );

  function onGenerate(): void {
    const ticker = settings.ticker.trim();
    if (!ticker) return;
    if (!evalState.summary) {
      loadError = 'No witness summary available — refresh data first.';
      return;
    }
    if (evalState.candles.length === 0) {
      loadError = 'No data available — fetch market data first.';
      return;
    }

    generating = true;
    loadError = null;
    copyFeedback = '';

    try {
      const thresholds = computeThresholds(
        settings.vestPrice,
        settings.shares,
        settings.taxRate,
      );

      markdown = generateSundayReview({
        ticker,
        reviewDate: new Date(),
        thresholds,
        taxDueDate: settings.taxDueDate || null,
        candles: evalState.candles,
        sma20: evalState.sma20,
        sma200: evalState.sma200,
        volume: evalState.volume,
        rsi: evalState.rsi,
        macd: evalState.macd,
        witnesses: evalState.summary,
      });

      generatedAtFetch = dataState.lastFetched;
      generatedAtTicker = ticker;
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
      console.error('ReviewExport: generation failed', err);
    } finally {
      generating = false;
    }
  }

  async function onCopy(): Promise<void> {
    if (!markdown) return;
    try {
      await navigator.clipboard.writeText(markdown);
      copyFeedback = 'Copied!';
      // Clear the feedback after a short delay so it doesn't linger.
      setTimeout(() => {
        copyFeedback = '';
      }, 1500);
    } catch (err) {
      copyFeedback = 'Copy failed';
      console.error('ReviewExport: copy failed', err);
    }
  }

  function onDownload(): void {
    if (!markdown) return;
    const today = new Date().toISOString().slice(0, 10);
    const ticker = (generatedAtTicker || settings.ticker).toLowerCase();
    const filename = `${ticker}-review-${today}.md`;
    // Standard Blob → object URL → anchor click pattern. Revoke the URL
    // after the click to avoid leaking the blob.
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
</script>

<section class="review-export" id="review">
  <header class="panel-header">
    <h2>Sunday Weekly Review</h2>
    {#if generating}
      <span class="status">Generating…</span>
    {:else if stale}
      <span class="badge stale">Stale — regenerate</span>
    {/if}
  </header>

  <p class="hint">
    Generates a pre-filled markdown document mirroring the canonical weekly-review
    template. Computed fields are auto-filled; judgment fields stay blank for you to
    complete (~15 minutes).
  </p>

  <div class="row actions">
    <button type="button" onclick={onGenerate} disabled={!canGenerate}>
      {generating ? 'Generating…' : markdown ? 'Regenerate Sunday Review' : 'Generate Sunday Review'}
    </button>
    {#if markdown}
      <button type="button" class="ghost" onclick={onCopy}>
        Copy to clipboard
      </button>
      <button type="button" class="ghost" onclick={onDownload}>
        Download .md
      </button>
      {#if copyFeedback}
        <span class="copy-feedback" aria-live="polite">{copyFeedback}</span>
      {/if}
    {/if}
  </div>

  {#if loadError}
    <div class="banner error" role="alert">{loadError}</div>
  {/if}

  {#if !markdown && !generating}
    <div class="placeholder">
      Click "Generate Sunday Review" to produce a pre-filled markdown document.
    </div>
  {/if}

  {#if markdown}
    <textarea readonly value={markdown} spellcheck="false"></textarea>
  {/if}
</section>

<style>
  .review-export {
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

  .badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .badge.stale {
    background: var(--warn-soft);
    color: #fde68a;
    border: 1px solid rgba(253, 230, 138, 0.4);
  }

  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
  }

  .row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }

  button {
    background: #2563eb;
    color: var(--text);
    border: 1px solid #1d4ed8;
    border-radius: var(--radius-sm);
    padding: 8px 14px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: background 0.12s ease;
  }

  button:hover:not(:disabled) {
    background: #1d4ed8;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  button.ghost {
    background: var(--border);
    border-color: var(--border-strong);
    font-weight: 400;
  }

  button.ghost:hover:not(:disabled) {
    background: var(--border-strong);
  }

  .copy-feedback {
    color: #86efac;
    font-size: 12px;
    margin-left: 4px;
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

  .placeholder {
    padding: 16px;
    background: rgba(15, 20, 25, 0.6);
    border: 1px dashed var(--border-strong);
    border-radius: 6px;
    color: var(--muted);
    text-align: center;
    font-size: 13px;
  }

  textarea {
    width: 100%;
    height: 400px;
    padding: 12px;
    background: var(--surface-inset);
    color: #d1d5db;
    border: 1px solid var(--border);
    border-radius: 6px;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.5;
    resize: vertical;
    box-sizing: border-box;
    /* Tabular numbers keep auto-filled values aligned in monospace. */
    font-variant-numeric: tabular-nums;
  }
</style>
