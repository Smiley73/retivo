import { describe, it, expect } from 'vitest';
import {
  computeAcaPtc,
  fplDollarsForRegion,
  roughMonthlyBenchmarkCentsForMember,
  roughHouseholdAnnualBenchmarkCents,
  ROUGH_BENCHMARK_ASSUMPTIONS,
  AcaPtcInvalidInputError,
  type AcaPtcInput,
} from './aca-ptc';
import { ACA_PTC_PARAMETERS } from './aca-ptc-parameters';

const snap = ACA_PTC_PARAMETERS;

function input(overrides: Partial<AcaPtcInput> = {}): AcaPtcInput {
  return {
    taxYear: 2025,
    filingStatus: 'Single',
    householdSize: 1,
    magiCents: 2_800_000, // $28,000 ≈ 186% FPL (2025 single)
    benchmarkAnnualSlcspCents: 600_000, // $6,000/yr
    ...overrides,
  };
}

describe('computeAcaPtc — FPL calculation', () => {
  it('calculates fplDollars for single (householdSize=1) 2025', () => {
    // 2025: base=15060, increment=5380 → size=1 → $15,060
    const r = computeAcaPtc(input({ taxYear: 2025, householdSize: 1, magiCents: 1_506_000 }), snap);
    expect(r.fplDollars).toBe(15_060);
    expect(r.fplPercentage).toBeCloseTo(100, 4);
  });

  it('calculates fplDollars for householdSize=4 2025', () => {
    // 2025: 15060 + 3*5380 = $31,200
    const r = computeAcaPtc(input({ taxYear: 2025, householdSize: 4, magiCents: 3_120_000 }), snap);
    expect(r.fplDollars).toBe(31_200);
    expect(r.fplPercentage).toBeCloseTo(100, 4);
  });

  it('calculates fplDollars for householdSize=2 2024', () => {
    // 2024: 14580 + 1*5140 = $19,720
    const r = computeAcaPtc(input({ taxYear: 2024, householdSize: 2, magiCents: 1_972_000 }), snap);
    expect(r.fplDollars).toBe(19_720);
  });

  it('calculates fplDollars for householdSize=1 2026', () => {
    // 2026: base=15650 → size=1 → $15,650
    const r = computeAcaPtc(input({ taxYear: 2026, householdSize: 1, magiCents: 1_565_000 }), snap);
    expect(r.fplDollars).toBe(15_650);
  });

  it('householdSize=8 extrapolates linearly', () => {
    // 2024: 14580 + 7*5140 = 14580 + 35980 = $50,560
    const r = computeAcaPtc(input({ taxYear: 2024, householdSize: 8, magiCents: 5_056_000 }), snap);
    expect(r.fplDollars).toBe(50_560);
    expect(r.fplPercentage).toBeCloseTo(100, 4);
  });

  it('householdSize=12 extrapolates linearly', () => {
    // 2024: 14580 + 11*5140 = 14580 + 56540 = $71,120
    const r = computeAcaPtc(input({ taxYear: 2024, householdSize: 12, magiCents: 7_112_000 }), snap);
    expect(r.fplDollars).toBe(71_120);
    expect(r.fplPercentage).toBeCloseTo(100, 4);
  });
});

describe('computeAcaPtc — below-FPL ineligible', () => {
  it('returns tier=below-fpl and zero PTC when MAGI < 100% FPL (2025)', () => {
    // $14,000 < $15,060 (100% FPL 2025)
    const r = computeAcaPtc(input({ taxYear: 2025, householdSize: 1, magiCents: 1_400_000 }), snap);
    expect(r.tier).toBe('below-fpl');
    expect(r.eligible).toBe(false);
    expect(r.annualPtcCents).toBe(0);
    expect(r.applicableFigurePct).toBe(0);
    expect(r.expectedContributionCents).toBe(0);
  });

  it('fplPercentage < 100 for below-FPL case', () => {
    const r = computeAcaPtc(input({ taxYear: 2025, householdSize: 1, magiCents: 1_400_000 }), snap);
    expect(r.fplPercentage).toBeLessThan(100);
  });
});

