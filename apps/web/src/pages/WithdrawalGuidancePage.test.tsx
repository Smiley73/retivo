/**
 * WithdrawalGuidancePage tests — page wiring: header + method/dollar-basis
 * toggles, the year stepper + jump-to-current control, the no-withdrawal empty
 * state, and an a11y smoke (disclaimer card included).
 *
 * The deterministic projection runs synchronously off `useBalanceProjectionData`
 * once the demo workspace loads, so the tests wait for the page header and then
 * assert the controls. Correctness of the per-year mapping + RMD grouping lives
 * in the pure `withdrawal-guidance-data` / `rmd-aggregation-groups` unit tests.
 */
import 'fake-indexeddb/auto';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAllStores } from '../db/store';
import { loadDemoData } from '../lib/demo-data-loader';
import { withTheme } from '../test/theme-render';
import { expectNoA11yViolations } from '../test/a11y';
import {
  blankPrimaryMemberBirthdate,
  deleteAllHouseholdMembers,
} from '../test/household-test-helpers';
import { WithdrawalGuidancePage, HsaSplitNote, MixedSplitNote } from './WithdrawalGuidancePage';
import type { GuidanceAccountRow } from './withdrawal-guidance-data';

function renderPage(): ReturnType<typeof render> {
  return render(
    withTheme(
      'light',
      <MemoryRouter initialEntries={['/withdrawal-guidance']}>
        <WithdrawalGuidancePage />
      </MemoryRouter>,
    ),
  );
}

async function findHeader(): Promise<HTMLElement> {
  return screen.findByRole(
    'heading',
    { name: 'Projected withdrawals', level: 1 },
    { timeout: 5000 },
  );
}

describe('WithdrawalGuidancePage', () => {
  beforeEach(async () => {
    await clearAllStores();
    window.localStorage.clear();
    await loadDemoData({
      householdId: 'hh-test',
      email: 'demo@example.test',
      displayName: 'Demo User',
    });
  });

  afterEach(async () => {
    await clearAllStores();
    window.localStorage.clear();
  });

  it('renders the page header', async () => {
    const { container } = renderPage();
    expect(await findHeader()).toBeInTheDocument();
    // Let the projection settle before scanning.
    await screen.findByRole('button', { name: 'Jump to current year' });
    await expectNoA11yViolations(container);
  });

  it('renders the return-method and dollar-basis toggles', async () => {
    renderPage();
    await findHeader();
    const method = await screen.findByRole('radiogroup', {
      name: 'Return method',
    });
    expect(within(method).getByRole('radio', { name: 'Planned' })).toBeChecked();
    expect(
      within(method).getByRole('radio', { name: 'Historical' }),
    ).toBeInTheDocument();

    const basis = await screen.findByRole('radiogroup', { name: 'Dollar basis' });
    expect(
      within(basis).getByRole('radio', { name: 'Future dollars' }),
    ).toBeChecked();
    expect(
      within(basis).getByRole('radio', { name: "Today's dollars" }),
    ).toBeInTheDocument();
  });

  it('switches the dollar-basis toggle to today\'s dollars', async () => {
    const user = userEvent.setup();
    renderPage();
    await findHeader();
    const basis = await screen.findByRole('radiogroup', { name: 'Dollar basis' });
    await user.click(
      within(basis).getByRole('radio', { name: "Today's dollars" }),
    );
    await waitFor(() =>
      expect(
        within(basis).getByRole('radio', { name: "Today's dollars" }),
      ).toBeChecked(),
    );
  });

  it('renders the year stepper with a jump-to-current control', async () => {
    renderPage();
    await findHeader();
    // The demo primary is pre-retirement, so the current year shows the
    // no-withdrawal empty state and the stepper is present.
    expect(
      await screen.findByRole('button', { name: 'Previous year' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Next year' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Jump to current year' }),
    ).toBeInTheDocument();
  });

  it('steps forward into a future year and back to the current year', async () => {
    const user = userEvent.setup();
    renderPage();
    await findHeader();
    const next = await screen.findByRole('button', { name: 'Next year' });
    const jump = screen.getByRole('button', { name: 'Jump to current year' });
    // Demo primary is pre-retirement: page opens at the first projected drawdown
    // year (clamped forward from the current calendar year), so the jump button
    // starts enabled (selected year ≠ current year). The forward-clamp runs in a
    // post-projection effect, so await it rather than asserting synchronously.
    await waitFor(() => expect(jump).toBeEnabled());
    await user.click(next);
    await waitFor(() => expect(jump).toBeEnabled());
    await user.click(jump);
    await waitFor(() => expect(jump).toBeDisabled());
  });

  it('shows the standing disclaimer card', async () => {
    renderPage();
    await findHeader();
    expect(
      await screen.findByText(/Illustrative only\. Not financial advice\./i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /not transaction, filing, required-minimum-distribution, Medicare, or ACA instructions/i,
      ),
    ).toBeInTheDocument();
  });

  it('shows the empty state when the scenario has no primary member', async () => {
    // The demo workspace seeds a resolvable primary scenario, so the page gets
    // past its `selectedScenarioId` guard and runs the deterministic engine.
    // Removing every household member makes the runner raise
    // NoPrimaryRetirementError — the page must collapse to the empty-plan card
    // rather than let it escape render and crash to ErrorBoundary.
    await deleteAllHouseholdMembers();
    renderPage();
    await findHeader();
    expect(
      await screen.findByText(/no withdrawal plan to show yet/i),
    ).toBeInTheDocument();
  });

  it('shows the empty state when the primary member has no resolvable retirement date', async () => {
    // The primary member stays in the household, but with a blank birthdate
    // `resolveMemberRetirementDates` can't compute a retirement date for them
    // (retirementDate() throws, caught, folded to null) — the runner raises
    // NoPrimaryRetirementError via the same `!primaryRetIso` branch as the
    // no-primary-member case above. The page must collapse it to the same
    // empty-plan card, not re-throw it to ErrorBoundary.
    await blankPrimaryMemberBirthdate();
    renderPage();
    await findHeader();
    expect(
      await screen.findByText(/no withdrawal plan to show yet/i),
    ).toBeInTheDocument();
  });
});

