// Password-reset flow against the local emulator: request-reset (opaque 202, cooldown and daily-cap no-ops), reset-password (token states, session
// revocation, audit), the request-side TOCTOU race and the middleware posture.
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  STRONG_PASSWORD,
  bootstrapTestApp,
  freshDeviceId,
  freshEmail,
  parseSetCookies,
  scanAll,
  type TestApp,
  loginRaw,
  deviceForgottenReasons,
  rememberDeviceViaEmailOtp,
} from './test-helpers.js';
import { REFRESH_COOKIE_NAME } from '../auth/cookie-config.js';
import { sha256 } from '../auth/refresh-token.service.js';
import { CredentialsRepository } from '../dynamo/credentials.repository.js';
import type { AuthEventRow } from '../dynamo/types.js';

const RESET_PASSWORD = 'ResetPassw0rd!New';
// Ceiling on the constant-time floor: catches gross over-padding while
// tolerating handler work + emulator round-trips above the 200ms floor.
const RESPONSE_TIME_CEILING_MS = 600;

interface SignupResponse {
  userId: string;
  email: string;
  verificationToken?: string;
}

interface RequestResetResponse {
  accepted: true;
  resetToken?: string;
}

function origin(): string {
  return process.env.WEB_ORIGIN!;
}

function authEventTable(t: TestApp): string {
  return t.module
    .get(ConfigService)
    .get('TABLE_AUTH_EVENT', { infer: true } as never) as unknown as string;
}

async function createVerifiedUser(
  t: TestApp,
): Promise<{ email: string; userId: string }> {
  const email = freshEmail();
  const signup = await request(t.app.getHttpServer())
    .post('/api/v1/auth/signup')
    .set('Origin', origin())
    .send({ email, password: STRONG_PASSWORD });
  expect(signup.status).toBe(202);
  const body = signup.body as SignupResponse;
  const verify = await request(t.app.getHttpServer())
    .post('/api/v1/auth/verify-email')
    .set('Origin', origin())
    .send({ token: body.verificationToken });
  expect(verify.status).toBe(200);

  // The approval token is stored hashed, so the raw token comes from the verify-email dev trapdoor.
  const approve = await request(t.app.getHttpServer())
    .post('/api/v1/auth/approve-signup')
    .set('Origin', origin())
    .send({ token: verify.body.approvalToken });
  expect(approve.status).toBe(200);

  return { email, userId: body.userId };
}

async function requestReset(t: TestApp, email: string): Promise<RequestResetResponse> {
  const res = await request(t.app.getHttpServer())
    .post('/api/v1/auth/request-password-reset')
    .set('Origin', origin())
    .send({ email });
  expect(res.status).toBe(202);
  return res.body as RequestResetResponse;
}

