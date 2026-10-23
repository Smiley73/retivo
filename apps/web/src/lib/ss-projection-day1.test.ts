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

// SSA day-1 rule (POMS GN 00302.400): born on the 1st counts as the prior month; Jan 1 → prior year's cohort → earlier FRA and claim year.
describe('projectSsByYear — SSA day-1 rule (POMS GN 00302.400)', () => {
  it('Jan 1 1960 (→ 1959 cohort) claims one year earlier than Jan 2 1960 (1960 cohort)', () => {
    // Jan 1 1960 → benefit birth year 1959 → claim age 67 → claim year 2026.
    // Jan 2 1960 → benefit birth year 1960 → claim age 67 → claim year 2027.
    const makeCtx = (birthdate: string): SsContext => ({
      primary: {
        id: 'p',
        payload: member({ birthdate }),
        pia: 1000,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
    });
    // Jan 1 1960 → claim year 2026 (prorated, benefit month Dec); the 1959-cohort FRA is 66y10m, so claiming at 67 earns 2 months of DRCs. First full year is 2027.
    const jan1Out = projectSsByYear(makeCtx('1960-01-01'), { from: 2025, to: 2028 });
    expect(jan1Out[0].total).toBe(0);          // 2025 — not yet
    expect(jan1Out[1].total).toBeGreaterThan(0); // 2026 — claim year (prorated, positive)
    expect(jan1Out[3].total).toBeCloseTo(jan1Out[2].total, 0);
    expect(jan1Out[1].total).toBeLessThan(jan1Out[2].total);

    // Jan 2 1960 → 1960 cohort, FRA 67: factor 1.0 → exactly $12k; claim year 2027 (Jan birth month, no proration).
    const jan2Out = projectSsByYear(makeCtx('1960-01-02'), { from: 2025, to: 2027 });
    expect(jan2Out[0].total).toBe(0);          // 2025
    expect(jan2Out[1].total).toBe(0);          // 2026 — still pre-claim
    expect(jan2Out[2].total).toBeCloseTo(12_000, 0); // 2027 — claim year, FRA exactly, full year
  });
});

describe('projectSsByMonth — SSA day-1 rule month precision', () => {
  it('born Jan 1 1960 claims one calendar month earlier than born Jan 2 1960', () => {
    // Jan 1 1960 → benefit birth year 1959, month0 11: claim at 67 → Dec 2026. Jan 2 1960 → birth year 1960, month0 0 → Jan 2027.
    const makeCtx = (birthdate: string): SsContext => ({
      primary: {
        id: 'p',
        payload: member({ birthdate }),
        pia: 1000,
        claimAge: claimAge(67),
        lifeExpectancyAge: 95,
      },
      colaPct: 0,
      benefitReductionPct: 0,
    });

    const jan1Out = projectSsByMonth(makeCtx('1960-01-01'), { from: 2026, to: 2027 });
    const jan2Out = projectSsByMonth(makeCtx('1960-01-02'), { from: 2026, to: 2027 });

    const dec2026_jan1 = jan1Out.find((p) => p.year === 2026 && p.month0 === 11)!;
    const dec2026_jan2 = jan2Out.find((p) => p.year === 2026 && p.month0 === 11)!;
    expect(dec2026_jan1.total).toBeGreaterThan(0);
    expect(dec2026_jan2.total).toBe(0);

    const jan2027_jan1 = jan1Out.find((p) => p.year === 2027 && p.month0 === 0)!;
    const jan2027_jan2 = jan2Out.find((p) => p.year === 2027 && p.month0 === 0)!;
    expect(jan2027_jan1.total).toBeGreaterThan(0);
    expect(jan2027_jan2.total).toBeGreaterThan(0);
  });
});
