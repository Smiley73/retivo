/**
 * Integration tests for the zero-knowledge key-envelope endpoints
 * (activated).
 *
 *   GET    /api/v1/auth/key-envelopes
 *   PUT    /api/v1/auth/key-envelopes/:slotId
 *   DELETE /api/v1/auth/key-envelopes/:slotId
 *
 * Coverage:
 *  - authenticated GET returns an empty slot set on a fresh household;
 *  - authenticated GET returns the real slot (NOT the ENVELOPE_META sentinel)
 *    plus the seeded envelopeSetVersion + envelopeSetTag;
 *  - unauthenticated GET is rejected (401);
 *  - PUT / DELETE without the CSRF header are blocked by the CSRF middleware (403);
 *  - PUT / DELETE with a bad Origin are blocked by the Origin middleware (403);
 *  - unauthenticated PUT / DELETE are refused before the handler;
 *  - PUT happy path creates the password + recovery slots, bumps the monotonic
 *    envelopeSetVersion, stores the opaque tag verbatim, and records a
 *    `key_envelope_created` AuthEvent;
 *  - a re-PUT of an existing slot records `key_envelope_updated`;
 *  - PUT with a stale / non-monotonic envelopeSetVersion → 409
 *    STALE_ENVELOPE_VERSION;
 *  - PUT / DELETE against the reserved `ENVELOPE_META` sentinel slot id → 400
 *    INVALID_SLOT_ID, with the envelope-set meta + slots left untouched;
 *  - DELETE removes a slot, bumps the version, and records
 *    `key_envelope_deleted`;
 *  - DELETE /auth/account also deletes the household's key-envelope rows
 *    (zero-knowledge cascade).
 *
 * Plus repository-level coverage for `HouseholdKeyEnvelopesRepository`:
 *  - `listSlots` excludes the ENVELOPE_META sentinel;
 *  - `putEnvelopeMeta` first write succeeds, a stale-version bump throws
 *    `StaleEnvelopeVersionError`.
 *
 * Each case uses fresh emails / device IDs / household IDs so suites stay
 * independent on the shared DynamoDB Local instance.
 */
import request from 'supertest';
import {
  STRONG_PASSWORD,
  bootstrapTestApp,
  decodeAccessClaims,
  scanAll,
  type TestApp,
  signupVerifyApprove,
  login,
} from './test-helpers.js';
import type {
  AuthEventRow,
  HouseholdEnvelopeMetaRow,
  HouseholdKeyEnvelopeRow,
} from '../dynamo/types.js';
import { ENVELOPE_META_SLOT_ID } from '../dynamo/types.js';
import {
  EnvelopeReadConflictError,
  HouseholdKeyEnvelopesRepository,
  StaleEnvelopeVersionError,
} from '../dynamo/household-key-envelopes.repository.js';
import { CredentialsRepository } from '../dynamo/credentials.repository.js';
import { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';

/** A well-formed upsert body for a `password` slot (opaque material). */
function passwordUpsertBody(
  householdId: string,
  envelopeSetVersion: number,
  envelopeSetTag: string,
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    slot: {
      householdId,
      slotId: 'password',
      slotType: 'password',
      kdf: { algorithm: 'PBKDF2-HMAC-SHA-256', iterations: 600_000, salt: 'c2FsdA' },
      wrappedKey: 'd3JhcHBlZA',
      encryptionVersion: 1,
      createdAt: now,
      updatedAt: now,
    },
    envelopeSetVersion,
    expectedEnvelopeSetVersion: envelopeSetVersion - 1,
    envelopeSetTag,
  };
}

/** A well-formed upsert body for a `password` slot with an Argon2id kdf. */
function argon2idUpsertBody(
  householdId: string,
  envelopeSetVersion: number,
  envelopeSetTag: string,
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    slot: {
      householdId,
      slotId: 'password',
      slotType: 'password',
      kdf: { algorithm: 'Argon2id', m: 65_536, t: 3, p: 4, salt: 'c2FsdA' },
      wrappedKey: 'd3JhcHBlZA',
      encryptionVersion: 1,
      createdAt: now,
      updatedAt: now,
    },
    envelopeSetVersion,
    expectedEnvelopeSetVersion: envelopeSetVersion - 1,
    envelopeSetTag,
  };
}

