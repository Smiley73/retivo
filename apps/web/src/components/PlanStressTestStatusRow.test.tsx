import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanStressTestStatusRow } from './PlanStressTestSection';
import { vm } from './__fixtures__/plan-stress-test-vm';
import { expectNoA11yViolations } from '../test/a11y';


describe('PlanStressTestStatusRow — running renders the MC progress bar', () => {
  it('renders the determinate progress bar with Cancel in a polite status region', async () => {
    const { container } = render(
      <PlanStressTestStatusRow
        vm={vm({ isRunning: true, progressDone: 6200, progressTotal: 10000, result: null })}
      />,
    );
    expect(
      screen.getByRole('progressbar', {
        name: /Simulating market histories: 6,200 of 10,000 paths/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(container.querySelector('[role="status"]')).toHaveAttribute('aria-live', 'polite');
    await expectNoA11yViolations(container);
  });

  it('renders an indeterminate bar before the worker reports a total', () => {
    render(
      <PlanStressTestStatusRow
        vm={vm({ isRunning: true, progressDone: 0, progressTotal: 0, result: null })}
      />,
    );
    expect(
      screen.getByRole('progressbar', { name: /preparing simulation/i }),
    ).toBeInTheDocument();
  });

  it('Cancel click invokes vm.cancel', async () => {
    const user = userEvent.setup();
    const cancel = vi.fn();
    render(
      <PlanStressTestStatusRow
        vm={vm({ isRunning: true, progressDone: 1, progressTotal: 10000, cancel, result: null })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('returns null when neither running nor errored', () => {
    const { container } = render(<PlanStressTestStatusRow vm={vm()} />);
    expect(container.firstChild).toBeNull();
  });
});
