// Shared evaluation cache.
//
// Centralizes the "fetch all series + compute witnesses" work that was
// previously duplicated in WitnessPanel, ReviewExport, ChartPanel, RsiPanel,
// and MacdPanel. Each consumer can now read from `evalState` instead of
// re-querying DuckDB and re-running the witness math.
//
// This is also the single source of truth for the "live status" that the
// StatusBanner displays — latest close, previous close, witness summary,
// divergence flag.
//
// Reactivity contract: the `recompute()` function is called from a single
// `$effect` in App.svelte that watches `dataState.lastFetched` and
// `settings.ticker`. Existing chart panels still own their own data
// pulls (Lightweight Charts series management is too tightly coupled to
// each panel's lifecycle to refactor in this milestone) — but they read
// from the same DuckDB tables, so the data they see is consistent with
// what evalState reflects.
//
// Uses Svelte 5 runes — file must end in `.svelte.ts`.

import { settings } from './settings.svelte';
import { dataState } from './data.svelte';
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

export interface EvalState {
  loading: boolean;
  error: string | null;
  summary: WitnessSummary | null;
  divergence: DivergenceFlag | null;
  latestClose: number | null;
  prevClose: number | null;
  // Raw series caches so panels can read instead of re-querying.
  candles: Candle[];
  sma20: MaPoint[];
  sma200: MaPoint[];
  volume: VolumeBar[];
  rsi: RsiPoint[];
  macd: MacdPoint[];
  closes: ClosePoint[];
  // Generation counter so consumers can react to "the cache was just
  // refreshed" without watching every individual array reference.
  generation: number;
}

export const evalState = $state<EvalState>({
  loading: false,
  error: null,
  summary: null,
  divergence: null,
  latestClose: null,
  prevClose: null,
  candles: [],
  sma20: [],
  sma200: [],
  volume: [],
  rsi: [],
  macd: [],
  closes: [],
  generation: 0,
});

// Cheap in-flight guard so back-to-back calls from a $effect don't double-fetch.
let inFlight: Promise<void> | null = null;

export async function recompute(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const ticker = settings.ticker.trim();
    if (!ticker) {
      reset();
      return;
    }

    evalState.loading = true;
    evalState.error = null;
    try {
      // Fetch all series in parallel — they're independent reads.
      const [candles, sma20, sma200, volume, closes] = await Promise.all([
        getCandles(ticker),
        getSma(ticker, 20),
        getSma(ticker, 200),
        getVolumeBars(ticker),
        getCloses(ticker),
      ]);

      if (candles.length === 0) {
        reset();
        return;
      }

      // RSI and MACD are computed from `closes` (already fetched above) so
      // we don't double-query the database.
      const rsi = computeRsi(closes, 14);
      const macd = computeMacd(closes, 12, 26, 9);

      const trend = evaluateTrend(candles, sma20, sma200);
      const vol = evaluateVolume(candles, volume);
      const ind = evaluateIndicators(rsi, macd);
      const summary = summarize(trend, vol, ind);

      const divergence = detectRsiDivergence(rsi, closes, 30);

      evalState.candles = candles;
      evalState.sma20 = sma20;
      evalState.sma200 = sma200;
      evalState.volume = volume;
      evalState.rsi = rsi;
      evalState.macd = macd;
      evalState.closes = closes;
      evalState.summary = summary;
      evalState.divergence = divergence;
      evalState.latestClose = candles[candles.length - 1].close;
      evalState.prevClose =
        candles.length >= 2 ? candles[candles.length - 2].close : null;
      evalState.generation += 1;
    } catch (err) {
      evalState.error = err instanceof Error ? err.message : String(err);
      console.error('evaluation: recompute failed', err);
    } finally {
      evalState.loading = false;
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function reset(): void {
  evalState.summary = null;
  evalState.divergence = null;
  evalState.latestClose = null;
  evalState.prevClose = null;
  evalState.candles = [];
  evalState.sma20 = [];
  evalState.sma200 = [];
  evalState.volume = [];
  evalState.rsi = [];
  evalState.macd = [];
  evalState.closes = [];
  evalState.generation += 1;
}

// Re-export dataState for convenience so consumers only import from one place.
export { dataState };
