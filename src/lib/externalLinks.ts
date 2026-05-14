// External per-ticker links.
//
// Pure function that maps a ticker symbol to a list of external resources
// (Yahoo, MarketWatch, Stocktwits, Earnings Whispers). Used by:
//   - StatusBanner: dropdown next to the active position's ticker badge
//   - PortfolioOverview: inline links beside each row's ticker
//
// Adding a new site = one entry in EXTERNAL_LINK_TEMPLATES below. The
// template is a function (not a string template) so call sites can do
// per-site URL massaging (e.g. lowercase, slugify) without leaking that
// concern into the consumer.
//
// Tickers are passed through as-is after trim/uppercase. Sites that
// require a different case (e.g. lowercase paths) handle it locally in
// their template function.

export interface ExternalLink {
  /** Display label, short enough for an inline pill ("Yahoo Quote"). */
  label: string;
  /** Fully-resolved URL. Always absolute, always https. */
  url: string;
  /** Short identifier for styling/icons; matches the template id below. */
  id: string;
}

interface LinkTemplate {
  id: string;
  label: string;
  build: (ticker: string) => string;
}

const EXTERNAL_LINK_TEMPLATES: LinkTemplate[] = [
  {
    id: 'yahoo-chart',
    label: 'Yahoo Chart',
    build: (t) => `https://finance.yahoo.com/chart/${t}/`,
  },
  {
    id: 'yahoo-quote',
    label: 'Yahoo Quote',
    build: (t) => `https://finance.yahoo.com/quote/${t}/`,
  },
  {
    id: 'stocktwits',
    label: 'Stocktwits',
    build: (t) => `https://stocktwits.com/symbol/${t}`,
  },
  {
    id: 'marketwatch',
    label: 'MarketWatch',
    // MarketWatch path is lowercase.
    build: (t) => `https://www.marketwatch.com/investing/stock/${t.toLowerCase()}`,
  },
  {
    id: 'earnings-whispers',
    label: 'Earnings Whispers',
    build: (t) => `https://www.earningswhispers.com/stocks/${t}`,
  },
];

/**
 * Build the list of external links for a ticker. Returns an empty array
 * for empty / whitespace input so callers can safely call this for the
 * "no active position" state without an extra guard.
 */
export function getExternalLinks(ticker: string): ExternalLink[] {
  const t = ticker.trim().toUpperCase();
  if (!t) return [];
  return EXTERNAL_LINK_TEMPLATES.map((tpl) => ({
    id: tpl.id,
    label: tpl.label,
    url: tpl.build(t),
  }));
}
