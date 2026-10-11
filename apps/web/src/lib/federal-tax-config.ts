/**
 * Federal income tax bracket tables for 2024–2026.
 *
 * Current law (post-OBBBA): the One Big Beautiful Bill Act (signed July 2025)
 * made the TCJA seven-rate structure (10/12/22/24/32/35/37%) permanent, so
 * 2026 keeps the TCJA rate schedule rather than reverting to pre-TCJA rates.
 *
 * Sources:
 *   2024 — IRS Rev. Proc. 2023-34 (inflation-adjusted 2024 amounts)
 *   2025 — IRS Rev. Proc. 2024-40 brackets/LTCG; standard deduction at the
 *          OBBBA-raised amounts (§70102: Single $15,750 / MFJ $31,500 /
 *          HoH $23,625)
 *   2026 — IRS Rev. Proc. 2025-32 (inflation-adjusted 2026 amounts under
 *          OBBBA-permanent TCJA brackets)
 *
 * OBBBA senior bonus deduction: the temporary $6,000/filer deduction for
 * taxpayers age 65+ (tax years 2025–2028, 6% MAGI phase-out above
 * $75k Single / $75k HoH / $150k MFJ) IS modeled — see the
 * `seniorBonusDeduction` slot on the 2025/2026 configs and the year-gated
 * extrapolation carry-forward for 2027/2028. The slot is absent for 2024 and
 * never carried past 2028 (statutory expiry), so those years are $0 by
 * construction.
 *
 * Engine: apps/web/src/lib/federal-tax.ts
 */

import type { CalibrationSnapshot } from './calibration';
import type {
  LtcgBracket,
  SeniorBonusDeduction,
  TaxBracket,
  TaxConfig,
} from './federal-tax';

// ---------------------------------------------------------------------------
// MFS / QSS calibration
// ---------------------------------------------------------------------------
//
// Married-filing-separately (MFS) and qualifying-surviving-spouse (QSS) tables
// are LIVE. The scalar `deriveFilingStatus` only returns Single/MFJ/HoH, but
// the filing plan (`resolveFilingPlanForYear` → `applyTaxYearForFilingPlan`)
// resolves each projection year into tax units, so a `separate` plan reaches
// MFS and a survivor status window reaches QSS. See docs/math-taxes.md,
// "Filing status and tax units".
//
// MFS ordinary brackets and the standard deduction are, by statute, exactly one
// half of the MFJ figures (26 U.S.C. §1(j)(2) for brackets; §63(c)(2)(A)/(C) —
// MFS standard deduction equals the Single amount, which equals MFJ/2). The
// per-year MFS ordinary-bracket arrays below are therefore MFJ/2, verified
// against the published Rev. Proc. MFS columns.
//
// MFS diverges from MFJ/2 in two places that are NOT symmetric and are set from
// the primary sources directly, not derived:
//   - NIIT threshold (IRC §1411): MFS = $125,000 (fixed), NOT MFJ $250,000 / 2.
//   - LTCG/QDI 15%→20% breakpoint: separately inflation-adjusted, so it is not
//     exactly MFJ/2. The MFS 0%→15% breakpoint equals the Single amount. The 20%
//     MFS breakpoints below (2024 $291,850 / 2025 $300,000 / 2026 $306,850) are
//     the published MFS maximum-15%-rate amounts, confirmed against the Rev.
//     Proc. MFS capital-gains column for each year (Rev. Proc. 2023-34,
//     2024-40, 2025-32 respectively).
//
// QSS is tax-computed on the MFJ schedule (26 U.S.C. §1(a)/§2(a)): each config
// below sets its QSS keys to the SAME array references / values as MFJ (no data
// duplication). QSS remains a distinct FilingStatus label everywhere else (SS
// taxation, IRMAA, senior-deduction phase-out base) — see federal-tax.ts.

