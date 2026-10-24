// Each badge state renders the right icon, label and `aria-live`; the action handlers live in SyncDetailsPopover.test.tsx.
import { render, screen, fireEvent, act } from '@testing-library/react';
import { SyncBadge } from './SyncBadge';
import { expectNoA11yViolations } from '../test/a11y';

const forceRefresh = vi.fn();
const retryNow = vi.fn();
const syncRoundTrip = vi.fn();

vi.mock('./SyncContext.js', () => ({
  useSync: vi.fn(),
}));

import { useSync } from './SyncContext.js';

function setState(
  state: ReturnType<typeof useSync>['state'],
  nextRetryAt: number | null = null,
) {
  (useSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    state,
    nextRetryAt,
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
  });
}

describe('SyncBadge', () => {
  beforeEach(() => {
    forceRefresh.mockClear();
    retryNow.mockClear();
    syncRoundTrip.mockClear();
  });

  it('renders the synced state with a cloud icon + relative timestamp', () => {
    setState({ kind: 'synced', lastSyncedAt: new Date(Date.now() - 30_000).toISOString() });
    render(<SyncBadge />);
    const button = screen.getByRole('button');
    expect(button).toHaveTextContent(/Synced/);
    expect(button.querySelector('svg')).not.toBeNull();
    // The polite live region rides the inert wrapper span: assistive tech announces live changes on a focused control unreliably.
    expect(button.parentElement).toHaveAttribute('aria-live', 'polite');
    expect(button).toHaveAttribute('data-sync-state', 'synced');
  });

  it('renders the syncing-push state with the spin icon', () => {
    setState({ kind: 'syncing-push' });
    render(<SyncBadge />);
    const button = screen.getByRole('button');
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button).toHaveTextContent('Syncing…');
    expect(button).toHaveAttribute('data-sync-state', 'syncing-push');
  });

  it('renders the syncing-pull state', () => {
    setState({ kind: 'syncing-pull' });
    render(<SyncBadge />);
    expect(screen.getByRole('button')).toHaveTextContent('Refreshing…');
  });

  it('renders the offline state', () => {
    setState({ kind: 'offline' });
    render(<SyncBadge />);
    const button = screen.getByRole('button');
    expect(button).toHaveTextContent('Offline');
    expect(button.querySelector('svg')).not.toBeNull();
  });

  it('renders the pending state with a count', () => {
    setState({ kind: 'pending', count: 3 });
    render(<SyncBadge />);
    expect(screen.getByRole('button')).toHaveTextContent('Pending (3)');
  });

  it('renders the error state with the warning icon and clickable cursor', () => {
    setState({ kind: 'error', message: 'Network error' });
    render(<SyncBadge />);
    const button = screen.getByRole('button', { name: /Sync failed|Network error/ });
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button).toHaveTextContent('Sync failed');
    expect(button).toHaveAttribute('data-sync-state', 'error');
  });

  it('renders the stale state', () => {
    setState({ kind: 'stale' });
    render(<SyncBadge />);
    const button = screen.getByRole('button');
    expect(button).toHaveTextContent('Refresh needed');
    expect(button).toHaveAttribute('data-sync-state', 'stale');
  });

  it('clicking the error badge opens the details popover', () => {
    setState({ kind: 'error', message: 'oops' });
    render(<SyncBadge />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Sync failed|oops/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('clicking the stale badge opens the details popover', () => {
    setState({ kind: 'stale' });
    render(<SyncBadge />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('renders the rollback-detected state (security alert, non-actionable)', () => {
    setState({ kind: 'rollback-detected' });
    render(<SyncBadge />);
    const button = screen.getByRole('button');
    expect(button).toHaveTextContent('Sync blocked');
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button).toHaveAttribute('data-sync-state', 'rollback-detected');
  });

  it('renders rollback-detected state (non-actionable)', () => {
    setState({ kind: 'rollback-detected' });
    render(<SyncBadge />);
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('data-sync-state', 'rollback-detected');
  });

  it('clicking the synced badge opens the details popover', () => {
    setState({ kind: 'synced', lastSyncedAt: null });
    render(<SyncBadge />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('clicking the offline badge opens the details popover', () => {
    setState({ kind: 'offline' });
    render(<SyncBadge />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('renders the update-available state with the calm info tone, not red, and not spun', () => {
    setState({ kind: 'update-available' });
    render(<SyncBadge />);
    const button = screen.getByRole('button');
    expect(button).toHaveTextContent('Update available');
    expect(button).toHaveAttribute('data-sync-state', 'update-available');
    expect(button.className).toContain('text-info');
    expect(button.className).not.toContain('text-negative');
    const iconWrapper = button.querySelector('svg')?.parentElement;
    expect(iconWrapper?.className).not.toContain('animate-spin');
  });

  it('clicking the update-available badge opens the details popover', () => {
    setState({ kind: 'update-available' });
    render(<SyncBadge />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

// The live "Retrying in Ns" countdown must not change announced content (the aria-live wrapper and title) every second.
describe('SyncBadge — Retrying in Ns countdown', () => {
  beforeEach(() => {
    forceRefresh.mockClear();
    retryNow.mockClear();
    syncRoundTrip.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('counts down live while nextRetryAt is set in the error state', () => {
    vi.useFakeTimers();
    const now = Date.now();
    setState({ kind: 'error', message: 'Sync failed' }, now + 5_000);
    render(<SyncBadge />);
    const button = screen.getByRole('button');
    expect(button).toHaveTextContent('Retrying in 5s');

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(button).toHaveTextContent('Retrying in 3s');

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(button).toHaveTextContent('Retrying in 1s');
  });

  it('falls back to the static "Sync failed" label when there is no scheduled deadline yet', () => {
    setState({ kind: 'error', message: 'Sync failed' }, null);
    render(<SyncBadge />);
    expect(screen.getByRole('button')).toHaveTextContent('Sync failed');
  });

  it('clears the countdown interval on leaving the error state', () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    const now = Date.now();
    setState({ kind: 'error', message: 'Sync failed' }, now + 5_000);
    const { rerender } = render(<SyncBadge />);
    expect(screen.getByRole('button')).toHaveTextContent('Retrying in 5s');

    setState({ kind: 'synced', lastSyncedAt: null }, null);
    rerender(<SyncBadge />);
    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(screen.getByRole('button')).toHaveTextContent(/Synced/);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByRole('button')).toHaveTextContent(/Synced/);
  });

  it('clears the countdown interval on unmount', () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    const now = Date.now();
    setState({ kind: 'error', message: 'Sync failed' }, now + 5_000);
    const { unmount } = render(<SyncBadge />);
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it('the ticking number is aria-hidden — the live region and title do not change once per tick', () => {
    vi.useFakeTimers();
    const now = Date.now();
    setState({ kind: 'error', message: 'Sync failed' }, now + 5_000);
    render(<SyncBadge />);
    const button = screen.getByRole('button');
    const wrapper = button.parentElement!;
    expect(wrapper).toHaveAttribute('aria-live', 'polite');

    const titleBeforeTick = wrapper.getAttribute('title');
    const digitsSpan = Array.from(button.querySelectorAll('span[aria-hidden="true"]')).find((el) =>
      /^\d+$/.test(el.textContent ?? ''),
    );
    expect(digitsSpan).toBeDefined();
    expect(digitsSpan).toHaveAttribute('aria-hidden', 'true');

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(wrapper.getAttribute('title')).toBe(titleBeforeTick);
  });

  it('passes jest-axe accessibility check while counting down', async () => {
    const now = Date.now();
    setState({ kind: 'error', message: 'Sync failed' }, now + 5_000);
    const { container } = render(<SyncBadge />);
    await expectNoA11yViolations(container);
  });

  // The countdown is decorative: it must never become the accessible name, which stays the state-derived label.
  it('keeps the accessible name "Sync failed" while counting down — never the ungrammatical "Retrying in s"', () => {
    vi.useFakeTimers();
    const now = Date.now();
    setState({ kind: 'error', message: 'Sync failed' }, now + 5_000);
    render(<SyncBadge />);
    const button = screen.getByRole('button', { name: 'Sync failed' });
    expect(button).toHaveTextContent('Retrying in 5s');

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByRole('button', { name: 'Sync failed' })).toBe(button);
  });
});
