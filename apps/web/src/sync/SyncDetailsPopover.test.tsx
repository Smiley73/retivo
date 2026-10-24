// The popover opens on a SyncBadge click in every state; each state is driven by mocking `useSync()`.
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button, DialogTrigger } from 'react-aria-components';
import { SyncDetailsPopover } from './SyncDetailsPopover';
import { expectNoA11yViolations } from '../test/a11y.js';

import type { PendingMutation } from '../db/types';

const forceRefresh = vi.fn();
const retryNow = vi.fn();
const syncRoundTrip = vi.fn();

vi.mock('./SyncContext.js', () => ({
  useSync: vi.fn(),
}));

// Labels resolve synchronously; row behaviour is covered in UnsyncedMutationList.test.tsx.
vi.mock('./mutation-label', async () => {
  const actual = await vi.importActual<typeof import('./mutation-label')>('./mutation-label');
  return {
    ...actual,
    resolveMutationLabel: vi.fn(async () => ({ typeLabel: 'Scenario', name: 'Base scenario' })),
  };
});

import { useSync } from './SyncContext.js';

type SyncValue = ReturnType<typeof useSync>;

function conflictMutation(): PendingMutation {
  return {
    id: 'mut-conflict',
    aggregateId: 'agg-conflict',
    aggregateType: 'scenario',
    operation: 'update',
    expectedVersion: 13,
    schemaVersion: 1,
    payload: {},
    timestamp: Date.now(),
    deviceId: 'dev-1',
    status: 'failed-conflict',
    reason: 'CONFLICT',
  };
}

function makeValue(over: Partial<SyncValue>): SyncValue {
  return {
    state: { kind: 'synced', lastSyncedAt: null },
    forceRefresh,
    retryNow,
    syncRoundTrip,
    pendingCount: 0,
    conflictCount: 0,
    pendingMutations: [],
    conflictMutations: [],
    failedErrorMutations: [],
    lastSyncedAt: null,
    notifyPending: vi.fn(),
    listSnapshots: vi.fn(),
    restoreSnapshot: vi.fn(),
    ...over,
  } as SyncValue;
}

function renderPopover(over: Partial<SyncValue>) {
  (useSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
    makeValue(over),
  );
  return render(
    <DialogTrigger defaultOpen>
      <Button>Open</Button>
      <SyncDetailsPopover />
    </DialogTrigger>,
  );
}

