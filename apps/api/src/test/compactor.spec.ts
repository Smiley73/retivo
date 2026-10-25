// Compactor round trip against the local emulator (push, compact, bootstrap serves the snapshot) plus the safety margin, merge semantics,
// snapshot read failure and covered-stray reclaim.
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

// Backdated past the compactor's 60 s safety margin (rows at or above the boundary KSUID are excluded from every run). The slot keeps
// intra-test ordering deterministic, since KSUID timestamps have 1 s precision.
function backdatedSeq(slot: number): string {
  return KSUID.fromParts(Date.now() - 10 * 60_000 + slot * 1000, Buffer.alloc(16)).string;
}

// A plaintext push 403s and no longer creates the meta row, so tests seed it directly for the compactor's household scan.
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
        // Create-if-missing: an unconditional Put would wipe latestSnapshotId and latestSnapshotCursor from a prior compaction.
        ConditionExpression: 'attribute_not_exists(householdId)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
}

// Seeds a MutationLog row directly (bypassing the push DTO and the ENCRYPTION_REQUIRED guard) and ensures the WorkspaceMeta row the compactor scans exists.
async function seedMutationLogRow(
  t: TestApp,
  s: Session,
  row: {
    aggregateId: string;
    aggregateType: string;
    operation: 'create' | 'update';
    version: number;
    payload: Record<string, unknown>;
    // Explicit sort key for deterministic order (same-second KSUID components can invert it); must sort after '0'.
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
    expect(summary.householdsProcessed).toBeGreaterThan(0);
    expect(summary.totalSnapshotBytes).toBeGreaterThan(0);
    expect(summary.totalMutationsCompacted).toBeGreaterThan(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);

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

  it('runOnce on an empty workspace does not throw', async () => {
    const s = await loginAsFreshUser(t);
    expect(s.householdId).toBeTruthy();
    const compactor = t.module.get(CompactorService);
    await expect(compactor.runOnce()).resolves.toBeTruthy();
  });

  it('does NOT compact a mutation timestamped inside the safety margin', async () => {
    // KSUIDs are minted before the push transaction commits, so a row inside the margin window may have an uncommitted lower-KSUID sibling in flight and must be excluded.
    const s = await loginAsFreshUser(t);
    const aggregateId = randomUUID();
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
    expect(metric).toBeNull();

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
    // A row well outside the margin cannot have an uncommitted lower sibling in flight, so it is safe to compact and delete.
    const s = await loginAsFreshUser(t);
    const aggregateId = randomUUID();
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
    await seedWorkspaceMeta(t, s);
    const aggregateId = randomUUID();
    // A create, then an update with a different envelope: replacement must yield only the latest envelope verbatim, where a spread-merge would blend both.
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
    expect(agg!.payload).toEqual(latest);
  });

  it('still spread-merges legacy plaintext mutations (create then partial update)', async () => {
    const s = await loginAsFreshUser(t);
    const aggregateId = randomUUID();
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

    // A new mutation forces the next run to re-load the existing baseline, the read made to fail below.
    await seedMutationLogRow(t, s, {
      aggregateId: randomUUID(),
      aggregateType: 'household',
      operation: 'create',
      version: 1,
      payload: { name: 'InFlight', currency: 'USD' },
      sequenceId: backdatedSeq(1),
    });

    // A non-NoSuchKey (infra-shaped) GetObject failure makes the snapshot unreadable, not empty; other S3 ops pass through.
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
    // The app silences the global logger in tests, so a recording stub replaces the CompactorService's Logger (restored in `finally`).
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
    // The EMF emitter writes with `fs.writeSync` (Lambda-freeze-safe), not `process.stdout.write`, so capture fd 1 at that layer and pass other fds through.
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

    expect(summary.householdsSkipped).toBeGreaterThan(0);

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

    // The EMF line carries CompactorSnapshotReadError in the per-stack Retivo/local/Compactor namespace (STACK is unset in tests) and no householdId dimension (high-cardinality stays in the log).
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
    expect(entry.Dimensions).toEqual([[]]);
    expect(JSON.stringify(emfLine)).not.toContain(s.householdId);
  });

  it('verify-then-delete sweeps a COVERED stray from a prior crashed run (self-healing delete)', async () => {
    // A crash between the cursor bump and the delete can strand a row `<= cutoff` that was folded into the snapshot, and the next run's `since`
    // query never sees it. The verify-then-delete sweep queries every row `<= cutoff` and reclaims it because the snapshot covers its
    // (aggregateId, version); only uncovered strays are kept (next test).
    const s = await loginAsFreshUser(t);
    const config = t.module.get(ConfigService);
    const mutationLogTable = config.get(
      'TABLE_MUTATION_LOG',
      { infer: true } as never,
    ) as unknown as string;
    const compactor = t.module.get(CompactorService);

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

    // A stray for the same aggregate at version 1 below the cursor, as a prior crashed run leaves it: the snapshot holds A@1, so it is covered.
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
    const strayBefore = await t.doc.send(
      new GetCommand({
        TableName: mutationLogTable,
        Key: { householdId: s.householdId, sequenceId: straySeq },
      }),
    );
    expect(strayBefore.Item).toBeTruthy();

    // A new settled mutation triggers a second compaction whose cutoff sits above the stray, so the sweep reclaims it though this run never read it.
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

    const strayAfter = await t.doc.send(
      new GetCommand({
        TableName: mutationLogTable,
        Key: { householdId: s.householdId, sequenceId: straySeq },
      }),
    );
    expect(strayAfter.Item).toBeUndefined();
  });
});
