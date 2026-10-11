/**
 * API-integration tests for the factor-change notice + undo: the four controller call sites
 * (passkey add/remove, TOTP add/ remove) and the public `POST /auth/factor-undo/consume` endpoint.
 *
 * SES is disabled by default in `bootstrapTestApp()`, so — unlike the
 * password-reset token, which has an `EXPOSE_VERIFICATION_TOKEN` dev
 * trapdoor — this suite has no way to recover the RAW token a real
 * controller-triggered notify() mints (only its SHA-256 hash is ever
 * persisted). The consume-focused cases below mint their OWN known token and
 * write it directly through `UsersRepository.setPendingFactorUndo` — the same
 * shape `FactorNoticeService.notify` writes — which proves the CONSUME
 * contract (single-use, expiry, credential/TOTP action, all-rows session
 * revoke) without depending on SES. The controller-wiring cases (does
 * enrolling/removing actually call notify) are proven separately, by
 * asserting the pending-undo fields exist after a real HTTP call.
 */
import request from 'supertest';
import { generateSync } from 'otplib';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  STRONG_PASSWORD,
  bootstrapTestApp,
  decodeAccessClaims,
  signupVerifyLogin,
  type Session,
  type TestApp,
  table,
  authSet,
} from './test-helpers.js';
import { sha256 } from '../auth/refresh-token.service.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import { UserMfaRepository } from '../dynamo/user-mfa.repository.js';
import type { FactorUndoKind } from '../auth/factor-notice-mail.js';
import type { PasskeyRow, UserRow } from '../dynamo/types.js';

const ORIGIN = () => process.env.WEB_ORIGIN!;

async function readUser(t: TestApp, userId: string): Promise<UserRow> {
  const r = await t.doc.send(
    new GetCommand({ TableName: table(t, 'TABLE_USER'), Key: { userId } }),
  );
  return r.Item as UserRow;
}

async function isJtiRevoked(t: TestApp, jti: string): Promise<boolean> {
  const r = await t.doc.send(
    new GetCommand({ TableName: table(t, 'TABLE_REVOKED_TOKEN'), Key: { jti } }),
  );
  return r.Item !== undefined;
}

