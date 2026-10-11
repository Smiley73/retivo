/**
 * Integration tests for the atomic password change: `POST /auth/change-password` commits the
 * credential AND (when supplied) the re-wrapped `password` key-envelope slot in ONE transaction.
 *
 * Coverage:
 *  - a household with no `password` slot commits the credential alone (the
 *    server-confirmed no-slot exception);
 *  - a body with no envelope fields from a household that DOES hold a
 *    `password` slot is refused `409 UPGRADE_REQUIRED`, never performed as a
 *    credential-only change;
 *  - a rejected transaction (stale envelope version) leaves the credential
 *    and the slot set untouched — the old password still signs in, the new
 *    one does neither;
 *  - a committed re-wrap is a REAL cryptographic round trip: the stored tag
 *    authenticates the committed slot set and only the new password unwraps
 *    it, proving the envelope-set meta item landed in the SAME transaction as
 *    the slot (the second-device proxy, since the API itself never validates
 *    wrap cryptography);
 *  - the "mirrored ordering" race — a pending slot write landing inside the
 *    window between the credential write and the completion of session
 *    revocation is rejected by the write-authority CONDITION, never merely
 *    the (not-yet-run) revocation/denylist guard — for both the
 *    change-password commit's own revocation and password-reset's;
 *  - a password slot appearing strictly between the eligibility read and the
 *    credential-only commit's transaction is rejected by the absence
 *    ConditionCheck, not merely the earlier read;
 *  - the MFA-challenge window: a reset landing between login and MFA
 *    completion is rejected under the stale pre-reset revision the challenge
 *    carried;
 *  - ordinary refresh rotation carries the session's write authority forward
 *    unchanged, in BOTH directions — a session that carries a revision keeps
 *    it, and a session that carries none keeps carrying none.
 *
 * Each case uses fresh emails / device IDs so suites stay independent on the
 * shared DynamoDB Local instance.
 */
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

/** A well-formed `password`-type slot body for the given household. */
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

/** Build a `Session` handle from a `login`/`refresh`/`mfa/verify` response, so
 * a "second device"/rotated-session request can reuse `keyEnvelopePut` etc. */
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

// ---------- Real crypto helpers: mirror apps/web/src/crypto/key-
// wrapping.ts's wrap/unwrap/tag construction byte-for-byte — the same AAD
// binding, the same HKDF-derived envelope-set MAC key, and the same full
// canonical slot fields production computes the tag over — so the
// second-device test proves a GENUINE round trip against the actual
// production format, not a scheme that merely round-trips opaque strings
// through storage. Self-contained (Node's WebCrypto): apps/api and apps/web
// are separate workspace packages with no shared crypto module to import. ----------

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Mirrors payload-crypto.ts's `canonicalStringify`: sorted keys at every depth. */
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

/** Mirrors `canonicalJsonBytes`. */
function canonicalJsonBytes(value: unknown): Uint8Array {
  return utf8Bytes(canonicalStringify(value));
}

// Node's `webcrypto.subtle` returns `webcrypto.CryptoKey`, distinct from the
// DOM `lib.dom.d.ts` `CryptoKey` global — alias it so wrap/unwrap signatures
// below don't collide with the ambient DOM type.
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

/** Mirrors `canonicalSlotAad`: binds slotType, kdf and version so a server
 * tampering with any of them fails the unlock closed. */
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

/** Mirrors `derivePasswordWrapKey`'s PBKDF2-HMAC-SHA-256 branch. */
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

/** Mirrors `wrapHdk`: nonce-prefixed AES-256-GCM with the slot-metadata AAD bound in. */
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

/** Mirrors `unwrapHdk`: rejects on the wrong wrap key OR mismatched AAD. */
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

/** Mirrors `deriveEnvelopeMacKey`: HKDF-SHA-256 over the raw HDK, domain-separated
 * by the same `envelope-auth` info label production uses. */
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

/** Mirrors `canonicalEnvelopeSet`: sorted by slotId, reduced to the same
 * integrity-relevant fields production tags (not merely slotId/wrappedKey). */
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

/** Mirrors `computeEnvelopeSetTag`: HMAC-SHA-256 under the HDK-derived MAC key
 * over the canonical slot set + version. */
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

