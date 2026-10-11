/**
 * Tests for `runOptimizerMonteCarlo`. The orchestrator is mocked at the
 * `MinimalMcWorker` seam — a fake `postMessage` records every input the
 * orchestrator hands the worker and synthesises deterministic
 * `{ kind: 'result' }` replies via a captured `message` listener.
 *
 * Mirror tests:
 *  - one `postMessage` per `(scenario, primary, secondary)` triple
 *  - iteration order matches the candidate grid
 *  - accumulator returns the per-scenario max
 *  - `signal.aborted` triggers `worker.terminate()` + resolves partial
 *  - progress callback fires per triple
 *  - seed pinned to 1 + pathCount pinned to the constant
 *  - BPP-equivalence: captured `postMessage` argument matches the input
 *    a separate `runBalanceProjectionMc` produces for the same triple.
 *  - worker-isolation: `runMonteCarlo` is never invoked on the main
 *    thread (mock the `monte-carlo` module to spy on the symbol).
 *
 * The orchestrator now fans triples across a worker pool. Every test in
 * this block pins `concurrency: 1` so dispatch is serial and the
 * single shared-instance fake (one `() => fake`) models exactly one
 * worker — keeping the legacy assertions (grid order, per-triple
 * progress, terminate count) exact. The parallel path (out-of-order
 * replies, result-identity across pool sizes) is covered by the
 * dedicated `concurrency` describe block at the end, which uses a
 * fresh-worker-per-call fake factory.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runOptimizerMonteCarlo,
  clearOptimizerMcCache,
  optimizerMcCacheSize,
  OPTIMIZER_MC_CACHE_MAX_ENTRIES,
  type MinimalMcWorker,
  OPTIMIZER_MC_DEFAULT_PATH_COUNT,
} from './optimizer-mc-runner';
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

// Spy on `runMonteCarlo` exported from `./monte-carlo` — the worker
// isolation assertion proves the orchestrator never invokes it on the
// main thread.
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

/** Minimal `MonteCarloSummary` for a posted input + success probability. */
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
  /** When set, emit one mid-triple `{ kind: 'progress', done }` message
   *  before the terminal `result` so path-progress wiring is exercised. */
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
      // Deliver the reply asynchronously to mirror real Worker behaviour.
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

/** `makeFakeWorker` variant that emits a mid-triple progress message. */
function makeProgressFakeWorker(
  summaryFor: (input: MonteCarloInput) => number,
  progressDone: number,
): FakeWorker {
  return makeFakeWorker(summaryFor, progressDone);
}

const PIA_HIGH = 3500;
const SINGLE_SCENARIO_GRID_PAIRS = 9; // 62..70

