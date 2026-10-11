/**
 * RestoreSnapshotModal tests — list render, selection-gated Restore,
 * confirm dialog naming the chosen version, restore-on-confirm, loading +
 * error states, and an a11y smoke (AGENTS.md: shared-component a11y).
 */
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../test/a11y';
import type { SnapshotListItem } from '../sync/types';

const listSnapshots = vi.fn<() => Promise<SnapshotListItem[]>>();
const restoreSnapshot =
  vi.fn<(id: string) => Promise<{ ok: boolean; wiped: boolean }>>();
const recacheHdk = vi.fn<() => Promise<void>>();

vi.mock('../sync/SyncContext', () => ({
  useSync: () => ({ listSnapshots, restoreSnapshot }),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ recacheHdk }),
}));


import { RestoreSnapshotModal } from './RestoreSnapshotModal';

const SNAPSHOTS: SnapshotListItem[] = [
  { snapshotId: '2026-05-31T12-00-00-000Z', timestamp: '2026-05-31T12:00:00.000Z' },
  { snapshotId: '2026-05-31T11-00-00-000Z', timestamp: '2026-05-31T11:00:00.000Z' },
];

afterEach(() => {
  vi.clearAllMocks();
});

function renderOpen() {
  return render(<RestoreSnapshotModal open onClose={() => {}} />);
}

/**
 * Wait for the snapshot data rows to render, then select the first one.
 *
 * The grid landmark mounts a tick before React Aria populates its data
 * rows; under parallel load a `getAllByRole('row')` fired the instant the
 * grid appears can find only the header row (so `rows[1]` is undefined and
 * `within(undefined)` throws). Poll until at least one data row beyond the
 * header exists before clicking.
 */
async function selectFirstSnapshotRow(): Promise<void> {
  await waitFor(() =>
    expect(screen.getAllByRole('row').length).toBeGreaterThan(SNAPSHOTS.length),
  );
  const rows = screen.getAllByRole('row');
  // rows[0] is the header row; rows[1] is the first snapshot.
  fireEvent.click(within(rows[1]).getAllByRole('rowheader')[0]);
}

