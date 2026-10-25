// SocialSecurityPage empty, populated and adult-only render paths over fake-indexeddb.
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
// Spy on queueLocalMutation so the future-statement-date test can assert the save was blocked (never queued).
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
    expect(screen.getByText('$3,000')).toBeInTheDocument();
  });

  it('renders the out-of-scope disclosure note card', async () => {
    await clearAllStores();
    await seedMember('hm-primary', true, '1985-04-15', 'Alex', 'Primary');
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('Alex (primary)')).toBeInTheDocument(),
    );
    const note = screen.getByRole('note');
    expect(note).toBeInTheDocument();
    expect(note.textContent).toContain('not modeled');
    // The WEP/GPO offsets were repealed by the Social Security Fairness Act (not "not modeled").
    expect(note.textContent).toContain('repealed by the Social Security Fairness Act');
    // The note discloses that the earnings test is applied before FRA, own-retirement and spousal withheld months are restored at FRA, and survivor withheld months are not.
    expect(note.textContent).toContain('earnings test');
    expect(note.textContent).toContain(
      'own retirement benefit or a spousal benefit are restored at full retirement age',
    );
    expect(note.textContent).toContain(
      'months withheld from a survivor benefit are not restored',
    );
    // Survivor benefits key off the separate survivor claim age and are withheld until it is set.
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
    // The grid can resolve carrying only its header row, so re-query inside waitFor.
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
    await clearAllStores();
    await seedMember('hm-primary', true, '1985-04-15', 'Alex', 'Primary');
    await seedSsa('hm-primary', 3000);
    renderPage();
    const edit = await screen.findByRole('button', { name: /^Edit/ });
    edit.focus();
    expect(edit).toHaveFocus();
  });

  it('exposes the React Aria Table grid for arrow-key navigation across rows', async () => {
    // jsdom cannot synthesize React Aria Table's focus-manager events for grid arrow keys, so assert the grid's accessible name and that each row's Edit/Add control can hold focus.
    await clearAllStores();
    await seedMember('hm-primary', true, '1985-04-15', 'Alex', 'Primary');
    await seedMember('hm-secondary', false, '1986-02-10', 'Sam', 'Secondary');
    await seedSsa('hm-primary', 3000);
    renderPage();
    const grid = await screen.findByRole('grid', {
      name: 'Social Security benefits per household member',
    });
    expect(grid).toBeInTheDocument();
    // findBy: the grid resolving does not mean its rows have rendered; a synchronous get has no retry and raced under CPU load.
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
    // A stored future statement date (bad data saved or synced earlier) is the reachable future-date path in jsdom, since the picker caps new selections at today. Save must still reject it: the year is the engine's COLA anchor, and a future anchor would deflate near-term benefits.
    await seedSsa('hm-primary', 3000, null, '2099-01-01');
    renderPage();
    const edit = await screen.findByRole('button', { name: /^Edit/ });
    fireEvent.click(edit);
    const save = await screen.findByRole('button', { name: 'Save' });
    await act(async () => {
      fireEvent.click(save);
    });
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

    // A single-row write fires only the per-store signal, no notifyWorkspaceChanged(); the useAggregates subscription must still wake.
    await act(async () => {
      await seedMember('hm-primary', true, '1985-04-15', 'Alex', 'Primary');
    });

    await waitFor(() =>
      expect(screen.getByText('Alex (primary)')).toBeInTheDocument(),
    );
  });
});
