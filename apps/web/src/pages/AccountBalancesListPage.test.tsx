/**
 * AccountBalancesListPage render tests.
 *
 * Drives IndexedDB through fake-indexeddb and asserts the empty,
 * populated, and inactive-row paths. Computation correctness is
 * covered by `lib/balance-calc.test.ts`; this file only checks that
 * the page wires the store reads through to the rendered table.
 */
import 'fake-indexeddb/auto';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAllStores, putAggregate } from '../db/store';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';
import { ThemeProvider } from '../contexts/ThemeContext';
import { AccountBalancesListPage } from './AccountBalancesListPage';

const HH = 'hh-test';

function renderPage() {
  // ThemeProvider: the bottom "Account balances over time" chart (rendered
  // when ≥ 2 distinct balance years exist) reads the theme-reactive chart
  // tokens, so the page needs a theme context.
  return render(
    <ThemeProvider>
      <MemoryRouter>
        <AccountBalancesListPage />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

async function seedMember(): Promise<void> {
  const m: Aggregate<HouseholdMemberPayload> = {
    id: 'hm-1',
    householdId: HH,
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      isPrimary: true,
      firstName: 'Alex',
      lastName: 'Primary',
      email: 'alex@example.test',
      birthdate: '1985-04-15',
    },
  };
  await putAggregate('householdMember', m);
}

async function seedAccount(
  id: string,
  name: string,
  active = true,
  notes = '',
): Promise<void> {
  const acc: Aggregate<AccountPayload> = {
    id,
    householdId: HH,
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name,
      type: 'RETIREMENT_401K',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'PRE_TAX',
      ownerId: 'hm-1',
      institution: 'Test Bank',
      notes,
      planningReturnPct: 7,
      active,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    },
  };
  await putAggregate('account', acc);
}

async function seedBalance(accountId: string, year: number, ending: number): Promise<void> {
  const bal: Aggregate<AccountBalancePayload> = {
    id: `bal-${accountId}-${year}`,
    householdId: HH,
    aggregateType: 'accountBalance',
    schemaVersion: 1,
    version: 1,
    updatedAt: `${year}-12-31T00:00:00Z`,
    deviceId: 'dev-1',
    payload: {
      accountId,
      year,
      lastUpdated: `${year}-12-31T23:59:59Z`,
      startingBalance: 0,
      startingBalancePreTax: null,
      startingBalancePostTax: null,
      contributionsPreTax: null,
      contributionsPostTax: null,
      companyContributions: 0,
      companyContributionsPreTax: null,
      companyContributionsPostTax: null,
      rollover: 0,
      distributions: 0,
      endingBalance: ending,
      endingBalancePreTax: null,
      endingBalancePostTax: null,
      totalContributions: 0,
      comment: null,
    },
  };
  await putAggregate('accountBalance', bal);
}

