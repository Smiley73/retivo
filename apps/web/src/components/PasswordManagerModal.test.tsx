/**
 * PasswordManagerModal — the containment-free re-auth overlay.
 *
 * The whole point of this component is the *absence* of React Aria's modal
 * containment: DOM injected outside the panel (a password manager's autofill
 * popup) must stay interactive — not `inert`, not `aria-hidden`. These tests
 * assert that property and its falsifiable negative control (the general
 * `Modal` DOES inert injected outside DOM), plus the hand-rolled shell the
 * component owns now that React Aria no longer manages it: scrim outside-click
 * gating (pointerdown + click), document-level Esc gating (including a dynamic
 * transition), autofocus + focus-restore (with a detached-trigger fallback),
 * ref-counted body scroll-lock across stacked instances and unmount-while-open,
 * dialog semantics (role + accessible name, no aria-modal), and an axe smoke.
 *
 * Keyboard/pointer interaction goes through `@testing-library/user-event`.
 * jsdom can only observe the scroll-lock via the body `style.overflow`
 * attribute, and `inert` as a boolean attribute (`hasAttribute('inert')`).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PasswordManagerModal } from './PasswordManagerModal';
import { Modal } from './Modal';
import { expectNoA11yViolations } from '../test/a11y';

afterEach(() => {
  // Defensive: a leaked scroll-lock would bleed into the next test's body
  // style. Every test that opens also closes/unmounts, but reset for safety.
  document.body.style.overflow = '';
});

/** A node appended outside the React tree, mimicking a password-manager popup. */
function injectOutsideNode(): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-testid', 'pm-popup');
  el.textContent = 'Keeper popup';
  document.body.appendChild(el);
  return el;
}

