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
// Uses Svelte 5 runes — file must end in `.svelte.ts`.

import { dataState } from './data.svelte';
import { settings } from './settings.svelte';
import { viewState } from './viewState.svelte';
import {
  getCandles,
  getSma,
  getVolumeBars,
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
  };
}

/**
 * Lazily initialize and return the per-ticker slice. Adding a new key to
 * a `$state`-tracked object is reactive in Svelte 5, so consumers that
 * call `getEval(ticker)` from a `$derived` will pick up the slice as soon
 * as it lands.
 */
export function getEval(ticker: string): PerTickerEval {
  const t = ticker.trim().toUpperCase();
  if (!evalState.byTicker[t]) {
    evalState.byTicker[t] = emptySlice();
  }
  return evalState.byTicker[t];
}

// In-flight guard per ticker so back-to-back triggers (e.g. from a
// $effect firing on multiple deps) don't double-fetch the same slice.
const inFlight = new Map<string, Promise<void>>();

/**
 * Recompute everything for one ticker. Pulls candles/MAs/volume/closes in
 * parallel from DuckDB, then runs the indicator + witness math on the
 * in-memory result. Bumps the slice's `generation` counter so chart
 * panels re-render.
 */
export async function recomputeOne(ticker: string): Promise<void> {
  const t = ticker.trim().toUpperCase();
  if (!t) return;

  const existing = inFlight.get(t);
  if (existing) return existing;

  const slice = getEval(t);
  // Snapshot the asOfDate at the start of recompute so the same value is
  // used for every parallel query AND stamped on the slice. Reading
  // viewState mid-flight could race against a user's "Apply" click.
  const asOf = viewState.asOfDate;
  const work = (async () => {
    slice.loading = true;
    slice.error = null;
    try {
      const [candles, sma20, sma200, volume, closes] = await Promise.all([
        getCandles(t, asOf),
        getSma(t, 20, asOf),
        getSma(t, 200, asOf),
        getVolumeBars(t, asOf),
        getCloses(t, asOf),
      ]);

      if (candles.length === 0) {
        // Empty out — keeps existing consumers' "no data" placeholders honest.
        slice.candles = [];
        slice.sma20 = [];
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
      slice.generation += 1;
    } catch (err) {
      slice.error = err instanceof Error ? err.message : String(err);
      console.error(`evaluation: recompute failed for ${t}`, err);
    } finally {
      slice.loading = false;
    }
  })().finally(() => {
    inFlight.delete(t);
  });

  inFlight.set(t, work);
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
