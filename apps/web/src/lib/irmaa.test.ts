import { describe, it, expect } from 'vitest';
import { computeIrmaa } from './irmaa';
import { IRMAA_TIERS } from './irmaa-tiers';

type IrmaaInput = Parameters<typeof computeIrmaa>[0];

const snap = IRMAA_TIERS;

function input(overrides: Partial<IrmaaInput> = {}): IrmaaInput {
  return {
    taxYear: 2025,
    magiTwoYearsPriorCents: 80_000_00, // $80,000 → none
    filingStatus: 'Single',
    beneficiariesOnMedicareCount: 1,
    ...overrides,
  };
}

describe('computeIrmaa — strict-year lookup', () => {
  it('throws UnsupportedTaxYearError with code UNSUPPORTED_TAX_YEAR for a year not in the snapshot', () => {
    expect(() => computeIrmaa(input({ taxYear: 2030 }), snap)).toThrow(
      expect.objectContaining({ name: 'UnsupportedTaxYearError', code: 'UNSUPPORTED_TAX_YEAR' }),
    );
  });

  it.each([2024, 2026])('does NOT throw for a year present in the snapshot (%i)', (taxYear) => {
    expect(() => computeIrmaa(input({ taxYear }), snap)).not.toThrow();
  });
});

describe('computeIrmaa — zero beneficiaries', () => {
  it('returns all-zero result for 0 beneficiaries regardless of MAGI', () => {
    const result = computeIrmaa(
      input({ beneficiariesOnMedicareCount: 0, magiTwoYearsPriorCents: 1_000_000_00 }),
      snap,
    );
    expect(result.tier).toBe('none');
    expect(result.partBSurchargeCentsPerBeneficiary).toBe(0);
    expect(result.partDSurchargeCentsPerBeneficiary).toBe(0);
    expect(result.totalHouseholdAnnualCents).toBe(0);
  });
});

describe('computeIrmaa — 2025 Single tiers', () => {
  // 2025 Single thresholds: $106k / $133k / $167k / $200k / $500k

  it('none: MAGI = $100,000 → none tier, no surcharge', () => {
    const result = computeIrmaa(
      input({ taxYear: 2025, magiTwoYearsPriorCents: 100_000_00 }),
      snap,
    );
    expect(result.tier).toBe('none');
    expect(result.partBSurchargeCentsPerBeneficiary).toBe(0);
    expect(result.partDSurchargeCentsPerBeneficiary).toBe(0);
  });

  it('none: MAGI exactly at threshold ($106,000) → none tier (inclusive lower)', () => {
    const result = computeIrmaa(
      input({ taxYear: 2025, magiTwoYearsPriorCents: 106_000_00 }),
      snap,
    );
    expect(result.tier).toBe('none');
  });

  it('tier1: MAGI = $106,001 → tier1', () => {
    const result = computeIrmaa(
      input({ taxYear: 2025, magiTwoYearsPriorCents: 106_001_00 }),
      snap,
    );
    expect(result.tier).toBe('tier1');
    // $74.00/mo × 12 × 100 = 88,800 cents
    expect(result.partBSurchargeCentsPerBeneficiary).toBe(88_800);
    // $13.70/mo × 12 × 100 = 16,440 cents
    expect(result.partDSurchargeCentsPerBeneficiary).toBe(16_440);
  });

  it('tier1: MAGI exactly at $133,000 → tier1 (inclusive lower)', () => {
    const result = computeIrmaa(
      input({ taxYear: 2025, magiTwoYearsPriorCents: 133_000_00 }),
      snap,
    );
    expect(result.tier).toBe('tier1');
  });

  it('tier2: MAGI = $133,001 → tier2', () => {
    const result = computeIrmaa(
      input({ taxYear: 2025, magiTwoYearsPriorCents: 133_001_00 }),
      snap,
    );
    expect(result.tier).toBe('tier2');
    // $185.00/mo × 12 × 100 = 222,000 cents
    expect(result.partBSurchargeCentsPerBeneficiary).toBe(222_000);
    // $35.30/mo × 12 × 100 = 42,360 cents
    expect(result.partDSurchargeCentsPerBeneficiary).toBe(42_360);
  });

  it('tier2: MAGI exactly at $167,000 → tier2', () => {
    const result = computeIrmaa(
      input({ taxYear: 2025, magiTwoYearsPriorCents: 167_000_00 }),
      snap,
    );
    expect(result.tier).toBe('tier2');
  });

  it('tier3: MAGI = $167,001 → tier3', () => {
    const result = computeIrmaa(
      input({ taxYear: 2025, magiTwoYearsPriorCents: 167_001_00 }),
      snap,
    );
    expect(result.tier).toBe('tier3');
    // $295.90/mo × 12 × 100 = 355,080 cents
    expect(result.partBSurchargeCentsPerBeneficiary).toBe(355_080);
    // $57.00/mo × 12 × 100 = 68,400 cents
    expect(result.partDSurchargeCentsPerBeneficiary).toBe(68_400);
  });

  it('tier3: MAGI exactly at $200,000 → tier3', () => {
    const result = computeIrmaa(
      input({ taxYear: 2025, magiTwoYearsPriorCents: 200_000_00 }),
      snap,
    );
    expect(result.tier).toBe('tier3');
  });

  it('tier4: MAGI = $200,001 → tier4', () => {
    const result = computeIrmaa(
      input({ taxYear: 2025, magiTwoYearsPriorCents: 200_001_00 }),
      snap,
    );
    expect(result.tier).toBe('tier4');
    // $406.90/mo × 12 × 100 = 488,280 cents
    expect(result.partBSurchargeCentsPerBeneficiary).toBe(488_280);
    // $78.60/mo × 12 × 100 = 94,320 cents
    expect(result.partDSurchargeCentsPerBeneficiary).toBe(94_320);
  });

  it('tier4: MAGI just below $500,000 → tier4', () => {
    const result = computeIrmaa(
      input({ taxYear: 2025, magiTwoYearsPriorCents: 499_999_99 }),
      snap,
    );
    expect(result.tier).toBe('tier4');
  });

  it('tier5: MAGI exactly at $500,000 → tier5 (inclusive upper)', () => {
    const result = computeIrmaa(
      input({ taxYear: 2025, magiTwoYearsPriorCents: 500_000_00 }),
      snap,
    );
    expect(result.tier).toBe('tier5');
    // $443.90/mo × 12 × 100 = 532,680 cents
    expect(result.partBSurchargeCentsPerBeneficiary).toBe(532_680);
    // $85.80/mo × 12 × 100 = 102,960 cents
    expect(result.partDSurchargeCentsPerBeneficiary).toBe(102_960);
  });

  it('tier5: MAGI above $500,000 → tier5', () => {
    const result = computeIrmaa(
      input({ taxYear: 2025, magiTwoYearsPriorCents: 1_000_000_00 }),
      snap,
    );
    expect(result.tier).toBe('tier5');
  });
});

