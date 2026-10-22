/** Unit tests for the MC-bundle assembly helpers in `balance-projection-runner-mc.ts`. */
import { describe, expect, it } from 'vitest';
import { assembleMcBundle } from './monte-carlo-input-bundle';
import {
  canonicalSsSharesByYear,
  mcInputFromBundle,
  buildMcTaxContext,
  buildMcRmdContext,
  buildMcQcdContext,
  buildOptimizerMcScenarioSetup,
  OPTIMIZER_MC_SEED,
} from './balance-projection-runner-mc';
import {
  buildPipelineContext,
  buildRmdEngineFactsFragment,
} from './balance-projection-runner-context';
import { buildCashflowSeries } from './balance-projection-runner-cashflow';
import { runBalanceProjectionForPage, runBalanceProjectionMc } from './balance-projection-runner';
import { buildMcTaxYearInput, deriveMcSurvivors } from './monte-carlo-tax';
import { buildMonteCarloInputForScenario } from './monte-carlo-scenario-input';
import { DEFAULT_GUARDRAIL_CONFIG } from './guardrails';
import { CbpUnconfiguredError } from './balance-projection-runner-types';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamKind,
  IncomeStreamPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';
import { resolveInflationForScenario, type ScenarioAggregate } from './scenario-resolution';
import { resolveExpensesForScenario } from './expense-resolution';
import {
  buildExpenseProjectionContext,
  projectExpensesByYear,
} from './expense-projection';
import type {
  PipelineContext,
  RunBalanceProjectionArgs,
} from './balance-projection-runner-types';

const TODAY_YEAR = 2026;
const TODAY_MONTH_INDEX = 5; // June (0-indexed).

function member(
  id: string,
  isPrimary: boolean,
  firstName: string,
  birthYear: number,
): Aggregate<HouseholdMemberPayload> {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'householdMember',
    payload: {
      isPrimary,
      firstName,
      lastName: 'Doe',
      email: `${id}@example.test`,
      birthdate: `${birthYear}-01-01`,
    },
  };
}

function ssBenefit(
  memberId: string,
  pia: number | null,
): Aggregate<SocialSecurityBenefitPayload> {
  return {
    id: `ss-${memberId}`,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'socialSecurityBenefit',
    payload: {
      householdMemberId: memberId,
      pia,
      piaAsOfDate: '2026-01-01',
      notes: null,
    },
  };
}

function brokerage(
  id: string,
  ownerId: string,
  type: AccountPayload['type'] = 'BROKERAGE',
  taxTreatment: AccountPayload['taxTreatment'] = 'POST_TAX',
  planningReturnPct = 5,
  plannedPre = 0,
  plannedPost = 0,
): Aggregate<AccountPayload> {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'account',
    payload: {
      name: id,
      type,
      ownershipType: 'INDIVIDUAL',
      taxTreatment,
      ownerId,
      institution: 'Vanguard',
      notes: '',
      planningReturnPct,
      active: true,
      plannedContributionPreTax: plannedPre,
      plannedContributionPostTax: plannedPost,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
    },
  };
}

function balanceRow(
  accountId: string,
  year: number,
  endingBalance: number,
  rothConversion?: { taxable?: number; nontaxable?: number },
): Aggregate<AccountBalancePayload> {
  return {
    id: `b-${accountId}-${year}`,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
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
      ...(rothConversion?.taxable !== undefined
        ? { rothConversionTaxableAmount: rothConversion.taxable }
        : {}),
      ...(rothConversion?.nontaxable !== undefined
        ? { rothConversionNontaxableAmount: rothConversion.nontaxable }
        : {}),
    },
  };
}

function withContributions(
  row: Aggregate<AccountBalancePayload>,
  totalContributions: number,
): Aggregate<AccountBalancePayload> {
  return { ...row, payload: { ...row.payload, totalContributions } };
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

function baseScenario(
  id: string,
  name: string,
  overrides: Partial<ScenarioAggregate['payload']['overrides']> = {},
): ScenarioAggregate {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'scenario',
    payload: {
      name,
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
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
        },
        inflation: { ratePct: 0 },
        lifeExpectancy: { primary: 90, secondary: 90 },
        ...overrides,
      },
    },
  };
}

interface FixtureOverrides {
  readonly expenses?: ReadonlyArray<Aggregate<ExpensePayload>>;
  readonly incomeStreams?: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  readonly members?: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  readonly ssBenefits?: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  readonly accounts?: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly balances?: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly scenario?: ScenarioAggregate;
  readonly medicalCategoryIds?: ReadonlyArray<string>;
}

function buildArgs(o: FixtureOverrides = {}): RunBalanceProjectionArgs {
  const scenario = o.scenario ?? baseScenario('s', 'Base');
  return {
    scenarioId: scenario.id,
    scenarios: [scenario],
    accounts: o.accounts ?? [brokerage('a1', 'm1')],
    balances: o.balances ?? [balanceRow('a1', 2025, 800_000)],
    members: o.members ?? [member('m1', true, 'Alex', 1965)],
    ssBenefits: o.ssBenefits ?? [ssBenefit('m1', 2500)],
    expenses: o.expenses ?? [],
    incomeStreams: o.incomeStreams ?? [],
    todayYear: TODAY_YEAR,
    todayMonthIndex: TODAY_MONTH_INDEX,
    ...(o.medicalCategoryIds
      ? { medicalCategoryIds: o.medicalCategoryIds }
      : {}),
  };
}

function buildCtx(args: RunBalanceProjectionArgs): PipelineContext {
  const ctx = buildPipelineContext(args);
  if (!ctx) throw new Error('fixture failed to build a pipeline context');
  return ctx;
}

function assemble(args: RunBalanceProjectionArgs) {
  const ctx = buildCtx(args);
  const cashflowSeries = buildCashflowSeries(args, ctx);
  return { ctx, bundle: assembleMcBundle({ runArgs: args, ctx, cashflowSeries }) };
}

describe('assembleMcBundle — CBP validation gate', () => {
  it('should_treat_null_cbp_validation_as_ok_and_synthesize_an_ok_validation_on_the_bundle', () => {
    const args = buildArgs();
    const ctx = buildCtx(args);
    expect(ctx.cbpValidation).toBeNull();

    const { bundle } = assemble(args);

    expect(bundle.cbpValidation.ok).toBe(true);
    expect(bundle.cbpValidation.unconfigured).toEqual([]);
    expect(bundle.portfolioToday).toBe(800_000);
  });

  it('should_exclude_an_annuity_elected_cbp_balance_from_portfolio_when_validation_is_ok', () => {
    const cbp = brokerage(
      'cbp1',
      'm1',
      'RETIREMENT_CASH_BALANCE',
      'PRE_TAX',
    );
    const annuityStream: Aggregate<IncomeStreamPayload> = {
      id: 'inc-cbp-annuity',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'incomeStream',
      payload: {
        name: 'CBP Annuity',
        kind: 'pension',
        memberId: 'm1',
        payoutType: 'annuity',
        linkedCbpAccountId: 'cbp1',
        monthlyBenefit: 1_000,
        colaPct: 0,
        start: { kind: 'retirementStart' },
      } as IncomeStreamPayload,
    };
    const args = buildArgs({
      accounts: [brokerage('a1', 'm1'), cbp],
      balances: [
        balanceRow('a1', 2025, 800_000),
        balanceRow('cbp1', 2025, 250_000),
      ],
      incomeStreams: [annuityStream],
    });
    const ctx = buildCtx(args);
    expect(ctx.cbpValidation?.ok).toBe(true);

    const { bundle } = assemble(args);

    expect(bundle.portfolioToday).toBe(800_000);
    expect(bundle.cbpValidation.ok).toBe(true);
  });

  it('should_gate_optimizer_setup_with_CbpUnconfiguredError_when_validation_is_not_ok', () => {
    const cbp = brokerage(
      'cbp1',
      'm1',
      'RETIREMENT_CASH_BALANCE',
      'PRE_TAX',
    );
    const args = buildArgs({
      accounts: [cbp],
      balances: [balanceRow('cbp1', 2025, 100_000)],
    });
    const ctx = buildCtx(args);
    expect(ctx.cbpValidation?.ok).toBe(false);

    expect(() => buildOptimizerMcScenarioSetup(args)).toThrowError(
      CbpUnconfiguredError,
    );
  });
});

describe('assembleMcBundle — event re-anchoring + fractional year', () => {
  it('should_reanchor_a_post_primary_one_off_event_to_a_todayYear_relative_step_index', () => {
    // The cashflow series stores events at the absolute month (year*12 + month0); assembleMcBundle re-anchors them to a
    // step index relative to todayYear.
    const windfall: Aggregate<IncomeStreamPayload> = {
      id: 'inc-windfall',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'incomeStream',
      payload: {
        name: 'Windfall',
        kind: 'oneOff',
        memberId: 'm1',
        oneOffAmount: 40_000,
        targetAccountId: 'a1',
        start: { kind: 'year', year: 2034 },
      } as IncomeStreamPayload,
    };
    const args = buildArgs({ incomeStreams: [windfall] });
    const ctx = buildCtx(args);
    const cashflowSeries = buildCashflowSeries(args, ctx);
    expect(cashflowSeries.targetedOneOffEvents.length).toBeGreaterThan(0);
    const absMonth = cashflowSeries.targetedOneOffEvents[0].month;
    expect(absMonth).toBeGreaterThanOrEqual(2034 * 12);

    const { bundle } = assemble(args);

    // The bundle event = absolute month - todayYear*12.
    expect(bundle.targetedOneOffEvents.length).toBe(
      cashflowSeries.targetedOneOffEvents.length,
    );
    const reanchored = bundle.targetedOneOffEvents[0];
    expect(reanchored.month).toBe(absMonth - TODAY_YEAR * 12);
    expect(reanchored.month).toBeGreaterThanOrEqual(8 * 12);
    expect(reanchored.amount).toBe(cashflowSeries.targetedOneOffEvents[0].amount);
  });

  it('should_reanchor_post_primary_contribution_events_to_todayYear_relative_step_indices', () => {
    const primary = member('m1', true, 'Alex', 1965);
    const secondary = member('m2', false, 'Sam', 1968);
    const secAccount = brokerage(
      'a-sec',
      'm2',
      'RETIREMENT_401K',
      'PRE_TAX',
      5,
      12_000,
      0,
    );
    const args = buildArgs({
      members: [primary, secondary],
      ssBenefits: [ssBenefit('m1', 2500), ssBenefit('m2', 2000)],
      accounts: [brokerage('a1', 'm1'), secAccount],
      balances: [
        balanceRow('a1', 2025, 800_000),
        balanceRow('a-sec', 2025, 200_000),
      ],
    });
    const ctx = buildCtx(args);
    const cashflowSeries = buildCashflowSeries(args, ctx);
    expect(cashflowSeries.postPrimaryContributionEvents.length).toBeGreaterThan(0);

    const { bundle } = assemble(args);

    expect(bundle.postPrimaryContributionEvents.length).toBe(
      cashflowSeries.postPrimaryContributionEvents.length,
    );
    for (let i = 0; i < bundle.postPrimaryContributionEvents.length; i += 1) {
      const src = cashflowSeries.postPrimaryContributionEvents[i];
      const out = bundle.postPrimaryContributionEvents[i];
      expect(out.month).toBe(src.month - TODAY_YEAR * 12);
      expect(out.amount).toBe(src.amount);
      expect(out.accountId).toBe(src.accountId);
    }
  });

  it('should_set_retirementFractionalYear_to_retirementYear_plus_month0_over_12', () => {
    // Born 1965-07 retires at 67 in 2032, month0 = 6 (July): fractional year 2032 + 6/12.
    const midYear: Aggregate<HouseholdMemberPayload> = {
      ...member('m1', true, 'Alex', 1965),
      payload: {
        ...member('m1', true, 'Alex', 1965).payload,
        birthdate: '1965-07-01',
      },
    };
    const args = buildArgs({ members: [midYear] });
    const ctx = buildCtx(args);

    const { bundle } = assemble(args);

    expect(bundle.retirementFractionalYear).toBeCloseTo(
      ctx.primaryRetirementYear + ctx.primaryRetirementMonth0 / 12,
      10,
    );
    expect(ctx.primaryRetirementMonth0).toBe(6);
    expect(bundle.retirementFractionalYear).toBeCloseTo(2032 + 6 / 12, 10);
  });
});

