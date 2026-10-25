// AccountsPage: empty-state copy and the populated list over IndexedDB.
import 'fake-indexeddb/auto';
import { fireEvent, render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllStores,
  listPendingMutations,
  putAggregate,
} from '../db/store';
import type { Batch } from '../db/store';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  ScenarioPayload,
} from '../db/types';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: vi.fn(() => vi.fn()) };
});

import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { AccountsPage } from './AccountsPage';
import { expectNoA11yViolations } from '../test/a11y';

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

function renderPage() {
  return render(
    <MemoryRouter>
      <AccountsPage />
    </MemoryRouter>,
  );
}

async function seedHousehold(): Promise<void> {
  const member: Aggregate<HouseholdMemberPayload> = {
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
  await putAggregate('householdMember', member);
}

async function seedAccount(
  name: string,
  type: AccountPayload['type'],
  overrides: Partial<AccountPayload> = {},
): Promise<void> {
  const acc: Aggregate<AccountPayload> = {
    id: `acc-${name.toLowerCase().replace(/\s/g, '-')}`,
    householdId: HH,
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name,
      type,
      ownershipType: 'INDIVIDUAL',
      taxTreatment: type === 'BROKERAGE' ? 'POST_TAX' : 'PRE_TAX',
      ownerId: 'hm-1',
      institution: 'Test Bank',
      notes: '',
      planningReturnPct: 7,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      ...overrides,
    },
  };
  await putAggregate('account', acc);
}

// An unflushed `batch` (a bare `new Set()`) writes the row without firing the store's change signal: the shape of a row synced by another tab, which leaves this page's `useAggregates` snapshot stale (see `recordOrNotify` in db/store.ts).
async function seedBalance(
  accountId: string,
  year: number,
  over: Partial<AccountBalancePayload> = {},
  batch?: Batch,
): Promise<void> {
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
      endingBalance: 0,
      endingBalancePreTax: null,
      endingBalancePostTax: null,
      totalContributions: 0,
      comment: null,
      ...over,
    },
  };
  await putAggregate('accountBalance', bal, batch);
}

async function seedIncomeStream(
  id: string,
  name: string,
  payload: Partial<IncomeStreamPayload>,
): Promise<void> {
  const row: Aggregate<IncomeStreamPayload> = {
    id,
    householdId: HH,
    aggregateType: 'incomeStream',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name,
      memberId: 'hm-1',
      kind: 'pension',
      ...payload,
    } as IncomeStreamPayload,
  };
  await putAggregate('incomeStream', row);
}

async function seedScenario(
  id: string,
  name: string,
  income: ScenarioPayload['overrides']['income'],
): Promise<void> {
  const row: Aggregate<ScenarioPayload> = {
    id,
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name,
      description: '',
      parentScenarioId: null,
      isPrimary: false,
      notes: '',
      overrides: { income },
    },
  };
  await putAggregate('scenario', row);
}

async function seedSecondaryMember(): Promise<void> {
  const member: Aggregate<HouseholdMemberPayload> = {
    id: 'hm-2',
    householdId: HH,
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      isPrimary: false,
      firstName: 'Sam',
      lastName: 'Secondary',
      email: 'sam@example.test',
      birthdate: '1986-02-10',
    },
  };
  await putAggregate('householdMember', member);
}

