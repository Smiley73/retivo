// Generation-based revocation barrier: a real concurrent request injected inside a jest.spyOn forces each interleaving, with no setTimeout racing.
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

    await meRequest(t, sess.accessToken).expect(200);

    const changed = await changePasswordRequest(t, sess, NEWER_PASSWORD);
    expect(changed.status).toBe(200);

    const after = await meRequest(t, sess.accessToken);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('ACCESS_TOKEN_REVOKED');

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
        // `revokeAll` calls `listAllForUser` only after the generation bump committed, so the presented refresh row is not yet marked revoked here: a
        // refresh at this instant proves the generation ConditionCheck rejects it, not the row's `revokedAt`.
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

    const after = await refreshRequest(t, sess);
    expect(after.status).toBe(401);
  });

  it('single-session logout leaves the account\'s other devices signed in; account-wide revocation does not', async () => {
    const first = await signupVerifyLogin(t);
    const second = await login(t, first.email, STRONG_PASSWORD);

    await request(t.app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Authorization', `Bearer ${first.accessToken}`)
      .set('X-CSRF-Token', first.csrfValue)
      .set('Cookie', [first.refreshCookie, first.csrfCookie].join('; '))
      .expect(204);

    await meRequest(t, first.accessToken).expect(401);
    await meRequest(t, second.accessToken).expect(200);

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
        // Only the first `find` (revokeOne's lookup before it plants the barrier) triggers the race; the interleaved rotation's own `find` on this spy must not recurse.
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

    // The interleaved rotation landed before `revokeOne` planted the family barrier and committed a live descendant: the case only the consistent enumeration after the barrier can catch.
    expect(interleavedStatus).toBe(200);
    expect(interleavedAccessToken).toBeDefined();

    await meRequest(t, interleavedAccessToken!).expect(401);
    const after = await refreshRequest(t, {
      refreshCookie: interleavedRefreshCookie!,
      csrfCookie: sess.csrfCookie,
    });
    expect(after.status).toBe(401);
  });

  it('refresh-token reuse: a descendant created while detection is running is unusable, and another family\'s sessions still work', async () => {
    const sess = await signupVerifyLogin(t);
    // A second family on the same account (another device's login), not another user: family revocation must not be an account-generation bump, which
    // would sign every device out on one device's reuse event, and a second user's session survives either way.
    const second = await login(t, sess.email, STRONG_PASSWORD);

    const rotated = await refreshRequest(t, sess).expect(200);
    const rotatedCookies = parseSetCookies(rotated.headers['set-cookie']);
    const rotatedRefreshCookie = `${REFRESH_COOKIE_NAME}=${encodeURIComponent(rotatedCookies[REFRESH_COOKIE_NAME])}`;

    const refreshTokens = t.module.get(RefreshTokensRepository);
    const originalListFamily = refreshTokens.listFamily.bind(refreshTokens);
    let descendantStatus: number | undefined;
    const spy = jest
      .spyOn(refreshTokens, 'listFamily')
      .mockImplementation(async (...args: Parameters<typeof originalListFamily>) => {
        // The barrier is already planted (rotate() writes it before listFamily), so a rotation with the family's current live token here is the "descendant created during detection" case and must fail the barrier ConditionCheck.
        const descendant = await refreshRequest(t, {
          refreshCookie: rotatedRefreshCookie,
          csrfCookie: sess.csrfCookie,
        });
        descendantStatus = descendant.status;
        return originalListFamily(...args);
      });

    try {
      const reuse = await refreshRequest(t, sess);
      expect(reuse.status).toBe(401);
      expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    } finally {
      spy.mockRestore();
    }

    expect(descendantStatus).toBe(401);

    const liveAfter = await refreshRequest(t, {
      refreshCookie: rotatedRefreshCookie,
      csrfCookie: sess.csrfCookie,
    });
    expect(liveAfter.status).toBe(401);

    // The discriminating assertion: it fails under an account-generation bump, unlike a different user's session, which survives either way.
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

    // A token identical to a real one but without a `sessionGeneration` claim (pre-cutover).
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

    // A row with the real shape but no `sessionGeneration` (legacy).
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

    // Deleting the User row directly (bypassing the account-deletion cascade, which tombstones generation 0) isolates the ConditionCheck's own
    // existence guard: against an absent row `attribute_not_exists(sessionGeneration) AND 0 = 0` is true, the fail-open case `attribute_exists(userId)` closes.
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
          // The account-deletion cascade's refresh-token sweep lands after revokeOne's strongly consistent read and before its conditional `revokedAt` update.
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

    // Without the existence guard that update succeeded against the absent key (`attribute_not_exists(revokedAt)` holds for a missing item) and created a
    // partial row with no `expiresAt` or `tokenFamilyId`: a permanent orphan.
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
          // The sweep lands after `rotate` resolved the presented row and before the issuance transaction, whose fourth item is the predecessor's conditional revoke.
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

    // The predecessor's revoke fails its existence guard, cancelling the whole transaction: no descendant is Put and no partial predecessor is manufactured.
    expect(rotateStatus).toBe(401);
    expect(await refreshTokens.listAllForUser(sess.userId)).toEqual([]);
  });
});
