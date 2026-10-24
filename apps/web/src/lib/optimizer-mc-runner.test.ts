// Fake `MinimalMcWorker`s record posted inputs and reply with a deterministic success probability.
// Most cases pin `concurrency: 1` because they share one fake across the pool.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OPTIMIZER_MC_DEFAULT_PATH_COUNT } from './optimizer-mc-runner';
import { OPTIMIZER_MC_SEED } from './balance-projection-runner-mc';
import { runBalanceProjectionMc } from './balance-projection-runner';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';
import type { ScenarioAggregate } from './scenario-resolution';
import type { MonteCarloInput, MonteCarloSummary } from './monte-carlo';

vi.mock('../workers/monte-carlo.worker.ts?worker', () => {
  class StubWorker {
    addEventListener(): void {}
    removeEventListener(): void {}
    postMessage(): void {}
    terminate(): void {}
  }
  return { default: StubWorker };
});

const runMonteCarloSpy = vi.fn();
vi.mock('./monte-carlo', async () => {
  const actual = await vi.importActual<typeof import('./monte-carlo')>('./monte-carlo');
  return {
    ...actual,
    runMonteCarlo: (...args: unknown[]) => {
      runMonteCarloSpy(...args);
      return actual.runMonteCarlo(args[0] as MonteCarloInput);
    },
  };
});

const TODAY = new Date('2026-06-15T00:00:00Z');

type MinimalMcWorker = ReturnType<
  NonNullable<Parameters<typeof import('./optimizer-mc-runner').runOptimizerMonteCarlo>[0]['workerFactory']>
>;

// The outcome cache is module state, so every case imports a fresh copy.
async function freshRunner(): Promise<typeof import('./optimizer-mc-runner').runOptimizerMonteCarlo> {
  vi.resetModules();
  return (await import('./optimizer-mc-runner')).runOptimizerMonteCarlo;
}

let runOptimizerMonteCarlo: Awaited<ReturnType<typeof freshRunner>>;

