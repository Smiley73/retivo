/**
 * LocalResetRequiredModal tests. Covers the blocking-modal render + copy, the
 * Retry interaction (re-attempts the drop), and the mandatory shared-component
 * a11y smoke (AGENTS.md → Testing setup).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LocalResetRequiredModal } from './LocalResetRequiredModal';
import { expectNoA11yViolations } from '../test/a11y';

describe('LocalResetRequiredModal', () => {
  it('renders nothing while closed', () => {
    render(<LocalResetRequiredModal open={false} onRetry={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('shows the close-all-tabs guidance and a Retry button when open', () => {
    render(<LocalResetRequiredModal open onRetry={vi.fn().mockResolvedValue(undefined)} />);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(/close all other tabs/i);
    expect(dialog).toHaveTextContent(/won.t sign you in until the old data is cleared/i);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('wires the guidance copy as the dialog accessible description', () => {
    render(<LocalResetRequiredModal open onRetry={vi.fn().mockResolvedValue(undefined)} />);
    // RAC wires the alertdialog's aria-describedby from the
    // `slot="description"` body explicitly (regression guard — RAC does not
    // auto-wire it, so without the manual id the dialog would announce only
    // its title).
    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(
      /another browser tab still has this app open/i,
    );
  });

  it('calls onRetry when Retry is clicked (re-attempts the drop)', async () => {
    const onRetry = vi.fn().mockResolvedValue(undefined);
    render(<LocalResetRequiredModal open onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
  });

  it('disables the button while a retry is in flight, then re-enables when it resolves', async () => {
    let resolveRetry: () => void = () => {};
    const onRetry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRetry = resolve;
        }),
    );
    render(<LocalResetRequiredModal open onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    // While pending the label flips to "Retrying…" and the button is disabled.
    const pending = screen.getByRole('button');
    expect(pending).toBeDisabled();
    expect(pending).toHaveTextContent('Retrying…');
    resolveRetry();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry' })).not.toBeDisabled(),
    );
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      <LocalResetRequiredModal open onRetry={vi.fn().mockResolvedValue(undefined)} />,
    );
    await expectNoA11yViolations(container);
  });
});