// ---------- MFA-challenge-window helper (test-coverage.1): a minimal
// login-MFA email-OTP completion, independent of `AUTH_MFA_ENFORCED` (the
// flag only gates whether LOGIN issues a challenge; `mfa/email/send` and
// `mfa/verify` are `@Public()` and process any validly-signed challenge
// regardless). Mirrors `mfa.spec.ts`'s `recoverEmailOtp`. ----------

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
    // Give the household a canonical password slot first.
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

    // Nothing changed: the old password still signs in, the new one does not.
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

    // Nothing changed: the old password still signs in.
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

    // Snapshot the stored slot rows (wrappedKey, kdf, the server-stamped
    // slot revision — every field) before the rejected attempt, so the
    // assertion below is exact equality, not merely "old password works".
    const envelopes = t.module.get(HouseholdKeyEnvelopesRepository);
    const rowsBefore = await envelopes.listSlots(sess.householdId, true);
    expect(rowsBefore).toHaveLength(1);

    const res = await changePasswordRequest(t, sess, {
      currentPassword: STRONG_PASSWORD,
      newPassword: STRONGER_PASSWORD,
      slot: passwordSlot(sess.householdId, 'bmV3LXdyYXA'),
      // Deliberately stale: the real current version is 1.
      envelopeSetVersion: 5,
      expectedEnvelopeSetVersion: 4,
      envelopeSetTag: 'tag-v5',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STALE_ENVELOPE_VERSION');

    // Old password still signs in; new password does not.
    const oldPw = await login(t, sess.email, STRONG_PASSWORD);
    expect(oldPw.status).toBe(200);
    const newPw = await login(t, sess.email, STRONGER_PASSWORD);
    expect(newPw.status).toBe(401);

    // The slot rows are byte-for-byte unchanged — an implementation that
    // wrote the replacement slot OUTSIDE the transaction and then failed the
    // credential/meta items would pass the sign-in assertions above while
    // leaving the slot overwritten (and its stored tag/meta inconsistent,
    // locking out every future unlock). The proposed wrap was never stored,
    // and the slot's recorded revision is exactly its pre-request value.
    const rowsAfter = await envelopes.listSlots(sess.householdId, true);
    expect(rowsAfter).toEqual(rowsBefore);
    expect(rowsAfter.some((r) => r.wrappedKey === 'bmV3LXdyYXA')).toBe(false);

    // The envelope-set meta stayed at its pre-request version and tag too
    // (the session's own access token is still valid — nothing was revoked).
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
    // The commit shape is the SERVER's eligibility read in BOTH directions:
    // the legitimate client sends no envelope
    // fields for a no-slot household, so a rewrap-shaped body here is either
    // a stale view of the slot set or a crafted call — committing it would
    // mint a brand-new canonical `password` slot via change-password.
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

    // Nothing changed: no slot was created and the credential is untouched.
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

    // A fresh sign-in with the new password (a "second device" that never saw
    // the change) reads the committed set cold.
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

    // Unwrap with the NEW password, over the production wrap-key derivation
    // AND the production AAD, → the SAME hdk bytes the change committed.
    const fetchedNewWrapKey = await derivePasswordWrapKey(STRONGER_PASSWORD, fetchedKdf);
    const unwrapped = await unwrapHdk(fetchedSlot.wrappedKey, fetchedNewWrapKey, fetchedAad);
    expect(Buffer.from(unwrapped).equals(Buffer.from(hdk))).toBe(true);

    // The tag genuinely authenticates the committed set: recomputing it with
    // the unwrapped HDK, the HKDF-derived MAC key, and the FULL canonical slot
    // fields (not merely slotId/wrappedKey) matches the stored tag — proving
    // the envelope-set meta item landed in the SAME transaction as the slot,
    // not merely that some string round-tripped through storage.
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

    // The OLD password can no longer unwrap the committed slot: its derived
    // wrap key does not authenticate the AES-GCM tag against this ciphertext.
    const oldWrapKeyAttempt = await derivePasswordWrapKey(STRONG_PASSWORD, fetchedKdf);
    await expect(unwrapHdk(fetchedSlot.wrappedKey, oldWrapKeyAttempt, fetchedAad)).rejects.toThrow();
  });

  it('a revoked session cannot lend its recorded write authority to a request bearing a DIFFERENT (live) session\'s access token', async () => {
    // Two live sessions for the same account (two devices). `sessA` will be
    // logged out (revoked); `sessB` stays live throughout.
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

    // Revoke sessA (logout): its refresh row is marked revoked and its own
    // access-token jti is denylisted.
    const logout = await request(t.app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Authorization', `Bearer ${sessA.accessToken}`)
      .set('X-CSRF-Token', sessA.csrfValue)
      .set('Cookie', [sessA.refreshCookie, sessA.csrfCookie].join('; '));
    expect(logout.status).toBe(204);

    // Present sessB's (live, unrevoked) BEARER token together with sessA's (revoked) refresh cookie
    // — the retained-cookie lending vector: the resolver must never hand sessA's recorded row to a
    // request bearing a different session's access token, nor to a revoked one, regardless of which
    // cookie physically arrives.
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
    // Fire the pending write from INSIDE `revokeAllSessions`, before its
    // `revokeFamily` call executes — the window between the reset's credential
    // rotation (already committed by `commitConsume`) and the completion of
    // session revocation. Previously this was the ONE
    // placement where the JWT guard's jti-denylist / row-revocation check
    // could not pre-empt the credential ConditionCheck (the
    // prior version of this test accepted either 401 or 409). The account
    // generation bump now lands FIRST, as the actual linearization point
    // (`SessionRevocationService.revokeAll`, before this `revokeFamily` call
    // even starts) — so the guard now rejects this session's access token
    // outright, and the credential ConditionCheck this test used to reach
    // never runs at all.
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
      // Reset the password via the token flow (rotates the credential — a
      // DIFFERENT path than change-password — while `sess` stays alive).
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

    // The retired session generation — not the credential write-authority
    // condition — is what rejected it (the
    // generation bump is the linearization point, ahead of the cleanup sweep
    // this spy is inside of).
    expect(pendingStatus).toBe(401);
    expect(pendingBody?.error?.code).toBe('ACCESS_TOKEN_REVOKED');

    // No slot was written under the superseded session's authority: the
    // household still holds only the ORIGINAL (pre-reset) wrap.
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
    // Recovery-only (no-slot) household: key setup verifies the old password
    // (`sess`'s login already grants this session authority the same way).
    const sess = await signupVerifyLogin(t);

    const refreshTokens = t.module.get(RefreshTokensRepository);
    const originalRevokeFamily = refreshTokens.revokeFamily.bind(refreshTokens);
    let pendingStatus: number | undefined;
    let pendingBody: { error?: { code?: string } } | undefined;
    const spy = jest
      .spyOn(refreshTokens, 'revokeFamily')
      .mockImplementation(async (...args: Parameters<typeof originalRevokeFamily>) => {
        // The credential-only commit has already landed (change() calls
        // `commitChangeTransaction` before `revokeFamily`) but this session's
        // refresh row is not yet revoked and its jti is not yet denylisted.
        // Previously this was the named window; the
        // account generation bump (`SessionRevocationService.revokeAll`, ahead
        // of this `revokeFamily` call) has ALREADY landed by the time this
        // callback runs, so a pending key-setup slot write from the SAME
        // (now-superseded) session is rejected at the guard, not by the
        // envelope write's own condition.
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
      // A credential-only change commits (no envelope fields — the
      // server-confirmed no-slot exception).
      const res = await changePasswordRequest(t, sess, {
        currentPassword: STRONG_PASSWORD,
        newPassword: STRONGER_PASSWORD,
      });
      expect(res.status).toBe(200);
    } finally {
      spy.mockRestore();
    }

    // The retired session generation — checked at the guard, ahead of the
    // (not-yet-run) revocation sweep and the envelope write's own revision
    // condition — rejected the pending write.
    expect(pendingStatus).toBe(401);
    expect(pendingBody?.error?.code).toBe('ACCESS_TOKEN_REVOKED');

    // No old-password-wrapped slot was left: the household holds no slot at
    // all (the credential-only commit never writes one).
    const relog = await request(t.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ email: sess.email, password: STRONGER_PASSWORD, deviceId: freshDeviceId() });
    expect(relog.status).toBe(200);
    const get = await request(t.app.getHttpServer())
      .get('/api/v1/auth/key-envelopes')
      .set('Authorization', `Bearer ${relog.body.accessToken}`);
    expect(get.body.slots).toEqual([]);

    // Setup succeeds only after re-verifying the new password: a fresh
    // session (from the re-login above, which itself carries the just-minted
    // revision) can complete the write.
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
        // Land a password slot strictly BETWEEN this eligibility read and the
        // credential-only transaction's commit — via a real concurrent-style
        // PUT (not a direct repository write), so the assertion below proves
        // the transactional ConditionCheck rejects it, not the earlier read
        // (which already returned its — now stale — empty result).
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

    // The household stays entirely on the old password.
    const oldPw = await login(t, sess.email, STRONG_PASSWORD);
    expect(oldPw.status).toBe(200);
    const newPw = await login(t, sess.email, STRONGER_PASSWORD);
    expect(newPw.status).toBe(401);
  });

  it('MFA challenge window: a reset landing between login and MFA completion revokes the stale-generation challenge outright', async () => {
    const sess = await signupVerifyLogin(t);
    const mfaChallenges = t.module.get(MfaChallengeService);

    // A challenge signed as if MFA had been enforced at signup's login —
    // generation 0, the account's session generation before any account-wide
    // revoke has ever run for it.
    const staleChallenge = mfaChallenges.sign(sess.userId, sess.deviceId, 'rev-at-signup', 0);

    // A reset lands INSIDE the challenge window: `revokeAll` bumps + tombstones
    // generation 0 -> 1.
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

    // `mfa/email/send` does not consult the generation (it only reads the
    // challenge's userId), so the code still sends...
    const send = await request(t.app.getHttpServer())
      .post('/api/v1/auth/mfa/email/send')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ challengeToken: staleChallenge });
    expect(send.status).toBe(202);
    const code = await recoverEmailOtp(t, sess.userId);

    // ...but completion is rejected outright: the challenge's generation (0)
    // was retired by the reset, so no session is minted at all — the reset's
    // whole point is that proof gathered before it cannot survive it.
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
    // The rotated session still carries the same write authority — accepted.
    expect(putAfterRefresh.status).toBe(204);
  });

  it('a chain that began carrying NO recorded revision still carries none after a refresh, and its slot write is still rejected', async () => {
    const sess = await signupVerifyLogin(t);

    // Strip the recorded revision from `sess`'s refresh row directly — the
    // shape every session alive at rollout carries.
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

    // The no-revision session's OWN write is rejected.
    const writeBeforeRefresh = await keyEnvelopePut(t, sess, 'password', {
      slot: passwordSlot(sess.householdId),
      envelopeSetVersion: 1,
      expectedEnvelopeSetVersion: 0,
      envelopeSetTag: 'tag-v1',
    });
    expect(writeBeforeRefresh.status).toBe(409);
    expect(writeBeforeRefresh.body.error.code).toBe('UPGRADE_REQUIRED');

    // Refresh rotates the session — `RefreshTokenService.issue` must copy the
    // ABSENCE forward verbatim, never silently default it to something that
    // would grant authority.
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
    // The in-place grant, end to end: controller resolves the session
    // row from the refresh cookie → `VerifyPasswordService.verify` stamps the
    // matched credential's revision on it → a later password-slot write from
    // that SAME session (no re-login, no token exchange) passes the
    // credential ConditionCheck. Exercises the one path no other test covers
    // — the "mirrored ordering" test obtains its authority from a fresh
    // re-login, which `LoginService.issueSession` already grants.
    const sess = await signupVerifyLogin(t);

    // Strip the recorded revision from the live session's refresh row — the
    // shape of a pre-rollout session (or a passwordless-passkey sign-in).
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

    // Without the grant, the write is rejected.
    const writeBefore = await keyEnvelopePut(t, sess, 'password', {
      slot: passwordSlot(sess.householdId),
      envelopeSetVersion: 1,
      expectedEnvelopeSetVersion: 0,
      envelopeSetTag: 'tag-v1',
    });
    expect(writeBefore.status).toBe(409);
    expect(writeBefore.body.error.code).toBe('UPGRADE_REQUIRED');

    // A WRONG password grants nothing: verify fails and the write from the
    // same session stays rejected.
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

    // Verifying the CORRECT current password on that same session stamps its
    // write authority in place (204: no token exchange, no new session)…
    const verify = await verifyPasswordRequest(t, sess, STRONG_PASSWORD);
    expect(verify.status).toBe(204);
    const row = await t.module.get(RefreshTokensRepository).find(sess.userId, tokenHash);
    expect(row?.credentialRevision).toBeDefined();

    // …so the SAME (non-reissued) session's slot write now succeeds.
    const writeAfter = await keyEnvelopePut(t, sess, 'password', {
      slot: passwordSlot(sess.householdId),
      envelopeSetVersion: 1,
      expectedEnvelopeSetVersion: 0,
      envelopeSetTag: 'tag-v1',
    });
    expect(writeAfter.status).toBe(204);
  });
});
