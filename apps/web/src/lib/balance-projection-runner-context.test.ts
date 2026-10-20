/**
 * Regression tests for `buildPerAccountDrawdownLedger`.
 *
 * a) Pre-primary linked-CBP lump-sum must NOT emit a ledger entry for
 *    the source CBP account — the dollars have already been routed
 *    into the target's accumulation projection upstream via
 *    `classifyTargetedDeposits`/`preDepositsByAccount`. Without the
 *    exclusion the target gets both the routed contribution AND the
 *    source CBP's at-retirement balance, double-counting it at the
 *    drawdown boundary.
 *
 * b) Contract: every `lumpSum`-elected linked-CBP source account
 *    is EXCLUDED from the ledger regardless of event-month timing
 *    (mirrors the MC bundle factory's `skipsPortfolio: true`). When
 *    the event fires at/after primary retirement, the projected
 *    at-event balance lands in the *target* account's per-account
 *    `depositsByMonth` slot — modeled as a transfer (source excluded
 *    + target deposited) so the kernel doesn't double-count via the
 *    household-aggregate proportional split. The returned
 *    `cbpLumpSumDeposits` list lets the caller subtract those dollars
 *    from the household-aggregate `depositsByMonth` upstream.
 */
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
  // Minimal stub — only the fields `buildPerAccountDrawdownLedger`
  // reads are populated; the rest are unused-but-required by the
  // PipelineContext shape.
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
    // Pre-retirement linked CBP lump-sum: the source CBP's balance has
    // already been routed into the target's accumulation projection
    // upstream. Emitting the source CBP into the post-retirement
    // ledger would double-count its at-retirement balance.
    const cbp = account('cbp1', 'PRE_TAX', 'RETIREMENT_CASH_BALANCE');
    const target = account('target1');
    const accountProjections = [makeProj(cbp, 100_000), makeProj(target, 500_000)];
    // The CBP event fires BEFORE primaryRetirementAbsMonth.
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
    // Source CBP must NOT appear in the ledger.
    expect(result.accounts.find((e) => e.id === 'cbp1')).toBeUndefined();
    // Target still emits its own (the pre-routed contribution was
    // already folded into `target1.outputs.planned.total` upstream by
    // `classifyTargetedDeposits`/`preDepositsByAccount` — this test
    // verifies the source CBP doesn't get a second slot).
    expect(result.accounts.find((e) => e.id === 'target1')).toBeDefined();
    // Pre-primary lump-sum has no post-retirement deposit attribution
    // — the dollars route via the accumulation projection upstream.
    expect(result.cbpLumpSumDeposits.length).toBe(0);
  });

  it('post-primary lumpSum source is EXCLUDED + target receives deposit ONCE', () => {
    // Contract: every `lumpSum`-elected linked-CBP source is
    // excluded from the ledger (mirrors MC bundle's `skipsPortfolio:
    // true`). The post-primary event lands in the target account's
    // per-account `depositsByMonth` slot, and the returned
    // `cbpLumpSumDeposits` list flags the same dollars so the caller
    // can subtract them from the household-aggregate
    // `depositsByMonth` upstream (avoiding the double-count where the
    // kernel applies both `acc.deposit[i]` AND a proportional share
    // of `s.deposit[i]`).
    const cbp = account('cbp1', 'PRE_TAX', 'RETIREMENT_CASH_BALANCE');
    const target = account('target1');
    const accountProjections = [makeProj(cbp, 200_000), makeProj(target, 500_000)];
    // Event fires 12 months AFTER primary retirement.
    const primaryRetirementAbsMonth = 2046 * 12;
    const eventAbsMonth = 2046 * 12 + 12;
    const cbpLumpSumEventAbsMonth = new Map<string, number>([
      ['cbp1', eventAbsMonth],
    ]);
    // CBP projection used to resolve the event-month balance.
    const cbpProj = {
      total: 200_000,
      accumulationGrowth: 0,
      perStep: {
        firstYear: 2026,
        preEnd: new Float64Array((2086 - 2026 + 1) * 12),
        postEnd: new Float64Array((2086 - 2026 + 1) * 12),
      },
    } as unknown as ProjectionOutput;
    // Pin the CBP balance at the event step.
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
    // Source CBP must NOT appear in the ledger (transfer, not
    // additive). The MC bundle factory's `skipsPortfolio: true`
    // contract is mirrored here.
    expect(result.accounts.find((e) => e.id === 'cbp1')).toBeUndefined();
    // Target still emits its own ledger entry.
    const targetEntry = result.accounts.find((e) => e.id === 'target1');
    expect(targetEntry).toBeDefined();
    // Per-account deposit at the event month equals the CBP's
    // projected at-event balance (210_000).
    const startYear = expensesByMonth.startYear;
    const evtYear = 2047;
    const evtMonth0 = 0;
    const stepIdx = (evtYear - startYear) * 12 + evtMonth0;
    expect(targetEntry!.depositsByMonth.values[stepIdx]).toBeCloseTo(210_000, 0);
    // The same dollars are surfaced on `cbpLumpSumDeposits` so the
    // caller subtracts them from the household-aggregate
    // `depositsByMonth` (no double-count).
    expect(result.cbpLumpSumDeposits.length).toBe(1);
    expect(result.cbpLumpSumDeposits[0]).toMatchObject({
      year: 2047,
      month0: 0,
    });
    expect(result.cbpLumpSumDeposits[0].amount).toBeCloseTo(210_000, 0);
  });

  it('zero-balance CBP lump-sum target KEEPS its ledger entry so the deposit lands', () => {
    // Regression: a CBP lump-sum target with zero projected
    // balance at retirement (e.g. a freshly-opened brokerage with no
    // contributions) must still emit a ledger entry — the kernel
    // attaches the event-month deposit via `acc.deposit[i]` and
    // compounds forward. A `buildLedgerEntry` short-circuit on
    // `totalAtRet <= 0` BEFORE the deposit attached would vanish the
    // transferred CBP dollars (the source CBP is excluded from the
    // ledger AND the household-aggregate is clamp-subtracted, so the
    // dollars would have nowhere to land).
    const cbp = account('cbp1', 'PRE_TAX', 'RETIREMENT_CASH_BALANCE');
    const target = account('zeroTarget'); // BROKERAGE, POST_TAX
    // Target's projection.total = 0 — empty account, lump-sum
    // destination only.
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
    // Source CBP excluded (transfer contract).
    expect(result.accounts.find((e) => e.id === 'cbp1')).toBeUndefined();
    // Zero-balance target MUST appear with initialPre=0, initialPost=0
    // — the kernel handles this and the event-month deposit attaches.
    const targetEntry = result.accounts.find((e) => e.id === 'zeroTarget');
    expect(targetEntry).toBeDefined();
    expect(targetEntry!.initialPre).toBe(0);
    expect(targetEntry!.initialPost).toBe(0);
    // `collectPostRetirementCbpLumpSumDeposits` compounds the CBP's
    // projected total forward to the event month at the CBP's
    // planning rate. With cbpProj.total = 150_000, planningReturnPct
    // = 5% (per the `account()` helper), and 24 months past primary
    // retirement: 150_000 × (1.05)^2 = 165_375.
    const expectedAmount = 150_000 * Math.pow(1.05, 2);
    // The deposit lands at the event month (2048 Jan = step 24).
    const stepIdx = (2048 - expensesByMonth.startYear) * 12 + 0;
    expect(targetEntry!.depositsByMonth.values[stepIdx]).toBeCloseTo(
      expectedAmount,
      0,
    );
    // Caller-side clamp-subtraction surface populated.
    expect(result.cbpLumpSumDeposits.length).toBe(1);
    expect(result.cbpLumpSumDeposits[0].amount).toBeCloseTo(expectedAmount, 0);
  });
});

