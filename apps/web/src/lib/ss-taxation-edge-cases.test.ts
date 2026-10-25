// Oracle: IRS Pub 915 Worksheet 1 (2024 edition), 26 USC §86.

import { describe, expect, it } from 'vitest';
import { computeSsTaxation, type SsTaxThresholds } from './ss-taxation';
import { SS_TAX_THRESHOLDS } from './ss-taxation-thresholds';
import { type CalibrationSnapshot } from './calibration';

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
});

describe('FP envelope: odd-cent grossSs at half-cent PI boundary follows Math.round(x*100) FP semantics', () => {
  it('computeSsTaxation at MFJ tier-1 boundary with odd-cent grossSs reports the IEEE 754 provisional income', () => {
    // Half-up would give 3_200_001 + 0.5×9 = 3_200_005.5 → 3_200_006. Each cent input is divided by 100 before
    // summing (32000.01 + 0.045 = 32000.054999999997), so Math.round gives 3_200_005: an accepted trade-off.
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
    // PI $32,000.05 > MFJ tier-1 $32,000 → 'fifty', not 'none'
    expect(result.provisionalIncomeCents).toBe(3_200_005);
    expect(result.tier).toBe('fifty');
    expect(result.taxableSsCents).toBeGreaterThanOrEqual(0);
    expect(result.taxableSsCents).toBeLessThanOrEqual(Math.round(0.5 * 9));
  });
});

describe('85% cap rounding', () => {
  it.each([1, 3])('taxableSsCents <= Math.round(0.85 * grossSsCents) when the cap binds at %i cents', (grossSsCents) => {
    const result = computeSsTaxation(
      {
        grossSsCents,
        otherAgiCents: 100_000_00,
        taxExemptInterestCents: 0,
        filingStatus: 'Single',
        taxYear: 2024,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.taxableSsCents).toBeLessThanOrEqual(Math.round(0.85 * grossSsCents));
  });
});

describe('year resolution — clamp-to-latest', () => {
  it('taxYear 2030 against values[2024] resolves to 2024 entry, no throw', () => {
    // §86 thresholds are statutorily fixed, so the 2024 entry applies for any year ≥ 2024.
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
          tier1: { Single: 30_000, MFJ: 38_000, HoH: 30_000 },
          tier2: { Single: 40_000, MFJ: 52_000, HoH: 40_000 },
        },
      },
      metadata: { source: 'test', asOfDate: '2024-01-01' },
    };
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
    // 2027 MFJ tier-1 is 38_000: PI = 27_000 + 15_000 = 42_000 → fifty
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

describe('UnsupportedTaxYearError', () => {
  it('taxYear 2023 throws with code UNSUPPORTED_TAX_YEAR and year 2023', () => {
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
    ).toThrow(
      expect.objectContaining({ name: 'UnsupportedTaxYearError', code: 'UNSUPPORTED_TAX_YEAR', year: 2023 }),
    );
  });
});