// ---------------------------------------------------------------------------
// OBBBA senior bonus deduction (Pub. L. 119-21 §70103)
// ---------------------------------------------------------------------------
//
// Temporary $6,000-per-filer deduction for taxpayers age 65+, available for
// tax years 2025–2028 only, phased out at 6% of MAGI above the per-status
// base ($75,000 Single / $75,000 HoH / $150,000 MFJ). The enacted non-joint
// threshold is $75,000 — HoH shares the Single base, not a $112,500 base.
// Statutory amounts are not CPI-indexed, so the same slot applies to every
// in-window year (and to the inflation-extrapolated 2027/2028 configs, which
// carry it forward unchanged — see federal-tax-extrapolation.ts). Lowers
// taxable income, not MAGI.
const SENIOR_BONUS_DEDUCTION_2025_2028: SeniorBonusDeduction = {
  perFilerCap: 6_000,
  // Only a joint return uses the $150,000 base; the eligible non-joint statuses
  // (Single / HoH / QSS) use the $75,000 base. MFS is INELIGIBLE (Pub. L.
  // 119-21 §70103 / IRC §151(d)(5)(C)(v) require a married taxpayer to file
  // JOINTLY): `computeSeniorBonusDeduction` returns $0 for MFS before reading
  // this base, so the MFS key below is unused (kept only to satisfy the
  // per-status record shape). QSS (a surviving-spouse return is not a joint
  // return) stays eligible at $75,000.
  phaseoutBaseMagi: { Single: 75_000, MFJ: 150_000, HoH: 75_000, MFS: 75_000, QSS: 75_000 },
  phaseoutRatePct: 0.06,
};

// ---------------------------------------------------------------------------
// 2024
// ---------------------------------------------------------------------------

const mfjBrackets2024: readonly TaxBracket[] = [
  { floor: 0, rate: 0.10 },
  { floor: 23200, rate: 0.12 },
  { floor: 94300, rate: 0.22 },
  { floor: 201050, rate: 0.24 },
  { floor: 383900, rate: 0.32 },
  { floor: 487450, rate: 0.35 },
  { floor: 731200, rate: 0.37 },
];
// MFS = MFJ / 2 (§1(j)(2)).
const mfsBrackets2024: readonly TaxBracket[] = [
  { floor: 0, rate: 0.10 },
  { floor: 11600, rate: 0.12 },
  { floor: 47150, rate: 0.22 },
  { floor: 100525, rate: 0.24 },
  { floor: 191950, rate: 0.32 },
  { floor: 243725, rate: 0.35 },
  { floor: 365600, rate: 0.37 },
];
const mfjLtcg2024: readonly LtcgBracket[] = [
  { floor: 0, rate: 0.00 },
  { floor: 94050, rate: 0.15 },
  { floor: 583750, rate: 0.20 },
];
const mfsLtcg2024: readonly LtcgBracket[] = [
  { floor: 0, rate: 0.00 },
  { floor: 47025, rate: 0.15 }, // = Single 0%→15% breakpoint.
  { floor: 291850, rate: 0.20 }, // published MFS max-15% amount (Rev. Proc. 2023-34).
];

const config2024: TaxConfig = {
  brackets: {
    Single: [
      { floor: 0, rate: 0.10 },
      { floor: 11600, rate: 0.12 },
      { floor: 47150, rate: 0.22 },
      { floor: 100525, rate: 0.24 },
      { floor: 191950, rate: 0.32 },
      { floor: 243725, rate: 0.35 },
      { floor: 609350, rate: 0.37 },
    ],
    MFJ: mfjBrackets2024,
    HoH: [
      { floor: 0, rate: 0.10 },
      { floor: 16550, rate: 0.12 },
      { floor: 63100, rate: 0.22 },
      { floor: 100500, rate: 0.24 },
      { floor: 191950, rate: 0.32 },
      { floor: 243700, rate: 0.35 },
      { floor: 609350, rate: 0.37 },
    ],
    MFS: mfsBrackets2024,
    QSS: mfjBrackets2024, // QSS uses the MFJ schedule (§1(a)/§2(a)).
  },
  standardDeduction: { Single: 14600, MFJ: 29200, HoH: 21900, MFS: 14600, QSS: 29200 },
  age65AddOn: { singleOrHoH: 1950, mfj: 1550 },
  niitThresholds: { Single: 200000, MFJ: 250000, HoH: 200000, MFS: 125000, QSS: 250000 },
  ltcgBrackets: {
    Single: [
      { floor: 0, rate: 0.00 },
      { floor: 47025, rate: 0.15 },
      { floor: 518900, rate: 0.20 },
    ],
    MFJ: mfjLtcg2024,
    HoH: [
      { floor: 0, rate: 0.00 },
      { floor: 63000, rate: 0.15 },
      { floor: 551350, rate: 0.20 },
    ],
    MFS: mfsLtcg2024,
    QSS: mfjLtcg2024, // QSS uses the MFJ LTCG schedule.
  },
};

