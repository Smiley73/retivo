/**
 * IncomePage empty-state render test.
 *
 * Locks the single-CTA empty state: with an empty income store the
 * page shows the "No income sources yet" helper copy and the ONLY
 * "Add" call-to-action is the PageHeader primary action — there is no
 * in-card Add button duplicating it. Drives IndexedDB through
 * fake-indexeddb; Auth/Sync mocked at the module boundary.
 */
import 'fake-indexeddb/auto';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllStores, putAggregate } from '../db/store';
import type {
  Aggregate,
  HouseholdMemberPayload,
  IncomeStreamPayload,
} from '../db/types';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));

import React from 'react';
import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { IncomePage } from './IncomePage';

const HH = 'hh-test';

function setupContexts(): void {
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

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <IncomePage />
    </MemoryRouter>,
  );
}

function renderPageAt(path: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <IncomePage />
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

describe('IncomePage — empty state', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders the single-CTA empty state when no income sources exist', async () => {
    await seedMember();
    renderPage();

    // (a) Helper copy renders.
    const helper = await screen.findByText(/No income sources yet/i);
    expect(helper).toBeInTheDocument();

    // (b) The PageHeader Add-income action is the ONLY "Add" CTA.
    await waitFor(() => {
      const addCtas = screen
        .getAllByRole('button')
        .filter((b) => /add/i.test(b.textContent ?? ''));
      expect(addCtas).toHaveLength(1);
    });
    const addBtn = screen.getByRole('button', { name: 'Add income source' });
    expect(addBtn).toBeInTheDocument();

    // (c) No in-card Add button — the empty-state card holds no buttons.
    const card = helper.closest('div');
    expect(card).not.toBeNull();
    expect(card?.querySelectorAll('button')).toHaveLength(0);
  });
});

async function seedIncomeStream(
  id: string,
  name: string,
  notes: string,
): Promise<void> {
  const stream: Aggregate<IncomeStreamPayload> = {
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
      annual: 12000,
      startMonth: '2030-01',
      payoutType: 'annuity',
      cola: 2,
      notes,
    } as IncomeStreamPayload,
  };
  await putAggregate('incomeStream', stream);
}

describe('IncomePage — React Aria Table + notes indicator', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders income sources inside a React Aria Table grid landmark', async () => {
    await seedMember();
    await seedIncomeStream('inc-1', 'ACME pension', 'COLA-adjusted');
    await seedIncomeStream('inc-2', 'BetaCorp pension', '');
    renderPage();
    // Member name "Alex" anchors the per-member section.
    await waitFor(() => expect(screen.getByText('Alex')).toBeInTheDocument());
    const grid = await screen.findByRole('grid', {
      name: /Income sources for Alex/i,
    });
    expect(grid).toBeInTheDocument();
    // RA Table wires its row landmarks a tick after the grid mounts; under
    // parallel load the rows can lag the grid, so poll rather than read once.
    // 1 header + 2 data rows.
    await waitFor(() =>
      expect(within(grid).getAllByRole('row').length).toBeGreaterThanOrEqual(3),
    );
  });

  it('shows the Notes indicator only on income rows with non-empty notes', async () => {
    await seedMember();
    await seedIncomeStream('inc-1', 'ACME pension', 'COLA-adjusted');
    await seedIncomeStream('inc-2', 'BetaCorp pension', '');
    renderPage();
    await waitFor(() => expect(screen.getByText('ACME pension')).toBeInTheDocument());
    // The Notes indicator mounts with the row body, which can lag the name
    // cell under parallel load; poll until exactly one indicator renders.
    await waitFor(() =>
      expect(screen.getAllByRole('img', { name: 'Notes' })).toHaveLength(1),
    );
  });

  it('renders an in-row Edit control as keyboard-focusable', async () => {
    // RA Table grid keyboard model exercised by Adobe upstream; here
    // we sanity-check that an in-row Edit button can hold focus.
    await seedMember();
    await seedIncomeStream('inc-1', 'ACME pension', '');
    renderPage();
    await waitFor(() => expect(screen.getByText('ACME pension')).toBeInTheDocument());
    // The in-row Edit control can mount a tick after the name cell under
    // parallel load; poll until at least one Edit button is present.
    await waitFor(() =>
      expect(
        screen.getAllByRole('button', { name: 'Edit' }).length,
      ).toBeGreaterThanOrEqual(1),
    );
    const editBtns = screen.getAllByRole('button', { name: 'Edit' });
    editBtns[0].focus();
    expect(editBtns[0]).toHaveFocus();
  });

  it('exposes the React Aria Table grid for arrow-key navigation across rows', async () => {
    // jsdom can't reliably synthesize RA Table's focus-manager
    // events for grid ArrowUp/ArrowDown; the robust jsdom assertion is
    // that the grid's accessible name is queryable AND each row's
    // focusable Edit descendant can independently hold focus — the
    // surface arrow-key navigation moves between. Real-DOM grid arrow
    // nav is covered by Adobe's upstream tests + a manual
    // walkthrough gate before merge.
    await seedMember();
    await seedIncomeStream('inc-1', 'ACME pension', '');
    await seedIncomeStream('inc-2', 'BetaCorp pension', '');
    renderPage();
    const grid = await screen.findByRole('grid', {
      name: /Income sources for Alex/i,
    });
    expect(grid).toBeInTheDocument();
    // Each row carries its own Edit button — focus must be reachable
    // independently for AT users navigating with arrow keys. The per-row
    // controls mount a tick after the grid landmark under parallel load, so
    // poll until both rows' Edit buttons are present.
    await waitFor(() =>
      expect(
        screen.getAllByRole('button', { name: 'Edit' }).length,
      ).toBeGreaterThanOrEqual(2),
    );
    const editBtns = screen.getAllByRole('button', { name: 'Edit' });
    editBtns[0].focus();
    expect(editBtns[0]).toHaveFocus();
    editBtns[1].focus();
    expect(editBtns[1]).toHaveFocus();
  });
});

