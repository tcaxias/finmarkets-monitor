// Cross-ticker Screener: predefined SQL queries that JOIN the
// `current_snapshot` view (migration v2) and the materialised
// indicator tables (migration v3) to surface positions matching
// classic momentum / trend / risk signals in one click.
//
// Why SQL? The shape of every screen is "for each user position,
// check the latest indicator/SMA/Pcover, filter, sort". With JS
// arrays you'd loop the positions, fire one read per ticker, filter,
// collect — 50 lines per screen and N round trips through the DuckDB
// boundary. Inside DuckDB it's a single JOIN: `current_snapshot s
// JOIN indicators_rsi r ON r.ticker = s.ticker AND r.dt = s.latest_dt`
// (a few lines, one round trip). This module is the headline
// "DuckDB-leverage" feature — it genuinely could not exist as elegant
// code without an in-browser SQL engine.
//
// Security: tickers are interpolated as quoted strings (DuckDB-WASM's
// bind-parameter API doesn't accept dynamic IN-list arity, and a
// VALUES-clause for the Pcover screen also needs literal values).
// Tickers are validated by `TICKER_RE = /^[A-Z0-9]{1,10}$/` in
// settings.svelte.ts before reaching this layer; `quoteTicker` adds
// SQL-string escaping as defence in depth. Numeric Pcover values are
// computed in JS via `computeThresholds` and inlined as numeric
// literals (no injection surface).

import { getConn } from './duckdb';
import type { Position } from './settings.svelte';
import { computeThresholds } from './math';

export interface ScreenColumn {
  key: string;
  label: string;
  /**
   * Display formatting hint consumed by ScreenerPanel.svelte:
   *   - 'price'  → `$XX.XX`
   *   - 'pct'    → `+X.X%` / `-X.X%`, colour-coded by sign
   *   - 'number' → `XX.XX` (2 decimals)
   *   - 'date'   → ISO date as-is
   *   - 'string' → as-is
   */
  format?: 'price' | 'pct' | 'number' | 'date' | 'string';
}

export interface ScreenDefinition {
  id: string;
  label: string;
  description: string;
  category: 'momentum' | 'trend' | 'risk';
  /**
   * Build the SQL for this screen given the user's positions. Empty
   * positions array → SQL that matches nothing (a literal `IN ('')`
   * clause that no real ticker can satisfy). The Pcover screen is the
   * one exception: its positions list is further filtered to those
   * with tax tracking configured, and the screen short-circuits with
   * a `WHERE FALSE` no-op when none qualify.
   */
  buildSql: (positions: Position[]) => string;
  columns: ScreenColumn[];
}

export interface ScreenRow {
  [key: string]: string | number | null;
}

/**
 * SQL-string-quote a ticker for interpolation. Tickers are validated
 * upstream as `/^[A-Z0-9]{1,10}$/` (no quotes, no whitespace), so the
 * `replace` is purely defence in depth — a programmer error elsewhere
 * shouldn't let an arbitrary string reach our SQL fragment.
 */
function quoteTicker(t: string): string {
  return `'${t.replace(/'/g, "''")}'`;
}

/**
 * Render a comma-separated list of quoted tickers suitable for
 * direct use inside a `WHERE ticker IN (...)` clause.
 *
 * Empty positions → `''` (the empty string, which no real ticker can
 * equal). Returning that instead of an empty string keeps the SQL
 * syntactically valid (`IN ()` is a parse error in DuckDB) while
 * guaranteeing zero matches — the natural "no positions configured"
 * empty state.
 */
function tickerListSql(positions: Position[]): string {
  if (positions.length === 0) return "''";
  return positions.map((p) => quoteTicker(p.ticker)).join(', ');
}

