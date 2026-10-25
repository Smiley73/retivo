// The sharding coordinator driven through fake `MinimalMcWorker`s that compute in-process, so a run must equal a plain
// `runMonteCarlo`; `mcPoolSize` reads `navigator.hardwareConcurrency`, stubbed per test to pin the shard count.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMonteCarlo, type MonteCarloInput } from '../lib/monte-carlo';
import { summaryToComparable, makeMonthlyExpenseBase } from '../lib/monte-carlo.test-helpers';
import { makeFactory } from './computing-fake-worker.test-harness';
import { runMonteCarloSharded } from './run-monte-carlo-sharded';

const HORIZON = 12;
const STEP_COUNT = HORIZON * 12;

function buildInput(overrides?: Partial<MonteCarloInput>): MonteCarloInput {
  const contribPost = new Float64Array(STEP_COUNT);
  for (let i = 0; i < 5 * 12; i += 1) contribPost[i] = 500;
  return {
    portfolioToday: 300_000,
    accountMcLedger: [
      {
        id: 'brokerage',
        ownerId: 'member-1',
        initialPre: 0,
        initialPost: 300_000,
        contribPre: new Float64Array(STEP_COUNT),
        contribPost,
        deposit: new Float64Array(STEP_COUNT),
        assetMix: { stocksPct: 60, bondsPct: 35, cashPct: 5 },
        assetMixSeries: null,
        cbpPlanningReturnPct: null,
        taxTreatment: 'POST_TAX',
        accountType: 'BROKERAGE',
      },
    ],
    annualContribution: 6_000,
    firstYear: 2026,
    retirementYear: 2031,
    horizonYear: 2026 + HORIZON - 1,
    monthlyExpenseBase: makeMonthlyExpenseBase(70_000, STEP_COUNT),
    ssByYear: Array.from({ length: HORIZON }, (_v, i) => (2026 + i >= 2031 ? 20_000 : 0)),
    incomeByYear: Array.from({ length: HORIZON }, () => 0),
    pathCount: 40,
    seed: 4242,
    strategyKind: 'taxEfficient',
    scenarioInflationPct: 3,
    todayMonthIndex: 6,
    ...overrides,
  };
}

