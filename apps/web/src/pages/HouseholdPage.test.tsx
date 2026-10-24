// HouseholdPage over fake-indexeddb, with AuthContext and SyncContext mocked at the module boundary.
import 'fake-indexeddb/auto';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllStores, listAggregates, listPendingMutations, putAggregate } from '../db/store';
import { expectNoA11yViolations } from '../test/a11y';
import type { Aggregate, HouseholdMemberPayload } from '../db/types';

vi.mock('../auth/AuthContext', () => ({
  useAuth: vi.fn(),
}));

vi.mock('../sync/SyncContext', () => ({
  useSync: vi.fn(),
}));

import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { HouseholdPage } from './HouseholdPage';
import { btnPrimarySmClass, btnDangerSmClass } from './profile-page-chrome';

const HH = 'hh-test';
const ME_EMAIL = 'me@example.test';

function setupContexts() {
  (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    householdId: HH,
    me: { email: ME_EMAIL, displayName: 'Me', roles: [], userId: 'u-1' },
    isAuthenticated: true,
    hasRole: () => false,
  });
  (useSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    notifyPending: vi.fn(),
    state: { kind: 'synced', lastSyncedAt: null },
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <HouseholdPage />
    </MemoryRouter>,
  );
}

async function seedPrimary(): Promise<void> {
  const row: Aggregate<HouseholdMemberPayload> = {
    id: 'hm-primary',
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
  await putAggregate('householdMember', row);
}

async function seedSecondary(): Promise<void> {
  const row: Aggregate<HouseholdMemberPayload> = {
    id: 'hm-secondary',
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
      birthdate: '1987-09-20',
    },
  };
  await putAggregate('householdMember', row);
}

