/**
 * `retivo_get_stress_test` with the computing fake worker factory injected (production passes none): cache
 * first and untouched, the page's path count and seed on a miss, nothing written, the page's numbers whatever the
 * pool size, and the wall clock, cancel, one-at-a-time and teardown caps.
 */
import 'fake-indexeddb/auto';
import { TOOL_REGISTRY, type TabFrame } from '@retirement/assistant-protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMonteCarloCache, mcCacheKey, monteCarloCacheCount, peekCached, putCached } from '../../db/monte-carlo-cache';
import { clearAllStores, db, listAggregates, putAggregate } from '../../db/store';
import type { Aggregate, ScenarioPayload } from '../../db/types';
import { loadDemoData } from '../../lib/demo-data-loader';
import { ENGINE_VERSION, runMonteCarlo, type MonteCarloInput, type MonteCarloSummary } from '../../lib/monte-carlo';
import { hashMcInput } from '../../lib/monte-carlo-input-signature';
import { MC_PATH_COUNT } from '../../lib/monte-carlo-scenario-input';
import { loadProjectionInputs } from '../../lib/projection-inputs';
import { seedFromString } from '../../lib/sfc32';
import { makeFactory } from '../../monte-carlo/computing-fake-worker.test-harness';
import type { MinimalMcWorker } from '../../monte-carlo/mc-worker-pool';
import { BASE_ID, EARLY_ID, savedSummary } from '../../test/assistant-analysis-inputs';
import { TEST_NOW, callDefinition, choicesWith, envelopeOf, toolContext } from '../../test/assistant-tools';
import { CallDispatcher, type ToolCallContext } from '../dispatcher';
import { createConsentRecord, defaultConsentAnswer } from '../sharing/consent';
import { toHandler, type ToolEnv } from './define';
import { monteCarloInputFor } from './stress-cache';
import { STRESS_TEST_WALL_CLOCK_MS, makeStressTestTool } from './stress-test';

const COMPUTE_TIMEOUT = process.env.VITEST_COVERAGE === '1' ? 90_000 : 30_000;
/** Enough paths to exercise the sharded path, few enough to stay inside a unit-test budget. */
const TEST_PATHS = 200;

interface StressData {
  scenarioId: string;
  source: 'cache' | 'computed';
  sourceNote: string;
  successProbability: number;
  pathCount: number;
  seed: number;
  engineVersion: number;
  computedAt: string;
  firstYear: number;
  tiers: Record<'typical' | 'pessimistic' | 'badLuck', { percentile: number; endingBalanceReal: number; endingBalanceNominal: number; depletionYear: number | null }>;
  percentilesReal: { p10: number[]; p25: number[]; p50: number[] };
}

function setCores(count: number): void {
  Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: count });
}

let scenarios: Aggregate<ScenarioPayload>[];

async function envOf(): Promise<ToolEnv> {
  return { workspace: { ...(await loadProjectionInputs()), scenarios }, now: TEST_NOW } as unknown as ToolEnv;
}

async function baseInput(scenarioId = BASE_ID): Promise<MonteCarloInput> {
  return monteCarloInputFor(scenarioId, await envOf())!;
}

function contextWith(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return { ...toolContext(), ...overrides };
}

/** A worker that records what it is sent and answers every message with an error, so no simulation runs. */
function recordingFactory(message = 'stop') {
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
        queueMicrotask(() => listeners.forEach((listener) => listener({ data: { kind: 'error', message } } as MessageEvent)));
      },
    };
  };
  return { factory, messages, constructed: () => constructed };
}

async function rows() {
  return (await db()).getAll('monteCarloResults');
}

beforeAll(async () => {
  await clearAllStores();
  await loadDemoData({ householdId: 'hh-1', email: 'a@b.example', displayName: 'Demo', todayYear: 2026 });
  scenarios = (await listAggregates('scenario')) as Aggregate<ScenarioPayload>[];
  setCores(2);
});

