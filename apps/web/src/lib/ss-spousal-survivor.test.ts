import { describe, expect, it } from 'vitest';
import {
  deemedFilingEligible,
  survivorBenefitAnnual,
  applyAnnualSurvivorBranches,
  SPOUSAL_PIA_FRACTION,
  type SurvivorMember,
  type DeceasedMember,
} from './ss-spousal-survivor';
import { survivorEarlyFactor } from './ssa-formulas';
import { projectSsByYear, type SsContext } from './ss-projection';
import type {
  HouseholdMemberPayload,
  RetirementAgePerMember,
} from '../db/types';

const ssMember = (
  overrides: Partial<HouseholdMemberPayload> & { birthdate: string },
): HouseholdMemberPayload => ({
  firstName: 'Test',
  lastName: 'Member',
  email: 'test@example.com',
  isPrimary: true,
  ...overrides,
});

const claimAge = (years: number, months = 0): RetirementAgePerMember => ({
  ageYears: years,
  ageMonths: months,
});

describe('deemedFilingEligible', () => {
  it('year-mode: current = claim year → true when worker has claimed', () => {
    expect(deemedFilingEligible(true, 2030, 2030)).toBe(true);
  });

  it('year-mode: current before claim year → false even if worker claimed', () => {
    expect(deemedFilingEligible(true, 2029, 2030)).toBe(false);
  });

  it('worker has not claimed → false regardless of recipient position', () => {
    expect(deemedFilingEligible(false, 2031, 2030)).toBe(false);
    expect(deemedFilingEligible(false, 2030, 2030)).toBe(false);
  });

  it('month-mode: month-idx June 2030 vs claim Oct 2030 → false before, true at', () => {
    // Month-index = year * 12 + month0. June=5, Oct=9.
    const claimIdx = 2030 * 12 + 9; // October 2030
    expect(deemedFilingEligible(true, 2030 * 12 + 8, claimIdx)).toBe(false);
    expect(deemedFilingEligible(true, claimIdx, claimIdx)).toBe(true);
    expect(deemedFilingEligible(true, 2030 * 12 + 10, claimIdx)).toBe(true);
  });

  it('both gates met → true', () => {
    expect(deemedFilingEligible(true, 2035, 2030)).toBe(true);
  });
});

describe('spousal fraction constant', () => {
  it('pins the statutory 50% spousal PIA fraction', () => {
    expect(SPOUSAL_PIA_FRACTION).toBe(0.5);
  });
});