describe('computeIrmaa — 2025 MFJ tiers', () => {
  // 2025 MFJ thresholds: $212k / $266k / $334k / $400k / $750k

  it('none: MAGI = $200,000 → none', () => {
    const result = computeIrmaa(
      input({ taxYear: 2025, filingStatus: 'MFJ', magiTwoYearsPriorCents: 200_000_00 }),
      snap,
    );
    expect(result.tier).toBe('none');
  });

  it('none: MAGI exactly at MFJ t1 ($212,000) → none (inclusive lower)', () => {
    const result = computeIrmaa(
      input({ taxYear: 2025, filingStatus: 'MFJ', magiTwoYearsPriorCents: 212_000_00 }),
      snap,
    );
    expect(result.tier).toBe('none');
  });

  it('tier1: MAGI = $212,001 → tier1', () => {
    const result = computeIrmaa(
      input({ taxYear: 2025, filingStatus: 'MFJ', magiTwoYearsPriorCents: 212_001_00 }),
      snap,
    );
    expect(result.tier).toBe('tier1');
  });

  it('tier5: MAGI exactly at MFJ $750,000 → tier5', () => {
    const result = computeIrmaa(
      input({ taxYear: 2025, filingStatus: 'MFJ', magiTwoYearsPriorCents: 750_000_00 }),
      snap,
    );
    expect(result.tier).toBe('tier5');
  });

  it('MFJ and Single in same tier have identical surcharge amounts', () => {
    const mfjResult = computeIrmaa(
      input({ taxYear: 2025, filingStatus: 'MFJ', magiTwoYearsPriorCents: 212_001_00 }),
      snap,
    );
    const singleResult = computeIrmaa(
      input({ taxYear: 2025, filingStatus: 'Single', magiTwoYearsPriorCents: 106_001_00 }),
      snap,
    );
    expect(mfjResult.tier).toBe('tier1');
    expect(mfjResult.partBSurchargeCentsPerBeneficiary).toBe(
      singleResult.partBSurchargeCentsPerBeneficiary,
    );
  });
});

