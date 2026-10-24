// AccountBalancesPage: `parseCurrencyInput` and render coverage over IndexedDB; `findPriorYearEntry` is in the sibling file.
import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCurrencyInput, AccountBalancesPage } from '../pages/AccountBalancesPage';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';
import { clearAllStores, putAggregate } from '../db/store';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));
vi.mock('../sync/mutation-queue', () => ({
  queueLocalMutation: vi.fn(async () => ({}) as never),
}));

import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { queueLocalMutation } from '../sync/mutation-queue';
import { withTheme } from '../test/theme-render';

describe('parseCurrencyInput', () => {
  it('parses plain numbers', () => {
    expect(parseCurrencyInput('10000')).toBe(10000);
    expect(parseCurrencyInput('10000.50')).toBe(10000.5);
  });

  it('strips dollar signs', () => {
    expect(parseCurrencyInput('$10000')).toBe(10000);
    expect(parseCurrencyInput('$10000.50')).toBe(10000.5);
  });

  it('strips thousands-separator commas', () => {
    expect(parseCurrencyInput('10,000')).toBe(10000);
    expect(parseCurrencyInput('1,000,000')).toBe(1000000);
  });

  it('handles dollar sign with commas', () => {
    expect(parseCurrencyInput('$10,000')).toBe(10000);
    expect(parseCurrencyInput('$1,234,567.89')).toBe(1234567.89);
  });

  it('handles negative values', () => {
    expect(parseCurrencyInput('-500')).toBe(-500);
    expect(parseCurrencyInput('-$1,000')).toBe(-1000);
  });

  it('returns null for empty or invalid input', () => {
    expect(parseCurrencyInput('')).toBeNull();
    expect(parseCurrencyInput('$')).toBeNull();
    expect(parseCurrencyInput(',')).toBeNull();
  });
});

const HH = 'hh-test';

function setupContexts() {
  (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    householdId: HH,
    me: { email: 'me@example.test', displayName: 'Me', roles: [], userId: 'u-1' },
    isAuthenticated: true,
  });
  (useSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    notifyPending: vi.fn(),
    state: { kind: 'synced', lastSyncedAt: null },
  });
}

function renderAt(path: string) {
  return render(
    withTheme(
      'light',
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/accounts/:id/balances" element={<AccountBalancesPage />} />
          <Route path="/account-balances" element={<div>list</div>} />
        </Routes>
      </MemoryRouter>,
    ),
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

async function seedAccount(active = true): Promise<void> {
  const acc: Aggregate<AccountPayload> = {
    id: 'acc-1',
    householdId: HH,
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: 'My 401k',
      type: 'RETIREMENT_401K',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'PRE_TAX',
      ownerId: 'hm-1',
      institution: 'Vanguard',
      notes: '',
      planningReturnPct: 7,
      active,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    },
  };
  await putAggregate('account', acc);
}

// A pure designated-Roth employer plan records in-plan rollovers (§402A), not conversions (§408A).
async function seedRothEmployerAccount(): Promise<void> {
  const acc: Aggregate<AccountPayload> = {
    id: 'acc-roth401k',
    householdId: HH,
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: 'My Roth 401k',
      type: 'RETIREMENT_ROTH_401K',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'ROTH',
      ownerId: 'hm-1',
      institution: 'Fidelity',
      notes: '',
      planningReturnPct: 7,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    },
  };
  await putAggregate('account', acc);
}

async function seedRothIraAccount(): Promise<void> {
  const acc: Aggregate<AccountPayload> = {
    id: 'acc-roth',
    householdId: HH,
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: 'My Roth IRA',
      type: 'RETIREMENT_ROTH_IRA',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'ROTH',
      ownerId: 'hm-1',
      institution: 'Vanguard',
      notes: '',
      planningReturnPct: 7,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    },
  };
  await putAggregate('account', acc);
}

async function seedBalance(
  year: number,
  ending: number,
  comment: string | null = null,
): Promise<void> {
  const bal: Aggregate<AccountBalancePayload> = {
    id: `bal-acc-1-${year}`,
    householdId: HH,
    aggregateType: 'accountBalance',
    schemaVersion: 1,
    version: 1,
    updatedAt: `${year}-12-31T00:00:00Z`,
    deviceId: 'dev-1',
    payload: {
      accountId: 'acc-1',
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
      comment,
    },
  };
  await putAggregate('accountBalance', bal);
}

