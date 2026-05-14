# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Cross-ticker Anomaly Detection panel** — three SQL-native detectors
  grouped into Volume (z-score ≥ 3 over the trailing 60-day mean,
  last 30 days), Price (gaps ≥ 2% open-vs-prev-close, last 30 days),
  and Regime (50/200 SMA golden/death crossings, last 90 days). Each
  detector is a one-click button against the user's full OHLCV
  history. Closes the DuckDB-leverage push: each query is a single
  window-function statement (`STDDEV_SAMP`/`AVG` over a `60 PRECEDING
  AND 1 PRECEDING` window for the z-score; `LAG(close)` for gaps;
  `LAG(sma50 - sma200)` sign-change for crossings) — none of these
  would be elegant in JS arrays. Lives in Portfolio mode between
  Screener and PortfolioCharts. New `src/lib/anomalies.ts` owns the
  `ANOMALIES` catalog plus a `runAnomaly` executor; new
  `src/components/AnomaliesPanel.svelte` renders the trigger grid +
  results table with a new `zscore` cell format that severity-codes
  the magnitude (yellow ≥3, orange ≥4, red ≥5). 24 new tests pin
  catalog invariants, every detector's SQL shape (window sizes,
  threshold predicates, label literals), the `w200 >= 200` partial-
  window guard for crossings, and the empty-positions safety branch.
- **Per-ticker Backtest panel** — historical conviction chart + three
  predefined example backtest queries. Lives in per-ticker view between
  the indicators (RSI/MACD) and ReviewExport. Section A renders the
  witness verdict over the last 250 daily bars as a Lightweight Charts
  step-line on a −2..+2 axis (high-bullish=2, neutral=0, high-bearish=−2),
  with a stats strip showing % time bullish/bearish/neutral and the count
  of regime transitions. Section B exposes three one-click SQL backtests
  against the user's own OHLCV + materialised indicator history:
  *Bullish Fridays in 2025* (RSI > 50 + close > 20-MA on Fridays),
  *Best 30-day rolling windows* (top 10 by close-to-close return,
  using `LAG(_, 30)` for the rolling baseline), and *RSI extremes →
  10-day forward return* (mean-reversion check via a self-JOIN by
  `ROW_NUMBER` offset of 10). New `src/lib/backtest.ts` owns the
  `BACKTEST_QUERIES` catalog, the `runBacktest` executor, and the
  `computeHistoricalConviction` helper (a JS loop over the existing
  pure witness functions for each historical bar — keeps witnesses.ts
  as the single source of truth for "what is bullish"). New
  `src/components/BacktestPanel.svelte` renders both sections with the
  same trigger-grid + results-table idiom as ScreenerPanel for visual
  parity. 30 new tests pin each query's SQL shape, the
  CONVICTION_NUMERIC mapping, and conviction transitions on synthetic
  series via the extracted-pure `computeConvictionSeries` helper.
- **Cross-ticker Screener panel** — six predefined SQL screens grouped
  into Momentum (Overbought RSI > 70, Oversold RSI < 30, MACD bullish
  crossover in the last 5 days), Trend (below 20-day SMA, above 200-day
  SMA), and Risk (approaching Pcover within 20%). Each screen is a
  one-click button that JOINs the `current_snapshot` view (migration
  v2) with the materialised indicator tables (migration v3) — the
  headline DuckDB-leverage feature. Lives in Portfolio mode between
  PortfolioOverview and PortfolioCharts. New `src/lib/screener.ts`
  owns the `ScreenDefinition[]` catalog plus a `runScreen` executor;
  new `src/components/ScreenerPanel.svelte` renders the trigger grid +
  results table. The Pcover screen pushes per-position numeric data
  into SQL via a `VALUES (...)` CTE, filtering tax-tracked positions
  in SQL rather than post-filtering JS results. 27 new tests pin each
  screen's SQL shape (live integration via the running app, since the
  test harness has no DuckDB-WASM).