describe('computeAcaPtc — IRA-expanded sliding (2025)', () => {
  it('150-200% band: interpolates applicable figure', () => {
    // 2025 single FPL = $15,060. 175% FPL = $26,355 = $2,635,500 cents
    // Band 150-200: floor=0, ceiling=0.02 → position = (175-150)/(200-150) = 0.5
    // raw = 0 + 0.5*0.02 = 0.01 → rounded 4dp = 0.01
    const r = computeAcaPtc(
      input({ taxYear: 2025, householdSize: 1, magiCents: 2_635_500 }),
      snap,
    );
    expect(r.tier).toBe('sliding');
    expect(r.eligible).toBe(true);
    expect(r.applicableFigurePct).toBeCloseTo(0.01, 4);
    expect(r.annualPtcCents).toBeGreaterThan(0);
  });

  it('100-150% band: applicable figure = 0 (IRA-expanded floor removal)', () => {
    // 2025 single 125% FPL = 0.25 * 15060 + 15060 = $18,825 = $1,882,500
    const r = computeAcaPtc(
      input({ taxYear: 2025, householdSize: 1, magiCents: 1_882_500 }),
      snap,
    );
    expect(r.tier).toBe('sliding');
    expect(r.eligible).toBe(true);
    expect(r.applicableFigurePct).toBe(0);
    expect(r.annualPtcCents).toBe(600_000);
  });

  it('250-300% band: interpolates correctly', () => {
    // 2025 single 275% = 15060 * 2.75 = $41,415 = $4,141,500
    // Band 250-300: floor=0.04, ceiling=0.06 → position=(275-250)/50=0.5 → 0.05
    const r = computeAcaPtc(
      input({ taxYear: 2025, householdSize: 1, magiCents: 4_141_500 }),
      snap,
    );
    expect(r.tier).toBe('sliding');
    expect(r.applicableFigurePct).toBeCloseTo(0.05, 4);
  });

  it('300-400% band: interpolates correctly at midpoint', () => {
    // 2025 single 350% = 15060 * 3.5 = $52,710 = $5,271,000
    // Band 300-400: floor=0.06, ceiling=0.085 → position=(350-300)/100=0.5 → 0.0725
    const r = computeAcaPtc(
      input({ taxYear: 2025, householdSize: 1, magiCents: 5_271_000 }),
      snap,
    );
    expect(r.tier).toBe('sliding');
    expect(r.applicableFigurePct).toBeCloseTo(0.0725, 4);
  });

  it('PTC is zero when expected contribution exceeds SLCSP', () => {
    const r = computeAcaPtc(
      input({
        taxYear: 2025,
        householdSize: 1,
        magiCents: 3_700_000, // ~246% FPL
        benchmarkAnnualSlcspCents: 10_000, // tiny SLCSP
      }),
      snap,
    );
    expect(r.annualPtcCents).toBe(0);
  });

  it('PTC = max(0, ...) — never negative', () => {
    const r = computeAcaPtc(
      input({
        taxYear: 2025,
        magiCents: 5_000_000,
        benchmarkAnnualSlcspCents: 1,
      }),
      snap,
    );
    expect(r.annualPtcCents).toBeGreaterThanOrEqual(0);
  });
});

describe('computeAcaPtc — IRA-expanded cap band (≥ 400% FPL)', () => {
  it('tier=cap-applies at exactly 400% FPL (2025)', () => {
    // 400% * 15060 = $60,240 = $6,024,000
    const r = computeAcaPtc(
      input({ taxYear: 2025, householdSize: 1, magiCents: 6_024_000 }),
      snap,
    );
    expect(r.tier).toBe('cap-applies');
    expect(r.eligible).toBe(true);
    expect(r.applicableFigurePct).toBe(0.085);
  });

  it('tier=cap-applies above 400% FPL (IRA-expanded)', () => {
    // 500% FPL = $75,300 = $7,530,000
    const r = computeAcaPtc(
      input({ taxYear: 2025, householdSize: 1, magiCents: 7_530_000 }),
      snap,
    );
    expect(r.tier).toBe('cap-applies');
    expect(r.eligible).toBe(true);
    expect(r.applicableFigurePct).toBe(0.085);
    expect(r.annualPtcCents).toBeGreaterThanOrEqual(0);
  });

  it('cap-applies PTC formula is correct: max(0, SLCSP - MAGI*0.085)', () => {
    // $60,240 MAGI, $6,000 SLCSP/yr → contribution = round(6024000 * 0.085) = 512040
    // PTC = max(0, 600000 - 512040) = 87960
    const r = computeAcaPtc(
      input({ taxYear: 2025, householdSize: 1, magiCents: 6_024_000, benchmarkAnnualSlcspCents: 600_000 }),
      snap,
    );
    expect(r.expectedContributionCents).toBe(Math.round(6_024_000 * 0.085));
    expect(r.annualPtcCents).toBe(Math.max(0, 600_000 - Math.round(6_024_000 * 0.085)));
  });

  it('same regime used for 2024 (IRA-expanded)', () => {
    const r = computeAcaPtc(
      input({ taxYear: 2024, householdSize: 1, magiCents: 7_000_000 }),
      snap,
    );
    expect(r.tier).toBe('cap-applies');
    expect(r.eligible).toBe(true);
  });
});

