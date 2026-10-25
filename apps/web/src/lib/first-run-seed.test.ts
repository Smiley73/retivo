import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { listAggregatesMock, queueLocalMutationMock } = vi.hoisted(() => ({
  listAggregatesMock: vi.fn(),
  queueLocalMutationMock: vi.fn(),
}));
vi.mock('../db/store', () => ({ listAggregates: listAggregatesMock }));
vi.mock('../sync/mutation-queue', () => ({ queueLocalMutation: queueLocalMutationMock }));

import { seedPrimaryMemberOnce } from './first-run-seed';
import { hasPrimaryMemberSeeded } from './first-run-seed-flag';

const PROFILE = { firstName: 'Ada', lastName: 'Lovelace', birthdate: '1985-12-10' };

function installFakeLocks() {
  let tail: Promise<unknown> = Promise.resolve();
  const request = vi.fn((_name: string, fn: () => Promise<unknown>) => {
    const run = tail.then(fn);
    tail = run.catch(() => undefined);
    return run;
  });
  Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
  return request;
}

describe('seedPrimaryMemberOnce', () => {
  beforeEach(() => {
    localStorage.clear();
    listAggregatesMock.mockReset();
    queueLocalMutationMock.mockReset();
    queueLocalMutationMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'locks');
  });

  it('seeds an empty, unflagged workspace and sets the flag', async () => {
    listAggregatesMock.mockResolvedValue([]);
    await expect(seedPrimaryMemberOnce('hh-1', 'a@b.test', PROFILE)).resolves.toBe('seeded');
    expect(queueLocalMutationMock).toHaveBeenCalledTimes(1);
    expect(hasPrimaryMemberSeeded('hh-1')).toBe(true);
  });

  it('does not seed a populated workspace', async () => {
    listAggregatesMock.mockResolvedValue([{ id: 'm-1' }]);
    await expect(seedPrimaryMemberOnce('hh-1', 'a@b.test', PROFILE)).resolves.toBe(
      'already-populated',
    );
    expect(queueLocalMutationMock).not.toHaveBeenCalled();
  });

  it('does not seed when the flag is already set', async () => {
    listAggregatesMock.mockResolvedValue([]);
    localStorage.setItem('retivo:primary-member-seeded:hh-1', '1');
    await expect(seedPrimaryMemberOnce('hh-1', 'a@b.test', PROFILE)).resolves.toBe(
      'already-seeded',
    );
    expect(queueLocalMutationMock).not.toHaveBeenCalled();
  });

  it('two concurrent callers under the cross-tab lock create exactly one primary member', async () => {
    const request = installFakeLocks();
    // The store reflects the first caller's write, as another tab's IDB would.
    let members: unknown[] = [];
    listAggregatesMock.mockImplementation(async () => members);
    queueLocalMutationMock.mockImplementation(async () => {
      members = [{ id: 'm-1' }];
    });

    const results = await Promise.all([
      seedPrimaryMemberOnce('hh-1', 'a@b.test', PROFILE),
      seedPrimaryMemberOnce('hh-1', 'a@b.test', PROFILE),
    ]);

    expect(results.sort()).toEqual(['already-populated', 'seeded']);
    expect(queueLocalMutationMock).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('retivo:primary-member-seed:hh-1', expect.any(Function));
  });
});
