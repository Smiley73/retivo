/**
 * `retivo_run_what_if` end to end on the demo dataset: the same numbers the projection tool gives, nothing written
 * anywhere on any outcome, the stress test computed under the stress-test tool's caps and never through the saved
 * results, and the sharing switches applied to the echo.
 */
import 'fake-indexeddb/auto';
import { TOOL_REGISTRY, PROMPTS } from '@retirement/assistant-protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMonteCarloCache, mcCacheKey, monteCarloCacheCount, putCached } from '../../db/monte-carlo-cache';
import { clearAllStores, db, getStoreVersion, listAggregates, putAggregate, readSelectedScenario, writeSelectedScenario } from '../../db/store';
import type { Aggregate, ScenarioPayload } from '../../db/types';
import { loadDemoData } from '../../lib/demo-data-loader';
import { runMonteCarlo, type MonteCarloInput } from '../../lib/monte-carlo';
import { hashMcInput } from '../../lib/monte-carlo-input-signature';
import { MC_PATH_COUNT } from '../../lib/monte-carlo-scenario-input';
import { seedFromString } from '../../lib/sfc32';
import { WORKSPACE_CHANGED_EVENT } from '../../lib/workspace-events';
import { makeFactory } from '../../monte-carlo/computing-fake-worker.test-harness';
import type { MinimalMcWorker } from '../../monte-carlo/mc-worker-pool';
import { BASE_ID, DELAY_ID, EARLY_ID, savedSummary, whatIfChildOf } from '../../test/assistant-analysis-inputs';
import { callDefinition, callPlanTool, choicesWith, envelopeOf, toolContext } from '../../test/assistant-tools';
import type { ToolCallContext } from '../dispatcher';
import { buildMasker } from '../sharing/sanitize';
import { maskTermsFor } from '../sharing/view';
import type { ToolEnv } from './define';
import { buildWhatIf } from './what-if-overrides';
import { monteCarloInputFor } from './stress-cache';
import { makeStressRunner, makeStressTestTool, type StressRunner } from './stress-test';
import { loadWorkspace, shareSourceOf } from './workspace';
import { retivoRunWhatIf } from './what-if';

/** The shipped runner, swapped for whichever one a test computes on. */
const runnerSlot = vi.hoisted(() => ({ current: undefined as StressRunner | undefined }));
vi.mock('./stress-test', async () => {
  const actual = await vi.importActual<typeof import('./stress-test')>('./stress-test');
  const stressRunner: StressRunner = {
    get pathCount() {
      return runnerSlot.current!.pathCount;
    },
    run: (input, env) => runnerSlot.current!.run(input, env),
  };
  return { ...actual, stressRunner };
});

/** `retivo_run_what_if` computing its stress test on `runner`. */
function whatIfOn(runner: StressRunner) {
  runnerSlot.current = runner;
  return retivoRunWhatIf;
}

const WHAT_IF_LABEL = 'What-if (not saved)';

const COMPUTE_TIMEOUT = process.env.VITEST_COVERAGE === '1' ? 90_000 : 30_000;
const TEST_PATHS = 200;
const ACCOUNT_ID = 'demo-account-john-401k';
const PARITY_CHILD_ID = 't-parity-child';

interface Headline {
  horizonYear: number | null;
  retirementYear: number | null;
  endingBalanceTodayDollars: number | null;
  runOutYear: number | null;
  portfolioAtRetirementNominal: number | null;
  portfolioAtRetirementTodayDollars: number | null;
}

interface WhatIfData {
  saved: boolean;
  statement: string;
  base: { scenarioId: string; name?: string; headline: Headline };
  whatIf: { label: string; headline: Headline };
  difference: Record<string, number | string | null>;
  echo: {
    changes: Array<{ setting: string; previous?: unknown; previousSource?: string; new?: unknown; changed?: boolean; accountId?: string; accountName?: string; withheld?: boolean; followsFrom?: string }>;
    unchangedInTheseSections: Array<{ setting: string; value: unknown; source: string }>;
    withheldSections?: Array<{ section: string; switch: string }>;
  };
  years?: { base: Array<{ year: number }>; whatIf: Array<{ year: number }> };
  stressTest?: { source: string; pathCount: number; seed: number; successProbability: number; tiers: Record<string, { endingBalanceReal: number }> };
}