describe('PasswordManagerModal', () => {
  it('renders nothing when closed', () => {
    render(
      <PasswordManagerModal open={false} onClose={() => {}} title="Hidden">
        <p>Body</p>
      </PasswordManagerModal>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Body')).not.toBeInTheDocument();
  });

  it('exposes role=dialog + accessible name from the title and NO aria-modal', () => {
    render(
      <PasswordManagerModal open onClose={() => {}} title="Confirm with your password">
        <p>Body content</p>
      </PasswordManagerModal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAccessibleName('Confirm with your password');
    // The deliberate trade-off: no aria-modal, so the honest
    // semantics match a non-suppressed background.
    expect(dialog).not.toHaveAttribute('aria-modal');
  });

  it('does NOT mark DOM injected outside the panel as inert or aria-hidden', async () => {
    const outside = injectOutsideNode();
    render(
      <PasswordManagerModal open onClose={() => {}} title="Open">
        <p>Body</p>
      </PasswordManagerModal>,
    );
    // Wait for any MutationObserver tick that a containment overlay would use
    // to auto-inert the injected node — the guard must survive it.
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(outside.hasAttribute('inert')).toBe(false);
    expect(outside.getAttribute('aria-hidden')).toBeNull();
    outside.remove();
  });

  it('negative control: the general Modal DOES inert/aria-hide injected outside DOM (guard is falsifiable)', async () => {
    const outside = injectOutsideNode();
    render(
      <Modal open onClose={() => {}} title="Containment modal">
        <p>Body</p>
      </Modal>,
    );
    await screen.findByRole('dialog');
    // React Aria's ariaHideOutside marks siblings inert and/or aria-hidden.
    await waitFor(() =>
      expect(
        outside.hasAttribute('inert') || outside.getAttribute('aria-hidden') === 'true',
      ).toBe(true),
    );
    outside.remove();
  });

  it('does not close on a scrim pointerdown outside the panel', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <PasswordManagerModal open onClose={onClose} title="Scrim locked">
        <p>Body</p>
      </PasswordManagerModal>,
    );
    const scrim = screen.getByRole('dialog').closest('.fixed')!;
    await user.pointer({ keys: '[MouseLeft>]', target: scrim });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close on a scrim click outside the panel', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <PasswordManagerModal open onClose={onClose} title="Scrim locked">
        <p>Body</p>
      </PasswordManagerModal>,
    );
    const scrim = screen.getByRole('dialog').closest('.fixed')!;
    await user.click(scrim);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Esc when keyboardDismissDisabled is unset', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <PasswordManagerModal open onClose={onClose} title="Esc closes">
        <input aria-label="pw" />
      </PasswordManagerModal>,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT close on Esc when keyboardDismissDisabled is set', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <PasswordManagerModal open onClose={onClose} title="Esc locked" keyboardDismissDisabled>
        <input aria-label="pw" />
      </PasswordManagerModal>,
    );
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('honors a dynamic keyboardDismissDisabled false→true→false transition', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <PasswordManagerModal open onClose={onClose} title="Esc dynamic" keyboardDismissDisabled={false}>
        <input aria-label="pw" />
      </PasswordManagerModal>,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    // Verifying starts → Esc suppressed.
    rerender(
      <PasswordManagerModal open onClose={onClose} title="Esc dynamic" keyboardDismissDisabled>
        <input aria-label="pw" />
      </PasswordManagerModal>,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    // Verify finished → Esc closes again.
    rerender(
      <PasswordManagerModal open onClose={onClose} title="Esc dynamic" keyboardDismissDisabled={false}>
        <input aria-label="pw" />
      </PasswordManagerModal>,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('moves focus into the panel on open and restores it to the trigger on close', async () => {
    const onClose = vi.fn();
    const trigger = document.createElement('button');
    trigger.textContent = 'Open prompt';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { rerender } = render(
      <PasswordManagerModal open onClose={onClose} title="Focus">
        <input aria-label="pw" />
      </PasswordManagerModal>,
    );
    // Autofocus lands on the first focusable in the panel.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('pw')));

    rerender(
      <PasswordManagerModal open={false} onClose={onClose} title="Focus">
        <input aria-label="pw" />
      </PasswordManagerModal>,
    );
    // Focus restored to the still-attached trigger.
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    trigger.remove();
  });

  it('falls back to body when the captured trigger is detached on close', async () => {
    const onClose = vi.fn();
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const { rerender } = render(
      <PasswordManagerModal open onClose={onClose} title="Detached">
        <input aria-label="pw" />
      </PasswordManagerModal>,
    );
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('pw')));

    // Trigger leaves the DOM before close (the surface that opened it unmounted).
    trigger.remove();
    rerender(
      <PasswordManagerModal open={false} onClose={onClose} title="Detached">
        <input aria-label="pw" />
      </PasswordManagerModal>,
    );
    await waitFor(() => expect(document.activeElement).toBe(document.body));
  });

  it('locks body scroll on open and restores it on close', async () => {
    const { rerender } = render(
      <PasswordManagerModal open onClose={() => {}} title="Scroll">
        <p>Body</p>
      </PasswordManagerModal>,
    );
    expect(document.body.style.overflow).toBe('hidden');

    rerender(
      <PasswordManagerModal open={false} onClose={() => {}} title="Scroll">
        <p>Body</p>
      </PasswordManagerModal>,
    );
    expect(document.body.style.overflow).toBe('');
  });

  it('restores body scroll on unmount-while-open', () => {
    const { unmount } = render(
      <PasswordManagerModal open onClose={() => {}} title="Scroll unmount">
        <p>Body</p>
      </PasswordManagerModal>,
    );
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('ref-counts the scroll-lock across stacked instances (last-out unlocks)', () => {
    const first = render(
      <PasswordManagerModal open onClose={() => {}} title="First">
        <p>One</p>
      </PasswordManagerModal>,
    );
    expect(document.body.style.overflow).toBe('hidden');

    // A second instance stacks (the dirty-guard confirm over Change-password).
    const second = render(
      <PasswordManagerModal open onClose={() => {}} title="Second">
        <p>Two</p>
      </PasswordManagerModal>,
    );
    expect(document.body.style.overflow).toBe('hidden');

    // Closing the inner instance must NOT unlock — the outer one still holds it.
    second.unmount();
    expect(document.body.style.overflow).toBe('hidden');

    first.unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('has no a11y violations when open', async () => {
    const { baseElement } = render(
      <PasswordManagerModal open onClose={() => {}} title="A11y check">
        <p>Body</p>
        <button type="button">Action</button>
      </PasswordManagerModal>,
    );
    await expectNoA11yViolations(baseElement);
  });
});
