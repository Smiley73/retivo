/** The shell indicator against the real provider and session on a scripted socket: pill on allow, verbatim viewer, Disconnect leaving focus on Menu. */
import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolResult } from '@retirement/assistant-protocol';
import { AssistantProvider, useAssistant, type AssistantContextValue } from '../assistant/AssistantContext';
import { BetaFeaturesProvider } from '../contexts/BetaFeaturesContext';
import { ScriptedSocket, allowWithDefaults, handshakeScripted, until } from '../test/assistant-socket';
import { AssistantSessionBadge } from './AssistantSessionBadge';
import { AssistantStatusAnnouncer } from './AssistantStatusAnnouncer';

const auth = vi.hoisted(() => ({
  value: { me: { id: 'u-1' } as { id: string } | null, householdId: 'h-1' as string | null, isUnlocked: true, unlockResolved: true },
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth.value }));

const CODE = '7QW49KXMZ2';
const OK: ToolResult = { ok: true, payload: { total: 1500.5 }, disclosure: {} };

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
      <AssistantProvider openSocket={openSocket} requestConsent={allowWithDefaults}>
        <Probe />
        <div role="banner">
          <button type="button">Menu</button>
          <AssistantSessionBadge variant="banner" />
        </div>
        <AssistantStatusAnnouncer />
      </AssistantProvider>
    </BetaFeaturesProvider>,
  );
  return { sockets };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  auth.value = { me: { id: 'u-1' }, householdId: 'h-1', isUnlocked: true, unlockResolved: true };
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AssistantSessionBadge with a real session', () => {
  it('appears when the person allows, shows a call as sent, and disconnects in one click', async () => {
    const user = userEvent.setup();
    const { sockets } = setup();
    expect(screen.queryByRole('button', { name: 'Disconnect assistant' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('');

    act(() => {
      expect(assistant().connect(CODE)).toBe('started');
    });
    const socket = sockets[0]!;
    await act(async () => {
      await handshakeScripted(socket, CODE, { name: 'Claude Code', version: '2.1' });
      await until(() => assistant().phase === 'ready', 'ready');
    });
    expect(screen.getByRole('status')).toHaveTextContent('Assistant connected, reported as Claude Code');

    let registered: () => void = () => undefined;
    act(() => {
      registered = assistant().registerHandler('retivo_status', () => OK);
    });
    act(() => socket.receive({ type: 'call', id: 'c1', tool: 'retivo_status', args: {} }));
    await waitFor(() => expect(assistant().audit).toHaveLength(1));
    registered();

    await user.click(screen.getByRole('button', { name: /^Assistant connected/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Assistant activity' });
    await user.click(within(dialog).getByRole('button', { name: /retivo_status/ }));
    const shown = within(dialog).getByRole('region', { name: /^Sent text/ }).textContent!;
    expect(shown).toBe(assistant().audit[0]!.payload);
    expect(shown).toContain('1500.5');
    expect(socket.sent.at(-1)).toContain(shown);

    await user.click(within(dialog).getByRole('button', { name: 'Disconnect assistant' }));
    expect(socket.closeCall).toEqual({ code: 1000, reason: 'disconnect' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Disconnect assistant' })).not.toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Assistant disconnected');
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveFocus();
  });
});