let scenarios: Aggregate<ScenarioPayload>[];

async function whatIf(overrides: unknown, extra: Record<string, unknown> = {}, choices = choicesWith(), baseScenarioId = BASE_ID) {
  const envelope = envelopeOf(await callPlanTool('retivo_run_what_if', { baseScenarioId, overrides, ...extra }, choices));
  return { envelope, data: envelope.data as unknown as WhatIfData };
}

async function projectionHeadline(scenarioId: string): Promise<Headline> {
  const envelope = envelopeOf(await callPlanTool('retivo_get_projection', { scenarioId }));
  return (envelope.data as unknown as { headline: Headline }).headline;
}

/** A tool env the way `toHandler` builds one, so the test can look at what the tool does to the workspace it is handed. */
async function envFor(context: ToolCallContext = toolContext()): Promise<ToolEnv> {
  const workspace = await loadWorkspace();
  const source = shareSourceOf(workspace);
  const { choices } = context.share.consent;
  return {
    workspace,
    choices,
    masker: buildMasker(maskTermsFor(source, choices)),
    now: context.now,
    context,
    view: () => context.share.buildView(source),
  };
}

/** The Monte Carlo input the tool builds for a what-if with `overrides`: the base's plan plus the throwaway child. */
async function whatIfInput(overrides: Parameters<typeof buildWhatIf>[1], pathCount = MC_PATH_COUNT): Promise<MonteCarloInput> {
  const env = await envFor();
  const base = env.workspace.scenarios.find((scenario) => scenario.id === BASE_ID)!;
  const throwaway = whatIfChildOf(base, buildWhatIf(BASE_ID, overrides, env).overrides);
  return monteCarloInputFor(throwaway.id, { ...env, workspace: { ...env.workspace, scenarios: [...env.workspace.scenarios, throwaway] } } as ToolEnv, pathCount)!;
}

/** A worker that records what it is sent and answers every message with an error, so no simulation runs. */
function recordingFactory() {
  const messages: unknown[] = [];
  let constructed = 0;
  const factory = (): MinimalMcWorker => {
    constructed += 1;
    const listeners = new Set<(event: MessageEvent) => void>();
    return {
      addEventListener: (type, listener) => {
        if (type === 'message') listeners.add(listener);
      },
      removeEventListener: (type, listener) => {
        if (type === 'message') listeners.delete(listener);
      },
      terminate: () => undefined,
      postMessage: (sent) => {
        messages.push(sent);
        queueMicrotask(() => listeners.forEach((listener) => listener({ data: { kind: 'error', message: 'stop' } } as MessageEvent)));
      },
    };
  };
  return { factory, messages, constructed: () => constructed };
}

/** Everything a what-if must leave exactly as it found it. */
async function footprint() {
  const handle = await db();
  return {
    scenarioRows: JSON.stringify(await listAggregates('scenario')),
    scenarioVersion: getStoreVersion('scenarios'),
    cacheCount: await monteCarloCacheCount(),
    cacheRows: JSON.stringify(await handle.getAll('monteCarloResults')),
    pending: JSON.stringify(await handle.getAll('mutations')),
    selected: JSON.stringify(await readSelectedScenario()),
  };
}

let changedEvents = 0;
const onChanged = (): void => {
  changedEvents += 1;
};

beforeAll(async () => {
  await clearAllStores();
  await loadDemoData({ householdId: 'hh-1', email: 'a@b.example', displayName: 'Demo', todayYear: 2026 });
  scenarios = (await listAggregates('scenario')) as Aggregate<ScenarioPayload>[];
  const base = scenarios.find((scenario) => scenario.id === BASE_ID)!;
  // Settings the what-if allowlist takes, none of which shadows a base section the agent cannot supply.
  await putAggregate('scenario', {
    ...base,
    id: PARITY_CHILD_ID,
    payload: {
      ...base.payload,
      name: 'Parity child',
      isPrimary: false,
      parentScenarioId: BASE_ID,
      overrides: {
        lifeExpectancy: { primary: 90 },
        discretionarySpending: { bumpPct: 10, durationYears: 5 },
        withdrawalStrategy: { kind: 'proportional' },
        contributions: { stopContributionsToday: true },
        accountReturns: { perAccount: { [ACCOUNT_ID]: { planningReturnPct: 3.5 } } },
      },
    },
  });
  await putAggregate('scenario', {
    ...base,
    id: 't-no-retirement',
    payload: { ...base.payload, name: 'No retirement', isPrimary: false, parentScenarioId: null, overrides: {} },
  });
  scenarios = (await listAggregates('scenario')) as Aggregate<ScenarioPayload>[];
  await writeSelectedScenario({ scenarioId: EARLY_ID, updatedAt: '2026-06-01T00:00:00.000Z' });
  window.addEventListener(WORKSPACE_CHANGED_EVENT, onChanged);
});

