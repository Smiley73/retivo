/**
 * Compactor safety-budget + restore-epoch race-guard tests (starvation + silent-undo fixes). Colocated with the emulator harness in
 * `compactor.spec.ts` / `restore.spec.ts`, kept in its own file so the
 * budget field mutation (`compactor.budgets = {...}`) can't leak into
 * unrelated tests via the shared `CompactorService` DI singleton — every
 * test that overrides it restores the default in a `finally`.
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import KSUID from 'ksuid';
import {
  bootstrapTestApp,
  signupVerifyLogin as loginAsFreshUser,
  type Session,
  type TestApp,
} from './test-helpers.js';
import {
  CompactorBudgetSkipError,
  CompactorService,
  type CompactorBudgets,
} from '../compactor/compactor.service.js';
import { RestoreService } from '../sync/restore.service.js';
import { SnapshotsService } from '../sync/snapshots.service.js';
import { AggregateVersionRepository } from '../dynamo/aggregate-version.repository.js';
import {
  RestoreEpochLostError,
  WorkspaceMetaRepository,
} from '../dynamo/workspace-meta.repository.js';
import { S3_CLIENT } from '../aws/aws.module.js';

/** Mint a sequenceId backdated past the compactor's 60 s safety margin. */
function backdatedSeq(slot: number): string {
  return KSUID.fromParts(Date.now() - 10 * 60_000 + slot * 1000, Buffer.alloc(16)).string;
}

function tableName(t: TestApp, key: string): string {
  return t.module.get(ConfigService).get(key, { infer: true } as never) as unknown as string;
}

