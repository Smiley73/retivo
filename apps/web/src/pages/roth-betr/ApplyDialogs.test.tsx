/**
 * Apply dialogs — no-Roth-IRA error state. When `rothIraAccounts` is
 * empty both dialogs surface an error Alert and disable Apply.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { withTheme } from '../../test/theme-render';
import { ApplyWorkingYearsDialog } from './ApplyWorkingYearsDialog';
import { ApplyRetirementDialog } from './ApplyRetirementDialog';

describe('ApplyWorkingYearsDialog', () => {
  it('offers only same-owner Roth targets and confirms with the chosen pair', async () => {
    const onConfirm = vi.fn();
    render(
      withTheme(
        'light',
        <ApplyWorkingYearsDialog
          open
          onClose={vi.fn()}
          amountDollars={25_000}
          replacedWindowCount={0}
          sourceAccounts={[
            { id: 'ira-a', name: 'Primary IRA', type: 'RETIREMENT_IRA', ownerId: 'm1' },
            { id: 'ira-b', name: 'Spouse IRA', type: 'RETIREMENT_IRA', ownerId: 'm2' },
          ]}
          rothIraAccounts={[
            { id: 'roth-a', name: 'Primary Roth', type: 'RETIREMENT_ROTH_IRA', ownerId: 'm1' },
            { id: 'roth-b', name: 'Spouse Roth', type: 'RETIREMENT_ROTH_IRA', ownerId: 'm2' },
          ]}
          onConfirm={onConfirm}
        />,
      ),
    );
    const dialog = screen.getByRole('dialog');
    // Saving is blocked until a source is chosen.
    expect(within(dialog).getByRole('button', { name: 'Save to scenario' })).toBeDisabled();
    // Choose the m1-owned source via the React Aria listbox.
    await userEvent.click(within(dialog).getByLabelText('Source pre-tax account'));
    await userEvent.click(await screen.findByRole('option', { name: 'Primary IRA' }));
    // Only the same-owner (m1) Roth target is offered — open the target listbox.
    await userEvent.click(within(dialog).getByLabelText('Target Roth IRA'));
    expect(await screen.findByRole('option', { name: 'Primary Roth' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Spouse Roth' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: 'Primary Roth' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save to scenario' }));
    expect(onConfirm).toHaveBeenCalledWith('ira-a', 'roth-a');
  });

  it('shows the no-Roth error and disables the save action when no Roth IRA exists', () => {
    render(
      withTheme(
        'light',
        <ApplyWorkingYearsDialog
          open
          onClose={vi.fn()}
          amountDollars={25_000}
          replacedWindowCount={0}
          sourceAccounts={[{ id: 'a1', name: 'IRA', type: 'RETIREMENT_IRA', ownerId: 'm1' }]}
          rothIraAccounts={[]}
          onConfirm={vi.fn()}
        />,
      ),
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/No Roth IRA account exists/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save to scenario' })).toBeDisabled();
  });
});

describe('ApplyRetirementDialog', () => {
  it('shows the no-Roth error and disables the save action when no Roth IRA exists', () => {
    render(
      withTheme(
        'light',
        <ApplyRetirementDialog
          open
          onClose={vi.fn()}
          rmdTriggerAge={73}
          rothIraAccounts={[]}
          onConfirm={vi.fn()}
        />,
      ),
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/No Roth IRA account exists/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save to scenario' })).toBeDisabled();
  });
});
