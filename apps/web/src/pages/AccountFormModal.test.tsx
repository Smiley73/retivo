/**
 * AccountFormModal render tests.
 *
 * Drives IndexedDB through fake-indexeddb. Covers create-mode form
 * rendering, the type-driven tax-treatment lock, and the
 * ACCOUNT_NOT_ZEROED guard on inactivation.
 */
import 'fake-indexeddb/auto';
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllStores,
  getAggregate,
  getStoreVersion,
  listAggregates,
  listPendingMutations,
  putAggregate,
} from '../db/store';
import { expectNoA11yViolations } from '../test/a11y';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  IncomeStreamPayload,
} from '../db/types';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));

// Hoisted gate on every `listAggregates('accountBalance', …)` read — the
// retype-block's open-time, pick-time and retry reads all go through
// it. `null` (the default)
// leaves every read untouched; a test parks a read on a promise it resolves
// by hand, so a second type choice (or a fresh render) is guaranteed to land
// while an earlier read's check is still out. The gate is applied AFTER the
// real read so that releasing it settles the check in microtasks alone.
// `failBalanceRead` rejects the read instead — the seam the read-failure
// abort tests inject through (a flag rather than a stored rejected promise,
// so no unhandled-rejection fires before the read consumes it). Wrapped in
// `vi.fn` so a test can also assert it was (or wasn't) called at all — see
// "create mode takes no balance read on open". The save-time TRANSACTIONAL
// read (`writeAccountWithRetypeGuard`, `db/store.ts`) does its own raw IDB
// `getAll` and is NOT covered by this mock — the save-time tests inject
// through `IDBObjectStore.prototype.getAll` directly.
const retypeReadGate = vi.hoisted<{
  balanceRead: Promise<void> | null;
  failBalanceRead: boolean;
}>(() => ({
  balanceRead: null,
  failBalanceRead: false,
}));
vi.mock('../db/store', async () => {
  const actual = await vi.importActual<typeof import('../db/store')>('../db/store');
  return {
    ...actual,
    listAggregates: vi.fn(async (...args: Parameters<typeof actual.listAggregates>) => {
      if (args[0] === 'accountBalance' && retypeReadGate.failBalanceRead) {
        throw new Error('injected balance read failure');
      }
      const rows = await actual.listAggregates(...args);
      if (args[0] === 'accountBalance' && retypeReadGate.balanceRead !== null) {
        await retypeReadGate.balanceRead;
      }
      return rows;
    }),
  };
});

// queueLocalMutation defaults to the real implementation (the happy-path
// tests below queue against the real store); the partial-failure test
// overrides it per-call via mockImplementationOnce to force the seed write to
// reject after the account write succeeds. queueGuardedAccountUpdate (the
// edit-mode account save) is wrapped the same way so
// a test can inspect the payload it built without a second seam.
vi.mock('../sync/mutation-queue', async () => {
  const actual =
    await vi.importActual<typeof import('../sync/mutation-queue')>(
      '../sync/mutation-queue',
    );
  return {
    ...actual,
    queueLocalMutation: vi.fn(actual.queueLocalMutation),
    queueGuardedAccountUpdate: vi.fn(actual.queueGuardedAccountUpdate),
  };
});

import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { queueLocalMutation, queueGuardedAccountUpdate } from '../sync/mutation-queue';
import { AccountFormModal } from './AccountFormModal';

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

// The form is now a modal opened from the Accounts list. Tests still
// address it by the old URL shape for brevity; this maps `/accounts/new`
// → create mode and `/accounts/<id>/edit` → edit mode, rendering the
// modal directly (its `open` is implied — the parent only mounts it
// while open).
function renderAt(
  path: string,
  balances: ReadonlyArray<Aggregate<AccountBalancePayload>> = [],
) {
  const accountId =
    path === '/accounts/new'
      ? null
      : (path.match(/^\/accounts\/(.+)\/edit$/)?.[1] ?? null);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AccountFormModal accountId={accountId} balances={balances} onClose={vi.fn()} />
    </MemoryRouter>,
  );
}

async function seedMember(birthdate = '1985-04-15'): Promise<void> {
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
      birthdate,
    },
  };
  await putAggregate('householdMember', m);
}

async function seedAccount(
  active = true,
  /** Extra stored payload facts (the Roth / required-withdrawal tax details
   *  the editor now reads back). */
  payloadExtra: Partial<AccountPayload> = {},
): Promise<void> {
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
      ...payloadExtra,
    },
  };
  await putAggregate('account', acc);
}