describe('AccountsPage', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders the empty-state when no accounts exist', async () => {
    await clearAllStores();
    await seedHousehold();
    renderPage();
    expect(
      await screen.findByText(/No accounts yet/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add Account/i })).toBeInTheDocument();
  });

  it('renders the accounts table with names when accounts exist', async () => {
    await clearAllStores();
    await seedHousehold();
    await seedAccount('My 401k', 'RETIREMENT_401K');
    await seedAccount('Brokerage', 'BROKERAGE');
    const stored = (await import('../db/store')).listAggregates;
    const rows = await stored('account');
    expect(rows.map((r) => r.id).sort()).toEqual(
      ['acc-brokerage', 'acc-my-401k'].sort(),
    );
    renderPage();
    await waitFor(() => {
      // The generic "Brokerage" string also appears in the type-filter dropdown, so anchor on the row's edit-button aria-label.
      expect(screen.getByLabelText('Delete My 401k')).toBeInTheDocument();
      expect(screen.getByLabelText('Delete Brokerage')).toBeInTheDocument();
    });
  });

  it('Owner filter narrows accounts by Joint / Primary / Secondary', async () => {
    const user = userEvent.setup();
    await clearAllStores();
    await seedHousehold();
    await seedSecondaryMember();
    await seedAccount('Primary 401k', 'RETIREMENT_401K', {
      ownerId: 'hm-1',
      ownershipType: 'INDIVIDUAL',
    });
    await seedAccount('Secondary IRA', 'RETIREMENT_IRA', {
      ownerId: 'hm-2',
      ownershipType: 'INDIVIDUAL',
    });
    await seedAccount('Joint Brokerage', 'BROKERAGE', {
      ownerId: 'hm-1',
      ownershipType: 'JOINT',
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText('Delete Primary 401k')).toBeInTheDocument();
    });
    const ownerSelect = screen.getByLabelText('Owner');

    await user.click(ownerSelect);
    const optionLabels = (await screen.findAllByRole('option')).map(
      (o) => o.textContent,
    );
    expect(optionLabels).toEqual(['All', 'Joint', 'Alex', 'Sam']);
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument(),
    );

    async function selectOwner(name: string): Promise<void> {
      await user.click(ownerSelect);
      await user.click(await screen.findByRole('option', { name }));
    }

    await selectOwner('Alex');
    await waitFor(() => {
      expect(screen.getByLabelText('Delete Primary 401k')).toBeInTheDocument();
      expect(screen.queryByLabelText('Delete Secondary IRA')).toBeNull();
      expect(screen.queryByLabelText('Delete Joint Brokerage')).toBeNull();
    });

    await selectOwner('Sam');
    await waitFor(() => {
      expect(screen.getByLabelText('Delete Secondary IRA')).toBeInTheDocument();
      expect(screen.queryByLabelText('Delete Primary 401k')).toBeNull();
      expect(screen.queryByLabelText('Delete Joint Brokerage')).toBeNull();
    });

    await selectOwner('Joint');
    await waitFor(() => {
      expect(screen.getByLabelText('Delete Joint Brokerage')).toBeInTheDocument();
      expect(screen.queryByLabelText('Delete Primary 401k')).toBeNull();
      expect(screen.queryByLabelText('Delete Secondary IRA')).toBeNull();
    });
  });
});

describe('AccountsPage — React Aria Table + notes indicator', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders accounts inside a React Aria Table grid landmark', async () => {
    await clearAllStores();
    await seedHousehold();
    await seedAccount('Notes 401k', 'RETIREMENT_401K', {
      notes: 'Roll over from old job',
    });
    await seedAccount('Plain Brokerage', 'BROKERAGE', { notes: '' });
    renderPage();
    const grid = await screen.findByRole('grid', {
      name: 'Retirement and savings accounts',
    });
    expect(grid).toBeInTheDocument();
    // Re-query inside waitFor: the grid can resolve carrying only its header row.
    await waitFor(() => {
      expect(within(grid).getAllByRole('row').length).toBeGreaterThanOrEqual(3);
    });
  });

  it('shows the Notes indicator only on accounts with non-empty notes', async () => {
    await clearAllStores();
    await seedHousehold();
    await seedAccount('Notes 401k', 'RETIREMENT_401K', {
      notes: 'Roll over from old job',
    });
    await seedAccount('Plain Brokerage', 'BROKERAGE', { notes: '' });
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Delete Notes 401k')).toBeInTheDocument(),
    );
    const indicators = screen.getAllByRole('img', { name: 'Notes' });
    expect(indicators).toHaveLength(1);
  });

  it('renders in-row interactive controls that are keyboard-focusable', async () => {
    // jsdom cannot synthesize the focus-manager events React Aria Table uses for row arrow-key navigation, so assert that the row's Edit and Delete controls can hold focus.
    await clearAllStores();
    await seedHousehold();
    await seedAccount('Notes 401k', 'RETIREMENT_401K');
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Delete Notes 401k')).toBeInTheDocument(),
    );
    const deleteBtn = screen.getByLabelText('Delete Notes 401k');
    deleteBtn.focus();
    expect(deleteBtn).toHaveFocus();
    const editLink = screen.getByRole('link', { name: 'Edit' });
    editLink.focus();
    expect(editLink).toHaveFocus();
  });

  it('exposes the React Aria Table grid for arrow-key navigation', async () => {
    // jsdom cannot synthesize React Aria's grid focus-delegate events (ArrowDown relies on browser-level focus-manager events), so assert the grid's accessible name and that each row's first focusable control holds focus.
    await clearAllStores();
    await seedHousehold();
    await seedAccount('First 401k', 'RETIREMENT_401K');
    await seedAccount('Second IRA', 'RETIREMENT_IRA');
    renderPage();
    const grid = await screen.findByRole('grid', {
      name: 'Retirement and savings accounts',
    });
    expect(grid).toBeInTheDocument();
    // findBy: the grid resolving does not mean its rows have.
    const firstRowDelete = await screen.findByLabelText('Delete First 401k');
    const secondRowDelete = await screen.findByLabelText('Delete Second IRA');
    firstRowDelete.focus();
    expect(firstRowDelete).toHaveFocus();
    secondRowDelete.focus();
    expect(secondRowDelete).toHaveFocus();
  });
});

