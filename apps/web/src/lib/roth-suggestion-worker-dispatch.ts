/**
 * One page → Roth suggestion worker round-trip: forwards the run's `progress`
 * messages to `onProgress`, resolves on its terminal reply, ignores replies
 * carrying another `runId`. The worker lifecycle is the hook's.
 */
import { cryptoUuid } from './crypto-uuid';
import type {
  RothSuggestionWorkerInbound,
  RothSuggestionWorkerInput,
  RothSuggestionWorkerOutbound,
  RothSuggestionWorkerTerminal,
} from '../workers/roth-suggestion.worker';

interface RothSuggestionTick {
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