// ---------------------------------------------------------------------------
// 2025
// ---------------------------------------------------------------------------

const mfjBrackets2025: readonly TaxBracket[] = [
  { floor: 0, rate: 0.10 },
  { floor: 23850, rate: 0.12 },
  { floor: 96950, rate: 0.22 },
  { floor: 206700, rate: 0.24 },
  { floor: 394600, rate: 0.32 },
  { floor: 501050, rate: 0.35 },
  { floor: 751600, rate: 0.37 },
];
// MFS = MFJ / 2 (§1(j)(2)).
const mfsBrackets2025: readonly TaxBracket[] = [
  { floor: 0, rate: 0.10 },
  { floor: 11925, rate: 0.12 },
  { floor: 48475, rate: 0.22 },
  { floor: 103350, rate: 0.24 },
  { floor: 197300, rate: 0.32 },
  { floor: 250525, rate: 0.35 },
  { floor: 375800, rate: 0.37 },
];
const mfjLtcg2025: readonly LtcgBracket[] = [
  { floor: 0, rate: 0.00 },
  { floor: 96700, rate: 0.15 },
  { floor: 600050, rate: 0.20 },
];
const mfsLtcg2025: readonly LtcgBracket[] = [
  { floor: 0, rate: 0.00 },
  { floor: 48350, rate: 0.15 }, // = Single 0%→15% breakpoint.
  { floor: 300000, rate: 0.20 }, // published MFS max-15% amount (Rev. Proc. 2024-40).
];

const config2025: TaxConfig = {
  brackets: {
    Single: [
      { floor: 0, rate: 0.10 },
      { floor: 11925, rate: 0.12 },
      { floor: 48475, rate: 0.22 },
      { floor: 103350, rate: 0.24 },
      { floor: 197300, rate: 0.32 },
      { floor: 250525, rate: 0.35 },
      { floor: 626350, rate: 0.37 },
    ],
    MFJ: mfjBrackets2025,
    HoH: [
      { floor: 0, rate: 0.10 },
      { floor: 17000, rate: 0.12 },
      { floor: 64850, rate: 0.22 },
      { floor: 103350, rate: 0.24 },
      { floor: 197300, rate: 0.32 },
      { floor: 250500, rate: 0.35 },
      { floor: 626350, rate: 0.37 },
    ],
    MFS: mfsBrackets2025,
    QSS: mfjBrackets2025, // QSS uses the MFJ schedule (§1(a)/§2(a)).
  },
  // OBBBA §70102 raised the 2025 standard deduction above the Rev. Proc.
  // 2024-40 amounts (Single $15,000 → $15,750, MFJ $30,000 → $31,500,
  // HoH $22,500 → $23,625). MFS = Single; QSS = MFJ.
  standardDeduction: { Single: 15750, MFJ: 31500, HoH: 23625, MFS: 15750, QSS: 31500 },
  age65AddOn: { singleOrHoH: 2000, mfj: 1600 },
  seniorBonusDeduction: SENIOR_BONUS_DEDUCTION_2025_2028,
  niitThresholds: { Single: 200000, MFJ: 250000, HoH: 200000, MFS: 125000, QSS: 250000 },
  ltcgBrackets: {
    Single: [
      { floor: 0, rate: 0.00 },
      { floor: 48350, rate: 0.15 },
      { floor: 533400, rate: 0.20 },
    ],
    MFJ: mfjLtcg2025,
    HoH: [
      { floor: 0, rate: 0.00 },
      { floor: 64750, rate: 0.15 },
      { floor: 566700, rate: 0.20 },
    ],
    MFS: mfsLtcg2025,
    QSS: mfjLtcg2025, // QSS uses the MFJ LTCG schedule.
  },
};

// ---------------------------------------------------------------------------
// 2026 — IRS Rev. Proc. 2025-32 (OBBBA-permanent TCJA rate schedule)
// OBBBA made the TCJA seven-rate brackets (10/12/22/24/32/35/37%) permanent;
// these are the inflation-adjusted 2026 amounts, NOT a pre-TCJA reversion.
// ---------------------------------------------------------------------------

