/**
 * Integration tests for the generation-based revocation barrier.
 *
 * Forces the interleavings by injecting a
 * real concurrent request inside a `jest.spyOn` on a repository method the
 * flow under test calls partway through — the same deterministic-barrier
 * style `atomic-password-change.spec.ts`'s "mirrored ordering" tests use.
 * Nothing here depends on `setTimeout` racing.
 */
import request from 'supertest';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  STRONG_PASSWORD,
  bootstrapTestApp,
  decodeAccessClaims,
  freshDeviceId,
  parseSetCookies,
  signupVerifyLogin,
  type Session,
  type TestApp,
  login,
} from './test-helpers.js';
import { REFRESH_COOKIE_NAME } from '../auth/cookie-config.js';
import { sha256 } from '../auth/refresh-token.service.js';
import { RefreshTokensRepository } from '../dynamo/refresh-tokens.repository.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import { AccessTokenService } from '../auth/jwt.service.js';
import type { RefreshTokenRow } from '../dynamo/types.js';

const NEWER_PASSWORD = 'NewPassw0rd!Better1';

function changePasswordRequest(t: TestApp, sess: Session, newPassword: string): request.Test {
  return request(t.app.getHttpServer())
    .post('/api/v1/auth/change-password')
    .set('Origin', process.env.WEB_ORIGIN!)
    .set('Authorization', `Bearer ${sess.accessToken}`)
    .set('X-CSRF-Token', sess.csrfValue)
    .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
    .send({ currentPassword: STRONG_PASSWORD, newPassword });
}

/** A protected route that does nothing but require a valid session — proves
 *  guard-level rejection through a real HTTP round trip, not a unit stub. */
function meRequest(t: TestApp, accessToken: string): request.Test {
  return request(t.app.getHttpServer())
    .get('/api/v1/auth/key-envelopes')
    .set('Authorization', `Bearer ${accessToken}`);
}

function refreshRequest(t: TestApp, sess: Pick<Session, 'refreshCookie' | 'csrfCookie'>): request.Test {
  return request(t.app.getHttpServer())
    .post('/api/v1/auth/refresh')
    .set('Origin', process.env.WEB_ORIGIN!)
    .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '));
}

