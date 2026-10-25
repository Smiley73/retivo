// SSA published exempt amounts (https://www.ssa.gov/oact/cola/rtea.html), lower/higher: 2024 $22,320/$59,520, 2025 $23,400/$62,160, 2026 $24,480/$65,160.
import { describe, it, expect } from 'vitest';
import {
  SSA_EARNINGS_TEST,
  resolveEarningsTestThresholds,
  computeEarningsTest,
} from './ss-earnings-test';

describe('SSA_EARNINGS_TEST snapshot', () => {
  it('carries the published 2026 lower and higher exempt amounts', () => {
    expect(SSA_EARNINGS_TEST.values[2026]).toEqual({
      lowerThreshold: 24_480,
      higherThreshold: 65_160,
    });
  });

  it('carries the published 2025 lower and higher exempt amounts', () => {
    expect(SSA_EARNINGS_TEST.values[2025]).toEqual({
      lowerThreshold: 23_400,
      higherThreshold: 62_160,
    });
  });

  it('carries the published 2024 lower and higher exempt amounts', () => {
    expect(SSA_EARNINGS_TEST.values[2024]).toEqual({
      lowerThreshold: 22_320,
      higherThreshold: 59_520,
    });
  });

  it('cites the SSA RET permalink with an as-of date', () => {
    expect(SSA_EARNINGS_TEST.metadata.source).toContain('ssa.gov/oact/cola/rtea.html');
    expect(SSA_EARNINGS_TEST.metadata.asOfDate).toBe('2026-06-05');
  });
});

describe('resolveEarningsTestThresholds', () => {
  it('returns published 2026 values without the estimated flag', () => {
    const r = resolveEarningsTestThresholds(SSA_EARNINGS_TEST, 2026, 2.5);
    expect(r).toEqual({ lowerThreshold: 24_480, higherThreshold: 65_160, estimated: false });
  });

  it('returns published 2025 values without the estimated flag', () => {
    const r = resolveEarningsTestThresholds(SSA_EARNINGS_TEST, 2025, 2.5);
    expect(r).toEqual({ lowerThreshold: 23_400, higherThreshold: 62_160, estimated: false });
  });

  it('returns published 2024 values without the estimated flag', () => {
    const r = resolveEarningsTestThresholds(SSA_EARNINGS_TEST, 2024, 2.5);
    expect(r).toEqual({ lowerThreshold: 22_320, higherThreshold: 59_520, estimated: false });
  });

  it('extrapolates future years via inflation, rounded to the nearest $10', () => {
    const r = resolveEarningsTestThresholds(SSA_EARNINGS_TEST, 2028, 3);
    // Two years past 2026 at 3%: 24,480 × 1.03² = 25,970.83 → $25,970; 65,160 × 1.03² = 69,128.24 → $69,130 (nearest-$10 rounding, 20 CFR 404.430(a)(2)).
    expect(r.estimated).toBe(true);
    expect(r.lowerThreshold).toBe(25_970);
    expect(r.higherThreshold).toBe(69_130);
    expect(r.lowerThreshold % 10).toBe(0);
    expect(r.higherThreshold % 10).toBe(0);
  });

  it('clamps years before the published range to 2024 values and flags them estimated', () => {
    const r = resolveEarningsTestThresholds(SSA_EARNINGS_TEST, 2020, 2);
    expect(r).toEqual({ lowerThreshold: 22_320, higherThreshold: 59_520, estimated: true });
  });
});

