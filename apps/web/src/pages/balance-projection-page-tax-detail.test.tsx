// BalanceProjectionTaxDetail "Taxes & health costs" sub-table: the six tax fields render, the table is strategy-agnostic (it consumes runner drawdown years carrying tax fields for every strategy), and the solver-diagnostic warning surfaces when a year is unfunded.
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BalanceProjectionTaxDetail } from './balance-projection-page-tax-detail';
import { expectNoA11yViolations } from '../test/a11y';
import type { DrawdownYear } from '../lib/drawdown-engine';

function taxYear(
  year: number,
  o: Partial<DrawdownYear> = {},
): DrawdownYear {
  return {
    year,
    balance: 500_000,
    withdrawn: 50_000,
    netNeed: 40_000,
    growth: 0,
    deposit: 0,
    depleted: false,
    federalTaxCashNeedCents: 800_000,
    irmaaWithheldFromSsCents: 120_000,
    irmaaCashNeedCents: 0,
    acaPtcCashflowOffsetCents: 50_000,
    totalTaxCashflowNeedCents: 750_000,
    taxCashflowIterations: 2,
    taxCashflowConverged: true,
    taxCashflowShortfallCents: 0,
    ...o,
  };
}

const identityDeflator = (): number => 1;

describe('BalanceProjectionTaxDetail', () => {
  it('renders the six tax fields with a column per field', () => {
    render(
      <BalanceProjectionTaxDetail
        drawdownYears={[taxYear(2040)]}
        viewDeflator={identityDeflator}
      />,
    );
    expect(screen.getByText('Federal tax')).toBeInTheDocument();
    expect(screen.getByText('IRMAA withheld')).toBeInTheDocument();
    expect(screen.getByText('IRMAA cash-paid')).toBeInTheDocument();
    expect(screen.getByText('ACA PTC offset')).toBeInTheDocument();
    expect(screen.getByText('Tax-funded withdrawals')).toBeInTheDocument();
    expect(screen.getByText('Credit applied to premiums')).toBeInTheDocument();
    expect(screen.getByText('$8,000')).toBeInTheDocument();
  });

  it('is present for any scenario (tax fields carried on the rows)', () => {
    // The component is strategy-agnostic: every named strategy's rows carry the tax fields, so the table renders identically.
    render(
      <BalanceProjectionTaxDetail
        drawdownYears={[taxYear(2040), taxYear(2041)]}
        viewDeflator={identityDeflator}
      />,
    );
    expect(
      screen.getByRole('region', { name: /taxes and health costs/i }),
    ).toBeInTheDocument();
  });

  it('surfaces a warning when a year is unfunded / non-converged', () => {
    render(
      <BalanceProjectionTaxDetail
        drawdownYears={[
          taxYear(2040),
          taxYear(2041, { taxCashflowShortfallCents: 500_000, taxCashflowConverged: false }),
        ]}
        viewDeflator={identityDeflator}
      />,
    );
    expect(screen.getByText(/could not be fully funded/i)).toBeInTheDocument();
    expect(
      screen.getByLabelText(/tax cashflow unfunded in 2041/i),
    ).toBeInTheDocument();
  });

  it('renders an empty-state message when there is no taxable signal', () => {
    render(
      <BalanceProjectionTaxDetail
        drawdownYears={[
          taxYear(2040, {
            federalTaxCashNeedCents: 0,
            irmaaWithheldFromSsCents: 0,
            irmaaCashNeedCents: 0,
            acaPtcCashflowOffsetCents: 0,
            totalTaxCashflowNeedCents: 0,
          }),
        ]}
        viewDeflator={identityDeflator}
      />,
    );
    expect(screen.getByText(/no tax-funded withdrawals/i)).toBeInTheDocument();
  });

  it('renders the table body at text-sm (typography rule)', () => {
    render(
      <BalanceProjectionTaxDetail
        drawdownYears={[taxYear(2040)]}
        viewDeflator={identityDeflator}
      />,
    );
    const table = screen.getByRole('grid', { name: /taxes and health costs/i });
    expect(table).toHaveClass('text-sm');
  });

  it('shows the credit applied to premiums, deflated like its neighbours', () => {
    render(
      <BalanceProjectionTaxDetail
        drawdownYears={[
          taxYear(2040, {
            federalTaxCashNeedCents: 0,
            irmaaWithheldFromSsCents: 0,
            acaPtcCashflowOffsetCents: 0,
            totalTaxCashflowNeedCents: 0,
            acaCreditAppliedToPremiumsCents: 513_420,
          }),
        ]}
        viewDeflator={() => 0.5}
      />,
    );
    expect(screen.getByText('$2,567')).toBeInTheDocument();
  });

  it('renders the table when the credit applied to premiums is the only signal', () => {
    render(
      <BalanceProjectionTaxDetail
        drawdownYears={[
          taxYear(2040, {
            federalTaxCashNeedCents: 0,
            irmaaWithheldFromSsCents: 0,
            acaPtcCashflowOffsetCents: 0,
            totalTaxCashflowNeedCents: 0,
            acaCreditAppliedToPremiumsCents: 270_000,
          }),
        ]}
        viewDeflator={identityDeflator}
      />,
    );
    expect(screen.getByText('$2,700')).toBeInTheDocument();
  });

  it('omits the Net taxable IRA RMD column when no year carries a QCD', () => {
    render(
      <BalanceProjectionTaxDetail
        drawdownYears={[taxYear(2040)]}
        viewDeflator={identityDeflator}
      />,
    );
    expect(screen.queryByText('Net taxable IRA RMD')).not.toBeInTheDocument();
  });

  it('shows the Net taxable IRA RMD column + value when a QCD is present', () => {
    render(
      <BalanceProjectionTaxDetail
        drawdownYears={[
          taxYear(2040, { qcdCents: 2_000_000, netTaxableRmdCents: 1_500_000 }),
        ]}
        viewDeflator={identityDeflator}
      />,
    );
    expect(screen.getByText('Net taxable IRA RMD')).toBeInTheDocument();
    expect(screen.getByText('$15,000')).toBeInTheDocument();
  });

  it('renders the table for a QCD-only year even with no tax-cashflow signal', () => {
    render(
      <BalanceProjectionTaxDetail
        drawdownYears={[
          taxYear(2040, {
            federalTaxCashNeedCents: 0,
            irmaaWithheldFromSsCents: 0,
            irmaaCashNeedCents: 0,
            acaPtcCashflowOffsetCents: 0,
            totalTaxCashflowNeedCents: 0,
            qcdCents: 1_000_000,
            netTaxableRmdCents: 0,
          }),
        ]}
        viewDeflator={identityDeflator}
      />,
    );
    expect(
      screen.getByRole('region', { name: /taxes and health costs/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('Net taxable IRA RMD')).toBeInTheDocument();
  });

  it('has no a11y violations with the Net taxable IRA RMD column present', async () => {
    const { container } = render(
      <BalanceProjectionTaxDetail
        drawdownYears={[
          taxYear(2040, { qcdCents: 2_000_000, netTaxableRmdCents: 1_500_000 }),
          taxYear(2041),
        ]}
        viewDeflator={identityDeflator}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
