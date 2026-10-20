/** Dispatch, caps and the audit log through a paired session on a scripted socket. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_TOOL_RESULT_BYTES, TOOL_REGISTRY, type TabFrame, type ToolResult } from '@retirement/assistant-protocol';
import { ScriptedSocket, allowKeepingSignedIn, allowWithDefaults, pairScripted } from '../test/assistant-socket';
import { AssistantSession, type SessionOptions } from './session';
import { CallDispatcher, type ToolCallContext } from './dispatcher';
import { defaultSharingChoices } from './sharing/switches';

const CODE = '7QW49KXMZ2';
const OK: ToolResult = { ok: true, payload: { status: 'ready' }, disclosure: {} };

async function pairedSession(overrides: Partial<SessionOptions> = {}) {
  const socket = new ScriptedSocket();
  const noteActivity = vi.fn();
  const session = new AssistantSession({
    port: 24580,
    openSocket: () => socket,
    isWorkspaceReady: () => true,
    appBuildId: 'test-build',
    noteActivity,
    requestConsent: allowWithDefaults,
    ...overrides,
  });
  session.connect(CODE);
  await pairScripted(socket, CODE);
  const results = () => socket.frames.filter((frame) => frame.type === 'result');
  const call = (id: string, tool: string, args: Record<string, unknown> = {}) =>
    socket.receive({ type: 'call', id, tool, args });
  return { session, socket, noteActivity, results, call };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the share view binding', () => {
  const aggregate = (id: string, payload: Record<string, unknown>) =>
    ({ id, householdId: 'hh', aggregateType: 'account', schemaVersion: 1, version: 1, updatedAt: '', deviceId: 'd', payload }) as const;

  it('hands the handler a builder bound to the session record, not a copy', async () => {
    const { session, results, call } = await pairedSession({
      requestConsent: async () => ({ choices: { ...defaultSharingChoices(), exactDollars: false, notes: false }, keepSignedInWhileActive: false }),
    });
    let seen: ToolCallContext['share'] | undefined;
    session.registerHandler('retivo_status', (_args, context) => {
      seen = context.share;
      return { ok: true, payload: context.share.buildView({ households: [], members: [], accounts: [aggregate('acct-1', { name: 'IRA', notes: 'private', plannedContributionPreTax: 1499 })] }), disclosure: {} };
    });
    call('c1', 'retivo_status');
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(seen?.consent).toBe(session.getSnapshot().consent);
    const payload = (results()[0]!.result as { payload: { accounts: unknown[]; withheld: string[] } }).payload;
    expect(payload.accounts).toEqual([{ id: 'acct-1', name: 'IRA', plannedContributionPreTax: 1000 }]);
    expect(payload.withheld).toEqual(['notes', 'exactDollars']);
  });

  it('answers WORKSPACE_LOCKED when no consent record is current, however the call arrived', async () => {
    const dispatcher = new CallDispatcher({
      registry: TOOL_REGISTRY,
      timers: { set: () => 0, clear: () => undefined },
      now: () => 0,
      isWorkspaceReady: () => true,
      getConsent: () => null,
      appBuildId: 'test',
      send: (frame) => sent.push(frame),
      onSettled: () => undefined,
    });
    const sent: TabFrame[] = [];
    const handler = vi.fn(() => OK);
    dispatcher.register('retivo_status', handler);
    expect(dispatcher.handleCall({ id: 'c1', tool: 'retivo_status', args: {} })).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(sent).toEqual([
      { type: 'result', id: 'c1', result: expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'WORKSPACE_LOCKED' }) }) },
    ]);
  });
});

describe('dispatch and caps', () => {
  it('answers a completed call with the handler result and audits it', async () => {
    const { session, results, call } = await pairedSession();
    session.registerHandler('retivo_status', () => OK);
    call('c1', 'retivo_status');
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(results()[0]).toEqual({ type: 'result', id: 'c1', result: OK });
    const [entry] = session.getSnapshot().audit;
    expect(entry).toMatchObject({ tool: 'retivo_status', outcome: 'ok', movedIdleClock: false, payloadTruncated: false });
    expect(JSON.parse(entry!.payload!)).toEqual(OK);
    expect(entry!.bytes).toBe(JSON.stringify(OK).length);
  });

  it('answers TOOL_NOT_SUPPORTED, with no data, for a name without a handler', async () => {
    const { session, results, call } = await pairedSession();
    const other = vi.fn(() => OK);
    session.registerHandler('retivo_status', other);
    call('c1', 'retivo_list_scenarios');
    call('c2', 'retivo_from_the_future');
    await vi.waitFor(() => expect(results()).toHaveLength(2));
    for (const frame of results()) {
      expect(frame.result).toMatchObject({ ok: false, error: { code: 'TOOL_NOT_SUPPORTED', appBuildId: 'test-build' } });
    }
    expect((results()[0]!.result as { error: { tool: string } }).error.tool).toBe('retivo_list_scenarios');
    expect(other).not.toHaveBeenCalled();
    expect(session.getSnapshot().audit.map((entry) => entry.outcome)).toEqual(['TOOL_NOT_SUPPORTED', 'TOOL_NOT_SUPPORTED']);
  });

  it('refuses to register a handler for a name outside the registry', async () => {
    const { session } = await pairedSession();
    expect(() => session.registerHandler('retivo_made_up', () => OK)).toThrow(/not a tool in the registry/);
  });

  it('answers INVALID_ARGS without invoking the handler', async () => {
    const { session, results, call } = await pairedSession();
    const handler = vi.fn(() => OK);
    session.registerHandler('retivo_get_scenario', handler);
    call('c1', 'retivo_get_scenario', { scenarioId: 7 });
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(results()[0]!.result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('hands the handler validated args, a signal and a progress callback that is clamped', async () => {
    const { session, socket, results, call } = await pairedSession();
    session.registerHandler('retivo_get_scenario', (args, context: ToolCallContext) => {
      context.progress({ fraction: 4, message: 'x'.repeat(500) });
      return { ok: true, payload: args, disclosure: {} };
    });
    call('c1', 'retivo_get_scenario', { scenarioId: 'abc', extra: 'stripped' });
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    const progress = socket.frames.find((frame) => frame.type === 'progress')!;
    expect(progress).toMatchObject({ id: 'c1', fraction: 1 });
    expect((progress.message as string).length).toBe(200);
    expect(results()[0]!.result).toMatchObject({ payload: { scenarioId: 'abc' } });
  });

  it('answers TOO_MANY_IN_FLIGHT for a third concurrent call', async () => {
    const { session, results, call } = await pairedSession();
    session.registerHandler('retivo_status', () => new Promise<never>(() => undefined));
    call('c1', 'retivo_status');
    call('c2', 'retivo_status');
    call('c3', 'retivo_status');
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(results()[0]).toMatchObject({ id: 'c3', result: { ok: false, error: { code: 'TOO_MANY_IN_FLIGHT' } } });
  });

  it('answers CALL_TIMEOUT and aborts the handler signal when a call runs too long', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { session, results, call } = await pairedSession();
    let seen: AbortSignal | undefined;
    const late = vi.fn();
    session.registerHandler('retivo_status', (_args, context) => {
      seen = context.signal;
      return new Promise<ToolResult>((resolve) => setTimeout(() => resolve(OK), 60_000)).then((result) => {
        late();
        return result;
      });
    });
    call('c1', 'retivo_status');
    await vi.advanceTimersByTimeAsync(30_001);
    expect(results()).toHaveLength(1);
    expect(results()[0]!.result).toMatchObject({ ok: false, error: { code: 'CALL_TIMEOUT' } });
    expect(seen?.aborted).toBe(true);
    // The handler finishing later changes nothing.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(late).toHaveBeenCalled();
    expect(results()).toHaveLength(1);
    expect(session.getSnapshot().audit.map((entry) => entry.outcome)).toEqual(['CALL_TIMEOUT']);
  });

  it('answers a cancel once with CANCELLED and drops the late result', async () => {
    const { session, socket, results, call } = await pairedSession();
    let finish: (result: ToolResult) => void = () => undefined;
    let seen: AbortSignal | undefined;
    session.registerHandler('retivo_status', (_args, context) => {
      seen = context.signal;
      return new Promise<ToolResult>((resolve) => {
        finish = resolve;
      });
    });
    call('c1', 'retivo_status');
    socket.receive({ type: 'cancel', id: 'c1', reason: 'client' });
    expect(seen?.aborted).toBe(true);
    expect(results()).toHaveLength(1);
    expect(results()[0]!.result).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    finish(OK);
    await new Promise((resolve) => setImmediate(resolve));
    socket.receive({ type: 'cancel', id: 'c1', reason: 'client' });
    expect(results()).toHaveLength(1);
    expect(session.getSnapshot().audit).toHaveLength(1);
  });

  it('answers OUTPUT_TOO_LARGE, never sending the oversize payload', async () => {
    const { session, socket, results, call } = await pairedSession();
    const huge: ToolResult = { ok: true, payload: 'x'.repeat(MAX_TOOL_RESULT_BYTES + 1), disclosure: {} };
    session.registerHandler('retivo_status', () => huge);
    call('c1', 'retivo_status');
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(results()[0]!.result).toMatchObject({ ok: false, error: { code: 'OUTPUT_TOO_LARGE' } });
    expect(socket.sent.every((text) => text.length < 2000)).toBe(true);
    expect(socket.sent.join('')).not.toContain('xxxxxxxxxx');
    const [entry] = session.getSnapshot().audit;
    expect(entry!.outcome).toBe('OUTPUT_TOO_LARGE');
    expect(entry!.bytes).toBeGreaterThan(MAX_TOOL_RESULT_BYTES);
  });

  it('answers INTERNAL when a handler throws, with no detail', async () => {
    const { session, results, call } = await pairedSession();
    session.registerHandler('retivo_status', () => {
      throw new Error('secret plan detail');
    });
    call('c1', 'retivo_status');
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(results()[0]!.result).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(JSON.stringify(results()[0])).not.toContain('secret plan detail');
  });

  it('answers WORKSPACE_LOCKED when the workspace is not ready and invokes nothing', async () => {
    let ready = true;
    const { session, results, call } = await pairedSession({ isWorkspaceReady: () => ready });
    const handler = vi.fn(() => OK);
    session.registerHandler('retivo_status', handler);
    ready = false;
    call('c1', 'retivo_status');
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(results()[0]!.result).toMatchObject({ ok: false, error: { code: 'WORKSPACE_LOCKED' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('closes with PROTOCOL_ERROR when a call id is reused while running', async () => {
    const { session, socket, call } = await pairedSession();
    session.registerHandler('retivo_status', () => new Promise<never>(() => undefined));
    call('c1', 'retivo_status');
    call('c1', 'retivo_status');
    expect(socket.closeCall?.code).toBe(4007);
  });

  it('stops invoking a removed handler', async () => {
    const { session, results, call } = await pairedSession();
    const handler = vi.fn(() => OK);
    const remove = session.registerHandler('retivo_status', handler);
    remove();
    call('c1', 'retivo_status');
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('the idle clock', () => {
  it('stays put when the D7 switch is off, whatever the outcome', async () => {
    const { session, noteActivity, results, call } = await pairedSession();
    session.registerHandler('retivo_status', () => OK);
    call('c1', 'retivo_status');
    call('c2', 'retivo_list_scenarios');
    await vi.waitFor(() => expect(results()).toHaveLength(2));
    expect(noteActivity).not.toHaveBeenCalled();
    expect(session.getSnapshot().audit.map((entry) => entry.movedIdleClock)).toEqual([false, false]);
  });

  it('moves once per completed call, and only for completed ones, when the switch is on', async () => {
    const { session, noteActivity, results, call } = await pairedSession({
      requestConsent: allowKeepingSignedIn(true),
    });
    session.registerHandler('retivo_status', () => OK);
    session.registerHandler('retivo_get_scenario', () => ({ ok: false, error: { code: 'INTERNAL', message: 'nope' } }));
    call('c1', 'retivo_status');
    call('c2', 'retivo_get_scenario', { scenarioId: 'a' });
    await vi.waitFor(() => expect(results()).toHaveLength(2));
    call('c3', 'retivo_list_scenarios');
    call('c4', 'retivo_status');
    await vi.waitFor(() => expect(results()).toHaveLength(4));
    expect(noteActivity).toHaveBeenCalledTimes(2);
    const moved = Object.fromEntries(session.getSnapshot().audit.map((entry) => [entry.tool + entry.outcome, entry.movedIdleClock]));
    expect(moved).toEqual({
      retivo_statusok: true,
      retivo_get_scenarioINTERNAL: false,
      retivo_list_scenariosTOOL_NOT_SUPPORTED: false,
    });
  });
});

describe('the audit log across a session', () => {
  it('is kept after Disconnect, and cleared when a new pairing begins', async () => {
    const { session, call, results } = await pairedSession();
    session.registerHandler('retivo_status', () => OK);
    call('c1', 'retivo_status');
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    session.disconnect();
    expect(session.getSnapshot().audit).toHaveLength(1);
    session.connect(CODE);
    expect(session.getSnapshot().audit).toEqual([]);
  });

  it.each(['sign-out', 'user-switch'] as const)('is cleared when the auth session ends (%s), even with no session running', async (reason) => {
    const { session, call, results } = await pairedSession();
    session.registerHandler('retivo_status', () => OK);
    call('c1', 'retivo_status');
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    session.disconnect();
    expect(session.getSnapshot().audit).toHaveLength(1);
    session.end(reason);
    expect(session.getSnapshot().audit).toEqual([]);
  });

  it('is kept on lock, which is not the end of the auth session', async () => {
    const { session, call, results } = await pairedSession();
    session.registerHandler('retivo_status', () => OK);
    call('c1', 'retivo_status');
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    session.end('lock');
    expect(session.getSnapshot().audit).toHaveLength(1);
  });

  it('never holds the code, the nonces or the proofs after a full handshake', async () => {
    const { session, socket, call, results } = await pairedSession();
    session.registerHandler('retivo_status', () => OK);
    call('c1', 'retivo_status');
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    const { tabNonce, tabProof } = socket.frames[0] as unknown as { tabNonce: string; tabProof: string };
    const serialized = JSON.stringify(session.getSnapshot());
    for (const secret of [CODE, tabNonce, tabProof]) expect(serialized).not.toContain(secret);
  });
});
