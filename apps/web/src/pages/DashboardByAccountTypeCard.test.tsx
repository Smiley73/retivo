/**
 * DashboardByAccountTypeCard render + a11y tests. The category split is
 * supplied by the caller (computed in `useDashboardProjection`); these
 * tests cover the label mapping, percentage formatting, the nonzero-bucket
 * filtering (a $0 / absent category is simply not rendered), the empty
 * state, and the a11y smoke.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DashboardByAccountTypeCard } from './DashboardByAccountTypeCard';
import type { DashboardByTypeSlice } from './use-dashboard-projection';
import { expectNoA11yViolations } from '../test/a11y';

// Five active categories — no `other` slice (the $0 Other case).
const SLICES: DashboardByTypeSlice[] = [
  { category: 'retirement', dollars: 500, share: 0.5 },
  { category: 'roth', dollars: 100, share: 0.1 },
  { category: 'brokerage', dollars: 200, share: 0.2 },
  { category: 'hsa', dollars: 76, share: 0.076 },
  { category: 'cash', dollars: 124, share: 0.124 },
];

describe('DashboardByAccountTypeCard', () => {
  it('renders one labelled row per active category with a right-aligned percent', () => {
    render(<DashboardByAccountTypeCard allocation={SLICES} />);
    expect(screen.getByText('Retirement')).toBeInTheDocument();
    expect(screen.getByText('Roth')).toBeInTheDocument();
    expect(screen.getByText('Brokerage')).toBeInTheDocument();
    expect(screen.getByText('HSA')).toBeInTheDocument();
    expect(screen.getByText('Cash & savings')).toBeInTheDocument();
    expect(screen.getByText('50.0%')).toBeInTheDocument();
    expect(screen.getByText('7.6%')).toBeInTheDocument();
  });

  it('drops a category that is not present (e.g. Other at $0)', () => {
    render(<DashboardByAccountTypeCard allocation={SLICES} />);
    expect(screen.queryByText('Other')).not.toBeInTheDocument();
  });

  it('shows an empty hint when there is no allocation', () => {
    render(<DashboardByAccountTypeCard allocation={[]} />);
    expect(
      screen.getByText('Add an account balance to see your accounts by type.'),
    ).toBeInTheDocument();
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      <DashboardByAccountTypeCard allocation={SLICES} />,
    );
    await expectNoA11yViolations(container);
  });
});