async function insertPasskey(t: TestApp, userId: string, credentialId: string): Promise<void> {
  const row: PasskeyRow = {
    userId,
    credentialId,
    publicKey: 'AAAA',
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
    transports: null,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  await t.module.get(PasskeysRepository).insert(row);
}

/** Mint a fresh raw undo token and persist it directly — bypasses SES. */
async function seedPendingUndo(
  t: TestApp,
  args: {
    userId: string;
    kind: FactorUndoKind;
    credentialId?: string;
    expiresInSec?: number;
  },
): Promise<string> {
  const rawToken = randomBytes(32).toString('base64url');
  const now = new Date();
  await t.module.get(UsersRepository).setPendingFactorUndo({
    userId: args.userId,
    tokenHash: sha256(rawToken),
    expiresAt: Math.floor(now.getTime() / 1000) + (args.expiresInSec ?? 24 * 60 * 60),
    kind: args.kind,
    now: now.toISOString(),
    ...(args.credentialId !== undefined ? { credentialId: args.credentialId } : {}),
  });
  return rawToken;
}

function consume(
  t: TestApp,
  userId: string,
  token: string,
  kind: FactorUndoKind,
): request.Test {
  return request(t.app.getHttpServer())
    .post('/api/v1/auth/factor-undo/consume')
    .set('Origin', ORIGIN())
    .send({ userId, token, kind });
}

async function enrollTotp(t: TestApp, s: Session): Promise<void> {
  const start = await authSet(s)(
    request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/start'),
  ).send({});
  const secret = start.body.secret as string;
  await authSet(s)(request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/confirm'))
    .send({ code: generateSync({ secret }), stepUp: { currentPassword: STRONG_PASSWORD } })
    .expect(200);
}

describe('factor-change notice + undo', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('enrolling TOTP leaves a pending undo (totp_add) on the user row and reports the notice as sent', async () => {
    const s = await signupVerifyLogin(t);
    const start = await authSet(s)(
      request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/start'),
    ).send({});
    const confirm = await authSet(s)(
      request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/confirm'),
    )
      .send({
        code: generateSync({ secret: start.body.secret as string }),
        stepUp: { currentPassword: STRONG_PASSWORD },
      })
      .expect(200);
    // SES is disabled in this harness, so the local-dev log path counts as
    // the mail having been handed off.
    expect(confirm.body).toEqual({ totpEnabled: true, noticeSent: true });

    const user = await readUser(t, s.userId);
    expect(user.pendingFactorUndoKind).toBe('totp_add');
    expect(user.pendingFactorUndoTokenHash).toBeTruthy();
    expect(user.pendingFactorUndoExpiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('disabling TOTP overwrites the pending undo with totp_remove (one outstanding undo)', async () => {
    const s = await signupVerifyLogin(t);
    await enrollTotp(t, s);

    await authSet(s)(request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/disable'))
      .send({ currentPassword: STRONG_PASSWORD })
      .expect(200);

    const user = await readUser(t, s.userId);
    expect(user.pendingFactorUndoKind).toBe('totp_remove');
  });

  it('removing a passkey leaves a pending undo (passkey_remove) with the credentialId', async () => {
    const s = await signupVerifyLogin(t);
    const credentialId = `cred-${randomUUID()}`;
    await insertPasskey(t, s.userId, credentialId);

    const res = await authSet(s)(
      request(t.app.getHttpServer()).post(`/api/v1/auth/passkey/${credentialId}/remove`),
    )
      .send({ currentPassword: STRONG_PASSWORD })
      .expect(200);
    expect(res.body).toEqual({ noticeSent: true });

    const user = await readUser(t, s.userId);
    expect(user.pendingFactorUndoKind).toBe('passkey_remove');
    expect(user.pendingFactorUndoCredentialId).toBe(credentialId);
  });

  it('removing an unknown/already-removed credential does not overwrite a live pending undo', async () => {
    const s = await signupVerifyLogin(t);
    // A real earlier change left a passkey_add undo outstanding.
    const addedCredentialId = `cred-${randomUUID()}`;
    const token = await seedPendingUndo(t, {
      userId: s.userId,
      kind: 'passkey_add',
      credentialId: addedCredentialId,
    });
    const before = await readUser(t, s.userId);

    // A no-op removal of a credential that doesn't exist (idempotent 200,
    // and no notice was minted for it).
    const unknownCredentialId = `cred-${randomUUID()}`;
    const noop = await authSet(s)(
      request(t.app.getHttpServer()).post(`/api/v1/auth/passkey/${unknownCredentialId}/remove`),
    )
      .send({ currentPassword: STRONG_PASSWORD })
      .expect(200);
    expect(noop.body).toEqual({ noticeSent: false });

    // The pending undo is untouched — the original passkey_add link still works.
    const after = await readUser(t, s.userId);
    expect(after.pendingFactorUndoKind).toBe('passkey_add');
    expect(after.pendingFactorUndoCredentialId).toBe(addedCredentialId);
    expect(after.pendingFactorUndoTokenHash).toBe(before.pendingFactorUndoTokenHash);

    const res = await consume(t, s.userId, token, 'passkey_add').expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('claimFactorUndo refuses a token superseded by a newer pending change, and the fresh token still claims correctly', async () => {
    const s = await signupVerifyLogin(t);
    const oldCredentialId = `cred-${randomUUID()}`;
    const staleToken = await seedPendingUndo(t, {
      userId: s.userId,
      kind: 'passkey_add',
      credentialId: oldCredentialId,
    });
    const users = t.module.get(UsersRepository);
    const nowSec = Math.floor(Date.now() / 1000);

    // A newer factor change supersedes the pending undo before the stale
    // link is clicked (one outstanding undo per account).
    const newToken = await seedPendingUndo(t, { userId: s.userId, kind: 'totp_add' });

    // The stale token's claim must fail outright — it must never hand back
    // the OLD kind/credentialId for the caller to act on, even though the
    // row still has a live (different) pending undo. This is what closes
    // the race: FactorNoticeService.consume acts only on what a successful
    // claim returns, never on a plain read taken before the claim.
    const staleClaim = await users.claimFactorUndo({
      userId: s.userId,
      presentedTokenHash: sha256(staleToken),
      presentedKind: 'passkey_add',
      nowSec,
      now: new Date().toISOString(),
    });
    expect(staleClaim).toBeNull();

    // The newer token still claims correctly and is untouched by the failed
    // attempt above.
    const freshClaim = await users.claimFactorUndo({
      userId: s.userId,
      presentedTokenHash: sha256(newToken),
      presentedKind: 'totp_add',
      nowSec,
      now: new Date().toISOString(),
    });
    expect(freshClaim).toEqual({ kind: 'totp_add' });

    // A successful claim does not itself clear the pending fields — that
    // stays UsersRepository.consumeFactorUndo's job (committed together with
    // the undo action), so a retry after a downstream failure can still
    // complete via the same link.
    const afterClaim = await readUser(t, s.userId);
    expect(afterClaim.pendingFactorUndoTokenHash).toBe(sha256(newToken));

    const res = await consume(t, s.userId, newToken, 'totp_add').expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('a token superseded AFTER its claim never acts: the undo aborts with the single-use gate and the newer factor is untouched', async () => {
    const s = await signupVerifyLogin(t);
    await enrollTotp(t, s);
    const staleToken = await seedPendingUndo(t, { userId: s.userId, kind: 'totp_add' });

    // Reproduce the race deterministically: the stale token's claim succeeds,
    // and THEN a newer factor change overwrites the pending undo before the
    // consume commits — the window a destructive write performed as a
    // separate step after the claim would fall into, clearing an
    // authenticator the clicked link was never about.
    const users = t.module.get(UsersRepository);
    const realClaim = users.claimFactorUndo.bind(users);
    let newToken = '';
    const claimSpy = jest
      .spyOn(users, 'claimFactorUndo')
      .mockImplementationOnce(async (args) => {
        const claimed = await realClaim(args);
        newToken = await seedPendingUndo(t, { userId: s.userId, kind: 'totp_add' });
        return claimed;
      });
    try {
      const res = await consume(t, s.userId, staleToken, 'totp_add').expect(200);
      expect(res.body).toEqual({ ok: false });
    } finally {
      claimSpy.mockRestore();
    }

    // TOTP survives (the action and the clear aborted together), the newer
    // token is still the live one, and it still works.
    const mfa = t.module.get(UserMfaRepository);
    expect((await mfa.get(s.userId))?.totpEnabled).toBe(true);
    expect((await readUser(t, s.userId)).pendingFactorUndoTokenHash).toBe(sha256(newToken));

    const fresh = await consume(t, s.userId, newToken, 'totp_add').expect(200);
    expect(fresh.body).toEqual({ ok: true });
    expect((await mfa.get(s.userId))?.totpEnabled).toBe(false);
  });

  it('a failing undo-token persist never fails the already-committed factor change, and sends no notice', async () => {
    const s = await signupVerifyLogin(t);
    const users = t.module.get(UsersRepository);
    const persistSpy = jest
      .spyOn(users, 'setPendingFactorUndo')
      .mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));
    try {
      const start = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/start'),
      ).send({});
      const confirm = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/confirm'),
      )
        .send({
          code: generateSync({ secret: start.body.secret as string }),
          stepUp: { currentPassword: STRONG_PASSWORD },
        })
        .expect(200);
      expect(confirm.body).toEqual({ totpEnabled: true, noticeSent: false });
    } finally {
      persistSpy.mockRestore();
    }

    // The promotion committed; no undo token was stored (and so none mailed).
    expect((await t.module.get(UserMfaRepository).get(s.userId))?.totpEnabled).toBe(true);
    expect((await readUser(t, s.userId)).pendingFactorUndoTokenHash).toBeFalsy();
  });

  it('consuming a passkey_add token removes exactly that credential and leaves others untouched', async () => {
    const s = await signupVerifyLogin(t);
    const credentialId = `cred-${randomUUID()}`;
    const otherCredentialId = `cred-${randomUUID()}`;
    await insertPasskey(t, s.userId, credentialId);
    await insertPasskey(t, s.userId, otherCredentialId);
    const token = await seedPendingUndo(t, { userId: s.userId, kind: 'passkey_add', credentialId });

    const res = await consume(t, s.userId, token, 'passkey_add').expect(200);
    expect(res.body).toEqual({ ok: true });

    const passkeys = t.module.get(PasskeysRepository);
    expect(await passkeys.find(s.userId, credentialId)).toBeNull();
    expect(await passkeys.find(s.userId, otherCredentialId)).not.toBeNull();

    const user = await readUser(t, s.userId);
    expect(user.pendingFactorUndoTokenHash).toBeFalsy();
  });

  it('consuming a totp_add token disables TOTP', async () => {
    const s = await signupVerifyLogin(t);
    await enrollTotp(t, s);
    // Overwrite the real (unrecoverable) token the enroll minted with a known one.
    const token = await seedPendingUndo(t, { userId: s.userId, kind: 'totp_add' });

    await consume(t, s.userId, token, 'totp_add').expect(200);

    const row = await t.module.get(UserMfaRepository).get(s.userId);
    expect(row?.totpEnabled).toBe(false);
  });

  it('a removal token ends sessions and never resurrects the removed factor', async () => {
    const s = await signupVerifyLogin(t);
    const credentialId = `cred-${randomUUID()}`; // already removed in the real flow
    const token = await seedPendingUndo(t, { userId: s.userId, kind: 'passkey_remove', credentialId });

    await consume(t, s.userId, token, 'passkey_remove').expect(200);

    const passkeys = t.module.get(PasskeysRepository);
    expect(await passkeys.find(s.userId, credentialId)).toBeNull();

    const claims = decodeAccessClaims(s.accessToken);
    expect(await isJtiRevoked(t, claims.jti)).toBe(true);
  });

  it('revokes an access-token jti from an ALREADY-REVOKED refresh row (all-rows scope)', async () => {
    const s = await signupVerifyLogin(t);
    const preRotationClaims = decodeAccessClaims(s.accessToken);

    // Rotate once: the OLD refresh row is now revoked (pre-rotation), but its
    // paired access-token jti is untouched by ordinary rotation and still
    // within its TTL — the exact case the all-rows scope must still catch.
    const refresh = await request(t.app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Origin', ORIGIN())
      .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
      .expect(200);
    const rotatedClaims = decodeAccessClaims(refresh.body.accessToken);
    expect(rotatedClaims.jti).not.toBe(preRotationClaims.jti);

    const token = await seedPendingUndo(t, { userId: s.userId, kind: 'passkey_remove' });
    await consume(t, s.userId, token, 'passkey_remove').expect(200);

    expect(await isJtiRevoked(t, preRotationClaims.jti)).toBe(true);
    expect(await isJtiRevoked(t, rotatedClaims.jti)).toBe(true);
  });

  it('the same token used twice: the second call changes nothing and is indistinguishable from an unknown token', async () => {
    const s = await signupVerifyLogin(t);
    const credentialId = `cred-${randomUUID()}`;
    await insertPasskey(t, s.userId, credentialId);
    const token = await seedPendingUndo(t, { userId: s.userId, kind: 'passkey_add', credentialId });

    const first = await consume(t, s.userId, token, 'passkey_add').expect(200);
    expect(first.body).toEqual({ ok: true });
    const second = await consume(t, s.userId, token, 'passkey_add').expect(200);
    expect(second.body).toEqual({ ok: false });
  });

  it('an unknown token revokes no sessions for any account', async () => {
    const control = await signupVerifyLogin(t);
    const strangerToken = randomBytes(32).toString('base64url');

    const res = await consume(t, randomUUID(), strangerToken, 'passkey_remove').expect(200);
    expect(res.body).toEqual({ ok: false });

    const claims = decodeAccessClaims(control.accessToken);
    expect(await isJtiRevoked(t, claims.jti)).toBe(false);
  });

  it('an expired token cannot be consumed', async () => {
    const s = await signupVerifyLogin(t);
    const token = await seedPendingUndo(t, {
      userId: s.userId,
      kind: 'passkey_remove',
      expiresInSec: -1,
    });

    const res = await consume(t, s.userId, token, 'passkey_remove').expect(200);
    expect(res.body).toEqual({ ok: false });
  });

  it('a request with no kind field is rejected by validation, not treated as a valid consume', async () => {
    const s = await signupVerifyLogin(t);
    const token = await seedPendingUndo(t, { userId: s.userId, kind: 'passkey_remove' });

    await request(t.app.getHttpServer())
      .post('/api/v1/auth/factor-undo/consume')
      .set('Origin', ORIGIN())
      .send({ userId: s.userId, token })
      .expect(400);
  });

  it('a kind that does not match the token\'s stored kind is refused with no side effects (a truncated/altered link cannot perform a different action than confirmed)', async () => {
    const s = await signupVerifyLogin(t);
    const credentialId = `cred-${randomUUID()}`;
    await insertPasskey(t, s.userId, credentialId);
    // The stored pending undo is passkey_add; the request claims passkey_remove
    // (e.g. an attacker-modified link fragment, or a page that fell back to
    // the wrong copy).
    const token = await seedPendingUndo(t, { userId: s.userId, kind: 'passkey_add', credentialId });

    const res = await consume(t, s.userId, token, 'passkey_remove').expect(200);
    expect(res.body).toEqual({ ok: false });

    // No side effects: the passkey survives and the pending undo is untouched
    // (the genuine passkey_add link still works).
    const passkeys = t.module.get(PasskeysRepository);
    expect(await passkeys.find(s.userId, credentialId)).not.toBeNull();
    const user = await readUser(t, s.userId);
    expect(user.pendingFactorUndoTokenHash).toBeTruthy();

    const claims = decodeAccessClaims(s.accessToken);
    expect(await isJtiRevoked(t, claims.jti)).toBe(false);
  });
});
