import { describe, expect, it } from 'vitest';
import { projectSsByMonth, projectSsByYear, type SsContext } from './ss-projection';
import {
  buildSurvivorStructs,
  computeAnnualMemberBenefits,
} from './ss-projection-helpers';
import type { SsContextMember } from './ss-projection-types';
import type {
  HouseholdMemberPayload,
  RetirementAgePerMember,
} from '../db/types';

const member = (
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

describe('projectSsByMonth — claim-month step-up', () => {
  it('rate is zero pre-claim, jumps to at-claim annual on the claim month', () => {
    // Born March 12 1965, claim age 67 → March 2032; PIA $2000 at FRA → $24000/yr.
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1965-03-12' }),
        pia: 2000,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
    };
    const out = projectSsByMonth(ctx, { from: 2032, to: 2032 });
    expect(out[0].total).toBe(0);
    expect(out[1].total).toBe(0);
    for (let m = 2; m < 12; m += 1) {
      expect(out[m].total).toBeCloseTo(24000, 2);
    }
  });

  it('COLA compounds at January each year past claim', () => {
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1965-07-15' }),
        pia: 1000,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
      },
      colaPct: 2,
      benefitReductionPct: 0,
    };
    const out = projectSsByMonth(ctx, { from: 2032, to: 2034 });
    const dec2032 = out.find((p) => p.year === 2032 && p.month0 === 11);
    expect(dec2032).toBeDefined();
    const baseRate = dec2032!.total;
    expect(baseRate).toBeGreaterThan(0);
    const jan2033 = out.find((p) => p.year === 2033 && p.month0 === 0);
    expect(jan2033!.total).toBeCloseTo(baseRate * 1.02, 2);
    const jan2034 = out.find((p) => p.year === 2034 && p.month0 === 0);
    expect(jan2034!.total).toBeCloseTo(baseRate * 1.02 * 1.02, 2);
  });
});

describe('projectSsByMonth — survivor switch at death (Dec 31)', () => {
  // Primary born Mar 1960, life 90 → deathYear 2050 (death modelled as Dec 31), so the survivor floor begins Jan 2051. Secondary born Mar 1962 claims at 67; survivor claim 67 too (past FRA, widow factor 1.0).
  // Primary PIA $3000, secondary $1000 (both at FRA). Both alive: own $12k + spousal excess $6k = $18k/yr; survivor: deceased component PIA $36k/yr.
  const ctx: SsContext = {
    primary: {
      id: 'p',
      payload: member({ birthdate: '1960-03-15', isPrimary: true }),
      pia: 3000,
      claimAge: claimAge(67),
      lifeExpectancyAge: 90,
    },
    secondary: {
      id: 's',
      payload: { ...member({ birthdate: '1962-03-15' }), isPrimary: false },
      pia: 1000,
      claimAge: claimAge(67),
      survivorClaimAge: claimAge(67),
      lifeExpectancyAge: 95,
    },
    colaPct: 0,
    benefitReductionPct: 0,
  };

  it("secondary's floor steps up Jan of the year after primary dies (monthly)", () => {
    const out = projectSsByMonth(ctx, { from: 2050, to: 2051 });
    const dec2050 = out.find((p) => p.year === 2050 && p.month0 === 11)!;
    expect(dec2050.byMember.primary ?? 0).toBeGreaterThan(0);
    const jan2051 = out.find((p) => p.year === 2051 && p.month0 === 0)!;
    expect(jan2051.byMember.secondary).toBeGreaterThan(dec2050.byMember.secondary ?? 0);
    expect(jan2051.byMember.primary).toBe(0);
  });

  it('annual: both alive through deathYear, survivor from deathYear + 1 (y <= deathYear)', () => {
    const out = projectSsByYear(ctx, { from: 2050, to: 2051 });
    const y2050 = out.find((p) => p.year === 2050)!;
    const y2051 = out.find((p) => p.year === 2051)!;
    expect(y2050.byMember.primary ?? 0).toBeGreaterThan(0);
    expect(y2051.byMember.primary).toBe(0);
    expect(y2051.byMember.secondary).toBeGreaterThan(y2050.byMember.secondary ?? 0);
  });
});

describe('projectSsByMonth — annual rollup', () => {
  it('post-claim full years: mean of 12 monthly rates equals projectSsByYear total', () => {
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1965-03-12' }),
        pia: 2000,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
      },
      colaPct: 2,
      benefitReductionPct: 0,
    };
    const monthly = projectSsByMonth(ctx, { from: 2033, to: 2035 });
    for (const y of [2033, 2034, 2035]) {
      const inYear = monthly.filter((p) => p.year === y);
      const mean = inYear.reduce((acc, p) => acc + p.total, 0) / 12;
      expect(mean).toBeGreaterThan(0);
      const max = Math.max(...inYear.map((p) => p.total));
      const min = Math.min(...inYear.map((p) => p.total));
      expect(max).toBeCloseTo(min, 4);
    }
  });
});

describe('projectSsByYear — nominal-unit contract (pin)', () => {
  const baseCtx = (colaPct: number): SsContext => ({
    primary: {
      id: 'p',
      payload: member({ birthdate: '1965-03-12' }),
      pia: 2000,
      claimAge: claimAge(67),
      lifeExpectancyAge: 95,
    },
    colaPct,
    benefitReductionPct: 0,
  });

  it('claim-year total = PIA × 12 × adjustmentFactor, prorated by claim month', () => {
    // Born 1965-03-12: FRA 67, age-62 year 2027, claim 2032. Full year $24,000; the March claim prorates by 10/12 → $20,000.
    const ctx = baseCtx(0);
    const out = projectSsByYear(ctx, { from: 2032, to: 2033 });
    expect(out[0].total).toBeCloseTo(24_000 * (10 / 12), 0); // claim year prorated
    expect(out[1].total).toBeCloseTo(24_000, 0); // full year, no COLA → flat
  });

  it('COLA compounds from the age-62 eligibility year, not the claim year', () => {
    // Age-62 year 2027: a full post-claim year 2033 carries 2033 − 2027 COLA years ($24k × 1.02^6).
    const ctx = baseCtx(2);
    const out = projectSsByYear(ctx, { from: 2033, to: 2037 });
    for (let i = 0; i < out.length; i += 1) {
      const year = 2033 + i;
      const expected = 24_000 * Math.pow(1.02, year - 2027);
      expect(out[i].total).toBeCloseTo(expected, 0);
    }
  });

  it('future years extend nominally from the age-62 anchor', () => {
    const ctx = baseCtx(3);
    const out = projectSsByYear(ctx, { from: 2033, to: 2043 });
    // 2043 = $24k × 1.03^(2043 − 2027).
    expect(out[10].total).toBeCloseTo(24_000 * Math.pow(1.03, 2043 - 2027), 0);
  });
});

describe('projectSsByMonth — fractionalYear', () => {
  it('= year + month0/12', () => {
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1965-03-12' }),
        pia: 2000,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
    };
    const out = projectSsByMonth(ctx, { from: 2030, to: 2030 });
    expect(out[0].fractionalYear).toBeCloseTo(2030, 6);
    expect(out[6].fractionalYear).toBeCloseTo(2030.5, 6);
    expect(out[11].fractionalYear).toBeCloseTo(2030 + 11 / 12, 6);
  });
});

// The runner feeds DEFAULT_COLA_PCT (2%) into SsContext; this pins the engine compounding at that rate.
describe('SS COLA = 2% (DEFAULT_COLA_PCT contract pin)', () => {
  it('compounds at 2% per year when colaPct is 2', () => {
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1960-01-01' }),
        pia: 2000,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
      },
      colaPct: 2,
      benefitReductionPct: 0,
    };
    // Born 1960-01-01 → SSA day-1 rule → 1959 cohort; the 2026 claim year is prorated, so assert from the first full year 2027.
    const out = projectSsByYear(ctx, { from: 2027, to: 2029 });
    // COLA compounds from the age-62 year 2021, so the per-year ratio is exactly 1.02.
    const base = out[0].total;
    expect(base).toBeGreaterThan(0);
    expect(out[1].total).toBeCloseTo(base * 1.02, 0);
    expect(out[2].total).toBeCloseTo(base * 1.02 ** 2, 0);
  });
});

