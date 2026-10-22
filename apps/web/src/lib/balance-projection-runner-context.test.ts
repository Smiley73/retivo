/** Tests for the per-account drawdown ledger and the Roth basis seeds built by the pipeline context. */
import { describe, expect, it } from 'vitest';
import {
  buildPerAccountDrawdownLedger,
  buildPipelineContext,
} from './balance-projection-runner-context';
import { emptyMonthlySeries } from './monthly-cashflow';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';
import type {
  PipelineContext,
  AccountProjection,
  RunBalanceProjectionArgs,
} from './balance-projection-runner-types';
import type { ProjectionOutput } from './projection';
import type { ScenarioAggregate } from './scenario-resolution';

function account(
  id: string,
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
      ownerId: 'm1',
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

function makeProj(
  acct: Aggregate<AccountPayload>,
  totalAtRet: number,
): AccountProjection {
  const planned: ProjectionOutput = {
    total: totalAtRet,
    accumulationGrowth: 0,
    perStep: {
      firstYear: 2026,
      preEnd: new Float64Array([totalAtRet]),
      postEnd: new Float64Array([0]),
      growthCarry: new Float64Array([0]),
      contribCarry: new Float64Array([0]),
    },
  } as unknown as ProjectionOutput;
  return {
    account: acct,
    latestBalance: totalAtRet,
    ownerRetirementDate: '2046-01-01',
    outputs: { planned, twr: null },
    ratePctByMethod: { planned: 5, twr: null },
    perMonthContribution: { preTax: 0, postTax: 0 },
  };
}

function pensionStream(
  id: string,
  memberId: string,
  cbpAccountId: string,
  targetAccountId: string,
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
      lumpSumAmount: 0, // unused — bundle reads source CBP balance
      linkedCbpAccountId: cbpAccountId,
      targetAccountId,
      start: { kind: 'retirementStart' },
    },
  };
}

function baseScenario(id: string): ScenarioAggregate {
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
      overrides: {},
    },
  };
}

function makeCtx(args: {
  accountProjections: AccountProjection[];
  primaryRetirementAbsMonth: number;
  cbpLumpSumEventAbsMonth: Map<string, number>;
  cbpProjectionByAccount?: Map<string, ProjectionOutput>;
  incomeStreams?: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
}): PipelineContext {
  const scenario = baseScenario('s');
  return {
    scenarioId: 's',
    method: 'planned',
    incomeStreams: args.incomeStreams ?? [],
    resolvedScenario: {} as unknown as PipelineContext['resolvedScenario'],
    effectiveScenarios: [scenario],
    primary: {} as unknown as PipelineContext['primary'],
    secondary: undefined,
    primaryRetIso: '2046-01-01',
    primaryRetirementYear: 2046,
    primaryRetirementMonth0: 0,
    primaryRetirementAbsMonth: args.primaryRetirementAbsMonth,
    retirementByMember: new Map(),
    horizonYear: 2086,
    horizonAbsMonth: 2086 * 12 + 11,
    ssStartYear: 2046,
    projCtx: {} as unknown as PipelineContext['projCtx'],
    accountProjections: args.accountProjections,
    cbpLumpSumEventAbsMonth: args.cbpLumpSumEventAbsMonth,
    preDepositsByAccount: new Map(),
    cbpProjectionByAccount: args.cbpProjectionByAccount ?? new Map(),
    cbpValidation: null,
    methodAvailable: true,
    fallbackAccounts: [],
    rothBasisCentsByOwner: new Map(),
    rothDistributionFacts: { rothIraByPool: new Map(), designatedByAccount: new Map() },
    rmdProfileFactsByAccountId: new Map(),
    mixedInPlanConversionBasisCentsByAccount: new Map(),
    preRetirementConversionBasisCentsByOwnerYear: new Map(),
    mixedInPlanConversionBasisCentsByAccountYear: new Map(),
    preRetirementConversionBasisCentsByOwner: new Map(),
    pureRothBasisCentsByOwner: new Map(),
    mixedRothDesignatedBasisCentsByOwner: new Map(),
    mixedInPlanConversionBasisCentsByOwner: new Map(),
    preRetirementConversionCentsByYear: new Map(),
    acaMarketplaceOptOutMemberIds: new Set<string>(),
    medicalInflationRatePct: 5,
    resolvedQcd: { entries: [] },
  };
}

