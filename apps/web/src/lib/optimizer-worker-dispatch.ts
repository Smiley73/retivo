/**
 * Page → optimizer Web Worker dispatch helper. Posts one
 * `OptimizerWorkerInput` tagged with a fresh `runId`, resolves when the
 * worker replies with that exact `runId` (filters cross-talk if a later
 * run lands first OR if a previous run's reply arrives while a new
 * dispatch is registered for the same scenario). Cleans up per-call
 * listeners on every resolution so handlers never leak across runs.
 * The worker lifecycle (spawn/terminate) is owned by the page; this
 * helper only wraps a single round-trip.
 *
 * Why `runId` (not just `scenarioId`). The page effect can re-run
 * mid-flight (aggregates change via WORKSPACE_CHANGED_EVENT or
 * cross-tab sync). When it does, a fresh listener is registered for the
 * same `scenarioId` while the OLD dispatch is still pending. Without a
 * per-call id, the OLD reply matches the NEW listener and the page
 * renders stale data; the page-level `runIdRef` cancellation guard
 * catches the OLD loop's await but not the NEW loop receiving the OLD
 * reply.
 *
 * Extracted from `SsOptimizerPage.tsx` to keep that file under the
 * ≤400-ln shape limit; the page imports this for every scenario
 * dispatch.
 */
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
      // Filter on BOTH keys — scenarioId alone is insufficient when a
      // re-render registers a new listener for the same scenario before
      // the old reply lands.
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
