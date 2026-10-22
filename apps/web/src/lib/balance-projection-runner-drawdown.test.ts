/** Unit tests for the per-method drawdown executor helpers in `balance-projection-runner-drawdown.ts`. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runDrawdownForMethod,
  resolveQcdLimitCentsForYear,
} from './balance-projection-runner-drawdown';
import { simulateDrawdown } from './drawdown-engine';
import { emptyMonthlySeries } from './monthly-cashflow';
import { DEFAULT_LIFE_EXPECTANCY_AGE } from '../db/types';
import type {
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  MagiCapOverride,
  MagiCapWindow,
  ScenarioOverrides,
} from '../db/types';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from './tax-integration';
import type { ProjectionOutput } from './projection';
import type {
  AccountProjection,
  CashflowSeries,
  PipelineContext,
  ProjectionMethod,
  RunBalanceProjectionArgs,
} from './balance-projection-runner-types';
import type { ScenarioAggregate } from './scenario-resolution';
import type { DrawdownInput } from './drawdown-engine-types';
import type { RmdAccountProfileFacts } from './rmd';

// The engine input is spied (still running the real engine) so the MAGI-cap windows and RMD context the executor builds are
// observable through `runDrawdownForMethod`.
vi.mock('./drawdown-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./drawdown-engine')>();
  return { ...actual, simulateDrawdown: vi.fn(actual.simulateDrawdown) };
});

beforeEach(() => {
  vi.mocked(simulateDrawdown).mockClear();
});

function engineInput(): DrawdownInput {
  const calls = vi.mocked(simulateDrawdown).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0][0];
}

function runCap(ctx: PipelineContext): ReturnType<typeof runDrawdownForMethod> {
  return runDrawdownForMethod({} as RunBalanceProjectionArgs, ctx, emptySeries(), 'planned');
}

function emptySeries(): CashflowSeries {
  const empty = emptyMonthlySeries(2046, 2086);
  return {
    expensesByMonth: empty,
    incomeByMonth: empty,
    depositsByMonth: empty,
    expenseRows: [],
    nonSsIncomeRows: [],
    postPrimaryContributionEvents: [],
    targetedOneOffEvents: [],
    ssRows: [],
  } as unknown as CashflowSeries;
}

function member(
  id: string,
  isPrimary: boolean,
  birthdate: string | undefined,
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
      ...(birthdate !== undefined ? { birthdate } : {}),
    } as HouseholdMemberPayload,
  };
}

function account(
  id: string,
  ownerId: string,
  type: AccountPayload['type'] = 'BROKERAGE',
  taxTreatment: AccountPayload['taxTreatment'] = 'POST_TAX',
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

function makeProj(
  acct: Aggregate<AccountPayload>,
  totalAtRet: number,
): AccountProjection {
  const planned: ProjectionOutput = {
    total: totalAtRet,
    yearlyTotals: [],
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
  payoutType: 'annuity' | 'lumpSum',
  targetAccountId?: string,
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
      payoutType,
      lumpSumAmount: 0,
      linkedCbpAccountId: cbpAccountId,
      ...(targetAccountId ? { targetAccountId } : {}),
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
  primary?: Aggregate<HouseholdMemberPayload>;
  secondary?: Aggregate<HouseholdMemberPayload>;
  accountProjections?: AccountProjection[];
  cbpLumpSumEventAbsMonth?: Map<string, number>;
  primaryRetirementAbsMonth?: number;
  resolvedScenario?: ScenarioOverrides;
  incomeStreams?: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  method?: ProjectionMethod;
  rmdProfileFactsByAccountId?: Map<string, RmdAccountProfileFacts>;
  retirementByMember?: Map<string, string>;
}): PipelineContext {
  const scenario = baseScenario('s');
  const primary = args.primary ?? member('m1', true, '1980-01-01');
  return {
    scenarioId: 's',
    method: args.method ?? 'planned',
    incomeStreams: args.incomeStreams ?? [],
    resolvedScenario: (args.resolvedScenario ?? {}) as PipelineContext['resolvedScenario'],
    effectiveScenarios: [scenario],
    primary,
    secondary: args.secondary,
    primaryRetIso: '2046-01-01',
    primaryRetirementYear: 2046,
    primaryRetirementMonth0: 0,
    primaryRetirementAbsMonth: args.primaryRetirementAbsMonth ?? 2046 * 12,
    retirementByMember: args.retirementByMember ?? new Map(),
    horizonYear: 2086,
    horizonAbsMonth: 2086 * 12 + 11,
    ssStartYear: 2046,
    projCtx: {} as unknown as PipelineContext['projCtx'],
    accountProjections: args.accountProjections ?? [],
    cbpLumpSumEventAbsMonth: args.cbpLumpSumEventAbsMonth ?? new Map(),
    preDepositsByAccount: new Map(),
    cbpProjectionByAccount: new Map(),
    cbpValidation: null,
    methodAvailable: true,
    fallbackAccounts: [],
    rothBasisCentsByOwner: new Map(),
    rothDistributionFacts: { rothIraByPool: new Map(), designatedByAccount: new Map() },
    rmdProfileFactsByAccountId: args.rmdProfileFactsByAccountId ?? new Map(),
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

function magiCap(
  role: 'primary' | 'secondary',
  endAge = 65,
): MagiCapOverride {
  const window: MagiCapWindow = {
    start: { kind: 'retirementStart' },
    end: { kind: 'age', memberId: role, years: endAge, months: 0 },
    magiCeilingAnnualDollars: 0,
    capMode: 'minimize',
    capMagiLine: 'irmaa',
  };
  return { windows: [window] };
}

describe('runDrawdownForMethod — MAGI-cap window resolution', () => {
  function resolveWindows(ctx: PipelineContext, cap: MagiCapOverride) {
    runCap({
      ...ctx,
      accountProjections: [makeProj(account('a1', ctx.primary.id), 500_000)],
      resolvedScenario: { magiCap: cap } as ScenarioOverrides,
    });
    return engineInput().magiCapWindows;
  }

  it('should resolve a primary-anchored window to [retirementYear, birthYear+endAge) (legacy parity)', () => {
    const ctx = makeCtx({ primary: member('m1', true, '1990-01-01') });
    const windows = resolveWindows(ctx, magiCap('primary', 75));
    expect(windows).toHaveLength(1);
    expect(windows![0].startYear).toBe(2046);
    expect(windows![0].endYear).toBe(1990 + 75);
  });

  it('should anchor the end to the secondary member when the end anchor names secondary', () => {
    const ctx = makeCtx({
      primary: member('m1', true, '1990-01-01'),
      secondary: member('m2', false, '1988-06-15'),
    });
    const windows = resolveWindows(ctx, magiCap('secondary', 75));
    expect(windows![0].endYear).toBe(1988 + 75);
  });

  it('should FLAG a broken-anchor window inactive — never throw — when the gating birthdate is missing', () => {
    const ctx = makeCtx({ primary: member('m1', true, undefined) });
    const windows = resolveWindows(ctx, magiCap('primary', 75));
    expect(windows).toHaveLength(1);
    expect(windows![0].brokenAnchor).toBe(true);
    // Empty interval so it never selects.
    expect(windows![0].startYear).toBe(0);
    expect(windows![0].endYear).toBe(0);
  });

  it('should run the rest of the ladder when one window is broken', () => {
    const ctx = makeCtx({ primary: member('m1', true, '1990-01-01') });
    const ladder: MagiCapOverride = {
      windows: [
        {
          // Broken: anchors to a secondary with no birthdate.
          start: { kind: 'retirementStart' },
          end: { kind: 'age', memberId: 'secondary', years: 70, months: 0 },
          magiCeilingAnnualDollars: 50_000,
          capMode: 'minimize',
          capMagiLine: 'irmaa',
        },
        {
          start: { kind: 'year', year: 2050 },
          end: { kind: 'year', year: 2055 },
          magiCeilingAnnualDollars: 60_000,
          capMode: 'minimize',
          capMagiLine: 'irmaa',
        },
      ],
    };
    const windows = resolveWindows(ctx, ladder);
    expect(windows).toHaveLength(2);
    const good = windows!.find((w) => !w.brokenAnchor)!;
    expect(good.startYear).toBe(2050);
    // `end{kind:'year', year:2055}` resolves exclusive to 2056 (active through 2055).
    expect(good.endYear).toBe(2056);
  });

  it('should sort by the total order (startYear, endYear, originalIndex)', () => {
    const ctx = makeCtx({ primary: member('m1', true, '1980-01-01') });
    const ladder: MagiCapOverride = {
      windows: [
        { start: { kind: 'year', year: 2060 }, end: { kind: 'year', year: 2065 }, magiCeilingAnnualDollars: 1, capMode: 'minimize', capMagiLine: 'irmaa' },
        { start: { kind: 'year', year: 2050 }, end: { kind: 'year', year: 2055 }, magiCeilingAnnualDollars: 1, capMode: 'minimize', capMagiLine: 'irmaa' },
      ],
    };
    const windows = resolveWindows(ctx, ladder)!;
    expect(windows.map((w) => w.startYear)).toEqual([2050, 2060]);
    expect(windows.map((w) => w.originalIndex)).toEqual([1, 0]);
  });

  it('should drop a non-positive resolved interval', () => {
    const ctx = makeCtx({ primary: member('m1', true, '1980-01-01') });
    const ladder: MagiCapOverride = {
      windows: [
        // Year 2055 start, year 2050 end → resolved end (2051) ≤ start → dropped.
        { start: { kind: 'year', year: 2055 }, end: { kind: 'year', year: 2050 }, magiCeilingAnnualDollars: 1, capMode: 'minimize', capMagiLine: 'irmaa' },
      ],
    };
    expect(resolveWindows(ctx, ladder)).toBeUndefined();
  });

  it('should return undefined for an empty ladder', () => {
    const ctx = makeCtx({ primary: member('m1', true, '1980-01-01') });
    expect(resolveWindows(ctx, { windows: [] })).toBeUndefined();
  });
});

describe('runDrawdownForMethod — strategy + allocation routing', () => {
  function series(): CashflowSeries {
    const empty = emptyMonthlySeries(2046, 2086);
    return {
      expensesByMonth: empty,
      incomeByMonth: empty,
      depositsByMonth: empty,
      expenseRows: [],
      nonSsIncomeRows: [],
      postPrimaryContributionEvents: [],
      targetedOneOffEvents: [],
      ssRows: [],
    } as unknown as CashflowSeries;
  }

  const args = {} as RunBalanceProjectionArgs;

  it('should RUN (no throw) when a named strategy is combined with a retirementAllocation override', () => {
    // Allocation routes through the per-account path (the ledger carries the blended-glide returnPctByMonth), so every
    // withdrawal strategy is compatible with an allocation override.
    const acct = account('a1', 'm1');
    const ctx = makeCtx({
      accountProjections: [makeProj(acct, 500_000)],
      resolvedScenario: {
        withdrawalStrategy: { kind: 'proportional' },
        retirementAllocation: {
          growthRatePct: 7,
          incomeRatePct: 3,
          startGrowthPct: 60,
          endGrowthPct: null,
          endYear: null,
        },
      } as ScenarioOverrides,
    });
    const result = runDrawdownForMethod(args, ctx, series(), 'planned');
    expect(result).not.toBeNull();
    expect(result!.years.length).toBeGreaterThan(0);
  });

  it('should surface the net at-retirement figure, excluding an annuity-elected CBP', () => {
    const broker = account('a1', 'm1');
    const cbp = account('cbp1', 'm1', 'RETIREMENT_CASH_BALANCE', 'PRE_TAX');
    const ctx = makeCtx({
      accountProjections: [makeProj(broker, 500_000), makeProj(cbp, 100_000)],
      incomeStreams: [pensionStream('p1', 'm1', 'cbp1', 'annuity')],
    });
    const result = runDrawdownForMethod(args, ctx, series(), 'planned');
    expect(result).not.toBeNull();
    expect(result!.netPortfolioAtRetirement).toBe(500_000);
  });

  it('should return null, when the portfolio at retirement is <= 0', () => {
    const acct = account('a1', 'm1');
    const ctx = makeCtx({ accountProjections: [makeProj(acct, 0)] });
    const result = runDrawdownForMethod(args, ctx, series(), 'planned');
    expect(result).toBeNull();
  });

  it('should return null, when there is no allocation override and the per-account ledger is empty', () => {
    const ctx = makeCtx({ accountProjections: [] });
    const result = runDrawdownForMethod(args, ctx, series(), 'planned');
    expect(result).toBeNull();
  });

  it('should INCLUDE post-primary spouse contributions under allocation (per-account route)', () => {
    // Allocation routes through the per-account ledger, so post-primary contributions apply per account: the same scenario with
    // post-primary events must land a materially higher at-horizon balance.
    const acct = account('a1', 'm1');
    const allocation: ScenarioOverrides = {
      retirementAllocation: {
        growthRatePct: 0,
        incomeRatePct: 0,
        startGrowthPct: 60,
        endGrowthPct: null,
        endYear: null,
      },
    } as ScenarioOverrides;
    // Twelve months of $1,000/mo post-primary contributions (pre + Roth) in the first drawdown year; month is the absolute step
    // index.
    const events = Array.from({ length: 12 }, (_, m) => ({
      month: 2046 * 12 + m,
      amount: 1_000,
      amountPre: 600,
      amountPost: 400,
      accountId: 'a1',
    }));
    const withEvents = (): CashflowSeries =>
      ({ ...series(), postPrimaryContributionEvents: events }) as unknown as CashflowSeries;

    const ctxBase = makeCtx({
      accountProjections: [makeProj(acct, 500_000)],
      resolvedScenario: allocation,
    });
    const ctxWith = makeCtx({
      accountProjections: [makeProj(acct, 500_000)],
      resolvedScenario: allocation,
    });

    const baseline = runDrawdownForMethod(args, ctxBase, series(), 'planned');
    const merged = runDrawdownForMethod(args, ctxWith, withEvents(), 'planned');
    expect(baseline).not.toBeNull();
    expect(merged).not.toBeNull();
    const lastBaseline = baseline!.years[baseline!.years.length - 1].balance;
    const lastMerged = merged!.years[merged!.years.length - 1].balance;
    // At 0% return the final balance exceeds the baseline by the full 12 × $1,000.
    expect(lastMerged).toBeGreaterThan(lastBaseline);
    expect(lastMerged - lastBaseline).toBeCloseTo(12_000, 0);
  });

  it('derives the growth/income Gains tooltip split that sums EXACTLY to the year gain', () => {
    // With an allocation override the post-pass derives growthBucket/incomeBucket gains that must sum exactly to year.growth;
    // growthPct is the year's target growth share.
    const acct = account('a1', 'm1');
    const ctx = makeCtx({
      accountProjections: [makeProj(acct, 800_000)],
      resolvedScenario: {
        retirementAllocation: {
          growthRatePct: 7,
          incomeRatePct: 3,
          startGrowthPct: 60,
          endGrowthPct: null,
          endYear: null,
        },
      } as ScenarioOverrides,
    });
    const result = runDrawdownForMethod(args, ctx, series(), 'planned');
    expect(result).not.toBeNull();
    for (const yr of result!.years) {
      expect(yr.growthBucket).toBeDefined();
      expect(yr.incomeBucket).toBeDefined();
      expect((yr.growthBucket!.gain + yr.incomeBucket!.gain)).toBeCloseTo(yr.growth, 6);
      expect(yr.growthPct).toBeCloseTo(60, 6);
    }
  });

  it('does NOT emit tooltip bucket fields without an allocation override', () => {
    const acct = account('a1', 'm1');
    const ctx = makeCtx({ accountProjections: [makeProj(acct, 800_000)] });
    const result = runDrawdownForMethod(args, ctx, series(), 'planned');
    expect(result).not.toBeNull();
    expect(result!.years[0].growthBucket).toBeUndefined();
    expect(result!.years[0].incomeBucket).toBeUndefined();
  });
});

describe('runDrawdownForMethod — portfolio at retirement', () => {
  function netAtRetirement(ctx: PipelineContext): number | undefined {
    return runCap(ctx)?.netPortfolioAtRetirement;
  }

  it('should subtract a lumpSum-elected CBP, when the lump-sum event lands before primary retirement', () => {
    const broker = account('a1', 'm1');
    const cbp = account('cbp1', 'm1', 'RETIREMENT_CASH_BALANCE', 'PRE_TAX');
    const ctx = makeCtx({
      accountProjections: [makeProj(broker, 500_000), makeProj(cbp, 100_000)],
      incomeStreams: [pensionStream('p1', 'm1', 'cbp1', 'lumpSum', 'a1')],
      primaryRetirementAbsMonth: 2046 * 12,
      cbpLumpSumEventAbsMonth: new Map([['cbp1', 2046 * 12 - 12]]),
    });
    expect(netAtRetirement(ctx)).toBe(500_000);
  });

  it('should NOT subtract a lumpSum-elected CBP, when the lump-sum event lands at/after primary retirement', () => {
    const broker = account('a1', 'm1');
    const cbp = account('cbp1', 'm1', 'RETIREMENT_CASH_BALANCE', 'PRE_TAX');
    const ctx = makeCtx({
      accountProjections: [makeProj(broker, 500_000), makeProj(cbp, 100_000)],
      incomeStreams: [pensionStream('p1', 'm1', 'cbp1', 'lumpSum', 'a1')],
      primaryRetirementAbsMonth: 2046 * 12,
      cbpLumpSumEventAbsMonth: new Map([['cbp1', 2046 * 12]]),
    });
    expect(netAtRetirement(ctx)).toBe(600_000);
  });

  it('should return null, when subtractions exceed the summed balances', () => {
    const cbp = account('cbp1', 'm1', 'RETIREMENT_CASH_BALANCE', 'PRE_TAX');
    const ctx = makeCtx({
      accountProjections: [makeProj(cbp, 100_000)],
      incomeStreams: [pensionStream('p1', 'm1', 'cbp1', 'annuity')],
    });
    expect(runCap(ctx)).toBeNull();
  });
});

describe('runDrawdownForMethod — RMD context', () => {
  function rmdContext(ctx: PipelineContext) {
    runCap(ctx);
    return engineInput().rmdContext!;
  }

  it('should set deathYear = birthYear + lifeExpectancy for each owner with a birthdate', () => {
    const primary = member('m1', true, '1980-01-01');
    const secondary = member('m2', false, '1975-01-01');
    const acctP = account('a1', 'm1');
    const acctS = account('a2', 'm2');
    const ctx = makeCtx({
      primary,
      secondary,
      accountProjections: [makeProj(acctP, 1), makeProj(acctS, 1)],
      resolvedScenario: {
        lifeExpectancy: { primary: 90, secondary: 88 },
      } as ScenarioOverrides,
    });
    const rmd = rmdContext(ctx);
    expect(rmd.ownerMeta.get('m1')).toEqual({
      isoBirthdate: '1980-01-01',
      deathYear: 1980 + 90,
    });
    expect(rmd.ownerMeta.get('m2')).toEqual({
      isoBirthdate: '1975-01-01',
      deathYear: 1975 + 88,
    });
  });

  it('should fall back to the default life-expectancy age, when no lifeExpectancy override is present', () => {
    const primary = member('m1', true, '1980-01-01');
    const acctP = account('a1', 'm1');
    const ctx = makeCtx({
      primary,
      accountProjections: [makeProj(acctP, 1)],
      resolvedScenario: {} as ScenarioOverrides,
    });
    expect(rmdContext(ctx).ownerMeta.get('m1')?.deathYear).toBe(
      1980 + DEFAULT_LIFE_EXPECTANCY_AGE,
    );
  });

  it('should map each ledger account to its owner in ownerByAccountId', () => {
    const ctx = makeCtx({
      primary: member('m1', true, '1980-01-01'),
      accountProjections: [makeProj(account('a1', 'm1'), 1)],
    });
    const rmd = rmdContext(ctx);
    expect(rmd.ownerByAccountId.get('a1')).toBe('m1');
    expect(rmd.ownerByAccountId.size).toBe(1);
  });

  it('should carry the recorded RMD facts + per-owner separation years to the FORCED draw', () => {
    // The forced-withdrawal pass resolves the per-account rule itself, so the context must hand it the facts; without them it
    // would run the default Uniform-Lifetime branch and contradict its own report disclosure.
    const facts: RmdAccountProfileFacts = { inheritedAccount: true, beneficiaryType: 'SPOUSE' };
    const primary = member('m1', true, '1980-01-01');
    const secondary = member('m2', false, '1975-01-01');
    const ctx = makeCtx({
      primary,
      secondary,
      accountProjections: [
        makeProj(account('a1', 'm1'), 1),
        makeProj(account('a2', 'm2'), 1),
      ],
      rmdProfileFactsByAccountId: new Map([['a1', facts]]),
      retirementByMember: new Map([['m2', '2043-06-01']]),
    });
    const rmd = rmdContext(ctx);
    // Plain Records (a Map would be invisible to the MC cache key).
    expect(rmd.rmdFactsByAccountId?.a1).toBe(facts);
    expect(rmd.rmdFactsByAccountId?.a2).toBeUndefined();
    expect(rmd.retirementYearByOwner?.m1).toBe(2046);
    expect(rmd.retirementYearByOwner?.m2).toBe(2043);
  });

  it('should omit both fact fields entirely for a household that records nothing', () => {
    // With no facts the engine must stay on its legacy branch (the frozen parity fixtures rest on it), so the fields must be
    // absent.
    const ctx = makeCtx({
      primary: member('m1', true, '1980-01-01'),
      accountProjections: [makeProj(account('a1', 'm1'), 1)],
    });
    const rmd = rmdContext(ctx);
    expect(rmd.rmdFactsByAccountId).toBeUndefined();
    expect(rmd.retirementYearByOwner).toBeUndefined();
  });

  it('should pass the default bundle rmd snapshot through unchanged', () => {
    const ctx = makeCtx({
      primary: member('m1', true, '1980-01-01'),
      accountProjections: [makeProj(account('a1', 'm1'), 1)],
    });
    expect(rmdContext(ctx).rmdSnapshot).toBe(DEFAULT_TAX_CALIBRATION_BUNDLE.rmd);
  });
});

describe('resolveQcdLimitCentsForYear — indexed §408(d)(8) limit', () => {
  // Published keys: 2024 = $105,000, 2025 = $108,000, 2026 = $111,000 (latest).
  it('clamps a year at/before the earliest published key to the earliest figure', () => {
    expect(resolveQcdLimitCentsForYear(2020, 3)).toBe(105_000 * 100);
    expect(resolveQcdLimitCentsForYear(2024, 3)).toBe(105_000 * 100);
  });

  it('clamps an interior published/gap year DOWN to the most-recent published key', () => {
    expect(resolveQcdLimitCentsForYear(2025, 3)).toBe(108_000 * 100);
    expect(resolveQcdLimitCentsForYear(2026, 3)).toBe(111_000 * 100);
  });

  it('inflation-extrapolates forward past the latest published key', () => {
    // 2030 at 3% = $111,000 × 1.03^4.
    const expected = Math.round(111_000 * Math.pow(1.03, 4) * 100);
    expect(resolveQcdLimitCentsForYear(2030, 3)).toBe(expected);
    expect(resolveQcdLimitCentsForYear(2030, 3)).toBeGreaterThan(111_000 * 100);
  });

  it('0% inflation leaves the forward-extrapolation at the latest published value', () => {
    expect(resolveQcdLimitCentsForYear(2040, 0)).toBe(111_000 * 100);
  });
});
