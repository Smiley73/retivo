// Ingress bounds on push: the daily quota (mutation count and bytes), the timestamp and schemaVersion DTO bounds, the freshness-counter step bound and the strict-envelope unknown-key guard.
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  bootstrapTestApp,
  decodeAccessClaims,
  freshDeviceId,
  makeMutation,
  parseSetCookies,
  signupVerifyLogin as loginAsFreshUser,
  STRONG_PASSWORD,
  type PushMutation,
  type Session,
  type TestApp,
} from './test-helpers.js';
import {
  REFRESH_COOKIE_NAME,
  CSRF_COOKIE_NAME,
} from '../auth/cookie-config.js';
import { WorkspaceMetaRepository } from '../dynamo/workspace-meta.repository.js';
import { DeviceRegistryRepository } from '../dynamo/device-registry.repository.js';
import { MutationLogRepository } from '../dynamo/mutation-log.repository.js';
import {
  SCHEMA_VERSION_CEILING,
  TIMESTAMP_MAX_FUTURE_SKEW_MS,
  TIMESTAMP_MAX_PAST_WINDOW_MS,
} from '../sync/dto/push.dto.js';
import { SnapshotsService } from '../sync/snapshots.service.js';

function encryptedPayload(): Record<string, unknown> {
  return {
    encryptionVersion: 1,
    keyId: 'hh-key-1',
    alg: 'AES-256-GCM',
    nonce: 'bm9uY2VfYnl0ZXM',
    ciphertext: 'Y2lwaGVydGV4dF9ieXRlcw',
  };
}

const VALID_CURSOR_TAG = 'a'.repeat(43);
const MAX_DAILY_MUTATIONS = 10_000;
const MAX_DAILY_BYTES = 50 * 1024 * 1024;
const FRESHNESS_COUNTER_MAX_STEP = 1000;
const MAX_PUSH_MUTATIONS = 100;
const utcDayStamp = (): string => new Date().toISOString().slice(0, 10);

async function push(
  t: TestApp,
  s: Session,
  mutations: PushMutation[],
  freshnessHead: { freshnessCounter: number; cursorTag: string } = {
    freshnessCounter: 1,
    cursorTag: VALID_CURSOR_TAG,
  },
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
      freshnessHead,
    });
}

async function countMutationLogRows(t: TestApp, householdId: string): Promise<number> {
  const config = t.module.get(ConfigService);
  const table = config.get('TABLE_MUTATION_LOG', { infer: true } as never) as unknown as string;
  const r = await t.doc.send(
    new ScanCommand({
      TableName: table,
      FilterExpression: 'householdId = :h',
      ExpressionAttributeValues: { ':h': householdId },
      Select: 'COUNT',
    }),
  );
  return r.Count ?? 0;
}

async function seedQuota(
  t: TestApp,
  householdId: string,
  quota: { quotaDay: string; dailyMutationCount: number; dailyByteCount: number },
): Promise<void> {
  const repo = t.module.get(WorkspaceMetaRepository);
  await repo.createIfMissing(householdId);
  const config = t.module.get(ConfigService);
  const table = config.get('TABLE_WORKSPACE_META', { infer: true } as never) as unknown as string;
  await t.doc.send(
    new UpdateCommand({
      TableName: table,
      Key: { householdId },
      UpdateExpression: 'SET quotaDay = :d, dailyMutationCount = :m, dailyByteCount = :b',
      ExpressionAttributeValues: {
        ':d': quota.quotaDay,
        ':m': quota.dailyMutationCount,
        ':b': quota.dailyByteCount,
      },
    }),
  );
}

