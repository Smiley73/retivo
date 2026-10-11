/**
 * Calibration seed config for the SS taxation engine.
 * Statutory thresholds (IRS §86(c)) — not inflation-indexed.
 */

import { type CalibrationSnapshot } from './calibration';
import { type SsTaxThresholds } from './ss-taxation';

/**
 * SS provisional-income tier thresholds (whole dollars).
 * Single 2024 entry covers all future years via the engine's
 * clamp-to-latest year-resolution.
 *
 * Statutory base amounts per 26 USC §86(c)(1)(A)+(B):
 *   MFJ:          tier-1 $32,000 / tier-2 $44,000
 *   Single + HoH: tier-1 $25,000 / tier-2 $34,000
 *
 * §86 thresholds have been fixed since OBRA-93 (Public Law 103-66,
 * enacted 1993-08-10) and are not adjusted for inflation.
 *
 * @see https://www.law.cornell.edu/uscode/text/26/86
 */
export const SS_TAX_THRESHOLDS: CalibrationSnapshot<SsTaxThresholds> = {
  values: {
    2024: {
      tier1: {
        // §86(c)(1)(B): MFJ adjusted base amount
        MFJ: 32_000,
        // §86(c)(1)(A): single / HoH base amount (HoH uses Single per §86(c)(1)(A))
        Single: 25_000,
        HoH: 25_000,
      },
      tier2: {
        // §86(c)(1)(B): MFJ adjusted base amount (upper tier)
        MFJ: 44_000,
        // §86(c)(1)(A): single / HoH adjusted base amount (upper tier)
        Single: 34_000,
        HoH: 34_000,
      },
    },
  },
  metadata: {
    // 26 USC §86 — IRS §86 provisional-income / 50% / 85% rule
    source: 'https://www.law.cornell.edu/uscode/text/26/86',
    // Last amended to current form by OBRA-93 (Public Law 103-66)
    asOfDate: '1993-08-10',
    jurisdiction: 'US-federal',
  },
};