/** One `accountBalance` aggregate, `acc-1`'s unless another account is named. */
function balanceAggregate(
  year: number,
  over: Partial<AccountBalancePayload> = {},
  accountId = 'acc-1',
): Aggregate<AccountBalancePayload> {
  return {
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
}

async function seedBalance(year: number, ending: number): Promise<void> {
  await putAggregate('accountBalance', balanceAggregate(year, { endingBalance: ending }));
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

describe('AccountFormPage — create mode', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders the empty form with required fields', async () => {
    await seedMember();
    renderAt('/accounts/new');
    expect(await screen.findByRole('heading', { name: 'Add Account' })).toBeInTheDocument();
    expect(screen.getByLabelText('Institution')).toBeInTheDocument();
    expect(screen.getByLabelText('Account name')).toBeInTheDocument();
    expect(screen.getByLabelText('Account type')).toBeInTheDocument();
    expect(screen.getByLabelText('Owner')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('queues an account create + a current-year $0 balance seed, account first', async () => {
    // Creating an account now queues TWO ordered mutations — the
    // account `create`, then a deterministic current-year $0
    // `accountBalance` seed (`bal-${accountId}-${year}`). The account is
    // queued first ⟹ lower monotonic timestamp ⟹ pushed strictly before the
    // balance (no balance-without-account orphan).
    const user = userEvent.setup();
    await seedMember();
    renderAt('/accounts/new');
    // Owner is the shared React Aria <Select>; wait for the
    // household member load to hydrate it (the trigger shows the
    // member's name) — otherwise the async setForm that follows can
    // race with the field edits and silently reset other fields.
    await waitFor(() =>
      expect(screen.getByLabelText('Owner')).toHaveTextContent('Alex (you)'),
    );
    fireEvent.change(screen.getByLabelText('Institution'), { target: { value: 'Vanguard' } });
    fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'My 401k' } });
    // Account type is a React Aria <Select>: open + pick the option.
    await user.click(screen.getByLabelText('Account type'));
    await user.click(await screen.findByRole('option', { name: '401(k)' }));
    fireEvent.change(screen.getByLabelText('Planning Return %'), { target: { value: '7' } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    await waitFor(async () => {
      const pending = await listPendingMutations();
      expect(pending).toHaveLength(2);
    });
    // listPendingMutations returns flush order (sorted by monotonic
    // timestamp) — assert account is pushed/dequeued strictly before balance.
    const ordered = await listPendingMutations();
    expect(ordered[0].operation).toBe('create');
    expect(ordered[0].aggregateType).toBe('account');
    expect(ordered[1].operation).toBe('create');
    expect(ordered[1].aggregateType).toBe('accountBalance');
    expect(ordered[0].timestamp).toBeLessThan(ordered[1].timestamp);
    // The seed uses the deterministic id `bal-${accountId}-${year}` so a later
    // real current-year balance UPDATES it in place.
    const year = new Date().getUTCFullYear();
    expect(ordered[1].aggregateId).toBe(`bal-${ordered[0].aggregateId}-${year}`);
    const seed = ordered[1].payload as AccountBalancePayload;
    expect(seed.endingBalance).toBe(0);
    expect(seed.startingBalance).toBe(0);
    expect(seed.totalContributions).toBe(0);
    expect(seed.year).toBe(year);
  });

  it('surfaces partial-success when the $0 seed write fails after the account succeeds', async () => {
    // The only reachable partial failure (account saved, seed not) is
    // benign — show "Account created — add a balance…", NOT the generic
    // "Failed to save account", and do NOT close with a failure.
    const user = userEvent.setup();
    await seedMember();
    const onClose = vi.fn();
    const { container } = render(
      <MemoryRouter initialEntries={['/accounts/new']}>
        <AccountFormModal accountId={null} onClose={onClose} />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Owner')).toHaveTextContent('Alex (you)'),
    );
    fireEvent.change(screen.getByLabelText('Institution'), { target: { value: 'Vanguard' } });
    fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'My 401k' } });
    await user.click(screen.getByLabelText('Account type'));
    await user.click(await screen.findByRole('option', { name: '401(k)' }));
    fireEvent.change(screen.getByLabelText('Planning Return %'), { target: { value: '7' } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled(),
    );
    // Force the SECOND queued mutation (the balance seed) to reject — the
    // first (account) passes through to the real impl. The default mock
    // delegates to the real `queueLocalMutation`, so we override only the
    // second call to reject.
    const mock = queueLocalMutation as unknown as ReturnType<typeof vi.fn>;
    const real =
      (
        await vi.importActual<typeof import('../sync/mutation-queue')>(
          '../sync/mutation-queue',
        )
      ).queueLocalMutation;
    mock
      .mockImplementationOnce((args, batch) => real(args, batch))
      .mockImplementationOnce(() =>
        Promise.reject(new Error('seed write failed')),
      );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /Account created — add a balance/i,
      ),
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent(
      /Failed to save account/i,
    );
    // The account persisted; the modal did not close with a generic failure.
    const pending = await listPendingMutations();
    expect(pending.some((m) => m.aggregateType === 'account')).toBe(true);
    expect(onClose).not.toHaveBeenCalledWith(true);
    await expectNoA11yViolations(container);
  });

  it('shows the Mixed Roth-designated vs after-tax help text when Mixed is selected', async () => {
    const user = userEvent.setup();
    await seedMember();
    const { container } = renderAt('/accounts/new');
    await waitFor(() =>
      expect(screen.getByLabelText('Owner')).toHaveTextContent('Alex (you)'),
    );
    // Pick a type that allows Mixed (401(k) → PRE_TAX | MIXED).
    await user.click(screen.getByLabelText('Account type'));
    await user.click(await screen.findByRole('option', { name: '401(k)' }));
    // Select Mixed tax treatment.
    await user.click(screen.getByLabelText('Tax treatment'));
    await user.click(await screen.findByRole('option', { name: 'Mixed' }));
    // The help text describes the Roth-designated (tax-free) employer-plan
    // post-tax slice vs plain after-tax savings — and does NOT promise §408A
    // contributions-first ordering for designated-Roth money.
    expect(
      await screen.findByText(/post-tax side is a Roth-designated slice/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/post-tax side is plain after-tax savings/i),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });
});

describe('AccountFormPage — edit mode', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('hydrates the form with the existing aggregate', async () => {
    await seedMember();
    await seedAccount();
    renderAt('/accounts/acc-1/edit');
    await waitFor(() =>
      expect((screen.getByLabelText('Account name') as HTMLInputElement).value).toBe('My 401k'),
    );
    expect(screen.getByRole('heading', { name: 'Edit Account' })).toBeInTheDocument();
  });

  it('persists asset-mix edits to the queued mutation payload', async () => {
    // Regression: AccountFormPage's update branch used to
    // overwrite the freshly-built payload's assetMix with
    // `existing.payload.assetMix`, silently dropping every edit. This
    // test pins the fix: change Stocks→100, Bonds→0, Cash→0, save,
    // assert the queued mutation carries 100/0/0.
    await seedMember();
    await seedAccount();
    renderAt('/accounts/acc-1/edit');
    await waitFor(() =>
      expect((screen.getByLabelText('Account name') as HTMLInputElement).value).toBe('My 401k'),
    );
    fireEvent.change(screen.getByLabelText(/Stocks %/), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText(/Bonds %/), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText(/Cash %/), { target: { value: '0' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    });
    await waitFor(async () => {
      const pending = await listPendingMutations();
      const update = pending.find((m) => m.operation === 'update');
      expect(update).toBeDefined();
      const payload = update!.payload as AccountPayload;
      expect(payload.assetMix.stocksPct).toBe(100);
      expect(payload.assetMix.bondsPct).toBe(0);
      expect(payload.assetMix.cashPct).toBe(0);
    });
  });

  it('blocks inactivating an account whose latest balance is non-zero', async () => {
    await seedMember();
    await seedAccount(true);
    await seedBalance(2025, 12345);
    renderAt('/accounts/acc-1/edit');
    await waitFor(() =>
      expect(screen.getByLabelText('Active')).toBeChecked(),
    );
    fireEvent.click(screen.getByLabelText('Active'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    });
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /Cannot inactivate an account whose latest balance is non-zero/i,
      ),
    );
    // Deep-link to the balance ledger surfaces inside the error block.
    const alert = screen.getByRole('alert');
    expect(alert.querySelector('a[href="/accounts/acc-1/balances"]')).not.toBeNull();
  });
});