function setCores(n: number): void {
  Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: n });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runMonteCarloSharded', () => {
  it('produces a summary bit-identical to a serial run (single-shard fallback)', async () => {
    setCores(2); // → mcPoolSize(40) = 1 shard
    const input = buildInput();
    const { factory, workers } = makeFactory();
    const reply = await runMonteCarloSharded(input, { factory });
    expect(reply.kind).toBe('result');
    if (reply.kind === 'result') {
      expect(summaryToComparable(reply.summary)).toEqual(summaryToComparable(runMonteCarlo(input)));
    }
    const runShards = workers.flatMap((w) => w.postedMessages).filter(
      (m) => (m as { kind: string }).kind === 'runShard',
    );
    expect(runShards).toHaveLength(1);
  });

  it('produces a bit-identical summary across multiple shards', async () => {
    setCores(4); // → mcPoolSize(40) = 3 shards
    const input = buildInput();
    const { factory, workers } = makeFactory();
    const reply = await runMonteCarloSharded(input, { factory });
    expect(reply.kind).toBe('result');
    if (reply.kind === 'result') {
      expect(summaryToComparable(reply.summary)).toEqual(summaryToComparable(runMonteCarlo(input)));
    }
    const runShards = workers
      .flatMap((w) => w.postedMessages)
      .filter((m): m is { kind: 'runShard'; pathStart: number; pathEnd: number } =>
        (m as { kind: string }).kind === 'runShard',
      )
      .sort((a, b) => a.pathStart - b.pathStart);
    expect(runShards).toHaveLength(3);
    expect(runShards[0].pathStart).toBe(0);
    expect(runShards[runShards.length - 1].pathEnd).toBe(input.pathCount);
    for (let i = 1; i < runShards.length; i += 1) {
      expect(runShards[i].pathStart).toBe(runShards[i - 1].pathEnd);
    }
  });

  it('never transfers input on a shard dispatch, but transfers the assemble payload', async () => {
    setCores(4); // 3 shards — input is the shared object across all of them
    const input = buildInput();
    const { factory, workers } = makeFactory();
    await runMonteCarloSharded(input, { factory });
    const all = workers.flatMap((w) =>
      w.postedMessages.map((m, i) => ({ msg: m as { kind: string }, transfer: w.postedTransfers[i] })),
    );
    const shardDispatches = all.filter((e) => e.msg.kind === 'runShard');
    const assembleDispatches = all.filter((e) => e.msg.kind === 'assemble');
    expect(shardDispatches).toHaveLength(3);
    // `input` is shared across every shard, so it must not be transferred: detaching its buffers would corrupt later dispatches.
    for (const e of shardDispatches) {
      expect(e.transfer === undefined || e.transfer.length === 0).toBe(true);
    }
    expect(assembleDispatches).toHaveLength(1);
    expect(assembleDispatches[0].transfer && assembleDispatches[0].transfer.length).toBeGreaterThan(0);
  });

  it('sums shard progress monotonically to pathCount', async () => {
    setCores(4);
    const input = buildInput();
    const { factory } = makeFactory();
    const calls: Array<[number, number]> = [];
    await runMonteCarloSharded(input, {
      factory,
      onProgress: (done, total) => calls.push([done, total]),
    });
    expect(calls.length).toBeGreaterThan(0);
    for (let i = 1; i < calls.length; i += 1) expect(calls[i][0]).toBeGreaterThanOrEqual(calls[i - 1][0]);
    for (const [, total] of calls) expect(total).toBe(input.pathCount);
    expect(calls[calls.length - 1][0]).toBe(input.pathCount);
  });

  it('resolves aborted + disposes the pool when the signal fires mid-shard', async () => {
    setCores(4);
    const input = buildInput();
    const { factory, workers } = makeFactory({ manual: true }); // workers never reply
    const controller = new AbortController();
    const promise = runMonteCarloSharded(input, { factory, signal: controller.signal });
    controller.abort();
    const reply = await promise;
    expect(reply).toEqual({ kind: 'aborted' });
    expect(workers.every((w) => w.terminated)).toBe(true);
  });

  it('propagates a shard error', async () => {
    setCores(4);
    const input = buildInput();
    const { factory } = makeFactory({ shardError: 'shard boom' });
    const reply = await runMonteCarloSharded(input, { factory });
    expect(reply).toEqual({ kind: 'error', message: 'shard boom' });
  });

  it('propagates an assemble-phase error (all shards resolved first)', async () => {
    setCores(4); // 3 shards resolve normally, then assemble errors
    const input = buildInput();
    const { factory, workers } = makeFactory({ assembleError: 'assemble boom' });
    const reply = await runMonteCarloSharded(input, { factory });
    expect(reply).toEqual({ kind: 'error', message: 'assemble boom' });
    expect(workers.every((w) => w.terminated)).toBe(true);
  });

  it('resolves aborted + disposes the pool when the signal fires at the assemble dispatch', async () => {
    setCores(4); // 3 shards resolve, then abort fires exactly at assemble
    const input = buildInput();
    const controller = new AbortController();
    // Abort fires when the assemble message is posted, exercising the assemble-phase abort branch.
    const { factory, workers } = makeFactory({ onAssemblePost: () => controller.abort() });
    const reply = await runMonteCarloSharded(input, { factory, signal: controller.signal });
    expect(reply).toEqual({ kind: 'aborted' });
    expect(workers.every((w) => w.terminated)).toBe(true);
  });

  it('throws synchronously on malformed input before constructing any worker', async () => {
    setCores(4);
    const bad = buildInput({ ssByYear: [0, 0] }); // length 2 ≠ horizon 12
    const { factory, workers } = makeFactory();
    await expect(runMonteCarloSharded(bad, { factory })).rejects.toThrow(
      /ssByYear\.length \(2\) !== horizon \(12\)/,
    );
    expect(workers).toHaveLength(0);
    expect(() => runMonteCarlo(bad)).toThrow(/ssByYear\.length \(2\) !== horizon \(12\)/);
  });
});
