import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CompareData, CompareDrivers } from './balance-projection-compare-data';
import { CompareDriversSection } from './balance-projection-page-compare-drivers';

const ZERO: CompareDrivers = {
  federalTax: 0,
  irmaaSurcharge: 0,
  acaPtcCredit: 0,
  rothConversions: 0,
  rmds: 0,
  qcds: 0,
  withdrawalYears: { pretax: 0, roth: 0, taxable: 0, cash: 0, tax_free: 0 },
};

function compareOf(viewed: CompareDrivers, comparison: CompareDrivers): CompareData {
  const side = (drivers: CompareDrivers) => ({
    horizonYear: 2060,
    endingBalance: 1,
    runOutYear: null,
    drivers,
  });
  return { viewed: side(viewed), comparison: side(comparison) } as CompareData;
}

function renderDrivers(viewed: CompareDrivers, comparison: CompareDrivers): void {
  render(<CompareDriversSection viewedName="A" comparisonName="B" compare={compareOf(viewed, comparison)} />);
}

const rowNames = (): string[] =>
  screen.getAllByRole('row').slice(1).map((r) => within(r).getByRole('rowheader').textContent!);

describe('CompareDriversSection', () => {
  it('keeps the three tax rows at zero and omits every other row that is zero in both', () => {
    renderDrivers(ZERO, ZERO);
    expect(rowNames()).toEqual([
      'Federal income tax',
      'Medicare surcharges (IRMAA)',
      'ACA health credits',
    ]);
    expect(screen.queryByText('Years of withdrawals')).toBeNull();
    expect(screen.getByText(/two complete projections/)).toBeInTheDocument();
  });

  it('shows a row that is non-zero on one side only, in the order Roth, RMD, QCD, buckets', () => {
    renderDrivers(
      { ...ZERO, qcds: 4_000, withdrawalYears: { ...ZERO.withdrawalYears, cash: 3 } },
      { ...ZERO, rothConversions: 60_000, rmds: 0.2 },
    );
    expect(rowNames()).toEqual([
      'Federal income tax',
      'Medicare surcharges (IRMAA)',
      'ACA health credits',
      'Roth conversions',
      'Qualified charitable distributions (QCD)',
      'Years of withdrawals: Cash',
    ]);
    expect(screen.getByText('Years of withdrawals')).toBeInTheDocument();
  });
});