describe('HouseholdPage', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders the welcome card when no primary member exists', async () => {
    await clearAllStores();
    renderPage();
    expect(
      await screen.findByText(/add yourself as the primary member/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('First name')).toBeInTheDocument();
    expect(screen.getByLabelText('Birthdate')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save primary member' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load demo data/i })).not.toBeInTheDocument();
  });

  it('Save primary member writes a row + queues a create mutation with isPrimary=true', async () => {
    const user = userEvent.setup();
    await clearAllStores();
    renderPage();
    await screen.findByText(/add yourself as the primary member/i);
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Sam' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Saver' } });
    // Birthdate is the shared React Aria DatePicker: focus the first date segment and type the date (en-US MM DD YYYY); the adapter still emits the frozen YYYY-MM-DD string.
    const bdGroup = screen.getByRole('group', { name: 'Birthdate' });
    await user.click(within(bdGroup).getAllByRole('spinbutton')[0]);
    await user.keyboard('01011990');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save primary member' }));
    });
    await waitFor(async () => {
      const members = (await listAggregates('householdMember')) as Aggregate<HouseholdMemberPayload>[];
      expect(members).toHaveLength(1);
    });
    const members = (await listAggregates('householdMember')) as Aggregate<HouseholdMemberPayload>[];
    expect(members[0].payload.isPrimary).toBe(true);
    expect(members[0].payload.firstName).toBe('Sam');
    expect(members[0].payload.birthdate).toBe('1990-01-01');
    const pending = await listPendingMutations();
    expect(pending).toHaveLength(1);
    expect(pending[0].operation).toBe('create');
    expect(pending[0].aggregateType).toBe('householdMember');
    expect(pending[0].expectedVersion).toBe(0);
  });

  it('does not queue a primary member with a birthdate more than 120 years ago', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/add yourself as the primary member/i);
    const bdGroup = screen.getByRole('group', { name: 'Birthdate' });
    await user.click(within(bdGroup).getAllByRole('spinbutton')[0]);
    await user.keyboard('01011800');
    await user.click(screen.getByRole('button', { name: 'Save primary member' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Date of birth must be within the last 120 years.',
    );
    expect(await listPendingMutations()).toHaveLength(0);
  });

  it('does not queue a secondary member with a birthdate more than 120 years ago', async () => {
    const user = userEvent.setup();
    await seedPrimary();
    renderPage();
    await screen.findByText('Alex');
    const bdGroup = screen.getByRole('group', { name: 'Birthdate' });
    await user.click(within(bdGroup).getAllByRole('spinbutton')[0]);
    await user.keyboard('01011800');
    await user.click(screen.getByRole('button', { name: 'Add spouse' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Date of birth must be within the last 120 years.',
    );
    expect(await listPendingMutations()).toHaveLength(0);
  });

  it('does not queue an edit with a birthdate more than 120 years ago', async () => {
    const user = userEvent.setup();
    await seedPrimary();
    renderPage();
    await screen.findByText('Alex');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const bdGroup = document.getElementById('edit-hm-primary-bd');
    if (!bdGroup) throw new Error('edit birthdate picker not found');
    const segments = within(bdGroup).getAllByRole('spinbutton');
    await user.click(segments[0]);
    await user.keyboard('01011800');
    await user.click(screen.getByRole('button', { name: 'Update' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Date of birth must be within the last 120 years.',
    );
    expect(await listPendingMutations()).toHaveLength(0);
  });

  it('hides the welcome card after the primary member exists', async () => {
    await seedPrimary();
    renderPage();
    await waitFor(() => {
      expect(
        screen.queryByText(/add yourself as the primary member/i),
      ).not.toBeInTheDocument();
    });
    expect(await screen.findByText('Alex')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load demo data/i })).not.toBeInTheDocument();
  });

  it('shows the secondary form when only the primary exists', async () => {
    await seedPrimary();
    renderPage();
    await screen.findByText('Alex');
    expect(
      screen.getByRole('button', { name: 'Add spouse' }),
    ).toBeInTheDocument();
  });

  it('shows the spouse-only guidance in the primary-only state', async () => {
    await seedPrimary();
    const { container } = renderPage();
    await screen.findByText('Alex');
    expect(
      screen.getByText(
        /only add a second member if they are your legal spouse\. unmarried partners must use separate plans\./i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add your spouse' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/relationship/i)).not.toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('shows the spouse-only guidance and labels the secondary card "Spouse" when both members exist', async () => {
    await seedPrimary();
    await seedSecondary();
    renderPage();
    await screen.findByText('Sam');
    expect(
      screen.getByText(
        /only add a second member if they are your legal spouse\. unmarried partners must use separate plans\./i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Spouse' })).toBeInTheDocument();
    expect(screen.queryByText(/secondary member/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add spouse' })).not.toBeInTheDocument();
  });

  it('shows a friendly fallback instead of "Born unknown" when no birthdate is set', async () => {
    await putAggregate('householdMember', {
      id: 'hm-nobday',
      householdId: HH,
      aggregateType: 'householdMember',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        isPrimary: true,
        firstName: 'Riley',
        lastName: 'Nobday',
        email: 'riley@example.test',
        birthdate: '',
      },
    } as Aggregate<HouseholdMemberPayload>);
    renderPage();
    await screen.findByText('Riley');
    expect(screen.getByText(/Birth date not set/i)).toBeInTheDocument();
    expect(screen.queryByText(/Born unknown/i)).not.toBeInTheDocument();
  });

  it('member-card Edit uses the standalone compact primary class', async () => {
    await seedPrimary();
    await seedSecondary();
    renderPage();
    await screen.findByText('Sam');
    const editButtons = screen.getAllByRole('button', { name: 'Edit' });
    for (const btn of editButtons) {
      expect(btn).toHaveClass('px-2.5', 'py-1', 'text-xs');
      expect(btn).toHaveAttribute('class', `${btnPrimarySmClass} gap-1.5`);
    }
  });

  it('member-card Delete uses the standalone compact danger class and confirms', async () => {
    await seedPrimary();
    await seedSecondary();
    renderPage();
    await screen.findByText('Sam');
    const deleteBtn = screen.getByRole('button', { name: 'Delete' });
    expect(deleteBtn).toHaveClass('px-2.5', 'py-1', 'text-xs');
    expect(deleteBtn).toHaveAttribute('class', `${btnDangerSmClass} gap-1.5`);

    await userEvent.click(deleteBtn);
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByRole('button', { name: 'Delete' }),
    ).toBeInTheDocument();
  });
});

describe('HouseholdPage — reactive read layer', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('re-reads on WORKSPACE_CHANGED_EVENT without a remount', async () => {
    await clearAllStores();
    renderPage();
    expect(
      await screen.findByText(/add yourself as the primary member/i),
    ).toBeInTheDocument();

    // A bulk fill lands after mount, then the coarse workspace-change event.
    await seedPrimary();
    const { notifyWorkspaceChanged } = await import('../lib/workspace-events');
    await act(async () => {
      notifyWorkspaceChanged();
    });

    expect(await screen.findByText('Alex')).toBeInTheDocument();
    expect(
      screen.queryByText(/add yourself as the primary member/i),
    ).not.toBeInTheDocument();
  });

  it('re-reads on a fine-signal householdMember write (no coarse event)', async () => {
    await clearAllStores();
    renderPage();
    expect(
      await screen.findByText(/add yourself as the primary member/i),
    ).toBeInTheDocument();

    // A single-row putAggregate fires only the per-store signal.
    await act(async () => {
      await seedPrimary();
    });

    expect(await screen.findByText('Alex')).toBeInTheDocument();
  });
});

describe('HouseholdPage — dirty-guard stability under reactive re-reads', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  // `useUnsavedChangesGuard` installs a `beforeunload` handler only while dirty, and it calls preventDefault(); a cancelable beforeunload's `defaultPrevented` is the observable proxy, since the pushState patch can't be exercised under MemoryRouter's in-memory history.
  function isGuardActive(): boolean {
    const evt = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(evt);
    return evt.defaultPrevented;
  }

  it('keeps protecting the draft when a background write matches the edited values', async () => {
    const user = userEvent.setup();
    await clearAllStores();
    await seedPrimary();
    renderPage();
    await screen.findByText('Alex');

    expect(isGuardActive()).toBe(false);

    // Open the inline edit form so the baseline ("Alex") is captured. The add-secondary form also has a "First name" label, so target the edit form's prefixed input id.
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    const firstName = (await screen.findByLabelText('First name', {
      selector: '#edit-hm-primary-fn',
    })) as HTMLInputElement;
    expect(firstName).toHaveValue('Alex');

    await act(async () => {
      fireEvent.change(firstName, { target: { value: 'Alexandra' } });
    });
    await waitFor(() => expect(isGuardActive()).toBe(true));

    // A background write lands the editing member at the user's draft values (e.g. a sync echoing the same edit); with a stable baseline this must not reset the dirty state.
    await act(async () => {
      await putAggregate('householdMember', {
        id: 'hm-primary',
        householdId: HH,
        aggregateType: 'householdMember',
        schemaVersion: 1,
        version: 2,
        updatedAt: '2026-05-02T00:00:00Z',
        deviceId: 'dev-2',
        payload: {
          isPrimary: true,
          firstName: 'Alexandra',
          lastName: 'Primary',
          email: 'alex@example.test',
          birthdate: '1985-04-15',
        },
      } as Aggregate<HouseholdMemberPayload>);
    });

    // Dirty is measured against the captured baseline ("Alex"), not the re-read row; comparing against members.find would flip this false.
    expect(firstName).toHaveValue('Alexandra');
    expect(isGuardActive()).toBe(true);
  });
});