describe('computeEarningsTest', () => {
  // Born 1965 → FRA 67 → FRA year 2032. 2026 is a pre-FRA year.
  const earlyClaimer = '1965-06-15';

  it('applies $1/$2 reduction above the lower threshold in a pre-FRA year', () => {
    const r = computeEarningsTest(
      {
        year: 2026,
        isoBirthdate: earlyClaimer,
        earnedIncomeDollars: 34_480, // $10,000 over the 2026 lower threshold ($24,480)
        grossBenefitDollars: 24_000,
        inflationRatePct: 2.5,
      },
      SSA_EARNINGS_TEST,
    );
    expect(r.rateApplied).toBe('pre-fra-year');
    expect(r.withheldDollars).toBe(5_000); // $10,000 / 2
    expect(r.reducedBenefitDollars).toBe(19_000);
    expect(r.estimated).toBe(false);
  });

  it('does not reduce when earnings are below the lower threshold', () => {
    const r = computeEarningsTest(
      {
        year: 2026,
        isoBirthdate: earlyClaimer,
        earnedIncomeDollars: 10_000,
        grossBenefitDollars: 24_000,
        inflationRatePct: 2.5,
      },
      SSA_EARNINGS_TEST,
    );
    expect(r.rateApplied).toBe('none');
    expect(r.withheldDollars).toBe(0);
    expect(r.reducedBenefitDollars).toBe(24_000);
  });

  it('caps withholding at the gross benefit', () => {
    const r = computeEarningsTest(
      {
        year: 2026,
        isoBirthdate: earlyClaimer,
        earnedIncomeDollars: 222_320, // $200k over → $100k/2 = $50k withheld cap
        grossBenefitDollars: 24_000,
        inflationRatePct: 2.5,
      },
      SSA_EARNINGS_TEST,
    );
    expect(r.withheldDollars).toBe(24_000);
    expect(r.reducedBenefitDollars).toBe(0);
  });

  it('does not reduce in years strictly after the FRA year', () => {
    // Born 1958-03-10: FRA 66y8m → fraYear 2024 (Nov); 2026 is strictly after it → no reduction.
    const r = computeEarningsTest(
      {
        year: 2026,
        isoBirthdate: '1958-03-10',
        earnedIncomeDollars: 200_000,
        grossBenefitDollars: 30_000,
        inflationRatePct: 2.5,
      },
      SSA_EARNINGS_TEST,
    );
    expect(r.rateApplied).toBe('none');
    expect(r.withheldDollars).toBe(0);
  });

  it('uses the higher threshold and $1/$3 rate in the FRA year (pre-FRA-month portion)', () => {
    // Born 1959-11-15: FRA 66y10m → FRA year 2026, fraMonth0 8 (Sep); only the first 8/12 of earnings count.
    const r = computeEarningsTest(
      {
        year: 2026,
        isoBirthdate: '1959-11-15',
        earnedIncomeDollars: 120_000,
        grossBenefitDollars: 30_000,
        inflationRatePct: 2.5,
      },
      SSA_EARNINGS_TEST,
    );
    // earningsBeforeFra = 120000 × 8/12 = 80000.
    // excess = 80000 − 65160 = 14840; withheld = 14840/3 ≈ 4946.67.
    expect(r.rateApplied).toBe('fra-year');
    expect(r.estimated).toBe(false);
    expect(r.withheldDollars).toBeCloseTo((80_000 - 65_160) / 3, 2);
    expect(r.reducedBenefitDollars).toBeCloseTo(30_000 - (80_000 - 65_160) / 3, 2);
  });

  it('FRA=67 non-January birth: FRA-year withholding is not zeroed (regression for fraMonths%12===0 bug)', () => {
    // Born 1960-06-15: FRA 67 → fraYear 2027, fraMonth0 5. Regression: fraMonths % 12 === 0 once zeroed preFraMonthShare, so withholding was 0.
    const r = computeEarningsTest(
      {
        year: 2027,
        isoBirthdate: '1960-06-15',
        earnedIncomeDollars: 300_000,
        grossBenefitDollars: 36_000,
        inflationRatePct: 2.5,
      },
      SSA_EARNINGS_TEST,
    );
    // earningsBeforeFra = 300000 × 5/12 = 125000; 2027 extrapolated at 2.5% → higherThreshold ≈ $66,789, so excess >> 0.
    expect(r.rateApplied).toBe('fra-year');
    expect(r.withheldDollars).toBeGreaterThan(0);
    expect(r.estimated).toBe(true);
  });

  it('skips the test on a missing/unparseable birthdate without flagging estimated', () => {
    const r = computeEarningsTest(
      {
        year: 2026,
        isoBirthdate: 'not-a-date',
        earnedIncomeDollars: 50_000,
        grossBenefitDollars: 24_000,
        inflationRatePct: 2.5,
      },
      SSA_EARNINGS_TEST,
    );
    expect(r.rateApplied).toBe('none');
    expect(r.withheldDollars).toBe(0);
    expect(r.estimated).toBe(false);
  });
});

