# Finmarkets Monitor

Personal browser-based tool for monitoring a single equity position with a tax-overhang
exit framework. Built for monitoring an AAPL RSU position but applicable to any single
equity.

## Stack

- Svelte 5 + TypeScript + Vite
- DuckDB-WASM (OPFS persistence) for storage and analytics
- Lightweight Charts (TradingView OSS) for visualization
- technicalindicators (npm) for RSI/MACD math
- Twelve Data API for OHLCV (free tier, 800 req/day)

## Setup

1. `npm install`
2. `npm run dev`
3. Open http://localhost:5173
4. Get a free Twelve Data API key at https://twelvedata.com/
5. Enter it in the Settings panel along with your vest price, shares, and tax rate
6. Click "Refresh data" to pull historical OHLCV
7. Review the Witness Panel and Chart for the current state

## Deployment

Deployed to Cloudflare Pages at https://finmarkets-monitor.pages.dev (after first deploy).

### One-time setup

You need a Cloudflare account and a Pages project. The first deploy will create the
project automatically; subsequent deploys update it.

```bash
npx wrangler login   # opens browser for OAuth, one-time
```

### Deploy

```bash
npm run deploy           # production deploy (--branch=main)
npm run deploy:preview   # preview deploy (--branch=preview)
```

The deploy command runs `npm run build` first, then uploads `dist/` to Cloudflare Pages.

### DuckDB WASM hosting

The DuckDB-WASM binaries (~40 MB each) are loaded at runtime from jsDelivr's
npm mirror (https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm/) rather than
bundled into the deployed assets. Cloudflare Pages caps individual file uploads
at 25 MiB, and the WASM files exceed that.

The version is pinned in `src/lib/duckdb.ts` (`DUCKDB_WASM_VERSION` constant)
and must be kept in sync with the installed npm package. If you bump
`@duckdb/duckdb-wasm`, also update the constant in `duckdb.ts`.

### Notes

- The Twelve Data API key is stored in browser `localStorage`, not in the deployed bundle.
  Each user enters their own key in the Settings panel after the page loads.
- All data lives in the user's browser (DuckDB-WASM + OPFS). No backend, no user accounts,
  no server-side storage.
- The site is fully static — no Cloudflare Workers Functions, no KV, no D1.

## Companion docs

The methodology this app implements lives in:

- `~/docs/finmarkets/aapl-monitoring-guide.md` — three-phase educational guide
- `~/docs/finmarkets/aapl-weekly-review.md` — the Sunday checklist template

## Disclaimers

Educational use only. Not investment, tax, or legal advice. The app applies
mechanical rules from the companion docs to live data; it does not replace
personal judgment, professional advisors, or your reading of the underlying
documents.

## Commands

- `npm run dev` — dev server
- `npm run build` — production build
- `npm run check` — type check
- `npm test -- --run` — run vitest suite
