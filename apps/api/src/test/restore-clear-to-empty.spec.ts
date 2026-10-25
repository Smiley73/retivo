// RestoreService.clearToEmpty and purgeHistory with pure stubs: the watermark is strictly above every live cursor, the empty snapshot is minted and
// WorkspaceMeta repointed before the S3 purge, a purge failure still commits, and the purgeHistoryOnly retry only purges.
import 'reflect-metadata';
import KSUID from 'ksuid';
import { RestoreService } from '../sync/restore.service.js';
import type { AccountSnapshotPurgeService } from '../auth/account-snapshot-purge.service.js';
import type { HouseholdSweepService } from '../auth/household-sweep.service.js';
import type { AggregateVersionRepository } from '../dynamo/aggregate-version.repository.js';
import type { MutationLogRepository } from '../dynamo/mutation-log.repository.js';
import type { WorkspaceMetaRepository } from '../dynamo/workspace-meta.repository.js';
import type { SnapshotsService } from '../sync/snapshots.service.js';

const HH = 'household-1';

function backdatedKsuid(minsAgo = 10): string {
  return KSUID.fromParts(Date.now() - minsAgo * 60_000, Buffer.alloc(16)).string;
}

// An all-0xff payload in the current second: a fresh same-second KSUID cannot beat it, so only the next-second strict successor dominates, the branch backdated cursors never reach.
function currentSecondMaxPayloadKsuid(): string {
  return KSUID.fromParts(Date.now(), Buffer.alloc(16, 0xff)).string;
}

// Pins the `fresh` clock KSUID below so the `bumped` (strict-successor) branch is exercised without a second-boundary flake.
function pinFreshBelow(): jest.SpyInstance {
  return jest
    .spyOn(KSUID, 'random')
    .mockResolvedValue(KSUID.fromParts(Date.now() - 60_000, Buffer.alloc(16)));
}

interface Harness {
  service: RestoreService;
  write: jest.Mock;
  sweep: jest.Mock;
  find: jest.Mock;
  reinit: jest.Mock;
  carryQuota: jest.Mock;
  maxSequenceId: jest.Mock;
  purge: jest.Mock;
}

function makeService(): Harness {
  const write = jest.fn().mockResolvedValue('SNAP-NEW');
  const sweep = jest.fn().mockResolvedValue({ priorWorkspaceMeta: null });
  const find = jest.fn().mockResolvedValue(null);
  const reinit = jest.fn().mockResolvedValue(undefined);
  const carryQuota = jest.fn().mockResolvedValue(undefined);
  const maxSequenceId = jest.fn().mockResolvedValue(null);
  const purge = jest.fn().mockResolvedValue(undefined);
  const service = new RestoreService(
    {
      write,
      fetch: jest.fn(),
      fetchStrict: jest.fn(),
      keyFor: (hh: string, id: string) => `${hh}/${id}.json.gz`,
    } as unknown as SnapshotsService,
    { sweepHouseholdData: sweep } as unknown as HouseholdSweepService,
    // `findConsistent` shares `find`'s jest.fn: `restore()` and the watermark use findConsistent while `purgeHistory` uses `find`, so one setup governs both.
    {
      find,
      findConsistent: find,
      reinitializeForRestore: reinit,
      carryQuotaForward: carryQuota,
    } as unknown as WorkspaceMetaRepository,
    { put: jest.fn() } as unknown as AggregateVersionRepository,
    { maxSequenceId } as unknown as MutationLogRepository,
    { purge } as unknown as AccountSnapshotPurgeService,
  );
  return { service, write, sweep, find, reinit, carryQuota, maxSequenceId, purge };
}