describe('computeAcaPtc — pre-ARPA 400% cliff (2026)', () => {
  it('tier=above-400-cliff for MAGI strictly above 400% FPL (2026)', () => {
    // 2026 single FPL = $15,650. 401% = $62,757 ≈ $6,275,700
    const r = computeAcaPtc(
      input({ taxYear: 2026, householdSize: 1, magiCents: 6_275_700 }),
      snap,
    );
    expect(r.tier).toBe('above-400-cliff');
    expect(r.eligible).toBe(false);
    expect(r.annualPtcCents).toBe(0);
    expect(r.applicableFigurePct).toBe(0);
  });

  it('exactly 400% FPL is eligible under pre-ARPA (sliding tier, 300-400 ceiling)', () => {
    // 400% * 15650 = $62,600 = $6,260,000
    const r = computeAcaPtc(
      input({ taxYear: 2026, householdSize: 1, magiCents: 6_260_000 }),
      snap,
    );
    expect(r.tier).toBe('sliding');
    expect(r.eligible).toBe(true);
    // At 400%, position in 300-400 band = (400-300)/100 = 1.0 → ceiling = 0.0996
    expect(r.applicableFigurePct).toBe(0.0996);
  });

  it('no above-400-cliff for IRA-expanded 2025 at same FPL%', () => {
    const r = computeAcaPtc(
      input({ taxYear: 2025, householdSize: 1, magiCents: 6_200_000 }),
      snap,
    );
    expect(r.tier).not.toBe('above-400-cliff');
  });
});

describe('computeAcaPtc — pre-ARPA sliding (2026)', () => {
  it('100-133% band: flat 2.10% applicable figure', () => {
    // 2026 single 116.5% FPL = 15650 * 1.165 = $18,232 ≈ $1,823,225
    const r = computeAcaPtc(
      input({ taxYear: 2026, householdSize: 1, magiCents: 1_823_225 }),
      snap,
    );
    expect(r.tier).toBe('sliding');
    expect(r.applicableFigurePct).toBe(0.0210);
  });

  it('133-150% band: interpolates (corrected values from Rev Proc 2025-25)', () => {
    // 2026 single 141.5% FPL = 15650 * 1.415 = $22,144.75 = $2,214,475
    // Band 133-150: floor=0.0314, ceiling=0.0419 → position=(141.5-133)/(150-133)=8.5/17≈0.5
    // raw = 0.0314 + 0.5*(0.0419-0.0314) = 0.0314 + 0.00525 = 0.03665 → 0.0367 rounded 4dp
    const r = computeAcaPtc(
      input({ taxYear: 2026, householdSize: 1, magiCents: 2_214_475 }),
      snap,
    );
    expect(r.tier).toBe('sliding');
    expect(r.applicableFigurePct).toBeCloseTo(0.0367, 3);
  });

  it('300-400% band ceiling = 0.0996 (flat band)', () => {
    // 400% * 15650 = $62,600 = $6,260,000 → ceiling pin
    const r = computeAcaPtc(
      input({ taxYear: 2026, householdSize: 1, magiCents: 6_260_000 }),
      snap,
    );
    expect(r.applicableFigurePct).toBe(0.0996);
  });

  it('below-FPL still ineligible in 2026', () => {
    const r = computeAcaPtc(
      input({ taxYear: 2026, householdSize: 1, magiCents: 1_000_000 }),
      snap,
    );
    expect(r.tier).toBe('below-fpl');
    expect(r.annualPtcCents).toBe(0);
  });
});

