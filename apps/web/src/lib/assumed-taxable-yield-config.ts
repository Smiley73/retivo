/**
 * Assumed annual taxable-account investment yield — a population-level modeling
 * assumption for the tax drag on brokerage-like taxable accounts.
 *
 * Brokerage-like POST_TAX accounts (`BROKERAGE` / `OTHER`) throw off taxable
 * investment income each year even when no withdrawal is taken. The yield's
 * tax character is split into three EXPLICIT components:
 *   - qualified dividends (taxed at LTCG/QDI rates),
 *   - ordinary interest / non-qualified dividends (taxed at ordinary rates,
 *     and part of the NIIT base),
 *   - tax-exempt municipal-bond interest (no federal tax, but a §36B/IRMAA
 *     MAGI add-back).
 * The exact yield is household-specific and not tracked, so it is modeled as a
 * flat fraction of the brokerage-like balance, split among the three streams.
 *
 * The tax-exempt component is NEVER inferred from a bond allocation — holding
 * bonds does not make their interest municipal/exempt. It is only
 * nonzero when this calibration explicitly says so; the seed keeps it at 0.
 *
 * This is a calibration assumption, not a household input — there is no
 * per-scenario override. Edit `values[<year>]` directly when the planning
 * assumption changes; the year-keyed shape lets the assumption vary by year if
 * a future calibration revision needs it.
 *
 * Seed (`as-of` 2026): a 2% total yield split evenly — 1% qualified dividends
 * + 1% ordinary interest, 0% tax-exempt — a conservative long-run planning
 * figure roughly matching a diversified total-market portfolio's dividend
 * yield plus a modest interest component. Reinvested back into basis each year
 * (the basis-reinvestment coupling invariant), so it does not double-tax the
 * withdrawal-time gain.
 */

import type { CalibrationSnapshot } from './calibration';

/**
 * Per-year assumed taxable-account yield parameters.
 *   - `totalYieldPct` — total taxable yield as a fraction of the brokerage-like
 *     balance (e.g. 0.02 = 2%).
 *   - `qualifiedDividendFraction` — share of the total yield that is qualified
 *     dividends / LTCG-rate income (0..1).
 *   - `taxExemptMunicipalFraction` — share of the total yield that is
 *     tax-exempt municipal-bond interest (0..1). $0 federal tax, but added
 *     back to the §36B / IRMAA MAGI (`taxExemptInterestDollars`). Explicit
 *     calibration only — never derived from the account's bond allocation.
 *   - The remainder (`1 − qualifiedDividendFraction −
 *     taxExemptMunicipalFraction`, floored at 0) is ordinary interest /
 *     non-qualified dividends (ordinary-rate income + NIIT base).
 */
export interface AssumedTaxableYieldConfig {
  readonly totalYieldPct: number;
  readonly qualifiedDividendFraction: number;
  readonly taxExemptMunicipalFraction: number;
}

/**
 * Default assumed-taxable-yield calibration snapshot. Update `values[<year>]`
 * and `metadata.asOfDate` when the planning assumption is revised.
 */
export const DEFAULT_ASSUMED_TAXABLE_YIELD_CONFIG: CalibrationSnapshot<AssumedTaxableYieldConfig> = {
  values: {
    2026: {
      totalYieldPct: 0.02,
      qualifiedDividendFraction: 0.5,
      // Explicit tax-exempt municipal component. 0 — municipal exemption
      // is never assumed from asset allocation; raise only via an explicit
      // calibration decision.
      taxExemptMunicipalFraction: 0,
    },
  },
  metadata: {
    // Population-level planning assumption (no single authoritative source);
    // a diversified total-market portfolio dividend yield (~1.3-2%) plus a
    // modest interest component, rounded to a round 2% split evenly QDI/interest
    // with no assumed municipal exemption.
    source:
      'Planning assumption — diversified total-market portfolio dividend + interest yield (population-level modeling default, no per-scenario override)',
    asOfDate: '2026-06-10',
    jurisdiction: 'US-federal',
  },
};