describe('RestoreService.clearToEmpty', () => {
  it('sweeps, mints an empty snapshot, and repoints WorkspaceMeta with a watermark strictly greater than the pre-clear head', async () => {
    const h = makeService();
    const head = backdatedKsuid();
    h.maxSequenceId.mockResolvedValue(head);

    const res = await h.service.clearToEmpty(HH, { eraseHistory: false });

    expect(res).toEqual({ historyErased: false });
    // Fenced on the epoch observed before the sweep: undefined here since `find` defaults to null.
    expect(h.sweep).toHaveBeenCalledWith(HH, {
      restoreEpochFence: { observedEpoch: undefined },
    });

    expect(h.write).toHaveBeenCalledTimes(1);
    const [wHh, content] = h.write.mock.calls[0];
    expect(wHh).toBe(HH);
    expect(content.aggregates).toEqual([]);
    const watermark = content.cutoff as string;
    // Strictly greater than the pre-clear head: PullService uses `since < watermark`, so equality would never expire.
    expect(watermark > head).toBe(true);
    expect(KSUID.parse(watermark).string).toBe(watermark);

    expect(h.reinit).toHaveBeenCalledWith(HH, 'SNAP-NEW', watermark, undefined);

    expect(h.purge).not.toHaveBeenCalled();

    expect(h.sweep.mock.invocationCallOrder[0]).toBeLessThan(
      h.write.mock.invocationCallOrder[0],
    );
    expect(h.write.mock.invocationCallOrder[0]).toBeLessThan(
      h.reinit.mock.invocationCallOrder[0],
    );
  });

  it('carries the daily push-quota captured BY THE SWEEP forward — never the pre-sweep watermark read — merged after the repoint', async () => {
    const h = makeService();
    // The pre-sweep read feeds only the watermark and is stale: an in-flight push charged one more mutation before the sweep's capturing delete, and a carry-forward from this read would hand that charge back.
    h.find.mockResolvedValue({
      householdId: HH,
      latestSnapshotId: null,
      latestSnapshotCursor: null,
      latestVersion: 0,
      lastUpdatedAt: '2026-09-03T00:00:00.000Z',
      mutationLogCursorBase: null,
      quotaDay: '2026-09-03',
      dailyMutationCount: 9_999,
      dailyByteCount: 10,
    });
    const captured = {
      householdId: HH,
      latestSnapshotId: null,
      latestSnapshotCursor: null,
      latestVersion: 0,
      lastUpdatedAt: '2026-09-03T00:00:01.000Z',
      mutationLogCursorBase: null,
      quotaDay: '2026-09-03',
      dailyMutationCount: 10_000,
      dailyByteCount: 20,
    };
    h.sweep.mockResolvedValue({ priorWorkspaceMeta: captured });

    await h.service.clearToEmpty(HH, { eraseHistory: false });

    expect(h.reinit).toHaveBeenCalledTimes(1);
    expect(h.reinit.mock.calls[0]).toHaveLength(4);
    expect(h.carryQuota).toHaveBeenCalledTimes(1);
    expect(h.carryQuota).toHaveBeenCalledWith(HH, captured);
    expect(h.reinit.mock.invocationCallOrder[0]).toBeLessThan(
      h.carryQuota.mock.invocationCallOrder[0],
    );
  });

  it('derives the watermark above the HIGHEST of the head and stored meta cursors', async () => {
    const h = makeService();
    const head = backdatedKsuid(20);
    const metaCursor = backdatedKsuid(5); // more recent → lexically higher
    h.maxSequenceId.mockResolvedValue(head);
    h.find.mockResolvedValue({
      latestSnapshotCursor: metaCursor,
      mutationLogCursorBase: null,
    });

    await h.service.clearToEmpty(HH, { eraseHistory: false });

    const watermark = h.write.mock.calls[0][1].cutoff as string;
    expect(watermark > metaCursor).toBe(true);
    expect(watermark > head).toBe(true);
  });

  it('takes the strict-successor (bumped = max + 1s) path for a current-second head with a maximal payload, computing the watermark BEFORE the sweep', async () => {
    const h = makeService();
    // A current-second head with an all-0xff payload exercises the `bumped` branch a backdated head never reaches.
    const head = currentSecondMaxPayloadKsuid();
    h.maxSequenceId.mockResolvedValue(head);
    const freshSpy = pinFreshBelow();
    try {
      await h.service.clearToEmpty(HH, { eraseHistory: false });
    } finally {
      freshSpy.mockRestore();
    }

    const watermark = h.write.mock.calls[0][1].cutoff as string;
    const headParsed = KSUID.parse(head);
    const wmParsed = KSUID.parse(watermark);
    expect(watermark > head).toBe(true);
    expect(wmParsed.date.getTime()).toBe(headParsed.date.getTime() + 1000);
    expect(wmParsed.payload.equals(Buffer.alloc(16))).toBe(true);

    // Both cursor sources are read before the sweep that deletes them.
    expect(h.maxSequenceId.mock.invocationCallOrder[0]).toBeLessThan(
      h.sweep.mock.invocationCallOrder[0],
    );
    expect(h.find.mock.invocationCallOrder[0]).toBeLessThan(
      h.sweep.mock.invocationCallOrder[0],
    );
  });

  it('mints a valid KSUID watermark for an empty household (no head, no meta cursors)', async () => {
    const h = makeService();
    await h.service.clearToEmpty(HH, { eraseHistory: false });
    const watermark = h.write.mock.calls[0][1].cutoff as string;
    expect(watermark).toHaveLength(27);
    expect(KSUID.parse(watermark).string).toBe(watermark);
  });

  it('eraseHistory=true purges LAST with the new empty snapshot as the keep-key (historyErased:true)', async () => {
    const h = makeService();
    h.maxSequenceId.mockResolvedValue(backdatedKsuid());

    const res = await h.service.clearToEmpty(HH, { eraseHistory: true });

    expect(res).toEqual({ historyErased: true });
    expect(h.purge).toHaveBeenCalledWith(HH, {
      keepKeys: [`${HH}/SNAP-NEW.json.gz`],
    });
    expect(h.reinit.mock.invocationCallOrder[0]).toBeLessThan(
      h.purge.mock.invocationCallOrder[0],
    );
  });

  it('still commits the clear when the erase-history purge fails (historyErased:false)', async () => {
    const h = makeService();
    h.maxSequenceId.mockResolvedValue(backdatedKsuid());
    h.purge.mockRejectedValue(new Error('forced failure'));

    const res = await h.service.clearToEmpty(HH, { eraseHistory: true });

    expect(res).toEqual({ historyErased: false });
    expect(h.sweep).toHaveBeenCalledWith(HH, {
      restoreEpochFence: { observedEpoch: undefined },
    });
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.reinit).toHaveBeenCalledTimes(1);
  });
});

