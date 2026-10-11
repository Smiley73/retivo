/**
 * Cross-household IDOR regression tests.
 *
 * Pins the 1:1 user↔household authorization invariant: a user must never
 * reach another household's data by tampering with the household id (or a
 * device / credential binding) on a sync, device-claim, or key-envelope
 * request. The app's whole authorization model assumes one user maps to
 * exactly one household; this test is the guard that fails a future
 * refactor which silently weakens that assumption. **Test-only — no
 * production source is touched.**
 *
 * Per the repo's testing convention, sync/auth API behaviour is verified
 * end-to-end against the local emulator (DynamoDB Local + Moto S3) through
 * the real HTTP + DynamoDB + S3 path, mirroring restore.spec.ts /
 * key-envelope.spec.ts.
 *
 * Coverage (the authorization checks each case pins):
 *  - POST /sync/push — `assertHousehold(me, dto.householdId)` 403s
 *    HOUSEHOLD_MISMATCH when the body householdId is not the caller's;
 *  - POST /sync/push — a body deviceId that differs from the JWT deviceId
 *    is 403 DEVICE_MISMATCH;
 *  - GET /sync/pull — uses the JWT household ONLY (no body field to
 *    tamper); proven by seeding household B's mutations directly and
 *    showing A's token returns only A's (empty) data;
 *  - GET /sync/bootstrap — same JWT-only pattern; bootstrap returns the
 *    caller's own household snapshot, never B's;
 *  - POST /sync/restore — the snapshot S3 key is `${householdId}/${id}`,
 *    so a foreign snapshotId under A's token 404s SNAPSHOT_NOT_FOUND
 *    rather than crossing households;
 *  - PUT /auth/key-envelopes/:slotId — a passkey_prf slot bound to a
 *    credential the caller does not own is 422 CREDENTIAL_NOT_FOUND;
 *  - PUT /auth/key-envelopes/:slotId — a tampered body `slot.householdId`
 *    is ignored: `toSlotRow(me.householdId, ...)` lands the row under the
 *    JWT household, never the foreign household the body named;
 *  - PUT /auth/key-envelopes/:slotId — binding to ANOTHER user's real,
 *    enrolled credentialId is still 422 CREDENTIAL_NOT_FOUND, because the
 *    ownership lookup is partitioned by `me.userId`.
 *
 * Each case uses fresh emails / device IDs so suites stay independent on
 * the shared DynamoDB Local instance.
 */
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

/** A strict encrypted-envelope payload so push clears the
 *  Plaintext rejection and reaches the authorization checks. */
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
 * Build a well-formed push body. `householdId` / `bodyDeviceId` /
 * `mutationDeviceId` default to the caller's own claims; a test overrides
 * exactly the field whose tampering it is pinning.
 */
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

/**
 * Seed a MutationLog row for the given household directly. A
 * plaintext `POST /sync/push` 403s, so isolation tests seed household B's
 * data under B's own household partition rather than pushing it.
 */
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

/** Write a snapshot object directly to S3 under B's prefix. */
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

/** A well-formed passkey_prf upsert body bound to `credentialBinding`. */
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
    // Fresh account, no envelope yet — expected version is 0 (PUT/DELETE
    // require expectedEnvelopeSetVersion = envelopeSetVersion - 1).
    expectedEnvelopeSetVersion: 0,
    envelopeSetTag: 'cHJmdGFn',
  };
}

