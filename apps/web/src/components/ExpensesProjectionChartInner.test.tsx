/**
 * ExpensesProjectionChartInner — canonical retirement-marker render
 * + a11y smoke, on the SVG chart engine.
 *
 * The Expenses projection chart must render the same teal
 * `Retires <Mon YYYY>` retirement marker as the Balance Projection
 * charts whenever the host feeds one. Asserts the marker renders as a
 * dashed vertical line with the canonical teal stroke + its label text.
 * expectNoA11yViolations satisfies the AGENTS component-test mandate.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';

import InnerChart from './ExpensesProjectionChartInner';
import type { ExpenseProjectionMonthlyPoint } from '../lib/expense-projection';
import type { TooltipMember } from './tooltip-member';
import type { CashflowChartMarker } from './CashflowProjectionChart';
import { expectNoA11yViolations } from '../test/a11y';
import { renderWithTheme } from '../test/theme-render';
import { CHART_COLORS } from '../lib/tokens';

function point(year: number, month0: number): ExpenseProjectionMonthlyPoint {
  return {
    fractionalYear: year + month0 / 12,
    year,
    month0,
    essential: 3_000,
    discretionary: 1_000,
    total: 4_000,
    oneOffEssential: 0,
    oneOffDiscretionary: 0,
    essentialBase: 3_000,
    discretionaryBase: 1_000,
    oneOffEssentialBase: 0,
    oneOffDiscretionaryBase: 0,
  };
}

const ROWS: ExpenseProjectionMonthlyPoint[] = [point(2033, 0), point(2034, 0)];
const MEMBERS: TooltipMember[] = [{ firstName: 'Alex', birthYear: 1975 }];

describe('ExpensesProjectionChartInner — canonical retirement marker', () => {
  it('renders the teal Retires <Mon YYYY> marker line fed by the host', () => {
    const retirement: CashflowChartMarker = {
      fractionalYear: 2033 + 4 / 12,
      label: 'Retires May 2033',
      color: CHART_COLORS.light.retirementMarker,
    };
    const container = renderWithTheme(
      'light',
      <InnerChart rows={ROWS} markers={[retirement]} members={MEMBERS} />,
    );
    const line = container.querySelector(
      '[data-marker-label="Retires May 2033"]',
    );
    expect(line).not.toBeNull();
    expect(line?.getAttribute('stroke')).toBe(
      CHART_COLORS.light.retirementMarker,
    );
    expect(container.textContent).toContain('Retires May 2033');
  });
});

describe('ExpensesProjectionChartInner — a11y', () => {
  it('renders without a11y violations', async () => {
    const container = renderWithTheme(
      'light',
      <InnerChart rows={ROWS} markers={[]} members={MEMBERS} />,
    );
    await expectNoA11yViolations(container);
  });
});
