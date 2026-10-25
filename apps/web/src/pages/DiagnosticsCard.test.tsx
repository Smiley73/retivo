// DiagnosticsCard over real `fake-indexeddb` paths; cases needing a controlled `ts`/`seq` spy on `listDiagnosticLogs`, since `recordError`/`flush` always stamp `ts = nowIso()`.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DiagnosticsCard } from './DiagnosticsCard';
import { ISSUES_URL } from '../lib/brand';
import { expectNoA11yViolations } from '../test/a11y';
import { clear, flush, recordError } from '../lib/diagnostics/logger';
import { clearDiagnosticLogs, listDiagnosticLogs } from '../db/store';
import * as store from '../db/store';
import type { DiagnosticLogEntry } from '../db/store';
import type { PendingMutation } from '../db/types';
import type { DiagnosticEntry } from '../lib/diagnostics/logger';

vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));

vi.mock('../sync/mutation-label', async () => {
  const actual =
    await vi.importActual<typeof import('../sync/mutation-label')>('../sync/mutation-label');
  return {
    ...actual,
    resolveMutationLabel: vi.fn(async () => ({ typeLabel: 'Scenario', name: 'Base scenario' })),
  };
});

import { useSync } from '../sync/SyncContext';

const useSyncMock = useSync as unknown as ReturnType<typeof vi.fn>;

function syncValue(over: Record<string, unknown> = {}): ReturnType<typeof useSync> {
  return {
    pendingMutations: [],
    conflictMutations: [],
    failedErrorMutations: [],
    resolveConflict: vi.fn(),
    checkAndRepair: vi.fn(),
    ...over,
  } as unknown as ReturnType<typeof useSync>;
}

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

// Fabricated row: `DiagnosticLogEntry` is opaque past `id`/`seq`, hence the cast.
function entry(over: Partial<DiagnosticEntry> = {}): DiagnosticLogEntry {
  return {
    id: over.id ?? `diag-${Math.random().toString(36).slice(2)}`,
    seq: over.seq ?? 1,
    ts: over.ts ?? new Date().toISOString(),
    level: over.level ?? 'error',
    source: over.source ?? 'console',
    message: over.message ?? 'boom',
    buildId: over.buildId ?? 'test-build',
    path: over.path ?? '/workspace',
    ...over,
  } as DiagnosticLogEntry;
}

