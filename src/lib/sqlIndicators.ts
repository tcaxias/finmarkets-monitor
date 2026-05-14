// Pure-DuckDB SQL implementations of RSI(14) and MACD(12,26,9) via
// recursive CTEs, with materialisation into the `indicators_rsi` and
// `indicators_macd` tables (created by migration v3).
//
// Why move the math into SQL?
//
// Until now we used the `technicalindicators` npm package and computed
// indicators on every chart render. Two issues with that:
//
//   1. The data layer already lives in DuckDB. Round-tripping closes out
//      to JS, computing, and storing the result back in reactive state
//      is two unnecessary boundary crossings per refresh.
//   2. Wilder's RSI and Appel's MACD are *recursive*: each bar's value
//      depends on the previous bar's smoothed value. Recursive CTEs are
//      DuckDB's idiom for exactly this shape — and once the math lives
//      in SQL the result can be materialised so subsequent reads are
//      indexed lookups, not recomputations.
//
// Refresh policy: this module owns the write path (`materializeRsi`,
// `materializeMacd`, and the `refreshIndicators` convenience that calls
// both). The data layer (`data.svelte.ts`) calls `refreshIndicators`
// after every successful OHLCV insert. The chart layer calls the
// matching `readRsi` / `readMacd` to fetch the materialised series.
//
// Math reference (kept here so future readers don't need to dig out the
// Wilder paper):
//
//   RSI(period):
//     gain_t = max(close_t - close_{t-1}, 0)
//     loss_t = max(close_{t-1} - close_t, 0)
//     seed (t = period+1):
//       avg_gain = AVG(gain) over the first `period` changes
//       avg_loss = AVG(loss) over the first `period` changes
//     recursive (t > period+1):
//       avg_gain_t = (avg_gain_{t-1} * (period-1) + gain_t) / period
//       avg_loss_t = (avg_loss_{t-1} * (period-1) + loss_t) / period
//     RSI_t = 100 - 100 / (1 + avg_gain_t / avg_loss_t)
//     Edge: avg_loss = 0 ⇒ RSI = 100 (avoids /0).
//
//   MACD(fast, slow, signal):
//     EMA_n_t = close_t * k_n + EMA_n_{t-1} * (1 - k_n), with k_n = 2/(n+1)
//     Seed at t = n: EMA_n = SMA(closes[1..n])
//     macd_line = EMA_fast - EMA_slow (defined from t = slow)
//     signal    = EMA_signal(macd_line) (defined from t = slow + signal - 1)
//     histogram = macd_line - signal
//
// Security: ticker is the only VARCHAR interpolated into SQL. It's
// validated by `TICKER_RE = /^[A-Z0-9]{1,10}$/` in settings.svelte.ts
// before reaching the data layer; we re-validate here as defence in
// depth (a programmer error elsewhere shouldn't let an arbitrary string
// reach the SQL fragment). All numeric parameters are inlined integer
// constants — no SQL injection surface.

import { getConn } from './duckdb';

// Mirror of settings.svelte.ts's TICKER_RE. Duplicated rather than
// imported to keep this module free of the reactive-settings
// dependency graph (sqlIndicators is a pure data-layer module).
const SAFE_TICKER_RE = /^[A-Z0-9]{1,10}$/;

function assertSafeTicker(ticker: string): void {
  if (!SAFE_TICKER_RE.test(ticker)) {
    throw new Error(
      `sqlIndicators: refusing to use unsafe ticker "${ticker}" — ` +
        `must match /^[A-Z0-9]{1,10}$/. (This indicates a validation ` +
        `gap upstream; tickers should be normalised in settings.)`,
    );
  }
}

/**
 * Recompute RSI for `ticker` and rewrite `indicators_rsi` for that
 * (ticker, period). DELETE-then-INSERT rather than upsert so a shorter
 * resulting series can't leave stale tail rows from a prior, longer
 * fetch. Returns the number of rows written.
 */