describe('computeIrmaa — HoH uses Single tiers', () => {
  it('HoH at $212,001 uses Single thresholds (not MFJ)', () => {
    // 2025 Single: $212,001 > $200k → tier4; MFJ: $212,001 > $212k → tier1
    const hohResult = computeIrmaa(
      input({ taxYear: 2025, filingStatus: 'HoH', magiTwoYearsPriorCents: 212_001_00 }),
      snap,
    );
    const mfjResult = computeIrmaa(
      input({ taxYear: 2025, filingStatus: 'MFJ', magiTwoYearsPriorCents: 212_001_00 }),
      snap,
    );
    expect(hohResult.tier).toBe('tier4');
    expect(mfjResult.tier).toBe('tier1');
    expect(hohResult.tier).not.toBe(mfjResult.tier);
  });
});

describe('computeIrmaa — 2 beneficiaries', () => {
  it('total = (partB + partD) × 2', () => {
    const result = computeIrmaa(
      input({ taxYear: 2025, magiTwoYearsPriorCents: 110_000_00, beneficiariesOnMedicareCount: 2 }),
      snap,
    );
    expect(result.tier).toBe('tier1');
    expect(result.totalHouseholdAnnualCents).toBe(
      (result.partBSurchargeCentsPerBeneficiary + result.partDSurchargeCentsPerBeneficiary) * 2,
    );
  });

  it('per-beneficiary amounts unchanged at count=2', () => {
    const r1 = computeIrmaa(
      input({ taxYear: 2025, magiTwoYearsPriorCents: 110_000_00, beneficiariesOnMedicareCount: 1 }),
      snap,
    );
    const r2 = computeIrmaa(
      input({ taxYear: 2025, magiTwoYearsPriorCents: 110_000_00, beneficiariesOnMedicareCount: 2 }),
      snap,
    );
    expect(r1.partBSurchargeCentsPerBeneficiary).toBe(r2.partBSurchargeCentsPerBeneficiary);
    expect(r1.partDSurchargeCentsPerBeneficiary).toBe(r2.partDSurchargeCentsPerBeneficiary);
    expect(r2.totalHouseholdAnnualCents).toBe(r1.totalHouseholdAnnualCents * 2);
  });
});

describe('computeIrmaa — 2024 spot checks', () => {
  it('2024 Single tier1: Part B = $69.90/mo → annual = 83,880 cents', () => {
    const result = computeIrmaa(
      input({ taxYear: 2024, magiTwoYearsPriorCents: 110_000_00 }),
      snap,
    );
    expect(result.tier).toBe('tier1');
    expect(result.partBSurchargeCentsPerBeneficiary).toBe(83_880);
  });

  it('2024 Single none: MAGI = $103,000 exactly → none', () => {
    const result = computeIrmaa(
      input({ taxYear: 2024, magiTwoYearsPriorCents: 103_000_00 }),
      snap,
    );
    expect(result.tier).toBe('none');
  });

  it('2024 Single tier5: MAGI = $500,000 → tier5', () => {
    const result = computeIrmaa(
      input({ taxYear: 2024, magiTwoYearsPriorCents: 500_000_00 }),
      snap,
    );
    expect(result.tier).toBe('tier5');
    // $419.30/mo × 12 × 100 = 503,160 cents
    expect(result.partBSurchargeCentsPerBeneficiary).toBe(503_160);
    // $81.00/mo × 12 × 100 = 97,200 cents
    expect(result.partDSurchargeCentsPerBeneficiary).toBe(97_200);
  });
});

describe('computeIrmaa — 2026 spot checks', () => {
  it('2026 Single tier1: Part B = $81.20/mo → annual = 97,440 cents', () => {
    const result = computeIrmaa(
      input({ taxYear: 2026, magiTwoYearsPriorCents: 110_000_00 }),
      snap,
    );
    expect(result.tier).toBe('tier1');
    expect(result.partBSurchargeCentsPerBeneficiary).toBe(97_440);
  });

  it('2026 Single tier5: MAGI = $500,000 → tier5', () => {
    const result = computeIrmaa(
      input({ taxYear: 2026, magiTwoYearsPriorCents: 500_000_00 }),
      snap,
    );
    expect(result.tier).toBe('tier5');
    // $487.00/mo × 12 × 100 = 584,400 cents
    expect(result.partBSurchargeCentsPerBeneficiary).toBe(584_400);
  });
});