async function seedWorkspaceMeta(t: TestApp, s: Session): Promise<void> {
  try {
    await t.doc.send(
      new PutCommand({
        TableName: tableName(t, 'TABLE_WORKSPACE_META'),
        Item: {
          householdId: s.householdId,
          latestSnapshotId: null,
          latestSnapshotCursor: null,
          latestVersion: 0,
          lastUpdatedAt: new Date().toISOString(),
          mutationLogCursorBase: null,
        },
        ConditionExpression: 'attribute_not_exists(householdId)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
}

async function seedMutationLogRow(
  t: TestApp,
  s: Session,
  row: {
    aggregateId: string;
    version: number;
    payload: Record<string, unknown>;
    sequenceId: string;
  },
): Promise<void> {
  await seedWorkspaceMeta(t, s);
  await t.doc.send(
    new PutCommand({
      TableName: tableName(t, 'TABLE_MUTATION_LOG'),
      Item: {
        householdId: s.householdId,
        sequenceId: row.sequenceId,
        deviceId: s.deviceId,
        aggregateId: row.aggregateId,
        aggregateType: 'household',
        operation: 'create',
        payload: JSON.stringify(row.payload),
        version: row.version,
        timestamp: Date.now(),
        schemaVersion: 1,
      },
    }),
  );
}

async function fetchMeta(
  t: TestApp,
  householdId: string,
): Promise<Record<string, unknown> | undefined> {
  const r = await t.doc.send(
    new GetCommand({
      TableName: tableName(t, 'TABLE_WORKSPACE_META'),
      Key: { householdId },
    }),
  );
  return r.Item as Record<string, unknown> | undefined;
}

async function householdLogRowCount(t: TestApp, householdId: string): Promise<number> {
  const r = await t.doc.send(
    new QueryCommand({
      TableName: tableName(t, 'TABLE_MUTATION_LOG'),
      KeyConditionExpression: 'householdId = :h',
      ExpressionAttributeValues: { ':h': householdId },
    }),
  );
  return (r.Items ?? []).length;
}

/** Capture EMF lines written via the compactor's synchronous fd-1 write. */
function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const realWriteSync = fs.writeSync.bind(fs);
  const spy = jest
    .spyOn(fs, 'writeSync')
    .mockImplementation(((fd: number, data: unknown, ...rest: unknown[]): number => {
      if (fd === 1) {
        const raw = String(data);
        lines.push(raw);
        return Buffer.byteLength(raw);
      }
      return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
    }) as unknown as typeof fs.writeSync);
  return { lines, restore: () => spy.mockRestore() };
}

function budgetLimitedEmf(lines: string[]): Record<string, unknown> | undefined {
  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .find(
      (p): p is Record<string, unknown> =>
        p !== undefined && typeof p === 'object' && 'CompactorBudgetLimited' in p,
    );
}

describe('compactor safety budgets', () => {
  let t: TestApp;
  let compactor: CompactorService;
  let defaultBudgets: CompactorBudgets;

  beforeAll(async () => {
    t = await bootstrapTestApp();
    compactor = t.module.get(CompactorService);
    defaultBudgets = compactor.budgets;
  });

  afterAll(async () => {
    await t.app.close();
  });

  afterEach(() => {
    compactor.budgets = defaultBudgets;
  });

  it('starvation fix (criterion 4): a household whose pass THROWS a budget skip does not stop the household visited right after it from compacting in the same run', async () => {
    const heavy = await loginAsFreshUser(t);
    const light = await loginAsFreshUser(t);
    // heavy: compact once under default budgets so it owns a baseline
    // snapshot, then seed a row above the cursor so the next pass must
    // re-read that baseline — the read a 10-byte decompression cap makes
    // THROW (`CompactorBudgetSkipError` 'baseline_oversized'). A prefix-shaped
    // budget trip would not do here: it returns a metric normally and could
    // never stop the loop, so the assertions below would stay green with the
    // continuation logic in `runOnce` removed entirely.
    await seedMutationLogRow(t, heavy, {
      aggregateId: randomUUID(),
      version: 1,
      payload: { name: 'heavy-base', currency: 'USD' },
      sequenceId: backdatedSeq(0),
    });
    expect(await compactor.compactHousehold(heavy.householdId)).not.toBeNull();
    const heavyMetaBefore = await fetchMeta(t, heavy.householdId);
    await seedMutationLogRow(t, heavy, {
      aggregateId: randomUUID(),
      version: 1,
      payload: { name: 'heavy-inflight', currency: 'USD' },
      sequenceId: backdatedSeq(5),
    });
    // light: no baseline yet (nothing to decompress), one row to fold.
    await seedMutationLogRow(t, light, {
      aggregateId: randomUUID(),
      version: 1,
      payload: { name: 'light', currency: 'USD' },
      sequenceId: backdatedSeq(10),
    });

    // Deterministic visiting order heavy → light: pin the household
    // enumeration to exactly these two and the fairness rotation's offset to
    // 0, so the run must SURVIVE heavy's throw before it ever reaches light.
    // Left to the real rotation, light is visited first half the time and
    // the test would pass without the continuation ever being exercised.
    const listSpy = jest
      .spyOn(
        compactor as unknown as { listHouseholdIds: () => Promise<string[]> },
        'listHouseholdIds',
      )
      .mockResolvedValue([heavy.householdId, light.householdId]);
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
    compactor.budgets = { ...defaultBudgets, maxSnapshotBytes: 10 };
    let summary: Awaited<ReturnType<CompactorService['runOnce']>>;
    try {
      summary = await compactor.runOnce();
    } finally {
      listSpy.mockRestore();
      randomSpy.mockRestore();
      compactor.budgets = defaultBudgets;
    }

    // heavy was a TRUE skip, recorded through the budget-specific catch
    // branch (not the generic failure path, which would not record it).
    expect(summary.budgetLimitedHouseholdIds).toEqual([heavy.householdId]);
    expect(summary.householdsSkipped).toBe(1);
    expect(summary.householdsProcessed).toBe(1);
    const heavyMetaAfter = await fetchMeta(t, heavy.householdId);
    expect(heavyMetaAfter?.latestSnapshotId).toBe(heavyMetaBefore?.latestSnapshotId);

    // light — visited AFTER the throw — still compacted in the SAME run.
    const lightMeta = await fetchMeta(t, light.householdId);
    expect(lightMeta?.latestSnapshotId).toBeTruthy();
  });

  it('prefix progress + metric emission: an over-budget household compacts a bounded prefix, the cursor lands on the prefix, unfolded rows survive, a second run drains them, and the EMF metric is emitted correctly', async () => {
    const s = await loginAsFreshUser(t);
    const seqs = [backdatedSeq(0), backdatedSeq(1), backdatedSeq(2)];
    const aggIds = [randomUUID(), randomUUID(), randomUUID()];
    for (let i = 0; i < 3; i++) {
      await seedMutationLogRow(t, s, {
        aggregateId: aggIds[i],
        version: 1,
        payload: { name: `P${i}`, currency: 'USD' },
        sequenceId: seqs[i],
      });
    }

    compactor.budgets = { ...defaultBudgets, maxLogRows: 2 };
    const capture = captureStdout();
    let metric: Awaited<ReturnType<CompactorService['compactHousehold']>>;
    try {
      metric = await compactor.compactHousehold(s.householdId);
    } finally {
      capture.restore();
    }
    expect(metric).not.toBeNull();
    expect(metric!.mutationsCompacted).toBe(2);
    expect(metric!.budgetLimited).toBe(true);

    // The cursor lands EXACTLY on the prefix's last folded row.
    const meta = await fetchMeta(t, s.householdId);
    expect(meta?.latestSnapshotCursor).toBe(seqs[1]);

    // The row above the prefix survives — not deleted, not lost.
    expect(await householdLogRowCount(t, s.householdId)).toBe(1);

    // EMF: per-stack namespace, no custom dimensions.
    const emf = budgetLimitedEmf(capture.lines);
    expect(emf).toBeTruthy();
    const aws = emf!._aws as {
      CloudWatchMetrics: Array<{
        Namespace: string;
        Dimensions: string[][];
        Metrics: Array<{ Name: string }>;
      }>;
    };
    expect(aws.CloudWatchMetrics[0].Namespace).toBe('Retivo/local/Compactor');
    expect(aws.CloudWatchMetrics[0].Dimensions).toEqual([[]]);
    expect(aws.CloudWatchMetrics[0].Metrics).toEqual(
      expect.arrayContaining([expect.objectContaining({ Name: 'CompactorBudgetLimited' })]),
    );
    expect(JSON.stringify(emf)).not.toContain(s.householdId);

    // A second run (default budgets) drains the surviving row.
    compactor.budgets = defaultBudgets;
    const second = await compactor.compactHousehold(s.householdId);
    expect(second).not.toBeNull();
    expect(second!.mutationsCompacted).toBe(1);
    expect(await householdLogRowCount(t, s.householdId)).toBe(0);
  });

  it('true skip: an oversized baseline leaves the cursor + latestSnapshotId untouched, writes no snapshot, deletes nothing, emits the budget metric, and the run continues', async () => {
    const s = await loginAsFreshUser(t);
    await seedMutationLogRow(t, s, {
      aggregateId: randomUUID(),
      version: 1,
      payload: { name: 'Base', currency: 'USD' },
      sequenceId: backdatedSeq(0),
    });
    const first = await compactor.compactHousehold(s.householdId);
    expect(first).not.toBeNull();
    const metaBefore = await fetchMeta(t, s.householdId);

    // A new mutation forces the next pass to re-read the just-written
    // baseline before merging — that decompressed read is what we bound.
    await seedMutationLogRow(t, s, {
      aggregateId: randomUUID(),
      version: 1,
      payload: { name: 'InFlight', currency: 'USD' },
      sequenceId: backdatedSeq(5),
    });
    const rowCountBefore = await householdLogRowCount(t, s.householdId);

    compactor.budgets = { ...defaultBudgets, maxSnapshotBytes: 10 };
    const capture = captureStdout();
    let err: unknown;
    try {
      await compactor.compactHousehold(s.householdId);
    } catch (e) {
      err = e;
    } finally {
      capture.restore();
    }
    expect(err).toBeInstanceOf(CompactorBudgetSkipError);
    expect((err as CompactorBudgetSkipError).budgetCause).toBe('baseline_oversized');

    // True skip: nothing moved.
    const metaAfter = await fetchMeta(t, s.householdId);
    expect(metaAfter?.latestSnapshotId).toBe(metaBefore?.latestSnapshotId);
    expect(metaAfter?.latestSnapshotCursor).toBe(metaBefore?.latestSnapshotCursor);
    expect(await householdLogRowCount(t, s.householdId)).toBe(rowCountBefore);

    const emf = budgetLimitedEmf(capture.lines);
    expect(emf).toBeTruthy();

    // The run continues past a household whose compactHousehold throws —
    // runOnce catches CompactorBudgetSkipError specifically (not a failure).
    compactor.budgets = defaultBudgets;
    const other = await loginAsFreshUser(t);
    await seedMutationLogRow(t, other, {
      aggregateId: randomUUID(),
      version: 1,
      payload: { name: 'Other', currency: 'USD' },
      sequenceId: backdatedSeq(20),
    });
    compactor.budgets = { ...defaultBudgets, maxSnapshotBytes: 10 };
    let summary: Awaited<ReturnType<CompactorService['runOnce']>> | undefined;
    try {
      summary = await compactor.runOnce();
    } finally {
      compactor.budgets = defaultBudgets;
    }
    expect(summary!.budgetLimitedHouseholdIds).toContain(s.householdId);
    const otherMeta = await fetchMeta(t, other.householdId);
    expect(otherMeta?.latestSnapshotId).toBeTruthy();
  });
});

describe('restore-epoch race guard', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('a compactor pass whose S3 write races a same-cutoff restore aborts before the cursor flip — the restore wins and no log rows are deleted (discriminating shape)', async () => {
    const s = await loginAsFreshUser(t);
    await seedMutationLogRow(t, s, {
      aggregateId: randomUUID(),
      version: 1,
      payload: { name: 'Base', currency: 'USD' },
      sequenceId: backdatedSeq(0),
    });
    const compactor = t.module.get(CompactorService);
    const restoreService = t.module.get(RestoreService);

    const firstMetric = await compactor.compactHousehold(s.householdId);
    expect(firstMetric).not.toBeNull();
    const metaAfterFirst = await fetchMeta(t, s.householdId);
    const firstSnapshotId = metaAfterFirst?.latestSnapshotId as string;
    expect(metaAfterFirst?.latestSnapshotCursor).toBeTruthy();

    // A second mutation above the cursor drives a real second compaction
    // pass that reads `latestSnapshotCursor` as the SAME value the restore
    // below will restore to — the discriminating shape: any test where the
    // cursor changes proves nothing, because the existing cursor-only guard
    // already catches that.
    await seedMutationLogRow(t, s, {
      aggregateId: randomUUID(),
      version: 1,
      payload: { name: 'InFlight', currency: 'USD' },
      sequenceId: backdatedSeq(5),
    });

    // Intercept the compactor's OWN snapshot PutObjectCommand — the last
    // awaited S3 step before its conditional cursor-advance UpdateCommand —
    // and, on that ONE call, synchronously run a full restore back to the
    // FIRST snapshot (cutoff === the cursor this pass observed).
    const s3 = t.module.get<S3Client>(S3_CLIENT);
    const realSend = s3.send.bind(s3);
    let intercepted = false;
    const s3Spy = jest
      .spyOn(s3, 'send')
      .mockImplementation(async (command: unknown, ...rest: unknown[]) => {
        const result = await (realSend as (...a: unknown[]) => unknown)(command, ...rest);
        if (!intercepted && command instanceof PutObjectCommand) {
          intercepted = true;
          await restoreService.restore(s.householdId, firstSnapshotId);
        }
        return result;
      });

    let metric: unknown;
    try {
      metric = await compactor.compactHousehold(s.householdId);
    } finally {
      s3Spy.mockRestore();
    }
    // Aborted: lost the epoch race (the existing ConditionalCheckFailedException
    // branch — warn, return null, retry next hour).
    expect(metric).toBeNull();

    const metaAfter = await fetchMeta(t, s.householdId);
    // The restore's fresh snapshot still owns the pointer, not the
    // compactor's just-written (now orphaned in S3) snapshot.
    expect(metaAfter?.latestSnapshotId).not.toBe(firstSnapshotId);
    expect(metaAfter?.restoreEpoch).toBe(1);

    // `metric === null` above already certifies the compactor's own
    // coverage-guarded delete phase never ran — the abort happens in the
    // cursor-advance catch block, structurally BEFORE `deleteUpToCutoff` is
    // ever called. A raw MutationLog row-count check would not discriminate
    // here: the restore's OWN household sweep (a normal, expected part of
    // every restore) already deletes every row regardless of whether the
    // compactor's guard fires, so an empty log post-race proves nothing
    // about the compactor. What the guard prevents is the SILENT DATA LOSS
    // shape — the compactor overwriting `latestSnapshotId` back to a
    // snapshot built from the pre-restore log — which the assertions above
    // already rule out.
    expect(await householdLogRowCount(t, s.householdId)).toBe(0);
  });

  it('epoch monotonicity across the sweep gap: a recreated epoch-less row does not defeat the restore, and a concurrent stale restore loses the race and throws instead of a false success', async () => {
    const s = await loginAsFreshUser(t);
    const workspaceMeta = t.module.get(WorkspaceMetaRepository);
    const householdId = s.householdId;

    // Two concurrent restores BOTH observe the epoch as absent (the ordinary
    // first-ever-restore case for this household).
    const observedEpoch = undefined;

    // The sweep gap: between "the sweep deleted the row" and "the restore's
    // own write", a concurrent bootstrap's createIfMissing legitimately
    // recreates an epoch-less row.
    await workspaceMeta.createIfMissing(householdId);
    const recreated = await workspaceMeta.find(householdId);
    expect(recreated?.restoreEpoch).toBeUndefined();

    // The FIRST restore's write still wins against that recreated row — an
    // absent epoch is a distinct pinned state, not a live epoch to beat.
    await workspaceMeta.reinitializeForRestore(householdId, 'snap-a', '0', observedEpoch);
    const afterFirst = await workspaceMeta.find(householdId);
    expect(afterFirst?.restoreEpoch).toBe(1);
    expect(afterFirst?.latestSnapshotId).toBe('snap-a');

    // The SECOND, concurrent restore observed the same stale (absent) epoch
    // before either committed — it now loses the race and must throw, never
    // silently report success for a pointer it did not write.
    await expect(
      workspaceMeta.reinitializeForRestore(householdId, 'snap-b', '0', observedEpoch),
    ).rejects.toThrow(RestoreEpochLostError);

    // The winner's pointer is untouched by the loser's attempt.
    const finalMeta = await workspaceMeta.find(householdId);
    expect(finalMeta?.latestSnapshotId).toBe('snap-a');
  });

  /** Seed one row and compact it so the household owns a real snapshot with
   *  one aggregate — a restore of it then reseeds one AggregateVersion row,
   *  which is the row a losing restore's sweep would otherwise destroy. */
  async function seedCompactedHousehold(
    s: Session,
  ): Promise<{ snapshotId: string; aggregateId: string }> {
    const aggregateId = randomUUID();
    await seedMutationLogRow(t, s, {
      aggregateId,
      version: 1,
      payload: { name: 'Base', currency: 'USD' },
      sequenceId: backdatedSeq(0),
    });
    expect(await t.module.get(CompactorService).compactHousehold(s.householdId)).not.toBeNull();
    const snapshotId = (await fetchMeta(t, s.householdId))?.latestSnapshotId as string;
    expect(snapshotId).toBeTruthy();
    return { snapshotId, aggregateId };
  }

  it('an older restore that resumes after a newer restore completed loses at its sweep fence — the newer pointer, epoch and reseeded AggregateVersion row all survive', async () => {
    const s = await loginAsFreshUser(t);
    const restoreService = t.module.get(RestoreService);
    const workspaceMeta = t.module.get(WorkspaceMetaRepository);
    const aggregateVersions = t.module.get(AggregateVersionRepository);
    const { snapshotId, aggregateId } = await seedCompactedHousehold(s);

    // Restore B reads the epoch and pauses; restore A then runs to
    // completion; B resumes with its stale observation. The pause point is
    // B's own strongly-consistent epoch read: on that call, run A in full and
    // hand B the value it saw BEFORE A committed. (A's own epoch read passes
    // straight through — the flag is already set by then.)
    const realFind = workspaceMeta.findConsistent.bind(workspaceMeta);
    let newer: Record<string, unknown> | undefined;
    let injected = false;
    const findSpy = jest
      .spyOn(workspaceMeta, 'findConsistent')
      .mockImplementation(async (householdId: string) => {
        const stale = await realFind(householdId);
        if (!injected && householdId === s.householdId) {
          injected = true;
          await restoreService.restore(s.householdId, snapshotId);
          newer = await fetchMeta(t, s.householdId);
        }
        return stale;
      });
    let err: unknown;
    try {
      await restoreService.restore(s.householdId, snapshotId);
    } catch (e) {
      err = e;
    } finally {
      findSpy.mockRestore();
    }
    expect(newer?.restoreEpoch).toBe(1);
    // B lost — surfaced as an error, never `{ ok: true }` for a pointer it
    // did not write. Without the fence B's sweep erases A's row (epoch
    // included), its pointer flip then passes as a fresh write, and A's
    // completed restore is silently undone.
    expect(err).toBeInstanceOf(RestoreEpochLostError);

    const finalMeta = await fetchMeta(t, s.householdId);
    expect(finalMeta?.latestSnapshotId).toBe(newer?.latestSnapshotId);
    expect(finalMeta?.restoreEpoch).toBe(1);
    // The fence is the sweep's FIRST step, so B touched nothing: A's
    // reseeded version row is still there.
    const versions = await aggregateVersions.listForHousehold(s.householdId);
    expect(versions.map((v) => v.aggregateId)).toEqual([aggregateId]);
  });

  it('an older restore whose sweep already ran cannot overwrite a newer restore that completed in the gap — the pointer flip loses to ANY epoch-bearing row, not only a numerically higher one', async () => {
    const s = await loginAsFreshUser(t);
    const restoreService = t.module.get(RestoreService);
    const snapshots = t.module.get(SnapshotsService);
    const { snapshotId } = await seedCompactedHousehold(s);

    // A prior restore, so the OLDER caller below observes epoch 1 and would
    // mint 2 — numerically above the 1 a gap restore re-mints from an absent
    // row. A "strictly below mine" pointer-flip condition lets 2 overwrite 1.
    await restoreService.restore(s.householdId, snapshotId);
    expect((await fetchMeta(t, s.householdId))?.restoreEpoch).toBe(1);

    // Older restore B: observes 1, fences + sweeps (row gone). On B's own
    // fresh-snapshot write — its first step after the sweep — a newer
    // restore C runs to completion: it observes the row as absent, mints
    // epoch 1 again, and commits. B then resumes and must lose.
    const realWrite = snapshots.write.bind(snapshots);
    let newer: Record<string, unknown> | undefined;
    let injected = false;
    const writeSpy = jest
      .spyOn(snapshots, 'write')
      .mockImplementation(async (householdId, content) => {
        const id = await realWrite(householdId, content);
        if (!injected && householdId === s.householdId) {
          injected = true;
          await restoreService.restore(s.householdId, snapshotId);
          newer = await fetchMeta(t, s.householdId);
        }
        return id;
      });
    let err: unknown;
    try {
      await restoreService.restore(s.householdId, snapshotId);
    } catch (e) {
      err = e;
    } finally {
      writeSpy.mockRestore();
    }
    expect(newer?.restoreEpoch).toBe(1);
    expect(err).toBeInstanceOf(RestoreEpochLostError);

    const finalMeta = await fetchMeta(t, s.householdId);
    expect(finalMeta?.latestSnapshotId).toBe(newer?.latestSnapshotId);
    expect(finalMeta?.restoreEpoch).toBe(1);
  });

  it('restore() reads the restore epoch with a strongly consistent GetItem, not an eventually consistent one (stale-epoch race)', async () => {
    const s = await loginAsFreshUser(t);
    const restoreService = t.module.get(RestoreService);
    const snapshots = t.module.get(SnapshotsService);
    const snapshotId = await snapshots.write(s.householdId, {
      aggregates: [],
      cutoff: null,
    });

    const seen: Array<{ consistentRead: unknown }> = [];
    const realSend = t.doc.send.bind(t.doc);
    const sendSpy = jest
      .spyOn(t.doc, 'send')
      .mockImplementation(async (command: unknown, ...rest: unknown[]) => {
        if (
          command instanceof GetCommand &&
          command.input.TableName === tableName(t, 'TABLE_WORKSPACE_META')
        ) {
          seen.push({ consistentRead: command.input.ConsistentRead });
        }
        return (realSend as (...a: unknown[]) => unknown)(command, ...rest);
      });

    try {
      await restoreService.restore(s.householdId, snapshotId);
    } finally {
      sendSpy.mockRestore();
    }

    // At least one WorkspaceMeta GetItem happened (the epoch read), and every
    // one of them was strongly consistent — the eventually-consistent default
    // would silently reproduce the stale-epoch race this test guards against.
    expect(seen.length).toBeGreaterThan(0);
    for (const read of seen) {
      expect(read.consistentRead).toBe(true);
    }
  });
});
