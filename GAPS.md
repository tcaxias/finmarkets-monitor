# Gaps

Honest engineering record of what doesn't work, what works partially, what was
deliberately traded off, and what's structurally deferred. Distinct from
[CHANGELOG.md](./CHANGELOG.md)'s `### Deferred` blocks (which are scoped to
individual commits) and [README.md](./README.md)'s `## Disclaimers` (which is
user-facing educational/advice framing).

If you're evaluating this project for production use beyond personal
single-user equity monitoring — read this file first.

---

## Known limitations

Things that don't work, work partially, or surprise users.

### Single-user, single-tab by design

DuckDB-WASM with OPFS persistence has no concurrency story. Two browser tabs
open against the same OPFS file will race and can corrupt the database.
Acceptable for the intended use (one user, one tab); a real problem for any
sharing scenario.

### Twelve Data free-tier limits

- **800 requests/day total.** Each ticker refresh = 1 request. Earnings refresh = 1 request. With 5 positions and a "Refresh all" once an hour, you'd burn through the daily quota. Heavy users should provision a paid key or wire in an alternate provider.
- **8 requests/minute** rate limit. The "Refresh all" path inserts 8s gaps when refreshing >7 positions, but a user who clicks "Refresh active" rapidly across many tickers can still get throttled.
- **15-minute delayed intraday data** on the free tier (US equities). The "1D" timeframe shows real bars but they're 15 minutes stale.

### Existing OPFS data on schema upgrade

The migrations system (`src/lib/migrations.ts`) is forward-only — there's no
`down()` to reverse a migration. If a future migration breaks an installation,
the only recovery is "Clear cache" (which drops all data) followed by
re-fetching from the API. There's no point-in-time rollback for OPFS state.

### Browser notification permission gates

Alerts can fire **in-app toasts** unconditionally, but **OS-level notifications**
require the user to grant `Notification.requestPermission()` from a button click
inside the AlertsPanel. If the user dismisses or denies the permission prompt,
the in-app toast is the only signal — easily missed if the tab is in the
background. There's no fallback to email, SMS, push, or any out-of-band channel.

### Alert evaluation only fires while the page is open

Alert rules are persisted in DuckDB but **evaluation runs in the browser**, not
on a server. If the tab is closed, no evaluation happens. A breakout that occurs
overnight will be detected only when the user next opens the page and refreshes.
This is the largest gap between the "active monitoring" framing and what the
implementation actually delivers.

### Alert fire history grows unbounded

`alert_fires` rows are written every time an alert transitions but never auto-
deleted. Over months of use this table will accumulate. There's no scheduled
cleanup. A future migration or a manual "Clear acknowledged fires older than
N days" action would close this.

### Indicator math: byte-level parity with reference platforms unverified

