// AccountFormModal: create-mode rendering, the type-driven tax-treatment lock, the ACCOUNT_NOT_ZEROED guard and retype blocking.
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

// Hoisted gate on every `listAggregates('accountBalance', …)` read: a test parks a read so a second type choice lands while the earlier check is out.
// Applied after the real read so releasing it settles in microtasks; the save-time transactional read uses raw IDB `getAll` and is injected through `IDBObjectStore.prototype.getAll` instead.
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

// queueLocalMutation defaults to the real implementation; one test overrides it per call to reject the seed write after the account write succeeds.
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

// The form is a modal opened from the Accounts list; this maps `/accounts/new` and `/accounts/<id>/edit` to create and edit mode and renders the modal directly.
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
    // Creating an account queues the account create, then a deterministic current-year $0 balance seed; the account is queued first so it is pushed before the balance (no orphan).
    const user = userEvent.setup();
    await seedMember();
    renderAt('/accounts/new');
    // Wait for the household member load to hydrate the owner select, or the async setForm can race the field edits and reset other fields.
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
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    await waitFor(async () => {
      const pending = await listPendingMutations();
      expect(pending).toHaveLength(2);
    });
    const ordered = await listPendingMutations();
    expect(ordered[0].operation).toBe('create');
    expect(ordered[0].aggregateType).toBe('account');
    expect(ordered[1].operation).toBe('create');
    expect(ordered[1].aggregateType).toBe('accountBalance');
    expect(ordered[0].timestamp).toBeLessThan(ordered[1].timestamp);
    // The deterministic id lets a later real current-year balance update the seed in place.
    const year = new Date().getUTCFullYear();
    expect(ordered[1].aggregateId).toBe(`bal-${ordered[0].aggregateId}-${year}`);
    const seed = ordered[1].payload as AccountBalancePayload;
    expect(seed.endingBalance).toBe(0);
    expect(seed.startingBalance).toBe(0);
    expect(seed.totalContributions).toBe(0);
    expect(seed.year).toBe(year);
  });

  it('surfaces partial-success when the $0 seed write fails after the account succeeds', async () => {
    // The only reachable partial failure (account saved, seed not) is benign: show "Account created — add a balance…", not "Failed to save account", and do not close with a failure.
    const user = userEvent.setup();
    await seedMember();
    const onClose = vi.fn();
    render(
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
    // Reject only the second queued mutation (the balance seed); the first passes through to the real implementation.
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
    const pending = await listPendingMutations();
    expect(pending.some((m) => m.aggregateType === 'account')).toBe(true);
    expect(onClose).not.toHaveBeenCalledWith(true);
  });

  it('shows the Mixed Roth-designated vs after-tax help text when Mixed is selected', async () => {
    const user = userEvent.setup();
    await seedMember();
    renderAt('/accounts/new');
    await waitFor(() =>
      expect(screen.getByLabelText('Owner')).toHaveTextContent('Alex (you)'),
    );
    await user.click(screen.getByLabelText('Account type'));
    await user.click(await screen.findByRole('option', { name: '401(k)' }));
    await user.click(screen.getByLabelText('Tax treatment'));
    await user.click(await screen.findByRole('option', { name: 'Mixed' }));
    // The help text must not promise §408A contributions-first ordering for designated-Roth money.
    expect(
      await screen.findByText(/post-tax side is a Roth-designated slice/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/post-tax side is plain after-tax savings/i),
    ).toBeInTheDocument();
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
    // Regression: the update branch overwrote the built payload's assetMix with `existing.payload.assetMix`, dropping every edit.
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
    // The disable guard gates only the active true→false transition: saving an already-inactive account without touching Active is allowed even with a linked income stream.
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
    // A non-zero, income-linked account surfaces the more feature-relevant /income remediation first.
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
    expect(await screen.findByText(/5-year Roth rule/i)).toBeInTheDocument();
    expect(
      await screen.findByText(/Locked to Tax-free \(Roth\) for this account type/i),
    ).toBeInTheDocument();
  });

  it('grouped account-type picker exposes section headings and all four Roth employer options (a11y smoke)', async () => {
    const user = userEvent.setup();
    await seedMember();
    renderAt('/accounts/new');
    await waitFor(() =>
      expect(screen.getByLabelText('Owner')).toHaveTextContent('Alex (you)'),
    );
    await user.click(screen.getByLabelText('Account type'));
    await screen.findByText('Traditional (pre-tax)');
    expect(screen.getByText('Roth')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Roth 401(k)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Roth 403(b)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Roth 457(b)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Roth TSP' })).toBeInTheDocument();
  });
});

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
    // Absent, not 0: the engines' conservative default depends on absence.
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
      // Shapes this editor never writes but an import or an older build could leave behind.
      rothIraFirstContributionTaxYear: 9999,
      rothIraRegularContributionBasis: -5,
    });
    renderAt('/accounts/acc-1/edit');
    await screen.findByRole('button', { name: 'Advanced tax details' });
    await userEvent.click(screen.getByRole('button', { name: 'Advanced tax details' }));
    await userEvent.click(screen.getByRole('button', { name: /Enter a year.*Year of your first Roth IRA contribution/ }));
    expect(screen.getByLabelText('Year of your first Roth IRA contribution')).toHaveValue('');
    expect(screen.queryByLabelText('Total contributions made so far')).toBeNull();
    expect(screen.getByRole('button', { name: 'Advanced tax details' })).toBeInTheDocument();
  });

  it('an inherited Roth IRA asks for the ORIGINAL OWNER’s contribution year, not the beneficiary’s', async () => {
    // An inherited account's `rothIraFirstContributionTaxYear` is the decedent's five-year clock (never merged with the beneficiary's own), so the field must ask for the original owner's year; a too-early answer makes growth look tax-free years early.
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
    // Scoped to the blocker list items: the same phrases also label the fields.
    const blockerItems = screen
      .getAllByRole('listitem')
      .map((li) => li.textContent?.trim());
    // The list is the engine's own withhold reasons: the three baseline facts every post-death rule needs, and nothing that depends on a rule not yet selected.
    expect(blockerItems).toContain('Who inherited this account');
    expect(blockerItems).toContain("The original owner's date of death");
    expect(blockerItems).toContain(
      'Whether the original owner had reached their RMD start date',
    );
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
    // An out-of-range year must not silently vanish from the payload and be read by the engines as "nothing recorded".
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
    // The mock is shared across this file's tests, so compare against the count entering this test.
    expect(mutations.mock.calls.length).toBe(callsBefore);
  });

  it('collects inherited dates through the shared date picker, not a free-text field', async () => {
    await seedMember();
    await seedAccount(true, {
      type: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      rmdInheritedAccount: true,
      rmdInheritedOwnerDeathDate: '2023-04-02',
    });
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));
    const deathDate = await screen.findByRole('group', {
      name: "Original owner's date of death",
    });
    expect(deathDate).toHaveTextContent('4/2/2023');
    expect(
      screen.queryByRole('textbox', { name: "Original owner's date of death" }),
    ).toBeNull();
    {
      const name = "Original owner's date of birth";
      expect(screen.getByRole('group', { name })).toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name })).toBeNull();
    }
    expect(screen.queryByText('Format: YYYY-MM-DD.')).toBeNull();
  });

  it('an employer plan offers no rollover editor here and points at the yearly balances', async () => {
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
    expect(document.querySelector('fieldset')).toBeNull();
  });

  it('surfaces the NEXT engine blocker as soon as the baseline inherited facts are supplied', async () => {
    const user = userEvent.setup();
    await seedMember();
    await seedAccount(true, {
      type: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
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
    // Conversions are recorded per year on the Account Balances page; a second entry point once made a conversion typed there do nothing.
    const user = userEvent.setup();
    await seedMember();
    await seedAccount(true, { type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH' });
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));

    expect(screen.queryByRole('group', { name: /converted into this Roth IRA/i })).toBeNull();
    // Must track the current balances-page label: pinned to the retired wording, the assertion passed no matter what.
    expect(screen.queryByLabelText(/Roth Conversion \(taxable\)/i)).toBeNull();
    expect(screen.getByText(/recorded on this account’s yearly balances/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(queueGuardedAccountUpdate).toHaveBeenCalled());
    const payload = (await getAggregate('account', 'acc-1'))?.payload as AccountPayload;
    expect('rothIraConversionLots' in payload).toBe(false);
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

// Retype blocking: an account's type is fixed once it has real balance history. Cases seed balance rows into the store and render the modal with no `balances` prop, the reachable shape on a cold deep link where the prop can still be `[]`.

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

  async function seedQualifyingRow(): Promise<void> {
    await putRow(2020, { totalContributions: 6_000, endingBalance: 6_000 });
  }

  async function chooseType(user: ReturnType<typeof userEvent.setup>, label: string) {
    await user.click(screen.getByLabelText('Account type'));
    await user.click(await screen.findByRole('option', { name: label }));
  }

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
    const savings = screen.getByRole('option', { name: 'Savings' });
    expect(savings.className).toMatch(/text-muted/);
    expect(savings).toHaveAccessibleDescription(/already has balance history/i);
  });

  it('the open-time verdict resolves BEFORE the loading gate lifts — no option renders ahead of it', async () => {
    await seedAccount(true);
    await seedQualifyingRow();
    let releaseBalanceRead!: () => void;
    retypeReadGate.balanceRead = new Promise<void>((resolve) => {
      releaseBalanceRead = resolve;
    });
    try {
      renderAt('/accounts/acc-1/edit');
      // Let every other microtask of the hydration effect settle while the balance read stays parked: a regression that fires the read without awaiting it would show the hydrated form ahead of the verdict.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(screen.queryByLabelText('Account name')).toBeNull();
      expect(screen.getByRole('status')).toHaveTextContent('Loading account…');

      const user = userEvent.setup();
      await act(async () => {
        releaseBalanceRead();
        // A macrotask boundary drains the microtask chain the released read resumes through.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

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

    // The role="status" region is mounted the whole time, so it never arrives already populated.
    const region = screen.getByRole('status');
    await chooseType(user, 'Roth IRA');
    await waitFor(() => expect(region).toHaveTextContent(/already has balance history/i));
    const node1 = within(region).getByText(/already has balance history/i);
    expect(screen.getByLabelText('Account type')).toHaveTextContent('401(k)');
    expect(await listPendingMutations()).toHaveLength(0);

    await chooseType(user, 'Roth IRA');
    await waitFor(() => {
      // The inner node is replaced (fresh key), not re-rendered with the same text, since many screen readers do not re-announce the latter.
      const node2 = within(region).getByText(/already has balance history/i);
      expect(node2).not.toBe(node1);
    });
  });

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
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(await listPendingMutations()).toHaveLength(0);
  });

  it('does not ask when the account is ALREADY persisted as the picked type — no read at all', async () => {
    const user = userEvent.setup();
    await seedAccount(true, { type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH' });
    await seedQualifyingRow();
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));
    await chooseType(user, 'Roth IRA');
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

  it('pick-time discovery: a qualifying row written after open refuses the pick and re-marks the options for the rest of the session', async () => {
    const user = userEvent.setup();
    await seedAccount(true);
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));

    // Second-tab shape: a qualifying row lands in IDB with no cross-tab signal.
    await seedQualifyingRow();

    await chooseType(user, 'Roth IRA');
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/already has balance history/i),
    );
    expect(screen.getByLabelText('Account type')).toHaveTextContent('401(k)');
    expect(await listPendingMutations()).toHaveLength(0);

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

    let releaseBalanceRead!: () => void;
    retypeReadGate.balanceRead = new Promise<void>((resolve) => {
      releaseBalanceRead = resolve;
    });
    try {
      await chooseType(user, 'Roth IRA');
      // A qualifying row lands only now, so the second (live) read resolves 'blocked' while the first (superseded) resolves 'clear'; without a supersession guard the first would still apply.
      await seedQualifyingRow();
      await chooseType(user, 'Savings');
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled(),
      );

      await act(async () => {
        releaseBalanceRead();
        // A macrotask boundary drains the microtask chain both released reads resume through.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

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
      expect(await listPendingMutations()).toHaveLength(0);
    } finally {
      releaseBalanceRead();
      retypeReadGate.balanceRead = null;
    }
  });

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

  it('save-time backstop: a qualifying row lands after an allowed pick — Update is refused with the blocked copy and nothing is queued', async () => {
    const user = userEvent.setup();
    await seedAccount(true);
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));

    await chooseType(user, 'Roth IRA');
    await waitFor(() =>
      expect(screen.getByLabelText('Account type')).toHaveTextContent('Roth IRA'),
    );

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

    // Another device retypes the account while this editor stays open (the accepted cross-device window); this tab only reads it in the save transaction.
    const current = (await getAggregate('account', 'acc-1')) as Aggregate<AccountPayload>;
    await putAggregate('account', {
      ...current,
      version: 2,
      payload: { ...current.payload, type: 'RETIREMENT_ROTH_IRA' },
    });

    fireEvent.change(screen.getByLabelText('Account name'), {
      target: { value: 'My 401k (renamed)' },
    });

    await user.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /This account already has balance history, so its type can.t be changed/i,
      ),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/Set the type back to Roth IRA/i);
    expect(await listPendingMutations()).toHaveLength(0);

    await user.click(screen.getByLabelText('Account type'));
    expect(screen.getByRole('option', { name: 'Roth IRA' })).toHaveAccessibleDescription('');
    // 401(k) is still the form's current value, so `Select` suppresses its description; its unavailable styling is the recovery signal.
    expect(screen.getByRole('option', { name: '401(k)' }).className).toMatch(/text-muted/);

    await user.click(screen.getByRole('option', { name: 'Roth IRA' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Account type')).toHaveTextContent('Roth IRA'),
    );
    expect(screen.getByRole('status')).toBeEmptyDOMElement();

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

    // Fail only the second `accountBalances` read: the first is onSave's early read, the second the guarded write's in-transaction read.
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

  // None of these asserts focus right after the type listbox closes inside the modal: React Aria's `useDialog` re-focuses the dialog from a 500 ms timer, and the listbox restores focus a frame after the popover is removed (jsdom reports `<body>` then).
  // A test closing the listbox about 500 ms after the dialog opened can lose that race; the restore target is covered by `Select.test.tsx`.

  it('accessibility: the open listbox in the blocked state has no axe violations', async () => {
    const user = userEvent.setup();
    await seedAccount(true);
    await seedQualifyingRow();
    renderAt('/accounts/acc-1/edit');
    await waitFor(() => expect(screen.getByLabelText('Account name')).toHaveValue('My 401k'));

    screen.getByLabelText('Account type').focus();
    await user.keyboard('{Enter}');
    const listbox = await screen.findByRole('listbox');
    // Wait for the open-time history read so the scan sees the blocked markup.
    await waitFor(() =>
      expect(within(listbox).getByRole('option', { name: 'Roth IRA' })).toHaveAccessibleDescription(
        /already has balance history/i,
      ),
    );
    // React Aria portals the dialog and listbox to `document.body`, not RTL's `container`.
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

    await user.keyboard('Roth IRA');
    const rothIra = screen.getByRole('option', { name: 'Roth IRA' });
    await waitFor(() => expect(rothIra).toHaveFocus());
    expect(rothIra.className).toMatch(/text-muted/);

    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/already has balance history/i),
    );
    expect(trigger).toHaveTextContent('401(k)');
    expect(await listPendingMutations()).toHaveLength(0);
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
    // Closed-trigger typeahead selects without opening the listbox, so the refusal is the only code that could move focus.
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