- **RSI(14) and MACD(12,26,9) computed in DuckDB SQL** via recursive
  CTEs and materialised into new `indicators_rsi` and `indicators_macd`
  tables (migration v3). New `src/lib/sqlIndicators.ts` owns the write
  side (`materializeRsi`, `materializeMacd`, `refreshIndicators`) and
  the read side (`readRsi`, `readMacd`). The data layer
  (`refreshData`) calls `refreshIndicators` after every successful
  OHLCV insert so subsequent chart renders are indexed reads, not
  per-render recomputations. The chart consumer (`evaluation.svelte.ts`)
  now reads from the materialised tables instead of computing on the fly.
- **Schema migrations infrastructure** — new `src/lib/migrations.ts`
  with versioned, append-only migrations recorded in a `_meta` table.
  `ensureSchema()` now delegates to `runMigrations()` instead of
  inlining DDL. Each migration runs in its own transaction so a
  failure in v(N) leaves the database recoverable at v(N-1).
  Migration v1 captures the existing baseline (idempotent
  `CREATE TABLE IF NOT EXISTS` for `ohlcv`, `ohlcv_intraday`,
  `fetch_log`); existing OPFS databases upgrade transparently.
- **`current_snapshot` view** (migration v2) — one row per ticker with
  latest OHLC, prev_close, latest_volume, and row_count, joined in
  SQL. New `getCurrentSnapshot()` query helper exposes it as
  `SnapshotRow[]`. Infrastructure for the upcoming Screener panel and
  a future PortfolioOverview migration; not yet wired into the UI.
- **Chart toolbar** — eight timeframe buttons (1D, 1M, 3M, 6M, YTD, 1Y,
  2Y, All) plus eight series toggles (SMA20, SMA50, SMA200, Volume,
  Pcover lines, Vest line, RSI pane, MACD pane). State persists to
  localStorage under `finmarkets-monitor:chartPrefs`.
- **Intraday (1D) view** — new `ohlcv_intraday` table, dedicated 5-min
  fetch path against Twelve Data, and a "Refresh intraday" button on
  the toolbar when the 1D timeframe is active. Indicator math is
  skipped for intraday (RSI/MACD/SMAs are daily-only concepts) and
  the chart's time scale renders HH:MM granularity.
- **Timeframe windowing** — daily queries now accept a `since` filter
  computed from the active timeframe so each pull only retrieves the
  visible slice. SMA window math reaches into pre-`since` history for
  warmup so the leading edge of the visible average is mathematically
  correct, not a partial-window artefact.
- **SMA(50) series** — additional medium-term moving average drawn
  alongside SMA(20) and SMA(200) when its toggle is on (default: off).
- **`IndicatorsAbout` collapsible panel** — definition list of every
  toggleable concept (candles, volume, SMAs, RSI, MACD, Pcover, Vest)
  with a 2-3 sentence financial explanation. Same descriptions are
  surfaced as `title` tooltips on the toolbar buttons.
- **Tests** — `chartPrefs.test.ts` covers defaults, persistence,
  rehydration, malformed-storage fallback, unknown-key tolerance, and
  the `timeframeSince` date math; `twelvedata.test.ts` locks down the
  `buildTimeSeriesUrl` parameter wiring across daily and intraday
  intervals.

### Changed

- **`TickerLinks`** — replaced the `<details>` dropdown with an
  always-visible inline horizontal pill row. Used in `StatusBanner`
  only (right-aligned via `margin-left: auto`); removed from
  `PortfolioOverview` rows where the per-row links crowded the dense
  table.
