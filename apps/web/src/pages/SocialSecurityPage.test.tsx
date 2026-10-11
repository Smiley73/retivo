/**
 * SocialSecurityPage render tests.
 *
 * Drives IndexedDB through fake-indexeddb and asserts the empty,
 * populated, and adult-only render paths.
 */
import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllStores, putAggregate } from '../db/store';
import type {
  Aggregate,
  HouseholdMemberPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));
// Spy on queueLocalMutation so the future-statement-date test can assert the
// save was BLOCKED (never queued) — no test in this file wants a real push.
vi.mock('../sync/mutation-queue', () => ({
  queueLocalMutation: vi.fn().mockResolvedValue(undefined),
}));

import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { queueLocalMutation } from '../sync/mutation-queue';
import { SocialSecurityPage } from './SocialSecurityPage';

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
      <SocialSecurityPage />
    </MemoryRouter>,
  );
}

async function seedMember(
  id: string,
  isPrimary: boolean,
  birthdate: string,
  firstName = 'Alex',
  lastName = 'Demo',
): Promise<void> {
  const m: Aggregate<HouseholdMemberPayload> = {
    id,
    householdId: HH,
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      isPrimary,
      firstName,
      lastName,
      email: `${id}@example.test`,
      birthdate,
    },
  };
  await putAggregate('householdMember', m);
}

async function seedSsa(
  memberId: string,
  pia: number,
  notes: string | null = null,
  piaAsOfDate = '2026-01-15',
): Promise<void> {
  const ss: Aggregate<SocialSecurityBenefitPayload> = {
    id: `ss-${memberId}`,
    householdId: HH,
    aggregateType: 'socialSecurityBenefit',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      householdMemberId: memberId,
      pia,
      piaAsOfDate,
      notes,
    },
  };
  await putAggregate('socialSecurityBenefit', ss);
}

