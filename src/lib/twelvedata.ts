// Twelve Data API client.
// Free tier: 800 requests/day, 8 requests/minute.
// Docs: https://twelvedata.com/docs#time-series

export interface OhlcvRow {
  dt: string; // ISO date YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface FetchResult {
  rows: OhlcvRow[];
  meta: { symbol: string; currency: string };
}

export class TwelveDataError extends Error {
  constructor(public code: number, message: string) {
    super(message);
    this.name = 'TwelveDataError';
  }
}

interface TdValue {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

interface TdSuccess {
  meta: { symbol: string; interval: string; currency?: string };
  values: TdValue[];
  status: 'ok';
}

interface TdError {
  code: number;
  message: string;
  status: 'error';
}

type TdResponse = TdSuccess | TdError;

function parseNumber(v: string | undefined | null): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetch daily OHLCV for the given ticker.
 * @param outputsize how many bars back to request (max 5000 on paid; default 500)
 */
export async function fetchDailyOhlcv(
  ticker: string,
  apiKey: string,
  outputsize = 500,
): Promise<FetchResult> {
  if (!ticker) throw new TwelveDataError(0, 'Ticker is required');
  if (!apiKey) throw new TwelveDataError(0, 'API key is required');

  const url = new URL('https://api.twelvedata.com/time_series');
  url.searchParams.set('symbol', ticker);
  url.searchParams.set('interval', '1day');
  url.searchParams.set('outputsize', String(outputsize));
  url.searchParams.set('apikey', apiKey);
  url.searchParams.set('format', 'JSON');

  let res: Response;
  try {
    res = await fetch(url.toString());
  } catch (err) {
    throw new TwelveDataError(
      0,
      `Network error contacting Twelve Data: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    // HTTP-level failure — try to read a body for diagnostics, but never trust it.
    const text = await res.text().catch(() => '');
    throw new TwelveDataError(res.status, `HTTP ${res.status}: ${text || res.statusText}`);
  }

  let body: TdResponse;
  try {
    body = (await res.json()) as TdResponse;
  } catch (err) {
    throw new TwelveDataError(
      0,
      `Invalid JSON from Twelve Data: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (body.status === 'error') {
    throw new TwelveDataError(body.code, body.message);
  }

  const meta = {
    symbol: body.meta.symbol,
    currency: body.meta.currency ?? 'USD',
  };

  // API returns newest-first as strings. Reverse to oldest-first for cleaner DB inserts
  // (so PRIMARY KEY conflicts on backfill prefer the most-recent rewrite path).
  const rows: OhlcvRow[] = body.values
    .map((v) => {
      const open = parseNumber(v.open);
      const high = parseNumber(v.high);
      const low = parseNumber(v.low);
      const close = parseNumber(v.close);
      const volume = parseNumber(v.volume);
      // OHLC must all be present; volume may legitimately be missing for some bars.
      if (open === null || high === null || low === null || close === null) return null;
      return {
        dt: v.datetime,
        open,
        high,
        low,
        close,
        volume,
      } as OhlcvRow;
    })
    .filter((r): r is OhlcvRow => r !== null)
    .reverse();

  return { rows, meta };
}
