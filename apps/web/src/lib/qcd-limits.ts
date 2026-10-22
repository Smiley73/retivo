/**
 * Per-person annual QCD exclusion limit (IRC §408(d)(8), indexed by SECURE 2.0
 * §307; IRS Pub. 590-B). Years past the latest key are inflation-extrapolated by the consumer.
 */

import type { CalibrationSnapshot } from './calibration';
import type { QcdLimits } from './qcd';

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
