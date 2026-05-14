// Twelve Data API client.
// Free tier: 800 requests/day, 8 requests/minute.
// Docs: https://twelvedata.com/docs#time-series

export interface OhlcvRow {
  /**
   * Source-format datetime string from Twelve Data.
   * - For daily intervals: `YYYY-MM-DD`.
   * - For intraday intervals: `YYYY-MM-DD HH:MM:SS`.
   *
   * The DuckDB DATE/TIMESTAMP cast at insert time handles both.
   */
  dt: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

/**
 * Intraday row — same shape as OhlcvRow but with the timestamp field
 * named `ts` to make the calling-site distinction obvious. The wire
 * format is identical, only the parsing target differs (TIMESTAMP not
 * DATE in DuckDB).
 */
export interface IntradayRow {
  /** ISO-ish timestamp `YYYY-MM-DD HH:MM:SS` from Twelve Data. */
  ts: string;
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

export interface IntradayFetchResult {
  rows: IntradayRow[];
  meta: { symbol: string; currency: string };
}

export type IntradayInterval = '5min' | '15min' | '30min' | '1h';
export type Interval = '1day' | '1week' | '1month' | IntradayInterval;

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
 * Build the time_series request URL. Exposed (not exported) so tests
 * can assert that interval, outputsize, and apikey end up wired
 * correctly without hitting the network.
 */
export function buildTimeSeriesUrl(
  ticker: string,
  apiKey: string,
  interval: Interval,
  outputsize: number,
): string {
  const url = new URL('https://api.twelvedata.com/time_series');
  url.searchParams.set('symbol', ticker);
  url.searchParams.set('interval', interval);
  url.searchParams.set('outputsize', String(outputsize));
  url.searchParams.set('apikey', apiKey);
  url.searchParams.set('format', 'JSON');
  return url.toString();
}

async function fetchTimeSeries(
  ticker: string,
  apiKey: string,
  interval: Interval,
  outputsize: number,
): Promise<TdSuccess> {
  if (!ticker) throw new TwelveDataError(0, 'Ticker is required');
  if (!apiKey) throw new TwelveDataError(0, 'API key is required');

  const url = buildTimeSeriesUrl(ticker, apiKey, interval, outputsize);

  let res: Response;
  try {
    res = await fetch(url);
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
  return body;
}

/**
 * Fetch OHLCV for the given ticker at the given interval.
 *
 * @param outputsize how many bars back to request (max 5000 on paid; default 500)
 * @param interval bar size; defaults to `'1day'` for backward compatibility
 *
 * For intraday work prefer `fetchIntradayOhlcv` which returns the
 * timestamp under the `ts` field (avoids ambiguity at consumers).
 */
export async function fetchOhlcv(
  ticker: string,
  apiKey: string,
  outputsize = 500,
  interval: Interval = '1day',
): Promise<FetchResult> {
  const body = await fetchTimeSeries(ticker, apiKey, interval, outputsize);

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

/**
 * Daily-only convenience wrapper. Preserved so existing call sites
 * keep working without churn.
 */
export async function fetchDailyOhlcv(
  ticker: string,
  apiKey: string,
  outputsize = 500,
): Promise<FetchResult> {
  return fetchOhlcv(ticker, apiKey, outputsize, '1day');
}

/**
 * Fetch intraday bars at the given interval (default 5min). Returns
 * rows keyed on `ts` (a `YYYY-MM-DD HH:MM:SS` string) so the consumer
 * can route into the dedicated `ohlcv_intraday` table without the
 * "is this a date or a timestamp?" ambiguity that would dog a single
 * unified shape.
 */
export async function fetchIntradayOhlcv(
  ticker: string,
  apiKey: string,
  interval: IntradayInterval = '5min',
  outputsize = 78,
): Promise<IntradayFetchResult> {
  const body = await fetchTimeSeries(ticker, apiKey, interval, outputsize);

  const meta = {
    symbol: body.meta.symbol,
    currency: body.meta.currency ?? 'USD',
  };

  const rows: IntradayRow[] = body.values
    .map((v) => {
      const open = parseNumber(v.open);
      const high = parseNumber(v.high);
      const low = parseNumber(v.low);
      const close = parseNumber(v.close);
      const volume = parseNumber(v.volume);
      if (open === null || high === null || low === null || close === null) return null;
      return {
        ts: v.datetime,
        open,
        high,
        low,
        close,
        volume,
      } as IntradayRow;
    })
    .filter((r): r is IntradayRow => r !== null)
    .reverse();

  return { rows, meta };
}
