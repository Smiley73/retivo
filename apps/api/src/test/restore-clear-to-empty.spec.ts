/**
 * Unit tests for RestoreService.clearToEmpty / purgeHistory.
 * Constructs the service with pure stubs (no
 * AppModule / emulator), so it verifies the decisive server logic directly:
 *   - the convergence watermark is strictly greater than every live cursor
 *     (guards the equality-at-head off-by-one),
 *   - the empty snapshot is minted + WorkspaceMeta repointed BEFORE the S3
 *     purge (purge-last) with the new snapshot as the keep-key,
 *   - a purge failure still commits the clear (historyErased:false),
 *   - the purgeHistoryOnly retry purges against the live snapshot WITHOUT
 *     sweeping / minting / repointing.
 *
 * The full HTTP + DynamoDB + S3 path is covered by clear-workspace.spec.ts
 * and clear-workspace-purge-order.spec.ts.
 */
import 'reflect-metadata';
import KSUID from 'ksuid';
import { RestoreService } from '../sync/restore.service.js';
import { SnapshotPurgeError } from '../auth/account-snapshot-purge.service.js';
import type { AccountSnapshotPurgeService } from '../auth/account-snapshot-purge.service.js';
import type { HouseholdSweepService } from '../auth/household-sweep.service.js';
import type { AggregateVersionRepository } from '../dynamo/aggregate-version.repository.js';
import type { MutationLogRepository } from '../dynamo/mutation-log.repository.js';
import type { WorkspaceMetaRepository } from '../dynamo/workspace-meta.repository.js';
import type { SnapshotsService } from '../sync/snapshots.service.js';

const HH = 'household-1';

/** A KSUID timestamped `minsAgo` in the past (deterministic ordering). */
function backdatedKsuid(minsAgo = 10): string {
  return KSUID.fromParts(Date.now() - minsAgo * 60_000, Buffer.alloc(16)).string;
}

/**
 * A current-second KSUID carrying the MAXIMAL payload (all 0xff). A fresh
 * same-second KSUID can never beat it on payload, so only the next-second
 * strict successor (zero payload, ts+1s) dominates it — the branch that
 * backdated cursors never reach (there a fresh clock KSUID trivially wins).
 */
function currentSecondMaxPayloadKsuid(): string {
  return KSUID.fromParts(Date.now(), Buffer.alloc(16, 0xff)).string;
}

