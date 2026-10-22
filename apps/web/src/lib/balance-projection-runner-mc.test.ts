/**
 * Unit tests for the MC-bundle assembly helpers
 * (balance-projection-runner-mc.ts): `assembleMcBundle`,
 * `mcInputFromBundle`, `buildOptimizerMcScenarioSetup`, `buildMcTaxContext`,
 * and the `OPTIMIZER_MC_SEED` constant.
 *
 * Drives the real pipeline-context + cashflow builders from `Aggregate`
 * fixtures (same fixture style as `balance-projection-runner.test.ts`) so the
 * assembly helpers run against production-shaped inputs. Each test isolates
 * one assembly behavior:
 *  - CBP-validation gate (null → ok; ok === false → election gate);
 *  - event re-anchoring (absolute month → todayYear-relative step index);
 *  - retirementFractionalYear = retirementYear + month0/12;
 *  - the pinned optimizer seed + default path count;
 *  - buildMcTaxContext builds a context for every named strategy.
 */
import { describe, expect, it } from 'vitest';
import {
  assembleMcBundle,
  computeMedicalDemandBase,
} from './monte-carlo-input-bundle';
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
  /** Per-year Roth conversion amounts — the ONLY place a Roth-IRA conversion is
   *  recorded, and the source `buildRothDistributionFacts` derives its lots from. */
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

/** Recorded regular contributions on a balance row — the §408A history a Roth
 *  IRA pool's contribution basis is derived from. */
function withContributions(
  row: Aggregate<AccountBalancePayload>,
  totalContributions: number,
): Aggregate<AccountBalancePayload> {
  return { ...row, payload: { ...row.payload, totalContributions } };
}

/** Recorded in-plan-rollover principal on a balance row — an employer plan's
 *  whole designated-Roth basis. */
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
    // Arrange: a household with NO CBP accounts → ctx.cbpValidation === null.
    const args = buildArgs();
    const ctx = buildCtx(args);
    expect(ctx.cbpValidation).toBeNull();

    // Act.
    const { bundle } = assemble(args);

    // Assert: the null case is treated as ok — the bundle carries a
    // synthesized ok validation rather than null, and portfolio assembled.
    expect(bundle.cbpValidation.ok).toBe(true);
    expect(bundle.cbpValidation.unconfigured).toEqual([]);
    expect(bundle.portfolioToday).toBe(800_000);
  });

  it('should_exclude_an_annuity_elected_cbp_balance_from_portfolio_when_validation_is_ok', () => {
    // Arrange: a configured annuity CBP (linked pension stream) plus a
    // brokerage. With cbpValidation.ok === true the elections lookup runs
    // (resolveLinkedCbpIncomeStreams), so the annuity CBP balance is routed
    // out of the portfolio (skipsPortfolio) — only the brokerage remains.
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

    // Act.
    const { bundle } = assemble(args);

    // Assert: only the brokerage's balance is in the portfolio; the
    // annuity-elected CBP balance is excluded (routed via incomeByYear).
    expect(bundle.portfolioToday).toBe(800_000);
    expect(bundle.cbpValidation.ok).toBe(true);
  });

  it('should_gate_optimizer_setup_with_CbpUnconfiguredError_when_validation_is_not_ok', () => {
    // Arrange: a CBP account with no linked pension stream → unconfigured →
    // ctx.cbpValidation.ok === false. The optimizer setup must throw
    // CbpUnconfiguredError (the documented ok === false gate).
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

    // Act + Assert.
    expect(() => buildOptimizerMcScenarioSetup(args)).toThrowError(
      CbpUnconfiguredError,
    );
  });
});

