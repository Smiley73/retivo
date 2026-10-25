// Page-level wiring of the store reads into the balances table; calculation correctness lives in `lib/balance-calc.test.ts`.
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
    await seedAccount('acc-1', 'My 401k');
    await seedBalance('acc-1', 2025, 50000);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('Tax-Deferred Balance')).toBeInTheDocument(),
    );
    // Scoped to the KPI grid: "Current Balance" is also a table column header.
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
    for (const removed of [
      'Company Contributions',
      'Pre-Tax Contributions',
      'Post-Tax Contributions',
      'Distributions',
    ]) {
      expect(screen.queryByText(removed)).not.toBeInTheDocument();
    }
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
    // The header row can mount a tick after the grid landmark under parallel load.
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
    // findAll retries: the React Aria grid mounts before its IDB rows land.
    const rows = await within(grid).findAllByRole('row');
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
    await seedMember();
    await seedAccount('acc-1', 'My 401k');
    await seedBalance('acc-1', 2025, 50000);
    renderPage();
    const editBtn = await screen.findByLabelText('Edit balances for My 401k');
    editBtn.focus();
    expect(editBtn).toHaveFocus();
  });

  it('exposes the React Aria Table grid for arrow-key navigation across rows', async () => {
    // jsdom cannot synthesize React Aria Table focus-manager arrow-key events, so assert that each row's control can hold focus.
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
    // The Edit controls mount a tick after the grid landmark under parallel load.
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
    await screen.findByLabelText('Edit balances for My 401k');
    expect(
      screen.queryByRole('heading', { name: 'Account balances over time' }),
    ).not.toBeInTheDocument();
  });

  it('re-derives on a fine store signal alone (putAggregate, no coarse event)', async () => {
    await seedMember();
    renderPage();
    expect(await screen.findByText(/No accounts yet/i)).toBeInTheDocument();

    // A single-row write fires only the per-store signal, no notifyWorkspaceChanged(); the useAggregates subscription must still wake.
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