export async function materializeRsi(
  ticker: string,
  period: number = 14,
): Promise<number> {
  assertSafeTicker(ticker);
  if (!Number.isInteger(period) || period < 2) {
    throw new Error(`materializeRsi: period must be an integer >= 2 (got ${period})`);
  }
  const conn = await getConn();

  await conn.query(
    `DELETE FROM indicators_rsi WHERE ticker = '${ticker}' AND period = ${period}`,
  );

  // Wilder's RSI as a recursive CTE.
  //
  // `ordered` numbers the bars by date (rn 1..N) so we can join the
  // recursive iteration to the next bar by `rn + 1`. `changes` holds the
  // gain/loss for each bar that has a previous close (rn 2..N). The seed
  // row (`seed`) at rn = period+1 carries the SMA of the first `period`
  // changes. Each recursive step computes Wilder's update from the
  // previous row's avg_gain/avg_loss.
  //
  // Final SELECT joins back to `changes` for the dt of each rn so we
  // attach the correct date to each RSI value.
  // NOTE: `WITH RECURSIVE` keyword is REQUIRED for self-referencing
  // CTEs in DuckDB (the `recursive_rsi` CTE references itself in its
  // UNION ALL branch). Without `RECURSIVE`, DuckDB rejects the SQL with
  // an "undefined reference" error at parse time. The earlier version of
  // this code omitted the keyword and was silently swallowed by the
  // try/catch in data.svelte.ts, leaving the indicator panes blank.
  const sql = `
    INSERT INTO indicators_rsi (ticker, dt, period, value)
    WITH RECURSIVE ordered AS (
      SELECT
        dt,
        close,
        LAG(close) OVER (ORDER BY dt) AS prev_close,
        ROW_NUMBER() OVER (ORDER BY dt) AS rn
      FROM ohlcv
      WHERE ticker = '${ticker}'
    ),
    changes AS (
      SELECT
        rn,
        dt,
        GREATEST(close - prev_close, 0) AS gain,
        GREATEST(prev_close - close, 0) AS loss
      FROM ordered
      WHERE prev_close IS NOT NULL
    ),
    seed AS (
      SELECT
        ${period + 1} AS rn,
        AVG(gain) AS avg_gain,
        AVG(loss) AS avg_loss
      FROM changes
      WHERE rn BETWEEN 2 AND ${period + 1}
    ),
    recursive_rsi (rn, avg_gain, avg_loss) AS (
      SELECT rn, avg_gain, avg_loss FROM seed
      UNION ALL
      SELECT
        c.rn,
        (r.avg_gain * ${period - 1} + c.gain) / ${period}.0,
        (r.avg_loss * ${period - 1} + c.loss) / ${period}.0
      FROM recursive_rsi r
      JOIN changes c ON c.rn = r.rn + 1
    )
    SELECT
      '${ticker}' AS ticker,
      c.dt,
      ${period} AS period,
      CASE
        WHEN r.avg_loss = 0 THEN 100.0
        ELSE 100.0 - (100.0 / (1.0 + r.avg_gain / r.avg_loss))
      END AS value
    FROM recursive_rsi r
    JOIN changes c ON c.rn = r.rn
  `;
  await conn.query(sql);

  const countResult = await conn.query(
    `SELECT COUNT(*) AS c FROM indicators_rsi WHERE ticker = '${ticker}' AND period = ${period}`,
  );
  const rows = countResult.toArray().map((r) => r.toJSON() as { c: bigint });
  return Number(rows[0]?.c ?? 0);
}

/**
 * Recompute MACD for `ticker` via three chained recursive EMAs (fast,
 * slow, then signal-EMA over the difference) and rewrite
 * `indicators_macd` for that (ticker, fast, slow, signal). Returns the
 * number of rows written.
 */