describe('projectSsByYear — COLA anchor (age-62 eligibility year)', () => {
  // Born 1956-03-15: age-62 year 2018, FRA 66y4m (796). Claim at 70 → first payment 2026; DRC factor = adjustmentFactor(796, 840) = 1 + 44 × 2/300 = 1.29333.
  const FRA = 66 * 12 + 4; // 796
  const ADJ_70 = 1 + (70 * 12 - FRA) * (2 / 300);
  const claimAt70 = (cola: number): SsContext => ({
    primary: {
      id: 'p',
      payload: member({ birthdate: '1956-03-15' }),
      pia: 2000,
      claimAge: claimAge(70),
      lifeExpectancyAge: 95,
    },
    colaPct: cola,
    benefitReductionPct: 0,
  });

  it('full post-claim years carry COLA measured from age-62 year 2018 (exact $)', () => {
    // Exact to the cent: the exponent is 2028 − 2018 = 10, not 2028 − claimYear (the over-counting claim-year shape fails).
    const out = projectSsByYear(claimAt70(2), { from: 2028, to: 2028 });
    const expected = 2000 * ADJ_70 * Math.pow(1.02, 2028 - 2018) * 12;
    expect(out[0].total).toBeCloseTo(expected, 1);
    const claimAnchored = 2000 * ADJ_70 * Math.pow(1.02, 2028 - 2026) * 12;
    expect(out[0].total).toBeGreaterThan(claimAnchored * 1.1);
  });

  it('per-year ratio is exactly the COLA factor (anchor moves, growth rate same)', () => {
    const out = projectSsByYear(claimAt70(2), { from: 2027, to: 2029 });
    expect(out[1].total).toBeCloseTo(out[0].total * 1.02, 2);
    expect(out[2].total).toBeCloseTo(out[0].total * 1.02 ** 2, 2);
  });

  it('no-regression at FRA: claim-AT-FRA per-year array unchanged ($)', () => {
    // Claim AT FRA (66y4m, first payment 2022): adjustmentFactor 1.0, so full years equal PIA × 1.02^(year − 2018) × 12.
    const fraCtx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1956-03-15' }),
        pia: 2000,
        claimAge: claimAge(66, 4), // exactly FRA
        lifeExpectancyAge: 95,
      },
      colaPct: 2,
      benefitReductionPct: 0,
    };
    const out = projectSsByYear(fraCtx, { from: 2024, to: 2026 });
    for (const row of out) {
      const expected = 2000 * Math.pow(1.02, row.year - 2018) * 12;
      expect(row.total).toBeCloseTo(expected, 1);
    }
  });
});

describe('projectSsByYear — claim-year proration', () => {
  it('claim-year row equals the monthly engine claim-year sum / 12 share', () => {
    // Born 1965-07-15 → benefit month July; claim 67 → 2032, proration (12 − 6)/12 = 0.5. PIA 2000, COLA 0 → $24,000 → $12,000.
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1965-07-15' }),
        pia: 2000,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
    };
    const annual = projectSsByYear(ctx, { from: 2032, to: 2033 });
    expect(annual[0].total).toBeCloseTo(12_000, 0); // claim year, prorated
    expect(annual[1].total).toBeCloseTo(24_000, 0); // full year
    // Cross-check: the monthly engine's claim-year mean of annualized rates equals the prorated annual figure.
    const monthly = projectSsByMonth(ctx, { from: 2032, to: 2032 });
    const monthlyMean =
      monthly.filter((p) => p.year === 2032).reduce((a, p) => a + p.total, 0) / 12;
    expect(annual[0].total).toBeCloseTo(monthlyMean, 0);
  });
});

describe('projectSsByMonth — age-62 first full month', () => {
  it('a non-1st birthday starts the month AFTER the 62nd birthday month', () => {
    // Born 1968-06-15 → 62nd birthday June 2030; the first full month at 62 is July 2030 (month0 6).
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1968-06-15' }),
        pia: 2000,
        claimAge: claimAge(62),
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
    };
    const out = projectSsByMonth(ctx, { from: 2030, to: 2030 });
    const june = out.find((p) => p.year === 2030 && p.month0 === 5)!;
    const july = out.find((p) => p.year === 2030 && p.month0 === 6)!;
    expect(june.total).toBe(0); // birthday month — not yet a full month at 62
    expect(july.total).toBeGreaterThan(0); // first full month at 62
  });

  it('a 1st-of-month birthday starts in the (benefit-purpose) birthday month', () => {
    // Born 1968-06-01 → the day-1 shift makes May the benefit-purpose birth month, so benefits start May 2030 (a June-15 birth starts July).
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1968-06-01' }),
        pia: 2000,
        claimAge: claimAge(62),
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
    };
    const out = projectSsByMonth(ctx, { from: 2030, to: 2030 });
    const apr = out.find((p) => p.year === 2030 && p.month0 === 3)!;
    const may = out.find((p) => p.year === 2030 && p.month0 === 4)!;
    expect(apr.total).toBe(0);
    expect(may.total).toBeGreaterThan(0);
  });
});

describe('projectSsByMonth — DRC deferral to January', () => {
  it('DRCs earned in year N are absent until January N+1, except at age 70', () => {
    // Born 1965-03-12: FRA 67, age-62 year 2027. A claim between FRA and 70 shows the deferral: claim at 68y6m → Sept 2033.
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1965-03-12' }),
        pia: 2000,
        claimAge: claimAge(68, 6),
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
    };
    const out = projectSsByMonth(ctx, { from: 2033, to: 2035 });
    // Sept 2033: only credits through Dec 2032 (FRA Mar 2032 → 10 DRC months) pay yet.
    const claimMonth = out.find((p) => p.year === 2033 && p.month0 === 8)!;
    const jan2034 = out.find((p) => p.year === 2034 && p.month0 === 0)!;
    expect(jan2034.total).toBeGreaterThan(claimMonth.total);
    // Flat within 2034: the 18-month DRC delay is all payable by Jan 2034.
    const mar2034 = out.find((p) => p.year === 2034 && p.month0 === 2)!;
    expect(mar2034.total).toBeCloseTo(jan2034.total, 2);
    const fullFactor = 1 + 18 * (2 / 300);
    expect(jan2034.total).toBeCloseTo(2000 * fullFactor * 12, 0);
    expect(claimMonth.total).toBeCloseTo(2000 * (1 + 10 * (2 / 300)) * 12, 0);
  });

  it('claim exactly at age 70 pays full DRCs immediately (no deferral)', () => {
    // Born 1965-03-12, claim at 70 (Mar 2035): the full 36-month DRC factor (1.24) pays from the first month.
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1965-03-12' }),
        pia: 2000,
        claimAge: claimAge(70),
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
    };
    const out = projectSsByMonth(ctx, { from: 2035, to: 2035 });
    const mar2035 = out.find((p) => p.year === 2035 && p.month0 === 2)!;
    // Full at-70 factor 1.24 → $2000 × 1.24 × 12 = $29,760.
    expect(mar2035.total).toBeCloseTo(2000 * 1.24 * 12, 0);
  });
});

// The spousal excess COLAs from the worker's anchor, the recipient's own benefit from the recipient's.
describe('computeAnnualMemberBenefits — spousal worker-anchored COLA', () => {
  it('secondary recipient: spousal excess uses the worker (primary) anchor, own uses recipient anchor', () => {
    // Worker = primary, anchor 2022; recipient = secondary, anchor 2029: the excess carries 7 more COLA years in any payment year. Evaluate 2035 at COLA 2%.
    const cola = 1.02;
    const year = 2035;
    const primaryColaAnchorYear = 2022; // worker
    const secondaryColaAnchorYear = 2029; // recipient
    // Recipient own base $9,000/yr; spousal excess base $5,000/yr (pre-COLA, independently reduced).
    const secondaryOwnBase = 9_000;
    const secondarySpousalExcessBase = 5_000;
    const { secondary } = computeAnnualMemberBenefits({
      hasSecondary: true,
      primaryAlive: true,
      secondaryAlive: true,
      primaryClaiming: true,
      secondaryClaiming: true,
      year,
      primaryClaim: 2022,
      secondaryClaim: 2029,
      primaryClaimMonthIdx: 2022 * 12,
      secondaryClaimMonthIdx: 2029 * 12,
      primaryColaAnchorYear,
      secondaryColaAnchorYear,
      primaryOwnBase: 0,
      secondaryOwnBase,
      primarySpousalExcessBase: 0,
      secondarySpousalExcessBase,
      colaFactor: cola,
    });
    const secondaryAnnual = secondary?.total;
    // own = 9,000 × 1.02^(2035 − 2029); excess = 5,000 × 1.02^(2035 − 2022) (worker anchor); dual entitlement adds both.
    const ownNow = secondaryOwnBase * Math.pow(cola, year - secondaryColaAnchorYear);
    const excessNow =
      secondarySpousalExcessBase * Math.pow(cola, year - primaryColaAnchorYear);
    const expected = ownNow + excessNow;
    expect(secondaryAnnual).toBeCloseTo(expected, 2);
    // Guard: using the recipient anchor for the excess too would give 1.02^6 instead of 1.02^13.
    const buggyExcess =
      secondarySpousalExcessBase * Math.pow(cola, year - secondaryColaAnchorYear);
    const buggy = ownNow + buggyExcess;
    expect(secondaryAnnual).not.toBeCloseTo(buggy, 2);
    expect(secondaryAnnual!).toBeGreaterThan(buggy);
  });
});

