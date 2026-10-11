/**
 * Focused integration tests for push-boundary validation. Kept separate from sync.spec.ts so
 * that 435-line file does not grow further past the shape-limit guideline.
 *
 * Each case asserts the observable contract (HTTP status + error code +
 * per-mutation outcome) AND that no DynamoDB row was written on a
 * pre-flight rejection — proving the rejection fires before any
 * TransactWriteItems is issued.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  bootstrapTestApp,
  freshDeviceId,
  makeMutation,
  signupVerifyLogin as loginAsFreshUser,
  type PushMutation,
  type Session,
  type TestApp,
} from './test-helpers.js';
import { IdempotencyKeyRepository } from '../dynamo/idempotency-key.repository.js';

/**
 * A strict encrypted-envelope payload. Every
 * `POST /sync/push` requires an encrypted payload + freshnessHead, so the
 * validation cases below that exercise post-guard logic carry both. Mirrors
 * `sync.spec.ts`'s `encryptedPayload()`.
 */
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
 * A valid `cursorTag`: exactly 43 base64url characters (the wire form of a
 * 32-byte HMAC, no padding). The sync controller strictly validates this
 * shape, so every push fixture must
 * carry a real 43-char tag rather than a short placeholder.
 */
const VALID_CURSOR_TAG = 'a'.repeat(43);

/** The default freshnessHead an encrypted Strategy-A push carries. */
const TEST_FRESHNESS_HEAD = { freshnessCounter: 1, cursorTag: VALID_CURSOR_TAG };

/**
 * Push with an arbitrary extra body field (e.g. the optional
 * `freshnessHead`) merged in. The single push helper for this file —
 * every push must carry an encrypted payload + freshnessHead to clear the
 * unconditional encryption guard before the validation logic under test runs.
 */
