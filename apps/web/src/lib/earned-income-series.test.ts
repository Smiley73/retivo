import { describe, expect, it } from 'vitest';
import {
  buildEarnedIncomeSeries,
  earliestSsEntitlementYear,
} from './earned-income-series';
import { buildIncomeContext } from './income-projection';
import { buildSsContext, projectSsByYear } from './ss-projection';
import type { ResolvedIncomeStream } from './income-resolution';
import type {
  Aggregate,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';

const memberAgg = (
  id: string,
  payload: Partial<HouseholdMemberPayload> & { birthdate: string; isPrimary: boolean },
): Aggregate<HouseholdMemberPayload> => ({
  id,
  householdId: 'h',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  deviceId: 'd',
  aggregateType: 'householdMember',
  payload: {
    firstName: 'Test',
    lastName: 'Member',
    email: 'test@example.com',
    ...payload,
  },
});

const stream = (
  id: string,
  payload: IncomeStreamPayload,
): ResolvedIncomeStream => ({
  id,
  source: 'canonical' as const,
  payload,
});

const members = [
  memberAgg('p', { birthdate: '1964-03-12', isPrimary: true }),
  memberAgg('s', { birthdate: '1965-06-15', isPrimary: false }),
];

const incomeCtx = () => ({
  ...buildIncomeContext(members, {
    retirementStartYear: 2026,
    lifeExpectancyPrimary: 90,
    lifeExpectancySecondary: 92,
    retirementDateByMember: new Map<string, { year: number; month0?: number }>([
      ['p', { year: 2026 }],
      ['s', { year: 2026 }],
    ]),
  }),
  retirementMonth0: 0,
});

const partTime = (id: string, memberId: string, annualAmount: number): ResolvedIncomeStream =>
  stream(id, {
    name: `PT-${id}`,
    kind: 'partTime',
    memberId,
    annualAmount,
    start: { kind: 'year', year: 2026 },
    end: { kind: 'year', year: 2027 },
    colaPct: 0,
  } as IncomeStreamPayload);

describe('buildEarnedIncomeSeries', () => {
  it('returns undefined when there are no part-time streams', () => {
    const pension = stream('pen', {
      name: 'Pension',
      kind: 'pension',
      payoutType: 'annuity',
      memberId: 'p',
      monthlyBenefit: 1_000,
      start: { kind: 'year', year: 2026 },
      colaPct: 0,
    } as IncomeStreamPayload);
    expect(
      buildEarnedIncomeSeries([pension], incomeCtx(), { from: 2026, to: 2030 }),
    ).toBeUndefined();
  });

  it('rolls up per-member annual dollars and actual per-month dollars', () => {
    const series = buildEarnedIncomeSeries(
      [partTime('a', 'p', 24_000), partTime('b', 's', 12_000)],
      incomeCtx(),
      { from: 2026, to: 2028 },
    );
    expect(series).toBeDefined();
    expect(series!.annualByMember.p[2026]).toBeCloseTo(24_000, 6);
    expect(series!.annualByMember.p[2027]).toBeCloseTo(24_000, 6);
    expect(series!.annualByMember.p[2028]).toBeUndefined();
    expect(series!.monthlyByMember.p[2026]).toHaveLength(12);
    expect(series!.monthlyByMember.p[2026][0]).toBeCloseTo(2_000, 6);
    expect(series!.annualByMember.s[2026]).toBeCloseTo(12_000, 6);
  });

  it('feeds the SS earnings test identically on any consuming surface', () => {
    const benefit: Aggregate<SocialSecurityBenefitPayload> = {
      id: 'ss-p',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      deviceId: 'd',
      aggregateType: 'socialSecurityBenefit',
      payload: { householdMemberId: 'p', pia: 1_200, piaAsOfDate: null, notes: null },
    };
    const series = buildEarnedIncomeSeries(
      [partTime('a', 'p', 60_000)],
      incomeCtx(),
      { from: 2026, to: 2028 },
    );
    const ctxFor = (earned: typeof series) =>
      buildSsContext(members, [benefit], {
        claimAgePrimary: { ageYears: 62, ageMonths: 0 },
        claimAgeSecondary: { ageYears: 67, ageMonths: 0 },
        lifeExpectancyPrimary: 90,
        lifeExpectancySecondary: 92,
        colaPct: 0,
        benefitReductionPct: 0,
        earnedIncomeByMemberYear: earned?.annualByMember,
        earnedIncomeMonthlyByMemberYear: earned?.monthlyByMember,
        earningsTestInflationRatePct: 0,
      });
    const withEarnings = projectSsByYear(ctxFor(series)!, { from: 2027, to: 2027 });
    const withoutEarnings = projectSsByYear(ctxFor(undefined)!, { from: 2027, to: 2027 });
    expect(withEarnings[0].total).toBeLessThan(withoutEarnings[0].total);
  });
});

// The shared series must start no later than the earliest SS entitlement year, so the earnings-test/ARF warm-up sees pre-retirement years.
describe('earliestSsEntitlementYear', () => {
  it('returns the earliest own-claim year across members', () => {
    expect(
      earliestSsEntitlementYear(members, {
        primary: { ageYears: 67, ageMonths: 0 },
        secondary: { ageYears: 62, ageMonths: 0 },
      }),
    ).toBe(1965 + 62);
  });

  it('a survivor claim age earlier than both own claims wins', () => {
    expect(
      earliestSsEntitlementYear(members, {
        primary: { ageYears: 67, ageMonths: 0 },
        secondary: { ageYears: 67, ageMonths: 0 },
        survivor: { secondary: { ageYears: 60, ageMonths: 0 } },
      }),
    ).toBe(1965 + 60);
  });

  it('defaults an absent claim age to 67 (the context-builder default)', () => {
    expect(earliestSsEntitlementYear(members, undefined)).toBe(1964 + 67);
  });

  it('returns null when no member has a parseable birthdate', () => {
    expect(
      earliestSsEntitlementYear([{ payload: { isPrimary: true } }], undefined),
    ).toBeNull();
  });
});
