/**
 * Built-in Medicare premium amounts the Expenses page helper offers when it
 * adds a person's Part B and Part D premiums as ordinary expenses.
 *
 * Two CMS series per year: the Part B standard monthly premium (fact sheet
 * "Medicare Parts A & B Premiums and Deductibles", published each autumn) and
 * the Part D national base beneficiary premium (the annual Part D bid
 * information announcement, published each July). Neither is what a person
 * actually pays: Part B is higher above the income thresholds, and a Part D plan
 * sets its own price around the national base. They are starting points the
 * person edits in the preview.
 *
 * Read only by the Expenses page helper (`pages/medicare-premium-helper.ts`).
 * No engine imports this file: the projection charges the income-related
 * surcharge from `IRMAA_TIERS` and takes the base premium from the household's
 * own Medical expenses.
 */

import type { CalibrationSnapshot } from './calibration';

/** One year's Medicare premium amounts, in dollars per month. */
export interface MedicarePremiumYear {
  /** CMS Part B standard monthly premium. */
  partBStandardMonthly: number;
  /** CMS Part D national base beneficiary premium. */
  partDNationalBaseMonthly: number;
}

/**
 * Part B standard premium: $174.70 (2024), $185.00 (2025), $202.90 (2026).
 * Part D national base beneficiary premium: $34.70 (2024), $36.78 (2025),
 * $38.99 (2026).
 *
 * Add a new year-keyed entry when CMS publishes it, and add its citations to
 * `metadata.source` in publication order. Update `metadata.asOfDate` at the
 * same time.
 */
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

/** The newest year in {@link MEDICARE_PREMIUMS} with its amounts. */
export interface LatestMedicarePremiums extends MedicarePremiumYear {
  year: number;
}

/**
 * The newest year in the snapshot. The helper offers this year's amounts and
 * names the year in its copy; older years stay for the record.
 */
export function latestMedicarePremiums(
  snapshot: CalibrationSnapshot<MedicarePremiumYear> = MEDICARE_PREMIUMS,
): LatestMedicarePremiums {
  const years = Object.keys(snapshot.values).map(Number);
  const year = Math.max(...years);
  return { year, ...snapshot.values[year] };
}