async function seedMixedAccount(): Promise<void> {
  const acc: Aggregate<AccountPayload> = {
    id: 'acc-1',
    householdId: HH,
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: 'My Brokerage',
      type: 'BROKERAGE',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'MIXED',
      ownerId: 'hm-1',
      institution: 'Fidelity',
      notes: '',
      planningReturnPct: 7,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    },
  };
  await putAggregate('account', acc);
}

async function seedMixedBalance(
  year: number,
  preTax: number,
  postTax: number,
): Promise<void> {
  const bal: Aggregate<AccountBalancePayload> = {
    id: `bal-acc-1-${year}`,
    householdId: HH,
    aggregateType: 'accountBalance',
    schemaVersion: 1,
    version: 1,
    updatedAt: `${year}-12-31T00:00:00Z`,
    deviceId: 'dev-1',
    payload: {
      accountId: 'acc-1',
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
      endingBalance: preTax + postTax,
      endingBalancePreTax: preTax,
      endingBalancePostTax: postTax,
      totalContributions: 0,
      comment: null,
    },
  };
  await putAggregate('accountBalance', bal);
}

describe('AccountBalancesPage — Pre-Tax % / Post-Tax % stats', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  // Resolve the value next to a label: `*.0%` also appears in the TWR / Planning-Return stats and the per-year cells.
  function statValueFor(label: string): string {
    const labelEl = screen.getByText(label);
    const value = labelEl.nextElementSibling;
    if (!value) throw new Error(`no value sibling for stat "${label}"`);
    return value.textContent ?? '';
  }

  it('renders the split percentages via formatPercent (one-decimal)', async () => {
    await seedMember();
    await seedMixedAccount();
    await seedMixedBalance(2025, 60000, 40000);
    renderAt('/accounts/acc-1/balances');
    await waitFor(() =>
      expect(screen.getByText('Pre-Tax %')).toBeInTheDocument(),
    );
    expect(statValueFor('Pre-Tax %')).toBe('60.0%');
    expect(statValueFor('Post-Tax %')).toBe('40.0%');
  });

  it('renders 0.0% for both when the total ending balance is zero', async () => {
    await seedMember();
    await seedMixedAccount();
    await seedMixedBalance(2025, 0, 0);
    renderAt('/accounts/acc-1/balances');
    await waitFor(() =>
      expect(screen.getByText('Pre-Tax %')).toBeInTheDocument(),
    );
    expect(statValueFor('Pre-Tax %')).toBe('0.0%');
    expect(statValueFor('Post-Tax %')).toBe('0.0%');
  });
});