describe('computeAcaPtc — whole-percent cliff truncation', () => {
  // 2026 single FPL = $15,650. 400.9% = 15650 * 4.009 = $62,740.85 → 6,274,085 cents.
  const magi400_9 = 6_274_085;

  it('pre-ARPA: raw 400.9% floors to 400 → NOT above the cliff → subsidy-eligible', () => {
    const r = computeAcaPtc(
      input({ taxYear: 2026, householdSize: 1, magiCents: magi400_9 }),
      snap,
    );
    expect(r.tier).toBe('sliding');
    expect(r.eligible).toBe(true);
    expect(r.fplPercentage).toBeCloseTo(400.9, 4);
  });

  it('ARPA: 400.9% input is unaffected by the cliff floor (IRA-expanded has no cliff)', () => {
    // 400.9% = 15060 * 4.009 = $60,375.54 → 6,037,554 cents.
    const magi2025_400_9 = 6_037_554;
    const r = computeAcaPtc(
      input({ taxYear: 2025, householdSize: 1, magiCents: magi2025_400_9 }),
      snap,
    );
    expect(r.tier).toBe('cap-applies');
    expect(r.fplPercentage).toBeCloseTo(400.9, 4);
    const r2 = computeAcaPtc(
      input({ taxYear: 2025, householdSize: 1, magiCents: magi2025_400_9 }),
      snap,
    );
    expect(r2).toEqual(r);
  });
});

describe('computeAcaPtc — expectedContribution re-inflation', () => {
  it('scales expectedContributionCents by expectedContributionScalingFactor; benchmark NOT scaled', () => {
    const base = computeAcaPtc(
      input({ taxYear: 2025, householdSize: 1, magiCents: 3_000_000 }),
      snap,
    );
    const scaled = computeAcaPtc(
      input({
        taxYear: 2025,
        householdSize: 1,
        magiCents: 3_000_000,
        expectedContributionScalingFactor: 1.344,
      }),
      snap,
    );
    expect(scaled.expectedContributionCents).toBe(
      Math.round(base.expectedContributionCents * 1.344),
    );
    expect(scaled.applicableFigurePct).toBe(base.applicableFigurePct);
    expect(scaled.fplPercentage).toBe(base.fplPercentage);
    expect(scaled.annualPtcCents).toBe(
      Math.max(0, 600_000 - scaled.expectedContributionCents),
    );
  });

  it('absent / ≤0 scaling factor → no scaling (1.0)', () => {
    const base = computeAcaPtc(
      input({ taxYear: 2025, householdSize: 1, magiCents: 3_000_000 }),
      snap,
    );
    const zero = computeAcaPtc(
      input({
        taxYear: 2025,
        householdSize: 1,
        magiCents: 3_000_000,
        expectedContributionScalingFactor: 0,
      }),
      snap,
    );
    expect(zero.expectedContributionCents).toBe(base.expectedContributionCents);
  });
});

describe('computeAcaPtc — interpolation rounding', () => {
  it('applicable figure is rounded to 4 decimal places', () => {
    const r = computeAcaPtc(input({ taxYear: 2025, householdSize: 1, magiCents: 2_800_000 }), snap);
    const str = r.applicableFigurePct.toString();
    const decimalPlaces = str.includes('.') ? str.split('.')[1].length : 0;
    expect(decimalPlaces).toBeLessThanOrEqual(4);
  });

  it('exactly at band boundary: uses boundary value without interpolation artifacts', () => {
    // 2025 single 200% FPL = $30,120 = $3,012,000 → band 200-250, floor=0.02
    const r = computeAcaPtc(
      input({ taxYear: 2025, householdSize: 1, magiCents: 3_012_000 }),
      snap,
    );
    // At 200% exactly: position in 200-250 = 0 → result = 0.02
    expect(r.applicableFigurePct).toBe(0.02);
  });
});

describe('computeAcaPtc — expectedContributionCents', () => {
  it('is integer (Math.round applied)', () => {
    const r = computeAcaPtc(input({ taxYear: 2025, magiCents: 3_333_333 }), snap);
    expect(Number.isInteger(r.expectedContributionCents)).toBe(true);
  });

  it('annualPtcCents is integer', () => {
    const r = computeAcaPtc(input({ taxYear: 2025, magiCents: 3_333_333 }), snap);
    expect(Number.isInteger(r.annualPtcCents)).toBe(true);
  });
});

describe('computeAcaPtc — zero MAGI', () => {
  it('zero MAGI → tier=below-fpl, zero PTC', () => {
    const r = computeAcaPtc(input({ magiCents: 0 }), snap);
    expect(r.tier).toBe('below-fpl');
    expect(r.eligible).toBe(false);
    expect(r.annualPtcCents).toBe(0);
    expect(r.fplPercentage).toBe(0);
  });
});

