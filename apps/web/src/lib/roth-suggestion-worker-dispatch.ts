/**
 * Page → Roth suggestion Web Worker dispatch. Sibling of
 * `dispatchToOptimizerWorker`, which resolves on the first message carrying
 * its `runId` and so cannot forward progress: this one forwards every
 * `progress` message of its own run to `onProgress` and resolves on the
 * terminal reply, the shape `McPool.dispatch`'s `onProgress` uses.
 *
 * `runId` correlation is the same as the claim-age dispatch: a reply (progress
 * or terminal) from another run, such as one the user cancelled, is ignored.
 * Per-call listeners are removed on every resolution. The worker lifecycle
 * (spawn, terminate on cancel, terminate on unmount) is the hook's; this
 * wraps one round-trip.
 */
import { cryptoUuid } from './crypto-uuid';
import type {
  RothSuggestionWorkerInbound,
  RothSuggestionWorkerInput,
  RothSuggestionWorkerOutbound,
  RothSuggestionWorkerTerminal,
} from '../workers/roth-suggestion.worker';

export interface RothSuggestionTick {
  readonly done: number;
  readonly total: number;
}

export function dispatchToRothSuggestionWorker(
  worker: Worker,
  input: RothSuggestionWorkerInput,
  onProgress?: (tick: RothSuggestionTick) => void,
): Promise<RothSuggestionWorkerTerminal> {
  const runId = cryptoUuid();
  const scenarioId = input.projection.selectedScenarioId;
  return new Promise((resolve) => {
    const cleanup = (): void => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };
    const onMessage = (ev: MessageEvent<RothSuggestionWorkerOutbound>): void => {
      const msg = ev.data;
      if (!msg || msg.runId !== runId) return;
      if (msg.kind === 'progress') {
        onProgress?.({ done: msg.done, total: msg.total });
        return;
      }
      cleanup();
      resolve(msg);
    };
    const onError = (e: ErrorEvent): void => {
      cleanup();
      resolve({
        kind: 'error',
        runId,
        scenarioId,
        message: e.message || 'Worker crashed',
      });
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    const msg: RothSuggestionWorkerInbound = { kind: 'run', runId, input };
    worker.postMessage(msg);
  });
}