describe('survivorBenefitAnnual — deceased component', () => {
  // Base survivor: claims at survivor FRA (67), so the early factor is 1.0; claim month Jan 2048.
  const survivor: SurvivorMember = {
    survivorFraMonths: 67 * 12,
    survivorClaimAgeMonths: 67 * 12,
    survivorClaimMonthIdx: 2048 * 12,
  };

  // Base deceased: PIA $2,500 (pre-reduced by the caller), claimed at FRA, death boundary age 73 (Dec 31 2047).
  const deceased: DeceasedMember = {
    pia: 2_500,
    fraMonths: 67 * 12,
    scenarioClaimAgeMonths: 67 * 12,
    deathAgeMonths: 73 * 12,
    deathYear: 2047,
    colaAnchorYear: 2030,
  };

  it('withholds (returns null) when no survivor claim age is on file', () => {
    const withheld: SurvivorMember = {
      ...survivor,
      survivorClaimAgeMonths: null,
      survivorClaimMonthIdx: null,
    };
    expect(survivorBenefitAnnual(withheld, deceased, 2050, 0)).toBeNull();
  });

  it('returns 0 before the survivor claim year', () => {
    const lateClaim: SurvivorMember = {
      ...survivor,
      survivorClaimMonthIdx: 2052 * 12,
    };
    expect(survivorBenefitAnnual(lateClaim, deceased, 2050, 0)).toBe(0);
  });

  it('returns 0 through the death year (deceased alive through Dec 31)', () => {
    // deathYear=2047 → first payable year is 2048; 2040 and 2047 both 0.
    expect(survivorBenefitAnnual(survivor, deceased, 2040, 0)).toBe(0);
    expect(survivorBenefitAnnual(survivor, deceased, 2047, 0)).toBe(0);
  });

  it('pays the full PIA-based component from deathYear+1 for an at-FRA deceased claim', () => {
    const result = survivorBenefitAnnual(survivor, deceased, 2048, 0);
    expect(result).toBeCloseTo(2_500 * 12, 0);
  });

  it('death-pre-deceased-claim: no posthumous DRCs — base stays at the PIA', () => {
    // Dies at boundary age 66 before ever claiming: the widow base is the full PIA, with no early reduction and no posthumous DRCs.
    const earlyDeathDeceased: DeceasedMember = {
      pia: 2_500,
      fraMonths: 67 * 12,
      scenarioClaimAgeMonths: 70 * 12,
      deathAgeMonths: 66 * 12,
      deathYear: 2030,
      colaAnchorYear: 2030,
    };
    const sv: SurvivorMember = {
      ...survivor,
      survivorClaimMonthIdx: 2028 * 12,
    };
    const result = survivorBenefitAnnual(sv, earlyDeathDeceased, 2031, 0);
    expect(result).toBeCloseTo(2_500 * 12, 0);
    expect(result!).toBeLessThan(2_500 * 12 * 1.24); // strictly < at-70 amount
  });

  it('widow inherits DRCs the deceased actually earned (claimed after FRA)', () => {
    const drcDeceased: DeceasedMember = {
      ...deceased,
      scenarioClaimAgeMonths: 70 * 12,
    };
    const result = survivorBenefitAnnual(survivor, drcDeceased, 2048, 0);
    expect(result).toBeCloseTo(2_500 * 1.24 * 12, 0);
  });

  it('two-year COLA accumulation from the deceased anchor: (1+cola)^2', () => {
    const colaPct = 3;
    const year0 = survivorBenefitAnnual(survivor, deceased, 2048, colaPct);
    const year2 = survivorBenefitAnnual(survivor, deceased, 2050, colaPct);
    expect(year0).not.toBeNull();
    expect(year2).toBeCloseTo((year0 as number) * Math.pow(1.03, 2), 0);
  });

  it('pre-reduced deceased pia scales the component linearly (reductionFactor semantics)', () => {
    const rf = 0.75;
    const reducedDeceased: DeceasedMember = { ...deceased, pia: deceased.pia * rf };
    const full = survivorBenefitAnnual(survivor, deceased, 2048, 0);
    const reduced = survivorBenefitAnnual(survivor, reducedDeceased, 2048, 0);
    expect(reduced).toBeCloseTo((full as number) * rf, 2);
  });
});

// factor(a) = 1 − 0.285 × (FRA − a) / (FRA − 60), 60 ≤ a ≤ FRA.
describe('survivorEarlyFactor', () => {
  const FRA = 67 * 12; // 804 months
  it('is 0.715 at survivor age 60 (28.5% max reduction)', () => {
    expect(survivorEarlyFactor(60 * 12, FRA)).toBeCloseTo(0.715, 6);
  });

  it('is 1.0 at survivor FRA', () => {
    expect(survivorEarlyFactor(FRA, FRA)).toBe(1);
  });

  it('is 1.0 at or after survivor FRA (no survivor DRCs)', () => {
    expect(survivorEarlyFactor(70 * 12, FRA)).toBe(1);
  });

  it('is linear at an intermediate age (exact factor)', () => {
    // Age 63.5 = 762 months. monthsEarly = 804 − 762 = 42. span = 84.
    // factor = 1 − 0.285 × 42/84 = 1 − 0.1425 = 0.8575.
    expect(survivorEarlyFactor(63 * 12 + 6, FRA)).toBeCloseTo(0.8575, 6);
  });

  it('clamps below age 60 to the age-60 factor', () => {
    expect(survivorEarlyFactor(59 * 12, FRA)).toBeCloseTo(0.715, 6);
  });
});

