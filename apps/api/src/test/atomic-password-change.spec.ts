// Atomic password change: POST /auth/change-password commits the credential and, when supplied, the re-wrapped password slot in one transaction.
// Covers the rollback on a rejected transaction, the second-device crypto round trip and the session-revocation race windows.
import { randomBytes, webcrypto } from 'node:crypto';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  STRONG_PASSWORD,
  bootstrapTestApp,
  freshDeviceId,
  parseSetCookies,
  signupVerifyLogin,
  type Session,
  type TestApp,
  recoverEmailOtp,
} from './test-helpers.js';
import { REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME } from '../auth/cookie-config.js';
import { sha256 } from '../auth/refresh-token.service.js';
import { RefreshTokensRepository } from '../dynamo/refresh-tokens.repository.js';
import { HouseholdKeyEnvelopesRepository } from '../dynamo/household-key-envelopes.repository.js';
import { MfaChallengeService } from '../auth/mfa-challenge.service.js';

const STRONGER_PASSWORD = 'NewPassw0rd!Better1';
const EVEN_STRONGER_PASSWORD = 'NewPassw0rd!Better2';

function passwordSlot(
  householdId: string,
  wrappedKey = 'd3JhcHBlZA',
  kdf: Record<string, unknown> = { algorithm: 'Argon2id', m: 65_536, t: 3, p: 4, salt: 'c2FsdA' },
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    householdId,
    slotId: 'password',
    slotType: 'password',
    kdf,
    wrappedKey,
    encryptionVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function changePasswordRequest(
  t: TestApp,
  sess: Session,
  body: Record<string, unknown>,
): request.Test {
  return request(t.app.getHttpServer())
    .post('/api/v1/auth/change-password')
    .set('Origin', process.env.WEB_ORIGIN!)
    .set('Authorization', `Bearer ${sess.accessToken}`)
    .set('X-CSRF-Token', sess.csrfValue)
    .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
    .send(body);
}

function verifyPasswordRequest(
  t: TestApp,
  sess: Session,
  currentPassword: string,
): request.Test {
  return request(t.app.getHttpServer())
    .post('/api/v1/auth/verify-password')
    .set('Origin', process.env.WEB_ORIGIN!)
    .set('Authorization', `Bearer ${sess.accessToken}`)
    .set('X-CSRF-Token', sess.csrfValue)
    .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
    .send({ currentPassword });
}

function keyEnvelopePut(
  t: TestApp,
  sess: Session,
  slotId: string,
  body: Record<string, unknown>,
): request.Test {
  return request(t.app.getHttpServer())
    .put(`/api/v1/auth/key-envelopes/${slotId}`)
    .set('Origin', process.env.WEB_ORIGIN!)
    .set('Authorization', `Bearer ${sess.accessToken}`)
    .set('X-CSRF-Token', sess.csrfValue)
    .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
    .send(body);
}

async function login(
  t: TestApp,
  email: string,
  password: string,
): Promise<{ status: number }> {
  const res = await request(t.app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('Origin', process.env.WEB_ORIGIN!)
    .send({ email, password, deviceId: freshDeviceId() });
  return { status: res.status };
}

function sessionFromResponse(
  res: request.Response,
  overrides: Pick<Session, 'deviceId' | 'householdId' | 'userId' | 'email'>,
): Session {
  const cookies = parseSetCookies(res.headers['set-cookie']);
  return {
    accessToken: res.body.accessToken,
    refreshCookie: `${REFRESH_COOKIE_NAME}=${encodeURIComponent(cookies[REFRESH_COOKIE_NAME])}`,
    csrfCookie: `${CSRF_COOKIE_NAME}=${encodeURIComponent(cookies[CSRF_COOKIE_NAME])}`,
    csrfValue: cookies[CSRF_COOKIE_NAME],
    ...overrides,
  };
}

// The crypto helpers mirror apps/web/src/crypto/key-wrapping.ts (AAD binding, HKDF-derived MAC key, canonical slot fields) so the
// second-device test proves a genuine round trip against the production format. They are self-contained (Node WebCrypto): apps/api and
// apps/web share no crypto module.

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => `${JSON.stringify(key)}:${canonicalStringify(v)}`);
  return `{${entries.join(',')}}`;
}

function canonicalJsonBytes(value: unknown): Uint8Array {
  return utf8Bytes(canonicalStringify(value));
}

// Node's webcrypto CryptoKey differs from the DOM lib's global CryptoKey; alias it so the signatures below do not collide with the ambient type.
type WcCryptoKey = Awaited<ReturnType<typeof webcrypto.subtle.deriveKey>>;