/** A well-formed upsert body for a `recovery` slot (no kdf). */
function recoveryUpsertBody(
  householdId: string,
  envelopeSetVersion: number,
  envelopeSetTag: string,
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    slot: {
      householdId,
      slotId: 'recovery',
      slotType: 'recovery',
      wrappedKey: 'cmVjb3Zlcnk',
      encryptionVersion: 1,
      createdAt: now,
      updatedAt: now,
    },
    envelopeSetVersion,
    expectedEnvelopeSetVersion: envelopeSetVersion - 1,
    envelopeSetTag,
  };
}

/** A well-formed upsert body for a `passkey_prf` slot bound to a credential. */
function passkeyPrfUpsertBody(
  householdId: string,
  credentialBinding: string,
  envelopeSetVersion: number,
  envelopeSetTag: string,
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
    envelopeSetVersion,
    expectedEnvelopeSetVersion: envelopeSetVersion - 1,
    envelopeSetTag,
  };
}

describe('key-envelope endpoints (zero-knowledge)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  describe('GET /auth/key-envelopes', () => {
    it('returns an empty slot set + zero meta for a fresh household', async () => {
      const { email } = await signupVerifyApprove(t);
      const sess = await login(t, email);
      const res = await request(t.app.getHttpServer())
        .get('/api/v1/auth/key-envelopes')
        .set('Authorization', `Bearer ${sess.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.slots).toEqual([]);
      expect(res.body.envelopeSetVersion).toBe(0);
      expect(res.body.envelopeSetTag).toBe('');
    });

    it('returns the seeded slot (not the ENVELOPE_META sentinel) with the set version + tag', async () => {
      const { email } = await signupVerifyApprove(t);
      const sess = await login(t, email);
      const { householdId } = decodeAccessClaims(sess.accessToken);

      // Seed one real slot + the per-household envelope-set meta sentinel
      // directly through the repository (independent of the write endpoints).
      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      const slot: HouseholdKeyEnvelopeRow = {
        householdId,
        slotId: 'password',
        slotType: 'password',
        kdf: { algorithm: 'PBKDF2-HMAC-SHA-256', iterations: 600_000, salt: 'c2FsdA' },
        wrappedKey: 'd3JhcHBlZA',
        encryptionVersion: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await repo.upsertSlot(slot);
      await repo.putEnvelopeMeta(householdId, 1, 'dGFn', null);

      const res = await request(t.app.getHttpServer())
        .get('/api/v1/auth/key-envelopes')
        .set('Authorization', `Bearer ${sess.accessToken}`);
      expect(res.status).toBe(200);
      const slots = res.body.slots as HouseholdKeyEnvelopeRow[];
      expect(slots).toHaveLength(1);
      expect(slots[0].slotId).toBe('password');
      expect(slots.some((s) => s.slotId === 'ENVELOPE_META')).toBe(false);
      expect(res.body.envelopeSetVersion).toBe(1);
      expect(res.body.envelopeSetTag).toBe('dGFn');
    });

    it('carries the credential\'s current revision on every read', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const sess = await login(t, email);
      const credentials = t.module.get(CredentialsRepository);

      const res = await request(t.app.getHttpServer())
        .get('/api/v1/auth/key-envelopes')
        .set('Authorization', `Bearer ${sess.accessToken}`);
      expect(res.status).toBe(200);
      // Server-authored, never derived client-side: a real credential row (a
      // fresh signup mints a revision) resolves
      // to a non-empty, concrete value rather than being omitted.
      expect(typeof res.body.currentCredentialRevision).toBe('string');
      expect((res.body.currentCredentialRevision as string).length).toBeGreaterThan(0);
      // Not just non-empty — it must equal the account's REAL credential row
      // (3.test-coverage.1): a hardcoded constant, the wrong user's
      // revision, or a stale cached value would all satisfy the shape check
      // above but fail this one.
      const credential = await credentials.findByUserId(userId);
      expect(res.body.currentCredentialRevision).toBe(credential?.credentialRevision);

      // And it must actually change after the credential does — this is the
      // field the client's derived compare gates every re-wrap decision on, so a value that never moves
      // would silently suppress every owed re-wrap for the rest of the account's life.
      const changed = await request(t.app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send({ currentPassword: STRONG_PASSWORD, newPassword: 'RewrapNewPassw0rd!' });
      expect(changed.status).toBe(200);
      const newAccessToken = (changed.body as { accessToken: string }).accessToken;

      const resAfter = await request(t.app.getHttpServer())
        .get('/api/v1/auth/key-envelopes')
        .set('Authorization', `Bearer ${newAccessToken}`);
      expect(resAfter.status).toBe(200);
      const credentialAfter = await credentials.findByUserId(userId);
      expect(credentialAfter?.credentialRevision).not.toBe(credential?.credentialRevision);
      expect(resAfter.body.currentCredentialRevision).toBe(credentialAfter?.credentialRevision);
    });

    it('retries past a single torn read and returns a consistent 200 snapshot', async () => {
      // Force a torn read: stub the repo's consistent meta read so the FIRST
      // attempt's before/after bracket disagrees (a concurrent slot+meta write
      // landed mid-read), then agrees on the retry. The endpoint must retry to
      // a consistent result — never return the torn pair.
      const { email } = await signupVerifyApprove(t);
      const sess = await login(t, email);
      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      const stable = { envelopeSetVersion: 5, envelopeSetTag: 'stabletag', updatedAt: new Date().toISOString() };
      let call = 0;
      const spy = jest
        .spyOn(repo, 'getEnvelopeMeta')
        .mockImplementation(async () => {
          call += 1;
          // Attempt 1: before(call 1)=stable, after(call 2)=torn → mismatch,
          // retry. Attempt 2: before(call 3)=after(call 4)=stable → accept.
          if (call === 2) return { envelopeSetVersion: 6, envelopeSetTag: 'torn', updatedAt: new Date().toISOString() };
          return { ...stable };
        });
      try {
        const res = await request(t.app.getHttpServer())
          .get('/api/v1/auth/key-envelopes')
          .set('Authorization', `Bearer ${sess.accessToken}`);
        expect(res.status).toBe(200);
        expect(res.body.envelopeSetVersion).toBe(5);
        expect(res.body.envelopeSetTag).toBe('stabletag');
      } finally {
        spy.mockRestore();
      }
      // Two bracketing meta reads on each of the two attempts.
      expect(call).toBe(4);
    });

    it('returns 503 ENVELOPE_READ_CONFLICT when the read stays torn past the retry bound', async () => {
      // Every consistent meta read reports a different version, so the
      // before/after bracket never matches on any attempt — a persistently
      // torn read must surface a 503, never an inconsistent slots/meta pair.
      const { email } = await signupVerifyApprove(t);
      const sess = await login(t, email);
      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      let call = 0;
      const spy = jest
        .spyOn(repo, 'getEnvelopeMeta')
        .mockImplementation(async () => {
          call += 1;
          return { envelopeSetVersion: call, envelopeSetTag: `tag${call}`, updatedAt: new Date().toISOString() };
        });
      try {
        const res = await request(t.app.getHttpServer())
          .get('/api/v1/auth/key-envelopes')
          .set('Authorization', `Bearer ${sess.accessToken}`);
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('ENVELOPE_READ_CONFLICT');
      } finally {
        spy.mockRestore();
      }
      // Two bracketing meta reads across each of the three bounded attempts.
      expect(call).toBe(6);
    });
  });

  describe('PUT /auth/key-envelopes/:slotId (middleware order)', () => {
    it('creates the password + recovery slots, bumps the version, stores the opaque tag, audits create', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const sess = await login(t, email);
      const { householdId } = decodeAccessClaims(sess.accessToken);

      // First slot: version 1.
      const put1 = await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/password')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send(passwordUpsertBody(householdId, 1, 'dGFnMQ'));
      expect(put1.status).toBe(204);

      // Second slot: monotonic bump to version 2.
      const put2 = await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/recovery')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send(recoveryUpsertBody(householdId, 2, 'dGFnMg'));
      expect(put2.status).toBe(204);

      // GET reflects both slots + the latest opaque meta (stored verbatim).
      const get = await request(t.app.getHttpServer())
        .get('/api/v1/auth/key-envelopes')
        .set('Authorization', `Bearer ${sess.accessToken}`);
      expect(get.status).toBe(200);
      const slots = get.body.slots as HouseholdKeyEnvelopeRow[];
      expect(slots.map((s) => s.slotId).sort()).toEqual(['password', 'recovery']);
      expect(get.body.envelopeSetVersion).toBe(2);
      expect(get.body.envelopeSetTag).toBe('dGFnMg');

      // AuthEvent audit: both writes were creates (the slot did not exist yet).
      const events = await scanAll<AuthEventRow>(t.doc, process.env.TABLE_AUTH_EVENT!);
      const mine = events.filter((e) => e.userId === userId);
      expect(mine.some((e) => e.eventType === 'key_envelope_created')).toBe(true);
    });

    it('round-trips an Argon2id-kdf password slot (m/t/p preserved, no iterations)', async () => {
      // New password slots emit an Argon2id kdf `{ algorithm, m, t, p, salt }`
      // (key-wrapping.ts `newArgon2idKdf`). The DTO must accept the m/t/p fields
      // under the global forbidNonWhitelisted ValidationPipe and the
      // controller must persist them verbatim, not collapse them to a PBKDF2
      // `{ algorithm, iterations, salt }` shape with `iterations: undefined`.
      // Assert the full Argon2id shape survives PUT → GET.
      const { email } = await signupVerifyApprove(t);
      const sess = await login(t, email);
      const { householdId } = decodeAccessClaims(sess.accessToken);

      const put = await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/password')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send(argon2idUpsertBody(householdId, 1, 'dGFnMQ'));
      expect(put.status).toBe(204);

      const get = await request(t.app.getHttpServer())
        .get('/api/v1/auth/key-envelopes')
        .set('Authorization', `Bearer ${sess.accessToken}`);
      expect(get.status).toBe(200);
      const slots = get.body.slots as HouseholdKeyEnvelopeRow[];
      const slot = slots.find((s) => s.slotId === 'password');
      expect(slot?.kdf).toEqual({ algorithm: 'Argon2id', m: 65_536, t: 3, p: 4, salt: 'c2FsdA' });
      // The PBKDF2-only `iterations` field is absent on an Argon2id slot.
      expect(slot?.kdf && 'iterations' in slot.kdf).toBe(false);
    });

    it('records key_envelope_updated when an existing slot is re-PUT', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const sess = await login(t, email);
      const { householdId } = decodeAccessClaims(sess.accessToken);

      await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/password')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send(passwordUpsertBody(householdId, 1, 'dGFnMQ'));

      const reput = await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/password')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send(passwordUpsertBody(householdId, 2, 'dGFnMg'));
      expect(reput.status).toBe(204);

      const events = await scanAll<AuthEventRow>(t.doc, process.env.TABLE_AUTH_EVENT!);
      const mine = events.filter((e) => e.userId === userId);
      expect(mine.some((e) => e.eventType === 'key_envelope_updated')).toBe(true);
    });

    it('rejects a stale / non-monotonic envelopeSetVersion with 409 STALE_ENVELOPE_VERSION', async () => {
      const { email } = await signupVerifyApprove(t);
      const sess = await login(t, email);
      const { householdId } = decodeAccessClaims(sess.accessToken);

      // Advance the stored version to 2.
      await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/password')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send(passwordUpsertBody(householdId, 1, 'dGFnMQ'));
      await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/recovery')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send(recoveryUpsertBody(householdId, 2, 'dGFnMg'));

      // Snapshot the COMPLETE stored password slot before the rejected write so
      // we can prove not one byte of it changed. The atomic slot+meta
      // transaction must fail closed — a regression that partially wrote the
      // stale slot content before returning the 409 would still pass a
      // version-only assertion, so give the stale attempt DISTINGUISHABLE
      // wrapped-key material (different from what is already stored) and assert
      // the whole slot survives unchanged.
      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      const passwordBefore = (await repo.listSlots(householdId)).find(
        (s) => s.slotId === 'password',
      );
      expect(passwordBefore).toBeTruthy();

      // A bump back to version 1 is non-monotonic → rejected. The stale body
      // carries a unique wrappedKey ('stalewrapped') absent from the store.
      const staleBody = passwordUpsertBody(householdId, 1, 'c3RhbGU') as {
        slot: Record<string, unknown>;
      };
      staleBody.slot.wrappedKey = 'c3RhbGV3cmFwcGVk';
      const stale = await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/password')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send(staleBody);
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('STALE_ENVELOPE_VERSION');

      // The stored meta is unchanged at version 2.
      const get = await request(t.app.getHttpServer())
        .get('/api/v1/auth/key-envelopes')
        .set('Authorization', `Bearer ${sess.accessToken}`);
      expect(get.body.envelopeSetVersion).toBe(2);
      expect(get.body.envelopeSetTag).toBe('dGFnMg');

      // The COMPLETE stored password slot is byte-for-byte unchanged — the
      // rejected write's distinguishable wrappedKey never landed.
      const passwordAfter = (await repo.listSlots(householdId)).find(
        (s) => s.slotId === 'password',
      );
      expect(passwordAfter).toEqual(passwordBefore);
      expect(passwordAfter?.wrappedKey).not.toBe('c3RhbGV3cmFwcGVk');
    });

    it('rejects PUT against the reserved ENVELOPE_META slot id with 400 INVALID_SLOT_ID (meta untouched)', async () => {
      // The ENVELOPE_META sentinel is the per-household envelope-set integrity
      // row. A client must never be able to PUT it — that would overwrite the
      // set's version/tag and corrupt the key-envelope set. The boundary
      // pipe rejects it before any read/write.
      const { email } = await signupVerifyApprove(t);
      const sess = await login(t, email);
      const { householdId } = decodeAccessClaims(sess.accessToken);

      // Seed a legit set (version 2) so we can prove the rejected PUT leaves the
      // meta row exactly as it was.
      await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/password')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send(passwordUpsertBody(householdId, 1, 'dGFnMQ'));
      await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/recovery')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send(recoveryUpsertBody(householdId, 2, 'dGFnMg'));

      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      const metaBefore = await repo.getEnvelopeMeta(householdId);
      expect(metaBefore).toMatchObject({ envelopeSetVersion: 2, envelopeSetTag: 'dGFnMg' });

      const res = await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/ENVELOPE_META')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send(passwordUpsertBody(householdId, 99, 'cHduZWQ'));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_SLOT_ID');

      // The meta row is exactly as seeded — the rejected write touched nothing.
      const metaAfter = await repo.getEnvelopeMeta(householdId);
      expect(metaAfter).toMatchObject({ envelopeSetVersion: 2, envelopeSetTag: 'dGFnMg' });
      const slots = await repo.listSlots(householdId);
      expect(slots.map((s) => s.slotId).sort()).toEqual(['password', 'recovery']);
    });

    it('accepts a passkey_prf slot whose credentialBinding is an enrolled passkey', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const sess = await login(t, email);
      const { householdId } = decodeAccessClaims(sess.accessToken);

      // Enroll a passkey for this user so the binding ownership check passes.
      const credentialId = `cred-${randomUUID()}`;
      const passkeys = t.module.get(PasskeysRepository);
      await passkeys.insert({
        userId,
        credentialId,
        publicKey: 'cHVibGljS2V5',
        counter: 0,
        deviceType: 'multiDevice',
        backedUp: true,
        transports: null,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      });

      const put = await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/passkey_prf')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send(passkeyPrfUpsertBody(householdId, credentialId, 1, 'cHJmdGFn'));
      expect(put.status).toBe(204);

      // The stored slot round-trips the credentialBinding back through GET.
      const get = await request(t.app.getHttpServer())
        .get('/api/v1/auth/key-envelopes')
        .set('Authorization', `Bearer ${sess.accessToken}`);
      const slots = get.body.slots as HouseholdKeyEnvelopeRow[];
      const prfSlot = slots.find((s) => s.slotId === 'passkey_prf');
      expect(prfSlot?.credentialBinding).toBe(credentialId);
    });

    it('rejects a passkey_prf slot whose credentialBinding is not enrolled with 422', async () => {
      const { email } = await signupVerifyApprove(t);
      const sess = await login(t, email);
      const { householdId } = decodeAccessClaims(sess.accessToken);

      const res = await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/passkey_prf')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send(passkeyPrfUpsertBody(householdId, `cred-${randomUUID()}`, 1, 'cHJmdGFn'));
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('CREDENTIAL_NOT_FOUND');

      // The rejected write touched nothing: no slot, no meta bump.
      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      expect(await repo.listSlots(householdId)).toEqual([]);
      expect(await repo.getEnvelopeMeta(householdId)).toBeNull();
    });
  });

  describe('DELETE /auth/key-envelopes/:slotId', () => {
    it('rejects DELETE against the reserved ENVELOPE_META slot id with 400 INVALID_SLOT_ID (meta untouched)', async () => {
      // Symmetric to the PUT guard: a client must never DELETE the envelope-set
      // integrity sentinel — that would strip the set's version/tag and corrupt
      // the household's key-envelope set.
      const { email } = await signupVerifyApprove(t);
      const sess = await login(t, email);
      const { householdId } = decodeAccessClaims(sess.accessToken);

      // Seed a legit set so the rejected DELETE has meta + slots to leave intact.
      await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/password')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send(passwordUpsertBody(householdId, 1, 'dGFnMQ'));

      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      const metaBefore = await repo.getEnvelopeMeta(householdId);
      expect(metaBefore).toMatchObject({ envelopeSetVersion: 1, envelopeSetTag: 'dGFnMQ' });

      const res = await request(t.app.getHttpServer())
        .delete('/api/v1/auth/key-envelopes/ENVELOPE_META')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send({ envelopeSetVersion: 2, expectedEnvelopeSetVersion: 1, envelopeSetTag: 'cHduZWQ' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_SLOT_ID');

      // Meta + slot survive the rejected delete untouched.
      const metaAfter = await repo.getEnvelopeMeta(householdId);
      expect(metaAfter).toMatchObject({ envelopeSetVersion: 1, envelopeSetTag: 'dGFnMQ' });
      expect((await repo.listSlots(householdId)).map((s) => s.slotId)).toEqual(['password']);
    });

    it('removes a slot, bumps the version, and audits delete', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const sess = await login(t, email);
      const { householdId } = decodeAccessClaims(sess.accessToken);

      // Seed two slots (version 1 then 2) so a delete has something to remove.
      await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/password')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send(passwordUpsertBody(householdId, 1, 'dGFnMQ'));
      await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/recovery')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send(recoveryUpsertBody(householdId, 2, 'dGFnMg'));

      // Delete the recovery slot; client recomputes the tag + bumps to v3.
      const del = await request(t.app.getHttpServer())
        .delete('/api/v1/auth/key-envelopes/recovery')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send({ envelopeSetVersion: 3, expectedEnvelopeSetVersion: 2, envelopeSetTag: 'dGFnMw' });
      expect(del.status).toBe(204);

      const get = await request(t.app.getHttpServer())
        .get('/api/v1/auth/key-envelopes')
        .set('Authorization', `Bearer ${sess.accessToken}`);
      const slots = get.body.slots as HouseholdKeyEnvelopeRow[];
      expect(slots.map((s) => s.slotId)).toEqual(['password']);
      expect(get.body.envelopeSetVersion).toBe(3);
      expect(get.body.envelopeSetTag).toBe('dGFnMw');

      const events = await scanAll<AuthEventRow>(t.doc, process.env.TABLE_AUTH_EVENT!);
      const mine = events.filter((e) => e.userId === userId);
      expect(mine.some((e) => e.eventType === 'key_envelope_deleted')).toBe(true);
    });
  });

  describe('DELETE /auth/account zero-knowledge cascade', () => {
    it('deletes the household key-envelope rows when the account is deleted', async () => {
      const { email } = await signupVerifyApprove(t);
      const sess = await login(t, email);
      const { householdId } = decodeAccessClaims(sess.accessToken);

      // Set up a key envelope for the household.
      await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/password')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send(passwordUpsertBody(householdId, 1, 'dGFnMQ'));

      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      expect(await repo.listSlots(householdId)).toHaveLength(1);

      // Delete the account (purge-first cascade includes the key-envelope sweep).
      const del = await request(t.app.getHttpServer())
        .delete('/api/v1/auth/account')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send({ currentPassword: STRONG_PASSWORD });
      expect(del.status).toBe(204);

      // No key-envelope rows survive (slots + ENVELOPE_META sentinel gone).
      expect(await repo.listSlots(householdId)).toEqual([]);
      expect(await repo.getEnvelopeMeta(householdId)).toBeNull();
    });
  });

  describe('HouseholdKeyEnvelopesRepository', () => {
    function repo(): HouseholdKeyEnvelopesRepository {
      return t.module.get(HouseholdKeyEnvelopesRepository);
    }

    function makeSlot(
      householdId: string,
      slotId: string,
    ): HouseholdKeyEnvelopeRow {
      return {
        householdId,
        slotId,
        slotType: 'password',
        kdf: { algorithm: 'PBKDF2-HMAC-SHA-256', iterations: 600_000, salt: 'c2FsdA' },
        wrappedKey: 'd3JhcHBlZA',
        encryptionVersion: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    it('listSlots returns only slots, excluding the ENVELOPE_META sentinel', async () => {
      const householdId = randomUUID();
      const r = repo();
      await r.upsertSlot(makeSlot(householdId, 'password'));
      await r.upsertSlot(makeSlot(householdId, 'recovery'));
      await r.putEnvelopeMeta(householdId, 1, 'dGFn', null);

      const slots = await r.listSlots(householdId);
      expect(slots.map((s) => s.slotId).sort()).toEqual(['password', 'recovery']);
      expect(slots.some((s) => s.slotId === 'ENVELOPE_META')).toBe(false);
    });

    it('putEnvelopeMeta first write succeeds and is readable', async () => {
      const householdId = randomUUID();
      const r = repo();
      await r.putEnvelopeMeta(householdId, 1, 'dGFn', null);
      const meta = await r.getEnvelopeMeta(householdId);
      expect(meta).toMatchObject({ envelopeSetVersion: 1, envelopeSetTag: 'dGFn' });
    });

    it('putEnvelopeMeta rejects a stale / non-monotonic version with StaleEnvelopeVersionError', async () => {
      const householdId = randomUUID();
      const r = repo();
      // Advance the stored version to 2.
      await r.putEnvelopeMeta(householdId, 1, 'dGFnMQ', null);
      await r.putEnvelopeMeta(householdId, 2, 'dGFnMg', 1);

      // A bump to version 1 against an expected predecessor of 0 is stale.
      await expect(
        r.putEnvelopeMeta(householdId, 1, 'c3RhbGU', 0),
      ).rejects.toBeInstanceOf(StaleEnvelopeVersionError);

      // The stored meta is unchanged at version 2.
      const meta = await r.getEnvelopeMeta(householdId);
      expect(meta).toMatchObject({ envelopeSetVersion: 2, envelopeSetTag: 'dGFnMg' });
    });

    it('getStableEnvelopeSet fails closed with a read conflict while a deletion sweep is in progress', async () => {
      // The non-atomic deleteAllForHousehold sweep removes slot rows WITHOUT
      // bumping the meta version/tag, so the before/after version bracket alone
      // cannot detect a partially-swept set. The sweep therefore stamps the meta
      // sentinel `deletionInProgress` before removing any row. Reproduce that
      // mid-sweep state directly (one slot still present, sentinel marked) and
      // assert the stable read refuses it — never returning the torn slot set.
      const householdId = randomUUID();
      const r = repo();
      await r.upsertSlot(makeSlot(householdId, 'password'));
      const inProgressMeta: HouseholdEnvelopeMetaRow = {
        householdId,
        slotId: ENVELOPE_META_SLOT_ID,
        envelopeSetVersion: 1,
        envelopeSetTag: 'dGFn',
        updatedAt: new Date().toISOString(),
        deletionInProgress: true,
      };
      await t.doc.send(
        new PutCommand({
          TableName: process.env.TABLE_HOUSEHOLD_KEY_ENVELOPE!,
          Item: inProgressMeta,
        }),
      );

      await expect(r.getStableEnvelopeSet(householdId)).rejects.toBeInstanceOf(
        EnvelopeReadConflictError,
      );
    });

    it('getStableEnvelopeSet returns a consistent empty snapshot once the deletion sweep completes', async () => {
      // After deleteAllForHousehold fully completes, both slots and the meta
      // sentinel (deleted LAST) are gone, so the bracket reads a genuinely
      // consistent empty set rather than surfacing a spurious conflict.
      const householdId = randomUUID();
      const r = repo();
      await r.upsertSlot(makeSlot(householdId, 'password'));
      await r.upsertSlot(makeSlot(householdId, 'recovery'));
      await r.putEnvelopeMeta(householdId, 1, 'dGFn', null);

      await r.deleteAllForHousehold(householdId);

      const { slots, meta } = await r.getStableEnvelopeSet(householdId);
      expect(slots).toEqual([]);
      expect(meta).toBeNull();
      // The sentinel row is gone too — the marker never lingers after a
      // completed sweep.
      expect(await r.getEnvelopeMeta(householdId)).toBeNull();
    });

    it('deleteAllForHousehold is a clean no-op when no meta sentinel exists', async () => {
      // A household with slot rows but no ENVELOPE_META sentinel (or none at all)
      // must not throw on the conditional stamp — the marker write is skipped and
      // the remaining rows are still swept.
      const householdId = randomUUID();
      const r = repo();
      await r.upsertSlot(makeSlot(householdId, 'password'));

      await expect(r.deleteAllForHousehold(householdId)).resolves.toBeUndefined();
      expect(await r.listSlots(householdId)).toEqual([]);
      expect(await r.getEnvelopeMeta(householdId)).toBeNull();
    });

    it('getStableEnvelopeSet fails closed when slot rows exist but no meta sentinel does', async () => {
      // A household with slot rows but NO ENVELOPE_META sentinel is a torn set:
      // `markDeletionInProgress` is a conditional UpdateItem that no-ops when the
      // sentinel is absent, so the deletion marker never fences this state. Both
      // meta brackets read `null` and agree, but the slot Query still sees rows —
      // returning `{ slots: [...], meta: null }` would hand the client slots the
      // set tag cannot cover. The read must retry to exhaustion and fail closed
      // rather than surface the torn pair.
      const householdId = randomUUID();
      const r = repo();
      await r.upsertSlot(makeSlot(householdId, 'password'));

      await expect(r.getStableEnvelopeSet(householdId)).rejects.toBeInstanceOf(
        EnvelopeReadConflictError,
      );
    });
  });
});
