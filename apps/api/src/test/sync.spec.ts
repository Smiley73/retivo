// Sync API integration tests against the local emulator: push (idempotency, conflicts, tombstone revival), pull cursoring and bootstrap.
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import KSUID from 'ksuid';
import { ConfigService } from '@nestjs/config';
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  bootstrapTestApp,
  makeMutation,
  signupVerifyLogin as loginAsFreshUser,
  type PushMutation,
  type Session,
  type TestApp,
} from './test-helpers.js';
import { HouseholdKeyEnvelopesRepository } from '../dynamo/household-key-envelopes.repository.js';
import { PushService } from '../sync/push.service.js';
import type { AggregateVersionRow } from '../dynamo/types.js';

async function push(
  t: TestApp,
  s: Session,
  mutations: PushMutation[],
  freshnessHead?: { freshnessCounter: number; cursorTag: string },
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
      mutations,
      ...(freshnessHead ? { freshnessHead } : {}),
    });
}

async function pull(t: TestApp, s: Session, since: string): Promise<request.Response> {
  return request(t.app.getHttpServer())
    .get(`/api/v1/sync/pull?since=${encodeURIComponent(since)}`)
    .set('Authorization', `Bearer ${s.accessToken}`);
}

async function bootstrap(t: TestApp, s: Session, force = false): Promise<request.Response> {
  return request(t.app.getHttpServer())
    .get(`/api/v1/sync/bootstrap?force=${force}`)
    .set('Authorization', `Bearer ${s.accessToken}`);
}

function encryptedPayload(): Record<string, unknown> {
  return {
    encryptionVersion: 1,
    keyId: 'hh-key-1',
    alg: 'AES-256-GCM',
    nonce: 'bm9uY2VfYnl0ZXM',
    ciphertext: 'Y2lwaGVydGV4dF9ieXRlcw',
  };
}

// The controller validates a 43-char base64url tag (a 32-byte HMAC), so push fixtures need a real-shaped one; `seed` keeps them distinguishable.
function validTag(seed: string): string {
  return seed.padEnd(43, '0').slice(0, 43);
}

const TEST_FRESHNESS_HEAD = { freshnessCounter: 1, cursorTag: validTag('test') };

// Seeds a MutationLog row directly, bypassing the DTO boundary and the ENCRYPTION_REQUIRED push guard: for legacy rows of retired aggregate
// types (the pull/bootstrap egress filter is the last defence) and for pull/bootstrap data.
async function seedLegacyMutationLogRow(
  t: TestApp,
  s: Session,
  overrides: { aggregateType: string; payload: Record<string, unknown>; aggregateId?: string },
): Promise<{ sequenceId: string; aggregateId: string }> {
  const config = t.module.get(ConfigService);
  const table = config.get('TABLE_MUTATION_LOG', { infer: true } as never) as unknown as string;
  const sequenceId = (await KSUID.random()).string;
  const aggregateId = overrides.aggregateId ?? randomUUID();
  await t.doc.send(
    new PutCommand({
      TableName: table,
      Item: {
        householdId: s.householdId,
        sequenceId,
        deviceId: s.deviceId,
        aggregateId,
        aggregateType: overrides.aggregateType,
        operation: 'create',
        payload: JSON.stringify(overrides.payload),
        version: 1,
        timestamp: Date.now(),
        schemaVersion: 1,
      },
    }),
  );
  return { sequenceId, aggregateId };
}

