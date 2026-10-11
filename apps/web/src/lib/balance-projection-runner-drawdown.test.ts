/**
 * Unit tests for the per-method drawdown executor helpers in
 * `balance-projection-runner-drawdown.ts`:
 *
 *  - `resolveMagiCapWindows` — MAGI-cap window resolution
 *    (primary/secondary end anchors → `[startYear, endYear)`; a broken
 *    anchor is FLAGGED inactive, never thrown; total-order sort,
 *    non-positive-interval drop, earliest-start-on-overlap).
 *  - `runDrawdownForMethod` — allocation routes through the per-account
 *    path with every withdrawal strategy + the null short-circuit
 *    (zero portfolio / empty ledger).
 *  - `computePortfolioAtRetirement` — annuity-elected CBP subtracted;
 *    lumpSum-elected CBP subtracted only when the event lands before
 *    primary retirement; floor at 0.
 *  - `buildRmdContext` — deathYear = birthYear + lifeExpectancy (+ the
 *    default fallback); ledger accounts absent from `accountProjections`
 *    skipped in `ownerByAccountId`; `rmdSnapshot` passthrough; and the
 *    the recorded per-account RMD facts + per-owner separation years the
 *    FORCED withdrawal resolves its rule from, omitted entirely for a
 *    fact-free household.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveMagiCapWindows,
  computePortfolioAtRetirement,
  buildRmdContext,
  runDrawdownForMethod,
  resolveQcdLimitCentsForYear,
} from './balance-projection-runner-drawdown';
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
import type { TaxCalibrationBundle } from './tax-integration';
import type { ProjectionOutput } from './projection';
import type {
  AccountProjection,
  CashflowSeries,
  PipelineContext,
  ProjectionMethod,
  RunBalanceProjectionArgs,
} from './balance-projection-runner-types';
import type { ScenarioAggregate } from './scenario-resolution';
import type { DrawdownAccountInput } from './drawdown-engine-types';
import type { RmdAccountProfileFacts } from './rmd';

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
    resolvedQcd: { entries: [] },
  };
}

/** A single-window cap ladder whose end anchors to `role`'s age `endAge`.
 *  Start = retirement (the implicit start). */
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

