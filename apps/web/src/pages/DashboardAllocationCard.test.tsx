/**
 * DashboardAllocationCard render + a11y tests. The bucket split is
 * supplied by the caller (computed in `useDashboardProjection`); these
 * tests cover the percentage formatting, the bucket-label mapping, the
 * empty state, and the a11y smoke.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DashboardAllocationCard } from './DashboardAllocationCard';
import type { DashboardAllocationSlice } from './use-dashboard-projection';
import { expectNoA11yViolations } from '../test/a11y';

const SLICES: DashboardAllocationSlice[] = [
  { bucket: 'pretax', dollars: 561, share: 0.561 },
  { bucket: 'taxable', dollars: 285, share: 0.285 },
  { bucket: 'taxfree_roth', dollars: 100, share: 0.1 },
  { bucket: 'taxfree_hsa', dollars: 54, share: 0.054 },
];

describe('DashboardAllocationCard', () => {
  it('renders one labelled row per bucket with a right-aligned percent', () => {
    render(<DashboardAllocationCard allocation={SLICES} />);
    expect(screen.getByText('Tax-deferred')).toBeInTheDocument();
    expect(screen.getByText('Taxable')).toBeInTheDocument();
    expect(screen.getByText('Tax-free (Roth)')).toBeInTheDocument();
    expect(screen.getByText('Tax-free (HSA)')).toBeInTheDocument();
    expect(screen.getByText('56.1%')).toBeInTheDocument();
    expect(screen.getByText('10.0%')).toBeInTheDocument();
    expect(screen.getByText('5.4%')).toBeInTheDocument();
  });

  it('shows an empty hint when there is no allocation', () => {
    render(<DashboardAllocationCard allocation={[]} />);
    expect(
      screen.getByText('Add an account balance to see your allocation.'),
    ).toBeInTheDocument();
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      <DashboardAllocationCard allocation={SLICES} />,
    );
    await expectNoA11yViolations(container);
  });
});
