/** The consent dialog end to end on a scripted socket: the session gate, decline, and the keep-signed-in choice living in the session only. */
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantProvider, useAssistant, type AssistantContextValue } from '../assistant/AssistantContext';
import { KEEP_SIGNED_IN_LABEL } from '../assistant/sharing/sentences';
import { BetaFeaturesProvider } from '../contexts/BetaFeaturesContext';
import { ScriptedSocket, handshakeScripted, until } from '../test/assistant-socket';
import { AssistantConsentHost } from './AssistantConsentHost';

const auth = vi.hoisted(() => ({
  value: { me: { id: 'u-1' } as { id: string } | null, householdId: 'h-1' as string | null, isUnlocked: true, unlockResolved: true },
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth.value }));

const CODE = '7QW49KXMZ2';

const latest: { current: AssistantContextValue | null } = { current: null };
const Probe: React.FC = () => {
  latest.current = useAssistant();
  return null;
};
const assistant = (): AssistantContextValue => latest.current!;

function setup() {
  vi.stubEnv('VITE_ASSISTANT_BRIDGE_PORT', '24580');
  localStorage.setItem('retivo.betaFeatures.u-1', 'on');
  localStorage.setItem('retivo.assistant.optIn.u-1', 'on');
  const sockets: ScriptedSocket[] = [];
  const openSocket = vi.fn(() => {
    const socket = new ScriptedSocket();
    sockets.push(socket);
    return socket;
  });
  render(
    <BetaFeaturesProvider userId="u-1">
      <AssistantProvider openSocket={openSocket}>
        <Probe />
        <AssistantConsentHost />
      </AssistantProvider>
    </BetaFeaturesProvider>,
  );
  return { sockets };
}

// Starts a pairing and plays the bridge up to `paired`; the dialog is due when this returns.
async function pairUntilDialog(sockets: ScriptedSocket[], clientName = 'Claude Code'): Promise<ScriptedSocket> {
  act(() => {
    expect(assistant().connect(CODE)).toBe('started');
  });
  const socket = sockets.at(-1)!;
  await act(async () => {
    await handshakeScripted(socket, CODE, { name: clientName, version: '2.1' });
    await until(() => assistant().phase === 'awaiting-consent', 'the consent step');
  });
  return socket;
}

function storageKeys(): string[] {
  return [...Object.keys(localStorage), ...Object.keys(sessionStorage)].sort();
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  auth.value = { me: { id: 'u-1' }, householdId: 'h-1', isUnlocked: true, unlockResolved: true };
  latest.current = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AssistantConsentHost', () => {
  it('renders nothing until the bridge proves itself, then opens the dialog and sends nothing before Allow', async () => {
    const { sockets } = setup();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const socket = await pairUntilDialog(sockets);
    expect(await screen.findByRole('dialog', { name: /Let this assistant read your plan/ })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: KEEP_SIGNED_IN_LABEL })).not.toBeChecked();
    expect(screen.getByText(/Claude Code wants to read your plan/)).toBeInTheDocument();
    expect(socket.frames.map((frame) => frame.type)).toEqual(['pair']);
    expect(assistant().consent).toBeNull();
  });

  it('Allow sends ready with keepSignedInWhileActive false by default and closes the dialog', async () => {
    const user = userEvent.setup();
    const { sockets } = setup();
    const socket = await pairUntilDialog(sockets);
    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(assistant().phase).toBe('ready'));
    expect(socket.frames[1]).toEqual({ type: 'ready', keepSignedInWhileActive: false });
    expect(assistant().consent).toMatchObject({ keepSignedInWhileActive: false, choices: { members: true, exactDollars: true } });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each([
    [
      'Don’t allow',
      async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(await screen.findByRole('button', { name: 'Don’t allow' }));
      },
    ],
    [
      'Esc',
      async (user: ReturnType<typeof userEvent.setup>) => {
        await screen.findByRole('dialog');
        await user.keyboard('{Escape}');
      },
    ],
    [
      'a scrim click',
      async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click((await screen.findByRole('dialog')).closest('.fixed')!);
      },
    ],
  ])('declines on %s: the socket closes with consent-declined and the agent gets nothing', async (_name, decline) => {
    const user = userEvent.setup();
    const { sockets } = setup();
    const socket = await pairUntilDialog(sockets);
    await decline(user);
    await waitFor(() => expect(socket.closeCall).toEqual({ code: 1000, reason: 'consent-declined' }));
    expect(assistant().phase).toBe('idle');
    expect(assistant().consent).toBeNull();
    expect(socket.frames.map((frame) => frame.type)).toEqual(['pair']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    socket.receive({ type: 'call', id: 'late', tool: 'retivo_status', args: {} });
    expect(socket.frames.some((frame) => frame.type === 'result')).toBe(false);
  });

  it('closes the dialog when the session ends under it', async () => {
    const { sockets } = setup();
    const socket = await pairUntilDialog(sockets);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    act(() => socket.emitClose(1006));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(assistant().phase).toBe('idle');
    expect(assistant().pendingConsent).toBeNull();
  });

  it('keeps keep-signed-in in the session only: no storage key, gone at Disconnect, off again at the next pairing', async () => {
    const user = userEvent.setup();
    const { sockets } = setup();
    const before = storageKeys();

    await pairUntilDialog(sockets);
    await user.click(await screen.findByRole('switch', { name: KEEP_SIGNED_IN_LABEL }));
    await user.click(screen.getByRole('switch', { name: 'Exact dollar figures' }));
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(assistant().phase).toBe('ready'));
    expect(sockets[0]!.frames[1]).toEqual({ type: 'ready', keepSignedInWhileActive: true });
    expect(assistant().consent).toMatchObject({ keepSignedInWhileActive: true, choices: { exactDollars: false } });
    expect(storageKeys()).toEqual(before);

    act(() => assistant().disconnect());
    expect(assistant().consent).toBeNull();
    expect(storageKeys()).toEqual(before);

    await pairUntilDialog(sockets);
    expect(await screen.findByRole('switch', { name: KEEP_SIGNED_IN_LABEL })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Exact dollar figures' })).toBeChecked();
    expect(assistant().consent).toBeNull();
  });
});