// ownBaseNoDrcAnnual already bakes in the pre-FRA reduction; payableDrcFactorForMonth must return 1.0 at or below FRA, not apply it again.
describe('projectSsByMonth — pre-FRA reduction applied once', () => {
  it('age-62 claim pays pia × adjustmentFactor × 12, not pia × factor² × 12', () => {
    // Born 1963-01-15 → FRA 67, benefit month0 0. 62nd birthday Jan 2025, first full month Feb 2025. adjustmentFactor(804, 744) = 0.70 (36 × 5/900 + 24 × 5/1200 = 0.30 cut).
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1963-01-15' }),
        pia: 1200,
        claimAge: claimAge(62),
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
    };
    const out = projectSsByMonth(ctx, { from: 2025, to: 2025 });
    const jan = out.find((p) => p.year === 2025 && p.month0 === 0)!;
    expect(jan.total).toBe(0);
    const feb = out.find((p) => p.year === 2025 && p.month0 === 1)!;
    const factor = 0.7;
    const correct = 1200 * factor * 12; // $10,080
    const doubled = 1200 * factor * factor * 12; // $7,056 (the pre-fix bug)
    expect(feb.total).toBeCloseTo(correct, 0);
    expect(Math.abs(feb.total - correct) / correct).toBeLessThan(0.01);
    expect(feb.total).not.toBeCloseTo(doubled, 0);
  });
});

// The monthly spousal excess also COLAs from the worker's anchor.
describe('projectSsByMonth — spousal worker-anchored COLA', () => {
  it('primary recipient: spousal excess grows from the worker (secondary) anchor', () => {
    // Recipient = primary, born 1967-03-01 → FRA 67, age-62 anchor 2029; worker = secondary, born 1960-03-01 → anchor 2022; both claim at FRA.
    // Primary PIA $800 → own $9,600/yr; spousal excess (50% × $2,000 − $800) × 12 = $2,400/yr (worker-anchored).
    const cola = 1.02;
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1967-03-01', isPrimary: true }),
        pia: 800,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
      },
      secondary: {
        id: 's',
        payload: member({ birthdate: '1960-03-01', isPrimary: false }),
        pia: 2000,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
      },
      colaPct: 2,
      benefitReductionPct: 0,
    };
    // Primary claims at FRA 67 → Feb 2034 (day-1 March shifts to Feb); evaluate Jan 2037.
    const out = projectSsByMonth(ctx, { from: 2034, to: 2037 });
    const jan2037 = out.find((p) => p.year === 2037 && p.month0 === 0)!;
    const primaryAnchor = 2029; // recipient anchor
    const secondaryAnchor = 2022; // worker anchor
    const ownBase = 800 * 12; // 9,600
    const ownPiaAtWorkerAnchor = 800 * Math.pow(cola, secondaryAnchor - primaryAnchor);
    const excessBase = (0.5 * 2000 - ownPiaAtWorkerAnchor) * 12;
    const ownNow = ownBase * Math.pow(cola, 2037 - primaryAnchor);
    const excessNow = excessBase * Math.pow(cola, 2037 - secondaryAnchor);
    const expectedPrimary = ownNow + excessNow;
    expect(jan2037.byMember.primary).toBeCloseTo(expectedPrimary, 1);
    const buggyExcess = excessBase * Math.pow(cola, 2037 - primaryAnchor);
    const buggyPrimary = ownNow + buggyExcess;
    expect(jan2037.byMember.primary).not.toBeCloseTo(buggyPrimary, 1);
    expect(jan2037.byMember.primary).toBeGreaterThan(buggyPrimary);
  });
});

// A mid-year-born survivor's claim index carries the benefit-purpose birth month, so the early-claim reduction and start-year proration are exact.
describe('buildSurvivorStructs — survivor claim month + widow(er) FRA + death age', () => {
  it('June-born survivor: survivorClaimMonthIdx carries the birth month', () => {
    // Survivor born 1962-06-15 → benefit month0 5; claim age 60 → June 2022: idx = (1962×12 + 5) + 720 = 2022×12 + 5 (a year-only derivation dropped the birth month).
    const survivor: SsContextMember = {
      id: 'p',
      payload: member({ birthdate: '1962-06-15', isPrimary: true }),
      pia: 2000,
      claimAge: claimAge(62),
      survivorClaimAge: claimAge(60),
      lifeExpectancyAge: 95,
    };
    const deceased: SsContextMember = {
      id: 's',
      payload: member({ birthdate: '1962-06-15', isPrimary: false }),
      pia: 1800,
      claimAge: claimAge(67),
      lifeExpectancyAge: 68,
    };
    const structs = buildSurvivorStructs(
      survivor,
      deceased,
      /* primaryDeathYear */ null,
      /* secondaryDeathYear */ 2030,
      /* reductionFactor */ 1,
    );
    expect(structs.primarySurvivor.survivorClaimMonthIdx).toBe(2022 * 12 + 5);
    expect(structs.primarySurvivor.survivorClaimMonthIdx).not.toBe(2022 * 12);
    // The separate survivor claim age (60y = 720mo) carries through, independent of the own age-62 claim.
    expect(structs.primarySurvivor.survivorClaimAgeMonths).toBe(720);
  });

  it('carries the WIDOW(ER) FRA cohort table, not the retirement FRA', () => {
    // Born 1958: retirement FRA 66y8m (800), survivor FRA 66y4m (796): the widow(er) schedule runs two cohort years behind (POMS RS 00615.003).
    const survivor: SsContextMember = {
      id: 'p',
      payload: member({ birthdate: '1958-06-15', isPrimary: true }),
      pia: 2000,
      claimAge: claimAge(66, 8),
      survivorClaimAge: claimAge(62),
      lifeExpectancyAge: 95,
    };
    const deceased: SsContextMember = {
      id: 's',
      payload: member({ birthdate: '1958-06-15', isPrimary: false }),
      pia: 1800,
      claimAge: claimAge(67),
      lifeExpectancyAge: 70,
    };
    const structs = buildSurvivorStructs(survivor, deceased, null, 2028, 1);
    expect(structs.primarySurvivor.survivorFraMonths).toBe(66 * 12 + 4);
    expect(structs.primarySurvivor.survivorFraMonths).not.toBe(66 * 12 + 8);
  });

  it('deceased deathAgeMonths reaches the Dec-31 death boundary', () => {
    // Born 1962-06-15, dies Dec 31 2030: death age = age at Jan 1 2031 = 823 months, not 68 × 12 = 816 (which would misclassify a claim between the birthday and Dec 31 as posthumous).
    const survivor: SsContextMember = {
      id: 'p',
      payload: member({ birthdate: '1962-06-15', isPrimary: true }),
      pia: 2000,
      claimAge: claimAge(62),
      survivorClaimAge: claimAge(60),
      lifeExpectancyAge: 95,
    };
    const deceased: SsContextMember = {
      id: 's',
      payload: member({ birthdate: '1962-06-15', isPrimary: false }),
      pia: 1800,
      claimAge: claimAge(67),
      lifeExpectancyAge: 68,
    };
    const structs = buildSurvivorStructs(survivor, deceased, null, 2030, 1);
    expect(structs.secondaryDeceased?.deathAgeMonths).toBe(823);
    expect(structs.secondaryDeceased?.deathAgeMonths).not.toBe(816);
  });

  it('absent survivor claim age → null months/idx (withheld)', () => {
    const survivor: SsContextMember = {
      id: 'p',
      payload: member({ birthdate: '1962-06-15', isPrimary: true }),
      pia: 2000,
      claimAge: claimAge(67),
      lifeExpectancyAge: 95,
    };
    const deceased: SsContextMember = {
      id: 's',
      payload: member({ birthdate: '1962-06-15', isPrimary: false }),
      pia: 1800,
      claimAge: claimAge(67),
      lifeExpectancyAge: 68,
    };
    const structs = buildSurvivorStructs(survivor, deceased, null, 2030, 1);
    expect(structs.primarySurvivor.survivorClaimAgeMonths).toBeNull();
    expect(structs.primarySurvivor.survivorClaimMonthIdx).toBeNull();
  });

  it('deceased struct carries the statement anchor when present', () => {
    const survivor: SsContextMember = {
      id: 'p',
      payload: member({ birthdate: '1962-06-15', isPrimary: true }),
      pia: 2000,
      claimAge: claimAge(67),
      survivorClaimAge: claimAge(67),
      lifeExpectancyAge: 95,
    };
    const deceased: SsContextMember = {
      id: 's',
      payload: member({ birthdate: '1962-06-15', isPrimary: false }),
      pia: 1800,
      claimAge: claimAge(67),
      statementAnchorYear: 2026,
      lifeExpectancyAge: 68,
    };
    const structs = buildSurvivorStructs(survivor, deceased, null, 2030, 1);
    expect(structs.secondaryDeceased?.colaAnchorYear).toBe(2026);
    const structsNoAnchor = buildSurvivorStructs(
      survivor,
      { ...deceased, statementAnchorYear: undefined },
      null,
      2030,
      1,
    );
    expect(structsNoAnchor.secondaryDeceased?.colaAnchorYear).toBe(1962 + 62);
  });
});

