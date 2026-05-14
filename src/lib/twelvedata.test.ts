import { describe, it, expect } from 'vitest';
import { buildTimeSeriesUrl } from './twelvedata';

// We don't exercise the network in unit tests — the URL builder is
// the only place where typos in interval/outputsize/apikey wiring
// would silently produce wrong data, so that's what we lock down.

describe('buildTimeSeriesUrl', () => {
  it('builds a daily URL with all required parameters', () => {
    const url = new URL(buildTimeSeriesUrl('AAPL', 'demo-key', '1day', 500));
    expect(url.host).toBe('api.twelvedata.com');
    expect(url.pathname).toBe('/time_series');
    expect(url.searchParams.get('symbol')).toBe('AAPL');
    expect(url.searchParams.get('interval')).toBe('1day');
    expect(url.searchParams.get('outputsize')).toBe('500');
    expect(url.searchParams.get('apikey')).toBe('demo-key');
    expect(url.searchParams.get('format')).toBe('JSON');
  });

  it('threads the 5min interval through for intraday calls', () => {
    const url = new URL(buildTimeSeriesUrl('AAPL', 'k', '5min', 78));
    expect(url.searchParams.get('interval')).toBe('5min');
    expect(url.searchParams.get('outputsize')).toBe('78');
    expect(url.toString()).toContain('&interval=5min');
  });

  it('honours alternate intraday intervals', () => {
    for (const iv of ['15min', '30min', '1h'] as const) {
      const url = new URL(buildTimeSeriesUrl('AAPL', 'k', iv, 100));
      expect(url.searchParams.get('interval')).toBe(iv);
    }
  });

  it('honours weekly and monthly intervals', () => {
    expect(new URL(buildTimeSeriesUrl('AAPL', 'k', '1week', 50)).searchParams.get('interval')).toBe(
      '1week',
    );
    expect(new URL(buildTimeSeriesUrl('AAPL', 'k', '1month', 50)).searchParams.get('interval')).toBe(
      '1month',
    );
  });

  it('coerces outputsize to string for query params', () => {
    const url = new URL(buildTimeSeriesUrl('AAPL', 'k', '1day', 1));
    expect(url.searchParams.get('outputsize')).toBe('1');
  });
});
