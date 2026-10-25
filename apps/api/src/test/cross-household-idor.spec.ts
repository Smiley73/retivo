// Cross-household IDOR regression tests: a user must never reach another household's data by tampering with the household id, device or
// credential binding on a sync, device-claim or key-envelope request.
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import KSUID from 'ksuid';
import { gzipSync } from 'node:zlib';
import { ConfigService } from '@nestjs/config';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  bootstrapTestApp,
  freshDeviceId,
  signupVerifyLogin,
  type Session,
  type TestApp,
} from './test-helpers.js';
import { S3_CLIENT } from '../aws/aws.module.js';
import { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import type { HouseholdKeyEnvelopeRow } from '../dynamo/types.js';

function tableName(t: TestApp, key: string): string {
  return t.module
    .get(ConfigService)
    .get(key, { infer: true } as never) as unknown as string;
}

// A strict encrypted-envelope payload, so push clears the plaintext rejection and reaches the authorization checks.
function encryptedPayload(): Record<string, unknown> {
  return {
    encryptionVersion: 1,
    keyId: 'hh-key-1',
    alg: 'AES-256-GCM',
    nonce: 'bm9uY2VfYnl0ZXM',
    ciphertext: 'Y2lwaGVydGV4dF9ieXRlcw',
  };
}

function pushBody(
  s: Session,
  overrides?: {
    householdId?: string;
    bodyDeviceId?: string;
    mutationDeviceId?: string;
  },
): Record<string, unknown> {
  const mutationDeviceId = overrides?.mutationDeviceId ?? s.deviceId;
  return {
    deviceId: overrides?.bodyDeviceId ?? s.deviceId,
    householdId: overrides?.householdId ?? s.householdId,
    mutations: [
      {
        id: randomUUID(),
        aggregateId: randomUUID(),
        aggregateType: 'household',
        operation: 'create',
        version: 0,
        schemaVersion: 1,
        payload: encryptedPayload(),
        timestamp: Date.now(),
        deviceId: mutationDeviceId,
      },
    ],
    freshnessHead: { freshnessCounter: 1, cursorTag: 'a'.repeat(43) },
  };
}

function push(t: TestApp, s: Session, body: Record<string, unknown>): request.Test {
  return request(t.app.getHttpServer())
    .post('/api/v1/sync/push')
    .set('Origin', process.env.WEB_ORIGIN!)
    .set('Authorization', `Bearer ${s.accessToken}`)
    .set('X-CSRF-Token', s.csrfValue)
    .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
    .send(body);
}

// Seeds a MutationLog row directly under the household's own partition, since a plaintext push 403s.
async function seedMutation(t: TestApp, s: Session): Promise<void> {
  await t.doc.send(
    new PutCommand({
      TableName: tableName(t, 'TABLE_MUTATION_LOG'),
      Item: {
        householdId: s.householdId,
        sequenceId: (await KSUID.random()).string,
        deviceId: s.deviceId,
        aggregateId: randomUUID(),
        aggregateType: 'household',
        operation: 'create',
        payload: JSON.stringify({ name: 'B-only data', currency: 'USD' }),
        version: 1,
        timestamp: Date.now(),
        schemaVersion: 1,
      },
    }),
  );
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
      Body: gzipSync(Buffer.from(JSON.stringify({ aggregates: [], cutoff: '0' }), 'utf8')),
      ContentType: 'application/json',
      ContentEncoding: 'gzip',
    }),
  );
}

function passkeyPrfUpsertBody(
  householdId: string,
  credentialBinding: string,
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    slot: {
      householdId,
      slotId: 'passkey_prf',
      slotType: 'passkey_prf',
      prfSalt: 'cHJmU2FsdA',
      credentialBinding,
      wrappedKey: 'cHJmd3JhcA',
      encryptionVersion: 1,
      createdAt: now,
      updatedAt: now,
    },
    envelopeSetVersion: 1,
    // Fresh account, no envelope yet.
    expectedEnvelopeSetVersion: 0,
    envelopeSetTag: 'cHJmdGFn',
  };
}

// The ownership check is a `passkeys.find(userId, credentialId)` read, so the row must land under the user's own partition.
async function seedPasskey(t: TestApp, s: Session): Promise<string> {
  const credentialId = `cred-${randomUUID()}`;
  await t.module.get(PasskeysRepository).insert({
    userId: s.userId,
    credentialId,
    publicKey: 'cHVibGljS2V5',
    counter: 0,
    deviceType: 'multiDevice',
    backedUp: true,
    transports: null,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  });
  return credentialId;
}

