/**
 * Roth conversion suggestion Web Worker: runs `searchRothSuggestions` on the
 * page's aggregate set and posts progress ticks, then one terminal reply, every
 * message carrying the page's `runId`. Cancel is `worker.terminate()` from the
 * page, so the search runs without an `AbortSignal`.
 */
import { searchRothSuggestions } from '../lib/roth-suggestion/search';
import { friendlyProjectionErrorMessage } from '../lib/tax-integration';
import type {
  RothCandidate,
  RothSuggestionDeathAges,
  RothSuggestionOk,
  RothSuggestionProjectionInput,
  RothSuggestionResult,
  RothSuggestionUnsupportedReason,
} from '../lib/roth-suggestion/types';

/** What the page sends; the tax bundle is the default one on both sides. */
export interface RothSuggestionWorkerInput {
  readonly projection: Omit<RothSuggestionProjectionInput, 'bundle'>;
  readonly targetRothAccountId: string;
  /** A fraction in [0, 1). */
  readonly leftoverTaxRate: number;
  readonly deathAges: RothSuggestionDeathAges;
}

/** A candidate without its raw `drawdownYears`, the heaviest part of the clone
 *  and nothing the page reads. */
export type RothSuggestionWorkerCandidate = Omit<RothCandidate, 'drawdownYears'>;

export interface RothSuggestionWorkerResult extends Omit<RothSuggestionOk, 'candidates'> {
  readonly candidates: readonly RothSuggestionWorkerCandidate[];
}

export interface RothSuggestionWorkerInbound {
  kind: 'run';
  runId: string;
  input: RothSuggestionWorkerInput;
}

type RothSuggestionWorkerProgress = {
  kind: 'progress';
  runId: string;
  /** Candidates finished so far. */
  done: number;
  /** Candidates in the search. */
  total: number;
};

export type RothSuggestionWorkerTerminal =
  | {
      kind: 'result';
      runId: string;
      scenarioId: string;
      result: RothSuggestionWorkerResult;
    }
  | {
      kind: 'empty';
      runId: string;
      scenarioId: string;
      reason: RothSuggestionUnsupportedReason;
    }
  | { kind: 'error'; runId: string; scenarioId: string; message: string };

export type RothSuggestionWorkerOutbound =
  | RothSuggestionWorkerProgress
  | RothSuggestionWorkerTerminal;

function slimCandidate(candidate: RothCandidate): RothSuggestionWorkerCandidate {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-to-omit: strip the heavy raw rows from the clone
  const { drawdownYears, ...slim } = candidate;
  return slim;
}

function slimResult(ok: RothSuggestionOk): RothSuggestionWorkerResult {
  return { ...ok, candidates: ok.candidates.map(slimCandidate) };
}

function terminalFor(
  runId: string,
  scenarioId: string,
  result: RothSuggestionResult,
): RothSuggestionWorkerTerminal {
  switch (result.kind) {
    case 'ok':
      return { kind: 'result', runId, scenarioId, result: slimResult(result) };
    case 'unsupported':
      return { kind: 'empty', runId, scenarioId, reason: result.reason };
    case 'error':
      return { kind: 'error', runId, scenarioId, message: result.message };
    case 'cancelled':
      // Unreachable without a signal; reply anyway so the page never waits.
      return { kind: 'error', runId, scenarioId, message: 'The comparison was cancelled.' };
  }
}

/**
 * Runs one search and posts its progress and terminal reply through `post`.
 * Never rejects: any failure becomes an `error` reply carrying the `runId`.
 */
export async function runRothSuggestion(
  runId: string,
  input: RothSuggestionWorkerInput,
  post: (message: RothSuggestionWorkerOutbound) => void,
): Promise<void> {
  const scenarioId = input.projection.selectedScenarioId;
  if (!input.projection.scenarios.some((s) => s.id === scenarioId)) {
    post({ kind: 'error', runId, scenarioId, message: `Unknown scenario id: ${scenarioId}` });
    return;
  }
  try {
    const result = await searchRothSuggestions({
      projection: input.projection,
      targetRothAccountId: input.targetRothAccountId,
      leftoverTaxRate: input.leftoverTaxRate,
      deathAges: input.deathAges,
      onProgress: ({ candidatesDone, candidatesTotal }) => {
        post({ kind: 'progress', runId, done: candidatesDone, total: candidatesTotal });
      },
    });
    post(terminalFor(runId, scenarioId, result));
  } catch (e) {
    const err = e as Error;
    post({
      kind: 'error',
      runId,
      scenarioId,
      message: friendlyProjectionErrorMessage(e) ?? err.message ?? String(err),
    });
  }
}

/** Registers the message listener on a target global (tests pass a fake `self`). */
export function registerRothSuggestionWorkerListener(target: {
  addEventListener: typeof self.addEventListener;
  postMessage: typeof self.postMessage;
}): void {
  target.addEventListener('message', (ev: Event) => {
    const msg = (ev as MessageEvent<RothSuggestionWorkerInbound>).data;
    if (!msg || msg.kind !== 'run') return;
    void runRothSuggestion(msg.runId, msg.input, (out) => {
      target.postMessage(out);
    });
  });
}

// Register only in a real worker global, so importing this module on the main
// thread or in jsdom adds no `message` listener to `window`.
const WORKER_GLOBAL_SCOPE_CTOR =
  typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope === 'function'
    ? ((globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope as new (
        ...args: unknown[]
      ) => unknown)
    : null;
if (WORKER_GLOBAL_SCOPE_CTOR !== null && self instanceof WORKER_GLOBAL_SCOPE_CTOR) {
  registerRothSuggestionWorkerListener(self);
}