describe('mcInputFromBundle + buildOptimizerMcScenarioSetup — pinned seed + paths', () => {
  it('should_pin_OPTIMIZER_MC_SEED_to_1', () => {
    expect(OPTIMIZER_MC_SEED).toBe(1);
  });

  it('should_flatten_a_bundle_into_a_MonteCarloInput_with_seed_1_and_default_path_count_1000', () => {
    const args = buildArgs();
    const { bundle } = assemble(args);

    const input = mcInputFromBundle(bundle);

    expect(input.seed).toBe(OPTIMIZER_MC_SEED);
    expect(input.seed).toBe(1);
    expect(input.pathCount).toBe(1000);
    expect(input.firstYear).toBe(bundle.todayYear);
    expect(input.retirementYear).toBe(bundle.retirementYear);
    expect(input.horizonYear).toBe(bundle.horizonYear);
  });

  it('should_build_a_per_candidate_input_swapping_only_ssByYear_while_holding_invariant_fields', () => {
    const args = buildArgs({ ssBenefits: [ssBenefit('m1', 3000)] });
    const setup = buildOptimizerMcScenarioSetup(args);

    const at62 = setup.mcInputForCandidate({
      socialSecurity: { primary: { ageYears: 62, ageMonths: 0 } },
    });
    const at70 = setup.mcInputForCandidate({
      socialSecurity: { primary: { ageYears: 70, ageMonths: 0 } },
    });

    expect(at62.seed).toBe(1);
    expect(at70.seed).toBe(1);
    expect(at62.pathCount).toBe(1000);
    expect(at62.portfolioToday).toBe(at70.portfolioToday);
    // The SS claim age changes neither the retirement year nor any expense window, so the per-month base is identical.
    expect(at62.monthlyExpenseBase).toEqual(at70.monthlyExpenseBase);
    const firstNonZero = (arr: number[]): number => arr.find((v) => v > 0) ?? 0;
    expect(firstNonZero(at62.ssByYear)).toBeLessThan(
      firstNonZero(at70.ssByYear),
    );
  });

  it('the candidate survivor overlay reaches the MC ssByYear (deterministic parity)', () => {
    // Primary dies 2034 (life 70, 1964 cohort); the secondary (born 1975) is 61, young enough that the survivor claim age
    // changes the start year and the widow(er) reduction.
    const scenario = baseScenario('s-sv', 'Survivor', {
      lifeExpectancy: { primary: 70, secondary: 95 },
      socialSecurity: {
        primary: { ageYears: 67, ageMonths: 0 },
        secondary: { ageYears: 67, ageMonths: 0 },
        // The candidate overlay carries a different validated survivor age (60) below.
        survivor: { secondary: { ageYears: 62, ageMonths: 0 } },
      },
    });
    const args = buildArgs({
      scenario,
      members: [member('m1', true, 'Alex', 1965), member('m2', false, 'Sam', 1975)],
      ssBenefits: [ssBenefit('m1', 3000), ssBenefit('m2', 800)],
    });
    const setup = buildOptimizerMcScenarioSetup(args);
    const ownAges = {
      primary: { ageYears: 67, ageMonths: 0 },
      secondary: { ageYears: 67, ageMonths: 0 },
    };
    const stored = setup.mcInputForCandidate({ socialSecurity: ownAges });
    const explicitStored = setup.mcInputForCandidate({
      socialSecurity: {
        ...ownAges,
        survivor: { secondary: { ageYears: 62, ageMonths: 0 } },
      },
    });
    expect(stored.ssByYear).toEqual(explicitStored.ssByYear);
    // A clamped or validated survivor age (60) on the candidate must reach MC, not be re-read from the resolved override.
    const clamped = setup.mcInputForCandidate({
      socialSecurity: {
        ...ownAges,
        survivor: { secondary: { ageYears: 60, ageMonths: 0 } },
      },
    });
    expect(clamped.ssByYear).not.toEqual(stored.ssByYear);
  });

  it('medical-cost inflation × windowed expenses: per-category windowed buckets survive mcInputForCandidate (optimizer)', () => {
    const scenario = baseScenario('s-opt-med', 'OptMedical', { inflation: { ratePct: 3 } });
    const expenses: Aggregate<ExpensePayload>[] = [
      {
        id: 'e-med',
        householdId: 'h',
        schemaVersion: 1,
        version: 1,
        updatedAt: '2026-05-01T00:00:00Z',
        deviceId: 'd',
        aggregateType: 'expense',
        payload: {
          name: 'Healthcare',
          categoryId: 'cat-medical',
          amount: 1_000,
          frequency: 'monthly',
          classification: 'essential',
          start: { kind: 'retirementStart' },
          end: { kind: 'lifetime', whose: 'last' },
        },
      },
    ];
    const setup = buildOptimizerMcScenarioSetup(buildArgs({ scenario, expenses }));
    const candidate = setup.mcInputForCandidate(
      { socialSecurity: { primary: { ageYears: 67, ageMonths: 0 } } },
      { successOnly: true },
    );
    expect(candidate.monthlyExpenseBucketsBase).toBeDefined();
    expect(candidate.monthlyExpenseBucketsBase!.map((b) => b.ratePct)).toContain(5);
    expect(candidate.successOnly).toBe(true);
  });
});

