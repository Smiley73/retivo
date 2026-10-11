/**
 * TotalsRow — 3-box totals render + tabular-nums.
 *
 * Tailwind-defaults replacement for the legacy `.totals-row` pattern.
 * Asserts each item's label + value render, values carry the
 * `tabular-nums` numeric-alignment class, and the grid is a
 * 3-column layout. Purely presentational (no interactive control / ARIA /
 * focus / keyboard handler) → exempt from the a11y-smoke mandate (AGENTS
 * *Testing setup*).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TotalsRow } from './TotalsRow';

const ITEMS = [
  { key: 'open', label: 'Opening', value: '$10,000' },
  { key: 'change', label: 'Change', value: '+$1,500' },
  { key: 'close', label: 'Closing', value: '$11,500' },
];

describe('TotalsRow', () => {
  it('renders each item label and value', () => {
    render(<TotalsRow items={ITEMS} />);
    expect(screen.getByText('Opening')).toBeInTheDocument();
    expect(screen.getByText('+$1,500')).toBeInTheDocument();
    expect(screen.getByText('$11,500')).toBeInTheDocument();
  });

  it('renders values with the preserved tabular-nums alignment', () => {
    render(<TotalsRow items={ITEMS} />);
    expect(screen.getByText('$10,000').className).toContain('tabular-nums');
  });

  it('uses a 3-column grid', () => {
    const { container } = render(<TotalsRow items={ITEMS} />);
    expect(container.firstElementChild?.className).toContain('grid-cols-3');
  });
});
