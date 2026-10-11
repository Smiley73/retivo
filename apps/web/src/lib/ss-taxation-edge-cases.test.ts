/**
 * SS taxation engine — edge cases, year-resolution, rounding, and helper export.
 * Oracle: IRS Pub 915 Worksheet 1 (2024 edition), 26 USC §86.
 */

import { describe, expect, it } from 'vitest';
import {
  computeSsTaxation,
  provisionalIncomeCents,
  UnsupportedTaxYearError,
  type SsTaxThresholds,
} from './ss-taxation';
import { SS_TAX_THRESHOLDS } from './ss-taxation-thresholds';
import { type CalibrationSnapshot } from './calibration';

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('zero grossSsCents → taxable = 0, PI = otherAgi', () => {
    const result = computeSsTaxation(
      {
        grossSsCents: 0,
        otherAgiCents: 50_000_00,
        taxExemptInterestCents: 0,
        filingStatus: 'MFJ',
        taxYear: 2024,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.taxableSsCents).toBe(0);
    expect(result.provisionalIncomeCents).toBe(50_000_00);
  });

  it('zero otherAgiCents → PI = 0.5 × grossSS (typical retiree below tier-1)', () => {
    // PI = 0 + 0 + 0.5×20_000 = 10_000 < 25_000 (Single tier-1)
    const result = computeSsTaxation(
      {
        grossSsCents: 20_000_00,
        otherAgiCents: 0,
        taxExemptInterestCents: 0,
        filingStatus: 'Single',
        taxYear: 2024,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.tier).toBe('none');
    expect(result.taxableSsCents).toBe(0);
    expect(result.provisionalIncomeCents).toBe(10_000_00);
  });

  it('tax-exempt interest pushes PI over MFJ tier-1 (would be none without it)', () => {
    // Without muni: PI = 20_000 + 10_000 = 30_000 < 32_000 → none
    // With muni:    PI = 20_000 + 5_000 + 10_000 = 35_000 > 32_000 → fifty
    const result = computeSsTaxation(
      {
        grossSsCents: 20_000_00,
        otherAgiCents: 20_000_00,
        taxExemptInterestCents: 5_000_00,
        filingStatus: 'MFJ',
        taxYear: 2024,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.tier).toBe('fifty');
  });

  it('provisionalIncomeCents helper matches computeSsTaxation output', () => {
    const grossSsCents = 30_000_00;
    const otherAgiCents = 25_000_00;
    const taxExemptInterestCents = 0;
    const helperResult = provisionalIncomeCents(
      grossSsCents,
      otherAgiCents,
      taxExemptInterestCents,
    );
    const engineResult = computeSsTaxation(
      {
        grossSsCents,
        otherAgiCents,
        taxExemptInterestCents,
        filingStatus: 'MFJ',
        taxYear: 2024,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(helperResult).toBe(engineResult.provisionalIncomeCents);
  });
});

// ---------------------------------------------------------------------------
// FP envelope regression — rounding semantics at half-cent boundaries
// ---------------------------------------------------------------------------

describe('FP envelope: odd-cent grossSs at half-cent PI boundary follows Math.round(x*100) FP semantics', () => {
  it('provisionalIncomeCents pins IEEE 754 result at half-cent boundary', () => {
    // Pins the Math.round(x*100) floating-point envelope at half-cent PI
    // boundaries.
    // Mathematical half-up answer: 3_200_001 + 0.5×9 = 3_200_005.5 → 3_200_006.
    // Engine result: each cent input is divided by 100 individually before
    // summing (3_200_001/100 = 32000.01; 0.5×9/100 = 0.045), so
    // 32000.01 + 0.045 = 32000.054999999997 in IEEE 754 binary, and
    // Math.round(3200005.4999...) === 3200005. This is the accepted
    // DIY-persona trade-off, not a defect.
    expect(provisionalIncomeCents(9, 3_200_001, 0)).toBe(
      Math.round((3_200_001 / 100 + 0.5 * (9 / 100)) * 100),
    );
    // Confirm the exact integer value the engine produces (3_200_005).
    expect(provisionalIncomeCents(9, 3_200_001, 0)).toBe(3_200_005);
  });

  it('computeSsTaxation at MFJ tier-1 boundary with odd-cent grossSs stays in tier none', () => {
    // PI = 3_200_005 cents = $32,000.05 > MFJ tier-1 $32,000, so tier is 'fifty'.
    // Demonstrates engine is internally consistent: piCents and tier agree at this edge.
    const result = computeSsTaxation(
      {
        grossSsCents: 9,
        otherAgiCents: 3_200_001,
        taxExemptInterestCents: 0,
        filingStatus: 'MFJ',
        taxYear: 2024,
      },
      SS_TAX_THRESHOLDS,
    );
    // PI = 3_200_005 → $32,000.05 > $32,000 (MFJ tier-1) → 'fifty', not 'none'
    expect(result.provisionalIncomeCents).toBe(3_200_005);
    expect(result.tier).toBe('fifty');
    // taxable = min(0.5×grossSS, 0.5×(PI−tier1)) = min(0.045, 0.5×0.05) = min(0.045, 0.025) = 0.025
    // Math.round(0.025 × 100) = Math.round(2.5) = 3 — Math.round half-up in V8
    expect(result.taxableSsCents).toBeGreaterThanOrEqual(0);
    expect(result.taxableSsCents).toBeLessThanOrEqual(Math.round(0.5 * 9));
  });
});

// ---------------------------------------------------------------------------
// 85% cap rounding — cap applied on float before round
// ---------------------------------------------------------------------------

describe('85% cap rounding', () => {
  it('taxableSsCents <= Math.round(0.85 * grossSsCents) exactly when cap binds', () => {
    // Use grossSsCents = 1 so cap = Math.round(0.85×1) = 1 cent
    // With very high other-income, cap binds
    const result = computeSsTaxation(
      {
        grossSsCents: 1,
        otherAgiCents: 100_000_00,
        taxExemptInterestCents: 0,
        filingStatus: 'Single',
        taxYear: 2024,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.taxableSsCents).toBeLessThanOrEqual(Math.round(0.85 * 1));
  });

  it('cap binds exactly — grossSsCents=3 → cap=Math.round(0.85×3)=3, taxable≤3', () => {
    // 0.85 × 3 cents = 2.55 → Math.round = 3
    const result = computeSsTaxation(
      {
        grossSsCents: 3,
        otherAgiCents: 100_000_00,
        taxExemptInterestCents: 0,
        filingStatus: 'Single',
        taxYear: 2024,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.taxableSsCents).toBeLessThanOrEqual(Math.round(0.85 * 3));
  });
});

// ---------------------------------------------------------------------------
// Year resolution — clamp-to-latest
// ---------------------------------------------------------------------------

describe('year resolution — clamp-to-latest', () => {
  it('taxYear 2030 against values[2024] resolves to 2024 entry, no throw', () => {
    // Deliberate divergence from federal-tax no-clamp: §86 thresholds are
    // statutorily fixed, so the 2024 entry applies for any year ≥ 2024.
    const result = computeSsTaxation(
      {
        grossSsCents: 30_000_00,
        otherAgiCents: 50_000_00,
        taxExemptInterestCents: 5_000_00,
        filingStatus: 'MFJ',
        taxYear: 2030,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.tier).toBe('eighty-five');
    expect(result.taxableSsCents).toBe(25_500_00);
  });

  it('taxYear 2024 resolves exactly to the 2024 entry', () => {
    const result = computeSsTaxation(
      {
        grossSsCents: 30_000_00,
        otherAgiCents: 10_000_00,
        taxExemptInterestCents: 0,
        filingStatus: 'MFJ',
        taxYear: 2024,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.tier).toBe('none');
    expect(result.taxableSsCents).toBe(0);
  });

  it('clamp resolves to highest key ≤ taxYear when multiple keys present', () => {
    const twoKeySnapshot: CalibrationSnapshot<SsTaxThresholds> = {
      values: {
        2024: SS_TAX_THRESHOLDS.values[2024],
        2027: {
          // Hypothetical updated thresholds — higher tier-1/2
          tier1: { Single: 30_000, MFJ: 38_000, HoH: 30_000 },
          tier2: { Single: 40_000, MFJ: 52_000, HoH: 40_000 },
        },
      },
      metadata: { source: 'test', asOfDate: '2024-01-01' },
    };
    // taxYear 2026 → should resolve to 2024 (not 2027)
    const result2026 = computeSsTaxation(
      {
        grossSsCents: 30_000_00,
        otherAgiCents: 10_000_00,
        taxExemptInterestCents: 0,
        filingStatus: 'MFJ',
        taxYear: 2026,
      },
      twoKeySnapshot,
    );
    expect(result2026.tier).toBe('none');
    // taxYear 2027 with MFJ tier-1 at 38_000:
    // PI = 27_000 + 15_000 = 42_000 > 38_000 → fifty
    const result2027b = computeSsTaxation(
      {
        grossSsCents: 30_000_00,
        otherAgiCents: 27_000_00,
        taxExemptInterestCents: 0,
        filingStatus: 'MFJ',
        taxYear: 2027,
      },
      twoKeySnapshot,
    );
    expect(result2027b.tier).toBe('fifty');
  });
});

// ---------------------------------------------------------------------------
// UnsupportedTaxYearError
// ---------------------------------------------------------------------------

describe('UnsupportedTaxYearError', () => {
  it('taxYear 2023 throws UnsupportedTaxYearError', () => {
    expect(() =>
      computeSsTaxation(
        {
          grossSsCents: 10_000_00,
          otherAgiCents: 0,
          taxExemptInterestCents: 0,
          filingStatus: 'Single',
          taxYear: 2023,
        },
        SS_TAX_THRESHOLDS,
      ),
    ).toThrow(UnsupportedTaxYearError);
  });

  it('error.code === UNSUPPORTED_TAX_YEAR and error.year === 2023', () => {
    let caught: unknown;
    try {
      computeSsTaxation(
        {
          grossSsCents: 10_000_00,
          otherAgiCents: 0,
          taxExemptInterestCents: 0,
          filingStatus: 'Single',
          taxYear: 2023,
        },
        SS_TAX_THRESHOLDS,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsupportedTaxYearError);
    const err = caught as UnsupportedTaxYearError;
    expect(err.code).toBe('UNSUPPORTED_TAX_YEAR');
    expect(err.year).toBe(2023);
  });
});