describe('DiagnosticsCard', () => {
  beforeEach(async () => {
    clear();
    await clearDiagnosticLogs();
    useSyncMock.mockReturnValue(syncValue());
  });
  afterEach(() => {
    clear();
    vi.restoreAllMocks();
  });

  it('renders the three actions and the personal-data note', async () => {
    const { container } = render(<DiagnosticsCard householdId="hh-1" email="a@b.test" />);
    expect(screen.getByRole('button', { name: /export diagnostics/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /view recent activity/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clear diagnostics/i })).toBeInTheDocument();
    expect(screen.getByText(/may contain personal data/i)).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('links the GitHub issue tracker once, in the footnote, and never tells the user to attach the file', () => {
    const { container } = render(<DiagnosticsCard householdId="hh-1" email="a@b.test" />);
    const link = screen.getByRole('link', { name: 'Report an issue on GitHub' });
    expect(link).toHaveAttribute('href', ISSUES_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(container.textContent).toMatch(/never attach it to a public issue/i);
    expect(container.textContent).not.toMatch(/to attach/i);
    expect(container.textContent).not.toMatch(/support/i);
  });

  it('View re-queries IDB and shows captured entries newest-first', async () => {
    recordError('boom one');
    recordError('boom two');
    await flush();
    render(<DiagnosticsCard householdId="hh-1" email="a@b.test" />);
    fireEvent.click(screen.getByRole('button', { name: /view recent activity/i }));
    await screen.findByRole('heading', { name: /recent activity/i });
    expect(screen.getByText('boom two')).toBeInTheDocument();
    expect(screen.getByText('boom one')).toBeInTheDocument();
  });

  it('Clear empties both the rings and the persisted store', async () => {
    recordError('wipe me');
    await flush();
    expect(await listDiagnosticLogs()).toHaveLength(1);
    render(<DiagnosticsCard householdId="hh-1" email="a@b.test" />);
    fireEvent.click(screen.getByRole('button', { name: /clear diagnostics/i }));
    const confirm = await screen.findByRole('button', { name: /^clear diagnostics$/i });
    fireEvent.click(confirm);
    await waitFor(async () => {
      expect(await listDiagnosticLogs()).toHaveLength(0);
    });
  });

  it('"Show unsynced items" reveals the shared list with a conflict row', async () => {
    useSyncMock.mockReturnValue(syncValue({ conflictMutations: [conflictMutation()] }));
    render(<DiagnosticsCard householdId="hh-1" email="a@b.test" />);
    fireEvent.click(screen.getByRole('button', { name: /show unsynced items/i }));
    expect(await screen.findByText('Base scenario')).toBeInTheDocument();
    expect(screen.getByText('Conflict')).toBeInTheDocument();
  });

  it('does not show the unsynced expander when there are no unsynced items', () => {
    render(<DiagnosticsCard householdId="hh-1" email="a@b.test" />);
    expect(screen.queryByRole('button', { name: /show unsynced items/i })).toBeNull();
  });

  it('shows "Check & repair" when conflicts persist and clicking it calls checkAndRepair', async () => {
    const checkAndRepair = vi.fn().mockResolvedValue(undefined);
    useSyncMock.mockReturnValue(
      syncValue({ conflictMutations: [conflictMutation()], checkAndRepair }),
    );
    render(<DiagnosticsCard householdId="hh-1" email="a@b.test" />);
    fireEvent.click(screen.getByRole('button', { name: /show unsynced items/i }));
    const btn = await screen.findByRole('button', { name: 'Check & repair' });
    fireEvent.click(btn);
    await waitFor(() => expect(checkAndRepair).toHaveBeenCalledTimes(1));
  });

  it('surfaces an error and re-enables the button when checkAndRepair rejects', async () => {
    const checkAndRepair = vi.fn().mockRejectedValue(new Error('repair boom'));
    useSyncMock.mockReturnValue(
      syncValue({ conflictMutations: [conflictMutation()], checkAndRepair }),
    );
    render(<DiagnosticsCard householdId="hh-1" email="a@b.test" />);
    fireEvent.click(screen.getByRole('button', { name: /show unsynced items/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Check & repair' }));
    expect(
      await screen.findByText('Could not check and repair sync. Please try again.'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Check & repair' })).not.toBeDisabled(),
    );
  });

  it('does not show "Check & repair" when there are only pending items (no conflicts)', () => {
    useSyncMock.mockReturnValue(
      syncValue({ pendingMutations: [{ ...conflictMutation(), status: 'pending' }] }),
    );
    render(<DiagnosticsCard householdId="hh-1" email="a@b.test" />);
    fireEvent.click(screen.getByRole('button', { name: /show unsynced items/i }));
    expect(screen.queryByRole('button', { name: 'Check & repair' })).toBeNull();
  });

  it('injects the per-row Resolve control into the unsynced list (keep calls resolveConflict)', async () => {
    const resolveConflict = vi.fn().mockResolvedValue(undefined);
    const conflict = { ...conflictMutation(), currentVersion: 14 };
    useSyncMock.mockReturnValue(
      syncValue({ conflictMutations: [conflict], resolveConflict }),
    );
    render(<DiagnosticsCard householdId="hh-1" email="a@b.test" />);
    fireEvent.click(screen.getByRole('button', { name: /show unsynced items/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Keep mine/ }));
    await waitFor(() => expect(resolveConflict).toHaveBeenCalledWith(conflict, 'keep'));
  });

  it('shows a one-time timezone note when entries exist', async () => {
    recordError('boom');
    await flush();
    render(<DiagnosticsCard householdId="hh-1" email="a@b.test" />);
    fireEvent.click(screen.getByRole('button', { name: /view recent activity/i }));
    await screen.findByRole('heading', { name: /recent activity/i });
    expect(screen.getByText(/Times are shown in your timezone/)).toBeInTheDocument();
  });

  it('does not show the timezone note when there are no diagnostics', async () => {
    render(<DiagnosticsCard householdId="hh-1" email="a@b.test" />);
    fireEvent.click(screen.getByRole('button', { name: /view recent activity/i }));
    await screen.findByRole('heading', { name: /recent activity/i });
    expect(screen.getByText('No diagnostics recorded yet.')).toBeInTheDocument();
    expect(screen.queryByText(/Times are shown in your timezone/)).toBeNull();
  });

  it("renders a row's time as a local date + time with seconds", async () => {
    vi.spyOn(store, 'listDiagnosticLogs').mockResolvedValue([
      entry({ ts: '2024-03-15T10:30:45.123Z', message: 'fixed-ts' }),
    ]);
    render(<DiagnosticsCard householdId="hh-1" email="a@b.test" />);
    fireEvent.click(screen.getByRole('button', { name: /view recent activity/i }));
    await screen.findByText('fixed-ts');
    // Zone-agnostic: exercises the "with seconds" branch without pinning the
    // runner's timezone or recomputing the exact formatted string inline.
    expect(screen.getByText(/\d{1,2}:\d{2}:\d{2}/)).toBeInTheDocument();
  });

  it('falls back to the raw ISO string for an unparseable ts', async () => {
    vi.spyOn(store, 'listDiagnosticLogs').mockResolvedValue([
      entry({ ts: 'not-a-date', message: 'bad-ts' }),
    ]);
    render(<DiagnosticsCard householdId="hh-1" email="a@b.test" />);
    fireEvent.click(screen.getByRole('button', { name: /view recent activity/i }));
    await screen.findByText('bad-ts');
    expect(screen.getByText('not-a-date')).toBeInTheDocument();
  });

  it('orders rows by capture time (ts) descending, seq breaking a ts tie', async () => {
    // A has the highest seq but the oldest ts: ts-descending, not seq order, must decide.
    const oldTsHighSeq = entry({ seq: 100, ts: '2024-01-01T00:00:00.000Z', message: 'A' });
    const newTsLowSeq = entry({ seq: 1, ts: '2024-06-01T00:00:00.000Z', message: 'B' });
    const newTsHigherSeq = entry({ seq: 5, ts: '2024-06-01T00:00:00.000Z', message: 'C' });
    vi.spyOn(store, 'listDiagnosticLogs').mockResolvedValue([
      oldTsHighSeq,
      newTsLowSeq,
      newTsHigherSeq,
    ]);
    render(<DiagnosticsCard householdId="hh-1" email="a@b.test" />);
    fireEvent.click(screen.getByRole('button', { name: /view recent activity/i }));
    await screen.findByText('A');
    const order = screen.getAllByText(/^[ABC]$/).map((el) => el.textContent);
    expect(order).toEqual(['C', 'B', 'A']);
  });

  it('sorts an entry with an unparseable ts as oldest among valid-ts entries', async () => {
    // An unparseable `ts` maps to epoch 0 rather than NaN, so it sorts last instead of poisoning every comparison.
    const newest = entry({ seq: 1, ts: '2024-06-01T00:00:00.000Z', message: 'X' });
    const older = entry({ seq: 1, ts: '2024-01-01T00:00:00.000Z', message: 'Y' });
    const unparseable = entry({ seq: 1, ts: 'not-a-date', message: 'Z' });
    vi.spyOn(store, 'listDiagnosticLogs').mockResolvedValue([older, unparseable, newest]);
    render(<DiagnosticsCard householdId="hh-1" email="a@b.test" />);
    fireEvent.click(screen.getByRole('button', { name: /view recent activity/i }));
    await screen.findByText('X');
    const order = screen.getAllByText(/^[XYZ]$/).map((el) => el.textContent);
    expect(order).toEqual(['X', 'Y', 'Z']);
  });

  it('omits the parenthetical timezone name when the runtime cannot resolve one', async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockReturnValue([
      { type: 'literal', value: '' },
    ]);
    recordError('boom');
    await flush();
    render(<DiagnosticsCard householdId="hh-1" email="a@b.test" />);
    fireEvent.click(screen.getByRole('button', { name: /view recent activity/i }));
    await screen.findByRole('heading', { name: /recent activity/i });
    expect(screen.getByText('Times are shown in your timezone.')).toBeInTheDocument();
  });
});
