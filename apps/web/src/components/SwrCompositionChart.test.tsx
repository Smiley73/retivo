/**
 * Wrapper test for `SwrCompositionChart` — the `lazy()` + `Suspense` shell
 * around `SwrCompositionChartInner`. `SwrCompositionChartInner.test.tsx`
 * covers everything the chart itself renders; this file only proves the
 * lazy chunk resolves and mounts it — `knip`'s vitest plugin only credits
 * a test file as a real importer of the chunk when it renders the runtime
 * export, not just the row type (`ExpensesCategoryChart.test.tsx` precedent).
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';

import { SwrCompositionChart } from './SwrCompositionChart';
import type { SwrComparisonYearRow } from './SwrCompositionChart';
import { renderWithTheme } from '../test/theme-render';

const ROWS: SwrComparisonYearRow[] = [
  {
    year: 2032,
    guaranteedIncome: 30_000,
    otherIncome: 0,
    afterTaxDraw: 40_000,
    tax: 8_000,
    guaranteedIncomeSplit: { socialSecurity: 20_000, pension: 10_000 },
    guaranteedIncomeSurplus: 0,
    fourPercentRuleValue: 40_000,
    fourPointFivePercentRuleValue: 45_000,
    isPartialYear: false,
  },
  {
    year: 2033,
    guaranteedIncome: 31_000,
    otherIncome: 0,
    afterTaxDraw: 42_000,
    tax: 8_500,
    guaranteedIncomeSplit: { socialSecurity: 20_500, pension: 10_500 },
    guaranteedIncomeSurplus: 0,
    fourPercentRuleValue: 40_000,
    fourPointFivePercentRuleValue: 45_000,
    isPartialYear: false,
  },
];

describe('SwrCompositionChart', () => {
  it('resolves its lazy chunk and renders the chart', async () => {
    renderWithTheme(
      'light',
      <SwrCompositionChart rows={ROWS} depletionYear={null} />,
    );
    expect(
      await screen.findByRole('img', {
        name: 'Spending composition and safe withdrawal rate chart',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Guaranteed income')).toBeInTheDocument();
    expect(screen.getByText('4% rule')).toBeInTheDocument();
  });
});
