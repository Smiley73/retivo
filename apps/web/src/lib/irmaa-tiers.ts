/**
 * IRMAA tiers (Medicare Part B/D income-related surcharges) for 2024–2026 from the CMS fact sheets.
 * Refresh: docs/yearly-tax-refresh.md.
 */

import type { CalibrationSnapshot } from './calibration';
import type { FilingStatus } from './federal-tax';

/** One tier: the MAGI threshold that starts it (lower bound exclusive, tier 5 inclusive) plus monthly surcharges; tier 'none' is implicit below the first threshold. */
export interface IrmaaTableEntry {
  thresholdDollars: number;
  partBMonthly: number;
  partDMonthly: number;
}

/**
 * Full IRMAA table for one tax year, five tiers per schedule. HoH and QSS use `bySingle` (CMS practice).
 * `byMfs` is the MFS lived-with-spouse schedule: CMS publishes only two bands, so slots 2-5 repeat the high
 * threshold and tier-5 surcharge (equal thresholds make the middle tiers unreachable).
 */
export interface IrmaaTable {
  bySingle: readonly [IrmaaTableEntry, IrmaaTableEntry, IrmaaTableEntry, IrmaaTableEntry, IrmaaTableEntry];
  byMfj: readonly [IrmaaTableEntry, IrmaaTableEntry, IrmaaTableEntry, IrmaaTableEntry, IrmaaTableEntry];
  byMfs: readonly [IrmaaTableEntry, IrmaaTableEntry, IrmaaTableEntry, IrmaaTableEntry, IrmaaTableEntry];
}

// 2024: https://www.cms.gov/newsroom/fact-sheets/2024-medicare-parts-b-premiums-and-deductibles

const table2024: IrmaaTable = {
  bySingle: [
    { thresholdDollars: 103_000, partBMonthly: 69.9,  partDMonthly: 12.9 },
    { thresholdDollars: 129_000, partBMonthly: 174.7, partDMonthly: 33.3 },
    { thresholdDollars: 161_000, partBMonthly: 279.5, partDMonthly: 53.8 },
    { thresholdDollars: 193_000, partBMonthly: 384.3, partDMonthly: 74.2 },
    { thresholdDollars: 500_000, partBMonthly: 419.3, partDMonthly: 81.0 },
  ],
  byMfj: [
    { thresholdDollars: 206_000, partBMonthly: 69.9,  partDMonthly: 12.9 },
    { thresholdDollars: 258_000, partBMonthly: 174.7, partDMonthly: 33.3 },
    { thresholdDollars: 322_000, partBMonthly: 279.5, partDMonthly: 53.8 },
    { thresholdDollars: 386_000, partBMonthly: 384.3, partDMonthly: 74.2 },
    { thresholdDollars: 750_000, partBMonthly: 419.3, partDMonthly: 81.0 },
  ],
  // MFS lived-with-spouse: top threshold $397,000 (published 2024 CMS figure; see metadata.source).
  byMfs: [
    { thresholdDollars: 103_000, partBMonthly: 384.3, partDMonthly: 74.2 },
    { thresholdDollars: 397_000, partBMonthly: 419.3, partDMonthly: 81.0 },
    { thresholdDollars: 397_000, partBMonthly: 419.3, partDMonthly: 81.0 },
    { thresholdDollars: 397_000, partBMonthly: 419.3, partDMonthly: 81.0 },
    { thresholdDollars: 397_000, partBMonthly: 419.3, partDMonthly: 81.0 },
  ],
};

// 2025: https://www.cms.gov/newsroom/fact-sheets/2025-medicare-parts-b-premiums-and-deductibles

const table2025: IrmaaTable = {
  bySingle: [
    { thresholdDollars: 106_000, partBMonthly: 74.0,  partDMonthly: 13.7 },
    { thresholdDollars: 133_000, partBMonthly: 185.0, partDMonthly: 35.3 },
    { thresholdDollars: 167_000, partBMonthly: 295.9, partDMonthly: 57.0 },
    { thresholdDollars: 200_000, partBMonthly: 406.9, partDMonthly: 78.6 },
    { thresholdDollars: 500_000, partBMonthly: 443.9, partDMonthly: 85.8 },
  ],
  byMfj: [
    { thresholdDollars: 212_000, partBMonthly: 74.0,  partDMonthly: 13.7 },
    { thresholdDollars: 266_000, partBMonthly: 185.0, partDMonthly: 35.3 },
    { thresholdDollars: 334_000, partBMonthly: 295.9, partDMonthly: 57.0 },
    { thresholdDollars: 400_000, partBMonthly: 406.9, partDMonthly: 78.6 },
    { thresholdDollars: 750_000, partBMonthly: 443.9, partDMonthly: 85.8 },
  ],
  // MFS lived-with-spouse: top threshold $394,000 (published 2025 CMS figure; see metadata.source).
  byMfs: [
    { thresholdDollars: 106_000, partBMonthly: 406.9, partDMonthly: 78.6 },
    { thresholdDollars: 394_000, partBMonthly: 443.9, partDMonthly: 85.8 },
    { thresholdDollars: 394_000, partBMonthly: 443.9, partDMonthly: 85.8 },
    { thresholdDollars: 394_000, partBMonthly: 443.9, partDMonthly: 85.8 },
    { thresholdDollars: 394_000, partBMonthly: 443.9, partDMonthly: 85.8 },
  ],
};

