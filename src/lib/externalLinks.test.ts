import { describe, it, expect } from 'vitest';
import { getExternalLinks } from './externalLinks';

describe('getExternalLinks', () => {
  it('returns an empty array for empty input', () => {
    expect(getExternalLinks('')).toEqual([]);
    expect(getExternalLinks('   ')).toEqual([]);
  });

  it('returns 5 links for a valid ticker', () => {
    const links = getExternalLinks('AAPL');
    expect(links).toHaveLength(5);
  });

  it('builds the documented Yahoo, Stocktwits, MarketWatch, and Earnings Whispers URLs for AAPL', () => {
    const links = getExternalLinks('AAPL');
    const byId = Object.fromEntries(links.map((l) => [l.id, l.url]));
    expect(byId['yahoo-chart']).toBe('https://finance.yahoo.com/chart/AAPL/');
    expect(byId['yahoo-quote']).toBe('https://finance.yahoo.com/quote/AAPL/');
    expect(byId['stocktwits']).toBe('https://stocktwits.com/symbol/AAPL');
    expect(byId['marketwatch']).toBe(
      'https://www.marketwatch.com/investing/stock/aapl',
    );
    expect(byId['earnings-whispers']).toBe(
      'https://www.earningswhispers.com/stocks/AAPL',
    );
  });

  it('uppercases the ticker for sites that expect uppercase paths', () => {
    const links = getExternalLinks('aapl');
    const byId = Object.fromEntries(links.map((l) => [l.id, l.url]));
    expect(byId['yahoo-chart']).toBe('https://finance.yahoo.com/chart/AAPL/');
    expect(byId['yahoo-quote']).toBe('https://finance.yahoo.com/quote/AAPL/');
    expect(byId['stocktwits']).toBe('https://stocktwits.com/symbol/AAPL');
    expect(byId['earnings-whispers']).toBe(
      'https://www.earningswhispers.com/stocks/AAPL',
    );
  });

  it('lowercases the ticker for MarketWatch (which uses lowercase paths)', () => {
    const links = getExternalLinks('AAPL');
    const mw = links.find((l) => l.id === 'marketwatch')!;
    expect(mw.url).toBe('https://www.marketwatch.com/investing/stock/aapl');
  });

  it('trims surrounding whitespace before building URLs', () => {
    const links = getExternalLinks('  AAPL  ');
    expect(links[0].url).toBe('https://finance.yahoo.com/chart/AAPL/');
  });

  it('every link has a label, url, and id', () => {
    for (const link of getExternalLinks('NVDA')) {
      expect(link.label).toBeTruthy();
      expect(link.url).toMatch(/^https:\/\//);
      expect(link.id).toBeTruthy();
    }
  });
});
