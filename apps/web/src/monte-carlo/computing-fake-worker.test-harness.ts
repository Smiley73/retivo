// A fake `MinimalMcWorker` factory whose workers compute in-process, so a sharded run produces a real summary that must equal a plain `runMonteCarlo`. Shared by the coordinator's tests and the AI assistant stress-test tool's.
import {
  buildRunContext,
  type MonteCarloInput,
} from '../lib/monte-carlo';
import { assembleMonteCarloSummary } from '../lib/monte-carlo-summary';
import { assembleAccumulationFromTyped, runPathRange } from '../lib/monte-carlo-shard';
import type { MinimalMcWorker } from './mc-worker-pool';

export interface FakeWorker extends MinimalMcWorker {
  readonly postedMessages: unknown[];
  readonly postedTransfers: Array<Transferable[] | undefined>;
  terminated: boolean;
}

export interface FakeOpts {
  shardError?: string;
  assembleError?: string;
  // Called synchronously when `assemble` is posted, before any reply, so a test can abort exactly there.
  onAssemblePost?: () => void;
  // Never reply (for abort tests).
  manual?: boolean;
}

export function makeFactory(opts: FakeOpts = {}): { factory: () => MinimalMcWorker; workers: FakeWorker[] } {
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