describe('buildPerAccountDrawdownLedger — CBP lump-sum routing', () => {
  it('pre-primary linked-CBP source account is EXCLUDED from the ledger', () => {
    // A pre-retirement linked-CBP lump sum is already routed into the target's accumulation projection upstream, so the
    // source CBP must not enter the ledger and double-count.
    const cbp = account('cbp1', 'PRE_TAX', 'RETIREMENT_CASH_BALANCE');
    const target = account('target1');
    const accountProjections = [makeProj(cbp, 100_000), makeProj(target, 500_000)];
    const primaryRetirementAbsMonth = 2046 * 12;
    const cbpLumpSumEventAbsMonth = new Map<string, number>([
      ['cbp1', 2046 * 12 - 12], // a year before primary retirement
    ]);
    const ctx = makeCtx({
      accountProjections,
      primaryRetirementAbsMonth,
      cbpLumpSumEventAbsMonth,
      incomeStreams: [pensionStream('p1', 'm1', 'cbp1', 'target1')],
    });
    const expensesByMonth = emptyMonthlySeries(2046, 2086);
    const result = buildPerAccountDrawdownLedger({
      ctx,
      method: 'planned',
      expensesByMonth,
    });
    expect(result.accounts.find((e) => e.id === 'cbp1')).toBeUndefined();
    expect(result.accounts.find((e) => e.id === 'target1')).toBeDefined();
    expect(result.cbpLumpSumDeposits.length).toBe(0);
  });

  it('post-primary lumpSum source is EXCLUDED + target receives deposit ONCE', () => {
    // Every lumpSum-elected linked-CBP source is excluded from the ledger (as the MC bundle's skipsPortfolio); the event lands
    // in the target's depositsByMonth and cbpLumpSumDeposits flags the same dollars so the caller can subtract them from the
    // household-aggregate series.
    const cbp = account('cbp1', 'PRE_TAX', 'RETIREMENT_CASH_BALANCE');
    const target = account('target1');
    const accountProjections = [makeProj(cbp, 200_000), makeProj(target, 500_000)];
    const primaryRetirementAbsMonth = 2046 * 12;
    const eventAbsMonth = 2046 * 12 + 12;
    const cbpLumpSumEventAbsMonth = new Map<string, number>([
      ['cbp1', eventAbsMonth],
    ]);
    const cbpProj = {
      total: 200_000,
      accumulationGrowth: 0,
      perStep: {
        firstYear: 2026,
        preEnd: new Float64Array((2086 - 2026 + 1) * 12),
        postEnd: new Float64Array((2086 - 2026 + 1) * 12),
      },
    } as unknown as ProjectionOutput;
    const eventStepIdx = (2047 - 2026) * 12 + 0;
    cbpProj.perStep!.preEnd[eventStepIdx] = 210_000;
    cbpProj.perStep!.postEnd[eventStepIdx] = 0;
    const ctx = makeCtx({
      accountProjections,
      primaryRetirementAbsMonth,
      cbpLumpSumEventAbsMonth,
      cbpProjectionByAccount: new Map([['cbp1', cbpProj]]),
      incomeStreams: [pensionStream('p1', 'm1', 'cbp1', 'target1')],
    });
    const expensesByMonth = emptyMonthlySeries(2046, 2086);
    const result = buildPerAccountDrawdownLedger({
      ctx,
      method: 'planned',
      expensesByMonth,
    });
    expect(result.accounts.find((e) => e.id === 'cbp1')).toBeUndefined();
    const targetEntry = result.accounts.find((e) => e.id === 'target1');
    expect(targetEntry).toBeDefined();
    // The per-account deposit at the event month equals the CBP's projected at-event balance (210_000).
    const startYear = expensesByMonth.startYear;
    const evtYear = 2047;
    const evtMonth0 = 0;
    const stepIdx = (evtYear - startYear) * 12 + evtMonth0;
    expect(targetEntry!.depositsByMonth.values[stepIdx]).toBeCloseTo(210_000, 0);
    expect(result.cbpLumpSumDeposits.length).toBe(1);
    expect(result.cbpLumpSumDeposits[0]).toMatchObject({
      year: 2047,
      month0: 0,
    });
    expect(result.cbpLumpSumDeposits[0].amount).toBeCloseTo(210_000, 0);
  });

  it('zero-balance CBP lump-sum target KEEPS its ledger entry so the deposit lands', () => {
    // A zero-balance CBP lump-sum target must keep its ledger entry: a short-circuit on totalAtRet <= 0 before the deposit
    // attached would leave the transferred dollars nowhere to land.
    const cbp = account('cbp1', 'PRE_TAX', 'RETIREMENT_CASH_BALANCE');
    const target = account('zeroTarget'); // BROKERAGE, POST_TAX
    const accountProjections = [makeProj(cbp, 150_000), makeProj(target, 0)];
    const primaryRetirementAbsMonth = 2046 * 12;
    const eventAbsMonth = 2046 * 12 + 24; // event 2 years post-primary
    const cbpLumpSumEventAbsMonth = new Map<string, number>([
      ['cbp1', eventAbsMonth],
    ]);
    const cbpProj = {
      total: 150_000,
      accumulationGrowth: 0,
      perStep: {
        firstYear: 2026,
        preEnd: new Float64Array((2086 - 2026 + 1) * 12),
        postEnd: new Float64Array((2086 - 2026 + 1) * 12),
      },
    } as unknown as ProjectionOutput;
    const ctx = makeCtx({
      accountProjections,
      primaryRetirementAbsMonth,
      cbpLumpSumEventAbsMonth,
      cbpProjectionByAccount: new Map([['cbp1', cbpProj]]),
      incomeStreams: [pensionStream('p1', 'm1', 'cbp1', 'zeroTarget')],
    });
    const expensesByMonth = emptyMonthlySeries(2046, 2086);
    const result = buildPerAccountDrawdownLedger({
      ctx,
      method: 'planned',
      expensesByMonth,
    });
    expect(result.accounts.find((e) => e.id === 'cbp1')).toBeUndefined();
    const targetEntry = result.accounts.find((e) => e.id === 'zeroTarget');
    expect(targetEntry).toBeDefined();
    expect(targetEntry!.initialPre).toBe(0);
    expect(targetEntry!.initialPost).toBe(0);
    // The CBP's projected total compounds to the event month at its 5% planning rate: 150_000 × 1.05^2 = 165_375.
    const expectedAmount = 150_000 * Math.pow(1.05, 2);
    const stepIdx = (2048 - expensesByMonth.startYear) * 12 + 0;
    expect(targetEntry!.depositsByMonth.values[stepIdx]).toBeCloseTo(
      expectedAmount,
      0,
    );
    expect(result.cbpLumpSumDeposits.length).toBe(1);
    expect(result.cbpLumpSumDeposits[0].amount).toBeCloseTo(expectedAmount, 0);
  });
});

