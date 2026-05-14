// Per-ticker Backtest helpers — historical conviction series + a
// catalogue of one-click example queries against the user's own
// OHLCV + materialised-indicator history.
//
// Why this module exists (and why it's per-ticker, not portfolio):
// the screener answers "which positions match this rule today?". A
// backtest answers "how would my methodology have voted on THIS
// position over time?", and "what would a query like X find in this
// position's history?". Both questions are scoped to a single ticker
// (the witness model has no cross-ticker semantics, and the example
// SQL queries are all single-ticker by construction), so this lives
// alongside the per-ticker indicator panes rather than in Portfolio
// mode.
//
// Two surfaces:
//
//   1. `computeHistoricalConviction(ticker, lookbackBars)` — runs the
//      existing pure witness functions in a JS loop, once per bar in
//      the lookback window, slicing the precomputed series up to
//      "as if that bar were today". Output is a `(time, conviction,
//      numeric)` array suitable for a Lightweight Charts step-line
//      with conviction mapped to -2..2.
//
//      Why JS, not SQL? The trend/volume/indicator verdicts are
//      threshold logic over multiple series with state across bars
//      (slope, accumulation/distribution counts, MACD-line sign).
//      Reproducing that in SQL would either need three new
//      materialised tables or a forest of window functions; the JS
//      loop is ~250 iterations of constant-time work over series
//      we already had to fetch for the live witness panel, so it
//      lands sub-100ms in practice. If we ever need 10×–100× longer
//      backtests, materialising witness verdicts to a table is the
//      escape hatch — but until then, JS keeps the existing pure
//      functions as the single source of truth (one definition of
//      "bullish trend", not two).
//
//   2. `BACKTEST_QUERIES` + `runBacktest` — three predefined SQL
//      queries (bullish Fridays, best 30-day windows, RSI extremes
//      with 10-day forward return). Same shape as `screener.ts` —
//      `id`/`label`/`description`/`buildSql`/`columns` — so the panel
//      can render generically.
//
// Security: tickers are validated upstream by `TICKER_RE = /^[A-Z0-9]
// {1,10}$/` (settings.svelte.ts) before reaching this layer.
// `quoteTicker` adds SQL-string escaping as defence in depth, mirroring
// the screener.ts pattern.

import { getConn } from './duckdb';
import {
  getCandles,
  getSma,
  getVolumeBars,
  type Candle,
  type MaPoint,
  type VolumeBar,
} from './queries';
import { readRsi, readMacd } from './sqlIndicators';
import type { RsiPoint, MacdPoint } from './indicators';
import {
  evaluateTrend,
  evaluateVolume,
  evaluateIndicators,
  summarize,
  type Conviction,
} from './witnesses';

// --- Historical conviction ---

/**
 * Numeric mapping for the 5 conviction levels, used to render the
 * verdict series as a step-line on a -2..2 axis. The mapping is
 * symmetric around neutral (0) so the chart's zero line cleanly
 * separates "bullish overall" from "bearish overall".
 *
 * Exported so tests can verify completeness against the `Conviction`
 * union — every member of the union must have an entry here, otherwise
 * a future addition to the witness model would silently render as 0.
 */
export const CONVICTION_NUMERIC: Record<Conviction, number> = {
  'high-bullish': 2,
  'moderate-bullish': 1,
  'neutral': 0,
  'moderate-bearish': -1,
  'high-bearish': -2,
};

export interface HistoricalConvictionPoint {
  /** unix seconds; suitable for Lightweight Charts UTCTimestamp */
  time: number;
  /** ISO yyyy-mm-dd date, for tooltip / table use */
  dt: string;
  /** Conviction label (one of the `Conviction` union members) */
  conviction: Conviction;
  /** -2..2 numeric mapping for the step-line series */
  numeric: number;
}

/**
 * Minimum history required before we'll attempt a historical-conviction
 * series. The trend witness compares price to the 200-day SMA, which
 * itself needs 200 bars of warmup — until then, every iteration would
 * see an empty `sma200` slice and resolve to `neutral` for spurious
 * "no data" reasons. Rather than emit a constant-zero line the panel
 * renders a "need more history" hint when this guard fails.
 */
export const MIN_BARS_FOR_BACKTEST = 200;

