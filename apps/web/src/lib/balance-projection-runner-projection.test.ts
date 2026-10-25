/** Unit tests for the projection and targeted-deposit classification helpers in `balance-projection-runner-projection.ts`. */
import { describe, expect, it } from 'vitest';
import {
  classifyTargetedDeposits,
  buildMemberRetirementMap,
  preProjectCbpAccounts,
  groupBalancesByAccount,
} from './balance-projection-runner-projection';
import { resolveScenario } from './scenario-resolution';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  IncomeStreamPayload,
} from '../db/types';
import type {
  RunBalanceProjectionArgs,
} from './balance-projection-runner-types';
import type { ScenarioAggregate } from './scenario-resolution';
import type { ProjectionOutput } from './projection';

function member(
  id: string,
  isPrimary: boolean,
  birthYear: number,
): Aggregate<HouseholdMemberPayload> {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'householdMember',
    payload: {
      isPrimary,
      firstName: id,
      lastName: 'Doe',
      email: `${id}@example.test`,
      birthdate: `${birthYear}-01-01`,
    },
  };
}

function account(
  id: string,
  ownerId: string,
  taxTreatment: AccountPayload['taxTreatment'] = 'POST_TAX',
  type: AccountPayload['type'] = 'BROKERAGE',
): Aggregate<AccountPayload> {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd',
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
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    },
  };
}

function balanceRow(
  accountId: string,
  year: number,
  endingBalance: number,
): Aggregate<AccountBalancePayload> {
  return {
    id: `${accountId}-${year}`,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'accountBalance',
    payload: {
      accountId,
      year,
      lastUpdated: `${year}-12-31`,
      startingBalance: endingBalance,
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

function oneOffStream(
  id: string,
  memberId: string,
  targetAccountId: string,
  year: number,
  amount: number,
): Aggregate<IncomeStreamPayload> {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'incomeStream',
    payload: {
      name: id,
      memberId,
      kind: 'oneOff',
      oneOffAmount: amount,
      source: 'inheritance',
      targetAccountId,
      start: { kind: 'year', year },
    },
  };
}

function cbpLumpSumStream(
  id: string,
  memberId: string,
  cbpAccountId: string,
  targetAccountId: string,
  year: number,
): Aggregate<IncomeStreamPayload> {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'incomeStream',
    payload: {
      name: id,
      memberId,
      kind: 'pension',
      payoutType: 'lumpSum',
      lumpSumAmount: 0,
      linkedCbpAccountId: cbpAccountId,
      targetAccountId,
      start: { kind: 'year', year },
    },
  };
}

function scenario(id: string): ScenarioAggregate {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'scenario',
    payload: {
      name: 'Base',
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      // 0% inflation so event-month dollars equal the entered amount, keeping bucket assertions exact.
      overrides: { inflation: { ratePct: 0 } },
    },
  };
}

const PRIMARY_RET_YEAR = 2046;
const PRIMARY_RET_ABS_MONTH = PRIMARY_RET_YEAR * 12; // Jan 2046

function baseArgs(opts: {
  accounts: Aggregate<AccountPayload>[];
  incomeStreams: Aggregate<IncomeStreamPayload>[];
  members: Aggregate<HouseholdMemberPayload>[];
  balances?: Aggregate<AccountBalancePayload>[];
}): RunBalanceProjectionArgs {
  return {
    scenarioId: 's',
    scenarios: [scenario('s')],
    accounts: opts.accounts,
    balances: opts.balances ?? [],
    members: opts.members,
    ssBenefits: [],
    expenses: [],
    incomeStreams: opts.incomeStreams,
    todayYear: 2026,
    todayMonthIndex: 5,
  };
}

function classifyInputs(opts: {
  accounts: Aggregate<AccountPayload>[];
  incomeStreams: Aggregate<IncomeStreamPayload>[];
  primary?: Aggregate<HouseholdMemberPayload>;
  secondary?: Aggregate<HouseholdMemberPayload>;
  cbpProjectionByAccount?: Map<string, ProjectionOutput>;
}) {
  const primary = opts.primary ?? member('m1', true, 1980);
  const members = [primary, ...(opts.secondary ? [opts.secondary] : [])];
  const args = baseArgs({
    accounts: opts.accounts,
    incomeStreams: opts.incomeStreams,
    members,
  });
  const resolved = resolveScenario('s', [...args.scenarios]);
  return {
    args,
    primary,
    secondary: opts.secondary,
    primaryRetirementAbsMonth: PRIMARY_RET_ABS_MONTH,
    primaryRetirementYear: PRIMARY_RET_YEAR,
    primaryRetirementMonth0: 0,
    resolved,
    retirementByMember: new Map<string, string | null>([
      ['m1', `${PRIMARY_RET_YEAR}-01-01`],
    ]),
    cbpProjectionByAccount:
      opts.cbpProjectionByAccount ?? new Map<string, ProjectionOutput>(),
  };
}