describe('buildPerAccountDrawdownLedger — TWR planned-rate fallback', () => {
  it('non-fill-target short-history account stays in ledger under TWR method at planned rate', () => {
    // A non-CBP account without an empirical TWR rate must stay in the ledger at its planned rate, or the at-horizon balance
    // is understated on named-strategy paths.

    const empirical = account('emp', 'POST_TAX', 'BROKERAGE');
    const fallback = account('fallback', 'PRE_TAX', 'RETIREMENT_IRA');

    function projOut(total: number): ProjectionOutput {
      return {
        total,
        accumulationGrowth: 0,
        perStep: {
          firstYear: 2046,
          preEnd: new Float64Array([total]),
          postEnd: new Float64Array([0]),
          growthCarry: new Float64Array([0]),
          contribCarry: new Float64Array([0]),
        },
      } as unknown as ProjectionOutput;
    }

    const empiricalProj: AccountProjection = {
      account: empirical,
      latestBalance: 500_000,
      ownerRetirementDate: '2046-01-01',
      outputs: {
        planned: projOut(500_000),
        twr: projOut(520_000), // empirical TWR projection differs from planned
      },
      ratePctByMethod: { planned: 5, twr: 7 }, // empirical TWR rate
      perMonthContribution: { preTax: 0, postTax: 0 },
    };

    const fallbackProj: AccountProjection = {
      account: fallback,
      latestBalance: 200_000,
      ownerRetirementDate: '2046-01-01',
      outputs: {
        planned: projOut(200_000),
        twr: projOut(200_000),
      },
      ratePctByMethod: { planned: 5, twr: null }, // no empirical TWR rate
      perMonthContribution: { preTax: 0, postTax: 0 },
    };

    const ctx = makeCtx({
      accountProjections: [empiricalProj, fallbackProj],
      primaryRetirementAbsMonth: 2046 * 12,
      cbpLumpSumEventAbsMonth: new Map(),
    });

    const expensesByMonth = emptyMonthlySeries(2046, 2086);
    const result = buildPerAccountDrawdownLedger({
      ctx,
      method: 'twr',
      expensesByMonth,
    });

    const empEntry = result.accounts.find((e) => e.id === 'emp');
    const fallbackEntry = result.accounts.find((e) => e.id === 'fallback');
    expect(empEntry).toBeDefined();
    expect(fallbackEntry).toBeDefined();

    expect(empEntry!.annualRatePct).toBe(7);

    expect(fallbackEntry!.annualRatePct).toBe(5);
  });
});