describe('MC per-category inflation buckets', () => {
  // hsaQualified defaults to true: medical expenses must be qualified to contribute to HSA demand.
  const expense = (
    id: string,
    categoryId: string,
    amount: number,
    frequency: ExpensePayload['frequency'],
    classification: ExpensePayload['classification'] = 'essential',
    end: ExpensePayload['end'] = { kind: 'lifetime', whose: 'last' },
    hsaQualified: boolean | undefined = undefined,
  ): Aggregate<ExpensePayload> => ({
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'expense',
    payload: {
      name: id,
      categoryId,
      amount,
      frequency,
      classification,
      start: { kind: 'retirementStart' },
      ...(frequency === 'oneOff' ? {} : { end }),
      ...(hsaQualified !== undefined ? { hsaQualified } : {}),
    },
  });

  // Per-step sum of base_b[i] equals monthlyExpenseBase[i] (round2 cents) at every month, and every per-month array has
  // the kernel step count.
  function expectBucketsPinPerStep(input: {
    firstYear: number;
    horizonYear: number;
    monthlyExpenseBase: number[];
    monthlyExpenseBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
  }): void {
    const stepCount = (input.horizonYear - input.firstYear + 1) * 12;
    expect(input.monthlyExpenseBase).toHaveLength(stepCount);
    const buckets = input.monthlyExpenseBucketsBase!;
    for (const b of buckets) expect(b.amount).toHaveLength(stepCount);
    for (let i = 0; i < input.monthlyExpenseBase.length; i += 1) {
      let sum = 0;
      for (const b of buckets) sum += b.amount[i];
      expect(sum).toBeCloseTo(input.monthlyExpenseBase[i], 6);
    }
  }

  // A month well inside an active lifetime window, so a recurring expense's run-rate / 12 base is non-zero.
  const retMonthOffsetOf = (input: { firstYear: number; retirementYear: number }): number =>
    (input.retirementYear - input.firstYear) * 12 + 6;

  it('a Medical expense at the +2pp default emits windowed buckets; Σ_b base[i] === monthlyExpenseBase[i]', () => {
    // baseScenario general rate is 3%; Medical defaults to general + 2 = 5%.
    const scenario = baseScenario('s-med', 'Medical', { inflation: { ratePct: 3 } });
    const expenses = [
      expense('e-med', 'cat-medical', 1_000, 'monthly'),
      expense('e-food', 'cat-food', 2_000, 'monthly'),
    ];
    const input = mcInputFromBundle(assemble(buildArgs({ scenario, expenses })).bundle);
    expect(input.monthlyExpenseBucketsBase).toBeDefined();
    const rates = input.monthlyExpenseBucketsBase!.map((b) => b.ratePct).sort();
    expect(rates).toEqual([3, 5]);
    expectBucketsPinPerStep(input);
  });

  it('v40: interleaved per-category rates — Σ_b base_b[i] equals monthlyExpenseBase[i] per step (cents)', () => {
    // Interleaved categories reorder the per-rate fp-adds against the in-order base sum; the per-step residual adjust must
    // close any gap to the cent.
    const scenario = baseScenario('s-ulp', 'Ulp', {
      inflation: {
        ratePct: 3,
        categoryRates: { 'cat-medical': 5, 'cat-housing': 4, 'cat-food': 6 },
      },
    });
    const expenses = [
      expense('e-med-1', 'cat-medical', 333.33, 'monthly'),
      expense('e-house-1', 'cat-housing', 777.77, 'monthly'),
      expense('e-food-1', 'cat-food', 111.11, 'monthly'),
      expense('e-med-2', 'cat-medical', 555.55, 'monthly'),
      expense('e-house-2', 'cat-housing', 999.99, 'monthly'),
      expense('e-food-2', 'cat-food', 222.22, 'monthly'),
      expense('e-gen-1', 'cat-other', 444.44, 'monthly'),
    ];
    const input = mcInputFromBundle(assemble(buildArgs({ scenario, expenses })).bundle);
    expect(input.monthlyExpenseBucketsBase).toBeDefined();
    expectBucketsPinPerStep(input);
  });

  it('an all-general expense set emits NO buckets (absent → scalar windowed path)', () => {
    const scenario = baseScenario('s-gen', 'General', { inflation: { ratePct: 3 } });
    const expenses = [
      expense('e-food', 'cat-food', 2_000, 'monthly'),
      expense('e-housing', 'cat-housing', 3_000, 'monthly'),
    ];
    const input = mcInputFromBundle(assemble(buildArgs({ scenario, expenses })).bundle);
    expect(input.monthlyExpenseBucketsBase).toBeUndefined();
  });

  it('a Medical override changes the bucket rate (MC consumes categoryRates)', () => {
    const expenses = [expense('e-med', 'cat-medical', 1_000, 'monthly')];
    const overridden = baseScenario('s-cat', 'Override', {
      inflation: { ratePct: 3, categoryRates: { 'cat-medical': 7 } },
    });
    const dflt = baseScenario('s-plain', 'Default', { inflation: { ratePct: 3 } });
    const inOverride = mcInputFromBundle(
      assemble(buildArgs({ scenario: overridden, expenses })).bundle,
    );
    const inDefault = mcInputFromBundle(
      assemble(buildArgs({ scenario: dflt, expenses })).bundle,
    );
    expect(inOverride.monthlyExpenseBase).toEqual(inDefault.monthlyExpenseBase);
    expect(inOverride.monthlyExpenseBucketsBase!.map((b) => b.ratePct)).toEqual([7]);
    expect(inDefault.monthlyExpenseBucketsBase!.map((b) => b.ratePct)).toEqual([5]);
  });

  it('flag follows the engine: a recreated-Medical (NEW id) in medicalCategoryIds gets +2pp; cat-medical omitted gets general', () => {
    // The set carries only the recreated id, not cat-medical, so a stale hard-coded cat-medical path cannot pass.
    const scenario = baseScenario('s-recreated', 'Recreated', {
      inflation: { ratePct: 3 },
    });
    const expenses = [
      expense('e-new-med', 'cat-medical-recreated', 1_000, 'monthly'),
      expense('e-legacy-med', 'cat-medical', 1_000, 'monthly'),
      expense('e-food', 'cat-food', 2_000, 'monthly'),
    ];
    const input = mcInputFromBundle(
      assemble(
        buildArgs({
          scenario,
          expenses,
          medicalCategoryIds: ['cat-medical-recreated'],
        }),
      ).bundle,
    );
    const rates = input.monthlyExpenseBucketsBase!.map((b) => b.ratePct).sort();
    expect(rates).toEqual([3, 5]);
    expectBucketsPinPerStep(input);
  });

  it('a second medical category (two flagged ids) both get +2pp', () => {
    const scenario = baseScenario('s-two-med', 'TwoMed', {
      inflation: { ratePct: 3 },
    });
    const expenses = [
      expense('e-med', 'cat-medical', 1_000, 'monthly'),
      expense('e-dental', 'cat-dental', 1_000, 'monthly'),
      expense('e-food', 'cat-food', 2_000, 'monthly'),
    ];
    const input = mcInputFromBundle(
      assemble(
        buildArgs({
          scenario,
          expenses,
          medicalCategoryIds: ['cat-medical', 'cat-dental'],
        }),
      ).bundle,
    );
    const rates = input.monthlyExpenseBucketsBase!.map((b) => b.ratePct).sort();
    expect(rates).toEqual([3, 5]);
    expectBucketsPinPerStep(input);
  });

  it('single-rate medical demand follows the sole NONZERO bucket, not the first flagged id with zero spend', () => {
    // cat-med-a (first flagged id, 7% override) has no spend; cat-med-b carries the real demand at 3%. Demand must inflate
    // at 3% (the sole nonzero bucket), not 7%, or it can exceed the inflated medical expense.
    const scenario = baseScenario('s-med-zero-first', 'MedZeroFirst', {
      inflation: { ratePct: 3, categoryRates: { 'cat-med-a': 7, 'cat-med-b': 3 } },
    });
    const expenses = [expense('e-med-b', 'cat-med-b', 1_000, 'monthly', 'essential', { kind: 'lifetime', whose: 'last' }, true)];
    const args = buildArgs({
      scenario,
      expenses,
      medicalCategoryIds: ['cat-med-a', 'cat-med-b'],
    });
    const medical = medicalDemandBaseForArgs(args);
    expect(medical.monthlyMedicalDemandBucketsBase).toBeUndefined();
    expect(medical.medicalDemandRatePct).toBe(3);
    const baseSum = (medical.monthlyMedicalDemandBase ?? []).reduce((s, v) => s + v, 0);
    expect(baseSum).toBeGreaterThan(0);
  });

  const medicalDemandBaseForArgs = (args: RunBalanceProjectionArgs) => mcInputFromBundle(assemble(args).bundle);

  it('bucket-composition: a windowed + discretionary-multiplier Medical expense lands the per-month bucket base matching the scalar base', () => {
    const scenario = baseScenario('s-disc', 'Disc', {
      inflation: { ratePct: 3 },
      discretionarySpending: { bumpPct: 50, durationYears: null }, // discMult 1.5
    });
    const expenses = [
      expense('e-med', 'cat-medical', 1_000, 'monthly', 'discretionary', {
        kind: 'year',
        year: 2050,
      }),
    ];
    const input = mcInputFromBundle(assemble(buildArgs({ scenario, expenses })).bundle);
    expect(input.monthlyExpenseBucketsBase).toBeDefined();
    const medBucket = input.monthlyExpenseBucketsBase!.find((b) => b.ratePct === 5)!;
    // 1_000/mo × 1.5 (discretionary bump) = 1_500/mo inside the window.
    expect(medBucket.amount[retMonthOffsetOf(input)]).toBeCloseTo(1_500, 4);
    // The window ends in 2050 (exclusive), so the base is 0 in 2051.
    const afterWindow = (2051 - input.firstYear) * 12 + 6;
    expect(afterWindow).toBeLessThan(input.monthlyExpenseBase.length);
    expect(medBucket.amount[afterWindow]).toBe(0);
    expectBucketsPinPerStep(input);
  });

  it('a Medical one-off lands its FULL literal amount in the spike month (v40 windowed)', () => {
    const scenario = baseScenario('s-oneoff', 'OneOff', { inflation: { ratePct: 3 } });
    const expenses = [
      expense('e-med-rec', 'cat-medical', 1_000, 'monthly'),
      expense('e-med-once', 'cat-medical', 50_000, 'oneOff'),
    ];
    const input = mcInputFromBundle(assemble(buildArgs({ scenario, expenses })).bundle);
    const medBucket = input.monthlyExpenseBucketsBase!.find((b) => b.ratePct === 5)!;
    // The one-off spikes in the retirement month: 50_000 plus the recurring 1_000/mo = 51_000.
    const spikeMonth = (input.retirementYear - input.firstYear) * 12;
    expect(medBucket.amount[spikeMonth]).toBeCloseTo(51_000, 4);
    expect(medBucket.amount[retMonthOffsetOf(input)]).toBeCloseTo(1_000, 4);
  });

  it('split inflation override (parent ratePct, child categoryRates only) — bundle baseline + bucket rates measure against the per-FIELD general', () => {
    // Whole-section merge keeps the child's inflation section and drops the parent's ratePct, but the per-field
    // resolveInflationForScenario inherits it; the bundle baseline must come from the per-field resolver.
    const parent: ScenarioAggregate = {
      ...baseScenario('s-parent', 'Parent'),
      payload: {
        ...baseScenario('s-parent', 'Parent').payload,
        isPrimary: true,
        parentScenarioId: null,
        overrides: {
          ...baseScenario('s-parent', 'Parent').payload.overrides,
          inflation: { ratePct: 4 },
        },
      },
    };
    const child: ScenarioAggregate = {
      ...baseScenario('s-child', 'Child'),
      payload: {
        ...baseScenario('s-child', 'Child').payload,
        isPrimary: false,
        parentScenarioId: 's-parent',
        // A partial inflation section (no ratePct) is reachable from a corrupt imported bundle, so the cast models it.
        overrides: {
          inflation: { categoryRates: { 'cat-medical': 9 } },
        } as unknown as ScenarioAggregate['payload']['overrides'],
      },
    };
    const scenarios = [child, parent];
    const args: RunBalanceProjectionArgs = {
      scenarioId: 's-child',
      scenarios,
      accounts: [brokerage('a1', 'm1')],
      balances: [balanceRow('a1', 2025, 800_000)],
      members: [member('m1', true, 'Alex', 1965)],
      ssBenefits: [ssBenefit('m1', 2500)],
      expenses: [
        expense('e-med', 'cat-medical', 1_000, 'monthly'),
        expense('e-food', 'cat-food', 2_000, 'monthly'),
      ],
      incomeStreams: [],
      todayYear: TODAY_YEAR,
      todayMonthIndex: TODAY_MONTH_INDEX,
    };
    const { bundle } = assemble(args);
    const perField = resolveInflationForScenario('s-child', scenarios);
    expect(perField.ratePct).toBe(4);
    expect(bundle.scenarioInflationPct).toBe(perField.ratePct);
    const rates = bundle.monthlyExpenseBucketsBase!.map((b) => b.ratePct).sort((a, b) => a - b);
    expect(rates).toEqual([4, 9]);
  });
});

describe('MC windowed expense schedule', () => {
  const windowedExpense = (
    id: string,
    amount: number,
    frequency: ExpensePayload['frequency'],
    start: ExpensePayload['start'],
    end?: ExpensePayload['end'],
  ): Aggregate<ExpensePayload> => ({
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'expense',
    payload: {
      name: id,
      categoryId: 'cat-other',
      amount,
      frequency,
      classification: 'essential',
      start,
      ...(frequency === 'oneOff' ? {} : { end: end ?? { kind: 'lifetime', whose: 'last' } }),
    },
  });

  it('charges a time-limited LTC window EXACTLY 0 outside it and positive inside (anchored months)', () => {
    // LTC at the primary's ages 85-90 (born 1965 → 2050-2055).
    const scenario = baseScenario('s-ltc', 'LTC', { inflation: { ratePct: 3 } });
    const ltc = windowedExpense(
      'e-ltc',
      10_000,
      'monthly',
      { kind: 'age', memberId: 'primary', years: 85, months: 0 },
      { kind: 'age', memberId: 'primary', years: 90, months: 0 },
    );
    const input = mcInputFromBundle(assemble(buildArgs({ scenario, expenses: [ltc] })).bundle);
    const fy = input.firstYear;
    const base = input.monthlyExpenseBase;
    const beforeMonth = (2049 - fy) * 12 + 6;
    expect(base[beforeMonth]).toBe(0);
    const insideMonth = (2052 - fy) * 12 + 6;
    expect(base[insideMonth]).toBeCloseTo(10_000, 4);
    const afterMonth = (2055 - fy) * 12 + 6;
    if (afterMonth < base.length) expect(base[afterMonth]).toBe(0);
  });

  it('a pre-retirement-only expense charges $0 in every retirement-phase month', () => {
    // Active 2026 to the primary's age 65 (2030), ending before the age-67 retirement.
    const scenario = baseScenario('s-pre', 'PreRet', { inflation: { ratePct: 3 } });
    const preRet = windowedExpense(
      'e-pre',
      5_000,
      'monthly',
      { kind: 'year', year: 2026 },
      { kind: 'age', memberId: 'primary', years: 65, months: 0 },
    );
    const input = mcInputFromBundle(assemble(buildArgs({ scenario, expenses: [preRet] })).bundle);
    const retStep = (input.retirementYear - input.firstYear) * 12;
    for (let i = retStep; i < input.monthlyExpenseBase.length; i += 1) {
      expect(input.monthlyExpenseBase[i]).toBe(0);
    }
  });

  it('a single-month one-off lands its FULL literal amount in exactly one month; the year roll-up ties to projectExpensesByYear', () => {
    const scenario = baseScenario('s-oneoff-win', 'OneOffWin', { inflation: { ratePct: 3 } });
    const oneOff = windowedExpense('e-windfall', 40_000, 'oneOff', { kind: 'year', year: 2055 });
    const args = buildArgs({ scenario, expenses: [oneOff] });
    const input = mcInputFromBundle(assemble(args).bundle);
    const fy = input.firstYear;
    const spikeMonth = (2055 - fy) * 12; // year-anchored → January.
    expect(input.monthlyExpenseBase[spikeMonth]).toBeCloseTo(40_000, 4);
    const nonZero = input.monthlyExpenseBase.filter((v) => v !== 0).length;
    expect(nonZero).toBe(1);
    const yearSum = (() => {
      let s = 0;
      for (let m = (2055 - fy) * 12; m < (2056 - fy) * 12 && m < input.monthlyExpenseBase.length; m += 1) {
        s += input.monthlyExpenseBase[m];
      }
      return s;
    })();
    const byYear = projectByYearTotalBase(args, 2055);
    expect(yearSum).toBeCloseTo(byYear, 2);
  });

  it('base parity: Σ_{months∈year} monthlyExpenseBase[i] === projectExpensesByYear(...).totalBase (today\'s dollars)', () => {
    const scenario = baseScenario('s-parity', 'Parity', { inflation: { ratePct: 3 } });
    const expenses = [
      windowedExpense('e-living', 4_000, 'monthly', { kind: 'retirementStart' }),
      windowedExpense(
        'e-ltc',
        8_000,
        'monthly',
        { kind: 'age', memberId: 'primary', years: 85, months: 0 },
        { kind: 'age', memberId: 'primary', years: 90, months: 0 },
      ),
      windowedExpense('e-windfall', 25_000, 'oneOff', { kind: 'year', year: 2052 }),
    ];
    const args = buildArgs({ scenario, expenses });
    const input = mcInputFromBundle(assemble(args).bundle);
    const fy = input.firstYear;
    for (let year = input.retirementYear; year <= input.horizonYear; year += 1) {
      let mcYearSum = 0;
      for (let m = (year - fy) * 12; m < (year - fy + 1) * 12 && m < input.monthlyExpenseBase.length; m += 1) {
        mcYearSum += input.monthlyExpenseBase[m];
      }
      expect(mcYearSum).toBeCloseTo(projectByYearTotalBase(args, year), 1);
    }
  });

  it('a zero-expense scenario produces an all-zero base (valid, not an error)', () => {
    const scenario = baseScenario('s-zero', 'Zero', { inflation: { ratePct: 3 } });
    const input = mcInputFromBundle(assemble(buildArgs({ scenario, expenses: [] })).bundle);
    expect(input.monthlyExpenseBase.every((v) => v === 0)).toBe(true);
    expect(input.monthlyExpenseBase).toHaveLength(
      (input.horizonYear - input.firstYear + 1) * 12,
    );
  });

  function projectByYearTotalBase(args: RunBalanceProjectionArgs, year: number): number {
    const ctx = buildCtx(args);
    const resolved = resolveExpensesForScenario(args.scenarioId, [...args.scenarios], [
      ...args.expenses,
    ]);
    const baseCtx = {
      ...buildExpenseProjectionContext({
        resolved: {
          discretionarySpending: ctx.resolvedScenario.discretionarySpending,
          lifeExpectancy: ctx.resolvedScenario.lifeExpectancy,
        },
        primary: { birthdate: ctx.primary.payload.birthdate },
        secondary: ctx.secondary ? { birthdate: ctx.secondary.payload.birthdate } : null,
        primaryRetirementIso: ctx.primaryRetIso,
      }),
      todayYear: args.todayYear,
      todayMonthIndex: args.todayMonthIndex,
      retirementMonth0: ctx.primaryRetirementMonth0,
    };
    const rows = projectExpensesByYear(resolved, baseCtx, { from: year, to: year });
    return rows[0]?.totalBase ?? 0;
  }
});