// COLAs begin after the SSA statement's as-of year; the age-62 eligibility year is the fallback.
describe('projectSsByYear — statement COLA anchor', () => {
  // Born 1956-03-15: age-62 year 2018, FRA 66y4m (796); claim at 70 → first payment 2026; ADJ = 1 + 44 × 2/300.
  const FRA = 66 * 12 + 4;
  const ADJ_70 = 1 + (70 * 12 - FRA) * (2 / 300);
  const claimAt70 = (statementAnchorYear?: number): SsContext => ({
    primary: {
      id: 'p',
      payload: member({ birthdate: '1956-03-15' }),
      pia: 2000,
      claimAge: claimAge(70),
      lifeExpectancyAge: 95,
      ...(statementAnchorYear !== undefined ? { statementAnchorYear } : {}),
    },
    colaPct: 2,
    benefitReductionPct: 0,
  });

  it('with a statement anchor, COLAs begin after the statement year (no back-fill)', () => {
    // Statement dated 2026: benefit(2028) = PIA × ADJ × 1.02^(2028 − 2026) × 12; an age-62 anchor would back-fill 8 extra COLA years.
    const out = projectSsByYear(claimAt70(2026), { from: 2028, to: 2028 });
    const expected = 2000 * ADJ_70 * Math.pow(1.02, 2028 - 2026) * 12;
    expect(out[0].total).toBeCloseTo(expected, 1);
    const age62Anchored = 2000 * ADJ_70 * Math.pow(1.02, 2028 - 2018) * 12;
    expect(out[0].total).toBeLessThan(age62Anchored * 0.9);
  });

  it('without a statement anchor, the age-62 eligibility year remains the fallback', () => {
    const out = projectSsByYear(claimAt70(), { from: 2028, to: 2028 });
    const expected = 2000 * ADJ_70 * Math.pow(1.02, 2028 - 2018) * 12;
    expect(out[0].total).toBeCloseTo(expected, 1);
  });

  it('monthly engine uses the same statement anchor', () => {
    const annual = projectSsByYear(claimAt70(2026), { from: 2028, to: 2028 });
    const monthly = projectSsByMonth(claimAt70(2026), { from: 2028, to: 2028 });
    const mean =
      monthly.filter((p) => p.year === 2028).reduce((a, p) => a + p.total, 0) / 12;
    expect(mean).toBeCloseTo(annual[0].total, 0);
  });
});

// Earnings test: grace year, FRA year (actual monthly earnings) and FRA restoration of withheld months (ARF).
describe('projectSsByYear — grace-year monthly earnings test', () => {
  // Born 1964-07-15 → benefit month0 6, FRA 67; claim 62 → July 2026 (grace year; prorated gross 0.7 × $1,200 × 12 × 6/12 = $5,040). Retires mid-year: works Jan–Jun at $15k/mo.
  const graceCtx = (withMonthly: boolean): SsContext => ({
    primary: {
      id: 'p',
      payload: member({ birthdate: '1964-07-15' }),
      pia: 1200,
      claimAge: claimAge(62),
      lifeExpectancyAge: 95,
      earnedIncomeByYear: { 2026: 90_000 },
      ...(withMonthly
        ? {
            earnedIncomeMonthlyByYear: {
              2026: [15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 0, 0, 0, 0, 0, 0],
            },
          }
        : {}),
    },
    colaPct: 0,
    benefitReductionPct: 0,
    earningsTestInflationRatePct: 0,
  });

  it('midyear retiree with high pre-claim wages keeps the full grace-year benefit', () => {
    const out = projectSsByYear(graceCtx(true), { from: 2026, to: 2026 });
    expect(out[0].total).toBeCloseTo(5_040, 0);
  });

  it('without monthly earnings the annual test wipes the same benefit (fallback)', () => {
    const out = projectSsByYear(graceCtx(false), { from: 2026, to: 2026 });
    // Annual $1/$2 over the 2026 lower limit ($24,480): excess $65,520 caps withholding at the whole $5,040 benefit.
    expect(out[0].total).toBe(0);
  });
});

describe('projectSsByYear — FRA-year actual monthly earnings', () => {
  // Born 1959-11-15 → FRA 66y10m; FRA month Sep 2026 (fraMonth0 = 8).
  // Claimed at 62 (2021). 2026 earnings: $10k/mo Jan–Aug, $50k/mo Sep–Dec.
  const fraYearCtx: SsContext = {
    primary: {
      id: 'p',
      payload: member({ birthdate: '1959-11-15' }),
      pia: 1200,
      claimAge: claimAge(62),
      lifeExpectancyAge: 95,
      earnedIncomeByYear: { 2026: 280_000 },
      earnedIncomeMonthlyByYear: {
        2026: [
          10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000,
          50_000, 50_000, 50_000, 50_000,
        ],
      },
    },
    colaPct: 0,
    benefitReductionPct: 0,
    earningsTestInflationRatePct: 0,
  };

  it('only the dollars actually earned before the FRA month count ($1/$3 over the higher limit)', () => {
    // Pre-FRA earnings $80,000, excess over $65,160 = $14,840 → $4,946.67 withheld against 8 checks at factor(802, 744) = 0.708333 ($850/mo).
    // 20 CFR 404.412: 6 whole checks credit with the FRA month (Sep), so Sep–Dec pay factor(802, 750) → $880/mo: 8 × $850 − $4,946.67 + 4 × $880 = $5,373.33.
    const out = projectSsByYear(fraYearCtx, { from: 2026, to: 2026 });
    expect(out[0].total).toBeCloseTo(8 * 850 - (80_000 - 65_160) / 3 + 4 * 880, 0);
    expect(out[0].total).toBeGreaterThan(0);
    // Not produced: the restored rate applied retroactively to the whole year ($10,560 − $4,946.67 = $5,613.33).
    expect(out[0].total).not.toBeCloseTo(10_200 - (80_000 - 65_160) / 3, 0);
    expect(out[0].total).not.toBeCloseTo(10_560 - (80_000 - 65_160) / 3, 0);
  });
});

describe('projectSsByYear — FRA restoration of withheld months (ARF)', () => {
  // Born 1964-01-15 → FRA 67 (2031). Claim 62 → Jan 2026, base $1,200 × 0.70 × 12 = $10,080; 2026 earnings $34,480 withhold $5,000 = 6 checks of $840.
  // From 2031 the reduction is recomputed as if the claim were 6 months later: factor(804, 750) = 1 − 0.2 − 18 × 5/1200 = 0.725 → $10,440/yr.
  const arfCtx = (withEarnings: boolean): SsContext => ({
    primary: {
      id: 'p',
      payload: member({ birthdate: '1964-01-15' }),
      pia: 1200,
      claimAge: claimAge(62),
      lifeExpectancyAge: 95,
      ...(withEarnings ? { earnedIncomeByYear: { 2026: 34_480 } } : {}),
    },
    colaPct: 0,
    benefitReductionPct: 0,
    earningsTestInflationRatePct: 0,
  });

  it('withheld months are restored at FRA: the benefit steps UP from the FRA year', () => {
    const out = projectSsByYear(arfCtx(true), { from: 2026, to: 2032 });
    const byYear = new Map(out.map((r) => [r.year, r.total]));
    expect(byYear.get(2026)).toBeCloseTo(10_080 - 5_000, 0);
    expect(byYear.get(2027)).toBeCloseTo(10_080, 0);
    expect(byYear.get(2030)).toBeCloseTo(10_080, 0);
    expect(byYear.get(2031)).toBeCloseTo(10_440, 0);
    expect(byYear.get(2032)).toBeCloseTo(10_440, 0);
  });

  it('no withholding → no restoration step (baseline unchanged at FRA)', () => {
    const out = projectSsByYear(arfCtx(false), { from: 2026, to: 2032 });
    const byYear = new Map(out.map((r) => [r.year, r.total]));
    expect(byYear.get(2030)).toBeCloseTo(10_080, 0);
    expect(byYear.get(2031)).toBeCloseTo(10_080, 0);
  });

  it('the monthly engine consumes the same ARF-adjusted base from the FRA year', () => {
    const annual = projectSsByYear(arfCtx(true), { from: 2026, to: 2032 });
    const monthly = projectSsByMonth(arfCtx(true), { from: 2026, to: 2032 });
    const annual2031 = annual.find((r) => r.year === 2031)!.total;
    const monthlyMean2031 =
      monthly.filter((p) => p.year === 2031).reduce((a, p) => a + p.total, 0) / 12;
    expect(monthlyMean2031).toBeCloseTo(annual2031, 0);
  });
});

