// AccountContributionsPage: empty and populated reads and the Save-only-when-dirty header; the math is in `lib/contributions-calc.test.ts`.
import 'fake-indexeddb/auto';
import {
  render,
  screen,
  waitFor,
  within,
  fireEvent,
  act,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllStores,
  getAggregate,
  listPendingMutations,
  putAggregate,
} from '../db/store';
import { expectNoA11yViolations } from '../test/a11y';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));

import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { AccountContributionsPage } from './AccountContributionsPage';

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
      <AccountContributionsPage />
    </MemoryRouter>,
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
  treatment: AccountPayload['taxTreatment'],
  plannedPre = 0,
  plannedPost = 0,
  notes = '',
  growthPct?: number,
  active = true,
): Promise<void> {
  const payload: AccountPayload = {
    name,
    type: 'RETIREMENT_401K',
    ownershipType: 'INDIVIDUAL',
    taxTreatment: treatment,
    ownerId: 'hm-1',
    institution: 'Bank',
    notes,
    planningReturnPct: 7,
    active,
    plannedContributionPreTax: plannedPre,
    plannedContributionPostTax: plannedPost,
    assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
  };
  if (growthPct !== undefined) payload.contributionGrowthPct = growthPct;
  const acc: Aggregate<AccountPayload> = {
    id,
    householdId: HH,
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload,
  };
  await putAggregate('account', acc);
}

async function seedBalance(
  accountId: string,
  totalContributions: number,
): Promise<void> {
  const year = new Date().getUTCFullYear();
  const bal: Aggregate<AccountBalancePayload> = {
    id: `bal-${accountId}`,
    householdId: HH,
    aggregateType: 'accountBalance',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      accountId,
      year,
      lastUpdated: '2026-05-01',
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
      endingBalance: totalContributions,
      endingBalancePreTax: null,
      endingBalancePostTax: null,
      totalContributions,
      comment: null,
    },
  };
  await putAggregate('accountBalance', bal);
}