describe('runOptimizerMonteCarlo', () => {
  // The session cache is module-level state; clear it before every test so
  // an earlier test's identical fixture can't serve a later run from cache.
  beforeEach(() => clearOptimizerMcCache());

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
      concurrency: 1, // single-worker pool: serial, shared-fake-safe (see header note)
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
    // Return higher success for higher SS claim age (deterministic
    // ramp). The orchestrator must pick age 70 as the winner.
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
      concurrency: 1, // single-worker pool: serial, shared-fake-safe (see header note)
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
      concurrency: 1, // single-worker pool: serial, shared-fake-safe (see header note)
      workerFactory: () => fake,
      onProgress,
    });
    // 9 progress calls in order (pairIdx 1..9).
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
    // Fake worker that emits one mid-triple `progress` (done=500) before
    // the terminal `result`, exercising the path-progress → scenario
    // progress roll-up in the orchestrator.
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
      concurrency: 1, // single-worker pool: serial, shared-fake-safe (see header note)
      workerFactory: () => fake,
      onScenarioProgress,
    });
    const pathCount = OPTIMIZER_MC_DEFAULT_PATH_COUNT;
    const total = SINGLE_SCENARIO_GRID_PAIRS * pathCount;
    // One emit per triple — the completed-triple base advances each time.
    expect(onScenarioProgress).toHaveBeenCalledTimes(SINGLE_SCENARIO_GRID_PAIRS);
    expect(onScenarioProgress.mock.calls[0]).toEqual(['s1', { done: 500, total }]);
    expect(onScenarioProgress.mock.calls[8]).toEqual([
      's1',
      { done: 8 * pathCount + 500, total },
    ]);
    // Monotonic non-decreasing `done`, capped at `total`.
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
      // Abort on the first post — orchestrator should bail out.
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
      concurrency: 1, // single-worker pool: serial, shared-fake-safe (see header note)
      workerFactory: () => fake,
      signal: controller.signal,
    });
    expect(fake.terminateCount).toBeGreaterThan(0);
    // Result is a Map (the partial accumulator). May be empty if the
    // abort fired before the first reply landed.
    expect(result).toBeInstanceOf(Map);
  });

  it('should_pin_seed_and_path_count_constants_on_every_post', async () => {
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
      concurrency: 1, // single-worker pool: serial, shared-fake-safe (see header note)
      workerFactory: () => fake,
    });
    for (const input of fake.postedInputs) {
      expect(input.seed).toBe(OPTIMIZER_MC_SEED);
      expect(input.pathCount).toBe(OPTIMIZER_MC_DEFAULT_PATH_COUNT);
    }
  });

  it('should_match_runBalanceProjectionMc_assembly_for_BPP_equivalence', async () => {
    // The orchestrator's per-triple assembly must equal what a direct
    // call to `runBalanceProjectionMc` with the same overlay returns
    // (modulo pinned pathCount + seed). Confirms the MC path threads
    // through the same routing as the deterministic path.
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
      concurrency: 1, // single-worker pool: serial, shared-fake-safe (see header note)
      workerFactory: () => fake,
    });
    // First posted input == the orchestrator's first triple (age 62).
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
    // ssByYear replaces annualSocialSecurity scalar.
    expect(first.ssByYear).toEqual(expected.ssByYear);
    // v40: the windowed per-month base is candidate-invariant.
    expect(first.monthlyExpenseBase).toEqual(expected.monthlyExpenseBase);
    // Pinned values:
    expect(first.seed).toBe(OPTIMIZER_MC_SEED);
    expect(first.pathCount).toBe(OPTIMIZER_MC_DEFAULT_PATH_COUNT);
  });

  // Orchestrator-level
  // coverage for the precheck-empty + per-scenario-empty + abort
  // outcome contracts.

  it('should_emit_empty_no_primary_member_when_no_primary_member', async () => {
    // No `isPrimary: true` member in the household → global precheck
    // fires before any triple assembly; every non-deleted scenario
    // surfaces `kind: 'empty', reason: 'no-primary-member'`.
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
      concurrency: 1, // single-worker pool: serial, shared-fake-safe (see header note)
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
    // Precheck short-circuits — no worker dispatch.
    expect(fake.postedInputs.length).toBe(0);
  });

  it('should_emit_empty_no_retirement_date_when_household_state_is_empty', async () => {
    // Primary present but birthdate invalid → `derivePrecheckEmpty`
    // returns `no-retirement-date` for every scenario.
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
      concurrency: 1, // single-worker pool: serial, shared-fake-safe (see header note)
      workerFactory: () => fake,
    });
    expect(result.get('s1')).toEqual({
      kind: 'empty',
      reason: 'no-retirement-date',
    });
    expect(fake.postedInputs.length).toBe(0);
  });

  it('should_emit_empty_no_retirement_date_for_scenario_without_resolved_retirement_age', async () => {
    // Scenario-aware empty-state routing. Primary HAS a valid
    // birthdate so the global precheck passes, but the scenario chain
    // resolves no `retirementAge` override AND both PIA grids are
    // empty. Pre-fix `buildTriples` pre-seeded `pastWindowOrMissingPia`
    // (Add PIAs copy); post-fix the per-scenario probe routes through
    // `no-retirement-date`.
    const members = [member('m1', true, 1965)];
    // Both PIAs empty → `buildCandidateGrid` returns [] for primary.
    const ss = [ssBenefit('m1', null)];
    // Scenario without `retirementAge` override on the chain.
    const noRetirementAge: ScenarioAggregate = {
      ...scenarioFixture('s1'),
      payload: {
        ...scenarioFixture('s1').payload,
        overrides: {
          // Deliberately omit `retirementAge`; everything else stays
          // valid so the orchestrator can run.
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
      concurrency: 1, // single-worker pool: serial, shared-fake-safe (see header note)
      workerFactory: () => fake,
    });
    expect(result.get('s1')).toEqual({
      kind: 'empty',
      reason: 'no-retirement-date',
    });
    // No PIA → no triples queued → no worker dispatch.
    expect(fake.postedInputs.length).toBe(0);
  });

  it('should_emit_cancelled_outcome_for_unprocessed_scenarios_on_abort', async () => {
    // Abort mid-sweep → scenarios with no accumulated
    // winner surface `kind: 'cancelled'` (NOT `winner: null`, which the
    // page renders as past-window).
    const members = [member('m1', true, 1965)];
    const ss = [ssBenefit('m1', PIA_HIGH)];
    const accounts = [brokerage('m1')];
    const balances = [balanceRow(800_000)];
    const scenarios = [scenarioFixture('s1'), scenarioFixture('s2')];
    const controller = new AbortController();
    // Pre-abort the signal so every triple short-circuits.
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
      concurrency: 1, // single-worker pool: serial, shared-fake-safe (see header note)
      workerFactory: () => fake,
      signal: controller.signal,
    });
    expect(result.get('s1')).toEqual({ kind: 'cancelled' });
    expect(result.get('s2')).toEqual({ kind: 'cancelled' });
  });

  it('should_NOT_construct_a_worker_when_signal_pre_aborted', async () => {
    // A pre-aborted signal short-circuits before workerFactory
    // ever runs — preSeeded outcomes (no-PIA / past-window) survive
    // (covered by the cancelled-outcome test above), but no Worker is
    // constructed at all. workerFactory must NOT be invoked.
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
      concurrency: 1, // single-worker pool: serial, shared-fake-safe (see header note)
      workerFactory: factorySpy,
      signal: controller.signal,
    });
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it('should_NOT_call_runMonteCarlo_on_the_main_thread', async () => {
    // Invariant: only `monte-carlo.worker.ts` may execute
    // `runMonteCarlo`. The orchestrator assembles inputs + posts to the
    // worker; the spy on `runMonteCarlo` must never be touched.
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
      concurrency: 1, // single-worker pool: serial, shared-fake-safe (see header note)
      workerFactory: () => fake,
    });
    expect(runMonteCarloSpy).not.toHaveBeenCalled();
  });

  it('should_thread_retirementAllocation_assetMixSeries_into_posted_input', async () => {
    // Regression: pre-fix the assetMixSeries slot was null even when
    // retirementAllocation was present → successProbability invariant
    // between scenarios with different glide paths. This test proves the
    // posted MonteCarloInput carries a non-null assetMixSeries when the
    // scenario includes a retirementAllocation override.
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
      concurrency: 1, // single-worker pool: serial, shared-fake-safe (see header note)
      workerFactory: () => fake,
    });
    // Every posted input must carry at least one ledger entry with a
    // non-null assetMixSeries (the glide trajectory).
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
    // Cache hit: no MC inputs posted, identical outcome returned.
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
    // Path-count change → different cache key → full recompute.
    const fake2 = makeFakeWorker(() => 0.5);
    await runOptimizerMonteCarlo({
      ...base,
      pathCount: 5000,
      workerFactory: () => fake2,
    });
    expect(fake2.postedInputs.length).toBe(SINGLE_SCENARIO_GRID_PAIRS);
    // Balance change (aggregate input) → different cache key → recompute.
    const fake3 = makeFakeWorker(() => 0.5);
    await runOptimizerMonteCarlo({
      ...base,
      balances: [balanceRow(900_000)],
      workerFactory: () => fake3,
    });
    expect(fake3.postedInputs.length).toBe(SINGLE_SCENARIO_GRID_PAIRS);
  });

  it('should_miss_the_session_cache_when_medicalCategoryIds_changes (FNV signature)', async () => {
    clearOptimizerMcCache();
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
    // A different medical-id set must NOT collide on the prior cached setup.
    const fake2 = makeFakeWorker(() => 0.5);
    await runOptimizerMonteCarlo({
      ...base,
      medicalCategoryIds: ['cat-medical', 'cat-dental'],
      workerFactory: () => fake2,
    });
    expect(fake2.postedInputs.length).toBe(SINGLE_SCENARIO_GRID_PAIRS);
  });

  it('should_cap_the_session_cache_at_the_max_entries_bound_with_LRU_eviction', { timeout: 60_000 }, async () => {
    clearOptimizerMcCache();
    const members = [member('m1', true, 1965)];
    const ss = [ssBenefit('m1', PIA_HIGH)];
    const accounts = [brokerage('m1')];
    // Drive past the cap: each run uses a distinct balance (distinct key).
    // One scenario per run → one cache entry per run. A large candidate
    // step clamps the grid to a single age, so each sweep posts one input
    // — keeping 500+ sweeps fast.
    const total = OPTIMIZER_MC_CACHE_MAX_ENTRIES + 5;
    for (let i = 0; i < total; i += 1) {
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
      expect(optimizerMcCacheSize()).toBeLessThanOrEqual(
        OPTIMIZER_MC_CACHE_MAX_ENTRIES,
      );
    }
    expect(optimizerMcCacheSize()).toBe(OPTIMIZER_MC_CACHE_MAX_ENTRIES);
  });
});

