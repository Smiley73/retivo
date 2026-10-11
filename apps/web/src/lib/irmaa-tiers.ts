/**
 * IRMAA calibration data — Medicare Part B/D income-related adjustment tiers.
 * Typed seed config for 2024, 2025, and 2026 CMS published values.
 */

import type { CalibrationSnapshot } from './calibration';
import type { FilingStatus } from './federal-tax';

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

/**
 * One tier entry: the MAGI threshold that starts this tier plus monthly surcharge amounts.
 * There are 5 entries per filing-status group (tier1–tier5); tier 'none' is implicit
 * (MAGI ≤ entries[0].thresholdDollars → no surcharge).
 */
export interface IrmaaTableEntry {
  /** MAGI in dollars at which this tier begins (lower-bound exclusive). Tier5 is inclusive. */
  thresholdDollars: number;
  /** Monthly Part B surcharge in dollars for this tier. */
  partBMonthly: number;
  /** Monthly Part D surcharge in dollars for this tier. */
  partDMonthly: number;
}

/**
 * Full IRMAA table for one tax year.
 * HoH and QSS filers use `bySingle` (CMS practice; QSS is an individual
 * filer for IRMAA). MFS filers who lived with their spouse use `byMfs`.
 * Each array has exactly 5 entries: [tier1, tier2, tier3, tier4, tier5].
 *
 * `byMfs`: CMS publishes only a TWO-band MFS schedule (lived-with-spouse):
 * no surcharge at/below the first single-filer threshold, the tier-4 surcharge
 * level in the wide middle band, and the tier-5 surcharge level above a single
 * high MFS threshold. That two-band shape is expressed in the fixed 5-entry
 * structure by repeating the high threshold + tier-5 surcharge in slots 2-5, so
 * `resolveTier` returns `tier1` for the middle band and `tier5` above the high
 * threshold, with the correct surcharge amounts at each. The intermediate tier
 * labels are unreachable by construction (equal thresholds).
 * Reached whenever a look-back or current-year unit files MFS.
 */
export interface IrmaaTable {
  bySingle: readonly [IrmaaTableEntry, IrmaaTableEntry, IrmaaTableEntry, IrmaaTableEntry, IrmaaTableEntry];
  byMfj: readonly [IrmaaTableEntry, IrmaaTableEntry, IrmaaTableEntry, IrmaaTableEntry, IrmaaTableEntry];
  byMfs: readonly [IrmaaTableEntry, IrmaaTableEntry, IrmaaTableEntry, IrmaaTableEntry, IrmaaTableEntry];
}

// ---------------------------------------------------------------------------
// 2024 CMS values
// Source: https://www.cms.gov/newsroom/fact-sheets/2024-medicare-parts-b-premiums-and-deductibles
// ---------------------------------------------------------------------------

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
  // MFS lived-with-spouse: no surcharge ≤ $103,000; the tier-4 surcharge in the
  // middle band; the tier-5 surcharge ≥ $397,000 (the published 2024 CMS
  // lived-with-spouse top threshold — see metadata.source). Slots 2-5 repeat the
  // high threshold + tier-5 surcharge (two-band collapse — see IrmaaTable docs).
  byMfs: [
    { thresholdDollars: 103_000, partBMonthly: 384.3, partDMonthly: 74.2 },
    { thresholdDollars: 397_000, partBMonthly: 419.3, partDMonthly: 81.0 },
    { thresholdDollars: 397_000, partBMonthly: 419.3, partDMonthly: 81.0 },
    { thresholdDollars: 397_000, partBMonthly: 419.3, partDMonthly: 81.0 },
    { thresholdDollars: 397_000, partBMonthly: 419.3, partDMonthly: 81.0 },
  ],
};

// ---------------------------------------------------------------------------
// 2025 CMS values
// Source: https://www.cms.gov/newsroom/fact-sheets/2025-medicare-parts-b-premiums-and-deductibles
// ---------------------------------------------------------------------------

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
  // MFS lived-with-spouse: top threshold $394,000 (published 2025 CMS
  // lived-with-spouse figure — see metadata.source).
  byMfs: [
    { thresholdDollars: 106_000, partBMonthly: 406.9, partDMonthly: 78.6 },
    { thresholdDollars: 394_000, partBMonthly: 443.9, partDMonthly: 85.8 },
    { thresholdDollars: 394_000, partBMonthly: 443.9, partDMonthly: 85.8 },
    { thresholdDollars: 394_000, partBMonthly: 443.9, partDMonthly: 85.8 },
    { thresholdDollars: 394_000, partBMonthly: 443.9, partDMonthly: 85.8 },
  ],
};

// ---------------------------------------------------------------------------
// 2026 CMS values
// Source: https://www.cms.gov/newsroom/fact-sheets/2026-medicare-parts-b-premiums-deductibles
// ---------------------------------------------------------------------------

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
  // MFS lived-with-spouse: top threshold $391,000 (published 2026 CMS
  // lived-with-spouse figure — see metadata.source).
  byMfs: [
    { thresholdDollars: 109_000, partBMonthly: 446.3, partDMonthly: 83.3 },
    { thresholdDollars: 391_000, partBMonthly: 487.0, partDMonthly: 91.0 },
    { thresholdDollars: 391_000, partBMonthly: 487.0, partDMonthly: 91.0 },
    { thresholdDollars: 391_000, partBMonthly: 487.0, partDMonthly: 91.0 },
    { thresholdDollars: 391_000, partBMonthly: 487.0, partDMonthly: 91.0 },
  ],
};

// ---------------------------------------------------------------------------
// Exported snapshot
// ---------------------------------------------------------------------------

/**
 * Canonical IRMAA calibration snapshot.
 * Update `values[<new-year>]` and `metadata.source` + `metadata.asOfDate`
 * when CMS publishes the new year's announcement (typically October–November).
 */
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

// ---------------------------------------------------------------------------
// Schedule + component selectors (shared by the whole-year and month-aware
// IRMAA engines)
// ---------------------------------------------------------------------------

/**
 * Select the tier-schedule (5-entry array) a filing status reads from a table.
 * The single source of truth for IRMAA filing-status routing:
 *   - `MFJ`                       → `byMfj`
 *   - `MFS` + lived-with-spouse   → `byMfs` (the steeper two-band schedule)
 *   - `MFS` lived-apart / absent  → `bySingle` (individual ladder)
 *   - `Single` / `HoH` / `QSS`    → `bySingle` (QSS is an individual filer)
 * Consumed by both `computeIrmaa` (whole-year) and `computeMonthAwareIrmaa`
 * (month-aware), so the two engines can never disagree on routing.
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

/**
 * Annual Part B / Part D surcharge (integer cents) for one tier entry — the
 * B/D components exposed separately so month-aware proration can scale each part
 * by its own enrollment months. `Math.round(monthly × 12 × 100)`.
 */
export function entryAnnualSurchargeCents(
  entry: IrmaaTableEntry,
): { partBCents: number; partDCents: number } {
  return {
    partBCents: Math.round(entry.partBMonthly * 12 * 100),
    partDCents: Math.round(entry.partDMonthly * 12 * 100),
  };
}
