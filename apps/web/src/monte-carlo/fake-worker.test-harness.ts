/**
 * Shared fixtures for the `MonteCarloProvider.*.test.tsx` suites. TEST-ONLY.
 *
 * `vi.mock` is hoisted, so each suite keeps its own `vi.mock(...)` calls and
 * its own `vi.hoisted` state. What lives here is what those suites only ever
 * copied: the tiny run input, a canned summary, the core-count stub, the act
 * settle helper, and the "never replies" fake worker module.
 */
import { act } from '@testing-library/react';
import { ENGINE_VERSION, type MonteCarloInput, type MonteCarloSummary } from '../lib/monte-carlo';

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

/**
 * The `?worker` module for a fake worker that supports BOTH worker protocols
 * (single-worker `onmessage`, pool `addEventListener`) and never replies, so a
 * run settles only through the provider's own teardown paths. Every
 * construction is pushed onto `sink.workers`; when `sink.posted` is given, the
 * `kind` of each posted message is recorded there.
 */
export function neverRepliesWorkerModule(sink: { workers: Array<{ terminated: boolean }>; posted?: string[] }) {
  class FakeMcWorker {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: { message?: string }) => void) | null = null;
    terminated = false;
    constructor() {
      sink.workers.push(this);
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    postMessage(msg: unknown): void {
      sink.posted?.push((msg as { kind?: string })?.kind ?? 'unknown');
    }
    terminate(): void {
      this.terminated = true;
    }
  }
  return { default: FakeMcWorker };
}