describe('buildPerAccountDrawdownLedger — TWR planned-rate fallback', () => {
  it('non-fill-target short-history account stays in ledger under TWR method at planned rate', () => {
    // A non-CBP account that lacks an empirical
    // TWR rate is projected at its planned rate everywhere in the
    // Historical view, INCLUDING the per-account drawdown ledger.
    //
    // `buildLedgerEntry` must not return null for such accounts
    // (`ratePctByMethod.twr === null` and `!isFillTargetRoth`): dropping
    // them would understate the at-horizon balance — a defect
    // scoped to named-strategy drawdown paths.
    //
    // Instead: `ratePct = proj.ratePctByMethod[method] ??
    // proj.ratePctByMethod.planned` — any fallback account keeps its
    // ledger slot, compounding at the planned rate as the runner does.

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
        // Non-null: runner projected this account at the planned rate under
        // TWR (planned-rate fallback, not a veto).
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

    // Both accounts must appear in the ledger — the fallback account must
    // NOT be dropped despite having `ratePctByMethod.twr === null`.
    const empEntry = result.accounts.find((e) => e.id === 'emp');
    const fallbackEntry = result.accounts.find((e) => e.id === 'fallback');
    expect(empEntry).toBeDefined();
    expect(fallbackEntry).toBeDefined();

    // Empirical account compounds at its empirical rate.
    expect(empEntry!.annualRatePct).toBe(7);

    // Fallback account compounds at its planned rate (not dropped, not 0).
    expect(fallbackEntry!.annualRatePct).toBe(5);
  });
});