type TestKdf = { algorithm: 'PBKDF2-HMAC-SHA-256'; iterations: number; salt: string };

type TestSlot = {
  householdId: string;
  slotId: string;
  slotType: string;
  kdf?: TestKdf;
  wrappedKey: string;
  encryptionVersion: number;
  credentialBinding?: string;
  prfSalt?: string;
};

function canonicalSlotAad(input: {
  slotType: string;
  kdf?: TestKdf;
  encryptionVersion: number;
}): Uint8Array {
  return canonicalJsonBytes({
    encryptionVersion: input.encryptionVersion,
    kdf: input.kdf ?? null,
    slotType: input.slotType,
  });
}

async function derivePasswordWrapKey(password: string, kdf: TestKdf) {
  const salt = fromB64url(kdf.salt);
  const baseKey = await webcrypto.subtle.importKey('raw', utf8Bytes(password), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: kdf.iterations, salt },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function wrapHdk(hdk: Uint8Array, wrapKey: WcCryptoKey, aad: Uint8Array): Promise<string> {
  const nonce = randomBytes(12);
  const wrapped = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad },
    wrapKey,
    hdk,
  );
  const combined = new Uint8Array(nonce.length + wrapped.byteLength);
  combined.set(nonce, 0);
  combined.set(new Uint8Array(wrapped), nonce.length);
  return b64url(combined);
}

async function unwrapHdk(wrappedKey: string, wrapKey: WcCryptoKey, aad: Uint8Array): Promise<Uint8Array> {
  const combined = fromB64url(wrappedKey);
  const nonce = combined.subarray(0, 12);
  const ciphertext = combined.subarray(12);
  const raw = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad },
    wrapKey,
    ciphertext,
  );
  return new Uint8Array(raw);
}

async function deriveEnvelopeMacKey(hdk: Uint8Array) {
  const baseKey = await webcrypto.subtle.importKey('raw', hdk, 'HKDF', false, ['deriveKey']);
  return webcrypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8Bytes('envelope-auth') },
    baseKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function canonicalEnvelopeSet(slots: TestSlot[], envelopeSetVersion: number): Uint8Array {
  const ordered = [...slots]
    .sort((a, b) => (a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0))
    .map((slot) => ({
      credentialBinding: slot.credentialBinding ?? null,
      encryptionVersion: slot.encryptionVersion,
      householdId: slot.householdId,
      kdf: slot.kdf ?? null,
      prfSalt: slot.prfSalt ?? null,
      slotId: slot.slotId,
      slotType: slot.slotType,
      wrappedKey: slot.wrappedKey,
    }));
  return canonicalJsonBytes({ envelopeSetVersion, slots: ordered });
}

async function computeEnvelopeSetTag(
  hdk: Uint8Array,
  slots: TestSlot[],
  envelopeSetVersion: number,
): Promise<string> {
  const macKey = await deriveEnvelopeMacKey(hdk);
  const signature = await webcrypto.subtle.sign(
    'HMAC',
    macKey,
    canonicalEnvelopeSet(slots, envelopeSetVersion),
  );
  return b64url(new Uint8Array(signature));
}

// mfa/email/send and mfa/verify are @Public() and accept any validly signed challenge, whatever AUTH_MFA_ENFORCED says.

