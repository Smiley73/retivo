// Shared fixtures for the `MonteCarloProvider.*.test.tsx` suites and the `createMcPool` consumers' hook tests. Each
// suite keeps its own hoisted `vi.mock` calls and `vi.hoisted` state.
import { act } from '@testing-library/react';
import { ENGINE_VERSION, type MonteCarloInput, type MonteCarloSummary } from '../lib/monte-carlo';
import type { MinimalMcWorker } from './mc-worker-pool';

const HORIZON = 8;

/** A tiny, valid run input; `pathCount` picks the single-worker or sharded branch. */
export function buildInput(pathCount: number, seed = 7): MonteCarloInput {
  return {
    portfolioToday: 500_000,
    accountMcLedger: [],
    annualContribution: 0,
    firstYear: 2026,
    retirementYear: 2030,
    horizonYear: 2026 + HORIZON - 1,
    monthlyExpenseBase: new Array(HORIZON * 12).fill(0),
    ssByYear: new Array(HORIZON).fill(0),
    incomeByYear: new Array(HORIZON).fill(0),
    pathCount,
    seed,
    strategyKind: 'taxEfficient',
    events: [],
  } as unknown as MonteCarloInput;
}

/** Below `SHARD_MIN_PATHS` → the single-worker branch. */
export const smallInput = (seed: number): MonteCarloInput => buildInput(10, seed);
/** At/above `SHARD_MIN_PATHS`, with cores stubbed high → the sharded branch. */
export const largeInput = (seed: number): MonteCarloInput => buildInput(2000, seed);

export function setCores(n: number): void {
  Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: n });
}

/** The summary a fake worker posts back; carries the run's seed. */
export function fakeSummary(seed: number): MonteCarloSummary {
  return {
    engineVersion: ENGINE_VERSION,
    seed,
    pathCount: 10,
    computedAt: 0,
    firstYear: 2026,
    horizonYears: 1,
    percentilesNominal: { p10: [1], p25: [2], p50: [3] },
    percentilesReal: { p10: [1], p25: [2], p50: [3] },
    successProbability: 0.9,
    medianDepletionYear: null,
    p10DepletionYear: null,
    p25DepletionYear: null,
    medianEndingBalanceNominal: 100,
    medianEndingBalanceReal: 100,
    p10EndingBalanceNominal: 50,
    p10EndingBalanceReal: 50,
    p25EndingBalanceNominal: 70,
    p25EndingBalanceReal: 70,
    failureYearHistogram: [],
    endingBalanceHistogramNominal: [],
    endingBalanceHistogramReal: [],
    plannedOverlay: [],
  };
}

/** Let every follow-on microtask/macrotask of a released gate run. */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
  });
}

export interface SpawnedWorker {
  terminated: boolean;
  /** Seed of the `run` message this worker was posted, once posted. */
  seed?: number;
  /** Posts the canned result for `seed` through `onmessage`; a terminated worker, like a real one, delivers nothing. */
  deliver(): void;
}

/**
 * The `?worker` module for a fake worker that supports both worker protocols (single-worker `onmessage`, pool
 * `addEventListener`) and replies only when a test calls `deliver()`. Every construction is pushed onto `sink.workers`;
 * when `sink.posted` is given, the `kind` of each posted message is recorded there.
 */
export function neverRepliesWorkerModule(sink: { workers: SpawnedWorker[]; posted?: string[] }) {
  class FakeMcWorker implements SpawnedWorker {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: { message?: string }) => void) | null = null;
    terminated = false;
    seed?: number;
    constructor() {
      sink.workers.push(this);
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    postMessage(msg: unknown): void {
      const m = msg as { kind?: string; input?: { seed: number } };
      sink.posted?.push(m?.kind ?? 'unknown');
      if (m?.kind === 'run') this.seed = m.input?.seed;
    }
    terminate(): void {
      this.terminated = true;
    }
    deliver(): void {
      if (this.terminated || this.seed === undefined) return;
      this.onmessage?.(
        new MessageEvent('message', { data: { kind: 'result', summary: fakeSummary(this.seed) } }),
      );
    }
  }
  return { default: FakeMcWorker };
}

export interface Gate {
  resolve: () => void;
  reject: (e: unknown) => void;
}

export interface PreflightGates {
  /** seed → gate for that request's pending cache-key hash. */
  keyGates: Map<number, Gate>;
  /** cache key → gate for that request's pending cache read. */
  readGates: Map<string, Gate>;
  /** Summaries a cache read resolves with, keyed like the mocked key. */
  cached: Map<string, unknown>;
}

/** The `../db/monte-carlo-cache` module with every key hash and cache read held open until the test settles its gate. */
export function gatedCacheModule(gates: PreflightGates) {
  return {
    mcCacheKey: (input: MonteCarloInput) =>
      new Promise<string>((resolve, reject) => {
        gates.keyGates.set(input.seed, { resolve: () => resolve(`key-${input.seed}`), reject });
      }),
    getCached: (key: string) =>
      new Promise<unknown>((resolve, reject) => {
        gates.readGates.set(key, { resolve: () => resolve(gates.cached.get(key) ?? null), reject });
      }),
    putCached: async () => undefined,
  };
}

// Bounded so a preflight that never starts fails fast instead of hanging the suite.
async function waitForGate<K>(gates: Map<K, Gate>, key: K): Promise<Gate> {
  for (let i = 0; i < 200 && !gates.has(key); i += 1) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  const gate = gates.get(key);
  if (!gate) throw new Error(`no preflight gate for ${String(key)}`);
  return gate;
}

export const waitForKeyGate = (gates: PreflightGates, seed: number): Promise<Gate> =>
  waitForGate(gates.keyGates, seed);

export const waitForReadGate = (gates: PreflightGates, seed: number): Promise<Gate> =>
  waitForGate(gates.readGates, `key-${seed}`);

/** A fake `MinimalMcWorker` for `createMcPool` consumers: `posted` records every
 *  run input, and the `emit*` / `resolveResult` methods deliver replies by hand. */
export interface ControlledWorker extends MinimalMcWorker {
  resolveResult(summary: MonteCarloSummary): void;
  emitError(message: string): void;
  emitProgress(done: number, total: number): void;
  readonly posted: ReadonlyArray<MonteCarloInput>;
  readonly terminated: boolean;
}

export function controlledWorker(): ControlledWorker {
  const listeners = new Set<(ev: MessageEvent) => void>();
  const posted: MonteCarloInput[] = [];
  let terminated = false;
  const emit = (data: unknown): void => {
    const ev = { data } as MessageEvent;
    listeners.forEach((fn) => fn(ev));
  };
  return {
    posted,
    get terminated() {
      return terminated;
    },
    addEventListener(t, fn) {
      if (t !== 'error') listeners.add(fn);
    },
    removeEventListener(t, fn) {
      if (t !== 'error') listeners.delete(fn);
    },
    postMessage(msg: unknown) {
      const m = msg as { kind: 'run'; input: MonteCarloInput };
      posted.push(m.input);
    },
    terminate() {
      terminated = true;
    },
    resolveResult(summary: MonteCarloSummary) {
      emit({ kind: 'result', summary });
    },
    emitError(message: string) {
      emit({ kind: 'error', message });
    },
    emitProgress(done: number, total: number) {
      emit({ kind: 'progress', done, total });
    },
  };
}
