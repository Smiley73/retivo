/** ToggleSwitch: switch role with selected state, accessible name, click and keyboard toggling, and disabled blocking. */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ToggleSwitch } from './ToggleSwitch';
import { expectNoA11yViolations } from '../test/a11y';

describe('ToggleSwitch', () => {
  it('renders role=switch reflecting checked, named by its visible label', () => {
    render(<ToggleSwitch checked label="Active" onChange={() => {}} />);
    const sw = screen.getByRole('switch', { name: 'Active' });
    expect(sw).toBeChecked();
    expect(screen.getByLabelText('Active')).toBe(sw);
  });

  it('toggles on click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ToggleSwitch checked={false} label="Active" onChange={onChange} />);
    await user.click(screen.getByRole('switch', { name: 'Active' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('toggles via the Space key (keyboard activation path)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ToggleSwitch checked label="Active" onChange={onChange} />);
    await user.tab();
    expect(screen.getByRole('switch', { name: 'Active' })).toHaveFocus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('supports an aria-only label (no visible text)', () => {
    render(
      <ToggleSwitch
        checked={false}
        ariaLabel="Override allocation"
        onChange={() => {}}
      />,
    );
    expect(
      screen.getByRole('switch', { name: 'Override allocation' }),
    ).toBeInTheDocument();
  });

  it('an explicit ariaLabel overrides the visible label as the accessible name', () => {
    render(
      <ToggleSwitch
        checked={false}
        label="Discretionary"
        ariaLabel="Classification (off = essential, on = discretionary)"
        onChange={() => {}}
      />,
    );
    expect(
      screen.getByRole('switch', {
        name: 'Classification (off = essential, on = discretionary)',
      }),
    ).toBeInTheDocument();
  });

  it('disabled blocks the change (no onChange on click)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ToggleSwitch checked={false} label="Active" disabled onChange={onChange} />,
    );
    const sw = screen.getByRole('switch', { name: 'Active' });
    expect(sw).toBeDisabled();
    await user.click(sw);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      <ToggleSwitch checked label="Active" onChange={() => {}} />,
    );
    await expectNoA11yViolations(container);
  });
});
