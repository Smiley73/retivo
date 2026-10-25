// WorkspaceMetaRepository against DynamoDB Local: the monotonic freshness-head bump and the daily push-quota carry-forward. The bump's error-recovery `null`
// path (UpdateItem and the GetItem re-read both failing) cannot be triggered against a healthy emulator.
import { createRepoTestEnv, type RepoTestEnv } from '../test/test-helpers.js';
import { WorkspaceMetaRepository } from './workspace-meta.repository.js';
import type { WorkspaceMetaRow } from './types.js';
import { randomUUID } from 'node:crypto';

const utcDayStamp = (): string => new Date().toISOString().slice(0, 10);

describe('WorkspaceMetaRepository.bumpFreshnessHead', () => {
  let env: RepoTestEnv;
  let repo: WorkspaceMetaRepository;

  beforeAll(async () => {
    env = await createRepoTestEnv();
    repo = new WorkspaceMetaRepository(env.doc, env.config);
  });

  afterAll(async () => {
    env.destroy();
  });

  const deviceId = randomUUID();

  it('first write stores and echoes the counter + tag', async () => {
    const householdId = randomUUID();
    await repo.createIfMissing(householdId);

    const result = await repo.bumpFreshnessHead(householdId, deviceId, 1, 'dGFnMQ');
    expect(result).toEqual({ storedCounter: 1, storedTag: 'dGFnMQ' });

    const row = await repo.find(householdId);
    expect(row?.freshnessCounter).toBe(1);
    expect(row?.cursorTag).toBe('dGFnMQ');
  });

  it('advances the head monotonically on a strictly-higher counter', async () => {
    const householdId = randomUUID();
    await repo.createIfMissing(householdId);

    await repo.bumpFreshnessHead(householdId, deviceId, 1, 'dGFnMQ');
    const result = await repo.bumpFreshnessHead(householdId, deviceId, 2, 'dGFnMg');
    expect(result).toEqual({ storedCounter: 2, storedTag: 'dGFnMg' });

    const row = await repo.find(householdId);
    expect(row?.freshnessCounter).toBe(2);
    expect(row?.cursorTag).toBe('dGFnMg');
  });

  it('no-ops on an incoming counter <= stored, echoing the existing higher head', async () => {
    const householdId = randomUUID();
    await repo.createIfMissing(householdId);

    await repo.bumpFreshnessHead(householdId, deviceId, 5, 'dGFnNQ');

    const lower = await repo.bumpFreshnessHead(householdId, deviceId, 3, 'c3RhbGU');
    expect(lower).toEqual({ storedCounter: 5, storedTag: 'dGFnNQ' });

    const equal = await repo.bumpFreshnessHead(householdId, deviceId, 5, 'c3RhbGU');
    expect(equal).toEqual({ storedCounter: 5, storedTag: 'dGFnNQ' });

    const row = await repo.find(householdId);
    expect(row?.freshnessCounter).toBe(5);
    expect(row?.cursorTag).toBe('dGFnNQ');
  });
});