/**
 * Pin `computeConvergenceWatermark`'s `fresh` clock KSUID to a deterministic
 * backdated value so the `bumped` (strict-successor) branch is exercised
 * without a wall-clock-second-boundary flake. Returns the spy for restore.
 */
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
      // Mirror the real single-source key builder so the erase-history
      // keep-key matches the format the purge lists against.
      keyFor: (hh: string, id: string) => `${hh}/${id}.json.gz`,
    } as unknown as SnapshotsService,
    { sweepHouseholdData: sweep } as unknown as HouseholdSweepService,
    // `findConsistent` reuses the same jest.fn as `find` (not a second,
    // independently-configured mock): `restore()` and
    // `computeConvergenceWatermark` call `findConsistent` (strong
    // read), while `purgeHistory` still calls plain `find` — sharing one
    // mock keeps every existing `h.find.mockResolvedValue(...)` setup in
    // this suite governing both call sites without duplicating it.
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
    // Fenced on the epoch observed before the sweep — undefined here
    // since `find` defaults to null (no prior WorkspaceMeta row).
    expect(h.sweep).toHaveBeenCalledWith(HH, {
      restoreEpochFence: { observedEpoch: undefined },
    });

    // Empty snapshot minted with the watermark as its cutoff.
    expect(h.write).toHaveBeenCalledTimes(1);
    const [wHh, content] = h.write.mock.calls[0];
    expect(wHh).toBe(HH);
    expect(content.aggregates).toEqual([]);
    const watermark = content.cutoff as string;
    // Strictly greater than the pre-clear head cursor a synced device holds
    // (PullService uses `since < watermark`, so equality would never expire).
    expect(watermark > head).toBe(true);
    // Valid, round-trippable KSUID.
    expect(KSUID.parse(watermark).string).toBe(watermark);

    // WorkspaceMeta repointed at the new snapshot with the same watermark.
    // The 4th arg is the epoch observed before the sweep — undefined
    // here since `find` defaults to null (no prior WorkspaceMeta row).
    expect(h.reinit).toHaveBeenCalledWith(HH, 'SNAP-NEW', watermark, undefined);

    // No S3 purge when eraseHistory is off.
    expect(h.purge).not.toHaveBeenCalled();

    // Ordering: sweep → write → repoint.
    expect(h.sweep.mock.invocationCallOrder[0]).toBeLessThan(
      h.write.mock.invocationCallOrder[0],
    );
    expect(h.write.mock.invocationCallOrder[0]).toBeLessThan(
      h.reinit.mock.invocationCallOrder[0],
    );
  });

  it('carries the daily push-quota captured BY THE SWEEP forward — never the pre-sweep watermark read — merged after the repoint', async () => {
    const h = makeService();
    // The pre-sweep read feeds only the watermark, and is stale here: an
    // in-flight push charged one more mutation between it and the sweep's
    // capturing delete. A carry-forward taken from this read would hand the
    // household that charge back.
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

    // The repoint carries NO quota fields of its own ...
    expect(h.reinit).toHaveBeenCalledTimes(1);
    expect(h.reinit.mock.calls[0]).toHaveLength(4);
    // ... the merge uses exactly what the sweep's delete returned ...
    expect(h.carryQuota).toHaveBeenCalledTimes(1);
    expect(h.carryQuota).toHaveBeenCalledWith(HH, captured);
    // ... and runs after the pointer flip, which stays the last
    // pointer-relevant step.
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
    // A current-second head with an all-0xff payload: a fresh same-second
    // KSUID can't beat it on payload, so only the next-second successor
    // dominates — the `bumped` branch a backdated head never reaches.
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
    // The `bumped` signature: exactly one second above the head, zero payload —
    // proves the strict successor, not the `fresh` fallback, produced it.
    expect(wmParsed.date.getTime()).toBe(headParsed.date.getTime() + 1000);
    expect(wmParsed.payload.equals(Buffer.alloc(16))).toBe(true);

    // Compute-before-sweep: both cursor sources are read BEFORE the sweep that
    // deletes them (otherwise the watermark could never be derived).
    expect(h.maxSequenceId.mock.invocationCallOrder[0]).toBeLessThan(
      h.sweep.mock.invocationCallOrder[0],
    );
    expect(h.find.mock.invocationCallOrder[0]).toBeLessThan(
      h.sweep.mock.invocationCallOrder[0],
    );
  });

  it('mints a valid KSUID watermark for an empty household (no head, no meta cursors)', async () => {
    const h = makeService();
    // maxSequenceId → null, find → null (defaults).
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
    // Purge runs AFTER the repoint (purge-last).
    expect(h.reinit.mock.invocationCallOrder[0]).toBeLessThan(
      h.purge.mock.invocationCallOrder[0],
    );
  });

  it('still commits the clear when the erase-history purge fails (historyErased:false)', async () => {
    const h = makeService();
    h.maxSequenceId.mockResolvedValue(backdatedKsuid());
    h.purge.mockRejectedValue(new SnapshotPurgeError('forced failure'));

    const res = await h.service.clearToEmpty(HH, { eraseHistory: true });

    expect(res).toEqual({ historyErased: false });
    // The clear itself committed — sweep + mint + repoint all ran.
    // Fenced on the epoch observed before the sweep — undefined here
    // since `find` defaults to null (no prior WorkspaceMeta row).
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
    // head + snapshot cursor are backdated; mutationLogCursorBase is the
    // current-second, maximal-payload dominant candidate.
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
    // Bumped off mutationLogCursorBase specifically (one second above it) —
    // proves it is folded into the candidate set, not ignored.
    expect(KSUID.parse(watermark).date.getTime()).toBe(
      KSUID.parse(dominant).date.getTime() + 1000,
    );
    expect(KSUID.parse(watermark).string).toBe(watermark); // round-trippable
  });

  it('falls back to a fresh clock KSUID when the max cursor is a non-KSUID sentinel (legacy "0")', async () => {
    const h = makeService();
    h.maxSequenceId.mockResolvedValue('0'); // legacy sentinel — KSUID.parse throws
    // find → null (default), so '0' is the sole candidate.

    await h.service.clearToEmpty(HH, { eraseHistory: false });

    const watermark = h.write.mock.calls[0][1].cutoff as string;
    // A real KSUID is lexically above the '0' sentinel, so the fresh fallback
    // still dominates the input.
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
    // No destructive sweep / mint / repoint on the retry.
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
    h.purge.mockRejectedValue(new SnapshotPurgeError('forced failure'));

    const res = await h.service.purgeHistory(HH);

    expect(res).toEqual({ historyErased: false });
  });
});
