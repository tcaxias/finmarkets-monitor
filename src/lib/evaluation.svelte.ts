// Per-ticker evaluation cache.
//
// Phase A multi-ticker rewrite: previously a single set of scalar fields
// keyed off `settings.ticker`. Now `evalState.byTicker[ticker]` holds an
// independent slice per position, so multiple positions can be live in
// the UI at once (Portfolio overview reads them all, per-ticker panels
// read just the active one).
//
// Each slice mirrors the legacy single-ticker shape: candles, MAs,
// volume, RSI, MACD, divergence, witness summary, and a generation
// counter that consumers (chart panels) watch for "the cache refreshed,
// re-render".
//
// Reactivity: `recomputeOne(ticker)` is called per position; `recomputeAll`
// fans across every configured position sequentially. App.svelte's effect
// watches the active position and triggers `recomputeOne` when ticker or
// dataState changes.
//
// Timeframe (chartPrefs.timeframe) participates in the cache key:
//  - '1D' switches to the intraday table and SKIPS indicator math.
//  - All other timeframes pass `since` to the daily queries so they
//    return only the windowed slice (1M/3M/6M/YTD/1Y/2Y/All).
//
// Uses Svelte 5 runes — file must end in `.svelte.ts`.

import { dataState } from './data.svelte';
import { settings } from './settings.svelte';
import { viewState } from './viewState.svelte';
import { chartPrefs, timeframeSince, type Timeframe } from './chartPrefs.svelte';
import {
  getCandles,
  getSma,
  getVolumeBars,
  getIntradayCandles,
  getIntradayVolumeBars,
  type Candle,
  type MaPoint,
  type VolumeBar,
} from './queries';
import {
  getCloses,
  computeRsi,
  computeMacd,
  detectRsiDivergence,
  type RsiPoint,
  type MacdPoint,
  type ClosePoint,
  type DivergenceFlag,
} from './indicators';
import {
  evaluateTrend,
  evaluateVolume,
  evaluateIndicators,
  summarize,
  type WitnessSummary,
} from './witnesses';

export interface PerTickerEval {
  loading: boolean;
  error: string | null;
  generation: number;
  candles: Candle[];
  sma20: MaPoint[];
  sma50: MaPoint[];
  sma200: MaPoint[];
  volume: VolumeBar[];
  rsi: RsiPoint[];
  macd: MacdPoint[];
  closes: ClosePoint[];
  divergence: DivergenceFlag | null;
  summary: WitnessSummary | null;
  latestClose: number | null;
  prevClose: number | null;
  /**
   * The asOfDate this slice was computed against (`null` = live mode).
   * Phase B: lets consumers detect a stale slice when `viewState.asOfDate`
   * has changed but a recompute hasn't landed yet — the App-level effect
   * handles invalidation, but components can still render an "as-of"
   * indicator without re-reading viewState directly.
   */
  asOfDate: string | null;
  /** The timeframe this slice was computed for. */
  timeframe: Timeframe;
  /** True when this slice came from the intraday table (timeframe='1D'). */
  isIntraday: boolean;
}

export interface EvalState {
  byTicker: Record<string, PerTickerEval>;
}

export const evalState = $state<EvalState>({
  byTicker: {},
});

function emptySlice(): PerTickerEval {
  return {
    loading: false,
    error: null,
    generation: 0,
    candles: [],
    sma20: [],
    sma50: [],
    sma200: [],
    volume: [],
    rsi: [],
    macd: [],
    closes: [],
    divergence: null,
    summary: null,
    latestClose: null,
    prevClose: null,
    asOfDate: null,
    timeframe: '1Y',
    isIntraday: false,
  };
}

/**
 * Ensure a slice exists for `ticker`. Idempotent. Call this whenever a
 * new position is added so consumers can read the slice via `getEval()`
 * without worrying about whether the key exists yet.
 *
 * Why this is separate from `getEval()`:
 *   Svelte 5 reactivity tracks property *reads* on `$state` proxies. A
 *   pure read inside a `$derived` registers the dependency. But INSERTING
 *   a new key into the proxy is what originally caused the "not yet
 *   reactive" trap consumers worked around with `void evalState.byTicker`.
 *   By centralising key insertion in this single mutator (called from
 *   App.svelte as positions change) and making `getEval` a pure read, we
 *   eliminate the touch-the-parent dance entirely.
 *
 * Returns the slice so callers can chain operations if needed.
 */