describe('computeAcaPtc — zero SLCSP', () => {
  it('zero SLCSP → zero PTC even when eligible', () => {
    const r = computeAcaPtc(
      input({ magiCents: 2_000_000, benchmarkAnnualSlcspCents: 0 }),
      snap,
    );
    expect(r.annualPtcCents).toBe(0);
  });
});

describe('computeAcaPtc — reference calculation', () => {
  it('2025, single, $28,000 MAGI, $6,000 SLCSP annual → correct PTC', () => {
    // 2025 FPL single = $15,060
    // fplPercentage = 28000/15060 * 100 ≈ 185.92%
    // Band 150-200: floor=0, ceiling=0.02
    // position = (185.92-150)/(200-150) = 35.92/50 = 0.7184
    // applicableFigurePct = round(0 + 0.7184*0.02, 4dp) = round(0.014368, 4dp) = 0.0144
    // expectedContribution = round(2800000 * 0.0144) = 40320
    // annualPtc = max(0, 600000 - 40320) = 559680
    const r = computeAcaPtc(
      input({ taxYear: 2025, householdSize: 1, magiCents: 2_800_000, benchmarkAnnualSlcspCents: 600_000 }),
      snap,
    );
    expect(r.fplDollars).toBe(15_060);
    expect(r.fplPercentage).toBeCloseTo(185.92, 1);
    expect(r.tier).toBe('sliding');
    expect(r.eligible).toBe(true);
    expect(r.applicableFigurePct).toBeCloseTo(0.0144, 4);
    expect(r.expectedContributionCents).toBe(Math.round(2_800_000 * r.applicableFigurePct));
    expect(r.annualPtcCents).toBe(Math.max(0, 600_000 - r.expectedContributionCents));
  });
});

const fpl2026 = ACA_PTC_PARAMETERS.values[2026]!.fpl;

describe('fplDollarsForRegion', () => {
  it('contiguous uses the base/increment 48-state schedule', () => {
    // 2026 contiguous: base 15,650 + increment 5,500
    expect(fplDollarsForRegion(fpl2026, 1, 'contiguous')).toBe(15_650);
    expect(fplDollarsForRegion(fpl2026, 2, 'contiguous')).toBe(15_650 + 5_500);
  });

  it('alaska uses the higher Alaska schedule', () => {
    // 2026 Alaska: base 19,550 + increment 6,880
    expect(fplDollarsForRegion(fpl2026, 1, 'alaska')).toBe(19_550);
    expect(fplDollarsForRegion(fpl2026, 2, 'alaska')).toBe(19_550 + 6_880);
  });

  it('hawaii uses the Hawaii schedule (between contiguous and Alaska)', () => {
    // 2026 Hawaii: base 17,990 + increment 6,330
    expect(fplDollarsForRegion(fpl2026, 1, 'hawaii')).toBe(17_990);
    expect(fplDollarsForRegion(fpl2026, 3, 'hawaii')).toBe(17_990 + 2 * 6_330);
  });

  it('falls back to contiguous when a region schedule is absent', () => {
    const contiguousOnly = { base: 15_650, increment: 5_500 };
    expect(fplDollarsForRegion(contiguousOnly, 2, 'alaska')).toBe(15_650 + 5_500);
    expect(fplDollarsForRegion(contiguousOnly, 2, 'hawaii')).toBe(15_650 + 5_500);
  });

  it.each([0, 2.5])('throws for household size %d', (size) => {
    expect(() => fplDollarsForRegion(fpl2026, size, 'contiguous')).toThrow(AcaPtcInvalidInputError);
  });

});

