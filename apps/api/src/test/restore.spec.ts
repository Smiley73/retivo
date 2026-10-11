/**
 * Self-service snapshot restore integration tests against the local
 * emulator (DynamoDB Local + Moto S3).
 *
 * Covers GET /sync/snapshots (list, household isolation, auth) and
 * POST /sync/restore (sweep + reinit + AggregateVersion reseed, 404 on
 * unknown snapshot, auth/CSRF rejection, idempotent retry, the
 * CONFLICT-free round-trip, and a compactor-no-op-post-restore
 * durability check).
 *
 * Per the repo's testing convention, sync/auth API behaviour is verified
 * end-to-end here (emulator-backed) rather than via shallow unit tests in
 * `apps/api/src/sync/`; this exercises SnapshotsService, RestoreService,
 * and the controller through the real HTTP + DynamoDB + S3 path.
 */
import request from 'supertest';
import { randomBytes, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import KSUID from 'ksuid';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  bootstrapTestApp,
  signupVerifyLogin as loginAsFreshUser,
  type Session,
  type TestApp,
} from './test-helpers.js';
import { S3_CLIENT } from '../aws/aws.module.js';
import { CompactorService } from '../compactor/compactor.service.js';
import { JanitorService } from '../janitor/janitor.service.js';
import { SnapshotsService } from '../sync/snapshots.service.js';
import { AggregateVersionRepository } from '../dynamo/aggregate-version.repository.js';
import type { EnvConfig } from '../common/env.config.js';

