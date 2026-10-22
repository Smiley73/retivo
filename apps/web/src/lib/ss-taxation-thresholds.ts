/**
 * SS provisional-income tier thresholds (26 USC §86(c)(1)(A)+(B)), fixed since OBRA-93
 * (Public Law 103-66); the single 2024 entry covers later years by clamp-to-latest.
 */

import { type CalibrationSnapshot } from './calibration';
import { type SsTaxThresholds } from './ss-taxation';

export const SS_TAX_THRESHOLDS: CalibrationSnapshot<SsTaxThresholds> = {
  values: {
    2024: {
      tier1: {
        MFJ: 32_000,
        // §86(c)(1)(A): single / HoH base amount (HoH uses Single per §86(c)(1)(A))
        Single: 25_000,
        HoH: 25_000,
      },
      tier2: {
        MFJ: 44_000,
        Single: 34_000,
        HoH: 34_000,
      },
    },
  },
  metadata: {
    source: 'https://www.law.cornell.edu/uscode/text/26/86',
    // Last amended to current form by OBRA-93 (Public Law 103-66)
    asOfDate: '1993-08-10',
    jurisdiction: 'US-federal',
  },
};
