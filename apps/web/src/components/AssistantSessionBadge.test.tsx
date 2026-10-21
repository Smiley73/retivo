/**
 * The shell's connected indicator: nothing without a session, a named pill and a one-activation
 * Disconnect with a place for focus to land, and the axe smoke. jsdom applies no Tailwind, so the
 * width behaviour (one banner row at 320 px) is the manual check recorded in the PR.
 */
import React from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../test/a11y';
import { assistantValue, createAssistantStore } from '../test/assistant-context';
import { AssistantSessionBadge, type AssistantSessionBadgeVariant } from './AssistantSessionBadge';

const store = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../assistant/AssistantContext', async () => {
  const { useSyncExternalStore } = await import('react');
  const current = () => store.current as ReturnType<typeof createAssistantStore>;
  const hook = () => useSyncExternalStore(current().subscribe, current().get);
  return { useOptionalAssistant: hook, useAssistant: hook };
});

function setup(variant: AssistantSessionBadgeVariant, initial = assistantValue()) {
  const assistants = createAssistantStore(initial);
  store.current = assistants;
  // `disconnect` ends the session the way the real one does: the badge's state goes idle.
  const disconnect = vi.fn(() => assistants.set(assistantValue({ phase: 'idle', client: null, pairedAt: null })));
  assistants.set({ ...initial, disconnect });
  const shell =
    variant === 'banner' ? (
      <div role="banner">
        <button type="button">Menu</button>
        <AssistantSessionBadge variant="banner" />
      </div>
    ) : (
      <aside>
        <nav aria-label="Sections">
          <button type="button">Dashboard</button>
        </nav>
        <AssistantSessionBadge variant="sidebar" />
      </aside>
    );
  return { ...render(shell), assistants, disconnect };
}

beforeEach(() => {
  store.current = createAssistantStore(null);
});

describe('AssistantSessionBadge', () => {
  it('renders nothing without a session', () => {
    const { container } = render(<AssistantSessionBadge variant="banner" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the session is not yet connected', () => {
    store.current = createAssistantStore(assistantValue({ phase: 'awaiting-consent' }));
    const { container } = render(<AssistantSessionBadge variant="sidebar" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the pill by state and the self-reported client', () => {
    setup('banner');
    expect(screen.getByRole('button', { name: 'Assistant connected, reported as Claude Code. View activity' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect assistant' })).toBeInTheDocument();
  });

  it('strips control characters from the name and keeps it within the label cap', () => {
    setup('banner', assistantValue({ client: { name: `\u0000\u0007Re\u0090tivo​${'x'.repeat(200)}\u001b[31m`, version: '1' } }));
    const pill = screen.getByRole('button', { name: /^Assistant connected, reported as / });
    const name = pill.getAttribute('aria-label')!.replace('Assistant connected, reported as ', '').replace('. View activity', '');
    expect(name).not.toMatch(/[\u0000-\u001f\u007f-\u009f​]/u);
    expect(name.startsWith('Retivoxxx')).toBe(true);
    expect(Array.from(name).length).toBeLessThanOrEqual(60);
  });

  it('still has a complete name when the bridge reported none', () => {
    setup('banner', assistantValue({ client: null }));
    expect(screen.getByRole('button', { name: 'Assistant connected. View activity' })).toBeInTheDocument();
    setup('sidebar', assistantValue({ client: { name: '\u0000 \u0007', version: '' } }));
    expect(screen.getAllByRole('button', { name: 'Assistant connected. View activity' })).toHaveLength(2);
  });

  it('calls disconnect once and moves focus to the Menu button in the banner', async () => {
    const user = userEvent.setup();
    const { disconnect } = setup('banner');
    await user.click(screen.getByRole('button', { name: 'Disconnect assistant' }));
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Disconnect assistant' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveFocus();
  });

  it('moves focus to the first navigation button in the sidebar', async () => {
    const user = userEvent.setup();
    const { disconnect } = setup('sidebar');
    await user.click(screen.getByRole('button', { name: 'Disconnect assistant' }));
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Dashboard' })).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('reaches the pill then Disconnect by Tab, and Enter and Space both disconnect', async () => {
    const user = userEvent.setup();
    const first = setup('banner');
    await user.tab();
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: /^Assistant connected/ })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Disconnect assistant' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = setup('banner');
    screen.getByRole('button', { name: 'Disconnect assistant' }).focus();
    await user.keyboard(' ');
    expect(second.disconnect).toHaveBeenCalledTimes(1);
  });

  it('opens the activity viewer from the pill, and closing it leaves the session alone', async () => {
    const user = userEvent.setup();
    const { disconnect } = setup('banner');
    await user.click(screen.getByRole('button', { name: /^Assistant connected/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Assistant activity' });
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(disconnect).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Disconnect assistant' })).toBeInTheDocument();
  });

  it('does not reopen the viewer on the next pairing after the session ended with it open', async () => {
    const user = userEvent.setup();
    const { assistants } = setup('banner');
    await user.click(screen.getByRole('button', { name: /^Assistant connected/ }));
    await screen.findByRole('dialog', { name: 'Assistant activity' });
    // The session ends from outside the viewer (the bridge went away).
    act(() => assistants.set(assistantValue({ phase: 'idle', client: null, pairedAt: null })));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => assistants.set(assistantValue()));
    expect(screen.getByRole('button', { name: /^Assistant connected/ })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('disconnects from inside the viewer: closes it, ends the session and keeps focus off the body', async () => {
    const user = userEvent.setup();
    const { disconnect } = setup('banner');
    await user.click(screen.getByRole('button', { name: /^Assistant connected/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Assistant activity' });
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect assistant' }));
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // React Aria restores focus on the next frame; give it that frame to prove it does not steal it back.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveFocus();
  });

  it('has no axe violations while connected', async () => {
    const { container } = setup('banner');
    await expectNoA11yViolations(container);
  });
});
