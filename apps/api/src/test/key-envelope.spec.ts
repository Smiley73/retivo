// Integration tests for GET/PUT/DELETE /auth/key-envelopes: slot writes, audit events, version monotonicity, torn-read handling and the
// account-deletion cascade, plus the repository's deletion-sweep reads.
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
} from '../dynamo/household-key-envelopes.repository.js';
import { CredentialsRepository } from '../dynamo/credentials.repository.js';
import { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';

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
      // Server-authored, never derived client-side: a fresh signup mints a revision, so it resolves to a concrete value rather than being omitted.
      expect(typeof res.body.currentCredentialRevision).toBe('string');
      expect((res.body.currentCredentialRevision as string).length).toBeGreaterThan(0);
      // It must equal the account's real credential row: a hardcoded constant, the wrong user's revision or a stale cached value would pass the shape check above.
      const credential = await credentials.findByUserId(userId);
      expect(res.body.currentCredentialRevision).toBe(credential?.credentialRevision);

      // It must change when the credential does: the client gates every re-wrap decision on it, so a value that never moves would suppress every owed re-wrap.
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
      // Stub the consistent meta read so the first attempt's before/after bracket disagrees (a concurrent slot+meta write landed mid-read) and the
      // retry agrees: the endpoint must retry to a consistent result, never return the torn pair.
      const { email } = await signupVerifyApprove(t);
      const sess = await login(t, email);
      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      const stable = { envelopeSetVersion: 5, envelopeSetTag: 'stabletag', updatedAt: new Date().toISOString() };
      let call = 0;
      const spy = jest
        .spyOn(repo, 'getEnvelopeMeta')
        .mockImplementation(async () => {
          call += 1;
          // Attempt 1: before(call 1) is stable, after(call 2) is torn, so retry. Attempt 2: calls 3 and 4 agree, so accept.
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
      // Every meta read reports a different version, so the bracket never matches: a persistently torn read must be a 503, never an inconsistent pair.
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

      const put1 = await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/password')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send(passwordUpsertBody(householdId, 1, 'dGFnMQ'));
      expect(put1.status).toBe(204);

      const put2 = await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/recovery')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send(recoveryUpsertBody(householdId, 2, 'dGFnMg'));
      expect(put2.status).toBe(204);

      const get = await request(t.app.getHttpServer())
        .get('/api/v1/auth/key-envelopes')
        .set('Authorization', `Bearer ${sess.accessToken}`);
      expect(get.status).toBe(200);
      const slots = get.body.slots as HouseholdKeyEnvelopeRow[];
      expect(slots.map((s) => s.slotId).sort()).toEqual(['password', 'recovery']);
      expect(get.body.envelopeSetVersion).toBe(2);
      expect(get.body.envelopeSetTag).toBe('dGFnMg');

      const events = await scanAll<AuthEventRow>(t.doc, process.env.TABLE_AUTH_EVENT!);
      const mine = events.filter((e) => e.userId === userId);
      expect(mine.some((e) => e.eventType === 'key_envelope_created')).toBe(true);
    });

    it('round-trips an Argon2id-kdf password slot (m/t/p preserved, no iterations)', async () => {
      // New password slots carry an Argon2id kdf `{ algorithm, m, t, p, salt }`. The DTO must accept m/t/p under the global forbidNonWhitelisted
      // ValidationPipe and the controller must persist them verbatim, not collapse them to a PBKDF2 shape with `iterations: undefined`.
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

      // Snapshot the whole stored password slot and send a stale body with a distinguishable wrappedKey: a regression that wrote the stale slot
      // before returning 409 would pass a version-only assertion.
      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      const passwordBefore = (await repo.listSlots(householdId)).find(
        (s) => s.slotId === 'password',
      );
      expect(passwordBefore).toBeTruthy();

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

      const get = await request(t.app.getHttpServer())
        .get('/api/v1/auth/key-envelopes')
        .set('Authorization', `Bearer ${sess.accessToken}`);
      expect(get.body.envelopeSetVersion).toBe(2);
      expect(get.body.envelopeSetTag).toBe('dGFnMg');

      // Byte-for-byte unchanged: the rejected write's wrappedKey never landed.
      const passwordAfter = (await repo.listSlots(householdId)).find(
        (s) => s.slotId === 'password',
      );
      expect(passwordAfter).toEqual(passwordBefore);
      expect(passwordAfter?.wrappedKey).not.toBe('c3RhbGV3cmFwcGVk');
    });

    it.each([
      ['the reserved ENVELOPE_META sentinel', 'ENVELOPE_META'],
      ['an archive-namespaced id', 'ARCHIVE%231%23recovery'],
    ])('rejects a PUT (and DELETE) against %s with 400 INVALID_SLOT_ID, leaving meta and slots untouched', async (_label, slotId) => {
      const { email } = await signupVerifyApprove(t);
      const sess = await login(t, email);
      const { householdId } = decodeAccessClaims(sess.accessToken);
      const authed = (req: request.Test) =>
        req
          .set('Origin', process.env.WEB_ORIGIN!)
          .set('Authorization', `Bearer ${sess.accessToken}`)
          .set('X-CSRF-Token', sess.csrfValue)
          .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '));
      const api = () => request(t.app.getHttpServer());

      await authed(api().put('/api/v1/auth/key-envelopes/password')).send(
        passwordUpsertBody(householdId, 1, 'dGFnMQ'),
      );
      await authed(api().put('/api/v1/auth/key-envelopes/recovery')).send(
        recoveryUpsertBody(householdId, 2, 'dGFnMg'),
      );

      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      const put = await authed(api().put(`/api/v1/auth/key-envelopes/${slotId}`)).send(
        passwordUpsertBody(householdId, 99, 'cHduZWQ'),
      );
      expect(put.status).toBe(400);
      expect(put.body.error.code).toBe('INVALID_SLOT_ID');
      const del = await authed(api().delete(`/api/v1/auth/key-envelopes/${slotId}`)).send({
        envelopeSetVersion: 3,
        expectedEnvelopeSetVersion: 2,
        envelopeSetTag: 'cHduZWQ',
      });
      expect(del.status).toBe(400);
      expect(del.body.error.code).toBe('INVALID_SLOT_ID');

      expect(await repo.getEnvelopeMeta(householdId)).toMatchObject({
        envelopeSetVersion: 2,
        envelopeSetTag: 'dGFnMg',
      });
      expect((await repo.listSlots(householdId)).map((s) => s.slotId).sort()).toEqual([
        'password',
        'recovery',
      ]);
    });

    it('accepts a passkey_prf slot whose credentialBinding is an enrolled passkey', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const sess = await login(t, email);
      const { householdId } = decodeAccessClaims(sess.accessToken);

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

      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      expect(await repo.listSlots(householdId)).toEqual([]);
      expect(await repo.getEnvelopeMeta(householdId)).toBeNull();
    });
  });

  describe('DELETE /auth/key-envelopes/:slotId', () => {
    it('removes a slot, bumps the version, and audits delete', async () => {
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
      await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/recovery')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send(recoveryUpsertBody(householdId, 2, 'dGFnMg'));

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

      await request(t.app.getHttpServer())
        .put('/api/v1/auth/key-envelopes/password')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send(passwordUpsertBody(householdId, 1, 'dGFnMQ'));

      const repo = t.module.get(HouseholdKeyEnvelopesRepository);
      expect(await repo.listSlots(householdId)).toHaveLength(1);

      const del = await request(t.app.getHttpServer())
        .delete('/api/v1/auth/account')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send({ currentPassword: STRONG_PASSWORD });
      expect(del.status).toBe(204);

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

    it('getStableEnvelopeSet fails closed with a read conflict while a deletion sweep is in progress', async () => {
      // The non-atomic deleteAllForHousehold sweep removes slot rows without bumping the meta version, so the version bracket cannot detect a
      // partially swept set; the sweep stamps `deletionInProgress` on the meta sentinel first. This reproduces that mid-sweep state and asserts the
      // stable read refuses it.
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
      // Once the sweep completes, slots and the meta sentinel (deleted last) are gone, so the bracket reads a consistent empty set, not a spurious conflict.
      const householdId = randomUUID();
      const r = repo();
      await r.upsertSlot(makeSlot(householdId, 'password'));
      await r.upsertSlot(makeSlot(householdId, 'recovery'));
      await r.putEnvelopeMeta(householdId, 1, 'dGFn', null);

      await r.deleteAllForHousehold(householdId);

      const { slots, meta } = await r.getStableEnvelopeSet(householdId);
      expect(slots).toEqual([]);
      expect(meta).toBeNull();
      expect(await r.getEnvelopeMeta(householdId)).toBeNull();
    });

    it('deleteAllForHousehold is a clean no-op when no meta sentinel exists', async () => {
      // The conditional deletion stamp must not throw when the sentinel is absent: the marker write is skipped and the remaining rows are still swept.
      const householdId = randomUUID();
      const r = repo();
      await r.upsertSlot(makeSlot(householdId, 'password'));

      await expect(r.deleteAllForHousehold(householdId)).resolves.toBeUndefined();
      expect(await r.listSlots(householdId)).toEqual([]);
      expect(await r.getEnvelopeMeta(householdId)).toBeNull();
    });

    it('getStableEnvelopeSet fails closed when slot rows exist but no meta sentinel does', async () => {
      // Slot rows with no meta sentinel are a torn set: `markDeletionInProgress` no-ops when the sentinel is absent, so the marker never fences
      // this state, and both meta brackets read `null` and agree. The read must retry to exhaustion and fail closed.
      const householdId = randomUUID();
      const r = repo();
      await r.upsertSlot(makeSlot(householdId, 'password'));

      await expect(r.getStableEnvelopeSet(householdId)).rejects.toBeInstanceOf(
        EnvelopeReadConflictError,
      );
    });
  });
});
