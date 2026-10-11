/**
 * End-to-end regression for the working-years Roth-conversions editor default
 * window. The bug class is a UI↔engine SEMANTIC mismatch, so this test
 * does NOT assert at the UI layer — it takes the editor's exact default-Add
 * stored output (via the same save helper the Save button uses) and runs it
 * through the deterministic engine pre-pass (`computePreRetirementRothConversions`,
 * which calls `resolveWorkingYears`), binding the stored window to the engine's
 * converted-year set.
 *
 * It pins the established window contract — shared with the sibling MAGI-cap
 * editor (`resolveEndMonth`'s `year` case maps `end:{kind:'year', year:Y}` to
 * Jan 1 of Y+1, so the engine's half-open `[startYear, endYear)` MONTH window
 * fully INCLUDES calendar year Y):
 *   (a) the default Add converts AT LEAST ONE working year (never the zero-year
 *       default), and
 *   (b) a single-year entry (`start = end = year Y`) converts EXACTLY calendar
 *       year Y — the "Convert through Y" label is honest.
 */
import { describe, expect, it } from 'vitest';
import { defaultConversion } from './scenario-roth-conversions-editor';
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
// Born 1975 → RMD trigger 75 (2050); retires far in the future so the window is
// only ever bounded by the entry's own anchors (never the working-years cap).
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

/** Run a draft list through the SAME save helper the editor's Save button uses,
 *  then the deterministic engine pre-pass — returns the converted calendar-year
 *  set for the source account (the engine's `resolveWorkingYears` output). */
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

describe('roth-conversions editor default window ↔ engine', () => {
  it('default Add converts at least one working year (no zero-year default)', () => {
    const seed = defaultConversion('pre', 'roth');
    const years = convertedYears([seed]);
    // The zero-year bug would yield an EMPTY set; the real semantics yield
    // exactly the current calendar year (a one-year "convert $X in year Y").
    expect(years.length).toBeGreaterThanOrEqual(1);
    expect(years).toEqual([THIS_YEAR]);
  });

  it('a single-year entry (start = end = year Y) converts exactly calendar year Y', () => {
    const Y = THIS_YEAR + 3;
    const single: DraftRothConversion = {
      ...defaultConversion('pre', 'roth'),
      start: { kind: 'year', year: Y },
      end: { kind: 'year', year: Y },
    };
    expect(convertedYears([single])).toEqual([Y]);
  });

  it('a multi-year window (start Y .. end Y+2) converts Y, Y+1, Y+2 inclusive', () => {
    const Y = THIS_YEAR + 1;
    const span: DraftRothConversion = {
      ...defaultConversion('pre', 'roth'),
      start: { kind: 'year', year: Y },
      end: { kind: 'year', year: Y + 2 },
    };
    // "Convert through Y+2" is inclusive of Y+2 — three converted years.
    expect(convertedYears([span])).toEqual([Y, Y + 1, Y + 2]);
  });
});
