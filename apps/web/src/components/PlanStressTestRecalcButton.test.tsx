/** PlanStressTestRecalcButton: forced recompute, custom accessible name and disabled states. */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanStressTestRecalcButton } from './PlanStressTestSection';
import { vm } from './__fixtures__/plan-stress-test-vm';
import { expectNoA11yViolations } from '../test/a11y';

describe('PlanStressTestRecalcButton — forced recompute', () => {
  it('calls vm.recalculate on click when a result is shown', async () => {
    const user = userEvent.setup();
    const recalculate = vi.fn();
    const { container } = render(<PlanStressTestRecalcButton vm={vm({ recalculate })} />);
    await expectNoA11yViolations(container);
    const btn = screen.getByRole('button', { name: 'Recalculate plan stress test' });
    expect(btn).not.toBeDisabled();
    await user.click(btn);
    expect(recalculate).toHaveBeenCalledTimes(1);
  });

  it('is disabled while a run is in flight', () => {
    render(<PlanStressTestRecalcButton vm={vm({ isRunning: true })} />);
    expect(
      screen.getByRole('button', { name: 'Recalculate plan stress test' }),
    ).toBeDisabled();
  });

  it('renders a custom accessible name when ariaLabel is overridden', () => {
    render(
      <PlanStressTestRecalcButton
        vm={vm()}
        ariaLabel="Recalculate the example projection"
      />,
    );
    expect(
      screen.getByRole('button', {
        name: 'Recalculate the example projection',
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Recalculate plan stress test' }),
    ).not.toBeInTheDocument();
  });

  it('is disabled when there is no result yet', () => {
    render(<PlanStressTestRecalcButton vm={vm({ result: null })} />);
    expect(
      screen.getByRole('button', { name: 'Recalculate plan stress test' }),
    ).toBeDisabled();
  });

  it('renders nothing for the empty / CBP-failed surfaces', () => {
    const empty = render(<PlanStressTestRecalcButton vm={vm({ hasNoAccounts: true })} />);
    expect(empty.container.firstChild).toBeNull();
    const cbpFailed = render(
      <PlanStressTestRecalcButton
        vm={vm({
          cbpValidation: {
            ok: false,
            unconfigured: ['cbp-1'],
            annuityMissingStream: [],
            annuityDuplicateStream: [],
          },
        })}
      />,
    );
    expect(cbpFailed.container.firstChild).toBeNull();
  });
});