/**
 * Compute the witness conviction "as of" each of the last `lookbackBars`
 * trading days for `ticker`.
 *
 * Algorithm:
 *   1. Pull the full price + indicator series for the ticker (one
 *      DuckDB round-trip per series, six in parallel).
 *   2. For each bar i in `[N - lookbackBars, N)`, slice each series
 *      up to (and including) that bar's timestamp, and run the same
 *      `evaluateTrend / evaluateVolume / evaluateIndicators / summarize`
 *      pipeline the live witness panel uses.
 *   3. Emit `(time, dt, conviction, numeric)` for each bar.
 *
 * Returns an empty array when the ticker has fewer than
 * `MIN_BARS_FOR_BACKTEST` bars — see that constant's docstring for
 * why. Callers are expected to detect the empty result and render an
 * appropriate "need more history" message.
 *
 * Performance: lookbackBars × O(W) where W is the witness work per
 * bar (a handful of array reads + arithmetic, dominated by the
 * sma200 .filter scan which is O(N) per iteration → overall
 * O(lookbackBars × N)). For default lookback=250 and N≈500 daily
 * bars this is ~125k ops, sub-100ms in practice. If we ever want a
 * 5-year lookback we'd want to switch the per-iteration .filter to a
 * binary-search slice using the precomputed time-sorted arrays.
 */
export async function computeHistoricalConviction(
  ticker: string,
  lookbackBars: number = 250,
): Promise<HistoricalConvictionPoint[]> {
  // Pull the full series for this ticker — we'll iterate in JS. All
  // queries here are read-only against tables that already exist
  // (ohlcv + materialised indicators_rsi/indicators_macd); fan them
  // out in parallel because the DuckDB connection serializes them
  // anyway but Promise.all makes the intent explicit and lets us
  // measure the slowest query as the wall-clock cost.
  //
  // We pass `null` for asOf/since on each query so we get the entire
  // history. The witness model needs the FULL warmup (sma200 needs
  // 200 bars before the very first bar we evaluate) — windowing here
  // would silently bias the early conviction values toward neutral.
  const [candles, sma20, sma200, volume, rsi, macd] = await Promise.all([
    getCandles(ticker, null, null),
    getSma(ticker, 20, null, null),
    getSma(ticker, 200, null, null),
    getVolumeBars(ticker, null, null),
    readRsi(ticker, null, null, 14),
    readMacd(ticker, null, null),
  ]);

  if (candles.length < MIN_BARS_FOR_BACKTEST) {
    // Not enough history for the SMA200 calc to be meaningful. The UI
    // surface shows a "need more history" hint when this is empty; we
    // intentionally return [] rather than a constant-neutral series so
    // a misleading flat-zero line never gets rendered.
    return [];
  }

  return computeConvictionSeries(
    candles,
    sma20,
    sma200,
    volume,
    rsi,
    macd,
    lookbackBars,
  );
}

/**
 * Pure-function core of `computeHistoricalConviction`. Given the full
 * precomputed series for a ticker, walk the lookback window and emit
 * one HistoricalConvictionPoint per bar.
 *
 * Extracted so it's testable without DuckDB — the unit tests
 * synthesize the input series directly (mirroring witnesses.test.ts)
 * and assert on conviction transitions across deliberately-crafted
 * boundary conditions. The DuckDB-bound `computeHistoricalConviction`
 * is a thin shim over this helper plus the data-fetch + minimum-bars
 * guard.
 *
 * Does NOT enforce the MIN_BARS_FOR_BACKTEST guard — callers passing
 * synthetic data may legitimately want shorter sequences. The
 * production path checks the guard before calling in.
 */