describe('SocialSecurityPage', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders the empty-state when no adult members exist', async () => {
    await clearAllStores();
    renderPage();
    expect(
      await screen.findByText(/No adult household members/i),
    ).toBeInTheDocument();
  });

  it('renders one row per adult member with Add button when no benefit exists', async () => {
    await clearAllStores();
    await seedMember('hm-primary', true, '1985-04-15', 'Alex', 'Primary');
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('Alex (primary)')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
  });

  it('renders Edit/Delete buttons and derived amounts when a benefit exists', async () => {
    await clearAllStores();
    await seedMember('hm-primary', true, '1985-04-15', 'Alex', 'Primary');
    await seedSsa('hm-primary', 3000);
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /^Edit/ }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^Delete/ })).toBeInTheDocument();
    // At-FRA cell: member born 1985-04-15 → FRA 67 → monthlyBenefitAtAge(3000, 804, 804) = $3,000.
    expect(screen.getByText('$3,000')).toBeInTheDocument();
  });

  it('renders the out-of-scope disclosure note card', async () => {
    await clearAllStores();
    await seedMember('hm-primary', true, '1985-04-15', 'Alex', 'Primary');
    renderPage();
    // Wait for page to finish loading (member row present)
    await waitFor(() =>
      expect(screen.getByText('Alex (primary)')).toBeInTheDocument(),
    );
    // The disclosure card is a role="note" region with plainEnglish out-of-scope copy.
    const note = screen.getByRole('note');
    expect(note).toBeInTheDocument();
    expect(note.textContent).toContain('not modeled');
    // Accurate WEP/GPO wording: the offsets were REPEALED (not "not modeled")
    // by the Social Security Fairness Act.
    expect(note.textContent).toContain('repealed by the Social Security Fairness Act');
    // The earnings test IS applied before FRA; own-retirement and spousal
    // withheld months ARE restored at FRA, while survivor-benefit withheld
    // months are NOT (a disclosed qualification) — the note states
    // all three accurately.
    expect(note.textContent).toContain('earnings test');
    expect(note.textContent).toContain(
      'own retirement benefit or a spousal benefit are restored at full retirement age',
    );
    expect(note.textContent).toContain(
      'months withheld from a survivor benefit are not restored',
    );
    // Survivor benefits key off the SEPARATE survivor claim age and are
    // withheld (left out) until it is set — the note discloses that.
    expect(note.textContent).toContain('survivor claim age');
  });

  it('skips minors (<18) from the table', async () => {
    await clearAllStores();
    await seedMember('hm-adult', true, '1985-04-15', 'Alex', 'Primary');
    await seedMember('hm-kid', false, '2020-04-15', 'Kid', 'Person');
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('Alex (primary)')).toBeInTheDocument(),
    );
    expect(screen.queryByText(/^Kid/i)).not.toBeInTheDocument();
  });

  it('renders the table inside a React Aria grid landmark', async () => {
    await clearAllStores();
    await seedMember('hm-primary', true, '1985-04-15', 'Alex', 'Primary');
    await seedSsa('hm-primary', 3000, 'COLA-adjusted');
    renderPage();
    const grid = await screen.findByRole('grid', {
      name: 'Social Security benefits per household member',
    });
    expect(grid).toBeInTheDocument();
    // Same race as the arrow-key test below: the grid can resolve carrying only its
    // header row, so re-query inside waitFor rather than asserting once.
    await waitFor(() => {
      expect(within(grid).getAllByRole('row').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('shows the Notes indicator only when the benefit row has non-empty notes', async () => {
    await clearAllStores();
    await seedMember('hm-with-notes', true, '1985-04-15', 'Alex', 'Primary');
    await seedMember('hm-no-notes', false, '1986-02-10', 'Sam', 'Secondary');
    await seedSsa('hm-with-notes', 3000, 'COLA-adjusted');
    await seedSsa('hm-no-notes', 2500, '');
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('Alex (primary)')).toBeInTheDocument(),
    );
    const indicators = screen.getAllByRole('img', { name: 'Notes' });
    expect(indicators).toHaveLength(1);
  });

  it('renders the in-row Edit control as keyboard-focusable', async () => {
    // RA Table arrow-key model exercised by Adobe upstream; here we
    // sanity-check the in-row Edit button can hold focus.
    await clearAllStores();
    await seedMember('hm-primary', true, '1985-04-15', 'Alex', 'Primary');
    await seedSsa('hm-primary', 3000);
    renderPage();
    const edit = await screen.findByRole('button', { name: /^Edit/ });
    edit.focus();
    expect(edit).toHaveFocus();
  });

  it('exposes the React Aria Table grid for arrow-key navigation across rows', async () => {
    // jsdom can't reliably synthesize RA Table's focus-manager
    // events for grid ArrowUp/ArrowDown; the robust jsdom assertion is
    // that the grid's accessible name is queryable AND each row's
    // focusable Edit/Add descendant can independently hold focus — the
    // surface arrow-key navigation moves between. Real-DOM grid arrow
    // nav is covered by Adobe's upstream tests + a manual
    // walkthrough gate before merge.
    await clearAllStores();
    await seedMember('hm-primary', true, '1985-04-15', 'Alex', 'Primary');
    await seedMember('hm-secondary', false, '1986-02-10', 'Sam', 'Secondary');
    await seedSsa('hm-primary', 3000);
    // hm-secondary has no benefit → row renders an "Add" button.
    renderPage();
    const grid = await screen.findByRole('grid', {
      name: 'Social Security benefits per household member',
    });
    expect(grid).toBeInTheDocument();
    // findBy*, not getBy*: the grid resolving does not mean its ROWS have
    // rendered, and a synchronous get has no retry — this raced under CPU
    // load (reproduced 1-in-6 concurrently; seen on CI shard 2).
    const editBtn = await screen.findByRole('button', { name: /^Edit/ });
    const addBtn = await screen.findByRole('button', { name: 'Add' });
    editBtn.focus();
    expect(editBtn).toHaveFocus();
    addBtn.focus();
    expect(addBtn).toHaveFocus();
  });

  it('blocks Save with an inline error when the SSA statement date is in the future', async () => {
    await clearAllStores();
    await seedMember('hm-primary', true, '1985-04-15', 'Alex', 'Primary');
    // Seed a stored FUTURE statement date (previously saved / hand-synced bad
    // data). The modal's picker caps NEW selections at today, so the stored
    // value is the reachable future-date path in jsdom — Save must still
    // reject it: the date's year is the engine's COLA anchor, and a future
    // anchor would deflate near-term benefits.
    await seedSsa('hm-primary', 3000, null, '2099-01-01');
    renderPage();
    const edit = await screen.findByRole('button', { name: /^Edit/ });
    fireEvent.click(edit);
    const save = await screen.findByRole('button', { name: 'Save' });
    await act(async () => {
      fireEvent.click(save);
    });
    // Inline validation error renders inside the modal; the save is blocked
    // (nothing queued) and the modal stays open.
    expect(
      await screen.findByText(/"Date on the SSA statement" can't be in the future\./),
    ).toBeInTheDocument();
    expect(queueLocalMutation).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('re-derives on a fine store signal alone (putAggregate, no coarse event)', async () => {
    await clearAllStores();
    renderPage();
    expect(
      await screen.findByText(/No adult household members/i),
    ).toBeInTheDocument();

    // A single-row write fires only the per-store fine signal — no
    // notifyWorkspaceChanged() — proving the useAggregates subscription wakes.
    await act(async () => {
      await seedMember('hm-primary', true, '1985-04-15', 'Alex', 'Primary');
    });

    await waitFor(() =>
      expect(screen.getByText('Alex (primary)')).toBeInTheDocument(),
    );
  });
});
