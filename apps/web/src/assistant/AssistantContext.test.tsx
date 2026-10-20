/**
 * The provider: the three gates, teardown on every signal (with the D7 switch
 * off and on), and the idle clock through real <IdleTimer> instances.
 */
import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolResult } from '@retirement/assistant-protocol';
import { IdleTimer } from '../auth/IdleTimer';
import { BetaFeaturesProvider } from '../contexts/BetaFeaturesContext';
import { ScriptedSocket, allowKeepingSignedIn, pairScripted } from '../test/assistant-socket';
import { AssistantProvider, useAssistant, type AssistantContextValue } from './AssistantContext';

const auth = vi.hoisted(() => ({
  value: {
    me: { id: 'u-1' } as { id: string } | null,
    householdId: 'h-1' as string | null,
    isUnlocked: true,
    unlockResolved: true,
  },
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth.value }));

const CODE = '7QW49KXMZ2';
const ACTIVITY_KEY = 'retivo.auth.lastActivityAt';
const OK: ToolResult = { ok: true, payload: {}, disclosure: {} };

const latest: { current: AssistantContextValue | null } = { current: null };
const Probe: React.FC = () => {
  latest.current = useAssistant();
  return null;
};
const assistant = (): AssistantContextValue => latest.current!;

interface SetupOptions {
  port?: string;
  betaOn?: boolean;
  optIn?: boolean;
  keepSignedIn?: boolean;
  timer?: { idleMs: number; onTimeout: () => void }[];
}

function setup(options: SetupOptions = {}) {
  const { port = '24580', betaOn = true, optIn = true, keepSignedIn = false, timer = [] } = options;
  if (port !== '') vi.stubEnv('VITE_ASSISTANT_BRIDGE_PORT', port);
  if (betaOn) localStorage.setItem('retivo.betaFeatures.u-1', 'on');
  if (optIn) localStorage.setItem('retivo.assistant.optIn.u-1', 'on');
  const sockets: ScriptedSocket[] = [];
  const openSocket = vi.fn(() => {
    const socket = new ScriptedSocket();
    sockets.push(socket);
    return socket;
  });
  const requestConsent = allowKeepingSignedIn(keepSignedIn);
  const tree = (): React.ReactElement => (
    <>
      <BetaFeaturesProvider userId={auth.value.me?.id ?? null}>
        <AssistantProvider openSocket={openSocket} requestConsent={requestConsent}>
          <Probe />
        </AssistantProvider>
      </BetaFeaturesProvider>
      {timer.map((entry, index) => (
        <IdleTimer key={index} enabled idleMs={entry.idleMs} warnLeadMs={5_000} onWarn={() => undefined} onTimeout={entry.onTimeout} />
      ))}
    </>
  );
  const utils = render(tree());
  return {
    ...utils,
    sockets,
    openSocket,
    update: () => act(() => utils.rerender(tree())),
  };
}

async function pair(socketsList: ScriptedSocket[]): Promise<ScriptedSocket> {
  let result = 'unavailable';
  act(() => {
    result = assistant().connect(CODE);
  });
  expect(result).toBe('started');
  const socket = socketsList.at(-1)!;
  await act(async () => {
    await pairScripted(socket, CODE);
  });
  expect(assistant().phase).toBe('ready');
  return socket;
}

