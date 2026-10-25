/** Modal: dialog semantics, dismissal gating and Enter handling. */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal';
import { DatePicker } from './DatePicker';
import { TextInput } from './TextInput';
import { expectNoA11yViolations } from '../test/a11y';

describe('Modal', () => {
  it('renders nothing when closed', () => {
    render(
      <Modal open={false} onClose={() => {}} title="Hidden">
        <p>Body</p>
      </Modal>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Body')).not.toBeInTheDocument();
  });

  it('renders dialog role, modal semantics, and is labelled by its title', () => {
    render(
      <Modal open onClose={() => {}} title="Edit account">
        <p>Body content</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    // React Aria hides sibling content instead of emitting `aria-modal`, so assert the role and accessible name.
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAccessibleName('Edit account');
    expect(screen.getByText('Body content')).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Esc closes">
        <p>Body</p>
      </Modal>,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on backdrop (scrim) click', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Scrim closes">
        <p>Body</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    const overlay = dialog.closest('.fixed')!;
    await user.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on scrim click when dismissable=false', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Locked scrim" dismissable={false}>
        <p>Body</p>
      </Modal>,
    );
    const overlay = screen.getByRole('dialog').closest('.fixed')!;
    await user.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
  });

  // Separate tests: a scrim click can blur focus out of the dialog, so Esc would no longer reach React Aria's handler.
  it('does not close on scrim click when dismissable=false + keyboardDismissable', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Outside locked" dismissable={false} keyboardDismissable>
        <p>Body</p>
      </Modal>,
    );
    const overlay = screen.getByRole('dialog').closest('.fixed')!;
    await user.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('still closes on Esc when dismissable=false + keyboardDismissable', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Esc kept" dismissable={false} keyboardDismissable>
        <p>Body</p>
      </Modal>,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('disables Esc too when dismissable=false and keyboardDismissable is unset (fully locked)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Fully locked" dismissable={false}>
        <p>Body</p>
      </Modal>,
    );
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('fires onEnter when Enter is pressed', async () => {
    const user = userEvent.setup();
    const onEnter = vi.fn();
    render(
      <Modal open onClose={() => {}} title="Enter submits" onEnter={onEnter}>
        <input type="text" aria-label="text field" />
      </Modal>,
    );
    await user.click(screen.getByLabelText('text field'));
    await user.keyboard('{Enter}');
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it('does not fire onEnter from date or number inputs', async () => {
    const user = userEvent.setup();
    const onEnter = vi.fn();
    render(
      <Modal open onClose={() => {}} title="Enter suppressed" onEnter={onEnter}>
        <input type="date" aria-label="date field" />
        <input type="number" aria-label="number field" />
      </Modal>,
    );
    await user.click(screen.getByLabelText('date field'));
    await user.keyboard('{Enter}');
    await user.click(screen.getByLabelText('number field'));
    await user.keyboard('{Enter}');
    expect(onEnter).not.toHaveBeenCalled();
  });

  it('does not fire onEnter from a React Aria DatePicker date segment', async () => {
    const user = userEvent.setup();
    const onEnter = vi.fn();
    render(
      <Modal open onClose={() => {}} title="Enter not stolen" onEnter={onEnter}>
        <DatePicker ariaLabel="Birthdate" value="2026-05-10" onChange={() => {}} />
      </Modal>,
    );
    await user.click(screen.getByRole('spinbutton', { name: /month/ }));
    await user.keyboard('{Enter}');
    expect(onEnter).not.toHaveBeenCalled();
  });

  it('does not fire onEnter from a spinner-less numeric field but still fires from plain text', async () => {
    const user = userEvent.setup();
    const onEnter = vi.fn();
    render(
      <Modal open onClose={() => {}} title="Mixed fields" onEnter={onEnter}>
        <TextInput
          inputMode="numeric"
          role="spinbutton"
          aria-label="age"
          defaultValue="65"
        />
        <TextInput aria-label="note" defaultValue="" />
      </Modal>,
    );
    await user.click(screen.getByRole('spinbutton', { name: 'age' }));
    await user.keyboard('{Enter}');
    expect(onEnter).not.toHaveBeenCalled();
    await user.click(screen.getByRole('textbox', { name: 'note' }));
    await user.keyboard('{Enter}');
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it('does not fire onEnter when Enter is pressed on a focused button', async () => {
    const user = userEvent.setup();
    const onEnter = vi.fn();
    const onClick = vi.fn();
    render(
      <Modal open onClose={() => {}} title="Button guard" onEnter={onEnter}>
        {/* Author-supplied button — distinct from React Aria's hidden Dismiss button */}
        <button type="button" onClick={onClick}>
          Save
        </button>
      </Modal>,
    );
    screen.getByRole('button', { name: 'Save' }).focus();
    await user.keyboard('{Enter}');
    expect(onEnter).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not fire onEnter when Enter is pressed in a textarea', async () => {
    const user = userEvent.setup();
    const onEnter = vi.fn();
    render(
      <Modal open onClose={() => {}} title="Textarea guard" onEnter={onEnter}>
        <textarea aria-label="notes" />
      </Modal>,
    );
    await user.click(screen.getByLabelText('notes'));
    await user.keyboard('{Enter}');
    expect(onEnter).not.toHaveBeenCalled();
  });

  it('defaults to the overlay-scrolls-the-panel contract (no capped body)', () => {
    render(
      <Modal open onClose={() => {}} title="Default">
        <p>Body content</p>
      </Modal>,
    );
    const body = screen.getByText('Body content');
    expect(body.closest('[role="region"]')).toBeNull();
    expect(
      body.closest('.max-h-full'),
    ).toBeNull();
    expect(body.closest('.overflow-y-auto')).toHaveClass('fixed');
  });

  it('scrollBodyLabel caps the panel and scrolls only the body as a named, focusable region', () => {
    render(
      <Modal
        open
        onClose={() => {}}
        title="Capped"
        scrollBodyLabel="Methodology details"
      >
        <p>Body content</p>
      </Modal>,
    );
    expect(
      screen.getByText('Body content').closest('.max-h-full'),
    ).not.toBeNull();
    const region = screen.getByRole('region', { name: 'Methodology details' });
    expect(region).toHaveClass('overflow-y-auto', 'flex-1', 'min-h-0');
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).not.toContainElement(screen.getByText('Capped'));
    // The overlay must not be a second scroller: focus scroll-into-view would drag the dialog.
    const overlay = region.closest('.fixed');
    expect(overlay).not.toBeNull();
    expect(overlay).toHaveClass('overflow-hidden');
    expect(overlay).not.toHaveClass('overflow-y-auto');
    expect(overlay).toHaveClass('h-[var(--visual-viewport-height)]');
    expect(overlay).not.toHaveClass('min-h-full');
    expect(overlay).toHaveClass('items-start');
    expect(overlay).not.toHaveClass('items-center');
  });

  it('scrollBodyLabel pins the overlay scroll offset so the dialog cannot be dragged off-screen', async () => {
    // `overflow-hidden` still scrolls programmatically; a focused hidden Switch input outside the overlay box would scroll the dialog off-screen.
    render(
      <Modal open onClose={() => {}} title="Pinned" scrollBodyLabel="Form body">
        <p>Body content</p>
      </Modal>,
    );
    const overlay = screen
      .getByRole('region', { name: 'Form body' })
      .closest('.fixed') as HTMLElement;
    overlay.scrollTop = 500;
    overlay.dispatchEvent(new Event('scroll'));
    expect(overlay.scrollTop).toBe(0);
  });

  it('has no a11y violations when open', async () => {
    const { baseElement } = render(
      <Modal open onClose={() => {}} title="A11y check">
        <p>Body</p>
        <button type="button">Action</button>
      </Modal>,
    );
    // React Aria portals the dialog outside the render container, so scan the whole body.
    await expectNoA11yViolations(baseElement);
  });
});