/**
 * Enroll a real WebAuthn passkey credential for `s` directly into the
 * user-keyed `Passkey` table and return its credentialId. The
 * `assertCredentialBelongsToUser` check is a `passkeys.find(userId,
 * credentialId)` GetCommand, so the row must land under the user's own
 * partition (`userId = s.userId`) to be found.
 */
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

      // A's real token, but the body claims B's household. The controller's
      // `assertHousehold(me, dto.householdId)` rejects before any DB work.
      const res = await push(t, a, pushBody(a, { householdId: b.householdId }));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('HOUSEHOLD_MISMATCH');
    });

    it('rejects a body deviceId that differs from the JWT claim with 403 DEVICE_MISMATCH', async () => {
      const a = await signupVerifyLogin(t);

      // Same household, but the top-level body deviceId is not the device
      // the JWT was issued for. A JWT for device A cannot pair with
      // mutations claiming device B.
      const res = await push(t, a, pushBody(a, { bodyDeviceId: freshDeviceId() }));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('DEVICE_MISMATCH');
    });
  });

  describe('GET /sync/pull', () => {
    it('returns only the caller household data even when another household has seeded mutations (isolation)', async () => {
      const a = await signupVerifyLogin(t);
      const b = await signupVerifyLogin(t);

      // Seed a mutation for household B directly. There is no body
      // householdId on pull to tamper — the endpoint keys off `me.householdId`
      // only, so the IDOR invariant is proved by A seeing none of B's data.
      await seedMutation(t, b);

      const res = await request(t.app.getHttpServer())
        .get('/api/v1/sync/pull')
        .query({ since: '0' })
        .set('Authorization', `Bearer ${a.accessToken}`);
      expect(res.status).toBe(200);
      // A has pushed nothing → exactly zero changes, none of them B's.
      expect(res.body.changes).toEqual([]);
    });
  });

  describe('GET /sync/bootstrap', () => {
    it('returns the caller own household snapshot, never another household data (isolation)', async () => {
      const a = await signupVerifyLogin(t);
      const b = await signupVerifyLogin(t);

      // Seed data for household B; bootstrap keys off `me.householdId` only.
      await seedMutation(t, b);

      const res = await request(t.app.getHttpServer())
        .get('/api/v1/sync/bootstrap')
        .set('Authorization', `Bearer ${a.accessToken}`);
      expect(res.status).toBe(200);
      // The snapshot is scoped to A's household and carries none of B's rows.
      expect(res.body.workspaceSnapshot.householdId).toBe(a.householdId);
      expect(res.body.workspaceSnapshot.householdId).not.toBe(b.householdId);
      expect(res.body.postSnapshotMutations).toEqual([]);
    });
  });

  describe('POST /sync/restore', () => {
    it('returns 404 SNAPSHOT_NOT_FOUND for a snapshotId owned by another household', async () => {
      const a = await signupVerifyLogin(t);
      const b = await signupVerifyLogin(t);

      // A real snapshot object exists under B's S3 prefix.
      const snapshotId = '2026-07-07T00-00-00-000Z';
      await seedSnapshot(s3, snapshotsBucket, b.householdId, snapshotId);

      // A restores with B's snapshotId. The S3 key is built from
      // `${me.householdId}/${snapshotId}`, so A's prefix has no such object
      // → 404, never reading B's data.
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

      // No passkey is enrolled for A, so any credentialBinding is unowned.
      // `assertCredentialBelongsToUser(me.userId, ...)` rejects before any
      // write, so a client cannot bind a key slot to another account's
      // credential.
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

      // Enroll a real passkey for A so the ownership check
      // (`assertCredentialBelongsToUser(me.userId, ...)`) passes and the
      // request reaches `toSlotRow`.
      const aCredentialId = await seedPasskey(t, a);

      // A's real token, but the body's `slot.householdId` claims B's
      // household. `toSlotRow(me.householdId, slotId, body)` binds the row to
      // the JWT household and IGNORES the body field, so the write must
      // succeed and land under A — not cross into B.
      const put = await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/passkey_prf')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .set('X-CSRF-Token', a.csrfValue)
        .set('Cookie', [a.refreshCookie, a.csrfCookie].join('; '))
        .send(passkeyPrfUpsertBody(b.householdId, aCredentialId));
      expect(put.status).toBe(204);

      // The slot is readable under A's household (GET keys off
      // `me.householdId`), confirming the row landed in A's partition.
      const aGet = await request(t.app.getHttpServer())
        .get('/api/v1/auth/key-envelopes')
        .set('Authorization', `Bearer ${a.accessToken}`);
      expect(aGet.status).toBe(200);
      const aSlots = aGet.body.slots as HouseholdKeyEnvelopeRow[];
      const aPrf = aSlots.find((slot) => slot.slotId === 'passkey_prf');
      expect(aPrf).toBeDefined();
      expect(aPrf?.householdId).toBe(a.householdId);

      // The row is NOT under B's household: B (the household the tampered body
      // named) sees no passkey_prf slot.
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

      // Enroll a REAL passkey for user B. This credentialId genuinely exists —
      // but under B's partition only.
      const bCredentialId = await seedPasskey(t, b);

      // A's token binds the slot to B's real credentialId.
      // `assertCredentialBelongsToUser` is a `passkeys.find(me.userId,
      // credentialId)` GetCommand partitioned by userId, so it looks in A's
      // partition, finds nothing, and 422s — even though the credential exists
      // globally under B.
      //
      // Regression this catches that the random-UUID test cannot: if the
      // lookup were ever changed to a global (un-scoped-by-userId) query, B's
      // real credential WOULD be found and A's bind would wrongly succeed — a
      // cross-user credential IDOR. A random UUID is absent from every
      // partition, so it 422s under both the correct and the broken lookup and
      // would let that regression pass silently. A real foreign credential
      // forces the partitioning to be exercised.
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