describe('AccountsPage — income-linked delete guard', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('blocks deletion when a canonical income stream links the account', async () => {
    await clearAllStores();
    await seedHousehold();
    await seedAccount('Acme CBP', 'RETIREMENT_CASH_BALANCE');
    await seedIncomeStream('inc-1', 'ACME pension', {
      linkedCbpAccountId: 'acc-acme-cbp',
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Delete Acme CBP')).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Delete Acme CBP'));
    });
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Cannot delete "Acme CBP"');
    expect(dialog).toHaveTextContent("It's referenced by 1 income source:");
    expect(dialog).toHaveTextContent('"ACME pension" (Base)');
    expect(
      within(dialog).getByRole('link', { name: /Go to Income/ }),
    ).toHaveAttribute('href', '/income');
    const pending = await listPendingMutations();
    expect(pending.find((p) => p.operation === 'delete')).toBeUndefined();
  });

  it('blocks deletion when only a scenario-embedded stream references it', async () => {
    await clearAllStores();
    await seedHousehold();
    await seedAccount('Windfall Target', 'BROKERAGE');
    await seedScenario('sc-1', 'Early retirement', {
      added: [
        {
          _localId: 'l1',
          name: 'Inheritance',
          memberId: 'hm-1',
          kind: 'oneOff',
          targetAccountId: 'acc-windfall-target',
        },
      ],
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Delete Windfall Target')).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Delete Windfall Target'));
    });
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(
      '"Inheritance" (in scenario "Early retirement")',
    );
    const pending = await listPendingMutations();
    expect(pending.find((p) => p.operation === 'delete')).toBeUndefined();
  });

  it('allows deletion and queues a delete mutation when no income references it', async () => {
    await clearAllStores();
    await seedHousehold();
    await seedAccount('Unlinked 401k', 'RETIREMENT_401K');
    await seedIncomeStream('inc-1', 'Other pension', {
      linkedCbpAccountId: 'acc-some-other-account',
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Delete Unlinked 401k')).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Delete Unlinked 401k'));
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Delete "Unlinked 401k"?');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    });
    await waitFor(async () => {
      const pending = await listPendingMutations();
      const del = pending.find((p) => p.operation === 'delete');
      expect(del).toBeTruthy();
      expect(del!.aggregateId).toBe('acc-unlinked-401k');
    });
    await waitFor(() =>
      expect(screen.queryByLabelText('Delete Unlinked 401k')).toBeNull(),
    );
  });

  it('reads income references at click-time, not page-load (catches a post-render add)', async () => {
    // Seed the linked income stream after render (simulating sync or another tab): the guard re-reads at click time, so the block dialog still appears and no delete mutation queues.
    await clearAllStores();
    await seedHousehold();
    await seedAccount('Late Link CBP', 'RETIREMENT_CASH_BALANCE');
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Delete Late Link CBP')).toBeInTheDocument(),
    );
    await seedIncomeStream('inc-1', 'ACME pension', {
      linkedCbpAccountId: 'acc-late-link-cbp',
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Delete Late Link CBP'));
    });
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Cannot delete "Late Link CBP"');
    expect(dialog).toHaveTextContent('"ACME pension" (Base)');
    const pending = await listPendingMutations();
    expect(pending.find((p) => p.operation === 'delete')).toBeUndefined();
  });

  it('caps the reference list at 20 and shows "+ N more"', async () => {
    await clearAllStores();
    await seedHousehold();
    await seedAccount('Busy CBP', 'RETIREMENT_CASH_BALANCE');
    for (let i = 0; i < 25; i++) {
      await seedIncomeStream(`inc-${i}`, `Pension ${i}`, {
        linkedCbpAccountId: 'acc-busy-cbp',
      });
    }
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Delete Busy CBP')).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Delete Busy CBP'));
    });
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent("It's referenced by 25 income sources:");
    expect(dialog.querySelectorAll('ul li')).toHaveLength(21);
    expect(dialog).toHaveTextContent('+ 5 more');
  });

  it('re-reads on WORKSPACE_CHANGED_EVENT without a remount', async () => {
    await clearAllStores();
    await seedHousehold();
    renderPage();
    expect(await screen.findByText(/No accounts yet/i)).toBeInTheDocument();

    // Simulate the sync layer bulk-filling the store after mount, then dispatching the workspace-change event.
    await seedAccount('My 401k', 'RETIREMENT_401K');
    const { notifyWorkspaceChanged } = await import('../lib/workspace-events');
    await act(async () => {
      notifyWorkspaceChanged();
    });

    await waitFor(() =>
      expect(screen.getByLabelText('Delete My 401k')).toBeInTheDocument(),
    );
  });
});

