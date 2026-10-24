// Unit tests for the shared badge formatters, a leaf module so SyncBadge and SyncDetailsPopover can both depend on them.
import { describe as describeState, relativeTime, relativeTimeFromMs } from './badge-format.js';

describe('badge-format describe', () => {
  it('returns a short label for each badge state', () => {
    expect(describeState({ kind: 'synced', lastSyncedAt: null })).toBe(
      'All edits are pushed.',
    );
    expect(describeState({ kind: 'syncing-push' })).toBe(
      'Sending edits to the cloud.',
    );
    expect(describeState({ kind: 'syncing-pull' })).toBe('Fetching updates.');
    expect(describeState({ kind: 'offline' })).toMatch(/No network/);
    expect(describeState({ kind: 'stale' })).toMatch(/changed elsewhere/);
    expect(describeState({ kind: 'pending', count: 3 })).toBe('3 edits queued.');
    expect(describeState({ kind: 'rollback-detected' })).toMatch(
      /Sync is blocked to protect your data/,
    );
    expect(describeState({ kind: 'rollback-detected' })).toMatch(
      /wasn.t sealed with your encryption key/,
    );
    expect(describeState({ kind: 'update-available' })).toBe(
      'A newer app version is available. Reload to update.',
    );
  });

  it('uses the error message when present, else a fallback', () => {
    expect(describeState({ kind: 'error', message: 'boom' })).toBe('boom');
    expect(
      describeState({ kind: 'error', message: undefined as unknown as string }),
    ).toMatch(/Last sync failed/);
  });
});

describe('badge-format relativeTime', () => {
  it('reports "just now" under a minute', () => {
    expect(relativeTime(new Date(Date.now() - 30_000).toISOString())).toBe(
      'just now',
    );
  });

  it('reports minutes for sub-hour gaps', () => {
    expect(relativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe(
      '5m ago',
    );
  });

  it('reports hours for hour-plus gaps', () => {
    expect(
      relativeTime(new Date(Date.now() - 3 * 60 * 60_000).toISOString()),
    ).toBe('3h ago');
  });
});

describe('badge-format relativeTimeFromMs', () => {
  it('reports "just now" under a minute', () => {
    expect(relativeTimeFromMs(Date.now() - 30_000)).toBe('just now');
  });

  it('reports minutes for sub-hour gaps', () => {
    expect(relativeTimeFromMs(Date.now() - 5 * 60_000)).toBe('5m ago');
  });

  it('reports hours for hour-plus gaps', () => {
    expect(relativeTimeFromMs(Date.now() - 3 * 60 * 60_000)).toBe('3h ago');
  });

  it('reports "just now" for a non-positive diff (monotonic/future timestamp)', () => {
    expect(relativeTimeFromMs(Date.now() + 60_000)).toBe('just now');
  });
});