export async function materializeMacd(
  ticker: string,
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9,
): Promise<number> {
  assertSafeTicker(ticker);
  if (
    !Number.isInteger(fastPeriod) ||
    !Number.isInteger(slowPeriod) ||
    !Number.isInteger(signalPeriod) ||
    fastPeriod < 2 ||
    slowPeriod <= fastPeriod ||
    signalPeriod < 2
  ) {
    throw new Error(
      `materializeMacd: invalid periods (fast=${fastPeriod}, slow=${slowPeriod}, signal=${signalPeriod}). ` +
        `Required: 2 <= fast < slow, signal >= 2.`,
    );
  }

  const conn = await getConn();
  await conn.query(
    `DELETE FROM indicators_macd WHERE ticker = '${ticker}'
     AND fast_period = ${fastPeriod}
     AND slow_period = ${slowPeriod}
     AND signal_period = ${signalPeriod}`,
  );

  // EMA smoothing constants. Computed once and inlined as numeric
  // literals so the SQL stays a single statement (no bind parameters
  // needed inside the CTE).
  const fastK = 2.0 / (fastPeriod + 1);
  const slowK = 2.0 / (slowPeriod + 1);
  const signalK = 2.0 / (signalPeriod + 1);

  // Three chained recursive CTEs:
  //   1. fast_ema (rn = fastPeriod ... N): EMA over close.
  //   2. slow_ema (rn = slowPeriod ... N): EMA over close.
  //   3. signal_ema: EMA over the (fast - slow) difference, but indexed
  //      by macd_rn (re-numbered from 1 over the rows where macd_line is
  //      defined) so the recursive join `macd_rn = se.macd_rn + 1`
  //      stays clean.
  //
  // Seed rows for each EMA are the SMA over the first `n` closes.
  // The final SELECT joins signal_ema back to macd_with_seed_rn so we
  // can output (dt, macd_line, signal_line, histogram) together — only
  // the rows where the signal EMA is defined make it out.
  // NOTE: `WITH RECURSIVE` keyword is REQUIRED for self-referencing
  // CTEs (fast_ema, slow_ema, signal_ema all reference themselves in
  // their UNION ALL branch). See materializeRsi for the full rationale.
  const sql = `
    INSERT INTO indicators_macd
      (ticker, dt, fast_period, slow_period, signal_period, macd_line, signal_line, histogram)
    WITH RECURSIVE ordered AS (
      SELECT
        dt,
        close,
        ROW_NUMBER() OVER (ORDER BY dt) AS rn
      FROM ohlcv
      WHERE ticker = '${ticker}'
    ),
    fast_seed AS (
      SELECT ${fastPeriod} AS rn, AVG(close) AS ema
      FROM ordered WHERE rn BETWEEN 1 AND ${fastPeriod}
    ),
    fast_ema (rn, ema) AS (
      SELECT rn, ema FROM fast_seed
      UNION ALL
      SELECT o.rn, o.close * ${fastK} + f.ema * (1 - ${fastK})
      FROM fast_ema f
      JOIN ordered o ON o.rn = f.rn + 1
    ),
    slow_seed AS (
      SELECT ${slowPeriod} AS rn, AVG(close) AS ema
      FROM ordered WHERE rn BETWEEN 1 AND ${slowPeriod}
    ),
    slow_ema (rn, ema) AS (
      SELECT rn, ema FROM slow_seed
      UNION ALL
      SELECT o.rn, o.close * ${slowK} + s.ema * (1 - ${slowK})
      FROM slow_ema s
      JOIN ordered o ON o.rn = s.rn + 1
    ),
    macd_line_calc AS (
      SELECT
        f.rn,
        o.dt,
        f.ema - s.ema AS macd_line
      FROM fast_ema f
      JOIN slow_ema s ON s.rn = f.rn
      JOIN ordered o ON o.rn = f.rn
      WHERE f.rn >= ${slowPeriod}
    ),
    macd_with_seed_rn AS (
      SELECT rn, dt, macd_line, ROW_NUMBER() OVER (ORDER BY rn) AS macd_rn
      FROM macd_line_calc
    ),
    signal_seed AS (
      SELECT ${signalPeriod} AS macd_rn, AVG(macd_line) AS ema
      FROM macd_with_seed_rn WHERE macd_rn BETWEEN 1 AND ${signalPeriod}
    ),
    signal_ema (macd_rn, ema) AS (
      SELECT macd_rn, ema FROM signal_seed
      UNION ALL
      SELECT m.macd_rn, m.macd_line * ${signalK} + se.ema * (1 - ${signalK})
      FROM signal_ema se
      JOIN macd_with_seed_rn m ON m.macd_rn = se.macd_rn + 1
    )
    SELECT
      '${ticker}' AS ticker,
      m.dt,
      ${fastPeriod} AS fast_period,
      ${slowPeriod} AS slow_period,
      ${signalPeriod} AS signal_period,
      m.macd_line,
      se.ema AS signal_line,
      m.macd_line - se.ema AS histogram
    FROM signal_ema se
    JOIN macd_with_seed_rn m ON m.macd_rn = se.macd_rn
  `;
  await conn.query(sql);

  const countResult = await conn.query(
    `SELECT COUNT(*) AS c FROM indicators_macd WHERE ticker = '${ticker}'
     AND fast_period = ${fastPeriod}
     AND slow_period = ${slowPeriod}
     AND signal_period = ${signalPeriod}`,
  );
  const rows = countResult.toArray().map((r) => r.toJSON() as { c: bigint });
  return Number(rows[0]?.c ?? 0);
}

