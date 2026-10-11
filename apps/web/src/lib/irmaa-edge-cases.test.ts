/**
 * Tests for computeIrmaa — edge cases and custom snapshot determinism.
 *
 * Coverage:
 *   - MAGI = 0 → none tier
 *   - Engine is deterministic: same input + snapshot → same output
 *   - Custom snapshot overrides IRMAA_TIERS values
 */

import { describe, it, expect } from 'vitest';
import { computeIrmaa, computeMonthAwareIrmaa, UnsupportedTaxYearError } from './irmaa';
import type { IrmaaInput, MonthAwareIrmaaInput, IrmaaBeneficiaryEnrollment } from './irmaa';
import { IRMAA_TIERS } from './irmaa-tiers';
import type { CalibrationSnapshot } from './calibration';
import type { IrmaaTable } from './irmaa-tiers';

const snap = IRMAA_TIERS;

/** Factory for IrmaaInput — defaults to 2025, Single, 1 beneficiary, base MAGI. */
function input(overrides: Partial<IrmaaInput> = {}): IrmaaInput {
  return {
    taxYear: 2025,
    magiTwoYearsPriorCents: 80_000_00,
    filingStatus: 'Single',
    beneficiariesOnMedicareCount: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Edge: MAGI = 0
// ---------------------------------------------------------------------------

describe('computeIrmaa — MAGI = 0', () => {
  it('MAGI = $0 → none tier', () => {
    const result = computeIrmaa(input({ magiTwoYearsPriorCents: 0 }), snap);
    expect(result.tier).toBe('none');
    expect(result.partBSurchargeCentsPerBeneficiary).toBe(0);
    expect(result.partDSurchargeCentsPerBeneficiary).toBe(0);
    expect(result.totalHouseholdAnnualCents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Regression: zero-beneficiary short-circuit fires before snapshot lookup
// ---------------------------------------------------------------------------

describe('computeIrmaa — zero-beneficiary short-circuit', () => {
  it('taxYear=2030 + beneficiariesOnMedicareCount=0 → all-zero result, does NOT throw UnsupportedTaxYearError', () => {
    // 2030 is not in IRMAA_TIERS snapshot — would throw UnsupportedTaxYearError if snapshot
    // were read first. The short-circuit must fire before the snapshot lookup.
    const result = computeIrmaa(
      input({ taxYear: 2030, magiTwoYearsPriorCents: 800_000_00, beneficiariesOnMedicareCount: 0 }),
      snap,
    );
    expect(result.tier).toBe('none');
    expect(result.partBSurchargeCentsPerBeneficiary).toBe(0);
    expect(result.partDSurchargeCentsPerBeneficiary).toBe(0);
    expect(result.totalHouseholdAnnualCents).toBe(0);
  });

  it('taxYear=2030 + beneficiariesOnMedicareCount=1 → throws UnsupportedTaxYearError (confirms snapshot IS read when count > 0)', () => {
    expect(() =>
      computeIrmaa(input({ taxYear: 2030, beneficiariesOnMedicareCount: 1 }), snap),
    ).toThrow(UnsupportedTaxYearError);
  });
});

// ---------------------------------------------------------------------------
// 2026 MFS lived-with-spouse top threshold = $391,000 (CMS), boundary
// ---------------------------------------------------------------------------

describe('computeIrmaa — 2026 MFS lived-with-spouse top-band boundary', () => {
  const mfs = (magiCents: number): IrmaaInput =>
    input({ taxYear: 2026, filingStatus: 'MFS', mfsLivedWithSpouse: true, magiTwoYearsPriorCents: magiCents });

  it('$390,999.99 stays in the middle band (tier1 surcharge = Single tier4 amounts)', () => {
    const result = computeIrmaa(mfs(390_999_99), snap);
    expect(result.tier).toBe('tier1');
    // 2026 middle-band surcharge = Single tier4: Part B $446.30, Part D $83.30.
    expect(result.partBSurchargeCentsPerBeneficiary).toBe(Math.round(446.3 * 12 * 100));
    expect(result.partDSurchargeCentsPerBeneficiary).toBe(Math.round(83.3 * 12 * 100));
  });

  it('$391,000 exactly crosses into the top band (tier5, Single tier5 amounts)', () => {
    const result = computeIrmaa(mfs(391_000_00), snap);
    expect(result.tier).toBe('tier5');
    expect(result.partBSurchargeCentsPerBeneficiary).toBe(Math.round(487.0 * 12 * 100));
    expect(result.partDSurchargeCentsPerBeneficiary).toBe(Math.round(91.0 * 12 * 100));
  });
});

// ---------------------------------------------------------------------------
// Snapshot determinism
// ---------------------------------------------------------------------------

describe('computeIrmaa — determinism', () => {
  it('returns identical results for the same input called twice', () => {
    const inp = input({ taxYear: 2025, magiTwoYearsPriorCents: 167_001_00 });
    const r1 = computeIrmaa(inp, snap);
    const r2 = computeIrmaa(inp, snap);
    expect(r1).toEqual(r2);
  });
});

// ---------------------------------------------------------------------------
// Custom snapshot
// ---------------------------------------------------------------------------

describe('computeIrmaa — custom snapshot', () => {
  it('uses values from the provided snapshot, not IRMAA_TIERS', () => {
    // Craft a tiny snapshot with shifted thresholds
    const customSnap: CalibrationSnapshot<IrmaaTable> = {
      values: {
        2025: {
          bySingle: [
            { thresholdDollars: 50_000,  partBMonthly: 50.0,  partDMonthly: 10.0 },
            { thresholdDollars: 75_000,  partBMonthly: 100.0, partDMonthly: 20.0 },
            { thresholdDollars: 100_000, partBMonthly: 150.0, partDMonthly: 30.0 },
            { thresholdDollars: 125_000, partBMonthly: 200.0, partDMonthly: 40.0 },
            { thresholdDollars: 200_000, partBMonthly: 250.0, partDMonthly: 50.0 },
          ],
          byMfj: [
            { thresholdDollars: 100_000, partBMonthly: 50.0,  partDMonthly: 10.0 },
            { thresholdDollars: 150_000, partBMonthly: 100.0, partDMonthly: 20.0 },
            { thresholdDollars: 200_000, partBMonthly: 150.0, partDMonthly: 30.0 },
            { thresholdDollars: 250_000, partBMonthly: 200.0, partDMonthly: 40.0 },
            { thresholdDollars: 400_000, partBMonthly: 250.0, partDMonthly: 50.0 },
          ],
          byMfs: [
            { thresholdDollars: 50_000,  partBMonthly: 200.0, partDMonthly: 40.0 },
            { thresholdDollars: 300_000, partBMonthly: 250.0, partDMonthly: 50.0 },
            { thresholdDollars: 300_000, partBMonthly: 250.0, partDMonthly: 50.0 },
            { thresholdDollars: 300_000, partBMonthly: 250.0, partDMonthly: 50.0 },
            { thresholdDollars: 300_000, partBMonthly: 250.0, partDMonthly: 50.0 },
          ],
        },
      } as Record<number, IrmaaTable>,
      metadata: snap.metadata,
    };

    // $80k > $75k threshold → tier2 under custom thresholds
    const result = computeIrmaa(input({ magiTwoYearsPriorCents: 80_000_00 }), customSnap);
    expect(result.tier).toBe('tier2');
    // $100.00/mo × 12 × 100 = 120,000 cents
    expect(result.partBSurchargeCentsPerBeneficiary).toBe(120_000);
  });
});

// ---------------------------------------------------------------------------
// Total household surcharge math
// ---------------------------------------------------------------------------

describe('computeIrmaa — totalHouseholdAnnualCents', () => {
  it('none tier: total = 0 regardless of count', () => {
    const result = computeIrmaa(
      input({ magiTwoYearsPriorCents: 50_000_00, beneficiariesOnMedicareCount: 2 }),
      snap,
    );
    expect(result.totalHouseholdAnnualCents).toBe(0);
  });

  it('tier1, count=1: total = partB + partD', () => {
    const result = computeIrmaa(
      input({ taxYear: 2025, magiTwoYearsPriorCents: 110_000_00, beneficiariesOnMedicareCount: 1 }),
      snap,
    );
    expect(result.totalHouseholdAnnualCents).toBe(
      result.partBSurchargeCentsPerBeneficiary + result.partDSurchargeCentsPerBeneficiary,
    );
  });

  it('tier1, count=2: total = (partB + partD) × 2', () => {
    const result = computeIrmaa(
      input({ taxYear: 2025, magiTwoYearsPriorCents: 110_000_00, beneficiariesOnMedicareCount: 2 }),
      snap,
    );
    expect(result.totalHouseholdAnnualCents).toBe(
      (result.partBSurchargeCentsPerBeneficiary + result.partDSurchargeCentsPerBeneficiary) * 2,
    );
  });
});

// ---------------------------------------------------------------------------
// computeMonthAwareIrmaa — month proration of Part B / Part D separately,
// plus look-back filing-status consumption.
// Input-validation tests live in irmaa-validation.test.ts.
// ---------------------------------------------------------------------------

/** Default full-year enrollment for one beneficiary (both parts, 12 months). */
const FULL_YEAR_BOTH: readonly IrmaaBeneficiaryEnrollment[] = [{ partBMonths: 12, partDMonths: 12 }];

/** Month-aware input factory — 2025 Single tier1 ($110k lookback), overridable. */
function mInput(overrides: Partial<MonthAwareIrmaaInput> = {}): MonthAwareIrmaaInput {
  return {
    taxYear: 2025,
    lookback: { magiCents: 110_000_00, filingStatus: 'Single' },
    beneficiaries: FULL_YEAR_BOTH,
    ...overrides,
  };
}

// 2025 Single tier1 full-year components (mirror the whole-year tests above):
//   Part B $74.00/mo × 12 × 100 = 88,800 cents
//   Part D $13.70/mo × 12 × 100 = 16,440 cents
const T1_PARTB = 88_800;
const T1_PARTD = 16_440;

describe('computeMonthAwareIrmaa — both parts, whole year', () => {
  it('12/12 months, 1 beneficiary → full annual per part', () => {
    const r = computeMonthAwareIrmaa(mInput(), snap);
    expect(r.tier).toBe('tier1');
    expect(r.partBAnnualCentsPerBeneficiary).toBe(T1_PARTB);
    expect(r.partDAnnualCentsPerBeneficiary).toBe(T1_PARTD);
    expect(r.partBProratedHouseholdCents).toBe(T1_PARTB);
    expect(r.partDProratedHouseholdCents).toBe(T1_PARTD);
    expect(r.totalHouseholdAnnualCents).toBe(T1_PARTB + T1_PARTD);
  });

  it('matches computeIrmaa household total for full-year 1 beneficiary', () => {
    const monthAware = computeMonthAwareIrmaa(mInput(), snap);
    const wholeYear = computeIrmaa(
      input({ taxYear: 2025, magiTwoYearsPriorCents: 110_000_00, beneficiariesOnMedicareCount: 1 }),
      snap,
    );
    expect(monthAware.totalHouseholdAnnualCents).toBe(wholeYear.totalHouseholdAnnualCents);
  });
});

describe('computeMonthAwareIrmaa — Part B only / Part D only / neither', () => {
  it('Part B only (12/0) → Part D household is zero', () => {
    const r = computeMonthAwareIrmaa(
      mInput({ beneficiaries: [{ partBMonths: 12, partDMonths: 0 }] }),
      snap,
    );
    expect(r.partBProratedHouseholdCents).toBe(T1_PARTB);
    expect(r.partDProratedHouseholdCents).toBe(0);
    expect(r.totalHouseholdAnnualCents).toBe(T1_PARTB);
  });

  it('Part D only (0/12) → Part B household is zero', () => {
    const r = computeMonthAwareIrmaa(
      mInput({ beneficiaries: [{ partBMonths: 0, partDMonths: 12 }] }),
      snap,
    );
    expect(r.partBProratedHouseholdCents).toBe(0);
    expect(r.partDProratedHouseholdCents).toBe(T1_PARTD);
    expect(r.totalHouseholdAnnualCents).toBe(T1_PARTD);
  });

  it('neither part enrolled (0/0) → all-zero, no snapshot read (accepts an absent year)', () => {
    const r = computeMonthAwareIrmaa(
      mInput({ taxYear: 2030, beneficiaries: [{ partBMonths: 0, partDMonths: 0 }] }),
      snap,
    );
    expect(r.tier).toBe('none');
    expect(r.totalHouseholdAnnualCents).toBe(0);
  });

  it('empty beneficiary list → all-zero', () => {
    const r = computeMonthAwareIrmaa(mInput({ beneficiaries: [] }), snap);
    expect(r.totalHouseholdAnnualCents).toBe(0);
  });
});

describe('computeMonthAwareIrmaa — mid-year transition proration', () => {
  it('6 months each part → half of each annual component (prorated separately)', () => {
    const r = computeMonthAwareIrmaa(
      mInput({ beneficiaries: [{ partBMonths: 6, partDMonths: 6 }] }),
      snap,
    );
    expect(r.partBProratedHouseholdCents).toBe(Math.round((T1_PARTB * 6) / 12));
    expect(r.partDProratedHouseholdCents).toBe(Math.round((T1_PARTD * 6) / 12));
  });

  it('Part B 6 months, Part D 0 months (declined drug plan mid-transition)', () => {
    const r = computeMonthAwareIrmaa(
      mInput({ beneficiaries: [{ partBMonths: 6, partDMonths: 0 }] }),
      snap,
    );
    expect(r.partBProratedHouseholdCents).toBe(Math.round((T1_PARTB * 6) / 12));
    expect(r.partDProratedHouseholdCents).toBe(0);
  });

  it('two beneficiaries with different months sum per part', () => {
    const r = computeMonthAwareIrmaa(
      mInput({
        beneficiaries: [
          { partBMonths: 12, partDMonths: 12 },
          { partBMonths: 6, partDMonths: 0 },
        ],
      }),
      snap,
    );
    expect(r.partBProratedHouseholdCents).toBe(T1_PARTB + Math.round((T1_PARTB * 6) / 12));
    expect(r.partDProratedHouseholdCents).toBe(T1_PARTD);
    expect(r.totalHouseholdAnnualCents).toBe(
      r.partBProratedHouseholdCents + r.partDProratedHouseholdCents,
    );
  });

  it("'none' tier → zero surcharge even at 12/12 months", () => {
    const r = computeMonthAwareIrmaa(
      mInput({ lookback: { magiCents: 100_000_00, filingStatus: 'Single' } }),
      snap,
    );
    expect(r.tier).toBe('none');
    expect(r.totalHouseholdAnnualCents).toBe(0);
  });
});

describe('computeMonthAwareIrmaa — consumes the look-back filing status', () => {
  it('MFJ look-back at $212,001 tiers on the MFJ ladder (tier1), not Single (tier4)', () => {
    const mfj = computeMonthAwareIrmaa(
      mInput({ lookback: { magiCents: 212_001_00, filingStatus: 'MFJ' } }),
      snap,
    );
    const single = computeMonthAwareIrmaa(
      mInput({ lookback: { magiCents: 212_001_00, filingStatus: 'Single' } }),
      snap,
    );
    expect(mfj.tier).toBe('tier1');
    expect(single.tier).toBe('tier4');
  });

  it('MFS lived-with-spouse uses the steeper byMfs schedule', () => {
    const livedTogether = computeMonthAwareIrmaa(
      mInput({ lookback: { magiCents: 150_000_00, filingStatus: 'MFS', mfsLivedWithSpouse: true } }),
      snap,
    );
    const livedApart = computeMonthAwareIrmaa(
      mInput({ lookback: { magiCents: 150_000_00, filingStatus: 'MFS', mfsLivedWithSpouse: false } }),
      snap,
    );
    // byMfs slot 0 is the tier-4 surcharge in the middle band; bySingle at $150k is tier2.
    expect(livedTogether.tier).toBe('tier1');
    expect(livedApart.tier).toBe('tier2');
    expect(livedTogether.partBAnnualCentsPerBeneficiary).toBeGreaterThan(
      livedApart.partBAnnualCentsPerBeneficiary,
    );
  });
});