describe('session revocation generation', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('rejects a previously issued access token through a real protected route after account-wide revocation, and a fresh login after the boundary still works', async () => {
    const sess = await signupVerifyLogin(t);

    // Works before.
    await meRequest(t, sess.accessToken).expect(200);

    const changed = await changePasswordRequest(t, sess, NEWER_PASSWORD);
    expect(changed.status).toBe(200);

    // The old access token is rejected after the boundary — through the real
    // guard + a real protected route, not only at the unit level.
    const after = await meRequest(t, sess.accessToken);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('ACCESS_TOKEN_REVOKED');

    // Over-revocation direction: a fresh login for the (still active) account
    // succeeds and its token keeps working.
    const relogin = await login(t, sess.email, NEWER_PASSWORD);
    await meRequest(t, relogin.accessToken).expect(200);
  });

  it('a refresh DURING an account-wide revocation fails to commit and leaves no usable descendant', async () => {
    const sess = await signupVerifyLogin(t);

    const refreshTokens = t.module.get(RefreshTokensRepository);
    const originalListAllForUser = refreshTokens.listAllForUser.bind(refreshTokens);
    let duringStatus: number | undefined;
    const spy = jest
      .spyOn(refreshTokens, 'listAllForUser')
      .mockImplementation(async (...args: Parameters<typeof originalListAllForUser>) => {
        // `SessionRevocationService.revokeAll` calls `listAllForUser` only
        // AFTER the generation bump has already committed (the cleanup
        // sweep) — the presented refresh row itself is not yet marked
        // revoked at this instant. A refresh landing exactly here proves the
        // generation ConditionCheck is what rejects it, not the row's own
        // `revokedAt`.
        const during = await refreshRequest(t, sess);
        duringStatus = during.status;
        return originalListAllForUser(...args);
      });

    try {
      const changed = await changePasswordRequest(t, sess, NEWER_PASSWORD);
      expect(changed.status).toBe(200);
    } finally {
      spy.mockRestore();
    }

    expect(duringStatus).toBe(401);

    // No usable descendant: a refresh with the SAME presented cookie after
    // the boundary also fails.
    const after = await refreshRequest(t, sess);
    expect(after.status).toBe(401);
  });

  it('single-session logout leaves the account\'s other devices signed in; account-wide revocation does not', async () => {
    const first = await signupVerifyLogin(t);
    const second = await login(t, first.email, STRONG_PASSWORD);

    // Logout device A only.
    await request(t.app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Authorization', `Bearer ${first.accessToken}`)
      .set('X-CSRF-Token', first.csrfValue)
      .set('Cookie', [first.refreshCookie, first.csrfCookie].join('; '))
      .expect(204);

    // Device A is dead; device B is untouched.
    await meRequest(t, first.accessToken).expect(401);
    await meRequest(t, second.accessToken).expect(200);

    // Now an account-wide revoke from device B kills device B's own
    // pre-boundary token too (unlike the single-session logout above).
    const changed = await changePasswordRequest(t, second, NEWER_PASSWORD);
    expect(changed.status).toBe(200);
    await meRequest(t, second.accessToken).expect(401);
  });

  it('a rotation racing logout\'s own read still leaves no live descendant', async () => {
    const sess = await signupVerifyLogin(t);

    const refreshTokens = t.module.get(RefreshTokensRepository);
    const originalFind = refreshTokens.find.bind(refreshTokens);
    let fired = false;
    let interleavedStatus: number | undefined;
    let interleavedAccessToken: string | undefined;
    let interleavedRefreshCookie: string | undefined;
    const spy = jest
      .spyOn(refreshTokens, 'find')
      .mockImplementation(async (...args: Parameters<typeof originalFind>) => {
        const row = await originalFind(...args);
        // Only the FIRST `find` (revokeOne's own lookup of the presented row,
        // before it plants the barrier) triggers the race — the interleaved
        // rotation below makes its OWN `find` call on this same spy, which
        // must not recurse.
        if (!fired) {
          fired = true;
          const rotate = await refreshRequest(t, sess);
          interleavedStatus = rotate.status;
          if (rotate.status === 200) {
            interleavedAccessToken = rotate.body.accessToken as string;
            const cookies = parseSetCookies(rotate.headers['set-cookie']);
            interleavedRefreshCookie = `${REFRESH_COOKIE_NAME}=${encodeURIComponent(cookies[REFRESH_COOKIE_NAME])}`;
          }
        }
        return row;
      });

    try {
      await request(t.app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .expect(204);
    } finally {
      spy.mockRestore();
    }

    // The interleaved rotation landed BEFORE `revokeOne` planted the family
    // barrier, so it committed a live descendant — the exact case the
    // barrier-first ordering alone cannot catch (only the consistent
    // enumeration that follows it can).
    expect(interleavedStatus).toBe(200);
    expect(interleavedAccessToken).toBeDefined();

    // No live descendant survives: its access token is denylisted...
    await meRequest(t, interleavedAccessToken!).expect(401);
    // ...and its refresh row was swept into the family revoke, so presenting
    // it again is rejected too (either as already-revoked or as reuse).
    const after = await refreshRequest(t, {
      refreshCookie: interleavedRefreshCookie!,
      csrfCookie: sess.csrfCookie,
    });
    expect(after.status).toBe(401);
  });

  it('refresh-token reuse: a descendant created while detection is running is unusable, and another family\'s sessions still work', async () => {
    const sess = await signupVerifyLogin(t);
    // A SECOND family on the SAME account (a second device's login) — not a
    // different user. Family revocation is scoped to the one family under
    // detection; it must not be expressed as an
    // account-generation bump (that would sign every device out on one
    // device's reuse event), and a second-user assertion can't tell that
    // implementation apart from the correct one (both leave a different
    // user's session untouched).
    const second = await login(t, sess.email, STRONG_PASSWORD);

    // Rotate once: sess's ORIGINAL cookie becomes the reused (already
    // revoked) token; the rotated cookie is the live one.
    const rotated = await refreshRequest(t, sess).expect(200);
    const rotatedCookies = parseSetCookies(rotated.headers['set-cookie']);
    const rotatedRefreshCookie = `${REFRESH_COOKIE_NAME}=${encodeURIComponent(rotatedCookies[REFRESH_COOKIE_NAME])}`;

    const refreshTokens = t.module.get(RefreshTokensRepository);
    const originalListFamily = refreshTokens.listFamily.bind(refreshTokens);
    let descendantStatus: number | undefined;
    const spy = jest
      .spyOn(refreshTokens, 'listFamily')
      .mockImplementation(async (...args: Parameters<typeof originalListFamily>) => {
        // The barrier has already been planted (rotate() writes it before
        // calling listFamily). A rotation attempt using the family's
        // CURRENT live token, landing here, is the "descendant created
        // during detection" case — it must fail the barrier ConditionCheck.
        const descendant = await refreshRequest(t, {
          refreshCookie: rotatedRefreshCookie,
          csrfCookie: sess.csrfCookie,
        });
        descendantStatus = descendant.status;
        return originalListFamily(...args);
      });

    try {
      // Reuse the ORIGINAL (already-rotated-away) cookie — triggers reuse
      // detection.
      const reuse = await refreshRequest(t, sess);
      expect(reuse.status).toBe(401);
      expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    } finally {
      spy.mockRestore();
    }

    expect(descendantStatus).toBe(401);

    // The live rotated token from the same family is now also dead.
    const liveAfter = await refreshRequest(t, {
      refreshCookie: rotatedRefreshCookie,
      csrfCookie: sess.csrfCookie,
    });
    expect(liveAfter.status).toBe(401);

    // A second family on the SAME account is untouched: its access token
    // still authenticates and its refresh cookie still rotates. This is the
    // discriminating assertion — it would FAIL under the forbidden
    // account-generation-bump implementation, unlike a different user's
    // session (which survives either way).
    await meRequest(t, second.accessToken).expect(200);
    await refreshRequest(t, second).expect(200);
  });

  it('the rotated refresh-token row is inserted with its FINAL jti — no setJti read/spread/Put exists to undo a concurrent revocation', async () => {
    const sess = await signupVerifyLogin(t);
    const res = await refreshRequest(t, sess).expect(200);
    const claims = decodeAccessClaims(res.body.accessToken);

    const cookies = parseSetCookies(res.headers['set-cookie']);
    const rawRefreshToken = cookies[REFRESH_COOKIE_NAME];
    const refreshTokens = t.module.get(RefreshTokensRepository);
    const row = await refreshTokens.find(sess.userId, sha256(rawRefreshToken));
    expect(row?.jti).toBe(claims.jti);
  });

  it('cutover: an access token with no sessionGeneration claim, and a refresh row with no stamped generation, are both rejected', async () => {
    const sess = await signupVerifyLogin(t);

    // Access-token side: mint a token identical to a real one except with no
    // `sessionGeneration` claim (a pre-cutover token).
    const tokens = t.module.get(AccessTokenService);
    const legacyAccess = tokens.sign({
      userId: sess.userId,
      householdId: sess.householdId,
      deviceId: sess.deviceId,
      email: sess.email,
    });
    const legacy = await meRequest(t, legacyAccess.token);
    expect(legacy.status).toBe(401);
    expect(legacy.body.error.code).toBe('ACCESS_TOKEN_REVOKED');

    // Refresh-row side: insert a row with the real shape but no
    // `sessionGeneration`, and present a matching raw token.
    const refreshTokens = t.module.get(RefreshTokensRepository);
    const random = randomBytes(48).toString('base64url');
    const rawToken = `${sess.userId}.${random}`;
    const legacyRow: RefreshTokenRow = {
      userId: sess.userId,
      tokenHash: sha256(rawToken),
      tokenFamilyId: randomUUID(),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      revokedAt: null,
      rotatedFrom: null,
      userAgent: null,
      ip: null,
      jti: randomUUID(),
      deviceId: sess.deviceId,
      householdId: sess.householdId,
      createdAt: new Date().toISOString(),
      // sessionGeneration deliberately omitted — legacy shape.
    };
    await refreshTokens.insert(legacyRow);
    const legacyRefresh = await refreshRequest(t, {
      refreshCookie: `${REFRESH_COOKIE_NAME}=${encodeURIComponent(rawToken)}`,
      csrfCookie: sess.csrfCookie,
    });
    expect(legacyRefresh.status).toBe(401);
    expect(legacyRefresh.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('the generation ConditionCheck fails closed against a User row that no longer exists, even at generation 0', async () => {
    const sess = await signupVerifyLogin(t);

    // Delete the User row directly — bypassing the full account-deletion
    // cascade (which itself revokes sessions first, tombstoning generation
    // 0) — to isolate the generation ConditionCheck's OWN existence guard
    // from that tombstone. The presented refresh row still carries
    // generation 0, the account's ONLY generation (no revoke has ever run
    // here): against an absent User row, the bare
    // `SESSION_GENERATION_CONDITION_EXPRESSION` evaluates
    // `attribute_not_exists(sessionGeneration) AND 0 = 0` as TRUE — the
    // fail-OPEN case `attribute_exists(userId)` exists to close.
    const users = t.module.get(UsersRepository);
    await users.deleteByUserId(sess.userId);

    const rotate = await refreshRequest(t, sess);
    expect(rotate.status).toBe(401);
  });

  it('a deleted account\'s still-valid access token stops working, and no re-issuance is possible', async () => {
    const sess = await signupVerifyLogin(t);

    await request(t.app.getHttpServer())
      .delete('/api/v1/auth/account')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Authorization', `Bearer ${sess.accessToken}`)
      .set('X-CSRF-Token', sess.csrfValue)
      .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
      .send({ currentPassword: STRONG_PASSWORD })
      .expect(204);

    await meRequest(t, sess.accessToken).expect(401);

    const relogin = await request(t.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ email: sess.email, password: STRONG_PASSWORD, deviceId: freshDeviceId() });
    expect(relogin.status).toBe(401);
  });

  it('logout racing the account-deletion sweep does not recreate the refresh-token row the sweep removed', async () => {
    const sess = await signupVerifyLogin(t);
    const rawRefreshToken = decodeURIComponent(
      sess.refreshCookie.slice(REFRESH_COOKIE_NAME.length + 1),
    );
    const tokenHash = sha256(rawRefreshToken);

    const refreshTokens = t.module.get(RefreshTokensRepository);
    const originalFind = refreshTokens.find.bind(refreshTokens);
    let fired = false;
    const spy = jest
      .spyOn(refreshTokens, 'find')
      .mockImplementation(async (...args: Parameters<typeof originalFind>) => {
        const row = await originalFind(...args);
        if (!fired) {
          fired = true;
          // `revokeOne`'s strongly consistent read of the presented row has
          // just completed. The account-deletion cascade's refresh-token
          // sweep lands HERE — before `revokeOne`'s conditional `revokedAt`
          // update runs against a key that no longer exists.
          await refreshTokens.deleteAllForUser(sess.userId);
        }
        return row;
      });

    try {
      await request(t.app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .expect(204);
    } finally {
      spy.mockRestore();
    }

    // Before the existence guard, that update SUCCEEDED against the absent
    // key (`attribute_not_exists(revokedAt)` holds for a missing item too)
    // and CREATED a partial row — keys + `revokedAt` only, with no
    // `expiresAt` for TTL to reap and no `tokenFamilyId` for any family
    // sweep to find: a permanent orphan for a deleted account.
    expect(await refreshTokens.find(sess.userId, tokenHash, { consistentRead: true })).toBeNull();
    expect(await refreshTokens.listAllForUser(sess.userId)).toEqual([]);
  });

  it('a rotation whose presented row the account-deletion sweep removed mid-flight commits nothing — no descendant, no recreated predecessor', async () => {
    const sess = await signupVerifyLogin(t);

    const refreshTokens = t.module.get(RefreshTokensRepository);
    const originalFind = refreshTokens.find.bind(refreshTokens);
    let fired = false;
    const spy = jest
      .spyOn(refreshTokens, 'find')
      .mockImplementation(async (...args: Parameters<typeof originalFind>) => {
        const row = await originalFind(...args);
        if (!fired) {
          fired = true;
          // `rotate` has resolved the presented row; the sweep lands before
          // its issuance transaction — whose fourth item is the
          // predecessor's conditional revoke — is committed.
          await refreshTokens.deleteAllForUser(sess.userId);
        }
        return row;
      });

    let rotateStatus: number | undefined;
    try {
      rotateStatus = (await refreshRequest(t, sess)).status;
    } finally {
      spy.mockRestore();
    }

    // The predecessor's revoke item fails its existence guard, cancelling
    // the whole transaction: no descendant row is Put and no partial
    // predecessor is manufactured. Before the guard, the transaction
    // committed BOTH — a 200 with a live descendant for a deleted account,
    // plus the orphan.
    expect(rotateStatus).toBe(401);
    expect(await refreshTokens.listAllForUser(sess.userId)).toEqual([]);
  });
});