describe('sync API', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  describe('POST /sync/push (3.2)', () => {
    it('applies a fresh create mutation', async () => {
      const s = await loginAsFreshUser(t);
      const m = makeMutation(s, { payload: encryptedPayload() });
      const res = await push(t, s, [m], TEST_FRESHNESS_HEAD);
      expect(res.status).toBe(201);
      expect(res.body.applied).toHaveLength(1);
      expect(res.body.rejected).toHaveLength(0);
      expect(res.body.applied[0].mutationId).toBe(m.id);
      expect(res.body.applied[0].sequenceId).toBeTruthy();
    });

    it('idempotency: replaying the same mutation id returns the cached applied result', async () => {
      const s = await loginAsFreshUser(t);
      const m = makeMutation(s, { payload: encryptedPayload() });
      const first = await push(t, s, [m], TEST_FRESHNESS_HEAD);
      expect(first.status).toBe(201);
      expect(first.body.applied).toHaveLength(1);
      const second = await push(t, s, [m], TEST_FRESHNESS_HEAD);
      expect(second.status).toBe(201);
      expect(second.body.applied).toHaveLength(1);
      expect(second.body.applied[0].mutationId).toBe(m.id);
      expect(second.body.rejected).toHaveLength(0);
      const pulled = await pull(t, s, '0');
      const matches = (
        pulled.body.changes as Array<{ aggregateId: string }>
      ).filter((c) => c.aggregateId === m.aggregateId);
      expect(matches).toHaveLength(1);
    });

    it('conflict: a second create on the same aggregateId is rejected with currentVersion', async () => {
      const s = await loginAsFreshUser(t);
      const aggregateId = randomUUID();
      const first = await push(
        t,
        s,
        [makeMutation(s, { aggregateId, version: 0, payload: encryptedPayload() })],
        TEST_FRESHNESS_HEAD,
      );
      expect(first.status).toBe(201);
      expect(first.body.applied).toHaveLength(1);
      expect(first.body.applied[0].newVersion).toBe(1);
      const second = await push(
        t,
        s,
        [makeMutation(s, { aggregateId, version: 0, payload: encryptedPayload() })],
        TEST_FRESHNESS_HEAD,
      );
      expect(second.status).toBe(201);
      expect(second.body.applied).toHaveLength(0);
      expect(second.body.rejected).toHaveLength(1);
      expect(second.body.rejected[0].reason).toBe('CONFLICT');
      expect(second.body.rejected[0].currentVersion).toBe(1);
      expect(second.body.rejected[0].currentDeletedAt).toBeNull();
    });

    it('recreate over a tombstone succeeds and continues the version lineage', async () => {
      const s = await loginAsFreshUser(t);
      const aggregateId = randomUUID();
      const created = await push(
        t,
        s,
        [makeMutation(s, { aggregateId, version: 0, payload: encryptedPayload() })],
        TEST_FRESHNESS_HEAD,
      );
      expect(created.body.applied).toHaveLength(1);
      const deleted = await push(
        t,
        s,
        [makeMutation(s, { aggregateId, version: 1, operation: 'delete', payload: encryptedPayload() })],
        TEST_FRESHNESS_HEAD,
      );
      expect(deleted.body.applied).toHaveLength(1);
      expect(deleted.body.applied[0].newVersion).toBe(2);
      // Recreate at version 0 succeeds: the server revives the tombstone via the full 3-item TransactWriteItems, continuing the lineage v2 to v3.
      const recreateMutation = makeMutation(s, { aggregateId, version: 0, payload: encryptedPayload() });
      const recreated = await push(t, s, [recreateMutation], TEST_FRESHNESS_HEAD);
      expect(recreated.body.rejected).toHaveLength(0);
      expect(recreated.body.applied).toHaveLength(1);
      expect(recreated.body.applied[0].newVersion).toBe(3);
      expect(recreated.body.applied[0].recreatedOverTombstone).toBe(true);

      // The replay returns the cached result: the revive's transaction wrote a real IdempotencyKey row.
      const replay = await push(t, s, [recreateMutation], TEST_FRESHNESS_HEAD);
      expect(replay.body.rejected).toHaveLength(0);
      expect(replay.body.applied).toHaveLength(1);
      expect(replay.body.applied[0].newVersion).toBe(3);

      const pulled = await pull(t, s, '0');
      const rows = (
        pulled.body.changes as Array<{ aggregateId: string; version: number }>
      ).filter((c) => c.aggregateId === aggregateId);
      expect(rows.some((r) => r.version === 3)).toBe(true);
    });

    it('create over a LIVE (non-tombstone) row still returns CONFLICT (currentDeletedAt distinction)', async () => {
      const s = await loginAsFreshUser(t);
      const aggregateId = randomUUID();
      const first = await push(
        t,
        s,
        [makeMutation(s, { aggregateId, version: 0, payload: encryptedPayload() })],
        TEST_FRESHNESS_HEAD,
      );
      expect(first.body.applied).toHaveLength(1);
      // A create over a still-live aggregateId is a genuine collision, not a revivable tombstone; currentDeletedAt tells them apart.
      const second = await push(
        t,
        s,
        [makeMutation(s, { aggregateId, version: 0, payload: encryptedPayload() })],
        TEST_FRESHNESS_HEAD,
      );
      expect(second.body.applied).toHaveLength(0);
      expect(second.body.rejected).toHaveLength(1);
      expect(second.body.rejected[0].reason).toBe('CONFLICT');
      expect(second.body.rejected[0].currentDeletedAt).toBeNull();
    });

    it("tombstoneRevivalPut's condition rejects a LIVE row at the same version number a stale tombstone read once had (attribute_type, not attribute_exists)", async () => {
      // `attribute_exists(deletedAt)` is always true because live rows carry `deletedAt: null`, a present NULL-type attribute, so the old condition
      // gave no protection against a concurrent write (e.g. a restore reseed) landing a tombstoned row back to live at a matching version. This
      // runs the production `tombstoneRevivalPut` builder against the emulator: a stale revival Put over a live row at the same version must fail.
      const s = await loginAsFreshUser(t);
      const config = t.module.get(ConfigService);
      const versionTable = config.get(
        'TABLE_AGGREGATE_VERSION',
        { infer: true } as never,
      ) as unknown as string;
      const aggregateId = randomUUID();
      const staleTombstoneVersion = 2;

      await t.doc.send(
        new PutCommand({
          TableName: versionTable,
          Item: {
            householdId: s.householdId,
            aggregateId,
            aggregateType: 'account',
            version: staleTombstoneVersion,
            updatedAt: new Date().toISOString(),
            deletedAt: null,
          },
        }),
      );

      const pushService = t.module.get(PushService);
      const revivalPut = (
        pushService as unknown as {
          tombstoneRevivalPut: (
            row: AggregateVersionRow,
            tombstoneVersion: number,
          ) => { Put: NonNullable<TransactWriteCommand['input']['TransactItems']>[number]['Put'] };
        }
      ).tombstoneRevivalPut(
        {
          householdId: s.householdId,
          aggregateId,
          aggregateType: 'account',
          version: staleTombstoneVersion + 1,
          updatedAt: new Date().toISOString(),
          deletedAt: null,
        },
        staleTombstoneVersion,
      );

      await expect(
        t.doc.send(new TransactWriteCommand({ TransactItems: [revivalPut] })),
      ).rejects.toMatchObject({ name: 'TransactionCanceledException' });

      const after = await t.doc.send(
        new GetCommand({
          TableName: versionTable,
          Key: { householdId: s.householdId, aggregateId },
        }),
      );
      expect(after.Item?.version).toBe(staleTombstoneVersion);
      expect(after.Item?.deletedAt).toBeNull();
    });

    it('a create with the same aggregateId in a DIFFERENT household is an ordinary fresh create, never a cross-household tombstone revival (partition scoping)', async () => {
      const householdA = await loginAsFreshUser(t);
      const householdB = await loginAsFreshUser(t);
      const aggregateId = randomUUID();

      await push(
        t,
        householdA,
        [makeMutation(householdA, { aggregateId, version: 0, payload: encryptedPayload() })],
        TEST_FRESHNESS_HEAD,
      );
      await push(
        t,
        householdA,
        [makeMutation(householdA, { aggregateId, version: 1, operation: 'delete', payload: encryptedPayload() })],
        TEST_FRESHNESS_HEAD,
      );

      // Household B's same aggregateId is a distinct partition key: an ordinary create, never a revival of A's tombstone.
      const res = await push(
        t,
        householdB,
        [makeMutation(householdB, { aggregateId, version: 0, payload: encryptedPayload() })],
        TEST_FRESHNESS_HEAD,
      );
      expect(res.body.rejected).toHaveLength(0);
      expect(res.body.applied).toHaveLength(1);
      expect(res.body.applied[0].newVersion).toBe(1);
      expect(res.body.applied[0].recreatedOverTombstone).toBeFalsy();
    });
  });

  describe('GET /sync/pull (3.3)', () => {
    it('returns changes newer than the cursor', async () => {
      const s = await loginAsFreshUser(t);
      const seeded = await seedLegacyMutationLogRow(t, s, {
        aggregateType: 'household',
        payload: encryptedPayload(),
      });
      const sequenceId = seeded.sequenceId;

      const pulled = await pull(t, s, '0');
      expect(pulled.status).toBe(200);
      const aggIds = (pulled.body.changes as Array<{ aggregateId: string }>).map(
        (c) => c.aggregateId,
      );
      expect(aggIds).toContain(seeded.aggregateId);
      expect(typeof pulled.body.newCursor).toBe('string');
      expect(typeof pulled.body.hasMore).toBe('boolean');

      const after = await pull(t, s, sequenceId);
      expect(after.status).toBe(200);
      expect(after.body.changes).toHaveLength(0);
      expect(after.body.hasMore).toBe(false);
    });

    it('rejects calls without a `since` query param', async () => {
      const s = await loginAsFreshUser(t);
      const res = await request(t.app.getHttpServer())
        .get('/api/v1/sync/pull')
        .set('Authorization', `Bearer ${s.accessToken}`);
      expect(res.status).toBe(400);
    });

    it('returns 409 CURSOR_EXPIRED when `since` predates the compactor watermark', async () => {
      // Silent data-loss guard: once the compactor rolls mutations into a snapshot and purges them, an incremental pull from below
      // `mutationLogCursorBase` would miss them, so the server must reject (CURSOR_EXPIRED) and the client re-bootstraps.
      const s = await loginAsFreshUser(t);
      // KSUIDs have 1-second resolution and seeds in the same second can land out of order, so pick the watermark by sorted sequenceId.
      const seed1 = await seedLegacyMutationLogRow(t, s, {
        aggregateType: 'household',
        payload: encryptedPayload(),
      });
      const seed2 = await seedLegacyMutationLogRow(t, s, {
        aggregateType: 'household',
        payload: encryptedPayload(),
      });
      const a = { seq: seed1.sequenceId, aggId: seed1.aggregateId };
      const b = { seq: seed2.sequenceId, aggId: seed2.aggregateId };
      const [lower, higher] = a.seq < b.seq ? [a, b] : [b, a];
      const tableName = t.module
        .get(ConfigService)
        .get('TABLE_WORKSPACE_META', { infer: true } as never) as unknown as string;
      await t.doc.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { householdId: s.householdId },
          UpdateExpression: 'SET mutationLogCursorBase = :cur',
          ExpressionAttributeValues: { ':cur': lower.seq },
        }),
      );

      const expired = await pull(t, s, '0');
      expect(expired.status).toBe(409);
      expect(expired.body.error.code).toBe('CURSOR_EXPIRED');
      expect(expired.body.error.traceId).toBeTruthy();

      // A cursor at the watermark is allowed: only `<` is rejected.
      const atBase = await pull(t, s, lower.seq);
      expect(atBase.status).toBe(200);
      const atBaseIds = (atBase.body.changes as Array<{ aggregateId: string }>).map(
        (c) => c.aggregateId,
      );
      expect(atBaseIds).toContain(higher.aggId);

      const fresh = await pull(t, s, higher.seq);
      expect(fresh.status).toBe(200);
      expect(fresh.body.changes).toHaveLength(0);
    });

    it('filters out rows for retired aggregate types but advances the cursor past them', async () => {
      // The `plan` aggregate type was removed but dev rows lingered, and the client threw on the missing IDB store at every login. Pull now drops
      // unknown types; the legacy row is seeded directly because push rejects retired types.
      const s = await loginAsFreshUser(t);
      await seedLegacyMutationLogRow(t, s, {
        aggregateType: 'household',
        payload: encryptedPayload(),
      });
      await seedLegacyMutationLogRow(t, s, {
        aggregateType: 'plan',
        payload: { name: 'Legacy plan' },
      });

      const pulled = await pull(t, s, '0');
      expect(pulled.status).toBe(200);
      const types = (pulled.body.changes as Array<{ aggregateType: string }>).map(
        (c) => c.aggregateType,
      );
      expect(types).toContain('household');
      expect(types).not.toContain('plan');
      // The cursor advances past the filtered row; otherwise the retired row would replay forever.
      const after = await pull(t, s, pulled.body.newCursor);
      expect(after.body.changes).toHaveLength(0);
    });
  });

  describe('GET /sync/bootstrap (3.4)', () => {
    it('returns an empty workspaceSnapshot + the full post-snapshot mutation log when no snapshot has been compacted yet', async () => {
      const s = await loginAsFreshUser(t);
      const seeded = await seedLegacyMutationLogRow(t, s, {
        aggregateType: 'household',
        payload: encryptedPayload(),
      });
      const res = await bootstrap(t, s, false);
      expect(res.status).toBe(200);
      expect(res.body.snapshotId).toBeNull();
      expect(res.body.workspaceSnapshot).toBeTruthy();
      expect(res.body.workspaceSnapshot.householdId).toBe(s.householdId);
      expect(Array.isArray(res.body.workspaceSnapshot.aggregates)).toBe(true);
      expect(Array.isArray(res.body.postSnapshotMutations)).toBe(true);
      const aggIds = (
        res.body.postSnapshotMutations as Array<{ aggregateId: string }>
      ).map((x) => x.aggregateId);
      expect(aggIds).toContain(seeded.aggregateId);
      expect(typeof res.body.syncCursor).toBe('string');
      expect(typeof res.body.timestamp).toBe('string');
    });

    it('returns 200 with the same body shape when force=true', async () => {
      const s = await loginAsFreshUser(t);
      const seeded = await seedLegacyMutationLogRow(t, s, {
        aggregateType: 'household',
        payload: encryptedPayload(),
      });
      // force=true only drives the forced-bootstrap log metric; the response shape matches force=false.
      const res = await bootstrap(t, s, true);
      expect(res.status).toBe(200);
      expect(res.body.snapshotId).toBeNull();
      expect(res.body.workspaceSnapshot.householdId).toBe(s.householdId);
      expect(Array.isArray(res.body.postSnapshotMutations)).toBe(true);
      const aggIds = (
        res.body.postSnapshotMutations as Array<{ aggregateId: string }>
      ).map((x) => x.aggregateId);
      expect(aggIds).toContain(seeded.aggregateId);
      expect(typeof res.body.syncCursor).toBe('string');
    });

    it('filters out post-snapshot mutations for retired aggregate types', async () => {
      // The push DTO forbids retired types, so the legacy row is seeded directly for the bootstrap egress filter to drop.
      const s = await loginAsFreshUser(t);
      await seedLegacyMutationLogRow(t, s, {
        aggregateType: 'household',
        payload: encryptedPayload(),
      });
      await seedLegacyMutationLogRow(t, s, {
        aggregateType: 'plan',
        payload: { name: 'Legacy plan' },
      });

      const res = await bootstrap(t, s, false);
      expect(res.status).toBe(200);
      const types = (
        res.body.postSnapshotMutations as Array<{ aggregateType: string }>
      ).map((m) => m.aggregateType);
      expect(types).toContain('household');
      expect(types).not.toContain('plan');
    });
  });

  describe('freshness head round-trip (zero-knowledge)', () => {
    it('push with freshnessHead echoes the stored head in the response', async () => {
      const s = await loginAsFreshUser(t);
      const res = await push(t, s, [makeMutation(s, { payload: encryptedPayload() })], {
        freshnessCounter: 1,
        cursorTag: validTag('tag1'),
      });
      expect(res.status).toBe(201);
      expect(res.body.freshnessHead).toBeTruthy();
      expect(res.body.freshnessHead.freshnessCounter).toBe(1);
      expect(res.body.freshnessHead.cursorTag).toBe(validTag('tag1'));
    });

    it('push with a lower counter is a no-op bump; response echoes the stored higher head', async () => {
      const s = await loginAsFreshUser(t);
      const first = await push(t, s, [makeMutation(s, { payload: encryptedPayload() })], {
        freshnessCounter: 5,
        cursorTag: validTag('tag5'),
      });
      expect(first.body.freshnessHead.freshnessCounter).toBe(5);
      // The monotonic guard rejects the lower counter, so the response echoes the stored counter (5), not the proposed 3.
      const second = await push(t, s, [makeMutation(s, { payload: encryptedPayload() })], {
        freshnessCounter: 3,
        cursorTag: validTag('tag3'),
      });
      expect(second.status).toBe(201);
      expect(second.body.freshnessHead.freshnessCounter).toBe(5);
      expect(second.body.freshnessHead.cursorTag).toBe(validTag('tag5'));
    });

    it('pull includes the stored freshnessHead', async () => {
      const s = await loginAsFreshUser(t);
      await push(t, s, [makeMutation(s, { payload: encryptedPayload() })], {
        freshnessCounter: 2,
        cursorTag: validTag('tag2'),
      });
      const res = await pull(t, s, '0');
      expect(res.status).toBe(200);
      expect(res.body.freshnessHead).toBeTruthy();
      expect(res.body.freshnessHead.freshnessCounter).toBe(2);
      expect(res.body.freshnessHead.cursorTag).toBe(validTag('tag2'));
    });

    it('bootstrap includes the stored freshnessHead', async () => {
      const s = await loginAsFreshUser(t);
      await push(t, s, [makeMutation(s, { payload: encryptedPayload() })], {
        freshnessCounter: 3,
        cursorTag: validTag('tag3'),
      });
      const res = await bootstrap(t, s, false);
      expect(res.status).toBe(200);
      expect(res.body.freshnessHead).toBeTruthy();
      expect(res.body.freshnessHead.freshnessCounter).toBe(3);
      expect(res.body.freshnessHead.cursorTag).toBe(validTag('tag3'));
    });

    it('fresh household bootstrap with no prior push has no freshnessHead', async () => {
      const s = await loginAsFreshUser(t);
      // A household that never pushed has no stored head (a plaintext push 403s), so bootstrap omits it.
      const res = await bootstrap(t, s, false);
      expect(res.status).toBe(200);
      expect(res.body.freshnessHead).toBeUndefined();
    });
  });

  describe('ENCRYPTION_REQUIRED guard — unconditional on every household', () => {
    async function seedKeySlot(s: Session): Promise<void> {
      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      const now = new Date().toISOString();
      await repo.upsertSlot({
        householdId: s.householdId,
        slotId: 'password',
        slotType: 'password',
        kdf: { algorithm: 'PBKDF2-HMAC-SHA-256', iterations: 600_000, salt: 'c2FsdA' },
        wrappedKey: 'd3JhcHBlZA',
        encryptionVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
    }

    it('fresh household (no slots yet) STILL rejects a plaintext push with ENCRYPTION_REQUIRED (no slot required)', async () => {
      const s = await loginAsFreshUser(t);
      // The encryption guard is unconditional: a plaintext push 403s whether or not a slot exists.
      const res = await push(t, s, [makeMutation(s)]);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ENCRYPTION_REQUIRED');
    });

    it('fresh household (no slots) accepts a strict encrypted payload with a freshnessHead — no slot required', async () => {
      const s = await loginAsFreshUser(t);
      const res = await push(
        t,
        s,
        [makeMutation(s, { aggregateType: 'account', payload: encryptedPayload() })],
        TEST_FRESHNESS_HEAD,
      );
      expect(res.status).toBe(201);
      expect(res.body.applied).toHaveLength(1);
    });

    it('keyed household rejects a plaintext mutation with ENCRYPTION_REQUIRED', async () => {
      const s = await loginAsFreshUser(t);
      await seedKeySlot(s);
      const res = await push(t, s, [makeMutation(s)], {
        freshnessCounter: 1,
        cursorTag: validTag('tag1'),
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ENCRYPTION_REQUIRED');
    });

    it('keyed household rejects a push missing freshnessHead with ENCRYPTION_REQUIRED', async () => {
      const s = await loginAsFreshUser(t);
      await seedKeySlot(s);
      const res = await push(t, s, [
        makeMutation(s, { aggregateType: 'account', payload: encryptedPayload() }),
      ]);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ENCRYPTION_REQUIRED');
    });

    it('keyed household accepts a strict encrypted payload with a freshnessHead', async () => {
      const s = await loginAsFreshUser(t);
      await seedKeySlot(s);
      const res = await push(
        t,
        s,
        [makeMutation(s, { aggregateType: 'account', payload: encryptedPayload() })],
        { freshnessCounter: 1, cursorTag: validTag('tag1') },
      );
      expect(res.status).toBe(201);
      expect(res.body.applied).toHaveLength(1);
    });

    it('a mixed batch [encrypted, plaintext] on a keyed household fails 403 atomically — the first mutation is NOT persisted', async () => {
      const s = await loginAsFreshUser(t);
      await seedKeySlot(s);
      // The encrypted mutation goes first and the plaintext second: the two-pass preflight must reject the whole batch before any write.
      const encrypted = makeMutation(s, {
        aggregateType: 'account',
        payload: encryptedPayload(),
      });
      const plaintext = makeMutation(s);
      const res = await push(t, s, [encrypted, plaintext], {
        freshnessCounter: 1,
        cursorTag: validTag('tag1'),
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ENCRYPTION_REQUIRED');
      // Neither aggregate may appear: the first (encrypted) mutation must not commit before the second fails the guard.
      const pulled = await pull(t, s, '0');
      expect(pulled.status).toBe(200);
      const aggIds = (
        pulled.body.changes as Array<{ aggregateId: string }>
      ).map((c) => c.aggregateId);
      expect(aggIds).not.toContain(encrypted.aggregateId);
      expect(aggIds).not.toContain(plaintext.aggregateId);
    });

    it('replaying an already-committed encrypted mutation returns its cached applied result (idempotency wins)', async () => {
      const s = await loginAsFreshUser(t);
      await seedKeySlot(s);
      // A replay of the same mutation id short-circuits at the idempotency lookup before the encryption guard, so the encrypted retry contract holds.
      const m = makeMutation(s, { aggregateType: 'account', payload: encryptedPayload() });
      const first = await push(t, s, [m], TEST_FRESHNESS_HEAD);
      expect(first.status).toBe(201);
      expect(first.body.applied).toHaveLength(1);
      const replay = await push(t, s, [m], TEST_FRESHNESS_HEAD);
      expect(replay.status).toBe(201);
      expect(replay.body.applied).toHaveLength(1);
      expect(replay.body.applied[0].mutationId).toBe(m.id);
      expect(replay.body.rejected).toHaveLength(0);
    });
  });
});