describe('classifyTargetedDeposits', () => {
  it('should return empty maps, when there are no income streams', () => {
    const inputs = classifyInputs({ accounts: [], incomeStreams: [] });
    const result = classifyTargetedDeposits(inputs);
    expect(result.preDepositsByAccount.size).toBe(0);
    expect(result.cbpLumpSumEventAbsMonth.size).toBe(0);
  });

  it('should route a PRE_TAX target deposit to the preTax bucket', () => {
    const acct = account('a1', 'm1', 'PRE_TAX');
    const inputs = classifyInputs({
      accounts: [acct],
      incomeStreams: [oneOffStream('w1', 'm1', 'a1', 2030, 50_000)],
    });
    const result = classifyTargetedDeposits(inputs);
    const entries = result.preDepositsByAccount.get('a1');
    expect(entries).toBeDefined();
    expect(entries![0]).toMatchObject({
      year: 2030,
      month0: 0,
      preTax: 50_000,
      postTax: 0,
    });
  });

  it('should route a non-PRE_TAX target deposit (incl. HSA) to the postTax bucket', () => {
    const post = account('a1', 'm1', 'POST_TAX');
    const hsa = account('a2', 'm1', 'HSA');
    const inputs = classifyInputs({
      accounts: [post, hsa],
      incomeStreams: [
        oneOffStream('w1', 'm1', 'a1', 2030, 20_000),
        oneOffStream('w2', 'm1', 'a2', 2031, 7_000),
      ],
    });
    const result = classifyTargetedDeposits(inputs);
    expect(result.preDepositsByAccount.get('a1')![0]).toMatchObject({
      preTax: 0,
      postTax: 20_000,
    });
    expect(result.preDepositsByAccount.get('a2')![0]).toMatchObject({
      preTax: 0,
      postTax: 7_000,
    });
  });

  it('should exclude an event at/after primary retirement from pre-retirement deposits', () => {
    const acct = account('a1', 'm1', 'POST_TAX');
    const inputs = classifyInputs({
      accounts: [acct],
      incomeStreams: [oneOffStream('w1', 'm1', 'a1', PRIMARY_RET_YEAR, 10_000)],
    });
    const result = classifyTargetedDeposits(inputs);
    expect(result.preDepositsByAccount.has('a1')).toBe(false);
  });

  it('should record cbpLumpSumEventAbsMonth = year*12+month0, for a pre-retirement linked-CBP event', () => {
    // A linked-CBP lump sum 2 years before primary retirement; the CBP balance lookup must be positive or the event is dropped,
    // so a CBP projection is seeded.
    const target = account('target', 'm1', 'POST_TAX');
    const cbp = account('cbp1', 'm1', 'PRE_TAX', 'RETIREMENT_CASH_BALANCE');
    const eventYear = PRIMARY_RET_YEAR - 2; // 2044
    const firstYear = 2026;
    const len = (2086 - firstYear + 1) * 12;
    const cbpProj = {
      total: 100_000,
      perStep: {
        firstYear,
        preEnd: new Float64Array(len).fill(100_000),
        postEnd: new Float64Array(len),
      },
    } as unknown as ProjectionOutput;
    const inputs = classifyInputs({
      accounts: [target, cbp],
      incomeStreams: [
        cbpLumpSumStream('p1', 'm1', 'cbp1', 'target', eventYear),
      ],
      cbpProjectionByAccount: new Map([['cbp1', cbpProj]]),
    });
    const result = classifyTargetedDeposits(inputs);
    expect(result.cbpLumpSumEventAbsMonth.get('cbp1')).toBe(eventYear * 12 + 0);
  });

  it('should discover a post-primary linked-CBP lump-sum via the second loop', () => {
    // A linked-CBP lump sum after primary retirement: the first loop drops it (the lookup returns null), so only the second loop
    // records the event month.
    const target = account('target', 'm1', 'POST_TAX');
    const cbp = account('cbp1', 'm1', 'PRE_TAX', 'RETIREMENT_CASH_BALANCE');
    const eventYear = PRIMARY_RET_YEAR + 3; // 2049
    const inputs = classifyInputs({
      accounts: [target, cbp],
      incomeStreams: [
        cbpLumpSumStream('p1', 'm1', 'cbp1', 'target', eventYear),
      ],
    });
    const result = classifyTargetedDeposits(inputs);
    expect(result.cbpLumpSumEventAbsMonth.get('cbp1')).toBe(eventYear * 12 + 0);
    expect(result.preDepositsByAccount.has('target')).toBe(false);
  });

  it('should NOT overwrite an existing earlier cbpLumpSumEventAbsMonth in the second loop', () => {
    // Two lump-sum streams linked to one CBP, one pre-retirement (first loop) and one post-retirement: the second loop must not
    // clobber the earlier entry.
    const target = account('target', 'm1', 'POST_TAX');
    const cbp = account('cbp1', 'm1', 'PRE_TAX', 'RETIREMENT_CASH_BALANCE');
    const preYear = PRIMARY_RET_YEAR - 2; // 2044
    const postYear = PRIMARY_RET_YEAR + 3; // 2049
    const firstYear = 2026;
    const len = (2086 - firstYear + 1) * 12;
    const cbpProj = {
      total: 100_000,
      perStep: {
        firstYear,
        preEnd: new Float64Array(len).fill(100_000),
        postEnd: new Float64Array(len),
      },
    } as unknown as ProjectionOutput;
    const inputs = classifyInputs({
      accounts: [target, cbp],
      incomeStreams: [
        cbpLumpSumStream('pPre', 'm1', 'cbp1', 'target', preYear),
        cbpLumpSumStream('pPost', 'm1', 'cbp1', 'target', postYear),
      ],
      cbpProjectionByAccount: new Map([['cbp1', cbpProj]]),
    });
    const result = classifyTargetedDeposits(inputs);
    expect(result.cbpLumpSumEventAbsMonth.get('cbp1')).toBe(preYear * 12 + 0);
  });
});