describe('AccountsPage — pooled tax-free delete warning', () => {
  const WARNING = /can increase the tax-free amount calculated for your other Roth IRAs/;

  beforeEach(async () => {
    setupContexts();
    await clearAllStores();
    await seedHousehold();
    await seedAccount('Keeper Roth', 'RETIREMENT_ROTH_IRA', { taxTreatment: 'ROTH' });
    await seedBalance('acc-keeper-roth', 2020, {
      totalContributions: 50_000,
      endingBalance: 50_000,
    });
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  // Rollover-funded, then zeroed out: its charge against the pool is the sibling's basis, so deleting it hands that basis back.
  async function seedConsumerRoth(): Promise<void> {
    await seedAccount('Consumer Roth', 'RETIREMENT_ROTH_IRA', { taxTreatment: 'ROTH' });
    await seedBalance('acc-consumer-roth', 2020, {
      rollover: 50_000,
      endingBalance: 50_000,
    });
    await seedBalance('acc-consumer-roth', 2021, { startingBalance: 50_000 });
  }

  // Only ever contributed, so removing it lowers the household figure.
  async function seedContributorRoth(): Promise<void> {
    await seedAccount('Contributor Roth', 'RETIREMENT_ROTH_IRA', { taxTreatment: 'ROTH' });
    await seedBalance('acc-contributor-roth', 2020, {
      totalContributions: 10_000,
      endingBalance: 10_000,
    });
  }

  async function confirmBothSteps(): Promise<void> {
    const first = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(within(first).getByRole('button', { name: 'Delete' }));
    });
    const second = await screen.findByRole('alertdialog');
    expect(second).toHaveTextContent('Are you sure?');
    await act(async () => {
      fireEvent.click(within(second).getByRole('button', { name: 'Yes, delete' }));
    });
  }

  it('warns inside the FIRST confirm when the deletion would raise the pooled figure', async () => {
    await seedConsumerRoth();
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Delete Consumer Roth')).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Delete Consumer Roth'));
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('This account has balance data that will also be deleted.');
    expect(dialog).toHaveTextContent(WARNING);
    // The warning has to reach a screen reader with the rest of the message.
    expect(dialog).toHaveAccessibleDescription(WARNING);

    await confirmBothSteps();
    await waitFor(async () => {
      const del = (await listPendingMutations()).find((p) => p.operation === 'delete');
      expect(del).toBeTruthy();
      expect(del!.aggregateId).toBe('acc-consumer-roth');
      expect(del!.expectedVersion).toBe(1);
    });
  });

  it('does not warn when the deletion would NOT raise the pooled figure', async () => {
    await seedContributorRoth();
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Delete Contributor Roth')).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Delete Contributor Roth'));
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('This account has balance data that will also be deleted.');
    expect(dialog).not.toHaveTextContent(WARNING);

    await confirmBothSteps();
    await waitFor(async () => {
      const del = (await listPendingMutations()).find((p) => p.operation === 'delete');
      expect(del).toBeTruthy();
      expect(del!.aggregateId).toBe('acc-contributor-roth');
      expect(del!.expectedVersion).toBe(1);
    });
  });

  it('completes the warned flow by keyboard alone', async () => {
    const user = userEvent.setup();
    // jsdom cannot reproduce the browser's grid focus-manager. React Aria moves DOM focus off the in-cell button onto the row container after `.focus()` returns, in a React effect or, under virtual modality, on the next animation frame.
    // Flush the effect and a frame, then re-focus; nothing re-arms the steal, so Enter reaches the button.
    const pressEnterOn = async (button: HTMLElement) => {
      button.focus();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      });
      button.focus();
      expect(button).toHaveFocus();
      await user.keyboard('{Enter}');
    };
    await seedConsumerRoth();
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Delete Consumer Roth')).toBeInTheDocument(),
    );
    await pressEnterOn(screen.getByLabelText('Delete Consumer Roth'));

    const first = await screen.findByRole('alertdialog');
    expect(first).toHaveAccessibleDescription(WARNING);
    await pressEnterOn(within(first).getByRole('button', { name: 'Delete' }));

    const second = await screen.findByRole('alertdialog');
    await pressEnterOn(within(second).getByRole('button', { name: 'Yes, delete' }));
    await waitFor(async () => {
      const del = (await listPendingMutations()).find((p) => p.operation === 'delete');
      expect(del?.aggregateId).toBe('acc-consumer-roth');
    });
  });

  it('cancels the warned flow on Esc without deleting anything', async () => {
    const user = userEvent.setup();
    await seedConsumerRoth();
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Delete Consumer Roth')).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Delete Consumer Roth'));
    });
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(
      (await listPendingMutations()).find((p) => p.operation === 'delete'),
    ).toBeUndefined();
    expect(screen.getByLabelText('Delete Consumer Roth')).toBeInTheDocument();
  });

  // The pooled tax-free figure counts every Roth IRA a member owns, active or not; the active-only list built for the form modal would break both cases below.
  it('warns when the account that FUNDS the pool is inactive', async () => {
    // With an active-only list the closed sibling disappears and the warning goes silent for the household that most needs it.
    await seedAccount('Keeper Roth', 'RETIREMENT_ROTH_IRA', {
      taxTreatment: 'ROTH',
      active: false,
    });
    await seedConsumerRoth();
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Delete Consumer Roth')).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Delete Consumer Roth'));
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAccessibleDescription(WARNING);
  });

  it('warns when the account BEING DELETED is inactive', async () => {
    // An inactive Roth IRA's outflows are charged against the pool like an active one's; an active-only list would not even contain the account under deletion.
    await seedAccount('Consumer Roth', 'RETIREMENT_ROTH_IRA', {
      taxTreatment: 'ROTH',
      active: false,
    });
    await seedBalance('acc-consumer-roth', 2020, {
      rollover: 50_000,
      endingBalance: 50_000,
    });
    await seedBalance('acc-consumer-roth', 2021, { startingBalance: 50_000 });
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Delete Consumer Roth')).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Delete Consumer Roth'));
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAccessibleDescription(WARNING);
  });
});