describe('RestoreService convergence watermark (computeConvergenceWatermark)', () => {
  it('bumps off meta.mutationLogCursorBase when it dominates the head + snapshot cursor', async () => {
    const h = makeService();
    h.maxSequenceId.mockResolvedValue(backdatedKsuid(20));
    const dominant = currentSecondMaxPayloadKsuid();
    h.find.mockResolvedValue({
      latestSnapshotCursor: backdatedKsuid(15),
      mutationLogCursorBase: dominant,
    });
    const freshSpy = pinFreshBelow();
    try {
      await h.service.clearToEmpty(HH, { eraseHistory: false });
    } finally {
      freshSpy.mockRestore();
    }

    const watermark = h.write.mock.calls[0][1].cutoff as string;
    expect(watermark > dominant).toBe(true);
    expect(KSUID.parse(watermark).date.getTime()).toBe(
      KSUID.parse(dominant).date.getTime() + 1000,
    );
    expect(KSUID.parse(watermark).string).toBe(watermark); // round-trippable
  });

  it('falls back to a fresh clock KSUID when the max cursor is a non-KSUID sentinel (legacy "0")', async () => {
    const h = makeService();
    h.maxSequenceId.mockResolvedValue('0'); // legacy sentinel — KSUID.parse throws

    await h.service.clearToEmpty(HH, { eraseHistory: false });

    const watermark = h.write.mock.calls[0][1].cutoff as string;
    expect(watermark > '0').toBe(true);
    expect(watermark).toHaveLength(27);
    expect(KSUID.parse(watermark).string).toBe(watermark); // valid, round-trippable
  });
});

describe('RestoreService.purgeHistory (erase-history retry)', () => {
  it('purges every snapshot except the live WorkspaceMeta snapshot, without sweeping/minting/repointing', async () => {
    const h = makeService();
    h.find.mockResolvedValue({ latestSnapshotId: 'LIVE' });

    const res = await h.service.purgeHistory(HH);

    expect(res).toEqual({ historyErased: true });
    expect(h.purge).toHaveBeenCalledWith(HH, {
      keepKeys: [`${HH}/LIVE.json.gz`],
    });
    expect(h.sweep).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.reinit).not.toHaveBeenCalled();
  });

  it('reports historyErased:false (not a false success) when there is no live snapshot pointer to purge against', async () => {
    const h = makeService();
    h.find.mockResolvedValue(null);

    const res = await h.service.purgeHistory(HH);

    expect(res).toEqual({ historyErased: false });
    expect(h.purge).not.toHaveBeenCalled();
  });

  it('reports historyErased:false when the retry purge fails', async () => {
    const h = makeService();
    h.find.mockResolvedValue({ latestSnapshotId: 'LIVE' });
    h.purge.mockRejectedValue(new Error('forced failure'));

    const res = await h.service.purgeHistory(HH);

    expect(res).toEqual({ historyErased: false });
  });
});