describe('buildPerAccountDrawdownLedger — post-primary spouse contributions', () => {
  it('retains a $0-at-retirement account funded only by post-primary events + maps the pre/post split', () => {
    // A spouse account that projects to $0 at retirement but is funded by post-primary contributions must be kept, with the
    // pre slice in depositsByMonth and the designated-Roth slice in depositsPostByMonth.
    const RET_ABS = 2046 * 12;
    const zeroSpouse = account('spouse', 'MIXED', 'RETIREMENT_401K');
    const accountProjections = [makeProj(zeroSpouse, 0)];
    // Three years of $750/mo pre-tax + $500/mo designated-Roth contributions from primary retirement.
    const PRE = 750;
    const POST = 500;
    const events = Array.from({ length: 36 }, (_, m) => ({
      month: RET_ABS + m,
      amount: PRE + POST,
      amountPre: PRE,
      amountPost: POST,
      accountId: 'spouse',
    }));
    const ctx = makeCtx({
      accountProjections,
      primaryRetirementAbsMonth: RET_ABS,
      cbpLumpSumEventAbsMonth: new Map(),
    });
    const result = buildPerAccountDrawdownLedger({
      ctx,
      method: 'planned',
      expensesByMonth: emptyMonthlySeries(2046, 2086),
      postPrimaryEvents: events,
    });

    const entry = result.accounts.find((e) => e.id === 'spouse');
    expect(entry).toBeDefined();
    expect(entry!.depositsPostByMonth).toBeDefined();

    // An event's series index is ev.month - startYear*12.
    const startAbs = 2046 * 12;
    for (const ev of events) {
      const idx = ev.month - startAbs;
      expect(entry!.depositsByMonth.values[idx]).toBeCloseTo(PRE, 6);
      expect(entry!.depositsPostByMonth!.values[idx]).toBeCloseTo(POST, 6);
    }
    expect(entry!.depositsByMonth.values[36]).toBe(0);
    expect(entry!.depositsPostByMonth!.values[36]).toBe(0);
  });
});

describe('buildPerAccountDrawdownLedger — plain-pension per-account placement', () => {
  it('places a post-retirement plain pension lump-sum in the target PRE_TAX account', () => {
    const target = account('target1', 'PRE_TAX', 'RETIREMENT_IRA');
    const accountProjections = [makeProj(target, 500_000)];
    const primaryRetirementAbsMonth = 2046 * 12;
    const ctx = makeCtx({
      accountProjections,
      primaryRetirementAbsMonth,
      cbpLumpSumEventAbsMonth: new Map(),
    });
    const expensesByMonth = emptyMonthlySeries(2046, 2086);
    const eventAbsMonth = 2049 * 12 + 8; // September, three years post-retirement
    const result = buildPerAccountDrawdownLedger({
      ctx,
      method: 'planned',
      expensesByMonth,
      plainPensionEvents: [
        { month: eventAbsMonth, amount: 80_000, accountId: 'target1' },
      ],
    });
    const entry = result.accounts.find((e) => e.id === 'target1');
    expect(entry).toBeDefined();
    const idx = eventAbsMonth - 2046 * 12;
    expect(entry!.depositsByMonth.values[idx]).toBeCloseTo(80_000, 6);
    expect(result.plainPensionDeposits).toHaveLength(1);
    expect(result.plainPensionDeposits[0].amount).toBeCloseTo(80_000, 6);
  });

  it('does NOT report a placement whose target is absent from the ledger', () => {
    // The target is not in the projections, so the placement stays in the household spread and is not reported back.
    const other = account('other1', 'PRE_TAX', 'RETIREMENT_IRA');
    const accountProjections = [makeProj(other, 500_000)];
    const ctx = makeCtx({
      accountProjections,
      primaryRetirementAbsMonth: 2046 * 12,
      cbpLumpSumEventAbsMonth: new Map(),
    });
    const result = buildPerAccountDrawdownLedger({
      ctx,
      method: 'planned',
      expensesByMonth: emptyMonthlySeries(2046, 2086),
      plainPensionEvents: [
        { month: 2049 * 12 + 8, amount: 80_000, accountId: 'missing-target' },
      ],
    });
    expect(result.plainPensionDeposits).toHaveLength(0);
  });
});

const TODAY_YEAR_BASIS = 2026;
const TODAY_MONTH_BASIS = 5; // June (0-indexed)

function basisMember(
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
      lastName: 'Test',
      email: `${id}@test.test`,
      birthdate: `${birthYear}-06-15`,
    },
  };
}

function basisSsBenefit(memberId: string): Aggregate<SocialSecurityBenefitPayload> {
  return {
    id: `ss-${memberId}`,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'socialSecurityBenefit',
    payload: {
      householdMemberId: memberId,
      pia: null,
      piaAsOfDate: '2026-01-01',
      notes: null,
    },
  };
}

function basisAccount(
  id: string,
  ownerId: string,
  type: AccountPayload['type'],
  active: boolean,
  payloadExtra: Partial<AccountPayload> = {},
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
      taxTreatment: 'POST_TAX',
      ownerId,
      institution: 'X',
      notes: '',
      planningReturnPct: 5,
      active,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
      ...payloadExtra,
    },
  };
}