describe('computeEarningsTest — grace-year monthly test (20 CFR 404.435)', () => {
  const earlyClaimer = '1965-06-15';
  // 2026 lower exempt $24,480 → monthly non-service limit $2,040.

  it('pays every post-retirement non-service month in full despite high pre-claim wages (retire midyear)', () => {
    // Works Jan–Jun at $15k/mo ($90k), retires, claims in July, earns $0 after: the annual test would wipe the benefit; the monthly test pays Jul–Dec in full.
    const monthly = [15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 0, 0, 0, 0, 0, 0];
    const r = computeEarningsTest(
      {
        year: 2026,
        isoBirthdate: earlyClaimer,
        earnedIncomeDollars: 90_000,
        grossBenefitDollars: 12_000, // 6 entitled months × $2,000
        inflationRatePct: 2.5,
        monthlyEarningsDollars: monthly,
        entitlementStartMonth0: 6, // July claim
        graceYearMonthly: true, // 2026 contains non-service months
      },
      SSA_EARNINGS_TEST,
    );
    expect(r.withheldDollars).toBe(0);
    expect(r.withheldMonths).toBe(0);
    expect(r.rateApplied).toBe('none');
  });

  it('withholds exactly the service months when some entitled months exceed the monthly limit', () => {
    // Claims in July; works Jul+Aug at $5,000/mo (> $2,040) then stops: 2 checks withheld ($4,000) vs annual excess $15,520/2 = $7,760; the smaller monthly test wins.
    const monthly = [5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 0, 0, 0, 0];
    const r = computeEarningsTest(
      {
        year: 2026,
        isoBirthdate: earlyClaimer,
        earnedIncomeDollars: 40_000,
        grossBenefitDollars: 12_000, // 6 entitled months × $2,000
        inflationRatePct: 2.5,
        monthlyEarningsDollars: monthly,
        entitlementStartMonth0: 6,
        graceYearMonthly: true,
      },
      SSA_EARNINGS_TEST,
    );
    expect(r.rateApplied).toBe('grace-year-monthly');
    expect(r.withheldDollars).toBeCloseTo(4_000, 2);
    expect(r.withheldMonths).toBe(2);
    expect(r.reducedBenefitDollars).toBeCloseTo(8_000, 2);
  });

  it('treats a month exactly AT the monthly limit as a non-service month (boundary)', () => {
    // $2,040 = 24,480 / 12 exactly — at the limit is NOT over it.
    const monthly = [0, 0, 0, 0, 0, 0, 2_040, 2_040, 2_040, 2_040, 2_040, 2_040];
    const r = computeEarningsTest(
      {
        year: 2026,
        isoBirthdate: earlyClaimer,
        earnedIncomeDollars: 12_240,
        grossBenefitDollars: 12_000,
        inflationRatePct: 2.5,
        monthlyEarningsDollars: monthly,
        entitlementStartMonth0: 6,
        graceYearMonthly: true,
      },
      SSA_EARNINGS_TEST,
    );
    expect(r.withheldDollars).toBe(0);
    expect(r.withheldMonths).toBe(0);
  });

  it('an entitlement-start year that is NOT the grace year gets no monthly test', () => {
    // The caller marks the year as NOT the grace year (every entitled month was a service month, POMS RS 02501.030): the annual test runs alone and wipes the benefit.
    const monthly = [15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 0, 0, 0, 0, 0, 0];
    const r = computeEarningsTest(
      {
        year: 2026,
        isoBirthdate: earlyClaimer,
        earnedIncomeDollars: 90_000,
        grossBenefitDollars: 12_000,
        inflationRatePct: 2.5,
        monthlyEarningsDollars: monthly,
        entitlementStartMonth0: 6, // entitled from July, but grace deferred
      },
      SSA_EARNINGS_TEST,
    );
    // Annual $1/$2: excess (90,000 − 24,480)/2 = 32,760, capped at the whole $12,000 of entitled checks.
    expect(r.rateApplied).toBe('pre-fra-year');
    expect(r.withheldDollars).toBe(12_000);
    expect(r.reducedBenefitDollars).toBe(0);
  });

  it('falls back to the annual test when it is more favorable than the monthly test', () => {
    // Earns just over the monthly limit every entitled month but under the annual limit: the monthly test would withhold all 6 checks, the annual test $0, so the annual result wins.
    const monthly = [0, 0, 0, 0, 0, 0, 2_100, 2_100, 2_100, 2_100, 2_100, 2_100];
    const r = computeEarningsTest(
      {
        year: 2026,
        isoBirthdate: earlyClaimer,
        earnedIncomeDollars: 12_600, // under the $24,480 annual limit
        grossBenefitDollars: 12_000,
        inflationRatePct: 2.5,
        monthlyEarningsDollars: monthly,
        entitlementStartMonth0: 6,
        graceYearMonthly: true,
      },
      SSA_EARNINGS_TEST,
    );
    expect(r.withheldDollars).toBe(0);
    expect(r.rateApplied).toBe('none');
    expect(r.withheldMonths).toBe(0);
  });
});