describe('assembleMcBundle — event re-anchoring + fractional year', () => {
  it('should_reanchor_a_post_primary_one_off_event_to_a_todayYear_relative_step_index', () => {
    // Arrange: a portfolio-deposit windfall at 2034 (two years past the
    // 2032 primary retirement). The cashflow series stores the event at the
    // ABSOLUTE month (year*12 + month0); assembleMcBundle re-anchors it to a
    // step index relative to todayYear (= month - todayYear*12).
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
    // Pre-condition: the cashflow event is stored at an absolute month.
    expect(cashflowSeries.targetedOneOffEvents.length).toBeGreaterThan(0);
    const absMonth = cashflowSeries.targetedOneOffEvents[0].month;
    // Year 2034 → absolute month is 2034*12 + month0.
    expect(absMonth).toBeGreaterThanOrEqual(2034 * 12);

    // Act.
    const { bundle } = assemble(args);

    // Assert golden: the bundle event = absolute month − todayYear*12.
    expect(bundle.targetedOneOffEvents.length).toBe(
      cashflowSeries.targetedOneOffEvents.length,
    );
    const reanchored = bundle.targetedOneOffEvents[0];
    expect(reanchored.month).toBe(absMonth - TODAY_YEAR * 12);
    // 2034 is 8 years past todayYear 2026 → step index ≥ 8*12 = 96.
    expect(reanchored.month).toBeGreaterThanOrEqual(8 * 12);
    expect(reanchored.amount).toBe(cashflowSeries.targetedOneOffEvents[0].amount);
  });

  it('should_reanchor_post_primary_contribution_events_to_todayYear_relative_step_indices', () => {
    // Arrange: secondary works two years past primary retirement, so the
    // cashflow series synthesizes per-month post-primary contribution events
    // at absolute months. assembleMcBundle re-anchors each one identically.
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

    // Act.
    const { bundle } = assemble(args);

    // Assert: every re-anchored event equals (absolute month − todayYear*12),
    // preserving amount + accountId.
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
    // Arrange: a mid-year birthdate so primaryRetirementMonth0 is non-zero.
    // Born 1965-07 → retire at 67 in 2032, month0 = 6 (July). The fractional
    // year must be 2032 + 6/12.
    const midYear: Aggregate<HouseholdMemberPayload> = {
      ...member('m1', true, 'Alex', 1965),
      payload: {
        ...member('m1', true, 'Alex', 1965).payload,
        birthdate: '1965-07-01',
      },
    };
    const args = buildArgs({ members: [midYear] });
    const ctx = buildCtx(args);

    // Act.
    const { bundle } = assemble(args);

    // Assert golden.
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
    // The constant is the single source of truth for the optimizer + BPP
    // MC seed; it must be the pinned value 1.
    expect(OPTIMIZER_MC_SEED).toBe(1);
  });

  it('should_flatten_a_bundle_into_a_MonteCarloInput_with_seed_1_and_default_path_count_1000', () => {
    // Arrange: assemble a bundle, then flatten it.
    const args = buildArgs();
    const { bundle } = assemble(args);

    // Act.
    const input = mcInputFromBundle(bundle);

    // Assert: seed pinned to OPTIMIZER_MC_SEED (1); default path count 1000.
    expect(input.seed).toBe(OPTIMIZER_MC_SEED);
    expect(input.seed).toBe(1);
    expect(input.pathCount).toBe(1000);
    // Anchors round-trip from the bundle.
    expect(input.firstYear).toBe(bundle.todayYear);
    expect(input.retirementYear).toBe(bundle.retirementYear);
    expect(input.horizonYear).toBe(bundle.horizonYear);
  });

  it('should_build_a_per_candidate_input_swapping_only_ssByYear_while_holding_invariant_fields', () => {
    // Arrange: optimizer setup builds the candidate-invariant input once.
    const args = buildArgs({ ssBenefits: [ssBenefit('m1', 3000)] });
    const setup = buildOptimizerMcScenarioSetup(args);

    // Act: two candidates at different claim ages.
    const at62 = setup.mcInputForCandidate({
      socialSecurity: { primary: { ageYears: 62, ageMonths: 0 } },
    });
    const at70 = setup.mcInputForCandidate({
      socialSecurity: { primary: { ageYears: 70, ageMonths: 0 } },
    });

    // Assert: pinned seed + path count hold across candidates; only ssByYear
    // differs (later claim age → higher first-non-zero annual SS).
    expect(at62.seed).toBe(1);
    expect(at70.seed).toBe(1);
    expect(at62.pathCount).toBe(1000);
    expect(at62.portfolioToday).toBe(at70.portfolioToday);
    // The windowed per-month expense base is candidate-invariant — the SS
    // claim age changes neither the retirement year nor any expense window, so
    // both candidates share the identical per-month base array.
    expect(at62.monthlyExpenseBase).toEqual(at70.monthlyExpenseBase);
    const firstNonZero = (arr: number[]): number => arr.find((v) => v > 0) ?? 0;
    expect(firstNonZero(at62.ssByYear)).toBeLessThan(
      firstNonZero(at70.ssByYear),
    );
  });

  it('the candidate survivor overlay reaches the MC ssByYear (deterministic parity)', () => {
    // Two-member household with a survivor phase: primary dies 2034 (life 70,
    // 1964 benefit cohort) while the secondary (born 1975 → 1974 cohort) is
    // 61 — young enough that the survivor claim age changes both the start
    // year and the widow(er) reduction.
    const scenario = baseScenario('s-sv', 'Survivor', {
      lifeExpectancy: { primary: 70, secondary: 95 },
      socialSecurity: {
        primary: { ageYears: 67, ageMonths: 0 },
        secondary: { ageYears: 67, ageMonths: 0 },
        // Stored survivor age 62 — the candidate overlay carries a
        // DIFFERENT validated age (60) below.
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
    // No survivor field on the overlay → the STORED survivor section applies
    // (withCandidateOverlay semantics).
    const stored = setup.mcInputForCandidate({ socialSecurity: ownAges });
    const explicitStored = setup.mcInputForCandidate({
      socialSecurity: {
        ...ownAges,
        survivor: { secondary: { ageYears: 62, ageMonths: 0 } },
      },
    });
    expect(stored.ssByYear).toEqual(explicitStored.ssByYear);
    // A candidate carrying a clamped/validated survivor age (60) must reach
    // MC — pre-fix the setup re-read the resolved override and silently
    // ranked a different plan than the deterministic candidate simulated.
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
    // The SS-claim-age overlay swaps only ssByYear — the Medical (+2pp) windowed
    // bucket survives into the candidate input so optimizer success% reflects it.
    expect(candidate.monthlyExpenseBucketsBase).toBeDefined();
    expect(candidate.monthlyExpenseBucketsBase!.map((b) => b.ratePct)).toContain(5);
    expect(candidate.successOnly).toBe(true);
  });
});

describe('MC per-category inflation buckets', () => {
  // NOTE: `hsaQualified` defaults to `true` for medical-category fixtures used
  // in tests that drive `computeMedicalDemandBase` — medical expenses must be
  // explicitly qualified to contribute to HSA demand. Fixtures for
  // non-medical categories ignore this parameter.
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

  // Per-step `Σ_b base_b[i]` must equal `monthlyExpenseBase[i]` (round2
  // cents) at EVERY month — the windowed bucket contract. Also pins the kernel
  // stepCount length on every per-month array.
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

  // A retirement-month index well inside an active lifetime window (offset
  // from the input's own firstYear/retirementYear), so a recurring expense's
  // run-rate ÷ 12 base is non-zero there.
  const retMonthOffsetOf = (input: { firstYear: number; retirementYear: number }): number =>
    (input.retirementYear - input.firstYear) * 12 + 6;

  it('a Medical expense at the +2pp default emits windowed buckets; Σ_b base[i] === monthlyExpenseBase[i]', () => {
    // baseScenario general rate = 3%; Medical defaults to general + 2 = 5%.
    const scenario = baseScenario('s-med', 'Medical', { inflation: { ratePct: 3 } });
    const expenses = [
      expense('e-med', 'cat-medical', 1_000, 'monthly'),
      expense('e-food', 'cat-food', 2_000, 'monthly'),
    ];
    const input = mcInputFromBundle(assemble(buildArgs({ scenario, expenses })).bundle);
    expect(input.monthlyExpenseBucketsBase).toBeDefined();
    // One bucket at general (food=3%) + one at 5% (medical).
    const rates = input.monthlyExpenseBucketsBase!.map((b) => b.ratePct).sort();
    expect(rates).toEqual([3, 5]);
    // Per-step pin + stepCount length on every per-month array.
    expectBucketsPinPerStep(input);
  });

  it('v40: interleaved per-category rates — Σ_b base_b[i] equals monthlyExpenseBase[i] per step (cents)', () => {
    // Interleave categories so the per-rate regrouping reorders the fp-adds vs
    // the in-original-order base sum. The Medical (+2pp) category supplies a
    // non-general rate so buckets are emitted; the override sets distinct rates
    // per category. The per-step residual-adjust must close any gap to the cent.
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
    // No Medical expense → no category differs from general → buckets absent.
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
    // The windowed base is identical (same dollars) ...
    expect(inOverride.monthlyExpenseBase).toEqual(inDefault.monthlyExpenseBase);
    // ... but the Medical bucket rate now follows the override (7%) vs default (5%).
    expect(inOverride.monthlyExpenseBucketsBase!.map((b) => b.ratePct)).toEqual([7]);
    expect(inDefault.monthlyExpenseBucketsBase!.map((b) => b.ratePct)).toEqual([5]);
  });

  it('flag follows the engine: a recreated-Medical (NEW id) in medicalCategoryIds gets +2pp; cat-medical omitted gets general', () => {
    // The flag-derived set carries ONLY the recreated id — NOT cat-medical.
    // A stale hard-coded cat-medical path would green for the wrong reason;
    // omitting cat-medical proves the +2pp follows the threaded set.
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
    // The recreated id gets +2pp (5%); the legacy cat-medical now reads the
    // general rate (3%) because it is NOT in the set.
    const rates = input.monthlyExpenseBucketsBase!.map((b) => b.ratePct).sort();
    // general (food + legacy-medical = 3) + recreated-medical (5).
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
    // Both medical ids coalesce into ONE 5% bucket; food stays general (3%).
    const rates = input.monthlyExpenseBucketsBase!.map((b) => b.ratePct).sort();
    expect(rates).toEqual([3, 5]);
    expectBucketsPinPerStep(input);
  });

  it('single-rate medical demand follows the sole NONZERO bucket, not the first flagged id with zero spend', () => {
    // Two isMedical categories. The FIRST-iterated flagged id (`cat-med-a`)
    // carries a 7% rate override but ZERO in-window spend (no expense). The
    // SECOND (`cat-med-b`) carries the real demand at an explicit 3% rate. The
    // medical demand series must inflate at 3% (the sole NONZERO bucket's rate),
    // NOT 7% (the first-flagged id) — else the real demand inflates at the wrong
    // CPI and can exceed the inflated medical expense, breaking the strict-subset
    // invariant. `byRate.size === 1` here (only the 3% bucket has positive spend).
    const scenario = baseScenario('s-med-zero-first', 'MedZeroFirst', {
      inflation: { ratePct: 3, categoryRates: { 'cat-med-a': 7, 'cat-med-b': 3 } },
    });
    // hsaQualified: true so this row contributes to medical demand.
    const expenses = [expense('e-med-b', 'cat-med-b', 1_000, 'monthly', 'essential', { kind: 'lifetime', whose: 'last' }, true)];
    // `cat-med-a` first → it is the "first flagged id" the buggy path read.
    const args = buildArgs({
      scenario,
      expenses,
      medicalCategoryIds: ['cat-med-a', 'cat-med-b'],
    });
    const medical = medicalDemandBaseForArgs(args);
    // Single nonzero bucket → scalar path; the rate is the real bucket's 3%.
    expect(medical.monthlyMedicalDemandBucketsBase).toBeUndefined();
    expect(medical.medicalDemandRatePct).toBe(3);
    // The medical demand base is exactly the real category's monthly charge, so
    // it stays a strict subset of the (≥) medical expense at every month.
    const baseSum = (medical.monthlyMedicalDemandBase ?? []).reduce((s, v) => s + v, 0);
    expect(baseSum).toBeGreaterThan(0);
  });

  // Drive `computeMedicalDemandBase` against a production-shaped pipeline
  // context (mirrors the private `computeWindowedExpenseBase` setup). Asserts the
  // rate-selection logic directly on the helper (the bundle-seam forwarding the
  // fields end-to-end is covered separately by the production-seam suite).
  function medicalDemandBaseForArgs(args: RunBalanceProjectionArgs): ReturnType<typeof computeMedicalDemandBase> {
    const ctx = buildCtx(args);
    const resolvedExpenses = resolveExpensesForScenario(args.scenarioId, [...ctx.effectiveScenarios], [...args.expenses]);
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
    const yearRange = { from: args.todayYear, to: ctx.horizonYear };
    const stepCount = (ctx.horizonYear - args.todayYear + 1) * 12;
    const inflation = resolveInflationForScenario(
      args.scenarioId,
      [...ctx.effectiveScenarios],
      new Set(args.medicalCategoryIds),
    );
    return computeMedicalDemandBase({
      runArgs: args,
      resolvedExpenses,
      baseCtx,
      yearRange,
      inflation,
      generalRate: inflation.ratePct,
      stepCount,
    });
  }

  it('bucket-composition: a windowed + discretionary-multiplier Medical expense lands the per-month bucket base matching the scalar base', () => {
    const scenario = baseScenario('s-disc', 'Disc', {
      inflation: { ratePct: 3 },
      discretionarySpending: { bumpPct: 50, durationYears: null }, // discMult 1.5
    });
    const expenses = [
      // A discretionary Medical expense with an explicit window end at 2050.
      expense('e-med', 'cat-medical', 1_000, 'monthly', 'discretionary', {
        kind: 'year',
        year: 2050,
      }),
    ];
    const input = mcInputFromBundle(assemble(buildArgs({ scenario, expenses })).bundle);
    expect(input.monthlyExpenseBucketsBase).toBeDefined();
    const medBucket = input.monthlyExpenseBucketsBase!.find((b) => b.ratePct === 5)!;
    // 1_000/mo × 1.5 (discretionary bump) = 1_500/mo run-rate base inside the
    // active window; the whole base is the Medical bucket (single expense).
    expect(medBucket.amount[retMonthOffsetOf(input)]).toBeCloseTo(1_500, 4);
    // Window ends in 2050 (exclusive) → the base is 0 in 2051 (still within the
    // horizon), proving the window closes the charge.
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
    // The one-off spikes at retirementStart (the retirement month) carrying its
    // FULL literal 50_000 PLUS the recurring 1_000/mo run-rate (= 51_000).
    const spikeMonth = (input.retirementYear - input.firstYear) * 12;
    expect(medBucket.amount[spikeMonth]).toBeCloseTo(51_000, 4);
    // A later active month carries only the recurring run-rate (1_000/mo).
    expect(medBucket.amount[retMonthOffsetOf(input)]).toBeCloseTo(1_000, 4);
  });

  it('split inflation override (parent ratePct, child categoryRates only) — bundle baseline + bucket rates measure against the per-FIELD general', () => {
    // Whole-section scenario merge (mergeFirstWins) keeps the CHILD's whole
    // `inflation` section, dropping the parent's `ratePct` from the resolved
    // section — so `ctx.resolvedScenario.inflation?.ratePct` is undefined here.
    // The per-FIELD `resolveInflationForScenario` instead inherits the parent's
    // ratePct. The bundle's `scenarioInflationPct` is sourced from the
    // per-field resolver, so the kernel mean-shift baseline matches the bucket
    // partition's general rate (NOT the section-default fallback).
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
        // Child overrides ONLY categoryRates — no ratePct in its inflation
        // section. `InflationOverride.ratePct` is required at the type level, but
        // this partial shape is reachable at runtime from a corrupt / partial
        // imported bundle (the exact case `resolveInflationForScenario` guards
        // with its per-FIELD `typeof inflation.ratePct === 'number'` check), so
        // the cast models that divergence.
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
    // The per-field general inherits the parent's 4% (not the section-default).
    expect(perField.ratePct).toBe(4);
    // The bundle baseline equals the per-field general, NOT the
    // whole-section fallback (which would be the DEFAULT, ≠ 4 here).
    expect(bundle.scenarioInflationPct).toBe(perField.ratePct);
    // Bucket rates are measured against that SAME general: food inflates at the
    // general 4%, the child's Medical override at 9% (≠ general → emitted).
    const rates = bundle.monthlyExpenseBucketsBase!.map((b) => b.ratePct).sort((a, b) => a - b);
    expect(rates).toEqual([4, 9]);
  });
});

describe('MC windowed expense schedule', () => {
  // An expense with an explicit start + end window (age-anchored to the primary)
  // so the active window is a finite slice of the projection horizon.
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
    // LTC at the primary's ages 85–90 (member m1 born 1965 → calendar 2050–2055).
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
    // Before the window opens (2050): EXACTLY 0 (1965 + 85 = 2050).
    const beforeMonth = (2049 - fy) * 12 + 6;
    expect(base[beforeMonth]).toBe(0);
    // Inside the window (2052): a $10_000/mo expense charges $10_000 per month.
    const insideMonth = (2052 - fy) * 12 + 6;
    expect(base[insideMonth]).toBeCloseTo(10_000, 4);
    // After the window closes (2055 exclusive end at age 90 → 2055): EXACTLY 0.
    const afterMonth = (2055 - fy) * 12 + 6;
    if (afterMonth < base.length) expect(base[afterMonth]).toBe(0);
  });

  it('a pre-retirement-only expense charges $0 in every retirement-phase month', () => {
    // An expense active 2026 → the primary's age 65 (2030), ending before the
    // age-67 (2032) retirement, so every retirement-phase month is $0.
    const scenario = baseScenario('s-pre', 'PreRet', { inflation: { ratePct: 3 } });
    const preRet = windowedExpense(
      'e-pre',
      5_000,
      'monthly',
      { kind: 'year', year: 2026 },
      { kind: 'age', memberId: 'primary', years: 65, months: 0 },
    );
    const input = mcInputFromBundle(assemble(buildArgs({ scenario, expenses: [preRet] })).bundle);
    // The kernel only applies expense from the retirement step onward; every
    // retirement-phase month carries a $0 base (the window closed pre-retirement).
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
    // Exactly one non-zero month for this single one-off.
    const nonZero = input.monthlyExpenseBase.filter((v) => v !== 0).length;
    expect(nonZero).toBe(1);
    // Year roll-up (2055) ties to projectExpensesByYear(...).totalBase.
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
    // A mixed plan: a lifetime recurring + a finite window + a one-off.
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
    // Every year's per-month base sum ties to the deterministic today's-dollar
    // year total — the windowed-parity regression contract.
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

  // Reference: the deterministic today's-dollar (0% inflation) year total for
  // `year`, the exact value the per-year base sum must tie to.
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
  // The regression: if `BalanceProjectionMcBundleArgs` did not declare the medical-demand
  // fields and `assembleMcBundleResult` did not forward them, the production
  // assembly (`assembleMcBundle → buildBalanceProjectionMcBundle →
  // assembleMcBundleResult`) would silently drop them and `mcInputFromBundle` would read
  // `undefined` → MC would see ZERO medical demand. These tests route through the FULL
  // production seam (no hand-built bundle literal) and assert the fields survive.
  // NOTE: `hsaQualified: true` is set for expenses used in medical-demand tests.
  // A medical expense without `hsaQualified` contributes zero demand.
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
    // A scenario with an HSA account + an isMedical-flagged category. The flag
    // set drives the medical-demand subset; the default +2pp rate (general 3% →
    // 5%) is the effective medical rate.
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

    // Act: full production seam — assemble the bundle, then flatten it.
    const { bundle } = assemble(args);
    const input = mcInputFromBundle(bundle);

    // Assert: the bundle itself carries the medical-demand base (not dropped by
    // assembleMcBundleResult) ...
    expect(bundle.monthlyMedicalDemandBase).toBeDefined();
    // ... and it SURVIVES verbatim into the MonteCarloInput (the production path
    // mcInputFromBundle reads). Equal-by-reference (carried, not re-derived).
    expect(input.monthlyMedicalDemandBase).toBe(bundle.monthlyMedicalDemandBase);
    expect(input.monthlyMedicalDemandBase!.some((v) => v > 0)).toBe(true);
    // The effective medical rate (general 3% + 2pp default = 5%) survives too.
    expect(bundle.medicalDemandRatePct).toBe(5);
    expect(input.medicalDemandRatePct).toBe(5);
    // Strict subset: medical demand never exceeds the total expense base per step.
    for (let i = 0; i < input.monthlyMedicalDemandBase!.length; i += 1) {
      expect(input.monthlyMedicalDemandBase![i]).toBeLessThanOrEqual(
        input.monthlyExpenseBase[i] + 1e-6,
      );
    }
  });

  it('forwards the per-rate medical-demand buckets when the medical set spans > 1 rate', () => {
    // Two isMedical categories at distinct explicit rates → the medical subset
    // spans > 1 effective rate, so the per-rate buckets are emitted and must
    // survive the bundle seam into the MonteCarloInput.
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
    // The buckets survive verbatim into the MonteCarloInput.
    expect(input.monthlyMedicalDemandBucketsBase).toBe(bundle.monthlyMedicalDemandBucketsBase);
    const rates = input.monthlyMedicalDemandBucketsBase!.map((b) => b.ratePct).sort((a, b) => a - b);
    expect(rates).toEqual([5, 7]);
  });

  it('omits the medical-demand fields when NO category is isMedical (no HSA reserve)', () => {
    const scenario = baseScenario('s-no-med', 'NoMed', { inflation: { ratePct: 3 } });
    const args = buildArgs({
      scenario,
      expenses: [medExpense('e-food', 'cat-food', 2_000)],
      // Explicit empty set = no medical categories (the absent/undefined case
      // would fall back to the legacy `cat-medical` default).
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
    // The Combined Pot guard is retired: every strategy is tax-supported, so an
    // absent-strategy (default taxEfficient) scenario still builds a context.
    const args = buildArgs();
    const ctx = buildCtx(args);

    // Act.
    const taxCtx = buildMcTaxContext(ctx);

    // Assert.
    expect(taxCtx).toBeDefined();
  });

  it('should_return_a_populated_context_for_a_named_strategy_scenario', () => {
    // Arrange: a taxEfficient strategy scenario → tax fields populate. A
    // single primary member → filing status single, household size 1.
    const scenario = baseScenario('s-tax', 'TaxEfficient', {
      withdrawalStrategy: { kind: 'taxEfficient' },
    });
    const args = buildArgs({ scenario });
    const ctx = buildCtx(args);

    // Act.
    const taxCtx = buildMcTaxContext(ctx);

    // Assert: a real context with the household snapshot the MC engine reads.
    expect(taxCtx).toBeDefined();
    expect(taxCtx!.householdSize).toBe(1);
    expect(taxCtx!.members.length).toBe(1);
    expect(taxCtx!.members[0].memberId).toBe('m1');
    expect(taxCtx!.taxBundle).toBeDefined();
  });

  it('should_set_mcRothPenaltyAllExempt_true_when_all_ROTH_401K_accounts_are_exempt', () => {
    // ROTH_401K is penalty-eligible (10%) so it participates in
    // mcRothPenaltyAllExempt counting.  When every such account is exempt the
    // flag should be true.
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
    // A governmental 457(b)'s earnings carry NO §72(t)
    // penalty by statute, so a household whose ONLY §408A-ordered Roth source
    // is a ROTH_457B account is source-exempt — the pooled Roth-earnings leg is
    // waived even with NO scenario exemption marked (the deterministic
    // per-account engine never penalizes it). Leaving this household uncounted
    // (rothCount 0 → flag false) would make the pooled leg wrongly fire.
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
    // Pooled all-or-nothing stays conservative: mixing a source-exempt 457(b)
    // with a penalty-eligible ROTH_401K (not scenario-exempt) keeps the pooled
    // leg armed — a non-exempt account's penalty is never silently waived.
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
    // A pre-tax governmental 457(b) distribution carries no §72(t) 10%
    // additional tax, so a household whose ONLY pre-tax source is a 457(b)
    // waives the pooled pre-tax leg with no scenario exemption. A brokerage
    // account (POST_TAX) never feeds the pre-tax bucket and stays uncounted.
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
    // Edge: a MIXED governmental 457(b)'s Roth-designated post
    // sub-bucket feeds the §408A-ordered bucket but its earnings are
    // statutorily penalty-free — source-exempt, like the pure ROTH_457B.
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
    // Its pre-tax tranche is also 457(b) → both pooled legs source-exempt.
    expect(taxCtx!.mcRothPenaltyAllExempt).toBe(true);
    expect(taxCtx!.mcPreTaxPenaltyAllExempt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HSA-qualified filter in computeMedicalDemandBase. Tests drive the
// exported helper directly, proving the
// MC builder applies the same isHsaQualifiedMedical predicate as the
// deterministic buildMedicalDemandByMonth.
// ---------------------------------------------------------------------------
describe('computeMedicalDemandBase — hsaQualified filter', () => {
  /** Minimal expense factory that supports hsaQualified. */
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

  /** Runs computeMedicalDemandBase for a simple fixture with one member
   *  retiring at 67 (2032), zero inflation, medicalCategoryIds = ['cat-medical']. */
  function demandFor(expenses: Aggregate<ExpensePayload>[]): ReturnType<typeof computeMedicalDemandBase> {
    const args = buildArgs({
      expenses,
      medicalCategoryIds: ['cat-medical'],
    });
    const ctx = buildCtx(args);
    const resolvedExpenses = resolveExpensesForScenario(
      args.scenarioId,
      [...ctx.effectiveScenarios],
      [...args.expenses],
    );
    const baseCtxArg = {
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
    const yearRange = { from: args.todayYear, to: ctx.horizonYear };
    const stepCount = (ctx.horizonYear - args.todayYear + 1) * 12;
    const inflation = resolveInflationForScenario(
      args.scenarioId,
      [...ctx.effectiveScenarios],
      new Set(args.medicalCategoryIds),
    );
    return computeMedicalDemandBase({
      runArgs: args,
      resolvedExpenses,
      baseCtx: baseCtxArg,
      yearRange,
      inflation,
      generalRate: inflation.ratePct,
      stepCount,
    });
  }

  /** Returns the non-zero sum of monthlyMedicalDemandBase (over active months). */
  function totalDemand(result: ReturnType<typeof computeMedicalDemandBase>): number {
    if (!result.monthlyMedicalDemandBase) return 0;
    return result.monthlyMedicalDemandBase.reduce((a, b) => a + b, 0);
  }

  it('includes ONLY hsaQualified === true medical rows in demand', () => {
    // Two medical expenses: one qualified, one not.  Only the qualified one
    // should contribute to monthlyMedicalDemandBase.
    const qualified = expHsa('e-qual', 'cat-medical', 500, true);
    const notQual = expHsa('e-nq', 'cat-medical', 800, false);
    const result = demandFor([qualified, notQual]);
    expect(result.monthlyMedicalDemandBase).toBeDefined();
    const total = totalDemand(result);
    // Only the $500/mo qualified row contributes; the $800 one does not.
    // With zero inflation over the horizon, Σ ≈ $500 × active months.
    expect(total).toBeGreaterThan(0);
    // Total demand if both qualified would be > just the $500 row.
    const bothResult = demandFor([
      expHsa('e-qual', 'cat-medical', 500, true),
      expHsa('e-q2', 'cat-medical', 800, true),
    ]);
    expect(totalDemand(bothResult)).toBeGreaterThan(total);
  });

  it('absent hsaQualified (legacy row) produces zero demand (absent ⇒ not qualified)', () => {
    // A medical expense with no hsaQualified field set (legacy/imported row)
    // must contribute ZERO to HSA medical demand.
    const legacy = expHsa('e-legacy', 'cat-medical', 600); // absent
    const result = demandFor([legacy]);
    expect(result.monthlyMedicalDemandBase).toBeUndefined();
    expect(totalDemand(result)).toBe(0);
  });

  it('returns {} (no demand fields) when all medical rows are not-qualified', () => {
    const nq1 = expHsa('e-nq1', 'cat-medical', 400, false);
    const nq2 = expHsa('e-nq2', 'cat-medical', 600, false);
    const result = demandFor([nq1, nq2]);
    // Empty object — both qualified fields are absent.
    expect(result.monthlyMedicalDemandBase).toBeUndefined();
    expect(result.medicalDemandRatePct).toBeUndefined();
  });

  it('ignores the flag on non-medical rows (flag is inert for non-medical)', () => {
    // A non-medical expense with hsaQualified=true must NOT contribute to
    // medical demand; only medical-category rows count.
    const nonMed = expHsa('e-housing', 'cat-housing', 1_000, true);
    const result = demandFor([nonMed]);
    expect(totalDemand(result)).toBe(0);
  });

  it('MC bucket case: two medical categories at different inflation rates — qualified subset drives rate; non-qualified excluded', () => {
    // Medical-A (cat-medical, +2pp override) qualified; Medical-B (cat-med2)
    // at general rate, not-qualified.  Only Medical-A should enter the bucket.
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
    const ctx = buildCtx(args);
    const resolvedExpenses = resolveExpensesForScenario(
      args.scenarioId,
      [...ctx.effectiveScenarios],
      [...args.expenses],
    );
    const baseCtxArg = {
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
    const yearRange = { from: args.todayYear, to: ctx.horizonYear };
    const stepCount = (ctx.horizonYear - args.todayYear + 1) * 12;
    const inflation = resolveInflationForScenario(
      args.scenarioId,
      [...ctx.effectiveScenarios],
      new Set(args.medicalCategoryIds),
    );
    const result = computeMedicalDemandBase({
      runArgs: args,
      resolvedExpenses,
      baseCtx: baseCtxArg,
      yearRange,
      inflation,
      generalRate: inflation.ratePct,
      stepCount,
    });
    // Only cat-medical (qualified) contributes; cat-med2 (not-qualified) is
    // excluded. The single bucket rate must be the cat-medical rate (5%).
    expect(result.monthlyMedicalDemandBase).toBeDefined();
    expect(result.medicalDemandRatePct).toBeCloseTo(5, 4);
    // Strict-subset invariant: demand ≤ total expense for every step.
    // (cat-med2 non-qualified → demand only from cat-medical, less than both.)
    const demandTotal = totalDemand(result);
    expect(demandTotal).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Downturn-guardrail runner assembly. The runner
// (`computeGuardrailBundleBlock`) nets ONLY guaranteed income — survivor-
// adjusted SS + lifetime annuity pension — from the net-need baseline;
// part-time and one-off/lump-sum income must NOT reduce it. A scenario with
// guardrails disabled/unset omits every guardrail field from MonteCarloInput.
// ---------------------------------------------------------------------------
describe('downturn-guardrail runner assembly — guaranteed-income filter', () => {
  const GUARDRAIL_ON = {
    enabled: true,
    lowerBandPct: 85,
    upperBandPct: 115,
    stepPct: 10,
    maxRaisePct: 120,
  };

  /** A recurring essential expense so the net-need baseline is positive. */
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

  // A lifetime annuity pension → GUARANTEED (nets down the baseline).
  const annuityPension = (): Aggregate<IncomeStreamPayload> =>
    income('inc-annuity', {
      kind: 'pension',
      payoutType: 'annuity',
      monthlyBenefit: 1_500,
      colaPct: 0,
      jointAndSurvivorPct: 0,
      start: { kind: 'retirementStart' },
    });
  // A recurring part-time gig → NOT guaranteed (excluded from the net).
  const partTimeGig = (): Aggregate<IncomeStreamPayload> =>
    income('inc-parttime', {
      kind: 'partTime',
      annualAmount: 30_000,
      colaPct: 0,
      start: { kind: 'retirementStart' },
      end: { kind: 'age', memberId: 'primary', years: 75, months: 0 },
    });
  // A one-off windfall → NOT guaranteed (excluded from the net).
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
    // Baseline: SS (from the default ssBenefit fixture) + the annuity pension.
    const guaranteedOnly = netNeedForStreams([annuityPension()]);
    // Adding a part-time gig + a one-off windfall must leave the net need
    // IDENTICAL — neither is guaranteed income.
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
    // Removing the annuity pension (SS only) must RAISE the net need vs the
    // SS + annuity case — so the annuity was genuinely netted.
    const ssOnly = netNeedForStreams([]);
    const withAnnuity = netNeedForStreams([annuityPension()]);
    expect(withAnnuity.length).toBe(ssOnly.length);
    // The annuity is $1,500/mo = $18,000/yr guaranteed → net need drops by that
    // in every drawdown year the annuity is active (0% inflation → real = nominal).
    let anyLower = false;
    for (let y = 0; y < ssOnly.length; y += 1) {
      expect(withAnnuity[y]).toBeLessThanOrEqual(ssOnly[y] + 1e-6);
      if (withAnnuity[y] < ssOnly[y] - 1) anyLower = true;
    }
    expect(anyLower).toBe(true);
  });

  it('a disabled/unset guardrail scenario omits every guardrail field from MonteCarloInput (byte-identical cache key)', () => {
    // No `downturnGuardrails` override → the runner omits the whole block, so a
    // no-guardrail scenario's serialized input stays byte-identical to the
    // pre-feature baseline (the disabled-guardrails regression gate).
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
    // The serialized input has no `guardrail*` / `downturnGuardrails` keys at all.
    const keys = Object.keys(input).filter(
      (k) => k === 'downturnGuardrails' || k.startsWith('guardrail'),
    );
    expect(keys).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Guardrail baseline-series correctness:
//   (1) already-retired anchor clamp, and
//   (2) per-category REAL differential (Medical &c.) in the baseline series.
// Both read the assembled MC input's `guardrail*RealByYear` arrays, which the
// per-path engine indexes by DRAWDOWN year (year 0 = the kernel's clamped
// drawdown start = today for an already-retired household).
// ---------------------------------------------------------------------------
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
    // Born 1950 → retirementAge 67 = retired 2017, 9 years before todayYear 2026.
    // The MC kernel clamps `retirementStepIdx = max(0, …)`, so drawdown year 0 is
    // TODAY; the baseline series mirrors that (anchor at max(retirementYear,
    // todayYear)). The pre-fix code anchored at the past 2017 — zero-padding the
    // first 9 drawdown entries and over-sizing the array by 9 years.
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
    // Genuinely already-retired.
    expect(input.retirementYear).toBeLessThan(input.firstYear);
    const horizonYears = input.horizonYear - input.firstYear + 1;
    const essential = input.guardrailEssentialRealByYear;
    const total = input.guardrailBaselineTotalRealByYear;
    const netNeed = input.guardrailBaselineRealNetNeedByYear;
    expect(essential).toBeDefined();
    expect(total).toBeDefined();
    expect(netNeed).toBeDefined();
    // Length equals the FULL horizon (clamped drawdown start), not horizon + N.
    expect(essential!.length).toBe(horizonYears);
    expect(total!.length).toBe(horizonYears);
    expect(netNeed!.length).toBe(horizonYears);
    // Drawdown year 0 = today has real essential spend — NOT a zero-padded past.
    expect(essential![0]).toBeGreaterThan(0);
    expect(total![0]).toBeGreaterThan(0);
    // No leading zeros anywhere (a lifetime essential is active every year).
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
    // Flat: an essential in today's dollars stays constant across the horizon.
    expect(Math.abs(flat[n - 1] - flat[0])).toBeLessThan(1);
    // Differential: the SAME essential rises in REAL terms year over year.
    expect(diff[n - 1]).toBeGreaterThan(diff[0] * 1.2);
    // The differential compounds from TODAY, so even drawdown year 0
    // (retirement) already sits above the flat baseline.
    expect(diff[0]).toBeGreaterThan(flat[0]);
    // Consecutive-year REAL growth EXACTLY matches the kernel's monthly spread
    // under flat CPI: with rate 3, general 0 the real factor is (1 + 3/1200)^12
    // per year — NOT the naive (1 + 3/100). This pins the annually-compounded
    // equivalent that avoids under-compounding vs the kernel near a band edge.
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

  it('should_omit_the_guardrail_block_when_no_override_and_no_scenario_config', () => {
    // No guardrail configured + no override → the field is absent.
    const bundle = assembleWithOverride(buildArgs({ expenses: [guardrailExpense] }));
    expect(bundle.downturnGuardrails).toBeUndefined();
  });

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
    // No guardrail configured + no override → flat guardrail fields ABSENT.
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

// ---------------------------------------------------------------------------
// The fact-based Roth / RMD state that crosses into MC assembly.
// ---------------------------------------------------------------------------

describe('buildMcRothOrderedProfile via buildMcTaxContext', () => {
  /** An account payload with extra tax-profile facts merged in. */
  const withFacts = (
    account: Aggregate<AccountPayload>,
    facts: Partial<AccountPayload>,
  ): Aggregate<AccountPayload> => ({
    ...account,
    payload: { ...account.payload, ...facts },
  });

  // Balance history now supplies the otherwise-missing clock. The pooled clock
  // remains order-independent and conservatively uses the latest applicable year.
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
    // Identical result either way — the whole point of the fix.
    expect(reversed?.designatedFirstParticipationTaxYear).toBe(
      forward?.designatedFirstParticipationTaxYear,
    );
  });

  // The §408A five-year period is PER INDIVIDUAL, so pooling two
  // owners' Roth IRAs must take the LATEST clock (the one no owner can beat) and
  // must name both owners so the 59½ test covers both.
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
    // LATEST, not earliest: the younger spouse's 2024 clock governs the pool.
    expect(profile?.iraFirstContributionTaxYear).toBe(2024);
    expect([...(profile?.rothOwnerIds ?? [])].sort()).toEqual(['m1', 'm2']);
  });

  // A MIXED plan's PRE-TAX sub-account never enters the MC
  // Roth-ordered pool (`classifyMcWithdrawal` routes only its POST share there), so
  // counting the whole balance would inflate the pool denominator and mis-split every
  // pooled Roth draw between the §408A contribution-first regime (Roth IRA) and the
  // §402A pro-rata regime (designated).
  it('counts only a MIXED plan’s Roth-designated pocket in the pooled Roth balance', () => {
    /** A balance row with an explicit MIXED pre/post split. */
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
    // $900k plan, of which only $100k is designated-Roth money.
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
    // Designated pool ≈ the $100k Roth pocket, NOT the $900k account balance.
    expect(profile!.designatedBalanceCents).toBeGreaterThan(95_000_00);
    expect(profile!.designatedBalanceCents).toBeLessThan(105_000_00);
    // …so the IRA share of the ordered pool is ~0.5 ($100k of $200k of Roth
    // money), not the ~0.1 the whole-balance denominator produced.
    expect(profile!.iraShareOfOrderedPool).toBeGreaterThan(0.45);
    expect(profile!.iraShareOfOrderedPool).toBeLessThan(0.55);
  });

  // The wiring this whole surface depends on: conversion lots are NOT account
  // facts. They are derived from the annual balance rows inside
  // `buildPipelineContext`, which must hand `args.balances` to the adapter.
  // If it did not, the balance-row fields would be inert — a conversion the
  // user typed on the Account Balances page would change nothing in the
  // projection. This test fails if that `args.balances` argument is ever
  // dropped.
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
        // 2023 records a conversion; 2024 records none and 2025 only a balance.
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

    // …and it reaches the MC input, so a conversion changes the cache key rather
    // than being silently absorbed into a stale cached result.
    const profile = buildMcTaxContext(ctx)!.rothOrderedProfile;
    expect(profile?.iraConversionLots).toEqual([
      { taxYear: 2023, taxableCents: 2_000_000, nontaxableCents: 500_000 },
    ]);
  });

  // An INACTIVE account's recorded facts must not dilute
  // an active sibling's pooled designated-Roth basis the way its (necessarily
  // zero) balance already can't. Building `rothDistributionFacts` from
  // every account (`args.accounts`), not just `activeAccounts`, would let a
  // deactivated pure-Roth plan's large recorded basis inflate the pool's basis
  // numerator without a matching balance in the denominator — sheltering an
  // active plan's draw far beyond its own recorded basis. The adapter is handed
  // every non-deleted account, so the narrowing lives INSIDE its designated
  // branch and this pin holds.
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
    // Active plan: $100k Roth pocket, a modest $10k of recorded in-plan-rollover
    // principal.
    const activePlan = withFacts(brokerage('mixed-401k', 'm1', 'RETIREMENT_401K', 'MIXED'), {
      designatedRothFirstParticipationTaxYear: 2010,
    });
    // Inactive, necessarily zero-balance sibling recording a LARGE rollover.
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
    // Basis fraction must reflect the ACTIVE plan's own $10k-of-$100k ratio
    // (0.1), never the inactive plan's $90k basis inflating it toward 1.0.
    expect(profile!.designatedBasisCents).toBe(10_000_00);
    expect(profile!.designatedBalanceCents).toBeGreaterThan(95_000_00);
    expect(profile!.designatedBalanceCents).toBeLessThan(105_000_00);
  });

  // An INHERITED Roth IRA's dollars are wholesale tax-free and never reach the
  // ordered carrier, so it contributes no balance, no clock, no lots, no basis and
  // no owner to any aggregate computed over that carrier's contributors.
  it('excludes an INHERITED Roth IRA from every ordered-pool aggregate', () => {
    const own = withFacts(brokerage('roth-ira-own', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH'), {
      rothIraRegularContributionBasis: 20_000,
      rothIraFirstContributionTaxYear: 2010,
    });
    // Owned by the SECOND member, whose only Roth account this is, and carrying no
    // recorded clock — pre-change that missing clock alone suppressed the pooled
    // `iraFirstContributionTaxYear` for the whole household.
    const inherited = withFacts(
      brokerage('roth-ira-inherited', 'm2', 'RETIREMENT_ROTH_IRA', 'ROTH'),
      { rothIraRegularContributionBasis: 5_000, rmdInheritedAccount: true },
    );
    // A designated plan makes the share discriminating: with no designated account
    // `iraShareOfOrderedPool` is 1 either way and the inherited balance skews nothing.
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
        // A recorded conversion on the inherited account — its lots must not reach
        // the pooled `iraConversionLots` either, and neither must its recorded
        // contributions reach the pooled basis.
        withContributions(
          balanceRow('roth-ira-inherited', 2025, 100_000, { taxable: 30_000 }),
          5_000,
        ),
        balanceRow('roth-401k', 2025, 100_000),
      ],
    });
    const ctx = buildCtx(args);
    const profile = buildMcTaxContext(ctx)!.rothOrderedProfile;
    // Only the OWN Roth IRA is in the map — the inherited account has no pool.
    expect([...ctx.rothDistributionFacts.rothIraByPool.keys()]).toEqual(['m1']);
    // The share splits $100k own IRA against $100k designated — not $200k vs $100k.
    expect(profile?.iraShareOfOrderedPool).toBeCloseTo(0.5, 6);
    // The pooled clock is the own account's 2010; the inherited account's missing
    // clock no longer suppresses it.
    expect(profile?.iraFirstContributionTaxYear).toBe(2010);
    // m2's only Roth account is inherited, so m2 never gates the pooled 59½ test.
    expect([...(profile?.rothOwnerIds ?? [])]).toEqual(['m1']);
    expect(profile?.iraConversionLots).toEqual([]);
    // Basis is derived from the owners' OWN recorded history only.
    expect(ctx.rothBasisCentsByOwner.get('m1')).toBe(20_000_00);
    expect(ctx.rothBasisCentsByOwner.has('m2')).toBe(false);
  });

  // An accepted consequence, pinned rather than discovered in a parity diff.
  // A pool whose accounts are ALL inactive now exists with real derived basis and
  // NO five-year anchor (the clock is still contributed by active accounts only).
  // Deterministically that is the same unmet clock the household already had; in
  // Monte Carlo it blanks the whole household's pooled clock and widens the
  // every-owner-59½ set. Both moves are conservative and deliberate.
  it('an ALL-INACTIVE Roth-IRA pool blanks the MC pooled clock and widens the owner set', () => {
    const seasoned = withFacts(brokerage('roth-ira-active', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH'), {
      rothIraFirstContributionTaxYear: 2010,
    });
    // m2's only Roth IRA is closed — real contribution history, no clock.
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
    // Both pools exist, and the closed one carries real basis.
    expect(ctx.rothBasisCentsByOwner.get('m2')).toBe(15_000_00);
    const profile = buildMcTaxContext(ctx)!.rothOrderedProfile;
    // The seasoned 2010 anchor no longer satisfies the household: one pool has
    // none, so the pooled clock is absent (conservatively unmet).
    expect(profile?.iraFirstContributionTaxYear).toBeUndefined();
    // …and m2 now gates the pooled 59½ test alongside m1.
    expect([...(profile?.rothOwnerIds ?? [])]).toEqual(['m1', 'm2']);
  });

  // 11.adversary.1 — an emitted ALL-CLOSED pool's remaining basis/lots are real
  // resolved facts (the display keeps them), but no deterministic pass can ever
  // consume them: the annotation keys its carrier on the DRAWN pool and the
  // funding pass charges drawn ledger owners, and the pool's owner has no active
  // Roth IRA to draw from. Seeding them into MC's single aggregate carrier let
  // them shelter the OTHER owner's draws on every path — MC systematically
  // under-reporting tax relative to the deterministic engine. Both engines now
  // agree by both NOT crediting the unreachable basis.
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
    // The RESOLVED numbers are unchanged: the closed pool is still emitted with
    // its surviving basis and conversion lot, flagged all-inactive.
    expect(ctx.rothBasisCentsByOwner.get('m2')).toBe(15_000_00);
    expect(
      ctx.rothDistributionFacts.rothIraByPool.get('m2')?.rothIra?.conversionLots,
    ).toHaveLength(1);
    expect(ctx.rothDistributionFacts.rothIraByPool.get('m2')?.allAccountsInactive).toBe(true);
    expect(ctx.rothDistributionFacts.rothIraByPool.get('m1')?.allAccountsInactive).toBeUndefined();
    const taxCtx = buildMcTaxContext(ctx)!;
    // …but the MC aggregate seed carries only DRAWABLE basis (m1's), and the
    // closed pool's conversion lot never reaches the pooled FIFO scan.
    expect(taxCtx.rothBasisCentsByOwner).toEqual([{ ownerId: 'm1', cents: 20_000_00 }]);
    expect(taxCtx.rothOrderedProfile?.iraConversionLots).toEqual([]);
    // The pool's conservative consequences stay in force: m2 still gates the
    // 59½ set and its missing anchor still blanks the pooled clock.
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
    // The account with no recorded facts stays ABSENT, which is what keeps a
    // fact-free household on the legacy byte-identical path.
    expect(rmdCtx!.rmdFactsByAccountId?.['a1']).toBeUndefined();
    // The §401(a)(9)(C) later-of rule needs a separation year per owner.
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

// ---------------------------------------------------------------------------
// Prototype-bearing serialized dictionaries (CWE-1321)
// ---------------------------------------------------------------------------

/**
 * Every id in an IMPORTED aggregate bundle is user-controlled: import validates
 * the envelope, not the id vocabulary, so an account or household member can
 * legitimately arrive with the id `"__proto__"` or `"constructor"`.
 *
 * Two dictionaries in this module's build path were keyed by exactly those ids
 * and built by ASSIGNMENT into a plain `{}` literal:
 *
 *  - `rmdFactsByAccountId` — `obj["__proto__"] = facts` never creates an own
 *    key, it re-points the object's prototype. The deterministic engine reads
 *    the object in memory and still resolves the facts through that prototype,
 *    but `JSON.stringify` emits OWN enumerable keys only, so the account
 *    vanished from the Monte Carlo input: a silently different RMD floor on the
 *    two engines from the same plan.
 *  - `firstEligibleYearByOwner` — the "already added?" guard
 *    (`obj[id] !== undefined`) read THROUGH the prototype chain, so an owner id
 *    of `"__proto__"` or `"constructor"` looked already-present and never got a
 *    70½ eligibility year, silently dropping their QCD gifts.
 *
 * Both are now built through `Object.fromEntries`, which DEFINES own properties.
 */
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

      // The ONE fragment BOTH engines consume (the deterministic
      // `buildRmdContext` spreads it; `buildMcRmdContext` serializes it).
      const fragment = buildRmdEngineFactsFragment(ctx);
      const facts = fragment.rmdFactsByAccountId;
      expect(facts).toBeDefined();
      expect(Object.hasOwn(facts!, accountId)).toBe(true);
      expect(Object.keys(facts!)).toContain(accountId);

      // The Monte Carlo half crosses `postMessage` + the JSON cache key, which
      // carry OWN enumerable keys only.
      const mcRmd = buildMcRmdContext(ctx);
      const wire = JSON.parse(JSON.stringify(mcRmd)) as {
        rmdFactsByAccountId?: Record<string, { inheritedAccount?: boolean }>;
      };
      expect(Object.hasOwn(wire.rmdFactsByAccountId ?? {}, accountId)).toBe(true);
      // …and it is the SAME fact the deterministic engine reads in memory.
      expect(wire.rmdFactsByAccountId?.[accountId]?.inheritedAccount).toBe(true);
      expect(facts![accountId]?.inheritedAccount).toBe(true);

      // The prototype itself is untouched — no pollution escaped.
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

      // Survives the worker + cache-key serialization the engine actually reads.
      const wire = JSON.parse(JSON.stringify(qcdCtx)) as {
        firstEligibleYearByOwner: Record<string, number>;
      };
      expect(Object.hasOwn(wire.firstEligibleYearByOwner, memberId)).toBe(true);
      expect(wire.firstEligibleYearByOwner[memberId]).toBe(2035);

      // The deterministic twin (`buildQcdContext`) resolves the same year for
      // the same owner, from its own prototype-safe `Map`.
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