describe('AccountContributionsPage', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders the empty-state when no accounts exist', async () => {
    await seedMember();
    renderPage();
    expect(await screen.findByText(/No accounts yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('renders an editable row per account when accounts exist', async () => {
    await seedMember();
    await seedAccount('acc-1', 'My 401k', 'PRE_TAX', 22500, 0);
    renderPage();
    await waitFor(() => expect(screen.getByText('My 401k')).toBeInTheDocument());
    // The labelled input cell can mount a tick after the name cell under parallel load.
    expect(
      await screen.findByLabelText(/My 401k planned pre-tax/i),
    ).toBeInTheDocument();
  });

  it('no longer shows the stale flat-nominal contribution hint (contributions now track inflation)', async () => {
    // Contributions are inflation-indexed by default, so the old flat-amount "increase manually" hint must be gone.
    await seedMember();
    await seedAccount('acc-1', 'My 401k', 'PRE_TAX', 22500, 0);
    renderPage();
    await screen.findByText(/does not enforce the statutory IRS contribution limits/i);
    expect(
      screen.queryByText(/projected as a flat amount/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/keep pace with inflation/i),
    ).not.toBeInTheDocument();
  });

  it('uses planning-target wording and states statutory IRS limits are not enforced', async () => {
    await seedMember();
    await seedAccount('acc-1', 'My 401k', 'PRE_TAX', 22500, 0);
    renderPage();
    expect(
      await screen.findByText(/does not enforce the statutory IRS contribution limits/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/headroom/i)).toBeNull();
    expect(screen.getAllByText(/Remaining planned amount/i).length).toBeGreaterThan(0);
  });

  it('reveals Save and queues an update mutation after a draft change', async () => {
    await seedMember();
    await seedAccount('acc-1', 'My 401k', 'PRE_TAX', 22500, 0);
    renderPage();
    await waitFor(() => expect(screen.getByText('My 401k')).toBeInTheDocument());
    const input = screen.getByLabelText(/My 401k planned pre-tax/i) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: '24000' } });
      fireEvent.blur(input);
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(async () => {
      const pending = await listPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].operation).toBe('update');
      expect(pending[0].aggregateType).toBe('account');
    });
  });

  it('relabels an over-contributed Remaining tile as "Overpaid" with the absolute value', async () => {
    await seedMember();
    await seedAccount('acc-pre', 'My 401k', 'PRE_TAX', 1000, 0);
    await seedBalance('acc-pre', 5000);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('My 401k')).toBeInTheDocument(),
    );
    // Scoped to the tile grid: the per-account table rows still show the signed value.
    const grid = within(
      screen.getByLabelText('Annual contributions summary'),
    );
    expect(grid.getByText('Total Overpaid')).toBeInTheDocument();
    expect(grid.getByText('Pre-Tax Overpaid')).toBeInTheDocument();
    expect(grid.getByText('Post-Tax Remaining')).toBeInTheDocument();
    expect(grid.queryByText('Total Remaining')).not.toBeInTheDocument();
    expect(grid.queryByText('Pre-Tax Remaining')).not.toBeInTheDocument();
    expect(grid.getAllByText('$4,000')).toHaveLength(2);
    expect(grid.queryByText('-$4,000')).not.toBeInTheDocument();
  });

  it('renders a single-row header with compound "Remaining *" column names', async () => {
    // The accessible name joins the group word and the leaf with a single space; there is no visual two-row header.
    await seedMember();
    await seedAccount('acc-1', 'My 401k', 'PRE_TAX', 22500, 0);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('My 401k')).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('columnheader', { name: 'Remaining Pre-tax' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Remaining Post-tax' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Remaining Total' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Name' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Pre-Tax' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Post-Tax' }),
    ).toBeInTheDocument();
  });

  it('renders the RA grid landmark + a focusable in-row control', async () => {
    // The full arrow-key model is jsdom-brittle (React Aria's grid focus delegate fires browser-level events), so only the grid name and first in-row control are asserted.
    await seedMember();
    await seedAccount('acc-1', 'My 401k', 'PRE_TAX', 22500, 0);
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByRole('grid', { name: 'Annual contributions per account' }),
      ).toBeInTheDocument(),
    );
    // The labelled input cell can mount a tick after the grid landmark under parallel load.
    const input = await screen.findByLabelText(/My 401k planned pre-tax/i);
    expect(input).toBeInTheDocument();
  });

  it('renders <NotesIndicator> next to the account name when notes are set (parity with Accounts + AccountBalances pages)', async () => {
    await seedMember();
    await seedAccount('acc-notes', 'Notes 401k', 'PRE_TAX', 22500, 0, 'Roll over from old job');
    await seedAccount('acc-plain', 'Plain IRA', 'PRE_TAX', 7000, 0, '');
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('Notes 401k')).toBeInTheDocument(),
    );
    // The indicator mounts with the row body, which can lag the name cell under parallel load.
    await waitFor(() =>
      expect(screen.getAllByRole('img', { name: 'Notes' })).toHaveLength(1),
    );
  });

  it('shows the non-numeric "Match inflation" placeholder when no rate is set (household)', async () => {
    // This page has no scenario context, so the empty annual-increase placeholder is the non-numeric "Match inflation".
    await seedMember();
    await seedAccount('acc-1', 'My 401k', 'PRE_TAX', 22500, 0);
    renderPage();
    await waitFor(() => expect(screen.getByText('My 401k')).toBeInTheDocument());
    const placeholder = await screen.findByRole('button', {
      name: /My 401k annual increase — match inflation \(set a rate\)/i,
    });
    expect(placeholder).toHaveTextContent('Match inflation');
    expect(
      screen.queryByLabelText('My 401k annual increase'),
    ).not.toBeInTheDocument();
  });

  it('persists an explicit annual-increase rate to contributionGrowthPct (household)', async () => {
    await seedMember();
    await seedAccount('acc-1', 'My 401k', 'PRE_TAX', 22500, 0);
    renderPage();
    await waitFor(() => expect(screen.getByText('My 401k')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: /My 401k annual increase — match inflation \(set a rate\)/i,
        }),
      );
    });
    const input = (await screen.findByLabelText(
      'My 401k annual increase',
    )) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: '3' } });
      fireEvent.blur(input);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(async () => {
      const stored = (await getAggregate('account', 'acc-1')) as
        | Aggregate<AccountPayload>
        | null;
      expect(stored?.payload.contributionGrowthPct).toBe(3);
    });
  });

  it('persists an explicit 0% rate as flat-nominal (household)', async () => {
    await seedMember();
    await seedAccount('acc-1', 'My 401k', 'PRE_TAX', 22500, 0);
    renderPage();
    await waitFor(() => expect(screen.getByText('My 401k')).toBeInTheDocument());
    // An explicit 0 (flat-nominal) is distinct from absent, so Save is immediately available.
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: /My 401k annual increase — match inflation \(set a rate\)/i,
        }),
      );
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(async () => {
      const stored = (await getAggregate('account', 'acc-1')) as
        | Aggregate<AccountPayload>
        | null;
      expect(stored?.payload.contributionGrowthPct).toBe(0);
    });
  });

  it('clears an explicit rate back to the match-inflation default (household)', async () => {
    await seedMember();
    await seedAccount('acc-1', 'My 401k', 'PRE_TAX', 22500, 0, '', 5);
    renderPage();
    await waitFor(() => expect(screen.getByText('My 401k')).toBeInTheDocument());
    expect(
      await screen.findByLabelText('My 401k annual increase'),
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: /My 401k annual increase — clear \(match inflation\)/i,
        }),
      );
    });
    await screen.findByRole('button', {
      name: /My 401k annual increase — match inflation \(set a rate\)/i,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(async () => {
      const stored = (await getAggregate('account', 'acc-1')) as
        | Aggregate<AccountPayload>
        | null;
      expect(stored?.payload.contributionGrowthPct).toBeUndefined();
    });
  });

  it('clamps an annual-increase entry to the 25% cap (household)', async () => {
    await seedMember();
    await seedAccount('acc-1', 'My 401k', 'PRE_TAX', 22500, 0, '', 5);
    renderPage();
    await waitFor(() => expect(screen.getByText('My 401k')).toBeInTheDocument());
    const input = (await screen.findByLabelText(
      'My 401k annual increase',
    )) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: '99' } });
      fireEvent.blur(input);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(async () => {
      const stored = (await getAggregate('account', 'acc-1')) as
        | Aggregate<AccountPayload>
        | null;
      expect(stored?.payload.contributionGrowthPct).toBe(25);
    });
  });

  it('has no a11y violations with the annual-increase column rendered', async () => {
    await seedMember();
    await seedAccount('acc-1', 'My 401k', 'PRE_TAX', 22500, 0);
    await seedAccount('acc-2', 'My Roth', 'ROTH', 0, 7000, '', 4);
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText('My 401k')).toBeInTheDocument());
    await screen.findByLabelText('My Roth annual increase');
    await expectNoA11yViolations(container);
  });

  it('disables the annual-increase control on an inactive account', async () => {
    await seedMember();
    await seedAccount('acc-inactive', 'Old 401k', 'PRE_TAX', 22500, 0, '', undefined, false);
    renderPage();
    await waitFor(() => expect(screen.getByText('Old 401k')).toBeInTheDocument());
    const placeholder = await screen.findByRole('button', {
      name: /Old 401k annual increase — match inflation \(set a rate\)/i,
    });
    expect(placeholder).toBeDisabled();
  });

  it('does not discard an in-progress draft on WORKSPACE_CHANGED_EVENT (exclusion)', async () => {
    // This explicit-Save page is excluded from the workspace-revision migration: a revision re-read would clobber unsaved edits and mark them clean.
    await seedMember();
    await seedAccount('acc-1', 'My 401k', 'PRE_TAX', 22500, 0);
    renderPage();
    await waitFor(() => expect(screen.getByText('My 401k')).toBeInTheDocument());

    // The labelled input cell can mount a tick after the name cell under parallel load.
    const input = (await screen.findByLabelText(
      /My 401k planned pre-tax/i,
    )) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: '24000' } });
      fireEvent.blur(input);
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument(),
    );

    // A sync pull, demo fill or bootstrap commits mid-edit and dispatches the workspace-change event.
    const { notifyWorkspaceChanged } = await import('../lib/workspace-events');
    await act(async () => {
      notifyWorkspaceChanged();
    });

    expect(
      (screen.getByLabelText(/My 401k planned pre-tax/i) as HTMLInputElement)
        .value,
    ).toBe('24000.00');
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});
