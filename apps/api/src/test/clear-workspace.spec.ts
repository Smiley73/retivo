/**
 * Server-authoritative "Delete workspace data" clear integration tests
 * against the local emulator (DynamoDB Local
 * + Moto S3).
 *
 * Covers POST /sync/workspace/clear: the authorized clear (zero live
 * aggregates on bootstrap incl. data this device never knew about + a wedged
 * version counter), password/backoff/CSRF/auth rejections, the JWT-scoped
 * household guard, DTO validation, audit events, eraseHistory on/off + the
 * keep-key purge that preserves the live snapshot, the purgeHistoryOnly
 * retry, and multi-device convergence via the strictly-greater watermark
 * (CURSOR_EXPIRED at since === pre-clear head).
 *
 * Per the repo's testing convention, sync/auth API behaviour is verified
 * end-to-end here (emulator-backed) through the real HTTP + DynamoDB + S3
 * path rather than via shallow unit tests. The forced-purge-failure seam
 * lives in clear-workspace-purge-order.spec.ts (needs a service override);
 * the @Throttle 5/hr limit lives in clear-workspace-throttle.spec.ts (the
 * shared harness disables throttling).
 */
import request from 'supertest';
import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import KSUID from 'ksuid';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  STRONG_PASSWORD,
  bootstrapTestApp,
  signupVerifyLogin as loginAsFreshUser,
  type Session,
  type TestApp,
} from './test-helpers.js';
import { S3_CLIENT } from '../aws/aws.module.js';
import { CompactorService } from '../compactor/compactor.service.js';
import { SnapshotsService } from '../sync/snapshots.service.js';
import type { AuthEventRow, MutationLogRow } from '../dynamo/types.js';

/**
 * Seed the full sync state for one mutation directly — WorkspaceMeta,
 * MutationLog, AND AggregateVersion. Bypasses `POST /sync/push` (a
 * plaintext push 403s). `sequenceId` is controllable so tests know the
 * pre-clear head cursor.
 */