describe('AccountFormPage — income-linked disable guard', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('blocks disabling when an income stream links the account', async () => {
    await seedMember();
    await seedAccount(true);
    await seedIncomeStream('inc-1', 'ACME pension', {
      linkedCbpAccountId: 'acc-1',
    });
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Active')).toBeChecked());
    fireEvent.click(screen.getByLabelText('Active'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    });
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /Cannot disable an account that an income source is paid from or deposits into/i,
      ),
    );
    const alert = screen.getByRole('alert');
    expect(alert.querySelector('a[href="/income"]')).not.toBeNull();
    const pending = await listPendingMutations();
    expect(pending.find((m) => m.operation === 'update')).toBeUndefined();
  });

  it('allows disabling when no income references the account', async () => {
    await seedMember();
    await seedAccount(true);
    await seedIncomeStream('inc-1', 'Other pension', {
      linkedCbpAccountId: 'acc-other',
    });
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Active')).toBeChecked());
    fireEvent.click(screen.getByLabelText('Active'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    });
    await waitFor(async () => {
      const pending = await listPendingMutations();
      const update = pending.find((m) => m.operation === 'update');
      expect(update).toBeDefined();
      expect((update!.payload as AccountPayload).active).toBe(false);
    });
  });

  it('allows saving an already-inactive income-linked account when Active is not toggled', async () => {
    // The disable guard gates the active true→false transition
    // only. An account seeded inactive, edited (institution) and saved
    // WITHOUT touching Active has no transition — the save must be
    // allowed even though an income stream still links it.
    await seedMember();
    await seedAccount(false);
    await seedIncomeStream('inc-1', 'ACME pension', {
      linkedCbpAccountId: 'acc-1',
    });
    renderAt('/accounts/acc-1/edit');
    await waitFor(() =>
      expect((screen.getByLabelText('Account name') as HTMLInputElement).value).toBe('My 401k'),
    );
    expect(screen.getByLabelText('Active')).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('Institution'), {
      target: { value: 'Fidelity' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    });
    await waitFor(async () => {
      const pending = await listPendingMutations();
      const update = pending.find((m) => m.operation === 'update');
      expect(update).toBeDefined();
      expect((update!.payload as AccountPayload).active).toBe(false);
      expect((update!.payload as AccountPayload).institution).toBe('Fidelity');
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('surfaces ACCOUNT_INCOME_LINKED before ACCOUNT_NOT_ZEROED when both apply', async () => {
    // An account that is both non-zero AND income-linked must
    // surface the more feature-relevant /income remediation first.
    await seedMember();
    await seedAccount(true);
    await seedBalance(2025, 12345);
    await seedIncomeStream('inc-1', 'ACME pension', {
      linkedCbpAccountId: 'acc-1',
    });
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Active')).toBeChecked());
    fireEvent.click(screen.getByLabelText('Active'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    });
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /Cannot disable an account that an income source is paid from or deposits into/i,
      ),
    );
    const alert = screen.getByRole('alert');
    expect(alert).not.toHaveTextContent(
      /Cannot inactivate an account whose latest balance is non-zero/i,
    );
    expect(alert.querySelector('a[href="/income"]')).not.toBeNull();
    const pending = await listPendingMutations();
    expect(pending.find((m) => m.operation === 'update')).toBeUndefined();
  });

  it('never blocks enabling (active true) even when income-linked', async () => {
    await seedMember();
    await seedAccount(false);
    await seedIncomeStream('inc-1', 'ACME pension', {
      linkedCbpAccountId: 'acc-1',
    });
    renderAt('/accounts/acc-1/edit');
    await waitFor(() =>
      expect(screen.getByLabelText('Active')).not.toBeChecked(),
    );
    fireEvent.click(screen.getByLabelText('Active'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    });
    await waitFor(async () => {
      const pending = await listPendingMutations();
      const update = pending.find((m) => m.operation === 'update');
      expect(update).toBeDefined();
      expect((update!.payload as AccountPayload).active).toBe(true);
    });
  });
});

describe('AccountFormPage — Roth employer-plan account types', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('selecting Roth 401(k) locks Tax treatment to Tax-free (Roth) and shows the disclosure hint', async () => {
    const user = userEvent.setup();
    await seedMember();
    renderAt('/accounts/new');
    await waitFor(() =>
      expect(screen.getByLabelText('Owner')).toHaveTextContent('Alex (you)'),
    );
    await user.click(screen.getByLabelText('Account type'));
    await user.click(await screen.findByRole('option', { name: 'Roth 401(k)' }));
    // Disclosure hint visible under the Account type field.
    expect(await screen.findByText(/5-year Roth rule/i)).toBeInTheDocument();
    // Tax treatment locked — locked hint confirms the forced single option.
    expect(
      await screen.findByText(/Locked to Tax-free \(Roth\) for this account type/i),
    ).toBeInTheDocument();
  });

  it('grouped account-type picker exposes section headings and all four Roth employer options (a11y smoke)', async () => {
    const user = userEvent.setup();
    await seedMember();
    const { container } = renderAt('/accounts/new');
    await waitFor(() =>
      expect(screen.getByLabelText('Owner')).toHaveTextContent('Alex (you)'),
    );
    await user.click(screen.getByLabelText('Account type'));
    // The section group headings are visible in the open listbox.
    await screen.findByText('Traditional (pre-tax)');
    // 'Roth' is exact-matched to the section header (options are "Roth 401(k)" etc.)
    expect(screen.getByText('Roth')).toBeInTheDocument();
    // All four dedicated Roth employer-plan types are keyboard-reachable options.
    expect(screen.getByRole('option', { name: 'Roth 401(k)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Roth 403(b)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Roth 457(b)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Roth TSP' })).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });
});

// ---------------------------------------------------------------------------
// Roth / required-withdrawal tax details
// ---------------------------------------------------------------------------

