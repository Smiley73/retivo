/**
 * McProgressBar — determinate / indeterminate Monte-Carlo progress bar.
 *
 * Covers the determinate path-count label (on `aria-label` + the
 * visible text line), the indeterminate fallback when `total` is 0/
 * unknown, the custom-label override, and an axe smoke check
 * (AGENTS.md — every components/*.test.tsx runs at least one a11y scan).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { McProgressBar } from './McProgressBar';
import { expectNoA11yViolations } from '../test/a11y';

describe('McProgressBar — determinate mode', () => {
  it('exposes a path-count aria-label + ARIA progressbar value semantics', () => {
    render(<McProgressBar done={6200} total={10000} />);
    const bar = screen.getByRole('progressbar', {
      name: /Simulating market histories: 6,200 of 10,000 paths/,
    });
    expect(bar).toBeInTheDocument();
    // React Aria stamps the value semantics onto the progressbar role.
    expect(bar).toHaveAttribute('aria-valuenow', '6200');
    expect(bar).toHaveAttribute('aria-valuemax', '10000');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
  });

  it('renders the thousands-grouped count in the visible text line', () => {
    render(<McProgressBar done={6200} total={10000} />);
    expect(
      screen.getByText('Simulating market histories: 6,200 of 10,000 paths'),
    ).toBeInTheDocument();
  });

  it('honors a custom label prefix', () => {
    render(<McProgressBar done={3} total={5} label="Resampling scenarios" />);
    expect(
      screen.getByRole('progressbar', {
        name: /Resampling scenarios: 3 of 5 paths/,
      }),
    ).toBeInTheDocument();
  });

  it('honors a custom unit, so a bar counting cases does not claim paths', () => {
    // The market-stress comparison's coarse bar counts stress CASES. Leaving
    // the default in place made it announce "0 of 4 paths" — a unit the number
    // is not in, and the one thing a screen-reader user has to go on.
    render(
      <McProgressBar done={1} total={4} label="Comparing market stresses" unit="done" />,
    );
    expect(
      screen.getByRole('progressbar', {
        name: 'Comparing market stresses: 1 of 4 done',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Comparing market stresses: 1 of 4 done'),
    ).toBeInTheDocument();
  });
});

describe('McProgressBar — indeterminate mode', () => {
  it('renders indeterminate (no aria-valuenow) when total is 0', () => {
    render(<McProgressBar done={0} total={0} />);
    const bar = screen.getByRole('progressbar', {
      name: /Simulating market histories: preparing simulation/,
    });
    expect(bar).toBeInTheDocument();
    // Indeterminate React-Aria ProgressBar omits aria-valuenow.
    expect(bar).not.toHaveAttribute('aria-valuenow');
  });

  it('renders indeterminate when total is negative/unknown', () => {
    render(<McProgressBar done={5} total={-1} />);
    expect(
      screen.getByRole('progressbar', {
        name: /preparing simulation/,
      }),
    ).not.toHaveAttribute('aria-valuenow');
  });
});

describe('McProgressBar — a11y', () => {
  it('has no axe violations (determinate)', async () => {
    const { container } = render(<McProgressBar done={4200} total={10000} />);
    await expectNoA11yViolations(container);
  });

  it('has no axe violations (indeterminate)', async () => {
    const { container } = render(<McProgressBar done={0} total={0} />);
    await expectNoA11yViolations(container);
  });
});
