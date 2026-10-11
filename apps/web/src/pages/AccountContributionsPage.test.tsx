/**
 * AccountContributionsPage render tests.
 *
 * Drives IndexedDB through fake-indexeddb and verifies the empty,
 * populated paths, plus the Save-only-when-dirty header behavior.
 * The math is covered in `lib/contributions-calc.test.ts` — this file
 * just checks the page wires reads / drafts / save through correctly.
 */
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
    // Save header button is hidden in clean state.
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('renders an editable row per account when accounts exist', async () => {
    await seedMember();
    await seedAccount('acc-1', 'My 401k', 'PRE_TAX', 22500, 0);
    renderPage();
    await waitFor(() => expect(screen.getByText('My 401k')).toBeInTheDocument());
    // The labelled input cell can mount a tick after the name cell under
    // parallel load; `findByLabelText` retries until it is present.
    expect(
      await screen.findByLabelText(/My 401k planned pre-tax/i),
    ).toBeInTheDocument();
  });

  it('no longer shows the stale flat-nominal contribution hint (contributions now track inflation)', async () => {
    // Contributions are inflation-indexed
    // by default, so the old "projected as a flat amount … increase manually"
    // hint is removed. Assert its absence (the planning-target + IRS-limit
    // guidance below still renders — see the next test).
    await seedMember();
    await seedAccount('acc-1', 'My 401k', 'PRE_TAX', 22500, 0);
    renderPage();
    // Wait for the page to settle on a stable element, then assert absence.
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
    // Explicit statement that the app does not enforce statutory IRS limits.
    expect(
      await screen.findByText(/does not enforce the statutory IRS contribution limits/i),
    ).toBeInTheDocument();
    // Planning-target wording replaces "headroom" — the subtitle uses it; assert
    // no "headroom" wording survives on the page.
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
    // Pre-tax account planned $1,000 but $5,000 already contributed →
    // pre-tax + total remaining = −$4,000 (over-contributed). The
    // post-tax side has nothing planned (remaining $0, ≥ 0) so it
    // keeps the "Remaining" wording — only the negative tiles flip.
    await seedAccount('acc-pre', 'My 401k', 'PRE_TAX', 1000, 0);
    await seedBalance('acc-pre', 5000);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('My 401k')).toBeInTheDocument(),
    );
    // Scope to the stat-tile grid — the per-account table rows still
    // show the signed value (abs() is the Overpaid-tile branch
    // only, the table is unchanged).
    const grid = within(
      screen.getByLabelText('Annual contributions summary'),
    );
    // Over-contributed tiles relabel to "… Overpaid".
    expect(grid.getByText('Total Overpaid')).toBeInTheDocument();
    expect(grid.getByText('Pre-Tax Overpaid')).toBeInTheDocument();
    // The non-negative post-tax side keeps "Remaining".
    expect(grid.getByText('Post-Tax Remaining')).toBeInTheDocument();
    expect(grid.queryByText('Total Remaining')).not.toBeInTheDocument();
    expect(grid.queryByText('Pre-Tax Remaining')).not.toBeInTheDocument();
    // Absolute value (no minus sign) on the over-contributed tiles —
    // Total + Pre-Tax both read $4,000.
    expect(grid.getAllByText('$4,000')).toHaveLength(2);
    expect(grid.queryByText('-$4,000')).not.toBeInTheDocument();
  });

  it('renders a single-row header with compound "Remaining *" column names', async () => {
    // The legacy two-row grouped header (Remaining colSpan parent over
    // Pre-tax / Post-tax / Total leaves) collapses to compound names:
    // the grouping survives in the accessible name, the
    // visual two-row hierarchy disappears. The "Remaining" group word
    // stacks visually over its leaf (no em-dash); the accessible name
    // joins the two with a single space.
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
    // RA Table renders role="grid" + aria-label; the editable
    // MoneyInput stays the first focusable in-row control. Full
    // arrow-key keyboard model is jsdom-brittle (RA's grid focus
    // delegate fires browser-level events) and is covered by the
    // manual keyboard check (Chromium / Firefox / Safari).
    await seedMember();
    await seedAccount('acc-1', 'My 401k', 'PRE_TAX', 22500, 0);
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByRole('grid', { name: 'Annual contributions per account' }),
      ).toBeInTheDocument(),
    );
    // The labelled input cell can mount a tick after the grid landmark under
    // parallel load; `findByLabelText` retries until it is present.
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
    // NotesIndicator surfaces an SVG with role="img" + aria-label
    // "Notes" — one per row whose notes is non-empty. The indicator mounts
    // with the row body, which can lag the name cell under parallel load;
    // poll until exactly one indicator renders.
    await waitFor(() =>
      expect(screen.getAllByRole('img', { name: 'Notes' })).toHaveLength(1),
    );
  });

  it('shows the non-numeric "Match inflation" placeholder when no rate is set (household)', async () => {
    // This page has no scenario context (reads accounts/balances/members
    // only), so the empty annual-increase placeholder is the non-numeric
    // copy "Match inflation" — no resolved %.
    await seedMember();
    await seedAccount('acc-1', 'My 401k', 'PRE_TAX', 22500, 0);
    renderPage();
    await waitFor(() => expect(screen.getByText('My 401k')).toBeInTheDocument());
    const placeholder = await screen.findByRole('button', {
      name: /My 401k annual increase — match inflation \(set a rate\)/i,
    });
    expect(placeholder).toHaveTextContent('Match inflation');
    // No numeric annual-increase input until a rate is set.
    expect(
      screen.queryByLabelText('My 401k annual increase'),
    ).not.toBeInTheDocument();
  });

  it('persists an explicit annual-increase rate to contributionGrowthPct (household)', async () => {
    await seedMember();
    await seedAccount('acc-1', 'My 401k', 'PRE_TAX', 22500, 0);
    renderPage();
    await waitFor(() => expect(screen.getByText('My 401k')).toBeInTheDocument());
    // Begin editing (placeholder → 0), then type a rate.
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
    // Clicking the placeholder sets an explicit 0 (flat-nominal) — a Save
    // is immediately available because 0 is distinct from absent.
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
    // A seeded explicit rate renders the input; the clear affordance drops
    // it back to absent (the field is omitted on save → tracks inflation).
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
    // Back to the placeholder.
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
    // An inactive account renders the "Match inflation" placeholder button
    // with `disabled={!a.active}` so its growth cannot be edited until the
    // account is reactivated.
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
    // This explicit-Save page is intentionally excluded from the
    // workspace-revision migration: its load effect resets
    // `baselineRef.current` + `setDrafts(...)`, so a revision re-read
    // would clobber unsaved per-account edits and mark them clean.
    await seedMember();
    await seedAccount('acc-1', 'My 401k', 'PRE_TAX', 22500, 0);
    renderPage();
    await waitFor(() => expect(screen.getByText('My 401k')).toBeInTheDocument());

    // The labelled input cell can mount a tick after the name cell under
    // parallel load; `findByLabelText` retries until it is present.
    const input = (await screen.findByLabelText(
      /My 401k planned pre-tax/i,
    )) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: '24000' } });
      fireEvent.blur(input);
    });
    // Dirty guard surfaces Save.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument(),
    );

    // A sync pull / demo fill / bootstrap commits mid-edit and dispatches
    // the workspace-change event.
    const { notifyWorkspaceChanged } = await import('../lib/workspace-events');
    await act(async () => {
      notifyWorkspaceChanged();
    });

    // The draft survives and the dirty guard still sees unsaved changes.
    expect(
      (screen.getByLabelText(/My 401k planned pre-tax/i) as HTMLInputElement)
        .value,
    ).toBe('24000.00');
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});
