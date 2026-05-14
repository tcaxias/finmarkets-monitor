// Cross-ticker Anomaly Detection — the closing piece of the
// DuckDB-leverage push. Three classes of "this bar is unusual" SQL
// detectors run set-based across the entire OHLCV history of every
// configured position.
//
// Why SQL? Each detector compares a row against a window of its own
// history (or the prior row), then filters across every ticker. In JS
// arrays that's a nested loop per ticker per detector — a few hundred
// lines of bookkeeping for what DuckDB expresses in a single window
// function. STDDEV_SAMP / AVG over a `ROWS BETWEEN 60 PRECEDING AND
// 1 PRECEDING` window gives the trailing-mean-and-stddev for the
// volume z-score in one statement; LAG(close) gives prev_close for
// the gap detector; LAG(sma50 - sma200) catches sign changes for the
// regime crossings. None of these would be elegant in JS arrays —
// that's the whole point of having SQL in the browser.
//
// Architectural mirror of screener.ts: ANOMALIES catalog of typed
// definitions, runAnomaly executor, AnomaliesPanel.svelte UI on top.
// Result-row coercion (BIGINT → Number, DATE → ISO string) matches
// screener.ts so the table renderer can stay shared in spirit.
//
// Security: same model as the Screener — tickers are validated by
// `TICKER_RE = /^[A-Z0-9]{1,10}$/` in settings.svelte before reaching
// this layer; `quoteTicker` adds SQL-string escaping as defence in
// depth. No user-controlled numerics are interpolated (all thresholds
// are baked literals).

import { getConn } from './duckdb';
import type { Position } from './settings.svelte';

/**
 * Display formatting hints consumed by AnomaliesPanel.svelte:
 *   - 'price'  → `$XX.XX`
 *   - 'pct'    → `+X.X%` / `-X.X%`, colour-coded by sign
 *   - 'number' → 2 decimals; large numbers (volumes) get thousands separators
 *   - 'date'   → ISO date as-is
 *   - 'string' → as-is
 *   - 'zscore' → 1-decimal z-score with severity colouring
 *                (yellow at ≥3, orange at ≥4, red at ≥5)
 */
interface AnomalyColumn {
  key: string;
  label: string;
  format?: 'price' | 'pct' | 'number' | 'date' | 'string' | 'zscore';
}

export interface AnomalyDefinition {
  id: string;
  label: string;
  description: string;
  category: 'volume' | 'price' | 'regime';
  /**
   * Build the SQL for this detector given the user's positions. Empty
   * positions array → SQL emits a no-op `IN ('')` clause that no real
   * ticker can satisfy, so the result set is empty without a syntax
   * error.
   */
  buildSql: (positions: Position[]) => string;
  columns: AnomalyColumn[];
}