describe('survivorBenefitAnnual — early claim at the SEPARATE survivor age', () => {
  // Survivor claim at 62 (744 months), FRA 804: factor 1 − 0.285 × 60/84. POMS RS 00615.301: the reduction AMOUNT ($508.9286) rounds UP to the next dime ($509.00), so the widow gets $1,991.00/mo, not the raw $1,991.07.
  it('applies the dime-rounded survivor early reduction once to the deceased component', () => {
    const survivorM1: SurvivorMember = {
      survivorFraMonths: 67 * 12,
      survivorClaimAgeMonths: 62 * 12,
      survivorClaimMonthIdx: 2043 * 12,
    };
    const earlyDeceased: DeceasedMember = {
      pia: 2_500,
      fraMonths: 67 * 12,
      scenarioClaimAgeMonths: 67 * 12,
      deathAgeMonths: 73 * 12,
      deathYear: 2040,
      colaAnchorYear: 2025,
    };
    const rawReduction = 2_500 * (0.285 * (60 / 84)); // $508.9286
    const dimeReduction = Math.ceil(rawReduction * 10) / 10; // $509.00
    const expected = (2_500 - dimeReduction) * 12; // $23,892 (COLA 0)
    const result = survivorBenefitAnnual(survivorM1, earlyDeceased, 2043, 0);
    expect(result).toBeCloseTo(expected, 2);
    expect(result!).toBeLessThan(2_500 * 12);
    expect(result!).toBeGreaterThan(2_500 * 12 * 0.7);
  });

  it('death after the chosen claim age pushes the start later and shrinks the reduction', () => {
    // Chose 62 (Jan 2043) but death on Dec 31 2047 forces a Jan 2048 start: effective age 804 = FRA, factor 1.0.
    const survivorForced: SurvivorMember = {
      survivorFraMonths: 67 * 12,
      survivorClaimAgeMonths: 62 * 12,
      survivorClaimMonthIdx: 2043 * 12,
    };
    const deceasedLate: DeceasedMember = {
      pia: 2_500,
      fraMonths: 67 * 12,
      scenarioClaimAgeMonths: 67 * 12,
      deathAgeMonths: 73 * 12,
      deathYear: 2047,
      colaAnchorYear: 2025,
    };
    const result = survivorBenefitAnnual(survivorForced, deceasedLate, 2048, 0);
    expect(result).toBeCloseTo(2_500 * 12, 0); // factor 1.0 at the forced start
  });
});

// POMS RS 00615.301: the reduction amount rounds UP to the next $0.10; an exact-dime reduction must not ratchet.
describe('survivorBenefitAnnual — dime rounding of the reduction amount', () => {
  const deceasedAtFra: DeceasedMember = {
    pia: 1_000,
    fraMonths: 67 * 12,
    scenarioClaimAgeMonths: 67 * 12,
    deathAgeMonths: 73 * 12,
    deathYear: 2044,
    colaAnchorYear: 2030,
  };

  it('rounds a mid-dime reduction UP (widow at 64: $122.1428 → $122.20)', () => {
    // Reduction $1,000 × 0.1221428… = $122.1428 → next dime $122.20 → $877.80/mo.
    const survivorAt64: SurvivorMember = {
      survivorFraMonths: 67 * 12,
      survivorClaimAgeMonths: 64 * 12,
      survivorClaimMonthIdx: 2045 * 12,
    };
    const result = survivorBenefitAnnual(survivorAt64, deceasedAtFra, 2045, 0);
    expect(result).toBeCloseTo(877.8 * 12, 6);
    expect(result).not.toBeCloseTo(1_000 * (1 - 0.285 * (36 / 84)) * 12, 2);
  });

  it('keeps an exact-dime reduction unchanged (widow at 60: $285.00 stays)', () => {
    const survivorAt60: SurvivorMember = {
      survivorFraMonths: 67 * 12,
      survivorClaimAgeMonths: 60 * 12,
      survivorClaimMonthIdx: 2041 * 12,
    };
    const earlierDeath: DeceasedMember = { ...deceasedAtFra, deathYear: 2040 };
    const result = survivorBenefitAnnual(survivorAt60, earlierDeath, 2041, 0);
    expect(result).toBeCloseTo(715 * 12, 6); // 1,000 − 285.00, no ratchet
  });
});