// Only the actually-charged checks are reduced, never a flat annual factor smeared over non-service months.
describe('projectSsByMonth — month-indexed earnings-test schedule', () => {
  it('zeroes exactly the service-month checks and pays later months in full', () => {
    // Born 1964-07-15 → July benefit month, claim 62 → grace year 2026; works Jan–Aug at $5k/mo, so the grace-year test withholds the Jul + Aug service-month checks.
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1964-07-15' }),
        pia: 1200,
        claimAge: claimAge(62),
        lifeExpectancyAge: 95,
        earnedIncomeByYear: { 2026: 40_000 },
        earnedIncomeMonthlyByYear: {
          2026: [5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 0, 0, 0, 0],
        },
      },
      colaPct: 0,
      benefitReductionPct: 0,
      earningsTestInflationRatePct: 0,
    };
    const out = projectSsByMonth(ctx, { from: 2026, to: 2026 });
    const runRate = 1200 * 0.7 * 12; // $10,080/yr at the age-62 factor
    const aug = out.find((p) => p.year === 2026 && p.month0 === 7)!;
    const sep = out.find((p) => p.year === 2026 && p.month0 === 8)!;
    const dec = out.find((p) => p.year === 2026 && p.month0 === 11)!;
    expect(aug.total).toBe(0);
    // Sep–Dec are non-service months: full run-rate, not the old year-factor smear.
    expect(sep.total).toBeCloseTo(runRate, 0);
    expect(dec.total).toBeCloseTo(runRate, 0);
  });
});

// The earnings-test/ARF state warms up from the actual entitlement year, so a range starting after the withholding years still reflects it.
describe('projectSsByYear — pre-range warm-up of withheld months', () => {
  const arfCtx: SsContext = {
    primary: {
      id: 'p',
      payload: member({ birthdate: '1964-01-15' }),
      pia: 1200,
      claimAge: claimAge(62),
      lifeExpectancyAge: 95,
      earnedIncomeByYear: { 2026: 34_480 }, // $5,000 withheld → 6 checks
    },
    colaPct: 0,
    benefitReductionPct: 0,
    earningsTestInflationRatePct: 0,
  };

  it('a range starting at the FRA year still applies the 2026 ARF credits', () => {
    // Same fixture as the full-range ARF test: 6 months withheld in 2026 →
    // Same fixture as the full-range ARF test: starting at 2031 must not forget the 2026 withholding (ARF base $10,440).
    const out = projectSsByYear(arfCtx, { from: 2031, to: 2032 });
    expect(out[0].total).toBeCloseTo(10_440, 0);
    expect(out[1].total).toBeCloseTo(10_440, 0);
  });

  it('matches the full-range projection year for year', () => {
    const full = projectSsByYear(arfCtx, { from: 2026, to: 2032 });
    const partial = projectSsByYear(arfCtx, { from: 2030, to: 2032 });
    for (const row of partial) {
      const fullRow = full.find((r) => r.year === row.year)!;
      expect(row.total).toBeCloseTo(fullRow.total, 6);
    }
  });
});

// SSA effects the ARF with the FRA month (20 CFR 404.412), so the FRA year's base already reflects that year's pre-FRA deductions.
describe('projectSsByYear — same-year FRA restoration ordering', () => {
  it('FRA-year withholding feeds the FRA-year base, not just later years', () => {
    // Born 1964-07-15 → FRA July 2031; claim 62 (2026). 2031 earnings $190,320 → excess $30,000 → $10,000 withholding, capped by the 6 pre-FRA checks.
    // All 6 withheld → 6 ARF months → restored factor(804, 750) = 0.725 → $10,440/yr; the 2031 row = $10,440 − 6 × $870 = $5,220.
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1964-07-15' }),
        pia: 1200,
        claimAge: claimAge(62),
        lifeExpectancyAge: 95,
        earnedIncomeByYear: { 2031: 190_320 },
      },
      colaPct: 0,
      benefitReductionPct: 0,
      earningsTestInflationRatePct: 0,
    };
    const out = projectSsByYear(ctx, { from: 2031, to: 2032 });
    expect(out[0].total).toBeCloseTo(5_220, 0);
    // Pre-fix ordering used the un-restored base in the FRA year ($10,080 − $5,040 = $5,040).
    expect(out[0].total).not.toBeCloseTo(5_040, 0);
    expect(out[1].total).toBeCloseTo(10_440, 0);
  });
});

// The SSA grace year keys to the member's entitlement start (any benefit type): a survivor benefit starting before the own claim establishes it.
describe('projectSsByYear — survivor-entitlement grace year', () => {
  it('a midyear survivor start gets the grace-year monthly test before the own claim', () => {
    // Secondary born 1966-07-15, survivor claim 60 → survivor start July 2026 (spouse dies Dec 31 2025); own claim 67 (2033).
    // The old own-claim-only grace rule ran the bare annual test in 2026 and wiped the survivor checks with the Jan–Jun wages.
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1960-03-15', isPrimary: true }),
        pia: 3000,
        claimAge: claimAge(62), // claimed 2022, reduced RIB before death
        lifeExpectancyAge: 65, // dies Dec 31 2025
      },
      secondary: {
        id: 's',
        payload: { ...member({ birthdate: '1966-07-15' }), isPrimary: false },
        pia: 800,
        claimAge: claimAge(67),
        survivorClaimAge: claimAge(60),
        lifeExpectancyAge: 95,
        earnedIncomeByYear: { 2026: 90_000 },
        earnedIncomeMonthlyByYear: {
          2026: [15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 0, 0, 0, 0, 0, 0],
        },
      },
      colaPct: 0,
      benefitReductionPct: 0,
      earningsTestInflationRatePct: 0,
    };
    const out = projectSsByYear(ctx, { from: 2026, to: 2026 });
    // Widow base $3,000 (deceased claimed early; RIB-LIM caps at max(82.5% × $3,000 = $2,475, reduced RIB $2,100) = $2,475); early factor at 60 → reduction $855.00 → $2,145.
    // Start July → 6/12 of the year: $2,145 × 12 × 6/12 = $12,870, paid in full (post-start months are non-service).
    expect(out[0].byMember.secondary).toBeCloseTo(2_145 * 6, 0);
    expect(out[0].byMember.secondary).toBeGreaterThan(0);
  });
});

// Per-component ARF: the spousal-excess factor restores independently of the own RIB at the recipient's FRA.
describe('projectSsByYear — spousal-excess ARF restoration', () => {
  it('excess withheld months step the spousal factor up at the recipient FRA', () => {
    // Recipient (primary) born 1964-01-15, own PIA 0; worker (secondary) born 1960-01-15, PIA $2,000, claimed 62. Recipient claims 62 (Jan 2026): excess $1,000 × 0.65 = $650/mo.
    // 2026 earnings $34,480 → $5,000 withheld = 8 checks → 8 excess ARF months; from FRA (2031) factor(752) = 1 − 0.25 − 16 × 5/1200 = 0.683333 → $683.33/mo.
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1964-01-15', isPrimary: true }),
        pia: 0,
        claimAge: claimAge(62),
        lifeExpectancyAge: 95,
        earnedIncomeByYear: { 2026: 34_480 },
      },
      secondary: {
        id: 's',
        payload: { ...member({ birthdate: '1960-01-15' }), isPrimary: false },
        pia: 2_000,
        claimAge: claimAge(62),
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
      earningsTestInflationRatePct: 0,
    };
    const out = projectSsByYear(ctx, { from: 2030, to: 2031 });
    const y2030 = out.find((r) => r.year === 2030)!;
    const y2031 = out.find((r) => r.year === 2031)!;
    expect(y2030.byMember.primary).toBeCloseTo(7_800, 0);
    expect(y2031.byMember.primary).toBeCloseTo(8_200, 0);
  });
});