describe('AccountBalancesPage — render', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders the empty-state for an account with no balances', async () => {
    await seedMember();
    await seedAccount();
    renderAt('/accounts/acc-1/balances');
    expect(
      await screen.findByText(/No balance entries yet/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Year' })).toBeInTheDocument();
  });

  it('renders the populated balance table when entries exist', async () => {
    await seedMember();
    await seedAccount();
    await seedBalance(2025, 50000);
    renderAt('/accounts/acc-1/balances');
    let grid!: HTMLElement;
    await waitFor(() => {
      grid = screen.getByRole('grid', { name: 'Annual balance entries' });
      // Scoped to the table cell: the SVG chart also paints a "2025" x-axis tick.
      expect(within(grid).getByText('2025')).toBeInTheDocument();
    });
  });

  it('should_not_render_the_removed_Avg_Return_stat', async () => {
    await seedMember();
    await seedAccount();
    await seedBalance(2024, 40000);
    await seedBalance(2025, 50000);
    renderAt('/accounts/acc-1/balances');
    await waitFor(() =>
      expect(screen.getByText('Ann. Return')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Avg Return')).not.toBeInTheDocument();
  });

  it('shows the inactive banner and hides Add Year for inactive accounts', async () => {
    await seedMember();
    await seedAccount(false);
    renderAt('/accounts/acc-1/balances');
    await waitFor(() =>
      expect(screen.getByText(/marked inactive/i)).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Add Year' })).not.toBeInTheDocument();
  });

  it('renders a Notes indicator only on rows whose comment is non-empty', async () => {
    // The NotesIndicator bubble text mounts only on hover/focus, so it is asserted in NotesIndicator.test.tsx.
    await seedMember();
    await seedAccount();
    await seedBalance(2024, 40000, 'Adjusted for late employer match');
    await seedBalance(2025, 50000, null);
    renderAt('/accounts/acc-1/balances');
    await screen.findByRole('grid', { name: 'Annual balance entries' });
    // The indicator mounts with the row body, which can lag the grid landmark under parallel load.
    await waitFor(() =>
      expect(screen.getAllByRole('img', { name: 'Notes' })).toHaveLength(1),
    );
  });
});

describe('AccountBalancesPage — Distributions for all account types', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders the Distributions column for a non-HSA account', async () => {
    await seedMember();
    await seedAccount(); // RETIREMENT_401K (non-HSA)
    await seedBalance(2025, 50000);
    renderAt('/accounts/acc-1/balances');
    const grid = await screen.findByRole('grid', {
      name: 'Annual balance entries',
    });
    expect(
      await within(grid).findByRole('columnheader', { name: 'Distributions' }),
    ).toBeInTheDocument();
  });

  it('shows the Distributions input in the Add modal for a non-HSA account', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedAccount(); // RETIREMENT_401K (non-HSA)
    renderAt('/accounts/acc-1/balances');
    const addBtn = await screen.findByRole('button', { name: 'Add Year' });
    await user.click(addBtn);
    expect(
      await screen.findByLabelText('Distributions'),
    ).toBeInTheDocument();
  });

  it('persists a recorded distribution for a non-HSA account (not forced to 0)', async () => {
    await seedMember();
    await seedAccount(); // RETIREMENT_401K (non-HSA)
    // A recorded withdrawal on a non-HSA account survives save (it was once forced to 0).
    const bal: Aggregate<AccountBalancePayload> = {
      id: 'bal-acc-1-2025',
      householdId: HH,
      aggregateType: 'accountBalance',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2025-12-31T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        accountId: 'acc-1',
        year: 2025,
        lastUpdated: '2025-12-31T23:59:59Z',
        startingBalance: 60000,
        startingBalancePreTax: null,
        startingBalancePostTax: null,
        contributionsPreTax: null,
        contributionsPostTax: null,
        companyContributions: 0,
        companyContributionsPreTax: null,
        companyContributionsPostTax: null,
        rollover: 0,
        distributions: 7000,
        endingBalance: 55000,
        endingBalancePreTax: null,
        endingBalancePostTax: null,
        totalContributions: 0,
        comment: null,
      },
    };
    await putAggregate('accountBalance', bal);
    renderAt('/accounts/acc-1/balances');
    const grid = await screen.findByRole('grid', {
      name: 'Annual balance entries',
    });
    // findBy*, not getBy*: the grid resolving does not mean its ROWS have.
    expect(await within(grid).findByText('$7,000')).toBeInTheDocument();
  });
});