// 2026: https://www.cms.gov/newsroom/fact-sheets/2026-medicare-parts-b-premiums-deductibles

const table2026: IrmaaTable = {
  bySingle: [
    { thresholdDollars: 109_000, partBMonthly: 81.2,  partDMonthly: 14.5 },
    { thresholdDollars: 137_000, partBMonthly: 202.9, partDMonthly: 37.5 },
    { thresholdDollars: 171_000, partBMonthly: 324.6, partDMonthly: 60.4 },
    { thresholdDollars: 205_000, partBMonthly: 446.3, partDMonthly: 83.3 },
    { thresholdDollars: 500_000, partBMonthly: 487.0, partDMonthly: 91.0 },
  ],
  byMfj: [
    { thresholdDollars: 218_000, partBMonthly: 81.2,  partDMonthly: 14.5 },
    { thresholdDollars: 274_000, partBMonthly: 202.9, partDMonthly: 37.5 },
    { thresholdDollars: 342_000, partBMonthly: 324.6, partDMonthly: 60.4 },
    { thresholdDollars: 410_000, partBMonthly: 446.3, partDMonthly: 83.3 },
    { thresholdDollars: 750_000, partBMonthly: 487.0, partDMonthly: 91.0 },
  ],
  // MFS lived-with-spouse: top threshold $391,000 (published 2026 CMS figure; see metadata.source).
  byMfs: [
    { thresholdDollars: 109_000, partBMonthly: 446.3, partDMonthly: 83.3 },
    { thresholdDollars: 391_000, partBMonthly: 487.0, partDMonthly: 91.0 },
    { thresholdDollars: 391_000, partBMonthly: 487.0, partDMonthly: 91.0 },
    { thresholdDollars: 391_000, partBMonthly: 487.0, partDMonthly: 91.0 },
    { thresholdDollars: 391_000, partBMonthly: 487.0, partDMonthly: 91.0 },
  ],
};

export const IRMAA_TIERS: CalibrationSnapshot<IrmaaTable> = {
  values: {
    2024: table2024,
    2025: table2025,
    2026: table2026,
  },
  metadata: {
    source:
      'https://www.cms.gov/newsroom/fact-sheets/2024-medicare-parts-b-premiums-and-deductibles, https://www.cms.gov/newsroom/fact-sheets/2025-medicare-parts-b-premiums-and-deductibles, https://www.cms.gov/newsroom/fact-sheets/2026-medicare-parts-b-premiums-deductibles',
    asOfDate: '2025-11-14',
    jurisdiction: 'US-federal',
  },
};

/**
 * The schedule a filing status reads: MFJ uses `byMfj`; MFS lived with spouse uses `byMfs`; Single, HoH, QSS
 * and MFS lived apart or unknown use `bySingle`. Shared by `computeIrmaa` and `computeMonthAwareIrmaa`.
 */
export function selectIrmaaScheduleEntries(
  table: IrmaaTable,
  filingStatus: FilingStatus,
  mfsLivedWithSpouse?: boolean,
): readonly IrmaaTableEntry[] {
  if (filingStatus === 'MFJ') return table.byMfj;
  if (filingStatus === 'MFS' && mfsLivedWithSpouse === true) return table.byMfs;
  return table.bySingle;
}

/** Annual Part B / Part D surcharge in integer cents, split so month-aware proration can scale each by its own enrollment months. */
export function entryAnnualSurchargeCents(
  entry: IrmaaTableEntry,
): { partBCents: number; partDCents: number } {
  return {
    partBCents: Math.round(entry.partBMonthly * 12 * 100),
    partDCents: Math.round(entry.partDMonthly * 12 * 100),
  };
}
