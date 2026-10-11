/**
 * Tests for `deemedFilingEligible` and `survivorBenefitAnnual`.
 *
 * `survivorBenefitAnnual` returns the widow(er) DECEASED-COMPONENT only:
 * the deceased's PIA-derived base (plus actual DRCs — no posthumous
 * credits), reduced by the SURVIVOR's early reduction AMOUNT (rounded UP to
 * the next dime — POMS RS 00615.301) at their SEPARATE survivor claim age
 * against the WIDOW(ER) FRA table, capped by RIB-LIM (with the deceased's
 * own ARF credits — POMS RS 00615.482) when the deceased claimed early
 * (POMS RS 00615.320), COLA'd from the deceased's statement anchor.
 * `null` = withheld (no survivor claim age on file). Callers
 * pre-reduce `deceased.pia` by the across-the-board reductionFactor.
 */
import { describe, expect, it } from 'vitest';
import {
  deemedFilingEligible,
  survivorBenefitAnnual,
  survivorStartMonth0,
  RIB_LIM_PIA_FRACTION,
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
    // May 2030 (idx 2030*12+8) → false
    expect(deemedFilingEligible(true, 2030 * 12 + 8, claimIdx)).toBe(false);
    // October 2030 (at claim) → true
    expect(deemedFilingEligible(true, claimIdx, claimIdx)).toBe(true);
    // November 2030 → true
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
  // Base survivor: survivor claim age = survivor FRA (67) → early factor
  // 1.0. Claim month = January 2048 (idx 2048×12).
  const survivor: SurvivorMember = {
    survivorFraMonths: 67 * 12,
    survivorClaimAgeMonths: 67 * 12,
    survivorClaimMonthIdx: 2048 * 12,
  };

  // Base deceased: PIA $2,500 (already reduced by caller), FRA 67×12=804,
  // claimed at FRA, death boundary age 73 (death Dec 31 of 2047).
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
    // Deceased claimed exactly at FRA → base = PIA; survivor at FRA → factor 1.
    const result = survivorBenefitAnnual(survivor, deceased, 2048, 0);
    expect(result).toBeCloseTo(2_500 * 12, 0);
  });

  it('death-pre-deceased-claim: no posthumous DRCs — base stays at the PIA', () => {
    // Deceased scenario claim age 70 (840mo) but dies with a boundary age of
    // 66 (792mo) — never claimed. Effective claim = 792 < FRA → the widow
    // base is the FULL PIA (the deceased's hypothetical early reduction never
    // applies to a never-claimed record) and no DRCs accrue posthumously.
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
    // Full PIA (no reduction, no DRCs), survivor at/past FRA → factor 1.
    expect(result).toBeCloseTo(2_500 * 12, 0);
    expect(result!).toBeLessThan(2_500 * 12 * 1.24); // strictly < at-70 amount
  });

  it('widow inherits DRCs the deceased actually earned (claimed after FRA)', () => {
    // Deceased claimed at 70 and died at 73 → base includes the full 24% DRC.
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

// Survivor (widow[er]) early-claim reduction sliding scale.
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
  // Survivor takes the SURVIVOR benefit at 62 (744 months), FRA 804 —
  // independent of any own-benefit claim. monthsEarly = 60, span = 84 →
  // factor = 1 − 0.285 × 60/84 = 0.79643. The statutory REDUCTION
  // AMOUNT ($2,500 × 0.203571… = $508.9286) rounds UP to the next dime
  // ($509.00) before subtraction — the widow gets $1,991.00/mo, not the raw
  // $1,991.07 a bare factor multiplication would give.
  it('applies the dime-rounded survivor early reduction once to the deceased component', () => {
    // Death (2040) precedes the chosen survivor claim month (Jan 2043), so
    // the CHOSEN age-62 claim governs the reduction.
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
    // Chose survivor age 62 (Jan 2043), but the spouse dies Dec 31 2047 →
    // forced start Jan 2048, five years (60 months) later → effective age
    // 744 + 60 = 804 = FRA → factor 1.0, not 0.796.
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

// Dime-boundary fixtures (POMS RS 00615.301): the reduction AMOUNT
// rounds UP to the next $0.10; an exact-dime reduction must NOT ratchet.
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
    // factor(64) = 1 − 0.285 × 36/84 → raw reduction $1,000 × 0.1221428…
    // = $122.1428 → next dime $122.20 → monthly $877.80 exactly.
    const survivorAt64: SurvivorMember = {
      survivorFraMonths: 67 * 12,
      survivorClaimAgeMonths: 64 * 12,
      survivorClaimMonthIdx: 2045 * 12,
    };
    const result = survivorBenefitAnnual(survivorAt64, deceasedAtFra, 2045, 0);
    expect(result).toBeCloseTo(877.8 * 12, 6);
    // A raw factor multiplication would give $877.857…/mo — must not match.
    expect(result).not.toBeCloseTo(1_000 * (1 - 0.285 * (36 / 84)) * 12, 2);
  });

  it('keeps an exact-dime reduction unchanged (widow at 60: $285.00 stays)', () => {
    const survivorAt60: SurvivorMember = {
      survivorFraMonths: 67 * 12,
      survivorClaimAgeMonths: 60 * 12,
      survivorClaimMonthIdx: 2041 * 12,
    };
    // Death 2040 → boundary Jan 2041 = the chosen claim month, so the
    // age-60 factor governs in the 2041 start year.
    const earlierDeath: DeceasedMember = { ...deceasedAtFra, deathYear: 2040 };
    const result = survivorBenefitAnnual(survivorAt60, earlierDeath, 2041, 0);
    expect(result).toBeCloseTo(715 * 12, 6); // 1,000 − 285.00, no ratchet
  });
});

