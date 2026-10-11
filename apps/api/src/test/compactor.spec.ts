/**
 * Compactor smoke tests against the local emulator. Verifies the
 * round-trip: push mutations → run compactor → bootstrap returns the
 * snapshotId and the workspace aggregate count matches.
 */
import request from 'supertest';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import KSUID from 'ksuid';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import {
  bootstrapTestApp,
  signupVerifyLogin as loginAsFreshUser,
  type Session,
  type TestApp,
} from './test-helpers.js';
import type { Logger } from '@nestjs/common';
import { CompactorService } from '../compactor/compactor.service.js';
import { S3_CLIENT } from '../aws/aws.module.js';

/**
 * Mint a sequenceId backdated past the compactor's 60 s safety margin
 *: rows at/above the boundary KSUID are excluded from every run, so
 * seeds that expect compaction must sit outside it. The slot (whole seconds)
 * keeps intra-test ordering deterministic — KSUID timestamps carry 1 s
 * precision, so same-second random payloads would order randomly.
 */
function backdatedSeq(slot: number): string {
  return KSUID.fromParts(Date.now() - 10 * 60_000 + slot * 1000, Buffer.alloc(16)).string;
}

/**
 * Ensure a minimal `WorkspaceMeta` row exists for the household so the
 * compactor's household scan picks it up. A plaintext push 403s, so it
 * no longer creates the meta row as a side effect — tests seed it directly.
 */