export const SCREENS: ScreenDefinition[] = [
  {
    id: 'overbought',
    label: 'Overbought (RSI > 70)',
    description:
      'Positions whose latest RSI(14) is above 70 — potential exhaustion / sell candidate. Strong trends can stay overbought for weeks; treat as a pullback warning, not a guaranteed reversal.',
    category: 'momentum',
    buildSql: (positions) => `
      SELECT
        s.ticker,
        s.latest_close AS price,
        r.value AS rsi,
        s.latest_dt AS dt
      FROM current_snapshot s
      JOIN indicators_rsi r ON r.ticker = s.ticker AND r.dt = s.latest_dt AND r.period = 14
      WHERE s.ticker IN (${tickerListSql(positions)})
        AND r.value > 70
      ORDER BY r.value DESC
    `,
    columns: [
      { key: 'ticker', label: 'Ticker', format: 'string' },
      { key: 'price', label: 'Price', format: 'price' },
      { key: 'rsi', label: 'RSI', format: 'number' },
      { key: 'dt', label: 'As of', format: 'date' },
    ],
  },
  {
    id: 'oversold',
    label: 'Oversold (RSI < 30)',
    description:
      'Positions whose latest RSI(14) is below 30 — selling exhaustion / potential bounce. Same caveat as overbought: bear trends can stay oversold; wait for the bounce, do not catch a falling knife.',
    category: 'momentum',
    buildSql: (positions) => `
      SELECT s.ticker, s.latest_close AS price, r.value AS rsi, s.latest_dt AS dt
      FROM current_snapshot s
      JOIN indicators_rsi r ON r.ticker = s.ticker AND r.dt = s.latest_dt AND r.period = 14
      WHERE s.ticker IN (${tickerListSql(positions)}) AND r.value < 30
      ORDER BY r.value ASC
    `,
    columns: [
      { key: 'ticker', label: 'Ticker', format: 'string' },
      { key: 'price', label: 'Price', format: 'price' },
      { key: 'rsi', label: 'RSI', format: 'number' },
      { key: 'dt', label: 'As of', format: 'date' },
    ],
  },
  {
    id: 'below-sma20',
    label: 'Below 20-day SMA',
    description:
      'Latest close is below the 20-day simple moving average. Short-term downtrend or pullback within a longer trend.',
    category: 'trend',
    buildSql: (positions) => `
      WITH sma20 AS (
        SELECT
          ticker,
          dt,
          AVG(close) OVER (PARTITION BY ticker ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS value,
          COUNT(*) OVER (PARTITION BY ticker ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS w,
          ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY dt DESC) AS rn
        FROM ohlcv
      )
      SELECT
        s.ticker,
        s.latest_close AS price,
        m.value AS sma20,
        s.latest_close - m.value AS diff,
        100.0 * (s.latest_close - m.value) / m.value AS pct_below
      FROM current_snapshot s
      JOIN sma20 m ON m.ticker = s.ticker AND m.rn = 1 AND m.w >= 20
      WHERE s.ticker IN (${tickerListSql(positions)}) AND s.latest_close < m.value
      ORDER BY pct_below ASC
    `,
    columns: [
      { key: 'ticker', label: 'Ticker', format: 'string' },
      { key: 'price', label: 'Price', format: 'price' },
      { key: 'sma20', label: '20-MA', format: 'price' },
      { key: 'pct_below', label: 'Below by', format: 'pct' },
    ],
  },
  {
    id: 'above-sma200',
    label: 'Above 200-day SMA',
    description:
      'Latest close is above the 200-day SMA — long-term bullish regime. The 200-MA is the most-watched institutional trend line.',
    category: 'trend',
    buildSql: (positions) => `
      WITH sma200 AS (
        SELECT
          ticker, dt,
          AVG(close) OVER (PARTITION BY ticker ORDER BY dt ROWS BETWEEN 199 PRECEDING AND CURRENT ROW) AS value,
          ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY dt DESC) AS rn,
          COUNT(*) OVER (PARTITION BY ticker ORDER BY dt ROWS BETWEEN 199 PRECEDING AND CURRENT ROW) AS w
        FROM ohlcv
      )
      SELECT
        s.ticker, s.latest_close AS price, m.value AS sma200,
        100.0 * (s.latest_close - m.value) / m.value AS pct_above
      FROM current_snapshot s
      JOIN sma200 m ON m.ticker = s.ticker AND m.rn = 1 AND m.w >= 200
      WHERE s.ticker IN (${tickerListSql(positions)}) AND s.latest_close > m.value
      ORDER BY pct_above DESC
    `,
    columns: [
      { key: 'ticker', label: 'Ticker', format: 'string' },
      { key: 'price', label: 'Price', format: 'price' },
      { key: 'sma200', label: '200-MA', format: 'price' },
      { key: 'pct_above', label: 'Above by', format: 'pct' },
    ],
  },
  {
    id: 'macd-bull-cross',
    label: 'MACD bullish crossover (last 5 days)',
    description:
      'MACD histogram flipped from negative to positive in the last 5 trading days — early-stage bullish momentum confirmation.',
    category: 'momentum',
    buildSql: (positions) => `
      WITH recent_macd AS (
        SELECT
          ticker, dt, histogram,
          LAG(histogram) OVER (PARTITION BY ticker ORDER BY dt) AS prev_hist,
          ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY dt DESC) AS rn
        FROM indicators_macd
        WHERE fast_period = 12 AND slow_period = 26 AND signal_period = 9
      )
      SELECT
        rm.ticker,
        s.latest_close AS price,
        rm.dt AS cross_dt,
        rm.histogram AS hist
      FROM recent_macd rm
      JOIN current_snapshot s ON s.ticker = rm.ticker
      WHERE rm.ticker IN (${tickerListSql(positions)})
        AND rm.rn <= 5
        AND rm.prev_hist < 0
        AND rm.histogram > 0
      ORDER BY rm.dt DESC
    `,
    columns: [
      { key: 'ticker', label: 'Ticker', format: 'string' },
      { key: 'price', label: 'Price', format: 'price' },
      { key: 'cross_dt', label: 'Crossover date', format: 'date' },
      { key: 'hist', label: 'Histogram', format: 'number' },
    ],
  },
  {
    id: 'near-pcover',
    label: 'Approaching Pcover (within 20%)',
    description:
      'Latest close is within 20% above Pcover — the tax-coverage floor is approaching. Time to review the exit plan. Only includes positions with tax tracking configured (vest price + shares + tax rate all set).',
    category: 'risk',
    buildSql: (positions) => {
      // The Pcover screen needs per-position numeric data (Pcover) that
      // isn't in the database — it's derived in JS from the user's vest
      // price + shares + tax rate. We push it down to SQL via a VALUES
      // (...) clause aliased as a CTE, then JOIN against the snapshot.
      // This keeps the filter declarative (the SQL still owns "find
      // positions whose latest close is within 20% above Pcover") while
      // letting the per-row Pcover live in JS.
      //
      // Filter at the SQL level for tax-tracked positions only — the
      // alternative (run the screen, then filter results in JS) would
      // need an extra column shipped back and re-implementation of
      // hasTaxTracking on the result set.
      const tracked = positions.filter(
        (p) => p.vestPrice > 0 && p.shares > 0 && p.taxRate > 0,
      );
      if (tracked.length === 0) {
        // No tracked positions → return an empty result set with the
        // expected column shape. `WHERE FALSE` is the standard DuckDB
        // idiom for "type-correct empty result"; column types are
        // declared via NULL-casts so result.toArray() returns []
        // without a runtime "column type unknown" error.
        return `SELECT NULL::VARCHAR AS ticker, NULL::DOUBLE AS price, NULL::DOUBLE AS pcover, NULL::DOUBLE AS headroom_pct WHERE FALSE`;
      }
      const valuesSql = tracked
        .map(
          (p) =>
            `(${quoteTicker(p.ticker)}, ${
              computeThresholds(p.vestPrice, p.shares, p.taxRate).pcover
            })`,
        )
        .join(', ');
      return `
        WITH user_pcovers (ticker, pcover) AS (VALUES ${valuesSql})
        SELECT
          s.ticker,
          s.latest_close AS price,
          u.pcover,
          100.0 * (s.latest_close - u.pcover) / u.pcover AS headroom_pct
        FROM current_snapshot s
        JOIN user_pcovers u ON u.ticker = s.ticker
        WHERE s.latest_close > u.pcover
          AND s.latest_close <= u.pcover * 1.20
        ORDER BY headroom_pct ASC
      `;
    },
    columns: [
      { key: 'ticker', label: 'Ticker', format: 'string' },
      { key: 'price', label: 'Price', format: 'price' },
      { key: 'pcover', label: 'Pcover', format: 'price' },
      { key: 'headroom_pct', label: 'Headroom', format: 'pct' },
    ],
  },
];

export function getScreenById(id: string): ScreenDefinition | undefined {
  return SCREENS.find((s) => s.id === id);
}

/**
 * Execute a screen against the given positions and return rows shaped
 * for direct rendering. DuckDB cell-type coercion mirrors queries.ts /
 * sqlIndicators.ts:
 *   - BIGINT → Number (lightweight-charts and JS arithmetic don't
 *     mix with BigInt; we never deal in values that overflow Number)
 *   - DATE   → ISO YYYY-MM-DD string (the 'date' format consumer
 *     just renders the string as-is)
 *   - everything else → pass-through string | number
 *   - null / undefined → null (callers render as "—")
 */
export async function runScreen(
  screen: ScreenDefinition,
  positions: Position[],
): Promise<ScreenRow[]> {
  const conn = await getConn();
  const sql = screen.buildSql(positions);
  const result = await conn.query(sql);
  return result.toArray().map((row) => {
    const r = row.toJSON() as Record<string, unknown>;
    const out: ScreenRow = {};
    for (const col of screen.columns) {
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
