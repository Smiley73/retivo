// Drives the build-id gate through its public API; `__BUILD_ID__` and `fetch` are stubbed before each fresh import.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type BuildIdModule = typeof import('./build-id');

type FetchOutcome = string | 'fail' | 'bad-status';

function stubFetch(outcome: () => FetchOutcome): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    const result = outcome();
    if (result === 'fail') throw new Error('network');
    if (result === 'bad-status') return { ok: false } as Response;
    return { ok: true, json: async () => ({ buildId: result }) } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function load(clientId: string, outcome: () => FetchOutcome = () => 'server-build-2') {
  vi.resetModules();
  vi.stubGlobal('__BUILD_ID__', clientId);
  const fetchMock = stubFetch(outcome);
  const mod: BuildIdModule = await import('./build-id');
  const listener = vi.fn();
  mod.subscribeToVersionMismatch(listener);
  return { ...mod, fetchMock, listener };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

const BUILD_MISMATCH = { buildId: 'server-build-2', reason: 'build-mismatch' };
const SCHEMA_AHEAD = { buildId: 'server-build-2', reason: 'schema-ahead' };

beforeEach(() => {
  window.sessionStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('recordServerBuildId', () => {
  it.each([
    ['the server id matches', 'client-build-1', 'client-build-1'],
    ['the server id is missing', 'client-build-1', undefined],
    ['the server id is empty', 'client-build-1', ''],
    ['the client is a dev build', 'dev', 'some-real-build-id'],
    ['the server is a dev build', 'client-build-1', 'dev'],
  ])('never verifies or prompts when %s', async (_name, clientId, serverId) => {
    const { recordServerBuildId, getCurrentMismatch, listener, fetchMock } = await load(clientId);
    recordServerBuildId(serverId);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(getCurrentMismatch()).toBeNull();
  });

  it('prompts only once /build-id.json reports the server id live', async () => {
    const { recordServerBuildId, getCurrentMismatch, listener, fetchMock } =
      await load('client-build-1');
    recordServerBuildId('server-build-2');
    expect(listener).not.toHaveBeenCalled();
    await flush();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/build-id.json'),
      expect.objectContaining({ cache: 'no-store', credentials: 'omit' }),
    );
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(BUILD_MISMATCH);
    expect(getCurrentMismatch()).toEqual(BUILD_MISMATCH);
  });

  it.each([
    ['still serves the client build', () => 'client-build-1'],
    ['serves an unrelated id', () => 'other-build'],
    ['answers with an error status', () => 'bad-status' as const],
    ['cannot be reached', () => 'fail' as const],
  ])('stays quiet while /build-id.json %s', async (_name, outcome) => {
    const { recordServerBuildId, getCurrentMismatch, listener } = await load(
      'client-build-1',
      outcome,
    );
    recordServerBuildId('server-build-2');
    await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(getCurrentMismatch()).toBeNull();
  });

  it('prompts on a later response once the deployed bundle catches up', async () => {
    let deployed = 'client-build-1';
    const { recordServerBuildId, listener, fetchMock } = await load('client-build-1', () => deployed);
    recordServerBuildId('server-build-2');
    await flush();
    expect(listener).not.toHaveBeenCalled();

    deployed = 'server-build-2';
    vi.advanceTimersByTime(5_000);
    recordServerBuildId('server-build-2');
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(BUILD_MISMATCH);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('verifies at most once per throttle window and does not re-notify for the same id', async () => {
    const { recordServerBuildId, getCurrentMismatch, listener, fetchMock } = await load(
      'client-build-1',
      () => 'client-build-1',
    );
    recordServerBuildId('server-build-2');
    await flush();
    recordServerBuildId('server-build-2');
    recordServerBuildId('server-build-3');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getCurrentMismatch()).toBeNull();

    const live = await load('client-build-1');
    live.recordServerBuildId('server-build-2');
    await flush();
    live.recordServerBuildId('server-build-2');
    live.recordServerBuildId('server-build-2');
    await flush();
    expect(live.listener).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('prompts again when a newer build is verified live', async () => {
    let deployed = 'server-build-2';
    const { recordServerBuildId, getCurrentMismatch, listener } = await load(
      'client-build-1',
      () => deployed,
    );
    recordServerBuildId('server-build-2');
    await flush();
    deployed = 'server-build-3';
    vi.advanceTimersByTime(5_000);
    recordServerBuildId('server-build-3');
    await flush();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getCurrentMismatch()).toEqual({ buildId: 'server-build-3', reason: 'build-mismatch' });
  });

  it('stays quiet for a dismissed id but prompts for a brand new build', async () => {
    let deployed = 'server-build-2';
    const { recordServerBuildId, dismissCurrentMismatch, getCurrentMismatch, listener } =
      await load('client-build-1', () => deployed);
    recordServerBuildId('server-build-2');
    await flush();
    dismissCurrentMismatch();
    listener.mockClear();

    vi.advanceTimersByTime(5_000);
    recordServerBuildId('server-build-2');
    await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(getCurrentMismatch()).toBeNull();

    deployed = 'server-build-3';
    vi.advanceTimersByTime(5_000);
    recordServerBuildId('server-build-3');
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ buildId: 'server-build-3', reason: 'build-mismatch' });
  });
});

describe('dismissCurrentMismatch', () => {
  it('clears the mismatch and notifies listeners with null', async () => {
    const { recordServerBuildId, dismissCurrentMismatch, getCurrentMismatch, listener } =
      await load('client-build-1');
    recordServerBuildId('server-build-2');
    await flush();
    listener.mockClear();
    dismissCurrentMismatch();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(null);
    expect(getCurrentMismatch()).toBeNull();
  });

  it('is a no-op when no mismatch is active', async () => {
    const { dismissCurrentMismatch, listener } = await load('client-build-1');
    dismissCurrentMismatch();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('recordSchemaAhead', () => {
  it('is a no-op while the build-mismatch prompt for that id is already up', async () => {
    const { recordServerBuildId, recordSchemaAhead, listener } = await load('client-build-1');
    recordServerBuildId('server-build-2');
    await flush();
    listener.mockClear();
    recordSchemaAhead();
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });

  it('forces the prompt past a dismissal, tagged schema-ahead', async () => {
    const { recordServerBuildId, recordSchemaAhead, dismissCurrentMismatch, listener } =
      await load('client-build-1');
    recordServerBuildId('server-build-2');
    await flush();
    dismissCurrentMismatch();
    listener.mockClear();
    recordSchemaAhead();
    await flush();
    expect(listener).toHaveBeenCalledWith(SCHEMA_AHEAD);
  });

  it('tags a prompt that was never raised for the id as schema-ahead', async () => {
    let deployed = 'client-build-1';
    const { recordServerBuildId, recordSchemaAhead, getCurrentMismatch, listener } = await load(
      'client-build-1',
      () => deployed,
    );
    recordServerBuildId('server-build-2');
    await flush();
    expect(getCurrentMismatch()).toBeNull();

    deployed = 'server-build-2';
    recordSchemaAhead();
    await flush();
    expect(listener).toHaveBeenCalledWith(SCHEMA_AHEAD);
    expect(getCurrentMismatch()).toEqual(SCHEMA_AHEAD);
  });

  it('wins the reason when it arrives while the verification is still in flight', async () => {
    let release: (id: string) => void = () => undefined;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { recordServerBuildId, recordSchemaAhead, listener, fetchMock } = await load(
      'client-build-1',
    );
    fetchMock.mockImplementation(
      async () =>
        ({ ok: true, json: async () => ({ buildId: await pending }) }) as Response,
    );
    recordServerBuildId('server-build-2');
    recordSchemaAhead();
    release('server-build-2');
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(SCHEMA_AHEAD);
  });

  it('warns and does nothing when no server build id has been seen', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { recordSchemaAhead, listener } = await load('client-build-1');
    recordSchemaAhead();
    await flush();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
  });
});