describe('buildPerAccountDrawdownLedger — post-primary spouse contributions', () => {
  it('retains a $0-at-retirement account funded only by post-primary events + maps the pre/post split', () => {
    // A spouse account that projects to $0 at primary retirement and is funded
    // ONLY by post-primary contributions must NOT be dropped (the
    // `!hasPostPrimaryDeposit` keep-guard), and its per-account deposit series
    // must carry the pre slice in `depositsByMonth` and the designated-Roth
    // slice in `depositsPostByMonth`.
    const RET_ABS = 2046 * 12;
    const zeroSpouse = account('spouse', 'MIXED', 'RETIREMENT_401K');
    const accountProjections = [makeProj(zeroSpouse, 0)];
    // Three years (36 months) of $750/mo pre-tax + $500/mo designated-Roth
    // post-primary contributions, starting at primary retirement.
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

    // Retained despite a $0 at-retirement balance.
    const entry = result.accounts.find((e) => e.id === 'spouse');
    expect(entry).toBeDefined();
    expect(entry!.depositsPostByMonth).toBeDefined();

    // The per-account deposit series start at January of the retirement year, so
    // an event's series index is `ev.month - startYear*12`.
    const startAbs = 2046 * 12;
    for (const ev of events) {
      const idx = ev.month - startAbs;
      // Pre slice → depositsByMonth; designated-Roth slice → depositsPostByMonth.
      expect(entry!.depositsByMonth.values[idx]).toBeCloseTo(PRE, 6);
      expect(entry!.depositsPostByMonth!.values[idx]).toBeCloseTo(POST, 6);
    }
    // Months outside the 36-month window carry nothing.
    expect(entry!.depositsByMonth.values[36]).toBe(0);
    expect(entry!.depositsPostByMonth!.values[36]).toBe(0);
  });
});

