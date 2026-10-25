/** RecoveryKeyModal: key display, explicit copy control and feedback, and the saved-key gate on Continue. */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoveryKeyModal } from './RecoveryKeyModal';
import { expectNoA11yViolations } from '../test/a11y';

const RECOVERY_KEY = 'ABCD-1234-EF56-7890-ABCD-1234-EF56-7890';

// Save and restore the descriptor per case so a stub left behind cannot weaken another case's never-called assertion.
let origClipboardDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  origClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
});

afterEach(() => {
  if (origClipboardDescriptor !== undefined) {
    Object.defineProperty(navigator, 'clipboard', origClipboardDescriptor);
  } else {
    // cast: restoring a non-enumerable browser property not in the Navigator type
    delete (navigator as any).clipboard;
  }
});

function stubClipboard(writeText: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

function removeClipboard(): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: undefined,
  });
}

function renderModal(
  props: Partial<React.ComponentProps<typeof RecoveryKeyModal>> = {},
): ReturnType<typeof render> {
  return render(
    <RecoveryKeyModal
      recoveryKey={RECOVERY_KEY}
      onConfirmed={vi.fn()}
      onDismiss={vi.fn()}
      {...props}
    />,
  );
}

describe('RecoveryKeyModal', () => {
  it('renders a dialog with the title and the recovery key verbatim', () => {
    renderModal();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Save your recovery key');
    expect(screen.getByTestId('recovery-key-display')).toHaveTextContent(
      RECOVERY_KEY,
    );
  });

  it.each([
    ['the setup consumer’s props', {}],
    [
      'the regeneration consumer’s props',
      {
        title: 'Save your new recovery key',
        intro: 'This is your new recovery key.',
        warning: "We can't show this key again.",
        savedLabel: 'I have saved my new recovery key',
        confirmLabel: 'Activate new key',
        confirmDisabled: false,
        error: 'Something went wrong',
        dismissable: false,
      },
    ],
  ])('never writes to the clipboard from mounting alone, under %s', async (_label, props) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    renderModal(props);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('a single activation writes exactly the displayed key, exactly once', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    renderModal();
    const shown = screen.getByTestId('recovery-key-display').textContent;
    expect(shown).toBe(RECOVERY_KEY);

    fireEvent.click(screen.getByRole('button', { name: 'Copy recovery key' }));
    const feedback = await screen.findByText('Copied to clipboard.');
    expect(feedback).toHaveAttribute('role', 'status');

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(RECOVERY_KEY);
  });

  it('activates the copy control from the keyboard', async () => {
    // userEvent.setup() installs its own navigator.clipboard stub, so the real one must be applied after it.
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    renderModal();

    const copyButton = screen.getByRole('button', { name: 'Copy recovery key' });
    copyButton.focus();
    expect(copyButton).toHaveFocus();
    await user.keyboard('{Enter}');

    const feedback = await screen.findByText('Copied to clipboard.');
    expect(feedback).toHaveAttribute('role', 'status');
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(RECOVERY_KEY);
  });

  it('a rejected write shows the failure state and never the success state', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    stubClipboard(writeText);
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Copy recovery key' }));
    const feedback = await screen.findByText(
      "Couldn't copy. Please copy the key above manually.",
    );
    expect(feedback).toHaveAttribute('role', 'status');
    expect(screen.queryByText('Copied to clipboard.')).not.toBeInTheDocument();
  });

  it('a missing clipboard API shows the failure state and never the success state', async () => {
    // An optional-chained await would resolve undefined without throwing and falsely signal a copy, so the guard is explicit.
    removeClipboard();
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Copy recovery key' }));
    const feedback = await screen.findByText(
      "Couldn't copy. Please copy the key above manually.",
    );
    expect(feedback).toHaveAttribute('role', 'status');
    expect(screen.queryByText('Copied to clipboard.')).not.toBeInTheDocument();
  });

  it('warns that forgetting the password alone needs the key and losing both is permanent', () => {
    renderModal();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(/forget your password/i);
    expect(dialog).toHaveTextContent(/forgetting your password alone is enough/i);
    expect(dialog).toHaveTextContent(
      /if you lose both your password and this key, your encrypted data is gone for good/i,
    );
  });

  it('keeps Continue disabled until the saved-key checkbox is ticked', () => {
    const onConfirmed = vi.fn();
    renderModal({ onConfirmed });

    const continueBtn = screen.getByRole('button', { name: 'Continue' });
    expect(continueBtn).toBeDisabled();
    fireEvent.click(continueBtn);
    expect(onConfirmed).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox', { name: /saved my recovery key/i }));
    expect(continueBtn).toBeEnabled();

    fireEvent.click(continueBtn);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });

  it('invokes onDismiss from the Cancel button', () => {
    const onDismiss = vi.fn();
    renderModal({ onDismiss });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('has no a11y violations with copy feedback rendered', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const { container } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Copy recovery key' }));
    await screen.findByText('Copied to clipboard.');
    await expectNoA11yViolations(container);
  });
});