describe('cross-household IDOR (1:1 user↔household authorization invariant)', () => {
  let t: TestApp;
  let s3: S3Client;
  let snapshotsBucket: string;

  beforeAll(async () => {
    t = await bootstrapTestApp();
    s3 = t.module.get<S3Client>(S3_CLIENT);
    snapshotsBucket = tableName(t, 'SNAPSHOTS_BUCKET');
  });

  afterAll(async () => {
    await t.app.close();
  });

  describe('POST /sync/push', () => {
    it('rejects a foreign body householdId with 403 HOUSEHOLD_MISMATCH', async () => {
      const a = await signupVerifyLogin(t);
      const b = await signupVerifyLogin(t);
      expect(a.householdId).not.toBe(b.householdId);

      const res = await push(t, a, pushBody(a, { householdId: b.householdId }));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('HOUSEHOLD_MISMATCH');
    });

    it('rejects a body deviceId that differs from the JWT claim with 403 DEVICE_MISMATCH', async () => {
      const a = await signupVerifyLogin(t);

      const res = await push(t, a, pushBody(a, { bodyDeviceId: freshDeviceId() }));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('DEVICE_MISMATCH');
    });
  });

  describe('GET /sync/pull', () => {
    it('returns only the caller household data even when another household has seeded mutations (isolation)', async () => {
      const a = await signupVerifyLogin(t);
      const b = await signupVerifyLogin(t);

      // Pull has no body householdId to tamper with and keys off `me.householdId`, so A seeing none of B's data proves the invariant.
      await seedMutation(t, b);

      const res = await request(t.app.getHttpServer())
        .get('/api/v1/sync/pull')
        .query({ since: '0' })
        .set('Authorization', `Bearer ${a.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.changes).toEqual([]);
    });
  });

  describe('GET /sync/bootstrap', () => {
    it('returns the caller own household snapshot, never another household data (isolation)', async () => {
      const a = await signupVerifyLogin(t);
      const b = await signupVerifyLogin(t);

      await seedMutation(t, b);

      const res = await request(t.app.getHttpServer())
        .get('/api/v1/sync/bootstrap')
        .set('Authorization', `Bearer ${a.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.workspaceSnapshot.householdId).toBe(a.householdId);
      expect(res.body.workspaceSnapshot.householdId).not.toBe(b.householdId);
      expect(res.body.postSnapshotMutations).toEqual([]);
    });
  });

  describe('POST /sync/restore', () => {
    it('returns 404 SNAPSHOT_NOT_FOUND for a snapshotId owned by another household', async () => {
      const a = await signupVerifyLogin(t);
      const b = await signupVerifyLogin(t);

      const snapshotId = '2026-07-07T00-00-00-000Z';
      await seedSnapshot(s3, snapshotsBucket, b.householdId, snapshotId);

      // The S3 key is built from `${me.householdId}/${snapshotId}`, so A's prefix has no such object: 404, never B's data.
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/sync/restore')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .set('X-CSRF-Token', a.csrfValue)
        .set('Cookie', [a.refreshCookie, a.csrfCookie].join('; '))
        .send({ snapshotId });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('SNAPSHOT_NOT_FOUND');
    });
  });

  describe('PUT /auth/key-envelopes/:slotId', () => {
    it('rejects a passkey_prf slot bound to a credential the caller does not own with 422 CREDENTIAL_NOT_FOUND', async () => {
      const a = await signupVerifyLogin(t);

      // No passkey is enrolled for A, so any credentialBinding is unowned and rejected before any write.
      const res = await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/passkey_prf')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .set('X-CSRF-Token', a.csrfValue)
        .set('Cookie', [a.refreshCookie, a.csrfCookie].join('; '))
        .send(passkeyPrfUpsertBody(a.householdId, `cred-${randomUUID()}`));
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('CREDENTIAL_NOT_FOUND');
    });

    it('stores the slot under the JWT household, ignoring a tampered body slot.householdId', async () => {
      const a = await signupVerifyLogin(t);
      const b = await signupVerifyLogin(t);
      expect(a.householdId).not.toBe(b.householdId);

      const aCredentialId = await seedPasskey(t, a);

      // `toSlotRow(me.householdId, ...)` binds the row to the JWT household and ignores the body's `slot.householdId`, so the write lands under A, not B.
      const put = await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/passkey_prf')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .set('X-CSRF-Token', a.csrfValue)
        .set('Cookie', [a.refreshCookie, a.csrfCookie].join('; '))
        .send(passkeyPrfUpsertBody(b.householdId, aCredentialId));
      expect(put.status).toBe(204);

      const aGet = await request(t.app.getHttpServer())
        .get('/api/v1/auth/key-envelopes')
        .set('Authorization', `Bearer ${a.accessToken}`);
      expect(aGet.status).toBe(200);
      const aSlots = aGet.body.slots as HouseholdKeyEnvelopeRow[];
      const aPrf = aSlots.find((slot) => slot.slotId === 'passkey_prf');
      expect(aPrf).toBeDefined();
      expect(aPrf?.householdId).toBe(a.householdId);

      const bGet = await request(t.app.getHttpServer())
        .get('/api/v1/auth/key-envelopes')
        .set('Authorization', `Bearer ${b.accessToken}`);
      expect(bGet.status).toBe(200);
      const bSlots = bGet.body.slots as HouseholdKeyEnvelopeRow[];
      expect(bSlots.find((slot) => slot.slotId === 'passkey_prf')).toBeUndefined();
    });

    it("rejects A's token binding to B's real, enrolled credentialId with 422 CREDENTIAL_NOT_FOUND", async () => {
      const a = await signupVerifyLogin(t);
      const b = await signupVerifyLogin(t);
      expect(a.userId).not.toBe(b.userId);

      // B's credential exists, but only under B's partition.
      const bCredentialId = await seedPasskey(t, b);

      // The ownership lookup is partitioned by userId, so it finds nothing in A's partition and 422s even though the credential exists under B.
      // A random UUID would 422 under a global (un-scoped) lookup too and let a cross-user credential IDOR regression pass; a real foreign
      // credential forces the partitioning to be exercised.
      const res = await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/passkey_prf')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .set('X-CSRF-Token', a.csrfValue)
        .set('Cookie', [a.refreshCookie, a.csrfCookie].join('; '))
        .send(passkeyPrfUpsertBody(a.householdId, bCredentialId));
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('CREDENTIAL_NOT_FOUND');
    });
  });
});