// 20 CFR 404.415(b)/404.434, §404.439: a worker's excess earnings charge the combined record (own check + spousal excess), apportioned proportionally: $20,160 + $9,360 with a $10,000 deduction pays $19,520.
describe('projectSsByYear — record-level charge of worker + spouse excess', () => {
  it('charges the $10,000 deduction once against the combined record checks (§404.439 apportionment)', () => {
    // Worker born 1962-01-15, PIA $2,400, claims 62: own $1,680/mo. Recipient born 1962-01-15, PIA 0, claims 62: excess $1,200 × 0.65 = $780/mo on the worker's record.
    // 2026 earnings $44,480 → $10,000 deduction against the record total $2,460/mo: Jan–Apr withheld ($9,840), May charged $160, so May pays (2,460 − 160)/2,460 of each component.
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1962-01-15', isPrimary: true }),
        pia: 2_400,
        claimAge: claimAge(62),
        lifeExpectancyAge: 95,
        earnedIncomeByYear: { 2026: 44_480 },
      },
      secondary: {
        id: 's',
        payload: { ...member({ birthdate: '1962-01-15' }), isPrimary: false },
        pia: 0,
        claimAge: claimAge(62),
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
      earningsTestInflationRatePct: 0,
    };
    const out = projectSsByYear(ctx, { from: 2026, to: 2026 });
    // §404.439 apportionment: the May factor applies to both components; paid months = 2,300/2,460 + 7 full.
    const paidMonths = (2_460 - 160) / 2_460 + 7;
    expect(out[0].byMember.primary).toBeCloseTo(1_680 * paidMonths, 0);
    expect(out[0].byMember.secondary).toBeCloseTo(780 * paidMonths, 0);
    expect(out[0].total).toBeCloseTo(29_520 - 10_000, 0);
    // Not produced: the deduction against the worker's own $20,160 alone, with its pay ratio reapplied to the excess, double-charges the family by about $4,643.
    expect(out[0].byMember.primary).not.toBeCloseTo(20_160 - 10_000, 0);
    expect(out[0].byMember.secondary).not.toBeCloseTo(9_360 * ((20_160 - 10_000) / 20_160), 0);
    expect(out[0].byMember.secondary).not.toBeCloseTo(9_360, 0);
  });
});

// 20 CFR 404.412(b): the ARF increase is effective only with the FRA month; paid pre-FRA checks stay at the original rate and the earnings test charges the original-rate checks.
describe('projectSsByYear — partial-deduction FRA year (mixed rates)', () => {
  // Born 1964-07-15 → FRA July 2031; claim 62 (July 2026) → original rate $1,200 × 0.70 = $840/mo.
  // 2031 earnings $11,910/mo Jan–Jun → $71,460 pre-FRA, excess over $65,160 = $6,300 → $2,100 withheld: Jan $840 + Feb $840 + Mar $420 → 3 ARF months.
  // Restored factor(804, 747) = 0.7125 → $855/mo, effective only from July.
  const ctx: SsContext = {
    primary: {
      id: 'p',
      payload: member({ birthdate: '1964-07-15' }),
      pia: 1200,
      claimAge: claimAge(62),
      lifeExpectancyAge: 95,
      earnedIncomeByYear: { 2031: 71_460 },
      earnedIncomeMonthlyByYear: {
        2031: [11_910, 11_910, 11_910, 11_910, 11_910, 11_910, 0, 0, 0, 0, 0, 0],
      },
    },
    colaPct: 0,
    benefitReductionPct: 0,
    earningsTestInflationRatePct: 0,
  };

  it('pays pre-FRA months at the original rate, FRA-month-onward at the restored rate', () => {
    const out = projectSsByYear(ctx, { from: 2031, to: 2032 });
    // Jan+Feb withheld, Mar half-paid ($420), Apr–Jun paid at $840,
    // Jul–Dec at the restored $855 → $8,070.
    expect(out[0].total).toBeCloseTo(420 + 3 * 840 + 6 * 855, 0);
    // Not produced: the restored rate retroactively over the whole year ($855 × 12 − $2,100 = $8,160).
    expect(out[0].total).not.toBeCloseTo(855 * 12 - 2_100, 0);
    expect(out[1].total).toBeCloseTo(855 * 12, 0);
  });

  it('reconciles exactly against the monthly engine month for month', () => {
    const annual = projectSsByYear(ctx, { from: 2031, to: 2031 });
    const monthly = projectSsByMonth(ctx, { from: 2031, to: 2031 });
    const rateOf = (m: number): number =>
      monthly.find((p) => p.year === 2031 && p.month0 === m)!.total;
    expect(rateOf(0)).toBe(0); // Jan — check withheld entirely
    expect(rateOf(2)).toBeCloseTo(840 * 12 * 0.5, 0); // Mar — half a check, ORIGINAL rate
    expect(rateOf(3)).toBeCloseTo(840 * 12, 0); // Apr — paid at the ORIGINAL rate
    expect(rateOf(6)).toBeCloseTo(855 * 12, 0); // Jul (FRA month) — restored rate
    expect(rateOf(11)).toBeCloseTo(855 * 12, 0);
    const mean = monthly.reduce((a, p) => a + p.total, 0) / 12;
    expect(mean).toBeCloseTo(annual[0].total, 6);
  });
});

// The spousal-excess payment and its credited ARF months derive from one combined per-month schedule (min of the recipient's and worker-record charges), over entitled months only.
describe('projectSsByYear — combined per-month excess schedule', () => {
  it('disjoint recipient/worker service months: every charged month reduces the excess once', () => {
    // Recipient born 1964-01-15, PIA 0 → excess $780/mo from Jan 2026; works Jul+Aug at $30k → the schedule zeroes 2 checks.
    // Worker born 1962-01-15, PIA $2,400, claimed 62 (2024): own $1,680; $9,520 deduction against the record pool $2,460/mo → Jan–Mar full + Apr partial (320/2,460).
    // Combined min-schedule charges Jan–Apr and Jul+Aug: excess paid = $780 × (320/2,460 + 6), never an annual-factor smear.
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1964-01-15', isPrimary: true }),
        pia: 0,
        claimAge: claimAge(62),
        lifeExpectancyAge: 95,
        earnedIncomeByYear: { 2026: 60_000 },
        earnedIncomeMonthlyByYear: {
          2026: [0, 0, 0, 0, 0, 0, 30_000, 30_000, 0, 0, 0, 0],
        },
      },
      secondary: {
        id: 's',
        payload: { ...member({ birthdate: '1962-01-15' }), isPrimary: false },
        pia: 2_400,
        claimAge: claimAge(62),
        lifeExpectancyAge: 95,
        earnedIncomeByYear: { 2026: 43_520 },
      },
      colaPct: 0,
      benefitReductionPct: 0,
      earningsTestInflationRatePct: 0,
    };
    const out = projectSsByYear(ctx, { from: 2026, to: 2026 });
    const aprFactor = 320 / 2_460; // Apr pays (2,460 − 2,140)/2,460 (§404.439)
    expect(out[0].byMember.secondary).toBeCloseTo(1_680 * (aprFactor + 8), 0);
    // Excess: Jan–Mar 0, Apr partial, May–Jun full, Jul–Aug 0 (recipient's grace months), Sep–Dec full.
    expect(out[0].byMember.primary).toBeCloseTo(780 * (aprFactor + 6), 0);
    expect(out[0].total).toBeCloseTo(29_520 - 9_520 - 1_560, 0);
    expect(out[0].byMember.primary).not.toBeCloseTo(9_360 * (10_640 / 20_160), 0);
    // 6 combined charged months credit the spousal ARF: factor(804, 750) = 0.675 → $810/mo → $9,720 from FRA 2031.
    const fra = projectSsByYear(ctx, { from: 2031, to: 2031 });
    expect(fra[0].byMember.primary).toBeCloseTo(9_720, 0);
    expect(fra[0].byMember.primary).not.toBeCloseTo(9_840, 0); // 8-month credit shape
  });

  it('withholding before the excess activates neither reduces the excess nor credits its ARF', () => {
    // Recipient born 1964-01-15, PIA $800, claims 62: own $560/mo. Worker born 1959-07-15 claims 67 → the excess ($400 × 0.675 = $270/mo) activates in JULY.
    // The recipient's grace service months Feb+Mar precede activation, so the excess is paid in full and no excess-ARF months accrue.
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1964-01-15', isPrimary: true }),
        pia: 800,
        claimAge: claimAge(62),
        lifeExpectancyAge: 95,
        earnedIncomeByYear: { 2026: 60_000 },
        earnedIncomeMonthlyByYear: {
          2026: [0, 30_000, 30_000, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        },
      },
      secondary: {
        id: 's',
        payload: { ...member({ birthdate: '1959-07-15' }), isPrimary: false },
        pia: 2_400,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
      earningsTestInflationRatePct: 0,
    };
    // 2026: own checks Feb+Mar withheld ($1,120), the Jul–Dec excess intact:
    // (12 × $560 − $1,120) + 6 × $270 = $7,220.
    const out = projectSsByYear(ctx, { from: 2026, to: 2026 });
    expect(out[0].byMember.primary).toBeCloseTo(12 * 560 - 1_120 + 6 * 270, 0);
    // FRA year 2031: the own base restores with 2 credits (0.708333 → $6,800.04/yr) but the spousal factor keeps its at-activation 0.675 ($3,240/yr).
    const fra = projectSsByYear(ctx, { from: 2031, to: 2031 });
    expect(fra[0].byMember.primary).toBeCloseTo(6_800 + 3_240, 0);
    // Crediting max(own 2, worker 0) = 2 excess months instead gives 0.683333 → $10,080.04: must not match.
    expect(fra[0].byMember.primary).not.toBeCloseTo(6_800 + 3_280, 0);
  });
});