beforeEach(() => {
  localStorage.clear();
  auth.value = { me: { id: 'u-1' }, householdId: 'h-1', isUnlocked: true, unlockResolved: true };
  latest.current = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('gates', () => {
  it('is inert without a bridge port: nothing offered, connect refused, no socket built', () => {
    const { openSocket } = setup({ port: '' });
    expect(assistant().offered).toBe(false);
    expect(assistant().port).toBeNull();
    expect(assistant().phase).toBe('idle');
    act(() => {
      expect(assistant().connect(CODE)).toBe('unavailable');
    });
    expect(openSocket).not.toHaveBeenCalled();
  });

  it('is not offered while the beta feature is hidden', () => {
    const { openSocket } = setup({ betaOn: false });
    expect(assistant().offered).toBe(false);
    act(() => {
      expect(assistant().connect(CODE)).toBe('unavailable');
    });
    expect(openSocket).not.toHaveBeenCalled();
  });

  it('is offered but dials nothing until the person opts in on this device', () => {
    const { openSocket } = setup({ optIn: false });
    expect(assistant().offered).toBe(true);
    expect(assistant().optedIn).toBe(false);
    act(() => {
      expect(assistant().connect(CODE)).toBe('unavailable');
    });
    expect(openSocket).not.toHaveBeenCalled();
  });

  it('dials once all three gates are open and the workspace is ready', () => {
    const { openSocket } = setup();
    act(() => {
      expect(assistant().connect(CODE)).toBe('started');
    });
    expect(openSocket).toHaveBeenCalledTimes(1);
    expect(openSocket).toHaveBeenCalledWith('ws://127.0.0.1:24580');
  });

  it('does not dial while the workspace is locked', () => {
    auth.value = { ...auth.value, isUnlocked: false };
    const { openSocket } = setup();
    act(() => {
      expect(assistant().connect(CODE)).toBe('unavailable');
    });
    expect(openSocket).not.toHaveBeenCalled();
  });

  it('persists the opt-in per user and re-reads it when the user changes', () => {
    const { update } = setup({ optIn: false });
    act(() => assistant().setOptedIn(true));
    expect(localStorage.getItem('retivo.assistant.optIn.u-1')).toBe('on');
    expect(assistant().optedIn).toBe(true);
    auth.value = { ...auth.value, me: { id: 'u-2' } };
    update();
    expect(assistant().optedIn).toBe(false);
    auth.value = { ...auth.value, me: { id: 'u-1' } };
    update();
    expect(assistant().optedIn).toBe(true);
  });

  it('ends the session when the switch is turned off', async () => {
    const { sockets } = setup();
    const socket = await pair(sockets);
    act(() => assistant().setOptedIn(false));
    expect(socket.closeCall).toEqual({ code: 1000, reason: 'disconnect' });
    expect(assistant().phase).toBe('idle');
  });
});

describe.each([false, true])('teardown (D7 switch %s)', (keepSignedIn) => {
  const signals: Array<[string, string, (ctx: ReturnType<typeof setup>) => void]> = [
    ['Disconnect', 'disconnect', () => act(() => assistant().disconnect())],
    [
      'the household going away (sign-out)',
      'sign-out',
      (ctx) => {
        auth.value = { ...auth.value, me: null, householdId: null, isUnlocked: false };
        ctx.update();
      },
    ],
    [
      'the workspace locking',
      'lock',
      (ctx) => {
        auth.value = { ...auth.value, isUnlocked: false };
        ctx.update();
      },
    ],
    [
      'a different user signing in',
      'user-switch',
      (ctx) => {
        auth.value = { ...auth.value, me: { id: 'u-2' } };
        ctx.update();
      },
    ],
    ['pagehide', 'pagehide', () => act(() => void window.dispatchEvent(new Event('pagehide')))],
  ];

  it.each(signals)('ends on %s with reason %s', async (_label, reason, trigger) => {
    const ctx = setup({ keepSignedIn });
    const handler = vi.fn(() => OK);
    const unregister = assistant().registerHandler('retivo_status', handler);
    const socket = await pair(ctx.sockets);

    trigger(ctx);

    expect(socket.closeCall).toEqual({ code: 1000, reason });
    expect(assistant().phase).toBe('idle');
    // The consent record dies with the session.
    expect(assistant().consent).toBeNull();
    act(() => socket.receive({ type: 'call', id: 'late', tool: 'retivo_status', args: {} }));
    expect(handler).not.toHaveBeenCalled();
    // A fresh code is needed: nothing reconnects by itself, and a blank code is refused.
    expect(ctx.openSocket).toHaveBeenCalledTimes(1);
    unregister();
  });
});

describe('idle', () => {
  const IDLE_MS = 60_000;

  function fakeClock(): void {
    // WebCrypto resolves off the timer queue, so only the timer functions and the clock are faked.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  }

  /** An idle sign-out reaches the tab only as the sign-in going away. */
  function signOutOnTimeout(ctxRef: { current: ReturnType<typeof setup> | null }): () => void {
    return () => {
      auth.value = { ...auth.value, me: null, householdId: null, isUnlocked: false };
      ctxRef.current?.update();
    };
  }

  async function callAndSettle(socket: ScriptedSocket, id: string, tool: string, args: Record<string, unknown> = {}): Promise<void> {
    await act(async () => {
      socket.receive({ type: 'call', id, tool, args });
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it('ends the session at the idle timeout with the switch off, and calls of every outcome never moved the clock', async () => {
    fakeClock();
    const ctxRef: { current: ReturnType<typeof setup> | null } = { current: null };
    const onTimeout = vi.fn(signOutOnTimeout(ctxRef));
    ctxRef.current = setup({ timer: [{ idleMs: IDLE_MS, onTimeout }] });
    const socket = await pair(ctxRef.current.sockets);
    assistant().registerHandler('retivo_status', () => OK);
    assistant().registerHandler('retivo_get_scenario', () => ({ ok: false, error: { code: 'INTERNAL', message: 'no' } }));
    assistant().registerHandler('retivo_get_projection', () => new Promise<never>(() => undefined));
    const written = localStorage.getItem(ACTIVITY_KEY);

    await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
    await callAndSettle(socket, 'c1', 'retivo_status');
    await callAndSettle(socket, 'c2', 'retivo_get_scenario', { scenarioId: 'a' });
    await callAndSettle(socket, 'c3', 'retivo_compare_scenarios', { baseScenarioId: 'a', otherScenarioId: 'b' });
    await callAndSettle(socket, 'c4', 'retivo_get_scenario', {});
    expect(localStorage.getItem(ACTIVITY_KEY)).toBe(written);
    expect(socket.frames.filter((frame) => frame.type === 'result')).toHaveLength(4);

    await act(async () => void (await vi.advanceTimersByTimeAsync(IDLE_MS - 10_000 + 1)));
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(assistant().phase).toBe('idle');
    expect(socket.closeCall).toEqual({ code: 1000, reason: 'sign-out' });
  });

  it('with the switch on, each completed call moves the key and defers the timeout once', async () => {
    fakeClock();
    const ctxRef: { current: ReturnType<typeof setup> | null } = { current: null };
    const onTimeout = vi.fn(signOutOnTimeout(ctxRef));
    const onSecondTimeout = vi.fn();
    ctxRef.current = setup({
      keepSignedIn: true,
      timer: [
        { idleMs: IDLE_MS, onTimeout },
        { idleMs: IDLE_MS, onTimeout: onSecondTimeout },
      ],
    });
    const start = Date.now();
    const socket = await pair(ctxRef.current.sockets);
    assistant().registerHandler('retivo_status', () => OK);

    await act(async () => void (await vi.advanceTimersByTimeAsync(20_000)));
    await callAndSettle(socket, 'c1', 'retivo_status');
    expect(localStorage.getItem(ACTIVITY_KEY)).toBe(String(Date.now()));
    expect(Number(localStorage.getItem(ACTIVITY_KEY))).toBeGreaterThanOrEqual(start + 20_000);

    // A sibling tab learns of the write through the storage event; jsdom does not fire one for same-document writes.
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: ACTIVITY_KEY, newValue: localStorage.getItem(ACTIVITY_KEY) }));
    });

    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    await callAndSettle(socket, 'c2', 'retivo_status');
    expect(localStorage.getItem(ACTIVITY_KEY)).toBe(String(Date.now()));

    // Without the two deferrals the first timer would have fired at 60 s; with one, at 80 s.
    await act(async () => void (await vi.advanceTimersByTimeAsync(IDLE_MS - 1_000)));
    expect(onTimeout).not.toHaveBeenCalled();
    expect(onSecondTimeout).not.toHaveBeenCalled();
    expect(assistant().phase).toBe('ready');

    await act(async () => void (await vi.advanceTimersByTimeAsync(2_000)));
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onSecondTimeout).toHaveBeenCalledTimes(1);
    expect(assistant().phase).toBe('idle');
  });

  it('with the switch on, a call that is started, fails, is cancelled, times out, is locked out or is unsupported moves nothing', async () => {
    fakeClock();
    const ctxRef: { current: ReturnType<typeof setup> | null } = { current: null };
    const onTimeout = vi.fn(signOutOnTimeout(ctxRef));
    ctxRef.current = setup({ keepSignedIn: true, timer: [{ idleMs: 300_000, onTimeout }] });
    const socket = await pair(ctxRef.current.sockets);
    assistant().registerHandler('retivo_get_scenario', () => ({ ok: false, error: { code: 'INTERNAL', message: 'no' } }));
    assistant().registerHandler('retivo_get_projection', () => new Promise<never>(() => undefined));
    assistant().registerHandler('retivo_get_stress_test', () => new Promise<never>(() => undefined));
    const written = localStorage.getItem(ACTIVITY_KEY);

    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    await callAndSettle(socket, 'c1', 'retivo_get_projection', { scenarioId: 'a' }); // started, then cancelled
    await callAndSettle(socket, 'c2', 'retivo_get_scenario', { scenarioId: 'a' }); // failed
    await callAndSettle(socket, 'c3', 'retivo_compare_scenarios', { baseScenarioId: 'a', otherScenarioId: 'b' }); // unsupported (no handler yet)
    await callAndSettle(socket, 'c4', 'retivo_get_scenario', {}); // invalid
    act(() => socket.receive({ type: 'cancel', id: 'c1', reason: 'client' }));
    await callAndSettle(socket, 'c5', 'retivo_get_stress_test', { scenarioId: 'a' }); // times out below
    expect(localStorage.getItem(ACTIVITY_KEY)).toBe(written);
    await act(async () => void (await vi.advanceTimersByTimeAsync(5 * 60_000)));
    expect(socket.frames.filter((frame) => frame.type === 'result').map((frame) => (frame.result as { error: { code: string } }).error.code)).toEqual(
      expect.arrayContaining(['CANCELLED', 'INTERNAL', 'TOOL_NOT_SUPPORTED', 'INVALID_ARGS', 'CALL_TIMEOUT']),
    );
    expect(localStorage.getItem(ACTIVITY_KEY)).toBe(written);

    auth.value = { ...auth.value, isUnlocked: false };
    ctxRef.current.update();
    expect(assistant().phase).toBe('idle');
  });

  it('with the switch on and no completed call, the timeout still fires', async () => {
    fakeClock();
    const ctxRef: { current: ReturnType<typeof setup> | null } = { current: null };
    const onTimeout = vi.fn(signOutOnTimeout(ctxRef));
    ctxRef.current = setup({ keepSignedIn: true, timer: [{ idleMs: IDLE_MS, onTimeout }] });
    await pair(ctxRef.current.sockets);
    await act(async () => void (await vi.advanceTimersByTimeAsync(IDLE_MS + 1)));
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(assistant().phase).toBe('idle');
  });
});
