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
 *
 * For deterministic computation against a fixed reference date (e.g. in
 * unit tests or a Sunday-review generator that pins a `reviewDate`), use
 * `daysUntilFrom` instead.
 */
export function daysUntil(isoDate: string): number {
  return daysUntilFrom(new Date(), isoDate);
}

/**
 * Whole days from `baseDate` (UTC midnight) to `targetIso` (YYYY-MM-DD).
 * Negative when target is in the past. NaN when target is empty or
 * unparseable. Pinning the base date makes callers deterministic and
 * trivially testable — see `sundayReview.generateSundayReview` which
 * uses `inputs.reviewDate` to keep generated documents reproducible.
 */
export function daysUntilFrom(baseDate: Date, targetIso: string): number {
  if (!targetIso) return NaN;
  const target = new Date(`${targetIso}T00:00:00Z`).getTime();
  if (!Number.isFinite(target)) return NaN;
  const baseUtc = Date.UTC(
    baseDate.getUTCFullYear(),
    baseDate.getUTCMonth(),
    baseDate.getUTCDate(),
  );
  const msPerDay = 86_400_000;
  return Math.ceil((target - baseUtc) / msPerDay);
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}
