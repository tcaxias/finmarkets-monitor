<script lang="ts">
  // Sunday weekly-review export panel for the active position.
  //
  // Phase A multi-ticker rewrite: reads from `getEval(activeTicker)` and
  // uses the active position's ticker, vest data, and tax due date.

  import { settings, getActivePosition } from '../lib/settings.svelte';
  import { dataState } from '../lib/data.svelte';
  import { evalState, getEval } from '../lib/evaluation.svelte';
  import { viewState } from '../lib/viewState.svelte';
  import { computeThresholds } from '../lib/math';
  import { generateSundayReview } from '../lib/sundayReview';

  let markdown = $state<string>('');
  let generating = $state(false);
  let loadError = $state<string | null>(null);
  let copyFeedback = $state<string>('');
  let generatedAtFetch = $state<Date | null>(null);
  let generatedAtTicker = $state<string>('');

  const activePosition = $derived.by(() => {
    settings.activePositionId;
    settings.positions.length;
    return getActivePosition();
  });

  const slice = $derived.by(() => {
    if (!activePosition) return null;
    void evalState.byTicker;
    return getEval(activePosition.ticker);
  });

  const ticker = $derived(activePosition?.ticker ?? '');
  const rowCount = $derived(ticker ? (dataState.rowCount[ticker] ?? 0) : 0);
  const tickerLastFetched = $derived(
    ticker ? (dataState.lastFetchedByTicker[ticker] ?? null) : null,
  );

  const canGenerate = $derived(
    !generating &&
      !!activePosition &&
      ticker !== '' &&
      rowCount > 0 &&
      slice?.summary !== null &&
      slice?.summary !== undefined,
  );

  const stale = $derived(
    markdown !== '' &&
      (generatedAtFetch?.getTime() !== tickerLastFetched?.getTime() ||
        generatedAtTicker !== ticker),
  );

  function onGenerate(): void {
    if (!activePosition) return;
    if (!ticker) return;
    if (!slice || !slice.summary) {
      loadError = 'No witness summary available — refresh data first.';
      return;
    }
    if (slice.candles.length === 0) {
      loadError = 'No data available — fetch market data first.';
      return;
    }

    generating = true;
    loadError = null;
    copyFeedback = '';

    try {
      const thresholds = computeThresholds(
        activePosition.vestPrice,
        activePosition.shares,
        activePosition.taxRate,
      );

      // Phase B: in historical view, anchor `reviewDate` to the as-of
      // date so §2 (days-until-tax-due) and §3 ("Friday close") are
      // internally consistent with what the dashboard is showing. The
      // wall-clock generation time is passed separately as `generatedAt`
      // so the auto-fill footer's "Generated at" line still reflects the
      // moment the document was actually produced.
      const asOf = viewState.asOfDate;
      const now = new Date();
      const reviewDate = asOf ? new Date(`${asOf}T12:00:00Z`) : now;

      markdown = generateSundayReview({
        ticker,
        reviewDate,
        thresholds,
        taxDueDate: activePosition.taxDueDate || null,
        candles: slice.candles,
        sma20: slice.sma20,
        sma200: slice.sma200,
        volume: slice.volume,
        rsi: slice.rsi,
        macd: slice.macd,
        witnesses: slice.summary,
        asOfDate: asOf,
        generatedAt: now,
      });

      generatedAtFetch = tickerLastFetched;
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
    const t = (generatedAtTicker || ticker).toLowerCase();
    const filename = `${t}-review-${today}.md`;
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

  {#if !activePosition}
    <div class="placeholder">
      Select a position from the tabs above to generate its weekly review.
    </div>
  {:else}
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
    font-variant-numeric: tabular-nums;
  }
</style>