beforeEach(async () => {
  await clearMonteCarloCache();
});

afterEach(() => {
  vi.useRealTimers();
  setCores(2);
});

afterAll(async () => {
  await clearMonteCarloCache();
  await clearAllStores();
});

describe('a saved result', () => {
  it('is returned as source cache, with no worker built and the cache entry and count untouched', async () => {
    const input = await baseInput();
    await putCached(await mcCacheKey(input), savedSummary(77));
    const before = await rows();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const worker = recordingFactory();
    const result = await callDefinition(makeStressTestTool({ workerFactory: worker.factory }), {});
    const data = envelopeOf(result).data as unknown as StressData;

    expect(worker.constructed()).toBe(0);
    expect(data.source).toBe('cache');
    expect(data.scenarioId).toBe(BASE_ID);
    expect(data.seed).toBe(77);
    expect(data.pathCount).toBe(MC_PATH_COUNT);
    expect(data.engineVersion).toBe(ENGINE_VERSION);
    expect(data.successProbability).toBe(savedSummary().successProbability);
    expect(data.computedAt).toBe('2026-06-01T12:00:00.000Z');
    expect(data.tiers.typical).toEqual({ percentile: 50, endingBalanceReal: 654_321, endingBalanceNominal: 1_234_567, depletionYear: null });
    expect(data.tiers.pessimistic).toMatchObject({ percentile: 25, endingBalanceReal: 345_678 });
    expect(data.tiers.badLuck).toMatchObject({ percentile: 10, endingBalanceReal: 12_345, depletionYear: 2071 });
    expect(data.percentilesReal).toEqual(savedSummary().percentilesReal);
    // Reading it left the entry, its lastAccessedAt and the count exactly as they were.
    expect(await rows()).toEqual(before);
    expect(await monteCarloCacheCount()).toBe(1);
  });

  it('returns only tier figures and percentilesReal: no histogram, representative path or tax series', async () => {
    const input = await baseInput();
    await putCached(await mcCacheKey(input), { ...savedSummary(), representativeByBasis: {} as never, federalTaxPercentilesByYear: { p10: [1], p25: [1], p50: [1] } });
    const text = JSON.stringify(envelopeOf(await callDefinition(makeStressTestTool(), {})).data);
    for (const absent of ['Histogram', 'representative', 'plannedOverlay', 'federalTaxPercentiles', 'percentilesNominal']) expect(text).not.toContain(absent);
  });

  it('rounds every dollar figure to $1,000 while exact figures are off, and leaves probabilities and years alone', async () => {
    const input = await baseInput();
    await putCached(await mcCacheKey(input), savedSummary());
    const result = await callDefinition(makeStressTestTool(), {}, toolContext(choicesWith({ exactDollars: false })));
    const data = envelopeOf(result).data as unknown as StressData;
    const dollars = [
      ...Object.values(data.tiers).flatMap((tier) => [tier.endingBalanceReal, tier.endingBalanceNominal]),
      ...data.percentilesReal.p10,
      ...data.percentilesReal.p25,
      ...data.percentilesReal.p50,
    ];
    for (const value of dollars) expect(Math.abs(value % 1000), String(value)).toBe(0);
    expect(data.tiers.typical.endingBalanceReal).toBe(654_000);
    expect(data.successProbability).toBe(savedSummary().successProbability);
    expect(data.tiers.badLuck.depletionYear).toBe(2071);
  });

  it('skips a result stamped with another engine version and leaves it in place', async () => {
    const input = await baseInput();
    const key = await mcCacheKey(input);
    await putCached(key, savedSummary());
    const handle = await db();
    await handle.put('monteCarloResults', { ...(await handle.get('monteCarloResults', key))!, engineVersion: -1 });
    const worker = recordingFactory();
    const result = await callDefinition(makeStressTestTool({ workerFactory: worker.factory }), {});
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(worker.constructed()).toBeGreaterThan(0);
    expect((await handle.get('monteCarloResults', key))?.engineVersion).toBe(-1);
  });
});

