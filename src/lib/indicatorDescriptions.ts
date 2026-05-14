// Short, plain-language descriptions of every chart series / pane the
// toolbar can toggle. Single source of truth — consumed by:
//   - ChartToolbar.svelte (title= attribute on each toggle button)
//   - IndicatorsAbout.svelte (definition list rendered below the chart)
//
// Keep entries 1-3 sentences. No emoji. No marketing language.

export interface IndicatorDescription {
  /** Short label that appears in the toolbar button. */
  label: string;
  /** Full plain-text description (no HTML). */
  description: string;
}

export const INDICATOR_DESCRIPTIONS = {
  candles: {
    label: 'Candles (OHLC)',
    description:
      'Each bar shows the open, high, low, and close for one period. Green when close > open (buying pressure), red when close < open (selling pressure). Body length = strength of conviction; long wicks = rejection.',
  },
  volume: {
    label: 'Volume',
    description:
      'Number of shares traded per bar. Confirms or denies a price move: a breakout on heavy volume is real; on light volume it is suspect. Distribution (rising volume on red days) often precedes declines.',
  },
  sma20: {
    label: '20-day SMA (yellow)',
    description:
      'Short-term trend line. Price above it = short-term bullish; crosses are early signals of momentum shifts. Often acts as dynamic support in uptrends.',
  },
  sma50: {
    label: '50-day SMA',
    description:
      'Medium-term trend line. The 50/200 cross (a 50-day crossing above a 200-day) is the canonical "golden cross" bullish signal; the reverse is a "death cross."',
  },
  sma200: {
    label: '200-day SMA (red)',
    description:
      'Long-term regime line. Price above it = long-term bull market; below it = long-term bear. Heavily watched; algorithms trade off it.',
  },
  rsi: {
    label: 'RSI(14)',
    description:
      'Momentum oscillator scaled 0-100. Above 70 = overbought, below 30 = oversold, but strong trends can stay overbought for weeks. The 50 line acts as a trend filter. Bearish divergence (price up, RSI down) often warns of a top.',
  },
  macd: {
    label: 'MACD(12, 26, 9)',
    description:
      'Trend-momentum hybrid. Positive MACD line = bullish regime; signal-line crossovers indicate momentum shifts. The histogram (MACD − signal) leads the crossovers and is an early warning indicator.',
  },
  pcover: {
    label: 'Pcover / Pcover+20%',
    description:
      'RSU-specific exit-framework levels. Pcover = the price at which selling all shares just covers your tax bill. Pcover+20% = with a safety buffer. Hard floors below which you should be acting, not waiting.',
  },
  vest: {
    label: 'Vest',
    description:
      'Your RSU vest-date FMV per share. Reference line for capital gain/loss math (above = gain, below = loss vs basis).',
  },
} as const satisfies Record<string, IndicatorDescription>;

export type IndicatorKey = keyof typeof INDICATOR_DESCRIPTIONS;