describe('HSA medical-demand survives the production MC bundle seam', () => {
  // These route through the full production seam (assembleMcBundle → assembleMcBundleResult); a dropped medical-demand
  // field would read as zero demand in MC. hsaQualified: true is set because an unqualified medical expense adds none.
  const medExpense = (
    id: string,
    categoryId: string,
    amount: number,
    hsaQualified = true,
  ): Aggregate<ExpensePayload> => ({
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'expense',
    payload: {
      name: id,
      categoryId,
      amount,
      frequency: 'monthly',
      classification: 'essential',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
      ...(hsaQualified ? { hsaQualified: true } : {}),
    },
  });

  it('forwards monthlyMedicalDemandBase + medicalDemandRatePct from the bundle to MonteCarloInput', () => {
    // An HSA account plus an isMedical category: the default +2pp rate (general 3% → 5%) is the effective medical rate.
    const scenario = baseScenario('s-med-seam', 'MedSeam', { inflation: { ratePct: 3 } });
    const args = buildArgs({
      scenario,
      accounts: [
        brokerage('a1', 'm1', 'RETIREMENT_IRA', 'PRE_TAX'),
        brokerage('hsa1', 'm1', 'HSA', 'HSA'),
      ],
      balances: [balanceRow('a1', 2025, 800_000), balanceRow('hsa1', 2025, 80_000)],
      expenses: [medExpense('e-med', 'cat-medical', 1_000), medExpense('e-food', 'cat-food', 2_000)],
      medicalCategoryIds: ['cat-medical'],
    });

    const { bundle } = assemble(args);
    const input = mcInputFromBundle(bundle);

    expect(bundle.monthlyMedicalDemandBase).toBeDefined();
    expect(input.monthlyMedicalDemandBase).toBe(bundle.monthlyMedicalDemandBase);
    expect(input.monthlyMedicalDemandBase!.some((v) => v > 0)).toBe(true);
    expect(bundle.medicalDemandRatePct).toBe(5);
    expect(input.medicalDemandRatePct).toBe(5);
    for (let i = 0; i < input.monthlyMedicalDemandBase!.length; i += 1) {
      expect(input.monthlyMedicalDemandBase![i]).toBeLessThanOrEqual(
        input.monthlyExpenseBase[i] + 1e-6,
      );
    }
  });

  it('forwards the per-rate medical-demand buckets when the medical set spans > 1 rate', () => {
    const scenario = baseScenario('s-med-buckets', 'MedBuckets', {
      inflation: { ratePct: 3, categoryRates: { 'cat-medical': 5, 'cat-dental': 7 } },
    });
    const args = buildArgs({
      scenario,
      accounts: [
        brokerage('a1', 'm1', 'RETIREMENT_IRA', 'PRE_TAX'),
        brokerage('hsa1', 'm1', 'HSA', 'HSA'),
      ],
      balances: [balanceRow('a1', 2025, 800_000), balanceRow('hsa1', 2025, 80_000)],
      expenses: [medExpense('e-med', 'cat-medical', 1_000), medExpense('e-dental', 'cat-dental', 500)],
      medicalCategoryIds: ['cat-medical', 'cat-dental'],
    });

    const { bundle } = assemble(args);
    const input = mcInputFromBundle(bundle);

    expect(bundle.monthlyMedicalDemandBucketsBase).toBeDefined();
    expect(input.monthlyMedicalDemandBucketsBase).toBe(bundle.monthlyMedicalDemandBucketsBase);
    const rates = input.monthlyMedicalDemandBucketsBase!.map((b) => b.ratePct).sort((a, b) => a - b);
    expect(rates).toEqual([5, 7]);
  });

  it('omits the medical-demand fields when NO category is isMedical (no HSA reserve)', () => {
    const scenario = baseScenario('s-no-med', 'NoMed', { inflation: { ratePct: 3 } });
    const args = buildArgs({
      scenario,
      expenses: [medExpense('e-food', 'cat-food', 2_000)],
      // An explicit empty set means no medical categories; absent would fall back to the legacy cat-medical.
      medicalCategoryIds: [],
    });
    const input = mcInputFromBundle(assemble(args).bundle);
    expect(input.monthlyMedicalDemandBase).toBeUndefined();
    expect(input.medicalDemandRatePct).toBeUndefined();
    expect(input.monthlyMedicalDemandBucketsBase).toBeUndefined();
  });
});

describe('buildMcTaxContext', () => {
  it('should_return_a_populated_context_for_a_default_strategy_scenario', () => {
    const args = buildArgs();
    const ctx = buildCtx(args);

    const taxCtx = buildMcTaxContext(ctx);

    expect(taxCtx).toBeDefined();
  });

  it('should_return_a_populated_context_for_a_named_strategy_scenario', () => {
    const scenario = baseScenario('s-tax', 'TaxEfficient', {
      withdrawalStrategy: { kind: 'taxEfficient' },
    });
    const args = buildArgs({ scenario });
    const ctx = buildCtx(args);

    const taxCtx = buildMcTaxContext(ctx);

    expect(taxCtx).toBeDefined();
    expect(taxCtx!.householdSize).toBe(1);
    expect(taxCtx!.members.length).toBe(1);
    expect(taxCtx!.members[0].memberId).toBe('m1');
    expect(taxCtx!.taxBundle).toBeDefined();
  });

  it('should_set_mcRothPenaltyAllExempt_true_when_all_ROTH_401K_accounts_are_exempt', () => {
    // ROTH_401K is penalty-eligible (10%), so it counts toward mcRothPenaltyAllExempt.
    const scenario = baseScenario('s-r401k', 'TaxEfficient', {
      withdrawalStrategy: { kind: 'taxEfficient' },
      earlyWithdrawalPenaltyExemptAccountIds: ['roth401k-1'],
    });
    const roth401k = brokerage('roth401k-1', 'm1', 'RETIREMENT_ROTH_401K', 'ROTH');
    const args = buildArgs({
      scenario,
      accounts: [brokerage('a1', 'm1'), roth401k],
      balances: [balanceRow('a1', 2025, 800_000), balanceRow('roth401k-1', 2025, 50_000)],
    });
    const ctx = buildCtx(args);
    const taxCtx = buildMcTaxContext(ctx);

    expect(taxCtx).toBeDefined();
    expect(taxCtx!.mcRothPenaltyAllExempt).toBe(true);
  });

  it('should_treat_an_all_ROTH_457B_household_as_source_exempt', () => {
    // A governmental 457(b) has no §72(t) penalty by statute, so a household whose only §408A-ordered Roth source is
    // ROTH_457B is source-exempt with no scenario exemption marked.
    const scenario = baseScenario('s-r457b', 'TaxEfficient', {
      withdrawalStrategy: { kind: 'taxEfficient' },
    });
    const roth457b = brokerage('roth457b-1', 'm1', 'RETIREMENT_ROTH_457B', 'ROTH');
    const args = buildArgs({
      scenario,
      accounts: [brokerage('a1', 'm1'), roth457b],
      balances: [balanceRow('a1', 2025, 800_000), balanceRow('roth457b-1', 2025, 50_000)],
    });
    const ctx = buildCtx(args);
    const taxCtx = buildMcTaxContext(ctx);

    expect(taxCtx).toBeDefined();
    expect(taxCtx!.mcRothPenaltyAllExempt).toBe(true);
  });

  it('should_NOT_waive_the_Roth_leg_when_a_457B_pools_with_a_penalized_ROTH_401K', () => {
    // Pooled all-or-nothing stays conservative: a penalty-eligible ROTH_401K beside a 457(b) keeps the pooled leg armed.
    const scenario = baseScenario('s-mixed-roth', 'TaxEfficient', {
      withdrawalStrategy: { kind: 'taxEfficient' },
    });
    const roth457b = brokerage('roth457b-1', 'm1', 'RETIREMENT_ROTH_457B', 'ROTH');
    const roth401k = brokerage('roth401k-1', 'm1', 'RETIREMENT_ROTH_401K', 'ROTH');
    const args = buildArgs({
      scenario,
      accounts: [roth457b, roth401k],
      balances: [
        balanceRow('roth457b-1', 2025, 50_000),
        balanceRow('roth401k-1', 2025, 50_000),
      ],
    });
    const ctx = buildCtx(args);
    const taxCtx = buildMcTaxContext(ctx);

    expect(taxCtx).toBeDefined();
    expect(taxCtx!.mcRothPenaltyAllExempt).toBeFalsy();
  });

  it('should_treat_an_all_457B_pretax_household_as_source_exempt_for_the_72t_leg', () => {
    // A 457(b) pre-tax distribution carries no §72(t) 10%, so a household whose only pre-tax source is a 457(b) waives the
    // pooled pre-tax leg; a POST_TAX brokerage never feeds that bucket.
    const scenario = baseScenario('s-457b-pre', 'TaxEfficient', {
      withdrawalStrategy: { kind: 'taxEfficient' },
    });
    const pre457b = brokerage('457b-1', 'm1', 'RETIREMENT_457B', 'PRE_TAX');
    const args = buildArgs({
      scenario,
      accounts: [pre457b, brokerage('a1', 'm1')],
      balances: [balanceRow('457b-1', 2025, 400_000), balanceRow('a1', 2025, 100_000)],
    });
    const ctx = buildCtx(args);
    const taxCtx = buildMcTaxContext(ctx);

    expect(taxCtx).toBeDefined();
    expect(taxCtx!.mcPreTaxPenaltyAllExempt).toBe(true);
  });

  it('should_NOT_waive_the_72t_leg_when_a_457B_pools_with_a_penalized_IRA', () => {
    const scenario = baseScenario('s-457b-ira', 'TaxEfficient', {
      withdrawalStrategy: { kind: 'taxEfficient' },
    });
    const pre457b = brokerage('457b-1', 'm1', 'RETIREMENT_457B', 'PRE_TAX');
    const ira = brokerage('ira-1', 'm1', 'RETIREMENT_IRA', 'PRE_TAX');
    const args = buildArgs({
      scenario,
      accounts: [pre457b, ira],
      balances: [balanceRow('457b-1', 2025, 400_000), balanceRow('ira-1', 2025, 100_000)],
    });
    const ctx = buildCtx(args);
    const taxCtx = buildMcTaxContext(ctx);

    expect(taxCtx).toBeDefined();
    expect(taxCtx!.mcPreTaxPenaltyAllExempt).toBeFalsy();
  });

  it('should_waive_the_Roth_leg_for_a_MIXED_457B_Roth_designated_post_bucket', () => {
    // A MIXED governmental 457(b)'s Roth-designated post bucket is statutorily penalty-free, like the pure ROTH_457B.
    const scenario = baseScenario('s-mixed-457b', 'TaxEfficient', {
      withdrawalStrategy: { kind: 'taxEfficient' },
    });
    const mixed457b = brokerage('m457b-1', 'm1', 'RETIREMENT_457B', 'MIXED');
    const args = buildArgs({
      scenario,
      accounts: [mixed457b, brokerage('a1', 'm1')],
      balances: [balanceRow('m457b-1', 2025, 300_000), balanceRow('a1', 2025, 100_000)],
    });
    const ctx = buildCtx(args);
    const taxCtx = buildMcTaxContext(ctx);

    expect(taxCtx).toBeDefined();
    expect(taxCtx!.mcRothPenaltyAllExempt).toBe(true);
    expect(taxCtx!.mcPreTaxPenaltyAllExempt).toBe(true);
  });
});

