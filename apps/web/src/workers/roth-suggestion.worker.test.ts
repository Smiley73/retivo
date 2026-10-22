/** Drives `registerRothSuggestionWorkerListener` against a fake `self`. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchRothSuggestions } from '../lib/roth-suggestion/search';
import { TOY_ROTH_ID, toyProjection } from '../lib/roth-suggestion/test-fixtures';
import {
  registerRothSuggestionWorkerListener,
  type RothSuggestionWorkerInbound,
  type RothSuggestionWorkerInput,
  type RothSuggestionWorkerOutbound,
} from './roth-suggestion.worker';

vi.mock('../lib/roth-suggestion/search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/roth-suggestion/search')>();
  return { ...actual, searchRothSuggestions: vi.fn(actual.searchRothSuggestions) };
});

type Handler = (ev: MessageEvent<RothSuggestionWorkerInbound>) => void;

const TIMEOUT = { timeout: 60_000 };

function setup(): { send: (msg: RothSuggestionWorkerInbound) => void; posted: RothSuggestionWorkerOutbound[] } {
  let handler: Handler | null = null;
  const posted: RothSuggestionWorkerOutbound[] = [];
  registerRothSuggestionWorkerListener({
    addEventListener: ((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'message' && typeof listener === 'function') handler = listener as Handler;
    }) as typeof self.addEventListener,
    postMessage: ((message: RothSuggestionWorkerOutbound) => {
      posted.push(message);
    }) as typeof self.postMessage,
  });
  if (handler === null) throw new Error('the worker registered no message listener');
  const captured: Handler = handler;
  return { send: (msg) => captured({ data: msg } as MessageEvent<RothSuggestionWorkerInbound>), posted };
}

function input(overrides: Partial<RothSuggestionWorkerInput> = {}): RothSuggestionWorkerInput {
  const { bundle: _bundle, ...projection } = toyProjection({ couple: false });
  void _bundle;
  return {
    projection,
    targetRothAccountId: TOY_ROTH_ID,
    leftoverTaxRate: 0.2,
    deathAges: { primary: 90 },
    ...overrides,
  };
}

async function waitForTerminal(posted: RothSuggestionWorkerOutbound[]): Promise<void> {
  await vi.waitFor(() => expect(posted.some((m) => m.kind !== 'progress')).toBe(true), TIMEOUT);
}

beforeEach(() => {
  vi.mocked(searchRothSuggestions).mockClear();
});

describe('roth suggestion worker', () => {
  it('posts progress ticks carrying the runId, then one result carrying it too', TIMEOUT, async () => {
    const { send, posted } = setup();
    send({ kind: 'run', runId: 'run-1', input: input() });
    await waitForTerminal(posted);

    expect(posted.length).toBeGreaterThan(2);
    expect(posted.every((m) => m.runId === 'run-1')).toBe(true);
    const terminalAt = posted.findIndex((m) => m.kind !== 'progress');
    expect(terminalAt).toBe(posted.length - 1);
    const ticks = posted.slice(0, terminalAt);
    expect(ticks.every((m) => m.kind === 'progress')).toBe(true);
    const last = ticks[ticks.length - 1];
    if (last.kind !== 'progress') throw new Error('expected a progress tick');
    expect(last.done).toBe(last.total);

    const terminal = posted[terminalAt];
    expect(terminal.kind).toBe('result');
    if (terminal.kind !== 'result') return;
    expect(terminal.scenarioId).toBe('toy');
    expect(terminal.result.candidates[0].isReference).toBe(true);
    expect(terminal.result.leftoverTaxRate).toBe(0.2);
    expect(terminal.result.deathAges).toEqual({ primary: 90 });
    // The heavy raw rows stay in the worker; the per-year records go across.
    expect(terminal.result.candidates.every((c) => !('drawdownYears' in c))).toBe(true);
    expect(terminal.result.candidates[0].years.length).toBeGreaterThan(0);
  });

  it('answers an unsupported household with an empty reply carrying the runId', TIMEOUT, async () => {
    const { send, posted } = setup();
    send({ kind: 'run', runId: 'run-3', input: input({ targetRothAccountId: 'not-an-account' }) });
    await waitForTerminal(posted);

    const terminal = posted[posted.length - 1];
    expect(terminal).toEqual({
      kind: 'empty',
      runId: 'run-3',
      scenarioId: 'toy',
      reason: 'no-roth-ira',
    });
  });

  it('turns a thrown projection error into an error reply, not an unhandled rejection', async () => {
    vi.mocked(searchRothSuggestions).mockRejectedValueOnce(new Error('engine blew up'));
    const { send, posted } = setup();
    send({ kind: 'run', runId: 'run-4', input: input() });
    await waitForTerminal(posted);

    expect(posted).toEqual([
      { kind: 'error', runId: 'run-4', scenarioId: 'toy', message: 'engine blew up' },
    ]);
  });

  it('answers an unknown scenario id with an error, without searching', async () => {
    const base = input();
    const { send, posted } = setup();
    send({
      kind: 'run',
      runId: 'run-5',
      input: { ...base, projection: { ...base.projection, selectedScenarioId: 'nope' } },
    });
    await waitForTerminal(posted);

    expect(posted).toEqual([
      { kind: 'error', runId: 'run-5', scenarioId: 'nope', message: 'Unknown scenario id: nope' },
    ]);
    expect(searchRothSuggestions).not.toHaveBeenCalled();
  });

  it('reports an out-of-range leftover-tax rate as an error reply', async () => {
    const { send, posted } = setup();
    send({ kind: 'run', runId: 'run-6', input: input({ leftoverTaxRate: 1.5 }) });
    await waitForTerminal(posted);

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ kind: 'error', runId: 'run-6' });
  });

  it('ignores a message that is not a run request', () => {
    const { send, posted } = setup();
    send({ kind: 'noise' } as unknown as RothSuggestionWorkerInbound);
    expect(posted).toEqual([]);
    expect(searchRothSuggestions).not.toHaveBeenCalled();
  });
});
