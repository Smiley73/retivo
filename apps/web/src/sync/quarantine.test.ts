// Pure quarantine merge; `recordDecryptOutcome`'s IDB and diagnostics side effects are covered via SyncContext and sync-client tests.
import { describe, expect, it } from 'vitest';
import { applyQuarantineOutcome } from './quarantine';

const NOW = 1_700_000_000_000;
const MAX_QUARANTINED_ROWS = 200;

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
    expect(result.some((r) => r.aggregateId === 'a0')).toBe(false);
    expect(result.some((r) => r.aggregateId === 'a-new')).toBe(true);
  });

  it('a no-op outcome (nothing quarantined or resolved) leaves the list unchanged', () => {
    const existing = [{ aggregateId: 'a1', aggregateType: 'account', version: 1, firstSeenAt: NOW }];
    const result = applyQuarantineOutcome(existing, { quarantined: [], resolved: [] }, NOW);
    expect(result).toEqual(existing);
  });
});