describe('AccountFormModal — tax details', () => {
  beforeEach(() => {
    setupContexts();
  });

  it('shows no Tax details section for an account type that carries no Roth or required-withdrawal facts', async () => {
    await seedMember();
    await seedAccount(true, { type: 'BROKERAGE', taxTreatment: 'POST_TAX' });
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));
    expect(screen.queryByRole('button', { name: 'Advanced tax details' })).not.toBeInTheDocument();
  });

  it('renders the recorded designated-Roth year for a MIXED employer plan and asks for no basis amount', async () => {
    await seedMember();
    await seedAccount(true, {
      taxTreatment: 'MIXED',
      designatedRothFirstParticipationTaxYear: 2018,
    });
    renderAt('/accounts/acc-1/edit');
    await waitFor(() =>
      expect(
        screen.getByLabelText('Year Roth contributions to this plan began'),
      ).toHaveValue('2018'),
    );
    // The plan's Roth basis is its recorded in-plan-rollover principal now, so
    // there is no amount to type.
    expect(screen.queryByLabelText('Roth contributions in this plan')).toBeNull();
  });

  it('a blank tax-detail field is OMITTED from the saved payload, never stored as zero', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedAccount(true, { type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH' });
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));
    await user.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(queueGuardedAccountUpdate).toHaveBeenCalled());
    const payload = (await getAggregate('account', 'acc-1'))?.payload as AccountPayload;
    // Absent, NOT 0 — the engines' conservative default depends on absence.
    expect('rothIraRegularContributionBasis' in payload).toBe(false);
    expect('rothIraFirstContributionTaxYear' in payload).toBe(false);
  });

  it('uses balance history for the summary without persisting the inferred year', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedAccount(true, { type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH' });
    const inferredBalance: Aggregate<AccountBalancePayload> = {
      id: 'bal-acc-1-2018',
      householdId: HH,
      aggregateType: 'accountBalance',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2018-12-31T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        accountId: 'acc-1',
        year: 2018,
        lastUpdated: '2018-12-31T00:00:00Z',
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
        endingBalance: 10_000,
        endingBalancePreTax: null,
        endingBalancePostTax: null,
        totalContributions: 0,
        comment: null,
      },
    };
    renderAt('/accounts/acc-1/edit', [inferredBalance]);
    expect(await screen.findByText(/Roth start: 2018 from balances/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(queueGuardedAccountUpdate).toHaveBeenCalled());
    const payload = (await getAggregate('account', 'acc-1'))?.payload as AccountPayload;
    expect('rothIraFirstContributionTaxYear' in payload).toBe(false);
  });

  it('a corrupt stored tax fact renders blank instead of crashing the editor (untrusted stored data)', async () => {
    await seedMember();
    await seedAccount(true, {
      type: 'RETIREMENT_ROTH_IRA',
      taxTreatment: 'ROTH',
      // Out-of-bounds year and a negative basis — shapes this editor never writes
      // but an import or an older build could leave behind.
      rothIraFirstContributionTaxYear: 9999,
      rothIraRegularContributionBasis: -5,
    });
    renderAt('/accounts/acc-1/edit');
    await screen.findByRole('button', { name: 'Advanced tax details' });
    await userEvent.click(screen.getByRole('button', { name: 'Advanced tax details' }));
    await userEvent.click(screen.getByRole('button', { name: /Enter a year.*Year of your first Roth IRA contribution/ }));
    expect(screen.getByLabelText('Year of your first Roth IRA contribution')).toHaveValue('');
    // The corrupt basis is not rendered anywhere — the field itself is gone.
    expect(screen.queryByLabelText('Total contributions made so far')).toBeNull();
    // The editor is fully usable — the corrupt values were dropped, not rendered.
    expect(screen.getByRole('button', { name: 'Advanced tax details' })).toBeInTheDocument();
  });

  it('an inherited Roth IRA asks for the ORIGINAL OWNER’s contribution year, not the beneficiary’s', async () => {
    // The engine reads `rothIraFirstContributionTaxYear` on an inherited account as
    // the DECEDENT's five-year clock (an inherited Roth IRA never merges with the
    // beneficiary's own), so the field has to ask for the original owner's year. The
    // unqualified "your first Roth IRA contribution" wording invited the beneficiary's
    // own year, and a too-early answer makes the growth look tax-free years early.
    const user = userEvent.setup();
    await seedMember();
    await seedAccount(true, { type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH' });
    renderAt('/accounts/acc-1/edit');
    await screen.findByRole('button', { name: 'Advanced tax details' });
    await user.click(screen.getByRole('button', { name: 'Advanced tax details' }));
    await user.click(screen.getByRole('button', { name: /Enter a year.*Year of your first Roth IRA contribution/ }));
    expect(screen.getByLabelText('Year of your first Roth IRA contribution')).toHaveValue('');

    await user.click(screen.getByRole('switch', { name: 'I inherited this account' }));

    expect(
      await screen.findByLabelText('Year the original owner first contributed to a Roth IRA'),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Year of your first Roth IRA contribution'),
    ).not.toBeInTheDocument();
    // The basis field that used to sit beside it — in either label variant — is
    // gone: the figure is derived from recorded balance history.
    expect(screen.queryByLabelText("Original owner's total contributions")).toBeNull();
    expect(screen.queryByLabelText('Total contributions made so far')).toBeNull();
  });

  it('an inherited account lists the exact missing facts that put its estimate on hold (blockers)', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedAccount(true, { type: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' });
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));
    await user.click(screen.getByRole('button', { name: 'Advanced tax details' }));

    await user.click(screen.getByRole('switch', { name: 'I inherited this account' }));

    expect(
      await screen.findByText(/cannot be saved while any of these inherited-account issues apply/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled();
    // Asserted on the blocker LIST items specifically — the same phrases also label
    // the fields, so scope the query to the readiness list.
    const blockerItems = screen
      .getAllByRole('listitem')
      .map((li) => li.textContent?.trim());
    // The list is the ENGINE's own withhold reasons for this fact set, so it
    // starts with exactly the three baseline facts every post-death rule needs …
    expect(blockerItems).toContain('Who inherited this account');
    expect(blockerItems).toContain("The original owner's date of death");
    expect(blockerItems).toContain(
      'Whether the original owner had reached their RMD start date',
    );
    // … and does NOT yet demand facts whose necessity depends on the rule that is
    // not selected yet (no false positives — the pre-fix list demanded a
    // beneficiary birthdate and an election from every category, including an
    // estate/charity and a plainly-named beneficiary, which neither rule needs).
    expect(blockerItems).not.toContain('The date of birth of whoever inherited it');
  });

  it('refuses to save a tax-detail YEAR it cannot read instead of dropping it', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedAccount(true, { type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH' });
    renderAt('/accounts/acc-1/edit');
    await screen.findByRole('button', { name: 'Advanced tax details' });
    await user.click(screen.getByRole('button', { name: 'Advanced tax details' }));
    await user.click(
      screen.getByRole('button', {
        name: /Enter a year.*Year of your first Roth IRA contribution/,
      }),
    );
    // An out-of-range year must not silently vanish from the saved payload and be
    // read by the engines as "nothing recorded".
    const mutations = queueGuardedAccountUpdate as unknown as ReturnType<typeof vi.fn>;
    const callsBefore = mutations.mock.calls.length;
    await user.type(
      screen.getByLabelText('Year of your first Roth IRA contribution'),
      '1971',
    );
    await user.click(screen.getByRole('button', { name: 'Update' }));
    expect(
      await screen.findByText(/Please check .*Year of your first Roth IRA contribution/i),
    ).toBeInTheDocument();
    // Nothing was written — the mock is shared across this file's tests, so compare
    // against the count entering this test rather than asserting "never called".
    expect(mutations.mock.calls.length).toBe(callsBefore);
  });

  it('collects inherited dates through the shared date picker, not a free-text field', async () => {
    // Every date in the app is the shared React Aria `DatePicker`
    // (segmented entry + calendar popover), never a bare text box with a
    // "Format: YYYY-MM-DD" hint. The stored value contract is the same string.
    await seedMember();
    await seedAccount(true, {
      type: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      rmdInheritedAccount: true,
      rmdInheritedOwnerDeathDate: '2023-04-02',
    });
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));
    // A date-picker group (not a textbox) rendering the stored date in en-US order.
    const deathDate = await screen.findByRole('group', {
      name: "Original owner's date of death",
    });
    expect(deathDate).toHaveTextContent('4/2/2023');
    expect(
      screen.queryByRole('textbox', { name: "Original owner's date of death" }),
    ).toBeNull();
    // The original owner's date of birth is a picker too, and still empty.
    // (The inheritor's own date of birth is no longer asked for here — it is
    // the account owner's, which the household already records.)
    {
      const name = "Original owner's date of birth";
      expect(screen.getByRole('group', { name })).toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name })).toBeNull();
    }
    // The format hint is gone with the free-text field it explained.
    expect(screen.queryByText('Format: YYYY-MM-DD.')).toBeNull();
  });

  it('an employer plan offers no rollover editor here and points at the yearly balances', async () => {
    // The employer-plan mirror of the Roth IRA case: in-plan Roth rollovers are
    // recorded per year on the Account Balances page, so the account editor keeps
    // only the standing basis figures and no repeatable list at all.
    await seedMember();
    await seedAccount(true, { taxTreatment: 'MIXED' });
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));
    expect(
      screen.queryByRole('group', { name: /moved into the Roth side/i }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a year' })).toBeNull();
    expect(
      screen.getByText(/recorded on this account’s yearly balances/i),
    ).toBeInTheDocument();
    // No `<fieldset>` anywhere in the editor (the app uses the
    // `<div role="group">` + `<header>` pattern instead).
    expect(document.querySelector('fieldset')).toBeNull();
  });

  it('surfaces the NEXT engine blocker as soon as the baseline inherited facts are supplied', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedAccount(true, {
      type: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      // The three baseline facts are recorded; an eligible designated beneficiary
      // must still choose between lifetime withdrawals and the ten-year rule, and
      // the engine reports exactly that.
      rmdInheritedAccount: true,
      rmdBeneficiaryType: 'SPOUSE',
      rmdInheritedOwnerDeathDate: '2023-04-02',
      rmdInheritedOwnerDiedOnOrAfterRbd: false,
    });
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));
    await waitFor(() =>
      expect(
        screen.getByText(/cannot be saved while any of these inherited-account issues apply/i),
      ).toBeInTheDocument(),
    );
    const blockerItems = screen
      .getAllByRole('listitem')
      .map((li) => li.textContent?.trim());
    expect(blockerItems).toContain(
      'Whether withdrawals spread over a lifetime or empty within ten years',
    );
    // The baseline facts are recorded, so they are no longer asked for.
    expect(blockerItems).not.toContain('Who inherited this account');
    void user;
  });

  it('switching an account away from a Roth type drops its now-meaningless Roth facts on save', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedAccount(true, {
      type: 'RETIREMENT_ROTH_IRA',
      taxTreatment: 'ROTH',
      rothIraRegularContributionBasis: 48_000,
      rothIraFirstContributionTaxYear: 2015,
    });
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));

    await user.click(screen.getByLabelText('Account type'));
    await user.click(await screen.findByRole('option', { name: 'Savings' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Advanced tax details' })).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(queueGuardedAccountUpdate).toHaveBeenCalled());
    const payload = (await getAggregate('account', 'acc-1'))?.payload as AccountPayload;
    expect('rothIraRegularContributionBasis' in payload).toBe(false);
    expect('rothIraFirstContributionTaxYear' in payload).toBe(false);
  });

  it('a Roth IRA offers no conversion editor here and points at the yearly balances instead', async () => {
    // Conversions are recorded per year on the Account Balances page. Two entry
    // points for one fact is the bug this replaced: the account-page list was the
    // one the engine read, so a conversion typed on the balances page did nothing.
    const user = userEvent.setup();
    await seedMember();
    await seedAccount(true, { type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH' });
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));

    expect(screen.queryByRole('group', { name: /converted into this Roth IRA/i })).toBeNull();
    // Must track the CURRENT balances-page label ("Roth Conversion (taxable)").
    // Pinned to the retired wording this assertion
    // passed no matter what — a restored editor would have gone unnoticed.
    expect(screen.queryByLabelText(/Roth Conversion \(taxable\)/i)).toBeNull();
    expect(screen.getByText(/recorded on this account’s yearly balances/i)).toBeInTheDocument();

    // Saving an untouched Roth IRA emits no conversion field at all.
    await user.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(queueGuardedAccountUpdate).toHaveBeenCalled());
    const payload = (await getAggregate('account', 'acc-1'))?.payload as AccountPayload;
    expect('rothIraConversionLots' in payload).toBe(false);
  });

  it('the tax-details section has no accessibility violations (owner and inherited states)', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedAccount(true, {
      taxTreatment: 'MIXED',
      designatedRothFirstParticipationTaxYear: 2018,
    });
    const { container } = renderAt('/accounts/acc-1/edit');
    await screen.findByRole('button', { name: 'Advanced tax details' });
    await user.click(screen.getByRole('button', { name: 'Advanced tax details' }));
    expect(
      screen.getByLabelText('Year Roth contributions to this plan began'),
    ).toHaveValue('2018');
    // Owner state (still-working questions + sole-spouse designation visible).
    await expectNoA11yViolations(container);

    // Inherited state (beneficiary controls + the blocker list visible).
    await user.click(screen.getByRole('switch', { name: 'I inherited this account' }));
    await screen.findByLabelText('Your relationship to the original owner');
    await expectNoA11yViolations(container);
  });

  it('allows a complete supported inherited rule to be updated', async () => {
    await seedMember();
    await seedAccount(true, {
      type: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      rmdInheritedAccount: true,
      rmdBeneficiaryType: 'SPOUSE',
      rmdBeneficiaryElection: 'LIFE_EXPECTANCY',
      rmdInheritedOwnerDeathDate: '2023-04-02',
      rmdInheritedOwnerDiedOnOrAfterRbd: false,
      rmdOriginalOwnerBirthdate: '1950-01-01',
    });
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));
    expect(screen.getByRole('button', { name: 'Update' })).toBeEnabled();
  });

  it('does not let a legacy beneficiary birthdate approve a save that removes that copy', async () => {
    await seedMember('');
    await seedAccount(true, {
      type: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      rmdInheritedAccount: true,
      rmdBeneficiaryType: 'SPOUSE',
      rmdBeneficiaryElection: 'LIFE_EXPECTANCY',
      rmdInheritedOwnerDeathDate: '2023-04-02',
      rmdInheritedOwnerDiedOnOrAfterRbd: false,
      rmdOriginalOwnerBirthdate: '1950-01-01',
      rmdBeneficiaryBirthdate: '1985-04-15',
    });
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));
    expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled();
    expect(
      screen.getByText("The account owner's date of birth on the Household screen"),
    ).toBeInTheDocument();
  });

  it('blocks a complete-looking inherited rule when its pre-2020 regime is unsupported', async () => {
    await seedMember();
    await seedAccount(true, {
      type: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      rmdInheritedAccount: true,
      rmdBeneficiaryType: 'SPOUSE',
      rmdBeneficiaryElection: 'LIFE_EXPECTANCY',
      rmdInheritedOwnerDeathDate: '2019-04-02',
      rmdInheritedOwnerDiedOnOrAfterRbd: false,
      rmdOriginalOwnerBirthdate: '1950-01-01',
    });
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));
    expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled();
    expect(screen.getByText(/Deaths before 2020 follow older rules/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Retype blocking — an account's type is fixed
// once it has real balance history, in every direction, edit mode only.
//
// Every case here seeds its balance rows into the STORE and renders the modal
// with NO `balances` prop, because that is the reachable shape: on a cold deep
// link to `/accounts?edit=…` the modal hydrates its account independently of the
// list page's balance query, so the prop can still be `[]` when the type select is
// used. A check that read the prop would apply (or refuse) a retype with no real
// verdict behind it.
// ---------------------------------------------------------------------------

describe('AccountFormModal — account-type retype block', () => {
  beforeEach(async () => {
    setupContexts();
    await clearAllStores();
    await seedMember();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  async function putRow(
    year: number,
    over: Partial<AccountBalancePayload>,
    accountId = 'acc-1',
  ): Promise<void> {
    await putAggregate('accountBalance', balanceAggregate(year, over, accountId));
  }

  /** One year of real return-bearing history on `acc-1` — qualifies as
   *  blocking history under every account type. */
  async function seedQualifyingRow(): Promise<void> {
    await putRow(2020, { totalContributions: 6_000, endingBalance: 6_000 });
  }

  async function chooseType(user: ReturnType<typeof userEvent.setup>, label: string) {
    await user.click(screen.getByLabelText('Account type'));
    await user.click(await screen.findByRole('option', { name: label }));
  }

  // -- Open-time verdict + option marking ----------------------------

  it('open-time blocked: every differing option carries the unavailable treatment and its own accessible description; the persisted option carries neither', async () => {
    const user = userEvent.setup();
    await seedAccount(true);
    await seedQualifyingRow();
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));

    await user.click(screen.getByLabelText('Account type'));
    const persisted = await screen.findByRole('option', { name: '401(k)' });
    expect(persisted.className).not.toMatch(/text-muted/);
    expect(persisted).toHaveAccessibleDescription('');

    const rothIra = screen.getByRole('option', { name: 'Roth IRA' });
    expect(rothIra.className).toMatch(/text-muted/);
    expect(rothIra).toHaveAccessibleDescription(/already has balance history/i);
    // No type-pair table: a second, unrelated differing option is marked
    // exactly the same way.
    const savings = screen.getByRole('option', { name: 'Savings' });
    expect(savings.className).toMatch(/text-muted/);
    expect(savings).toHaveAccessibleDescription(/already has balance history/i);
  });

  it('the open-time verdict resolves BEFORE the loading gate lifts — no option renders ahead of it', async () => {
    await seedAccount(true);
    await seedQualifyingRow();
    // Park the OPEN-TIME read itself (set before `renderAt`, so it gates the
    // very read the hydration effect kicks off).
    let releaseBalanceRead!: () => void;
    retypeReadGate.balanceRead = new Promise<void>((resolve) => {
      releaseBalanceRead = resolve;
    });
    try {
      renderAt('/accounts/acc-1/edit');
      // Let the account read (and every OTHER microtask the hydration
      // effect kicks off) fully settle while the balance read stays
      // parked. A regression that fires the balance read without
      // awaiting it (so `setLoading(false)` in the effect's `finally`
      // does not wait on it either) would already show the hydrated form
      // at this point, ahead of the verdict — exactly what the verdict-before-render rule forbids.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(screen.queryByLabelText('Account name')).toBeNull();
      expect(screen.getByRole('status')).toHaveTextContent('Loading account…');

      const user = userEvent.setup();
      await act(async () => {
        releaseBalanceRead();
        // A macrotask boundary drains the microtask chain the released read
        // resumes through.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // The gate lifts only once the verdict is in, and the options come
      // back already marked — never ordinary for a frame.
      await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));
      await user.click(screen.getByLabelText('Account type'));
      expect(screen.getByRole('option', { name: 'Roth IRA' })).toHaveAccessibleDescription(
        /already has balance history/i,
      );
    } finally {
      releaseBalanceRead();
      retypeReadGate.balanceRead = null;
    }
  });

  it('a blocked pick applies nothing: the trigger stays on the held value, the live region carries the reason, and repeating the pick announces again', async () => {
    const user = userEvent.setup();
    await seedAccount(true);
    await seedQualifyingRow();
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));

    // The `role="status"` region is mounted the whole time (never
    // arrives already populated); grab it before triggering an announcement.
    const region = screen.getByRole('status');
    await chooseType(user, 'Roth IRA');
    await waitFor(() => expect(region).toHaveTextContent(/already has balance history/i));
    const node1 = within(region).getByText(/already has balance history/i);
    expect(screen.getByLabelText('Account type')).toHaveTextContent('401(k)');
    expect(await listPendingMutations()).toHaveLength(0);

    await chooseType(user, 'Roth IRA');
    await waitFor(() => {
      // The INNER node was replaced (fresh `key`), not merely re-rendered
      // with the same text — many screen readers don't re-announce the
      // latter — while the outer region itself stayed mounted.
      const node2 = within(region).getByText(/already has balance history/i);
      expect(node2).not.toBe(node1);
    });
  });

  // -- Clear -------------------------------------------------------------

  it('clear: a brand-new account retypes freely and applies the new type’s default tax treatment', async () => {
    const user = userEvent.setup();
    renderAt('/accounts/new');
    await waitFor(() =>
      expect(screen.getByLabelText('Owner')).toHaveTextContent('Alex (you)'),
    );
    await chooseType(user, 'Roth IRA');
    await waitFor(() =>
      expect(screen.getByLabelText('Account type')).toHaveTextContent('Roth IRA'),
    );
    expect(
      await screen.findByText(/Locked to Tax-free \(Roth\) for this account type/i),
    ).toBeInTheDocument();
    // The region is mounted but never populated for a clean retype.
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('create mode takes no balance read on open', async () => {
    renderAt('/accounts/new');
    await waitFor(() =>
      expect(screen.getByLabelText('Owner')).toHaveTextContent('Alex (you)'),
    );
    const calls = (listAggregates as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c) => c[0] === 'accountBalance')).toBe(false);
  });

  it('clear: a seed-only account (the automatic all-zero balance) retypes freely', async () => {
    const user = userEvent.setup();
    await seedAccount(true);
    await putRow(2026, {});
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));
    await chooseType(user, 'Roth IRA');
    await waitFor(() =>
      expect(screen.getByLabelText('Account type')).toHaveTextContent('Roth IRA'),
    );
    expect(
      await screen.findByText(/Locked to Tax-free \(Roth\) for this account type/i),
    ).toBeInTheDocument();
    // The region is mounted but never populated for a clean retype.
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(await listPendingMutations()).toHaveLength(0);
  });

  it('does not ask when the account is ALREADY persisted as the picked type — no read at all', async () => {
    // Flipping the type away and back grants nothing new, so a pick equal to
    // the PERSISTED type applies immediately with no read.
    const user = userEvent.setup();
    await seedAccount(true, { type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH' });
    await seedQualifyingRow();
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));
    // Roth IRA is the persisted type here, so it applies with no read even
    // though the account has real history.
    await chooseType(user, 'Roth IRA');
    // The region is mounted but never populated — the persisted-type
    // pick takes no read at all.
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    await waitFor(() =>
      expect(screen.getByLabelText('Account type')).toHaveTextContent('Roth IRA'),
    );
  });

  it('does not touch the picker on an unrelated field edit', async () => {
    await seedAccount(true);
    await seedQualifyingRow();
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));
    fireEvent.change(screen.getByLabelText('Institution'), { target: { value: 'Fidelity' } });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  // -- Pick-time discovery + the latch ---------------------------------

  it('pick-time discovery: a qualifying row written after open refuses the pick and re-marks the options for the rest of the session', async () => {
    const user = userEvent.setup();
    await seedAccount(true);
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));

    // Second-tab shape: a qualifying row lands straight in IDB with no
    // cross-tab signal this editor would see.
    await seedQualifyingRow();

    await chooseType(user, 'Roth IRA');
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/already has balance history/i),
    );
    expect(screen.getByLabelText('Account type')).toHaveTextContent('401(k)');
    expect(await listPendingMutations()).toHaveLength(0);

    // The latch: re-opening the listbox shows the options now marked, not
    // just a one-time refusal.
    await user.click(screen.getByLabelText('Account type'));
    expect(screen.getByRole('option', { name: 'Roth IRA' })).toHaveAccessibleDescription(
      /already has balance history/i,
    );
  });

  it('supersession: a later pick wins over an earlier read still out, which applies and refuses nothing', async () => {
    const user = userEvent.setup();
    await seedAccount(true);
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));

    // Gate AFTER hydration — the open-time read must not be parked by this,
    // only the two pick-time reads below.
    let releaseBalanceRead!: () => void;
    retypeReadGate.balanceRead = new Promise<void>((resolve) => {
      releaseBalanceRead = resolve;
    });
    try {
      // The first pick's read runs (fetching real rows) and is then parked —
      // no qualifying row exists yet, so it will resolve 'clear'.
      await chooseType(user, 'Roth IRA');
      // A qualifying row lands only now (the second-tab shape), so the
      // SECOND pick's read — which runs and is parked after it — will
      // resolve 'blocked'. The two abandoned/live reads now disagree,
      // which is what makes a missing supersession guard observable:
      // without it, the FIRST (superseded) read's 'clear' outcome would
      // still apply once it resolves, even though the person moved on.
      await seedQualifyingRow();
      await chooseType(user, 'Savings');
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled(),
      );

      await act(async () => {
        releaseBalanceRead();
        // A macrotask boundary drains the entire microtask chain both
        // released reads resume through.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // The FIRST (superseded) read applied and refused nothing — the
      // trigger never moved to 'Roth IRA'. The SECOND (live) read is what
      // decided the outcome: it found the qualifying row and refused.
      expect(screen.getByLabelText('Account type')).toHaveTextContent('401(k)');
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(/already has balance history/i),
      );
      expect(await listPendingMutations()).toHaveLength(0);
    } finally {
      releaseBalanceRead();
      retypeReadGate.balanceRead = null;
    }
  });

  it('submit-while-in-flight: Update stays disabled and Enter in a text field queues nothing', async () => {
    const user = userEvent.setup();
    await seedAccount(true);
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));

    let releaseBalanceRead!: () => void;
    retypeReadGate.balanceRead = new Promise<void>((resolve) => {
      releaseBalanceRead = resolve;
    });
    try {
      await chooseType(user, 'Roth IRA');
      expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled();
      fireEvent.submit(screen.getByLabelText('Account name').closest('form')!);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // Never a mutation carrying the pre-pick (persisted) type.
      expect(await listPendingMutations()).toHaveLength(0);
    } finally {
      releaseBalanceRead();
      retypeReadGate.balanceRead = null;
    }
  });

  // -- Could not check + retry -----------------------------------------

  it('a pick read that fails lands in could-not-check; the retry re-reads, and once it returns clear a fresh pick applies', async () => {
    const user = userEvent.setup();
    await seedAccount(true);
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));

    const region = screen.getByRole('status');
    retypeReadGate.failBalanceRead = true;
    await chooseType(user, 'Roth IRA');
    await waitFor(() =>
      expect(region).toHaveTextContent(/Could not check this account’s balance history/i),
    );
    expect(screen.getByLabelText('Account type')).toHaveTextContent('401(k)');
    expect(await listPendingMutations()).toHaveLength(0);

    retypeReadGate.failBalanceRead = false;
    await user.click(within(region).getByRole('button', { name: 'Try again' }));
    // The region stays mounted and reports the retry's own outcome —
    // it does not go silently empty — and the retry control it was pressed
    // on is gone.
    await waitFor(() =>
      expect(region).toHaveTextContent(/Balance history check complete/i),
    );
    expect(within(region).queryByRole('button', { name: 'Try again' })).toBeNull();

    await chooseType(user, 'Roth IRA');
    await waitFor(() =>
      expect(screen.getByLabelText('Account type')).toHaveTextContent('Roth IRA'),
    );
  });

  it('open read fails → the field arrives in could-not-check while the account itself still hydrates', async () => {
    await seedAccount(true);
    retypeReadGate.failBalanceRead = true;
    try {
      renderAt('/accounts/acc-1/edit');
      await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(
          /Could not check this account’s balance history/i,
        ),
      );
    } finally {
      retypeReadGate.failBalanceRead = false;
    }
  });

  // -- Save-time backstop --------------------------------------------------

  it('save-time backstop: a qualifying row lands after an allowed pick — Update is refused with the blocked copy and nothing is queued', async () => {
    const user = userEvent.setup();
    await seedAccount(true);
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));

    await chooseType(user, 'Roth IRA');
    await waitFor(() =>
      expect(screen.getByLabelText('Account type')).toHaveTextContent('Roth IRA'),
    );

    // The race: a qualifying row lands after the pick was already accepted.
    await seedQualifyingRow();

    await user.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /This account already has balance history, so its type can.t be changed/i,
      ),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/Set the type back to 401\(k\)/i);
    expect(await listPendingMutations()).toHaveLength(0);
    const stored = await getAggregate('account', 'acc-1');
    expect((stored?.payload as AccountPayload).type).toBe('RETIREMENT_401K');
  });

  it('save-time backstop names a persisted type another device moved to, and re-picking it in-modal recovers without reopening the editor', async () => {
    const user = userEvent.setup();
    await seedAccount(true);
    await seedQualifyingRow();
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));

    // Another device retypes the account (carrying its qualifying history)
    // to Roth IRA while this editor stays open — the accepted cross-device
    // window. The local row changes under the open editor; this
    // tab never reads it until the save transaction does.
    const current = (await getAggregate('account', 'acc-1')) as Aggregate<AccountPayload>;
    await putAggregate('account', {
      ...current,
      version: 2,
      payload: { ...current.payload, type: 'RETIREMENT_ROTH_IRA' },
    });

    // A non-type edit — untouched by the block.
    fireEvent.change(screen.getByLabelText('Account name'), {
      target: { value: 'My 401k (renamed)' },
    });

    await user.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /This account already has balance history, so its type can.t be changed/i,
      ),
    );
    // Names the FRESH persisted type the transaction actually saw, not the
    // stale open-time snapshot.
    expect(screen.getByRole('alert')).toHaveTextContent(/Set the type back to Roth IRA/i);
    expect(await listPendingMutations()).toHaveLength(0);

    // Recovery: the picker itself now tracks the fresh persisted type —
    // Roth IRA is no longer marked unavailable, and 401(k) (no longer the
    // real persisted type) now is.
    await user.click(screen.getByLabelText('Account type'));
    expect(screen.getByRole('option', { name: 'Roth IRA' })).toHaveAccessibleDescription('');
    // 401(k) is still the form's CURRENT value at this point (nothing has
    // been re-picked yet), so its own description is suppressed by
    // `Select`'s contract (a selected option's
    // description never leaks into the closed trigger). Its `unavailable`
    // visual treatment is the recovery signal to check here: it is no
    // longer the persisted type, so it now renders muted.
    expect(screen.getByRole('option', { name: '401(k)' }).className).toMatch(/text-muted/);

    // Picking the (now) persisted type applies immediately, with no read
    // and no refusal — the in-modal recovery exit.
    await user.click(screen.getByRole('option', { name: 'Roth IRA' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Account type')).toHaveTextContent('Roth IRA'),
    );
    expect(screen.getByRole('status')).toBeEmptyDOMElement();

    // And Update now saves the rename together with the type correction —
    // no need to close and reopen the editor.
    await user.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(async () => {
      const stored = (await getAggregate('account', 'acc-1')) as Aggregate<AccountPayload>;
      expect(stored.payload.name).toBe('My 401k (renamed)');
    });
    const stored = (await getAggregate('account', 'acc-1')) as Aggregate<AccountPayload>;
    expect(stored.payload.type).toBe('RETIREMENT_ROTH_IRA');
  });

  it('save-time backstop: an in-transaction balance-read failure surfaces the distinct could-not-check save copy', async () => {
    const user = userEvent.setup();
    await seedAccount(true);
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));

    await chooseType(user, 'Roth IRA');
    await waitFor(() =>
      expect(screen.getByLabelText('Account type')).toHaveTextContent('Roth IRA'),
    );

    // Fail only the SECOND `accountBalances` read reached by Update — the
    // first is onSave's pre-existing early read (untouched by this feature);
    // the second is the guarded write's in-transaction read.
    const originalGetAll = IDBObjectStore.prototype.getAll;
    let balanceGetAllCalls = 0;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, 'getAll')
      .mockImplementation(function (
        this: IDBObjectStore,
        ...args: Parameters<typeof originalGetAll>
      ) {
        if (this.name === 'accountBalances') {
          balanceGetAllCalls += 1;
          if (balanceGetAllCalls > 1) {
            throw new Error('injected in-transaction balance read failure');
          }
        }
        return originalGetAll.apply(this, args);
      });
    try {
      await user.click(screen.getByRole('button', { name: 'Update' }));
      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          /Could not check this account’s balance history, so nothing was saved/i,
        ),
      );
    } finally {
      spy.mockRestore();
    }
    expect(await listPendingMutations()).toHaveLength(0);
  });

  it('same-type save on an account with years of history (rename only) succeeds and takes no history read inside the transaction', async () => {
    const user = userEvent.setup();
    await seedAccount(true);
    await seedQualifyingRow();
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));
    fireEvent.change(screen.getByLabelText('Institution'), { target: { value: 'Fidelity' } });

    const originalGetAll = IDBObjectStore.prototype.getAll;
    let balanceGetAllCalls = 0;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, 'getAll')
      .mockImplementation(function (
        this: IDBObjectStore,
        ...args: Parameters<typeof originalGetAll>
      ) {
        if (this.name === 'accountBalances') balanceGetAllCalls += 1;
        return originalGetAll.apply(this, args);
      });
    try {
      await user.click(screen.getByRole('button', { name: 'Update' }));
      await waitFor(async () => {
        const pending = await listPendingMutations();
        expect(
          pending.some((m) => m.aggregateType === 'account' && m.operation === 'update'),
        ).toBe(true);
      });
    } finally {
      spy.mockRestore();
    }
    // Exactly the pre-existing early read (untouched by this feature) — no
    // SECOND, in-transaction read, because the submitted type equals the
    // fresh persisted type.
    expect(balanceGetAllCalls).toBe(1);
    const pending = await listPendingMutations();
    const update = pending.find((m) => m.operation === 'update');
    expect((update!.payload as AccountPayload).institution).toBe('Fidelity');
  });

  it('the MIXED tax-treatment confirm still fires ahead of the guarded transaction, and cancelling writes nothing', async () => {
    const user = userEvent.setup();
    await seedAccount(true, { taxTreatment: 'MIXED' });
    await seedQualifyingRow();
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));

    await user.click(screen.getByLabelText('Tax treatment'));
    await user.click(await screen.findByRole('option', { name: 'Tax-deferred' }));
    await user.click(screen.getByRole('button', { name: 'Update' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/Switch to Tax-deferred/i);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await listPendingMutations()).toHaveLength(0);
  });

  it('after a successful edit-mode save the account store’s change signal fires', async () => {
    const user = userEvent.setup();
    await seedAccount(true);
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));
    const before = getStoreVersion('accounts');
    fireEvent.change(screen.getByLabelText('Institution'), { target: { value: 'Fidelity' } });
    await user.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(getStoreVersion('accounts')).toBeGreaterThan(before));
  });

  // -- Accessibility -------------------------------------------------------
  //
  // None of these asserts which element holds focus right after the type
  // listbox closes inside the modal. React Aria's `useDialog` re-focuses the
  // dialog from a 500 ms timer whenever focus is on the dialog or `<body>`,
  // and the listbox's own focus restore runs one animation frame after the
  // popover is removed — a window in which jsdom reports `<body>`. A test that
  // closes the listbox about 500 ms after the dialog opened (a slow CI runner
  // does) can lose that race and end with focus on the dialog. The restore
  // target itself is covered by `Select.test.tsx`, outside any dialog.

  it('accessibility: the open listbox in the blocked state has no axe violations', async () => {
    const user = userEvent.setup();
    await seedAccount(true);
    await seedQualifyingRow();
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));

    screen.getByLabelText('Account type').focus();
    await user.keyboard('{Enter}');
    const listbox = await screen.findByRole('listbox');
    // Scan the blocked markup (muted rows, per-option descriptions), not the
    // pre-verdict markup: wait for the open-time history read to land first.
    await waitFor(() =>
      expect(within(listbox).getByRole('option', { name: 'Roth IRA' })).toHaveAccessibleDescription(
        /already has balance history/i,
      ),
    );
    // React Aria portals the dialog, the type <Select> and its listbox to
    // `document.body` (see `Modal.tsx`), not RTL's `container`.
    await expectNoA11yViolations(document.body);
  });

  it('keyboard: typeahead reaches a blocked option, Enter selects it, and the pick is refused — announced in the status region, the trigger keeps 401(k), nothing is written', async () => {
    const user = userEvent.setup();
    await seedAccount(true);
    await seedQualifyingRow();
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));

    const trigger = screen.getByLabelText('Account type');
    trigger.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('listbox');

    // Keyboard-only: typeahead lands on the blocked "Roth IRA" option — it is
    // marked unavailable but not removed from keyboard navigation.
    await user.keyboard('Roth IRA');
    const rothIra = screen.getByRole('option', { name: 'Roth IRA' });
    await waitFor(() => expect(rothIra).toHaveFocus());
    expect(rothIra.className).toMatch(/text-muted/);

    // Enter selects it: the listbox closes (a real selection, not a no-op) and
    // the editor refuses the pick.
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/already has balance history/i),
    );
    expect(trigger).toHaveTextContent('401(k)');
    expect(await listPendingMutations()).toHaveLength(0);
    // Focus was not dropped to <body>: it stays inside the dialog.
    await waitFor(() =>
      expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement),
    );
  });

  it('the refusal announces without moving focus: a blocked option picked from the closed trigger leaves focus on the trigger', async () => {
    const user = userEvent.setup();
    await seedAccount(true);
    await seedQualifyingRow();
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));

    const trigger = screen.getByLabelText('Account type');
    trigger.focus();
    // React Aria's closed-trigger typeahead: "R" selects the first R option
    // (Roth IRA) without opening the listbox, so no popover opens or closes and
    // the only code that could move focus is the refusal itself.
    await user.keyboard('R');
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/already has balance history/i),
    );
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger).toHaveTextContent('401(k)');
    expect(trigger).toHaveFocus();
    expect(await listPendingMutations()).toHaveLength(0);
  });
});