const mfjBrackets2026: readonly TaxBracket[] = [
  { floor: 0, rate: 0.10 },
  { floor: 24800, rate: 0.12 },
  { floor: 100800, rate: 0.22 },
  { floor: 211400, rate: 0.24 },
  { floor: 403550, rate: 0.32 },
  { floor: 512450, rate: 0.35 },
  { floor: 768700, rate: 0.37 },
];
// MFS = MFJ / 2 (§1(j)(2)).
const mfsBrackets2026: readonly TaxBracket[] = [
  { floor: 0, rate: 0.10 },
  { floor: 12400, rate: 0.12 },
  { floor: 50400, rate: 0.22 },
  { floor: 105700, rate: 0.24 },
  { floor: 201775, rate: 0.32 },
  { floor: 256225, rate: 0.35 },
  { floor: 384350, rate: 0.37 },
];
const mfjLtcg2026: readonly LtcgBracket[] = [
  { floor: 0, rate: 0.00 },
  { floor: 98900, rate: 0.15 },
  { floor: 613700, rate: 0.20 },
];
const mfsLtcg2026: readonly LtcgBracket[] = [
  { floor: 0, rate: 0.00 },
  { floor: 49450, rate: 0.15 }, // = Single 0%→15% breakpoint.
  { floor: 306850, rate: 0.20 }, // published MFS max-15% amount (Rev. Proc. 2025-32).
];

const config2026: TaxConfig = {
  brackets: {
    Single: [
      { floor: 0, rate: 0.10 },
      { floor: 12400, rate: 0.12 },
      { floor: 50400, rate: 0.22 },
      { floor: 105700, rate: 0.24 },
      { floor: 201775, rate: 0.32 },
      { floor: 256225, rate: 0.35 },
      { floor: 640600, rate: 0.37 },
    ],
    MFJ: mfjBrackets2026,
    HoH: [
      { floor: 0, rate: 0.10 },
      { floor: 17700, rate: 0.12 },
      { floor: 67450, rate: 0.22 },
      { floor: 105700, rate: 0.24 },
      { floor: 201775, rate: 0.32 },
      { floor: 256200, rate: 0.35 },
      { floor: 640600, rate: 0.37 },
    ],
    MFS: mfsBrackets2026,
    QSS: mfjBrackets2026, // QSS uses the MFJ schedule (§1(a)/§2(a)).
  },
  standardDeduction: { Single: 16100, MFJ: 32200, HoH: 24150, MFS: 16100, QSS: 32200 },
  age65AddOn: { singleOrHoH: 2050, mfj: 1650 },
  seniorBonusDeduction: SENIOR_BONUS_DEDUCTION_2025_2028,
  // NIIT thresholds are NOT CPI-indexed; frozen at 2013 enactment levels.
  // MFS = $125,000 (§1411); QSS = MFJ $250,000.
  niitThresholds: { Single: 200000, MFJ: 250000, HoH: 200000, MFS: 125000, QSS: 250000 },
  ltcgBrackets: {
    Single: [
      { floor: 0, rate: 0.00 },
      { floor: 49450, rate: 0.15 },
      { floor: 545500, rate: 0.20 },
    ],
    MFJ: mfjLtcg2026,
    HoH: [
      { floor: 0, rate: 0.00 },
      { floor: 66200, rate: 0.15 },
      { floor: 579600, rate: 0.20 },
    ],
    MFS: mfsLtcg2026,
    QSS: mfjLtcg2026, // QSS uses the MFJ LTCG schedule.
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const FEDERAL_TAX_CONFIG: CalibrationSnapshot<TaxConfig> = {
  values: {
    2024: config2024,
    2025: config2025,
    2026: config2026,
  },
  metadata: {
    source:
      'https://www.irs.gov/pub/irs-drop/rp-23-34.pdf, ' +
      'https://www.irs.gov/pub/irs-drop/rp-24-40.pdf, ' +
      'OBBBA Pub. L. 119-21 §70102 (2025 standard deduction), ' +
      'OBBBA Pub. L. 119-21 §70103 (2025-2028 senior bonus deduction), ' +
      'https://www.irs.gov/newsroom/check-your-eligibility-for-the-new-enhanced-deduction-for-seniors ' +
      '(HoH senior-deduction phaseout base corrected to the $75,000 non-joint threshold), ' +
      'https://www.irs.gov/pub/irs-drop/rp-25-32.pdf, ' +
      '26 U.S.C. §1(j)',
    asOfDate: '2026-07-18',
    jurisdiction: 'US-federal',
  },
};