export function ensureSlice(ticker: string): PerTickerEval {
  const t = ticker.trim().toUpperCase();
  if (!evalState.byTicker[t]) {
    evalState.byTicker[t] = emptySlice();
  }
  return evalState.byTicker[t];
}

/**
 * Read the per-ticker slice. Returns the existing slice if present, or a
 * stable empty slice if not. The empty-slice fallback means consumers
 * can safely call `getEval()` for any ticker (even one that hasn't been
 * `ensureSlice`-d yet) without hitting null. They'll see a "no data"
 * shape until the slice is populated by `recomputeOne`.
 *
 * Reactive contract: this is a pure read. Reading any property of the
 * returned object inside a `$derived` will register a dependency on
 * that property — which is what we want for chart panels, status
 * banner, etc. Calling `ensureSlice(ticker)` once (from App.svelte's
 * positions effect) guarantees the slice exists before any consumer
 * reads it.
 */
export function getEval(ticker: string): PerTickerEval {
  const t = ticker.trim().toUpperCase();
  return evalState.byTicker[t] ?? STABLE_EMPTY_SLICE;
}

/**
 * Singleton empty slice returned by `getEval()` when the ticker hasn't
 * been ensured yet. Frozen to make the "do not mutate" contract
 * unambiguous — anyone trying to write here gets a TypeError instead of
 * a confusing silent-corruption bug.
 */
const STABLE_EMPTY_SLICE: PerTickerEval = Object.freeze(emptySlice()) as PerTickerEval;

// In-flight guard per (ticker, asOf, timeframe) tuple so back-to-back
// triggers don't double-fetch the same slice. Switching either the
// date OR the timeframe scopes a fresh request.
const inFlight = new Map<string, Promise<void>>();

function flightKey(ticker: string, asOf: string | null, timeframe: Timeframe): string {
  return `${ticker}|${asOf ?? 'live'}|${timeframe}`;
}

/**
 * Recompute everything for one ticker. Pulls candles/MAs/volume/closes in
 * parallel from DuckDB, then runs the indicator + witness math on the
 * in-memory result. Bumps the slice's `generation` counter so chart
 * panels re-render.
 *
 * Race handling: on completion, re-checks `viewState.asOfDate` against
 * the snapshot used for this run. If they no longer match, schedules a
 * follow-up `recomputeOne` so the slice eventually settles to the
 * current view. Without this, switching dates while a recompute was in
 * flight could leave the UI permanently showing data for the old date.
 *
 * Branching:
 *   - timeframe === '1D' → intraday path: read ohlcv_intraday, skip
 *     SMA/RSI/MACD/witness math (those are daily-only concepts).
 *   - other timeframes → daily path: pass `since` to all queries so
 *     each is windowed to (asOf - tfWindow)..asOf.
 */