describe('a miss', () => {
  it('sends the workers the page’s path count and the seed the page derives, and writes nothing', async () => {
    const input = await baseInput();
    const key = await mcCacheKey(input);
    const worker = recordingFactory('stop');
    const result = await callDefinition(makeStressTestTool({ workerFactory: worker.factory }), {});

    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(JSON.stringify(result)).toContain('stop');
    const sent = worker.messages[0] as { kind: string; input: MonteCarloInput };
    expect(sent.kind).toBe('runShard');
    // The production default, not the test override.
    expect(sent.input.pathCount).toBe(MC_PATH_COUNT);
    // The page's own derivation: the seed of the signature of the input it hashes.
    expect(sent.input.seed).toBe(seedFromString(hashMcInput(input, false)));
    expect(await monteCarloCacheCount()).toBe(0);
    expect(await peekCached(key)).toBeNull();
  });

  it('reports a worker’s own error message as INTERNAL, cut to a short length', async () => {
    const worker = recordingFactory(`bad input ${'x'.repeat(500)}`);
    const result = await callDefinition(makeStressTestTool({ workerFactory: worker.factory }), {});
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(!result.ok && result.error.message.length).toBeLessThan(300);
    expect(!result.ok && result.error.message).toContain('bad input');
  });

  it('computes the page’s numbers on one shard and on three, reports monotonic progress ending at the path count, and writes nothing', async () => {
    const input = { ...(await baseInput()), pathCount: TEST_PATHS };
    // The page's seed, derived the way its hook does.
    const seed = seedFromString(hashMcInput(input, false));
    const expected: MonteCarloSummary = runMonteCarlo({ ...input, seed });
    const key = await mcCacheKey(input);

    for (const cores of [2, 4]) {
      setCores(cores);
      const { factory, workers } = makeFactory();
      const progress: Array<{ fraction?: number; message?: string }> = [];
      const result = await callDefinition(
        makeStressTestTool({ workerFactory: factory, pathCount: TEST_PATHS }),
        {},
        contextWith({ progress: (update) => progress.push(update) }),
      );
      const data = envelopeOf(result).data as unknown as StressData;

      expect(workers.length, `${cores} cores`).toBe(cores === 2 ? 1 : 3);
      expect(data.source).toBe('computed');
      expect(data.pathCount).toBe(TEST_PATHS);
      expect(data.seed).toBe(seed);
      expect(data.successProbability).toBe(expected.successProbability);
      expect(data.tiers.typical).toEqual({
        percentile: 50,
        endingBalanceReal: expected.medianEndingBalanceReal,
        endingBalanceNominal: expected.medianEndingBalanceNominal,
        depletionYear: expected.medianDepletionYear,
      });
      expect(data.tiers.pessimistic).toEqual({
        percentile: 25,
        endingBalanceReal: expected.p25EndingBalanceReal,
        endingBalanceNominal: expected.p25EndingBalanceNominal,
        depletionYear: expected.p25DepletionYear,
      });
      expect(data.tiers.badLuck).toEqual({
        percentile: 10,
        endingBalanceReal: expected.p10EndingBalanceReal,
        endingBalanceNominal: expected.p10EndingBalanceNominal,
        depletionYear: expected.p10DepletionYear,
      });
      expect(data.percentilesReal).toEqual(expected.percentilesReal);
      expect(data.firstYear).toBe(expected.firstYear);

      const fractions = progress.map((update) => update.fraction!);
      expect(fractions.length).toBeGreaterThan(1);
      expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
      expect(fractions.at(-1)).toBe(1);
      expect(progress.at(-1)!.message).toContain(`${TEST_PATHS} of ${TEST_PATHS}`);
      expect(await monteCarloCacheCount()).toBe(0);
      expect(await peekCached(key)).toBeNull();
    }
  }, COMPUTE_TIMEOUT);

  it('uses the full path count unless a test lowers it', async () => {
    const worker = recordingFactory();
    await callDefinition(makeStressTestTool({ workerFactory: worker.factory }), {});
    expect((worker.messages[0] as { input: MonteCarloInput }).input.pathCount).toBe(MC_PATH_COUNT);
    const lowered = recordingFactory();
    await callDefinition(makeStressTestTool({ workerFactory: lowered.factory, pathCount: 50 }), {});
    expect((lowered.messages[0] as { input: MonteCarloInput }).input.pathCount).toBe(50);
  });
});