/** A strict encrypted-envelope payload. */
function encryptedPayload(): Record<string, unknown> {
  return {
    encryptionVersion: 1,
    keyId: 'hh-key-1',
    alg: 'AES-256-GCM',
    nonce: 'bm9uY2VfYnl0ZXM',
    ciphertext: 'Y2lwaGVydGV4dF9ieXRlcw',
  };
}

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
 * Seed the full sync state for one mutation directly — WorkspaceMeta (so the
 * compactor scans the household), MutationLog (so compaction has something to
 * fold), AND AggregateVersion (so restore's reseed assertions see the row).
 * This bypasses `POST /sync/push`, which 403s on any plaintext payload.
 * Used wherever push is setup-only (not the behavior under test).
 */
async function seedOne(
  t: TestApp,
  s: Session,
  aggregateId: string,
  opts?: { operation?: 'create' | 'update'; version?: number; sequenceId?: string },
): Promise<void> {
  const config = t.module.get(ConfigService);
  const metaTable = config.get('TABLE_WORKSPACE_META', { infer: true } as never) as unknown as string;
  const logTable = config.get('TABLE_MUTATION_LOG', { infer: true } as never) as unknown as string;
  const versionTable = config.get('TABLE_AGGREGATE_VERSION', { infer: true } as never) as unknown as string;
  const operation = opts?.operation ?? 'create';
  const newVersion = (opts?.version ?? 0) + 1;
  const now = new Date().toISOString();
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
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
  await t.doc.send(
    new PutCommand({
      TableName: logTable,
      Item: {
        householdId: s.householdId,
        // Default sits outside the 60 s margin so compaction sees the row.
        sequenceId: opts?.sequenceId ?? KSUID.fromParts(Date.now() - 10 * 60_000, randomBytes(16)).string,
        deviceId: s.deviceId,
        aggregateId,
        aggregateType: 'household',
        operation,
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
}

/**
 * Push one ENCRYPTED mutation through the real HTTP path.
 * Every push must carry a strict encrypted payload + freshnessHead. Used where
 * push itself is the behavior under test.
 */
async function pushOne(
  t: TestApp,
  s: Session,
  aggregateId: string,
  opts?: { operation?: 'create' | 'update'; version?: number },
): Promise<request.Response> {
  return request(t.app.getHttpServer())
    .post('/api/v1/sync/push')
    .set('Origin', process.env.WEB_ORIGIN!)
    .set('Authorization', `Bearer ${s.accessToken}`)
    .set('X-CSRF-Token', s.csrfValue)
    .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
    .send({
      deviceId: s.deviceId,
      householdId: s.householdId,
      mutations: [
        {
          id: randomUUID(),
          aggregateId,
          aggregateType: 'household',
          operation: opts?.operation ?? 'create',
          version: opts?.version ?? 0,
          schemaVersion: 1,
          payload: encryptedPayload(),
          timestamp: Date.now(),
          deviceId: s.deviceId,
        },
      ],
      freshnessHead: { freshnessCounter: 1, cursorTag: 'a'.repeat(43) },
    });
}

function listSnapshots(t: TestApp, s: Session): Promise<request.Response> {
  return request(t.app.getHttpServer())
    .get('/api/v1/sync/snapshots')
    .set('Authorization', `Bearer ${s.accessToken}`);
}

function restore(
  t: TestApp,
  s: Session,
  snapshotId: string,
): Promise<request.Response> {
  return request(t.app.getHttpServer())
    .post('/api/v1/sync/restore')
    .set('Origin', process.env.WEB_ORIGIN!)
    .set('Authorization', `Bearer ${s.accessToken}`)
    .set('X-CSRF-Token', s.csrfValue)
    .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
    .send({ snapshotId });
}

function bootstrap(t: TestApp, s: Session): Promise<request.Response> {
  return request(t.app.getHttpServer())
    .get('/api/v1/sync/bootstrap')
    .set('Authorization', `Bearer ${s.accessToken}`);
}

/** Write a snapshot object directly to S3 so list/restore have an
 *  object to read without running the compactor (used for the
 *  household-isolation + list-shape tests). */
async function seedSnapshot(
  s3: S3Client,
  bucket: string,
  householdId: string,
  snapshotId: string,
  body: { aggregates: unknown[]; cutoff: string | null },
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${householdId}/${snapshotId}.json.gz`,
      Body: gzipSync(Buffer.from(JSON.stringify(body), 'utf8')),
      ContentType: 'application/json',
      ContentEncoding: 'gzip',
    }),
  );
}

/** Write a snapshot object whose body is NOT valid gzip, so the fetch
 *  path's `gunzipSync` throws — exercising the corrupt-object branch
 *  (a real read failure must surface a non-404 error, not a
 *  misleading SNAPSHOT_NOT_FOUND). */
async function seedCorruptSnapshot(
  s3: S3Client,
  bucket: string,
  householdId: string,
  snapshotId: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${householdId}/${snapshotId}.json.gz`,
      Body: Buffer.from('not-gzip-not-json', 'utf8'),
      ContentType: 'application/json',
    }),
  );
}

/** Write a snapshot object that is valid gzip + valid JSON but malformed
 *  in SHAPE (the decoded body has no `aggregates` array). The fetch path
 *  must reject this instead of coercing it to an empty snapshot, so a
 *  restore cannot sweep the household and reseed nothing. */
async function seedMalformedSnapshot(
  s3: S3Client,
  bucket: string,
  householdId: string,
  snapshotId: string,
  body: unknown,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${householdId}/${snapshotId}.json.gz`,
      Body: gzipSync(Buffer.from(JSON.stringify(body), 'utf8')),
      ContentType: 'application/json',
      ContentEncoding: 'gzip',
    }),
  );
}

describe('snapshot restore API', () => {
  let t: TestApp;
  let s3: S3Client;
  let bucket: string;
  let metaTable: string;
  let aggregateVersionTable: string;
  let mutationLogTable: string;
  let snapshotsService: SnapshotsService;

  beforeAll(async () => {
    t = await bootstrapTestApp();
    s3 = t.module.get<S3Client>(S3_CLIENT);
    snapshotsService = t.module.get(SnapshotsService);
    const config = t.module.get(ConfigService);
    bucket = config.get('SNAPSHOTS_BUCKET', { infer: true } as never) as unknown as string;
    metaTable = config.get('TABLE_WORKSPACE_META', { infer: true } as never) as unknown as string;
    aggregateVersionTable = config.get('TABLE_AGGREGATE_VERSION', { infer: true } as never) as unknown as string;
    mutationLogTable = config.get('TABLE_MUTATION_LOG', { infer: true } as never) as unknown as string;
  });

  afterAll(async () => {
    await t.app.close();
  });

  describe('GET /sync/snapshots', () => {
    it('returns an empty array when the household has no snapshots', async () => {
      const s = await loginAsFreshUser(t);
      const res = await listSnapshots(t, s);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('lists the household snapshots newest-first with an ISO timestamp', async () => {
      const s = await loginAsFreshUser(t);
      await seedSnapshot(s3, bucket, s.householdId, '2026-01-01T00-00-00-000Z', {
        aggregates: [],
        cutoff: '0',
      });
      await seedSnapshot(s3, bucket, s.householdId, '2026-03-01T00-00-00-000Z', {
        aggregates: [],
        cutoff: '0',
      });

      const res = await listSnapshots(t, s);
      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ snapshotId: string; timestamp: string }>).map(
        (x) => x.snapshotId,
      );
      expect(ids).toContain('2026-01-01T00-00-00-000Z');
      expect(ids).toContain('2026-03-01T00-00-00-000Z');
      // Each item carries a parseable ISO timestamp from S3 LastModified.
      for (const item of res.body as Array<{ timestamp: string }>) {
        expect(Number.isNaN(Date.parse(item.timestamp))).toBe(false);
      }
    });

    it('does not return another household snapshots (isolation)', async () => {
      const owner = await loginAsFreshUser(t);
      const other = await loginAsFreshUser(t);
      await seedSnapshot(s3, bucket, other.householdId, '2026-02-02T00-00-00-000Z', {
        aggregates: [],
        cutoff: '0',
      });
      const res = await listSnapshots(t, owner);
      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ snapshotId: string }>).map((x) => x.snapshotId);
      expect(ids).not.toContain('2026-02-02T00-00-00-000Z');
    });
  });

  describe('POST /sync/restore', () => {
    it('restores the chosen snapshot: bootstrap serves it and a subsequent push does not CONFLICT', async () => {
      const s = await loginAsFreshUser(t);
      const aggregateId = randomUUID();
      // Snapshot the household at v1 (single create — avoids relying on
      // intra-second KSUID ordering of multiple compacted mutations).
      // Seed directly (push is not under test here): A plaintext push
      // 403s, and seedOne writes the WorkspaceMeta + MutationLog +
      // AggregateVersion rows the compactor + restore assertions need.
      await seedOne(t, s, aggregateId, { operation: 'create', version: 0, sequenceId: backdatedSeq(0) });
      const compactor = t.module.get(CompactorService);
      await compactor.runOnce();

      const snapBoot = await bootstrap(t, s);
      const snapshotId = snapBoot.body.snapshotId as string;
      expect(snapshotId).toBeTruthy();

      // Diverge from the snapshot: update v1 → v2 (now the current
      // server state is ahead of the snapshot we'll restore).
      await seedOne(t, s, aggregateId, { operation: 'update', version: 1, sequenceId: backdatedSeq(1) });

      // Restore back to the v1 snapshot.
      const res = await restore(t, s, snapshotId);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true });

      // MutationLog is swept clean.
      const logRows = await t.doc.send(
        new QueryCommand({
          TableName: mutationLogTable,
          KeyConditionExpression: 'householdId = :h',
          ExpressionAttributeValues: { ':h': s.householdId },
        }),
      );
      expect(logRows.Items ?? []).toHaveLength(0);

      // WorkspaceMeta points at a FRESH minted snapshot key,
      // NOT the chosen (old) one — so the janitor's newest-N retention
      // always protects the live pointer.
      const meta = await t.doc.send(
        new GetCommand({ TableName: metaTable, Key: { householdId: s.householdId } }),
      );
      const freshId = meta.Item?.latestSnapshotId as string;
      expect(freshId).toBeTruthy();
      expect(freshId).not.toBe(snapshotId);

      // A snapshot object exists at the fresh key carrying the restored
      // aggregate at v1.
      const fresh = await snapshotsService.fetchStrict(s.householdId, freshId);
      expect(fresh.aggregates.find((a) => a.id === aggregateId)?.version).toBe(1);

      // Bootstrap serves the restored snapshot's aggregate at v1.
      const boot = await bootstrap(t, s);
      expect(boot.body.snapshotId).toBe(freshId);
      const restored = (
        boot.body.workspaceSnapshot.aggregates as Array<{ id: string; version: number }>
      ).find((a) => a.id === aggregateId);
      expect(restored?.version).toBe(1);

      // A push at the restored version (update v1 → v2) succeeds — the
      // AggregateVersion reseed means no spurious CONFLICT.
      const after = await pushOne(t, s, aggregateId, { operation: 'update', version: 1 });
      expect(after.status).toBe(201);
      expect(after.body.applied).toHaveLength(1);
      expect(after.body.rejected).toHaveLength(0);
    });

    it('janitor-after-restore: the live pointer survives because restore mints a FRESH (newest) key, and bootstrap still serves the restored aggregates', async () => {
      const s = await loginAsFreshUser(t);
      const aggregateId = randomUUID();
      const DAY_MS = 24 * 60 * 60 * 1000;

      // The CHOSEN snapshot is an OLD object (>90 days) carrying a real
      // aggregate. On its own it would rank past MIN_KEEP and be older
      // than MIN_AGE_DAYS → janitor-deletable. Pre-fix, restore repointed
      // WorkspaceMeta at THIS key, so the janitor could delete the live
      // pointer → next bootstrap NoSuchKey → empty workspace.
      const chosenTs = Date.now() - 200 * DAY_MS;
      const chosenId = new Date(chosenTs).toISOString().replace(/[:.]/g, '-');
      await seedSnapshot(s3, bucket, s.householdId, chosenId, {
        aggregates: [
          {
            id: aggregateId,
            householdId: s.householdId,
            schemaVersion: 1,
            version: 1,
            updatedAt: new Date(chosenTs).toISOString(),
            deviceId: s.deviceId,
            aggregateType: 'household',
            payload: { name: 'Restored', currency: 'USD' },
          },
        ],
        cutoff: '0',
      });
      // 12 additional OLD keys, all newer than the chosen one but still
      // >90 days old, so the chosen key ranks > MIN_KEEP (10) AND is past
      // MIN_AGE_DAYS — i.e. squarely in the janitor's delete set.
      for (let i = 1; i <= 12; i++) {
        const ts = chosenTs + i * DAY_MS;
        const id = new Date(ts).toISOString().replace(/[:.]/g, '-');
        await seedSnapshot(s3, bucket, s.householdId, id, { aggregates: [], cutoff: '0' });
      }

      // Restore to the chosen OLD snapshot.
      const res = await restore(t, s, chosenId);
      expect(res.status).toBe(201);

      // WorkspaceMeta points at a FRESH (current-timestamp) key, not the
      // old chosen one.
      const meta = await t.doc.send(
        new GetCommand({ TableName: metaTable, Key: { householdId: s.householdId } }),
      );
      const freshId = meta.Item?.latestSnapshotId as string;
      expect(freshId).not.toBe(chosenId);

      // Run the janitor immediately. It deletes the old keys past the
      // floor + age, but the freshly minted key is the newest → kept.
      const janitor = t.module.get(JanitorService);
      await janitor.runOnce();

      // The live pointer still exists in S3.
      const fresh = await snapshotsService.fetch(s.householdId, freshId);
      expect(fresh).not.toBeNull();
      expect(fresh?.aggregates.find((a) => a.id === aggregateId)?.version).toBe(1);

      // And a subsequent bootstrap returns the restored aggregates — NOT
      // an empty workspace.
      const boot = await bootstrap(t, s);
      expect(boot.body.snapshotId).toBe(freshId);
      const got = (
        boot.body.workspaceSnapshot.aggregates as Array<{ id: string; version: number }>
      ).find((a) => a.id === aggregateId);
      expect(got?.version).toBe(1);
    });

    it('returns 404 SNAPSHOT_NOT_FOUND for an unknown snapshotId', async () => {
      const s = await loginAsFreshUser(t);
      const res = await restore(t, s, '2099-01-01T00-00-00-000Z');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('SNAPSHOT_NOT_FOUND');
    });

    it('returns 404 for another household snapshotId (cross-household isolation)', async () => {
      const owner = await loginAsFreshUser(t);
      const other = await loginAsFreshUser(t);
      await seedSnapshot(s3, bucket, other.householdId, '2026-04-04T00-00-00-000Z', {
        aggregates: [],
        cutoff: '0',
      });
      // owner's household has no such key → 404, never reads other's data.
      const res = await restore(t, owner, '2026-04-04T00-00-00-000Z');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('SNAPSHOT_NOT_FOUND');
    });

    it('surfaces a non-404 server error for a corrupt (un-gunzippable) snapshot object, not SNAPSHOT_NOT_FOUND', async () => {
      const s = await loginAsFreshUser(t);
      // A snapshot object exists but its body is not valid gzip → the
      // fetch path's gunzip throws. This is a real read failure, NOT a
      // missing object, so it must NOT be swallowed into a 404.
      await seedCorruptSnapshot(s3, bucket, s.householdId, '2026-05-05T00-00-00-000Z');
      const res = await restore(t, s, '2026-05-05T00-00-00-000Z');
      expect(res.status).not.toBe(404);
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(res.body?.error?.code).not.toBe('SNAPSHOT_NOT_FOUND');
      // NOTE: the S3-dependency-5xx case (GetObject returns 503) follows
      // the same rethrow path but is impractical to drive deterministically
      // against the Moto emulator; the corrupt-object branch above is the
      // deterministic proxy that proves real failures are not masked as 404.
    });

    it('surfaces a non-404 server error for a shape-malformed snapshot and does NOT sweep the household', async () => {
      const s = await loginAsFreshUser(t);
      const aggregateId = randomUUID();
      // Establish real sync state: a compacted snapshot + an
      // AggregateVersion row. This is the state a swept-but-not-reseeded
      // restore would silently destroy.
      // Seed directly (push is setup-only here, not under test): A
      // plaintext push 403s; seedOne writes WorkspaceMeta + MutationLog +
      // AggregateVersion so the compactor + restore assertions have real state.
      await seedOne(t, s, aggregateId, { operation: 'create', version: 0 });
      const compactor = t.module.get(CompactorService);
      await compactor.runOnce();
      const goodSnapshotId = (await bootstrap(t, s)).body.snapshotId as string;
      expect(goodSnapshotId).toBeTruthy();

      // Capture the pre-restore sync state.
      const metaBefore = await t.doc.send(
        new GetCommand({ TableName: metaTable, Key: { householdId: s.householdId } }),
      );
      const versionBefore = await t.doc.send(
        new QueryCommand({
          TableName: aggregateVersionTable,
          KeyConditionExpression: 'householdId = :h',
          ExpressionAttributeValues: { ':h': s.householdId },
        }),
      );
      expect((versionBefore.Items ?? []).some((r) => r.aggregateId === aggregateId)).toBe(
        true,
      );

      // A snapshot object that is valid gzip + valid JSON but malformed in
      // SHAPE (`{}` — no `aggregates` array). The fetch path must reject it
      // BEFORE the sweep rather than coerce it to an empty snapshot.
      await seedMalformedSnapshot(s3, bucket, s.householdId, '2026-06-06T00-00-00-000Z', {});
      const res = await restore(t, s, '2026-06-06T00-00-00-000Z');
      expect(res.status).not.toBe(404);
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(res.body?.error?.code).not.toBe('SNAPSHOT_NOT_FOUND');

      // The household was NOT swept/reinitialised — WorkspaceMeta and the
      // AggregateVersion row are byte-for-byte the pre-restore state.
      const metaAfter = await t.doc.send(
        new GetCommand({ TableName: metaTable, Key: { householdId: s.householdId } }),
      );
      expect(metaAfter.Item?.latestSnapshotId).toBe(metaBefore.Item?.latestSnapshotId);
      expect(metaAfter.Item?.latestSnapshotCursor).toBe(
        metaBefore.Item?.latestSnapshotCursor,
      );
      const versionAfter = await t.doc.send(
        new QueryCommand({
          TableName: aggregateVersionTable,
          KeyConditionExpression: 'householdId = :h',
          ExpressionAttributeValues: { ':h': s.householdId },
        }),
      );
      const matchAfter = (versionAfter.Items ?? []).filter(
        (r) => r.aggregateId === aggregateId,
      );
      expect(matchAfter).toHaveLength(1);
      expect(matchAfter[0].version).toBe(1);
    });

    it('is idempotent: restoring the same snapshot twice yields the same state', async () => {
      const s = await loginAsFreshUser(t);
      const aggregateId = randomUUID();
      // Seed directly (push is setup-only here, not under test): A
      // plaintext push 403s; seedOne writes WorkspaceMeta + MutationLog +
      // AggregateVersion so the compactor + restore assertions have real state.
      await seedOne(t, s, aggregateId, { operation: 'create', version: 0 });
      const compactor = t.module.get(CompactorService);
      await compactor.runOnce();
      const snapshotId = (await bootstrap(t, s)).body.snapshotId as string;

      const first = await restore(t, s, snapshotId);
      expect(first.status).toBe(201);
      const second = await restore(t, s, snapshotId);
      expect(second.status).toBe(201);

      // AggregateVersion holds exactly one (idempotent) row at v1.
      const rows = await t.doc.send(
        new QueryCommand({
          TableName: aggregateVersionTable,
          KeyConditionExpression: 'householdId = :h',
          ExpressionAttributeValues: { ':h': s.householdId },
        }),
      );
      const matching = (rows.Items ?? []).filter(
        (r) => r.aggregateId === aggregateId,
      );
      expect(matching).toHaveLength(1);
      expect(matching[0].version).toBe(1);
    });

    it('durability: running the compactor immediately after restore is a no-op', async () => {
      const s = await loginAsFreshUser(t);
      const aggregateId = randomUUID();
      // Seed directly (push is setup-only here, not under test): A
      // plaintext push 403s; seedOne writes WorkspaceMeta + MutationLog +
      // AggregateVersion so the compactor + restore assertions have real state.
      await seedOne(t, s, aggregateId, { operation: 'create', version: 0 });
      const compactor = t.module.get(CompactorService);
      await compactor.runOnce();
      const snapshotId = (await bootstrap(t, s)).body.snapshotId as string;

      await restore(t, s, snapshotId);
      const before = await t.doc.send(
        new GetCommand({ TableName: metaTable, Key: { householdId: s.householdId } }),
      );
      // Restore points at a FRESH minted key, not the chosen old one.
      const freshId = before.Item?.latestSnapshotId as string;
      expect(freshId).not.toBe(snapshotId);

      // No pushes since restore → the compactor's queryAllSince(> cutoff)
      // is empty → it must not move the snapshot pointer.
      await compactor.runOnce();
      const after = await t.doc.send(
        new GetCommand({ TableName: metaTable, Key: { householdId: s.householdId } }),
      );
      expect(after.Item?.latestSnapshotId).toBe(before.Item?.latestSnapshotId);
      expect(after.Item?.latestSnapshotCursor).toBe(before.Item?.latestSnapshotCursor);
      expect(after.Item?.latestSnapshotId).toBe(freshId);
    });

    it('a throw during the AggregateVersion reseed leaves WorkspaceMeta ABSENT (not pointing at a versionless snapshot), logs RestoreReseedIncomplete, and a re-run converges (pointer-flip-last)', async () => {
      const s = await loginAsFreshUser(t);
      const aggregateId = randomUUID();
      await seedOne(t, s, aggregateId, { operation: 'create', version: 0 });
      const compactor = t.module.get(CompactorService);
      await compactor.runOnce();
      const snapshotId = (await bootstrap(t, s)).body.snapshotId as string;

      const warnCalls: string[] = [];
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation((...args: unknown[]) => {
          warnCalls.push(String(args[0]));
        });
      const aggregateVersions = t.module.get(AggregateVersionRepository);
      const putSpy = jest
        .spyOn(aggregateVersions, 'put')
        .mockRejectedValueOnce(new Error('simulated crash mid-reseed'));

      const crashed = await restore(t, s, snapshotId);
      expect(crashed.status).toBeGreaterThanOrEqual(500);

      // The reorder's whole point: the pointer flip is the LAST step, so a
      // throw during the reseed (which runs BEFORE it) leaves WorkspaceMeta
      // absent — the sweep already deleted it — rather than pointing at a
      // fresh snapshot whose AggregateVersion rows don't all exist yet.
      const metaAfterCrash = await t.doc.send(
        new GetCommand({ TableName: metaTable, Key: { householdId: s.householdId } }),
      );
      expect(metaAfterCrash.Item).toBeUndefined();

      // Best-effort structured log — never silently swallowed.
      expect(warnCalls.some((line) => line.includes('RestoreReseedIncomplete'))).toBe(true);

      putSpy.mockRestore();
      warnSpy.mockRestore();

      // Idempotent re-run converges to the FINAL state: WorkspaceMeta points
      // at a fresh snapshot again and the AggregateVersion row exists — no
      // permanent NOT_FOUND on the next push.
      const retried = await restore(t, s, snapshotId);
      expect(retried.status).toBe(201);
      const metaAfterRetry = await t.doc.send(
        new GetCommand({ TableName: metaTable, Key: { householdId: s.householdId } }),
      );
      expect(metaAfterRetry.Item?.latestSnapshotId).toBeTruthy();
      const versionRows = await t.doc.send(
        new QueryCommand({
          TableName: aggregateVersionTable,
          KeyConditionExpression: 'householdId = :h',
          ExpressionAttributeValues: { ':h': s.householdId },
        }),
      );
      expect((versionRows.Items ?? []).some((r) => r.aggregateId === aggregateId)).toBe(true);
    });
  });
});

// SnapshotsService.fetch only treats a genuine object-miss
// (`NoSuchKey`) as the soft null case. A 404-shaped INFRA error such as
// `NoSuchBucket` (deleted / misconfigured bucket) shares httpStatusCode
// 404 but is NOT an object miss — swallowing it to null would hide a real
// infra fault behind an empty bootstrap / a misleading SNAPSHOT_NOT_FOUND.
// Driven via a stubbed S3 client (the NoSuchBucket shape is impractical to
// produce against the Moto emulator), matching the unit-stub pattern in
// account-snapshot-purge-service.spec.ts.
describe('SnapshotsService.fetch — 404-shaped infra errors are not soft-null', () => {
  function makeConfig(): ConfigService<EnvConfig, true> {
    const values: Partial<EnvConfig> = { SNAPSHOTS_BUCKET: 'snapshots-bucket' };
    return {
      get: (key: keyof EnvConfig) => values[key],
    } as unknown as ConfigService<EnvConfig, true>;
  }

  function makeService(send: jest.Mock): SnapshotsService {
    const stubbedS3 = { send } as unknown as S3Client;
    return new SnapshotsService(stubbedS3, makeConfig());
  }

  it('rethrows a NoSuchBucket-shaped 404 error instead of returning null', async () => {
    const send = jest.fn().mockRejectedValue(
      Object.assign(new Error('The specified bucket does not exist'), {
        name: 'NoSuchBucket',
        $metadata: { httpStatusCode: 404 },
      }),
    );
    const service = makeService(send);
    // Must SURFACE as a real error, not be swallowed into a soft null.
    await expect(service.fetch('hh-1', 'snap-1')).rejects.toMatchObject({
      name: 'NoSuchBucket',
    });
  });

  it('returns null for a genuine NoSuchKey object miss (soft case stays intact)', async () => {
    const send = jest.fn().mockRejectedValue(
      Object.assign(new Error('The specified key does not exist'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      }),
    );
    const service = makeService(send);
    await expect(service.fetch('hh-1', 'snap-1')).resolves.toBeNull();
  });
});