describe('buildMemberRetirementMap', () => {
  it('should map a valid ISO date to {year, month0}', () => {
    const input = new Map<string, string | null>([['m1', '2031-07-01']]);
    const out = buildMemberRetirementMap(input);
    expect(out.get('m1')).toEqual({ year: 2031, month0: 6 });
  });

  it('should leave month0 undefined, when the month is out of range', () => {
    // Month "13" is invalid.
    const input = new Map<string, string | null>([['m1', '2031-13-01']]);
    const out = buildMemberRetirementMap(input);
    expect(out.get('m1')).toEqual({ year: 2031, month0: undefined });
  });

  it('should omit the member, when the iso is null', () => {
    const input = new Map<string, string | null>([['m1', null]]);
    const out = buildMemberRetirementMap(input);
    expect(out.has('m1')).toBe(false);
  });

  it('should omit the member, when the year is non-numeric', () => {
    const input = new Map<string, string | null>([['m1', 'XXXX-07-01']]);
    const out = buildMemberRetirementMap(input);
    expect(out.has('m1')).toBe(false);
  });
});

describe('preProjectCbpAccounts', () => {
  function preProjectInputs(opts: {
    activeAccounts: Aggregate<AccountPayload>[];
    balances: Aggregate<AccountBalancePayload>[];
    retirementByMember?: Map<string, string | null>;
  }) {
    const args = baseArgs({
      accounts: opts.activeAccounts,
      incomeStreams: [],
      members: [member('m1', true, 1980)],
      balances: opts.balances,
    });
    return {
      activeAccounts: opts.activeAccounts,
      args,
      resolved: resolveScenario('s', [...args.scenarios]),
      primaryRetIso: `${PRIMARY_RET_YEAR}-01-01`,
      retirementByMember:
        opts.retirementByMember ?? new Map<string, string | null>(),
    };
  }

  it('should ignore non-CBP accounts', () => {
    const broker = account('a1', 'm1', 'POST_TAX', 'BROKERAGE');
    const inputs = preProjectInputs({
      activeAccounts: [broker],
      balances: [balanceRow('a1', 2025, 100_000)],
    });
    const out = preProjectCbpAccounts(inputs);
    expect(out.size).toBe(0);
  });

  it('should skip a CBP account with zero balance rows', () => {
    const cbp = account('cbp1', 'm1', 'PRE_TAX', 'RETIREMENT_CASH_BALANCE');
    const inputs = preProjectInputs({
      activeAccounts: [cbp],
      balances: [],
    });
    const out = preProjectCbpAccounts(inputs);
    expect(out.has('cbp1')).toBe(false);
  });

  it('should project a CBP account using primary retirement ISO, when the owner has no retirement date', () => {
    // The owner has no retirement entry (retirementByMember is empty), so it falls back to primaryRetIso.
    const cbp = account('cbp1', 'm1', 'PRE_TAX', 'RETIREMENT_CASH_BALANCE');
    const inputs = preProjectInputs({
      activeAccounts: [cbp],
      balances: [balanceRow('cbp1', 2025, 80_000)],
      retirementByMember: new Map(),
    });
    const out = preProjectCbpAccounts(inputs);
    expect(out.has('cbp1')).toBe(true);
    expect(out.get('cbp1')?.total).toBeGreaterThan(0);
  });
});

describe('groupBalancesByAccount', () => {
  it('should group multi-account balance rows by accountId', () => {
    const rows = [
      balanceRow('a1', 2024, 100),
      balanceRow('a2', 2024, 200),
      balanceRow('a1', 2025, 110),
    ];
    const grouped = groupBalancesByAccount(rows);
    expect(grouped.get('a1')!.map((r) => r.payload.year)).toEqual([2024, 2025]);
    expect(grouped.get('a2')!.map((r) => r.payload.year)).toEqual([2024]);
    expect(grouped.size).toBe(2);
  });
});
