/**
 * Money formatters used across the app. `formatCurrency` produces a
 * full `$1,234,567` string (rounded to whole dollars);
 * `formatCurrencyExact` keeps two decimals (`$1,234.56`);
 * `formatCurrencyShort` produces a `1.2M` / `480k` compact form for
 * chart axes + tooltips.
 *
 * This is the canonical home for currency display: every currency
 * formatter in the app routes through here. The two pre-existing
 * inlined copies (`IncomePage.tsx` `formatUsd`, `expense-format.ts`
 * `USD`) were migrated onto `formatCurrency` in the readability-polish
 * batch, completing the consolidation.
 */

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Math.round(value));
}

export function formatCurrencyExact(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatCurrencyShort(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `$${Math.round(value / 1_000)}k`;
  }
  return `$${Math.round(value)}`;
}