async function pushWithBody(
  t: TestApp,
  s: Session,
  mutations: PushMutation[],
  extra: Record<string, unknown>,
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
      ...extra,
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

describe('sync push validation', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  describe('aggregateType validation', () => {
    it('rejects unknown aggregateType with 400 and writes no DynamoDB rows', async () => {
      const s = await loginAsFreshUser(t);
      const before = await countMutationLogRows(t, s.householdId);
      const res = await pushWithBody(
        t,
        s,
        [makeMutation(s, { aggregateType: 'definitelyNotARealAggregateType', payload: encryptedPayload() })],
        { freshnessHead: TEST_FRESHNESS_HEAD },
      );
      // The DTO layer rejects the unknown aggregateType (400) before the
      // encryption guard would 403; the encrypted payload keeps the assertion
      // pinned on the aggregateType failure.
      expect(res.status).toBe(400);
      const after = await countMutationLogRows(t, s.householdId);
      expect(after).toBe(before);
    });

    it('accepts every active aggregate type at create v=0', async () => {
      const s = await loginAsFreshUser(t);
      // Single happy-path probe: 'account' (cheap to spot-check; full
      // matrix lives in sync.spec.ts).
      const res = await pushWithBody(
        t,
        s,
        [makeMutation(s, { aggregateType: 'account', payload: encryptedPayload() })],
        { freshnessHead: TEST_FRESHNESS_HEAD },
      );
      expect(res.status).toBe(201);
      expect(res.body.applied).toHaveLength(1);
    });
  });

  describe('create requires version === 0', () => {
    it('rejects create with version 5 as 400 and writes no rows', async () => {
      const s = await loginAsFreshUser(t);
      const before = await countMutationLogRows(t, s.householdId);
      const res = await pushWithBody(
        t,
        s,
        [makeMutation(s, { operation: 'create', version: 5, payload: encryptedPayload() })],
        { freshnessHead: TEST_FRESHNESS_HEAD },
      );
      // DTO rejects version≠0 on create (400) before the encryption guard.
      expect(res.status).toBe(400);
      const after = await countMutationLogRows(t, s.householdId);
      expect(after).toBe(before);
    });
  });

  describe('inner deviceId provenance', () => {
    it('rejects mismatched inner deviceId with 403 INNER_DEVICE_MISMATCH and writes no rows', async () => {
      const s = await loginAsFreshUser(t);
      const before = await countMutationLogRows(t, s.householdId);
      const rogueDeviceId = freshDeviceId();
      const res = await pushWithBody(
        t,
        s,
        [makeMutation(s, { deviceId: rogueDeviceId, payload: encryptedPayload() })],
        { freshnessHead: TEST_FRESHNESS_HEAD },
      );
      // The encryption guard passes (encrypted payload + freshnessHead); the
      // inner-deviceId check fires after it at the service layer.
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INNER_DEVICE_MISMATCH');
      expect(res.body.error.details).toMatchObject({
        expected: s.deviceId,
        got: rogueDeviceId,
      });
      const after = await countMutationLogRows(t, s.householdId);
      expect(after).toBe(before);
    });

    it('fails the whole batch on the first mismatch (no partial write)', async () => {
      const s = await loginAsFreshUser(t);
      const before = await countMutationLogRows(t, s.householdId);
      const good = makeMutation(s, { payload: encryptedPayload() }); // deviceId = s.deviceId
      const bad = makeMutation(s, { deviceId: freshDeviceId(), payload: encryptedPayload() });
      const res = await pushWithBody(t, s, [good, bad], { freshnessHead: TEST_FRESHNESS_HEAD });
      expect(res.status).toBe(403);
      const after = await countMutationLogRows(t, s.householdId);
      // Whole batch rejected before any TransactWriteItems runs.
      expect(after).toBe(before);
    });
  });

  describe('operation-aware preconditions', () => {
    it('rejects update against missing aggregate with per-mutation NOT_FOUND', async () => {
      const s = await loginAsFreshUser(t);
      const res = await pushWithBody(
        t,
        s,
        [
          makeMutation(s, {
            operation: 'update',
            version: 1,
            payload: encryptedPayload(),
          }),
        ],
        { freshnessHead: TEST_FRESHNESS_HEAD },
      );
      // Encryption guard passes; NOT_FOUND fires at the apply layer.
      expect(res.status).toBe(201);
      expect(res.body.applied).toHaveLength(0);
      expect(res.body.rejected).toHaveLength(1);
      expect(res.body.rejected[0].reason).toBe('NOT_FOUND');
      expect(res.body.rejected[0].currentVersion).toBe(0);
    });

    it('rejects delete against missing aggregate with per-mutation NOT_FOUND', async () => {
      const s = await loginAsFreshUser(t);
      const res = await pushWithBody(
        t,
        s,
        [
          makeMutation(s, {
            operation: 'delete',
            version: 3,
            payload: encryptedPayload(),
          }),
        ],
        { freshnessHead: TEST_FRESHNESS_HEAD },
      );
      expect(res.status).toBe(201);
      expect(res.body.applied).toHaveLength(0);
      expect(res.body.rejected).toHaveLength(1);
      expect(res.body.rejected[0].reason).toBe('NOT_FOUND');
    });

    it('positive regression: create → update → delete on the same aggregate', async () => {
      const s = await loginAsFreshUser(t);
      const aggregateId = randomUUID();

      const create = await pushWithBody(
        t,
        s,
        [makeMutation(s, { aggregateId, operation: 'create', version: 0, payload: encryptedPayload() })],
        { freshnessHead: TEST_FRESHNESS_HEAD },
      );
      expect(create.status).toBe(201);
      expect(create.body.applied).toHaveLength(1);
      expect(create.body.applied[0].newVersion).toBe(1);

      const update = await pushWithBody(
        t,
        s,
        [
          makeMutation(s, {
            aggregateId,
            operation: 'update',
            version: 1,
            payload: encryptedPayload(),
          }),
        ],
        { freshnessHead: TEST_FRESHNESS_HEAD },
      );
      expect(update.status).toBe(201);
      expect(update.body.applied).toHaveLength(1);
      expect(update.body.applied[0].newVersion).toBe(2);

      const del = await pushWithBody(
        t,
        s,
        [makeMutation(s, { aggregateId, operation: 'delete', version: 2, payload: encryptedPayload() })],
        { freshnessHead: TEST_FRESHNESS_HEAD },
      );
      expect(del.status).toBe(201);
      expect(del.body.applied).toHaveLength(1);
      expect(del.body.applied[0].newVersion).toBe(3);
    });
  });

  describe('idempotency-key race replay', () => {
    it('two parallel pushes with the same mutationId commit exactly once; the loser replays the cached response', async () => {
      const s = await loginAsFreshUser(t);
      const repo = t.module.get(IdempotencyKeyRepository);

      // Force-null the first lookup call AND hold it past B's commit.
      // This is what actually exercises the apply-path replay branch:
      // if the spy returned the real (post-B) cached row, A would
      // short-circuit at the pre-lookup hit and never reach applyOne's
      // TransactWriteCommand. Returning null routes A through the
      // conditional IdempotencyKey Put, which cancels (B's row already
      // there), and handleCancel runs replayIdempotencyRow.
      let firstCallHeld = false;
      let resolveHeld!: () => void;
      const held = new Promise<void>((resolve) => {
        resolveHeld = resolve;
      });
      const origLookup = repo.lookup.bind(repo);
      const spy = jest
        .spyOn(repo, 'lookup')
        .mockImplementation(async (key: string) => {
          if (!firstCallHeld) {
            firstCallHeld = true;
            await held;
            return null; // force A past pre-lookup → into applyOne
          }
          return origLookup(key);
        });

      const sharedMutationId = randomUUID();
      const mutationA: PushMutation = makeMutation(s, {
        id: sharedMutationId,
        aggregateId: randomUUID(),
        payload: encryptedPayload(),
      });
      const mutationB: PushMutation = makeMutation(s, {
        id: sharedMutationId,
        aggregateId: randomUUID(),
        payload: encryptedPayload(),
      });

      // Start A first → its lookup call is held.
      const pushA = pushWithBody(t, s, [mutationA], { freshnessHead: TEST_FRESHNESS_HEAD });
      // Yield to the event loop so A's controller actually issues the
      // lookup before B starts.
      await new Promise((r) => setImmediate(r));
      // B runs to completion.
      const bRes = await pushWithBody(t, s, [mutationB], { freshnessHead: TEST_FRESHNESS_HEAD });
      expect(bRes.status).toBe(201);
      expect(bRes.body.applied).toHaveLength(1);
      expect(bRes.body.applied[0].aggregateId).toBe(mutationB.aggregateId);

      // Release A's lookup. lookup returns null (forced) → A enters
      // applyOne → conditional IdempotencyKey Put cancels (B's row is
      // there) → handleCancel classifies as 'idempotency' →
      // replayIdempotencyRow re-queries via the same spy (which now
      // calls origLookup since firstCallHeld is true) → returns B's
      // cached applied row.
      resolveHeld();
      const aRes = await pushA;
      expect(aRes.status).toBe(201);
      expect(aRes.body.applied).toHaveLength(1);
      // Transparent replay: A's response is B's cached aggregateId, not
      // A's own — duplicate mutationId contract holds.
      expect(aRes.body.applied[0].aggregateId).toBe(mutationB.aggregateId);

      spy.mockRestore();
    });
  });

  describe('freshnessHead strict validation', () => {
    // The sync controller performs 100% of freshness-head validation
    // manually (FreshnessHeadDto carries no class-validator decorators, and
    // PushDto.freshnessHead is `unknown` with @ValidateNested() removed), so the
    // global ValidationPipe can never pre-empt the FRESHNESS_HEAD_INVALID
    // discriminator. EVERY malformed-head shape — bad bounds, wrong field type,
    // a missing field, AND a bare non-object primitive — must return the exact
    // `400 FRESHNESS_HEAD_INVALID` code (not the pipe's generic default), and no
    // mutation may be committed (the whole push fails).

    it('accepts a push with a well-formed 43-char freshnessHead', async () => {
      const s = await loginAsFreshUser(t);
      const res = await pushWithBody(t, s, [makeMutation(s, { payload: encryptedPayload() })], {
        freshnessHead: { freshnessCounter: 1, cursorTag: VALID_CURSOR_TAG },
      });
      expect(res.status).toBe(201);
      expect(res.body.applied).toHaveLength(1);
    });

    /**
     * Every malformed freshnessHead value + the human label. `head` is the raw
     * value placed at the `freshnessHead` key — including bare primitives, which
     * must reach the controller untouched by the pipe.
     */
    const invalidCases: ReadonlyArray<{ label: string; head: unknown }> = [
      { label: 'a non-integer (string) freshnessCounter', head: { freshnessCounter: 'nope', cursorTag: VALID_CURSOR_TAG } },
      { label: 'a fractional freshnessCounter', head: { freshnessCounter: 1.5, cursorTag: VALID_CURSOR_TAG } },
      { label: 'a zero freshnessCounter', head: { freshnessCounter: 0, cursorTag: VALID_CURSOR_TAG } },
      { label: 'a negative freshnessCounter', head: { freshnessCounter: -1, cursorTag: VALID_CURSOR_TAG } },
      { label: 'an unsafe-integer freshnessCounter', head: { freshnessCounter: Number.MAX_SAFE_INTEGER + 2, cursorTag: VALID_CURSOR_TAG } },
      { label: 'an empty cursorTag', head: { freshnessCounter: 1, cursorTag: '' } },
      { label: 'a 42-char cursorTag', head: { freshnessCounter: 1, cursorTag: 'a'.repeat(42) } },
      { label: 'a 44-char cursorTag', head: { freshnessCounter: 1, cursorTag: 'a'.repeat(44) } },
      { label: 'a base64 (non-base64url) padded cursorTag', head: { freshnessCounter: 1, cursorTag: `${'a'.repeat(42)}=` } },
      { label: 'a non-base64url-character cursorTag', head: { freshnessCounter: 1, cursorTag: `${'a'.repeat(42)}!` } },
      { label: 'a non-string cursorTag', head: { freshnessCounter: 1, cursorTag: 42 } },
      { label: 'a missing cursorTag field', head: { freshnessCounter: 1 } },
      { label: 'a missing freshnessCounter field', head: { cursorTag: VALID_CURSOR_TAG } },
      { label: 'a bare string primitive', head: 'not-an-object' },
      { label: 'a bare number primitive', head: 42 },
      { label: 'a null value', head: null },
      { label: 'an array value', head: [1, VALID_CURSOR_TAG] },
    ];

    for (const { label, head } of invalidCases) {
      it(`rejects ${label} with 400 FRESHNESS_HEAD_INVALID and commits nothing`, async () => {
        const s = await loginAsFreshUser(t);
        const res = await pushWithBody(t, s, [makeMutation(s, { payload: encryptedPayload() })], {
          freshnessHead: head,
        });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('FRESHNESS_HEAD_INVALID');
        expect(res.body.applied).toBeUndefined();

        // Nothing was committed: the mutation-log table has no row for this
        // household. Proves the head is validated before any TransactWriteItems.
        expect(await countMutationLogRows(t, s.householdId)).toBe(0);
      });
    }
  });
});