export function computeConvictionSeries(
  candles: Candle[],
  sma20: MaPoint[],
  sma200: MaPoint[],
  volume: VolumeBar[],
  rsi: RsiPoint[],
  macd: MacdPoint[],
  lookbackBars: number = 250,
): HistoricalConvictionPoint[] {
  // Iterate the lookback window. At each bar we slice the series so
  // the witness functions only see bars at-or-before the current bar's
  // timestamp — this is the "as-of" simulation that makes the result
  // trustworthy as a backtest.
  //
  // Performance note: the per-iteration `.filter(p => p.time <= t)`
  // pattern was O(N) per series per iteration, giving O(lookback × N)
  // total. All series are sorted by time ascending (queries.ts and
  // sqlIndicators.ts both `ORDER BY dt`), so a single forward pointer
  // per series advances monotonically — O(N) total per series,
  // O(N) overall. Same outputs, asymptotically faster as the lookback
  // window grows. Tested against the prior implementation in
  // backtest.test.ts (same conviction transitions on synthetic series).
  const startIdx = Math.max(0, candles.length - lookbackBars);
  const out: HistoricalConvictionPoint[] = [];

  // Running pointers — each holds the count of entries with time <= t
  // after the corresponding while-loop runs.
  let sma20Idx = 0;
  let sma200Idx = 0;
  let volumeIdx = 0;
  let rsiIdx = 0;
  let macdIdx = 0;

  for (let i = startIdx; i < candles.length; i++) {
    const candle = candles[i];
    const t = candle.time;

    // Advance each series' pointer past entries whose time <= t. After
    // the loop, each `*Idx` is the count of entries with time <= t.
    // Series are time-sorted ascending so this never has to back up.
    while (sma20Idx < sma20.length && sma20[sma20Idx].time <= t) sma20Idx++;
    while (sma200Idx < sma200.length && sma200[sma200Idx].time <= t) sma200Idx++;
    while (volumeIdx < volume.length && volume[volumeIdx].time <= t) volumeIdx++;
    while (rsiIdx < rsi.length && rsi[rsiIdx].time <= t) rsiIdx++;
    while (macdIdx < macd.length && macd[macdIdx].time <= t) macdIdx++;

    const candlesSlice = candles.slice(0, i + 1);
    const sma20Slice = sma20.slice(0, sma20Idx);
    const sma200Slice = sma200.slice(0, sma200Idx);
    const volumeSlice = volume.slice(0, volumeIdx);
    const rsiSlice = rsi.slice(0, rsiIdx);
    const macdSlice = macd.slice(0, macdIdx);

    const trend = evaluateTrend(candlesSlice, sma20Slice, sma200Slice);
    const vol = evaluateVolume(candlesSlice, volumeSlice);
    const ind = evaluateIndicators(rsiSlice, macdSlice);
    const summary = summarize(trend, vol, ind);

    out.push({
      time: t,
      dt: new Date(t * 1000).toISOString().slice(0, 10),
      conviction: summary.conviction,
      numeric: CONVICTION_NUMERIC[summary.conviction] ?? 0,
    });
  }
  return out;
}

// --- Example backtest queries ---

interface BacktestColumn {
  key: string;
  label: string;
  /**
   * Display formatting hint consumed by BacktestPanel.svelte. Mirrors
   * the screener column shape so the panel can reuse the same
   * formatter helpers.
   *   - 'price'  → `$XX.XX`
   *   - 'pct'    → `+X.X%` / `-X.X%`, colour-coded by sign
   *   - 'number' → `XX.XX` (2 decimals)
   *   - 'date'   → ISO date as-is
   *   - 'string' → as-is
   */
  format?: 'price' | 'pct' | 'number' | 'date' | 'string';
}

export interface BacktestQueryDefinition {
  id: string;
  label: string;
  description: string;
  /**
   * Build the SQL for this query against `ticker`. The ticker is
   * already validated upstream as `/^[A-Z0-9]{1,10}$/`; we still
   * quote-escape via `quoteTicker` as defence in depth (mirrors
   * screener.ts).
   */
  buildSql: (ticker: string) => string;
  columns: BacktestColumn[];
}

export interface BacktestRow {
  [key: string]: string | number | null;
}

/**
 * SQL-string-quote a ticker for interpolation. Mirrors the same
 * helper in screener.ts — duplicated rather than exported so each
 * SQL-builder module owns its own escaping policy and a future
 * change in one doesn't surprise the other.
 */
function quoteTicker(t: string): string {
  return `'${t.replace(/'/g, "''")}'`;
}

