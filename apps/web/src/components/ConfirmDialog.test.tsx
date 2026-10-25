/** ConfirmDialog: open and closed rendering, confirm and cancel resolution, and left-aligned primary-first actions. */
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
    screen.getByRole('button', { name: 'Cancel' }).focus();
    await user.keyboard('{Enter}');
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
    const checkbox = screen.getByRole('checkbox');
    checkbox.focus();
    await user.keyboard('{Enter}');
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
    // React Aria's dismissable overlay injects a visually-hidden "Dismiss" button first; assert order on the two real action buttons.
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
    // RAC's <Text> renders an inline span, so the message must be `block` for the gap to the action row to exist.
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