describe('survivorBenefitAnnual — RIB-LIM widow(er) cap (POMS RS 00615.320)', () => {
  // Deceased PIA $1,000 (pre-reduced), FRA 67, claimed at 62 (reduced RIB $700), died at boundary age 73.
  const earlyClaimDeceased: DeceasedMember = {
    pia: 1_000,
    fraMonths: 67 * 12,
    scenarioClaimAgeMonths: 62 * 12,
    deathAgeMonths: 73 * 12,
    deathYear: 2047,
    colaAnchorYear: 2030,
  };
  const survivorAtFra: SurvivorMember = {
    survivorFraMonths: 67 * 12,
    survivorClaimAgeMonths: 67 * 12,
    survivorClaimMonthIdx: 2048 * 12,
  };

  it('caps a widow claiming at FRA to 82.5% of the PIA (the RIB-LIM floor wins)', () => {
    // RIB-LIM cap = max($700 reduced RIB, 82.5% × $1,000 = $825) = $825.
    const result = survivorBenefitAnnual(survivorAtFra, earlyClaimDeceased, 2048, 0);
    expect(result).toBeCloseTo(825 * 12, 0);
  });

  it('does not bind when the widow early reduction already lands below the cap', () => {
    const survivorAt60: SurvivorMember = {
      survivorFraMonths: 67 * 12,
      survivorClaimAgeMonths: 60 * 12,
      survivorClaimMonthIdx: 2041 * 12, // death 2040 → chosen age governs
    };
    const earlyDeath: DeceasedMember = { ...earlyClaimDeceased, deathYear: 2040 };
    const result = survivorBenefitAnnual(survivorAt60, earlyDeath, 2041, 0);
    expect(result).toBeCloseTo(715 * 12, 0);
  });

  it('binds between the boundaries (widow at 64 → 877.80 capped to 825)', () => {
    const survivorAt64: SurvivorMember = {
      survivorFraMonths: 67 * 12,
      survivorClaimAgeMonths: 64 * 12,
      survivorClaimMonthIdx: 2045 * 12,
    };
    const earlyDeath: DeceasedMember = { ...earlyClaimDeceased, deathYear: 2044 };
    const result = survivorBenefitAnnual(survivorAt64, earlyDeath, 2045, 0);
    expect(result).toBeCloseTo(825 * 12, 0);
  });

  it('no RIB-LIM when the deceased never claimed before death', () => {
    const neverClaimed: DeceasedMember = {
      ...earlyClaimDeceased,
      deathAgeMonths: 61 * 12,
      deathYear: 2036,
    };
    const sv: SurvivorMember = {
      survivorFraMonths: 67 * 12,
      survivorClaimAgeMonths: 67 * 12,
      survivorClaimMonthIdx: 2037 * 12,
    };
    const result = survivorBenefitAnnual(sv, neverClaimed, 2037, 0);
    expect(result).toBeCloseTo(1_000 * 12, 0);
  });

  // POMS RS 00615.320: RIB-LIM needs reduced-RIB entitlement before death; deathAgeMonths is the exclusive Jan-1 boundary, so a claim equal to it was never entitled.
  it('a claim landing exactly on the exclusive death boundary never triggers RIB-LIM', () => {
    const claimAtBoundary: DeceasedMember = {
      ...earlyClaimDeceased,
      scenarioClaimAgeMonths: 62 * 12,
      deathAgeMonths: 62 * 12,
      deathYear: 2036,
    };
    const sv: SurvivorMember = {
      survivorFraMonths: 67 * 12,
      survivorClaimAgeMonths: 67 * 12,
      survivorClaimMonthIdx: 2037 * 12,
    };
    const result = survivorBenefitAnnual(sv, claimAtBoundary, 2037, 0);
    expect(result).toBeCloseTo(1_000 * 12, 0);
  });

  it('one month of pre-death reduced entitlement DOES apply RIB-LIM', () => {
    const claimOneMonthBeforeBoundary: DeceasedMember = {
      ...earlyClaimDeceased,
      scenarioClaimAgeMonths: 62 * 12,
      deathAgeMonths: 62 * 12 + 1,
      deathYear: 2036,
    };
    const sv: SurvivorMember = {
      survivorFraMonths: 67 * 12,
      survivorClaimAgeMonths: 67 * 12,
      survivorClaimMonthIdx: 2037 * 12,
    };
    const result = survivorBenefitAnnual(sv, claimOneMonthBeforeBoundary, 2037, 0);
    expect(result).toBeCloseTo(825 * 12, 0);
  });

  // POMS RS 00615.482: the deceased's earnings-test-withheld months are ARF-credited into the reduced RIB the cap compares against.
  it('ARF credits from the deceased earnings-test withholding raise the RIB-LIM cap', () => {
    const withoutCredits = survivorBenefitAnnual(
      survivorAtFra,
      earlyClaimDeceased,
      2048,
      0,
      0,
    );
    expect(withoutCredits).toBeCloseTo(825 * 12, 0);
    // 30 withheld months → ARF claim 62y6m + 30 = 64.5y (774) → factor
    // 1 − 30 × 5/900 = 0.8333 → reduced RIB $833.33 > $825 → cap $833.33.
    const with30 = survivorBenefitAnnual(
      survivorAtFra,
      earlyClaimDeceased,
      2048,
      0,
      30,
    );
    expect(with30).toBeCloseTo((1_000 - 30 * (5 / 900) * 1_000) * 12, 0);
    // 60 withheld months reach FRA: reduced RIB = full PIA, so the cap no longer binds.
    const with60 = survivorBenefitAnnual(
      survivorAtFra,
      earlyClaimDeceased,
      2048,
      0,
      60,
    );
    expect(with60).toBeCloseTo(1_000 * 12, 0);
  });
});

