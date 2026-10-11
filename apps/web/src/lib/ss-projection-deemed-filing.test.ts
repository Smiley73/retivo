/**
 * Deemed-filing gate, death-before-claim, and DRC-no-transfer tests
 * for `projectSsByYear` and `projectSsByMonth`.
 *
 * Extracted from ss-projection.test.ts to keep that file under the 400-line
 * shape limit (day-1 tests + deemed-filing tests are the natural seams).
 */
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

// projectSsByYear — deemed-filing gate, death-before-claim, DRC-no-transfer.
describe('projectSsByYear — deemed-filing gate, DRC-no-transfer', () => {
  it('spousal floor is 0 before worker claims, active in same year worker claims', () => {
    // Primary (worker): born 1965-03-12, claim age 67 → claim year 2032.
    // Secondary (recipient): born 1967-03-12, claim age 62 → claim year 2029.
    // Secondary claims before primary — spousal floor must be 0 until primary
    // also claims (deemed-filing gate). In 2031, secondary is already claiming
    // but primary hasn't → secondary gets own only. In 2032, primary claims too
    // → spousal floor activates.
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
    // 2031: primary not yet claiming → spousal floor inactive.
    // Secondary own annual (claim age 62, FRA 67): pia=100, factor=0.70 → $840/yr.
    const secondaryOwn2031 = out[0].byMember.secondary ?? 0;
    expect(secondaryOwn2031).toBeGreaterThan(0);
    // Spousal would be 50% × $2000 × 12 × factor ≈ $12k/yr — far > $840.
    // Confirm no spousal top-up (secondary stays near own base).
    expect(secondaryOwn2031).toBeLessThan(5_000);
    // 2032: primary claims → spousal floor kicks in for secondary.
    const secondaryOwn2032 = out[1].byMember.secondary ?? 0;
    expect(secondaryOwn2032).toBeGreaterThan(secondaryOwn2031);
    expect(secondaryOwn2032).toBeGreaterThan(5_000);
  });

  it('death-pre-scenario-claim uses death year, no posthumous DRCs', () => {
    // Primary (worker): born 1965-03-12, scenario claim age 70 → claim year 2035.
    // But primary dies at age 65 → death year = 2030.
    // Deceased effective claim age = min(70×12, 65×12) = 780 (65 years) < 804 FRA.
    // Survivor benefit uses death year 2030 as the effective claim year.
    // Secondary: born 1965-04-15, claim age 67 → claim year 2032, life 95.
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
    // Primary death year ~2030, secondary claim year ~2032.
    // After both death + secondary claim, survivor benefit uses the
    // early-death reduction (claim at 65, not 70 — no posthumous DRCs).
    const out = projectSsByYear(ctx, { from: 2032, to: 2032 });
    // Secondary is the SURVIVOR — primary is dead in 2032, so their benefit is 0.
    // Survivor annual must be < pia×12×1.24 (the at-70 amount — DRCs NOT transferred).
    const survivorAnnual = out[0].byMember.secondary!;
    expect(out[0].byMember.primary).toBe(0);
    expect(survivorAnnual).toBeLessThan(2000 * 12 * 1.24);
    // Survivor annual must be <= pia × 12 × 1.0 (at FRA — capped at death age).
    // Actually death at 65 → factor < 1; result is further reduced below FRA.
    expect(survivorAnnual).toBeLessThan(2000 * 12);
    // Survivor should be positive (death has occurred, secondary claiming).
    expect(survivorAnnual).toBeGreaterThan(0);
  });

  it('DRC-no-transfer: delayed-retirement credits do NOT increase spousal benefit', () => {
    // Worker (secondary): born 1965-03-12, claim age 70 → DRCs push factor to 1.24.
    // Spousal floor is based on 50% × worker PIA (no DRCs transferred):
    // spousal = 0.5 × pia × 12 × spousalAdjustmentFactor (≤ 1.0, capped at FRA).
    // Even if secondary claims at 70 (1.24× their own), spousal for primary
    // must be exactly 50% × PIA × 12 × recipientFactor, NOT 50% × (1.24×PIA).
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
    // Secondary claim year 2035; primary claim year 2034 (born 1967, claim 67).
    // Evaluate 2036 — the first FULL year both are claiming (the worker-claim
    // year 2035 is prorated to the excess's actual activation month).
    // Primary = own $1,200 + excess (50% × 3000 − 100) × 12 × 1.0 = $18,000.
    // NOT own + 50% × (3000×1.24) × 12 which would be ~$22.3k.
    const out = projectSsByYear(ctx, { from: 2036, to: 2036 });
    const primaryAnnual = out[0].byMember.primary;
    // own $1,200 + independently reduced excess $16,800 = $18,000; the
    // DRC-inflated composition would exceed it.
    expect(primaryAnnual).toBeCloseTo(18_000, 0);
    expect(primaryAnnual).toBeLessThan(18_001); // not DRC-inflated
  });
});

// Deemed-filing month-precision: spousal floor activates exactly at the
// month both (a) the worker has claimed and (b) the recipient has claimed.
describe('projectSsByMonth — deemed-filing precision', () => {
  it('spousal floor is absent one month before recipient claim, present at claim month', () => {
    // Primary (worker): born 1960-01-02, claim age 67 → claim Jan 2027.
    // Secondary (recipient): born 1962-04-15, claim age 67 → claim Apr 2029.
    // Primary PIA $2000 → spousal floor = $1000/mo annualised = $12k/yr.
    // Secondary PIA $400 → own = $4800/yr.
    // Pre-Apr 2029: secondary receives own only ($4800). Apr 2029 onward:
    // spousal floor $12k > own $4.8k → secondary gets $12k.
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
    // March 2029 (month0=2): secondary not yet claiming (Apr is claim month).
    const mar = out.find((p) => p.year === 2029 && p.month0 === 2)!;
    // April 2029 (month0=3): secondary claims → spousal floor activates.
    const apr = out.find((p) => p.year === 2029 && p.month0 === 3)!;
    expect(mar.byMember.secondary).toBeLessThan(12_000);
    expect(apr.byMember.secondary).toBeCloseTo(12_000, 0);
  });
});
