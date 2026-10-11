/**
 * BalanceProjectionMcSampleNote — copy + polite-live-region + a11y.
 *
 * The banner explains the Monte Carlo per-year line is one example, not
 * an average. It must announce POLITELY (`role="status"`) — never
 * assertively (`role="alert"`), which would re-read the paragraph on
 * every basis change.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BalanceProjectionMcSampleNote } from './BalanceProjectionMcSampleNote';
import { expectNoA11yViolations } from '../test/a11y';

describe('BalanceProjectionMcSampleNote', () => {
  it('renders the approved bold lead + body copy', () => {
    render(<BalanceProjectionMcSampleNote />);
    expect(
      screen.getByText('This is one example, not an average.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Monte Carlo tries thousands of possible futures/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/draw a different\s+example/),
    ).toBeInTheDocument();
  });

  it('announces politely via role="status", never role="alert"', () => {
    const { container } = render(<BalanceProjectionMcSampleNote />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('renders its copy at the text-sm page baseline', () => {
    const status = render(<BalanceProjectionMcSampleNote />).getByRole(
      'status',
    );
    expect(status).toHaveClass('text-sm');
  });

  it('has no axe violations', async () => {
    const { container } = render(<BalanceProjectionMcSampleNote />);
    await expectNoA11yViolations(container);
  });
});