describe('applyAnnualSurvivorBranches — survivor start month', () => {
  const survivorJune: SurvivorMember = {
    survivorFraMonths: 67 * 12,
    survivorClaimAgeMonths: 60 * 12,
    survivorClaimMonthIdx: 2041 * 12 + 5, // June 2041
  };
  const deceased: DeceasedMember = {
    pia: 1_000,
    fraMonths: 67 * 12,
    scenarioClaimAgeMonths: 67 * 12,
    deathAgeMonths: 70 * 12,
    deathYear: 2039, // boundary Jan 2040 < claim month → claim governs
    colaAnchorYear: 2030,
  };

  // First month0 of `year` in which the survivor step-up pays (12 when none does).
  const firstPayableMonth0 = (member: DeceasedMember, year: number): number => {
    const { secondaryByMonth } = applyAnnualSurvivorBranches(
      {
        hasSecondary: true,
        primaryAlive: false,
        secondaryAlive: true,
        year,
        colaPct: 0,
        primarySurvivor: survivorJune,
        secondarySurvivor: survivorJune,
        primaryDeceased: member,
        secondaryDeceased: null,
      },
      new Array<number>(12).fill(0),
      new Array<number>(12).fill(0),
    );
    const first = secondaryByMonth!.findIndex((v) => v > 0);
    return first === -1 ? 12 : first;
  };

  it('is the start month0 in the entitlement-start year', () => {
    expect(firstPayableMonth0(deceased, 2041)).toBe(5);
  });

  it('is 0 in full years after the start, 12 (no payable month) before it', () => {
    expect(firstPayableMonth0(deceased, 2042)).toBe(0);
    expect(firstPayableMonth0(deceased, 2040)).toBe(12);
  });

  it('uses the forced later start when death lands after the chosen month', () => {
    // Forced start Jan 2045.
    expect(firstPayableMonth0({ ...deceased, deathYear: 2044 }, 2045)).toBe(0);
  });
});

