/**
 * Roth conversion suggestion — run state. Owns the Web Worker (lazy spawn,
 * terminate on cancel, terminate on unmount, respawn on the next run) and the
 * state machine the panel renders: idle, running with ticks, done, cancelled,
 * error. A reply from a run the user cancelled, or from before a scenario
 * switch, is dropped by the run counter (the `isCurrentRun` idea in
 * `ss-optimizer-page-helpers.ts`).
 *
 * A finished run is tagged with the aggregate signature it ran on, so the
 * panel can mark it out of date. Nothing here runs on its own: a run costs
 * seconds and starts only from `run`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { buildCandidateGrid } from '../../lib/roth-suggestion/candidate-grid';
import type { RothSuggestionUnsupportedReason } from '../../lib/roth-suggestion/types';
import { dispatchToRothSuggestionWorker } from '../../lib/roth-suggestion-worker-dispatch';
import type {
  RothSuggestionWorkerInput,
  RothSuggestionWorkerResult,
} from '../../workers/roth-suggestion.worker';
// Worker spawned via Vite's `?worker` ESM transform — a separate JS chunk
// loaded on the first run.
import RothSuggestionWorker from '../../workers/roth-suggestion.worker.ts?worker';

type RothSuggestionOutcome =
  | { readonly kind: 'result'; readonly result: RothSuggestionWorkerResult }
  | { readonly kind: 'empty'; readonly reason: RothSuggestionUnsupportedReason };

type RothSuggestionRunState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'running'; readonly done: number; readonly total: number }
  | {
      readonly phase: 'done';
      readonly outcome: RothSuggestionOutcome;
      /** The aggregate signature the run started on. */
      readonly signature: string;
    }
  | { readonly phase: 'cancelled' }
  | { readonly phase: 'error'; readonly message: string };

const IDLE: RothSuggestionRunState = { phase: 'idle' };

/** Candidates in a full search: the bar's total until the first tick. */
const CANDIDATE_COUNT = buildCandidateGrid().length;

export interface UseRothSuggestionResult {
  readonly state: RothSuggestionRunState;
  readonly run: (input: RothSuggestionWorkerInput) => void;
  readonly cancel: () => void;
}

/**
 * @param scenarioId  Switching it drops the result and stops a run in flight.
 * @param signature   Content signature of the aggregates a run starts on.
 */
export function useRothSuggestion(scenarioId: string, signature: string): UseRothSuggestionResult {
  const [state, setState] = useState<RothSuggestionRunState>(IDLE);
  const [stateScenarioId, setStateScenarioId] = useState(scenarioId);
  // Drop the previous scenario's result in the same render the scenario
  // changes, so it is never painted against the new one.
  if (stateScenarioId !== scenarioId) {
    setStateScenarioId(scenarioId);
    setState(IDLE);
  }
  const workerRef = useRef<Worker | null>(null);
  const runIdRef = useRef(0);

  const dispose = useCallback((): void => {
    runIdRef.current += 1;
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);

  // A scenario switch (and unmount) stops a run in flight.
  useEffect(() => dispose, [scenarioId, dispose]);

  const run = useCallback(
    (input: RothSuggestionWorkerInput): void => {
      const myRunId = runIdRef.current + 1;
      runIdRef.current = myRunId;
      workerRef.current ??= new RothSuggestionWorker();
      setState({ phase: 'running', done: 0, total: CANDIDATE_COUNT });
      void dispatchToRothSuggestionWorker(workerRef.current, input, (tick) => {
        if (myRunId !== runIdRef.current) return;
        setState({ phase: 'running', done: tick.done, total: tick.total });
      }).then((reply) => {
        if (myRunId !== runIdRef.current) return;
        if (reply.kind === 'error') {
          setState({ phase: 'error', message: reply.message });
        } else if (reply.kind === 'empty') {
          setState({ phase: 'done', outcome: { kind: 'empty', reason: reply.reason }, signature });
        } else {
          setState({ phase: 'done', outcome: { kind: 'result', result: reply.result }, signature });
        }
      });
    },
    [signature],
  );

  // Cancel is termination: it stops the search whether or not it yields.
  const cancel = useCallback((): void => {
    dispose();
    setState({ phase: 'cancelled' });
  }, [dispose]);

  return { state, run, cancel };
}
