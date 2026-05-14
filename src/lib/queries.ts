// Pure SQL query helpers for chart data.
//
// All time values are returned as unix seconds (Number, not BigInt) so they
// can be passed straight to Lightweight Charts as `UTCTimestamp`. DuckDB
// returns BIGINT columns as native JS BigInt; we convert at the boundary.
//
// SMA warmup is filtered server-side via QUALIFY so the partial-window values
// (mathematically wrong as a "true" SMA) never reach the chart.
//
// `asOf` and `since` filters compose: callers may pass either or both.
//   - `asOf`: upper bound on the date column (`dt <= CAST(? AS DATE)`)
//   - `since`: lower bound on the date column (`dt >= CAST(? AS DATE)`)
// Both are CAST to DATE explicitly because DuckDB-WASM's bind-type
// inference would otherwise see a JS string and bind as VARCHAR — comparing
// VARCHAR to DATE triggers the "invalid date" runtime error we hit in af22d1f.

import { getConn } from './duckdb';

export interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface MaPoint {
  time: number;
  value: number;
}

export interface VolumeBar {
  time: number;
  // `null` when the source row had no volume (e.g. older Twelve Data bars
  // sometimes omit the field). Consumers MUST distinguish "no data" from
  // zero — coercing to 0 silently corrupts averages and the
  // accumulation/distribution witness.
  value: number | null;
  color: string;
}

const VOLUME_UP = '#26a69a';
const VOLUME_DOWN = '#ef5350';

// Coerce DuckDB-returned scalars (which may be BigInt for BIGINT columns or
// Number for DOUBLE) to plain Number. Lightweight Charts will silently
// misrender — or throw — if handed a BigInt.
function toNum(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  return Number(v);
}

// Like `toNum` but preserves null/undefined as null. Used for nullable
// columns (volume) where downstream math depends on knowing "missing"
// vs "zero" — a missing bar shouldn't drag a 20-day average down.
function toNullableNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = toNum(v);
  return Number.isFinite(n) ? n : null;
}

// Coerce a DuckDB DATE/TIMESTAMP cell to an ISO-8601 date string
// ("YYYY-MM-DD"). Mirrors `formatDate` in data.svelte.ts; kept local
// here so queries.ts has no dependency on the reactive data layer.
//
// DuckDB-WASM may surface DATE values as JS Date objects, ISO strings,
// or epoch-day integers depending on driver internals — we accept all
// three and emit `''` for anything we can't parse rather than throwing.
function formatDateValue(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) {
    return Number.isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : '';
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return trimmed.slice(0, 10);
    return '';
  }
  if (typeof v === 'number' || typeof v === 'bigint') {
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    // Heuristic: if the magnitude looks like ms-since-epoch keep as-is,
    // otherwise treat it as days-since-epoch (DuckDB's DATE storage).
    const ms = Math.abs(n) > 1_000_000 ? n : n * 86_400_000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  return '';
}

/**
 * Build the WHERE clause and matching parameter array for a daily-table
 * query that's filtered by ticker plus optional asOf upper bound and
 * since lower bound. Centralised so each query function isn't
 * repeating the same five-branch ladder.
 */
function dailyWhere(
  ticker: string,
  asOf: string | null | undefined,
  since: string | null | undefined,
): { clause: string; params: unknown[] } {
  let clause = `WHERE ticker = ?`;
  const params: unknown[] = [ticker];
  if (since) {
    clause += ` AND dt >= CAST(? AS DATE)`;
    params.push(since);
  }
  if (asOf) {
    clause += ` AND dt <= CAST(? AS DATE)`;
    params.push(asOf);
  }
  return { clause, params };
}

export async function getCandles(
  ticker: string,
  asOf?: string | null,
  since?: string | null,
): Promise<Candle[]> {
  const conn = await getConn();
  const { clause, params } = dailyWhere(ticker, asOf, since);
  const sql = `
    SELECT
      epoch(dt)::BIGINT AS time,
      open, high, low, close
    FROM ohlcv
    ${clause}
    ORDER BY dt
  `;
  const stmt = await conn.prepare(sql);
  try {
    const tbl = await stmt.query(...params);
    return tbl.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return {
        time: toNum(r.time),
        open: toNum(r.open),
        high: toNum(r.high),
        low: toNum(r.low),
        close: toNum(r.close),
      };
    });
  } finally {
    await stmt.close();
  }
}

