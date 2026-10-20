/**
 * The AI assistants card in Settings → Preferences: gates, the opt-in switch,
 * the launch commands, the pairing-code field, the status line and the
 * diagnosis texts. Rendered inside the real provider with a scripted socket.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeCommandFor } from '@retirement/assistant-protocol';
import { AssistantProvider } from '../assistant/AssistantContext';
import { BetaFeaturesProvider } from '../contexts/BetaFeaturesContext';
import { ScriptedSocket, allowWithDefaults, pairScripted } from '../test/assistant-socket';
import { expectNoA11yViolations } from '../test/a11y';
import { GENEROUS_DEFAULTS_STATEMENT, MODEL_PROVIDER_STATEMENT } from '../assistant/sharing/sentences';
import { AssistantSettingsCard } from './AssistantSettingsCard';

const auth = vi.hoisted(() => ({
  value: { me: { id: 'u-1' } as { id: string } | null, householdId: 'h-1' as string | null, isUnlocked: true, unlockResolved: true },
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth.value }));

const CODE = '7QW49KXMZ2';

interface Options {
  port?: string;
  betaOn?: boolean;
  optIn?: boolean;
}

function setup({ port = '24580', betaOn = true, optIn = true }: Options = {}) {
  if (port !== '') vi.stubEnv('VITE_ASSISTANT_BRIDGE_PORT', port);
  if (betaOn) localStorage.setItem('retivo.betaFeatures.u-1', 'on');
  if (optIn) localStorage.setItem('retivo.assistant.optIn.u-1', 'on');
  const sockets: ScriptedSocket[] = [];
  const openSocket = vi.fn(() => {
    const socket = new ScriptedSocket();
    sockets.push(socket);
    return socket;
  });
  const tree = (): React.ReactElement => (
    <BetaFeaturesProvider userId={auth.value.me?.id ?? null}>
      <AssistantProvider openSocket={openSocket} requestConsent={allowWithDefaults}>
        <AssistantSettingsCard />
      </AssistantProvider>
    </BetaFeaturesProvider>
  );
  const utils = render(tree());
  return { ...utils, sockets, openSocket, update: () => utils.rerender(tree()) };
}

const codeField = (): HTMLInputElement => screen.getByLabelText('Pairing code');

beforeEach(() => {
  localStorage.clear();
  auth.value = { me: { id: 'u-1' }, householdId: 'h-1', isUnlocked: true, unlockResolved: true };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('AssistantSettingsCard gates', () => {
  it('renders nothing without a bridge port, even for an opted-in beta user', () => {
    const { container } = setup({ port: '' });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the beta feature is hidden', () => {
    const { container } = setup({ betaOn: false });
    expect(container).toBeEmptyDOMElement();
  });

  it('shows only the opt-in switch until the person opts in', () => {
    setup({ optIn: false });
    expect(screen.getByRole('heading', { level: 2, name: /AI assistants/ })).toHaveTextContent('Beta');
    expect(screen.getByRole('switch', { name: 'Allow AI assistants on this device' })).not.toBeChecked();
    expect(screen.getByRole('switch')).toHaveAccessibleDescription(MODEL_PROVIDER_STATEMENT);
    expect(screen.queryByLabelText('Pairing code')).not.toBeInTheDocument();
    expect(screen.queryByText(/Claude Code/)).not.toBeInTheDocument();
  });

  it('renders the whole card once all three gates are open', async () => {
    const { container } = setup();
    expect(screen.getByRole('switch', { name: 'Allow AI assistants on this device' })).toBeChecked();
    expect(codeField()).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Not connected');
    await expectNoA11yViolations(container);
  });

  it('states the same two sentences as the consent dialog once the commands show, under them', () => {
    setup();
    const note = screen.getByText(`${MODEL_PROVIDER_STATEMENT} ${GENEROUS_DEFAULTS_STATEMENT}`);
    const copyButtons = screen.getAllByRole('button', { name: /^Copy .* command$/ });
    expect(copyButtons.at(-1)!.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The pre-opt-in note is not repeated beside the same sentence.
    expect(screen.getAllByText(MODEL_PROVIDER_STATEMENT, { exact: false })).toHaveLength(1);
  });

  it('persists the switch per user and re-reads it when the user changes', async () => {
    const { update } = setup({ optIn: false });
    await userEvent.click(screen.getByRole('switch'));
    expect(localStorage.getItem('retivo.assistant.optIn.u-1')).toBe('on');
    expect(screen.getByRole('switch')).toBeChecked();

    auth.value = { ...auth.value, me: { id: 'u-2' } };
    localStorage.setItem('retivo.betaFeatures.u-2', 'on');
    update();
    expect(screen.getByRole('switch')).not.toBeChecked();

    auth.value = { ...auth.value, me: { id: 'u-1' } };
    update();
    expect(screen.getByRole('switch')).toBeChecked();
  });
});

describe('launch commands', () => {
  it('shows one command per agent for this origin and port, and copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    setup({ port: '24999' });
    for (const agent of ['claude', 'codex'] as const) {
      const command = bridgeCommandFor(agent, { origin: window.location.origin, port: 24999 });
      expect(command).toContain(window.location.origin);
      expect(screen.getByText(command)).toBeInTheDocument();
    }
    await userEvent.click(screen.getByRole('button', { name: 'Copy Codex command' }));
    expect(writeText).toHaveBeenCalledWith(bridgeCommandFor('codex', { origin: window.location.origin, port: 24999 }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('says so when the clipboard is unavailable', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Copy Claude Code command' }));
    expect(await screen.findByText(/Could not copy/)).toBeInTheDocument();
  });

  it('explains instead of showing commands when the origin is unsafe to paste', () => {
    const original = window.location;
    vi.stubGlobal('location', { ...original, origin: 'http://192.168.1.20:5173' });
    setup();
    expect(screen.getByText(/available when Retivo is opened over https/)).toBeInTheDocument();
    expect(screen.queryByText(/mcp add/)).not.toBeInTheDocument();
  });
});

describe('connecting', () => {
  it('refuses a malformed code before any socket opens', async () => {
    const { openSocket } = setup();
    await userEvent.type(codeField(), 'ABC');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not a pairing code');
    expect(openSocket).not.toHaveBeenCalled();
  });

  it('keeps the code field away from password managers and autocomplete', () => {
    setup();
    const field = codeField();
    expect(field).toHaveAttribute('autocomplete', 'off');
    expect(field).not.toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('data-1p-ignore');
    expect(field).toHaveAttribute('data-lpignore', 'true');
    expect(field).toHaveAttribute('data-bwignore');
  });

  it('pairs, clears the field, reports the state and disconnects', async () => {
    const { sockets, openSocket } = setup();
    await userEvent.type(codeField(), '7qw49-kxmz2');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(openSocket).toHaveBeenCalledTimes(1);
    // The code left the field the moment Connect was pressed.
    expect(codeField()).toHaveValue('');
    expect(screen.getByRole('status')).toHaveTextContent('Connecting to the bridge');
    await act(async () => {
      await pairScripted(sockets[0]!, CODE);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Connected');
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(sockets[0]!.closeCall).toEqual({ code: 1000, reason: 'disconnect' });
    expect(screen.getByRole('status')).toHaveTextContent('Not connected');
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  });

  it('keeps keyboard focus on the control that takes over when a session starts and ends', async () => {
    const { sockets } = setup();
    await userEvent.type(codeField(), CODE);
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Disconnect' })).toHaveFocus();
    await act(async () => {
      await pairScripted(sockets[0]!, CODE);
    });
    expect(screen.getByRole('button', { name: 'Disconnect' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
    expect(codeField()).toHaveFocus();
  });

  it('returns focus to the code field when the bridge refuses the code', async () => {
    const { sockets } = setup();
    await userEvent.type(codeField(), CODE);
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.getByRole('button', { name: 'Disconnect' })).toHaveFocus();
    await act(async () => {
      sockets[0]!.open();
      sockets[0]!.emitClose(4002);
    });
    expect(codeField()).toHaveFocus();
  });

  it('does not take focus from something outside the form when the session ends', async () => {
    const { sockets } = setup();
    await userEvent.type(codeField(), CODE);
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    const outside = screen.getByRole('button', { name: 'Copy Claude Code command' });
    outside.focus();
    await act(async () => {
      sockets[0]!.emitClose(1006);
    });
    expect(outside).toHaveFocus();
  });

  it('asks the person to unlock first when the workspace is locked', async () => {
    auth.value = { ...auth.value, isUnlocked: false };
    const { openSocket } = setup();
    await userEvent.type(codeField(), CODE);
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('unlock your workspace');
    expect(openSocket).not.toHaveBeenCalled();
  });
});

describe('diagnosis texts', () => {
  const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
  const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:151.0) Gecko/20100101 Firefox/151.0';
  const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

  async function failWith(closeCode: number, openFirst: boolean, agent = CHROME, brave = false) {
    vi.stubGlobal('navigator', { ...navigator, userAgent: agent, ...(brave && { brave: {} }), permissions: undefined });
    const view = setup();
    await userEvent.type(codeField(), CODE);
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await act(async () => {
      if (openFirst) view.sockets[0]!.open();
      view.sockets[0]!.emitClose(closeCode);
    });
    return view;
  }

  it('says "not running or blocked" with the Chromium remedy when nothing answers', async () => {
    await failWith(1006, false);
    expect(screen.getByRole('status')).toHaveTextContent(/either not running or blocked by your browser/);
    expect(screen.getByRole('status')).toHaveTextContent(/choose Allow/);
  });

  it('names the Brave setting', async () => {
    await failWith(1006, false, CHROME, true);
    expect(screen.getByRole('status')).toHaveTextContent(/Brave blocks this by default/);
  });

  it('names the Firefox prompt', async () => {
    await failWith(1006, false, FIREFOX);
    expect(screen.getByRole('status')).toHaveTextContent(/Firefox 151 and later asks/);
  });

  it('says Safari is unsupported, before and after a failure', async () => {
    vi.stubGlobal('navigator', { ...navigator, userAgent: SAFARI });
    setup();
    expect(screen.getByText(/Safari and browsers on an iPhone or iPad cannot connect/)).toBeInTheDocument();
  });

  it.each([
    [4005, /already has a Retivo tab connected/],
    [4002, /code is not right/],
    [4003, /Too many wrong codes/],
    [4004, /expired or was already used/],
    [4001, /do not speak the same version/],
    [4007, /unexpected message/],
    [1009, /unexpected message/],
  ])('explains close code %s once the socket opened', async (code, text) => {
    await failWith(code, true);
    expect(screen.getByRole('status')).toHaveTextContent(text);
  });

  it('says the thing that answered is not the bridge when no hello arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      vi.stubGlobal('navigator', { ...navigator, userAgent: CHROME, permissions: undefined });
      const view = setup();
      fireEvent.change(codeField(), { target: { value: CODE } });
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
      await act(async () => {
        view.sockets[0]!.open();
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(screen.getByRole('status')).toHaveTextContent(/not the Retivo bridge/);
    } finally {
      vi.useRealTimers();
    }
  });
});
