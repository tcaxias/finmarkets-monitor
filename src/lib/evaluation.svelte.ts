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
  getEarnings,
  getSma,
  getVwap,
  getVolumeBars,
  getIntradayCandles,
  getIntradayVolumeBars,
  type Candle,
  type EarningsEventRow,
  type MaPoint,
  type VolumeBar,
  type VwapPoint,
} from './queries';
import {
  detectRsiDivergence,
  type RsiPoint,
  type MacdPoint,
  type ClosePoint,
  type DivergenceFlag,
} from './indicators';
import { readRsi, readMacd } from './sqlIndicators';
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
  /** 20-day rolling volume-weighted average price. Daily-only;
   *  empty in intraday mode (same lifecycle as the SMA series). */
  vwap: VwapPoint[];
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
  /**
   * Earnings events visible in the current window (asOf-bounded above
   * and since-bounded below in daily mode). Empty in intraday mode —
   * earnings are a daily-bars annotation; rendering them on a 5-minute
   * intraday view would be visual noise without information value.
   */
  earnings: EarningsEventRow[];
}

// Internal-only — consumers read per-ticker slices via `getEval(ticker)`
// rather than touching the cache root directly. Keeping it un-exported
// prevents components from accidentally subscribing to the whole
// `byTicker` map (every ticker change would re-run their reactivity).
interface EvalState {
  byTicker: Record<string, PerTickerEval>;
}