export async function getSma(
  ticker: string,
  period: number,
  asOf?: string | null,
  since?: string | null,
): Promise<MaPoint[]> {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`getSma: period must be a positive integer (got ${period})`);
  }
  const conn = await getConn();
  // `period` is inlined: it's a fixed constant (20/50/200), never user input.
  // Inlining keeps the window-frame syntactically valid (DuckDB rejects bind
  // parameters inside ROWS BETWEEN ... PRECEDING).
  //
  // The `asOf` filter goes inside the SELECT so the SMA window is
  // computed only over bars that existed on that date — otherwise the
  // trailing N rows of the as-of slice would borrow values from the
  // future.
  //
  // The `since` filter is applied as an OUTER predicate (post-window)
  // so the moving average over an N-bar window still uses bars *before*
  // `since` for warmup — only the OUTPUT rows are clipped to the
  // requested range. Filtering inside the window would chop the warmup
  // and produce a leading gap that's mathematically wrong.
  const { clause: asOfClause, params: asOfParams } = dailyWhere(ticker, asOf, null);
  const sql = `
    SELECT * FROM (
      SELECT
        dt,
        epoch(dt)::BIGINT AS time,
        AVG(close) OVER (
          ORDER BY dt
          ROWS BETWEEN ${period - 1} PRECEDING AND CURRENT ROW
        ) AS value
      FROM ohlcv
      ${asOfClause}
      QUALIFY COUNT(*) OVER (
        ORDER BY dt
        ROWS BETWEEN ${period - 1} PRECEDING AND CURRENT ROW
      ) >= ${period}
    )
    ${since ? 'WHERE dt >= CAST(? AS DATE)' : ''}
    ORDER BY dt
  `;
  const params = since ? [...asOfParams, since] : asOfParams;
  const stmt = await conn.prepare(sql);
  try {
    const tbl = await stmt.query(...params);
    return tbl.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return { time: toNum(r.time), value: toNum(r.value) };
    });
  } finally {
    await stmt.close();
  }
}

export interface VwapPoint {
  time: number; // unix seconds
  value: number;
}

/**
 * Rolling N-day Volume-Weighted Average Price.
 *
 *   VWAP_t = SUM(close * volume) / SUM(volume) over the trailing N bars.
 *
 * Returns one point per bar where N preceding bars are available
 * (warmup window: skips bars where the rolling window isn't full,
 * matching the SMA contract above).
 *
 * Uses DuckDB's window functions; no recursive CTE needed — VWAP is
 * just a weighted moving average, not a smoothed indicator like
 * RSI/MACD where each value depends on the previous.
 *
 * Volume can be NULL for some bars (Twelve Data occasionally returns
 * empty volume — see `toNullableNum` in this file). Bars with NULL
 * volume contribute 0 to both numerator and denominator via
 * COALESCE, which is the correct behavior — they're effectively
 * skipped from the weighted average rather than crashing the query
 * or polluting the result with NULL arithmetic.
 *
 * `asOf` and `since` follow the same windowing rules as `getSma`:
 * `asOf` filters inside the SELECT (so the rolling window doesn't
 * borrow from the future), `since` is applied as an outer predicate
 * (so the N-bar warmup still uses bars before `since` — only the
 * OUTPUT rows are clipped to the requested range).
 */
