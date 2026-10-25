// Posts one `OptimizerWorkerInput` tagged with a fresh `runId` and resolves on the worker's reply for that id; the page owns the worker lifecycle.
// Matching `runId`, not just `scenarioId`: when the page effect re-runs mid-flight, the old dispatch's reply would otherwise satisfy the new listener and render stale data.

import { cryptoUuid } from './crypto-uuid';
import type {
  OptimizerWorkerInbound,
  OptimizerWorkerInput,
  OptimizerWorkerOutbound,
} from '../workers/claim-age-optimizer.worker';

export function dispatchToOptimizerWorker(
  worker: Worker,
  input: OptimizerWorkerInput,
): Promise<OptimizerWorkerOutbound> {
  const runId = cryptoUuid();
  return new Promise((resolve) => {
    const cleanup = (): void => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };
    const onMessage = (ev: MessageEvent<OptimizerWorkerOutbound>): void => {
      const msg = ev.data;
      // Both keys: `scenarioId` alone matches a stale reply to a re-registered listener.
      if (!msg || msg.scenarioId !== input.scenarioId || msg.runId !== runId) {
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
        scenarioId: input.scenarioId,
        message: e.message ?? 'Worker crashed',
      });
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    const msg: OptimizerWorkerInbound = { kind: 'run', runId, input };
    worker.postMessage(msg);
  });
}
