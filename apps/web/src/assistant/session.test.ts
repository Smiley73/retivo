/**
 * The tab's handshake and teardown against a scripted socket. A scripted pass
 * cannot catch an encoding disagreement with the real bridge; the
 * `session.bridge-test.ts` suite does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOSE_CODES,
  PROTOCOL_VERSION,
  TAB_CLOSE_REASONS,
  type TabCloseReason,
} from '@retirement/assistant-protocol';
import { ScriptedSocket, allowKeepingSignedIn, allowWithDefaults, bridgeHello, handshakeScripted, pairScripted, until } from '../test/assistant-socket';
import { diagnose } from './diagnosis';
import { AssistantSession, CONNECT_TIMEOUT_MS, HELLO_TIMEOUT_MS, PAIRED_TIMEOUT_MS, type SessionOptions } from './session';
import type { ConsentRequest, SocketLike } from './session-types';
import { defaultConsentAnswer, type ConsentAnswer } from './sharing/consent';
import { defaultSharingChoices } from './sharing/switches';

// Frozen vector from the protocol package: with these nonces the tab's proof is fixed.
const VECTOR = {
  code: '7QW49KXMZ2',
  bridgeNonce: Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join(''),
  tabNonce: Array.from({ length: 32 }, (_, i) => (i + 32).toString(16).padStart(2, '0')).join(''),
  tabProof: '34e2fc9033a8225366d782444e5de29aaedf89b5d3912c1f3a2c93c0151148b6',
  bridgeProof: 'e7bea19670af3423ef90743b33da8ab92e031b7673f5dd6cea883d4728f5b216',
};

const nonce = vi.hoisted(() => ({ forced: null as string | null }));
vi.mock('@retirement/assistant-protocol', async () => {
  const actual = await vi.importActual<typeof import('@retirement/assistant-protocol')>('@retirement/assistant-protocol');
  return { ...actual, generateNonce: () => nonce.forced ?? actual.generateNonce() };
});

interface Harness {
  session: AssistantSession;
  sockets: ScriptedSocket[];
  noteActivity: ReturnType<typeof vi.fn>;
  openSocket: ReturnType<typeof vi.fn>;
}

function makeSession(overrides: Partial<SessionOptions> = {}): Harness {
  const sockets: ScriptedSocket[] = [];
  const openSocket = vi.fn((url: string): SocketLike => {
    expect(url).toBe('ws://127.0.0.1:24580');
    const socket = new ScriptedSocket();
    sockets.push(socket);
    return socket;
  });
  const noteActivity = vi.fn();
  const session = new AssistantSession({
    port: 24580,
    openSocket,
    isWorkspaceReady: () => true,
    appBuildId: 'test-build',
    noteActivity,
    requestConsent: allowWithDefaults,
    ...overrides,
  });
  return { session, sockets, noteActivity, openSocket };
}

beforeEach(() => {
  nonce.forced = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('pairing with a scripted socket', () => {
  it('sends exactly one pair frame with the vector proof, and ready only once the bridge proof verifies', async () => {
    nonce.forced = VECTOR.tabNonce;
    const { session, sockets } = makeSession();
    expect(session.connect('7qw49-kxmz2')).toBe('started');
    const socket = sockets[0]!;
    expect(session.getSnapshot().phase).toBe('connecting');
    socket.open();
    expect(session.getSnapshot().phase).toBe('awaiting-hello');
    expect(socket.sent).toEqual([]);

    socket.receive(bridgeHello({ bridgeNonce: VECTOR.bridgeNonce }));
    await until(() => socket.sentAtLeast(1), 'the pair frame');
    expect(socket.frames).toEqual([
      { type: 'pair', protocolVersion: PROTOCOL_VERSION, tabNonce: VECTOR.tabNonce, tabProof: VECTOR.tabProof },
    ]);
    expect(session.getSnapshot().phase).toBe('awaiting-paired');

    socket.receive({ type: 'paired', bridgeProof: VECTOR.bridgeProof });
    await until(() => session.getSnapshot().phase === 'ready', 'ready');
    expect(socket.frames[1]).toEqual({ type: 'ready', keepSignedInWhileActive: false });
    expect(socket.frames).toHaveLength(2);
    expect(socket.sent.join('')).not.toContain(VECTOR.code);
  });

  it('keeps the bridge-reported client and the pairing time while connected, and drops them at the end', async () => {
    const { session, sockets } = makeSession({ now: () => 1_700_000_000_000 });
    session.connect(VECTOR.code);
    expect(session.getSnapshot()).toMatchObject({ client: null, pairedAt: null });
    await handshakeScripted(sockets[0]!, VECTOR.code, { name: 'Claude Code', version: '2.1' });
    await until(() => session.getSnapshot().phase === 'ready', 'ready');
    expect(session.getSnapshot()).toMatchObject({ client: { name: 'Claude Code', version: '2.1' }, pairedAt: 1_700_000_000_000 });
    session.disconnect();
    expect(session.getSnapshot()).toMatchObject({ client: null, pairedAt: null });
  });

  it('keeps no client when the bridge reported none', async () => {
    const { session, sockets } = makeSession();
    session.connect(VECTOR.code);
    await pairScripted(sockets[0]!, VECTOR.code);
    await until(() => session.getSnapshot().phase === 'ready', 'ready');
    expect(session.getSnapshot().client).toBeNull();
    expect(session.getSnapshot().pairedAt).not.toBeNull();
  });

  it('waits in awaiting-consent: nothing leaves until the person allows, then the record and ready follow', async () => {
    const phases: string[] = [];
    const requests: ConsentRequest[] = [];
    let answer: (value: ConsentAnswer | 'declined') => void = () => undefined;
    const { session, sockets } = makeSession({
      requestConsent: (request) => {
        requests.push(request);
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
      log: (message) => phases.push(message),
      now: () => 1_700_000_000_000,
    });
    session.connect(VECTOR.code);
    const socket = sockets[0]!;
    await handshakeScripted(socket, VECTOR.code, { name: 'Claude Code', version: '2.1' });
    await until(() => requests.length === 1, 'the consent request');

    expect(session.getSnapshot().phase).toBe('awaiting-consent');
    expect(session.getSnapshot().consent).toBeNull();
    expect(requests).toEqual([{ clientName: 'Claude Code' }]);
    expect(socket.frames).toHaveLength(1);

    answer({ choices: { ...defaultSharingChoices(), notes: false }, keepSignedInWhileActive: true });
    await until(() => session.getSnapshot().phase === 'ready', 'ready');
    expect(socket.frames[1]).toEqual({ type: 'ready', keepSignedInWhileActive: true });
    const { consent } = session.getSnapshot();
    expect(consent).toMatchObject({ keepSignedInWhileActive: true, grantedAt: 1_700_000_000_000 });
    expect(consent?.choices.notes).toBe(false);
    expect(consent?.choices.members).toBe(true);
    expect(Object.isFrozen(consent)).toBe(true);
    expect(phases.filter((entry) => entry.startsWith('phase '))).toEqual([
      'phase connecting',
      'phase awaiting-hello',
      'phase awaiting-paired',
      'phase paired',
      'phase awaiting-consent',
      'phase ready',
    ]);
    // State names only: nothing in the log carries the code.
    expect(phases.join('\n')).not.toContain(VECTOR.code);
  });

  it('sends keepSignedInWhileActive false in the ready frame unless the person switched it on', async () => {
    const { session, sockets } = makeSession({ requestConsent: allowWithDefaults });
    session.connect(VECTOR.code);
    await pairScripted(sockets[0]!, VECTOR.code);
    expect(sockets[0]!.frames[1]).toEqual({ type: 'ready', keepSignedInWhileActive: false });
    expect(session.getSnapshot().consent?.keepSignedInWhileActive).toBe(false);
  });

  it('answers a call injected before Allow with WORKSPACE_LOCKED and runs no handler', async () => {
    const { session, sockets } = makeSession({ requestConsent: () => new Promise(() => undefined) });
    const handler = vi.fn(() => ({ ok: true as const, payload: {}, disclosure: {} }));
    session.registerHandler('retivo_status', handler);
    session.connect(VECTOR.code);
    const socket = sockets[0]!;
    await handshakeScripted(socket, VECTOR.code);
    await until(() => session.getSnapshot().phase === 'awaiting-consent', 'awaiting-consent');

    socket.receive({ type: 'call', id: 'early', tool: 'retivo_status', args: {} });
    expect(handler).not.toHaveBeenCalled();
    const result = socket.frames.find((frame) => frame.type === 'result');
    expect(result).toMatchObject({ id: 'early', result: { ok: false, error: { code: 'WORKSPACE_LOCKED' } } });
    expect(socket.frames.some((frame) => frame.type === 'ready')).toBe(false);
  });

  it('reads closing the tab while the dialog is open as a decline', async () => {
    const { session, sockets } = makeSession({ requestConsent: () => new Promise(() => undefined) });
    session.connect(VECTOR.code);
    const socket = sockets[0]!;
    await handshakeScripted(socket, VECTOR.code);
    await until(() => session.getSnapshot().phase === 'awaiting-consent', 'awaiting-consent');
    session.end('pagehide');
    expect(socket.closeCall).toEqual({ code: 1000, reason: 'consent-declined' });
    expect(session.getSnapshot().end?.close).toEqual({ kind: 'tab', reason: 'consent-declined' });
  });

  it('does not answer the consent request twice if the session ended while the dialog was open', async () => {
    let answer: (value: ConsentAnswer | 'declined') => void = () => undefined;
    const { session, sockets } = makeSession({
      requestConsent: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    session.connect(VECTOR.code);
    const socket = sockets[0]!;
    await handshakeScripted(socket, VECTOR.code);
    await until(() => session.getSnapshot().phase === 'awaiting-consent', 'awaiting-consent');
    session.end('disconnect');
    answer(defaultConsentAnswer());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getSnapshot().phase).toBe('idle');
    expect(session.getSnapshot().consent).toBeNull();
    expect(socket.frames.some((frame) => frame.type === 'ready')).toBe(false);
  });

  it('closes with consent-declined when the consent step declines', async () => {
    const { session, sockets } = makeSession({ requestConsent: async () => 'declined' });
    session.connect(VECTOR.code);
    const socket = sockets[0]!;
    socket.open();
    socket.receive(bridgeHello({ bridgeNonce: VECTOR.bridgeNonce }));
    await until(() => socket.sentAtLeast(1));
    const { computeBridgeProof } = await import('@retirement/assistant-protocol');
    socket.receive({
      type: 'paired',
      bridgeProof: await computeBridgeProof({ code: VECTOR.code, bridgeNonce: VECTOR.bridgeNonce, tabNonce: socket.frames[0]!.tabNonce as string }),
    });
    await until(() => socket.closeCall !== null, 'the close');
    expect(socket.closeCall).toEqual({ code: 1000, reason: 'consent-declined' });
    expect(socket.frames).toHaveLength(1);
    expect(session.getSnapshot().end?.close).toEqual({ kind: 'tab', reason: 'consent-declined' });
  });

  it('closes with PAIRING_FAILED after exactly one frame when the bridge proof is wrong', async () => {
    const { session, sockets } = makeSession();
    session.connect(VECTOR.code);
    const socket = sockets[0]!;
    socket.open();
    socket.receive(bridgeHello({ bridgeNonce: VECTOR.bridgeNonce }));
    await until(() => socket.sentAtLeast(1));
    socket.receive({ type: 'paired', bridgeProof: 'ab'.repeat(32) });
    await until(() => socket.closeCall !== null, 'the close');
    expect(socket.closeCall?.code).toBe(CLOSE_CODES.PAIRING_FAILED);
    expect(socket.sent).toHaveLength(1);
    const { phase, end } = session.getSnapshot();
    expect(phase).toBe('idle');
    expect(end).toEqual({ phase: 'awaiting-paired', close: { kind: 'local', error: 'PAIRING_FAILED' } });
    expect(diagnose(end!.phase, end!.close, 'unknown')).toEqual({ kind: 'bridge-unverified' });
  });

  it('closes with PROTOCOL_VERSION_MISMATCH without sending anything', () => {
    const { session, sockets } = makeSession();
    session.connect(VECTOR.code);
    const socket = sockets[0]!;
    socket.open();
    socket.receive(bridgeHello({ protocolVersion: PROTOCOL_VERSION + 1 }));
    expect(socket.closeCall?.code).toBe(CLOSE_CODES.PROTOCOL_VERSION_MISMATCH);
    expect(socket.sent).toEqual([]);
    expect(session.getSnapshot().end?.close).toEqual({ kind: 'local', error: 'PROTOCOL_VERSION_MISMATCH' });
  });

  it('gives up with "not the bridge" when no hello arrives in time', () => {
    vi.useFakeTimers();
    const { session, sockets } = makeSession();
    session.connect(VECTOR.code);
    const socket = sockets[0]!;
    socket.open();
    vi.advanceTimersByTime(HELLO_TIMEOUT_MS + 1);
    expect(socket.closeCall).not.toBeNull();
    const { end } = session.getSnapshot();
    expect(end).toEqual({ phase: 'awaiting-hello', close: { kind: 'deadline' } });
    expect(diagnose(end!.phase, end!.close, 'unknown')).toEqual({ kind: 'not-the-bridge' });
    expect(socket.sent).toEqual([]);
  });

  it('gives up when the bridge never answers the pair frame', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { session, sockets } = makeSession();
    session.connect(VECTOR.code);
    const socket = sockets[0]!;
    socket.open();
    socket.receive(bridgeHello());
    await until(() => socket.sentAtLeast(1));
    vi.advanceTimersByTime(PAIRED_TIMEOUT_MS + 1);
    expect(socket.closeCall).not.toBeNull();
    expect(session.getSnapshot().end).toEqual({ phase: 'awaiting-paired', close: { kind: 'deadline' } });
  });

  it('treats a socket that never opens as unreachable', () => {
    vi.useFakeTimers();
    const { session, sockets } = makeSession();
    session.connect(VECTOR.code);
    sockets[0]!.emitError();
    sockets[0]!.emitClose(1006);
    const { end } = session.getSnapshot();
    expect(end).toEqual({ phase: 'connecting', close: { kind: 'remote', code: 1006 } });
    expect(diagnose(end!.phase, end!.close, 'unknown')).toEqual({ kind: 'unreachable' });
  });

  it('does not start the hello deadline until the socket opens, so a pending permission prompt can be answered', () => {
    vi.useFakeTimers();
    const { session, sockets } = makeSession();
    session.connect(VECTOR.code);
    const socket = sockets[0]!;
    vi.advanceTimersByTime(HELLO_TIMEOUT_MS * 3);
    expect(session.getSnapshot().phase).toBe('connecting');
    expect(socket.closeCall).toBeNull();
    socket.open();
    expect(session.getSnapshot().phase).toBe('awaiting-hello');
    vi.advanceTimersByTime(HELLO_TIMEOUT_MS - 1);
    expect(session.getSnapshot().phase).toBe('awaiting-hello');
    vi.advanceTimersByTime(2);
    expect(session.getSnapshot().end).toEqual({ phase: 'awaiting-hello', close: { kind: 'deadline' } });
  });

  it('still gives up on a socket that never opens, after the longer connect bound', () => {
    vi.useFakeTimers();
    const { session, sockets } = makeSession();
    session.connect(VECTOR.code);
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS + 1);
    expect(sockets[0]!.closeCall).not.toBeNull();
    const { end } = session.getSnapshot();
    expect(end).toEqual({ phase: 'connecting', close: { kind: 'deadline' } });
    expect(diagnose(end!.phase, end!.close, 'unknown')).toEqual({ kind: 'unreachable' });
  });

  it('closes with PROTOCOL_ERROR on an undecodable frame, a binary frame or a hello that is not first', () => {
    for (const bad of ['{not json', JSON.stringify({ type: 'surprise' }), new ArrayBuffer(4)]) {
      const { session, sockets } = makeSession();
      session.connect(VECTOR.code);
      sockets[0]!.open();
      sockets[0]!.receive(bad as string);
      expect(sockets[0]!.closeCall?.code, String(bad)).toBe(CLOSE_CODES.PROTOCOL_ERROR);
      expect(session.getSnapshot().phase).toBe('idle');
    }
    const { session, sockets } = makeSession();
    session.connect(VECTOR.code);
    sockets[0]!.open();
    sockets[0]!.receive({ type: 'paired', bridgeProof: 'ab'.repeat(32) });
    expect(sockets[0]!.closeCall?.code).toBe(CLOSE_CODES.PROTOCOL_ERROR);
  });

  it('closes with PROTOCOL_ERROR on a call before ready, and on paired before pair', async () => {
    const { session, sockets } = makeSession();
    session.connect(VECTOR.code);
    const socket = sockets[0]!;
    socket.open();
    socket.receive(bridgeHello());
    await until(() => socket.sentAtLeast(1));
    socket.receive({ type: 'call', id: 'c1', tool: 'retivo_status', args: {} });
    expect(socket.closeCall?.code).toBe(CLOSE_CODES.PROTOCOL_ERROR);
    expect(session.getSnapshot().end?.close).toEqual({ kind: 'local', error: 'PROTOCOL_ERROR' });
  });

  it('reads close 1009 as a frame that was too large', () => {
    const { session, sockets } = makeSession();
    session.connect(VECTOR.code);
    sockets[0]!.open();
    sockets[0]!.emitClose(1009);
    const { end } = session.getSnapshot();
    expect(diagnose(end!.phase, end!.close, 'unknown')).toEqual({ kind: 'frame-too-large' });
  });

  it('reads the bridge close codes back as diagnoses', () => {
    const cases: Array<[number, string]> = [
      [CLOSE_CODES.PROTOCOL_VERSION_MISMATCH, 'version-mismatch'],
      [CLOSE_CODES.PAIRING_FAILED, 'wrong-code'],
      [CLOSE_CODES.PAIRING_ATTEMPTS_EXCEEDED, 'attempts-exceeded'],
      [CLOSE_CODES.PAIRING_EXPIRED, 'code-expired'],
      [CLOSE_CODES.ALREADY_CONNECTED, 'already-connected'],
    ];
    for (const [code, kind] of cases) {
      const { session, sockets } = makeSession();
      session.connect(VECTOR.code);
      sockets[0]!.open();
      sockets[0]!.emitClose(code);
      const { end } = session.getSnapshot();
      expect(diagnose(end!.phase, end!.close, 'unknown').kind).toBe(kind);
    }
  });
});

describe('gates on connect', () => {
  it('never builds a socket without a port', () => {
    const { session, openSocket } = makeSession({ port: null });
    expect(session.connect(VECTOR.code)).toBe('unavailable');
    expect(openSocket).not.toHaveBeenCalled();
    expect(session.getSnapshot().phase).toBe('idle');
  });

  it('refuses a malformed code before any socket opens', () => {
    const { session, openSocket } = makeSession();
    expect(session.connect('short')).toBe('malformed-code');
    expect(session.connect('')).toBe('malformed-code');
    expect(openSocket).not.toHaveBeenCalled();
  });

  it('refuses a second pairing while one is running', () => {
    const { session, openSocket } = makeSession();
    expect(session.connect(VECTOR.code)).toBe('started');
    expect(session.connect(VECTOR.code)).toBe('busy');
    expect(openSocket).toHaveBeenCalledTimes(1);
  });

  it('records a socket that cannot be built as unreachable', () => {
    const { session } = makeSession({
      openSocket: () => {
        throw new Error('blocked');
      },
    });
    expect(session.connect(VECTOR.code)).toBe('started');
    const { phase, end } = session.getSnapshot();
    expect(phase).toBe('idle');
    expect(end).toEqual({ phase: 'connecting', close: { kind: 'failed-to-open' } });
  });
});

describe.each([false, true])('teardown (D7 switch %s)', (keepSignedIn) => {
  const options = (): Partial<SessionOptions> => ({ requestConsent: allowKeepingSignedIn(keepSignedIn) });

  it.each(TAB_CLOSE_REASONS.filter((reason) => reason !== 'consent-declined'))(
    'ends on %s: socket closed with the reason, secrets gone, nothing runs after, a fresh code needed',
    async (reason: TabCloseReason) => {
      const { session, sockets, openSocket } = makeSession(options());
      const handler = vi.fn(() => new Promise<never>(() => undefined));
      session.registerHandler('retivo_status', handler);
      session.connect(VECTOR.code);
      const socket = sockets[0]!;
      await pairScripted(socket, VECTOR.code);
      socket.receive({ type: 'call', id: 'c1', tool: 'retivo_status', args: {} });
      expect(handler).toHaveBeenCalledTimes(1);
      const signal = (handler.mock.calls[0] as unknown as [unknown, { signal: AbortSignal }])[1].signal;

      session.end(reason);

      expect(socket.closeCall).toEqual({ code: 1000, reason });
      expect(signal.aborted).toBe(true);
      const { phase, end } = session.getSnapshot();
      expect(phase).toBe('idle');
      expect(end).toEqual({ phase: 'ready', close: { kind: 'tab', reason } });
      // The consent record dies with the session.
      expect(session.getSnapshot().consent).toBeNull();
      const internals = session as unknown as { code: unknown; handshake: unknown };
      expect(internals.code).toBeNull();
      expect(internals.handshake).toBeNull();

      // Frames that still arrive on the old socket reach nothing.
      socket.receive({ type: 'call', id: 'c2', tool: 'retivo_status', args: {} });
      expect(handler).toHaveBeenCalledTimes(1);
      // Only the first call's cancelled answer is dropped, never sent.
      expect(socket.frames.filter((frame) => frame.type === 'result')).toEqual([]);

      // A new session needs a new code.
      expect(session.connect('')).toBe('malformed-code');
      expect(openSocket).toHaveBeenCalledTimes(1);
    },
  );

  it('ends when the bridge closes the socket, dropping its in-flight call', async () => {
    const { session, sockets } = makeSession(options());
    const handler = vi.fn(() => new Promise<never>(() => undefined));
    session.registerHandler('retivo_status', handler);
    session.connect(VECTOR.code);
    await pairScripted(sockets[0]!, VECTOR.code);
    sockets[0]!.receive({ type: 'call', id: 'c1', tool: 'retivo_status', args: {} });
    sockets[0]!.emitClose(1006);
    expect(session.getSnapshot().end).toEqual({ phase: 'ready', close: { kind: 'remote', code: 1006 } });
    expect(session.getSnapshot().consent).toBeNull();
    expect(diagnose('ready', { kind: 'remote', code: 1006 }, 'unknown')).toEqual({ kind: 'connection-lost' });
  });
});