export async function recomputeOne(ticker: string): Promise<void> {
  const t = ticker.trim().toUpperCase();
  if (!t) return;

  // Snapshot the asOfDate AND timeframe at the start of recompute so the
  // same values are used for every parallel query AND stamped on the slice.
  const asOf = viewState.asOfDate;
  const timeframe = chartPrefs.timeframe;
  const key = flightKey(t, asOf, timeframe);

  const existing = inFlight.get(key);
  if (existing) return existing;

  const slice = ensureSlice(t);
  const work = (async () => {
    slice.loading = true;
    slice.error = null;
    try {
      if (timeframe === '1D') {
        // Intraday path. Indicator math doesn't apply to 5min bars in
        // any meaningful way (Wilder RSI on intraday is pure noise) so
        // we surface candles + volume only and zero out the rest.
        const [candles, volume] = await Promise.all([
          getIntradayCandles(t, asOf),
          getIntradayVolumeBars(t, asOf),
        ]);

        slice.candles = candles;
        slice.sma20 = [];
        slice.sma50 = [];
        slice.sma200 = [];
        slice.volume = volume;
        slice.rsi = [];
        slice.macd = [];
        slice.closes = [];
        // Keep the existing summary so the StatusBanner conviction
        // dot doesn't flicker to "neutral" when the user toggles 1D —
        // conviction is a daily-bars concept and this view is a
        // momentary live look. If we wanted strict consistency we'd
        // null it; trading off in favour of stable banner UI.
        slice.divergence = null;
        slice.latestClose = candles.length > 0 ? candles[candles.length - 1].close : null;
        slice.prevClose =
          candles.length >= 2 ? candles[candles.length - 2].close : null;
        slice.asOfDate = asOf;
        slice.timeframe = timeframe;
        slice.isIntraday = true;
        slice.generation += 1;
        return;
      }

      // Daily path. Compute the lower bound from the timeframe window
      // anchored to "today" (not asOf — the intent of YTD/1Y is calendar-
      // based, not relative-to-the-historical-snapshot).
      const since = timeframeSince(timeframe, new Date());

      const [candles, sma20, sma50, sma200, volume, closes] = await Promise.all([
        getCandles(t, asOf, since),
        getSma(t, 20, asOf, since),
        getSma(t, 50, asOf, since),
        getSma(t, 200, asOf, since),
        getVolumeBars(t, asOf, since),
        // Closes are pulled WITHOUT `since` so RSI/MACD have warmup
        // history; the resulting indicator series naturally starts
        // earlier than `since` in some cases — the chart's time scale
        // clips the visible range either way.
        getCloses(t, asOf),
      ]);

      if (candles.length === 0) {
        // Empty out — keeps existing consumers' "no data" placeholders honest.
        slice.candles = [];
        slice.sma20 = [];
        slice.sma50 = [];
        slice.sma200 = [];
        slice.volume = [];
        slice.rsi = [];
        slice.macd = [];
        slice.closes = [];
        slice.summary = null;
        slice.divergence = null;
        slice.latestClose = null;
        slice.prevClose = null;
        slice.asOfDate = asOf;
        slice.timeframe = timeframe;
        slice.isIntraday = false;
        slice.generation += 1;
        return;
      }

      const rsi = computeRsi(closes, 14);
      const macd = computeMacd(closes, 12, 26, 9);
      const trend = evaluateTrend(candles, sma20, sma200);
      const vol = evaluateVolume(candles, volume);
      const ind = evaluateIndicators(rsi, macd);
      const summary = summarize(trend, vol, ind);
      const divergence = detectRsiDivergence(rsi, closes, 30);

      slice.candles = candles;
      slice.sma20 = sma20;
      slice.sma50 = sma50;
      slice.sma200 = sma200;
      slice.volume = volume;
      slice.rsi = rsi;
      slice.macd = macd;
      slice.closes = closes;
      slice.summary = summary;
      slice.divergence = divergence;
      slice.latestClose = candles[candles.length - 1].close;
      slice.prevClose =
        candles.length >= 2 ? candles[candles.length - 2].close : null;
      slice.asOfDate = asOf;
      slice.timeframe = timeframe;
      slice.isIntraday = false;
      slice.generation += 1;
    } catch (err) {
      slice.error = err instanceof Error ? err.message : String(err);
      console.error(`evaluation: recompute failed for ${t}`, err);
    } finally {
      slice.loading = false;
    }
  })().finally(() => {
    inFlight.delete(key);
    // Date or timeframe switched mid-flight? Schedule a follow-up so
    // the slice eventually reflects the current view. Done AFTER the
    // map cleanup so the recursive call doesn't see its own promise.
    if (viewState.asOfDate !== asOf || chartPrefs.timeframe !== timeframe) {
      void recomputeOne(t);
    }
  });

  inFlight.set(key, work);
  return work;
}

/**
 * Recompute every configured position. Used after a "Refresh all" cycle
 * or when an unrelated mutation could have invalidated multiple slices
 * (e.g. clearing the cache). Awaits each in turn — the work is mostly
 * I/O against the same DuckDB connection, so parallelism wouldn't buy
 * us much and serial keeps the UI predictable.
 */
export async function recomputeAll(): Promise<void> {
  for (const p of settings.positions) {
    await recomputeOne(p.ticker);
  }
}

// Re-export dataState for convenience so consumers only import from one place.
export { dataState };
