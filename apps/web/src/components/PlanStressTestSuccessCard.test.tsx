/**
 * Display and methodology-button tests for the headline success-probability card.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanStressTestSuccessCard } from './PlanStressTestSection';
import { vm } from './__fixtures__/plan-stress-test-vm';
import { expectNoA11yViolations } from '../test/a11y';


describe('PlanStressTestSuccessCard — methodology (i) button', () => {
  it('renders the (i) trigger button in the success card', async () => {
    const { container } = render(<PlanStressTestSuccessCard vm={vm({ successPct: 85, successTier: 'success' })} />);
    await expectNoA11yViolations(container);
    expect(
      screen.getByRole('button', {
        name: /how is success probability calculated/i,
      }),
    ).toBeInTheDocument();
  });

  it('(i) click opens the MonteCarloMethodologyModal dialog', async () => {
    const user = userEvent.setup();
    render(<PlanStressTestSuccessCard vm={vm({ successPct: 85, successTier: 'success' })} />);
    await user.click(
      screen.getByRole('button', {
        name: /how is success probability calculated/i,
      }),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('PlanStressTestSuccessCard — headline', () => {
  it('renders the headline as a whole-number percent (matches the colour band)', () => {
    // The card renders the integer `successPct` it is given (87%),
    // never a one-decimal form — the 87.3 → 87 rounding is the vm
    // builder's concern, not the card's.
    render(
      <PlanStressTestSuccessCard
        vm={vm({
          successTier: 'success',
          successPct: 87,
        })}
      />,
    );
    expect(screen.getByText('87%')).toBeInTheDocument();
    expect(screen.queryByText('87.3%')).not.toBeInTheDocument();
  });
});
