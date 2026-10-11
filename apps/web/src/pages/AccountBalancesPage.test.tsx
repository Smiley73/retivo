/**
 * AccountBalancesPage tests — `parseCurrencyInput` utility + render coverage.
 *
 * Render tests drive the IndexedDB code paths: empty state, populated table,
 * inactive-account banner, Pre-Tax/Post-Tax % stats, NotesIndicator row marker.
 * `findPriorYearEntry` helper unit tests live in the sibling file
 * `AccountBalancesPage.findPriorYearEntry.test.tsx`.
 */
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
  // AccountHistoryCharts (lazy) reads useChartColors() → needs a
  // ThemeProvider ancestor, as the real app shell provides.
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

/** A pure designated-Roth employer plan — the type that records IN-PLAN ROLLOVERS
 *  (§402A) rather than conversions (§408A). */
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

  // The Stat tile renders <label div> immediately followed by a
  // <value div> sibling. Resolve the value next to a given label so
  // the assertion can't collide with the TWR / Planning-Return stats
  // or the per-year table cells (which also render `*.0%`).
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
    // Both collapse to the old '0.0' fallback, now produced by
    // formatPercent(0) === '0.0%' (the numeric-migration guard).
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
      // Scope to the table cell — the SVG chart engine also paints a
      // "2025" x-axis tick label, so a document-wide text
      // query would match more than one node.
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
    // NotesIndicator was added to annual balance rows. Asserts
    // one indicator renders when one row has a comment and another has
    // null — the 2024 row carries the icon; the 2025 row renders nothing.
    // The bubble text only mounts on hover/focus (React Aria Tooltip),
    // so the bubble-text assertion lives in the indicator's own unit
    // test (NotesIndicator.test.tsx).
    await seedMember();
    await seedAccount();
    await seedBalance(2024, 40000, 'Adjusted for late employer match');
    await seedBalance(2025, 50000, null);
    renderAt('/accounts/acc-1/balances');
    await screen.findByRole('grid', { name: 'Annual balance entries' });
    // The Notes indicator mounts with the row body, which can lag the grid
    // landmark under parallel load; poll until exactly one indicator renders.
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
    // The MoneyInput renders a labelled control named "Distributions".
    expect(
      await screen.findByLabelText('Distributions'),
    ).toBeInTheDocument();
  });

  it('persists a recorded distribution for a non-HSA account (not forced to 0)', async () => {
    await seedMember();
    await seedAccount(); // RETIREMENT_401K (non-HSA)
    // A recorded withdrawal on a non-HSA account survives + renders in the
    // Distributions column (previously forced to 0 on save).
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
    // Mounted against an account with no balances: empty-state copy renders.
    expect(
      await screen.findByText(/No balance entries yet/i),
    ).toBeInTheDocument();

    // Simulate a bulk fill (sync bootstrap / demo load) landing after mount,
    // then dispatching the coarse workspace-change event.
    await seedBalance(2025, 50000);
    const { notifyWorkspaceChanged } = await import('../lib/workspace-events');
    await act(async () => {
      notifyWorkspaceChanged();
    });

    // Same page instance (no route change) now shows the balance row.
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

    // Single-row write via putAggregate fires only the per-store fine
    // signal — no notifyWorkspaceChanged(). The `useAggregates('accountBalance')`
    // subscription must still re-read.
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
    // The reactive refactor derives `notFound` as
    // `ready && id !== undefined && account === null`. Seed a real
    // member + account, then navigate to a DIFFERENT account id: the
    // settled read finds no matching account and shows the error.
    await seedMember();
    await seedAccount();
    renderAt('/accounts/unknown-id/balances');
    expect(
      await screen.findByText('Account not found'),
    ).toBeInTheDocument();
  });
  it('re-adding a previously deleted year updates the tombstone instead of creating over it', async () => {
    // Regression: `persist` resolved the target row with `getAggregate`, which
    // filters tombstones (store.ts), so re-adding a deleted year queued a
    // `create` at expectedVersion 0. The local optimistic write then landed the
    // row back at version 1, regressing it below the tombstone's version and
    // making the next edit queue against a version the server never had.
    const user = userEvent.setup();
    await seedMember();
    await seedAccount();
    // A tombstoned 2024 row at version 3 — the shape left behind by a delete.
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
    // Set the year directly: this control is value-bound to `form.year` and its
    // onChange ignores an empty string, so `clear`-then-type appends to the
    // prefilled year instead of replacing it.
    fireEvent.change(yearInput, { target: { value: '2024' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(queueLocalMutation).toHaveBeenCalled());
    const call = vi.mocked(queueLocalMutation).mock.calls.at(-1)?.[0];
    expect(call?.aggregateId).toBe('bal-acc-1-2024');
    // The tombstone is a real row at version 3: this is an update that
    // continues its lineage, never a create at 0.
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
    // The per-field help text was REMOVED at the owner's request (2026-08-05): it
    // repeated under both halves and was the largest contributor to the dialog's
    // height. Each field is identified by its label alone now. Asserted rather
    // than dropped so re-adding it — or leaving an orphaned paragraph the label
    // no longer points at — is a deliberate change, not a silent one.
    expect(taxable).not.toHaveAccessibleDescription();
    expect(nontaxable).not.toHaveAccessibleDescription();
    expect(screen.queryByText(/records the tax history only/i)).toBeNull();

    await user.type(taxable, '1234.56');
    await user.type(nontaxable, '10.01');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(queueLocalMutation).toHaveBeenCalled());
    const payload = vi.mocked(queueLocalMutation).mock.calls.at(-1)?.[0]
      .payload as AccountBalancePayload;
    // Cents survive: these are dollars-with-cents like every other money field.
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
    // Sparse-optional: absent means nothing recorded, which is a weaker claim
    // than a stored 0, so a blank field must not persist as 0.
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
    // The mirror of the id check in "keeps the two dated Roth pairs on their own
    // account types": the labels are shared with the Roth-IRA pair, so the id is
    // the only thing proving THIS account got the §402A pair and not the §408A one.
    expect(taxable).toHaveAttribute('id', 'balance-roth-rollover-taxable');
    expect(nontaxable).toHaveAttribute('id', 'balance-roth-rollover-nontaxable');
    expect(document.getElementById('balance-roth-conversion-taxable')).toBeNull();
    // Help text removed here too (see the conversion test above). The
    // "enter it under Rollover" instruction must stay absent for this pair
    // whatever else changes: an in-plan rollover stays inside the account, and
    // recording it under Rollover would subtract it from the year's computed
    // gain/loss.
    expect(taxable).not.toHaveAccessibleDescription();
    expect(nontaxable).not.toHaveAccessibleDescription();
    expect(screen.queryByText(/enter the money that moved under rollover/i)).toBeNull();

    // The three roll-up totals moved out of a full-width band under the amount
    // fields into their own right-hand rail (2026-08-05), and were computed
    // inline in two separate branches before that. Nothing covered them, so a
    // rail that silently failed to render would not have been caught.
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
    // A Roth IRA takes conversions and never rollovers; an employer Roth plan the
    // reverse. Swapping the two predicates on the persist path would show the
    // wrong pair here.
    const user = userEvent.setup();
    await seedMember();
    await seedRothIraAccount();
    renderAt('/accounts/acc-roth/balances');
    await user.click(await screen.findByRole('button', { name: 'Add Year' }));
    // Both pairs now read "Roth Conversion (taxable)" / "(after-tax)" — they are
    // the same action from the same two money sources, and no account type shows
    // both — so the LABEL can no longer tell them apart. Discriminate on the
    // element id, which stays distinct, or this test silently stops proving
    // anything: a swapped predicate would render the rollover pair under an
    // identical label and still pass a label-based assertion.
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
    // Retyping an account hides the inputs. Without gating the save on the same
    // predicate, an edit would silently re-persist amounts the user can no
    // longer see or clear.
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