export const BACKTEST_QUERIES: BacktestQueryDefinition[] = [
  {
    id: 'bullish-fridays-2025',
    label: 'Bullish Fridays in 2025',
    description:
      'All Fridays during 2025 where the latest RSI(14) was above 50 AND the close was above the 20-day SMA — a simple proxy for "bullish momentum + bullish trend on Friday." Useful for spotting Friday close-strength clusters that historically led into the next week.',
    buildSql: (ticker) => `
      WITH sma20 AS (
        SELECT
          ticker, dt, close,
          AVG(close) OVER (
            PARTITION BY ticker ORDER BY dt
            ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
          ) AS value,
          COUNT(*) OVER (
            PARTITION BY ticker ORDER BY dt
            ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
          ) AS w20
        FROM ohlcv
        WHERE ticker = ${quoteTicker(ticker)}
      )
      SELECT
        s.dt, s.close, s.value AS sma20, r.value AS rsi
      FROM sma20 s
      JOIN indicators_rsi r
        ON r.ticker = s.ticker AND r.dt = s.dt AND r.period = 14
      WHERE EXTRACT('year' FROM s.dt) = 2025
        AND EXTRACT('dow' FROM s.dt) = 5  -- DuckDB: 0=Sunday, 5=Friday
        AND s.w20 >= 20
        AND r.value > 50
        AND s.close > s.value
      ORDER BY s.dt
    `,
    columns: [
      { key: 'dt', label: 'Date', format: 'date' },
      { key: 'close', label: 'Close', format: 'price' },
      { key: 'sma20', label: '20-MA', format: 'price' },
      { key: 'rsi', label: 'RSI', format: 'number' },
    ],
  },
  {
    id: 'best-30d-windows',
    label: 'Best 30-day rolling windows (top 10)',
    description:
      'All rolling 30-trading-day windows ranked by close-to-close return. Highlights the best historical entry points so you can eyeball the regime that produced them (was it a recovery, a breakout, post-news?).',
    buildSql: (ticker) => `
      WITH windows AS (
        SELECT
          dt AS end_dt,
          close AS end_close,
          LAG(dt, 30) OVER (ORDER BY dt) AS start_dt,
          LAG(close, 30) OVER (ORDER BY dt) AS start_close
        FROM ohlcv
        WHERE ticker = ${quoteTicker(ticker)}
      )
      SELECT
        start_dt, end_dt,
        start_close, end_close,
        100.0 * (end_close - start_close) / start_close AS return_pct
      FROM windows
      WHERE start_dt IS NOT NULL
      ORDER BY return_pct DESC
      LIMIT 10
    `,
    columns: [
      { key: 'start_dt', label: 'Start', format: 'date' },
      { key: 'end_dt', label: 'End', format: 'date' },
      { key: 'start_close', label: 'Start $', format: 'price' },
      { key: 'end_close', label: 'End $', format: 'price' },
      { key: 'return_pct', label: 'Return', format: 'pct' },
    ],
  },
  {
    id: 'rsi-extremes-followup',
    label: 'RSI extremes → 10-day forward return',
    description:
      'Every historical bar where RSI(14) was overbought (>70) or oversold (<30), with the close 10 trading days later and the resulting return. Tests the conventional wisdom that RSI extremes mean reversion — strong trends often persist past extremes, so a positive average return after "overbought" days is itself a useful signal.',
    buildSql: (ticker) => `
      WITH ranked AS (
        SELECT
          o.ticker, o.dt, o.close,
          r.value AS rsi,
          ROW_NUMBER() OVER (PARTITION BY o.ticker ORDER BY o.dt) AS rn
        FROM ohlcv o
        JOIN indicators_rsi r
          ON r.ticker = o.ticker AND r.dt = o.dt AND r.period = 14
        WHERE o.ticker = ${quoteTicker(ticker)}
      ),
      with_future AS (
        SELECT
          a.dt AS signal_dt,
          a.rsi,
          CASE WHEN a.rsi > 70 THEN 'overbought' ELSE 'oversold' END AS signal_type,
          a.close AS signal_close,
          b.close AS future_close,
          100.0 * (b.close - a.close) / a.close AS return_pct
        FROM ranked a
        LEFT JOIN ranked b ON b.ticker = a.ticker AND b.rn = a.rn + 10
        WHERE a.rsi > 70 OR a.rsi < 30
      )
      SELECT * FROM with_future
      WHERE future_close IS NOT NULL
      ORDER BY signal_dt DESC
      LIMIT 25
    `,
    columns: [
      { key: 'signal_dt', label: 'Signal date', format: 'date' },
      { key: 'signal_type', label: 'Signal', format: 'string' },
      { key: 'rsi', label: 'RSI', format: 'number' },
      { key: 'signal_close', label: 'At signal', format: 'price' },
      { key: 'future_close', label: '+10 days', format: 'price' },
      { key: 'return_pct', label: 'Return', format: 'pct' },
    ],
  },
  {
    id: 'post-earnings-drift',
    label: 'Post-earnings drift (1/5/20 day forward returns)',
    description:
      "For every historical earnings event, the stock's 1-day, 5-day, and 20-day forward return measured from the close on the earnings date. Bucketed by EPS surprise direction (beat vs miss). Useful for testing whether this ticker tends to follow the initial reaction or fade it. Requires earnings data — refresh the active position to populate.",
    // Implementation notes:
    //   - T=0 close is the close ON the earnings date. For Twelve Data
    //     events with `time_of_day = 'After Market'` the actual price
    //     reaction starts the NEXT trading day, so what we're really
    //     measuring is "+1d after close" → "+2d after close" etc. That's
    //     the right thing for after-hours releases. For 'Before Market'
    //     releases T=0's close already reflects the reaction. v1 keeps
    //     these mixed in the same table; the user can read off the
    //     time_of_day from the earnings panel if they need to bucket
    //     further. Filed away — see CHANGELOG.
    //   - We use ROW_NUMBER over OHLCV (not date-arithmetic) so "+1/+5/
    //     +20 days" mean trading-day offsets, skipping weekends and
    //     holidays. Same approach as the rsi-extremes query above.
    //   - LIMIT 12 keeps the table readable — most tickers have ≤ 8
    //     years of earnings history (32 events), and the most recent
    //     12 are the ones a user is realistically using to update a
    //     prior. If you want the whole record set, run the SQL via
    //     the SQL panel directly.
    buildSql: (ticker) => `
      WITH numbered AS (
        SELECT
          ticker, dt, close,
          ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY dt) AS rn
        FROM ohlcv
        WHERE ticker = ${quoteTicker(ticker)}
      ),
      earnings_with_close AS (
        SELECT
          e.dt AS earnings_dt,
          e.eps_actual,
          e.eps_estimate,
          e.surprise_pct,
          n.rn AS earnings_rn,
          n.close AS earnings_close
        FROM earnings_events e
        JOIN numbered n ON n.ticker = e.ticker AND n.dt = e.dt
        WHERE e.ticker = ${quoteTicker(ticker)}
          AND e.eps_actual IS NOT NULL
      ),
      forwards AS (
        SELECT
          ec.earnings_dt,
          ec.surprise_pct,
          ec.earnings_close,
          ec.eps_actual,
          ec.eps_estimate,
          (SELECT close FROM numbered n2 WHERE n2.rn = ec.earnings_rn + 1) AS close_1d,
          (SELECT close FROM numbered n5 WHERE n5.rn = ec.earnings_rn + 5) AS close_5d,
          (SELECT close FROM numbered n20 WHERE n20.rn = ec.earnings_rn + 20) AS close_20d
        FROM earnings_with_close ec
      )
      SELECT
        earnings_dt,
        eps_actual,
        eps_estimate,
        surprise_pct,
        CASE
          WHEN surprise_pct IS NULL THEN 'unknown'
          WHEN surprise_pct > 0 THEN 'beat'
          ELSE 'miss'
        END AS direction,
        earnings_close,
        100.0 * (close_1d - earnings_close) / earnings_close AS return_1d_pct,
        100.0 * (close_5d - earnings_close) / earnings_close AS return_5d_pct,
        100.0 * (close_20d - earnings_close) / earnings_close AS return_20d_pct
      FROM forwards
      WHERE earnings_close IS NOT NULL
      ORDER BY earnings_dt DESC
      LIMIT 12
    `,
    columns: [
      { key: 'earnings_dt', label: 'Earnings', format: 'date' },
      { key: 'direction', label: 'Surprise', format: 'string' },
      { key: 'surprise_pct', label: 'Surp %', format: 'pct' },
      { key: 'eps_actual', label: 'EPS', format: 'number' },
      { key: 'return_1d_pct', label: '+1d', format: 'pct' },
      { key: 'return_5d_pct', label: '+5d', format: 'pct' },
      { key: 'return_20d_pct', label: '+20d', format: 'pct' },
    ],
  },
];