- **`fetchDailyOhlcv` → `fetchOhlcv`** — generalised to take an
  `interval` parameter; the legacy `fetchDailyOhlcv` is preserved as a
  thin wrapper for backward compatibility. New `fetchIntradayOhlcv`
  returns `IntradayRow[]` with a `ts` field (vs daily's `dt`) so
  callers can route to the right table without ambiguity.
- **`evaluation.svelte.ts`** — `flightKey` now includes the active
  timeframe so a timeframe switch mid-flight schedules a fresh run
  instead of returning the prior in-flight slice. `PerTickerEval`
  carries `timeframe` and `isIntraday` so consumers can detect the
  cache state without re-reading prefs.
- **`indicators.ts`** — trimmed to type definitions
  (`RsiPoint`, `MacdPoint`, `ClosePoint`, `DivergenceFlag`) plus the
  pure `detectRsiDivergence` function. The previous JS-side
  `computeRsi` / `computeMacd` / `getRsi` / `getMacd` / `getCloses`
  wrappers around the `technicalindicators` npm package are removed —
  the math now lives in `sqlIndicators.ts` (DuckDB SQL recursive CTEs)
  and the read API is `readRsi` / `readMacd` against the materialised
  tables. Indicator-pane consumers (`evaluation.svelte.ts`) read from
  the new API; `sundayReview.ts` keeps using the divergence detector
  unchanged.

### Removed

- **`technicalindicators` npm dependency** — replaced by native DuckDB
  SQL recursive CTEs (see migration v3 + `sqlIndicators.ts`). Removed
  from `package.json`, `NOTICE`, and the `README.md` License table.
  9 unit tests that exercised the JS wrapper outputs are removed; the
  4 divergence tests (pure-function, no DuckDB) are retained.

### Risks (manual verification needed post-deploy)

- **SQL parity with the npm implementation is mathematically faithful**
  to Wilder's RSI smoothing and Appel's MACD chained EMAs but is
  unverified at build time — the vitest harness can't boot DuckDB-WASM
  (no worker, no OPFS). Compare a few RSI/MACD values from a live
  ticker against the prior deployment before trusting the new path.
- **Existing OPFS users will see empty RSI/MACD until the first
  refresh after upgrade.** Migration v3 creates the indicator tables
  but leaves them empty for already-stored OHLCV data; the next
  successful `refreshData` call populates them.

### Fixed (Phase A/B review findings)

- **`recomputeOne` asOfDate race** — in-flight dedupe was keyed only by
  ticker, so a date switch mid-flight would be dropped. Key is now
  `${ticker}|${asOf ?? 'live'}` and on completion the snapshot is
  re-checked against `viewState.asOfDate`; if it moved during the run,
  a follow-up `recomputeOne` is scheduled so the slice eventually
  settles on the current view.
- **`PortfolioOverview` null sort in descending mode** — nulls floated
  to the top in `dir = -1` because the direction multiplier was applied
  to the null comparison. Renamed `cmpNullable` → `cmpNullableDirected`
  and moved null placement before the direction multiply, so nulls
  always sort last regardless of `dir`.
- **`loadOrMigrate` activePositionId normalization** — new-shape branch
  now validates that the saved `activePositionId` references a
  surviving position; stale ids fall back to `positions[0]?.id ?? null`.
  Prevents the "no tab selected" limbo after manual localStorage edits
  or out-of-tab deletions.
- **`validatePosition` strict date check** — `taxDueDate` validation
  now uses the same UTC round-trip pattern as `viewState`'s
  `isValidAsOf`, rejecting impossible calendar dates like Feb 30 or
  month 13 that JS would otherwise silently normalize.
- **Historical-view banner is now sticky** under the page nav (`top:
  42px`, `z-index: 9`, with backdrop-filter) so it stays visible while
  scrolling through lower sections. `PositionTabs` shifts its sticky
  band down by ~38px in historical mode via a `:global()` rule on
  `.page.historical`.

5 new tests added (total: 118): 3 covering the strict date check
(Feb 30, month 13, real date) and 2 covering `activePositionId`
normalization (stale id with positions, stale id with empty positions).
The asOfDate race fix isn't directly testable without DuckDB-WASM in
the test runner; verified by reading the in-flight key construction.

### Added (Phase B — historical backtest mode)

- **`viewState.svelte.ts`** — reactive `asOfDate` Svelte rune state with
  `setAsOfDate`, `isHistorical`, and `daysAgo` helpers. Persisted to
  `localStorage` under `finmarkets-monitor:viewState` so a backtest
  survives reloads. Validation rejects malformed ISO strings, impossible
  calendar days (e.g. Feb 30), and future dates.
- **`HistoricalControls` component** — thin horizontal strip below the
  page nav with a `<input type="date">` (max=today), Apply, and Live
  buttons. Defaults the picker to today (live) or the current as-of
  date (historical).
- **Prominent amber banner** rendered immediately above `StatusBanner`
  whenever `viewState.asOfDate !== null`. Shows the as-of date,
  "(N days ago)", and a "Return to Live" button that clears the state.
- **Optional `asOf` parameter on every query and indicator fetcher**
  (`getCandles`, `getSma`, `getVolumeBars`, `getCloses`, `getRsi`,
  `getMacd`). When provided, SQL appends `AND dt <= CAST(? AS DATE)` —
  the explicit cast avoids the DuckDB-WASM bind-type quirk that surfaced
  in af22d1f.
- **`PerTickerEval.asOfDate` field** records the as-of date the slice
  was computed against, so consumers can detect a stale slice without
  reading viewState directly.
- **App-level `$effect`** watches `viewState.asOfDate` and triggers
  `recomputeAll()` so every ticker's slice rebuilds when the historical
  view changes.
- **Sunday review export uses `asOfDate` as `reviewDate`**. Adds
  `inputs.asOfDate` and `inputs.generatedAt` to `ReviewInputs`. The
  banner and auto-fill footer surface a separate "As of:" line when
  historical, while "Generated at:" continues to reflect wall-clock
  generation time.
- **`PortfolioOverview` "As of {date}" tag** in the panel header when
  in historical mode — consistent with the amber banner styling.
- **20 new tests** covering `setAsOfDate` validation (null, valid past,
  today, future, malformed, Feb 30), `isHistorical`, `daysAgo`,
  persistence, and historical Sunday-review banner/footer behavior.
  Total tests: 113 (up from 93).

### Notes (Phase B)

- **Chart vertical-line marker skipped.** The chart already truncates
  visually because the slice's candles are `<= asOfDate`, which makes
  the as-of point obvious. Adding a custom vertical marker via
  Lightweight Charts would have required a hidden series or marker
  hack — disproportionate complexity for a small visual cue.
- **Refresh-while-historical** still fetches latest data into DuckDB
  (the Twelve Data API call doesn't know about asOfDate). The next
  recompute then truncates against the active as-of date. This is
  intentional and acceptable for v1.

### Added (Phase A — multi-ticker portfolio support)

- **Multi-position portfolio model.** Settings now hold a list of
  `Position` objects (ticker, vest price, shares, tax rate, due date)
  instead of a single ticker scalar. The Twelve Data API key remains
  single since it ties to one account.
- **Forward-migration from the legacy single-ticker shape.** On first
  load, an existing `finmarkets-monitor:settings` payload with the old
  `{ ticker, vestPrice, ... }` shape is wrapped as `positions[0]` and
  rewritten to localStorage. Migration is idempotent.
- **`PositionTabs` sticky bar** under the status banner with one tab per
  position plus a "Portfolio" meta-tab. Arrow-key navigation supported.
- **`PortfolioOverview` component** — sortable table of every position
  with latest price, day change, Pcover threshold, distance/cushion,
  three-witness conviction, and last-updated relative time. Click a
  ticker to jump into its per-ticker view.
- **`PositionsPanel` component** replaces the old `SettingsPanel`. Inline
  add/edit/delete forms with synchronous validation
  (`validatePosition`).
- **Per-ticker evaluation cache.** `evalState.byTicker[ticker]` holds an
  independent slice (candles, MAs, RSI, MACD, witnesses) per position.
  `getEval(ticker)`, `recomputeOne(ticker)`, and `recomputeAll()`
  replace the old singleton `recompute`.
- **`refreshAll()` with rate-limit-aware sequencing.** Walks every
  configured position; spaces requests by 8s when there are more than
  7 positions to stay inside Twelve Data's 8 req/min free tier.
  Exposes per-batch progress via `dataState.refreshProgress`.
- **40 new tests** covering migration scenarios, validation rules, and
  every mutation helper. Total tests: 93 (up from 53).

### Changed (Phase A)

- **All per-ticker views (StatusBanner, Witness, Chart, RSI, MACD,
  ReviewExport) read from the active position's evaluation slice**
  rather than the old singleton `evalState`. When no position is
  active (portfolio overview mode), each panel renders a
  "select a position" placeholder.
- **`refreshData(ticker)` and `refreshState(ticker)` take an explicit
  ticker argument.** `dataState` now keeps per-ticker maps for row
  count, latest close, latest date, and last fetched.

### Removed

- **`SettingsPanel.svelte`** — replaced by `PositionsPanel.svelte`.

### Changed

- **Volume handling preserves nulls end-to-end.** `VolumeBar.value` is now
  `number | null`; consumers (`evaluateVolume`, `sundayReview`,
  `ChartPanel`) skip null-volume bars instead of silently coercing them to
  zero. Prevents missing source rows from biasing the 20-day trailing
  average toward zero and skewing the accumulation/distribution witness.
- **Indicators witness uses MACD line sign as the baseline regime.**
  Histogram expansion/contraction now modifies the reason string ("…
  bearish, histogram contracting = weakening trend") rather than gating
  the verdict. Fixes under-calling bearish in scenarios where the MACD
  line was below zero but the histogram was contracting.
- **Chart, RSI, and MACD panels render purely from the shared evaluation
  cache.** Removed direct DuckDB queries from `ChartPanel`, `RsiPanel`,
  and `MacdPanel`. They now observe `evalState.generation` and re-render
  when the cache refreshes — no more parallel queries running per-panel.

### Fixed

- **DuckDB-WASM binaries load from jsDelivr CDN instead of being bundled.**
  Cloudflare Pages caps individual file uploads at 25 MiB; the MVP (~39 MB)
  and EH (~34 MB) WASM blobs exceeded that limit, blocking deploys. The
  WASM URLs in `src/lib/duckdb.ts` now point at
  `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@<pinned-version>/dist/`.
  Worker files (~800 KB each) remain bundled via Vite `?url` imports.
  `DUCKDB_WASM_VERSION` constant pins the CDN version and must stay in sync
  with the installed npm dependency. `dist/` drops from ~75 MB to under 3 MB.
- **Settings panel no longer auto-collapses mid-edit.** Snapshot the
  "configured" state once at mount and bind `<details open>` to a local
  toggle. Previously the panel could collapse while the user was editing
  vest price or share count because the open-state was a `$derived` over
  reactive settings.
- **`logFetch` failures no longer poison successful refreshes.** A failure
  writing the audit log row after a successful data insert is logged to
  the console but does not mark the refresh as failed.
- **`ensureSchema` no longer leaks ad-hoc connections.** When called
  without a connection argument, the temporary connection is closed in a
  `finally` block.
- **`generateSundayReview` is deterministic w.r.t. the review date.**
  Time-pressure computation now uses `daysUntilFrom(reviewDate, taxDueDate)`
  instead of `daysUntil(taxDueDate)`, so the generated document is
  reproducible against the pinned `inputs.reviewDate` rather than
  silently depending on `new Date()` at call time.
- **In-page `#settings`, `#witnesses`, and `#review` anchors resolve.**
  Added missing `id` attributes to the wrapper sections in `App.svelte`
  so the sticky nav links work end-to-end.

### Added

- **Plaintext-storage warning under the API key input.** Reminds the user
  not to paste keys for shared accounts.
- **`daysUntilFrom(baseDate, targetIso)` in `math.ts`** — deterministic
  variant of `daysUntil` for callers that need to pin the reference date
  (Sunday review generation, unit tests).
- **Two new tests for the previously-undercalled MACD bearish case** —
  MACD line < 0 with histogram contracting now correctly produces a
  bearish indicators verdict (with a "weakening trend" qualifier).

### Notes

- Schema migrations (Minor 4) and DuckDB integration tests (Minor 5) from
  the same code review are intentionally deferred.