beforeEach(async () => {
  await clearMonteCarloCache();
  changedEvents = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  window.removeEventListener(WORKSPACE_CHANGED_EVENT, onChanged);
  await clearMonteCarloCache();
  await clearAllStores();
});

describe('the answer', () => {
  it('gives base and what-if side by side, the difference, an echo of what changed, and the not-saved statement', async () => {
    const { data } = await whatIf({ retirementAge: { primary: { ageYears: 62 } }, socialSecurity: { primary: { ageYears: 70 } } });
    expect(data.saved).toBe(false);
    expect(data.statement).toMatch(/^Nothing was saved\./);
    expect(data.statement).toMatch(/Planning, Scenarios, Create scenario/);
    expect(data.base).toMatchObject({ scenarioId: BASE_ID, name: 'Base' });
    expect(data.whatIf.label).toBe(WHAT_IF_LABEL);
    expect(data.whatIf.headline.retirementYear).toBe(data.base.headline.retirementYear! - 3);
    expect(data.difference.retirementYear).toBe(-3);
    expect(data.difference.endingBalanceTodayDollars).toBeCloseTo(data.whatIf.headline.endingBalanceTodayDollars! - data.base.headline.endingBalanceTodayDollars!, 6);

    const ages = data.echo.changes.find((change) => change.setting === 'retirementAge.primary.ageYears');
    expect(ages).toMatchObject({ previous: 65, previousSource: 'scenario', new: 62, changed: true });
    // The other member's age follows the same-date anchor and says so.
    expect(data.echo.changes.find((change) => change.setting === 'retirementAge.secondary.ageYears')).toMatchObject({ previous: 68, new: 65, followsFrom: expect.stringContaining('same date') });
    expect(data.echo.changes.find((change) => change.setting === 'socialSecurity.primary.ageYears')).toMatchObject({ previous: 67, new: 70 });
    expect(data.echo.unchangedInTheseSections.find((entry) => entry.setting === 'socialSecurity.secondary.ageYears')).toMatchObject({ value: 67, source: 'scenario' });
  });

  it('adds the yearly rows for both sides only when fromYear or toYear is given', async () => {
    const { data: without } = await whatIf({});
    expect(without.years).toBeUndefined();
    const { data } = await whatIf({ retirementAge: { primary: { ageYears: 62 } } }, { fromYear: 2045, toYear: 2048 });
    expect(data.years!.base.map((row) => row.year)).toEqual([2045, 2046, 2047, 2048]);
    expect(data.years!.whatIf.map((row) => row.year)).toEqual([2045, 2046, 2047, 2048]);
    const reversed = await callPlanTool('retivo_run_what_if', { baseScenarioId: BASE_ID, overrides: {}, fromYear: 2050, toYear: 2045 });
    expect(reversed).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
  });

  it('says in its assumptions that the what-if starts from the base and lists the defaults the what-if rests on', async () => {
    const { envelope } = await whatIf({ lifeExpectancy: { primary: 90 } });
    expect(envelope.assumptions[0]).toMatch(/starts from the base scenario/);
    expect(envelope.assumptions.some((line) => /^socialSecurity\.benefitReductionPct: /.test(line))).toBe(true);
  });

  it('answers INVALID_ARGS, like the projection tool, for a base the page could not run', async () => {
    const result = await callPlanTool('retivo_run_what_if', { baseScenarioId: 't-no-retirement', overrides: {} });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    expect(JSON.stringify(result)).toMatch(/retirement age/);
  });

  it('omits itself while the scenarios switch is off, since the base is named by a scenario id', async () => {
    const result = envelopeOf(await callPlanTool('retivo_run_what_if', { baseScenarioId: BASE_ID, overrides: {} }, choicesWith({ scenarios: false })));
    expect(result.data).toEqual({ omittedSections: ['scenarios'] });
  });
});

