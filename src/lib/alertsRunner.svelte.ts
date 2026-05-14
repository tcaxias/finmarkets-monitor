// Thin glue between the per-ticker evaluation cache and the alert
// evaluator + notification surfaces.
//
// Why a separate module instead of inlining into App.svelte:
//   - Testable in isolation (the App.svelte effect is just `void
//     runAlertsForTicker(ticker)`, so the orchestration logic isn't
//     buried in a Svelte component).
//   - Keeps `data.svelte.ts` free of the notifications dependency —
//     the data layer stays focused on Twelve Data + DuckDB writes,
//     while alert evaluation is a downstream concern that fires AFTER
//     the OHLCV insert + indicator refresh + recompute are all done.
//
// The seam: App.svelte has a `$effect` that watches each per-ticker
// slice's `generation` counter. Whenever a recompute lands (the data
// pipeline finishes a refresh and the slice is repopulated), we have
// the freshest in-memory values for close / RSI / MACD / etc. — feed
// them into `evaluateAlerts` and surface any fires.
//
// Drawdown / Pcover are NOT in `PerTickerEval`. We compute them
// here from the slice + a one-shot `getDrawdowns` query (cheap; runs
// only when a slice generation actually advances, not on every UI
// re-render).
//
// Idempotency:
//   The evaluator itself is edge-triggered (won't re-fire while still
//   in the firing zone), so even if this glue is called extra times
//   per refresh it's harmless. We DO de-dupe per-(ticker, generation)
//   anyway to avoid the N extra DB roundtrips that would otherwise
//   accumulate.
//
// Uses Svelte 5 runes — file must end in `.svelte.ts`.

import { evaluateAlerts, type EvaluationContext } from './alerts';
import { getEval } from './evaluation.svelte';
import { getPositionByTicker } from './settings.svelte';
import { getDrawdowns } from './queries';
import { addToast, fireBrowserNotification } from './notifications.svelte';

// Per-ticker dedupe: track the last `generation` we evaluated against,
// so a tight loop of effect re-runs with no actual data change is a
// no-op.
const lastEvaluatedGeneration = new Map<string, number>();

/**
 * Evaluate all enabled alerts for `ticker` against the freshest
 * per-ticker slice. Surfaces any fires as toasts + browser
 * notifications + parity-debug console.info.
 *
 * Safe to call extraneously — it's idempotent within a generation.
 * Best-effort — never throws (alerts are additive functionality and
 * must not break the refresh pipeline).
 */