describe('computeEarningsTest — FRA-year actual monthly earnings (20 CFR 404.430)', () => {
  // Born 1959-11-15: day-1-unadjusted, FRA 66y10m → FRA month Sep 2026
  // (fraMonth0 = 8). Only Jan–Aug earnings count against the higher limit.
  const fraYearBirth = '1959-11-15';

  it('counts only the dollars actually earned before the FRA month', () => {
    // $10k/mo Jan–Aug ($80,000 pre-FRA) then $50k/mo Sep–Dec (exempt). Excess 80,000 − 65,160 = 14,840 → withheld ≈ $4,946.67.
    const monthly = [
      10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000,
      50_000, 50_000, 50_000, 50_000,
    ];
    const r = computeEarningsTest(
      {
        year: 2026,
        isoBirthdate: fraYearBirth,
        earnedIncomeDollars: 280_000,
        grossBenefitDollars: 30_000,
        inflationRatePct: 2.5,
        monthlyEarningsDollars: monthly,
      },
      SSA_EARNINGS_TEST,
    );
    expect(r.rateApplied).toBe('fra-year');
    expect(r.withheldDollars).toBeCloseTo((80_000 - 65_160) / 3, 2);
  });

  it('applies no withholding when all earnings land at/after the FRA month', () => {
    const monthly = [0, 0, 0, 0, 0, 0, 0, 0, 50_000, 50_000, 50_000, 50_000];
    const r = computeEarningsTest(
      {
        year: 2026,
        isoBirthdate: fraYearBirth,
        earnedIncomeDollars: 200_000,
        grossBenefitDollars: 30_000,
        inflationRatePct: 2.5,
        monthlyEarningsDollars: monthly,
      },
      SSA_EARNINGS_TEST,
    );
    expect(r.rateApplied).toBe('none');
    expect(r.withheldDollars).toBe(0);
    expect(r.withheldMonths).toBe(0);
  });
});

describe('computeEarningsTest — withheld-month count (ARF restoration input)', () => {
  const earlyClaimer = '1965-06-15';

  it('converts annual-test withholding to whole checks, rounding up', () => {
    // $10,000 over the lower limit → $5,000 withheld; $2,000 monthly checks → 2.5 → 3 whole months.
    const r = computeEarningsTest(
      {
        year: 2026,
        isoBirthdate: earlyClaimer,
        earnedIncomeDollars: 34_480,
        grossBenefitDollars: 24_000,
        inflationRatePct: 2.5,
      },
      SSA_EARNINGS_TEST,
    );
    expect(r.withheldDollars).toBe(5_000);
    expect(r.withheldMonths).toBe(3);
  });

  it('caps the withheld-month count at 12 when the whole benefit is withheld', () => {
    const r = computeEarningsTest(
      {
        year: 2026,
        isoBirthdate: earlyClaimer,
        earnedIncomeDollars: 222_320,
        grossBenefitDollars: 24_000,
        inflationRatePct: 2.5,
      },
      SSA_EARNINGS_TEST,
    );
    expect(r.withheldDollars).toBe(24_000);
    expect(r.withheldMonths).toBe(12);
  });
});