describe('RestoreSnapshotModal', () => {
  it('loads and renders the snapshot list when opened', async () => {
    listSnapshots.mockResolvedValue(SNAPSHOTS);
    renderOpen();
    expect(listSnapshots).toHaveBeenCalledTimes(1);
    // Both versions appear with an absolute timestamp.
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(SNAPSHOTS.length);
    });
  });

  it('shows an empty-state message when there are no versions', async () => {
    listSnapshots.mockResolvedValue([]);
    renderOpen();
    await waitFor(() =>
      expect(screen.getByText(/No previous versions are available/i)).toBeInTheDocument(),
    );
  });

  it('disables Restore until a version is selected', async () => {
    listSnapshots.mockResolvedValue(SNAPSHOTS);
    renderOpen();
    // Wait for the data rows (not just the grid landmark) before reading them.
    await waitFor(() =>
      expect(screen.getAllByRole('row').length).toBeGreaterThan(SNAPSHOTS.length),
    );
    const restoreBtn = screen.getByRole('button', { name: 'Restore' });
    expect(restoreBtn).toBeDisabled();

    // Select the first data row.
    const rows = screen.getAllByRole('row');
    // rows[0] is the header row; rows[1] is the first snapshot.
    fireEvent.click(within(rows[1]).getAllByRole('rowheader')[0]);
    await waitFor(() => expect(restoreBtn).toBeEnabled());
  });

  it('marks the chosen row as selected so it is visually distinguishable', async () => {
    listSnapshots.mockResolvedValue(SNAPSHOTS);
    renderOpen();
    // Wait for the data rows (not just the grid landmark) before reading them.
    await waitFor(() =>
      expect(screen.getAllByRole('row').length).toBeGreaterThan(SNAPSHOTS.length),
    );

    const rows = screen.getAllByRole('row');
    // Nothing selected yet.
    expect(rows[1]).not.toHaveAttribute('aria-selected', 'true');

    fireEvent.click(within(rows[1]).getAllByRole('rowheader')[0]);

    // React Aria stamps aria-selected on the picked row; the styling
    // (indigo wash + ✓ cell) keys off the same selected state.
    await waitFor(() =>
      expect(rows[1]).toHaveAttribute('aria-selected', 'true'),
    );
    // The other row stays unselected — exactly one pick is visible.
    expect(rows[2]).not.toHaveAttribute('aria-selected', 'true');
  });

  it('opens a confirm dialog naming the selected version and calls restoreSnapshot on confirm', async () => {
    listSnapshots.mockResolvedValue(SNAPSHOTS);
    restoreSnapshot.mockResolvedValue({ ok: true, wiped: true });
    renderOpen();
    await selectFirstSnapshotRow();
    const restoreBtn = screen.getByRole('button', { name: 'Restore' });
    await waitFor(() => expect(restoreBtn).toBeEnabled());
    fireEvent.click(restoreBtn);

    // The confirm dialog warns about permanent loss.
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/permanently lost/i)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(restoreSnapshot).toHaveBeenCalledWith('2026-05-31T12-00-00-000Z'),
    );
  });

  it('re-caches the HDK once after a successful restore', async () => {
    const onClose = vi.fn();
    listSnapshots.mockResolvedValue(SNAPSHOTS);
    restoreSnapshot.mockResolvedValue({ ok: true, wiped: true });
    recacheHdk.mockResolvedValue(undefined);
    render(<RestoreSnapshotModal open onClose={onClose} />);
    await selectFirstSnapshotRow();
    const restoreBtn = screen.getByRole('button', { name: 'Restore' });
    await waitFor(() => expect(restoreBtn).toBeEnabled());
    fireEvent.click(restoreBtn);

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));

    // Restore wiped keyCache; the modal re-caches the still-in-memory HDK so a
    // refresh doesn't re-prompt for the password.
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(recacheHdk).toHaveBeenCalledTimes(1);
  });

  it('does not re-cache the HDK when the restore fails', async () => {
    listSnapshots.mockResolvedValue(SNAPSHOTS);
    restoreSnapshot.mockResolvedValue({ ok: false, wiped: false });
    renderOpen();
    await selectFirstSnapshotRow();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));

    await waitFor(() =>
      expect(screen.getByText(/Could not restore this version/i)).toBeInTheDocument(),
    );
    // The cache write only runs on the success path — a failed reseed leaves the
    // workspace untouched, so there's no surviving-session cache to refresh.
    expect(recacheHdk).not.toHaveBeenCalled();
  });

  it('does not re-cache the HDK when the restore throws', async () => {
    listSnapshots.mockResolvedValue(SNAPSHOTS);
    restoreSnapshot.mockRejectedValue(new Error('boom'));
    renderOpen();
    await selectFirstSnapshotRow();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));

    await waitFor(() =>
      expect(screen.getByText(/Could not restore this version/i)).toBeInTheDocument(),
    );
    expect(recacheHdk).not.toHaveBeenCalled();
  });

  it('still closes the modal on success when the HDK re-cache rejects (best-effort)', async () => {
    const onClose = vi.fn();
    listSnapshots.mockResolvedValue(SNAPSHOTS);
    restoreSnapshot.mockResolvedValue({ ok: true, wiped: true });
    // A rejected re-cache must not flip the succeeded restore into an error.
    recacheHdk.mockRejectedValue(new Error('idb write failed'));
    render(<RestoreSnapshotModal open onClose={onClose} />);
    await selectFirstSnapshotRow();
    const restoreBtn = screen.getByRole('button', { name: 'Restore' });
    await waitFor(() => expect(restoreBtn).toBeEnabled());
    fireEvent.click(restoreBtn);

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(recacheHdk).toHaveBeenCalledTimes(1);
    // The success path stays clean — no error alert is surfaced.
    expect(screen.queryByText(/Could not restore this version/i)).not.toBeInTheDocument();
  });

  it('warns in the confirm dialog that a recovery key may be needed after a password change', async () => {
    listSnapshots.mockResolvedValue(SNAPSHOTS);
    renderOpen();
    await selectFirstSnapshotRow();
    const restoreBtn = screen.getByRole('button', { name: 'Restore' });
    await waitFor(() => expect(restoreBtn).toBeEnabled());
    fireEvent.click(restoreBtn);

    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(/may need your recovery key to unlock your data/i),
    ).toBeInTheDocument();
  });

  it('shows an inline error alert when restore fails', async () => {
    listSnapshots.mockResolvedValue(SNAPSHOTS);
    restoreSnapshot.mockRejectedValue(new Error('boom'));
    renderOpen();
    await selectFirstSnapshotRow();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));

    await waitFor(() =>
      expect(screen.getByText(/Could not restore this version/i)).toBeInTheDocument(),
    );
  });

  it('shows a reload-recovery message and keeps the modal open when restore wipes but does not finish', async () => {
    const onClose = vi.fn();
    listSnapshots.mockResolvedValue(SNAPSHOTS);
    restoreSnapshot.mockResolvedValue({ ok: false, wiped: true });
    render(<RestoreSnapshotModal open onClose={onClose} />);
    await selectFirstSnapshotRow();
    const restoreBtn = screen.getByRole('button', { name: 'Restore' });
    await waitFor(() => expect(restoreBtn).toBeEnabled());
    fireEvent.click(restoreBtn);

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));

    await waitFor(() =>
      expect(screen.getByText(/Reload the page to continue/i)).toBeInTheDocument(),
    );
    // The modal stays open so the user can act on the reload-recovery message.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clears the prior list when a re-open fails to reload it', async () => {
    listSnapshots.mockResolvedValueOnce(SNAPSHOTS);
    const { rerender } = render(<RestoreSnapshotModal open onClose={() => {}} />);
    // Two snapshot rows are rendered on the first, successful open; wait for
    // the data rows, not just the grid landmark, before counting them.
    await waitFor(() =>
      expect(screen.getAllByRole('row').length).toBeGreaterThan(SNAPSHOTS.length),
    );

    // Close, then re-open with the list reload now failing.
    rerender(<RestoreSnapshotModal open={false} onClose={() => {}} />);
    listSnapshots.mockRejectedValueOnce(new Error('network'));
    rerender(<RestoreSnapshotModal open onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText(/Could not load your previous versions/i)).toBeInTheDocument(),
    );
    // The stale list is gone — nothing remains selectable.
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  });

  it('surfaces a list-load failure as an error alert', async () => {
    listSnapshots.mockRejectedValue(new Error('network'));
    renderOpen();
    await waitFor(() =>
      expect(screen.getByText(/Could not load your previous versions/i)).toBeInTheDocument(),
    );
  });

  it('has no a11y violations with a populated list', async () => {
    listSnapshots.mockResolvedValue(SNAPSHOTS);
    const { container } = renderOpen();
    await waitFor(() => screen.getByRole('grid'));
    await expectNoA11yViolations(container);
  });
});