describe('roughMonthlyBenchmarkCentsForMember', () => {
  it('base age → base monthly premium in cents', () => {
    // $700/mo at age 60 → 70,000 cents
    expect(roughMonthlyBenchmarkCentsForMember(60)).toBe(70_000);
  });

  it('grows 5% per year of age above the base age', () => {
    // $700 × 1.05^5 = $893.397… → 89,340 cents
    expect(roughMonthlyBenchmarkCentsForMember(65)).toBe(
      Math.round(700 * Math.pow(1.05, 5) * 100),
    );
  });

  it('exposes its assumptions for disclosure', () => {
    expect(ROUGH_BENCHMARK_ASSUMPTIONS.baseMonthlyDollars).toBe(700);
    expect(ROUGH_BENCHMARK_ASSUMPTIONS.baseAge).toBe(60);
    expect(ROUGH_BENCHMARK_ASSUMPTIONS.ageGrowthRate).toBe(0.05);
    expect(ROUGH_BENCHMARK_ASSUMPTIONS.baseYear).toBe(2026);
    expect(ROUGH_BENCHMARK_ASSUMPTIONS.disclosure).toMatch(/not an exchange/i);
    expect(ROUGH_BENCHMARK_ASSUMPTIONS.disclosure).toMatch(/medical inflation rate/i);
  });

  it.each([NaN, Infinity, -5, 60.5, 1_000])('throws for the off-curve or overflowing age %d', (age) => {
    expect(() => roughMonthlyBenchmarkCentsForMember(age)).toThrow(AcaPtcInvalidInputError);
  });

});

describe('roughHouseholdAnnualBenchmarkCents', () => {
  it('single covered member, whole year → monthly × 12', () => {
    expect(roughHouseholdAnnualBenchmarkCents([{ age: 60, marketplaceMonths: 12 }])).toBe(
      70_000 * 12,
    );
  });

  it('sums per member (NOT oldest premium × covered count)', () => {
    const members = [
      { age: 60, marketplaceMonths: 12 },
      { age: 65, marketplaceMonths: 12 },
    ];
    const perMemberSum =
      roughMonthlyBenchmarkCentsForMember(60) * 12 + roughMonthlyBenchmarkCentsForMember(65) * 12;
    expect(roughHouseholdAnnualBenchmarkCents(members)).toBe(perMemberSum);
    const oldestTimesCount = roughMonthlyBenchmarkCentsForMember(65) * 12 * 2;
    expect(roughHouseholdAnnualBenchmarkCents(members)).toBeLessThan(oldestTimesCount);
  });

  it('prorates a partial coverage year by covered months', () => {
    expect(roughHouseholdAnnualBenchmarkCents([{ age: 60, marketplaceMonths: 6 }])).toBe(
      70_000 * 6,
    );
  });

  it('a member with 0 marketplace months contributes nothing', () => {
    const members = [
      { age: 60, marketplaceMonths: 12 },
      { age: 62, marketplaceMonths: 0 },
    ];
    expect(roughHouseholdAnnualBenchmarkCents(members)).toBe(70_000 * 12);
  });

  it('an annual override is used verbatim and bypasses the age/month fallback', () => {
    const members = [{ age: 60, marketplaceMonths: 12 }];
    expect(roughHouseholdAnnualBenchmarkCents(members, 6_000)).toBe(600_000);
  });

  it('empty covered set → 0', () => {
    expect(roughHouseholdAnnualBenchmarkCents([])).toBe(0);
  });

  it.each([99, -3, 6.5, NaN])('throws for the month count %d (no silent clamp)', (marketplaceMonths) => {
    expect(() => roughHouseholdAnnualBenchmarkCents([{ age: 60, marketplaceMonths }])).toThrow(
      AcaPtcInvalidInputError,
    );
  });

  it.each([Infinity, -5, 60.5])('throws for the member age %d', (age) => {
    expect(() => roughHouseholdAnnualBenchmarkCents([{ age, marketplaceMonths: 12 }])).toThrow(
      AcaPtcInvalidInputError,
    );
  });

  it('throws for a zero-month member with an invalid age', () => {
    expect(() =>
      roughHouseholdAnnualBenchmarkCents([
        { age: 60, marketplaceMonths: 12 },
        { age: -1, marketplaceMonths: 0 },
      ]),
    ).toThrow(AcaPtcInvalidInputError);
    expect(() =>
      roughHouseholdAnnualBenchmarkCents([{ age: 60.5, marketplaceMonths: 0 }]),
    ).toThrow(AcaPtcInvalidInputError);
  });

  it.each([Number.MAX_SAFE_INTEGER, -100, NaN])('throws for the annual override %d', (override) => {
    const members = [{ age: 60, marketplaceMonths: 12 }];
    expect(() => roughHouseholdAnnualBenchmarkCents(members, override)).toThrow(AcaPtcInvalidInputError);
  });

});

