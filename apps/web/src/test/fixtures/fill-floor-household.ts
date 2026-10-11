/**
 * Test-only fixture: a single-member, well-funded Fill-mode household with a
 * floored cash-like account (`cash1`) and a large unfloored one (`cash2`).
 *
 * Shared by the Monte Carlo suite and the cross-engine pin suite so both drive
 * the same aggregate → projection pipeline. Never imported by production code.
 */
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  MagiCapOverride,
  SocialSecurityBenefitPayload,
} from '../../db/types.js';
import type { ScenarioAggregate } from '../../lib/scenario-resolution.js';

export const FILL_FLOOR_TODAY = new Date('2026-06-15T00:00:00Z');
/** The `cash1` per-account floor, in dollars. */
export const CASH1_FLOOR = 150_000;

export function fMember(id: string, birthYear: number): Aggregate<HouseholdMemberPayload> {
  return {
    id, householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
    aggregateType: 'householdMember',
    payload: { isPrimary: true, firstName: 'John', lastName: 'Doe', email: `${id}@example.test`, birthdate: `${birthYear}-01-01` },
  };
}

export function fSs(memberId: string, pia: number): Aggregate<SocialSecurityBenefitPayload> {
  return {
    id: `ss-${memberId}`, householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
    aggregateType: 'socialSecurityBenefit',
    payload: { householdMemberId: memberId, pia, piaAsOfDate: '2026-01-01', notes: null },
  };
}

export function fAccount(
  id: string,
  type: AccountPayload['type'],
  taxTreatment: AccountPayload['taxTreatment'],
): Aggregate<AccountPayload> {
  return {
    id, householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
    aggregateType: 'account',
    payload: {
      name: id, type, ownershipType: 'INDIVIDUAL', taxTreatment, ownerId: 'm1', institution: 'V', notes: '',
      planningReturnPct: 5, active: true, plannedContributionPreTax: 0, plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
    },
  };
}

export function fBalance(accountId: string, endingBalance: number): Aggregate<AccountBalancePayload> {
  return {
    id: `b-${accountId}`, householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
    aggregateType: 'accountBalance',
    payload: {
      accountId, year: 2025, lastUpdated: '2025-12-31', startingBalance: endingBalance * 0.9,
      startingBalancePreTax: null, startingBalancePostTax: null, contributionsPreTax: null, contributionsPostTax: null,
      companyContributions: 0, companyContributionsPreTax: null, companyContributionsPostTax: null,
      rollover: 0, distributions: 0, endingBalance, endingBalancePreTax: null, endingBalancePostTax: null,
      totalContributions: 0, comment: null,
    },
  };
}

export function fExpense(annual: number): Aggregate<ExpensePayload> {
  return {
    id: 'living', householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
    aggregateType: 'expense',
    payload: {
      name: 'living', categoryId: 'cat-housing', amount: annual, frequency: 'yearly',
      classification: 'essential', start: { kind: 'retirementStart' }, end: { kind: 'lifetime', whose: 'last' },
    },
  };
}

/** A well-funded single-member Fill-mode household. `cash1` (floored, drawn
 *  FIRST for conversion-tax funding) carries only a small above-floor slice, so
 *  the conversion tax pulls it to exactly its floor in the first conversion
 *  year; `cash2` (unfloored, large) covers every later need so the plan never
 *  depletes and the last-resort reserve pass never fires. `withFloor === false`
 *  omits the `accountFloors` override (the no-op control). */
export function flooredFillArgs(opts: { withFloor: boolean }) {
  const magiCap: MagiCapOverride = {
    windows: [
      {
        start: { kind: 'retirementStart' },
        end: { kind: 'age', memberId: 'primary', years: 85, months: 0 },
        magiCeilingAnnualDollars: 120_000,
        capMode: 'fill',
        capMagiLine: 'irmaa',
        targetRothAccountId: 'roth',
      },
    ],
  };
  const scenario: ScenarioAggregate = {
    id: 's', householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
    aggregateType: 'scenario',
    payload: {
      name: 'FloorFill', description: '', parentScenarioId: null, isPrimary: true, notes: '',
      overrides: {
        retirementAge: { primary: { ageYears: 64, ageMonths: 0 }, secondary: { ageYears: 64, ageMonths: 0 } },
        socialSecurity: { primary: { ageYears: 67, ageMonths: 0 }, secondary: { ageYears: 67, ageMonths: 0 } },
        inflation: { ratePct: 2 }, // NON-ZERO: nominal balances diverge from real.
        lifeExpectancy: { primary: 90, secondary: 90 },
        withdrawalStrategy: { kind: 'taxEfficient' },
        magiCap,
        ...(opts.withFloor
          ? { accountFloors: { perAccount: { cash1: { floorDollars: CASH1_FLOOR } } } }
          : {}),
      },
    },
  };
  return {
    scenarioId: 's',
    scenarios: [scenario],
    accounts: [
      fAccount('ira', 'RETIREMENT_IRA', 'PRE_TAX'),
      fAccount('roth', 'RETIREMENT_ROTH_IRA', 'ROTH'),
      fAccount('cash1', 'SAVINGS', 'POST_TAX'),
      fAccount('cash2', 'SAVINGS', 'POST_TAX'),
    ],
    balances: [
      fBalance('ira', 800_000),
      fBalance('roth', 0),
      fBalance('cash1', 160_000), // only $10k sits above the $150k floor
      fBalance('cash2', 2_500_000),
    ],
    members: [fMember('m1', 1962)],
    ssBenefits: [fSs('m1', 2000)],
    expenses: [fExpense(30_000)],
    incomeStreams: [],
    todayYear: FILL_FLOOR_TODAY.getUTCFullYear(),
    todayMonthIndex: FILL_FLOOR_TODAY.getUTCMonth(),
  };
}
