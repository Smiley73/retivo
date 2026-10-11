/**
 * SSA day-1 rule (POMS GN 00302.400) tests for the SS projection engines.
 * Covers year-mode and month-index-mode claim-year / claim-month derivation
 * when a member is born on the 1st of a month (or January 1 of a year).
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

// SSA day-1 rule (POMS GN 00302.400): born on the 1st of any month is
// treated as born in the prior month for benefit purposes; Jan 1 of a
// year → prior year's cohort → earlier FRA + earlier claim year.
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
    // Jan 1 1960: claim year = 2026. 2025 → pre-claim (0); 2026 → claims.
    // Note: the 1959 cohort FRA is 66y10m (802 months) so claiming at 67
    // (804 months) earns 2 months of DRCs → annual slightly above $12k.
    // The Jan-1-born benefit month is Dec (day-1 shift), so the claim
    // year is prorated to ~1/12; the first FULL post-claim year is 2027.
    const jan1Out = projectSsByYear(makeCtx('1960-01-01'), { from: 2025, to: 2028 });
    expect(jan1Out[0].total).toBe(0);          // 2025 — not yet
    expect(jan1Out[1].total).toBeGreaterThan(0); // 2026 — claim year (prorated, positive)
    // 2027 and 2028 are full post-claim years at the same rate (colaPct=0).
    expect(jan1Out[3].total).toBeCloseTo(jan1Out[2].total, 0);
    // Claim-year (2026) is strictly below the full-year rate (proration).
    expect(jan1Out[1].total).toBeLessThan(jan1Out[2].total);

    // Jan 2 1960: benefit birth year = 1960, FRA = 67 (804 months), claim = 67
    // → factor 1.0 → annual = $12k exactly. Claim year = 2027 (Jan birth
    // month → full year, no day-1 proration).
    const jan2Out = projectSsByYear(makeCtx('1960-01-02'), { from: 2025, to: 2027 });
    expect(jan2Out[0].total).toBe(0);          // 2025
    expect(jan2Out[1].total).toBe(0);          // 2026 — still pre-claim
    expect(jan2Out[2].total).toBeCloseTo(12_000, 0); // 2027 — claim year, FRA exactly, full year
  });
});

// projectSsByMonth SSA day-1 rule — month precision.
describe('projectSsByMonth — SSA day-1 rule month precision', () => {
  it('born Jan 1 1960 claims one calendar month earlier than born Jan 2 1960', () => {
    // Jan 1 1960 → benefit birth year 1959, birth month0 = 11 (Dec).
    // Claim age 67 → claimMonthFor: Dec + 67×12 months = month0 11 + 804 = 815 total
    // months from benefit year 1959: year = 1959 + floor(815/12) = 1959 + 67 = 2026,
    // month0 = 815 % 12 = 11 → Dec 2026.
    //
    // Jan 2 1960 → benefit birth year 1960, birth month0 = 0 (Jan, no day-1 shift).
    // Claim age 67 → 0 + 804 = 804 total months from 1960:
    // year = 1960 + 67 = 2027, month0 = 0 → Jan 2027.
    //
    // So Jan 1 birth claims Dec 2026; Jan 2 birth claims Jan 2027.
    // In Dec 2026: Jan1-born is claiming, Jan2-born is not.
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

    // Dec 2026: Jan1-born claims; Jan2-born does not.
    const dec2026_jan1 = jan1Out.find((p) => p.year === 2026 && p.month0 === 11)!;
    const dec2026_jan2 = jan2Out.find((p) => p.year === 2026 && p.month0 === 11)!;
    expect(dec2026_jan1.total).toBeGreaterThan(0);
    expect(dec2026_jan2.total).toBe(0);

    // Jan 2027: both claiming.
    const jan2027_jan1 = jan1Out.find((p) => p.year === 2027 && p.month0 === 0)!;
    const jan2027_jan2 = jan2Out.find((p) => p.year === 2027 && p.month0 === 0)!;
    expect(jan2027_jan1.total).toBeGreaterThan(0);
    expect(jan2027_jan2.total).toBeGreaterThan(0);
  });
});
