/** BalanceProjectionEstimateNote: standing tax, IRMAA and ACA estimate disclosure. */
import React from 'react';
import { render as renderBare, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { BalanceProjectionEstimateNote } from './BalanceProjectionEstimateNote';
import { MonteCarloMethodologyModal } from './MonteCarloMethodologyModal';
import { expectNoA11yViolations } from '../test/a11y';
import { ROUGH_BENCHMARK_ASSUMPTIONS } from '../lib/aca-ptc';

// The missing-premium paragraph links to the Expenses page, so the note needs a router.
const render = (ui: React.ReactElement): ReturnType<typeof renderBare> =>
  renderBare(<MemoryRouter>{ui}</MemoryRouter>);

describe('BalanceProjectionEstimateNote', () => {
  it('discloses that tax/IRMAA/ACA figures are balance-affecting estimates', () => {
    render(<BalanceProjectionEstimateNote />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(/Estimates only/i);
    expect(note).toHaveTextContent(/IRMAA/);
    expect(note).toHaveTextContent(/ACA premium-tax-credit/i);
    expect(note).toHaveTextContent(/reduce your projected\s+balances/i);
  });

  it('discloses the federal-only / senior-deduction-modeled / IRMAA Part B+D / penalty-exception / brokerage-basis limitations', () => {
    render(<BalanceProjectionEstimateNote />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(/only federal income tax/i);
    expect(note).toHaveTextContent(/no state tax/i);
    expect(note).toHaveTextContent(/senior bonus deduction/i);
    expect(note).not.toHaveTextContent(/senior standard deduction is not included/i);
    expect(note).toHaveTextContent(/never itemized deductions/i);
    expect(note).not.toHaveTextContent(/assumes you carry both/i);
    expect(note).toHaveTextContent(/do not check the detailed exceptions/i);
    expect(note).toHaveTextContent(/planning percentage/i);
  });

  it('discloses that yield/interest/cost-basis tax refinements are display-only (not funded)', () => {
    render(<BalanceProjectionEstimateNote />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(/yearly tax on estimated investment yield/i);
    expect(note).toHaveTextContent(/savings, money-market, and CD\s+interest/i);
    expect(note).toHaveTextContent(/not yet pulled from the portfolio/i);
    expect(note).toHaveTextContent(/projected\s+balances do not subtract that portion/i);
  });

  it('the display-only disclosure also renders under the MC basis (shared paragraph)', () => {
    render(<BalanceProjectionEstimateNote isMcBasisActive />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(/not yet pulled from the portfolio/i);
    expect(note).toHaveTextContent(/projected\s+balances do not subtract that portion/i);
  });

  it('discloses that tax-exempt (muni) interest is modeled as zero', () => {
    render(<BalanceProjectionEstimateNote />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(
      /Tax-exempt \(municipal-bond\) interest is\s+modeled as zero/i,
    );
    expect(note).toHaveTextContent(
      /Social Security\s+provisional income/i,
    );
    expect(note).toHaveTextContent(
      /fraction of your SS benefit is\s+taxable/i,
    );
  });

  it('keeps the muni tax-exempt-interest limitation out of the stress-test modal (surface separation)', async () => {
    const user = userEvent.setup();
    render(<MonteCarloMethodologyModal />);
    await user.click(
      screen.getByRole('button', {
        name: /how is success probability calculated/i,
      }),
    );
    expect(screen.getByRole('dialog').textContent).not.toMatch(
      /municipal-bond/i,
    );
    expect(screen.queryByText(/tax-exempt \(municipal-bond\) interest/i)).toBeNull();
  });

  it('renders body copy at the text-sm page baseline', () => {
    render(<BalanceProjectionEstimateNote />);
    const paragraph = screen.getByRole('note').querySelector('p');
    expect(paragraph).not.toBeNull();
    expect(paragraph).toHaveClass('text-sm');
  });

  it('omits the projected-first-year-MAGI line by default', () => {
    render(<BalanceProjectionEstimateNote />);
    const note = screen.getByRole('note');
    expect(note).not.toHaveTextContent(/First-year Medicare surcharge estimated/i);
  });

  it('renders the projected-first-year-MAGI disclosure when the flag is set', () => {
    render(<BalanceProjectionEstimateNote magiEstimatedFromProjection />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(
      /First-year Medicare surcharge estimated from your projected first-year income/i,
    );
    expect(note).toHaveTextContent(/no historical \(two-years-prior\) MAGI was provided/i);
    const text = screen.getByText(/First-year Medicare surcharge estimated/i);
    expect(text.tagName.toLowerCase()).toBe('p');
  });

  it('states the MC simulation funds tax + reduces its balances under an MC basis', () => {
    render(<BalanceProjectionEstimateNote isMcBasisActive />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(
      /estimated for the simulated run, and the simulation funds them from the portfolio each year, so they reduce its projected balances/i,
    );
    expect(note).not.toHaveTextContent(/not deducted from its projected balances/i);
    expect(note).toHaveTextContent(/only federal income tax/i);
  });

  it('deterministic render keeps the funded clause verbatim', () => {
    render(<BalanceProjectionEstimateNote isMcBasisActive={false} />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(/reduce your projected\s+balances/i);
    expect(note).not.toHaveTextContent(/not deducted from its projected balances/i);
  });

  it('always shows the standard-deduction-only disclosure (blanket, no materiality trigger)', () => {
    render(<BalanceProjectionEstimateNote />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(/Standard deduction only/i);
    expect(note).toHaveTextContent(/never itemized deductions/i);
    expect(note).toHaveTextContent(/alternative minimum tax/i);
    expect(note).toHaveTextContent(/qualified business income/i);
    expect(note).toHaveTextContent(/could be meaningfully lower/i);
    expect(note).toHaveTextContent(/every scenario, whatever your filing choice/i);
  });

  it('the standard-deduction-only disclosure also renders under the MC basis', () => {
    render(<BalanceProjectionEstimateNote isMcBasisActive />);
    expect(screen.getByRole('note')).toHaveTextContent(/Standard deduction only/i);
  });

  it('always discloses the rough ACA benchmark and its assumptions', () => {
    render(<BalanceProjectionEstimateNote />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(/Health coverage costs/i);
    // Assert against the constant the engine prices from, so a recalibration fails this test.
    const { baseMonthlyDollars, baseAge, ageGrowthRate } = ROUGH_BENCHMARK_ASSUMPTIONS;
    expect(note).toHaveTextContent(
      new RegExp(`\\$${baseMonthlyDollars.toLocaleString('en-US')} a month for a\\s+${baseAge}-year-old`, 'i'),
    );
    expect(note).toHaveTextContent(
      new RegExp(`rising\\s+${Math.round(ageGrowthRate * 100)}% for each year\\s+of age`, 'i'),
    );
    expect(note).toHaveTextContent(
      /counted for each covered person and only for the months they are\s+covered/i,
    );
    expect(note).toHaveTextContent(
      new RegExp(
        `From ${ROUGH_BENCHMARK_ASSUMPTIONS.baseYear}, the estimate grows\\s+every year at the scenario.s medical inflation rate`,
        'i',
      ),
    );
    expect(note).toHaveTextContent(/it is used exactly as entered/i);
    expect(note).toHaveTextContent(/not a real quote from your exchange/i);
  });

  it('always discloses that only the Medicare surcharge is modeled', () => {
    render(<BalanceProjectionEstimateNote />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(/only the Medicare\s+income-related surcharge \(IRMAA\)/i);
    expect(note).toHaveTextContent(/base Medicare premium, Medigap/i);
  });

  it('omits the missing-premium readiness warning by default', () => {
    render(<BalanceProjectionEstimateNote />);
    expect(screen.getByRole('note')).not.toHaveTextContent(
      /Medicare premiums are missing/i,
    );
  });

  it('renders the missing-premium readiness warning when the flag is set', () => {
    render(<BalanceProjectionEstimateNote medicareBasePremiumMissing />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(/Medicare premiums are missing/i);
    expect(note).toHaveTextContent(/no\s+medical spending at all/i);
    expect(note).toHaveTextContent(/understates what you will actually\s+pay/i);
    const text = screen.getByText(/Medicare premiums are missing/i);
    expect(text.tagName.toLowerCase()).toBe('strong');
  });

  it('omits the Medicaid paragraph by default', () => {
    render(<BalanceProjectionEstimateNote />);
    expect(screen.getByRole('note')).not.toHaveTextContent(/Medicaid/i);
  });

  it('renders the Medicaid paragraph, with its four points, when the flag is set', () => {
    render(<BalanceProjectionEstimateNote medicaidMayApply />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(/Medicaid may cover your household instead/i);
    expect(note).toHaveTextContent(/Depending on your\s+state/i);
    expect(note).toHaveTextContent(/does not model states or Medicaid/i);
    expect(note).toHaveTextContent(/do not assume Medicaid/i);
    expect(note).toHaveTextContent(/did not expand\s+Medicaid/i);
    expect(note).toHaveTextContent(/estates of people who received it at 55 or older/i);
    const lead = screen.getByText(/Medicaid may apply/i);
    expect(lead.tagName.toLowerCase()).toBe('strong');
  });

  it('has no a11y violations with every disclosure flag set', async () => {
    const { container } = render(
      <BalanceProjectionEstimateNote
        medicareBasePremiumMissing
        medicaidMayApply
        isMcBasisActive
        magiEstimatedFromProjection
      />,
    );
    await expectNoA11yViolations(container);
  });

  it('shows the Add Medicare premiums link only when the base premium is missing', () => {
    const { unmount } = render(<BalanceProjectionEstimateNote />);
    expect(screen.getByRole('note')).toHaveTextContent(
      /Expenses page can add the standard Part B and Part D\s+amounts for you/i,
    );
    expect(screen.queryByRole('link', { name: 'Add Medicare premiums' })).toBeNull();
    unmount();
    render(<BalanceProjectionEstimateNote medicareBasePremiumMissing />);
    expect(screen.getByRole('link', { name: 'Add Medicare premiums' })).toHaveAttribute(
      'href',
      '/expenses?medicarePremiums=1',
    );
  });
});