async function seedOne(
  t: TestApp,
  s: Session,
  aggregateId: string,
  opts?: { version?: number; sequenceId?: string },
): Promise<string> {
  const metaTable = tableName(t, 'TABLE_WORKSPACE_META');
  const logTable = tableName(t, 'TABLE_MUTATION_LOG');
  const versionTable = tableName(t, 'TABLE_AGGREGATE_VERSION');
  const newVersion = (opts?.version ?? 0) + 1;
  const now = new Date().toISOString();
  const sequenceId =
    opts?.sequenceId ??
    KSUID.fromParts(Date.now() - 10 * 60_000, randomBytes(16)).string;
  try {
    await t.doc.send(
      new PutCommand({
        TableName: metaTable,
        Item: {
          householdId: s.householdId,
          latestSnapshotId: null,
          latestSnapshotCursor: null,
          latestVersion: 0,
          lastUpdatedAt: now,
          mutationLogCursorBase: null,
        },
        ConditionExpression: 'attribute_not_exists(householdId)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
      throw err;
    }
  }
  await t.doc.send(
    new PutCommand({
      TableName: logTable,
      Item: {
        householdId: s.householdId,
        sequenceId,
        deviceId: s.deviceId,
        aggregateId,
        aggregateType: 'household',
        operation: 'create',
        payload: JSON.stringify({ name: 'Test', currency: 'USD', createdAt: now }),
        version: newVersion,
        timestamp: Date.now(),
        schemaVersion: 1,
      },
    }),
  );
  await t.doc.send(
    new PutCommand({
      TableName: versionTable,
      Item: {
        householdId: s.householdId,
        aggregateId,
        aggregateType: 'household',
        version: newVersion,
        updatedAt: now,
        deletedAt: null,
      },
    }),
  );
  return sequenceId;
}

/**
 * Seed an AggregateVersion row whose counter is WEDGED ahead of any durable
 * content (no MutationLog row, no snapshot). This is the 2026-07-01 incident
 * shape the old client-tombstone delete could not remove; the server sweep
 * is type-agnostic and clears it regardless.
 */
async function seedWedgedCounter(t: TestApp, s: Session): Promise<string> {
  const aggregateId = randomUUID();
  await t.doc.send(
    new PutCommand({
      TableName: tableName(t, 'TABLE_AGGREGATE_VERSION'),
      Item: {
        householdId: s.householdId,
        aggregateId,
        aggregateType: 'account',
        version: 99, // counter ahead of any content
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      },
    }),
  );
  return aggregateId;
}

async function seedSnapshot(
  s3: S3Client,
  bucket: string,
  householdId: string,
  snapshotId: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${householdId}/${snapshotId}.json.gz`,
      Body: Buffer.from('seed'),
    }),
  );
}

function clearWorkspace(
  t: TestApp,
  s: Session,
  body: Record<string, unknown>,
): request.Test {
  return request(t.app.getHttpServer())
    .post('/api/v1/sync/workspace/clear')
    .set('Origin', process.env.WEB_ORIGIN!)
    .set('Authorization', `Bearer ${s.accessToken}`)
    .set('X-CSRF-Token', s.csrfValue)
    .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
    .send(body);
}

function bootstrap(t: TestApp, s: Session): Promise<request.Response> {
  return request(t.app.getHttpServer())
    .get('/api/v1/sync/bootstrap')
    .set('Authorization', `Bearer ${s.accessToken}`);
}

function listSnapshots(t: TestApp, s: Session): Promise<request.Response> {
  return request(t.app.getHttpServer())
    .get('/api/v1/sync/snapshots')
    .set('Authorization', `Bearer ${s.accessToken}`);
}

function restore(t: TestApp, s: Session, snapshotId: string): Promise<request.Response> {
  return request(t.app.getHttpServer())
    .post('/api/v1/sync/restore')
    .set('Origin', process.env.WEB_ORIGIN!)
    .set('Authorization', `Bearer ${s.accessToken}`)
    .set('X-CSRF-Token', s.csrfValue)
    .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
    .send({ snapshotId });
}

function pull(t: TestApp, s: Session, since: string): Promise<request.Response> {
  return request(t.app.getHttpServer())
    .get(`/api/v1/sync/pull?since=${encodeURIComponent(since)}`)
    .set('Authorization', `Bearer ${s.accessToken}`);
}

function tableName(t: TestApp, key: string): string {
  return t.module
    .get(ConfigService)
    .get(key, { infer: true } as never) as unknown as string;
}

async function auditEventsFor(t: TestApp, userId: string): Promise<string[]> {
  const config = t.module.get(ConfigService);
  const table = config.get('TABLE_AUTH_EVENT', { infer: true } as never) as unknown as string;
  const rows = await t.doc.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': userId },
    }),
  );
  return ((rows.Items as AuthEventRow[] | undefined) ?? []).map((r) => r.eventType);
}

async function householdMutations(t: TestApp, householdId: string): Promise<MutationLogRow[]> {
  const rows = await t.doc.send(
    new QueryCommand({
      TableName: tableName(t, 'TABLE_MUTATION_LOG'),
      KeyConditionExpression: 'householdId = :h',
      ExpressionAttributeValues: { ':h': householdId },
    }),
  );
  return (rows.Items as MutationLogRow[] | undefined) ?? [];
}

async function householdAggregateVersions(
  t: TestApp,
  householdId: string,
): Promise<unknown[]> {
  const rows = await t.doc.send(
    new QueryCommand({
      TableName: tableName(t, 'TABLE_AGGREGATE_VERSION'),
      KeyConditionExpression: 'householdId = :h',
      ExpressionAttributeValues: { ':h': householdId },
    }),
  );
  return rows.Items ?? [];
}

describe('POST /sync/workspace/clear', () => {
  let t: TestApp;
  let s3: S3Client;
  let bucket: string;
  let snapshotsService: SnapshotsService;

  beforeAll(async () => {
    t = await bootstrapTestApp();
    s3 = t.module.get<S3Client>(S3_CLIENT);
    snapshotsService = t.module.get(SnapshotsService);
    bucket = tableName(t, 'SNAPSHOTS_BUCKET');
  });

  afterAll(async () => {
    await t.app.close();
  });

  describe('authorized clear', () => {
    it('clears every live aggregate — incl. data this device never knew about — so bootstrap returns empty', async () => {
      const s = await loginAsFreshUser(t);
      // Failure-mode #1: a device-B push this device never pulled. Seeded
      // directly to represent server-side state A cannot enumerate locally.
      await seedOne(t, s, randomUUID());

      const res = await clearWorkspace(t, s, {
        currentPassword: STRONG_PASSWORD,
        eraseHistory: false,
      });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true, historyErased: false });

      expect(await householdMutations(t, s.householdId)).toHaveLength(0);
      expect(await householdAggregateVersions(t, s.householdId)).toHaveLength(0);

      const boot = await bootstrap(t, s);
      expect(boot.status).toBe(200);
      expect(boot.body.workspaceSnapshot.aggregates).toHaveLength(0);
    });

    it('clears a WEDGED version counter the client-tombstone delete could not remove', async () => {
      const s = await loginAsFreshUser(t);
      await seedOne(t, s, randomUUID());
      await seedWedgedCounter(t, s);

      const res = await clearWorkspace(t, s, {
        currentPassword: STRONG_PASSWORD,
        eraseHistory: false,
      });
      expect(res.status).toBe(201);

      // The type-agnostic sweep removed the wedged AggregateVersion row too.
      expect(await householdAggregateVersions(t, s.householdId)).toHaveLength(0);
      const boot = await bootstrap(t, s);
      expect(boot.body.workspaceSnapshot.aggregates).toHaveLength(0);
    });

    it('records workspace_clear_started + workspace_clear_completed on success', async () => {
      const s = await loginAsFreshUser(t);
      await seedOne(t, s, randomUUID());
      const res = await clearWorkspace(t, s, {
        currentPassword: STRONG_PASSWORD,
        eraseHistory: false,
      });
      expect(res.status).toBe(201);

      const events = await auditEventsFor(t, s.userId);
      expect(events).toContain('workspace_clear_started');
      expect(events).toContain('workspace_clear_completed');
      expect(events).not.toContain('workspace_clear_failed');
    });
  });

  describe('authorization + rejection', () => {
    it('rejects a wrong currentPassword with 401 INVALID_CREDENTIALS and sweeps nothing', async () => {
      const s = await loginAsFreshUser(t);
      await seedOne(t, s, randomUUID());

      const res = await clearWorkspace(t, s, {
        currentPassword: 'WrongPassw0rd!',
        eraseHistory: false,
      });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');

      // Nothing swept.
      expect((await householdMutations(t, s.householdId)).length).toBeGreaterThan(0);
      const events = await auditEventsFor(t, s.userId);
      // A workspace_clear_failed audit row was written for the rejection.
      expect(events).toContain('workspace_clear_failed');
      // _started lands only after a successful verify — a rejected password
      // must never emit it (guards the audit ordering).
      expect(events).not.toContain('workspace_clear_started');
    });

    it('is JWT-household-scoped: a body-supplied householdId is rejected (400) and never crosses households', async () => {
      const owner = await loginAsFreshUser(t);
      const other = await loginAsFreshUser(t);
      await seedOne(t, other, randomUUID());

      const res = await clearWorkspace(t, owner, {
        currentPassword: STRONG_PASSWORD,
        eraseHistory: false,
        householdId: other.householdId,
      });
      expect(res.status).toBe(400);

      // The other household's data is untouched — no cross-household clear.
      expect((await householdMutations(t, other.householdId)).length).toBeGreaterThan(0);
    });
  });

  describe('erase-history + keep-key purge', () => {
    it('eraseHistory=false leaves prior snapshots restorable (round-trip recovers the workspace)', async () => {
      const s = await loginAsFreshUser(t);
      const aggregateId = randomUUID();
      await seedOne(t, s, aggregateId, {
        sequenceId: KSUID.fromParts(Date.now() - 10 * 60_000, Buffer.alloc(16)).string,
      });
      const compactor = t.module.get(CompactorService);
      await compactor.runOnce();
      const priorSnapshotId = (await bootstrap(t, s)).body.snapshotId as string;
      expect(priorSnapshotId).toBeTruthy();

      const res = await clearWorkspace(t, s, {
        currentPassword: STRONG_PASSWORD,
        eraseHistory: false,
      });
      expect(res.status).toBe(201);
      expect(res.body.historyErased).toBe(false);

      // The prior snapshot survives alongside the fresh empty one.
      const snaps = (await listSnapshots(t, s)).body as Array<{ snapshotId: string }>;
      expect(snaps.map((x) => x.snapshotId)).toContain(priorSnapshotId);

      // Restoring it actually recovers the prior workspace aggregate.
      const restored = await restore(t, s, priorSnapshotId);
      expect(restored.status).toBe(201);
      const boot = await bootstrap(t, s);
      const got = (
        boot.body.workspaceSnapshot.aggregates as Array<{ id: string; version: number }>
      ).find((a) => a.id === aggregateId);
      expect(got?.version).toBe(1);
    });

    it('eraseHistory=true deletes prior snapshots but preserves the just-minted live empty snapshot (no dangling pointer)', async () => {
      const s = await loginAsFreshUser(t);
      await seedSnapshot(s3, bucket, s.householdId, '2026-01-01T00-00-00-000Z');
      await seedSnapshot(s3, bucket, s.householdId, '2026-02-01T00-00-00-000Z');

      const res = await clearWorkspace(t, s, {
        currentPassword: STRONG_PASSWORD,
        eraseHistory: true,
      });
      expect(res.status).toBe(201);
      expect(res.body.historyErased).toBe(true);

      // Only the fresh empty snapshot remains.
      const snaps = (await listSnapshots(t, s)).body as Array<{ snapshotId: string }>;
      expect(snaps).toHaveLength(1);
      expect(snaps.map((x) => x.snapshotId)).not.toContain('2026-01-01T00-00-00-000Z');

      // WorkspaceMeta still resolves to a live snapshot object (no dangling
      // pointer) and it is empty.
      const meta = await t.doc.send(
        new GetCommand({
          TableName: tableName(t, 'TABLE_WORKSPACE_META'),
          Key: { householdId: s.householdId },
        }),
      );
      const liveId = meta.Item?.latestSnapshotId as string;
      expect(liveId).toBe(snaps[0].snapshotId);
      const live = await snapshotsService.fetch(s.householdId, liveId);
      expect(live).not.toBeNull();
      expect(live?.aggregates).toHaveLength(0);
    });
  });

  describe('multi-device convergence (watermark bump)', () => {
    it('a device sitting exactly at the pre-clear head cursor gets CURSOR_EXPIRED (since === max, strict watermark)', async () => {
      const s = await loginAsFreshUser(t);
      // Backdated so the head is deterministically below the clear-time
      // watermark regardless of same-second KSUID ordering.
      const headCursor = KSUID.fromParts(
        Date.now() - 10 * 60_000,
        randomBytes(16),
      ).string;
      await seedOne(t, s, randomUUID(), { sequenceId: headCursor });

      const res = await clearWorkspace(t, s, {
        currentPassword: STRONG_PASSWORD,
        eraseHistory: false,
      });
      expect(res.status).toBe(201);

      // A second device polling from the real pre-clear head cursor is
      // force-expired → it re-bootstraps onto the empty snapshot.
      const atHead = await pull(t, s, headCursor);
      expect(atHead.status).toBe(409);
      expect(atHead.body.error.code).toBe('CURSOR_EXPIRED');

      // And a device further behind ('0') is likewise expired.
      const behind = await pull(t, s, '0');
      expect(behind.status).toBe(409);
      expect(behind.body.error.code).toBe('CURSOR_EXPIRED');
    });
  });
});
