/**
 * AccountsPage render test.
 *
 * Drives the IndexedDB code paths via fake-indexeddb. Covers the
 * empty-state copy and the populated-list rendering.
 */
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

/** One annual balance row for an account. The two personal split keys are `null`
 *  explicitly — that pair is what distinguishes a flat row from a MIXED one.
 *  Passing an unflushed `batch` (a bare `new Set()`) writes the row WITHOUT
 *  firing the store's change signal — the shape of a row synced by another tab,
 *  which lands in IndexedDB while this page's `useAggregates` snapshot stays
 *  stale (see `recordOrNotify` in db/store.ts). */
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
    // Sanity: both rows are in the store before we render.
    const stored = (await import('../db/store')).listAggregates;
    const rows = await stored('account');
    expect(rows.map((r) => r.id).sort()).toEqual(
      ['acc-brokerage', 'acc-my-401k'].sort(),
    );
    renderPage();
    await waitFor(() => {
      // Account names render as <Link> labels inside the table — the
      // generic "Brokerage" string also appears in the type-filter
      // dropdown, so anchor on the row's edit-button aria-label
      // instead (it's the unambiguous "name" surface).
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
    // The Owner filter is the shared React Aria <Select>;
    // its trigger is the element labelled by the "Owner" <label>.
    const ownerSelect = screen.getByLabelText('Owner');

    // Project rule: prefer member firstName in user-facing copy.
    // Seeded primary is "Alex", secondary is "Sam".
    await user.click(ownerSelect);
    const optionLabels = (await screen.findAllByRole('option')).map(
      (o) => o.textContent,
    );
    expect(optionLabels).toEqual(['All', 'Joint', 'Alex', 'Sam']);
    // Close the listbox opened for the inventory check so each
    // selectOwner() starts from a closed trigger.
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
    // React Aria Table renders role="grid". The aria-label on the
    // <Table> component is the grid's accessible name.
    const grid = await screen.findByRole('grid', {
      name: 'Retirement and savings accounts',
    });
    expect(grid).toBeInTheDocument();
    // Each row carries role="row" (RA Row primitive). Re-query inside waitFor:
    // the grid can resolve carrying only its header row.
    // 1 header row + 2 data rows.
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
    // The NotesIndicator surfaces an SVG with role="img" + aria-label
    // "Notes" — one per row whose notes is non-empty.
    const indicators = screen.getAllByRole('img', { name: 'Notes' });
    expect(indicators).toHaveLength(1);
  });

  it('renders in-row interactive controls that are keyboard-focusable', async () => {
    // RA Table's arrow-key row-navigation keyboard model is exercised
    // by Adobe's upstream tests. In jsdom we cannot reliably synthesize
    // the focus-manager events the grid uses to advance row focus, so
    // we sanity-check that the row's Edit + Delete controls are
    // reachable + can hold focus — confirming the rendered Table is
    // keyboard-reachable.
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
    // The page must support arrow-key row navigation (RA Table keyboard
    // model). RA's grid focus-delegate behavior is brittle to
    // synthesize in jsdom — the actual ArrowDown handler relies on
    // browser-level focus-manager events Adobe's upstream tests exercise
    // in a real DOM. The robust jsdom proxy is: the table's
    // accessible name is queryable via `role="grid"` (so AT can target
    // it) AND its first focusable descendant in each row holds focus
    // — confirming the grid's contract surface is wired correctly.
    // Real-DOM grid arrow nav is covered by a manual
    // walkthrough gate before merge.
    await clearAllStores();
    await seedHousehold();
    await seedAccount('First 401k', 'RETIREMENT_401K');
    await seedAccount('Second IRA', 'RETIREMENT_IRA');
    renderPage();
    const grid = await screen.findByRole('grid', {
      name: 'Retirement and savings accounts',
    });
    expect(grid).toBeInTheDocument();
    // findBy*, not getBy*: the grid resolving does not mean its ROWS have.
    const firstRowDelete = await screen.findByLabelText('Delete First 401k');
    const secondRowDelete = await screen.findByLabelText('Delete Second IRA');
    firstRowDelete.focus();
    expect(firstRowDelete).toHaveFocus();
    // Both rows expose their own focusable descendant — the arrow-key
    // navigation surface (Adobe's grid moves focus between these).
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
    // The no-reference path goes straight to the shared confirm, which
    // is a React Aria alertdialog.
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
    // The reactive read layer must drop the deleted row from the rendered
    // table without a manual reload.
    await waitFor(() =>
      expect(screen.queryByLabelText('Delete Unlinked 401k')).toBeNull(),
    );
  });

  it('reads income references at click-time, not page-load (catches a post-render add)', async () => {
    // Render with no income, THEN seed a linked income stream
    // into IndexedDB (simulating sync / another tab), THEN click
    // Delete. The guard re-reads fresh at click-time, so the block
    // dialog still appears and no delete mutation queues.
    await clearAllStores();
    await seedHousehold();
    await seedAccount('Late Link CBP', 'RETIREMENT_CASH_BALANCE');
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Delete Late Link CBP')).toBeInTheDocument(),
    );
    // Reference added AFTER the page rendered — not in the load snapshot.
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
    // Mounted against an empty workspace: the empty-state copy renders.
    expect(await screen.findByText(/No accounts yet/i)).toBeInTheDocument();

    // Simulate the sync layer bulk-filling the store after the page is
    // already mounted, then dispatching the workspace-change event.
    await seedAccount('My 401k', 'RETIREMENT_401K');
    const { notifyWorkspaceChanged } = await import('../lib/workspace-events');
    await act(async () => {
      notifyWorkspaceChanged();
    });

    // Same page instance (no route change / remount) now shows the row.
    await waitFor(() =>
      expect(screen.getByLabelText('Delete My 401k')).toBeInTheDocument(),
    );
  });
});