/**
 * Refresh both indicators for `ticker` with the canonical default
 * parameters (RSI 14, MACD 12/26/9). Called from the data-refresh
 * pipeline after a successful OHLCV insert.
 *
 * Errors are not swallowed here — callers are expected to wrap this in
 * a try/catch if they want the indicator refresh to be non-fatal
 * (e.g. data.svelte.ts treats it as best-effort because the chart can
 * still render OHLCV without indicators).
 */
export async function refreshIndicators(ticker: string): Promise<void> {
  await materializeRsi(ticker, 14);
  await materializeMacd(ticker, 12, 26, 9);
}

/**
 * Read the materialised RSI series for `ticker`, optionally bounded by
 * `asOf` (upper bound) and `since` (lower bound). Output shape matches
 * the legacy in-memory `RsiPoint[]` so chart consumers don't change.
 *
 * Like `getCloses` in the prior implementation, callers should pass
 * `since = null` when they need the full warmup history (the chart's
 * time scale clips the visible range either way).
 */
export async function readRsi(
  ticker: string,
  asOf?: string | null,
  since?: string | null,
  period: number = 14,
): Promise<{ time: number; value: number }[]> {
  assertSafeTicker(ticker);
  const conn = await getConn();

  // Build the WHERE clause with bind parameters for the date bounds.
  // ticker is already validated; period is a numeric constant. Dates are
  // bound with `CAST(? AS DATE)` for the same reason as queries.ts: the
  // VARCHAR-to-DATE comparison fails otherwise (see the af22d1f
  // commit-message context in queries.ts).
  let where = `ticker = '${ticker}' AND period = ${period}`;
  const params: unknown[] = [];
  if (asOf) {
    where += ` AND dt <= CAST(? AS DATE)`;
    params.push(asOf);
  }
  if (since) {
    where += ` AND dt >= CAST(? AS DATE)`;
    params.push(since);
  }
  const sql = `SELECT epoch(dt)::BIGINT AS time, value
               FROM indicators_rsi
               WHERE ${where}
               ORDER BY dt`;
  const stmt = await conn.prepare(sql);
  try {
    const tbl = await stmt.query(...params);
    return tbl.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return { time: Number(r.time), value: Number(r.value) };
    });
  } finally {
    await stmt.close();
  }
}

/**
 * Read the materialised MACD series for `ticker`, optionally bounded by
 * `asOf` (upper bound) and `since` (lower bound). Output shape matches
 * the legacy in-memory `MacdPoint[]` (`{time, macd, signal, histogram}`)
 * so chart consumers don't change.
 */
export async function readMacd(
  ticker: string,
  asOf?: string | null,
  since?: string | null,
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9,
): Promise<{ time: number; macd: number; signal: number; histogram: number }[]> {
  assertSafeTicker(ticker);
  const conn = await getConn();

  let where = `ticker = '${ticker}'`;
  const params: unknown[] = [];
  // Period parameters are inlined integers (defaults come from the
  // chart toolbar, not user input), safe to interpolate. Filtering by
  // them is required: indicators_macd's primary key includes the period
  // tuple, so a future second period set (e.g. MACD(5,35,5)) would
  // otherwise be commingled into the read result.
  where += ` AND fast_period = ${fastPeriod}`;
  where += ` AND slow_period = ${slowPeriod}`;
  where += ` AND signal_period = ${signalPeriod}`;
  if (asOf) {
    where += ` AND dt <= CAST(? AS DATE)`;
    params.push(asOf);
  }
  if (since) {
    where += ` AND dt >= CAST(? AS DATE)`;
    params.push(since);
  }
  const sql = `SELECT epoch(dt)::BIGINT AS time, macd_line, signal_line, histogram
               FROM indicators_macd
               WHERE ${where}
               ORDER BY dt`;
  const stmt = await conn.prepare(sql);
  try {
    const tbl = await stmt.query(...params);
    return tbl.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return {
        time: Number(r.time),
        macd: Number(r.macd_line),
        signal: Number(r.signal_line),
        histogram: Number(r.histogram),
      };
    });
  } finally {
    await stmt.close();
  }
}