describe('AccountBalancesListPage', () => {
  afterEach(async () => {
    await clearAllStores();
  });

  it('renders the empty-state when no accounts exist', async () => {
    await seedMember();
    renderPage();
    expect(await screen.findByText(/No accounts yet/i)).toBeInTheDocument();
  });

  it('renders one row per account with Edit affordance', async () => {
    await seedMember();
    await seedAccount('acc-1', 'My 401k');
    await seedBalance('acc-1', 2025, 50000);
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Edit balances for My 401k')).toBeInTheDocument(),
    );
    expect(screen.getByText('My 401k')).toBeInTheDocument();
  });

  it('should_not_render_the_removed_Avg_Return_stat', async () => {
    await seedMember();
    await seedAccount('acc-1', 'My 401k');
    await seedBalance('acc-1', 2024, 40000);
    await seedBalance('acc-1', 2025, 50000);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('Ann. Return')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Avg Return')).not.toBeInTheDocument();
  });

  it('shows the eight-tile KPI grid, with $0 for an empty tax bucket', async () => {
    await seedMember();
    // Default seeded account is PRE_TAX, so the post-tax bucket is empty.
    await seedAccount('acc-1', 'My 401k');
    await seedBalance('acc-1', 2025, 50000);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('Tax-Deferred Balance')).toBeInTheDocument(),
    );
    // The Graphite Spectrum mock pins the portfolio summary to exactly eight
    // KPI tiles in a 2×4 grid. Scope the lookups to the KPI grid — "Current
    // Balance" also appears as a table column header, so an unscoped getByText
    // would match multiple elements.
    // Each KPI label now carries an info-(i) tooltip, so the label text sits a
    // couple of spans deep; climb to the stable `Portfolio summary` wrapper
    // rather than counting parentElement hops.
    const kpiGrid = screen
      .getByText('Tax-Deferred Balance')
      .closest('[aria-label="Portfolio summary"]') as HTMLElement;
    for (const label of [
      'Current Balance',
      'Tax-Deferred Balance',
      'Tax-Deferred %',
      'Taxable Balance',
      'Taxable %',
      'Contributions',
      'Gain/Loss',
      'Ann. Return',
    ]) {
      expect(within(kpiGrid).getByText(label)).toBeInTheDocument();
    }
    // The granular contribution + distribution tiles were trimmed to match
    // the mock's eight-tile grid.
    for (const removed of [
      'Company Contributions',
      'Pre-Tax Contributions',
      'Post-Tax Contributions',
      'Distributions',
    ]) {
      expect(screen.queryByText(removed)).not.toBeInTheDocument();
    }
    // PRE_TAX account → all balance lands in the tax-deferred bucket, taxable reads $0.
    const postTaxCard = screen
      .getByText('Taxable Balance')
      .closest('.bg-surface-raised') as HTMLElement;
    expect(within(postTaxCard).getByText('$0')).toBeInTheDocument();
  });

  it('wraps each KPI label in a focusable info-(i) tooltip trigger', async () => {
    await seedMember();
    await seedAccount('acc-1', 'My 401k');
    await seedBalance('acc-1', 2025, 50000);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('Tax-Free %')).toBeInTheDocument(),
    );
    // Every summary label gets an info-(i) tooltip so a user can hover/focus
    // for a plain-English description. The tooltip anchor is keyboard-focusable
    // (tabIndex 0) and carries the `cursor-help` affordance.
    for (const label of [
      'Contributions',
      'Tax-Deferred %',
      'Taxable %',
      'Tax-Free %',
    ]) {
      const trigger = screen.getByText(label).closest('[tabindex="0"]');
      expect(trigger).not.toBeNull();
      expect(trigger).toHaveClass('cursor-help');
    }
  });

  it('renders a per-account TWR column', async () => {
    await seedMember();
    await seedAccount('acc-1', 'My 401k');
    await seedBalance('acc-1', 2024, 40000);
    await seedBalance('acc-1', 2025, 50000);
    renderPage();
    const grid = await screen.findByRole('grid', {
      name: 'Household account balances',
    });
    // The header row can mount a tick after the grid landmark under parallel
    // load; `findByRole` retries until the columnheader is present.
    expect(
      await within(grid).findByRole('columnheader', { name: 'Historical' }),
    ).toBeInTheDocument();
  });

  it('renders inactive accounts with the View affordance and footnote', async () => {
    await seedMember();
    await seedAccount('acc-1', 'Old 401k', false);
    await seedBalance('acc-1', 2025, 0);
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('View balances for Old 401k')).toBeInTheDocument(),
    );
    expect(screen.getAllByText(/Inactive/i).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/Totals include data from inactive accounts/i),
    ).toBeInTheDocument();
  });

  it('renders accounts inside a React Aria Table grid landmark', async () => {
    await seedMember();
    await seedAccount('acc-1', 'My 401k', true, 'Roll over from old job');
    await seedAccount('acc-2', 'Plain Brokerage', true, '');
    await seedBalance('acc-1', 2025, 50000);
    await seedBalance('acc-2', 2025, 10000);
    renderPage();
    const grid = await screen.findByRole('grid', {
      name: 'Household account balances',
    });
    expect(grid).toBeInTheDocument();
    // findAll (retrying): the React Aria grid mounts before the IDB rows
    // land, so a synchronous getAll races the row population on slow
    // (instrumented CI) runs.
    const rows = await within(grid).findAllByRole('row');
    // 1 header + 2 data rows.
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it('shows the Notes indicator only on accounts with non-empty notes', async () => {
    await seedMember();
    await seedAccount('acc-1', 'My 401k', true, 'Roll over from old job');
    await seedAccount('acc-2', 'Plain Brokerage', true, '');
    await seedBalance('acc-1', 2025, 50000);
    await seedBalance('acc-2', 2025, 10000);
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Edit balances for My 401k')).toBeInTheDocument(),
    );
    const indicators = screen.getAllByRole('img', { name: 'Notes' });
    expect(indicators).toHaveLength(1);
  });

  it('renders the in-row Edit control as keyboard-focusable', async () => {
    // RA Table arrow-key keyboard model exercised by Adobe upstream;
    // here we sanity-check that an in-row Edit button can hold focus.
    await seedMember();
    await seedAccount('acc-1', 'My 401k');
    await seedBalance('acc-1', 2025, 50000);
    renderPage();
    const editBtn = await screen.findByLabelText('Edit balances for My 401k');
    editBtn.focus();
    expect(editBtn).toHaveFocus();
  });

  it('exposes the React Aria Table grid for arrow-key navigation across rows', async () => {
    // jsdom can't reliably synthesize RA Table's focus-manager
    // events for grid ArrowUp/ArrowDown; the robust jsdom assertion is
    // that the grid's accessible name is queryable AND each row's
    // focusable descendant can independently hold focus — the surface
    // arrow-key navigation moves between. Real-DOM grid arrow nav is
    // covered by Adobe's upstream tests + a manual keyboard walkthrough
    // (Chromium / Firefox / Safari arrow keys + Home / End + typeahead)
    // before merge.
    await seedMember();
    await seedAccount('acc-1', 'First 401k');
    await seedAccount('acc-2', 'Second IRA');
    await seedBalance('acc-1', 2025, 50000);
    await seedBalance('acc-2', 2025, 25000);
    renderPage();
    const grid = await screen.findByRole('grid', {
      name: 'Household account balances',
    });
    expect(grid).toBeInTheDocument();
    // The per-row Edit controls mount a tick after the grid landmark under
    // parallel load; `findByLabelText` retries until both rows are present.
    const firstRowEdit = await screen.findByLabelText(
      'Edit balances for First 401k',
    );
    const secondRowEdit = await screen.findByLabelText(
      'Edit balances for Second IRA',
    );
    firstRowEdit.focus();
    expect(firstRowEdit).toHaveFocus();
    secondRowEdit.focus();
    expect(secondRowEdit).toHaveFocus();
  });

  it('renders Account balances over time chart when ≥ 2 distinct balance years', async () => {
    await seedMember();
    await seedAccount('acc-1', 'My 401k');
    await seedBalance('acc-1', 2024, 100_000);
    await seedBalance('acc-1', 2025, 110_000);
    renderPage();
    expect(
      await screen.findByRole('heading', { name: 'Account balances over time' }),
    ).toBeInTheDocument();
  });

  it('omits Account balances over time chart when < 2 distinct balance years', async () => {
    await seedMember();
    await seedAccount('acc-1', 'My 401k');
    await seedBalance('acc-1', 2025, 100_000);
    renderPage();
    // Wait for the page to fully mount (row renders, which means IDB loaded)
    await screen.findByLabelText('Edit balances for My 401k');
    expect(
      screen.queryByRole('heading', { name: 'Account balances over time' }),
    ).not.toBeInTheDocument();
  });

  it('re-derives on a fine store signal alone (putAggregate, no coarse event)', async () => {
    await seedMember();
    renderPage();
    expect(await screen.findByText(/No accounts yet/i)).toBeInTheDocument();

    // A single-row write fires only the per-store fine signal — no
    // notifyWorkspaceChanged() — proving the useAggregates subscription wakes.
    await act(async () => {
      await seedAccount('acc-1', 'My 401k');
      await seedBalance('acc-1', 2025, 50000);
    });

    await waitFor(() =>
      expect(
        screen.getByLabelText('Edit balances for My 401k'),
      ).toBeInTheDocument(),
    );
  });
});