describe('computeMedicalDemandBase — hsaQualified filter', () => {
  const expHsa = (
    id: string,
    categoryId: string,
    amount: number,
    hsaQualified?: boolean,
  ): Aggregate<ExpensePayload> => ({
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'expense',
    payload: {
      name: id,
      categoryId,
      amount,
      frequency: 'monthly',
      classification: 'essential',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
      ...(hsaQualified !== undefined ? { hsaQualified } : {}),
    },
  });

  function demandFor(expenses: Aggregate<ExpensePayload>[]) {
    return mcInputFromBundle(assemble(buildArgs({ expenses, medicalCategoryIds: ['cat-medical'] })).bundle);
  }

  function totalDemand(result: ReturnType<typeof demandFor>): number {
    if (!result.monthlyMedicalDemandBase) return 0;
    return result.monthlyMedicalDemandBase.reduce((a, b) => a + b, 0);
  }

  it('includes ONLY hsaQualified === true medical rows in demand', () => {
    const qualified = expHsa('e-qual', 'cat-medical', 500, true);
    const notQual = expHsa('e-nq', 'cat-medical', 800, false);
    const result = demandFor([qualified, notQual]);
    expect(result.monthlyMedicalDemandBase).toBeDefined();
    const total = totalDemand(result);
    expect(total).toBeGreaterThan(0);
    const bothResult = demandFor([
      expHsa('e-qual', 'cat-medical', 500, true),
      expHsa('e-q2', 'cat-medical', 800, true),
    ]);
    expect(totalDemand(bothResult)).toBeGreaterThan(total);
  });

  it('absent hsaQualified (legacy row) produces zero demand (absent ⇒ not qualified)', () => {
    const legacy = expHsa('e-legacy', 'cat-medical', 600); // absent
    const result = demandFor([legacy]);
    expect(result.monthlyMedicalDemandBase).toBeUndefined();
    expect(totalDemand(result)).toBe(0);
  });

  it('returns {} (no demand fields) when all medical rows are not-qualified', () => {
    const nq1 = expHsa('e-nq1', 'cat-medical', 400, false);
    const nq2 = expHsa('e-nq2', 'cat-medical', 600, false);
    const result = demandFor([nq1, nq2]);
    expect(result.monthlyMedicalDemandBase).toBeUndefined();
    expect(result.medicalDemandRatePct).toBeUndefined();
  });

  it('ignores the flag on non-medical rows (flag is inert for non-medical)', () => {
    const nonMed = expHsa('e-housing', 'cat-housing', 1_000, true);
    const result = demandFor([nonMed]);
    expect(totalDemand(result)).toBe(0);
  });

  it('MC bucket case: two medical categories at different inflation rates — qualified subset drives rate; non-qualified excluded', () => {
    const scenario = baseScenario('s-rate', 'TwoMedRate', {
      inflation: { ratePct: 3, categoryRates: { 'cat-medical': 5, 'cat-med2': 3 } },
    });
    const args = buildArgs({
      expenses: [
        expHsa('e-qual-a', 'cat-medical', 400, true),
        expHsa('e-nq-b', 'cat-med2', 600, false),
      ],
      scenario,
      medicalCategoryIds: ['cat-medical', 'cat-med2'],
    });
    const result = mcInputFromBundle(assemble(args).bundle);
    expect(result.monthlyMedicalDemandBase).toBeDefined();
    expect(result.medicalDemandRatePct).toBeCloseTo(5, 4);
    const demandTotal = totalDemand(result);
    expect(demandTotal).toBeGreaterThan(0);
  });
});

describe('downturn-guardrail runner assembly — guaranteed-income filter', () => {
  const GUARDRAIL_ON = {
    enabled: true,
    lowerBandPct: 85,
    upperBandPct: 115,
    stepPct: 10,
    maxRaisePct: 120,
  };

  const livingExpense = (): Aggregate<ExpensePayload> => ({
    id: 'e-living',
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'expense',
    payload: {
      name: 'Living',
      categoryId: 'cat-other',
      amount: 6_000,
      frequency: 'monthly',
      classification: 'essential',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    },
  });

  const income = (
    id: string,
    payload: Partial<IncomeStreamPayload> & { kind: IncomeStreamKind },
  ): Aggregate<IncomeStreamPayload> => ({
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'incomeStream',
    payload: { name: id, memberId: 'm1', ...payload } as IncomeStreamPayload,
  });

  const annuityPension = (): Aggregate<IncomeStreamPayload> =>
    income('inc-annuity', {
      kind: 'pension',
      payoutType: 'annuity',
      monthlyBenefit: 1_500,
      colaPct: 0,
      jointAndSurvivorPct: 0,
      start: { kind: 'retirementStart' },
    });
  const partTimeGig = (): Aggregate<IncomeStreamPayload> =>
    income('inc-parttime', {
      kind: 'partTime',
      annualAmount: 30_000,
      colaPct: 0,
      start: { kind: 'retirementStart' },
      end: { kind: 'age', memberId: 'primary', years: 75, months: 0 },
    });
  const oneOffWindfall = (): Aggregate<IncomeStreamPayload> =>
    income('inc-oneoff', {
      kind: 'oneOff',
      oneOffAmount: 100_000,
      targetAccountId: 'a1',
      start: { kind: 'year', year: 2035 },
    });

  function netNeedForStreams(
    incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>,
  ): number[] {
    const scenario = baseScenario('s-guardrail', 'Guardrail', {
      inflation: { ratePct: 0 },
      downturnGuardrails: GUARDRAIL_ON,
    });
    const input = mcInputFromBundle(
      assemble(
        buildArgs({ scenario, expenses: [livingExpense()], incomeStreams }),
      ).bundle,
    );
    const netNeed = input.guardrailBaselineRealNetNeedByYear;
    expect(netNeed).toBeDefined();
    return netNeed!;
  }

  it('nets ONLY SS + lifetime annuity pension — part-time + one-off do NOT reduce the net-need baseline', () => {
    const guaranteedOnly = netNeedForStreams([annuityPension()]);
    const withNonGuaranteed = netNeedForStreams([
      annuityPension(),
      partTimeGig(),
      oneOffWindfall(),
    ]);
    expect(withNonGuaranteed.length).toBe(guaranteedOnly.length);
    expect(withNonGuaranteed.length).toBeGreaterThan(0);
    for (let y = 0; y < guaranteedOnly.length; y += 1) {
      expect(withNonGuaranteed[y]).toBeCloseTo(guaranteedOnly[y], 4);
    }
  });

  it('the annuity pension DOES net down the baseline (proves the guaranteed leg is applied, not a no-op filter)', () => {
    const ssOnly = netNeedForStreams([]);
    const withAnnuity = netNeedForStreams([annuityPension()]);
    expect(withAnnuity.length).toBe(ssOnly.length);
    // $1,500/mo = $18,000/yr guaranteed: net need drops by that in every year the annuity is active (0% inflation).
    let anyLower = false;
    for (let y = 0; y < ssOnly.length; y += 1) {
      expect(withAnnuity[y]).toBeLessThanOrEqual(ssOnly[y] + 1e-6);
      if (withAnnuity[y] < ssOnly[y] - 1) anyLower = true;
    }
    expect(anyLower).toBe(true);
  });

  it('a disabled/unset guardrail scenario omits every guardrail field from MonteCarloInput (byte-identical cache key)', () => {
    const scenario = baseScenario('s-no-guardrail', 'NoGuardrail', {
      inflation: { ratePct: 0 },
    });
    const input = mcInputFromBundle(
      assemble(
        buildArgs({
          scenario,
          expenses: [livingExpense()],
          incomeStreams: [annuityPension(), partTimeGig()],
        }),
      ).bundle,
    );
    expect(input.downturnGuardrails).toBeUndefined();
    expect(input.guardrailBaselineRealNetNeedByYear).toBeUndefined();
    expect(input.guardrailBaselineTotalRealByYear).toBeUndefined();
    expect(input.guardrailEssentialRealByYear).toBeUndefined();
    expect(input.guardrailEffectiveTaxRate).toBeUndefined();
    const keys = Object.keys(input).filter(
      (k) => k === 'downturnGuardrails' || k.startsWith('guardrail'),
    );
    expect(keys).toEqual([]);
  });
});