/**
 * Lookup helper for tests / UI. Returns undefined for an unknown id.
 */
export function getBacktestQueryById(
  id: string,
): BacktestQueryDefinition | undefined {
  return BACKTEST_QUERIES.find((q) => q.id === id);
}

/**
 * Execute a backtest query against the user's DuckDB and return rows
 * shaped for direct rendering. Mirrors `runScreen` in screener.ts —
 * same DuckDB cell-type coercion (BIGINT → Number, DATE → ISO string,
 * everything else pass-through; nulls preserved as null so the panel
 * can render "—").
 */
export async function runBacktest(
  query: BacktestQueryDefinition,
  ticker: string,
): Promise<BacktestRow[]> {
  const conn = await getConn();
  const sql = query.buildSql(ticker);
  const result = await conn.query(sql);
  return result.toArray().map((row) => {
    const r = row.toJSON() as Record<string, unknown>;
    const out: BacktestRow = {};
    for (const col of query.columns) {
      const v = r[col.key];
      if (v == null) {
        out[col.key] = null;
      } else if (typeof v === 'bigint') {
        out[col.key] = Number(v);
      } else if (v instanceof Date) {
        out[col.key] = v.toISOString().slice(0, 10);
      } else {
        out[col.key] = v as string | number;
      }
    }
    return out;
  });
}