// ---------------------------------------------------------------------------
// Deleting a Roth IRA that consumed its owner's pooled tax-free figure
// ---------------------------------------------------------------------------

describe('AccountsPage — pooled tax-free delete warning', () => {
  const WARNING = /can increase the tax-free amount calculated for your other Roth IRAs/;

  beforeEach(async () => {
    setupContexts();
    await clearAllStores();
    await seedHousehold();
    // The sibling that funds the owner's §408A pool: $50k of recorded
    // contributions, no outflow of its own.
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

  /** Rollover-funded, then zeroed out — its charge against the pool is the
   *  sibling's basis, so deleting it hands that basis back to the household. */
  async function seedConsumerRoth(): Promise<void> {
    await seedAccount('Consumer Roth', 'RETIREMENT_ROTH_IRA', { taxTreatment: 'ROTH' });
    await seedBalance('acc-consumer-roth', 2020, {
      rollover: 50_000,
      endingBalance: 50_000,
    });
    await seedBalance('acc-consumer-roth', 2021, { startingBalance: 50_000 });
  }

  /** Same type, same owner, same two-confirm delete flow — but it only ever
   *  contributed, so removing it LOWERS the household figure. */
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
    // The warning has to reach a screen reader with the rest of the message, not
    // as loose text somewhere in the panel.
    expect(dialog).toHaveAccessibleDescription(WARNING);

    // Deletion itself is unchanged: same two confirmations, same mutation.
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
    // jsdom cannot reproduce the browser's grid focus-manager, so each control is
    // focused the way the keyboard tests above do; the assertion is that it
    // holds focus and that Enter activates it. React Aria moves DOM focus off
    // the in-cell button and onto the row container after `.focus()` returns —
    // synchronously in a React effect, or (when the interaction modality is
    // "virtual") on the next animation frame via focusSafely/runAfterTransition.
    // Flush the effect AND a frame so the steal has landed either way, then
    // re-focus; nothing re-arms the steal after that, so Enter deterministically
    // reaches the button.
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
    const { container } = renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Delete Consumer Roth')).toBeInTheDocument(),
    );
    await pressEnterOn(screen.getByLabelText('Delete Consumer Roth'));

    const first = await screen.findByRole('alertdialog');
    expect(first).toHaveAccessibleDescription(WARNING);
    await expectNoA11yViolations(container);
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

  // The pooled tax-free figure counts every Roth IRA a member owns, ACTIVE OR NOT. The page builds an
  // active-only account list for the form modal right beside this call, and
  // substituting it here would break both cases below and no other test —
  // every other account in this file is active.
  it('warns when the account that FUNDS the pool is inactive', async () => {
    // Same money movement as the warned case above, but the sibling whose $50k of
    // contributions the deletion hands back is a closed account. With an
    // active-only list that sibling disappears, the figure is $0 either way, and
    // the warning goes silent for the household that most needs it.
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
    // An inactive Roth IRA's outflows are charged against its owner's pool exactly
    // as an active one's are, so deleting it hands the same charges back. With an
    // active-only list the account under deletion is not even in the set the
    // predicate looks it up in, so the answer is "no warning" by accident.
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

// ---------------------------------------------------------------------------
// onDelete decides BOTH confirms from click-time reads, not the page-load
// snapshot. A balance row synced by another tab lands in IndexedDB without
// firing this page's store signal, so the captured `accounts` / `balances`
// arrays can be stale (see onDelete's comment). A plain post-render
// `seedBalance` cannot reproduce that — `putAggregate` fires the fine signal
// and `useAggregates` re-reads — so these cases write with the signal
// suppressed (an unflushed `Batch`) and fail if onDelete is pointed back at
// the captured arrays.
// ---------------------------------------------------------------------------

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
    // At render the keeper Roth has NO rows, so on the page-load snapshot the
    // owner's pool is $0 with or without the consumer and the deletion warns
    // about nothing. The $50k contribution row lands afterwards with the store
    // signal suppressed; only a click-time re-read can see the household
    // figure this irreversible delete would raise.
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
    // No balance rows at render, so the snapshot says "no balance data" and
    // the one-step confirm would show. The account's first row lands after
    // render with the signal suppressed; the click-time read must route the
    // delete through the two-step balance-data flow instead.
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

// ---------------------------------------------------------------------------
// Tax details column
// ---------------------------------------------------------------------------

describe('AccountsPage — Tax details column', () => {
  beforeEach(async () => {
    await clearAllStores();
    await seedHousehold();
  });

  it('summarises each account tax-detail state and has no accessibility violations', async () => {
    // Complete: every fact this type needs is recorded.
    await seedAccount('Roth Full', 'RETIREMENT_ROTH_IRA', {
      taxTreatment: 'ROTH',
      rothIraRegularContributionBasis: 48_000,
      rothIraFirstContributionTaxYear: 2015,
    });
    // Partial: a Roth IRA with nothing recorded → cautious defaults in use.
    await seedAccount('Roth Empty', 'RETIREMENT_ROTH_IRA', { taxTreatment: 'ROTH' });
    // Blocked: inherited with no beneficiary facts → estimate withheld.
    await seedAccount('Inherited IRA', 'RETIREMENT_IRA', { rmdInheritedAccount: true });
    // Not applicable: no Roth / required-withdrawal facts exist for this type.
    await seedAccount('Brokerage', 'BROKERAGE');

    const { container } = renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText('Delete Roth Full')).toBeInTheDocument(),
    );

    // Each badge is paired with a VISUALLY-HIDDEN sibling naming the account (an
    // `aria-label` on a role-less `<span>` would be inert to assistive tech), and the
    // visible badge sits in the same cell.
    const expectBadge = (spoken: string, visible: string): void => {
      const label = screen.getByText(spoken);
      expect(label).toHaveClass('sr-only');
      expect(label.parentElement).toHaveTextContent(visible);
    };
    expect(screen.queryByText('Roth Empty: tax details incomplete')).not.toBeInTheDocument();
    expectBadge('Inherited IRA: required-withdrawal estimate on hold', 'On hold');
    // A COMPLETE account earns no badge — the badge flags outstanding work, so a
    // fully-recorded row stays clean rather than showing a redundant "Recorded".
    expect(
      screen.queryByText('Roth Full: tax details recorded'),
    ).not.toBeInTheDocument();
    // The brokerage row carries no badge either (nothing to record).
    expect(
      screen.queryByText('Brokerage: tax details recorded'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Brokerage: tax details incomplete'),
    ).not.toBeInTheDocument();
    // The dedicated column is gone; the badge now sits beside the account name.
    expect(
      screen.queryByRole('columnheader', { name: 'Tax details' }),
    ).not.toBeInTheDocument();

    await expectNoA11yViolations(container);
  });
});
