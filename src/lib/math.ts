// Tax / cover-price math for vested shares.
//
// Definitions (Pv = vest price, S = shares, T = tax rate):
//   Tax        = Pv * S * T          total tax bill in dollars
//   Pcover     = Pv * T              price at which selling all shares covers the tax
//   Pcover+20% = Pv * T * 1.2        price with a 20% safety margin
//   Pbreakeven = Pv                  price at which proceeds equal cost basis

export interface Thresholds {
  tax: number;
  pcover: number;
  pcoverPlus20: number;
  pbreakeven: number;
  /** Shares that must be sold at `price` to fully cover the tax bill. */
  sharesToCoverAt(price: number): number;
}

export function computeThresholds(
  vestPrice: number,
  shares: number,
  taxRate: number,
): Thresholds {
  const tax = vestPrice * shares * taxRate;
  const pcover = vestPrice * taxRate;
  const pcoverPlus20 = pcover * 1.2;
  const pbreakeven = vestPrice;

  return {
    tax,
    pcover,
    pcoverPlus20,
    pbreakeven,
    sharesToCoverAt(price: number): number {
      if (!Number.isFinite(price) || price <= 0) return Infinity;
      return tax / price;
    },
  };
}

/**
 * Whole days between today (UTC) and the given ISO date (YYYY-MM-DD).
 * Returns NaN if the input is empty or unparseable, negative when overdue.
 */
export function daysUntil(isoDate: string): number {
  if (!isoDate) return NaN;
  const target = new Date(`${isoDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(target)) return NaN;
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const msPerDay = 86_400_000;
  return Math.ceil((target - todayUtc) / msPerDay);
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}