export interface AnomalyRow {
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
 * Render a comma-separated list of quoted tickers for a `WHERE ticker
 * IN (...)` clause. Empty positions → `''` (the empty string, which no
 * real ticker can equal). Keeps the SQL syntactically valid (`IN ()`
 * is a parse error in DuckDB) while guaranteeing zero matches.
 */
function tickerListSql(positions: Position[]): string {
  if (positions.length === 0) return "''";
  return positions.map((p) => quoteTicker(p.ticker)).join(', ');
}

export const ANOMALIES: AnomalyDefinition[] = [
  {
    id: 'volume-zscore-3',
    label: 'Volume z-score ≥ 3 (last 30 days)',
    description:
      'Bars where the volume was at least 3 standard deviations above the trailing 60-day mean. Unusual liquidity is often a leading indicator of significant news, breakouts, or capitulation. Limited to the last 30 trading days for relevance.',
    category: 'volume',
    // STDDEV_SAMP + AVG over a `ROWS BETWEEN 60 PRECEDING AND 1
    // PRECEDING` window gives the trailing-60-day mean/stddev that
    // *excludes* the current bar — so the z-score measures how
    // surprising today's volume is against the recent baseline,
    // without the bar contaminating its own reference. We then
    // ROW_NUMBER over the same partition to keep only the last 30
    // bars per ticker (relevance). The CASE around the z-score
    // guards against a degenerate stddev=0 window (a string of
    // identical volumes — unlikely but cheap to defend).
    buildSql: (positions) => `
      WITH stats AS (
        SELECT
          ticker,
          dt,
          volume,
          AVG(volume) OVER (
            PARTITION BY ticker ORDER BY dt
            ROWS BETWEEN 60 PRECEDING AND 1 PRECEDING
          ) AS mean_vol,
          STDDEV_SAMP(volume) OVER (
            PARTITION BY ticker ORDER BY dt
            ROWS BETWEEN 60 PRECEDING AND 1 PRECEDING
          ) AS sd_vol,
          ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY dt DESC) AS rn
        FROM ohlcv
        WHERE volume IS NOT NULL
      )
      SELECT
        ticker,
        dt,
        volume,
        mean_vol,
        CASE WHEN sd_vol > 0 THEN (volume - mean_vol) / sd_vol ELSE NULL END AS zscore
      FROM stats
      WHERE ticker IN (${tickerListSql(positions)})
        AND rn <= 30
        AND sd_vol > 0
        AND (volume - mean_vol) / sd_vol >= 3.0
      ORDER BY zscore DESC
      LIMIT 50
    `,
    columns: [
      { key: 'ticker', label: 'Ticker', format: 'string' },
      { key: 'dt', label: 'Date', format: 'date' },
      { key: 'volume', label: 'Volume', format: 'number' },
      { key: 'mean_vol', label: '60d avg vol', format: 'number' },
      { key: 'zscore', label: 'Z-score', format: 'zscore' },
    ],
  },
  {
    id: 'price-gaps',
    label: 'Price gaps > 2% (last 30 days)',
    description:
      'Bars where the open was at least 2% above (gap-up) or below (gap-down) the prior close. Gaps often follow material news (earnings, sector moves, M&A) and can either fill back or sustain — depends on the regime context.',
    category: 'price',
    // LAG(close) gives prev_close in one statement; ABS on the
    // percentage handles both directions in a single predicate. The
    // CASE labels gap-up vs gap-down for the rendered table. We
    // ORDER BY ABS(gap_pct) so the most violent gaps surface first —
    // direction is information, but magnitude is what triggers the
    // "investigate this" reflex.
    buildSql: (positions) => `
      WITH gaps AS (
        SELECT
          ticker,
          dt,
          open,
          close,
          LAG(close) OVER (PARTITION BY ticker ORDER BY dt) AS prev_close,
          ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY dt DESC) AS rn
        FROM ohlcv
      )
      SELECT
        ticker,
        dt,
        prev_close,
        open,
        close,
        100.0 * (open - prev_close) / prev_close AS gap_pct,
        CASE WHEN open > prev_close THEN 'gap-up' ELSE 'gap-down' END AS direction
      FROM gaps
      WHERE ticker IN (${tickerListSql(positions)})
        AND rn <= 30
        AND prev_close IS NOT NULL
        AND ABS(100.0 * (open - prev_close) / prev_close) >= 2.0
      ORDER BY ABS(gap_pct) DESC
      LIMIT 50
    `,
    columns: [
      { key: 'ticker', label: 'Ticker', format: 'string' },
      { key: 'dt', label: 'Date', format: 'date' },
      { key: 'direction', label: 'Type', format: 'string' },
      { key: 'prev_close', label: 'Prev close', format: 'price' },
      { key: 'open', label: 'Open', format: 'price' },
      { key: 'gap_pct', label: 'Gap', format: 'pct' },
    ],
  },
  {
    id: 'regime-shifts',
    label: 'Regime shift (50/200 cross, last 90 days)',
    description:
      'Bars where the 50-day SMA crossed above the 200-day SMA (golden cross — bullish regime change) or below (death cross — bearish regime change), within the last 90 trading days. The 50/200 cross is the canonical institutional regime signal.',
    category: 'regime',
    // Two windowed AVGs give the 50/200 SMAs; COUNT(*) on the same
    // 200-bar window guards against partial-window bogus values
    // (mirrors the `m.w >= 200` guard in the above-sma200 screen).
    // The crossing detector is LAG(sma50 - sma200) — sign change in
    // that difference between yesterday and today is exactly a
    // golden/death cross. `<= 0` and `>= 0` (rather than strict <,>)
    // catch the corner case where the SMAs touch on day t-1 and
    // separate on day t, which is still a regime event in practice.
    buildSql: (positions) => `
      WITH mas AS (
        SELECT
          ticker,
          dt,
          close,
          AVG(close) OVER (
            PARTITION BY ticker ORDER BY dt
            ROWS BETWEEN 49 PRECEDING AND CURRENT ROW
          ) AS sma50,
          AVG(close) OVER (
            PARTITION BY ticker ORDER BY dt
            ROWS BETWEEN 199 PRECEDING AND CURRENT ROW
          ) AS sma200,
          COUNT(*) OVER (
            PARTITION BY ticker ORDER BY dt
            ROWS BETWEEN 199 PRECEDING AND CURRENT ROW
          ) AS w200
        FROM ohlcv
      ),
      crosses AS (
        SELECT
          ticker,
          dt,
          close,
          sma50,
          sma200,
          LAG(sma50 - sma200) OVER (PARTITION BY ticker ORDER BY dt) AS prev_diff,
          sma50 - sma200 AS curr_diff,
          ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY dt DESC) AS rn
        FROM mas
        WHERE w200 >= 200
      )
      SELECT
        ticker,
        dt,
        close,
        sma50,
        sma200,
        CASE
          WHEN prev_diff <= 0 AND curr_diff > 0 THEN 'golden-cross'
          WHEN prev_diff >= 0 AND curr_diff < 0 THEN 'death-cross'
        END AS event
      FROM crosses
      WHERE ticker IN (${tickerListSql(positions)})
        AND rn <= 90
        AND prev_diff IS NOT NULL
        AND ((prev_diff <= 0 AND curr_diff > 0) OR (prev_diff >= 0 AND curr_diff < 0))
      ORDER BY dt DESC
      LIMIT 25
    `,
    columns: [
      { key: 'ticker', label: 'Ticker', format: 'string' },
      { key: 'dt', label: 'Date', format: 'date' },
      { key: 'event', label: 'Event', format: 'string' },
      { key: 'close', label: 'Close', format: 'price' },
      { key: 'sma50', label: '50-MA', format: 'price' },
      { key: 'sma200', label: '200-MA', format: 'price' },
    ],
  },
];

export function getAnomalyById(id: string): AnomalyDefinition | undefined {
  return ANOMALIES.find((a) => a.id === id);
}

/**
 * Execute an anomaly detector against the given positions and return
 * rows shaped for direct rendering. DuckDB cell-type coercion mirrors
 * screener.ts / queries.ts:
 *   - BIGINT → Number (lightweight-charts and JS arithmetic don't
 *     mix with BigInt; we never deal in values that overflow Number)
 *   - DATE   → ISO YYYY-MM-DD string
 *   - everything else → pass-through string | number
 *   - null / undefined → null (callers render as "—")
 */
export async function runAnomaly(
  anomaly: AnomalyDefinition,
  positions: Position[],
): Promise<AnomalyRow[]> {
  const conn = await getConn();
  const sql = anomaly.buildSql(positions);
  const result = await conn.query(sql);
  return result.toArray().map((row) => {
    const r = row.toJSON() as Record<string, unknown>;
    const out: AnomalyRow = {};
    for (const col of anomaly.columns) {
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
