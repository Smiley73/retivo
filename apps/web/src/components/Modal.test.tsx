/**
 * Modal — a11y smoke + behavior coverage.
 *
 * The internals are React Aria's `ModalOverlay`/`Modal`/`Dialog`. These
 * tests assert the framework-independent behavioral contract
 * directly rather than React Aria internals: correct dialog semantics
 * (role, aria-modal, labelled by its title), render-nothing-when-closed,
 * Esc closes, scrim click closes, the `dismissable` / `keyboardDismissable`
 * gating (outside-click and Esc disabled independently — the re-auth
 * password-prompt and fully-locked recovery-key contracts), the optional
 * Enter handler fires (and is suppressed on date/number inputs), and the
 * shared-component axe rule.
 *
 * The literal `aria-labelledby` id is React-Aria-generated, so we assert
 * the *labelling relationship* (accessible name) instead of a hard-coded
 * id — the behavior is identical, the id is an internal. Keyboard/
 * pointer interaction goes through `@testing-library/user-event`
 * because React Aria's `usePress` model cannot be driven by `fireEvent`.
 */
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
    // React Aria Components' Dialog enforces modality by hiding sibling
    // content from AT (focus containment + aria-hidden on the rest of
    // the tree) rather than emitting an `aria-modal` attribute — this
    // is RA's documented modal a11y model. Assert the modal contract
    // via the dialog role + the labelling relationship instead of the
    // (intentionally absent) attribute.
    expect(dialog).toHaveAttribute('role', 'dialog');
    // React Aria wires aria-labelledby from the slot="title" heading;
    // assert the resulting accessible name rather than the generated id.
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
    // React Aria's isDismissable overlay closes when a pointer press
    // lands on the overlay (scrim) outside the modal panel.
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

  // The re-auth password prompt's contract (dismissable=false +
  // keyboardDismissable): a password-manager popup (Keeper / 1Password) renders
  // outside the dialog, so an outside click must NOT close it, but Esc remains
  // a keyboard exit. Asserted in two separate tests: clicking the scrim and
  // then pressing Esc in one test is flaky because the scrim click can blur
  // focus out of the dialog, so Esc no longer reaches React Aria's handler.
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
    // keyboardDismissable defaults to dismissable, so a fully-locked modal
    // (the recovery-key modal) blocks both channels with one prop.
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
    // Post-React-Aria the date control is a `role="spinbutton"`
    // segment, not a native `<input type=date>`; Enter must be left
    // for the segment (the migration regression this guards).
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
    // A spinner-less numeric field exposes `role="spinbutton"`: Enter
    // must not be hijacked (the field owns the keystroke).
    await user.click(screen.getByRole('spinbutton', { name: 'age' }));
    await user.keyboard('{Enter}');
    expect(onEnter).not.toHaveBeenCalled();
    // A plain text field keeps the historical Enter-submits behavior.
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
    // Focus the button without a click, then press Enter.
    screen.getByRole('button', { name: 'Save' }).focus();
    await user.keyboard('{Enter}');
    // The button guard early-returns (no preventDefault); the browser fires the
    // button's native click — onEnter is not called, onClick fires exactly once.
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
    // The textarea guard early-returns so Enter adds a newline, not a submit.
    expect(onEnter).not.toHaveBeenCalled();
  });

  it('defaults to the overlay-scrolls-the-panel contract (no capped body)', () => {
    // Dialog sizing: the panel sizes to content and the
    // overlay scrolls the whole panel; the viewport-fit body cap is opt-in.
    render(
      <Modal open onClose={() => {}} title="Default">
        <p>Body content</p>
      </Modal>,
    );
    const body = screen.getByText('Body content');
    // No inner scroll region / named region / viewport cap…
    expect(body.closest('[role="region"]')).toBeNull();
    expect(
      body.closest('.max-h-full'),
    ).toBeNull();
    // …the only scroll container above the body is the React Aria overlay,
    // which scrolls the whole panel (the documented default).
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
    // Panel (the React Aria Modal) is capped to the viewport so the whole
    // dialog — including a wrapped title — fits on short screens.
    expect(
      screen.getByText('Body content').closest('.max-h-full'),
    ).not.toBeNull();
    // The body is a named, keyboard-focusable scroll region (so clipped
    // content is reachable); the title is pinned outside it.
    const region = screen.getByRole('region', { name: 'Methodology details' });
    expect(region).toHaveClass('overflow-y-auto', 'flex-1', 'min-h-0');
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).not.toContainElement(screen.getByText('Capped'));
    // The OVERLAY must not be a second scroller in this mode. With one, the
    // browser's focus scroll-into-view drags the whole dialog when a control is
    // activated — and an `overflow-hidden` overlay still scrolls
    // programmatically, so the user cannot drag it back.
    const overlay = region.closest('.fixed');
    expect(overlay).not.toBeNull();
    expect(overlay).toHaveClass('overflow-hidden');
    expect(overlay).not.toHaveClass('overflow-y-auto');
    // Sized from React Aria's own visual-viewport measurement (which it sets as
    // an inline style on this element), not `min-h-full` or a `vh` guess — an
    // exactly-sized overlay is what makes the panel's `max-h-full` exact.
    expect(overlay).toHaveClass('h-[var(--visual-viewport-height)]');
    expect(overlay).not.toHaveClass('min-h-full');
    // Top-anchored, not centred: a centred panel re-centres every time its
    // height changes, so toggling a field open jerks the whole dialog by half
    // the delta. Anchored, the top edge stays put and growth goes downward.
    expect(overlay).toHaveClass('items-start');
    expect(overlay).not.toHaveClass('items-center');
  });

  it('scrollBodyLabel pins the overlay scroll offset so the dialog cannot be dragged off-screen', async () => {
    // `overflow-hidden` removes the scrollbar but leaves the element scrollable
    // PROGRAMMATICALLY. React Aria's Switch focuses a visually-hidden <input>
    // that can sit a few px outside the overlay's box, and the browser's focus
    // scroll-into-view then scrolls the overlay to reveal it — which dragged the
    // whole dialog off-screen (observed live: overlay scrollTop 1022, panel top
    // -1006). The overlay here is a fixed, viewport-sized scrim that must never
    // scroll, so its offset is pinned back to 0.
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
    // React Aria portals the dialog outside the render container; axe
    // the whole document body so the dialog tree is in scope.
    await expectNoA11yViolations(baseElement);
  });
});