describe('sync push bounds', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  describe('daily push-quota — mutation count', () => {
    it('refuses a push that would exceed the mutation-count budget, with zero rows written', async () => {
      const s = await loginAsFreshUser(t);
      const today = utcDayStamp();
      await seedQuota(t, s.householdId, {
        quotaDay: today,
        dailyMutationCount: MAX_DAILY_MUTATIONS - 1,
        dailyByteCount: 0,
      });
      const before = await countMutationLogRows(t, s.householdId);
      const res = await push(t, s, [
        makeMutation(s, { payload: encryptedPayload() }),
        makeMutation(s, { payload: encryptedPayload() }),
      ]);
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('PUSH_QUOTA_EXCEEDED');
      expect(await countMutationLogRows(t, s.householdId)).toBe(before);
    });

    it('accepts a push that lands exactly within the remaining mutation-count room', async () => {
      const s = await loginAsFreshUser(t);
      const today = utcDayStamp();
      await seedQuota(t, s.householdId, {
        quotaDay: today,
        dailyMutationCount: MAX_DAILY_MUTATIONS - 1,
        dailyByteCount: 0,
      });
      const res = await push(t, s, [makeMutation(s, { payload: encryptedPayload() })]);
      expect(res.status).toBe(201);
      expect(res.body.applied).toHaveLength(1);
    });
  });

  describe('daily push-quota — payload bytes', () => {
    it('refuses a push that would exceed the byte budget, with zero rows written', async () => {
      const s = await loginAsFreshUser(t);
      const today = utcDayStamp();
      const mutation = makeMutation(s, { payload: encryptedPayload() });
      const bytes = Buffer.byteLength(JSON.stringify(mutation.payload), 'utf8');
      await seedQuota(t, s.householdId, {
        quotaDay: today,
        dailyMutationCount: 0,
        dailyByteCount: MAX_DAILY_BYTES - bytes + 1,
      });
      const before = await countMutationLogRows(t, s.householdId);
      const res = await push(t, s, [mutation]);
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('PUSH_QUOTA_EXCEEDED');
      expect(await countMutationLogRows(t, s.householdId)).toBe(before);
    });

    it('accepts a push that lands exactly within the remaining byte room, and accumulates dailyByteCount', async () => {
      const s = await loginAsFreshUser(t);
      const today = utcDayStamp();
      const mutation = makeMutation(s, { payload: encryptedPayload() });
      const bytes = Buffer.byteLength(JSON.stringify(mutation.payload), 'utf8');
      const seededBase = MAX_DAILY_BYTES - bytes;
      await seedQuota(t, s.householdId, {
        quotaDay: today,
        dailyMutationCount: 0,
        dailyByteCount: seededBase,
      });
      const res = await push(t, s, [mutation]);
      expect(res.status).toBe(201);

      // Pins `chargeDailyQuota`'s `ADD dailyByteCount :addB`: accept/reject alone would pass if `:addB` were wired to 0 or bytes dropped from the preflight, and the budget would never accumulate.
      const repo = t.module.get(WorkspaceMetaRepository);
      const row = await repo.find(s.householdId);
      expect(row?.dailyByteCount).toBe(seededBase + bytes);
    });

    it('accumulates dailyByteCount across every mutation in a multi-mutation batch', async () => {
      const s = await loginAsFreshUser(t);
      const mutations = [
        makeMutation(s, { payload: encryptedPayload() }),
        makeMutation(s, { payload: { ...encryptedPayload(), aadVersion: 1 } }),
        makeMutation(s, { payload: { ...encryptedPayload(), aadVersion: 2 } }),
      ];
      const totalBytes = mutations.reduce(
        (sum, m) => sum + Buffer.byteLength(JSON.stringify(m.payload), 'utf8'),
        0,
      );
      const res = await push(t, s, mutations);
      expect(res.status).toBe(201);
      expect(res.body.applied).toHaveLength(3);

      const repo = t.module.get(WorkspaceMetaRepository);
      const row = await repo.find(s.householdId);
      expect(row?.dailyByteCount).toBe(totalBytes);
    });
  });

  describe('daily push-quota — UTC day rollover', () => {
    it('rolls over on a stale UTC day, ignoring the prior day\'s near-max count', async () => {
      const s = await loginAsFreshUser(t);
      await seedQuota(t, s.householdId, {
        quotaDay: '2000-01-01',
        dailyMutationCount: MAX_DAILY_MUTATIONS - 1,
        dailyByteCount: MAX_DAILY_BYTES - 1,
      });
      const res = await push(t, s, [makeMutation(s, { payload: encryptedPayload() })]);
      expect(res.status).toBe(201);

      const repo = t.module.get(WorkspaceMetaRepository);
      const row = await repo.find(s.householdId);
      expect(row?.quotaDay).toBe(utcDayStamp());
      expect(row?.dailyMutationCount).toBe(1);
    });
  });

  describe('daily push-quota — not resettable by a household-triggerable operation', () => {
    async function exhaustBudget(s: Session): Promise<void> {
      await seedQuota(t, s.householdId, {
        quotaDay: utcDayStamp(),
        dailyMutationCount: MAX_DAILY_MUTATIONS,
        dailyByteCount: 0,
      });
    }

    it('a re-bootstrap does not hand the household a fresh budget', async () => {
      const s = await loginAsFreshUser(t);
      await exhaustBudget(s);

      const bootstrapRes = await request(t.app.getHttpServer())
        .get('/api/v1/sync/bootstrap?force=true')
        .set('Authorization', `Bearer ${s.accessToken}`);
      expect(bootstrapRes.status).toBe(200);

      const res = await push(t, s, [makeMutation(s, { payload: encryptedPayload() })]);
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('PUSH_QUOTA_EXCEEDED');
    });

    async function reLoginAfterReset(s: Session): Promise<Session> {
      const reLogin = await request(t.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email: s.email, password: STRONG_PASSWORD, deviceId: freshDeviceId() });
      expect(reLogin.status).toBe(200);
      const cookies = parseSetCookies(reLogin.headers['set-cookie']);
      const claims = decodeAccessClaims(reLogin.body.accessToken);
      return {
        accessToken: reLogin.body.accessToken,
        refreshCookie: `${REFRESH_COOKIE_NAME}=${encodeURIComponent(cookies[REFRESH_COOKIE_NAME])}`,
        csrfCookie: `${CSRF_COOKIE_NAME}=${encodeURIComponent(cookies[CSRF_COOKIE_NAME])}`,
        csrfValue: cookies[CSRF_COOKIE_NAME],
        deviceId: claims.deviceId,
        householdId: claims.householdId,
        userId: claims.userId,
        email: s.email,
      };
    }

    // A push already past its `createIfMissing` when a household-triggerable sweep starts charges the quota on either side of the sweep's WorkspaceMeta delete,
    // and that charge must survive the carry-forward. Each case seeds MAX-1, injects one charge from inside the sweep, and asserts the next push sees a spent
    // budget (429): with the charge lost the same push is accepted against MAX-1.
    async function seedOneBelowBudget(s: Session): Promise<void> {
      await seedQuota(t, s.householdId, {
        quotaDay: utcDayStamp(),
        dailyMutationCount: MAX_DAILY_MUTATIONS - 1,
        dailyByteCount: 0,
      });
    }

    async function inFlightCharge(householdId: string): Promise<void> {
      const repo = t.module.get(WorkspaceMetaRepository);
      const charge = await repo.chargeDailyQuota(
        householdId,
        1,
        0,
        MAX_DAILY_MUTATIONS,
        MAX_DAILY_BYTES,
      );
      expect(charge).toEqual({ ok: true });
    }

    function chargeBeforeFirstCallOf(repo: {
      deleteAllForHousehold: (householdId: string) => Promise<unknown>;
    }): jest.SpyInstance {
      const original = repo.deleteAllForHousehold.bind(repo);
      return jest
        .spyOn(repo, 'deleteAllForHousehold')
        .mockImplementationOnce(async (householdId: string) => {
          await inFlightCharge(householdId);
          return original(householdId);
        });
    }

    it('a snapshot restore carries forward a charge that lands after any pre-sweep read but before the sweep deletes WorkspaceMeta', async () => {
      const s = await loginAsFreshUser(t);
      const snapshots = t.module.get(SnapshotsService);
      const snapshotId = await snapshots.write(s.householdId, { aggregates: [], cutoff: '0' });
      await seedOneBelowBudget(s);

      // MutationLog is the sweep's first step: a charge here commits after everything the service read and before the WorkspaceMeta delete.
      const spy = chargeBeforeFirstCallOf(t.module.get(MutationLogRepository));
      try {
        const restoreRes = await request(t.app.getHttpServer())
          .post('/api/v1/sync/restore')
          .set('Origin', process.env.WEB_ORIGIN!)
          .set('Authorization', `Bearer ${s.accessToken}`)
          .set('X-CSRF-Token', s.csrfValue)
          .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
          .send({ snapshotId });
        expect(restoreRes.status).toBe(201);
      } finally {
        spy.mockRestore();
      }

      const res = await push(t, s, [makeMutation(s, { payload: encryptedPayload() })]);
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('PUSH_QUOTA_EXCEEDED');
    });

    it('a workspace clear carries forward a charge that lands after any pre-sweep read but before the sweep deletes WorkspaceMeta', async () => {
      const s = await loginAsFreshUser(t);
      await seedOneBelowBudget(s);

      const spy = chargeBeforeFirstCallOf(t.module.get(MutationLogRepository));
      try {
        const clearRes = await request(t.app.getHttpServer())
          .post('/api/v1/sync/workspace/clear')
          .set('Origin', process.env.WEB_ORIGIN!)
          .set('Authorization', `Bearer ${s.accessToken}`)
          .set('X-CSRF-Token', s.csrfValue)
          .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
          .send({ currentPassword: STRONG_PASSWORD, eraseHistory: false });
        expect(clearRes.status).toBe(201);
      } finally {
        spy.mockRestore();
      }

      const res = await push(t, s, [makeMutation(s, { payload: encryptedPayload() })]);
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('PUSH_QUOTA_EXCEEDED');
    });

    it('an encrypted-workspace reset merges the captured counters with a charge that recreated WorkspaceMeta after the sweep deleted it', async () => {
      const s = await loginAsFreshUser(t);
      await seedOneBelowBudget(s);

      // DeviceRegistry is the sweep's last step, after the WorkspaceMeta delete: the charge recreates the row with a count of 1, and the captured MAX-1 must be added on top of it, not discarded.
      const spy = chargeBeforeFirstCallOf(t.module.get(DeviceRegistryRepository));
      try {
        const resetRes = await request(t.app.getHttpServer())
          .post('/api/v1/auth/encrypted-workspace-reset')
          .set('Origin', process.env.WEB_ORIGIN!)
          .set('Authorization', `Bearer ${s.accessToken}`)
          .set('X-CSRF-Token', s.csrfValue)
          .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
          .send({ confirmation: 'DELETE', currentPassword: STRONG_PASSWORD });
        expect(resetRes.status).toBe(204);
      } finally {
        spy.mockRestore();
      }

      const s2 = await reLoginAfterReset(s);
      const res = await push(t, s2, [makeMutation(s2, { payload: encryptedPayload() })]);
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('PUSH_QUOTA_EXCEEDED');
    });
  });

  describe('daily push-quota — idempotent replay is free', () => {
    it('does not charge budget twice for a replayed (same-mutationId) push', async () => {
      const s = await loginAsFreshUser(t);
      const mutation = makeMutation(s, { payload: encryptedPayload() });

      const first = await push(t, s, [mutation]);
      expect(first.status).toBe(201);

      const repo = t.module.get(WorkspaceMetaRepository);
      const afterFirst = await repo.find(s.householdId);
      expect(afterFirst?.dailyMutationCount).toBe(1);

      const replay = await push(t, s, [mutation]);
      expect(replay.status).toBe(201);

      const afterReplay = await repo.find(s.householdId);
      expect(afterReplay?.dailyMutationCount).toBe(1);
    });
  });

  describe('mutations-per-push cap', () => {
    const batch = (s: Session, n: number): PushMutation[] =>
      Array.from({ length: n }, () => makeMutation(s, { payload: encryptedPayload() }));

    it('accepts a push at the cap', async () => {
      const s = await loginAsFreshUser(t);
      const res = await push(t, s, batch(s, MAX_PUSH_MUTATIONS));
      expect(res.status).toBe(201);
      expect(res.body.applied).toHaveLength(MAX_PUSH_MUTATIONS);
    });

    it('rejects a push one over the cap with 400, writing nothing', async () => {
      const s = await loginAsFreshUser(t);
      const before = await countMutationLogRows(t, s.householdId);
      const res = await push(t, s, batch(s, MAX_PUSH_MUTATIONS + 1));
      expect(res.status).toBe(400);
      expect(await countMutationLogRows(t, s.householdId)).toBe(before);
    });
  });

  describe('timestamp bound — asymmetric future/past window', () => {
    it('rejects a far-future timestamp with 400, writes nothing, and leaves pull/bootstrap healthy', async () => {
      const s = await loginAsFreshUser(t);
      const before = await countMutationLogRows(t, s.householdId);
      const res = await push(t, s, [
        makeMutation(s, {
          payload: encryptedPayload(),
          timestamp: Date.now() + TIMESTAMP_MAX_FUTURE_SKEW_MS + 60_000,
        }),
      ]);
      expect(res.status).toBe(400);
      // A distinct code from the generic BAD_REQUEST: a clock-skewed device is recoverable, and the client (SyncContext.tsx) relies on this code not to park the batch as permanently unsendable.
      expect(res.body.error.code).toBe('TIMESTAMP_OUT_OF_SERVER_WINDOW');
      expect(await countMutationLogRows(t, s.householdId)).toBe(before);

      // No absurd-timestamp row ever reached MutationLog, so pull and bootstrap stay healthy (never a 500 from `new Date(...).toISOString()`).
      const pullRes = await request(t.app.getHttpServer())
        .get('/api/v1/sync/pull?since=0')
        .set('Authorization', `Bearer ${s.accessToken}`);
      expect(pullRes.status).toBe(200);
      const bootstrapRes = await request(t.app.getHttpServer())
        .get('/api/v1/sync/bootstrap?force=false')
        .set('Authorization', `Bearer ${s.accessToken}`);
      expect(bootstrapRes.status).toBe(200);
    });

    it('accepts a timestamp from a plausibly long offline period', async () => {
      const s = await loginAsFreshUser(t);
      const res = await push(t, s, [
        makeMutation(s, {
          payload: encryptedPayload(),
          timestamp: Date.now() - Math.floor(TIMESTAMP_MAX_PAST_WINDOW_MS / 2),
        }),
      ]);
      expect(res.status).toBe(201);
    });

    it('rejects a timestamp beyond the past window', async () => {
      const s = await loginAsFreshUser(t);
      const before = await countMutationLogRows(t, s.householdId);
      const res = await push(t, s, [
        makeMutation(s, {
          payload: encryptedPayload(),
          timestamp: Date.now() - TIMESTAMP_MAX_PAST_WINDOW_MS - 60_000,
        }),
      ]);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TIMESTAMP_OUT_OF_SERVER_WINDOW');
      expect(await countMutationLogRows(t, s.householdId)).toBe(before);
    });
  });

  describe('schemaVersion ceiling', () => {
    it('accepts schemaVersion at the ceiling', async () => {
      const s = await loginAsFreshUser(t);
      const res = await push(t, s, [
        makeMutation(s, { payload: encryptedPayload(), schemaVersion: SCHEMA_VERSION_CEILING }),
      ]);
      expect(res.status).toBe(201);
    });

    it('rejects schemaVersion above the ceiling with 400, writing nothing', async () => {
      const s = await loginAsFreshUser(t);
      const before = await countMutationLogRows(t, s.householdId);
      const res = await push(t, s, [
        makeMutation(s, {
          payload: encryptedPayload(),
          schemaVersion: SCHEMA_VERSION_CEILING + 1,
        }),
      ]);
      expect(res.status).toBe(400);
      // A distinct code from the generic BAD_REQUEST: this one cannot clear without a newer app build, so the client (SyncContext.tsx) parks it as permanently unsendable.
      expect(res.body.error.code).toBe('SCHEMA_VERSION_TOO_NEW');
      expect(await countMutationLogRows(t, s.householdId)).toBe(before);
    });
  });

  describe('freshness-counter step bound', () => {
    it('rejects a counter far above the stored head, writing nothing', async () => {
      const s = await loginAsFreshUser(t);
      const seed = await push(t, s, [makeMutation(s, { payload: encryptedPayload() })], {
        freshnessCounter: 1,
        cursorTag: VALID_CURSOR_TAG,
      });
      expect(seed.status).toBe(201);

      const before = await countMutationLogRows(t, s.householdId);
      const res = await push(
        t,
        s,
        [makeMutation(s, { payload: encryptedPayload() })],
        { freshnessCounter: 1 + FRESHNESS_COUNTER_MAX_STEP + 1, cursorTag: VALID_CURSOR_TAG },
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('FRESHNESS_COUNTER_TOO_FAR_AHEAD');
      expect(await countMutationLogRows(t, s.householdId)).toBe(before);
    });

    it('accepts a large counter for a household with no stored head (trust-on-first-use)', async () => {
      const s = await loginAsFreshUser(t);
      const res = await push(t, s, [makeMutation(s, { payload: encryptedPayload() })], {
        freshnessCounter: 500_000,
        cursorTag: VALID_CURSOR_TAG,
      });
      expect(res.status).toBe(201);
    });

    it('still stores and echoes a normal increment', async () => {
      const s = await loginAsFreshUser(t);
      const res = await push(t, s, [makeMutation(s, { payload: encryptedPayload() })], {
        freshnessCounter: 1,
        cursorTag: VALID_CURSOR_TAG,
      });
      expect(res.status).toBe(201);
      expect(res.body.freshnessHead).toEqual({ freshnessCounter: 1, cursorTag: VALID_CURSOR_TAG });
    });
  });

  describe('strict encrypted-envelope guard — unknown key at the push boundary', () => {
    it('rejects an otherwise-valid envelope carrying one extra key', async () => {
      const s = await loginAsFreshUser(t);
      const before = await countMutationLogRows(t, s.householdId);
      const res = await push(t, s, [
        makeMutation(s, { payload: { ...encryptedPayload(), name: 'plaintext-leak' } }),
      ]);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ENCRYPTION_REQUIRED');
      expect(await countMutationLogRows(t, s.householdId)).toBe(before);
    });
  });
});