// onDelete decides both confirms from click-time reads, not the page-load snapshot: a balance row synced by another tab lands without firing the store signal, so these cases write with the signal suppressed (an unflushed Batch) and fail if onDelete reads the captured arrays.

describe('AccountsPage — delete confirms read balances at click-time, not page-load', () => {
  const WARNING = /can increase the tax-free amount calculated for your other Roth IRAs/;

  beforeEach(async () => {
    setupContexts();
    await clearAllStores();
    await seedHousehold();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('warns off a sibling contribution row that arrived AFTER the page rendered', async () => {
    // At render the keeper Roth has no rows, so the page-load snapshot would warn about nothing; only a click-time re-read sees the figure this delete would raise.
    await seedAccount('Keeper Roth', 'RETIREMENT_ROTH_IRA', { taxTreatment: 'ROTH' });
    await seedAccount('Consumer Roth', 'RETIREMENT_ROTH_IRA', { taxTreatment: 'ROTH' });
    await seedBalance('acc-consumer-roth', 2020, {
      rollover: 50_000,
      endingBalance: 50_000,
    });
    await seedBalance('acc-consumer-roth', 2021, { startingBalance: 50_000 });
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Delete Consumer Roth')).toBeInTheDocument(),
    );
    await seedBalance(
      'acc-keeper-roth',
      2020,
      { totalContributions: 50_000, endingBalance: 50_000 },
      new Set(),
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Delete Consumer Roth'));
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAccessibleDescription(WARNING);
  });

  it("switches to the two-step flow off the account's first row written AFTER render", async () => {
    // No balance rows at render, so the snapshot would show the one-step confirm; the click-time read must route the delete through the two-step flow.
    await seedAccount('Late Rows 401k', 'RETIREMENT_401K');
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Delete Late Rows 401k')).toBeInTheDocument(),
    );
    await seedBalance('acc-late-rows-401k', 2024, { endingBalance: 5_000 }, new Set());
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Delete Late Rows 401k'));
    });
    const first = await screen.findByRole('alertdialog');
    expect(first).toHaveTextContent(
      'This account has balance data that will also be deleted.',
    );
    await act(async () => {
      fireEvent.click(within(first).getByRole('button', { name: 'Delete' }));
    });
    const second = await screen.findByRole('alertdialog');
    expect(second).toHaveTextContent('Are you sure?');
  });
});