describe('IncomePage — reactive reads', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('re-derives on a fine store signal alone (putAggregate, no coarse event)', async () => {
    await seedMember();
    renderPage();
    expect(
      await screen.findByText(/No income sources yet/i),
    ).toBeInTheDocument();

    // A single-row write fires only the per-store fine signal — no
    // notifyWorkspaceChanged() — proving the useAggregates subscription wakes.
    await act(async () => {
      await seedIncomeStream('inc-1', 'ACME pension', '');
    });

    await waitFor(() =>
      expect(screen.getByText('ACME pension')).toBeInTheDocument(),
    );
  });
});

// ---------------------------------------------------------------------------
// Focus-restore tests.
// ---------------------------------------------------------------------------

describe('IncomePage — focus restore', () => {
  beforeEach(() => {
    setupContexts();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
    // Reset the real URL so a seeded focus param can't leak between tests.
    window.history.replaceState(null, '', '/');
  });

  it('scrolls to and focuses the row for the matching income stream after load', async () => {
    await seedMember();
    await seedIncomeStream('inc-focus', 'ACME pension', '');

    const scrollSpy = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollSpy;

    renderPageAt('/income?focusIncomeId=inc-focus');
    await screen.findByText('ACME pension');

    // The effect fires after loading completes.
    await waitFor(() => {
      expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'instant', block: 'nearest' });
    });

    // React Aria Table's grid pattern manages focus at the row (<tr>) level,
    // so the row receives focus (not the button inside the cell).
    await waitFor(() => {
      const row = document.querySelector(`tr[data-income-id="inc-focus"]`);
      expect(document.activeElement).toBe(row);
    });
  });

  it('strips the focusIncomeId param from the URL after restoration', async () => {
    await seedMember();
    await seedIncomeStream('inc-strip', 'Strip stream', '');

    // Seed the real URL with the param so the replaceState strip has
    // something to remove — MemoryRouter keeps its history in-memory and
    // never writes to window.location, so the assertion would otherwise
    // pass vacuously.
    window.history.replaceState(null, '', '/income?focusIncomeId=inc-strip');

    renderPageAt('/income?focusIncomeId=inc-strip');
    await screen.findByText('Strip stream');

    await waitFor(() => {
      expect(window.location.search).not.toContain('focusIncomeId');
    });
  });

  it('strips the param but does nothing else when the id matches no row', async () => {
    await seedMember();
    await seedIncomeStream('inc-real', 'Real stream', '');

    const scrollSpy = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollSpy;

    // Seed the real URL so the strip assertion is meaningful.
    window.history.replaceState(null, '', '/income?focusIncomeId=inc-missing');

    renderPageAt('/income?focusIncomeId=inc-missing');
    await screen.findByText('Real stream');

    await waitFor(() => {
      expect(window.location.search).not.toContain('focusIncomeId');
    });
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('is a no-op for an invalid id containing selector metacharacters', async () => {
    await seedMember();
    await seedIncomeStream('inc-real', 'Real stream', '');

    const scrollSpy = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollSpy;

    // `%5B` = `[` — a selector metacharacter; regex guard must reject it.
    // Seed the real URL so the strip assertion is meaningful.
    window.history.replaceState(null, '', '/income?focusIncomeId=bad%5Bid');

    renderPageAt('/income?focusIncomeId=bad%5Bid');
    await screen.findByText('Real stream');

    await waitFor(() => {
      expect(window.location.search).not.toContain('focusIncomeId');
    });
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('navigates to the encoded returnTo URL when the row Edit button is clicked', async () => {
    let capturedLocation = '';
    const LocationProbe: React.FC = () => {
      const loc = useLocation();
      capturedLocation = loc.pathname + loc.search;
      return null;
    };

    await seedMember();
    await seedIncomeStream('inc-nav', 'Nav pension', '');

    render(
      <MemoryRouter initialEntries={['/income']}>
        <LocationProbe />
        <Routes>
          <Route path="/income" element={<IncomePage />} />
          <Route path="/income/:id/edit" element={<div>edit form</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Nav pension');

    const editBtn = await screen.findByRole('button', { name: 'Edit' });
    await userEvent.click(editBtn);

    await waitFor(() => {
      expect(capturedLocation).toBe(
        '/income/inc-nav/edit?returnTo=%2Fincome%3FfocusIncomeId%3Dinc-nav',
      );
    });
  });

  it('Add income source navigation is not affected by the restore feature', async () => {
    let capturedLocation = '';
    const LocationProbe: React.FC = () => {
      const loc = useLocation();
      capturedLocation = loc.pathname + loc.search;
      return null;
    };

    await seedMember();

    render(
      <MemoryRouter initialEntries={['/income']}>
        <LocationProbe />
        <Routes>
          <Route path="/income" element={<IncomePage />} />
          <Route path="/income/new" element={<div>new form</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText(/No income sources yet/i);

    const addBtn = screen.getByRole('button', { name: 'Add income source' });
    await userEvent.click(addBtn);

    await waitFor(() => {
      expect(capturedLocation).toBe('/income/new');
    });
  });
});
