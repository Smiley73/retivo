/**
 * Qualified Charitable Distribution (QCD) per-person annual exclusion-limit
 * calibration seed (IRC §408(d)(8), indexed by SECURE 2.0 §307).
 *
 * Source: IRS Publication 590-B (the QCD-limit worksheet — the SECURE 2.0 §307
 * inflation indexing is reflected there).
 *
 * Unlike the non-indexed RMD Uniform Lifetime Table, this limit is annually
 * indexed for inflation, so consumers INFLATION-EXTRAPOLATE forward past the
 * latest published year by the same canonical scenario inflation factor used
 * for the peer indexed limits — NOT clamp-to-latest, which would understate it.
 *
 * Consumer: apps/web/src/lib/qcd.ts (engine wiring lands in later phases).
 */

import type { CalibrationSnapshot } from './calibration';
import type { QcdLimits } from './qcd';

/**
 * IRS §408(d)(8) per-person annual QCD exclusion limit, indexed by year.
 *
 * Published figures (IRS Pub. 590-B): 2024 = $105,000, 2025 = $108,000,
 * 2026 = $111,000. Years beyond the latest published key are inflation-
 * extrapolated forward by the consumer, never clamped to the latest.
 *
 * Add a new year-keyed entry when the IRS publishes the next indexed limit.
 * Update `metadata.asOfDate` at the same time.
 */
export const QCD_LIMITS: CalibrationSnapshot<QcdLimits> = {
  values: {
    2024: { annualLimitDollars: 105_000 },
    2025: { annualLimitDollars: 108_000 },
    2026: { annualLimitDollars: 111_000 },
  },
  metadata: {
    source:
      'IRS Pub. 590-B (https://www.irs.gov/pub/irs-pdf/p590b.pdf) — §408(d)(8) annual QCD exclusion limit, indexed for inflation by SECURE 2.0 §307',
    asOfDate: '2026-06-28',
    jurisdiction: 'US-federal',
  },
} as const;
