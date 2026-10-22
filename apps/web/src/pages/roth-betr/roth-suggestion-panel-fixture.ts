/**
 * Shared harness for the suggestion panel suites: a fake `?worker` class that
 * records what the page sends and posts replies when a test releases them
 * (it keeps its listeners after `terminate()`, so only the run guard stands
 * between a late reply and the screen), plus the toy search result the panel
 * renders.
 */
import { toyProjection } from '../../lib/roth-suggestion/test-fixtures';
import {
  runRothSuggestion,
  type RothSuggestionWorkerInbound,
  type RothSuggestionWorkerOutbound,
  type RothSuggestionWorkerResult,
} from '../../workers/roth-suggestion.worker';
import { buildRothBETRPageData, type RothBETRPageData } from './roth-betr-data';

export interface FakeWorkerShape {
  readonly sent: RothSuggestionWorkerInbound[];
  terminated: boolean;
  emit(msg: RothSuggestionWorkerOutbound): void;
}

/** Every fake worker the page spawned, in spawn order; reset per test. */
export const fakeWorkers: FakeWorkerShape[] = [];

export class FakeRothSuggestionWorker implements FakeWorkerShape {
  private readonly listeners = new Map<string, Set<(ev: Event) => void>>();
  readonly sent: RothSuggestionWorkerInbound[] = [];
  terminated = false;
  constructor() {
    fakeWorkers.push(this);
  }
  addEventListener(type: string, fn: (ev: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: (ev: Event) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  postMessage(msg: RothSuggestionWorkerInbound): void {
    this.sent.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(msg: RothSuggestionWorkerOutbound): void {
    const ev = new MessageEvent('message', { data: msg });
    this.listeners.get('message')?.forEach((fn) => fn(ev));
  }
}

export interface PanelSeed {
  readonly pageData: RothBETRPageData;
  readonly baseResult: RothSuggestionWorkerResult;
}

/** Page data and a real search result for the single-member toy household. */
export async function seedToyPanel(): Promise<PanelSeed> {
  const projection = toyProjection({ couple: false });
  const pageData = buildRothBETRPageData(projection);
  if (pageData === null) throw new Error('toy page data is null');
  const { bundle: _bundle, ...rest } = projection;
  void _bundle;
  const posted: RothSuggestionWorkerOutbound[] = [];
  await runRothSuggestion(
    'seed',
    { projection: rest, targetRothAccountId: 'roth', leftoverTaxRate: 0.2, deathAges: { primary: 90 } },
    (m) => posted.push(m),
  );
  const terminal = posted[posted.length - 1];
  if (terminal.kind !== 'result') throw new Error(`seed search gave ${terminal.kind}`);
  return { pageData, baseResult: terminal.result };
}