export async function getVwap(
  ticker: string,
  period: number = 20,
  asOf?: string | null,
  since?: string | null,
): Promise<VwapPoint[]> {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`getVwap: period must be a positive integer (got ${period})`);
  }
  const conn = await getConn();
  // `period` is inlined for the same reason as `getSma`: it's a fixed
  // constant (20), never user input, and DuckDB rejects bind parameters
  // inside ROWS BETWEEN ... PRECEDING.
  const { clause: asOfClause, params: asOfParams } = dailyWhere(ticker, asOf, null);
  const sql = `
    SELECT * FROM (
      WITH w AS (
        SELECT
          dt,
          epoch(dt)::BIGINT AS time,
          SUM(COALESCE(close * volume, 0)) OVER (
            ORDER BY dt
            ROWS BETWEEN ${period - 1} PRECEDING AND CURRENT ROW
          ) AS num,
          SUM(COALESCE(volume, 0)) OVER (
            ORDER BY dt
            ROWS BETWEEN ${period - 1} PRECEDING AND CURRENT ROW
          ) AS den,
          COUNT(*) OVER (
            ORDER BY dt
            ROWS BETWEEN ${period - 1} PRECEDING AND CURRENT ROW
          ) AS w_size
        FROM ohlcv
        ${asOfClause}
      )
      SELECT dt, time, num / NULLIF(den, 0) AS value
      FROM w
      WHERE w_size >= ${period} AND den > 0
    )
    ${since ? 'WHERE dt >= CAST(? AS DATE)' : ''}
    ORDER BY dt
  `;
  const params = since ? [...asOfParams, since] : asOfParams;
  const stmt = await conn.prepare(sql);
  try {
    const tbl = await stmt.query(...params);
    return tbl.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return { time: toNum(r.time), value: toNum(r.value) };
    });
  } finally {
    await stmt.close();
  }
}

export async function getVolumeBars(
  ticker: string,
  asOf?: string | null,
  since?: string | null,
): Promise<VolumeBar[]> {
  const conn = await getConn();
  const { clause, params } = dailyWhere(ticker, asOf, since);
  const sql = `
    SELECT
      epoch(dt)::BIGINT AS time,
      volume,
      close >= open AS up
    FROM ohlcv
    ${clause}
    ORDER BY dt
  `;
  const stmt = await conn.prepare(sql);
  try {
    const tbl = await stmt.query(...params);
    return tbl.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return {
        time: toNum(r.time),
        value: toNullableNum(r.volume),
        color: r.up ? VOLUME_UP : VOLUME_DOWN,
      };
    });
  } finally {
    await stmt.close();
  }
}

/**
 * Intraday candles for the active trading session (or for `asOf`'s
 * date when historical-view mode is on).
 *
 * Time is returned in unix seconds (matching the other query functions)
 * so Lightweight Charts can use it directly as `UTCTimestamp`. The
 * chart consumer is expected to enable `timeVisible: true` on its time
 * scale so the bar timestamps render with HH:MM granularity.
 */
export async function getIntradayCandles(
  ticker: string,
  asOf?: string | null,
): Promise<Candle[]> {
  const conn = await getConn();
  // Always bound by date. When `asOf` is set use it; otherwise restrict
  // to today (CURRENT_DATE). This prevents prior sessions persisted in
  // OPFS from leaking into the live "1D" view (review Major #2).
  const sql = asOf
    ? `SELECT
         epoch(ts)::BIGINT AS time,
         open, high, low, close
       FROM ohlcv_intraday
       WHERE ticker = ? AND date(ts) = CAST(? AS DATE)
       ORDER BY ts`
    : `SELECT
         epoch(ts)::BIGINT AS time,
         open, high, low, close
       FROM ohlcv_intraday
       WHERE ticker = ? AND date(ts) = CURRENT_DATE
       ORDER BY ts`;
  const stmt = await conn.prepare(sql);
  try {
    const tbl = asOf ? await stmt.query(ticker, asOf) : await stmt.query(ticker);
    return tbl.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return {
        time: toNum(r.time),
        open: toNum(r.open),
        high: toNum(r.high),
        low: toNum(r.low),
        close: toNum(r.close),
      };
    });
  } finally {
    await stmt.close();
  }
}

/**
 * Intraday volume bars (5-minute granularity by default). Same shape
 * as `getVolumeBars` — colour-coded by per-bar direction.
 */