describe('AccountsPage — Tax details column', () => {
  beforeEach(async () => {
    await clearAllStores();
    await seedHousehold();
  });

  it('summarises each account tax-detail state and has no accessibility violations', async () => {
    await seedAccount('Roth Full', 'RETIREMENT_ROTH_IRA', {
      taxTreatment: 'ROTH',
      rothIraRegularContributionBasis: 48_000,
      rothIraFirstContributionTaxYear: 2015,
    });
    await seedAccount('Roth Empty', 'RETIREMENT_ROTH_IRA', { taxTreatment: 'ROTH' });
    await seedAccount('Inherited IRA', 'RETIREMENT_IRA', { rmdInheritedAccount: true });
    await seedAccount('Brokerage', 'BROKERAGE');

    const { container } = renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Delete Roth Full')).toBeInTheDocument(),
    );

    // Each badge is paired with a visually hidden sibling naming the account (an `aria-label` on a role-less `<span>` is inert to assistive tech).
    const expectBadge = (spoken: string, visible: string): void => {
      const label = screen.getByText(spoken);
      expect(label).toHaveClass('sr-only');
      expect(label.parentElement).toHaveTextContent(visible);
    };
    expect(screen.queryByText('Roth Empty: tax details incomplete')).not.toBeInTheDocument();
    expectBadge('Inherited IRA: required-withdrawal estimate on hold', 'On hold');
    // A complete account earns no badge: the badge flags outstanding work.
    expect(
      screen.queryByText('Roth Full: tax details recorded'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Brokerage: tax details recorded'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Brokerage: tax details incomplete'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('columnheader', { name: 'Tax details' }),
    ).not.toBeInTheDocument();

    await expectNoA11yViolations(container);
  });
});
