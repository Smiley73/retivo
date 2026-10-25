// Oracle: IRS Pub 915 Worksheet 1 (2024 edition), 26 USC §86.

import { describe, expect, it } from 'vitest';
import { computeSsTaxation } from './ss-taxation';
import { SS_TAX_THRESHOLDS } from './ss-taxation-thresholds';

describe('MFJ — tier: none', () => {
  it('taxableSsCents=0 when PI < tier-1', () => {
    // PI = 10_000 + 0 + 15_000 = 25_000 < 32_000 tier-1
    // Worksheet 1 line 3 = 25_000 ≤ 32_000 → line 8 = 0
    const result = computeSsTaxation(
      {
        grossSsCents: 30_000_00,
        otherAgiCents: 10_000_00,
        taxExemptInterestCents: 0,
        filingStatus: 'MFJ',
        taxYear: 2025,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.tier).toBe('none');
    expect(result.taxableSsCents).toBe(0);
    expect(result.provisionalIncomeCents).toBe(25_000_00);
  });

  it('taxableSsCents=0 when PI exactly equals MFJ tier-1 ($32,000) — boundary inclusive', () => {
    // PI = 17_000 + 0 + 15_000 = 32_000 (exactly at tier-1 → 'none' per §86(a)(1) "≤")
    const result = computeSsTaxation(
      {
        grossSsCents: 30_000_00,
        otherAgiCents: 17_000_00,
        taxExemptInterestCents: 0,
        filingStatus: 'MFJ',
        taxYear: 2025,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.tier).toBe('none');
    expect(result.taxableSsCents).toBe(0);
    expect(result.provisionalIncomeCents).toBe(32_000_00);
  });
});

describe('MFJ — tier: fifty', () => {
  it('50% tier mid-range', () => {
    // PI = 25_000 + 0 + 15_000 = 40_000 ∈ (32_000, 44_000]
    // taxable = min(0.5×30_000, 0.5×(40_000−32_000)) = min(15_000, 4_000) = 4_000
    const result = computeSsTaxation(
      {
        grossSsCents: 30_000_00,
        otherAgiCents: 25_000_00,
        taxExemptInterestCents: 0,
        filingStatus: 'MFJ',
        taxYear: 2025,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.tier).toBe('fifty');
    expect(result.taxableSsCents).toBe(4_000_00);
    expect(result.provisionalIncomeCents).toBe(40_000_00);
  });

  it('PI just above MFJ tier-1 → tier fifty with small taxable', () => {
    // PI = 17_001 + 15_000 = 32_001 > 32_000 (1 dollar above tier-1)
    // taxable = min(15_000, 0.5×1) = min(15_000, 0.50) = $0.50 → 50 cents
    const result = computeSsTaxation(
      {
        grossSsCents: 30_000_00,
        otherAgiCents: 1_700_100, // $17_001.00 → PI = $32_001
        taxExemptInterestCents: 0,
        filingStatus: 'MFJ',
        taxYear: 2025,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.tier).toBe('fifty');
    expect(result.taxableSsCents).toBe(50); // 50 cents
  });

  it('PI exactly equals MFJ tier-2 ($44,000) → tier fifty', () => {
    // PI = 29_000 + 0 + 15_000 = 44_000 (≤ tier-2 → 'fifty' per §86(a)(2)(A) "≤")
    // taxable = min(15_000, 0.5×(44_000−32_000)) = min(15_000, 6_000) = 6_000
    const result = computeSsTaxation(
      {
        grossSsCents: 30_000_00,
        otherAgiCents: 29_000_00,
        taxExemptInterestCents: 0,
        filingStatus: 'MFJ',
        taxYear: 2025,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.tier).toBe('fifty');
    expect(result.taxableSsCents).toBe(6_000_00);
    expect(result.provisionalIncomeCents).toBe(44_000_00);
  });
});

describe('MFJ — tier: eighty-five', () => {
  it('85% cap engaged (high other-income)', () => {
    // PI = 50_000 + 5_000 + 15_000 = 70_000 > 44_000
    // innerMin = min(0.5×12_000, 0.5×30_000) = min(6_000, 15_000) = 6_000
    // uncapped = 0.85×(70_000−44_000) + 6_000 = 22_100 + 6_000 = 28_100
    // cap      = 0.85×30_000 = 25_500
    // taxable  = min(25_500, 28_100) = 25_500  ← cap engaged
    const result = computeSsTaxation(
      {
        grossSsCents: 30_000_00,
        otherAgiCents: 50_000_00,
        taxExemptInterestCents: 5_000_00,
        filingStatus: 'MFJ',
        taxYear: 2025,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.tier).toBe('eighty-five');
    expect(result.taxableSsCents).toBe(25_500_00);
    expect(result.provisionalIncomeCents).toBe(70_000_00);
  });

  it('85% tier cap NOT engaged (moderate income above tier-2)', () => {
    // PI = 35_000 + 15_000 = 50_000 > 44_000
    // innerMin = min(6_000, 15_000) = 6_000
    // uncapped = 0.85×(50_000−44_000) + 6_000 = 5_100 + 6_000 = 11_100
    // cap      = 25_500
    // taxable  = min(25_500, 11_100) = 11_100  ← cap NOT engaged
    const result = computeSsTaxation(
      {
        grossSsCents: 30_000_00,
        otherAgiCents: 35_000_00,
        taxExemptInterestCents: 0,
        filingStatus: 'MFJ',
        taxYear: 2025,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.tier).toBe('eighty-five');
    expect(result.taxableSsCents).toBe(11_100_00);
  });

  it('PI just above MFJ tier-2 ($44_000.01) → tier eighty-five', () => {
    // otherAgi = 29_000.01 dollars → 2_900_001 cents
    // PI = 29_000.01 + 15_000 = 44_000.01 > 44_000
    const result = computeSsTaxation(
      {
        grossSsCents: 30_000_00,
        otherAgiCents: 2_900_001, // $29_000.01
        taxExemptInterestCents: 0,
        filingStatus: 'MFJ',
        taxYear: 2025,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.tier).toBe('eighty-five');
  });
});

describe('Single — tier matrix', () => {
  it('tier none (PI < $25,000)', () => {
    // PI = 10_000 + 0 + 5_000 = 15_000 < 25_000
    const result = computeSsTaxation(
      {
        grossSsCents: 10_000_00,
        otherAgiCents: 10_000_00,
        taxExemptInterestCents: 0,
        filingStatus: 'Single',
        taxYear: 2025,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.tier).toBe('none');
    expect(result.taxableSsCents).toBe(0);
  });

  it('tier none — PI exactly at Single tier-1 ($25,000)', () => {
    // PI = 20_000 + 0 + 5_000 = 25_000 → 'none'
    const result = computeSsTaxation(
      {
        grossSsCents: 10_000_00,
        otherAgiCents: 20_000_00,
        taxExemptInterestCents: 0,
        filingStatus: 'Single',
        taxYear: 2025,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.tier).toBe('none');
    expect(result.taxableSsCents).toBe(0);
  });

  it('tier fifty — mid-range', () => {
    // PI = 22_000 + 0 + 5_000 = 27_000 ∈ (25_000, 34_000]
    // taxable = min(0.5×10_000, 0.5×(27_000−25_000)) = min(5_000, 1_000) = 1_000
    const result = computeSsTaxation(
      {
        grossSsCents: 10_000_00,
        otherAgiCents: 22_000_00,
        taxExemptInterestCents: 0,
        filingStatus: 'Single',
        taxYear: 2025,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.tier).toBe('fifty');
    expect(result.taxableSsCents).toBe(1_000_00);
  });

  it('tier eighty-five — cap engaged', () => {
    // PI = 40_000 + 0 + 5_000 = 45_000 > 34_000
    // innerMin = min(0.5×9_000, 0.5×10_000) = min(4_500, 5_000) = 4_500
    // uncapped = 0.85×(45_000−34_000) + 4_500 = 9_350 + 4_500 = 13_850
    // cap      = 0.85×10_000 = 8_500
    // taxable  = min(8_500, 13_850) = 8_500  ← cap engaged
    const result = computeSsTaxation(
      {
        grossSsCents: 10_000_00,
        otherAgiCents: 40_000_00,
        taxExemptInterestCents: 0,
        filingStatus: 'Single',
        taxYear: 2025,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.tier).toBe('eighty-five');
    expect(result.taxableSsCents).toBe(8_500_00);
  });

  it('tier eighty-five — cap NOT engaged', () => {
    // PI = 30_000 + 5_000 = 35_000 > 34_000
    // innerMin = min(0.5×9_000, 0.5×10_000) = min(4_500, 5_000) = 4_500
    // uncapped = 0.85×(35_000−34_000) + 4_500 = 850 + 4_500 = 5_350
    // cap      = 8_500
    // taxable  = min(8_500, 5_350) = 5_350  ← cap NOT engaged
    const result = computeSsTaxation(
      {
        grossSsCents: 10_000_00,
        otherAgiCents: 30_000_00,
        taxExemptInterestCents: 0,
        filingStatus: 'Single',
        taxYear: 2025,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.tier).toBe('eighty-five');
    expect(result.taxableSsCents).toBe(5_350_00);
  });
});

describe('HoH — uses Single thresholds per §86(c)(1)(A)', () => {
  it('PI above Single tier-2 ($34k) → eighty-five (would be fifty under MFJ tier-2 $44k)', () => {
    // PI = 26_000 + 0 + 10_000 = 36_000 > 34_000 (Single tier-2) → 'eighty-five'
    // With MFJ thresholds: 36_000 < 44_000 → would be 'fifty'
    const result = computeSsTaxation(
      {
        grossSsCents: 20_000_00,
        otherAgiCents: 26_000_00,
        taxExemptInterestCents: 0,
        filingStatus: 'HoH',
        taxYear: 2025,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.tier).toBe('eighty-five');
  });

  it('HoH tier-1 boundary matches Single ($25,000), not MFJ ($32,000)', () => {
    // PI = 23_000 + 5_000 = 28_000 > 25_000 → 'fifty' (Single threshold caught it)
    const result = computeSsTaxation(
      {
        grossSsCents: 10_000_00,
        otherAgiCents: 23_000_00,
        taxExemptInterestCents: 0,
        filingStatus: 'HoH',
        taxYear: 2025,
      },
      SS_TAX_THRESHOLDS,
    );
    expect(result.tier).toBe('fifty');
  });
});
