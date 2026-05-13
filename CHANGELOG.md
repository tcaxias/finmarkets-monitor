# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