function basisBalanceRow(
  accountId: string,
  year: number,
  endingBalance: number,
): Aggregate<AccountBalancePayload> {
  return {
    id: `bal-${accountId}-${year}`,
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

function withInPlanRollover(
  row: Aggregate<AccountBalancePayload>,
  taxableDollars: number,
): Aggregate<AccountBalancePayload> {
  return {
    ...row,
    payload: { ...row.payload, rothInPlanRolloverTaxableAmount: taxableDollars },
  };
}

function basisScenario(): ScenarioAggregate {
  return {
    id: 's',
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
      overrides: {
        retirementAge: { primary: { ageYears: 67, ageMonths: 0 } },
        socialSecurity: { primary: { ageYears: 67, ageMonths: 0 } },
        inflation: { ratePct: 0 },
        lifeExpectancy: { primary: 90 },
      },
    },
  };
}

function buildBasisArgs(
  overrides: Partial<RunBalanceProjectionArgs>,
): RunBalanceProjectionArgs {
  const scenario = basisScenario();
  return {
    scenarioId: 's',
    scenarios: [scenario],
    accounts: [basisAccount('brk', 'm1', 'BROKERAGE', true)],
    balances: [basisBalanceRow('brk', 2025, 500_000)],
    members: [basisMember('m1', true, 1965)],
    ssBenefits: [basisSsBenefit('m1')],
    expenses: [],
    incomeStreams: [],
    todayYear: TODAY_YEAR_BASIS,
    todayMonthIndex: TODAY_MONTH_BASIS,
    ...overrides,
  };
}

function buildBasisCtx(args: RunBalanceProjectionArgs) {
  const ctx = buildPipelineContext(args);
  if (!ctx) throw new Error('fixture failed to build a pipeline context');
  return ctx;
}

describe('buildPipelineContext — spouse birthdate comes from the HOUSEHOLD, not the account', () => {
  it('supplies the other member’s birthdate only when it proves Table II eligibility', () => {
    const acct = basisAccount('ira-p', 'm1', 'RETIREMENT_IRA', true, {
      rmdSoleSpouseBeneficiary: true,
    });
    const acctSpouse = basisAccount('ira-s', 'm2', 'RETIREMENT_IRA', true, {
      rmdSoleSpouseBeneficiary: true,
    });
    const args = buildBasisArgs({
      accounts: [acct, acctSpouse],
      balances: [
        basisBalanceRow('ira-p', 2025, 500_000),
        basisBalanceRow('ira-s', 2025, 200_000),
      ],
      members: [basisMember('m1', true, 1955), basisMember('m2', false, 1975)],
    });
    const ctx = buildBasisCtx(args);
    // m1's spouse is more than 10 years younger; m2's is older, so that stale designation is ignored (Table III path).
    expect(ctx.rmdProfileFactsByAccountId?.get('ira-p')?.spouseBeneficiaryBirthdate).toBe(
      '1975-06-15',
    );
    expect(
      ctx.rmdProfileFactsByAccountId?.get('ira-p')?.soleSpouseBeneficiaryMoreThan10YrsYounger,
    ).toBe(true);
    expect(ctx.rmdProfileFactsByAccountId?.has('ira-s')).toBe(false);
  });

  it('uses the account OWNER’s household birthdate as the inherited-account beneficiary date', () => {
    const acct = basisAccount('inh', 'm2', 'RETIREMENT_IRA', true, {
      rmdInheritedAccount: true,
    });
    const args = buildBasisArgs({
      accounts: [acct],
      balances: [basisBalanceRow('inh', 2025, 300_000)],
      members: [basisMember('m1', true, 1955), basisMember('m2', false, 1975)],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.rmdProfileFactsByAccountId?.get('inh')?.beneficiaryBirthdate).toBe('1975-06-15');
  });

  it('prefers a changed household birthdate over a conflicting legacy account copy', () => {
    const acct = basisAccount('inh', 'm2', 'RETIREMENT_IRA', true, {
      rmdInheritedAccount: true,
      rmdBeneficiaryBirthdate: '1983-05-01',
    });
    const args = buildBasisArgs({
      accounts: [acct],
      balances: [basisBalanceRow('inh', 2025, 300_000)],
      members: [basisMember('m1', true, 1955), basisMember('m2', false, 1975)],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.rmdProfileFactsByAccountId?.get('inh')?.beneficiaryBirthdate).toBe('1975-06-15');
  });

  it('does NOT give a fact-free account a fact just because the household has a spouse', () => {
    // The household date is consulted only for an account carrying the sole-spouse designation; otherwise every account in a
    // two-member household would carry a fact and switch the household onto the fact-based path.
    const acct = basisAccount('ira-p', 'm1', 'RETIREMENT_IRA', true);
    const args = buildBasisArgs({
      accounts: [acct],
      balances: [basisBalanceRow('ira-p', 2025, 500_000)],
      members: [basisMember('m1', true, 1955), basisMember('m2', false, 1975)],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.rmdProfileFactsByAccountId?.has('ira-p')).toBe(false);
  });

  it('ignores a stale designation for a single-member household', () => {
    const acct = basisAccount('ira-p', 'm1', 'RETIREMENT_IRA', true, {
      rmdSoleSpouseBeneficiary: true,
    });
    const args = buildBasisArgs({
      accounts: [acct],
      balances: [basisBalanceRow('ira-p', 2025, 500_000)],
      members: [basisMember('m1', true, 1955)],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.rmdProfileFactsByAccountId?.has('ira-p')).toBe(false);
  });

  it('does not let a legacy copied birthdate override missing household evidence', () => {
    const acct = basisAccount('ira-p', 'm1', 'RETIREMENT_IRA', true, {
      rmdSoleSpouseBeneficiary: true,
      rmdSpouseBeneficiaryBirthdate: '1978-02-02',
    });
    const spouseNoDob = basisMember('m2', false, 1975);
    const args = buildBasisArgs({
      accounts: [acct],
      balances: [basisBalanceRow('ira-p', 2025, 500_000)],
      members: [
        basisMember('m1', true, 1955),
        { ...spouseNoDob, payload: { ...spouseNoDob.payload, birthdate: '' } },
      ],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.rmdProfileFactsByAccountId?.has('ira-p')).toBe(false);
  });
});

describe('buildPipelineContext — pureRothBasisCentsByOwner derivation', () => {
  it('(a) uses the recorded in-plan-rollover principal, never the projected balance or the stored total', () => {
    // $350k balance, a $250k stored designatedRothBasis nobody reads, and $40k of recorded rollover principal: the seeded basis
    // is the $40k.
    const rothAcct = basisAccount('r1', 'm1', 'RETIREMENT_ROTH_401K', true, {
      designatedRothBasis: 250_000,
    });
    const args = buildBasisArgs({
      accounts: [rothAcct],
      balances: [
        withInPlanRollover(basisBalanceRow('r1', 2023, 200_000), 40_000),
        basisBalanceRow('r1', 2025, 350_000),
      ],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.pureRothBasisCentsByOwner.get('m1')).toBe(4_000_000); // $40k in cents
  });

  it('(a2) NO recorded in-plan rollover → the owner is absent (conservative $0)', () => {
    const rothAcct = basisAccount('r1', 'm1', 'RETIREMENT_ROTH_401K', true);
    const args = buildBasisArgs({
      accounts: [rothAcct],
      balances: [basisBalanceRow('r1', 2025, 350_000)],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.pureRothBasisCentsByOwner.has('m1')).toBe(false);
  });

  it('(b) inactive pure-Roth employer account is excluded from the map', () => {
    const rothAcct = basisAccount('r1', 'm1', 'RETIREMENT_ROTH_403B', false);
    const args = buildBasisArgs({
      accounts: [rothAcct],
      balances: [basisBalanceRow('r1', 2025, 100_000)],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.pureRothBasisCentsByOwner.has('m1')).toBe(false);
  });

  it('(c) pure-Roth employer account with no balance rows is excluded from the map', () => {
    const rothAcct = basisAccount('r1', 'm1', 'RETIREMENT_ROTH_457B', true);
    const args = buildBasisArgs({
      accounts: [rothAcct],
      balances: [], // no rows
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.pureRothBasisCentsByOwner.has('m1')).toBe(false);
  });

  it('(d) pure-Roth employer account whose latest endingBalance is ≤ 0 is excluded', () => {
    const rothAcct = basisAccount('r1', 'm1', 'RETIREMENT_ROTH_TSP', true);
    const args = buildBasisArgs({
      accounts: [rothAcct],
      balances: [basisBalanceRow('r1', 2025, 0)],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.pureRothBasisCentsByOwner.has('m1')).toBe(false);
  });

  it('(e) two pure-Roth employer accounts for the same owner have their recorded basis SUMMED', () => {
    const r1 = basisAccount('r1', 'm1', 'RETIREMENT_ROTH_401K', true);
    const r2 = basisAccount('r2', 'm1', 'RETIREMENT_ROTH_401K', true);
    const args = buildBasisArgs({
      accounts: [r1, r2],
      balances: [
        withInPlanRollover(basisBalanceRow('r1', 2025, 120_000), 12_000),
        withInPlanRollover(basisBalanceRow('r2', 2025, 80_000), 8_000),
      ],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.pureRothBasisCentsByOwner.get('m1')).toBe(2_000_000); // $20k in cents
  });
});

function mixedRothAccount(
  id: string,
  ownerId: string,
  type: AccountPayload['type'],
  active: boolean,
  payloadExtra: Partial<AccountPayload> = {},
): Aggregate<AccountPayload> {
  const base = basisAccount(id, ownerId, type, active, payloadExtra);
  return {
    ...base,
    payload: { ...base.payload, taxTreatment: 'MIXED' },
  };
}

function mixedBasisBalanceRow(
  accountId: string,
  year: number,
  endingBalance: number,
  endingBalancePostTax: number | null,
  endingBalancePreTax: number | null = null,
): Aggregate<AccountBalancePayload> {
  const base = basisBalanceRow(accountId, year, endingBalance);
  return {
    ...base,
    payload: { ...base.payload, endingBalancePostTax, endingBalancePreTax },
  };
}

describe('buildPipelineContext — mixedRothDesignatedBasisCentsByOwner derivation', () => {
  it('(a) uses the recorded in-plan-rollover principal, never the post sub-bucket balance', () => {
    const acct = mixedRothAccount('m1a', 'm1', 'RETIREMENT_401K', true);
    const args = buildBasisArgs({
      accounts: [acct],
      balances: [
        withInPlanRollover(mixedBasisBalanceRow('m1a', 2023, 200_000, 50_000), 15_000),
        mixedBasisBalanceRow('m1a', 2025, 350_000, 90_000),
      ],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.mixedRothDesignatedBasisCentsByOwner.get('m1')).toBe(1_500_000); // $15k in cents
  });

  it('(a2) NO recorded basis fact → the owner is absent (conservative $0)', () => {
    const acct = mixedRothAccount('m1a', 'm1', 'RETIREMENT_401K', true);
    const args = buildBasisArgs({
      accounts: [acct],
      balances: [mixedBasisBalanceRow('m1a', 2025, 350_000, 90_000)],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.mixedRothDesignatedBasisCentsByOwner.has('m1')).toBe(false);
  });

  it('(b) inactive MIXED Roth-designated account is excluded from the map', () => {
    const acct = mixedRothAccount('m1a', 'm1', 'RETIREMENT_403B', false);
    const args = buildBasisArgs({
      accounts: [acct],
      balances: [mixedBasisBalanceRow('m1a', 2025, 100_000, 40_000)],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.mixedRothDesignatedBasisCentsByOwner.has('m1')).toBe(false);
  });

  it('(c) MIXED Roth-designated account with no balance rows is excluded', () => {
    const acct = mixedRothAccount('m1a', 'm1', 'RETIREMENT_457B', true);
    const args = buildBasisArgs({
      accounts: [acct],
      balances: [],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.mixedRothDesignatedBasisCentsByOwner.has('m1')).toBe(false);
  });

  it('(d) MIXED account whose latest endingBalancePostTax is null or 0 is excluded', () => {
    const acct = mixedRothAccount('m1a', 'm1', 'RETIREMENT_TSP', true);
    const args = buildBasisArgs({
      accounts: [acct],
      balances: [mixedBasisBalanceRow('m1a', 2025, 100_000, null)],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.mixedRothDesignatedBasisCentsByOwner.has('m1')).toBe(false);

    const acct2 = mixedRothAccount('m1b', 'm2', 'RETIREMENT_401K', true);
    const args2 = buildBasisArgs({
      accounts: [acct2],
      balances: [mixedBasisBalanceRow('m1b', 2025, 100_000, 0)],
    });
    const ctx2 = buildBasisCtx(args2);
    expect(ctx2.mixedRothDesignatedBasisCentsByOwner.has('m2')).toBe(false);
  });

  it('(e) non-designated MIXED account (e.g. MIXED BROKERAGE) is excluded', () => {
    const acct = basisAccount('m1a', 'm1', 'BROKERAGE', true);
    const mixedAcct: Aggregate<AccountPayload> = {
      ...acct,
      payload: { ...acct.payload, taxTreatment: 'MIXED' },
    };
    const args = buildBasisArgs({
      accounts: [mixedAcct],
      balances: [mixedBasisBalanceRow('m1a', 2025, 200_000, 80_000)],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.mixedRothDesignatedBasisCentsByOwner.has('m1')).toBe(false);
  });

  it('(f) two active MIXED Roth-designated accounts for the same owner are summed', () => {
    const r1 = mixedRothAccount('m1a', 'm1', 'RETIREMENT_401K', true);
    const r2 = mixedRothAccount('m1b', 'm1', 'RETIREMENT_403B', true);
    const args = buildBasisArgs({
      accounts: [r1, r2],
      balances: [
        withInPlanRollover(mixedBasisBalanceRow('m1a', 2025, 200_000, 60_000), 6_000),
        withInPlanRollover(mixedBasisBalanceRow('m1b', 2025, 150_000, 40_000), 4_000),
      ],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.mixedRothDesignatedBasisCentsByOwner.get('m1')).toBe(1_000_000); // $10k in cents
  });

  it('(g) the recorded rollover principal is balance-independent', () => {
    const acct = mixedRothAccount('m1a', 'm1', 'RETIREMENT_TSP', true);
    const args = buildBasisArgs({
      accounts: [acct],
      balances: [
        withInPlanRollover(mixedBasisBalanceRow('m1a', 2023, 100_000, 20_000), 9_000),
        mixedBasisBalanceRow('m1a', 2024, 150_000, 35_000),
        mixedBasisBalanceRow('m1a', 2026, 220_000, 55_000),
      ],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.mixedRothDesignatedBasisCentsByOwner.get('m1')).toBe(900_000); // $9k in cents
  });
});

import { buildMcTaxContext } from './balance-projection-runner-mc';

function inPlanMixedAccount(
  id: string,
  ownerId: string,
): Aggregate<AccountPayload> {
  const base = basisAccount(id, ownerId, 'RETIREMENT_401K', true);
  return { ...base, payload: { ...base.payload, taxTreatment: 'MIXED' } };
}

describe('buildPipelineContext — mixedInPlanConversionBasisCentsByOwner vs mixedRothDesignatedBasisCentsByOwner', () => {
  it('(a) same-account MIXED in-plan conversion: mixedInPlanConversionBasisCentsByOwner holds the converted amount', () => {
    // One MIXED 401k is both source and target of a same-account in-plan conversion of $5k in 2026; a $3k recorded rollover
    // seeds mixedRothDesignatedBasisCentsByOwner.
    const acct = inPlanMixedAccount('m401k', 'm1');
    const args = buildBasisArgs({
      accounts: [acct],
      // endingBalancePreTax must be non-null so a MIXED account seeds a non-zero pre-tax sub-bucket.
      balances: [
        withInPlanRollover(
          mixedBasisBalanceRow('m401k', 2025, 100_000, 3_000, 97_000),
          3_000,
        ),
      ],
      scenarios: [
        {
          ...basisScenario(),
          payload: {
            ...basisScenario().payload,
            overrides: {
              ...basisScenario().payload.overrides,
              preRetirementRothConversions: [
                {
                  sourceAccountId: 'm401k',
                  targetRothAccountId: 'm401k', // same-account in-plan
                  annualAmountDollars: 5_000,
                  start: { kind: 'year', year: 2026 },
                  end: { kind: 'year', year: 2026 },
                },
              ],
            },
          },
        },
      ],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.mixedInPlanConversionBasisCentsByOwner.get('m1')).toBe(500_000);
    // The fact-derived field reflects only the recorded $3k basis.
    expect(ctx.mixedRothDesignatedBasisCentsByOwner.get('m1')).toBe(300_000);
    // The principal is also keyed by the target account, so the designated carrier credits the exact plan that received it.
    expect(ctx.mixedInPlanConversionBasisCentsByAccount.get('m401k')).toBe(500_000);
  });

  it('(b) MC seed does NOT include the deterministic-only in-plan conversion basis', () => {
    const acct = inPlanMixedAccount('m401k', 'm1');
    const args = buildBasisArgs({
      accounts: [acct],
      balances: [
        withInPlanRollover(
          mixedBasisBalanceRow('m401k', 2025, 100_000, 3_000, 97_000),
          3_000,
        ),
      ],
      scenarios: [
        {
          ...basisScenario(),
          payload: {
            ...basisScenario().payload,
            overrides: {
              ...basisScenario().payload.overrides,
              // A named strategy with tax data makes buildMcTaxContext return a context.
              withdrawalStrategy: { kind: 'rothFirst' as const },
              preRetirementRothConversions: [
                {
                  sourceAccountId: 'm401k',
                  targetRothAccountId: 'm401k',
                  annualAmountDollars: 5_000,
                  start: { kind: 'year', year: 2026 },
                  end: { kind: 'year', year: 2026 },
                },
              ],
            },
          },
        },
      ],
    });
    const ctx = buildBasisCtx(args);
    const mcTaxCtx = buildMcTaxContext(ctx);
    expect(mcTaxCtx).toBeDefined();
    // rothBasisCentsByOwner is a plain sorted array so it participates in mcCacheKey (a Map serialises to {}) and carries only
    // Roth-IRA contribution basis; designated basis lives on rothOrderedProfile.
    expect(
      mcTaxCtx!.rothBasisCentsByOwner?.find((e) => e.ownerId === 'm1')?.cents ?? 0,
    ).toBe(0);
    // The MC designated pool carries only the recorded $3k, never the $5k deterministic-only conversion basis, which would
    // shelter MC Roth withdrawals the MC Roth balance never received.
    expect(mcTaxCtx!.rothOrderedProfile?.designatedBasisCents).toBe(300_000);
    expect(ctx.mixedInPlanConversionBasisCentsByOwner.get('m1')).toBe(500_000);
    expect(ctx.mixedInPlanConversionBasisCentsByAccount.get('m401k')).toBe(500_000);
    expect(ctx.mixedRothDesignatedBasisCentsByOwner.get('m1')).toBe(300_000);
  });
});