describe('parity with the projection tool', () => {
  it('with empty overrides the what-if side is the base’s own headline', async () => {
    const { data } = await whatIf({});
    const expected = await projectionHeadline(BASE_ID);
    expect(data.base.headline).toEqual(expected);
    expect(data.whatIf.headline).toEqual(expected);
    expect(Object.values(data.difference).filter((value) => typeof value === 'number').every((value) => value === 0)).toBe(true);
    expect(data.echo.changes).toEqual([]);
  });

  it('with overrides equal to a stored child’s own, the what-if side is that child’s headline', async () => {
    const child = scenarios.find((scenario) => scenario.id === PARITY_CHILD_ID)!;
    const { data } = await whatIf(child.payload.overrides);
    expect(data.whatIf.headline).toEqual(await projectionHeadline(PARITY_CHILD_ID));
    expect(data.whatIf.headline).not.toEqual(data.base.headline);

    // The demo's own "Delay" scenario, which retimes both members and both claim ages.
    const delay = scenarios.find((scenario) => scenario.id === DELAY_ID)!;
    const { data: delayed } = await whatIf(delay.payload.overrides);
    expect(delayed.whatIf.headline).toEqual(await projectionHeadline(DELAY_ID));
  });

  it('keeps a base benefit cut the way the stored scenario with the same cut does', async () => {
    const base = scenarios.find((scenario) => scenario.id === BASE_ID)!;
    const cutId = 't-cut-base';
    const cutOverrides = { socialSecurity: { ...base.payload.overrides.socialSecurity!, benefitReductionPct: 20 } };
    await putAggregate('scenario', { ...base, id: cutId, payload: { ...base.payload, name: 'Cut', isPrimary: false, parentScenarioId: BASE_ID, overrides: cutOverrides } });
    await putAggregate('scenario', {
      ...base,
      id: 't-cut-claim70',
      payload: {
        ...base.payload,
        name: 'Cut and claim at 70',
        isPrimary: false,
        parentScenarioId: BASE_ID,
        overrides: { socialSecurity: { ...cutOverrides.socialSecurity, primary: { ageYears: 70, ageMonths: 0 } } },
      },
    });
    const { data } = await whatIf({ socialSecurity: { primary: { ageYears: 70 } } }, {}, choicesWith(), cutId);
    expect(data.whatIf.headline).toEqual(await projectionHeadline('t-cut-claim70'));
    expect(data.whatIf.headline).not.toEqual(await projectionHeadline(cutId));
  });

  it('leaves the base’s numbers, and the scenario list, exactly as they were', async () => {
    const before = await projectionHeadline(BASE_ID);
    await whatIf({ retirementAge: { primary: { ageYears: 62 } }, inflation: { ratePct: 6 } });
    expect(await projectionHeadline(BASE_ID)).toEqual(before);
    const list = envelopeOf(await callPlanTool('retivo_list_scenarios')).data as unknown as { scenarios: Array<{ id: string; name: string }> };
    expect(list.scenarios.map((scenario) => scenario.id).sort()).toEqual((await listAggregates('scenario')).map((scenario) => scenario.id).sort());
    expect(JSON.stringify(list)).not.toContain(WHAT_IF_LABEL);
  });
});