describe('projectSsByYear — survivor start uses the SEPARATE survivor claim age', () => {
  it('no early-claim reduction when the deceased dies after the survivor is past FRA', () => {
    // Survivor born 1960 (FRA 67) claims own SS and survivor benefit at 62; the worker dies in 2040, so the survivor benefit starts 2041 at age 81: factor 1.0. Conflating the own claim age would wrongly reduce it.
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: ssMember({ birthdate: '1955-06-15', isPrimary: true }),
        pia: 3_000,
        claimAge: claimAge(67),
        lifeExpectancyAge: 85, // dies 2040
      },
      secondary: {
        id: 's',
        payload: { ...ssMember({ birthdate: '1960-06-15' }), isPrimary: false },
        pia: 500,
        claimAge: claimAge(62),
        survivorClaimAge: claimAge(62),
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
    };
    const out = projectSsByYear(ctx, { from: 2042, to: 2042 });
    const survivorBenefit = out[0].byMember.secondary ?? 0;
    // Deceased (born 1955, FRA 66y2m) claimed at 67 → 10 months of DRCs on
    // the $3,000 PIA; survivor factor 1.0 at the forced start.
    const drcFactor = 1 + 10 * (2 / 3) / 100;
    const fullDeceased = 3_000 * drcFactor * 12;
    expect(survivorBenefit).toBeCloseTo(fullDeceased, 0);
    expect(out[0].survivorWithheld).toBeUndefined();
  });

  it('withholds the survivor step-up and flags the row when the survivor claim age is absent', () => {
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: ssMember({ birthdate: '1955-06-15', isPrimary: true }),
        pia: 3_000,
        claimAge: claimAge(67),
        lifeExpectancyAge: 85, // dies 2040
      },
      secondary: {
        id: 's',
        payload: { ...ssMember({ birthdate: '1960-06-15' }), isPrimary: false },
        pia: 500,
        claimAge: claimAge(62),
        // survivorClaimAge intentionally absent → withheld.
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
    };
    const out = projectSsByYear(ctx, { from: 2042, to: 2042 });
    const ownAt62 = 500 * (1 - 36 * (5 / 900) - 24 * (5 / 1200)) * 12; // 30% cut
    expect(out[0].byMember.secondary).toBeCloseTo(ownAt62, 0);
    expect(out[0].survivorWithheld).toBe(true);
  });
});

describe('projectSsByYear — dual entitlement (own + independently reduced excess)', () => {
  it('reduces the own benefit and the spousal excess SEPARATELY before adding (POMS RS 00615.020)', () => {
    // Own $800 × 0.70 = $560; excess ($1,200 − $800 = $400) × 0.65 = $260; total $820/mo. The retired larger-of composition gave $780: a wrong-number guard.
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: ssMember({ birthdate: '1965-03-12', isPrimary: true }),
        pia: 800,
        claimAge: claimAge(62),
        lifeExpectancyAge: 95,
      },
      secondary: {
        id: 's',
        payload: { ...ssMember({ birthdate: '1965-03-12' }), isPrimary: false },
        pia: 2_400,
        claimAge: claimAge(62),
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
    };
    const out = projectSsByYear(ctx, { from: 2028, to: 2028 });
    expect(out[0].byMember.primary).toBeCloseTo(820 * 12, 0);
  });

  it('lower earner at FRA gets own + excess (equals the 50% floor only at factor 1.0)', () => {
    // Both at FRA: own $9,600 + excess $4,800 = $14,400.
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: ssMember({ birthdate: '1965-03-12', isPrimary: true }),
        pia: 800,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
      },
      secondary: {
        id: 's',
        payload: { ...ssMember({ birthdate: '1965-03-12' }), isPrimary: false },
        pia: 2_400,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
    };
    const out = projectSsByYear(ctx, { from: 2033, to: 2033 });
    expect(out[0].byMember.primary).toBeCloseTo(14_400, 0);
  });

  it('excess is 0 while deemed filing is not yet eligible (worker not claimed)', () => {
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: ssMember({ birthdate: '1965-03-12', isPrimary: true }),
        pia: 800,
        claimAge: claimAge(62),
        lifeExpectancyAge: 95,
      },
      secondary: {
        id: 's',
        payload: { ...ssMember({ birthdate: '1965-03-12' }), isPrimary: false },
        pia: 2_400,
        claimAge: claimAge(70),
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
    };
    const before = projectSsByYear(ctx, { from: 2030, to: 2030 })[0].byMember.primary;
    const after = projectSsByYear(ctx, { from: 2036, to: 2036 })[0].byMember.primary;
    expect(after).toBeGreaterThan(before);
  });

  it('excess is 0 when the recipient own PIA meets or exceeds half the worker PIA', () => {
    // Own PIA $1,300 ≥ 50% × $2,400 = $1,200: no excess.
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: ssMember({ birthdate: '1965-03-12', isPrimary: true }),
        pia: 1_300,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
      },
      secondary: {
        id: 's',
        payload: { ...ssMember({ birthdate: '1965-03-12' }), isPrimary: false },
        pia: 2_400,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
    };
    const out = projectSsByYear(ctx, { from: 2033, to: 2033 });
    expect(out[0].byMember.primary).toBeCloseTo(1_300 * 12, 0);
  });
});

