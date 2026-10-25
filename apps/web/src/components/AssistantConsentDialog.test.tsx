/** The consent dialog: every registry switch with its default and description, the statements, Allow with toggled choices, and the three ways to decline. */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  CONSENT_CHOICES_FIXED_STATEMENT,
  GENEROUS_DEFAULTS_STATEMENT,
  KEEP_SIGNED_IN_LABEL,
  MODEL_PROVIDER_STATEMENT,
  NEVER_SHARED_ITEMS,
  UNKNOWN_ASSISTANT_NAME,
  keepSignedInDescription,
} from '../assistant/sharing/sentences';
import { CONSENT_SWITCHES, KEEP_SIGNED_IN_ID, SHARING_SWITCHES } from '../assistant/sharing/switches';
import { expectNoA11yViolations } from '../test/a11y';
import { AssistantConsentDialog } from './AssistantConsentDialog';

function setup(props: { clientName?: string | null; idleMinutes?: number | null } = {}) {
  const onAllow = vi.fn();
  const onDecline = vi.fn();
  const utils = render(
    <AssistantConsentDialog
      open
      clientName={props.clientName === undefined ? 'Claude Code' : props.clientName}
      idleMinutes={props.idleMinutes === undefined ? 30 : props.idleMinutes}
      onAllow={onAllow}
      onDecline={onDecline}
    />,
  );
  return { ...utils, onAllow, onDecline };
}

describe('AssistantConsentDialog', () => {
  it('renders every registry switch with its default and a linked description', () => {
    setup();
    for (const definition of CONSENT_SWITCHES) {
      const control = screen.getByRole('switch', { name: definition.label });
      if (definition.defaultOn) expect(control).toBeChecked();
      else expect(control).not.toBeChecked();
      expect(control).toHaveAccessibleDescription(definition.describe({ idleMinutes: 30 }));
    }
    expect(screen.getAllByRole('switch')).toHaveLength(CONSENT_SWITCHES.length);
  });

  it('describes what each sharing switch does when it is off, under the switch', () => {
    setup();
    for (const definition of SHARING_SWITCHES) {
      const description = definition.describe({ idleMinutes: 30 });
      expect(description.endsWith(` Off: ${definition.offDescription}`)).toBe(true);
      expect(screen.getByRole('switch', { name: definition.label })).toHaveAccessibleDescription(description);
    }
  });

  it('puts the keep-signed-in switch in its own Session group, off, with the configured minutes', () => {
    setup({ idleMinutes: 15 });
    const session = screen.getByRole('group', { name: 'Session' });
    const control = within(session).getByRole('switch', { name: KEEP_SIGNED_IN_LABEL });
    expect(control).not.toBeChecked();
    expect(control).toHaveAccessibleDescription(keepSignedInDescription(15));
    expect(control).toHaveAccessibleDescription(/after 15 minutes without your own clicks or key presses/);
    expect(control).toHaveAccessibleDescription(/Signing out, Disconnect, closing this tab and locking still end the session\./);

    const sharing = screen.getByRole('group', { name: 'What the assistant may read' });
    expect(within(sharing).queryByRole('switch', { name: KEEP_SIGNED_IN_LABEL })).not.toBeInTheDocument();
    expect(within(sharing).getAllByRole('switch')).toHaveLength(SHARING_SWITCHES.length);
    expect(within(session).getAllByRole('switch')).toHaveLength(1);
  });

  it('states where the data goes, that the defaults are generous, and what is never shared', () => {
    setup();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(MODEL_PROVIDER_STATEMENT)).toBeInTheDocument();
    expect(within(dialog).getByText(GENEROUS_DEFAULTS_STATEMENT)).toBeInTheDocument();
    expect(within(dialog).getByText(CONSENT_CHOICES_FIXED_STATEMENT)).toBeInTheDocument();
    const neverShared = within(dialog).getByRole('group', { name: /Never shared/ });
    for (const item of NEVER_SHARED_ITEMS) expect(within(neverShared).getByText(item)).toBeInTheDocument();
  });

  it('shows the assistant name as unverified, sanitized, or "an assistant" when absent', () => {
    const { unmount } = setup({ clientName: 'Evil\u202E\nAgent\u200B ' + 'x'.repeat(100) });
    const intro = screen.getByText(/wants to read your plan/);
    expect(intro).toHaveTextContent(/cannot verify it/);
    expect(intro.textContent).not.toMatch(/[\u202E\u200B\n]/);
    expect(intro.textContent).toContain('Evil Agent');
    expect(intro.textContent).toContain('…');
    unmount();

    setup({ clientName: null });
    expect(screen.getByText(/wants to read your plan/)).toHaveTextContent(`${UNKNOWN_ASSISTANT_NAME} wants to read your plan`);
  });

  it('allows with every switch at its default and keep-signed-in off unless toggled', async () => {
    const user = userEvent.setup();
    const { onAllow, onDecline } = setup();
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    expect(onDecline).not.toHaveBeenCalled();
    expect(onAllow).toHaveBeenCalledTimes(1);
    const [answer] = onAllow.mock.calls[0] as [{ choices: Record<string, boolean>; keepSignedInWhileActive: boolean }];
    expect(answer.keepSignedInWhileActive).toBe(false);
    expect(Object.keys(answer.choices)).toHaveLength(SHARING_SWITCHES.length);
    expect(Object.values(answer.choices).every(Boolean)).toBe(true);
  });

  it('allows with the toggled choices', async () => {
    const user = userEvent.setup();
    const { onAllow } = setup();
    await user.click(screen.getByRole('switch', { name: 'Exact dollar figures' }));
    await user.click(screen.getByRole('switch', { name: 'Notes and descriptions' }));
    await user.click(screen.getByRole('switch', { name: KEEP_SIGNED_IN_LABEL }));
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    expect(onAllow).toHaveBeenCalledWith({
      choices: expect.objectContaining({ exactDollars: false, notes: false, members: true, firstNames: true }),
      keepSignedInWhileActive: true,
    });
  });

  it('keeps Allow first and Don’t allow after it', () => {
    setup();
    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons.indexOf('Allow')).toBeGreaterThanOrEqual(0);
    expect(buttons.indexOf('Allow')).toBeLessThan(buttons.indexOf('Don’t allow'));
  });

  it('declines on Don’t allow', async () => {
    const user = userEvent.setup();
    const { onAllow, onDecline } = setup();
    await user.click(screen.getByRole('button', { name: 'Don’t allow' }));
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onAllow).not.toHaveBeenCalled();
  });

  it('declines on Esc', async () => {
    const user = userEvent.setup();
    const { onAllow, onDecline } = setup();
    await user.keyboard('{Escape}');
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onAllow).not.toHaveBeenCalled();
  });

  it('declines on a scrim click', async () => {
    const user = userEvent.setup();
    const { onAllow, onDecline } = setup();
    await user.click(screen.getByRole('dialog').closest('.fixed')!);
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onAllow).not.toHaveBeenCalled();
  });

  it('falls back to a generic timeout phrase when this build has no idle sign-out', () => {
    setup({ idleMinutes: null });
    expect(screen.getByRole('switch', { name: KEEP_SIGNED_IN_LABEL })).toHaveAccessibleDescription(/signs you out after a period without/);
  });

  it('has the keep-signed-in id the registry names', () => {
    expect(CONSENT_SWITCHES.at(-1)?.id).toBe(KEEP_SIGNED_IN_ID);
  });

  it('has no accessibility violations', async () => {
    setup();
    await expectNoA11yViolations(document.body);
  });
});