describe('nothing is written', () => {
  /** Runs `act` and proves it changed nothing the what-if could have touched. */
  async function expectNoTrace(act: () => Promise<unknown>) {
    await putCached(await mcCacheKey({ marker: 'planted' } as unknown as MonteCarloInput), savedSummary(5));
    const before = await footprint();
    await act();
    expect(await footprint()).toEqual(before);
    expect(changedEvents).toBe(0);
  }

  it('on success', async () => {
    await expectNoTrace(() => whatIf({ retirementAge: { primary: { ageYears: 62 } }, accountReturns: { perAccount: { [ACCOUNT_ID]: { planningReturnPct: 2 } } } }));
  });

  it('on INVALID_ARGS, whether the schema or the bounds refuse', async () => {
    await expectNoTrace(async () => {
      expect(await callPlanTool('retivo_run_what_if', { baseScenarioId: BASE_ID, overrides: { expenses: {} } })).toMatchObject({ ok: false });
      expect(await callPlanTool('retivo_run_what_if', { baseScenarioId: BASE_ID, overrides: { inflation: { ratePct: 99 } } })).toMatchObject({ ok: false });
      expect(await callPlanTool('retivo_run_what_if', { baseScenarioId: 'nope', overrides: {} })).toMatchObject({ ok: false });
    });
  });

  it('on a stress test that is cancelled, and on one that exceeds its cap', async () => {
    await expectNoTrace(async () => {
      const controller = new AbortController();
      const hanging = makeFactory({ manual: true });
      const cancelled = callDefinition(
        whatIfOn(makeStressRunner({ workerFactory: hanging.factory })),
        { baseScenarioId: BASE_ID, overrides: {}, stressTest: true },
        { ...toolContext(), signal: controller.signal },
      );
      await vi.waitFor(() => expect(hanging.workers.length).toBeGreaterThan(0));
      controller.abort();
      expect(await cancelled).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
      expect(hanging.workers.every((worker) => worker.terminated)).toBe(true);

      const capped = makeFactory({ manual: true });
      const result = await callDefinition(whatIfOn(makeStressRunner({ workerFactory: capped.factory, wallClockMs: 30 })), {
        baseScenarioId: BASE_ID,
        overrides: {},
        stressTest: true,
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'COMPUTE_CAP_EXCEEDED' } });
      expect(capped.workers.every((worker) => worker.terminated)).toBe(true);
    });
  });

  it('on a stress test that completes', async () => {
    await expectNoTrace(async () => {
      const { factory } = makeFactory();
      const result = await callDefinition(whatIfOn(makeStressRunner({ workerFactory: factory, pathCount: TEST_PATHS })), {
        baseScenarioId: BASE_ID,
        overrides: { inflation: { ratePct: 4 } },
        stressTest: true,
      });
      expect(result.ok).toBe(true);
    });
  }, COMPUTE_TIMEOUT);

  it('never adds the throwaway to the scenarios it was handed, nor leaves it for the next call', async () => {
    const env = await envFor();
    const before = env.workspace.scenarios.map((scenario) => scenario.id);
    const outcome = await retivoRunWhatIf.run({ baseScenarioId: BASE_ID, overrides: { retirementAge: { primary: { ageYears: 62 } } } }, env);
    expect(outcome.data.saved).toBe(false);
    expect(env.workspace.scenarios.map((scenario) => scenario.id)).toEqual(before);
    expect(env.workspace.scenarios.some((scenario) => scenario.payload.name === WHAT_IF_LABEL)).toBe(false);
    const again = await envFor();
    expect(again.workspace.scenarios).toHaveLength(before.length);
  });
});

