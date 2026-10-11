/**
 * Tests for the ConfirmDialog component.
 *
 * Internals are React Aria's `ModalOverlay`/`Modal`/`Dialog`. These cover the
 * behavioral contract: render-when-open / hidden-when-closed,
 * the Confirm/Cancel callbacks, rich message content, Esc + scrim
 * resolve cancel, Enter resolves confirm, the LEFT-aligned primary-first
 * action order ("Modals" in docs/ui-conventions.md), and the shared-component axe
 * assertion. Keyboard/pointer interaction goes through
 * `@testing-library/user-event` because React Aria's `usePress`
 * model cannot be driven by `fireEvent`.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Checkbox } from 'react-aria-components';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { expectNoA11yViolations } from '../test/a11y';

describe('ConfirmDialog', () => {
  it('renders when open', () => {
    render(
      <ConfirmDialog
        open
        title="Delete?"
        message="Are you sure?"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText('Delete?')).toBeInTheDocument();
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });

  it('styles the confirm action as danger by default', () => {
    render(
      <ConfirmDialog
        open
        title="Delete?"
        message="Are you sure?"
        confirmLabel="Delete"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    // Default = destructive: the red danger fill (`bg-negative`).
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('bg-negative');
  });

  it('styles the confirm action as primary (not danger) when destructive is false', () => {
    render(
      <ConfirmDialog
        open
        title="Use this passkey?"
        message="This is a benign confirmation."
        confirmLabel="Use it"
        destructive={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    // Benign confirms use the lime primary fill (`bg-accent`) so a screen full
    // of red buttons doesn't dilute what "danger" means.
    const confirm = screen.getByRole('button', { name: 'Use it' });
    expect(confirm).toHaveClass('bg-accent');
    expect(confirm).not.toHaveClass('bg-negative');
  });

  it('does not render when closed', () => {
    render(
      <ConfirmDialog
        open={false}
        title="Delete?"
        message="Are you sure?"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByText('Delete?')).not.toBeInTheDocument();
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete?"
        message="Are you sure?"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('calls onConfirm when Confirm is clicked', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete?"
        message="Are you sure?"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('cancels on Escape', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete?"
        message="Are you sure?"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels on backdrop (scrim) press', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete?"
        message="Are you sure?"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    // React Aria's isDismissable overlay closes (→ onCancel) when a
    // pointer press lands on the scrim outside the dialog panel.
    const dialog = screen.getByRole('alertdialog');
    const overlay = dialog.closest('.fixed')!;
    await user.click(overlay);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('confirms on Enter', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete?"
        message="Are you sure?"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    // The Confirm button is autofocused on open. With the button guard,
    // Enter on the autofocused button activates via native button click
    // rather than the wrapper handler — onConfirm is still called exactly
    // once; the observable result is unchanged.
    await user.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Enter on the focused Cancel button calls onCancel, not onConfirm', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete?"
        message="Are you sure?"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    // Focus the Cancel button directly (no click, no side-effect on mocks).
    screen.getByRole('button', { name: 'Cancel' }).focus();
    await user.keyboard('{Enter}');
    // The button guard early-returns; the browser fires the button's native
    // click — onCancel is called once, onConfirm not at all.
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not confirm on Enter when a checkbox in extraContent has focus', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete all workspace data?"
        message="This clears everything."
        confirmLabel="Delete everything"
        onConfirm={onConfirm}
        onCancel={() => {}}
        extraContent={
          <Checkbox>
            <span>Also erase backup history</span>
          </Checkbox>
        }
      />,
    );
    // Move focus off the autofocused Confirm button onto the opt-in checkbox
    // (the "Delete workspace data" flow's "Also erase backup history" toggle lives here).
    const checkbox = screen.getByRole('checkbox');
    checkbox.focus();
    await user.keyboard('{Enter}');
    // Enter must stay scoped to the checkbox — it does NOT trigger the
    // destructive confirm (the broadened guard excludes interactive
    // input/role=checkbox targets), so the irreversible action never fires by
    // accident while the checkbox is focused.
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('renders the primary (confirm) action first, left-aligned', () => {
    render(
      <ConfirmDialog
        open
        title="Delete?"
        message="Are you sure?"
        confirmLabel="Delete"
        cancelLabel="Keep"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    // React Aria's isDismissable overlay injects a visually-hidden
    // "Dismiss" button as the first DOM button (its AT escape hatch);
    // it is not part of the visible action row. Assert ordering on the
    // two real action buttons: primary (confirm) must precede the
    // dismissive (cancel) action in DOM order — the left-aligned,
    // primary-first modal rule.
    const actions = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-label') !== 'Dismiss');
    expect(actions[0]).toHaveTextContent('Delete');
    expect(actions[1]).toHaveTextContent('Keep');
  });

  it('wires the message as the dialog accessible description', () => {
    render(
      <ConfirmDialog
        open
        title="Delete account?"
        message="This permanently erases all data."
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    // React Aria wires the alertdialog's aria-describedby from the
    // `slot="description"` message (regression guard — a bare <p>
    // would leave the dialog with no programmatic description).
    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(
      'This permanently erases all data.',
    );
  });

  it('keeps rich/multiline message content as the accessible description', () => {
    render(
      <ConfirmDialog
        open
        title="Delete?"
        message={<>This <strong>cannot</strong> be undone.</>}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(
      'This cannot be undone.',
    );
  });

  it('renders rich content in message', () => {
    render(
      <ConfirmDialog
        open
        title="Delete?"
        message={<>This <strong>cannot</strong> be undone.</>}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const strong = screen.getByText('cannot');
    expect(strong.tagName).toBe('STRONG');
  });

  it('gives the message a block box with a bottom gap above the buttons', () => {
    // RAC's <Text> renders an inline <span>; margin-bottom is a no-op on
    // inline boxes, so the message must be `block` for the gap to the
    // action row to exist at all. Regression guard for the
    // "no padding between text and buttons" report.
    render(
      <ConfirmDialog
        open
        title="Delete?"
        message="Are you sure?"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const message = screen.getByText('Are you sure?');
    expect(message).toHaveClass('block');
    expect(message).toHaveClass('mb-6');
  });

  it('applies the size prop to the dialog panel width', () => {
    render(
      <ConfirmDialog
        open
        size="lg"
        title="Delete?"
        message="Are you sure?"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    // The panel is the alertdialog's RAC Modal ancestor; `size` maps to a
    // max-w-* token (lg → max-w-lg). Default (omitted) stays max-w-sm.
    const panel = screen.getByRole('alertdialog').closest('.rounded-lg');
    expect(panel).toHaveClass('max-w-lg');
  });

  it('has no a11y violations when open', async () => {
    const { baseElement } = render(
      <ConfirmDialog
        open
        title="Delete?"
        message="Are you sure?"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    // React Aria portals the dialog outside the render container.
    await expectNoA11yViolations(baseElement);
  });
});
