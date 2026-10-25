// Version-aware rejection-cache replay: a cached rejected push carries its attempted expectedVersion (server-internal), so a replay with a different version re-evaluates, a true duplicate replays the cached rejection, and a legacy row without the field always re-evaluates.
// The concurrent TOCTOU case needs deterministic interleaving the emulator cannot give and lives in push-rejection-cache-toctou.spec.ts.
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

    const corrected = { ...stale, version: 1 };
    const appliedRes = await push(t, s, [corrected]);
    expect(appliedRes.body.rejected).toHaveLength(0);
    expect(appliedRes.body.applied).toHaveLength(1);
    expect(appliedRes.body.applied[0].mutationId).toBe(mutationId);
    expect(appliedRes.body.applied[0].newVersion).toBe(2);

    // The stale rejection row is gone: a further replay returns the new cached applied result, not a resurrected conflict.
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

    // A legacy cached rejection minted before `expectedVersion` existed: the attribute is absent from the row.
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

    // Replayed as-is, this create would wrongly stay a CONFLICT forever; it must re-evaluate and apply.
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