// Carry-forward primitives for a push in flight when a household-triggerable sweep ran, whose `chargeDailyQuota` landed on either side of the sweep's delete:
// the capturing delete, the `ADD`-merge that restores the counters, and the repoint that must not clobber a charge already on the row.
describe('WorkspaceMetaRepository — daily push-quota carry-forward', () => {
  let env: RepoTestEnv;
  let repo: WorkspaceMetaRepository;

  beforeAll(async () => {
    env = await createRepoTestEnv();
    repo = new WorkspaceMetaRepository(env.doc, env.config);
  });

  afterAll(async () => {
    env.destroy();
  });

  function captured(householdId: string): WorkspaceMetaRow {
    return {
      householdId,
      latestSnapshotId: null,
      latestSnapshotCursor: null,
      latestVersion: 0,
      lastUpdatedAt: '2026-09-03T00:00:00.000Z',
      mutationLogCursorBase: null,
      quotaDay: utcDayStamp(),
      dailyMutationCount: 9_999,
      dailyByteCount: 4_096,
    };
  }

  it('deleteReturningPrior hands back the row as it stood, leaves it absent, and is null on an absent row', async () => {
    const householdId = randomUUID();
    await repo.createIfMissing(householdId);
    expect(await repo.chargeDailyQuota(householdId, 3, 30, 100, 1_000)).toEqual({ ok: true });

    const prior = await repo.deleteReturningPrior(householdId);
    expect(prior).toMatchObject({
      householdId,
      quotaDay: utcDayStamp(),
      dailyMutationCount: 3,
      dailyByteCount: 30,
    });
    expect(await repo.find(householdId)).toBeNull();
    expect(await repo.deleteReturningPrior(householdId)).toBeNull();
  });

  it('carryQuotaForward lays the captured counters onto a freshly recreated row', async () => {
    const householdId = randomUUID();
    await repo.createIfMissing(householdId);

    await repo.carryQuotaForward(householdId, captured(householdId));

    expect(await repo.find(householdId)).toMatchObject({
      latestVersion: 0,
      quotaDay: utcDayStamp(),
      dailyMutationCount: 9_999,
      dailyByteCount: 4_096,
    });
  });

  it('carryQuotaForward ADDs onto a same-day charge that recreated the row first — both survive', async () => {
    const householdId = randomUUID();
    // A charge landing on the swept (absent) row recreates it with today's count of 1: the shape a conditional create would defer to and a full-row Put would clobber.
    expect(await repo.chargeDailyQuota(householdId, 1, 10, 10_000, 1_000_000)).toEqual({ ok: true });

    await repo.carryQuotaForward(householdId, captured(householdId));

    expect(await repo.find(householdId)).toMatchObject({
      quotaDay: utcDayStamp(),
      dailyMutationCount: 10_000,
      dailyByteCount: 4_106,
    });
  });

  it('carryQuotaForward drops captured counters whose day has already rolled over on the row', async () => {
    const householdId = randomUUID();
    expect(await repo.chargeDailyQuota(householdId, 1, 10, 10_000, 1_000_000)).toEqual({ ok: true });

    await repo.carryQuotaForward(householdId, {
      ...captured(householdId),
      quotaDay: '2000-01-01',
    });

    // Today's charge is authoritative; yesterday's counters are discarded, as chargeDailyQuota's own roll-over would.
    expect(await repo.find(householdId)).toMatchObject({
      quotaDay: utcDayStamp(),
      dailyMutationCount: 1,
      dailyByteCount: 10,
    });
  });

  it('carryQuotaForward is a no-op for a captured row that never pushed, and for no captured row at all', async () => {
    const householdId = randomUUID();
    await repo.createIfMissing(householdId);

    await repo.carryQuotaForward(householdId, {
      ...captured(householdId),
      quotaDay: undefined,
      dailyMutationCount: undefined,
      dailyByteCount: undefined,
    });
    await repo.carryQuotaForward(householdId, null);

    const row = await repo.find(householdId);
    expect(row?.quotaDay).toBeUndefined();
    expect(row?.dailyMutationCount).toBeUndefined();
    expect(row?.dailyByteCount).toBeUndefined();
  });

  it('reinitializeForRestore repoints and clears the freshness head WITHOUT clobbering a quota charge already on the row', async () => {
    const householdId = randomUUID();
    // A charge from a push in flight during the sweep recreated the row, and that push's best-effort head bump landed on it too.
    expect(await repo.chargeDailyQuota(householdId, 2, 20, 10_000, 1_000_000)).toEqual({ ok: true });
    await repo.bumpFreshnessHead(householdId, randomUUID(), 5, 'dGFnNQ');

    await repo.reinitializeForRestore(householdId, 'SNAP-1', 'CURSOR-1', undefined);

    const row = await repo.find(householdId);
    expect(row).toMatchObject({
      householdId,
      latestSnapshotId: 'SNAP-1',
      latestSnapshotCursor: 'CURSOR-1',
      mutationLogCursorBase: 'CURSOR-1',
      latestVersion: 0,
      quotaDay: utcDayStamp(),
      dailyMutationCount: 2,
      dailyByteCount: 20,
    });
    expect(row?.freshnessCounter).toBeUndefined();
    expect(row?.cursorTag).toBeUndefined();
  });
});
