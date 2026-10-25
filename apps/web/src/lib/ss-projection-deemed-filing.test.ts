import { describe, expect, it } from 'vitest';
import { projectSsByMonth, projectSsByYear, type SsContext } from './ss-projection';
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

describe('projectSsByYear — deemed-filing gate, DRC-no-transfer', () => {
  it('spousal floor is 0 before worker claims, active in same year worker claims', () => {
    // Primary (worker) born 1965-03-12, claim 67 → 2032. Secondary (recipient) born 1967-03-12, claim 62 → 2029: the spousal floor stays 0 until the primary also claims (deemed-filing gate), so 2031 is own-only and 2032 activates it.
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1965-03-12', isPrimary: true }),
        pia: 2000,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
      },
      secondary: {
        id: 's',
        payload: { ...member({ birthdate: '1967-03-12' }), isPrimary: false },
        pia: 100, // Very low own PIA — spousal floor dominates when active.
        claimAge: claimAge(62),
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
    };
    const out = projectSsByYear(ctx, { from: 2031, to: 2032 });
    // Secondary own annual (claim age 62, FRA 67): pia=100, factor=0.70 → $840/yr.
    const secondaryOwn2031 = out[0].byMember.secondary ?? 0;
    expect(secondaryOwn2031).toBeGreaterThan(0);
    // Spousal would be 50% × $2000 × 12 × factor ≈ $12k/yr, far above $840: no top-up.
    expect(secondaryOwn2031).toBeLessThan(5_000);
    const secondaryOwn2032 = out[1].byMember.secondary ?? 0;
    expect(secondaryOwn2032).toBeGreaterThan(secondaryOwn2031);
    expect(secondaryOwn2032).toBeGreaterThan(5_000);
  });

  it('death-pre-scenario-claim uses death year, no posthumous DRCs', () => {
    // Primary born 1965-03-12, scenario claim 70 (2035) but dies at 65 → death year 2030; effective claim age min(70, 65) × 12 = 780 < FRA 804. Secondary born 1965-04-15, claim 67 → 2032, life 95.
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1965-03-12', isPrimary: true }),
        pia: 2000,
        claimAge: claimAge(70), // would have waited
        lifeExpectancyAge: 65,  // dies at 65
      },
      secondary: {
        id: 's',
        payload: { ...member({ birthdate: '1965-04-15' }), isPrimary: false },
        pia: 500,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
    };
    const out = projectSsByYear(ctx, { from: 2032, to: 2032 });
    // Survivor annual must be < pia × 12 × 1.24 (the at-70 amount): DRCs are not transferred.
    const survivorAnnual = out[0].byMember.secondary!;
    expect(out[0].byMember.primary).toBe(0);
    expect(survivorAnnual).toBeLessThan(2000 * 12 * 1.24);
    // At or below pia × 12 × 1.0: capped at the death age; death at 65 leaves it below FRA.
    expect(survivorAnnual).toBeLessThan(2000 * 12);
    expect(survivorAnnual).toBeGreaterThan(0);
  });

  it('DRC-no-transfer: delayed-retirement credits do NOT increase spousal benefit', () => {
    // Worker (secondary) claims at 70 (DRC factor 1.24); the spousal floor is 50% × worker PIA with no DRCs transferred, not 50% × (1.24 × PIA).
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1967-03-15', isPrimary: true }),
        pia: 100, // low own PIA so spousal dominates
        claimAge: claimAge(67), // claim at FRA → spousal factor 1.0
        lifeExpectancyAge: 95,
      },
      secondary: {
        id: 's',
        payload: { ...member({ birthdate: '1965-03-12' }), isPrimary: false },
        pia: 3000,
        claimAge: claimAge(70), // claims at 70 → DRCs on own; does NOT pass to spousal
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
    };
    // Secondary claim year 2035, primary claim year 2034; evaluate 2036, the first full year both claim.
    // Primary = own $1,200 + excess (50% × 3000 − 100) × 12 × 1.0 = $18,000; own + 50% × (3000 × 1.24) × 12 would be about $22.3k.
    const out = projectSsByYear(ctx, { from: 2036, to: 2036 });
    const primaryAnnual = out[0].byMember.primary;
    expect(primaryAnnual).toBeCloseTo(18_000, 0);
    expect(primaryAnnual).toBeLessThan(18_001); // not DRC-inflated
  });
});

describe('projectSsByMonth — deemed-filing precision', () => {
  it('spousal floor is absent one month before recipient claim, present at claim month', () => {
    // Primary (worker) born 1960-01-02, claim 67 → Jan 2027. Secondary (recipient) born 1962-04-15, claim 67 → Apr 2029; PIA $2000 → spousal floor $12k/yr, secondary PIA $400 → own $4800/yr.
    const ctx: SsContext = {
      primary: {
        id: 'p',
        payload: member({ birthdate: '1960-01-02', isPrimary: true }),
        pia: 2000,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
      },
      secondary: {
        id: 's',
        payload: { ...member({ birthdate: '1962-04-15' }), isPrimary: false },
        pia: 400,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
    };
    const out = projectSsByMonth(ctx, { from: 2029, to: 2029 });
    const mar = out.find((p) => p.year === 2029 && p.month0 === 2)!;
    const apr = out.find((p) => p.year === 2029 && p.month0 === 3)!;
    expect(mar.byMember.secondary).toBeLessThan(12_000);
    expect(apr.byMember.secondary).toBeCloseTo(12_000, 0);
  });
});