describe('computeAcaPtc — FPL region', () => {
  it('an absent region prices the contiguous 48-state poverty line (unchanged)', () => {
    const absent = computeAcaPtc(input({ taxYear: 2026, householdSize: 2 }), snap);
    const explicit = computeAcaPtc(
      input({ taxYear: 2026, householdSize: 2, fplRegion: 'contiguous' }),
      snap,
    );
    expect(absent).toEqual(explicit);
  });

  it('Alaska and Hawaii use their own HHS schedules', () => {
    // 2026 table: contiguous 15,650 / +5,500; alaska 19,550 / +6,880;
    // hawaii 17,990 / +6,330 (household size 2 → base + 1 × increment).
    const alaska = computeAcaPtc(
      input({ taxYear: 2026, householdSize: 2, fplRegion: 'alaska' }),
      snap,
    );
    const hawaii = computeAcaPtc(
      input({ taxYear: 2026, householdSize: 2, fplRegion: 'hawaii' }),
      snap,
    );
    const contiguous = computeAcaPtc(input({ taxYear: 2026, householdSize: 2 }), snap);
    expect(alaska.fplDollars).toBe(19_550 + 6_880);
    expect(hawaii.fplDollars).toBe(17_990 + 6_330);
    expect(contiguous.fplDollars).toBeLessThan(hawaii.fplDollars);
    expect(hawaii.fplDollars).toBeLessThan(alaska.fplDollars);
  });

});

describe('computeAcaPtc — coverage-month proration', () => {
  const partYear = (coverageMonths: number) =>
    computeAcaPtc(
      input({
        taxYear: 2026,
        householdSize: 1,
        magiCents: 5_000_000,
        benchmarkAnnualSlcspCents:
          roughMonthlyBenchmarkCentsForMember(62) * coverageMonths,
        coverageMonths,
      }),
      snap,
    );

  it('credits 7 covered months as 7 × (monthly benchmark − monthly contribution)', () => {
    const r = partYear(7);
    const monthlyBenchmarkCents = roughMonthlyBenchmarkCentsForMember(62); // $771.75
    const monthlyContributionCents = Math.round(
      (5_000_000 * r.applicableFigurePct) / 12,
    ); // $415.00
    expect(monthlyBenchmarkCents).toBe(77_175);
    expect(monthlyContributionCents).toBe(41_500);
    expect(r.annualPtcCents).toBe(
      7 * monthlyBenchmarkCents - Math.round((5_000_000 * r.applicableFigurePct * 7) / 12),
    );
    expect(r.annualPtcCents).toBe(249_725);
    expect(r.coverageMonths).toBe(7);
  });

  it('credits 1 covered month as one monthly credit', () => {
    const r = partYear(1);
    expect(r.annualPtcCents).toBe(77_175 - 41_500);
  });

  it('credits 6 covered months as six monthly credits', () => {
    const r = partYear(6);
    expect(r.annualPtcCents).toBe(6 * 77_175 - Math.round((5_000_000 * r.applicableFigurePct * 6) / 12));
  });

  it('scales linearly in the covered months (1 : 6 : 7)', () => {
    const one = partYear(1).annualPtcCents;
    expect(partYear(6).annualPtcCents).toBeCloseTo(6 * one, -1);
    expect(partYear(7).annualPtcCents).toBeCloseTo(7 * one, -1);
  });

  it('an absent coverageMonths reproduces the full-year annual formula exactly', () => {
    const base = input({
      taxYear: 2026,
      householdSize: 1,
      magiCents: 5_000_000,
      benchmarkAnnualSlcspCents: roughMonthlyBenchmarkCentsForMember(62) * 12,
    });
    const implicit = computeAcaPtc(base, snap);
    const explicit = computeAcaPtc({ ...base, coverageMonths: 12 }, snap);
    expect(explicit.annualPtcCents).toBe(implicit.annualPtcCents);
    expect(implicit.expectedContributionCents).toBe(
      Math.round(5_000_000 * implicit.applicableFigurePct),
    );
    expect(implicit.coverageMonths).toBe(12);
  });

  it('rejects a coverage-month count outside the statutory 0..12 range', () => {
    expect(() => computeAcaPtc(input({ coverageMonths: 13 }), snap)).toThrow(
      AcaPtcInvalidInputError,
    );
    expect(() => computeAcaPtc(input({ coverageMonths: -1 }), snap)).toThrow(
      AcaPtcInvalidInputError,
    );
    expect(() => computeAcaPtc(input({ coverageMonths: 6.5 }), snap)).toThrow(
      AcaPtcInvalidInputError,
    );
  });
});
