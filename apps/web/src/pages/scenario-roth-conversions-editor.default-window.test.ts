// Binds the Roth-conversions editor's stored window to the engine's converted-year set (a UI↔engine semantic mismatch can't be caught at the UI layer): `resolveEndMonth` maps `end:{kind:'year', year:Y}` to Jan 1 of Y+1, so the half-open `[startYear, endYear)` window includes calendar year Y, as in the MAGI-cap editor.
// A single-year entry (`start = end = Y`) converts exactly Y, so "Convert through Y" is honest.
import { describe, expect, it } from 'vitest';
import { buildNextRothConversions } from './scenario-roth-conversions-save-helpers';
import type { DraftRothConversion } from './scenario-roth-conversions-draft-hook';
import { computePreRetirementRothConversions } from '../lib/roth-conversion-projection';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  ScenarioPayload,
} from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

const HH = 'hh-1';
const THIS_YEAR = new Date().getFullYear();

function agg<T extends Record<string, unknown>>(
  id: string,
  aggregateType: string,
  payload: T,
): Aggregate<T> {
  return {
    id,
    householdId: HH,
    aggregateType: aggregateType as Aggregate<T>['aggregateType'],
    schemaVersion: 1,
    version: 1,
    updatedAt: '2025-12-31T00:00:00Z',
    deviceId: 'd1',
    payload,
  };
}

function account(id: string, p: Partial<AccountPayload>): Aggregate<AccountPayload> {
  return agg<AccountPayload>(id, 'account', {
    name: id,
    type: p.type ?? 'RETIREMENT_401K',
    ownershipType: 'INDIVIDUAL',
    taxTreatment: p.taxTreatment ?? 'PRE_TAX',
    ownerId: p.ownerId ?? 'm1',
    institution: 'Bank',
    notes: '',
    planningReturnPct: 0,
    active: true,
    plannedContributionPreTax: 0,
    plannedContributionPostTax: 0,
    assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
  });
}

function balance(accountId: string, endingBalance: number): Aggregate<AccountBalancePayload> {
  return agg<AccountBalancePayload>(`bal-${accountId}`, 'accountBalance', {
    accountId,
    year: 2025,
    lastUpdated: '2025-12-31T00:00:00Z',
    startingBalance: 0,
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
  });
}

function member(id: string, birthdate: string): Aggregate<HouseholdMemberPayload> {
  return agg<HouseholdMemberPayload>(id, 'householdMember', {
    isPrimary: true,
    firstName: id,
    lastName: 'X',
    email: `${id}@x.test`,
    birthdate,
  } as HouseholdMemberPayload);
}

const SRC = account('pre', { type: 'RETIREMENT_401K', taxTreatment: 'PRE_TAX', ownerId: 'm1' });
const ROTH = account('roth', { type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH', ownerId: 'm1' });
// Born 1975 gives an RMD trigger at 75 (2050); retiring far in the future means the window is only bounded by the entry's own anchors, never the working-years cap.
const M1 = member('m1', '1975-06-01');

function scenarioWith(overrides: ScenarioPayload['overrides']): ScenarioAggregate {
  return agg<ScenarioPayload>('p', 'scenario', {
    name: 'Base',
    description: '',
    parentScenarioId: null,
    isPrimary: true,
    notes: '',
    overrides,
  });
}

// Run drafts through the save helper the editor's Save uses, then the deterministic engine pre-pass; returns the converted calendar-year set for the source account.
function convertedYears(drafts: DraftRothConversion[]): number[] {
  const accounts = [SRC, ROTH];
  const { preRetirementRothConversions } = buildNextRothConversions({ drafts, accounts });
  const r = computePreRetirementRothConversions({
    scenarioId: 'p',
    scenarios: [
      scenarioWith({
        preRetirementRothConversions,
      }),
    ],
    accounts,
    balances: [balance('pre', 1_000_000)],
    members: [M1],
    retirementByMember: new Map<string, string | null>([['m1', '2090-01-01']]),
    primaryRetIso: '2090-01-01',
    todayYear: THIS_YEAR,
    todayMonthIndex: 0,
    stopContributionsToday: true,
  });
  return (r.preWithdrawalsByAccount.get('pre') ?? []).map((w) => w.year).sort((a, b) => a - b);
}

const draft = (startYear: number, endYear: number): DraftRothConversion => ({
  draftId: 'd1',
  sourceAccountId: 'pre',
  targetRothAccountId: 'roth',
  annualAmountDollars: 10000,
  start: { kind: 'year', year: startYear },
  end: { kind: 'year', year: endYear },
});

describe('roth-conversions window ↔ engine', () => {
  it('a single-year entry (start = end = year Y) converts exactly calendar year Y', () => {
    const Y = THIS_YEAR + 3;
    expect(convertedYears([draft(Y, Y)])).toEqual([Y]);
  });

  it('a multi-year window (start Y .. end Y+2) converts Y, Y+1, Y+2 inclusive', () => {
    const Y = THIS_YEAR + 1;
    expect(convertedYears([draft(Y, Y + 2)])).toEqual([Y, Y + 1, Y + 2]);
  });
});
