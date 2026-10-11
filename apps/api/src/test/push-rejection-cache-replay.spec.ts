/**
 * Version-aware, TOCTOU-safe rejection-cache replay.
 *
 * A cached REJECTED push outcome now carries the mutation's attempted
 * `expectedVersion` (server-internal — never on the client-facing
 * `RejectedMutationResult`). A later replay of the SAME
 * `(householdId, deviceId, mutationId)` whose incoming `version` differs
 * means the client re-based and retried with a corrected version, so the
 * stale rejection must not be replayed — the server conditionally deletes
 * the cached row and re-evaluates the mutation from scratch. A TRUE
 * duplicate (same version) still replays the cached rejection exactly, and
 * a legacy row minted before this field existed always re-evaluates
 * (bypass on any incoming version).
 *
 * HTTP/emulator-level (real DynamoDB Local + Moto) — exercises the full
 * push pipeline, matching the repo's sync-API test convention
 * (apps/api/src/test/sync.spec.ts). The TOCTOU-specific "concurrent
 * corrected retries never cache a false CONFLICT" case needs deterministic
 * control over interleaving the emulator can't provide — that is a
 * mock-based unit test, `push-rejection-cache-toctou.spec.ts`.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  bootstrapTestApp,
  makeMutation,
  signupVerifyLogin as loginAsFreshUser,
  type PushMutation,
  type Session,
  type TestApp,
} from './test-helpers.js';
import { IdempotencyKeyRepository } from '../dynamo/idempotency-key.repository.js';

async function push(
  t: TestApp,
  s: Session,
  mutations: PushMutation[],
  freshnessHead = { freshnessCounter: 1, cursorTag: 'a'.repeat(43) },
): Promise<request.Response> {
  return request(t.app.getHttpServer())
    .post('/api/v1/sync/push')
    .set('Origin', process.env.WEB_ORIGIN!)
    .set('Authorization', `Bearer ${s.accessToken}`)
    .set('X-CSRF-Token', s.csrfValue)
    .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
    .send({ deviceId: s.deviceId, householdId: s.householdId, mutations, freshnessHead });
}

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

describe('push rejection-cache replay', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('a corrected-version retry of the SAME mutation id is applied, not stale-rejected', async () => {
    const s = await loginAsFreshUser(t);
    const aggregateId = randomUUID();
    const created = await push(t, s, [
      makeMutation(s, { aggregateId, version: 0, payload: encryptedPayload() }),
    ]);
    expect(created.body.applied).toHaveLength(1);

    // Client mistakenly (or staleness-induced) sends an update at version 0
    // when the server is already at version 1 → CONFLICT, cached with
    // expectedVersion: 0.
    const mutationId = randomUUID();
    const stale = makeMutation(s, {
      id: mutationId,
      aggregateId,
      version: 0,
      operation: 'update',
      payload: encryptedPayload(),
    });
    const rejected = await push(t, s, [stale]);
    expect(rejected.body.rejected).toHaveLength(1);
    expect(rejected.body.rejected[0].reason).toBe('CONFLICT');
    expect(rejected.body.rejected[0].currentVersion).toBe(1);

    // Client re-bases and retries the SAME mutation id with the corrected
    // version — must be APPLIED, not the stale cached CONFLICT.
    const corrected = { ...stale, version: 1 };
    const appliedRes = await push(t, s, [corrected]);
    expect(appliedRes.body.rejected).toHaveLength(0);
    expect(appliedRes.body.applied).toHaveLength(1);
    expect(appliedRes.body.applied[0].mutationId).toBe(mutationId);
    expect(appliedRes.body.applied[0].newVersion).toBe(2);

    // The stale cached rejection row is gone: a further replay of the
    // corrected mutation id returns the NEW cached applied result (stable
    // exact-replay), not a resurrected conflict.
    const replay = await push(t, s, [corrected]);
    expect(replay.body.rejected).toHaveLength(0);
    expect(replay.body.applied).toHaveLength(1);
    expect(replay.body.applied[0].newVersion).toBe(2);
  });

  it('a true duplicate (same version) still replays the cached rejection exactly', async () => {
    const s = await loginAsFreshUser(t);
    const aggregateId = randomUUID();
    const created = await push(t, s, [
      makeMutation(s, { aggregateId, version: 0, payload: encryptedPayload() }),
    ]);
    expect(created.body.applied).toHaveLength(1);

    const stale = makeMutation(s, {
      aggregateId,
      version: 0,
      operation: 'update',
      payload: encryptedPayload(),
    });
    const first = await push(t, s, [stale]);
    expect(first.body.rejected).toHaveLength(1);
    expect(first.body.rejected[0].reason).toBe('CONFLICT');

    // Exact same mutation id AND version — a genuine duplicate, not a
    // re-based retry. Replays the identical cached rejection.
    const second = await push(t, s, [stale]);
    expect(second.body.rejected).toHaveLength(1);
    expect(second.body.rejected[0]).toEqual(first.body.rejected[0]);
  });

  it('a legacy rejection row lacking expectedVersion re-evaluates (applies) rather than replaying', async () => {
    const s = await loginAsFreshUser(t);
    const aggregateId = randomUUID();
    const mutationId = randomUUID();
    const config = t.module.get(ConfigService);
    const idemTable = config.get('TABLE_IDEMPOTENCY_KEY', { infer: true } as never) as unknown as string;
    const idemKey = IdempotencyKeyRepository.composeKey(s.householdId, s.deviceId, mutationId);

    // Seed a LEGACY cached rejection minted before `expectedVersion`
    // existed — no such attribute on the row at all.
    await t.doc.send(
      new PutCommand({
        TableName: idemTable,
        Item: {
          key: idemKey,
          response: {
            status: 'rejected',
            mutationId,
            aggregateId,
            reason: 'CONFLICT',
            currentVersion: 0,
            currentUpdatedAt: new Date().toISOString(),
            currentDeletedAt: null,
          },
          createdAt: new Date().toISOString(),
          expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
        },
      }),
    );

    // A fresh create at version 0 for an aggregate that doesn't exist yet —
    // if the legacy rejection were replayed as-is this would wrongly stay a
    // CONFLICT forever; instead it must re-evaluate and apply.
    const mutation = makeMutation(s, {
      id: mutationId,
      aggregateId,
      version: 0,
      payload: encryptedPayload(),
    });
    const res = await push(t, s, [mutation]);
    expect(res.body.rejected).toHaveLength(0);
    expect(res.body.applied).toHaveLength(1);
    expect(res.body.applied[0].newVersion).toBe(1);
  });
});