describe('SyncDetailsPopover', () => {
  beforeEach(() => {
    forceRefresh.mockReset();
    retryNow.mockReset();
    syncRoundTrip.mockReset();
    syncRoundTrip.mockResolvedValue({ ok: true });
    forceRefresh.mockResolvedValue({ ok: true, wiped: false });
    retryNow.mockResolvedValue(undefined);
  });


  it('shows status + last-synced + pending + conflicts + connection for synced state', () => {
    renderPopover({
      state: { kind: 'synced', lastSyncedAt: '2026-06-13T10:00:00.000Z' },
      pendingCount: 2,
      conflictCount: 1,
      lastSyncedAt: '2026-06-13T10:00:00.000Z',
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Status');
    expect(dialog).toHaveTextContent('All edits are pushed.');
    expect(dialog).toHaveTextContent('Last synced');
    expect(dialog).toHaveTextContent('Pending');
    expect(dialog).toHaveTextContent('Conflicts');
    expect(dialog).toHaveTextContent('Connection');
    expect(dialog).toHaveTextContent('Online');
  });

  it('shows "Not synced yet" when lastSyncedAt is null', () => {
    renderPopover({
      state: { kind: 'synced', lastSyncedAt: null },
      lastSyncedAt: null,
    });
    expect(screen.getByRole('dialog')).toHaveTextContent('Not synced yet');
  });

  it('shows relative + exact (title) timestamp when lastSyncedAt is set', () => {
    const iso = new Date(Date.now() - 30_000).toISOString();
    renderPopover({
      state: { kind: 'synced', lastSyncedAt: iso },
      lastSyncedAt: iso,
    });
    const exact = screen.getByTitle(iso);
    expect(exact).toHaveTextContent('just now');
  });

  it('shows pending count and conflict count', () => {
    renderPopover({
      state: { kind: 'stale' },
      pendingCount: 4,
      conflictCount: 3,
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('4');
    expect(dialog).toHaveTextContent('3');
  });

  it('shows Offline connection when state is offline', () => {
    renderPopover({ state: { kind: 'offline' } });
    expect(screen.getByRole('dialog')).toHaveTextContent('Offline');
  });

  it('shows Online connection for non-offline states', () => {
    renderPopover({ state: { kind: 'pending', count: 1 } });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Online');
    expect(dialog).not.toHaveTextContent('Connection\nOffline');
  });


  it('"Sync now" button appears for synced state', () => {
    renderPopover({ state: { kind: 'synced', lastSyncedAt: null } });
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled();
  });

  it('"Sync now" button appears for pending state', () => {
    renderPopover({ state: { kind: 'pending', count: 2 } });
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled();
  });

  it('"Retry now" button appears for error state', () => {
    renderPopover({ state: { kind: 'error', message: 'boom' } });
    expect(screen.getByRole('button', { name: 'Retry now' })).toBeEnabled();
  });

  it('"Refresh from server" button appears for stale state', () => {
    renderPopover({ state: { kind: 'stale' } });
    expect(
      screen.getByRole('button', { name: 'Refresh from server' }),
    ).toBeEnabled();
  });

  it('"Reload to update" button appears for update-available state', () => {
    renderPopover({ state: { kind: 'update-available' } });
    expect(
      screen.getByRole('button', { name: 'Reload to update' }),
    ).toBeEnabled();
  });

  it('"Sync now" button is disabled for offline state', () => {
    renderPopover({ state: { kind: 'offline' } });
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
    expect(screen.getByRole('dialog')).toHaveTextContent(
      "You're offline. Will sync on reconnect.",
    );
  });

  it('in-flight states show disabled button with spinner text', () => {
    renderPopover({ state: { kind: 'syncing-push' } });
    expect(screen.getByRole('button', { name: /Syncing…/ })).toBeDisabled();

    renderPopover({ state: { kind: 'syncing-pull' } });
    expect(screen.getByRole('button', { name: /Refreshing…/ })).toBeDisabled();
  });

  it('rollback-detected state shows no action button, shows security explanation', () => {
    renderPopover({ state: { kind: 'rollback-detected' } });
    const dialog = screen.getByRole('dialog');
    expect(
      screen.queryByRole('button', { name: 'Sync now' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Retry now' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Refresh from server' }),
    ).toBeNull();
    expect(dialog).toHaveTextContent(
      /Sync is blocked to protect your data/,
    );
    expect(dialog).toHaveTextContent(/wasn.t sealed with your encryption key/);
  });


  it('"Sync now" calls syncRoundTrip', async () => {
    renderPopover({ state: { kind: 'synced', lastSyncedAt: null } });
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    expect(syncRoundTrip).toHaveBeenCalledTimes(1);
  });

  it('"Retry now" calls retryNow', () => {
    renderPopover({ state: { kind: 'error', message: 'boom' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(retryNow).toHaveBeenCalledTimes(1);
  });

  it('"Refresh from server" calls forceRefresh', () => {
    renderPopover({ state: { kind: 'stale' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh from server' }));
    expect(forceRefresh).toHaveBeenCalledTimes(1);
  });

  it('"Reload to update" calls window.location.reload', () => {
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadSpy },
    });
    renderPopover({ state: { kind: 'update-available' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reload to update' }));
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('shows inline error when syncRoundTrip returns {ok:false, reason}', async () => {
    syncRoundTrip.mockResolvedValue({ ok: false, reason: 'No connection.' });
    renderPopover({ state: { kind: 'synced', lastSyncedAt: null } });
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('No connection.')).toBeInTheDocument();
  });

  it('popover stays open after action', async () => {
    renderPopover({ state: { kind: 'synced', lastSyncedAt: null } });
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    expect(syncRoundTrip).toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows a disabled "Working…" button while the action is in flight', async () => {
    // A never-settling promise keeps the handler pending so the running spinner stays rendered.
    syncRoundTrip.mockReturnValue(new Promise<never>(() => {}));
    renderPopover({ state: { kind: 'synced', lastSyncedAt: null } });
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    const working = await screen.findByRole('button', { name: /Working…/ });
    expect(working).toBeDisabled();
  });


  it('shows error envelope (phase/code/status/traceId/message) in error state', () => {
    renderPopover({
      state: {
        kind: 'error',
        phase: 'push',
        code: 'CONFLICT',
        status: 409,
        traceId: 'trace-abc',
        message: 'Aggregate version mismatch',
      },
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('push');
    expect(dialog).toHaveTextContent('CONFLICT');
    expect(dialog).toHaveTextContent('409');
    expect(dialog).toHaveTextContent('trace-abc');
    expect(dialog).toHaveTextContent('Aggregate version mismatch');
  });

  it('Copy details writes formatErrorReport to clipboard in error state', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderPopover({
      state: {
        kind: 'error',
        phase: 'push',
        code: 'CONFLICT',
        status: 409,
        traceId: 'trace-abc',
        message: 'Aggregate version mismatch',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy details' }));
    await screen.findByRole('button', { name: 'Copied' });
    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = writeText.mock.calls[0]![0] as string;
    expect(payload).toMatch(/Phase: push/);
    expect(payload).toMatch(/Code: CONFLICT/);
    expect(payload).toMatch(/Status: 409/);
    expect(payload).toMatch(/Trace ID: trace-abc/);
    expect(payload).toMatch(/Message: Aggregate version mismatch/);
  });

  it('shows "Copy failed" when clipboard write rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderPopover({
      state: {
        kind: 'error',
        code: 'CONFLICT',
        message: 'Aggregate version mismatch',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy details' }));
    await screen.findByRole('button', { name: 'Copy failed' });
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('renders only the Message row for a message-only error envelope', () => {
    renderPopover({ state: { kind: 'error', message: 'Fetch failed' } });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Message');
    expect(dialog).toHaveTextContent('Fetch failed');
    expect(dialog).not.toHaveTextContent('Phase');
    expect(dialog).not.toHaveTextContent('Code');
    // Scope to the error <dl>: "Status" also appears as a status-row label up top.
    const errorList = dialog.querySelector('dl');
    expect(errorList).not.toBeNull();
    expect(errorList).not.toHaveTextContent('Status');
    expect(errorList).not.toHaveTextContent('Trace ID');
  });

  it('does NOT show error envelope for non-error states', () => {
    renderPopover({ state: { kind: 'synced', lastSyncedAt: null } });
    expect(
      screen.queryByRole('button', { name: 'Copy details' }),
    ).toBeNull();
  });


  it('Esc closes the popover', async () => {
    const user = userEvent.setup();
    renderPopover({ state: { kind: 'synced', lastSyncedAt: null } });
    const dialog = screen.getByRole('dialog');
    // React Aria handles Escape on the popover element; after an earlier click puts it in "virtual" mode the dialog takes
    // focus a frame late, so a keypress straight after render would hit `body`.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });


  it('renders the unsynced-items inspector with the resolved name for a conflict', async () => {
    renderPopover({
      state: { kind: 'stale' },
      conflictCount: 1,
      conflictMutations: [conflictMutation()],
    });
    expect(await screen.findByText('Base scenario')).toBeInTheDocument();
    expect(screen.getByText('Conflict')).toBeInTheDocument();
  });

  it('does not render the inspector region when there are no unsynced items', () => {
    renderPopover({ state: { kind: 'synced', lastSyncedAt: null } });
    expect(screen.queryByRole('region', { name: 'Unsynced items' })).toBeNull();
  });


  it('passes jest-axe accessibility check', async () => {
    renderPopover({
      state: { kind: 'synced', lastSyncedAt: '2026-06-13T10:00:00.000Z' },
      lastSyncedAt: '2026-06-13T10:00:00.000Z',
      pendingCount: 1,
    });
    await expectNoA11yViolations(screen.getByRole('dialog'));
  });
});
