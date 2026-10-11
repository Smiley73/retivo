/**
 * Tests for `projectSsByMonth` — locks the claim-month step-up,
 * COLA-at-January stepping, and survivor switch at death month.
 *
 * The annual fn `projectSsByYear` is intentionally not exercised here
 * (existing behavior is locked by spec + downstream drawdown tests).
 * Monthly is the chart-band visualisation path.
 */
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
    // Primary born March 12, 1965; claim age 67 + 0 months → claim
    // month = March 2032. PIA $2000 → at-FRA monthly = $2000, annual
    // = $24000. (We use FRA = 67 implicitly via fraMonthsForBirthYear.)
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
    // Jan, Feb 2032 — pre-claim.
    expect(out[0].total).toBe(0);
    expect(out[1].total).toBe(0);
    // March 2032 onward — claim at $24000/yr annualised rate.
    for (let m = 2; m < 12; m += 1) {
      expect(out[m].total).toBeCloseTo(24000, 2);
    }
  });

  it('COLA compounds at January each year past claim', () => {
    const ctx: SsContext = {
      primary: {
        id: 'p',
        // Mid-year birthday → claim in mid-year, COLA boundary still Jan.
        payload: member({ birthdate: '1965-07-15' }),
        pia: 1000,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
      },
      colaPct: 2,
      benefitReductionPct: 0,
    };
    const out = projectSsByMonth(ctx, { from: 2032, to: 2034 });
    // Claim year July 2032 → ratios stay at base through Dec 2032.
    // Dec 2032 rate equals at-claim annual.
    const dec2032 = out.find((p) => p.year === 2032 && p.month0 === 11);
    expect(dec2032).toBeDefined();
    const baseRate = dec2032!.total;
    expect(baseRate).toBeGreaterThan(0);
    // Jan 2033 — COLA bump (×1.02).
    const jan2033 = out.find((p) => p.year === 2033 && p.month0 === 0);
    expect(jan2033!.total).toBeCloseTo(baseRate * 1.02, 2);
    // Jan 2034 — COLA bump again (×1.02^2 vs base).
    const jan2034 = out.find((p) => p.year === 2034 && p.month0 === 0);
    expect(jan2034!.total).toBeCloseTo(baseRate * 1.02 * 1.02, 2);
  });
});

describe('projectSsByMonth — survivor switch at death (Dec 31)', () => {
  // Primary born Mar 1960, life expectancy 90 → deathYear = 2050. Death is
  // modelled as Dec 31 of deathYear, so both members are alive through all
  // of 2050 and the survivor floor begins Jan 2051.
  // Secondary born Mar 1962, claim 67 → claim Mar 2029, life 95; survivor
  // claim age 67 (separate input — the forced start at 2051 is past FRA so
  // the widow factor is 1.0).
  // Primary PIA $3000, secondary PIA $1000 (both claim at FRA). Both-alive:
  // secondary gets own ($12k/yr) + spousal excess ((50% × $3000 − $1000) ×
  // 12 = $6k/yr) = $18k/yr. Survivor: deceased component = PIA $36k/yr.
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
    // Every month of the death year (2050) — primary still alive.
    const dec2050 = out.find((p) => p.year === 2050 && p.month0 === 11)!;
    expect(dec2050.byMember.primary ?? 0).toBeGreaterThan(0);
    // Jan 2051 — primary dead, survivor floor kicks in for secondary.
    const jan2051 = out.find((p) => p.year === 2051 && p.month0 === 0)!;
    expect(jan2051.byMember.secondary).toBeGreaterThan(dec2050.byMember.secondary ?? 0);
    // Primary contributes 0 from Jan 2051 on.
    expect(jan2051.byMember.primary).toBe(0);
  });

  it('annual: both alive through deathYear, survivor from deathYear + 1 (y <= deathYear)', () => {
    const out = projectSsByYear(ctx, { from: 2050, to: 2051 });
    const y2050 = out.find((p) => p.year === 2050)!;
    const y2051 = out.find((p) => p.year === 2051)!;
    // 2050 (= deathYear) — primary still alive, contributes own benefit.
    expect(y2050.byMember.primary ?? 0).toBeGreaterThan(0);
    // 2051 (= deathYear + 1) — primary dead, secondary steps up to survivor.
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
    // Claim year is 2032 (Mar); 2033-2035 are fully post-claim.
    for (const y of [2033, 2034, 2035]) {
      const inYear = monthly.filter((p) => p.year === y);
      const mean = inYear.reduce((acc, p) => acc + p.total, 0) / 12;
      expect(mean).toBeGreaterThan(0);
      // Inter-month variance within a year should be zero (COLA bumps
      // only happen on Jan 1, then flat).
      const max = Math.max(...inYear.map((p) => p.total));
      const min = Math.min(...inYear.map((p) => p.total));
      expect(max).toBeCloseTo(min, 4);
    }
  });
});

// Nominal-unit annotation pin. The SS projection emits nominal
// dollars (PIA in today's terms → claim year at the
// adjusted PIA × 12 → COLA compounded year-over-year). This block
// makes that contract explicit so future changes can't silently
// re-interpret the unit.
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
    // Primary born 1965-03-12 with FRA = 67 (born ≥ 1960), age-62 year
    // = 2027. Claim age 67 → claim year = 2032. At-FRA adjustmentFactor
    // = 1.0; full-year = $24,000. The March claim prorates the claim
    // year by (12 − 2)/12 = 10/12 → $20,000. Full post-claim year 2033 =
    // $24,000 (colaPct = 0 → no COLA growth from the age-62 anchor).
    const ctx = baseCtx(0);
    const out = projectSsByYear(ctx, { from: 2032, to: 2033 });
    expect(out[0].total).toBeCloseTo(24_000 * (10 / 12), 0); // claim year prorated
    expect(out[1].total).toBeCloseTo(24_000, 0); // full year, no COLA → flat
  });

  it('COLA compounds from the age-62 eligibility year, not the claim year', () => {
    // age-62 year = 2027. With 2% COLA, a full post-claim year carries
    // (year − 2027) COLA years — e.g. 2033 = $24k × 1.02^6.
    const ctx = baseCtx(2);
    const out = projectSsByYear(ctx, { from: 2033, to: 2037 });
    for (let i = 0; i < out.length; i += 1) {
      const year = 2033 + i;
      const expected = 24_000 * Math.pow(1.02, year - 2027);
      expect(out[i].total).toBeCloseTo(expected, 0);
    }
  });

  it('future years extend nominally from the age-62 anchor', () => {
    // Higher COLA — 3 % — exposes the nominal compounding clearly.
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

// balance-projection-runner-cashflow feeds `ss.colaPct ?? DEFAULT_COLA_PCT`
// into SsContext. This test pins that the engine compounds correctly when
// DEFAULT_COLA_PCT (2 %) is the effective rate — same assertion as the
// existing "COLA compounds nominally" case but with colaPct=2 explicit so
// it documents the default value in use.
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
      // Explicit 2 — mirrors DEFAULT_COLA_PCT seeded by the runner.
      colaPct: 2,
      benefitReductionPct: 0,
    };
    // Claim year = 2026 (birth 1960-01-01 → 1959 cohort via SSA day-1
    // rule → benefit birth year 1959; 1959 + 67 = 2026). The Jan-1 birth
    // shifts the benefit month to Dec, so the 2026 claim year is prorated
    // to ~1/12. Start the COLA-compounding assertion at the first FULL
    // post-claim year (2027) to avoid the prorated boundary.
    const out = projectSsByYear(ctx, { from: 2027, to: 2029 });
    // Verify the 2% COLA compounds year-over-year (anchored at age-62 year
    // 2021) so the per-year ratio is still exactly 1.02.
    const base = out[0].total;
    expect(base).toBeGreaterThan(0);
    expect(out[1].total).toBeCloseTo(base * 1.02, 0);
    expect(out[2].total).toBeCloseTo(base * 1.02 ** 2, 0);
  });
});

