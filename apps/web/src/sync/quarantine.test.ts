/**
 * Unit tests for the pure quarantine merge.
 * `recordDecryptOutcome`'s IDB + diagnostics side effects are exercised via
 * `SyncContext`/`sync-client.test.ts`'s injected-dep coverage; this file
 * covers the merge logic directly.
 */
import { describe, expect, it } from 'vitest';
import { applyQuarantineOutcome, MAX_QUARANTINED_ROWS } from './quarantine';

const NOW = 1_700_000_000_000;

describe('applyQuarantineOutcome', () => {
  it('adds a new quarantine entry with the given timestamp', () => {
    const result = applyQuarantineOutcome(
      undefined,
      { quarantined: [{ aggregateId: 'a1', aggregateType: 'account', version: 3 }], resolved: [] },
      NOW,
    );
    expect(result).toEqual([
      { aggregateId: 'a1', aggregateType: 'account', version: 3, firstSeenAt: NOW },
    ]);
  });

  it('does not duplicate an already-quarantined aggregate', () => {
    const existing = [{ aggregateId: 'a1', aggregateType: 'account', version: 1, firstSeenAt: NOW - 1000 }];
    const result = applyQuarantineOutcome(
      existing,
      { quarantined: [{ aggregateId: 'a1', aggregateType: 'account', version: 2 }], resolved: [] },
      NOW,
    );
    expect(result).toHaveLength(1);
    // The FIRST-seen stamp and version are not clobbered by a later duplicate
    // report of the same still-quarantined aggregate.
    expect(result[0]).toEqual(existing[0]);
  });

  it('clears an entry when a later good version of the same aggregate resolves', () => {
    const existing = [{ aggregateId: 'a1', aggregateType: 'account', version: 1, firstSeenAt: NOW - 1000 }];
    const result = applyQuarantineOutcome(
      existing,
      { quarantined: [], resolved: [{ aggregateId: 'a1', aggregateType: 'account' }] },
      NOW,
    );
    expect(result).toEqual([]);
  });

  it('stays bounded — the oldest entries are evicted once the cap is exceeded', () => {
    const existing = Array.from({ length: MAX_QUARANTINED_ROWS }, (_, i) => ({
      aggregateId: `a${i}`,
      aggregateType: 'account',
      version: 1,
      firstSeenAt: NOW - (MAX_QUARANTINED_ROWS - i),
    }));
    const result = applyQuarantineOutcome(
      existing,
      { quarantined: [{ aggregateId: 'a-new', aggregateType: 'account', version: 1 }], resolved: [] },
      NOW,
    );
    expect(result).toHaveLength(MAX_QUARANTINED_ROWS);
    // The single oldest entry (a0) was evicted to make room for the new one.
    expect(result.some((r) => r.aggregateId === 'a0')).toBe(false);
    expect(result.some((r) => r.aggregateId === 'a-new')).toBe(true);
  });

  it('a no-op outcome (nothing quarantined or resolved) leaves the list unchanged', () => {
    const existing = [{ aggregateId: 'a1', aggregateType: 'account', version: 1, firstSeenAt: NOW }];
    const result = applyQuarantineOutcome(existing, { quarantined: [], resolved: [] }, NOW);
    expect(result).toEqual(existing);
  });
});
