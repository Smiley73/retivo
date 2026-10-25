/** PasswordManagerModal: the containment-free re-auth overlay; DOM injected outside the panel must stay interactive. */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PasswordManagerModal } from './PasswordManagerModal';
import { Modal } from './Modal';
import { expectNoA11yViolations } from '../test/a11y';

afterEach(() => {
  // jsdom observes the scroll lock only via body `style.overflow`; reset it so a leaked lock cannot bleed into the next test.
  document.body.style.overflow = '';
});

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

  it('exposes role=dialog + accessible name from the title and no aria-modal', () => {
    render(
      <PasswordManagerModal open onClose={() => {}} title="Confirm with your password">
        <p>Body content</p>
      </PasswordManagerModal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAccessibleName('Confirm with your password');
    expect(dialog).not.toHaveAttribute('aria-modal');
  });

  it('does not mark DOM injected outside the panel as inert or aria-hidden', async () => {
    const outside = injectOutsideNode();
    render(
      <PasswordManagerModal open onClose={() => {}} title="Open">
        <p>Body</p>
      </PasswordManagerModal>,
    );
    // Wait out the MutationObserver tick a containment overlay would use to inert the injected node.
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

  it('does not close on Esc when keyboardDismissDisabled is set', async () => {
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

    rerender(
      <PasswordManagerModal open onClose={onClose} title="Esc dynamic" keyboardDismissDisabled>
        <input aria-label="pw" />
      </PasswordManagerModal>,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

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
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('pw')));

    rerender(
      <PasswordManagerModal open={false} onClose={onClose} title="Focus">
        <input aria-label="pw" />
      </PasswordManagerModal>,
    );
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

    const second = render(
      <PasswordManagerModal open onClose={() => {}} title="Second">
        <p>Two</p>
      </PasswordManagerModal>,
    );
    expect(document.body.style.overflow).toBe('hidden');

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
