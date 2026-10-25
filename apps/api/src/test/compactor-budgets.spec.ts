// Compactor safety budgets and restore-epoch race guards (starvation and silent-undo). A separate file because `compactor.budgets = {...}` would
// leak through the shared CompactorService singleton; every override is restored in a `finally`.
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
import { CompactorService } from '../compactor/compactor.service.js';
import { RestoreService } from '../sync/restore.service.js';
import { SnapshotsService } from '../sync/snapshots.service.js';
import { AggregateVersionRepository } from '../dynamo/aggregate-version.repository.js';
import { WorkspaceMetaRepository } from '../dynamo/workspace-meta.repository.js';
import { S3_CLIENT } from '../aws/aws.module.js';

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
  let defaultBudgets: CompactorService['budgets'];

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
    // A 10-byte decompression cap makes the re-read of heavy's baseline throw (`CompactorBudgetSkipError` 'baseline_oversized'). A prefix-shaped
    // budget trip returns a metric normally and could never stop the loop, so the assertions would pass with the continuation logic removed.
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
    await seedMutationLogRow(t, light, {
      aggregateId: randomUUID(),
      version: 1,
      payload: { name: 'light', currency: 'USD' },
      sequenceId: backdatedSeq(10),
    });

    // Pins the visiting order heavy then light (enumeration and fairness rotation offset 0), so the run must survive heavy's throw before reaching
    // light; a real rotation visits light first half the time and would pass without exercising the continuation.
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

    // A true skip recorded through the budget-specific catch branch, not the generic failure path.
    expect(summary.budgetLimitedHouseholdIds).toEqual([heavy.householdId]);
    expect(summary.householdsSkipped).toBe(1);
    expect(summary.householdsProcessed).toBe(1);
    const heavyMetaAfter = await fetchMeta(t, heavy.householdId);
    expect(heavyMetaAfter?.latestSnapshotId).toBe(heavyMetaBefore?.latestSnapshotId);

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

    const meta = await fetchMeta(t, s.householdId);
    expect(meta?.latestSnapshotCursor).toBe(seqs[1]);

    expect(await householdLogRowCount(t, s.householdId)).toBe(1);

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

    // The new mutation forces the next pass to re-read the baseline, the decompressed read being bounded.
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
    expect(err).toMatchObject({ householdId: s.householdId, budgetCause: 'baseline_oversized' });

    const metaAfter = await fetchMeta(t, s.householdId);
    expect(metaAfter?.latestSnapshotId).toBe(metaBefore?.latestSnapshotId);
    expect(metaAfter?.latestSnapshotCursor).toBe(metaBefore?.latestSnapshotCursor);
    expect(await householdLogRowCount(t, s.householdId)).toBe(rowCountBefore);

    const emf = budgetLimitedEmf(capture.lines);
    expect(emf).toBeTruthy();

    // runOnce catches the budget skip specifically, so the run continues.
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

    // The second pass reads `latestSnapshotCursor` as the same value the restore will restore to: a test where the cursor changes proves nothing,
    // since the cursor-only guard already catches that.
    await seedMutationLogRow(t, s, {
      aggregateId: randomUUID(),
      version: 1,
      payload: { name: 'InFlight', currency: 'USD' },
      sequenceId: backdatedSeq(5),
    });

    // Intercepts the compactor's own snapshot PutObjectCommand, the last awaited step before its conditional cursor advance, and on that one call
    // runs a full restore back to the first snapshot.
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
    expect(metric).toBeNull();

    const metaAfter = await fetchMeta(t, s.householdId);
    expect(metaAfter?.latestSnapshotId).not.toBe(firstSnapshotId);
    expect(metaAfter?.restoreEpoch).toBe(1);

    // `metric === null` already shows the coverage-guarded delete phase never ran (the abort precedes `deleteUpToCutoff`). A row-count check would
    // not discriminate: the restore's own sweep deletes every row regardless of the guard.
    expect(await householdLogRowCount(t, s.householdId)).toBe(0);
  });

  it('epoch monotonicity across the sweep gap: a recreated epoch-less row does not defeat the restore, and a concurrent stale restore loses the race and throws instead of a false success', async () => {
    const s = await loginAsFreshUser(t);
    const workspaceMeta = t.module.get(WorkspaceMetaRepository);
    const householdId = s.householdId;

    const observedEpoch = undefined;

    // Between the sweep's delete and the restore's own write, a concurrent bootstrap's createIfMissing legitimately recreates an epoch-less row.
    await workspaceMeta.createIfMissing(householdId);
    const recreated = await workspaceMeta.find(householdId);
    expect(recreated?.restoreEpoch).toBeUndefined();

    // The first restore's write still wins against that row: an absent epoch is a distinct pinned state, not a live epoch to beat.
    await workspaceMeta.reinitializeForRestore(householdId, 'snap-a', '0', observedEpoch);
    const afterFirst = await workspaceMeta.find(householdId);
    expect(afterFirst?.restoreEpoch).toBe(1);
    expect(afterFirst?.latestSnapshotId).toBe('snap-a');

    // The second restore observed the same stale (absent) epoch, so it must throw, never report success for a pointer it did not write.
    await expect(
      workspaceMeta.reinitializeForRestore(householdId, 'snap-b', '0', observedEpoch),
    ).rejects.toThrow(/lost the epoch race/);

    const finalMeta = await workspaceMeta.find(householdId);
    expect(finalMeta?.latestSnapshotId).toBe('snap-a');
  });

  // Restoring the seeded compacted household reseeds one AggregateVersion row, the row a losing restore's sweep would otherwise destroy.
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

    // Pauses restore B at its strongly consistent epoch read, runs restore A in full, and hands B the value it saw before A committed (A's own read passes through).
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
    // B's loss must surface as an error: without the fence B's sweep erases A's row (epoch included), B's pointer flip passes as a fresh write and
    // A's restore is silently undone.
    expect((err as Error).message).toMatch(/lost the epoch race/);

    const finalMeta = await fetchMeta(t, s.householdId);
    expect(finalMeta?.latestSnapshotId).toBe(newer?.latestSnapshotId);
    expect(finalMeta?.restoreEpoch).toBe(1);
    // The fence is the sweep's first step, so B touched nothing.
    const versions = await aggregateVersions.listForHousehold(s.householdId);
    expect(versions.map((v) => v.aggregateId)).toEqual([aggregateId]);
  });

  it('an older restore whose sweep already ran cannot overwrite a newer restore that completed in the gap — the pointer flip loses to ANY epoch-bearing row, not only a numerically higher one', async () => {
    const s = await loginAsFreshUser(t);
    const restoreService = t.module.get(RestoreService);
    const snapshots = t.module.get(SnapshotsService);
    const { snapshotId } = await seedCompactedHousehold(s);

    // After a prior restore the older caller observes epoch 1 and mints 2, above the 1 a gap restore re-mints from an absent row; a "strictly below
    // mine" pointer-flip condition would let 2 overwrite 1.
    await restoreService.restore(s.householdId, snapshotId);
    expect((await fetchMeta(t, s.householdId))?.restoreEpoch).toBe(1);

    // Restore B fences and sweeps, then on its fresh-snapshot write a newer restore C observes the row absent, mints epoch 1 again and commits; B must lose.
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
    expect((err as Error).message).toMatch(/lost the epoch race/);

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

    // Every WorkspaceMeta GetItem for the epoch must be strongly consistent; the eventually consistent default would reproduce the stale-epoch race.
    expect(seen.length).toBeGreaterThan(0);
    for (const read of seen) {
      expect(read.consistentRead).toBe(true);
    }
  });
});