describe('atomic password change', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('a household with no password slot commits the credential alone', async () => {
    const sess = await signupVerifyLogin(t);
    const res = await changePasswordRequest(t, sess, {
      currentPassword: STRONG_PASSWORD,
      newPassword: STRONGER_PASSWORD,
    });
    expect(res.status).toBe(200);

    const oldPw = await login(t, sess.email, STRONG_PASSWORD);
    expect(oldPw.status).toBe(401);
    const newPw = await login(t, sess.email, STRONGER_PASSWORD);
    expect(newPw.status).toBe(200);
  });

  it('a body with no envelope fields from a household that DOES hold a password slot is refused UPGRADE_REQUIRED, never performed as a credential-only change', async () => {
    const sess = await signupVerifyLogin(t);
    const setup = await keyEnvelopePut(t, sess, 'password', {
      slot: passwordSlot(sess.householdId),
      envelopeSetVersion: 1,
      expectedEnvelopeSetVersion: 0,
      envelopeSetTag: 'tag-v1',
    });
    expect(setup.status).toBe(204);

    const res = await changePasswordRequest(t, sess, {
      currentPassword: STRONG_PASSWORD,
      newPassword: STRONGER_PASSWORD,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UPGRADE_REQUIRED');

    const oldPw = await login(t, sess.email, STRONG_PASSWORD);
    expect(oldPw.status).toBe(200);
    const newPw = await login(t, sess.email, STRONGER_PASSWORD);
    expect(newPw.status).toBe(401);
  });

  it('a household holding a noncanonical password-type slot is refused PASSWORD_SLOT_NOT_CANONICAL with a message that names no support contact or address', async () => {
    const sess = await signupVerifyLogin(t);
    const now = new Date().toISOString();
    const envelopes = t.module.get(HouseholdKeyEnvelopesRepository);
    await envelopes.upsertSlot({
      householdId: sess.householdId,
      slotId: 'legacy-password',
      slotType: 'password',
      wrappedKey: 'd3JhcHBlZA',
      encryptionVersion: 1,
      createdAt: now,
      updatedAt: now,
    });

    const res = await changePasswordRequest(t, sess, {
      currentPassword: STRONG_PASSWORD,
      newPassword: STRONGER_PASSWORD,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PASSWORD_SLOT_NOT_CANONICAL');
    expect(res.body.error.message).not.toMatch(/support/i);
    expect(res.body.error.message).not.toMatch(/http/i);

    const oldPw = await login(t, sess.email, STRONG_PASSWORD);
    expect(oldPw.status).toBe(200);
  });

  it('a rejected transaction (stale envelope version) leaves the credential and the slot set untouched', async () => {
    const sess = await signupVerifyLogin(t);
    const setup = await keyEnvelopePut(t, sess, 'password', {
      slot: passwordSlot(sess.householdId),
      envelopeSetVersion: 1,
      expectedEnvelopeSetVersion: 0,
      envelopeSetTag: 'tag-v1',
    });
    expect(setup.status).toBe(204);

    // Snapshot every stored slot field first, so the assertion below is exact equality and not merely "old password works".
    const envelopes = t.module.get(HouseholdKeyEnvelopesRepository);
    const rowsBefore = await envelopes.listSlots(sess.householdId, true);
    expect(rowsBefore).toHaveLength(1);

    const res = await changePasswordRequest(t, sess, {
      currentPassword: STRONG_PASSWORD,
      newPassword: STRONGER_PASSWORD,
      slot: passwordSlot(sess.householdId, 'bmV3LXdyYXA'),
      // Stale on purpose: the current version is 1.
      envelopeSetVersion: 5,
      expectedEnvelopeSetVersion: 4,
      envelopeSetTag: 'tag-v5',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STALE_ENVELOPE_VERSION');

    const oldPw = await login(t, sess.email, STRONG_PASSWORD);
    expect(oldPw.status).toBe(200);
    const newPw = await login(t, sess.email, STRONGER_PASSWORD);
    expect(newPw.status).toBe(401);

    // Byte-for-byte unchanged: a slot written outside the transaction would pass the sign-in assertions yet leave the stored tag and meta
    // inconsistent, locking out every future unlock.
    const rowsAfter = await envelopes.listSlots(sess.householdId, true);
    expect(rowsAfter).toEqual(rowsBefore);
    expect(rowsAfter.some((r) => r.wrappedKey === 'bmV3LXdyYXA')).toBe(false);

    const get = await request(t.app.getHttpServer())
      .get('/api/v1/auth/key-envelopes')
      .set('Authorization', `Bearer ${sess.accessToken}`);
    expect(get.status).toBe(200);
    expect(get.body.envelopeSetVersion).toBe(1);
    expect(get.body.envelopeSetTag).toBe('tag-v1');
    const storedSlot = get.body.slots.find((s: { slotId: string }) => s.slotId === 'password');
    expect(storedSlot.wrappedKey).toBe('d3JhcHBlZA');
  });

  it('a rewrap-shaped body from a household holding NO password slot is refused, never silently creating the slot (the reverse shape-mismatch direction)', async () => {
    // The commit shape is the server's eligibility read in both directions: a rewrap-shaped body for a no-slot household is a stale view or a
    // crafted call, and committing it would mint a canonical password slot through change-password.
    const sess = await signupVerifyLogin(t);
    const res = await changePasswordRequest(t, sess, {
      currentPassword: STRONG_PASSWORD,
      newPassword: STRONGER_PASSWORD,
      slot: passwordSlot(sess.householdId, 'bm8tc2xvdC1ib2R5'),
      envelopeSetVersion: 1,
      expectedEnvelopeSetVersion: 0,
      envelopeSetTag: 'tag-v1',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UPGRADE_REQUIRED');

    const envelopes = t.module.get(HouseholdKeyEnvelopesRepository);
    expect(await envelopes.listSlots(sess.householdId, true)).toEqual([]);
    const oldPw = await login(t, sess.email, STRONG_PASSWORD);
    expect(oldPw.status).toBe(200);
    const newPw = await login(t, sess.email, STRONGER_PASSWORD);
    expect(newPw.status).toBe(401);
  });

  it('a committed re-wrap is a REAL cryptographic round trip: the tag authenticates the committed set and only the new password unwraps it (second-device proxy)', async () => {
    const sess = await signupVerifyLogin(t);
    const hdk = randomBytes(32);
    const oldSalt = randomBytes(16);
    const newSalt = randomBytes(16);
    const oldKdf: TestKdf = { algorithm: 'PBKDF2-HMAC-SHA-256', iterations: 1000, salt: b64url(oldSalt) };
    const newKdf: TestKdf = { algorithm: 'PBKDF2-HMAC-SHA-256', iterations: 1000, salt: b64url(newSalt) };

    const oldWrapKey = await derivePasswordWrapKey(STRONG_PASSWORD, oldKdf);
    const oldAad = canonicalSlotAad({ slotType: 'password', kdf: oldKdf, encryptionVersion: 1 });
    const oldWrapped = await wrapHdk(hdk, oldWrapKey, oldAad);
    const oldSlot: TestSlot = {
      householdId: sess.householdId,
      slotId: 'password',
      slotType: 'password',
      kdf: oldKdf,
      wrappedKey: oldWrapped,
      encryptionVersion: 1,
    };
    const setupTag = await computeEnvelopeSetTag(hdk, [oldSlot], 1);
    const setup = await keyEnvelopePut(t, sess, 'password', {
      slot: passwordSlot(sess.householdId, oldWrapped, oldKdf),
      envelopeSetVersion: 1,
      expectedEnvelopeSetVersion: 0,
      envelopeSetTag: setupTag,
    });
    expect(setup.status).toBe(204);

    const newWrapKey = await derivePasswordWrapKey(STRONGER_PASSWORD, newKdf);
    const newAad = canonicalSlotAad({ slotType: 'password', kdf: newKdf, encryptionVersion: 1 });
    const newWrapped = await wrapHdk(hdk, newWrapKey, newAad);
    const newSlot: TestSlot = {
      householdId: sess.householdId,
      slotId: 'password',
      slotType: 'password',
      kdf: newKdf,
      wrappedKey: newWrapped,
      encryptionVersion: 1,
    };
    const newTag = await computeEnvelopeSetTag(hdk, [newSlot], 2);

    const res = await changePasswordRequest(t, sess, {
      currentPassword: STRONG_PASSWORD,
      newPassword: STRONGER_PASSWORD,
      slot: passwordSlot(sess.householdId, newWrapped, newKdf),
      envelopeSetVersion: 2,
      expectedEnvelopeSetVersion: 1,
      envelopeSetTag: newTag,
    });
    expect(res.status).toBe(200);

    const relog = await request(t.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ email: sess.email, password: STRONGER_PASSWORD, deviceId: freshDeviceId() });
    expect(relog.status).toBe(200);
    const get = await request(t.app.getHttpServer())
      .get('/api/v1/auth/key-envelopes')
      .set('Authorization', `Bearer ${relog.body.accessToken}`);
    expect(get.status).toBe(200);
    expect(get.body.envelopeSetVersion).toBe(2);

    const fetchedSlot = get.body.slots.find((s: { slotId: string }) => s.slotId === 'password');
    expect(fetchedSlot.wrappedKey).toBe(newWrapped);
    const fetchedKdf: TestKdf = fetchedSlot.kdf;
    const fetchedAad = canonicalSlotAad({
      slotType: fetchedSlot.slotType,
      kdf: fetchedKdf,
      encryptionVersion: fetchedSlot.encryptionVersion,
    });

    const fetchedNewWrapKey = await derivePasswordWrapKey(STRONGER_PASSWORD, fetchedKdf);
    const unwrapped = await unwrapHdk(fetchedSlot.wrappedKey, fetchedNewWrapKey, fetchedAad);
    expect(Buffer.from(unwrapped).equals(Buffer.from(hdk))).toBe(true);

    // Recomputing the tag from the unwrapped HDK, the HKDF-derived MAC key and the full canonical slot fields matches the stored tag, so the meta item landed in the same transaction as the slot.
    const fetchedSlotForTag: TestSlot = {
      householdId: fetchedSlot.householdId,
      slotId: fetchedSlot.slotId,
      slotType: fetchedSlot.slotType,
      kdf: fetchedSlot.kdf,
      wrappedKey: fetchedSlot.wrappedKey,
      encryptionVersion: fetchedSlot.encryptionVersion,
    };
    const recomputedTag = await computeEnvelopeSetTag(
      unwrapped,
      [fetchedSlotForTag],
      get.body.envelopeSetVersion,
    );
    expect(recomputedTag).toBe(get.body.envelopeSetTag);

    const oldWrapKeyAttempt = await derivePasswordWrapKey(STRONG_PASSWORD, fetchedKdf);
    await expect(unwrapHdk(fetchedSlot.wrappedKey, oldWrapKeyAttempt, fetchedAad)).rejects.toThrow();
  });

  it('a revoked session cannot lend its recorded write authority to a request bearing a DIFFERENT (live) session\'s access token', async () => {
    const sessA = await signupVerifyLogin(t);
    const loginB = await request(t.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ email: sessA.email, password: STRONG_PASSWORD, deviceId: freshDeviceId() });
    expect(loginB.status).toBe(200);
    const sessB = sessionFromResponse(loginB, {
      deviceId: freshDeviceId(),
      householdId: sessA.householdId,
      userId: sessA.userId,
      email: sessA.email,
    });

    const logout = await request(t.app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Authorization', `Bearer ${sessA.accessToken}`)
      .set('X-CSRF-Token', sessA.csrfValue)
      .set('Cookie', [sessA.refreshCookie, sessA.csrfCookie].join('; '));
    expect(logout.status).toBe(204);

    // sessB's live bearer with sessA's revoked refresh cookie is the retained-cookie lending vector: the resolver must not hand sessA's
    // recorded row to a request bearing another session's token.
    const write = await request(t.app.getHttpServer())
      .put('/api/v1/auth/key-envelopes/password')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Authorization', `Bearer ${sessB.accessToken}`)
      .set('X-CSRF-Token', sessA.csrfValue)
      .set('Cookie', [sessA.refreshCookie, sessA.csrfCookie].join('; '))
      .send({
        slot: passwordSlot(sessA.householdId, 'bGVudC1hdXRob3JpdHk'),
        envelopeSetVersion: 1,
        expectedEnvelopeSetVersion: 0,
        envelopeSetTag: 'tag-v1',
      });
    expect(write.status).toBe(409);
    expect(write.body.error.code).toBe('UPGRADE_REQUIRED');
  });

  it('a session whose sign-in predates a password reset is rejected at the guard by the retired session generation, before the write-authority CONDITION ever runs (superseded session)', async () => {
    const sess = await signupVerifyLogin(t);
    const setup = await keyEnvelopePut(t, sess, 'password', {
      slot: passwordSlot(sess.householdId),
      envelopeSetVersion: 1,
      expectedEnvelopeSetVersion: 0,
      envelopeSetTag: 'tag-v1',
    });
    expect(setup.status).toBe(204);

    const refreshTokens = t.module.get(RefreshTokensRepository);
    const originalRevokeFamily = refreshTokens.revokeFamily.bind(refreshTokens);
    let pendingStatus: number | undefined;
    let pendingBody: { error?: { code?: string } } | undefined;
    // Fires the pending write from inside `revokeAllSessions`, before `revokeFamily`: after the reset's credential rotation, before session
    // revocation completes. The generation bump lands first as the linearization point, so the guard rejects the session before the
    // credential ConditionCheck runs.
    const spy = jest
      .spyOn(refreshTokens, 'revokeFamily')
      .mockImplementation(async (...args: Parameters<typeof originalRevokeFamily>) => {
        const pending = await keyEnvelopePut(t, sess, 'password', {
          slot: passwordSlot(sess.householdId, 'c3RhbGUtd3JhcA'),
          envelopeSetVersion: 2,
          expectedEnvelopeSetVersion: 1,
          envelopeSetTag: 'tag-v2',
        });
        pendingStatus = pending.status;
        pendingBody = pending.body;
        return originalRevokeFamily(...args);
      });

    try {
      const reqReset = await request(t.app.getHttpServer())
        .post('/api/v1/auth/request-password-reset')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email: sess.email });
      expect(reqReset.status).toBe(202);
      const resetToken = reqReset.body.resetToken as string;
      expect(typeof resetToken).toBe('string');
      const consume = await request(t.app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ token: resetToken, newPassword: EVEN_STRONGER_PASSWORD });
      expect(consume.status).toBe(204);
    } finally {
      spy.mockRestore();
    }

    // The retired session generation, not the write-authority condition, rejected it: the bump is the linearization point, ahead of the sweep this spy is inside.
    expect(pendingStatus).toBe(401);
    expect(pendingBody?.error?.code).toBe('ACCESS_TOKEN_REVOKED');

    const relog = await request(t.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ email: sess.email, password: EVEN_STRONGER_PASSWORD, deviceId: freshDeviceId() });
    expect(relog.status).toBe(200);
    const get = await request(t.app.getHttpServer())
      .get('/api/v1/auth/key-envelopes')
      .set('Authorization', `Bearer ${relog.body.accessToken}`);
    expect(get.body.envelopeSetVersion).toBe(1);
    const slot = get.body.slots.find((s: { slotId: string }) => s.slotId === 'password');
    expect(slot.wrappedKey).toBe('d3JhcHBlZA');
  });

  it('the mirrored ordering: a pending slot write landing between change-password\'s credential write and the completion of ITS OWN session revocation is rejected at the guard by the retired session generation (concurrency)', async () => {
    // Recovery-only (no-slot) household: login already grants this session write authority.
    const sess = await signupVerifyLogin(t);

    const refreshTokens = t.module.get(RefreshTokensRepository);
    const originalRevokeFamily = refreshTokens.revokeFamily.bind(refreshTokens);
    let pendingStatus: number | undefined;
    let pendingBody: { error?: { code?: string } } | undefined;
    const spy = jest
      .spyOn(refreshTokens, 'revokeFamily')
      .mockImplementation(async (...args: Parameters<typeof originalRevokeFamily>) => {
        // change() has committed the credential-only transaction, but this session's refresh row is not yet revoked. The generation bump
        // (SessionRevocationService.revokeAll) has already landed, so the guard rejects the pending write, not the envelope write's own condition.
        const pending = await keyEnvelopePut(t, sess, 'password', {
          slot: passwordSlot(sess.householdId, 'cGVuZGluZy13cmFw'),
          envelopeSetVersion: 1,
          expectedEnvelopeSetVersion: 0,
          envelopeSetTag: 'tag-pending',
        });
        pendingStatus = pending.status;
        pendingBody = pending.body;
        return originalRevokeFamily(...args);
      });

    try {
      const res = await changePasswordRequest(t, sess, {
        currentPassword: STRONG_PASSWORD,
        newPassword: STRONGER_PASSWORD,
      });
      expect(res.status).toBe(200);
    } finally {
      spy.mockRestore();
    }

    expect(pendingStatus).toBe(401);
    expect(pendingBody?.error?.code).toBe('ACCESS_TOKEN_REVOKED');

    const relog = await request(t.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ email: sess.email, password: STRONGER_PASSWORD, deviceId: freshDeviceId() });
    expect(relog.status).toBe(200);
    const get = await request(t.app.getHttpServer())
      .get('/api/v1/auth/key-envelopes')
      .set('Authorization', `Bearer ${relog.body.accessToken}`);
    expect(get.body.slots).toEqual([]);

    const freshSess = sessionFromResponse(relog, {
      deviceId: freshDeviceId(),
      householdId: sess.householdId,
      userId: sess.userId,
      email: sess.email,
    });
    const setupAfter = await keyEnvelopePut(t, freshSess, 'password', {
      slot: passwordSlot(sess.householdId, 'cG9zdC1zZXR1cA'),
      envelopeSetVersion: 1,
      expectedEnvelopeSetVersion: 0,
      envelopeSetTag: 'tag-v1',
    });
    expect(setupAfter.status).toBe(204);
  });

  it('no-slot household, slot appears mid-flight: the credential-only commit is rejected and the household stays entirely on the old password (concurrency)', async () => {
    const sess = await signupVerifyLogin(t);
    const envelopes = t.module.get(HouseholdKeyEnvelopesRepository);
    const originalListSlots = envelopes.listSlots.bind(envelopes);
    const spy = jest
      .spyOn(envelopes, 'listSlots')
      .mockImplementationOnce(async (...args: Parameters<typeof originalListSlots>) => {
        const result = await originalListSlots(...args);
        // A real concurrent PUT lands a password slot between the eligibility read and the commit, so this proves the transactional ConditionCheck rejects it, not the earlier (now stale) read.
        const putRes = await keyEnvelopePut(t, sess, 'password', {
          slot: passwordSlot(sess.householdId, 'bWlkLWZsaWdodA'),
          envelopeSetVersion: 1,
          expectedEnvelopeSetVersion: 0,
          envelopeSetTag: 'tag-midflight',
        });
        expect(putRes.status).toBe(204);
        return result;
      });

    try {
      const res = await changePasswordRequest(t, sess, {
        currentPassword: STRONG_PASSWORD,
        newPassword: STRONGER_PASSWORD,
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PASSWORD_SLOT_PRESENT');
    } finally {
      spy.mockRestore();
    }

    const oldPw = await login(t, sess.email, STRONG_PASSWORD);
    expect(oldPw.status).toBe(200);
    const newPw = await login(t, sess.email, STRONGER_PASSWORD);
    expect(newPw.status).toBe(401);
  });

  it('MFA challenge window: a reset landing between login and MFA completion revokes the stale-generation challenge outright', async () => {
    const sess = await signupVerifyLogin(t);
    const mfaChallenges = t.module.get(MfaChallengeService);

    // Signed as if MFA were enforced at signup's login: generation 0, before any account-wide revoke.
    const staleChallenge = mfaChallenges.sign(sess.userId, sess.deviceId, 'rev-at-signup', 0);

    const reqReset = await request(t.app.getHttpServer())
      .post('/api/v1/auth/request-password-reset')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ email: sess.email });
    expect(reqReset.status).toBe(202);
    const resetToken = reqReset.body.resetToken as string;
    const consume = await request(t.app.getHttpServer())
      .post('/api/v1/auth/reset-password')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ token: resetToken, newPassword: EVEN_STRONGER_PASSWORD });
    expect(consume.status).toBe(204);

    // mfa/email/send reads only the challenge's userId, not its generation, so the code still sends...
    const send = await request(t.app.getHttpServer())
      .post('/api/v1/auth/mfa/email/send')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ challengeToken: staleChallenge });
    expect(send.status).toBe(202);
    const code = await recoverEmailOtp(t, sess.userId);

    // ...but completion is rejected: the reset retired generation 0, so proof gathered before it cannot survive it.
    const verify = await request(t.app.getHttpServer())
      .post('/api/v1/auth/mfa/verify')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ challengeToken: staleChallenge, method: 'email_otp', code, deviceId: sess.deviceId });
    expect(verify.status).toBe(401);
    expect(verify.body.error.code).toBe('MFA_CHALLENGE_INVALID');
  });

  it('ordinary refresh rotation carries the session write authority forward', async () => {
    const sess = await signupVerifyLogin(t);
    const setup = await keyEnvelopePut(t, sess, 'password', {
      slot: passwordSlot(sess.householdId),
      envelopeSetVersion: 1,
      expectedEnvelopeSetVersion: 0,
      envelopeSetTag: 'tag-v1',
    });
    expect(setup.status).toBe(204);

    const refresh = await request(t.app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '));
    expect(refresh.status).toBe(200);
    const rotatedCookies = refresh.headers['set-cookie'] as unknown as string[];
    const rotatedRefresh = rotatedCookies.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`))!;
    const rotatedCsrf = rotatedCookies.find((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`))!;

    const putAfterRefresh = await request(t.app.getHttpServer())
      .put('/api/v1/auth/key-envelopes/password')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Authorization', `Bearer ${refresh.body.accessToken}`)
      .set('X-CSRF-Token', rotatedCsrf.split(';')[0]!.split('=')[1]!)
      .set('Cookie', [rotatedRefresh.split(';')[0], rotatedCsrf.split(';')[0]].join('; '))
      .send({
        slot: passwordSlot(sess.householdId, 'cm90YXRlZC13cmFw'),
        envelopeSetVersion: 2,
        expectedEnvelopeSetVersion: 1,
        envelopeSetTag: 'tag-v2',
      });
    expect(putAfterRefresh.status).toBe(204);
  });

  it('a chain that began carrying NO recorded revision still carries none after a refresh, and its slot write is still rejected', async () => {
    const sess = await signupVerifyLogin(t);

    // Strips the recorded revision, the shape of every session alive at rollout.
    const refreshTable = t.module
      .get(ConfigService)
      .get('TABLE_REFRESH_TOKEN', { infer: true } as never) as unknown as string;
    const rawCookie = decodeURIComponent(sess.refreshCookie.slice(`${REFRESH_COOKIE_NAME}=`.length));
    const tokenHash = sha256(rawCookie);
    await t.doc.send(
      new UpdateCommand({
        TableName: refreshTable,
        Key: { userId: sess.userId, tokenHash },
        UpdateExpression: 'REMOVE credentialRevision',
      }),
    );

    const writeBeforeRefresh = await keyEnvelopePut(t, sess, 'password', {
      slot: passwordSlot(sess.householdId),
      envelopeSetVersion: 1,
      expectedEnvelopeSetVersion: 0,
      envelopeSetTag: 'tag-v1',
    });
    expect(writeBeforeRefresh.status).toBe(409);
    expect(writeBeforeRefresh.body.error.code).toBe('UPGRADE_REQUIRED');

    // RefreshTokenService.issue must copy the absence forward verbatim, never default it to something that grants authority.
    const refresh = await request(t.app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '));
    expect(refresh.status).toBe(200);
    const rotatedCookies = refresh.headers['set-cookie'] as unknown as string[];
    const rotatedRefreshCookie = rotatedCookies.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`))!;
    const rotatedCsrfCookie = rotatedCookies.find((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`))!;
    const rotatedTokenHash = sha256(
      decodeURIComponent(rotatedRefreshCookie.split(';')[0]!.split('=').slice(1).join('=')),
    );
    const rotatedRow = await t.module.get(RefreshTokensRepository).find(sess.userId, rotatedTokenHash);
    expect(rotatedRow).not.toBeNull();
    expect(rotatedRow?.credentialRevision).toBeUndefined();

    const writeAfterRefresh = await request(t.app.getHttpServer())
      .put('/api/v1/auth/key-envelopes/password')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Authorization', `Bearer ${refresh.body.accessToken}`)
      .set('X-CSRF-Token', rotatedCsrfCookie.split(';')[0]!.split('=')[1]!)
      .set('Cookie', [rotatedRefreshCookie.split(';')[0], rotatedCsrfCookie.split(';')[0]].join('; '))
      .send({
        slot: passwordSlot(sess.householdId),
        envelopeSetVersion: 1,
        expectedEnvelopeSetVersion: 0,
        envelopeSetTag: 'tag-v1',
      });
    expect(writeAfterRefresh.status).toBe(409);
    expect(writeAfterRefresh.body.error.code).toBe('UPGRADE_REQUIRED');
  });

  it('verify-password grants the SAME session write authority in place: a no-revision session\'s slot write is rejected, healed by verifying the correct password (and NOT by a wrong one)', async () => {
    // The one path no other test covers: verifyPassword stamps the matched revision on the session in place, with no re-login, and a later
    // password-slot write from that same session passes the credential ConditionCheck.
    const sess = await signupVerifyLogin(t);

    const refreshTable = t.module
      .get(ConfigService)
      .get('TABLE_REFRESH_TOKEN', { infer: true } as never) as unknown as string;
    const rawCookie = decodeURIComponent(sess.refreshCookie.slice(`${REFRESH_COOKIE_NAME}=`.length));
    const tokenHash = sha256(rawCookie);
    await t.doc.send(
      new UpdateCommand({
        TableName: refreshTable,
        Key: { userId: sess.userId, tokenHash },
        UpdateExpression: 'REMOVE credentialRevision',
      }),
    );

    const writeBefore = await keyEnvelopePut(t, sess, 'password', {
      slot: passwordSlot(sess.householdId),
      envelopeSetVersion: 1,
      expectedEnvelopeSetVersion: 0,
      envelopeSetTag: 'tag-v1',
    });
    expect(writeBefore.status).toBe(409);
    expect(writeBefore.body.error.code).toBe('UPGRADE_REQUIRED');

    const wrongVerify = await verifyPasswordRequest(t, sess, 'Wrong-password-123!');
    expect(wrongVerify.status).toBe(401);
    const writeAfterWrongVerify = await keyEnvelopePut(t, sess, 'password', {
      slot: passwordSlot(sess.householdId),
      envelopeSetVersion: 1,
      expectedEnvelopeSetVersion: 0,
      envelopeSetTag: 'tag-v1',
    });
    expect(writeAfterWrongVerify.status).toBe(409);
    expect(writeAfterWrongVerify.body.error.code).toBe('UPGRADE_REQUIRED');

    const verify = await verifyPasswordRequest(t, sess, STRONG_PASSWORD);
    expect(verify.status).toBe(204);
    const row = await t.module.get(RefreshTokensRepository).find(sess.userId, tokenHash);
    expect(row?.credentialRevision).toBeDefined();

    const writeAfter = await keyEnvelopePut(t, sess, 'password', {
      slot: passwordSlot(sess.householdId),
      envelopeSetVersion: 1,
      expectedEnvelopeSetVersion: 0,
      envelopeSetTag: 'tag-v1',
    });
    expect(writeAfter.status).toBe(204);
  });
});