export async function getIntradayVolumeBars(
  ticker: string,
  asOf?: string | null,
): Promise<VolumeBar[]> {
  const conn = await getConn();
  // Same date-bounding policy as getIntradayCandles: live mode must
  // restrict to CURRENT_DATE so prior sessions don't leak.
  const sql = asOf
    ? `SELECT
         epoch(ts)::BIGINT AS time,
         volume,
         close >= open AS up
       FROM ohlcv_intraday
       WHERE ticker = ? AND date(ts) = CAST(? AS DATE)
       ORDER BY ts`
    : `SELECT
         epoch(ts)::BIGINT AS time,
         volume,
         close >= open AS up
       FROM ohlcv_intraday
       WHERE ticker = ? AND date(ts) = CURRENT_DATE
       ORDER BY ts`;
  const stmt = await conn.prepare(sql);
  try {
    const tbl = asOf ? await stmt.query(ticker, asOf) : await stmt.query(ticker);
    return tbl.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return {
        time: toNum(r.time),
        value: toNullableNum(r.volume),
        color: r.up ? VOLUME_UP : VOLUME_DOWN,
      };
    });
  } finally {
    await stmt.close();
  }
}

export interface EarningsEventRow {
  /** ISO yyyy-mm-dd date string for table display. */
  dt: string;
  /** Unix seconds for chart marker placement (matches the candle series time axis). */
  time: number;
  timeOfDay: string | null;
  epsEstimate: number | null;
  epsActual: number | null;
  surprisePct: number | null;
}

/**
 * Earnings events for `ticker`, optionally bounded by `asOf` (upper)
 * and `since` (lower) date filters. Same composition contract as
 * `getCandles` so chart consumers can pass the same window args and
 * get markers aligned to the visible bar range.
 *
 * `asOf` matters in historical-view mode (we don't want a marker for
 * an earnings release that hadn't happened yet on the as-of date).
 * `since` clips earnings older than the visible chart window so the
 * marker plugin doesn't emit a thousand circles when the user is on
 * a 1M view.
 */
export async function getEarnings(
  ticker: string,
  asOf?: string | null,
  since?: string | null,
): Promise<EarningsEventRow[]> {
  const conn = await getConn();
  let clause = `WHERE ticker = ?`;
  const params: unknown[] = [ticker];
  if (since) {
    clause += ` AND dt >= CAST(? AS DATE)`;
    params.push(since);
  }
  if (asOf) {
    clause += ` AND dt <= CAST(? AS DATE)`;
    params.push(asOf);
  }
  const sql = `
    SELECT
      dt,
      epoch(dt)::BIGINT AS time,
      time_of_day,
      eps_estimate,
      eps_actual,
      surprise_pct
    FROM earnings_events
    ${clause}
    ORDER BY dt
  `;
  const stmt = await conn.prepare(sql);
  try {
    const tbl = await stmt.query(...params);
    return tbl.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      const timeOfDayRaw = r.time_of_day;
      return {
        dt: formatDateValue(r.dt),
        time: toNum(r.time),
        timeOfDay:
          typeof timeOfDayRaw === 'string' && timeOfDayRaw.trim()
            ? timeOfDayRaw
            : null,
        epsEstimate: toNullableNum(r.eps_estimate),
        epsActual: toNullableNum(r.eps_actual),
        surprisePct: toNullableNum(r.surprise_pct),
      };
    });
  } finally {
    await stmt.close();
  }
}

// `getCurrentSnapshot` (a wrapper over the `current_snapshot` view from
// migration v2) used to live here as infrastructure for the Screener
// panel. It went unused — the Screener now reads `current_snapshot`
// directly via its own query path — and was removed to keep this module
// to "what the UI actually calls". The view itself is still maintained
// by migrations (other call sites depend on it).

export interface DrawdownRow {
  ticker: string;
  latestClose: number;
  rolling52wHigh: number;
  /** <= 0; e.g. -22.4 means the latest close is 22.4% off the 52-week high. */
  drawdownPct: number;
  /** 0 = at the high; counts trading bars since the high was set. */
  daysSinceHigh: number;
}

/**
 * Per-ticker drawdown from the rolling 252-trading-day high.
 *
 * Uses MAX(close) OVER (... 251 PRECEDING AND CURRENT ROW) so the
 * window is exactly the trailing 252 bars (~52 weeks of trading days).
 * If the ticker has fewer than 252 bars in the table, the window
 * gracefully degrades to whatever's available — useful for newly-added
 * positions without faking "no drawdown."
 *
 * `daysSinceHigh` is computed as the count of bars strictly between the
 * most recent bar that achieved the rolling high and the latest bar
 * (inclusive of the latest). 0 means the latest bar IS the high.
 *
 * Returns one row per ticker that has at least 1 bar; empty array if
 * the ohlcv table is empty. No `asOf` parameter — drawdown reflects the
 * latest persisted bar regardless of historical-view state. (If we ever
 * want historical drawdown, add an asOf upper bound on the inner CTE.)
 */
