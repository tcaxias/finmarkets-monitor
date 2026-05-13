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