describe('the stress test', () => {
  it('is not run, and no pool is built, unless asked for', async () => {
    const worker = recordingFactory();
    const result = await callDefinition(whatIfOn(makeStressRunner({ workerFactory: worker.factory })), { baseScenarioId: BASE_ID, overrides: {} });
    expect(result.ok).toBe(true);
    expect(envelopeOf(result).data).not.toHaveProperty('stressTest');
    expect(worker.constructed()).toBe(0);
  });

  it('runs exactly MC_PATH_COUNT paths, on the what-if’s own plan, with the page’s seed rule', async () => {
    const worker = recordingFactory();
    const overrides = { inflation: { ratePct: 4 } };
    const result = await callDefinition(whatIfOn(makeStressRunner({ workerFactory: worker.factory })), { baseScenarioId: BASE_ID, overrides, stressTest: true });
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    const sent = worker.messages[0] as { kind: string; input: MonteCarloInput };
    expect(sent.kind).toBe('runShard');
    expect(sent.input.pathCount).toBe(MC_PATH_COUNT);
    // The what-if's plan, not the base's: the changed inflation is part of the input.
    expect(hashMcInput(sent.input, false)).toBe(hashMcInput(await whatIfInput(overrides), false));
    expect(hashMcInput(sent.input, false)).not.toBe(hashMcInput(await whatIfInput({}), false));
    expect(sent.input.seed).toBe(seedFromString(hashMcInput(await whatIfInput(overrides), false)));
  });

  it('returns the simulation of the what-if with progress frames, and equals a plain run of that input', async () => {
    const overrides = { inflation: { ratePct: 4 } };
    const { factory } = makeFactory();
    const progress: Array<{ fraction?: number }> = [];
    const tool = whatIfOn(makeStressRunner({ workerFactory: factory, pathCount: TEST_PATHS }));
    const result = await callDefinition(tool, { baseScenarioId: BASE_ID, overrides, stressTest: true }, { ...toolContext(), progress: (update) => progress.push(update) });
    const data = envelopeOf(result).data as unknown as WhatIfData;

    const input = await whatIfInput(overrides, TEST_PATHS);
    const expected = runMonteCarlo({ ...input, seed: seedFromString(hashMcInput(input, false)) });
    expect(data.stressTest).toMatchObject({ source: 'computed', pathCount: TEST_PATHS, successProbability: expected.successProbability });
    expect(data.stressTest!.tiers.typical!.endingBalanceReal).toBe(expected.medianEndingBalanceReal);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)!.fraction).toBe(1);
    expect(envelopeOf(result).assumptions.some((line) => /Sampling error:/.test(line))).toBe(true);
  }, COMPUTE_TIMEOUT);

  it('neither reads nor writes the saved results: an entry for the same input is computed past, and its last-access stamp is kept', async () => {
    const input = await whatIfInput({});
    await putCached(await mcCacheKey(input), savedSummary(77));
    const handle = await db();
    const before = JSON.stringify(await handle.getAll('monteCarloResults'));
    await new Promise((resolve) => setTimeout(resolve, 5));

    const worker = recordingFactory();
    const result = await callDefinition(whatIfOn(makeStressRunner({ workerFactory: worker.factory })), { baseScenarioId: BASE_ID, overrides: {}, stressTest: true });
    // A cache hit would have answered with seed 77 and built no worker.
    expect(worker.constructed()).toBeGreaterThan(0);
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(JSON.stringify(await handle.getAll('monteCarloResults'))).toBe(before);
    expect(await monteCarloCacheCount()).toBe(1);
  });

  it('shares the stress-test tool’s one-run-at-a-time slot, and frees it afterwards', async () => {
    const controller = new AbortController();
    const hanging = makeFactory({ manual: true });
    const runner = makeStressRunner({ workerFactory: hanging.factory });
    const first = callDefinition(whatIfOn(runner), { baseScenarioId: BASE_ID, overrides: {}, stressTest: true }, { ...toolContext(), signal: controller.signal });
    await vi.waitFor(() => expect(hanging.workers.length).toBeGreaterThan(0));

    const built = hanging.workers.length;
    expect(await callDefinition(makeStressTestTool({ runner }), {})).toMatchObject({ ok: false, error: { code: 'TOO_MANY_IN_FLIGHT' } });
    expect(await callDefinition(whatIfOn(runner), { baseScenarioId: BASE_ID, overrides: {}, stressTest: true })).toMatchObject({ ok: false, error: { code: 'TOO_MANY_IN_FLIGHT' } });
    expect(hanging.workers.length).toBe(built);

    controller.abort();
    expect(await first).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    const worker = recordingFactory();
    expect(await callDefinition(whatIfOn(makeStressRunner({ workerFactory: worker.factory })), { baseScenarioId: BASE_ID, overrides: {}, stressTest: true })).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  });
});