export async function getDrawdowns(): Promise<DrawdownRow[]> {
  const conn = await getConn();
  const result = await conn.query(`
    WITH ranked AS (
      SELECT
        ticker,
        dt,
        close,
        MAX(close) OVER (
          PARTITION BY ticker ORDER BY dt
          ROWS BETWEEN 251 PRECEDING AND CURRENT ROW
        ) AS rolling_high,
        ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY dt DESC) AS rn
      FROM ohlcv
    ),
    high_dates AS (
      -- For each ticker, find the most recent date the rolling_high was
      -- actually achieved within the trailing-252 window. We restrict to
      -- the latest 252 bars per ticker (rn <= 252) so an ancient all-time
      -- high doesn't get picked up after it has rolled out of the window.
      SELECT
        ticker,
        MAX(dt) AS high_dt
      FROM ranked
      WHERE rn <= 252 AND close = rolling_high
      GROUP BY ticker
    )
    SELECT
      r.ticker,
      r.close AS latest_close,
      r.rolling_high,
      100.0 * (r.close - r.rolling_high) / r.rolling_high AS drawdown_pct,
      (
        SELECT COUNT(*) FROM ohlcv o2
        WHERE o2.ticker = r.ticker
          AND o2.dt > h.high_dt
          AND o2.dt <= r.dt
      ) AS days_since_high
    FROM ranked r
    JOIN high_dates h ON h.ticker = r.ticker
    WHERE r.rn = 1
    ORDER BY r.ticker
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as Record<string, unknown>;
    return {
      ticker: String(r.ticker),
      latestClose: toNum(r.latest_close),
      rolling52wHigh: toNum(r.rolling_high),
      drawdownPct: toNum(r.drawdown_pct),
      daysSinceHigh: toNum(r.days_since_high),
    };
  });
}

export interface VolatilityRow {
  ticker: string;
  /** Annualised realised volatility, as a fraction (0.34 = 34%). */
  realizedVol30d: number;
  regime: 'low' | 'medium' | 'high' | 'extreme';
  /**
   * Number of log-return bars that contributed to the trailing window.
   * < 30 means the window wasn't full (typical for newly-added tickers
   * with thin history). Callers can downgrade UI confidence when this
   * is too small to trust the stddev — sample stddev with n=4 is a
   * very different beast than n=30.
   */
  barsSampled: number;
}

/**
 * Per-ticker 30-day realised volatility (annualised) with a qualitative
 * regime classification.
 *
 *   log_return_t = ln(close_t / close_{t-1})
 *   sd_30        = STDDEV_SAMP(log_return) over trailing 30 bars
 *   annualised   = sd_30 * sqrt(252)
 *
 * Sample stddev (n-1 divisor) — STDDEV_SAMP — is the right choice for
 * a finite trailing window. Population stddev would understate
 * variability at small n. Annualisation factor sqrt(252) is the
 * standard US-equity trading-days-per-year convention.
 *
 * Regime thresholds, calibrated for daily-bar US equities:
 *   - low      < 20%   (megacap defensive — SPY, JNJ)
 *   - medium   20-35%  (typical large-cap growth)
 *   - high     35-60%  (mid-cap, tech)
 *   - extreme  ≥ 60%   (biotech, leveraged ETFs, meme stocks)
 *
 * One row per ticker that has at least 2 bars in the table (≥ 2 bars
 * are needed to derive even a single log return; STDDEV_SAMP needs ≥ 2
 * non-null values, so the latest-bar row will only emit when we have
 * at least 3 bars total — bars_sampled ≥ 2). The bars-sampled flag
 * lets the UI hide the badge for windows too thin to be meaningful.
 *
 * No `asOf` parameter — volatility reflects the latest persisted bars
 * regardless of historical-view state, matching `getDrawdowns`.
 */
export async function getVolatilityRegimes(): Promise<VolatilityRow[]> {
  const conn = await getConn();
  const result = await conn.query(`
    WITH returns AS (
      SELECT
        ticker,
        dt,
        ln(close / NULLIF(LAG(close) OVER (PARTITION BY ticker ORDER BY dt), 0)) AS log_ret
      FROM ohlcv
    ),
    windowed AS (
      SELECT
        ticker,
        dt,
        log_ret,
        STDDEV_SAMP(log_ret) OVER (
          PARTITION BY ticker ORDER BY dt
          ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
        ) AS sd_30,
        COUNT(log_ret) OVER (
          PARTITION BY ticker ORDER BY dt
          ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
        ) AS bars,
        ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY dt DESC) AS rn
      FROM returns
      WHERE log_ret IS NOT NULL
    )
    SELECT
      ticker,
      sd_30 * sqrt(252) AS annualized_vol,
      bars
    FROM windowed
    WHERE rn = 1 AND sd_30 IS NOT NULL
    ORDER BY ticker
  `);
  return result.toArray().map((row) => {
    const r = row.toJSON() as Record<string, unknown>;
    const vol = toNum(r.annualized_vol);
    let regime: VolatilityRow['regime'];
    if (vol < 0.2) regime = 'low';
    else if (vol < 0.35) regime = 'medium';
    else if (vol < 0.6) regime = 'high';
    else regime = 'extreme';
    return {
      ticker: String(r.ticker),
      realizedVol30d: vol,
      regime,
      barsSampled: toNum(r.bars),
    };
  });
}

export interface VolumeProfileBucket {
  /** Bottom edge of this price bucket (inclusive). */
  priceLow: number;
  /** Top edge of this price bucket (exclusive, except the last bucket). */
  priceHigh: number;
  /** Center price — used for label / Y-axis positioning in the overlay. */
  priceMid: number;
  /** Sum of `volume` from all bars whose close fell into this bucket. */
  totalVolume: number;
  /** How many ohlcv bars contributed to this bucket. */
  barsCount: number;
}

export interface VolumeProfile {
  buckets: VolumeProfileBucket[];
  /** Bucket with the highest `totalVolume` — the Point of Control. */
  poc: VolumeProfileBucket | null;
  totalVolume: number;
  barsAnalyzed: number;
}

/**
 * Compute the volume profile for `ticker` over `[startDate, endDate]`.
 *
 * Bins the close-price range observed in the window into `bucketCount`
 * equal-width buckets, then sums `volume` per bucket. Bars with NULL
 * volume are excluded entirely (they'd contribute nothing meaningful to
 * a "where did money change hands" picture).
 *
 * Single-bar attribution: each bar's volume is fully attributed to the
 * bucket containing its close. This is the simplest model — TPO-style
 * "split by traversed range" attribution would distribute volume across
 * every bin between low and high, but is an order of magnitude more
 * complex (DuckDB needs a generate_series cross-join) and gives
 * qualitatively similar results for daily bars.
 *
 * Returns an empty profile (`{ buckets: [], poc: null, ... }`) when:
 *   - there's no data for the ticker in the window
 *   - all bars have the same close (degenerate single-price case where
 *     `hi - lo == 0` and bucket width would be zero — meaningful
 *     bucketing is impossible). The `barsAnalyzed` count is still
 *     surfaced so the UI can disambiguate "no data" from "single price".
 *
 * The price range (`lo`/`hi`/`bucketWidth`) is inlined into the second
 * query because they're computed numbers we just derived; bind params
 * inside the FLOOR expression would force DuckDB to re-plan per-row
 * and offer no safety win since the values are server-derived doubles.
 * Ticker and dates are still bound as parameters (defense in depth on
 * top of the upstream TICKER_RE check).
 */
export async function getVolumeProfile(
  ticker: string,
  startDate: string,
  endDate: string,
  bucketCount: number = 40,
): Promise<VolumeProfile> {
  if (!/^[A-Z0-9]{1,10}$/.test(ticker)) {
    throw new Error(`getVolumeProfile: unsafe ticker '${ticker}'`);
  }
  if (!Number.isInteger(bucketCount) || bucketCount < 2 || bucketCount > 200) {
    throw new Error(
      `getVolumeProfile: bucketCount must be an integer in [2, 200] (got ${bucketCount})`,
    );
  }

  const conn = await getConn();

  // First pass: find the close-price range in the window. We need this
  // before we can size the buckets. `volume IS NOT NULL` mirrors the
  // bucketing query so the range and the bucketed sums see the same
  // bar set — a NULL-volume bar at an extreme price shouldn't widen
  // the range and leave dead space at the edges of the profile.
  const rangeSql = `
    SELECT MIN(close) AS lo, MAX(close) AS hi, COUNT(*) AS n
    FROM ohlcv
    WHERE ticker = ?
      AND dt >= CAST(? AS DATE)
      AND dt <= CAST(? AS DATE)
      AND volume IS NOT NULL
  `;
  const rangeStmt = await conn.prepare(rangeSql);
  let lo: number;
  let hi: number;
  let n: number;
  try {
    const rangeTbl = await rangeStmt.query(ticker, startDate, endDate);
    const rangeRows = rangeTbl
      .toArray()
      .map((r) => r.toJSON() as Record<string, unknown>);
    const rangeRow = rangeRows[0];
    if (!rangeRow) {
      return { buckets: [], poc: null, totalVolume: 0, barsAnalyzed: 0 };
    }
    n = toNum(rangeRow.n);
    if (n === 0) {
      return { buckets: [], poc: null, totalVolume: 0, barsAnalyzed: 0 };
    }
    lo = toNum(rangeRow.lo);
    hi = toNum(rangeRow.hi);
  } finally {
    await rangeStmt.close();
  }

  // Degenerate case: every bar in the window closed at the same price.
  // We can't bucket a zero-width range. Surface barsAnalyzed so the
  // UI can show "single price — no profile" rather than confusing it
  // with the empty-data case.
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) {
    return { buckets: [], poc: null, totalVolume: 0, barsAnalyzed: n };
  }

  const bucketWidth = (hi - lo) / bucketCount;

  // Second pass: bucket each bar by close price.
  //   FLOOR((close - lo) / bucketWidth) → bucket index 0..bucketCount-1
  // Edge case: close == hi gives bucket index == bucketCount (out of
  // range by one). LEAST/GREATEST clamps it back into [0, bucketCount-1]
  // so the topmost bucket includes its upper edge.
  const profileSql = `
    WITH bucketed AS (
      SELECT
        LEAST(${bucketCount - 1}, GREATEST(0, FLOOR((close - ${lo}) / ${bucketWidth})))::INTEGER AS bucket_idx,
        volume
      FROM ohlcv
      WHERE ticker = ?
        AND dt >= CAST(? AS DATE)
        AND dt <= CAST(? AS DATE)
        AND volume IS NOT NULL
    )
    SELECT
      bucket_idx,
      SUM(volume) AS total_volume,
      COUNT(*) AS bars_count
    FROM bucketed
    GROUP BY bucket_idx
    ORDER BY bucket_idx
  `;
  const profileStmt = await conn.prepare(profileSql);
  let profileRows: Record<string, unknown>[];
  try {
    const profileTbl = await profileStmt.query(ticker, startDate, endDate);
    profileRows = profileTbl
      .toArray()
      .map((r) => r.toJSON() as Record<string, unknown>);
  } finally {
    await profileStmt.close();
  }

  const buckets: VolumeProfileBucket[] = [];
  let totalVolume = 0;
  let barsAnalyzed = 0;
  let pocIdx = -1;
  let pocVol = -1;

  for (const row of profileRows) {
    const idx = toNum(row.bucket_idx);
    const vol = toNum(row.total_volume);
    const bars = toNum(row.bars_count);
    const priceLow = lo + idx * bucketWidth;
    const priceHigh = priceLow + bucketWidth;
    buckets.push({
      priceLow,
      priceHigh,
      priceMid: (priceLow + priceHigh) / 2,
      totalVolume: vol,
      barsCount: bars,
    });
    totalVolume += vol;
    barsAnalyzed += bars;
    if (vol > pocVol) {
      pocVol = vol;
      pocIdx = buckets.length - 1;
    }
  }

  return {
    buckets,
    poc: pocIdx >= 0 ? buckets[pocIdx] : null,
    totalVolume,
    barsAnalyzed,
  };
}

export interface CorrelationPair {
  tickerA: string;
  tickerB: string;
  /** Pearson correlation in [-1, 1], or null if < 30 overlapping bars. */
  correlation: number | null;
  barsOverlap: number;
}

/**
 * Pairwise Pearson correlation of daily log returns over the trailing
 * `windowBars` (default 60) trading days, for every distinct pair of
 * supplied tickers.
 *
 * Returns lower-triangular pairs only (lexicographic `tickerA < tickerB`)
 * because the matrix is symmetric — the upper triangle is redundant.
 * Diagonal (self-correlation = 1.0) is NOT returned; callers fill it in.
 *
 * Pairs with < 30 overlapping bars in the window get `correlation=null`.
 * Below that threshold the correlation point estimate is too noisy to
 * be useful (rule-of-thumb minimum sample for a meaningful Pearson r).
 *
 * Implementation note: one query per pair. With handful-of-positions
 * portfolios this is fine; if we ever support 50+ positions a single
 * UNION ALL query would be more efficient, but for v1 the per-pair
 * approach is more readable and lets us isolate any single failure.
 *
 * Tickers are validated against the same regex as `assertSafeTicker`
 * (defense in depth — TICKER_RE upstream should already catch anything
 * malformed, but we're string-interpolating into SQL).
 */
export async function getCorrelationMatrix(
  tickers: string[],
  windowBars: number = 60,
): Promise<CorrelationPair[]> {
  if (tickers.length < 2) return [];
  const conn = await getConn();

  for (const t of tickers) {
    if (!/^[A-Z0-9]{1,10}$/.test(t)) {
      throw new Error(`getCorrelationMatrix: unsafe ticker '${t}'`);
    }
  }

  const pairs: { a: string; b: string }[] = [];
  for (let i = 0; i < tickers.length; i++) {
    for (let j = i + 1; j < tickers.length; j++) {
      pairs.push({ a: tickers[i], b: tickers[j] });
    }
  }
  if (pairs.length === 0) return [];

  const out: CorrelationPair[] = [];
  for (const { a, b } of pairs) {
    // Per pair: build log-returns for each ticker, INNER JOIN by date
    // so we only count days where BOTH have a bar (handles holidays /
    // partial histories gracefully), take the most recent `windowBars`,
    // run DuckDB's CORR aggregate.
    const sql = `
      WITH returns_a AS (
        SELECT
          dt,
          ln(close / NULLIF(LAG(close) OVER (ORDER BY dt), 0)) AS r
        FROM ohlcv WHERE ticker = '${a}'
      ),
      returns_b AS (
        SELECT
          dt,
          ln(close / NULLIF(LAG(close) OVER (ORDER BY dt), 0)) AS r
        FROM ohlcv WHERE ticker = '${b}'
      ),
      paired AS (
        SELECT a.dt, a.r AS ra, b.r AS rb,
          ROW_NUMBER() OVER (ORDER BY a.dt DESC) AS rn
        FROM returns_a a
        JOIN returns_b b ON a.dt = b.dt
        WHERE a.r IS NOT NULL AND b.r IS NOT NULL
      ),
      windowed AS (
        SELECT * FROM paired WHERE rn <= ${windowBars}
      )
      SELECT
        CORR(ra, rb) AS correlation,
        COUNT(*) AS bars_overlap
      FROM windowed
    `;
    const result = await conn.query(sql);
    const rows = result.toArray().map((row) => row.toJSON() as Record<string, unknown>);
    const row = rows[0] ?? {};
    const bars = toNum(row.bars_overlap ?? 0);
    // CORR returns NULL when the input has zero variance (constant
    // series) or when there's only one row — guard against NaN/null
    // in addition to the bars threshold so the UI gets a clean
    // null sentinel for "can't compute" rather than NaN.
    let correlation: number | null = null;
    if (bars >= 30 && row.correlation !== null && row.correlation !== undefined) {
      const c = toNum(row.correlation);
      correlation = Number.isFinite(c) ? c : null;
    }
    out.push({
      tickerA: a,
      tickerB: b,
      correlation,
      barsOverlap: bars,
    });
  }
  return out;
}