describe('the caps', () => {
  /** Starts a call whose workers never reply, and waits until its pool exists. */
  async function startHanging(context: ToolCallContext) {
    const { factory, workers } = makeFactory({ manual: true });
    const settled = callDefinition(makeStressTestTool({ workerFactory: factory }), {}, context);
    await vi.waitFor(() => expect(workers.length).toBeGreaterThan(0));
    return { settled, workers };
  }

  it('fails with COMPUTE_CAP_EXCEEDED at the wall clock and terminates every worker', async () => {
    setCores(4);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { factory, workers } = makeFactory({ manual: true });
    const settled = callDefinition(makeStressTestTool({ workerFactory: factory }), {});
    await vi.waitFor(() => expect(workers.length).toBe(3));
    expect(workers.every((worker) => !worker.terminated)).toBe(true);

    // `vi.waitFor` moved the fake clock a little, so stay well inside the cap, then pass it.
    await vi.advanceTimersByTimeAsync(STRESS_TEST_WALL_CLOCK_MS - 5_000);
    expect(workers.every((worker) => !worker.terminated)).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await settled;

    expect(result).toMatchObject({ ok: false, error: { code: 'COMPUTE_CAP_EXCEEDED' } });
    expect(!result.ok && result.error.message).toMatch(/not shortened/);
    expect(workers.every((worker) => worker.terminated)).toBe(true);
    expect(await monteCarloCacheCount()).toBe(0);
  });

  it('answers CANCELLED when the call’s signal aborts, and terminates the workers', async () => {
    setCores(4);
    const controller = new AbortController();
    const { settled, workers } = await startHanging(contextWith({ signal: controller.signal }));
    controller.abort();
    expect(await settled).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(workers.length).toBe(3);
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  it('answers CANCELLED without building a worker when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const worker = recordingFactory();
    const result = await callDefinition(makeStressTestTool({ workerFactory: worker.factory }), {}, contextWith({ signal: controller.signal }));
    expect(result).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(worker.constructed()).toBe(0);
  });

  it('fails a second concurrent run fast with TOO_MANY_IN_FLIGHT, building no worker, and frees the slot afterwards', async () => {
    const controller = new AbortController();
    const { factory, workers } = makeFactory({ manual: true });
    const tool = makeStressTestTool({ workerFactory: factory });
    const first = callDefinition(tool, {}, contextWith({ signal: controller.signal }));
    await vi.waitFor(() => expect(workers.length).toBeGreaterThan(0));
    const built = workers.length;

    const second = await callDefinition(tool, {});
    expect(second).toMatchObject({ ok: false, error: { code: 'TOO_MANY_IN_FLIGHT' } });
    expect(workers.length).toBe(built);

    controller.abort();
    expect(await first).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    const worker = recordingFactory();
    const again = await callDefinition(makeStressTestTool({ workerFactory: worker.factory }), {});
    expect(again).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    // The same instance accepts a new run once the first has ended.
    const reuse = callDefinition(tool, {}, contextWith({ signal: AbortSignal.abort() }));
    expect(await reuse).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
  });

  it('does not count a saved result against the one-at-a-time cap', async () => {
    const input = await baseInput();
    await putCached(await mcCacheKey(input), savedSummary());
    const controller = new AbortController();
    const { factory, workers } = makeFactory({ manual: true });
    const tool = makeStressTestTool({ workerFactory: factory });
    // A different scenario misses and hangs...
    const hanging = callDefinition(tool, { scenarioId: EARLY_ID }, contextWith({ signal: controller.signal }));
    await vi.waitFor(() => expect(workers.length).toBeGreaterThan(0));
    // ...while the saved one is still answered.
    expect(envelopeOf(await callDefinition(tool, { scenarioId: BASE_ID })).data).toMatchObject({ source: 'cache' });
    controller.abort();
    await hanging;
  });

  it('disposes the pool when the dispatcher tears the session down mid-run', async () => {
    setCores(4);
    const { factory, workers } = makeFactory({ manual: true });
    const sent: TabFrame[] = [];
    const dispatcher = new CallDispatcher({
      registry: TOOL_REGISTRY,
      timers: { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
      now: () => TEST_NOW.getTime(),
      isWorkspaceReady: () => true,
      getConsent: () => createConsentRecord(defaultConsentAnswer(), 0, 1),
      appBuildId: 'test-build',
      send: (frame) => sent.push(frame),
      onSettled: () => undefined,
    });
    dispatcher.register('retivo_get_stress_test', toHandler(makeStressTestTool({ workerFactory: factory })));
    dispatcher.handleCall({ id: 'call-1', tool: 'retivo_get_stress_test', args: {} });
    await vi.waitFor(() => expect(workers.length).toBe(3));

    dispatcher.abortAll();
    await vi.waitFor(() => expect(workers.every((worker) => worker.terminated)).toBe(true));
    // A torn-down session sends no answer.
    expect(sent.filter((frame) => frame.type === 'result')).toEqual([]);
  });
});

describe('arguments and scenarios', () => {
  it('is INVALID_ARGS, saying what is missing, for a scenario the page could not run', async () => {
    const base = scenarios.find((scenario) => scenario.id === BASE_ID)!;
    await putAggregate('scenario', { ...base, id: 't-no-retirement', payload: { ...base.payload, name: 'No retirement', isPrimary: false, parentScenarioId: null, overrides: {} } });
    scenarios = (await listAggregates('scenario')) as Aggregate<ScenarioPayload>[];
    const worker = recordingFactory();
    const result = await callDefinition(makeStressTestTool({ workerFactory: worker.factory }), { scenarioId: 't-no-retirement' });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    expect(JSON.stringify(result)).toMatch(/retirement age/);
    expect(worker.constructed()).toBe(0);
  });

  it('runs nothing and answers the refusal on a miss while a switch the analysis draws on is off', async () => {
    const run = vi.fn();
    const result = await callDefinition(makeStressTestTool({ runner: { pathCount: MC_PATH_COUNT, run } }), {}, toolContext(choicesWith({ balances: false })));
    expect(envelopeOf(result).data).toMatchObject({ omittedSections: ['balances'] });
    expect(run).not.toHaveBeenCalled();
    expect(await monteCarloCacheCount()).toBe(0);
  });

  it('defaults to the base scenario', async () => {
    const input = await baseInput();
    await putCached(await mcCacheKey(input), savedSummary());
    const data = envelopeOf(await callDefinition(makeStressTestTool(), {})).data as unknown as StressData;
    expect(data.scenarioId).toBe(BASE_ID);
  });

  it('carries the sampling-error note, the seed rule and the source in its envelope', async () => {
    const input = await baseInput();
    await putCached(await mcCacheKey(input), savedSummary());
    const envelope = envelopeOf(await callDefinition(makeStressTestTool(), {}));
    expect(envelope.assumptions.some((line) => /Sampling error:.*0\.5 percentage points/.test(line))).toBe(true);
    expect(envelope.assumptions.some((line) => /Seed rule:/.test(line))).toBe(true);
    expect((envelope.data as { sourceNote: string }).sourceNote).toMatch(/Nothing was recalculated/);
  });
});