describe('buildPerAccountDrawdownLedger — plain-pension per-account placement', () => {
  it('places a post-retirement plain pension lump-sum in the target PRE_TAX account', () => {
    // A plain (non-linked-CBP) pension lump-sum routes whole into the target
    // account's `depositsByMonth` (→ bucketed by treatment downstream), and the
    // placed dollars are reported back so the caller subtracts them from the
    // household spread (no double-count).
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
    // The placed dollars are reported for the household-spread subtraction.
    expect(result.plainPensionDeposits).toHaveLength(1);
    expect(result.plainPensionDeposits[0].amount).toBeCloseTo(80_000, 6);
  });

  it('does NOT report a placement whose target is absent from the ledger', () => {
    // The target account is not in the projections → no ledger entry → the
    // placement is left in the household spread (NOT reported back), so the
    // caller does not subtract it and the dollars are conserved.
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

// ---------------------------------------------------------------------------
// pureRothBasisCentsByOwner derivation
// ---------------------------------------------------------------------------
// These tests call buildPipelineContext directly with minimal RunBalanceProjectionArgs
// fixtures to exercise the guard branches of the pureRothBasisCentsByOwner reducer
// (in balance-projection-runner-context.ts).

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
  /** Extra payload facts (e.g. the recorded `designatedRothBasis`, which is
   *  what `pureRothBasisCentsByOwner` / `mixedRothDesignatedBasisCentsByOwner` now
   *  read instead of an at-retirement balance). */
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

/** An employer plan's designated-Roth basis IS its recorded in-plan-rollover
 *  principal, and that fact lives on the year's balance row (§402A(c)(4)). */
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
  // The account editor used to ask for the spouse's date of birth even though the
  // household already stores it. That second copy could drift out of date, so the
  // engine now reads the household record; the account keeps only the
  // sole-beneficiary DESIGNATION.
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
    // m1's spouse is >10 years younger. m2's spouse is older, so that stale
    // designation is ignored and the account uses the standard Table III path.
    expect(ctx.rmdProfileFactsByAccountId?.get('ira-p')?.spouseBeneficiaryBirthdate).toBe(
      '1975-06-15',
    );
    expect(
      ctx.rmdProfileFactsByAccountId?.get('ira-p')?.soleSpouseBeneficiaryMoreThan10YrsYounger,
    ).toBe(true);
    expect(ctx.rmdProfileFactsByAccountId?.has('ira-s')).toBe(false);
  });

  it('uses the account OWNER’s household birthdate as the inherited-account beneficiary date', () => {
    // On an inherited account the owner IS the beneficiary, so the Table I
    // birthdate is theirs — the editor no longer asks for it a second time.
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
    // Guards the legacy byte-identical path: the household date is consulted
    // only for an account carrying the sole-spouse designation. Without that
    // scoping every account in a two-member household would suddenly carry a
    // fact and switch the whole household onto the fact-based engine path.
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
    // $350k latest balance, a $250k stored `designatedRothBasis` nobody reads any
    // more, and $40k of recorded in-plan-rollover principal. The seeded basis is
    // the $40k recorded rollover principal — not the $350k balance and not the
    // stored $250k total.
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
    // A large projected balance with no recorded basis contributes nothing: every
    // distributed dollar past recorded lots is treated as earnings.
    const rothAcct = basisAccount('r1', 'm1', 'RETIREMENT_ROTH_401K', true);
    const args = buildBasisArgs({
      accounts: [rothAcct],
      balances: [basisBalanceRow('r1', 2025, 350_000)],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.pureRothBasisCentsByOwner.has('m1')).toBe(false);
  });

  it('(b) inactive pure-Roth employer account is excluded from the map', () => {
    // active: false → guard skips the account; map must be empty.
    const rothAcct = basisAccount('r1', 'm1', 'RETIREMENT_ROTH_403B', false);
    const args = buildBasisArgs({
      accounts: [rothAcct],
      balances: [basisBalanceRow('r1', 2025, 100_000)],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.pureRothBasisCentsByOwner.has('m1')).toBe(false);
  });

  it('(c) pure-Roth employer account with no balance rows is excluded from the map', () => {
    // No balance rows → rows.length === 0 → guard returns early; map must be empty.
    const rothAcct = basisAccount('r1', 'm1', 'RETIREMENT_ROTH_457B', true);
    const args = buildBasisArgs({
      accounts: [rothAcct],
      balances: [], // no rows
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.pureRothBasisCentsByOwner.has('m1')).toBe(false);
  });

  it('(d) pure-Roth employer account whose latest endingBalance is ≤ 0 is excluded', () => {
    // endingBalance = 0 → balanceCents = 0 → guard (balanceCents <= 0) skips it.
    const rothAcct = basisAccount('r1', 'm1', 'RETIREMENT_ROTH_TSP', true);
    const args = buildBasisArgs({
      accounts: [rothAcct],
      balances: [basisBalanceRow('r1', 2025, 0)],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.pureRothBasisCentsByOwner.has('m1')).toBe(false);
  });

  it('(e) two pure-Roth employer accounts for the same owner have their recorded basis SUMMED', () => {
    // Two active ROTH_401K accounts for 'm1' with $12k + $8k of recorded in-plan
    // rollover principal.
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

// ---------------------------------------------------------------------------
// Helpers for mixedRothDesignated tests
// ---------------------------------------------------------------------------

/** MIXED Roth-designated employer-plan account (401k/403b/457b/TSP). */
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

/** Balance row for a MIXED account — sets `endingBalancePostTax` to the
 *  supplied `postTax` value (the basis used by `mixedRothDesignatedBasisCentsByOwner`). */
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
    // $90k post sub-bucket but only $15k of recorded in-plan-rollover principal.
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
    // active: false → guard skips the account; map must be empty.
    const acct = mixedRothAccount('m1a', 'm1', 'RETIREMENT_403B', false);
    const args = buildBasisArgs({
      accounts: [acct],
      balances: [mixedBasisBalanceRow('m1a', 2025, 100_000, 40_000)],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.mixedRothDesignatedBasisCentsByOwner.has('m1')).toBe(false);
  });

  it('(c) MIXED Roth-designated account with no balance rows is excluded', () => {
    // No balance rows → rows.length === 0 → guard returns early; map must be empty.
    const acct = mixedRothAccount('m1a', 'm1', 'RETIREMENT_457B', true);
    const args = buildBasisArgs({
      accounts: [acct],
      balances: [],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.mixedRothDesignatedBasisCentsByOwner.has('m1')).toBe(false);
  });

  it('(d) MIXED account whose latest endingBalancePostTax is null or 0 is excluded', () => {
    // endingBalancePostTax = null → postCents = 0 → guard (postCents <= 0) skips it.
    const acct = mixedRothAccount('m1a', 'm1', 'RETIREMENT_TSP', true);
    const args = buildBasisArgs({
      accounts: [acct],
      balances: [mixedBasisBalanceRow('m1a', 2025, 100_000, null)],
    });
    const ctx = buildBasisCtx(args);
    expect(ctx.mixedRothDesignatedBasisCentsByOwner.has('m1')).toBe(false);

    // Also test endingBalancePostTax = 0.
    const acct2 = mixedRothAccount('m1b', 'm2', 'RETIREMENT_401K', true);
    const args2 = buildBasisArgs({
      accounts: [acct2],
      balances: [mixedBasisBalanceRow('m1b', 2025, 100_000, 0)],
    });
    const ctx2 = buildBasisCtx(args2);
    expect(ctx2.mixedRothDesignatedBasisCentsByOwner.has('m2')).toBe(false);
  });

  it('(e) non-designated MIXED account (e.g. MIXED BROKERAGE) is excluded', () => {
    // isRothDesignatedRetirementType('BROKERAGE') === false → guard skips it.
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
    // Two active MIXED accounts for 'm1' with $6k + $4k of recorded in-plan
    // rollover principal = $10k.
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
    // Three balance years with growing post sub-buckets; the seeded basis tracks
    // only the one recorded rollover, so no balance can inflate it.
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

// ---------------------------------------------------------------------------
// mixedInPlanConversionBasisCentsByOwner segregation (MC seed isolation)
// ---------------------------------------------------------------------------

import { buildMcTaxContext } from './balance-projection-runner-mc';

/** Build a MIXED Roth-designated 401k account (used as both source and target
 *  for a same-account in-plan conversion). */
function inPlanMixedAccount(
  id: string,
  ownerId: string,
): Aggregate<AccountPayload> {
  // The seeded designated-Roth basis is the recorded in-plan-rollover
  // principal on the balance row below ($3k), not the account's post sub-bucket
  // balance, so the isolation assertions below stay meaningful.
  const base = basisAccount(id, ownerId, 'RETIREMENT_401K', true);
  return { ...base, payload: { ...base.payload, taxTreatment: 'MIXED' } };
}

describe('buildPipelineContext — mixedInPlanConversionBasisCentsByOwner vs mixedRothDesignatedBasisCentsByOwner', () => {
  it('(a) same-account MIXED in-plan conversion: mixedInPlanConversionBasisCentsByOwner holds the converted amount', () => {
    // One MIXED 401k as both source and target of a same-account in-plan
    // conversion of $5k/yr for 1 year (2026 only). The owner also has a
    // snapshot post balance ($3k) which seeds mixedRothDesignatedBasisCentsByOwner.
    const acct = inPlanMixedAccount('m401k', 'm1');
    const args = buildBasisArgs({
      accounts: [acct],
      // endingBalancePreTax must be non-null so seedBuckets seeds a non-zero
      // pre-tax sub-bucket (MIXED: pre = endingBalancePreTax ?? 0).
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
    // The conversion amount ($5k = 500,000 cents) lands in the new field.
    expect(ctx.mixedInPlanConversionBasisCentsByOwner.get('m1')).toBe(500_000);
    // The fact-derived field must reflect ONLY the recorded basis ($3k = 300,000 cents).
    expect(ctx.mixedRothDesignatedBasisCentsByOwner.get('m1')).toBe(300_000);
    // The same principal is ALSO keyed by the target ACCOUNT, so the
    // deterministic designated carrier credits the exact plan that received it.
    expect(ctx.mixedInPlanConversionBasisCentsByAccount.get('m401k')).toBe(500_000);
  });

  it('(b) MC seed does NOT include the deterministic-only in-plan conversion basis', () => {
    // Same scenario as (a): $5k in-plan conversion + $3k snapshot post balance.
    // The MC seed must equal only the snapshot-derived basis (300,000 cents) —
    // the conversion basis must NOT appear there.
    const acct = inPlanMixedAccount('m401k', 'm1');
    const args = buildBasisArgs({
      accounts: [acct],
      // endingBalancePreTax must be non-null so seedBuckets seeds a non-zero
      // pre-tax sub-bucket (MIXED: pre = endingBalancePreTax ?? 0).
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
              // Use a named strategy with tax data so buildMcTaxContext returns a
              // defined McTaxContext.
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
    // rothFirst strategy guarantees buildMcTaxContext returns a defined value.
    const mcTaxCtx = buildMcTaxContext(ctx);
    expect(mcTaxCtx).toBeDefined();
    // `rothBasisCentsByOwner` is a PLAIN sorted array on `McTaxContext` (so it
    // participates in `mcCacheKey` — a `Map` serialises to `{}`) and carries ONLY
    // Roth-IRA regular-contribution basis. This household owns no Roth IRA, so it is
    // empty; designated-Roth basis lives on `rothOrderedProfile`, where the §402A
    // pro-rata regime consumes it.
    expect(
      mcTaxCtx!.rothBasisCentsByOwner?.find((e) => e.ownerId === 'm1')?.cents ?? 0,
    ).toBe(0);
    // The MC designated pool carries ONLY the RECORDED $3k basis fact — never the
    // $5k deterministic-only in-plan conversion basis (MC does not model the
    // conversion deposit legs, so seeding it there would shield MC Roth withdrawals
    // the MC Roth balance never received).
    expect(mcTaxCtx!.rothOrderedProfile?.designatedBasisCents).toBe(300_000);
    // Field isolation on ctx is also load-bearing.
    expect(ctx.mixedInPlanConversionBasisCentsByOwner.get('m1')).toBe(500_000);
    expect(ctx.mixedInPlanConversionBasisCentsByAccount.get('m401k')).toBe(500_000);
    expect(ctx.mixedRothDesignatedBasisCentsByOwner.get('m1')).toBe(300_000);
  });
});