// The FRA-year restoration also fires when the only withholding is the spousal excess charged by the worker's earnings test (20 CFR 404.415(b)); it restores at the recipient's FRA month.
describe('projectSsByYear — worker-only excess withholding in the recipient FRA year', () => {
  // Recipient born 1964-07-15 → FRA July 2031, PIA 0 (spousal-only), claims 62, no earnings. Worker born 1966-01-15, PIA $2,400, claims 62 (Jan 2028): excess starts at 762 months, factor 0.725 → $870/mo.
  // Worker earns $44,480 in 2031 → $10,000 deduction on the record pool ($1,680 + $870 = $2,550/mo): Jan–Mar full + Apr $2,350 → 4 months, charging the excess too.
  // 4 ARF credits → factor(766) = 0.741667 → $890/mo, effective at the recipient's FRA month (July 2031).
  const ctx: SsContext = {
    primary: {
      id: 'p',
      payload: member({ birthdate: '1964-07-15', isPrimary: true }),
      pia: 0,
      claimAge: claimAge(62),
      lifeExpectancyAge: 95,
    },
    secondary: {
      id: 's',
      payload: { ...member({ birthdate: '1966-01-15' }), isPrimary: false },
      pia: 2_400,
      claimAge: claimAge(62),
      lifeExpectancyAge: 95,
      earnedIncomeByYear: { 2031: 44_480 },
    },
    colaPct: 0,
    benefitReductionPct: 0,
    earningsTestInflationRatePct: 0,
  };
  // Apr pays (2,550 − 2,350)/2,550 of each record component (§404.439).
  const workerAprFactor = 200 / 2_550;

  it('restores the excess-based ARF at the recipient FRA month in the SAME year', () => {
    const out = projectSsByYear(ctx, { from: 2030, to: 2032 });
    expect(out[0].byMember.primary).toBeCloseTo(10_440, 0);
    // 2031: Jan–Mar excess withheld, Apr partial, May–Jun at $870, Jul–Dec at the restored $890/mo.
    expect(out[1].byMember.primary).toBeCloseTo(
      870 * workerAprFactor + 2 * 870 + 6 * 890,
      0,
    );
    // Pre-fix: no same-year rerun, so the whole year stayed at $870/mo.
    expect(out[1].byMember.primary).not.toBeCloseTo(
      870 * workerAprFactor + 2 * 870 + 6 * 870,
      0,
    );
    expect(out[2].byMember.primary).toBeCloseTo(10_680, 0);
    expect(out[1].byMember.secondary).toBeCloseTo(1_680 * (workerAprFactor + 8), 0);
    expect(out[1].byMember.secondary).not.toBeCloseTo(20_160 - 10_000, 0);
  });

  it('monthly engine: the restored excess base takes over exactly at the FRA month', () => {
    const monthly = projectSsByMonth(ctx, { from: 2031, to: 2031 });
    const rateOf = (m: number): number =>
      monthly.find((p) => p.year === 2031 && p.month0 === m)!.byMember.primary;
    expect(rateOf(0)).toBe(0); // Jan — excess check withheld (worker charge)
    expect(rateOf(3)).toBeCloseTo(10_440 * workerAprFactor, 0); // Apr — partial
    expect(rateOf(5)).toBeCloseTo(10_440, 0); // Jun — full, PRE-restoration rate
    expect(rateOf(6)).toBeCloseTo(10_680, 0); // Jul (recipient FRA month) — restored
    expect(rateOf(6)).not.toBeCloseTo(10_440, 0); // pre-fix: restoration delayed to 2032
    expect(rateOf(11)).toBeCloseTo(10_680, 0);
    const annual = projectSsByYear(ctx, { from: 2031, to: 2031 });
    const mean = monthly.reduce((a, p) => a + p.byMember.primary, 0) / 12;
    expect(mean).toBeCloseTo(annual[0].byMember.primary, 6);
  });
});

// The earnings-test/ARF warm-up covers a survivor entitlement that begins before either member's own claim year.
describe('projectSsByYear — survivor-entitlement warm-up + own-RIB ARF gating', () => {
  // Primary born 1960-03-15 dies Dec 31 2025 never having claimed → widow base is the full PIA $400. Secondary born 1966-07-15, PIA $2,000, own claim 62 (July 2028), survivor claim 60 → start July 2026.
  // Widow amount $400 − roundUpToDime($400 × 0.285) = $286/mo. 2026 earnings $34,480 withhold all 6 survivor checks, credited to no component (survivor-factor ARF is not modeled).
  // 2029 earnings $28,480 → $2,000 withheld from the $1,400 own checks (Jan full + Feb partial) → 2 own-entitled ARF months.
  const ctx: SsContext = {
    primary: {
      id: 'p',
      payload: member({ birthdate: '1960-03-15', isPrimary: true }),
      pia: 400,
      claimAge: claimAge(67),
      lifeExpectancyAge: 65,
    },
    secondary: {
      id: 's',
      payload: { ...member({ birthdate: '1966-07-15' }), isPrimary: false },
      pia: 2_000,
      claimAge: claimAge(62),
      survivorClaimAge: claimAge(60),
      lifeExpectancyAge: 95,
      earnedIncomeByYear: { 2026: 34_480, 2029: 28_480 },
    },
    colaPct: 0,
    benefitReductionPct: 0,
    earningsTestInflationRatePct: 0,
  };

  it('a range starting at the FRA year still applies the pre-range OWN ARF credits, and survivor-only withheld months restore nothing', () => {
    const full = projectSsByYear(ctx, { from: 2026, to: 2035 });
    const partial = projectSsByYear(ctx, { from: 2033, to: 2035 });
    for (const row of partial) {
      const fullRow = full.find((r) => r.year === row.year)!;
      expect(row.byMember.secondary).toBeCloseTo(fullRow.byMember.secondary ?? 0, 6);
    }
    // FRA year 2033 (July): Jan–Jun at $1,400/mo; Jul–Dec restored with only the 2 own-entitled credits: factor(804, 746) = 0.708333 → $1,416.67/mo → $16,900.
    expect(partial[0].byMember.secondary).toBeCloseTo(6 * 1_400 + 6 * 1_416.67, 0);
    // Negative: the 6 survivor-only 2026 months must not inflate the own RIB (8 credits would give $17,200).
    expect(partial[0].byMember.secondary).not.toBeCloseTo(6 * 1_400 + 6 * 1_466.67, 0);
    // Warm-up negative: starting the warm-up at the range start forgets the 2029 withholding → $16,800 flat.
    expect(partial[0].byMember.secondary).not.toBeCloseTo(12 * 1_400, 0);
  });
});