describe('survivorBenefitAnnual — RIB-LIM widow(er) cap (POMS RS 00615.320)', () => {
  // Deceased PIA $1,000 (pre-reduced), FRA 67, CLAIMED at 62 (reduced RIB:
  // $700 = 30% reduction), died at boundary age 73.
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
    // Un-capped widow benefit = PIA × 1.0 = $1,000. RIB-LIM cap =
    // max($700 reduced RIB, 82.5% × $1,000 = $825) = $825.
    const result = survivorBenefitAnnual(survivorAtFra, earlyClaimDeceased, 2048, 0);
    expect(RIB_LIM_PIA_FRACTION).toBe(0.825);
    expect(result).toBeCloseTo(825 * 12, 0);
  });

  it('does not bind when the widow early reduction already lands below the cap', () => {
    // Widow claims the survivor benefit at 60 → 0.715 × $1,000 = $715,
    // below the $825 cap → the reduction result stands.
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
    // factor(64) → dime-rounded reduction $122.20 → $877.80 → capped $825.
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
    // Deceased would have claimed at 62 per the scenario but died at a
    // boundary age of 61 — never received a reduced benefit → widow base =
    // full PIA, no cap.
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

  // (POMS RS 00615.320): RIB-LIM requires reduced-RIB ENTITLEMENT
  // before death. `deathAgeMonths` is the age at the EXCLUSIVE Jan-1
  // boundary after the Dec-31 death, so a claim age EQUAL to it would have
  // started only the month AFTER death — never entitled, no cap.
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
    // Full PIA — no early reduction flows into the base, no RIB-LIM cap.
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
    // Capped at max(82.5% × $1,000, reduced RIB $700) = $825.
    expect(result).toBeCloseTo(825 * 12, 0);
  });

  // (POMS RS 00615.482): the deceased's own earnings-test-withheld
  // months are ARF-credited into the reduced RIB the cap compares against.
  it('ARF credits from the deceased earnings-test withholding raise the RIB-LIM cap', () => {
    // Without credits: cap = max($825, $700) = $825 → $9,900/yr.
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
    // 60 withheld months → ARF claim reaches FRA → reduced RIB = full PIA →
    // the cap no longer binds at all.
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

// The annual table's month-wise fold starts a midyear survivor
// entitlement at the exact start month.
describe('survivorStartMonth0', () => {
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

  it('is the start month0 in the entitlement-start year', () => {
    expect(survivorStartMonth0(survivorJune, deceased, 2041)).toBe(5);
  });

  it('is 0 in full years after the start, 12 (no payable month) before it', () => {
    expect(survivorStartMonth0(survivorJune, deceased, 2042)).toBe(0);
    expect(survivorStartMonth0(survivorJune, deceased, 2040)).toBe(12);
  });

  it('uses the forced later start when death lands after the chosen month', () => {
    const lateDeath: DeceasedMember = { ...deceased, deathYear: 2044 };
    // Forced start Jan 2045 → month0 0 in 2045 (January start).
    expect(survivorStartMonth0(survivorJune, lateDeath, 2045)).toBe(0);
  });
});

// Survivor start-age separation at the engine level: the survivor claim age
// is independent of the own claim age.
describe('projectSsByYear — survivor start uses the SEPARATE survivor claim age', () => {
  it('no early-claim reduction when the deceased dies after the survivor is past FRA', () => {
    // Survivor (secondary) born 1960 → FRA 67, claims OWN SS at 62 and sets
    // a survivor claim age of 62 too. Worker (primary) born 1955, claims at
    // FRA, dies in 2040 when the survivor is 80 (past FRA). The survivor
    // benefit starts 2041 at age 81 → survivorEarlyFactor = 1.0. Conflating
    // the OWN claim age (62) would wrongly reduce the deceased component.
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
    // Survivor keeps their OWN (reduced, age-62) benefit only — the deceased
    // component is withheld, never silently defaulted.
    const ownAt62 = 500 * (1 - 36 * (5 / 900) - 24 * (5 / 1200)) * 12; // 30% cut
    expect(out[0].byMember.secondary).toBeCloseTo(ownAt62, 0);
    expect(out[0].survivorWithheld).toBe(true);
  });
});

// Dual entitlement: own + independently reduced spousal excess.
describe('projectSsByYear — dual entitlement (own + independently reduced excess)', () => {
  it('reduces the own benefit and the spousal excess SEPARATELY before adding (POMS RS 00615.020)', () => {
    // Lower earner (primary) PIA $800/mo, higher earner (secondary) PIA
    // $2,400/mo. Both born 1965-03-12 (FRA 67), BOTH claim at 62, COLA 0.
    // own = $800 × 0.70 (own factor at 62) = $560.
    // excess = (50% × $2,400 − $800) = $400, × spousal factor at 62 (0.65)
    //        = $260.  Total = $820/mo = $9,840/yr.
    // The retired larger-of composition gave max($560, $2,400×0.5×0.65
    // = $780) = $780/mo — a wrong-number regression guard.
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
    // Claim year 2027 (1965 + 62); use the first FULL year, 2028.
    const out = projectSsByYear(ctx, { from: 2028, to: 2028 });
    expect(out[0].byMember.primary).toBeCloseTo(820 * 12, 0);
  });

  it('lower earner at FRA gets own + excess (equals the 50% floor only at factor 1.0)', () => {
    // Both claim at FRA → own $9,600 + excess $4,800 = $14,400 (= the floor
    // only because both factors are 1.0 at FRA).
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
    // 2030: primary claiming (since 2027), worker not yet (claims 2035).
    const before = projectSsByYear(ctx, { from: 2030, to: 2030 })[0].byMember.primary;
    // 2036: both claiming → spousal excess now adds on top of own.
    const after = projectSsByYear(ctx, { from: 2036, to: 2036 })[0].byMember.primary;
    expect(after).toBeGreaterThan(before);
  });

  it('excess is 0 when the recipient own PIA meets or exceeds half the worker PIA', () => {
    // Own PIA $1,300 ≥ 50% × $2,400 = $1,200 → no excess; the recipient
    // keeps their own (higher) benefit untouched.
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

// Mixed statement anchors: the recipient's PIA is brought onto the
// worker's anchor basis before subtracting, so the excess is not mis-scaled.
describe('projectSsByYear — spousal excess on a common COLA basis', () => {
  it('deflates a later-anchored recipient PIA to the worker anchor before subtracting', () => {
    // Worker (secondary) statement anchor 2022; recipient (primary)
    // statement anchor 2026; COLA 2%. Recipient PIA $1,000 quoted in 2026
    // dollars ≙ $1,000 × 1.02^(2022−2026) = $923.85 in 2022 terms. Excess
    // base = (50% × $2,400 − $923.85) = $276.15/mo at the 2022 anchor.
    // Both claim at FRA (factor 1.0). Evaluate the full year 2033:
    // own = $1,000 × 1.02^(2033−2026) × 12
    // excess = $276.15 × 1.02^(2033−2022) × 12
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
    // The mixed-basis subtraction (raw $1,000 against the 2022-anchored
    // worker PIA) understates the excess — must NOT match.
    const mixedBasis =
      1_000 * Math.pow(cola, 2033 - 2026) * 12 +
      (0.5 * 2_400 - 1_000) * Math.pow(cola, 2033 - 2022) * 12;
    expect(out[0].byMember.primary).not.toBeCloseTo(mixedBasis, 1);
  });
});

// Spousal reduction months counted from max(recipientClaim, workerClaim).
describe('projectSsByYear — spousal reduction timing', () => {
  it('reduction clock starts at the worker claim when the recipient claims first', () => {
    // Recipient (primary) born 1965-03-12 claims at 62 with own PIA 0 (only
    // the excess matters). Worker (secondary) claims at FRA 67 in 2032.
    // Recipient's age when the worker claims = 67 → spousal factor 1.0.
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
    // Full post-claim year 2033: excess = 50% × $2,000 × 12 = $12,000.
    const out = projectSsByYear(earlyRecipientLateWorker, { from: 2033, to: 2033 });
    expect(out[0].byMember.primary).toBeCloseTo(12_000, 0);
  });
});