describe('the sharing switches', () => {
  const OVERRIDES = {
    retirementAge: { primary: { ageYears: 62 } },
    socialSecurity: { primary: { ageYears: 70 } },
    accountReturns: { perAccount: { [ACCOUNT_ID]: { planningReturnPct: 4 } } },
  };

  function dollarFigures(data: WhatIfData): number[] {
    const figures = (headline: Headline) => [headline.endingBalanceTodayDollars, headline.portfolioAtRetirementNominal, headline.portfolioAtRetirementTodayDollars];
    return [
      ...figures(data.base.headline),
      ...figures(data.whatIf.headline),
      data.difference.endingBalanceTodayDollars,
      data.difference.portfolioAtRetirementNominal,
      data.difference.portfolioAtRetirementTodayDollars,
    ].filter((value): value is number => typeof value === 'number');
  }

  it('rounds every dollar figure of both headlines and the difference to $1,000 while exact figures are off, and not an age in the echo', async () => {
    const { envelope, data } = await whatIf(OVERRIDES, { fromYear: 2050, toYear: 2051 }, choicesWith({ exactDollars: false }));
    const figures = dollarFigures(data);
    expect(figures.length).toBeGreaterThan(8);
    for (const value of figures) expect(Math.abs(value % 1000), String(value)).toBe(0);
    for (const row of [...data.years!.base, ...data.years!.whatIf] as Array<Record<string, unknown>>) {
      for (const key of ['balanceNominal', 'balanceTodayDollars', 'withdrawn', 'deposit']) expect(Math.abs((row[key] as number) % 1000), key).toBe(0);
    }
    expect(envelope.rounding).toMatchObject({ exact: false, stepDollars: 1000 });
    expect(data.echo.changes.find((change) => change.setting === 'retirementAge.primary.ageYears')).toMatchObject({ previous: 65, new: 62 });
    expect(data.echo.changes.find((change) => change.setting === 'accountReturns.perAccount.planningReturnPct')).toMatchObject({ new: 4 });
  });

  it('keeps the exact figures while exact figures are on', async () => {
    const { data } = await whatIf(OVERRIDES);
    expect(dollarFigures(data).some((value) => value % 1000 !== 0)).toBe(true);
  });

  it('names no member by first name when role labels are on, in any part of the response', async () => {
    const members = await listAggregates('householdMember');
    const names = members.map((member) => String(member.payload.firstName));
    expect(names.every((name) => name.length > 2)).toBe(true);
    const labelled = JSON.stringify(await callPlanTool('retivo_run_what_if', { baseScenarioId: BASE_ID, overrides: OVERRIDES }, choicesWith({ firstNames: false })));
    for (const name of names) expect(labelled).not.toContain(name);
    expect(labelled).toContain('"mode":"role-labels"');
  });

  it('follows the accounts switch for the account’s name, and withholds the section while it is off', async () => {
    const [account] = (await listAggregates('account')).filter((candidate) => candidate.id === ACCOUNT_ID);
    const name = String(account!.payload.name);
    const on = (await whatIf(OVERRIDES)).data.echo.changes.find((change) => change.setting === 'accountReturns.perAccount.planningReturnPct')!;
    // The base sets no return for this account, so the previous one is the account's own.
    expect(on).toMatchObject({ accountId: ACCOUNT_ID, accountName: name, new: 4, previousSource: 'default' });

    const { data: off, envelope } = await whatIf(OVERRIDES, {}, choicesWith({ accounts: false }));
    expect(JSON.stringify(envelope)).not.toContain(name);
    expect(off.echo.withheldSections).toEqual([{ section: 'accountReturns', switch: 'accounts' }]);
    expect(off.echo.changes.some((change) => change.setting.startsWith('accountReturns'))).toBe(false);
    expect(off.echo.changes.some((change) => change.setting.startsWith('retirementAge'))).toBe(true);
    // The what-if itself is still computed with the account's new return.
    expect(off.whatIf.headline).toEqual((await whatIf(OVERRIDES)).data.whatIf.headline);
  });

  it('withholds a Social Security setting’s echo while the Social Security switch is off', async () => {
    const { data } = await whatIf({ socialSecurity: { primary: { ageYears: 70 } } }, {}, choicesWith({ socialSecurity: false }));
    expect(data.echo.withheldSections).toEqual([{ section: 'socialSecurity', switch: 'socialSecurity' }]);
    expect(data.echo.changes).toEqual([]);
    expect(data.echo.unchangedInTheseSections).toEqual([]);
  });
});

describe('the tool list and the prompt', () => {
  it('registers retivo_run_what_if as long-running, saying the result is not saved', () => {
    const entry = TOOL_REGISTRY.find((tool) => tool.name === 'retivo_run_what_if')!;
    expect(entry.longRunning).toBe(true);
    expect(entry.description).toMatch(/not saved/i);
  });

  it('has retivo_plan_review name the tool, say it is not saved, and how the person makes it real', () => {
    const text = PROMPTS.find((prompt) => prompt.name === 'retivo_plan_review')!.messages.map((message) => message.text).join('\n');
    expect(text).toContain('retivo_run_what_if');
    expect(text).toMatch(/not saved/);
    expect(text).toMatch(/only from values the person stated/);
    expect(text).toMatch(/never invent inputs/);
    expect(text).toMatch(/echo/);
    expect(text).toMatch(/Create scenario/);
  });
});