/**
 * Pool-concurrency coverage. The serial tests above pin `concurrency: 1`
 * and reuse a single shared-instance fake. These exercise the real pool
 * with a fresh worker per `factory()` call (the pool spins up one worker
 * per slot), proving: (a) results are identical across pool sizes —
 * the constant seed makes each triple order-independent, so winners must
 * not depend on how triples are partitioned across workers — and (b) the
 * pool actually dispatches up to `size` triples at once.
 */
interface FakeFactory {
  readonly factory: () => MinimalMcWorker;
  readonly postedCount: number;
  readonly terminateCount: number;
}

/** Fresh worker per `factory()` call, all writing to one shared tally so
 *  assertions span the whole pool. Each worker replies only to its own
 *  listeners, so the pool's per-worker reply correlation is exercised. */
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
          // The pool also registers an `error` listener; this fake only
          // emits `message` events, so keep the error listener out of the set.
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

/** Deterministic per-triple success probability derived from the posted
 *  input. The claim-age overlay is the only thing that varies between a
 *  scenario's triples, and it flows into `ssByYear`, so this assigns a
 *  stable, distinct value per triple without any call-order coupling. */
function successFromInput(input: MonteCarloInput): number {
  const sum = input.ssByYear.reduce((a, b) => a + b, 0);
  return (sum % 99_991) / 99_991;
}

describe('runOptimizerMonteCarlo — pool concurrency', () => {
  beforeEach(() => clearOptimizerMcCache());

  const members = [member('m1', true, 1965)];
  const ss = [ssBenefit('m1', PIA_HIGH)];
  const accounts = [brokerage('m1')];
  const balances = [balanceRow(800_000)];

  it('should_produce_identical_winners_across_pool_sizes', async () => {
    const scenarios = [scenarioFixture('s1')];
    const runAt = async (concurrency: number) => {
      // Clear so the parallel run recomputes instead of serving the
      // serial run's cached outcome.
      clearOptimizerMcCache();
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
    // Constant seed → order-independent: same winner, metric, and row
    // contract regardless of how triples were spread across workers.
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
          // The pool also registers an `error` listener; this fake only
          // emits `message` events, so keep the error listener out of the set.
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
    // 9 triples, 4 workers → all four post before the first reply lands.
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
