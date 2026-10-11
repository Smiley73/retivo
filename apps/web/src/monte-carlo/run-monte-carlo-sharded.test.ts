/**
 * Sharding coordinator. Driven through fake
 * `MinimalMcWorker`s that actually COMPUTE (`runPathRange` /
 * `assembleAccumulationFromTyped` / `assembleMonteCarloSummary` in-process), so
 * a single- or multi-shard coordinator run produces a real summary that must
 * equal a plain `runMonteCarlo`. Covers: fan-out message shapes, the
 * transfer-list boundary (`input` never transferred, the shard
 * reply + assemble message are), progress summing, abort mid-shard, shard
 * error propagation, and the synchronous validation gate.
 *
 * `mcPoolSize` reads `navigator.hardwareConcurrency`, stubbed per test to pin
 * the shard count deterministically.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRunContext,
  runMonteCarlo,
  type MonteCarloInput,
} from '../lib/monte-carlo';
import { assembleMonteCarloSummary } from '../lib/monte-carlo-summary';
import {
  assembleAccumulationFromTyped,
  runPathRange,
} from '../lib/monte-carlo-shard';
import { summaryToComparable, makeMonthlyExpenseBase } from '../lib/monte-carlo.test-helpers';
import type { MinimalMcWorker } from './mc-worker-pool';
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

interface FakeWorker extends MinimalMcWorker {
  readonly postedMessages: unknown[];
  readonly postedTransfers: Array<Transferable[] | undefined>;
  terminated: boolean;
}

interface FakeOpts {
  /** Reply to `runShard` with an error instead of a result. */
  shardError?: string;
  /** Reply to `assemble` with an error instead of a result. */
  assembleError?: string;
  /** Called synchronously when an `assemble` message is posted, BEFORE any
   *  reply — lets a test abort the signal exactly at the assemble dispatch. */
  onAssemblePost?: () => void;
  /** Never reply (used to test abort). */
  manual?: boolean;
}

function makeFactory(opts: FakeOpts = {}): { factory: () => MinimalMcWorker; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const factory = (): MinimalMcWorker => {
    const messageListeners = new Set<(ev: MessageEvent) => void>();
    const errorListeners = new Set<(ev: MessageEvent) => void>();
    const postedMessages: unknown[] = [];
    const postedTransfers: Array<Transferable[] | undefined> = [];
    const emit = (data: unknown): void => {
      const ev = { data } as MessageEvent;
      messageListeners.forEach((fn) => fn(ev));
    };
    const worker: FakeWorker = {
      postedMessages,
      postedTransfers,
      terminated: false,
      addEventListener(t, fn) {
        (t === 'error' ? errorListeners : messageListeners).add(fn);
      },
      removeEventListener(t, fn) {
        (t === 'error' ? errorListeners : messageListeners).delete(fn);
      },
      terminate() {
        worker.terminated = true;
      },
      postMessage(msg: unknown, transfer?: Transferable[]) {
        postedMessages.push(msg);
        postedTransfers.push(transfer);
        if (opts.manual) return;
        const m = msg as {
          kind: string;
          input: MonteCarloInput;
          pathStart: number;
          pathEnd: number;
          merged: Parameters<typeof assembleAccumulationFromTyped>[0];
        };
        if (m.kind === 'runShard') {
          if (opts.shardError !== undefined) {
            const err = opts.shardError;
            queueMicrotask(() => emit({ kind: 'error', message: err }));
            return;
          }
          queueMicrotask(() => {
            const runCtx = buildRunContext(m.input);
            const result = runPathRange(m.input, runCtx, m.pathStart, m.pathEnd, (done, total) =>
              emit({ kind: 'progress', done, total }),
            );
            emit({ kind: 'shardResult', result });
          });
        } else if (m.kind === 'assemble') {
          opts.onAssemblePost?.();
          if (opts.assembleError !== undefined) {
            const err = opts.assembleError;
            queueMicrotask(() => emit({ kind: 'error', message: err }));
            return;
          }
          queueMicrotask(() => {
            const runCtx = buildRunContext(m.input);
            const acc = assembleAccumulationFromTyped(m.merged, m.input);
            const summary = assembleMonteCarloSummary(m.input, runCtx, acc);
            emit({ kind: 'result', summary });
          });
        }
      },
    };
    workers.push(worker);
    return worker;
  };
  return { factory, workers };
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
    // Exactly one shard was created (single-shard) + reused for assemble.
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
    // Fan-out shapes: three contiguous, gap-free ranges covering [0, pathCount).
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
    // `input` is shared across every shard → must NOT be transferred (detaching
    // its buffers would corrupt later dispatches).
    for (const e of shardDispatches) {
      expect(e.transfer === undefined || e.transfer.length === 0).toBe(true);
    }
    // The assemble payload is single-recipient → zero-copy transferred.
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
    // Monotonic non-decreasing, total pinned to pathCount, terminal = pathCount.
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
    // The pool is torn down in the coordinator's `finally`.
    expect(workers.every((w) => w.terminated)).toBe(true);
  });

  it('resolves aborted + disposes the pool when the signal fires at the assemble dispatch', async () => {
    setCores(4); // 3 shards resolve, then abort fires exactly at assemble
    const input = buildInput();
    const controller = new AbortController();
    // Abort synchronously when the assemble message is posted — the in-flight
    // assemble dispatch settles as 'aborted', exercising the assemble-phase
    // abort branch (all shards already resolved).
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
    // Zero workers were ever built — the gate fired before any dispatch.
    expect(workers).toHaveLength(0);
    // Identical error to the serial path.
    expect(() => runMonteCarlo(bad)).toThrow(/ssByYear\.length \(2\) !== horizon \(12\)/);
  });
});