const evalState = $state<EvalState>({
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
    vwap: [],
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
    earnings: [],
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
        slice.vwap = [];
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
        // Earnings markers don't apply to intraday — they're a daily-
        // chart annotation (one circle per release date). Rendering
        // them on a 5min view would just clutter the price action.
        slice.earnings = [];
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

      const [candles, sma20, sma50, sma200, volume, vwap, rsiFull, macdFull, earnings] =
        await Promise.all([
          getCandles(t, asOf, since),
          getSma(t, 20, asOf, since),
          getSma(t, 50, asOf, since),
          getSma(t, 200, asOf, since),
          getVolumeBars(t, asOf, since),
          // VWAP(20) — same windowing semantics as getSma: warmup
          // bars before `since` are still consumed by the rolling
          // window, only output rows are clipped.
          getVwap(t, 20, asOf, since),
          // Indicators are read from the materialised tables
          // (indicators_rsi / indicators_macd, populated by
          // refreshIndicators after every OHLCV insert — see
          // sqlIndicators.ts and migration v3). We pass `since = null`
          // so we get the full warmup history; the post-clipping below
          // bounds the visible range.
          readRsi(t, asOf, null, 14),
          readMacd(t, asOf, null),
          // Earnings markers — windowed to the visible chart range so
          // a 1M view doesn't render a marker for an earnings release
          // from 18 months ago that's invisible off-screen anyway.
          getEarnings(t, asOf, since),
        ]);

      if (candles.length === 0) {
        // Empty out — keeps existing consumers' "no data" placeholders honest.
        slice.candles = [];
        slice.sma20 = [];
        slice.sma50 = [];
        slice.sma200 = [];
        slice.vwap = [];
        slice.volume = [];
        slice.rsi = [];
        slice.macd = [];
        slice.closes = [];
        slice.summary = null;
        slice.divergence = null;
        slice.earnings = [];
        slice.latestClose = null;
        slice.prevClose = null;
        slice.asOfDate = asOf;
        slice.timeframe = timeframe;
        slice.isIntraday = false;
        slice.generation += 1;
        return;
      }

      // Derive `closes` from `candles` so detectRsiDivergence has the
      // (time, close) shape it expects. With this change `closes` is
      // also clipped to `since` — divergence-detection now operates on
      // the visible window. The lookback=30 default still applies, so
      // for the common 1Y+ timeframes this is identical to the previous
      // "full history" behaviour; only sub-30-bar windows see a
      // difference, and there the new behaviour ("divergence within the
      // visible window") is more intuitive than the old behaviour
      // ("divergence somewhere in your account history").
      const closes: ClosePoint[] = candles.map((c) => ({
        time: c.time,
        close: c.close,
      }));

      // Indicators (rsiFull, macdFull) were read from the materialised
      // tables above with the full warmup history intact (`since = null`
      // on the readRsi/readMacd calls). Witness conviction +
      // divergence detection use the FULL series so the verdict
      // reflects current momentum (the doc-defined "is the recent trend
      // bullish/bearish" question, not "as-of timeframe window").
      // detectRsiDivergence only inspects the most recent N bars
      // internally so this is correct.
      const trend = evaluateTrend(candles, sma20, sma200);
      const vol = evaluateVolume(candles, volume);
      const ind = evaluateIndicators(rsiFull, macdFull);
      const summary = summarize(trend, vol, ind);
      const divergence = detectRsiDivergence(rsiFull, closes, 30);

      // Clip the RSI/MACD arrays handed to the indicator panes so they
      // render the same time window as the price chart (review Major #3).
      // RsiPanel/MacdPanel use Lightweight Charts' fitContent() on their
      // own time scale; without clipping, those panes show a wider range
      // than the candle chart.
      //
      // `since` is an ISO yyyy-mm-dd string OR null (= 'All'); convert
      // to unix seconds for comparison against the indicator points'
      // `time` field. For null we keep the full series.
      const sinceEpoch =
        since !== null ? Math.floor(new Date(`${since}T00:00:00Z`).getTime() / 1000) : null;
      const rsi = sinceEpoch === null ? rsiFull : rsiFull.filter((p) => p.time >= sinceEpoch);
      const macd = sinceEpoch === null ? macdFull : macdFull.filter((p) => p.time >= sinceEpoch);

      slice.candles = candles;
      slice.sma20 = sma20;
      slice.sma50 = sma50;
      slice.sma200 = sma200;
      slice.vwap = vwap;
      slice.volume = volume;
      slice.rsi = rsi;
      slice.macd = macd;
      slice.closes = closes;
      slice.summary = summary;
      slice.divergence = divergence;
      slice.earnings = earnings;
      slice.latestClose = candles[candles.length - 1].close;
      slice.prevClose =
        candles.length >= 2 ? candles[candles.length - 2].close : null;
      slice.asOfDate = asOf;
      slice.timeframe = timeframe;
      slice.isIntraday = false;
      slice.generation += 1;

      // Parity log — emits the latest computed indicator values to the
      // console after every successful daily-path recompute. Lets us
      // cross-check our DuckDB recursive-CTE indicators against
      // reference platforms (investing.com RSI/MACD, TradingView
      // VWMA(20)) without needing a dedicated UI affordance. Open
      // DevTools console, copy the line, paste-compare against the
      // reference. See CHANGELOG for the parity-check workflow + the
      // VWMA-vs-VWAP caveat (TradingView's "VWAP" is session-anchored,
      // not what we compute).
      const lastDt = candles.length > 0
        ? new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 10)
        : 'n/a';
      const lastRsi = rsi.length > 0 ? rsi[rsi.length - 1].value : null;
      const lastMacd = macd.length > 0 ? macd[macd.length - 1] : null;
      const lastVwap = vwap.length > 0 ? vwap[vwap.length - 1].value : null;
      console.debug(
        `[parity] ${t} ${lastDt}: ` +
          `RSI=${lastRsi?.toFixed(2) ?? 'n/a'}, ` +
          `MACD=${lastMacd?.macd.toFixed(3) ?? 'n/a'} ` +
          `signal=${lastMacd?.signal.toFixed(3) ?? 'n/a'} ` +
          `hist=${lastMacd?.histogram.toFixed(3) ?? 'n/a'}, ` +
          `VWAP=${lastVwap?.toFixed(2) ?? 'n/a'}`,
      );
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


