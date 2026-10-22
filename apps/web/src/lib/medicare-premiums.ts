/**
 * CMS Medicare premiums by year: the Part B standard monthly premium (the
 * "Medicare Parts A & B Premiums and Deductibles" fact sheet, each autumn) and
 * the Part D national base beneficiary premium (the Part D bid announcement, each
 * July). Read only by the Expenses page helper; no engine imports this file.
 */

import type { CalibrationSnapshot } from './calibration';

/** One year's Medicare premium amounts, in dollars per month. */
interface MedicarePremiumYear {
  /** CMS Part B standard monthly premium. */
  partBStandardMonthly: number;
  /** CMS Part D national base beneficiary premium. */
  partDNationalBaseMonthly: number;
}

/** Add a new year when CMS publishes it, with its citations appended to
 *  `metadata.source` in publication order and `asOfDate` moved with them. */
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
