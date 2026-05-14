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
// Internal — `fetchDailyOhlcv` (the public wrapper) is what callers
// reach for. `fetchOhlcv` is only used here as the shared body of the
// daily/intraday paths.
async function fetchOhlcv(
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
 * One earnings release record returned by Twelve Data's `/earnings`
 * endpoint, normalised into the shape we persist.
 *
 * Each numeric field can be `null` because Twelve Data legitimately
 * omits or empty-strings them when the report is unconfirmed
 * (estimate-only) or pre-release (no actual yet).
 */
// Used internally by `FetchEarningsResult`. Consumers receive
// `EarningsEventRow` from queries.ts (the post-DB-insert shape) — the
// raw Twelve Data event shape doesn't need to escape this module.
interface EarningsEvent {
  /** ISO yyyy-mm-dd. The wire format may include a time component; we slice it off. */
  date: string;
  /** 'Before Market', 'After Market', or null when the source omitted the field. */
  timeOfDay: string | null;
  epsEstimate: number | null;
  epsActual: number | null;
  surprisePct: number | null;
}

export interface FetchEarningsResult {
  events: EarningsEvent[];
  meta: { symbol: string };
}

/**
 * Build the /earnings request URL. Same export-for-test pattern as
 * `buildTimeSeriesUrl` — lets a unit test verify the URL wiring
 * (symbol, apikey, format) without hitting the network.
 */
export function buildEarningsUrl(ticker: string, apiKey: string): string {
  const url = new URL('https://api.twelvedata.com/earnings');
  url.searchParams.set('symbol', ticker);
  url.searchParams.set('apikey', apiKey);
  url.searchParams.set('format', 'JSON');
  return url.toString();
}

function parseFloatOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetch the past + (when available) upcoming earnings dates for a
 * ticker. Free-tier endpoint; counts as 1 API credit per call. We
 * fetch once per ticker per refresh.
 *
 * Defensive about response shape — Twelve Data's docs are imperfect
 * and we've seen the `/earnings` payload appear both as
 * `{ earnings: [...] }` and as a bare array depending on which
 * gateway answered. Anything else becomes an empty events list rather
 * than a thrown error: earnings is auxiliary data, the chart still
 * renders without it, and a malformed response must not block the
 * OHLCV refresh path.
 */
export async function fetchEarnings(
  ticker: string,
  apiKey: string,
): Promise<FetchEarningsResult> {
  if (!ticker) throw new TwelveDataError(0, 'Ticker is required');
  if (!apiKey) throw new TwelveDataError(0, 'API key is required');

  const url = buildEarningsUrl(ticker, apiKey);

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
    const text = await res.text().catch(() => '');
    throw new TwelveDataError(res.status, `HTTP ${res.status}: ${text || res.statusText}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new TwelveDataError(
      0,
      `Invalid JSON from Twelve Data: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Error envelope: { code, message, status: 'error' }
  if (
    body !== null &&
    typeof body === 'object' &&
    (body as { status?: string }).status === 'error'
  ) {
    const e = body as { code?: number; message?: string };
    throw new TwelveDataError(e.code ?? 0, e.message ?? 'Unknown Twelve Data error');
  }

  // Twelve Data returns earnings either wrapped in `{ earnings: [...] }`
  // or as the bare array depending on the gateway. Be defensive about
  // both shapes; any other shape produces an empty list rather than a
  // throw — earnings is auxiliary, missing data is not a refresh-failure
  // condition.
  let rawEvents: unknown;
  let metaSymbol = ticker;
  if (Array.isArray(body)) {
    rawEvents = body;
  } else if (body !== null && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    rawEvents = obj.earnings ?? [];
    const meta = obj.meta as { symbol?: string } | undefined;
    if (meta && typeof meta.symbol === 'string') {
      metaSymbol = meta.symbol;
    }
  } else {
    rawEvents = [];
  }

  if (!Array.isArray(rawEvents)) {
    return { events: [], meta: { symbol: metaSymbol } };
  }

  const events: EarningsEvent[] = rawEvents
    .map((raw): EarningsEvent | null => {
      if (raw === null || typeof raw !== 'object') return null;
      const e = raw as Record<string, unknown>;
      const dateStr = typeof e.date === 'string' ? e.date.slice(0, 10) : '';
      if (dateStr.length !== 10) return null;
      const timeRaw = e.time;
      const timeOfDay =
        typeof timeRaw === 'string' && timeRaw.trim() ? timeRaw.trim() : null;
      return {
        date: dateStr,
        timeOfDay,
        epsEstimate: parseFloatOrNull(e.eps_estimate),
        epsActual: parseFloatOrNull(e.eps_actual),
        surprisePct: parseFloatOrNull(e.surprise_prc),
      };
    })
    .filter((e): e is EarningsEvent => e !== null);

  return { events, meta: { symbol: metaSymbol } };
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