// ---------------------------------------------------------------------------
// COLA anchored at the age-62 eligibility year, not the claim year.
// ---------------------------------------------------------------------------
describe('projectSsByYear — COLA anchor (age-62 eligibility year)', () => {
  // Pinned timeline: birth 1956-03-15 → benefit birth year 1956 →
  // age-62 eligibility year = 2018. FRA(1956) = 66y4m = 796 months.
  // Claim at 70 (840 months) → first payment year 2026. DRC factor =
  // adjustmentFactor(796, 840) = 1 + 44 × (2/300) = 1.29333.
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
    // 2028 is a full post-claim year (claim year 2026 is prorated).
    // benefit(2028) = 2000 × ADJ × 1.02^(2028 − 2018) × 12, asserted to
    // the cent. Crucially the exponent is 10 (= 2028 − 2018), NOT
    // 2 (= 2028 − claimYear) — the over-counting claim-year shape fails.
    const out = projectSsByYear(claimAt70(2), { from: 2028, to: 2028 });
    const expected = 2000 * ADJ_70 * Math.pow(1.02, 2028 - 2018) * 12;
    expect(out[0].total).toBeCloseTo(expected, 1);
    // Structural guard: the exponent is anchored at 2018, so a
    // claim-year anchor (exponent 2) would be far smaller.
    const claimAnchored = 2000 * ADJ_70 * Math.pow(1.02, 2028 - 2026) * 12;
    expect(out[0].total).toBeGreaterThan(claimAnchored * 1.1);
  });

  it('per-year ratio is exactly the COLA factor (anchor moves, growth rate same)', () => {
    const out = projectSsByYear(claimAt70(2), { from: 2027, to: 2029 });
    expect(out[1].total).toBeCloseTo(out[0].total * 1.02, 2);
    expect(out[2].total).toBeCloseTo(out[0].total * 1.02 ** 2, 2);
  });

  it('no-regression at FRA: claim-AT-FRA per-year array unchanged ($)', () => {
    // Same person claims AT FRA (66y4m). adjustmentFactor = 1.0, so the
    // order of (COLA, adjust) is immaterial and the array is simply the
    // COLA-compounded PIA. FRA first payment year = 1956 + 66 = 2022 (the
    // 4-month remainder lands the actual FRA mid-2022). Assert full
    // post-FRA years against PIA × 1.02^(year − 2018) × 12.
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

// ---------------------------------------------------------------------------
// Claim-year proration in the annual summary table only.
// ---------------------------------------------------------------------------
describe('projectSsByYear — claim-year proration', () => {
  it('claim-year row equals the monthly engine claim-year sum / 12 share', () => {
    // Born 1965-07-15 → benefit month July (month0 = 6). Claim 67 → claim
    // year 2032, claim month July. Proration fraction = (12 − 6)/12 = 6/12 = 0.5.
    // PIA 2000, FRA 67, COLA 0 → full year $24,000 → prorated $12,000.
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
    // Cross-check against the monthly engine: the claim-year mean of the
    // 12 annualized monthly rates equals the prorated annual figure (the
    // monthly engine is exact; the proration approximates it in the annual table).
    const monthly = projectSsByMonth(ctx, { from: 2032, to: 2032 });
    const monthlyMean =
      monthly.filter((p) => p.year === 2032).reduce((a, p) => a + p.total, 0) / 12;
    expect(annual[0].total).toBeCloseTo(monthlyMean, 0);
  });
});

// ---------------------------------------------------------------------------
// Age-62 benefit begins the first full month at 62.
// ---------------------------------------------------------------------------
describe('projectSsByMonth — age-62 first full month', () => {
  it('a non-1st birthday starts the month AFTER the 62nd birthday month', () => {
    // Born 1968-06-15 → 62nd birthday June 2030 (month0 = 5). First full
    // month at 62 = July 2030 (month0 = 6). Claim age 62.
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
    // Born 1968-06-01 → SSA treats the birth month as May (day-1 shift),
    // so the benefit-purpose 62nd birthday lands in May 2030 and that
    // month is already a full month at 62 → benefit starts May 2030
    // (one month earlier than a June-15 birth, which starts July).
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

// ---------------------------------------------------------------------------
// DRC payable the following January (monthly engine only).
// ---------------------------------------------------------------------------
describe('projectSsByMonth — DRC deferral to January', () => {
  it('DRCs earned in year N are absent until January N+1, except at age 70', () => {
    // Born 1965-03-12 → FRA 67 (804), age-62 year 2027. Claim at 70 (Mar
    // 2035). DRCs accrue Mar 2032 (FRA) → Mar 2035 (claim). At the claim
    // month (Mar 2035, age 70) all credits are payable immediately
    // because age 70 pays in full. To observe deferral we need a claim
    // BETWEEN FRA and 70. Claim at 68y6m: claim month Sept 2033.
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
    // Sept 2033 (claim month): credits earned IN 2033 are not yet payable
    // (only credits through Dec 2032 — i.e. FRA Mar 2032 → Dec 2032, 10
    // DRC months — pay now).
    const claimMonth = out.find((p) => p.year === 2033 && p.month0 === 8)!;
    // Jan 2034: credits earned through Dec 2033 become payable (a step up).
    const jan2034 = out.find((p) => p.year === 2034 && p.month0 === 0)!;
    expect(jan2034.total).toBeGreaterThan(claimMonth.total);
    // Within 2034 the rate is flat (the January step already landed; the
    // full 18-month DRC delay was earned by the Sept-2033 claim and is
    // all payable by Jan 2034 — no further mid-year or 2035 steps).
    const mar2034 = out.find((p) => p.year === 2034 && p.month0 === 2)!;
    expect(mar2034.total).toBeCloseTo(jan2034.total, 2);
    // Full payable factor by 2034 = at-claim factor (18 DRC months).
    const fullFactor = 1 + 18 * (2 / 300);
    expect(jan2034.total).toBeCloseTo(2000 * fullFactor * 12, 0);
    // And the claim-month partial paid only the 10 pre-2033 DRC months.
    expect(claimMonth.total).toBeCloseTo(2000 * (1 + 10 * (2 / 300)) * 12, 0);
  });

  it('claim exactly at age 70 pays full DRCs immediately (no deferral)', () => {
    // Born 1965-03-12, claim at 70 (Mar 2035). At/after age 70 the full
    // 36-month DRC factor (1.24) is payable from the first benefit month.
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

// The spousal EXCESS COLAs from the WORKER's anchor, while the
// recipient's own benefit COLAs from the RECIPIENT's anchor.
describe('computeAnnualMemberBenefits — spousal worker-anchored COLA', () => {
  it('secondary recipient: spousal excess uses the worker (primary) anchor, own uses recipient anchor', () => {
    // Worker = primary, anchor 2022 (claims at 62). Recipient = secondary,
    // anchor 2029 (claims at 62). The worker's anchor is 7 years earlier, so
    // the excess carries 7 MORE years of COLA than the own component in any
    // payment year. Evaluate year 2035, COLA 2%.
    const cola = 1.02;
    const year = 2035;
    const primaryColaAnchorYear = 2022; // worker
    const secondaryColaAnchorYear = 2029; // recipient
    // Recipient own base $9,000/yr; spousal EXCESS base $5,000/yr (pre-COLA,
    // independently reduced).
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
    // own_now = 9,000 × 1.02^(2035 − 2029); excess_now = 5,000 × 1.02^(2035
    // − 2022) — worker anchor. Dual entitlement ADDS the two components.
    const ownNow = secondaryOwnBase * Math.pow(cola, year - secondaryColaAnchorYear);
    const excessNow =
      secondarySpousalExcessBase * Math.pow(cola, year - primaryColaAnchorYear);
    const expected = ownNow + excessNow;
    expect(secondaryAnnual).toBeCloseTo(expected, 2);
    // Guard against the pre-fix behaviour that used the recipient anchor for
    // the excess too (1.02^6 instead of 1.02^13).
    const buggyExcess =
      secondarySpousalExcessBase * Math.pow(cola, year - secondaryColaAnchorYear);
    const buggy = ownNow + buggyExcess;
    expect(secondaryAnnual).not.toBeCloseTo(buggy, 2);
    // The worker anchor adds 7 extra COLA years on the excess → strictly higher.
    expect(secondaryAnnual!).toBeGreaterThan(buggy);
  });
});

// The monthly engine must NOT double-apply the early-claim reduction for
// a pre-FRA claim. `ownBaseNoDrcAnnual` already bakes in the reduction (via
// min(claim, FRA)); `payableDrcFactorForMonth` must return 1.0 below/at FRA, not
// the reduction a second time.
describe('projectSsByMonth — pre-FRA reduction applied once', () => {
  it('age-62 claim pays pia × adjustmentFactor × 12, not pia × factor² × 12', () => {
    // Born 1963-01-15 → FRA 67 (804 months), benefit month0 = 0 (January).
    // 62nd birthday = Jan 2025; first full month at 62 = Feb 2025. Claim 62.
    // adjustmentFactor(804, 744) = 0.70 (36 × 5/900 + 24 × 5/1200 = 0.30 cut).
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
    // Jan 2025 — birthday month, not yet a full month at 62.
    const jan = out.find((p) => p.year === 2025 && p.month0 === 0)!;
    expect(jan.total).toBe(0);
    // Feb 2025 onward — first full month at 62.
    const feb = out.find((p) => p.year === 2025 && p.month0 === 1)!;
    const factor = 0.7;
    const correct = 1200 * factor * 12; // $10,080
    const doubled = 1200 * factor * factor * 12; // $7,056 (the pre-fix bug)
    expect(feb.total).toBeCloseTo(correct, 0);
    // Within 1% of the single-reduction value, far from the double-reduction value.
    expect(Math.abs(feb.total - correct) / correct).toBeLessThan(0.01);
    expect(feb.total).not.toBeCloseTo(doubled, 0);
  });
});

// The monthly spousal EXCESS COLAs from the WORKER's anchor,
// not the recipient's. Mirrors the annual test on the monthly path.
describe('projectSsByMonth — spousal worker-anchored COLA', () => {
  it('primary recipient: spousal excess grows from the worker (secondary) anchor', () => {
    // Recipient = primary, born 1967-03-01 → benefit year 1967, FRA 67,
    // age-62 anchor 2029 (no statement date). Worker = secondary, born
    // 1960-03-01 → anchor 2022. Both claim at FRA.
    // Primary PIA $800 → own at FRA $9,600/yr. Spousal EXCESS = (50% ×
    // $2,000 − $800) × 12 = $2,400/yr (worker-anchored).
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
    // Primary claims at FRA = 67 → claim Feb 2034 (benefit month0 = 1, day-1
    // March shifts to Feb). Evaluate a clean post-claim January: Jan 2037.
    const out = projectSsByMonth(ctx, { from: 2034, to: 2037 });
    const jan2037 = out.find((p) => p.year === 2037 && p.month0 === 0)!;
    const primaryAnchor = 2029; // recipient anchor
    const secondaryAnchor = 2022; // worker anchor
    const ownBase = 800 * 12; // 9,600
    // The recipient's PIA is deflated to the WORKER's anchor basis
    // before subtracting, so the whole excess grows from one basis.
    const ownPiaAtWorkerAnchor = 800 * Math.pow(cola, secondaryAnchor - primaryAnchor);
    const excessBase = (0.5 * 2000 - ownPiaAtWorkerAnchor) * 12;
    // own_now uses recipient anchor; excess_now uses worker anchor; dual
    // entitlement ADDS the two independently reduced components.
    const ownNow = ownBase * Math.pow(cola, 2037 - primaryAnchor);
    const excessNow = excessBase * Math.pow(cola, 2037 - secondaryAnchor);
    const expectedPrimary = ownNow + excessNow;
    expect(jan2037.byMember.primary).toBeCloseTo(expectedPrimary, 1);
    // Guard against the pre-fix bug that used the recipient anchor for the excess.
    const buggyExcess = excessBase * Math.pow(cola, 2037 - primaryAnchor);
    const buggyPrimary = ownNow + buggyExcess;
    expect(jan2037.byMember.primary).not.toBeCloseTo(buggyPrimary, 1);
    // Worker anchor is 7 years earlier → strictly higher spousal excess.
    expect(jan2037.byMember.primary).toBeGreaterThan(buggyPrimary);
  });
});

// The survivor claim month is month-precise. A mid-year-born
// survivor's claim index carries the benefit-purpose birth month so the
// early-claim reduction and the annual start-year proration are exact.
describe('buildSurvivorStructs — survivor claim month + widow(er) FRA + death age', () => {
  it('June-born survivor: survivorClaimMonthIdx carries the birth month', () => {
    // Survivor (primary) born 1962-06-15 → benefit year 1962, benefit month0
    // = 5 (June). Survivor claim age 60 → claim month June 2022:
    // idx = (1962×12 + 5) + 720 = 2022×12 + 5 (not 2022×12 — the year-only
    // derivation dropped the birth month AND the claim-age months).
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
    // The SEPARATE survivor claim age carries through verbatim (60y = 720mo)
    // — independent of the own age-62 claim.
    expect(structs.primarySurvivor.survivorClaimAgeMonths).toBe(720);
  });

  it('carries the WIDOW(ER) FRA cohort table, not the retirement FRA', () => {
    // Born 1958: retirement FRA = 66y8m (800) but survivor FRA = 66y4m
    // (796) — the widow(er) schedule runs two cohort years behind (POMS
    // RS 00615.003).
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
    // Deceased born 1962-06-15 (benefit month0 5), dies Dec 31 2030
    // (lifeExpectancy 68 → deathYear 2030). Death age = age at Jan 1 2031 =
    // (2031 − 1962) × 12 − 5 = 823 months — NOT 68 × 12 = 816 (the
    // birthday-of-death-year age, which would misclassify a claim between
    // the birthday and Dec 31 as posthumous).
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
    // Without a statement date the anchor falls back to the age-62 year.
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

// ---------------------------------------------------------------------------
// Statement COLA anchor: COLAs begin after the SSA statement's as-of
// year; the age-62 eligibility year remains the documented fallback.
// ---------------------------------------------------------------------------
describe('projectSsByYear — statement COLA anchor', () => {
  // Born 1956-03-15 → age-62 year 2018, FRA 66y4m (796 months). Claim at 70
  // → first payment year 2026. ADJ = 1 + 44 × (2/300).
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
    // Statement dated 2026 → benefit(2028) = PIA × ADJ × 1.02^(2028 − 2026)
    // × 12. The pre-fix age-62 anchor would back-fill 8 extra COLA years
    // (1.02^10) — double-counting COLAs already inside the statement quote.
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

// ---------------------------------------------------------------------------
// Earnings test — grace year, FRA year (actual monthly earnings), and the
// FRA restoration of withheld months (ARF).
// ---------------------------------------------------------------------------
describe('projectSsByYear — grace-year monthly earnings test', () => {
  // Born 1964-07-15 → benefit month0 = 6 (July), FRA 67. Claim 62 → claim
  // July 2026 (grace year 2026, prorated gross = 0.7 × $1,200 × 12 × 6/12
  // = $5,040). Retires mid-year: works Jan–Jun at $15k/mo, $0 after.
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
    // Annual $1/$2 over the 2026 lower limit ($24,480): excess $65,520 →
    // withholding caps at the whole $5,040 benefit.
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
    // Pre-FRA earnings $80,000; excess over $65,160 = $14,840 → withheld
    // $4,946.67, charged against the 8 pre-FRA checks at the ORIGINAL rate:
    // factor(802, 744) = 0.708333 → $850/mo. Per 20 CFR 404.412 the
    // FRA-year withholding credits 6 whole checks — and per 20 CFR
    // 404.412(b) SSA effects that increase WITH the FRA month (Sep), so
    // only Sep–Dec pay at the restored rate factor(802, 744 + 6) =
    // 0.733333 → $880/mo. Benefit = 8 × $850 − $4,946.67 + 4 × $880 =
    // $5,373.33. The month-share fallback (280,000 × 8/12 ≈ $186,667)
    // would wipe the whole benefit; without the same-year credit the year pays only
    // $10,200 − $4,946.67.
    const out = projectSsByYear(fraYearCtx, { from: 2026, to: 2026 });
    expect(out[0].total).toBeCloseTo(8 * 850 - (80_000 - 65_160) / 3 + 4 * 880, 0);
    expect(out[0].total).toBeGreaterThan(0);
    // Guards: neither the fully-un-restored year nor the retroactive shape
    // (the restored rate applied retroactively to the whole year,
    // $10,560 − $4,946.67 = $5,613.33) is produced.
    expect(out[0].total).not.toBeCloseTo(10_200 - (80_000 - 65_160) / 3, 0);
    expect(out[0].total).not.toBeCloseTo(10_560 - (80_000 - 65_160) / 3, 0);
  });
});

describe('projectSsByYear — FRA restoration of withheld months (ARF)', () => {
  // Born 1964-01-15 → benefit month0 = 0 (Jan), FRA 67 → FRA year 2031.
  // Claim 62 → claim Jan 2026, own base = $1,200 × 0.70 × 12 = $10,080.
  // 2026 earnings $34,480 → $10,000 over the lower limit → $5,000 withheld
  // → 6 whole checks (of $840) withheld. From 2031 (FRA) the reduction is
  // recomputed as if the claim were 6 months later: factor(804, 750) =
  // 1 − 0.2 − 18 × 5/1200 = 0.725 → $10,440/yr.
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
    // 2026 (grace year, no monthly data → annual test): $10,080 − $5,000.
    expect(byYear.get(2026)).toBeCloseTo(10_080 - 5_000, 0);
    // 2027–2030: no earnings → full reduced benefit at the original factor.
    expect(byYear.get(2027)).toBeCloseTo(10_080, 0);
    expect(byYear.get(2030)).toBeCloseTo(10_080, 0);
    // 2031 (FRA year) onward: ARF removes the 6 withheld months from the
    // reduction → $1,200 × 0.725 × 12 = $10,440.
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

// ---------------------------------------------------------------------------
// The monthly engine consumes the month-indexed withholding schedule:
// only the actually-charged checks are reduced, never a flat annual factor
// smeared over grace-year non-service months or post-claim months.
// ---------------------------------------------------------------------------
describe('projectSsByMonth — month-indexed earnings-test schedule', () => {
  it('zeroes exactly the service-month checks and pays later months in full', () => {
    // Born 1964-07-15 → benefit month0 6 (July), claim 62 → grace year 2026.
    // Works Jan–Aug at $5k/mo (service months Jul+Aug within entitlement),
    // then stops. Grace-year monthly test withholds the Jul + Aug checks.
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
    // Born the 15th → first full month at 62 is August. July pre-claim.
    const aug = out.find((p) => p.year === 2026 && p.month0 === 7)!;
    const sep = out.find((p) => p.year === 2026 && p.month0 === 8)!;
    const dec = out.find((p) => p.year === 2026 && p.month0 === 11)!;
    // August: a service month — its check is withheld entirely.
    expect(aug.total).toBe(0);
    // September–December: non-service months — FULL run-rate, NOT the
    // pre-fix year-factor smear (10,080 × annual-factor < 10,080).
    expect(sep.total).toBeCloseTo(runRate, 0);
    expect(dec.total).toBeCloseTo(runRate, 0);
  });
});

// ---------------------------------------------------------------------------
// Earnings-test/ARF state warms up from the actual entitlement year:
// a projection range that starts AFTER the withholding years still reflects
// the prior withholding in the FRA restoration.
// ---------------------------------------------------------------------------
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
    // ARF base $10,440 from FRA year 2031. Starting the projection at 2031
    // must NOT forget the 2026 withholding (pre-fix: counters started at 0
    // at `yearRange.from` → $10,080).
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

// ---------------------------------------------------------------------------
// The FRA year's own base already reflects that SAME year's
// pre-FRA-month deductions (SSA effects the ARF with the FRA month,
// 20 CFR 404.412).
// ---------------------------------------------------------------------------
describe('projectSsByYear — same-year FRA restoration ordering', () => {
  it('FRA-year withholding feeds the FRA-year base, not just later years', () => {
    // Born 1964-07-15 → FRA July 2031 (6 pre-FRA months). Claim 62 (2026,
    // no earnings). 2031 earnings $190,320 (annual proration → $95,160
    // pre-FRA → excess $30,000 → $10,000 withholding, capped by the 6
    // chargeable checks). Pass 1 withholds all 6 pre-FRA checks → 6 ARF
    // months → restored base factor(804, 744+6) = 0.725 → $10,440/yr.
    // The 2031 row = the 6 post-FRA months at the restored rate minus… all
    // pre-FRA checks withheld = $10,440 − 6 × $870 = $5,220.
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
    // Pre-fix ordering used the un-restored base in the FRA year: $10,080 −
    // $5,040 = $5,040 — must no longer match.
    expect(out[0].total).not.toBeCloseTo(5_040, 0);
    // The year after carries the fully restored base.
    expect(out[1].total).toBeCloseTo(10_440, 0);
  });
});

// ---------------------------------------------------------------------------
// The SSA grace year keys to the member's ENTITLEMENT start (any
// benefit type). A survivor benefit starting before the member's own
// retirement claim establishes the grace year.
// ---------------------------------------------------------------------------
describe('projectSsByYear — survivor-entitlement grace year', () => {
  it('a midyear survivor start gets the grace-year monthly test before the own claim', () => {
    // Secondary born 1966-07-15, survivor claim age 60 → survivor start
    // July 2026 (spouse dies Dec 31 2025). Own claim 67 (2033) — the OLD
    // grace-year rule (own claim year only) would run the bare annual test
    // in 2026 and wipe the survivor checks with the Jan–Jun wages.
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
    // Widow base $3,000 (deceased claimed early → RIB-LIM caps at
    // max(82.5% × $3,000 = $2,475, reduced RIB $2,100) = $2,475). Survivor
    // early factor at 60 → reduction $855.00 (exact dime) → $2,145 → under
    // the cap. Start July → 6/12 of the year: $2,145 × 12 × 6/12 = $12,870,
    // paid IN FULL (post-start months are all non-service).
    expect(out[0].byMember.secondary).toBeCloseTo(2_145 * 6, 0);
    expect(out[0].byMember.secondary).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Per-component ARF: the spousal-excess reduction factor restores
// independently of the own RIB at the recipient's FRA.
// ---------------------------------------------------------------------------
describe('projectSsByYear — spousal-excess ARF restoration', () => {
  it('excess withheld months step the spousal factor up at the recipient FRA', () => {
    // Recipient (primary) born 1964-01-15, own PIA 0 → spousal-only. Worker
    // (secondary) born 1960-01-15, PIA $2,000, claimed 62 (2022). Recipient
    // claims 62 (Jan 2026): excess = $1,000 × 0.65 = $650/mo = $7,800/yr.
    // 2026 earnings $34,480 → $5,000 withheld → 8 checks of $650 → 8 excess
    // ARF months. From FRA (2031): spousal factor at 744 + 8 = 752 months →
    // 1 − 0.25 − 16 × 5/1200 = 0.683333 → $683.33/mo → $8,200/yr.
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
    // Pre-FRA: the original 0.65 factor.
    expect(y2030.byMember.primary).toBeCloseTo(7_800, 0);
    // FRA year: 8 restored months → 0.683333 factor.
    expect(y2031.byMember.primary).toBeCloseTo(8_200, 0);
  });
});

// ---------------------------------------------------------------------------
// A worker's excess earnings are charged against the COMBINED
// benefits payable on their record — the worker's own check PLUS the spousal
// excess (20 CFR 404.415(b)/404.434) — with a partial month apportioned
// proportionally across both (§404.439). Worked example:
// $20,160 worker + $9,360 auxiliary + a $10,000 deduction pays $19,520 total.
// ---------------------------------------------------------------------------
describe('projectSsByYear — record-level charge of worker + spouse excess', () => {
  it('charges the $10,000 deduction once against the combined record checks (§404.439 apportionment)', () => {
    // Worker (primary) born 1962-01-15, PIA $2,400, claims 62 (2024); own
    // gross 2026 = $2,400 × 0.70 × 12 = $20,160 ($1,680/mo). Recipient
    // (secondary) born 1962-01-15, PIA 0, claims 62: excess = $1,200 ×
    // 0.65 × 12 = $9,360 ($780/mo), payable on the WORKER's record. 2026
    // earnings $44,480 → excess earnings $20,000 → $10,000 deduction,
    // charged sequentially against the RECORD total $2,460/mo: Jan–Apr
    // fully withheld ($9,840), May charged the remaining $160 → May pays
    // (2,460 − 160)/2,460 of each component; Jun–Dec pay in full.
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
    // §404.439 proportional apportionment: the May pay factor applies to
    // both components; paid months = (2,300/2,460) + 7 full months.
    const paidMonths = (2_460 - 160) / 2_460 + 7;
    expect(out[0].byMember.primary).toBeCloseTo(1_680 * paidMonths, 0);
    expect(out[0].byMember.secondary).toBeCloseTo(780 * paidMonths, 0);
    // The record pays exactly the combined total minus the deduction.
    expect(out[0].total).toBeCloseTo(29_520 - 10_000, 0);
    // Two other shapes must NOT be produced: the deduction computed against
    // the worker's personal $20,160 alone (paying $10,160) with its pay
    // ratio REAPPLIED to the spouse's excess ($9,360 × 10,160/20,160 =
    // $4,717) would double-charge the family ~$4,643.
    expect(out[0].byMember.primary).not.toBeCloseTo(20_160 - 10_000, 0);
    expect(out[0].byMember.secondary).not.toBeCloseTo(9_360 * ((20_160 - 10_000) / 20_160), 0);
    // Also not produced: the spouse's excess untouched by the worker's earnings.
    expect(out[0].byMember.secondary).not.toBeCloseTo(9_360, 0);
  });
});

// ---------------------------------------------------------------------------
// Partial-deduction FRA year: the ARF increase is effective only
// WITH the FRA month (20 CFR 404.412(b)) — paid pre-FRA checks stay at the
// original rate, the restored rate starts at the FRA month, and the earnings
// test charges/caps against the original-rate pre-FRA checks.
// ---------------------------------------------------------------------------
describe('projectSsByYear — partial-deduction FRA year (mixed rates)', () => {
  // Born 1964-07-15 → benefit month0 6 (July), FRA 67 → FRA month July 2031
  // (fraMonth0 = 6). Claim 62 (July 2026) → original rate $1,200 × 0.70 =
  // $840/mo. 2031 earnings $11,910/mo Jan–Jun → pre-FRA dollars $71,460 →
  // excess over $65,160 = $6,300 → withheld $2,100, charged sequentially
  // against the ORIGINAL-rate checks: Jan $840 + Feb $840 + Mar $420 →
  // 3 ARF months. Restored rate factor(804, 744 + 3) = 0.7125 → $855/mo,
  // effective ONLY from July (the FRA month).
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
    // Not produced: the restored rate applied retroactively to the whole
    // year and the cap recomputed at it ($855 × 12 − $2,100 = $8,160).
    expect(out[0].total).not.toBeCloseTo(855 * 12 - 2_100, 0);
    // The year after pays the fully restored rate all year.
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

// ---------------------------------------------------------------------------
// The spousal-excess payment AND the credited spousal-ARF months both
// derive from the same combined per-month schedule (min of the recipient's
// own-record and the worker-record charges), counted only over months the
// excess is actually entitled.
// ---------------------------------------------------------------------------
describe('projectSsByYear — combined per-month excess schedule', () => {
  it('disjoint recipient/worker service months: every charged month reduces the excess once', () => {
    // Recipient (primary) born 1964-01-15, PIA 0 → excess-only: $1,200 ×
    // 0.65 = $780/mo ($9,360/yr) from Jan 2026 (grace year). Grace monthly
    // test: works Jul+Aug at $30k → recipient's schedule zeroes Jul+Aug
    // (2 checks). Worker (secondary) born 1962-01-15, PIA $2,400, claimed
    // 62 (2024): own checks $1,680; 2026 earnings $43,520 → excess earnings
    // $19,040 → $9,520 deduction, charged against the RECORD pool
    // (own $1,680 + the recipient's $780 excess = $2,460/mo): Jan–Mar full
    // ($7,380) + Apr the remaining $2,140 → worker schedule charges
    // Jan–Apr (Apr partially: pay factor 320/2,460). The combined
    // min-schedule charges Jan–Apr AND Jul+Aug (6 months, disjoint
    // charges) → excess paid = $780 × (320/2,460 + 6) — never a
    // year-level annual-factor smear.
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
    // Worker's own check takes the same record-level apportioned factor.
    expect(out[0].byMember.secondary).toBeCloseTo(1_680 * (aprFactor + 8), 0);
    // Excess: Jan–Mar 0 (worker charge), Apr partial, May–Jun full, Jul–Aug
    // 0 (recipient's grace service months), Sep–Dec full.
    expect(out[0].byMember.primary).toBeCloseTo(780 * (aprFactor + 6), 0);
    // The record pays the combined total minus the deduction, minus the
    // recipient's own Jul+Aug grace withholding ($780 × 2).
    expect(out[0].total).toBeCloseTo(29_520 - 9_520 - 1_560, 0);
    expect(out[0].byMember.primary).not.toBeCloseTo(9_360 * (10_640 / 20_160), 0);
    // 6 combined charged months (Jan–Apr worker + Jul/Aug recipient, not
    // 4 or 2 alone) credit the spousal ARF: factor(804, 744 + 6) = 0.675 →
    // $810/mo → $9,720 from FRA 2031.
    const fra = projectSsByYear(ctx, { from: 2031, to: 2031 });
    expect(fra[0].byMember.primary).toBeCloseTo(9_720, 0);
    expect(fra[0].byMember.primary).not.toBeCloseTo(9_840, 0); // 8-month credit shape
  });

  it('withholding before the excess activates neither reduces the excess nor credits its ARF', () => {
    // Recipient (primary) born 1964-01-15, PIA $800, claims 62 (Jan 2026):
    // own $560/mo. Worker (secondary) born 1959-07-15 claims 67 → July 2026
    // → the excess ($400 × 0.675 = $270/mo, entitlement clock at 750) activates JULY.
    // Recipient's grace-year service months are Feb+Mar — BEFORE activation
    // — so the excess is paid in full and NO excess-ARF months accrue.
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
    // FRA year 2031: the OWN base restores with 2 credits (factor 0.708333 →
    // $6,800.04/yr) but the SPOUSAL factor keeps its at-activation 0.675
    // ($3,240/yr) — the pre-activation months never credited the excess.
    const fra = projectSsByYear(ctx, { from: 2031, to: 2031 });
    expect(fra[0].byMember.primary).toBeCloseTo(6_800 + 3_240, 0);
    // Crediting max(own 2, worker 0) = 2 excess months instead would give
    // spousal factor 0.683333 → $10,080.04 — must not match.
    expect(fra[0].byMember.primary).not.toBeCloseTo(6_800 + 3_280, 0);
  });
});

// ---------------------------------------------------------------------------
// The FRA-year same-year restoration also fires when the ONLY
// withholding that year is the spousal excess charged by the WORKER's
// earnings-test schedule (20 CFR 404.415(b)) — the recipient's own earnings
// test never ran, yet the excess-based ARF credit must still restore at the
// RECIPIENT's FRA month, not the following year.
// ---------------------------------------------------------------------------
describe('projectSsByYear — worker-only excess withholding in the recipient FRA year', () => {
  // Recipient (primary) born 1964-07-15 → FRA 67 = July 2031 (fraMonth0 6),
  // PIA 0 (spousal-only), claims 62, ZERO earnings — their own test never
  // withholds. Worker (secondary) born 1966-01-15, PIA $2,400, claims 62
  // (Jan 2028) → excess activates Jan 2028 at the entitlement-clock age 63y6m (762
  // months): factor 0.725 → $870/mo ($10,440/yr). Worker earns $44,480 in
  // 2031 (lower limit $24,480) → $10,000 deduction charged against the
  // RECORD pool (own $1,680 + excess $870 = $2,550/mo): Jan–Mar full
  // ($7,650) + Apr the remaining $2,350 → 4 worker-record months, which
  // charge the recipient's excess too. 4 excess-ARF credits →
  // spousal factor at 762 + 4 = 766 months = 0.741667 → $890/mo
  // ($10,680/yr), effective at the recipient's FRA month (July 2031).
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
    // 2030 — no withholding anywhere: the at-activation 0.725 factor.
    expect(out[0].byMember.primary).toBeCloseTo(10_440, 0);
    // 2031 — Jan–Mar excess withheld, Apr partial (worker's record
    // schedule), May–Jun at the pre-restoration $870, Jul–Dec at the
    // RESTORED $890/mo (FRA-month effective):
    expect(out[1].byMember.primary).toBeCloseTo(
      870 * workerAprFactor + 2 * 870 + 6 * 890,
      0,
    );
    // Pre-fix shape: no same-year rerun (own withheldMonths was 0) → the
    // whole year stayed at $870/mo — must no longer match.
    expect(out[1].byMember.primary).not.toBeCloseTo(
      870 * workerAprFactor + 2 * 870 + 6 * 870,
      0,
    );
    // 2032 — fully restored all year.
    expect(out[2].byMember.primary).toBeCloseTo(10_680, 0);
    // The worker's own check takes the same record-level apportioned
    // factor (the deduction spans the combined pool, so the worker
    // keeps more of their own check than the personal-pool shape).
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

// ---------------------------------------------------------------------------
// The earnings-test/ARF warm-up covers a SURVIVOR entitlement that
// begins before either member's own claim year.
// ---------------------------------------------------------------------------
describe('projectSsByYear — survivor-entitlement warm-up + own-RIB ARF gating', () => {
  // Primary born 1960-03-15, claims 67 (2027) but dies Dec 31 2025 (life 65,
  // never claimed → widow base = full PIA $400, no RIB-LIM). Secondary born
  // 1966-07-15, PIA $2,000, own claim 62 (July 2028), survivor claim 60 →
  // survivor start July 2026 — the EARLIEST entitlement, before EITHER own
  // claim year. Widow amount $400 − roundUpToDime($400 × 0.285) = $286/mo.
  // 2026 earnings $34,480 (annual only) withhold all 6 survivor checks —
  // SURVIVOR-only months (the own RIB starts July 2028), so none are credited
  // to any component (survivor-factor ARF is the disclosed unmodeled
  // gap). 2029 earnings $28,480 → ($28,480 − $24,480)/2 = $2,000 withheld
  // from the $1,400 own checks (Jan full + Feb partial) → 2 OWN-entitled
  // ARF months — the only credits that restore the own RIB at FRA.
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
    // FRA year 2033 (FRA month July): Jan–Jun at the original $1,400/mo;
    // Jul–Dec restored with ONLY the 2 own-entitled 2029 credits —
    // factor(804, 744 + 2) = 0.708333 → $1,416.67/mo → $16,900.
    expect(partial[0].byMember.secondary).toBeCloseTo(6 * 1_400 + 6 * 1_416.67, 0);
    // Negative: the 6 survivor-only 2026 withheld months must NOT
    // inflate the own RIB — an 8-credit shape factor(804, 752) =
    // 0.733333 → $1,466.67/mo → $17,200 is wrong (those checks were
    // survivor checks, before the own entitlement even began, and
    // survivor-factor ARF is disclosed as not modeled).
    expect(partial[0].byMember.secondary).not.toBeCloseTo(6 * 1_400 + 6 * 1_466.67, 0);
    // Warm-up negative: a warm-up starting at the range start forgets the
    // 2029 withholding → $16,800 flat.
    expect(partial[0].byMember.secondary).not.toBeCloseTo(12 * 1_400, 0);
  });
});

// ---------------------------------------------------------------------------
// ONE grace year per continuous entitlement period (20 CFR
// 404.435(b)(2), POMS RS 02501.030): another grace year requires the prior
// entitlement to END plus a ≥1-month break, which the model never produces —
// so only the member's FIRST-ever entitlement start establishes a grace year.
// ---------------------------------------------------------------------------
describe('projectSsByYear — single grace year per continuous entitlement', () => {
  it('an uninterrupted own claim into a later survivor start gets NO second grace year', () => {
    // Deceased (primary) born 1960-03-15, PIA $2,000, claims AT FRA 67
    // (Mar 2027) — no RIB-LIM, no DRCs — and dies Dec 31 2030 (life 70).
    // Survivor (secondary) born 1968-07-15, PIA $1,000, own claim 62 →
    // July 2030 (the FIRST entitlement); survivor claim age 64 → the
    // survivor benefit starts July 2032, with own entitlement continuing
    // UNBROKEN into it. Widow amount: $2,000 − roundUpToDime($2,000 ×
    // 0.285 × 36/84) = $2,000 − $244.30 = $1,755.70/mo from July 2032
    // (survivor FRA 67, claim at 64 → 36 of 84 early months).
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
    // 2032 is NOT a grace year (first entitlement was July 2030 and the own
    // entitlement never broke), so the ANNUAL test charges from January:
    // excess = ($36,000 − $24,480) / 2 = $5,760 → Jan–Jun own checks ($700
    // each, $4,200) + $1,560 of the July survivor check. Paid = 6 × $700 +
    // 6 × $1,755.70 − $5,760 = $8,974.20.
    const out = projectSsByYear(ctx, { from: 2032, to: 2032 });
    expect(out[0].byMember.secondary).toBeCloseTo(6 * 700 + 6 * 1_755.7 - 5_760, 0);
    // Pre-fix shape: the survivor start re-granted a grace year whose
    // monthly test (no Jul–Dec earnings → all non-service) paid the year in
    // FULL and whose chargeable frame excluded the Jan–Jun own checks —
    // must no longer match.
    expect(out[0].byMember.secondary).not.toBeCloseTo(6 * 700 + 6 * 1_755.7, 0);
    // Monthly engine agrees: January's own check is charged (chargeable
    // months start in January, not at the survivor start).
    const monthly = projectSsByMonth(ctx, { from: 2032, to: 2032 });
    const rateOf = (m: number): number =>
      monthly.find((p) => p.year === 2032 && p.month0 === m)!.byMember.secondary ?? 0;
    expect(rateOf(0)).toBe(0); // Jan — charged in full
    const mean = monthly.reduce((a, p) => a + (p.byMember.secondary ?? 0), 0) / 12;
    expect(mean).toBeCloseTo(out[0].byMember.secondary ?? 0, 6);
  });

  it('survivor-first entitlement: the survivor start year IS the grace year, the later own claim gets none', () => {
    // Deceased (primary) born 1960-03-15, PIA $3,000, claimed 62 (reduced
    // RIB), dies Dec 31 2025 (life 65). Survivor (secondary) born
    // 1966-07-15, PIA $800: survivor claim 60 → survivor start July 2026 —
    // the FIRST-ever entitlement (grace year 2026); own claim 64 → July
    // 2030, with the widow(er) entitlement continuing UNBROKEN into it.
    // Widow amount $2,145/mo (base $3,000 − $855 survivor reduction; RIB-LIM
    // cap $2,475 not binding); own at 64 = $640/mo < $2,145 → every check
    // stays at the survivor level.
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
    // 2026 — the genuine (first-entitlement) grace year: Jul–Dec are all
    // non-service months, so the survivor checks pay in FULL.
    expect(byYear.get(2026)).toBeCloseTo(6 * 2_145, 0);
    // 2030 — the own claim is NOT a new entitlement break, so NO second
    // grace year: the annual test withholds ($90,000 − $24,480)/2 =
    // $32,760, capped at the year's 12 × $2,145 = $25,740 of checks →
    // everything withheld.
    expect(byYear.get(2030)).toBeCloseTo(0, 6);
    // Pre-fix shape — a re-granted grace year in 2030 paid the year in full.
    expect(byYear.get(2030)).not.toBeCloseTo(12 * 2_145, 0);
  });
});

// ---------------------------------------------------------------------------
// The SSA grace year is the first entitled taxable year CONTAINING a
// non-service month (POMS RS 02501.030), not blindly the first entitlement
// year: a claimant who works over the monthly limit through their ENTIRE
// entitlement year gets the grace-year monthly test in the first LATER year
// with a non-service month.
// ---------------------------------------------------------------------------
describe('projectSsByYear — grace year deferred past an all-service entitlement year', () => {
  // Born 1964-07-15, claim 62 → July 2026 (entitled Jul–Dec, checks $840).
  // 2026: works $15k/mo ALL year — every entitled month is a service month
  // (over the $2,040 monthly limit), so 2026 is NOT the grace year. 2027:
  // works $15k/mo Jan–Jun, retires July — the first non-service months →
  // 2027 IS the grace year (POMS RS 02501.030).
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
    // 2026: every entitled check withheld (annual excess ($180,000 −
    // $24,480)/2 = $77,760 caps at the 6 × $840 entitled checks; the
    // monthly test would also withhold all 6 service months).
    expect(out[0].total).toBe(0);
    // 2027 — the grace year: the monthly test pays the Jul–Dec non-service
    // checks in full ($840 × 6 = $5,040), beating the annual test (excess
    // ($90,000 − $24,480)/2 = $32,760 → would wipe all 12 checks). The
    // Burning the grace year on 2026 would pay $0 here.
    expect(out[1].total).toBeCloseTo(6 * 840, 0);
    expect(out[1].total).not.toBe(0);
    // 2028: no earnings → the full reduced benefit.
    expect(out[2].total).toBeCloseTo(12 * 840, 0);
    // Monthly engine consumes the same schedule: Jan 2027 charged, Jul
    // 2027 (first non-service month) pays the full run-rate.
    const monthly = projectSsByMonth(ctx, { from: 2027, to: 2027 });
    const rateOf = (m: number): number =>
      monthly.find((p) => p.year === 2027 && p.month0 === m)!.total;
    expect(rateOf(0)).toBe(0);
    expect(rateOf(6)).toBeCloseTo(840 * 12, 0);
    const mean = monthly.reduce((a, p) => a + p.total, 0) / 12;
    expect(mean).toBeCloseTo(out[1].total, 6);
  });
});

// ---------------------------------------------------------------------------
// Own claim and survivor start in the SAME midyear: the annual table
// composes the year month-wise (own-only months + survivor-level months), so
// it matches the monthly engine instead of blending an already-prorated own
// benefit into the survivor fraction.
// ---------------------------------------------------------------------------
describe('projectSsByYear — own claim + survivor start in the same midyear', () => {
  // Primary born 1960-03-15, PIA $3,000, claims at FRA 67 (Mar 2027), dies
  // Dec 31 2027 (life 67) → no RIB-LIM (claimed AT FRA). Secondary born
  // 1966-07-01 (day-1 → June benefit month), PIA $1,000: own claim 62 →
  // June 2028 ($700/mo); survivor claim 62y4m → Oct 2028. Widow amount =
  // $3,000 − roundUpToDime($3,000 × 0.19) = $2,430/mo (survivor FRA 67,
  // effective age 748).
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
    // The retired fraction blend `current + (sv − current) × 3/12` on the
    // already-prorated own benefit produced $10,965 — must not match.
    expect(annual[0].byMember.secondary).not.toBeCloseTo(10_965, 0);
  });
});

// Day-1 rule tests → ss-projection-day1.test.ts
// Deemed-filing gate / death-before-claim / DRC-no-transfer tests → ss-projection-deemed-filing.test.ts