describe('HsaSplitNote', () => {
  const fmt = (d: number): string => `$${d.toLocaleString('en-US')}`;
  function row(over: Partial<GuidanceAccountRow>): GuidanceAccountRow {
    return {
      accountId: 'hsa', accountName: 'Health Savings', withdrawnDollars: 0,
      endingBalanceDollars: 0, rmdDollars: 0, ...over,
    };
  }
  function renderNote(acc: GuidanceAccountRow): ReturnType<typeof render> {
    return render(withTheme('light', <HsaSplitNote acc={acc} format={fmt} />));
  }

  it('renders both medical + emergency captions when both are present', async () => {
    const { container } = renderNote(
      row({ withdrawnDollars: 5_000, hsaMedicalQualifiedDollars: 3_000, hsaEmergencyReserveDollars: 2_000 }),
    );
    expect(screen.getByText(/\$3,000 for medical costs \(tax-free\)/)).toBeInTheDocument();
    expect(screen.getByText(/\$2,000 as an emergency reserve/)).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('renders only the medical caption when emergency is $0', async () => {
    const { container } = renderNote(
      row({ withdrawnDollars: 3_000, hsaMedicalQualifiedDollars: 3_000, hsaEmergencyReserveDollars: 0 }),
    );
    expect(screen.getByText(/for medical costs/)).toBeInTheDocument();
    expect(screen.queryByText(/emergency reserve/)).not.toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('renders only the emergency caption when medical is $0', async () => {
    const { container } = renderNote(
      row({ withdrawnDollars: 4_000, hsaMedicalQualifiedDollars: 0, hsaEmergencyReserveDollars: 4_000 }),
    );
    expect(screen.getByText(/as an emergency reserve/)).toBeInTheDocument();
    expect(screen.queryByText(/for medical costs/)).not.toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('renders nothing for a non-HSA row (both split fields undefined)', () => {
    const { container } = renderNote(row({ withdrawnDollars: 7_000 }));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('MixedSplitNote', () => {
  const fmt = (d: number): string => `$${d.toLocaleString('en-US')}`;
  function row(over: Partial<GuidanceAccountRow>): GuidanceAccountRow {
    return {
      accountId: 'mix', accountName: 'Mixed 401k', withdrawnDollars: 10_000,
      endingBalanceDollars: 0, rmdDollars: 0, ...over,
    };
  }
  function renderNote(acc: GuidanceAccountRow): ReturnType<typeof render> {
    return render(withTheme('light', <MixedSplitNote acc={acc} format={fmt} />));
  }

  it('renders the pre-tax vs Roth split for a MIXED 401K with named strategy (shows "Roth")', async () => {
    const { container } = renderNote(
      row({
        isMixed: true,
        withdrawnDollars: 10_000,
        preTaxWithdrawnDollars: 6_000,
        postWithdrawnDollars: 4_000,
        postLabel: 'Roth',
      }),
    );
    expect(screen.getByText(/\$6,000 from pre-tax/)).toBeInTheDocument();
    expect(screen.getByText(/\$4,000 from Roth/)).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('renders the pre-tax vs after-tax split for MIXED OTHER with named strategy (shows "after-tax contributions (gains taxable)")', async () => {
    const { container } = renderNote(
      row({
        isMixed: true,
        withdrawnDollars: 8_000,
        preTaxWithdrawnDollars: 5_000,
        postWithdrawnDollars: 3_000,
        postLabel: 'after-tax contributions (gains taxable)',
      }),
    );
    expect(screen.getByText(/\$5,000 from pre-tax/)).toBeInTheDocument();
    expect(screen.getByText(/\$3,000 from after-tax contributions \(gains taxable\)/)).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('renders nothing for a MIXED account without split data', () => {
    const { container } = renderNote(
      row({
        isMixed: true,
        // preTaxWithdrawnDollars undefined → no split data
      }),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for non-MIXED accounts', () => {
    // isMixed absent / false
    const { container } = renderNote(row({ withdrawnDollars: 7_000 }));
    expect(container).toBeEmptyDOMElement();
  });
});
