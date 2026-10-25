/**
 * CMS Part B standard and Part D national base monthly premiums by year, from
 * the autumn fact sheet and the July Part D bid announcement.
 */

import type { CalibrationSnapshot } from './calibration';

interface MedicarePremiumYear {
  partBStandardMonthly: number;
  partDNationalBaseMonthly: number;
}

export const MEDICARE_PREMIUMS: CalibrationSnapshot<MedicarePremiumYear> = {
  values: {
    2024: { partBStandardMonthly: 174.7, partDNationalBaseMonthly: 34.7 },
    2025: { partBStandardMonthly: 185.0, partDNationalBaseMonthly: 36.78 },
    2026: { partBStandardMonthly: 202.9, partDNationalBaseMonthly: 38.99 },
  },
  metadata: {
    source:
      'https://www.cms.gov/files/document/july-31-2023-parts-c-d-announcement-pdf.pdf, https://www.cms.gov/newsroom/fact-sheets/2024-medicare-parts-b-premiums-and-deductibles, https://www.cms.gov/files/document/july-29-2024-parts-c-d-announcement.pdf, https://www.cms.gov/newsroom/fact-sheets/2025-medicare-parts-b-premiums-and-deductibles, https://www.cms.gov/files/document/july-28-2025-parts-c-d-announcement.pdf, https://www.cms.gov/newsroom/fact-sheets/2026-medicare-parts-b-premiums-deductibles',
    asOfDate: '2025-11-14',
    jurisdiction: 'US-federal',
  },
};

/** The newest year in the snapshot with its amounts. */
export function latestMedicarePremiums(): MedicarePremiumYear & { year: number } {
  const year = Math.max(...Object.keys(MEDICARE_PREMIUMS.values).map(Number));
  return { year, ...MEDICARE_PREMIUMS.values[year] };
}