async function seedWorkspaceMeta(t: TestApp, s: Session): Promise<void> {
  const config = t.module.get(ConfigService);
  const table = config.get('TABLE_WORKSPACE_META', { infer: true } as never) as unknown as string;
  try {
    await t.doc.send(
      new PutCommand({
        TableName: table,
        Item: {
          householdId: s.householdId,
          latestSnapshotId: null,
          latestSnapshotCursor: null,
          latestVersion: 0,
          lastUpdatedAt: new Date().toISOString(),
          mutationLogCursorBase: null,
        },
        // Create-if-missing only: a prior compaction may have advanced
        // latestSnapshotId / latestSnapshotCursor on this row, and an
        // unconditional Put would wipe them back to null.
        ConditionExpression: 'attribute_not_exists(householdId)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
}

/**
 * Seed a `MutationLog` row directly (bypassing the push DTO + the
 * ENCRYPTION_REQUIRED guard) so the compactor can be exercised with an
 * encrypted-envelope or legacy-plaintext payload without standing up a full
 * keyed-household push flow. Also ensures the household's `WorkspaceMeta` row
 * exists so the compactor's scan finds the household (a plaintext push
 * 403s and no longer creates it). Returns the seeded `{ sequenceId,
 * aggregateId }` so callers can reference the row in cursor/pull assertions.
 */
async function seedMutationLogRow(
  t: TestApp,
  s: Session,
  row: {
    aggregateId: string;
    aggregateType: string;
    operation: 'create' | 'update';
    version: number;
    payload: Record<string, unknown>;
    /** Explicit SK so call order is deterministic (KSUID same-second random
     *  components can invert intra-test ordering). Must sort after '0'. */
    sequenceId?: string;
  },
): Promise<{ sequenceId: string; aggregateId: string }> {
  await seedWorkspaceMeta(t, s);
  const config = t.module.get(ConfigService);
  const table = config.get('TABLE_MUTATION_LOG', { infer: true } as never) as unknown as string;
  const sequenceId = row.sequenceId ?? (await KSUID.random()).string;
  await t.doc.send(
    new PutCommand({
      TableName: table,
      Item: {
        householdId: s.householdId,
        sequenceId,
        deviceId: s.deviceId,
        aggregateId: row.aggregateId,
        aggregateType: row.aggregateType,
        operation: row.operation,
        payload: JSON.stringify(row.payload),
        version: row.version,
        timestamp: Date.now(),
        schemaVersion: 1,
      },
    }),
  );
  return { sequenceId, aggregateId: row.aggregateId };
}

/** A well-formed encrypted aggregate payload envelope. */
function encryptedEnvelope(): Record<string, unknown> {
  return {
    encryptionVersion: 1,
    keyId: 'hh-key-1',
    alg: 'AES-256-GCM',
    nonce: 'bm9uY2VfYnl0ZXM',
    ciphertext: 'Y2lwaGVydGV4dF9ieXRlcw',
  };
}

describe('compactor (4.1 / 4.4)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('runOnce processes households and writes a snapshot to S3', async () => {
    const s = await loginAsFreshUser(t);
    const aggregateId = randomUUID();
    // Seed a legacy-plaintext create+update directly (a plaintext push
    // 403s); the helper also seeds the WorkspaceMeta row the compactor scans.
    await seedMutationLogRow(t, s, {
      aggregateId,
      aggregateType: 'household',
      operation: 'create',
      version: 1,
      payload: { name: 'Test', currency: 'USD', createdAt: new Date().toISOString() },
      sequenceId: backdatedSeq(0),
    });
    await seedMutationLogRow(t, s, {
      aggregateId,
      aggregateType: 'household',
      operation: 'update',
      version: 2,
      payload: { name: 'Test2' },
      sequenceId: backdatedSeq(1),
    });

    const compactor = t.module.get(CompactorService);
    const summary = await compactor.runOnce();
    expect(summary.householdsProcessed + summary.householdsSkipped).toBeGreaterThan(0);
    // 4.3 metrics: a real run produces a positive snapshot + non-negative duration.
    expect(summary.householdsProcessed).toBeGreaterThan(0);
    expect(summary.totalSnapshotBytes).toBeGreaterThan(0);
    expect(summary.totalMutationsCompacted).toBeGreaterThan(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);

    const boot = await request(t.app.getHttpServer())
      .get('/api/v1/sync/bootstrap')
      .set('Authorization', `Bearer ${s.accessToken}`);
    expect(boot.status).toBe(200);
    // After compaction the household has a snapshot id and the aggregate
    // shows up in workspaceSnapshot.
    expect(boot.body.snapshotId).toBeTruthy();
    const aggIds = (
      boot.body.workspaceSnapshot.aggregates as Array<{ id: string }>
    ).map((a) => a.id);
    expect(aggIds).toContain(aggregateId);
  });

  it('runOnce on an empty workspace does not throw', async () => {
    // Spin up a fresh user so they have a brand-new (empty) household.
    const s = await loginAsFreshUser(t);
    expect(s.householdId).toBeTruthy();
    const compactor = t.module.get(CompactorService);
    await expect(compactor.runOnce()).resolves.toBeTruthy();
  });

  it('does NOT compact a mutation timestamped inside the safety margin', async () => {
    // KSUIDs are minted before the push transaction commits, so a
    // racing in-flight push can commit with a sequenceId below the cutoff.
    // A row whose KSUID timestamp is INSIDE the margin window (now) may
    // still have an uncommitted lower-KSUID sibling in flight, so it must
    // be excluded from compaction this run.
    const s = await loginAsFreshUser(t);
    const aggregateId = randomUUID();
    // KSUID timestamped at "now" → inside the 60 s safety margin.
    const insideMargin = KSUID.fromParts(Date.now(), Buffer.alloc(16)).string;
    await seedMutationLogRow(t, s, {
      aggregateId,
      aggregateType: 'household',
      operation: 'create',
      version: 1,
      payload: { name: 'In flight', currency: 'USD' },
      sequenceId: insideMargin,
    });

    const compactor = t.module.get(CompactorService);
    const metric = await compactor.compactHousehold(s.householdId);
    // Only an inside-margin row exists → nothing is safely compactable yet.
    expect(metric).toBeNull();

    // The row survives in the mutation log (not deleted) and is visible to
    // bootstrap (replayed from the still-current cursor base).
    const boot = await request(t.app.getHttpServer())
      .get('/api/v1/sync/bootstrap')
      .set('Authorization', `Bearer ${s.accessToken}`);
    expect(boot.status).toBe(200);
    const aggIds = (
      boot.body.workspaceSnapshot.aggregates as Array<{ id: string }>
    ).map((a) => a.id);
    const postIds = (
      boot.body.postSnapshotMutations as Array<{ aggregateId: string }>
    ).map((m) => m.aggregateId);
    expect([...aggIds, ...postIds]).toContain(aggregateId);
  });

  it('DOES compact a mutation timestamped outside the safety margin', async () => {
    // A row whose KSUID timestamp is well OUTSIDE the margin window cannot
    // have an uncommitted lower-KSUID sibling still in flight, so it is
    // safe to compact into the snapshot and delete from the log.
    const s = await loginAsFreshUser(t);
    const aggregateId = randomUUID();
    // KSUID timestamped 10 min ago → comfortably outside the 60 s margin.
    const outsideMargin = KSUID.fromParts(
      Date.now() - 10 * 60_000,
      Buffer.alloc(16),
    ).string;
    await seedMutationLogRow(t, s, {
      aggregateId,
      aggregateType: 'household',
      operation: 'create',
      version: 1,
      payload: { name: 'Settled', currency: 'USD' },
      sequenceId: outsideMargin,
    });

    const compactor = t.module.get(CompactorService);
    const metric = await compactor.compactHousehold(s.householdId);
    expect(metric).not.toBeNull();
    expect(metric!.mutationsCompacted).toBe(1);

    const boot = await request(t.app.getHttpServer())
      .get('/api/v1/sync/bootstrap')
      .set('Authorization', `Bearer ${s.accessToken}`);
    expect(boot.status).toBe(200);
    expect(boot.body.snapshotId).toBeTruthy();
    const aggIds = (
      boot.body.workspaceSnapshot.aggregates as Array<{ id: string }>
    ).map((a) => a.id);
    expect(aggIds).toContain(aggregateId);
  });

  it('REPLACES the snapshot payload for an encrypted mutation (no spread-merge)', async () => {
    const s = await loginAsFreshUser(t);
    // Seed the WorkspaceMeta row directly so the compactor (which scans
    // WorkspaceMeta for households) processes this household (a
    // plaintext push 403s and no longer creates it as a side effect).
    await seedWorkspaceMeta(t, s);
    const aggregateId = randomUUID();
    // First a create carrying an envelope with a distinctive ciphertext, then an
    // update carrying a DIFFERENT envelope. If the compactor spread-merged, the
    // snapshot would blend both envelopes' fields; replacement must yield only
    // the latest envelope verbatim.
    await seedMutationLogRow(t, s, {
      aggregateId,
      aggregateType: 'account',
      operation: 'create',
      version: 1,
      payload: { ...encryptedEnvelope(), ciphertext: 'b2xkX2NpcGhlcg', keyId: 'old-key' },
      sequenceId: backdatedSeq(0),
    });
    const latest = { ...encryptedEnvelope(), ciphertext: 'bmV3X2NpcGhlcg', keyId: 'new-key' };
    await seedMutationLogRow(t, s, {
      aggregateId,
      aggregateType: 'account',
      operation: 'update',
      version: 2,
      payload: latest,
      sequenceId: backdatedSeq(1),
    });

    const compactor = t.module.get(CompactorService);
    await compactor.runOnce();

    const boot = await request(t.app.getHttpServer())
      .get('/api/v1/sync/bootstrap')
      .set('Authorization', `Bearer ${s.accessToken}`);
    expect(boot.status).toBe(200);
    const agg = (
      boot.body.workspaceSnapshot.aggregates as Array<{ id: string; payload: Record<string, unknown> }>
    ).find((a) => a.id === aggregateId);
    expect(agg).toBeTruthy();
    // The snapshot payload is exactly the latest envelope — no residual fields
    // from the earlier envelope (replacement, not merge).
    expect(agg!.payload).toEqual(latest);
  });

  it('still spread-merges legacy plaintext mutations (create then partial update)', async () => {
    const s = await loginAsFreshUser(t);
    const aggregateId = randomUUID();
    // seedMutationLogRow also seeds the WorkspaceMeta row the compactor scans.
    await seedMutationLogRow(t, s, {
      aggregateId,
      aggregateType: 'household',
      operation: 'create',
      version: 1,
      payload: { name: 'Original', currency: 'USD' },
      sequenceId: backdatedSeq(0),
    });
    // A partial update touching only `name` must preserve `currency` (merge).
    await seedMutationLogRow(t, s, {
      aggregateId,
      aggregateType: 'household',
      operation: 'update',
      version: 2,
      payload: { name: 'Renamed' },
      sequenceId: backdatedSeq(1),
    });

    const compactor = t.module.get(CompactorService);
    await compactor.runOnce();

    const boot = await request(t.app.getHttpServer())
      .get('/api/v1/sync/bootstrap')
      .set('Authorization', `Bearer ${s.accessToken}`);
    expect(boot.status).toBe(200);
    const agg = (
      boot.body.workspaceSnapshot.aggregates as Array<{ id: string; payload: Record<string, unknown> }>
    ).find((a) => a.id === aggregateId);
    expect(agg).toBeTruthy();
    expect(agg!.payload).toEqual({ name: 'Renamed', currency: 'USD' });
  });

  it('fails closed on a non-NoSuchKey snapshot read error: skips the household, logs, emits EMF metric', async () => {
    const s = await loginAsFreshUser(t);
    // First compaction writes a real snapshot so the household's WorkspaceMeta
    // carries a `latestSnapshotId` that the NEXT run will try to re-read.
    await seedMutationLogRow(t, s, {
      aggregateId: randomUUID(),
      aggregateType: 'household',
      operation: 'create',
      version: 1,
      payload: { name: 'Base', currency: 'USD' },
      sequenceId: backdatedSeq(0),
    });
    const compactor = t.module.get(CompactorService);
    await compactor.runOnce();

    // A new mutation forces the next run to re-load the existing snapshot
    // baseline before merging — that read is the one we make fail.
    await seedMutationLogRow(t, s, {
      aggregateId: randomUUID(),
      aggregateType: 'household',
      operation: 'create',
      version: 1,
      payload: { name: 'InFlight', currency: 'USD' },
      sequenceId: backdatedSeq(1),
    });

    // Force the snapshot GetObject to fail with a non-NoSuchKey (infra-shaped)
    // error so the read is unreadable, NOT empty. Other S3 ops pass through.
    const s3 = t.module.get<S3Client>(S3_CLIENT);
    const realSend = s3.send.bind(s3);
    const s3Spy = jest
      .spyOn(s3, 'send')
      .mockImplementation((command: Parameters<S3Client['send']>[0], ...rest: unknown[]) => {
        if (command instanceof GetObjectCommand) {
          const err = new Error('simulated S3 500');
          err.name = 'InternalError';
          return Promise.reject(err);
        }
        return (realSend as (...a: unknown[]) => unknown)(command, ...rest) as ReturnType<
          S3Client['send']
        >;
      });
    // The app silences the global logger in tests (`app.useLogger(false)`), so
    // capture the structured error record by swapping the CompactorService's
    // own `Logger` instance for a recording stub (restored in `finally`).
    const loggerRef = compactor as unknown as { logger: Logger };
    const realLogger = loggerRef.logger;
    const errorCalls: unknown[][] = [];
    loggerRef.logger = {
      ...realLogger,
      error: (...args: unknown[]) => {
        errorCalls.push(args);
      },
      log: () => undefined,
      warn: () => undefined,
    } as unknown as Logger;
    // The EMF emitter uses a synchronous fd-1 write (`fs.writeSync`,
    // Lambda-freeze-safe — see compactor.service.ts), NOT `process.stdout.write`,
    // so capture at the `fs.writeSync` layer for fd 1 and pass every other fd
    // through to the real implementation.
    const stdoutLines: string[] = [];
    const realWriteSync = fs.writeSync.bind(fs);
    const stdoutSpy = jest.spyOn(fs, 'writeSync').mockImplementation(((
      fd: number,
      data: unknown,
      ...rest: unknown[]
    ): number => {
      if (fd === 1) {
        const raw = String(data);
        stdoutLines.push(raw);
        return Buffer.byteLength(raw);
      }
      return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
    }) as unknown as typeof fs.writeSync);

    let summary: Awaited<ReturnType<CompactorService['runOnce']>>;
    try {
      summary = await compactor.runOnce();
    } finally {
      s3Spy.mockRestore();
      loggerRef.logger = realLogger;
      stdoutSpy.mockRestore();
    }

    // (a) The failing household is skipped — its in-flight mutation is NOT
    // compacted away against an empty baseline.
    expect(summary.householdsSkipped).toBeGreaterThan(0);

    // (b) A structured error log carries householdId / snapshotId / error fields.
    const structuredCall = errorCalls.find(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as Record<string, unknown>)['metric.kind'] === 'compactor_snapshot_read_error',
    );
    expect(structuredCall).toBeTruthy();
    const ctx = structuredCall![0] as Record<string, unknown>;
    expect(ctx.householdId).toBe(s.householdId);
    expect(typeof ctx.snapshotId).toBe('string');
    expect(ctx.errorName).toBe('InternalError');
    expect(ctx.errorMessage).toBe('simulated S3 500');

    // (c) An EMF line on stdout carries _aws.CloudWatchMetrics with the
    // CompactorSnapshotReadError metric in the per-stack
    // Retivo/local/Compactor namespace (STACK is unset in the test
    // env so it resolves to `local`), and NO householdId dimension
    // (high-cardinality stays in the log).
    const emfLine = stdoutLines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find(
        (parsed): parsed is Record<string, unknown> =>
          parsed !== null && typeof parsed === 'object' && '_aws' in parsed,
      );
    expect(emfLine).toBeTruthy();
    const aws = emfLine!._aws as {
      CloudWatchMetrics: Array<{
        Namespace: string;
        Dimensions: string[][];
        Metrics: Array<{ Name: string; Unit?: string }>;
      }>;
    };
    expect(aws.CloudWatchMetrics).toHaveLength(1);
    const entry = aws.CloudWatchMetrics[0];
    expect(entry.Namespace).toBe('Retivo/local/Compactor');
    expect(entry.Metrics).toEqual(
      expect.arrayContaining([expect.objectContaining({ Name: 'CompactorSnapshotReadError' })]),
    );
    // No custom dimensions: the only dimension set is empty, so householdId is
    // not a metric dimension.
    expect(entry.Dimensions).toEqual([[]]);
    expect(JSON.stringify(emfLine)).not.toContain(s.householdId);
  });

  it('verify-then-delete sweeps a COVERED stray from a prior crashed run (self-healing delete)', async () => {
    // A crash between the WorkspaceMeta cursor bump and the
    // delete can strand a row `<= cutoff` that WAS folded into the snapshot —
    // the NEXT run's `since`-cursor query (sequenceId > cutoff) never sees it.
    // The verify-then-delete sweep queries EVERY row `<= cutoff` and still
    // reclaims this one because the snapshot COVERS its (aggregateId, version).
    // Only uncovered strays are kept (next test).
    const s = await loginAsFreshUser(t);
    const config = t.module.get(ConfigService);
    const mutationLogTable = config.get(
      'TABLE_MUTATION_LOG',
      { infer: true } as never,
    ) as unknown as string;
    const compactor = t.module.get(CompactorService);

    // 1. First compaction folds aggregate A (version 1) into the snapshot and
    //    advances the cursor to firstSeq.
    const firstSeq = KSUID.fromParts(Date.now() - 30 * 60_000, Buffer.alloc(16)).string;
    const first = await seedMutationLogRow(t, s, {
      aggregateId: randomUUID(),
      aggregateType: 'household',
      operation: 'create',
      version: 1,
      payload: { name: 'First', currency: 'USD' },
      sequenceId: firstSeq,
    });
    const firstMetric = await compactor.compactHousehold(s.householdId);
    expect(firstMetric).not.toBeNull();

    // 2. Plant a stray for the SAME aggregate A at version 1, BELOW the cursor
    //    — a row a prior crashed run failed to delete. The snapshot holds A@1,
    //    so it is COVERED and safe to reclaim.
    const straySeq = KSUID.fromParts(Date.now() - 40 * 60_000, Buffer.alloc(16)).string;
    await t.doc.send(
      new PutCommand({
        TableName: mutationLogTable,
        Item: {
          householdId: s.householdId,
          sequenceId: straySeq,
          deviceId: s.deviceId,
          aggregateId: first.aggregateId,
          aggregateType: 'household',
          operation: 'create',
          payload: JSON.stringify({ name: 'First', currency: 'USD' }),
          version: 1,
          timestamp: Date.now(),
          schemaVersion: 1,
        },
      }),
    );
    // Confirm the stray exists before the next compaction.
    const strayBefore = await t.doc.send(
      new GetCommand({
        TableName: mutationLogTable,
        Key: { householdId: s.householdId, sequenceId: straySeq },
      }),
    );
    expect(strayBefore.Item).toBeTruthy();

    // 3. A NEW settled mutation (above the cursor) triggers a real second
    //    compaction. Its cutoff sits above the stray, so the covered stray is
    //    swept even though this run never read it into the `recent` list.
    const secondSeq = KSUID.fromParts(Date.now() - 20 * 60_000, Buffer.alloc(16)).string;
    await seedMutationLogRow(t, s, {
      aggregateId: randomUUID(),
      aggregateType: 'household',
      operation: 'create',
      version: 1,
      payload: { name: 'Second', currency: 'USD' },
      sequenceId: secondSeq,
    });
    const secondMetric = await compactor.compactHousehold(s.householdId);
    expect(secondMetric).not.toBeNull();

    // The covered stray row is gone — reclaimed by the verify-then-delete sweep.
    const strayAfter = await t.doc.send(
      new GetCommand({
        TableName: mutationLogTable,
        Key: { householdId: s.householdId, sequenceId: straySeq },
      }),
    );
    expect(strayAfter.Item).toBeUndefined();
  });
});