The recursive-CTE RSI(14), MACD(12,26,9), and rolling VWAP(20) implementations
are mathematically faithful to Wilder, Appel, and the textbook definitions
respectively, and are integration-tested against deterministic synthetic series
(see `src/lib/__tests__/`). Manual cross-checks against investing.com and
TradingView VWMA(20) are documented in CHANGELOG `[0.1.0]` under "Verified" —
but no automated regression test pins our outputs against a third-party
reference. Subtle implementation differences (e.g., Wilder's smoothing seed
choice, Twelve Data's split/dividend adjustment vs. the reference) can produce
small but persistent deltas.

### Volume profile single-bar attribution

Each bar's volume is fully attributed to the bucket containing its **close**.
A bar that traversed several price buckets during the session contributes
volume to only one. This is the simplest profile model; the more accurate
"TPO-style" range distribution is an order of magnitude more complex and
qualitatively similar for daily bars. Documented in `src/lib/queries.ts` next
to `getVolumeProfile`.

### Volume profile doesn't react to chart zoom on every event

The overlay re-aligns on chart visible-range changes (subscribed via
`subscribeVisibleLogicalRangeChange`, throttled with `requestAnimationFrame`).
Edge cases — programmatic price-scale changes, autoscale toggles outside the
range subscription — may briefly desync the overlay. A round-trip through
zoom/pan re-aligns it.

### Correlation matrix scales O(N²) per refresh

`getCorrelationMatrix` runs one SQL query per pair. For the typical 1–5
positions this is sub-second; for 20+ positions you'd want to switch to a
single UNION ALL query. Not a current-state limitation; a known scaling cliff.

### Volatility regime requires ≥20 bars

The StatusBanner Vol pill hides until at least 20 daily returns are sampled.
For a freshly-added position with <20 bars of history, the regime classification
isn't shown — by design (annualized stddev needs more bars to stabilize). The
side-effect: new users see a missing badge for their first day or two of usage.

### Backup refs after the FIVN scrub were deleted locally

Per the v0.1.0-era scrub work, the local `pre-scrub-backup` and
`refs/backups/origin-main-pre-scrub` refs that pinned the original FIVN-bearing
history have been garbage-collected. The pre-scrub history is unrecoverable on
any clone. The remote (GitHub) was force-pushed to the scrubbed history; old
commit SHAs (`970ada0`, `dff0298`, etc.) may still resolve via direct URL on
GitHub for ~90 days due to GitHub's orphaned-commit retention. See the GAPS
"Out of scope" section for follow-up if you care.

### Commits show as "Unverified" on GitHub

The local signing key (`AE42F6DB0D2A07A5F3D670BEAB749194D3679B78`) signs every
commit, but its UID emails don't include the GitHub noreply address
(`12184375+tcaxias@users.noreply.github.com`) used as the author email. GitHub
rejects the signature with `bad_email`. Easy fix (~5 min): add the noreply UID
to the GPG key and re-import to GitHub. Not done.

---

## Conscious tradeoffs

Choices made deliberately, with rationale that survives review.

### DuckDB-WASM as the analytical engine

5 MB WASM binary loaded from jsDelivr CDN on first visit is a real cost. Chosen
anyway because the alternative for cross-ticker SQL JOINs, recursive-CTE
indicator math, and historical backtests would be hand-rolled JS array
gymnastics — much harder to read, much easier to get subtly wrong. The
integration tests run against `@duckdb/node-api` (devDep) so SQL bugs are
caught at test time, not deploy time. This is the central architectural bet of
the project.

### Lazy WASM loading from jsDelivr instead of bundling

DuckDB's two WASM binaries (35 MB MVP + 41 MB EH) exceed Cloudflare Pages' 25
MiB per-file upload cap. Loading from jsDelivr's npm mirror means a third-party
runtime dependency at first visit and ~76 MB of transfer (cached after first
hit). Acceptable because it's the canonical DuckDB-WASM production pattern and
the alternative (Cloudflare R2 + custom domain) adds ongoing storage cost and
infra complexity for marginal benefit.

### Test fixtures duplicate SQL strings from production code

`src/lib/__tests__/duckdb-fixture.ts` inlines the migration SQL and several
indicator/screener queries rather than importing them. This is intentional —
importing from `src/lib/migrations.ts` would couple the test setup to the
production module's API surface, and the duplication is small. The cost is
that a real schema bug introduced via a migration could be missed if the test
fixture's inlined version diverges from the production migration. Mitigated by
the integration tests that exercise the production query paths, which DO use
the real migrations indirectly.

### Strict edge semantics on alert rules

`shouldFire()` returns `false` on first evaluation (`prev === null`), even when
the current state is on the firing side. A new "alert when AAPL closes below
$100" rule against a stock currently at $95 will NOT fire on the next refresh —
it will only fire when AAPL crosses back above $100 and then below again. This
is "correct" behavior in the strict-edge model and matches user expectation
("I just made the rule; nothing transitioned"), but is occasionally surprising.
Documented in `src/lib/alerts.ts` near `shouldFire`.

### Alerts evaluation gated on data-refresh cadence

Alerts evaluate only when a ticker's `evalState.byTicker[ticker].generation`
bumps — i.e., after a successful data refresh, asOf change, or timeframe
change. They do NOT poll on a timer. If the user opens the page and never
refreshes, no alerts evaluate. This avoids spurious "alert fired because we
re-evaluated against unchanged data" noise but means the user controls the
evaluation cadence. Documented in `src/lib/alertsRunner.svelte.ts`.

### `pre-flight` section of Sunday review left blank

The auto-generated weekly-review markdown intentionally does NOT pre-fill the
"private numbers" pre-flight section (vest price, share count, tax rate). The
generator has the data; it deliberately omits it so a user can paste the
generated review into screenshots / shared docs without leaking private
position data. Documented in `src/lib/sundayReview.ts`.

### Ticker validation regex `/^[A-Z0-9]{1,10}$/`

This rejects legitimately-formatted tickers like `BRK.B`, `BF-B`, indices with
slashes/spaces, or international tickers with Unicode. Chosen because (a) every
SQL string interpolation downstream relies on this validation as the only
defense against injection, and (b) Twelve Data's free tier mostly returns
US-equity-shaped symbols anyway. If support for other markets is needed, the
validation needs to be widened AND every SQL interpolation site needs to be
audited for the new shape.

### License: `Apache-2.0 OR MIT`

Dual-licensed at the user's option. Apache-2.0 brings the explicit patent grant
that some users / downstream projects need; MIT brings the brevity that a lot
of permissive consumers expect. The Rust pattern. Costs us a `NOTICE` file and
attribution discipline; pays off if anyone ever uses this code in their own
project. See `LICENSE`, `LICENSE-APACHE`, `LICENSE-MIT`, `NOTICE`.

---

## Deferred work

Bigger structural items that aren't blocking but would meaningfully improve the
project. Different from CHANGELOG `### Deferred` blocks (those are commit-
scoped, e.g., "didn't dedupe CSS in this commit"); these are project-scoped.

### Server-side alert evaluation

Currently alerts only fire while the tab is open. A scheduled Cloudflare Worker
or similar could pull OHLCV, evaluate rules against the same DuckDB schema,
and push notifications via email/web push. Substantial: requires the OPFS
state to be either replicated server-side or replaced with a remote DB. Closes
the "active monitoring" gap honestly.

### CI workflow (GitHub Actions)

Currently every change is deploy-and-pray; CI would run `npm run check && npm
test -- --run && npm run knip && npm run build` on push and PR. ~10 minutes to
add. Catches type errors, test regressions, and dead-export drift before they
reach a deploy. Mentioned several times across reviews; not yet done.

### Cloudflare Pages Git auto-deploy

Push-to-main → CF builds and ships, replacing the manual `npm run deploy`.
Removes a deployment step and makes the deploy a guaranteed consequence of
landing on `main`. ~10 minutes via the Cloudflare dashboard.

### Multi-source data ingest

DuckDB reads CSV / Parquet / JSON natively. The browser `<input type="file">`
+ DuckDB's `read_csv` could let users drag a Yahoo Finance CSV export or a
broker statement Parquet into the app and merge it with Twelve Data history.
Would unlock longer historical ranges, alternate data sources, and actual buy/
sell event tracking. ~half-day to wire up; substantial value for power users.

### Tax-lot tracking

The current "tax overhang" framework treats a position as a single weighted
unit (vest price + shares + tax rate). Real tax accounting needs share-by-
share lot tracking with FIFO/LIFO/specific-ID cost basis selection, wash-sale
detection, and per-lot capital-gain calculation. New `tax_lots` table; new
panel; new exit-framework math. Significant feature; meaningful for users
with multiple vests or partial sales.

### Hedging math (collars / protective puts)

Black-Scholes pricing for European options or finite-difference for American
options. Lets the user model "what if I buy a $90 put against my AAPL
position?" Pure JS math (no DuckDB). The natural next layer for tax-trapped
RSU holders worried about downside but unwilling to sell. ~half-day.

### Custom domain for the Cloudflare Pages deployment

Replaces `finmarkets-monitor.pages.dev` with a domain you control. Cosmetic
unless you also want SPF/DMARC for outgoing alert emails (which requires
server-side evaluation, see above).

### Scheduled per-day refresh via service worker

A Service Worker registered with Background Sync could trigger a daily
post-market-close refresh without the user needing to open the page. Browser
support is uneven (Safari doesn't); a fallback to "show a banner if data is
>1 day stale" is the cross-browser path. Out-of-scope for v0.1; useful for
users who check the app irregularly.

---

## Out of scope

Things this project intentionally does not aim to be. Not deferred — actively
declined.

### Multi-user / shared workspaces

The project is a single-user personal tool. There's no auth, no per-user data
partitioning, no role model. OPFS is browser-profile-scoped. Building any of
this would change the project's character entirely.

### Mobile-responsive layout

The UI is designed for desktop screens. Charts and tables don't reflow nicely
to narrow viewports. The author uses this on a Mac, not a phone. No effort
will go into mobile UX.

### Internationalization

Single user, English speaker, US-equity ticker conventions. Currency is
implicitly USD throughout. Date formats are ISO. No i18n tooling will be added.

### Real-time tick streaming

The app polls Twelve Data on user action. There is no WebSocket connection,
no real-time tick stream, no in-flight order routing. If you need
sub-second updates, this is the wrong tool.

### Brokerage integration

The app reads price data and applies an analytical framework. It does NOT
place trades, manage orders, or talk to any brokerage API. That responsibility
stays with the user.

### "Production" SaaS readiness

No multi-tenant DB, no SLA, no incident response, no audit log compliance, no
SOC 2 / GDPR documentation. The project is a personal tool published openly
under permissive licenses; users who fork it for any organizational use take
on those obligations themselves.

---

## See also

- [README.md](./README.md) — setup, deployment, license
- [CHANGELOG.md](./CHANGELOG.md) — per-version change history; `### Deferred`
  blocks under each release capture commit-scoped follow-up items
- [NOTICE](./NOTICE) — third-party attribution required by Apache-2.0 §4(d)
- [LICENSE](./LICENSE) — dual-license declaration (Apache-2.0 OR MIT)