describe('downturn-guardrail runner assembly — baseline-series correctness', () => {
  const GUARDRAIL_ON = {
    enabled: true,
    lowerBandPct: 85,
    upperBandPct: 115,
    stepPct: 10,
    maxRaisePct: 120,
  };

  const essentialExpense = (categoryId: string): Aggregate<ExpensePayload> => ({
    id: 'e-essential',
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'expense',
    payload: {
      name: 'Essential',
      categoryId,
      amount: 5_000,
      frequency: 'monthly',
      classification: 'essential',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    },
  });

  it('already-retired household (retirementYear < todayYear) anchors the baseline at TODAY (no zero-pad / N-year shift)', () => {
    // Born 1950 retired in 2017, nine years before 2026. The kernel clamps retirementStepIdx to 0, so drawdown year 0 is today
    // and the baseline series anchors at max(retirementYear, todayYear) with no zero-padding.
    const retiree = member('m1', true, 'Alex', 1950);
    const scenario = baseScenario('s-retired', 'AlreadyRetired', {
      inflation: { ratePct: 0 },
      downturnGuardrails: GUARDRAIL_ON,
    });
    const input = mcInputFromBundle(
      assemble(
        buildArgs({
          scenario,
          members: [retiree],
          expenses: [essentialExpense('cat-other')],
        }),
      ).bundle,
    );
    expect(input.retirementYear).toBeLessThan(input.firstYear);
    const horizonYears = input.horizonYear - input.firstYear + 1;
    const essential = input.guardrailEssentialRealByYear;
    const total = input.guardrailBaselineTotalRealByYear;
    const netNeed = input.guardrailBaselineRealNetNeedByYear;
    expect(essential).toBeDefined();
    expect(total).toBeDefined();
    expect(netNeed).toBeDefined();
    expect(essential!.length).toBe(horizonYears);
    expect(total!.length).toBe(horizonYears);
    expect(netNeed!.length).toBe(horizonYears);
    expect(essential![0]).toBeGreaterThan(0);
    expect(total![0]).toBeGreaterThan(0);
    expect(essential!.every((v) => v > 0)).toBe(true);
  });

  function essentialRealSeries(categoryRates?: Record<string, number>): number[] {
    const scenario = baseScenario('s-medical', 'Medical', {
      inflation: categoryRates ? { ratePct: 0, categoryRates } : { ratePct: 0 },
      downturnGuardrails: GUARDRAIL_ON,
    });
    const input = mcInputFromBundle(
      assemble(
        buildArgs({ scenario, expenses: [essentialExpense('cat-other')] }),
      ).bundle,
    );
    const essential = input.guardrailEssentialRealByYear;
    expect(essential).toBeDefined();
    return essential!;
  }

  it('a higher-rate category grows the baseline REAL series (matches the kernel per-bucket growth)', () => {
    const flat = essentialRealSeries(); // cat-other at general (0) → flat real
    const diff = essentialRealSeries({ 'cat-other': 3 }); // +3pp real differential
    const n = flat.length;
    expect(n).toBeGreaterThan(5);
    expect(diff.length).toBe(n);
    expect(Math.abs(flat[n - 1] - flat[0])).toBeLessThan(1);
    expect(diff[n - 1]).toBeGreaterThan(diff[0] * 1.2);
    expect(diff[0]).toBeGreaterThan(flat[0]);
    // Real growth under flat CPI matches the kernel's monthly spread, (1 + 3/1200)^12 per year, not the naive (1 + 3/100).
    const expectedYoY = Math.pow(1 + 3 / 1200, 12); // ≈ 1.030416
    expect(diff[1] / diff[0]).toBeCloseTo(expectedYoY, 4);
    expect(diff[2] / diff[1]).toBeCloseTo(expectedYoY, 4);
  });
});

describe('guardrail live-advisory override bypass', () => {
  const guardrailExpense: Aggregate<ExpensePayload> = {
    id: 'e-guard',
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'expense',
    payload: {
      name: 'Living',
      categoryId: 'cat-other',
      amount: 4_000,
      frequency: 'monthly',
      classification: 'essential',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    },
  };

  const OVERRIDE_ON = { ...DEFAULT_GUARDRAIL_CONFIG, enabled: true };

  function assembleWithOverride(
    args: RunBalanceProjectionArgs,
    guardrailOverrideConfig?: typeof OVERRIDE_ON,
  ) {
    const ctx = buildCtx(args);
    const cashflowSeries = buildCashflowSeries(args, ctx);
    return assembleMcBundle({ runArgs: args, ctx, cashflowSeries, guardrailOverrideConfig });
  }

  it('should_omit_the_guardrail_block_when_no_override_and_scenario_disabled', () => {
    const scenario = baseScenario('s-off', 'Off', {
      downturnGuardrails: {
        enabled: false,
        lowerBandPct: 85,
        upperBandPct: 115,
        stepPct: 10,
        maxRaisePct: 100,
      },
    });
    const bundle = assembleWithOverride(buildArgs({ scenario, expenses: [guardrailExpense] }));
    expect(bundle.downturnGuardrails).toBeUndefined();
  });

  it('should_populate_the_baseline_series_when_an_override_is_passed_on_a_no_config_scenario', () => {
    const bundle = assembleWithOverride(
      buildArgs({ expenses: [guardrailExpense] }),
      OVERRIDE_ON,
    );
    expect(bundle.downturnGuardrails).toBeDefined();
    expect(bundle.downturnGuardrails!.config.enabled).toBe(true);
    expect(bundle.downturnGuardrails!.baselineNetNeedRealByYear.length).toBeGreaterThan(0);
    expect(bundle.downturnGuardrails!.essentialRealByYear.length).toBeGreaterThan(0);
    expect(bundle.downturnGuardrails!.baselineTotalRealByYear.length).toBeGreaterThan(0);
  });

  it('should_leave_runBalanceProjectionMc_byte_identical_when_no_opts_are_passed', () => {
    const args = buildArgs({ expenses: [guardrailExpense] });
    const withoutOpts = runBalanceProjectionMc(args);
    const withEmptyOpts = runBalanceProjectionMc(args, {});
    expect(withEmptyOpts).toEqual(withoutOpts);
    expect(withoutOpts.guardrailBaselineRealNetNeedByYear).toBeUndefined();
  });

  it('should_populate_runBalanceProjectionMc_flat_fields_when_an_override_is_passed_on_a_disabled_scenario', () => {
    const scenario = baseScenario('s-off2', 'Off', {
      downturnGuardrails: {
        enabled: false,
        lowerBandPct: 85,
        upperBandPct: 115,
        stepPct: 10,
        maxRaisePct: 100,
      },
    });
    const args = buildArgs({ scenario, expenses: [guardrailExpense] });
    const input = runBalanceProjectionMc(args, { guardrailOverrideConfig: OVERRIDE_ON });
    expect(input.downturnGuardrails?.enabled).toBe(true);
    expect(input.guardrailBaselineRealNetNeedByYear).toBeDefined();
    expect(input.guardrailEffectiveTaxRate).toBeDefined();
  });

  it('should_populate_buildMonteCarloInputForScenario_flat_fields_only_with_the_override', () => {
    const scenario = baseScenario('s-live', 'Live');
    const args = buildArgs({ scenario, expenses: [guardrailExpense] });
    const inputs = {
      members: [...args.members],
      accounts: [...args.accounts],
      balances: [...args.balances],
      expenses: [...args.expenses],
      incomeStreams: [...args.incomeStreams],
      ssBenefits: [...args.ssBenefits],
    };
    const base = {
      scenarioId: scenario.id,
      scenarios: [scenario],
      inputs,
      todayYear: TODAY_YEAR,
      todayMonthIndex: TODAY_MONTH_INDEX,
    };
    const plain = buildMonteCarloInputForScenario(base);
    expect(plain).not.toBeNull();
    expect(plain!.guardrailBaselineRealNetNeedByYear).toBeUndefined();

    const withOverride = buildMonteCarloInputForScenario({
      ...base,
      guardrailOverrideConfig: OVERRIDE_ON,
    });
    expect(withOverride).not.toBeNull();
    expect(withOverride!.guardrailBaselineRealNetNeedByYear).toBeDefined();
    expect(withOverride!.guardrailEffectiveTaxRate).toBeDefined();
  });

  it('should_still_return_null_from_buildMonteCarloInputForScenario_when_retirement_age_is_unset_even_with_the_override', () => {
    const noRetirement: ScenarioAggregate = {
      id: 's-noret',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'scenario',
      payload: {
        name: 'NoRetirement',
        description: '',
        parentScenarioId: null,
        isPrimary: true,
        notes: '',
        overrides: {},
      },
    };
    const args = buildArgs({ scenario: noRetirement, expenses: [guardrailExpense] });
    const result = buildMonteCarloInputForScenario({
      scenarioId: noRetirement.id,
      scenarios: [noRetirement],
      inputs: {
        members: [...args.members],
        accounts: [...args.accounts],
        balances: [...args.balances],
        expenses: [...args.expenses],
        incomeStreams: [...args.incomeStreams],
        ssBenefits: [...args.ssBenefits],
      },
      todayYear: TODAY_YEAR,
      todayMonthIndex: TODAY_MONTH_INDEX,
      guardrailOverrideConfig: OVERRIDE_ON,
    });
    expect(result).toBeNull();
  });
});

describe('canonicalSsSharesByYear', () => {
  const row = (year: number, primary: number, secondary: number) => ({
    year,
    month0: 0,
    total: primary + secondary,
    primary,
    secondary,
  });

  it('should_omit_the_key_for_a_one_member_household', () => {
    expect(canonicalSsSharesByYear([row(2030, 30_000, 0)], false)).toEqual({});
  });

  it('should_omit_the_key_when_the_household_has_no_Social_Security', () => {
    expect(canonicalSsSharesByYear([row(2030, 0, 0)], true)).toEqual({});
    expect(canonicalSsSharesByYear(undefined, true)).toEqual({});
  });

  it('should_sum_the_months_into_one_ascending_entry_per_year', () => {
    const out = canonicalSsSharesByYear(
      [row(2031, 1_000, 3_000), row(2030, 2_000, 2_000), row(2030, 2_000, 2_000)],
      true,
    );
    expect(out.ssSharesByYear).toEqual([
      { year: 2030, primaryShare: 0.5 },
      { year: 2031, primaryShare: 0.25 },
    ]);
  });
});