describe('projectSsByYear — spousal excess on a common COLA basis', () => {
  it('deflates a later-anchored recipient PIA to the worker anchor before subtracting', () => {
    // Worker anchor 2022, recipient anchor 2026, COLA 2%: recipient PIA $1,000 is $923.85 in 2022 terms, so the excess base is $276.15/mo at the 2022 anchor.
    const cola = 1.02;
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: ssMember({ birthdate: '1965-03-12', isPrimary: true }),
        pia: 1_000,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
        statementAnchorYear: 2026,
      },
      secondary: {
        id: 's',
        payload: { ...ssMember({ birthdate: '1965-03-12' }), isPrimary: false },
        pia: 2_400,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
        statementAnchorYear: 2022,
      },
      colaPct: 2,
      benefitReductionPct: 0,
    };
    const out = projectSsByYear(ctx, { from: 2033, to: 2033 });
    const ownAtWorkerAnchor = 1_000 * Math.pow(cola, 2022 - 2026);
    const excessBase = 0.5 * 2_400 - ownAtWorkerAnchor;
    const expected =
      1_000 * Math.pow(cola, 2033 - 2026) * 12 +
      excessBase * Math.pow(cola, 2033 - 2022) * 12;
    expect(out[0].byMember.primary).toBeCloseTo(expected, 1);
    // Subtracting the raw $1,000 against the 2022-anchored worker PIA understates the excess.
    const mixedBasis =
      1_000 * Math.pow(cola, 2033 - 2026) * 12 +
      (0.5 * 2_400 - 1_000) * Math.pow(cola, 2033 - 2022) * 12;
    expect(out[0].byMember.primary).not.toBeCloseTo(mixedBasis, 1);
  });
});

describe('projectSsByYear — spousal reduction timing', () => {
  it('reduction clock starts at the worker claim when the recipient claims first', () => {
    // Recipient claims at 62 with own PIA 0; the worker claims at FRA 67 in 2032, so the reduction clock starts there: spousal factor 1.0.
    const earlyRecipientLateWorker: SsContext = {
      primary: {
        id: 'p',
        payload: ssMember({ birthdate: '1965-03-12', isPrimary: true }),
        pia: 0,
        claimAge: claimAge(62),
        lifeExpectancyAge: 95,
      },
      secondary: {
        id: 's',
        payload: { ...ssMember({ birthdate: '1965-03-12' }), isPrimary: false },
        pia: 2_000,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
    };
    const out = projectSsByYear(earlyRecipientLateWorker, { from: 2033, to: 2033 });
    expect(out[0].byMember.primary).toBeCloseTo(12_000, 0);
  });
});