describe('AccountBalancesPage — reactive read layer', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('re-reads on WORKSPACE_CHANGED_EVENT without a remount', async () => {
    await seedMember();
    await seedAccount();
    renderAt('/accounts/acc-1/balances');
    expect(
      await screen.findByText(/No balance entries yet/i),
    ).toBeInTheDocument();

    await seedBalance(2025, 50000);
    const { notifyWorkspaceChanged } = await import('../lib/workspace-events');
    await act(async () => {
      notifyWorkspaceChanged();
    });

    await waitFor(() =>
      expect(
        screen.getByRole('grid', { name: 'Annual balance entries' }),
      ).toBeInTheDocument(),
    );
    expect(
      within(
        screen.getByRole('grid', { name: 'Annual balance entries' }),
      ).getByText('2025'),
    ).toBeInTheDocument();
  });

  it('re-reads on a fine-signal accountBalance write (no coarse event)', async () => {
    await seedMember();
    await seedAccount();
    renderAt('/accounts/acc-1/balances');
    expect(
      await screen.findByText(/No balance entries yet/i),
    ).toBeInTheDocument();

    // A single-row putAggregate fires only the per-store signal, no notifyWorkspaceChanged(); `useAggregates` must still re-read.
    await act(async () => {
      await seedBalance(2025, 50000);
    });

    await waitFor(() =>
      expect(
        screen.getByRole('grid', { name: 'Annual balance entries' }),
      ).toBeInTheDocument(),
    );
  });

  it('surfaces "Account not found" once the stores settle with no matching account', async () => {
    await seedMember();
    await seedAccount();
    renderAt('/accounts/unknown-id/balances');
    expect(
      await screen.findByText('Account not found'),
    ).toBeInTheDocument();
  });
  it('re-adding a previously deleted year updates the tombstone instead of creating over it', async () => {
    // `persist` once resolved the target row with `getAggregate`, which filters tombstones, so re-adding a deleted year queued a create at expectedVersion 0 and regressed the row below the tombstone's version.
    const user = userEvent.setup();
    await seedMember();
    await seedAccount();
    await putAggregate('accountBalance', {
      id: 'bal-acc-1-2024',
      householdId: HH,
      aggregateType: 'accountBalance',
      schemaVersion: 2,
      version: 3,
      updatedAt: '2024-12-31T00:00:00Z',
      deletedAt: '2025-01-02T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        accountId: 'acc-1',
        year: 2024,
        lastUpdated: '2024-12-31T23:59:59Z',
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
        endingBalance: 0,
        endingBalancePreTax: null,
        endingBalancePostTax: null,
        totalContributions: 0,
        comment: null,
      },
    } as unknown as Aggregate<AccountBalancePayload>);

    renderAt('/accounts/acc-1/balances');
    await user.click(await screen.findByRole('button', { name: 'Add Year' }));
    const yearInput = await screen.findByLabelText('Year');
    // Set the year directly: the control is value-bound to `form.year` and ignores an empty string, so clear-then-type would append.
    fireEvent.change(yearInput, { target: { value: '2024' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(queueLocalMutation).toHaveBeenCalled());
    const call = vi.mocked(queueLocalMutation).mock.calls.at(-1)?.[0];
    expect(call?.aggregateId).toBe('bal-acc-1-2024');
    expect(call?.operation).toBe('update');
    expect(call?.expectedVersion).toBe(3);
  });
  it('offers the Roth conversion fields on a Roth IRA and saves both halves', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedRothIraAccount();
    renderAt('/accounts/acc-roth/balances');
    await user.click(await screen.findByRole('button', { name: 'Add Year' }));

    const taxable = await screen.findByLabelText(
      'Roth Conversion (taxable)',
    );
    const nontaxable = screen.getByLabelText(
      'Roth Conversion (after-tax)',
    );
    // Each field is named by its label alone; asserting no description makes re-adding help text a deliberate change.
    expect(taxable).not.toHaveAccessibleDescription();
    expect(nontaxable).not.toHaveAccessibleDescription();
    expect(screen.queryByText(/records the tax history only/i)).toBeNull();

    await user.type(taxable, '1234.56');
    await user.type(nontaxable, '10.01');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(queueLocalMutation).toHaveBeenCalled());
    const payload = vi.mocked(queueLocalMutation).mock.calls.at(-1)?.[0]
      .payload as AccountBalancePayload;
    expect(payload.rothConversionTaxableAmount).toBe(1234.56);
    expect(payload.rothConversionNontaxableAmount).toBe(10.01);
  });

  it('omits the conversion keys entirely when nothing was converted', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedRothIraAccount();
    renderAt('/accounts/acc-roth/balances');
    await user.click(await screen.findByRole('button', { name: 'Add Year' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(queueLocalMutation).toHaveBeenCalled());
    const payload = vi.mocked(queueLocalMutation).mock.calls.at(-1)?.[0]
      .payload as Record<string, unknown>;
    // Absent means nothing recorded, a weaker claim than a stored 0, so a blank field must not persist as 0.
    expect('rothConversionTaxableAmount' in payload).toBe(false);
    expect('rothConversionNontaxableAmount' in payload).toBe(false);
  });

  it('hides the Roth conversion fields on a non-Roth account', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedAccount(); // RETIREMENT_401K
    renderAt('/accounts/acc-1/balances');
    await user.click(await screen.findByRole('button', { name: 'Add Year' }));
    expect(
      screen.queryByLabelText(
        'Roth Conversion (taxable)',
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('Roth Conversion (after-tax)'),
    ).not.toBeInTheDocument();
  });

  it('seeds the stored conversion amounts back into the form when editing a year', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedRothIraAccount();
    await putAggregate('accountBalance', {
      id: 'bal-acc-roth-2025',
      householdId: HH,
      aggregateType: 'accountBalance',
      schemaVersion: 2,
      version: 1,
      updatedAt: '2025-12-31T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        accountId: 'acc-roth',
        year: 2025,
        lastUpdated: '2025-12-31T23:59:59Z',
        startingBalance: 0,
        startingBalancePreTax: null,
        startingBalancePostTax: null,
        contributionsPreTax: null,
        contributionsPostTax: null,
        companyContributions: 0,
        companyContributionsPreTax: null,
        companyContributionsPostTax: null,
        rollover: 5000,
        distributions: 0,
        endingBalance: 5000,
        endingBalancePreTax: null,
        endingBalancePostTax: null,
        totalContributions: 0,
        comment: null,
        rothConversionTaxableAmount: 4000.25,
        rothConversionNontaxableAmount: 999.75,
      },
    } as unknown as Aggregate<AccountBalancePayload>);

    renderAt('/accounts/acc-roth/balances');
    await user.click(await screen.findByRole('button', { name: 'Edit 2025' }));
    expect(
      await screen.findByLabelText(
        'Roth Conversion (taxable)',
      ),
    ).toHaveValue('4000.25');
    expect(
      screen.getByLabelText('Roth Conversion (after-tax)'),
    ).toHaveValue('999.75');
  });

  it('offers the in-plan rollover fields on an employer Roth plan and saves both halves', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedRothEmployerAccount();
    renderAt('/accounts/acc-roth401k/balances');
    await user.click(await screen.findByRole('button', { name: 'Add Year' }));

    const taxable = await screen.findByLabelText('Roth Conversion (taxable)');
    const nontaxable = screen.getByLabelText('Roth Conversion (after-tax)');
    // The labels are shared with the Roth-IRA pair, so the id alone proves this account got the §402A pair, not the §408A one.
    expect(taxable).toHaveAttribute('id', 'balance-roth-rollover-taxable');
    expect(nontaxable).toHaveAttribute('id', 'balance-roth-rollover-nontaxable');
    expect(document.getElementById('balance-roth-conversion-taxable')).toBeNull();
    // No "enter it under Rollover" help: an in-plan rollover stays inside the account, and recording it there would subtract it from the year's gain/loss.
    expect(taxable).not.toHaveAccessibleDescription();
    expect(nontaxable).not.toHaveAccessibleDescription();
    expect(screen.queryByText(/enter the money that moved under rollover/i)).toBeNull();

    const totals = screen.getByRole('complementary', {
      name: 'Totals for this year',
    });
    for (const label of ['Total Starting', 'Total Contributions', 'Total Ending']) {
      expect(within(totals).getByText(label)).toBeInTheDocument();
    }

    await user.type(taxable, '6000.50');
    await user.type(nontaxable, '1000.25');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(queueLocalMutation).toHaveBeenCalled());
    const payload = vi.mocked(queueLocalMutation).mock.calls.at(-1)?.[0]
      .payload as AccountBalancePayload;
    expect(payload.rothInPlanRolloverTaxableAmount).toBe(6000.5);
    expect(payload.rothInPlanRolloverNontaxableAmount).toBe(1000.25);
  });

  it('omits the rollover keys entirely when nothing was moved', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedRothEmployerAccount();
    renderAt('/accounts/acc-roth401k/balances');
    await user.click(await screen.findByRole('button', { name: 'Add Year' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(queueLocalMutation).toHaveBeenCalled());
    const payload = vi.mocked(queueLocalMutation).mock.calls.at(-1)?.[0]
      .payload as Record<string, unknown>;
    expect('rothInPlanRolloverTaxableAmount' in payload).toBe(false);
    expect('rothInPlanRolloverNontaxableAmount' in payload).toBe(false);
  });

  it('keeps the two dated Roth pairs on their own account types', async () => {
    // Roth IRAs take conversions and never rollovers, employer Roth plans the reverse; a swapped predicate shows the wrong pair.
    const user = userEvent.setup();
    await seedMember();
    await seedRothIraAccount();
    renderAt('/accounts/acc-roth/balances');
    await user.click(await screen.findByRole('button', { name: 'Add Year' }));
    // Both pairs read "Roth Conversion (taxable)" / "(after-tax)", so discriminate on the element id or a swapped predicate goes unnoticed.
    expect(await screen.findByLabelText('Roth Conversion (taxable)')).toHaveAttribute(
      'id',
      'balance-roth-conversion-taxable',
    );
    expect(screen.getByLabelText('Roth Conversion (after-tax)')).toHaveAttribute(
      'id',
      'balance-roth-conversion-nontaxable',
    );
    expect(document.getElementById('balance-roth-rollover-taxable')).toBeNull();
    expect(document.getElementById('balance-roth-rollover-nontaxable')).toBeNull();
  });

  it('drops the rollover amounts when the account is no longer an employer Roth plan', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedAccount(); // RETIREMENT_401K, PRE_TAX → no designated-Roth side
    await putAggregate('accountBalance', {
      id: 'bal-acc-1-2025',
      householdId: HH,
      aggregateType: 'accountBalance',
      schemaVersion: 3,
      version: 1,
      updatedAt: '2025-12-31T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        accountId: 'acc-1',
        year: 2025,
        lastUpdated: '2025-12-31T23:59:59Z',
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
        endingBalance: 1000,
        endingBalancePreTax: null,
        endingBalancePostTax: null,
        totalContributions: 0,
        comment: null,
        rothInPlanRolloverTaxableAmount: 6000,
        rothInPlanRolloverNontaxableAmount: 100,
      },
    } as unknown as Aggregate<AccountBalancePayload>);

    renderAt('/accounts/acc-1/balances');
    await user.click(await screen.findByRole('button', { name: 'Edit 2025' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(queueLocalMutation).toHaveBeenCalled());
    const payload = vi.mocked(queueLocalMutation).mock.calls.at(-1)?.[0]
      .payload as Record<string, unknown>;
    expect('rothInPlanRolloverTaxableAmount' in payload).toBe(false);
    expect('rothInPlanRolloverNontaxableAmount' in payload).toBe(false);
  });

  it('drops the conversion amounts when the account is no longer a Roth IRA', async () => {
    // Retyping an account hides the inputs; save must be gated on the same predicate or it re-persists amounts the user can no longer see.
    const user = userEvent.setup();
    await seedMember();
    await seedAccount(); // RETIREMENT_401K
    await putAggregate('accountBalance', {
      id: 'bal-acc-1-2025',
      householdId: HH,
      aggregateType: 'accountBalance',
      schemaVersion: 2,
      version: 1,
      updatedAt: '2025-12-31T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        accountId: 'acc-1',
        year: 2025,
        lastUpdated: '2025-12-31T23:59:59Z',
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
        endingBalance: 1000,
        endingBalancePreTax: null,
        endingBalancePostTax: null,
        totalContributions: 0,
        comment: null,
        rothConversionTaxableAmount: 4000,
        rothConversionNontaxableAmount: 100,
      },
    } as unknown as Aggregate<AccountBalancePayload>);

    renderAt('/accounts/acc-1/balances');
    await user.click(await screen.findByRole('button', { name: 'Edit 2025' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(queueLocalMutation).toHaveBeenCalled());
    const payload = vi.mocked(queueLocalMutation).mock.calls.at(-1)?.[0]
      .payload as Record<string, unknown>;
    expect('rothConversionTaxableAmount' in payload).toBe(false);
    expect('rothConversionNontaxableAmount' in payload).toBe(false);
  });
});
