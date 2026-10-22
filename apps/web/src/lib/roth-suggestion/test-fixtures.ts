/**
 * Hand-built households for the Roth suggestion tests, small enough that every
 * number can be reasoned about. The demo dataset covers the realistic case;
 * these cover the shapes it does not: spending above the 12 % ceiling with and
 * without a later taxable account, a spouse who dies inside the window, and the
 * unsupported households.
 */
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  ScenarioOverrides,
  SocialSecurityBenefitPayload,
} from '../../db/types';
import type { ScenarioAggregate } from '../scenario-resolution';
import type { RothSuggestionProjectionInput } from './types';

const TOY_TODAY_YEAR = 2026;
const TOY_TODAY_MONTH = 5;
export const TOY_BIRTH_YEAR = 1966;
const TOY_IRA_ID = 'ira';
export const TOY_ROTH_ID = 'roth';
const TOY_BROKERAGE_ID = 'brk';
const TOY_SCENARIO_ID = 'toy';

const BASE = {
  householdId: 'h',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'd',
} as const;

function member(id: string, isPrimary: boolean, birthYear: number): Aggregate<HouseholdMemberPayload> {
  return {
    ...BASE,
    id,
    aggregateType: 'householdMember',
    payload: {
      isPrimary,
      firstName: id,
      lastName: 'Doe',
      email: `${id}@example.test`,
      birthdate: `${birthYear}-06-15`,
    },
  };
}

function ssBenefit(memberId: string, pia: number): Aggregate<SocialSecurityBenefitPayload> {
  return {
    ...BASE,
    id: `ss-${memberId}`,
    aggregateType: 'socialSecurityBenefit',
    payload: { householdMemberId: memberId, pia, piaAsOfDate: '2026-01-01', notes: null },
  };
}

export function toyAccount(
  id: string,
  ownerId: string,
  type: AccountPayload['type'],
  taxTreatment: AccountPayload['taxTreatment'],
  extra: Partial<AccountPayload> = {},
): Aggregate<AccountPayload> {
  return {
    ...BASE,
    id,
    aggregateType: 'account',
    payload: {
      name: id,
      type,
      ownershipType: 'INDIVIDUAL',
      taxTreatment,
      ownerId,
      institution: 'X',
      notes: '',
      planningReturnPct: 5,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
      ...extra,
    },
  };
}

function balanceRow(accountId: string, year: number, endingBalance: number): Aggregate<AccountBalancePayload> {
  return {
    ...BASE,
    id: `b-${accountId}-${year}`,
    aggregateType: 'accountBalance',
    payload: {
      accountId,
      year,
      lastUpdated: `${year}-12-31`,
      startingBalance: endingBalance * 0.9,
      startingBalancePreTax: null,
      startingBalancePostTax: null,
      contributionsPreTax: null,
      contributionsPostTax: null,
      companyContributions: 0,
      companyContributionsPreTax: null,
      companyContributionsPostTax: null,
      rollover: 0,
      distributions: 0,
      endingBalance,
      endingBalancePreTax: null,
      endingBalancePostTax: null,
      totalContributions: 0,
      comment: null,
    },
  };
}

export function toyBalances(
  balances: Readonly<Record<string, number>>,
): Aggregate<AccountBalancePayload>[] {
  return Object.entries(balances).flatMap(([accountId, dollars]) => [
    balanceRow(accountId, TOY_TODAY_YEAR - 2, dollars * 0.9),
    balanceRow(accountId, TOY_TODAY_YEAR - 1, dollars),
  ]);
}

function toyExpense(annualDollars: number): Aggregate<ExpensePayload> {
  return {
    ...BASE,
    id: 'exp',
    aggregateType: 'expense',
    payload: {
      name: 'Living costs',
      amount: annualDollars,
      frequency: 'yearly',
      classification: 'essential',
      categoryId: 'cat-housing',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    },
  };
}

export function toyScenario(overrides: ScenarioOverrides = {}): ScenarioAggregate {
  return {
    ...BASE,
    id: TOY_SCENARIO_ID,
    aggregateType: 'scenario',
    payload: {
      name: 'Toy',
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides: {
        socialSecurity: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
        },
        retirementAge: {
          primary: { ageYears: 62, ageMonths: 0 },
          secondary: { ageYears: 62, ageMonths: 0 },
        },
        inflation: { ratePct: 2 },
        lifeExpectancy: { primary: 90, secondary: 90 },
        taxFilingPlan: { kind: 'joint' },
        ...overrides,
      },
    },
  };
}

export interface ToyOptions {
  readonly couple?: boolean;
  /** Adds a taxable account beside the IRA and the target Roth IRA. */
  readonly brokerage?: boolean;
  readonly rothBalance?: number;
  readonly iraBalance?: number;
  readonly brokerageBalance?: number;
  readonly annualExpense?: number;
  readonly overrides?: ScenarioOverrides;
}

/** A 60-year-old couple (or single) with a pre-tax IRA, a Roth IRA and an
 *  optional brokerage account, retiring at 62. The RMD trigger age for a 1966
 *  birth is 75, so the conversion window is 2028 through 2040. */
export function toyProjection(options: ToyOptions = {}): RothSuggestionProjectionInput {
  const couple = options.couple ?? true;
  const accounts = [
    toyAccount(TOY_IRA_ID, 'm1', 'RETIREMENT_IRA', 'PRE_TAX'),
    toyAccount(TOY_ROTH_ID, 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH'),
    ...(options.brokerage === true ? [toyAccount(TOY_BROKERAGE_ID, 'm1', 'BROKERAGE', 'POST_TAX')] : []),
  ];
  const balances = toyBalances({
    [TOY_IRA_ID]: options.iraBalance ?? 1_500_000,
    [TOY_ROTH_ID]: options.rothBalance ?? 50_000,
    ...(options.brokerage === true ? { [TOY_BROKERAGE_ID]: options.brokerageBalance ?? 400_000 } : {}),
  });
  const members = [
    member('m1', true, TOY_BIRTH_YEAR),
    ...(couple ? [member('m2', false, TOY_BIRTH_YEAR)] : []),
  ];
  return {
    scenarios: [toyScenario(couple ? options.overrides : { taxFilingPlan: { kind: 'individual' }, ...options.overrides })],
    selectedScenarioId: TOY_SCENARIO_ID,
    accounts,
    balances,
    members,
    ssBenefits: members.map((m) => ssBenefit(m.id, 2_200)),
    expenses: [toyExpense(options.annualExpense ?? 90_000)],
    incomeStreams: [],
    todayYear: TOY_TODAY_YEAR,
    todayMonthIndex: TOY_TODAY_MONTH,
  };
}