beforeEach(async () => {
  runOptimizerMonteCarlo = await freshRunner();
});

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
    updatedAt: '2026-05-19T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'householdMember',
    payload: {
      isPrimary,
      firstName: isPrimary ? 'Alex' : 'Sam',
      lastName: 'Doe',
      email: '',
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
    updatedAt: '2026-05-19T00:00:00Z',
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

function brokerage(ownerId: string): Aggregate<AccountPayload> {
  return {
    id: 'a1',
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-19T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'account',
    payload: {
      name: 'Brokerage',
      type: 'BROKERAGE',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'POST_TAX',
      ownerId,
      institution: 'Vanguard',
      notes: '',
      planningReturnPct: 5,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
    },
  };
}

function balanceRow(endingBalance: number): Aggregate<AccountBalancePayload> {
  return {
    id: 'b1',
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-19T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'accountBalance',
    payload: {
      accountId: 'a1',
      year: 2025,
      lastUpdated: '2025-12-31',
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

function scenarioFixture(id: string): ScenarioAggregate {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-19T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'scenario',
    payload: {
      name: id,
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides: {
        socialSecurity: { primary: { ageYears: 67, ageMonths: 0 } },
        retirementAge: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
        },
        inflation: { ratePct: 0 },
        lifeExpectancy: { primary: 90 },
      },
    },
  };
}

interface FakeWorker extends MinimalMcWorker {
  readonly postedInputs: ReadonlyArray<MonteCarloInput>;
  readonly terminateCount: number;
}

function buildFakeSummary(
  input: MonteCarloInput,
  successProbability: number,
): MonteCarloSummary {
  return {
    engineVersion: 4,
    seed: input.seed,
    pathCount: input.pathCount,
    computedAt: 0,
    firstYear: input.firstYear,
    horizonYears: input.horizonYear - input.firstYear + 1,
    percentilesNominal: { p10: [], p25: [], p50: [] },
    percentilesReal: { p10: [], p25: [], p50: [] },
    successProbability,
    medianDepletionYear: null,
    p10DepletionYear: null,
    p25DepletionYear: null,
    medianEndingBalanceNominal: 0,
    medianEndingBalanceReal: 0,
    p10EndingBalanceNominal: 0,
    p10EndingBalanceReal: 0,
    p25EndingBalanceNominal: 0,
    p25EndingBalanceReal: 0,
    failureYearHistogram: [],
    endingBalanceHistogramNominal: [],
    endingBalanceHistogramReal: [],
    plannedOverlay: [],
  } satisfies MonteCarloSummary;
}

function makeFakeWorker(
  summaryFor: (input: MonteCarloInput) => number,
  progressDone?: number,
): FakeWorker {
  const listeners = new Set<(ev: MessageEvent) => void>();
  const posted: MonteCarloInput[] = [];
  let terminate = 0;
  return {
    get postedInputs() {
      return posted;
    },
    get terminateCount() {
      return terminate;
    },
    addEventListener(t, fn) {
      // The pool now also registers an `error` listener; this fake only
      // emits `message` events, so keep the error listener out of the set.
      if (t !== 'error') listeners.add(fn);
    },
    removeEventListener(t, fn) {
      if (t !== 'error') listeners.delete(fn);
    },
    postMessage(msg: unknown) {
      const m = msg as { kind: 'run'; input: MonteCarloInput };
      posted.push(m.input);
      const fakeSummary = buildFakeSummary(m.input, summaryFor(m.input));
      setTimeout(() => {
        if (progressDone != null) {
          const pev = {
            data: { kind: 'progress', done: progressDone, total: m.input.pathCount },
          } as MessageEvent;
          listeners.forEach((fn) => fn(pev));
        }
        const ev = { data: { kind: 'result', summary: fakeSummary } } as MessageEvent;
        listeners.forEach((fn) => fn(ev));
      }, 0);
    },
    terminate() {
      terminate += 1;
    },
  };
}

function makeProgressFakeWorker(
  summaryFor: (input: MonteCarloInput) => number,
  progressDone: number,
): FakeWorker {
  return makeFakeWorker(summaryFor, progressDone);
}

const PIA_HIGH = 3500;
const SINGLE_SCENARIO_GRID_PAIRS = 9; // 62..70

describe('runOptimizerMonteCarlo', () => {
  it('should_post_one_run_message_per_candidate_pair_per_scenario', async () => {
    const members = [member('m1', true, 1965)];
    const ss = [ssBenefit('m1', PIA_HIGH)];
    const accounts = [brokerage('m1')];
    const balances = [balanceRow(800_000)];
    const scenarios = [scenarioFixture('s1'), scenarioFixture('s2')];
    const fake = makeFakeWorker(() => 0.5);
    await runOptimizerMonteCarlo({
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      today: TODAY,
      concurrency: 1,
      workerFactory: () => fake,
    });
    expect(fake.postedInputs.length).toBe(
      scenarios.length * SINGLE_SCENARIO_GRID_PAIRS,
    );
  });

  it('should_accumulate_max_success_probability_per_scenario', async () => {
    const members = [member('m1', true, 1965)];
    const ss = [ssBenefit('m1', PIA_HIGH)];
    const accounts = [brokerage('m1')];
    const balances = [balanceRow(800_000)];
    const scenarios = [scenarioFixture('s1')];
    let call = 0;
    const fake = makeFakeWorker(() => {
      call += 1;
      return 0.5 + call * 0.01;
    });
    const result = await runOptimizerMonteCarlo({
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      today: TODAY,
      concurrency: 1,
      workerFactory: () => fake,
    });
    const outcome = result.get('s1');
    expect(outcome).not.toBeUndefined();
    if (outcome?.kind !== 'result') throw new Error('expected result');
    expect(outcome.winner?.primaryAgeYears).toBe(70);
  });

  it('should_propagate_progress_callback_in_iteration_order', async () => {
    const members = [member('m1', true, 1965)];
    const ss = [ssBenefit('m1', PIA_HIGH)];
    const accounts = [brokerage('m1')];
    const balances = [balanceRow(800_000)];
    const scenarios = [scenarioFixture('s1')];
    const onProgress = vi.fn();
    const fake = makeFakeWorker(() => 0.5);
    await runOptimizerMonteCarlo({
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      today: TODAY,
      concurrency: 1,
      workerFactory: () => fake,
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledTimes(SINGLE_SCENARIO_GRID_PAIRS);
    expect(onProgress.mock.calls[0][0].pairIdx).toBe(1);
    expect(onProgress.mock.calls[8][0].pairIdx).toBe(9);
    expect(onProgress.mock.calls[0][0].totals).toEqual({
      scenarios: 1,
      pairs: SINGLE_SCENARIO_GRID_PAIRS,
      totalPairs: SINGLE_SCENARIO_GRID_PAIRS,
    });
    expect(onProgress.mock.calls[0][0].cumulativeIdx).toBe(1);
    expect(onProgress.mock.calls[8][0].cumulativeIdx).toBe(
      SINGLE_SCENARIO_GRID_PAIRS,
    );
  });

  it('should_roll_worker_path_progress_into_smooth_per_scenario_progress', async () => {
    const members = [member('m1', true, 1965)];
    const ss = [ssBenefit('m1', PIA_HIGH)];
    const accounts = [brokerage('m1')];
    const balances = [balanceRow(800_000)];
    const scenarios = [scenarioFixture('s1')];
    const onScenarioProgress = vi.fn();
    const fake = makeProgressFakeWorker(() => 0.5, 500);
    await runOptimizerMonteCarlo({
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      today: TODAY,
      concurrency: 1,
      workerFactory: () => fake,
      onScenarioProgress,
    });
    const pathCount = OPTIMIZER_MC_DEFAULT_PATH_COUNT;
    const total = SINGLE_SCENARIO_GRID_PAIRS * pathCount;
    expect(onScenarioProgress).toHaveBeenCalledTimes(SINGLE_SCENARIO_GRID_PAIRS);
    expect(onScenarioProgress.mock.calls[0]).toEqual(['s1', { done: 500, total }]);
    expect(onScenarioProgress.mock.calls[8]).toEqual([
      's1',
      { done: 8 * pathCount + 500, total },
    ]);
    const dones = onScenarioProgress.mock.calls.map((c) => c[1].done as number);
    for (let i = 1; i < dones.length; i += 1) {
      expect(dones[i]).toBeGreaterThan(dones[i - 1]);
    }
    expect(dones[dones.length - 1]).toBeLessThanOrEqual(total);
  });

  it('should_terminate_worker_and_resolve_partial_on_abort', async () => {
    const members = [member('m1', true, 1965)];
    const ss = [ssBenefit('m1', PIA_HIGH)];
    const accounts = [brokerage('m1')];
    const balances = [balanceRow(800_000)];
    const scenarios = [scenarioFixture('s1')];
    const controller = new AbortController();
    const fake = makeFakeWorker(() => {
      queueMicrotask(() => controller.abort());
      return 0.5;
    });
    const result = await runOptimizerMonteCarlo({
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      today: TODAY,
      concurrency: 1,
      workerFactory: () => fake,
      signal: controller.signal,
    });
    expect(fake.terminateCount).toBeGreaterThan(0);
    // The partial accumulator may be empty if the abort fired before the first reply.
    expect(result).toBeInstanceOf(Map);
  });

  it('should_match_runBalanceProjectionMc_assembly_for_BPP_equivalence', async () => {
    const members = [member('m1', true, 1965)];
    const ss = [ssBenefit('m1', PIA_HIGH)];
    const accounts = [brokerage('m1')];
    const balances = [balanceRow(800_000)];
    const scenarios = [scenarioFixture('s1')];
    const fake = makeFakeWorker(() => 0.5);
    await runOptimizerMonteCarlo({
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      today: TODAY,
      concurrency: 1,
      workerFactory: () => fake,
    });
    const expected = runBalanceProjectionMc({
      scenarioId: 's1',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(),
      todayMonthIndex: TODAY.getUTCMonth(),
      candidateOverlay: {
        socialSecurity: { primary: { ageYears: 62, ageMonths: 0 } },
      },
    });
    const first = fake.postedInputs[0];
    expect(first.portfolioToday).toBe(expected.portfolioToday);
    expect(first.firstYear).toBe(expected.firstYear);
    expect(first.retirementYear).toBe(expected.retirementYear);
    expect(first.horizonYear).toBe(expected.horizonYear);
    expect(first.ssByYear).toEqual(expected.ssByYear);
    expect(first.monthlyExpenseBase).toEqual(expected.monthlyExpenseBase);
    for (const input of fake.postedInputs) {
      expect(input.seed).toBe(OPTIMIZER_MC_SEED);
      expect(input.pathCount).toBe(OPTIMIZER_MC_DEFAULT_PATH_COUNT);
    }
  });

  it('should_emit_empty_no_primary_member_when_no_primary_member', async () => {
    const members = [member('m2', false, 1965)];
    const ss = [ssBenefit('m2', PIA_HIGH)];
    const scenarios = [scenarioFixture('s1'), scenarioFixture('s2')];
    const fake = makeFakeWorker(() => 0.5);
    const result = await runOptimizerMonteCarlo({
      scenarios,
      accounts: [],
      balances: [],
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      today: TODAY,
      concurrency: 1,
      workerFactory: () => fake,
    });
    expect(result.get('s1')).toEqual({
      kind: 'empty',
      reason: 'no-primary-member',
    });
    expect(result.get('s2')).toEqual({
      kind: 'empty',
      reason: 'no-primary-member',
    });
    expect(fake.postedInputs.length).toBe(0);
  });

  it('should_emit_empty_no_retirement_date_when_household_state_is_empty', async () => {
    const noBirthdate: Aggregate<HouseholdMemberPayload> = {
      ...member('m1', true, 1965),
      payload: { ...member('m1', true, 1965).payload, birthdate: '' },
    };
    const ss = [ssBenefit('m1', PIA_HIGH)];
    const scenarios = [scenarioFixture('s1')];
    const fake = makeFakeWorker(() => 0.5);
    const result = await runOptimizerMonteCarlo({
      scenarios,
      accounts: [],
      balances: [],
      members: [noBirthdate],
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      today: TODAY,
      concurrency: 1,
      workerFactory: () => fake,
    });
    expect(result.get('s1')).toEqual({
      kind: 'empty',
      reason: 'no-retirement-date',
    });
    expect(fake.postedInputs.length).toBe(0);
  });

  it('should_emit_empty_no_retirement_date_for_scenario_without_resolved_retirement_age', async () => {
    // Pre-fix, buildTriples pre-seeded `pastWindowOrMissingPia` here; the per-scenario probe now routes through no-retirement-date.
    const members = [member('m1', true, 1965)];
    const ss = [ssBenefit('m1', null)];
    const noRetirementAge: ScenarioAggregate = {
      ...scenarioFixture('s1'),
      payload: {
        ...scenarioFixture('s1').payload,
        overrides: {
          socialSecurity: { primary: { ageYears: 67, ageMonths: 0 } },
          inflation: { ratePct: 0 },
          lifeExpectancy: { primary: 90 },
        },
      },
    };
    const fake = makeFakeWorker(() => 0.5);
    const result = await runOptimizerMonteCarlo({
      scenarios: [noRetirementAge],
      accounts: [],
      balances: [],
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      today: TODAY,
      concurrency: 1,
      workerFactory: () => fake,
    });
    expect(result.get('s1')).toEqual({
      kind: 'empty',
      reason: 'no-retirement-date',
    });
    expect(fake.postedInputs.length).toBe(0);
  });

  it('should_emit_cancelled_outcome_for_unprocessed_scenarios_on_abort', async () => {
    // An aborted scenario with no winner is `cancelled`, not `winner: null`, which the page renders as past-window.
    const members = [member('m1', true, 1965)];
    const ss = [ssBenefit('m1', PIA_HIGH)];
    const accounts = [brokerage('m1')];
    const balances = [balanceRow(800_000)];
    const scenarios = [scenarioFixture('s1'), scenarioFixture('s2')];
    const controller = new AbortController();
    controller.abort();
    const fake = makeFakeWorker(() => 0.5);
    const result = await runOptimizerMonteCarlo({
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      today: TODAY,
      concurrency: 1,
      workerFactory: () => fake,
      signal: controller.signal,
    });
    expect(result.get('s1')).toEqual({ kind: 'cancelled' });
    expect(result.get('s2')).toEqual({ kind: 'cancelled' });
  });

  it('should_NOT_construct_a_worker_when_signal_pre_aborted', async () => {
    const members = [member('m1', true, 1965)];
    const ss = [ssBenefit('m1', PIA_HIGH)];
    const accounts = [brokerage('m1')];
    const balances = [balanceRow(800_000)];
    const scenarios = [scenarioFixture('s1')];
    const controller = new AbortController();
    controller.abort();
    const factorySpy = vi.fn(() => makeFakeWorker(() => 0.5));
    await runOptimizerMonteCarlo({
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      today: TODAY,
      concurrency: 1,
      workerFactory: factorySpy,
      signal: controller.signal,
    });
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it('should_NOT_call_runMonteCarlo_on_the_main_thread', async () => {
    runMonteCarloSpy.mockClear();
    const members = [member('m1', true, 1965)];
    const ss = [ssBenefit('m1', PIA_HIGH)];
    const accounts = [brokerage('m1')];
    const balances = [balanceRow(800_000)];
    const scenarios = [scenarioFixture('s1')];
    const fake = makeFakeWorker(() => 0.5);
    await runOptimizerMonteCarlo({
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      today: TODAY,
      concurrency: 1,
      workerFactory: () => fake,
    });
    expect(runMonteCarloSpy).not.toHaveBeenCalled();
  });

  it('should_thread_retirementAllocation_assetMixSeries_into_posted_input', async () => {
    // Regression: assetMixSeries was null even with a retirementAllocation, so success probability ignored glide paths.
    const members = [member('m1', true, 1965)];
    const ss = [ssBenefit('m1', PIA_HIGH)];
    const accounts = [brokerage('m1')];
    const balances = [balanceRow(800_000)];
    const scenarioWithGlide: ScenarioAggregate = {
      ...scenarioFixture('glide'),
      payload: {
        ...scenarioFixture('glide').payload,
        overrides: {
          ...scenarioFixture('glide').payload.overrides,
          retirementAllocation: {
            growthRatePct: 7,
            incomeRatePct: 3,
            startGrowthPct: 70,
            endGrowthPct: 30,
            endYear: 2045,
            glideStartYear: 2032,
            incomeOnlyYear: null,
          },
        },
      },
    };
    const fake = makeFakeWorker(() => 0.75);
    await runOptimizerMonteCarlo({
      scenarios: [scenarioWithGlide],
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      today: TODAY,
      concurrency: 1,
      workerFactory: () => fake,
    });
    expect(fake.postedInputs.length).toBeGreaterThan(0);
    for (const input of fake.postedInputs) {
      const hasGlideSeries = input.accountMcLedger.some(
        (e) => e.assetMixSeries !== null,
      );
      expect(hasGlideSeries).toBe(true);
    }
  });

  it('should_post_success_only_inputs_so_the_worker_skips_runPlannedOverlay', async () => {
    const members = [member('m1', true, 1965)];
    const ss = [ssBenefit('m1', PIA_HIGH)];
    const accounts = [brokerage('m1')];
    const balances = [balanceRow(800_000)];
    const scenarios = [scenarioFixture('s1')];
    const fake = makeFakeWorker(() => 0.5);
    await runOptimizerMonteCarlo({
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      today: TODAY,
      concurrency: 1,
      workerFactory: () => fake,
    });
    expect(fake.postedInputs.length).toBeGreaterThan(0);
    for (const input of fake.postedInputs) {
      expect(input.successOnly).toBe(true);
    }
  });

  it('should_hit_the_session_cache_on_a_repeat_run_with_identical_inputs', async () => {
    const members = [member('m1', true, 1965)];
    const ss = [ssBenefit('m1', PIA_HIGH)];
    const accounts = [brokerage('m1')];
    const balances = [balanceRow(800_000)];
    const scenarios = [scenarioFixture('s1')];
    const runOnce = async () => {
      const fake = makeFakeWorker((input) => successFromInput(input));
      const result = await runOptimizerMonteCarlo({
        scenarios,
        accounts,
        balances,
        members,
        ssBenefits: ss,
        expenses: [],
        incomeStreams: [],
        today: TODAY,
        concurrency: 1,
        workerFactory: () => fake,
      });
      return { posted: fake.postedInputs.length, outcome: result.get('s1') };
    };
    const first = await runOnce();
    expect(first.posted).toBe(SINGLE_SCENARIO_GRID_PAIRS);
    const second = await runOnce();
    expect(second.posted).toBe(0);
    expect(second.outcome).toEqual(first.outcome);
  });

  it('should_miss_the_session_cache_when_an_optimizer_relevant_input_changes', async () => {
    const members = [member('m1', true, 1965)];
    const ss = [ssBenefit('m1', PIA_HIGH)];
    const accounts = [brokerage('m1')];
    const balances = [balanceRow(800_000)];
    const scenarios = [scenarioFixture('s1')];
    const base = {
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      today: TODAY,
      concurrency: 1,
    } as const;
    const fake1 = makeFakeWorker(() => 0.5);
    await runOptimizerMonteCarlo({ ...base, workerFactory: () => fake1 });
    expect(fake1.postedInputs.length).toBe(SINGLE_SCENARIO_GRID_PAIRS);
    const fake2 = makeFakeWorker(() => 0.5);
    await runOptimizerMonteCarlo({
      ...base,
      pathCount: 5000,
      workerFactory: () => fake2,
    });
    expect(fake2.postedInputs.length).toBe(SINGLE_SCENARIO_GRID_PAIRS);
    const fake3 = makeFakeWorker(() => 0.5);
    await runOptimizerMonteCarlo({
      ...base,
      balances: [balanceRow(900_000)],
      workerFactory: () => fake3,
    });
    expect(fake3.postedInputs.length).toBe(SINGLE_SCENARIO_GRID_PAIRS);
  });

  it('should_miss_the_session_cache_when_medicalCategoryIds_changes (FNV signature)', async () => {
    const base = {
      scenarios: [scenarioFixture('s1')],
      accounts: [brokerage('m1')],
      balances: [balanceRow(800_000)],
      members: [member('m1', true, 1965)],
      ssBenefits: [ssBenefit('m1', PIA_HIGH)],
      expenses: [],
      incomeStreams: [],
      today: TODAY,
      concurrency: 1,
    } as const;
    const fake1 = makeFakeWorker(() => 0.5);
    await runOptimizerMonteCarlo({
      ...base,
      medicalCategoryIds: ['cat-medical'],
      workerFactory: () => fake1,
    });
    expect(fake1.postedInputs.length).toBe(SINGLE_SCENARIO_GRID_PAIRS);
    const fake2 = makeFakeWorker(() => 0.5);
    await runOptimizerMonteCarlo({
      ...base,
      medicalCategoryIds: ['cat-medical', 'cat-dental'],
      workerFactory: () => fake2,
    });
    expect(fake2.postedInputs.length).toBe(SINGLE_SCENARIO_GRID_PAIRS);
  });

  it('should_cap_the_session_cache_at_500_entries_with_LRU_eviction', { timeout: 60_000 }, async () => {
    const CACHE_CAP = 500;
    const members = [member('m1', true, 1965)];
    const ss = [ssBenefit('m1', PIA_HIGH)];
    const accounts = [brokerage('m1')];
    // A cache hit posts nothing. A large candidate step keeps the grid tiny so 500+ sweeps stay fast.
    const runWithBalance = async (i: number): Promise<number> => {
      const fake = makeFakeWorker(() => 0.5);
      await runOptimizerMonteCarlo({
        scenarios: [scenarioFixture('s1')],
        accounts,
        balances: [balanceRow(100_000 + i)],
        members,
        ssBenefits: ss,
        expenses: [],
        incomeStreams: [],
        today: TODAY,
        candidateStepYears: 100,
        concurrency: 1,
        workerFactory: () => fake,
      });
      return fake.postedInputs.length;
    };
    for (let i = 0; i < CACHE_CAP + 5; i += 1) await runWithBalance(i);
    expect(await runWithBalance(5)).toBe(0);
    expect(await runWithBalance(4)).toBeGreaterThan(0);
  });
});

interface FakeFactory {
  readonly factory: () => MinimalMcWorker;
  readonly postedCount: number;
  readonly terminateCount: number;
}

function makeFakeFactory(
  summaryFor: (input: MonteCarloInput) => number,
  progressDone?: number,
): FakeFactory {
  let posted = 0;
  let terminate = 0;
  const tally = {
    get postedCount() {
      return posted;
    },
    get terminateCount() {
      return terminate;
    },
    factory(): MinimalMcWorker {
      const listeners = new Set<(ev: MessageEvent) => void>();
      return {
        addEventListener(t, fn) {
          if (t !== 'error') listeners.add(fn);
        },
        removeEventListener(t, fn) {
          if (t !== 'error') listeners.delete(fn);
        },
        postMessage(msg: unknown) {
          const m = msg as { kind: 'run'; input: MonteCarloInput };
          posted += 1;
          const summary = buildFakeSummary(m.input, summaryFor(m.input));
          setTimeout(() => {
            if (progressDone != null) {
              const pev = {
                data: { kind: 'progress', done: progressDone, total: m.input.pathCount },
              } as MessageEvent;
              listeners.forEach((fn) => fn(pev));
            }
            const ev = { data: { kind: 'result', summary } } as MessageEvent;
            listeners.forEach((fn) => fn(ev));
          }, 0);
        },
        terminate() {
          terminate += 1;
        },
      };
    },
  };
  return tally;
}

function successFromInput(input: MonteCarloInput): number {
  const sum = input.ssByYear.reduce((a, b) => a + b, 0);
  return (sum % 99_991) / 99_991;
}

describe('runOptimizerMonteCarlo — stored month-level claim age', () => {
  const members = [member('m1', true, 1965)];
  const scenarioWithMonths = (): ScenarioAggregate => {
    const sc = scenarioFixture('s1');
    sc.payload.overrides.socialSecurity = { primary: { ageYears: 66, ageMonths: 4 } };
    return sc;
  };
  const GRID_PLUS_STORED = SINGLE_SCENARIO_GRID_PAIRS + 1;
  const run = (
    summaryFor: (call: number) => number,
    extra: Partial<Parameters<typeof runOptimizerMonteCarlo>[0]> = {},
  ) => {
    let call = 0;
    const fake = makeFakeWorker(() => summaryFor((call += 1)));
    return {
      fake,
      done: runOptimizerMonteCarlo({
        scenarios: [scenarioWithMonths()],
        accounts: [brokerage('m1')],
        balances: [balanceRow(800_000)],
        members,
        ssBenefits: [ssBenefit('m1', PIA_HIGH)],
        expenses: [],
        incomeStreams: [],
        today: TODAY,
        concurrency: 1,
        workerFactory: () => fake,
        ...extra,
      }),
    };
  };

  it('captures the baseline at the stored pair (not the rounded year) and counts the extra triple', async () => {
    const progress: Array<{ cumulativeIdx: number; pairs: number; totalPairs: number }> = [];
    const { fake, done } = run((n) => (n === GRID_PLUS_STORED ? 0.4 : 0.5), {
      onProgress: (p) =>
        progress.push({ cumulativeIdx: p.cumulativeIdx, ...p.totals }),
    });
    const outcome = (await done).get('s1');
    if (outcome?.kind !== 'result') throw new Error('expected result');
    expect(fake.postedInputs).toHaveLength(GRID_PLUS_STORED);
    expect(outcome.baselineMetricValue).toBe(0.4);
    expect(outcome.alreadyAtOptimum).toBe(false);
    expect(outcome.winner).toMatchObject({ primaryAgeYears: 62, metricValue: 0.5 });
    expect(progress[progress.length - 1]).toMatchObject({
      cumulativeIdx: GRID_PLUS_STORED,
      pairs: GRID_PLUS_STORED,
      totalPairs: GRID_PLUS_STORED,
    });
  });

  it('a stored pair that ranks highest wins already-at-optimum with its months', async () => {
    const { done } = run((n) => (n === GRID_PLUS_STORED ? 0.9 : 0.5));
    const outcome = (await done).get('s1');
    if (outcome?.kind !== 'result') throw new Error('expected result');
    expect(outcome.winner).toMatchObject({ primaryAgeYears: 66, primaryAgeMonths: 4 });
    expect(outcome.alreadyAtOptimum).toBe(true);
    expect(outcome.baselineMetricValue).toBe(0.9);
  });

  it('on an exact tie the lower total-months age wins', async () => {
    const { done } = run(() => 0.5);
    const outcome = (await done).get('s1');
    if (outcome?.kind !== 'result') throw new Error('expected result');
    expect(outcome.winner?.primaryAgeYears).toBe(62);
    expect(outcome.winner?.primaryAgeMonths).toBeUndefined();
  });

  it('a cancelled run still collapses to cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { done } = run(() => 0.5, { signal: controller.signal });
    expect((await done).get('s1')).toEqual({ kind: 'cancelled' });
  });
});

describe('runOptimizerMonteCarlo — pool concurrency', () => {

  const members = [member('m1', true, 1965)];
  const ss = [ssBenefit('m1', PIA_HIGH)];
  const accounts = [brokerage('m1')];
  const balances = [balanceRow(800_000)];

  it('should_produce_identical_winners_across_pool_sizes', async () => {
    const scenarios = [scenarioFixture('s1')];
    const runAt = async (concurrency: number) => {
      const runOptimizerMonteCarlo = await freshRunner();
      const fakes = makeFakeFactory(successFromInput);
      const result = await runOptimizerMonteCarlo({
        scenarios,
        accounts,
        balances,
        members,
        ssBenefits: ss,
        expenses: [],
        incomeStreams: [],
        today: TODAY,
        concurrency,
        workerFactory: fakes.factory,
      });
      return result.get('s1');
    };
    const serial = await runAt(1);
    const parallel = await runAt(8);
    expect(parallel).toEqual(serial);
    if (serial?.kind !== 'result') throw new Error('expected result');
    expect(serial.winner).not.toBeNull();
  });

  it('should_dispatch_triples_concurrently_up_to_the_pool_size', async () => {
    const scenarios = [scenarioFixture('s1')];
    let inFlight = 0;
    let peak = 0;
    const factory = (): MinimalMcWorker => {
      const listeners = new Set<(ev: MessageEvent) => void>();
      return {
        addEventListener(t, fn) {
          if (t !== 'error') listeners.add(fn);
        },
        removeEventListener(t, fn) {
          if (t !== 'error') listeners.delete(fn);
        },
        postMessage(msg: unknown) {
          const m = msg as { kind: 'run'; input: MonteCarloInput };
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          const summary = buildFakeSummary(m.input, 0.5);
          setTimeout(() => {
            inFlight -= 1;
            const ev = { data: { kind: 'result', summary } } as MessageEvent;
            listeners.forEach((fn) => fn(ev));
          }, 0);
        },
        terminate() {},
      };
    };
    await runOptimizerMonteCarlo({
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      today: TODAY,
      concurrency: 4,
      workerFactory: factory,
    });
    expect(peak).toBe(4);
  });

  it('should_keep_smooth_per_scenario_progress_monotonic_and_capped_under_concurrency', async () => {
    const scenarios = [scenarioFixture('s1')];
    const onScenarioProgress = vi.fn();
    const fakes = makeFakeFactory(() => 0.5, 500);
    await runOptimizerMonteCarlo({
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      today: TODAY,
      concurrency: 4,
      workerFactory: fakes.factory,
      onScenarioProgress,
    });
    const total = SINGLE_SCENARIO_GRID_PAIRS * OPTIMIZER_MC_DEFAULT_PATH_COUNT;
    const dones = onScenarioProgress.mock.calls.map((c) => c[1].done as number);
    expect(dones.length).toBeGreaterThan(0);
    for (let i = 1; i < dones.length; i += 1) {
      expect(dones[i]).toBeGreaterThanOrEqual(dones[i - 1]);
    }
    for (const d of dones) expect(d).toBeLessThanOrEqual(total);
  });
});
