// Assumed annual taxable yield on brokerage-like POST_TAX accounts (`BROKERAGE` / `OTHER`), a calibration assumption with no
// per-scenario override. The tax-exempt component is nonzero only when stated here, never inferred from a bond allocation.

import type { CalibrationSnapshot } from './calibration';

/**
 * Per-year assumed taxable yield: `totalYieldPct` is a fraction of the balance
 * (0.02 = 2%); `qualifiedDividendFraction` is taxed at LTCG/QDI rates;
 * `taxExemptMunicipalFraction` pays no federal tax but is added back to the
 * §36B / IRMAA MAGI. The remainder (floored at 0) is ordinary interest, taxed at
 * ordinary rates and part of the NIIT base.
 */
export interface AssumedTaxableYieldConfig {
  readonly totalYieldPct: number;
  readonly qualifiedDividendFraction: number;
  readonly taxExemptMunicipalFraction: number;
}

/** Default snapshot: a 2% yield split evenly between qualified dividends and interest, reinvested into basis so it does not double-tax the withdrawal gain. */
export const DEFAULT_ASSUMED_TAXABLE_YIELD_CONFIG: CalibrationSnapshot<AssumedTaxableYieldConfig> = {
  values: {
    2026: {
      totalYieldPct: 0.02,
      qualifiedDividendFraction: 0.5,
      taxExemptMunicipalFraction: 0,
    },
  },
  metadata: {
    source:
      'Planning assumption — diversified total-market portfolio dividend + interest yield (population-level modeling default, no per-scenario override)',
    asOfDate: '2026-06-10',
    jurisdiction: 'US-federal',
  },
};