describe('buildMcRothOrderedProfile via buildMcTaxContext', () => {
  const withFacts = (
    account: Aggregate<AccountPayload>,
    facts: Partial<AccountPayload>,
  ): Aggregate<AccountPayload> => ({
    ...account,
    payload: { ...account.payload, ...facts },
  });

  it('uses inferred balance history for a pooled designated clock in both account orders', () => {
    const known = withFacts(
      brokerage('roth401k-known', 'm1', 'RETIREMENT_ROTH_401K', 'ROTH'),
      { designatedRothBasis: 10_000, designatedRothFirstParticipationTaxYear: 2005 },
    );
    const missing = withFacts(
      brokerage('roth401k-missing', 'm1', 'RETIREMENT_ROTH_403B', 'ROTH'),
      { designatedRothBasis: 10_000 },
    );
    const scenario = baseScenario('s-desig', 'TaxEfficient', {
      withdrawalStrategy: { kind: 'taxEfficient' },
    });
    const profileFor = (accounts: Aggregate<AccountPayload>[]) => {
      const args = buildArgs({
        scenario,
        accounts,
        balances: accounts.map((a) => balanceRow(a.id, 2025, 100_000)),
      });
      return buildMcTaxContext(buildCtx(args))!.rothOrderedProfile;
    };
    const forward = profileFor([known, missing]);
    const reversed = profileFor([missing, known]);
    expect(forward?.designatedFirstParticipationTaxYear).toBe(2025);
    expect(reversed?.designatedFirstParticipationTaxYear).toBe(2025);
    expect(reversed?.designatedFirstParticipationTaxYear).toBe(
      forward?.designatedFirstParticipationTaxYear,
    );
  });

  // The §408A five-year period is per individual: pooling takes the latest clock and names both owners so the 59½ test
  // covers both.
  it('pools two owners’ Roth-IRA clocks conservatively and names both owners', () => {
    const older = withFacts(brokerage('roth-ira-1', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH'), {
      rothIraRegularContributionBasis: 20_000,
      rothIraFirstContributionTaxYear: 2001,
    });
    const younger = withFacts(brokerage('roth-ira-2', 'm2', 'RETIREMENT_ROTH_IRA', 'ROTH'), {
      rothIraRegularContributionBasis: 5_000,
      rothIraFirstContributionTaxYear: 2024,
    });
    const args = buildArgs({
      members: [member('m1', true, 'Alex', 1965), member('m2', false, 'Sam', 1975)],
      scenario: baseScenario('s-two-owner', 'TaxEfficient', {
        withdrawalStrategy: { kind: 'taxEfficient' },
      }),
      accounts: [older, younger],
      balances: [balanceRow('roth-ira-1', 2025, 200_000), balanceRow('roth-ira-2', 2025, 50_000)],
    });
    const profile = buildMcTaxContext(buildCtx(args))!.rothOrderedProfile;
    expect(profile?.iraFirstContributionTaxYear).toBe(2024);
    expect([...(profile?.rothOwnerIds ?? [])].sort()).toEqual(['m1', 'm2']);
  });

  // A MIXED plan's pre-tax sub-account never enters the Roth-ordered pool; counting the whole balance would inflate the
  // denominator and mis-split pooled draws between the §408A and §402A regimes.
  it('counts only a MIXED plan’s Roth-designated pocket in the pooled Roth balance', () => {
    const mixedBalanceRow = (
      accountId: string,
      year: number,
      preTax: number,
      postTax: number,
    ): Aggregate<AccountBalancePayload> => {
      const row = balanceRow(accountId, year, preTax + postTax);
      return {
        ...row,
        payload: {
          ...row.payload,
          endingBalancePreTax: preTax,
          endingBalancePostTax: postTax,
        },
      };
    };
    const rothIra = withFacts(brokerage('roth-ira', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH'), {
      rothIraRegularContributionBasis: 20_000,
      rothIraFirstContributionTaxYear: 2001,
    });
    const mixedPlan = withFacts(brokerage('mixed-401k', 'm1', 'RETIREMENT_401K', 'MIXED'), {
      designatedRothBasis: 40_000,
      designatedRothFirstParticipationTaxYear: 2010,
    });
    const args = buildArgs({
      scenario: baseScenario('s-mixed-pool', 'TaxEfficient', {
        withdrawalStrategy: { kind: 'taxEfficient' },
      }),
      accounts: [rothIra, mixedPlan],
      balances: [
        balanceRow('roth-ira', 2025, 100_000),
        mixedBalanceRow('mixed-401k', 2025, 800_000, 100_000),
      ],
    });
    const profile = buildMcTaxContext(buildCtx(args))!.rothOrderedProfile;
    expect(profile!.designatedBalanceCents).toBeGreaterThan(95_000_00);
    expect(profile!.designatedBalanceCents).toBeLessThan(105_000_00);
    expect(profile!.iraShareOfOrderedPool).toBeGreaterThan(0.45);
    expect(profile!.iraShareOfOrderedPool).toBeLessThan(0.55);
  });

  // Conversion lots are derived from the annual balance rows inside buildPipelineContext; this fails if args.balances is
  // no longer handed to the adapter.
  it('derives Roth-IRA conversion lots from the annual balance rows, through the real pipeline context', () => {
    const iraAccount = withFacts(
      brokerage('roth-ira-conv', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH'),
      { rothIraRegularContributionBasis: 10_000, rothIraFirstContributionTaxYear: 2010 },
    );
    const args = buildArgs({
      scenario: baseScenario('s-conv-lots', 'TaxEfficient', {
        withdrawalStrategy: { kind: 'taxEfficient' },
      }),
      accounts: [iraAccount],
      balances: [
        balanceRow('roth-ira-conv', 2023, 120_000, { taxable: 20_000, nontaxable: 5_000 }),
        balanceRow('roth-ira-conv', 2024, 150_000),
        balanceRow('roth-ira-conv', 2025, 200_000),
      ],
    });

    const ctx = buildCtx(args);
    const pool = [...ctx.rothDistributionFacts.rothIraByPool.values()][0];
    expect(pool.rothIra?.conversionLots).toEqual([
      {
        taxYear: 2023,
        taxableConvertedPrincipalCents: 2_000_000,
        nontaxableConvertedPrincipalCents: 500_000,
      },
    ]);

    // ...and it reaches the MC input, so a conversion changes the cache key.
    const profile = buildMcTaxContext(ctx)!.rothOrderedProfile;
    expect(profile?.iraConversionLots).toEqual([
      { taxYear: 2023, taxableCents: 2_000_000, nontaxableCents: 500_000 },
    ]);
  });

  // Building rothDistributionFacts from every account would let an inactive plan's recorded basis inflate the pool's basis
  // numerator with no matching balance; the narrowing lives inside the adapter's designated branch.
  it('excludes an inactive account’s recorded designated-Roth basis from the pooled basis', () => {
    const mixedBalanceRow = (
      accountId: string,
      year: number,
      preTax: number,
      postTax: number,
    ): Aggregate<AccountBalancePayload> => {
      const row = balanceRow(accountId, year, preTax + postTax);
      return {
        ...row,
        payload: { ...row.payload, endingBalancePreTax: preTax, endingBalancePostTax: postTax },
      };
    };
    const activePlan = withFacts(brokerage('mixed-401k', 'm1', 'RETIREMENT_401K', 'MIXED'), {
      designatedRothFirstParticipationTaxYear: 2010,
    });
    const inactivePlan = withFacts(
      brokerage('roth403b-inactive', 'm1', 'RETIREMENT_ROTH_403B', 'ROTH'),
      {
        designatedRothFirstParticipationTaxYear: 2005,
        active: false,
      },
    );
    const args = buildArgs({
      scenario: baseScenario('s-inactive-basis', 'TaxEfficient', {
        withdrawalStrategy: { kind: 'taxEfficient' },
      }),
      accounts: [activePlan, inactivePlan],
      balances: [
        withInPlanRollover(mixedBalanceRow('mixed-401k', 2025, 900_000, 100_000), 10_000),
        withInPlanRollover(balanceRow('roth403b-inactive', 2025, 0), 90_000),
      ],
    });
    const profile = buildMcTaxContext(buildCtx(args))!.rothOrderedProfile;
    expect(profile!.designatedBasisCents).toBe(10_000_00);
    expect(profile!.designatedBalanceCents).toBeGreaterThan(95_000_00);
    expect(profile!.designatedBalanceCents).toBeLessThan(105_000_00);
  });

  // An inherited Roth IRA is wholesale tax-free and never reaches the ordered carrier, so it contributes no balance, clock,
  // lots, basis or owner to any aggregate.
  it('excludes an INHERITED Roth IRA from every ordered-pool aggregate', () => {
    const own = withFacts(brokerage('roth-ira-own', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH'), {
      rothIraRegularContributionBasis: 20_000,
      rothIraFirstContributionTaxYear: 2010,
    });
    // Owned by m2, whose only Roth account this is, with no recorded clock.
    const inherited = withFacts(
      brokerage('roth-ira-inherited', 'm2', 'RETIREMENT_ROTH_IRA', 'ROTH'),
      { rothIraRegularContributionBasis: 5_000, rmdInheritedAccount: true },
    );
    // A designated plan makes the share discriminating; without one, iraShareOfOrderedPool is 1 either way.
    const designated = withFacts(
      brokerage('roth-401k', 'm1', 'RETIREMENT_ROTH_401K', 'ROTH'),
      { designatedRothBasis: 40_000, designatedRothFirstParticipationTaxYear: 2012 },
    );
    const args = buildArgs({
      scenario: baseScenario('s-inherited-pool', 'TaxEfficient', {
        withdrawalStrategy: { kind: 'taxEfficient' },
      }),
      accounts: [own, inherited, designated],
      members: [member('m1', true, 'Alex', 1965), member('m2', false, 'Blair', 1967)],
      balances: [
        withContributions(balanceRow('roth-ira-own', 2025, 100_000), 20_000),
        withContributions(
          balanceRow('roth-ira-inherited', 2025, 100_000, { taxable: 30_000 }),
          5_000,
        ),
        balanceRow('roth-401k', 2025, 100_000),
      ],
    });
    const ctx = buildCtx(args);
    const profile = buildMcTaxContext(ctx)!.rothOrderedProfile;
    expect([...ctx.rothDistributionFacts.rothIraByPool.keys()]).toEqual(['m1']);
    expect(profile?.iraShareOfOrderedPool).toBeCloseTo(0.5, 6);
    expect(profile?.iraFirstContributionTaxYear).toBe(2010);
    expect([...(profile?.rothOwnerIds ?? [])]).toEqual(['m1']);
    expect(profile?.iraConversionLots).toEqual([]);
    expect(ctx.rothBasisCentsByOwner.get('m1')).toBe(20_000_00);
    expect(ctx.rothBasisCentsByOwner.has('m2')).toBe(false);
  });

  // Accepted consequence: a pool whose accounts are all inactive has real derived basis and no five-year anchor, so in MC
  // it blanks the household's pooled clock and widens the every-owner-59½ set (conservative).
  it('an ALL-INACTIVE Roth-IRA pool blanks the MC pooled clock and widens the owner set', () => {
    const seasoned = withFacts(brokerage('roth-ira-active', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH'), {
      rothIraFirstContributionTaxYear: 2010,
    });
    const closed = withFacts(brokerage('roth-ira-closed', 'm2', 'RETIREMENT_ROTH_IRA', 'ROTH'), {
      rothIraFirstContributionTaxYear: 2004,
      active: false,
    });
    const args = buildArgs({
      members: [member('m1', true, 'Alex', 1965), member('m2', false, 'Sam', 1967)],
      scenario: baseScenario('s-all-inactive-pool', 'TaxEfficient', {
        withdrawalStrategy: { kind: 'taxEfficient' },
      }),
      accounts: [seasoned, closed],
      balances: [
        withContributions(balanceRow('roth-ira-active', 2025, 200_000), 20_000),
        withContributions(balanceRow('roth-ira-closed', 2025, 0), 15_000),
      ],
    });
    const ctx = buildCtx(args);
    expect(ctx.rothBasisCentsByOwner.get('m2')).toBe(15_000_00);
    const profile = buildMcTaxContext(ctx)!.rothOrderedProfile;
    expect(profile?.iraFirstContributionTaxYear).toBeUndefined();
    expect([...(profile?.rothOwnerIds ?? [])]).toEqual(['m1', 'm2']);
  });

  // A closed pool's remaining basis and lots are resolved facts (kept for display), but no deterministic pass can consume
  // them; seeding them into MC's single carrier would shelter the other owner's draws and under-report tax.
  it('excludes an ALL-INACTIVE pool’s basis and lots from the MC aggregate seed (still resolved for display)', () => {
    const seasoned = withFacts(brokerage('roth-ira-active', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH'), {
      rothIraFirstContributionTaxYear: 2010,
    });
    const closed = withFacts(brokerage('roth-ira-closed', 'm2', 'RETIREMENT_ROTH_IRA', 'ROTH'), {
      active: false,
    });
    const args = buildArgs({
      members: [member('m1', true, 'Alex', 1965), member('m2', false, 'Sam', 1967)],
      scenario: baseScenario('s-all-inactive-mc-seed', 'TaxEfficient', {
        withdrawalStrategy: { kind: 'taxEfficient' },
      }),
      accounts: [seasoned, closed],
      balances: [
        withContributions(balanceRow('roth-ira-active', 2025, 200_000), 20_000),
        withContributions(balanceRow('roth-ira-closed', 2025, 0, { taxable: 30_000 }), 15_000),
      ],
    });
    const ctx = buildCtx(args);
    expect(ctx.rothBasisCentsByOwner.get('m2')).toBe(15_000_00);
    expect(
      ctx.rothDistributionFacts.rothIraByPool.get('m2')?.rothIra?.conversionLots,
    ).toHaveLength(1);
    expect(ctx.rothDistributionFacts.rothIraByPool.get('m2')?.allAccountsInactive).toBe(true);
    expect(ctx.rothDistributionFacts.rothIraByPool.get('m1')?.allAccountsInactive).toBeUndefined();
    const taxCtx = buildMcTaxContext(ctx)!;
    // The MC seed carries only drawable basis (m1's); the closed pool's lot never reaches the pooled FIFO scan.
    expect(taxCtx.rothBasisCentsByOwner).toEqual([{ ownerId: 'm1', cents: 20_000_00 }]);
    expect(taxCtx.rothOrderedProfile?.iraConversionLots).toEqual([]);
    expect(taxCtx.rothOrderedProfile?.iraFirstContributionTaxYear).toBeUndefined();
    expect([...(taxCtx.rothOrderedProfile?.rothOwnerIds ?? [])]).toEqual(['m1', 'm2']);
  });

  it('uses balance history when one contributing Roth-IRA owner records no explicit year', () => {
    const dated = withFacts(brokerage('roth-ira-1', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH'), {
      rothIraRegularContributionBasis: 20_000,
      rothIraFirstContributionTaxYear: 2001,
    });
    const undated = withFacts(brokerage('roth-ira-2', 'm2', 'RETIREMENT_ROTH_IRA', 'ROTH'), {
      rothIraRegularContributionBasis: 5_000,
    });
    const args = buildArgs({
      members: [member('m1', true, 'Alex', 1965), member('m2', false, 'Sam', 1975)],
      scenario: baseScenario('s-two-owner-blank', 'TaxEfficient', {
        withdrawalStrategy: { kind: 'taxEfficient' },
      }),
      accounts: [dated, undated],
      balances: [balanceRow('roth-ira-1', 2025, 200_000), balanceRow('roth-ira-2', 2025, 50_000)],
    });
    const profile = buildMcTaxContext(buildCtx(args))!.rothOrderedProfile;
    expect(profile?.iraFirstContributionTaxYear).toBe(2025);
  });
});

describe('buildMcRmdContext', () => {
  it('carries the per-account RMD facts + per-owner separation years across the seam', () => {
    const inherited: Aggregate<AccountPayload> = {
      ...brokerage('inh-ira', 'm1', 'RETIREMENT_IRA', 'PRE_TAX'),
      payload: {
        ...brokerage('inh-ira', 'm1', 'RETIREMENT_IRA', 'PRE_TAX').payload,
        rmdInheritedAccount: true,
        rmdBeneficiaryType: 'SPOUSE',
        rmdInheritedOwnerDeathDate: '2023-04-02',
        rmdInheritedOwnerDiedOnOrAfterRbd: false,
      },
    };
    const args = buildArgs({
      scenario: baseScenario('s-rmd', 'TaxEfficient', {
        withdrawalStrategy: { kind: 'taxEfficient' },
      }),
      accounts: [brokerage('a1', 'm1'), inherited],
      balances: [balanceRow('a1', 2025, 500_000), balanceRow('inh-ira', 2025, 200_000)],
    });
    const rmdCtx = buildMcRmdContext(buildCtx(args));
    expect(rmdCtx).toBeDefined();
    expect(rmdCtx!.rmdFactsByAccountId?.['inh-ira']?.inheritedAccount).toBe(true);
    expect(rmdCtx!.rmdFactsByAccountId?.['inh-ira']?.beneficiaryType).toBe('SPOUSE');
    // An account with no recorded facts stays absent, keeping a fact-free household on the byte-identical path.
    expect(rmdCtx!.rmdFactsByAccountId?.['a1']).toBeUndefined();
    expect(rmdCtx!.retirementYearByOwner?.['m1']).toBeGreaterThan(2020);
  });

  it('omits the RMD fact fields entirely for a household that records none (cache-key stability)', () => {
    const args = buildArgs({
      scenario: baseScenario('s-no-rmd', 'TaxEfficient', {
        withdrawalStrategy: { kind: 'taxEfficient' },
      }),
    });
    const rmdCtx = buildMcRmdContext(buildCtx(args));
    expect(rmdCtx).toBeDefined();
    expect(rmdCtx!.rmdFactsByAccountId).toBeUndefined();
    expect(rmdCtx!.retirementYearByOwner).toBeUndefined();
  });
});

// Imported ids are user-controlled, so "__proto__" or "constructor" can arrive as an id. Assigning them into a plain {}
// re-points the prototype instead of creating an own key (the account vanishes from JSON), and prototype-chain reads
// make an owner look already-present; both dictionaries are built with Object.fromEntries.
describe('serialized id-keyed dictionaries survive hostile ids', () => {
  const inheritedIra = (id: string, ownerId: string): Aggregate<AccountPayload> => {
    const base = brokerage(id, ownerId, 'RETIREMENT_IRA', 'PRE_TAX');
    return {
      ...base,
      payload: {
        ...base.payload,
        rmdInheritedAccount: true,
        rmdBeneficiaryType: 'SPOUSE',
        rmdInheritedOwnerDeathDate: '2023-04-02',
        rmdInheritedOwnerDiedOnOrAfterRbd: false,
      },
    };
  };

  it.each(['__proto__', 'constructor'])(
    'keeps an account id of "%s" as an OWN key that survives serialization',
    (accountId) => {
      const args = buildArgs({
        accounts: [brokerage('a1', 'm1'), inheritedIra(accountId, 'm1')],
        balances: [balanceRow('a1', 2025, 500_000), balanceRow(accountId, 2025, 200_000)],
      });
      const ctx = buildCtx(args);

      const fragment = buildRmdEngineFactsFragment(ctx);
      const facts = fragment.rmdFactsByAccountId;
      expect(facts).toBeDefined();
      expect(Object.hasOwn(facts!, accountId)).toBe(true);
      expect(Object.keys(facts!)).toContain(accountId);

      const mcRmd = buildMcRmdContext(ctx);
      const wire = JSON.parse(JSON.stringify(mcRmd)) as {
        rmdFactsByAccountId?: Record<string, { inheritedAccount?: boolean }>;
      };
      expect(Object.hasOwn(wire.rmdFactsByAccountId ?? {}, accountId)).toBe(true);
      expect(wire.rmdFactsByAccountId?.[accountId]?.inheritedAccount).toBe(true);
      expect(facts![accountId]?.inheritedAccount).toBe(true);

      expect(({} as Record<string, unknown>).inheritedAccount).toBeUndefined();
    },
  );

  it.each(['__proto__', 'constructor'])(
    'gives a household member id of "%s" their 70½ QCD eligibility year',
    (memberId) => {
      const args = buildArgs({
        members: [member(memberId, true, 'Alex', 1965)],
        ssBenefits: [ssBenefit(memberId, 2500)],
        accounts: [brokerage('ira', memberId, 'RETIREMENT_IRA', 'PRE_TAX')],
        balances: [balanceRow('ira', 2025, 900_000)],
        scenario: baseScenario('s-qcd', 'TaxEfficient', {
          withdrawalStrategy: { kind: 'taxEfficient' },
          qualifiedCharitableDistributions: [
            {
              memberId,
              sourceAccountId: 'ira',
              annualAmountDollars: 20_000,
              // Both anchors sit past the member's 70½ tax year (born 1965).
              start: { kind: 'year', year: 2040 },
              end: { kind: 'year', year: 2050 },
            },
          ],
        }),
      });
      const ctx = buildCtx(args);
      expect(ctx.resolvedQcd.entries).toHaveLength(1);

      const qcdCtx = buildMcQcdContext(ctx);
      expect(qcdCtx).toBeDefined();
      const byOwner = qcdCtx!.firstEligibleYearByOwner;
      expect(Object.hasOwn(byOwner, memberId)).toBe(true);
      expect(byOwner[memberId]).toBe(2035); // 1965 + 70½ → tax year 2035

      const wire = JSON.parse(JSON.stringify(qcdCtx)) as {
        firstEligibleYearByOwner: Record<string, number>;
      };
      expect(Object.hasOwn(wire.firstEligibleYearByOwner, memberId)).toBe(true);
      expect(wire.firstEligibleYearByOwner[memberId]).toBe(2035);

      expect(new Map(Object.entries(wire.firstEligibleYearByOwner)).get(memberId)).toBe(
        2035,
      );
    },
  );
});

describe('medical inflation rate plumbing', () => {
  const argsWith = (inflation: { ratePct: number; categoryRates?: Record<string, number> }) =>
    buildArgs({ scenario: baseScenario('s-med-rate', 'MedRate', { inflation }) });

  it('buildPipelineContext stores the resolved rate: general + 2 pp, or the explicit Medical rate', () => {
    expect(buildCtx(argsWith({ ratePct: 4 })).medicalInflationRatePct).toBe(6);
    expect(
      buildCtx(argsWith({ ratePct: 4, categoryRates: { 'cat-medical': 7 } }))
        .medicalInflationRatePct,
    ).toBe(7);
  });

  it('PageSharedContext exposes the same rate', () => {
    const page = runBalanceProjectionForPage(
      argsWith({ ratePct: 4, categoryRates: { 'cat-medical': 7 } }),
    );
    expect(page.sharedCtx.medicalInflationRatePct).toBe(7);
  });

  it('buildMcTaxContext and buildMcTaxYearInput carry the same number as the context', () => {
    const ctx = buildCtx(argsWith({ ratePct: 4 }));
    const taxCtx = buildMcTaxContext(ctx)!;
    expect(taxCtx.medicalInflationRatePct).toBe(ctx.medicalInflationRatePct);
    const taxYear = ctx.primaryRetirementYear + 1;
    const survivors = deriveMcSurvivors(taxCtx, taxYear, ctx.primaryRetirementYear)!;
    const yearInput = buildMcTaxYearInput(
      {
        taxCtx,
        taxYear,
        retirementYear: ctx.primaryRetirementYear,
        grossSsDollars: 0,
        nominalExpense: 40_000,
        otherIncome: 0,
        priorBalance: 800_000,
        priorPreTaxByOwner: new Map(),
        magiMinus2: undefined,
      },
      survivors,
      40_000,
    );
    expect(yearInput.medicalInflationRatePct).toBe(6);
  });
});