export async function runAlertsForTicker(ticker: string): Promise<void> {
  const t = ticker.trim().toUpperCase();
  if (!t) return;

  const slice = getEval(t);
  if (slice.candles.length === 0) return; // no data yet

  // Skip in intraday mode — the per-ticker slice's RSI/MACD arrays are
  // empty in 1D, and re-firing on intraday refreshes would also fight
  // the daily-refresh edge-trigger semantics. Alerts evaluate against
  // the daily series only, which matches user mental model ("alert
  // when AAPL CLOSES below $200" means the daily close).
  if (slice.isIntraday) return;

  // Dedupe by generation — if we already ran for this slice version,
  // re-running would just re-update last_state to the same value
  // (no fires emitted, but extra DB writes). Cheap to short-circuit.
  const prevGen = lastEvaluatedGeneration.get(t);
  if (prevGen === slice.generation) return;
  lastEvaluatedGeneration.set(t, slice.generation);

  // Capture the generation we're about to evaluate against. The slice
  // is a Svelte $state proxy that another concurrent runAlertsForTicker
  // can mutate (via a fresher recompute landing while we're awaiting
  // getDrawdowns or evaluateAlerts). Without re-checking the
  // generation across each await boundary, an older run can complete
  // AFTER a newer run and overwrite the rule's `last_state` with
  // stale-context data — which then breaks the next edge-trigger
  // evaluation because the state machine has the wrong baseline.
  //
  // The dedupe map above only handles "same generation called twice"
  // (cheap re-entry); it does NOT handle "newer generation arrived
  // mid-flight". This guard does.
  //
  // Cumulative-review Major #2 (this file).
  const evaluatedGen = slice.generation;
  const isStale = (): boolean => getEval(t).generation !== evaluatedGen;

  // Build the EvaluationContext from the slice. RSI / MACD: take the
  // last point if present, else null. The slice's arrays are clipped
  // to the active timeframe but the LAST element is always the most
  // recent computed value, regardless of window size.
  const close = slice.latestClose;
  if (close === null || !Number.isFinite(close)) return;

  const rsi = slice.rsi.length > 0 ? slice.rsi[slice.rsi.length - 1].value : null;
  const macdHist =
    slice.macd.length > 0 ? slice.macd[slice.macd.length - 1].histogram : null;

  // Distance-from-Pcover requires the position's vest/share/tax to
  // derive Pcover. If the ticker isn't tracked or has no tax overhang
  // configured, leave the metric as null — alerts on this metric
  // simply won't fire for that ticker, which matches the documented
  // semantics (the AlertsPanel UI also disables the metric for
  // tax-untracked positions).
  let distanceFromPcoverPct: number | null = null;
  const position = getPositionByTicker(t);
  if (position && position.vestPrice > 0 && position.shares > 0 && position.taxRate > 0) {
    // Pcover = breakeven-after-tax = vestPrice * (1 + taxRate / (1 - taxRate)).
    // Same formula as math.ts / witnesses.ts. Kept inline rather than
    // imported to avoid a circular import (witnesses.ts may eventually
    // depend on alert evaluation for some downstream feature).
    const denom = 1 - position.taxRate;
    if (denom > 0) {
      const pcover = position.vestPrice * (1 + position.taxRate / denom);
      if (pcover > 0) {
        distanceFromPcoverPct = ((close - pcover) / pcover) * 100;
      }
    }
  }

  // Drawdown — single-ticker filter from the all-tickers query. Cheap
  // (one SQL pass) and we only run it when a slice generation actually
  // advances, so no accidental N+1 over a refreshAll loop.
  let drawdownPct: number | null = null;
  try {
    const drawdowns = await getDrawdowns();
    // Stale-check: if a newer recompute arrived while we were awaiting
    // getDrawdowns, abort — the newer run will compute against fresher
    // data and write its own (correct) last_state. Continuing here
    // would race the newer run's evaluateAlerts UPDATE.
    if (isStale()) return;
    const row = drawdowns.find((d) => d.ticker === t);
    if (row && Number.isFinite(row.drawdownPct)) {
      drawdownPct = row.drawdownPct;
    }
  } catch (err) {
    // getDrawdowns failure is non-fatal — drawdown_pct alerts just
    // won't fire for this tick. Other metrics still evaluate.
    console.warn(`alertsRunner: getDrawdowns failed for ${t}`, err);
  }

  // Belt-and-suspenders stale check before we invest the cost of
  // building the context + evaluating against the DB.
  if (isStale()) return;

  const ctx: EvaluationContext = {
    ticker: t,
    close,
    rsi,
    macdHist,
    distanceFromPcoverPct,
    drawdownPct,
  };

  let fires: Awaited<ReturnType<typeof evaluateAlerts>> = [];
  try {
    fires = await evaluateAlerts(ctx);
  } catch (err) {
    console.warn(`alertsRunner: evaluateAlerts failed for ${t}`, err);
    return;
  }

  // Final stale check: evaluateAlerts itself awaits the DB. If a
  // newer recompute landed mid-flight, the fires we just produced are
  // against stale context — discard rather than surfacing as toasts /
  // notifications / state-mutation. The newer run will produce the
  // correct fires (which may be a superset, subset, or different set
  // entirely) against the fresh context.
  if (isStale()) return;

  // Surface each fire to the user via both surfaces. Browser
  // notification is fire-and-forget — the boolean return tells us if
  // it was shown but we don't act on it (the toast is the always-on
  // backup).
  for (const fire of fires) {
    addToast({
      tone: 'alert',
      title: `Alert — ${fire.ticker}`,
      body: fire.message,
      ttlMs: 30_000,
    });
    fireBrowserNotification(`Alert — ${fire.ticker}`, fire.message, {
      // `tag` deduplicates notifications with the same id at the OS
      // level — if the user gets a fire, dismisses the OS notification,
      // and the same alert fires again later (after a state cycle out
      // and back in), the new notification replaces the dismissed one
      // rather than stacking.
      tag: `finmarkets-alert-${fire.alertId}`,
    });
    // Parity-style debug log so the user can verify in DevTools that
    // an alert actually fired (and at what observed value), matching
    // the [parity] convention from evaluation.svelte.ts.
    console.info(
      `[alert] ${fire.ticker} fired: ${fire.message} (alert_id=${fire.alertId})`,
    );
  }
}

// (resetAlertsRunnerDedupe — useful when the underlying data changes in
// a way that bypasses generation increments (e.g. `clearCache`). Not
// currently called: clearCache also resets the per-ticker slices,
// which makes generation jump from 0 → 1 on the next recompute and
// the dedupe map's stale entry — keyed by the same ticker but with a
// pre-clear generation value — is naturally invalidated by the
// inequality check. Re-export this if a future code path bypasses the
// generation-bump invariant.)