describe('resolveMagiCapWindows', () => {
  it('should resolve a primary-anchored window to [retirementYear, birthYear+endAge) (legacy parity)', () => {
    // Primary born 1990 → retires 2046 (age 56) → the cap ends at age 75 (2065).
    const ctx = makeCtx({ primary: member('m1', true, '1990-01-01') });
    const windows = resolveMagiCapWindows(magiCap('primary', 75), ctx);
    expect(windows).toHaveLength(1);
    // Start = retirement (2046); end exclusive = the year primary turns 75.
    expect(windows![0].startYear).toBe(2046);
    expect(windows![0].endYear).toBe(1990 + 75);
  });

  it('should anchor the end to the secondary member when the end anchor names secondary', () => {
    const ctx = makeCtx({
      primary: member('m1', true, '1990-01-01'),
      secondary: member('m2', false, '1988-06-15'),
    });
    const windows = resolveMagiCapWindows(magiCap('secondary', 75), ctx);
    expect(windows![0].endYear).toBe(1988 + 75);
  });

  it('should FLAG a broken-anchor window inactive — never throw — when the gating birthdate is missing', () => {
    const ctx = makeCtx({ primary: member('m1', true, undefined) });
    const windows = resolveMagiCapWindows(magiCap('primary', 75), ctx);
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
          // broken: anchors to a secondary with no birthdate
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
    const windows = resolveMagiCapWindows(ladder, ctx);
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
    const windows = resolveMagiCapWindows(ladder, ctx)!;
    expect(windows.map((w) => w.startYear)).toEqual([2050, 2060]);
    expect(windows.map((w) => w.originalIndex)).toEqual([1, 0]);
  });

  it('should drop a non-positive resolved interval', () => {
    const ctx = makeCtx({ primary: member('m1', true, '1980-01-01') });
    const ladder: MagiCapOverride = {
      windows: [
        // year 2055 start, year 2050 end → resolved end (2051) ≤ start → dropped
        { start: { kind: 'year', year: 2055 }, end: { kind: 'year', year: 2050 }, magiCeilingAnnualDollars: 1, capMode: 'minimize', capMagiLine: 'irmaa' },
      ],
    };
    expect(resolveMagiCapWindows(ladder, ctx)).toBeUndefined();
  });

  it('should return undefined for an empty ladder', () => {
    const ctx = makeCtx({ primary: member('m1', true, '1980-01-01') });
    expect(resolveMagiCapWindows({ windows: [] }, ctx)).toBeUndefined();
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
    // Allocation routes through the per-account
    // path (the ledger carries the blended-glide `returnPctByMonth`), so every
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
    // Act / Assert — no throw, a real result is produced.
    const result = runDrawdownForMethod(args, ctx, series(), 'planned');
    expect(result).not.toBeNull();
    expect(result!.years.length).toBeGreaterThan(0);
  });

  it('should surface the net at-retirement figure computePortfolioAtRetirement already computed, additively', () => {
    // Arrange — an annuity-elected CBP account alongside a plain brokerage
    // account: `netPortfolioAtRetirement` must equal `computePortfolioAtRetirement`'s
    // excluded figure (broker only), NOT the raw summed total (broker + CBP).
    const broker = account('a1', 'm1');
    const cbp = account('cbp1', 'm1', 'RETIREMENT_CASH_BALANCE', 'PRE_TAX');
    const ctx = makeCtx({
      accountProjections: [makeProj(broker, 500_000), makeProj(cbp, 100_000)],
      incomeStreams: [pensionStream('p1', 'm1', 'cbp1', 'annuity')],
    });
    const expected = computePortfolioAtRetirement(ctx);
    const result = runDrawdownForMethod(args, ctx, series(), 'planned');
    expect(result).not.toBeNull();
    expect(expected).toBe(500_000);
    expect(result!.netPortfolioAtRetirement).toBe(expected);
  });

  it('should return null, when the portfolio at retirement is <= 0', () => {
    // Arrange — single account projecting to zero at retirement.
    const acct = account('a1', 'm1');
    const ctx = makeCtx({ accountProjections: [makeProj(acct, 0)] });
    // Act
    const result = runDrawdownForMethod(args, ctx, series(), 'planned');
    // Assert
    expect(result).toBeNull();
  });

  it('should return null, when there is no allocation override and the per-account ledger is empty', () => {
    // Arrange — no accounts at all: positive-portfolio path can't be
    // reached, and the ledger is empty with no allocation.
    const ctx = makeCtx({ accountProjections: [] });
    // Act
    const result = runDrawdownForMethod(args, ctx, series(), 'planned');
    // Assert
    expect(result).toBeNull();
  });

  it('should INCLUDE post-primary spouse contributions under allocation (per-account route)', () => {
    // Allocation now routes through the per-account ledger (each account carries
    // the blended-glide `returnPctByMonth`), so post-primary contributions are
    // applied per-account directly (no single-pool re-merge). This pins that the
    // same allocation scenario WITH post-primary events lands a materially higher
    // at-horizon balance than WITHOUT them.
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
    // Twelve months of $1,000/mo post-primary contributions in the first
    // drawdown year (mix of pre + Roth, routed per-account by treatment).
    // `month` is the absolute step index.
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
    // The 12 * $1,000 = $12,000 of contributions are reflected in the pool: the
    // merged final balance exceeds the baseline by (approximately) the full
    // contribution total (0% return → no compounding, no spend pressure).
    expect(lastMerged).toBeGreaterThan(lastBaseline);
    expect(lastMerged - lastBaseline).toBeCloseTo(12_000, 0);
  });

  it('derives the growth/income Gains tooltip split that sums EXACTLY to the year gain', () => {
    // Allocation override → the runner post-pass derives growthBucket/incomeBucket
    // gains. They must sum exactly to year.growth (single residual), and growthPct
    // is the year's target growth share as a percent.
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
      // Single-residual exact sum.
      expect((yr.growthBucket!.gain + yr.incomeBucket!.gain)).toBeCloseTo(yr.growth, 6);
      // Flat 60% growth share → growthPct 60.
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

describe('computePortfolioAtRetirement', () => {
  it('should subtract an annuity-elected CBP balance from the total', () => {
    // Arrange — one brokerage (500k) + one annuity-elected CBP (100k).
    const broker = account('a1', 'm1');
    const cbp = account('cbp1', 'm1', 'RETIREMENT_CASH_BALANCE', 'PRE_TAX');
    const ctx: PipelineContext = {
      ...makeCtx({
        accountProjections: [makeProj(broker, 500_000), makeProj(cbp, 100_000)],
        incomeStreams: [pensionStream('p1', 'm1', 'cbp1', 'annuity')],
      }),
    };
    // Act
    const total = computePortfolioAtRetirement(ctx);
    // Assert — annuity CBP dollars flow as income, not portfolio.
    expect(total).toBe(500_000);
  });

  it('should subtract a lumpSum-elected CBP, when the lump-sum event lands before primary retirement', () => {
    // Arrange — lumpSum CBP with an event month one year before primary.
    const broker = account('a1', 'm1');
    const cbp = account('cbp1', 'm1', 'RETIREMENT_CASH_BALANCE', 'PRE_TAX');
    const ctx = makeCtx({
      accountProjections: [makeProj(broker, 500_000), makeProj(cbp, 100_000)],
      incomeStreams: [pensionStream('p1', 'm1', 'cbp1', 'lumpSum', 'a1')],
      primaryRetirementAbsMonth: 2046 * 12,
      cbpLumpSumEventAbsMonth: new Map([['cbp1', 2046 * 12 - 12]]),
    });
    // Act
    const total = computePortfolioAtRetirement(ctx);
    // Assert — pre-retirement lump-sum already routed to the target.
    expect(total).toBe(500_000);
  });

  it('should NOT subtract a lumpSum-elected CBP, when the lump-sum event lands at/after primary retirement', () => {
    // Arrange — lumpSum CBP with an event AT primary retirement month.
    const broker = account('a1', 'm1');
    const cbp = account('cbp1', 'm1', 'RETIREMENT_CASH_BALANCE', 'PRE_TAX');
    const ctx = makeCtx({
      accountProjections: [makeProj(broker, 500_000), makeProj(cbp, 100_000)],
      incomeStreams: [pensionStream('p1', 'm1', 'cbp1', 'lumpSum', 'a1')],
      primaryRetirementAbsMonth: 2046 * 12,
      cbpLumpSumEventAbsMonth: new Map([['cbp1', 2046 * 12]]),
    });
    // Act
    const total = computePortfolioAtRetirement(ctx);
    // Assert — post-primary lump-sum stays in the portfolio total.
    expect(total).toBe(600_000);
  });

  it('should floor the total at 0, when subtractions exceed the summed balances', () => {
    // Arrange — annuity CBP balance exceeds the rest of the portfolio.
    const cbp = account('cbp1', 'm1', 'RETIREMENT_CASH_BALANCE', 'PRE_TAX');
    const ctx = makeCtx({
      accountProjections: [makeProj(cbp, 100_000)],
      incomeStreams: [pensionStream('p1', 'm1', 'cbp1', 'annuity')],
    });
    // Act
    const total = computePortfolioAtRetirement(ctx);
    // Assert
    expect(total).toBe(0);
  });
});

describe('buildRmdContext', () => {
  const bundle = {
    rmd: { sentinel: 'rmd-snapshot' },
  } as unknown as TaxCalibrationBundle;

  function ledgerEntry(id: string): DrawdownAccountInput {
    return { id } as unknown as DrawdownAccountInput;
  }

  it('should set deathYear = birthYear + lifeExpectancy for each owner with a birthdate', () => {
    // Arrange — primary + secondary, explicit life expectancies.
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
    // Act
    const rmd = buildRmdContext(
      ctx,
      [ledgerEntry('a1'), ledgerEntry('a2')],
      bundle,
    );
    // Assert
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
    // Arrange — no lifeExpectancy section on the resolved scenario.
    const primary = member('m1', true, '1980-01-01');
    const acctP = account('a1', 'm1');
    const ctx = makeCtx({
      primary,
      accountProjections: [makeProj(acctP, 1)],
      resolvedScenario: {} as ScenarioOverrides,
    });
    // Act
    const rmd = buildRmdContext(ctx, [ledgerEntry('a1')], bundle);
    // Assert
    expect(rmd.ownerMeta.get('m1')?.deathYear).toBe(
      1980 + DEFAULT_LIFE_EXPECTANCY_AGE,
    );
  });

  it('should skip ledger accounts absent from accountProjections in ownerByAccountId', () => {
    // Arrange — ledger references 'a1' (known) and 'ghost' (not in
    // accountProjections).
    const primary = member('m1', true, '1980-01-01');
    const acctP = account('a1', 'm1');
    const ctx = makeCtx({
      primary,
      accountProjections: [makeProj(acctP, 1)],
    });
    // Act
    const rmd = buildRmdContext(
      ctx,
      [ledgerEntry('a1'), ledgerEntry('ghost')],
      bundle,
    );
    // Assert — only the known account maps to an owner.
    expect(rmd.ownerByAccountId.get('a1')).toBe('m1');
    expect(rmd.ownerByAccountId.has('ghost')).toBe(false);
    expect(rmd.ownerByAccountId.size).toBe(1);
  });

  it('should carry the recorded RMD facts + per-owner separation years to the FORCED draw', () => {
    // The forced-withdrawal pass resolves the per-account rule itself, so
    // the context has to hand it the facts. Without them the money-moving pass would run the
    // default Uniform-Lifetime branch and contradict its own report disclosure.
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
    // Act
    const rmd = buildRmdContext(ctx, [ledgerEntry('a1'), ledgerEntry('a2')], bundle);
    // Assert — plain Records (a Map would be invisible to the MC cache key).
    expect(rmd.rmdFactsByAccountId?.a1).toBe(facts);
    expect(rmd.rmdFactsByAccountId?.a2).toBeUndefined();
    expect(rmd.retirementYearByOwner?.m1).toBe(2046);
    expect(rmd.retirementYearByOwner?.m2).toBe(2043);
  });

  it('should omit both fact fields entirely for a household that records nothing', () => {
    // The byte-identical guarantee the frozen parity fixtures rest on: with no facts
    // the engine must stay on its legacy branch, which needs the fields ABSENT.
    const ctx = makeCtx({
      primary: member('m1', true, '1980-01-01'),
      accountProjections: [makeProj(account('a1', 'm1'), 1)],
    });
    const rmd = buildRmdContext(ctx, [ledgerEntry('a1')], bundle);
    expect(rmd.rmdFactsByAccountId).toBeUndefined();
    expect(rmd.retirementYearByOwner).toBeUndefined();
  });

  it('should pass the bundle.rmd snapshot through unchanged', () => {
    // Arrange
    const primary = member('m1', true, '1980-01-01');
    const ctx = makeCtx({
      primary,
      accountProjections: [makeProj(account('a1', 'm1'), 1)],
    });
    // Act
    const rmd = buildRmdContext(ctx, [ledgerEntry('a1')], bundle);
    // Assert
    expect(rmd.rmdSnapshot).toBe(bundle.rmd);
  });
});

describe('resolveQcdLimitCentsForYear — indexed §408(d)(8) limit', () => {
  // Published keys: 2024 = $105,000, 2025 = $108,000, 2026 = $111,000 (latest).
  it('clamps a year at/before the earliest published key to the earliest figure', () => {
    // Branch 1: taxYear ≤ earliest (2024) → earliest value, inflation ignored.
    expect(resolveQcdLimitCentsForYear(2020, 3)).toBe(105_000 * 100);
    expect(resolveQcdLimitCentsForYear(2024, 3)).toBe(105_000 * 100);
  });

  it('clamps an interior published/gap year DOWN to the most-recent published key', () => {
    // Branch 2: earliest < taxYear ≤ latest → most-recent published key ≤ taxYear
    // (the published value is authoritative; inflation never applies here).
    expect(resolveQcdLimitCentsForYear(2025, 3)).toBe(108_000 * 100);
    expect(resolveQcdLimitCentsForYear(2026, 3)).toBe(111_000 * 100);
  });

  it('inflation-extrapolates forward past the latest published key', () => {
    // Branch 3: taxYear > latest (2026) → base × (1 + i/100)^(taxYear − latest).
    // 2030 at 3% = $111,000 × 1.03^4.
    const expected = Math.round(111_000 * Math.pow(1.03, 4) * 100);
    expect(resolveQcdLimitCentsForYear(2030, 3)).toBe(expected);
    // The extrapolated figure exceeds the latest published value (NOT clamped).
    expect(resolveQcdLimitCentsForYear(2030, 3)).toBeGreaterThan(111_000 * 100);
  });

  it('0% inflation leaves the forward-extrapolation at the latest published value', () => {
    expect(resolveQcdLimitCentsForYear(2040, 0)).toBe(111_000 * 100);
  });
});