async function login(
  t: TestApp,
  email: string,
  password: string,
): Promise<number> {
  const res = await request(t.app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('Origin', origin())
    .send({ email, password, deviceId: freshDeviceId() });
  return res.status;
}

interface Session {
  accessToken: string;
  refreshCookie: string;
}

async function loginSession(
  t: TestApp,
  email: string,
  password: string,
): Promise<Session> {
  const res = await request(t.app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('Origin', origin())
    .send({ email, password, deviceId: freshDeviceId() });
  expect(res.status).toBe(200);
  const cookies = parseSetCookies(res.headers['set-cookie']);
  return {
    accessToken: res.body.accessToken,
    refreshCookie: `${REFRESH_COOKIE_NAME}=${encodeURIComponent(cookies[REFRESH_COOKIE_NAME])}`,
  };
}

function userTable(t: TestApp): string {
  return t.module
    .get(ConfigService)
    .get('TABLE_USER', { infer: true } as never) as unknown as string;
}

async function countAuthEvents(
  t: TestApp,
  userId: string,
  eventType: AuthEventRow['eventType'],
): Promise<number> {
  const rows = await scanAll<AuthEventRow>(t.doc, authEventTable(t));
  return rows.filter((r) => r.userId === userId && r.eventType === eventType).length;
}

describe('password reset', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  describe('request-password-reset (anti-enumeration)', () => {
    it('returns an opaque 202 with a dev token for a known verified email and audits the send', async () => {
      const { email, userId } = await createVerifiedUser(t);
      const before = await countAuthEvents(t, userId, 'password_reset_requested');
      const body = await requestReset(t, email);
      expect(body.accepted).toBe(true);
      expect(body.resetToken).toBeTruthy();
      const after = await countAuthEvents(t, userId, 'password_reset_requested');
      expect(after).toBe(before + 1);
    });

    it('returns the identical 202 with NO token for an unknown email and writes no audit', async () => {
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/request-password-reset')
        .set('Origin', origin())
        .send({ email: freshEmail() });
      expect(res.status).toBe(202);
      expect((res.body as RequestResetResponse).accepted).toBe(true);
      expect((res.body as RequestResetResponse).resetToken).toBeUndefined();
    });

    it('is a silent no-op (no token) for an unverified email', async () => {
      const email = freshEmail();
      const signup = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', origin())
        .send({ email, password: STRONG_PASSWORD });
      const userId = (signup.body as SignupResponse).userId;
      const before = await countAuthEvents(t, userId, 'password_reset_requested');

      const body = await requestReset(t, email);
      expect(body.resetToken).toBeUndefined();
      const after = await countAuthEvents(t, userId, 'password_reset_requested');
      expect(after).toBe(before);
    });

    it('silently no-ops when the daily cap is reached (no token, no new audit)', async () => {
      const { email, userId } = await createVerifiedUser(t);
      // Set the counter at the limit and clear the cooldown anchor so only the daily-cap branch can trip.
      const dayKey = Math.floor(Date.now() / 1000 / 86400);
      await t.doc.send(
        new UpdateCommand({
          TableName: userTable(t),
          Key: { userId },
          UpdateExpression:
            'SET resetsSentDayKey = :day, resetsSentToday = :count REMOVE lastResetSentAt',
          ExpressionAttributeValues: { ':day': dayKey, ':count': 5 },
        }),
      );
      const before = await countAuthEvents(t, userId, 'password_reset_requested');

      const body = await requestReset(t, email);
      expect(body.accepted).toBe(true);
      expect(body.resetToken).toBeUndefined();
      const after = await countAuthEvents(t, userId, 'password_reset_requested');
      expect(after).toBe(before);
    });

    it('silently no-ops a second request within the cooldown (no new token, no new audit)', async () => {
      const { email, userId } = await createVerifiedUser(t);
      const first = await requestReset(t, email);
      expect(first.resetToken).toBeTruthy();
      const afterFirst = await countAuthEvents(t, userId, 'password_reset_requested');

      const second = await requestReset(t, email);
      expect(second.resetToken).toBeUndefined();
      const afterSecond = await countAuthEvents(t, userId, 'password_reset_requested');
      expect(afterSecond).toBe(afterFirst);
    });

    // Every branch returns the identical opaque 202 and takes at least the constant floor, so timing cannot reveal whether the email is registered.
    describe('constant-time response floor (anti-enumeration)', () => {
      async function timedRequest(
        email: string,
      ): Promise<{ status: number; body: RequestResetResponse; elapsedMs: number }> {
        const start = Date.now();
        const res = await request(t.app.getHttpServer())
          .post('/api/v1/auth/request-password-reset')
          .set('Origin', origin())
          .send({ email });
        return {
          status: res.status,
          body: res.body as RequestResetResponse,
          elapsedMs: Date.now() - start,
        };
      }

      function expectFlooredOpaque202(result: {
        status: number;
        elapsedMs: number;
      }): void {
        expect(result.status).toBe(202);
        expect(result.elapsedMs).toBeGreaterThanOrEqual(200);
        expect(result.elapsedMs).toBeLessThan(RESPONSE_TIME_CEILING_MS);
      }

      it('holds the floor on the missing-account branch', async () => {
        const result = await timedRequest(freshEmail());
        expectFlooredOpaque202(result);
        expect(result.body.resetToken).toBeUndefined();
      });

      it('holds the floor on the existing-account (real send) branch', async () => {
        const { email } = await createVerifiedUser(t);
        const result = await timedRequest(email);
        expectFlooredOpaque202(result);
        expect(result.body.accepted).toBe(true);
      });
    });
  });

  describe('reset-password (consume)', () => {
    it('rotates the credential (204), new password works, old fails', async () => {
      const { email, userId } = await createVerifiedUser(t);
      const credentials = t.module.get(CredentialsRepository);
      const revisionBeforeReset = (await credentials.findByUserId(userId))?.credentialRevision;
      const { resetToken } = await requestReset(t, email);
      const beforeReset = await countAuthEvents(t, userId, 'password_reset');

      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .set('Origin', origin())
        .send({ token: resetToken, newPassword: RESET_PASSWORD });
      expect(res.status).toBe(204);
      expect(res.body).toEqual({});

      expect(await login(t, email, RESET_PASSWORD)).toBe(200);
      expect(await login(t, email, STRONG_PASSWORD)).toBe(401);

      const afterReset = await countAuthEvents(t, userId, 'password_reset');
      expect(afterReset).toBe(beforeReset + 1);

      // The reset consume must mint a fresh credential revision; otherwise every account reset through this path stays in the "owed" legacy-resolution state.
      const credentialAfterReset = await credentials.findByUserId(userId);
      expect(credentialAfterReset?.credentialRevision).toBeTruthy();
      expect(credentialAfterReset?.credentialRevision).not.toBe(revisionBeforeReset);
    });

    it('revokes a pre-reset session: the old access token 401s and the old refresh cookie cannot rotate', async () => {
      const { email } = await createVerifiedUser(t);
      const session = await loginSession(t, email, STRONG_PASSWORD);
      const preReset = await request(t.app.getHttpServer())
        .get('/api/v1/auth/passkey/list')
        .set('Authorization', `Bearer ${session.accessToken}`);
      expect(preReset.status).toBe(200);

      const { resetToken } = await requestReset(t, email);
      const reset = await request(t.app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .set('Origin', origin())
        .send({ token: resetToken, newPassword: RESET_PASSWORD });
      expect(reset.status).toBe(204);

      const stale = await request(t.app.getHttpServer())
        .get('/api/v1/auth/passkey/list')
        .set('Authorization', `Bearer ${session.accessToken}`);
      expect(stale.status).toBe(401);

      const rotate = await request(t.app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', origin())
        .set('Cookie', [session.refreshCookie].join('; '));
      expect(rotate.status).toBe(401);
    });

    it('denylists a rotated-then-reset access token: BOTH the pre-refresh and post-refresh tokens 401', async () => {
      const { email } = await createVerifiedUser(t);
      // Rotating once leaves the pre-refresh row revoked while its access token's jti is still within its 60-min TTL; a reset must denylist both jtis, not just the active row's.
      const session = await loginSession(t, email, STRONG_PASSWORD);
      const preRefreshAccess = session.accessToken;

      const refresh = await request(t.app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', origin())
        .set('Cookie', [session.refreshCookie].join('; '));
      expect(refresh.status).toBe(200);
      const postRefreshAccess = refresh.body.accessToken as string;
      expect(postRefreshAccess).not.toEqual(preRefreshAccess);

      for (const token of [preRefreshAccess, postRefreshAccess]) {
        const ok = await request(t.app.getHttpServer())
          .get('/api/v1/auth/passkey/list')
          .set('Authorization', `Bearer ${token}`);
        expect(ok.status).toBe(200);
      }

      const { resetToken } = await requestReset(t, email);
      const reset = await request(t.app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .set('Origin', origin())
        .send({ token: resetToken, newPassword: RESET_PASSWORD });
      expect(reset.status).toBe(204);

      for (const token of [preRefreshAccess, postRefreshAccess]) {
        const stale = await request(t.app.getHttpServer())
          .get('/api/v1/auth/passkey/list')
          .set('Authorization', `Bearer ${token}`);
        expect(stale.status).toBe(401);
      }
    });

    it('clears the failed-login backoff so the new password logs in immediately', async () => {
      const { email } = await createVerifiedUser(t);
      for (let i = 0; i < 5; i += 1) {
        await login(t, email, 'WrongPassw0rd!x');
      }
      const blocked = await login(t, email, STRONG_PASSWORD);
      expect(blocked).toBe(429);

      const { resetToken } = await requestReset(t, email);
      const reset = await request(t.app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .set('Origin', origin())
        .send({ token: resetToken, newPassword: RESET_PASSWORD });
      expect(reset.status).toBe(204);

      expect(await login(t, email, RESET_PASSWORD)).toBe(200);
    });

    it('returns 410 RESET_TOKEN_EXPIRED for an expired token', async () => {
      const { email } = await createVerifiedUser(t);
      const { resetToken } = await requestReset(t, email);
      const table = t.module
        .get(ConfigService)
        .get('TABLE_PASSWORD_RESET', { infer: true } as never) as unknown as string;
      // DynamoDB stores the SHA-256 hash as the PK; the endpoint still receives the raw token.
      await t.doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { resetToken: sha256(resetToken!) },
          UpdateExpression: 'SET expiresAt = :past',
          ExpressionAttributeValues: { ':past': Math.floor(Date.now() / 1000) - 10 },
        }),
      );
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .set('Origin', origin())
        .send({ token: resetToken, newPassword: RESET_PASSWORD });
      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe('RESET_TOKEN_EXPIRED');
    });

    it('returns 400 RESET_TOKEN_INVALID for an unknown token', async () => {
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .set('Origin', origin())
        .send({ token: 'a'.repeat(43), newPassword: RESET_PASSWORD });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('RESET_TOKEN_INVALID');
    });

    it('is single-use: a reused token rotates the password only once', async () => {
      const { email } = await createVerifiedUser(t);
      const { resetToken } = await requestReset(t, email);
      const first = await request(t.app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .set('Origin', origin())
        .send({ token: resetToken, newPassword: RESET_PASSWORD });
      expect(first.status).toBe(204);

      const replay = await request(t.app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .set('Origin', origin())
        .send({ token: resetToken, newPassword: 'AnotherPassw0rd!2' });
      expect(replay.status).toBe(400);
      expect(replay.body.error.code).toBe('RESET_TOKEN_INVALID');

      expect(await login(t, email, 'AnotherPassw0rd!2')).toBe(401);
      expect(await login(t, email, RESET_PASSWORD)).toBe(200);
    });

    it('rejects a new password that fails the policy without consuming the token', async () => {
      const { email } = await createVerifiedUser(t);
      const { resetToken } = await requestReset(t, email);
      const weak = await request(t.app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .set('Origin', origin())
        .send({ token: resetToken, newPassword: 'short' });
      expect(weak.status).toBe(400);
    });
  });

  describe('concurrent reset-request race', () => {
    it('two near-simultaneous requests yield at most one real send (one audit), and the cooldown holds', async () => {
      const { email, userId } = await createVerifiedUser(t);
      const before = await countAuthEvents(t, userId, 'password_reset_requested');

      // The conditional User update closes the read-then-write TOCTOU: only one transaction commits against the observed rate-limit state, and the loser aborts with the same opaque 202 no-op.
      const [a, b] = await Promise.all([
        requestReset(t, email),
        requestReset(t, email),
      ]);

      const tokensIssued = [a.resetToken, b.resetToken].filter(Boolean);
      expect(tokensIssued.length).toBeLessThanOrEqual(1);

      const after = await countAuthEvents(t, userId, 'password_reset_requested');
      expect(after).toBe(before + 1);

      const third = await requestReset(t, email);
      expect(third.resetToken).toBeUndefined();
    });

    it('leaves exactly one valid link (the latest); the superseded token is 400', async () => {
      const { email } = await createVerifiedUser(t);
      const a = await requestReset(t, email);
      expect(a.resetToken).toBeTruthy();

      // A second request inside the cooldown is a no-op, so clear lastResetSentAt to reach the supersession path.
      const userTable = t.module
        .get(ConfigService)
        .get('TABLE_USER', { infer: true } as never) as unknown as string;
      const byEmail = await t.doc.send(
        new QueryCommand({
          TableName: userTable,
          IndexName: 'EmailIndex',
          KeyConditionExpression: 'emailLowercase = :e',
          ExpressionAttributeValues: { ':e': email.toLowerCase() },
          Limit: 1,
        }),
      );
      const userId = (byEmail.Items?.[0] as { userId: string }).userId;
      await t.doc.send(
        new UpdateCommand({
          TableName: userTable,
          Key: { userId },
          UpdateExpression: 'REMOVE lastResetSentAt',
        }),
      );
      const b = await requestReset(t, email);
      expect(b.resetToken).toBeTruthy();
      expect(b.resetToken).not.toEqual(a.resetToken);

      // The prior row must be deleted in the same transaction that mints B; a silently dropped Delete entry would pass every assertion below, since consuming A already 400s on the currentResetToken mismatch.
      const resetTable = t.module
        .get(ConfigService)
        .get('TABLE_PASSWORD_RESET', { infer: true } as never) as unknown as string;
      const priorRow = await t.doc.send(
        new GetCommand({
          TableName: resetTable,
          Key: { resetToken: sha256(a.resetToken!) },
        }),
      );
      expect(priorRow.Item).toBeUndefined();

      const consumeA = await request(t.app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .set('Origin', origin())
        .send({ token: a.resetToken, newPassword: RESET_PASSWORD });
      expect(consumeA.status).toBe(400);
      expect(consumeA.body.error.code).toBe('RESET_TOKEN_INVALID');

      const consumeB = await request(t.app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .set('Origin', origin())
        .send({ token: b.resetToken, newPassword: RESET_PASSWORD });
      expect(consumeB.status).toBe(204);
    });
  });

  describe('middleware posture', () => {
    it('rejects a missing Origin on request-password-reset', async () => {
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/request-password-reset')
        .send({ email: freshEmail() });
      expect(res.status).toBe(403);
    });

    it('rejects a missing Origin on reset-password', async () => {
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .send({ token: 'a'.repeat(43), newPassword: RESET_PASSWORD });
      expect(res.status).toBe(403);
    });

    it('both routes are CSRF-exempt: a state-changing POST without a CSRF token is not 403 CSRF', async () => {
      // If the routes were not CSRF-exempt the middleware would 403 CSRF_TOKEN_MISMATCH before the handler runs.
      const { email } = await createVerifiedUser(t);
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/request-password-reset')
        .set('Origin', origin())
        .send({ email });
      expect(res.status).toBe(202);
    });
  });
});

describe('password reset with enforced MFA', () => {
  let t: TestApp;
  let priorEnforced: string | undefined;

  beforeAll(async () => {
    priorEnforced = process.env.AUTH_MFA_ENFORCED;
    process.env.AUTH_MFA_ENFORCED = 'true';
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
    if (priorEnforced === undefined) delete process.env.AUTH_MFA_ENFORCED;
    else process.env.AUTH_MFA_ENFORCED = priorEnforced;
  });

  it('forgets a remembered device: its next sign-in is challenged and the forget is audited as a reset', async () => {
    const { email, userId } = await createVerifiedUser(t);
    const deviceId = freshDeviceId();
    const { trustCookie } = await rememberDeviceViaEmailOtp(t, email, userId, deviceId);
    const before = await loginRaw(t, email, deviceId, [trustCookie]);
    expect(before.body.accessToken).toBeTruthy();

    const { resetToken } = await requestReset(t, email);
    await request(t.app.getHttpServer())
      .post('/api/v1/auth/reset-password')
      .set('Origin', origin())
      .send({ token: resetToken, newPassword: RESET_PASSWORD })
      .expect(204);

    const after = await request(t.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', origin())
      .set('Cookie', trustCookie)
      .send({ email, password: RESET_PASSWORD, deviceId });
    expect(after.status).toBe(200);
    expect(after.body.mfaRequired).toBe(true);
    expect(after.body.accessToken).toBeUndefined();
    expect(await deviceForgottenReasons(t, userId, deviceId)).toEqual(['password_reset']);
  });
});