// One grace year per continuous entitlement (20 CFR 404.435(b)(2), POMS RS 02501.030): only the first-ever entitlement start establishes it.
describe('projectSsByYear — single grace year per continuous entitlement', () => {
  it('an uninterrupted own claim into a later survivor start gets NO second grace year', () => {
    // Deceased (primary) born 1960-03-15, PIA $2,000, claims at FRA 67 and dies Dec 31 2030. Survivor (secondary) born 1968-07-15, PIA $1,000, own claim 62 → July 2030; survivor claim 64 → July 2032, own entitlement unbroken into it.
    // Widow amount $2,000 − roundUpToDime($2,000 × 0.285 × 36/84) = $1,755.70/mo from July 2032.
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1960-03-15', isPrimary: true }),
        pia: 2_000,
        claimAge: claimAge(67),
        lifeExpectancyAge: 70,
      },
      secondary: {
        id: 's',
        payload: { ...member({ birthdate: '1968-07-15' }), isPrimary: false },
        pia: 1_000,
        claimAge: claimAge(62),
        survivorClaimAge: claimAge(64),
        lifeExpectancyAge: 95,
        earnedIncomeByYear: { 2032: 36_000 },
        earnedIncomeMonthlyByYear: {
          2032: [6_000, 6_000, 6_000, 6_000, 6_000, 6_000, 0, 0, 0, 0, 0, 0],
        },
      },
      colaPct: 0,
      benefitReductionPct: 0,
      earningsTestInflationRatePct: 0,
    };
    // 2032 is not a grace year, so the annual test charges from January: excess ($36,000 − $24,480)/2 = $5,760; paid = 6 × $700 + 6 × $1,755.70 − $5,760 = $8,974.20.
    const out = projectSsByYear(ctx, { from: 2032, to: 2032 });
    expect(out[0].byMember.secondary).toBeCloseTo(6 * 700 + 6 * 1_755.7 - 5_760, 0);
    // Pre-fix: the survivor start re-granted a grace year, paying the year in full.
    expect(out[0].byMember.secondary).not.toBeCloseTo(6 * 700 + 6 * 1_755.7, 0);
    // The monthly engine agrees: January's own check is charged.
    const monthly = projectSsByMonth(ctx, { from: 2032, to: 2032 });
    const rateOf = (m: number): number =>
      monthly.find((p) => p.year === 2032 && p.month0 === m)!.byMember.secondary ?? 0;
    expect(rateOf(0)).toBe(0); // Jan — charged in full
    const mean = monthly.reduce((a, p) => a + (p.byMember.secondary ?? 0), 0) / 12;
    expect(mean).toBeCloseTo(out[0].byMember.secondary ?? 0, 6);
  });

  it('survivor-first entitlement: the survivor start year IS the grace year, the later own claim gets none', () => {
    // Deceased (primary) born 1960-03-15, PIA $3,000, claimed 62, dies Dec 31 2025. Survivor born 1966-07-15, PIA $800: survivor claim 60 → July 2026 (first entitlement); own claim 64 → July 2030, widow entitlement unbroken.
    // Widow amount $2,145/mo (RIB-LIM cap $2,475 not binding); own at 64 = $640/mo, so every check stays at the survivor level.
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1960-03-15', isPrimary: true }),
        pia: 3_000,
        claimAge: claimAge(62),
        lifeExpectancyAge: 65,
      },
      secondary: {
        id: 's',
        payload: { ...member({ birthdate: '1966-07-15' }), isPrimary: false },
        pia: 800,
        claimAge: claimAge(64),
        survivorClaimAge: claimAge(60),
        lifeExpectancyAge: 95,
        earnedIncomeByYear: { 2026: 90_000, 2030: 90_000 },
        earnedIncomeMonthlyByYear: {
          2026: [15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 0, 0, 0, 0, 0, 0],
          2030: [15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 0, 0, 0, 0, 0, 0],
        },
      },
      colaPct: 0,
      benefitReductionPct: 0,
      earningsTestInflationRatePct: 0,
    };
    const out = projectSsByYear(ctx, { from: 2026, to: 2030 });
    const byYear = new Map(out.map((r) => [r.year, r.byMember.secondary ?? 0]));
    // 2026, the first-entitlement grace year: Jul–Dec are non-service months, so the survivor checks pay in full.
    expect(byYear.get(2026)).toBeCloseTo(6 * 2_145, 0);
    // 2030: no second grace year, so the annual test withholds ($90,000 − $24,480)/2 = $32,760, capped at 12 × $2,145 = $25,740: everything.
    expect(byYear.get(2030)).toBeCloseTo(0, 6);
    expect(byYear.get(2030)).not.toBeCloseTo(12 * 2_145, 0);
  });
});

// The grace year is the first entitled year containing a non-service month (POMS RS 02501.030): a claimant working over the limit all through the first year gets it in the first later year with one.
describe('projectSsByYear — grace year deferred past an all-service entitlement year', () => {
  // Born 1964-07-15, claim 62 → July 2026 (checks $840). 2026: works $15k/mo all year, so every entitled month is a service month and 2026 is not the grace year. 2027: works Jan–Jun, retires July → 2027 is.
  const ctx: SsContext = {
    primary: {
      id: 'p',
      payload: member({ birthdate: '1964-07-15' }),
      pia: 1200,
      claimAge: claimAge(62),
      lifeExpectancyAge: 95,
      earnedIncomeByYear: { 2026: 180_000, 2027: 90_000 },
      earnedIncomeMonthlyByYear: {
        2026: [
          15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000,
          15_000, 15_000, 15_000, 15_000,
        ],
        2027: [15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 0, 0, 0, 0, 0, 0],
      },
    },
    colaPct: 0,
    benefitReductionPct: 0,
    earningsTestInflationRatePct: 0,
  };

  it('applies the grace-year monthly test to the second year, not the all-service first year', () => {
    const out = projectSsByYear(ctx, { from: 2026, to: 2028 });
    // 2026: every entitled check withheld (annual excess $77,760 caps at 6 × $840).
    expect(out[0].total).toBe(0);
    // 2027, the grace year: the monthly test pays Jul–Dec in full ($840 × 6 = $5,040); the annual test would wipe all 12 checks.
    expect(out[1].total).toBeCloseTo(6 * 840, 0);
    expect(out[1].total).not.toBe(0);
    expect(out[2].total).toBeCloseTo(12 * 840, 0);
    const monthly = projectSsByMonth(ctx, { from: 2027, to: 2027 });
    const rateOf = (m: number): number =>
      monthly.find((p) => p.year === 2027 && p.month0 === m)!.total;
    expect(rateOf(0)).toBe(0);
    expect(rateOf(6)).toBeCloseTo(840 * 12, 0);
    const mean = monthly.reduce((a, p) => a + p.total, 0) / 12;
    expect(mean).toBeCloseTo(out[1].total, 6);
  });
});

// Own claim and survivor start in the same midyear: the annual table composes the year month-wise, matching the monthly engine instead of blending an already-prorated own benefit into the survivor fraction.
describe('projectSsByYear — own claim + survivor start in the same midyear', () => {
  // Primary born 1960-03-15, PIA $3,000, claims at FRA 67 (Mar 2027), dies Dec 31 2027 (no RIB-LIM). Secondary born 1966-07-01 (June benefit month), PIA $1,000: own claim 62 → June 2028 ($700/mo); survivor claim 62y4m → Oct 2028.
  // Widow amount = $3,000 − roundUpToDime($3,000 × 0.19) = $2,430/mo.
  const ctx: SsContext = {
    primary: {
      id: 'p',
      payload: member({ birthdate: '1960-03-15', isPrimary: true }),
      pia: 3_000,
      claimAge: claimAge(67),
      lifeExpectancyAge: 67,
    },
    secondary: {
      id: 's',
      payload: { ...member({ birthdate: '1966-07-01' }), isPrimary: false },
      pia: 1_000,
      claimAge: claimAge(62),
      survivorClaimAge: claimAge(62, 4),
      lifeExpectancyAge: 95,
    },
    colaPct: 0,
    benefitReductionPct: 0,
  };

  it('annual total equals the monthly engine mean (no double-counted own months)', () => {
    const annual = projectSsByYear(ctx, { from: 2028, to: 2028 });
    const monthly = projectSsByMonth(ctx, { from: 2028, to: 2028 });
    const mean = monthly.reduce((a, p) => a + p.total, 0) / 12;
    // Jun–Sep pay the own benefit ($700/mo), Oct–Dec step up to the
    // survivor level ($2,430/mo): 4 × $700 + 3 × $2,430 = $10,090.
    expect(annual[0].byMember.secondary).toBeCloseTo(4 * 700 + 3 * 2_430, 0);
    expect(annual[0].byMember.secondary).toBeCloseTo(mean, 6);
    // The retired fraction blend current + (sv − current) × 3/12 gave $10,965.
    expect(annual[0].byMember.secondary).not.toBeCloseTo(10_965, 0);
  });
});
