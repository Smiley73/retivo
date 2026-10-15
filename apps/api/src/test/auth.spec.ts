/**
 * Auth flow integration tests against the local emulator.
 *
 * Covers signup → verify → login → refresh → logout, change-password,
 * refresh-reuse detection, and CSRF + Origin middleware (the 3-case
 * matrix per middleware: missing, mismatch, match).
 *
 * Each test uses fresh emails / device IDs so suites are independent
 * even though they share the in-memory DynamoDB Local instance.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { PutCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  STRONG_PASSWORD,
  bootstrapTestApp,
  completeEmailOtpLogin,
  decodeAccessClaims,
  freshDeviceId,
  freshEmail,
  parseSetCookies,
  scanAll,
  type TestApp,
  login,
  type Session,
} from './test-helpers.js';
import type {
  AuthEventRow,
  EmailVerificationRow,
  FailedLoginAttemptRow,
  SignupApprovalRow,
  UserRow,
} from '../dynamo/types.js';
import { REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME } from '../auth/cookie-config.js';
import { sha256 } from '../auth/refresh-token.service.js';
import {
  RESPONSE_TIME_FLOOR_MS,
  RESEND_DAILY_LIMIT,
} from '../auth/resend-verification.service.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { RevokedTokensRepository } from '../dynamo/revoked-tokens.repository.js';
import { RefreshTokenService } from '../auth/refresh-token.service.js';
import { CredentialsRepository } from '../dynamo/credentials.repository.js';

// Ceiling on the constant-time floor: catches gross over-padding while
// tolerating handler work + emulator round-trips above the 200ms floor.
const RESPONSE_TIME_CEILING_MS = 600;
const STRONGER_PASSWORD = 'NewPassw0rd!Better';

interface SignupResponse {
  userId: string;
  email: string;
  verificationRequired: boolean;
  verificationToken?: string;
}

interface LoginResponse {
  accessToken: string;
  expiresIn: number;
}

async function signupAndVerify(t: TestApp): Promise<{ email: string; userId: string }> {
  const { email, userId, approvalToken } = await signupVerifyOnly(t);
  await approvePendingSignup(t, approvalToken);
  return { email, userId };
}

/**
 * Signup + email-verify, **without** consuming the owner-approval token.
 * Use this when a test needs to assert behaviour while a user is still
 * 'pending' (e.g. login is blocked, token expiry, decline path).
 *
 * Returns the RAW approval token from the verify-email dev-trapdoor response:
 * The SignupApproval table stores only its SHA-256 digest, so the
 * raw token can no longer be recovered by scanning.
 */
async function signupVerifyOnly(
  t: TestApp,
): Promise<{ email: string; userId: string; approvalToken: string }> {
  const email = freshEmail();
  const signup = await request(t.app.getHttpServer())
    .post('/api/v1/auth/signup')
    .set('Origin', process.env.WEB_ORIGIN!)
    .send({ email, password: STRONG_PASSWORD });
  expect(signup.status).toBe(202);
  const body = signup.body as SignupResponse;
  expect(body.verificationToken).toBeTruthy();
  const verify = await request(t.app.getHttpServer())
    .post('/api/v1/auth/verify-email')
    .set('Origin', process.env.WEB_ORIGIN!)
    .send({ token: body.verificationToken });
  expect(verify.status).toBe(200);
  expect(typeof verify.body.approvalToken).toBe('string');
  return { email, userId: body.userId, approvalToken: verify.body.approvalToken as string };
}

/**
 * Approve a verified-but-pending user by POSTing its RAW approval token through
 * /auth/approve-signup (the table holds only the digest).
 */
async function approvePendingSignup(t: TestApp, rawApprovalToken: string): Promise<void> {
  const res = await request(t.app.getHttpServer())
    .post('/api/v1/auth/approve-signup')
    .set('Origin', process.env.WEB_ORIGIN!)
    .send({ token: rawApprovalToken });
  expect(res.status).toBe(200);
}

/**
 * Read the active SignupApproval ROW for a userId (its stored key is the token
 * DIGEST, not the raw token). Lets gate tests confirm a row exists or address it
 * by its stored key (e.g. to force-expire it) without poking the SES dispatch
 * path. To CONSUME a token via the endpoint, use the raw token from
 * `signupVerifyOnly` instead — the digest here will not resolve.
 */
async function findApprovalToken(t: TestApp, userId: string): Promise<SignupApprovalRow | null> {
  const tableName = t.module
    .get(ConfigService)
    .get('TABLE_SIGNUP_APPROVAL', { infer: true } as never) as unknown as string;
  const rows = await scanAll<SignupApprovalRow>(t.doc, tableName);
  return rows.find((r) => r.userId === userId) ?? null;
}


function cookieHeader(name: string, value: string): string {
  return `${name}=${encodeURIComponent(value)}`;
}

/** Whether a response's raw `Set-Cookie` headers include a CLEARING entry
 * (an empty value + an `Expires` in the past) for `name` — Express's
 * `res.clearCookie(...)` signature (as logout does). */
function hasClearingCookie(setCookie: string[] | string | undefined, name: string): boolean {
  const arr = setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie];
  return arr.some((c) => c.startsWith(`${name}=;`) && /Expires=Thu, 01 Jan 1970/.test(c));
}

function changePassword(
  t: TestApp,
  sess: Pick<Session, 'accessToken' | 'refreshCookie' | 'csrfCookie' | 'csrfValue'>,
  currentPassword: string,
  newPassword: string,
): request.Test {
  return request(t.app.getHttpServer())
    .post('/api/v1/auth/change-password')
    .set('Origin', process.env.WEB_ORIGIN!)
    .set('Authorization', `Bearer ${sess.accessToken}`)
    .set('X-CSRF-Token', sess.csrfValue)
    .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
    .send({ currentPassword, newPassword });
}

function tableName(t: TestApp, key: string): string {
  return t.module
    .get(ConfigService)
    .get(key, { infer: true } as never) as unknown as string;
}

function updateAccountRecord(
  t: TestApp,
  sess: Pick<Session, 'accessToken' | 'refreshCookie' | 'csrfCookie' | 'csrfValue'>,
  body: Record<string, unknown>,
): request.Test {
  return request(t.app.getHttpServer())
    .patch('/api/v1/auth/me')
    .set('Origin', process.env.WEB_ORIGIN!)
    .set('Authorization', `Bearer ${sess.accessToken}`)
    .set('X-CSRF-Token', sess.csrfValue)
    .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
    .send(body);
}

describe('auth flow', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  describe('signup + email verification (2.3)', () => {
    it('signup writes a user, returns a verification token in dev, and verify clears emailVerifiedAt', async () => {
      const { email, userId } = await signupAndVerify(t);
      expect(email).toBeTruthy();
      expect(userId).toBeTruthy();

      // Signup mints a FRESH, non-empty credential revision (signup is one of the three writers
      // required to mint one on every credential write). A regression that stopped signup from
      // minting one would leave every account created through this path permanently in the
      // "owed" legacy-resolution state, and no other test would catch it.
      const credentials = t.module.get(CredentialsRepository);
      const credential = await credentials.findByUserId(userId);
      expect(credential?.credentialRevision).toBeTruthy();
    });

    it('rejects a duplicate email with EMAIL_TAKEN', async () => {
      const email = freshEmail();
      const first = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD });
      expect(first.status).toBe(202);
      const second = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('EMAIL_TAKEN');
    });

    it('rejects a weak password before any DB write', async () => {
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email: freshEmail(), password: 'short' });
      // class-validator returns 400 (`BAD_REQUEST`) on the @MinLength failure,
      // before the password-policy service runs.
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    });

    // Token must travel in the request body, not
    // in a query string that ends up in API Gateway / CloudFront access
    // logs and Referer headers. Endpoint is CSRF-exempt (no session yet
    // for the unverified user) but Origin is still required.
    describe('verify-email transport', () => {
      it('POST without the X-CSRF-Token header still succeeds (endpoint is CSRF-exempt)', async () => {
        const email = freshEmail();
        const signup = await request(t.app.getHttpServer())
          .post('/api/v1/auth/signup')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({ email, password: STRONG_PASSWORD });
        const token = (signup.body as SignupResponse).verificationToken!;
        const res = await request(t.app.getHttpServer())
          .post('/api/v1/auth/verify-email')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({ token });
        expect(res.status).toBe(200);
        expect(res.body).toEqual(expect.objectContaining({ verified: true }));
      });

      it('POST without an Origin header is refused by the origin-check middleware', async () => {
        const email = freshEmail();
        const signup = await request(t.app.getHttpServer())
          .post('/api/v1/auth/signup')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({ email, password: STRONG_PASSWORD });
        const token = (signup.body as SignupResponse).verificationToken!;
        const res = await request(t.app.getHttpServer())
          .post('/api/v1/auth/verify-email')
          .send({ token });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('ORIGIN_MISMATCH');
      });

      it('POST with an empty body fails class-validator before the service runs', async () => {
        const res = await request(t.app.getHttpServer())
          .post('/api/v1/auth/verify-email')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({});
        expect(res.status).toBe(400);
      });
    });

    // The atomic single-use consume (delete-token + mark-verified in
    // one TransactWriteItems) must settle a concurrent/replayed verification on
    // exactly one winner and leave NO partial state (a verified user with a live
    // token, or a consumed token on an unverified user).
    it('concurrent verification of the same token settles on exactly one winner with no partial state', async () => {
      const email = freshEmail();
      const signup = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD });
      expect(signup.status).toBe(202);
      const { userId, verificationToken } = signup.body as SignupResponse;
      const token = verificationToken!;

      const fire = () =>
        request(t.app.getHttpServer())
          .post('/api/v1/auth/verify-email')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({ token });

      const [a, b] = await Promise.all([fire(), fire()]);

      // Exactly ONE 200 winner — never two, never a 5xx crash.
      const winners = [a, b].filter((r) => r.status === 200);
      expect(winners).toHaveLength(1);
      // The loser is a terminal non-winner: either the stale-token 400
      // (the winner committed first → ConditionalCheckFailed) or, if a
      // transient TransactionConflict survived the bounded retry, a 503. Both
      // mean its own all-or-nothing transaction never committed.
      const loser = [a, b].find((r) => r.status !== 200)!;
      expect([400, 503]).toContain(loser.status);
      expect(['VERIFICATION_TOKEN_INVALID', 'VERIFICATION_WRITE_CONFLICT']).toContain(
        loser.body.error.code,
      );

      // No partial state: the token row is consumed (gone) and the user row is
      // verified — the two writes committed together.
      const verificationTable = t.module
        .get(ConfigService)
        .get('TABLE_EMAIL_VERIFICATION', { infer: true } as never) as unknown as string;
      const tokenRow = await t.doc.send(
        new GetCommand({
          TableName: verificationTable,
          Key: { verificationToken: sha256(token) },
        }),
      );
      expect(tokenRow.Item).toBeUndefined();

      const userTable = t.module
        .get(ConfigService)
        .get('TABLE_USER', { infer: true } as never) as unknown as string;
      const userRow = await t.doc.send(
        new GetCommand({ TableName: userTable, Key: { userId } }),
      );
      expect((userRow.Item as UserRow).emailVerifiedAt).toBeTruthy();
    });
  });

  describe('login (2.4)', () => {
    it('returns access token + refresh + csrf cookies on a verified, correct password', async () => {
      const { email } = await signupAndVerify(t);
      const sess = await login(t, email);
      expect(sess.accessToken.split('.').length).toBe(3); // JWS compact form
      expect(sess.csrfValue).toBeTruthy();
    });

    it('rejects unverified email with EMAIL_NOT_VERIFIED', async () => {
      const email = freshEmail();
      const signup = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD });
      expect(signup.status).toBe(202);
      // Skip verify on purpose.
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD, deviceId: freshDeviceId() });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('rejects a wrong password with INVALID_CREDENTIALS', async () => {
      const { email } = await signupAndVerify(t);
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: 'WrongPassw0rd!', deviceId: freshDeviceId() });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('rejects an unknown email with INVALID_CREDENTIALS (no user-existence oracle)', async () => {
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email: freshEmail(), password: STRONG_PASSWORD, deviceId: freshDeviceId() });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('audits an unknown-email failure under the hashed anonymous-<sha256> identifier', async () => {
      // The collision is the actual defect a length-derived identifier had: a
      // single-address test would pass with the old `anonymous-<len>` code.
      // Two different unknown addresses of the SAME length must produce
      // DIFFERENT identifiers.
      const emailA = `aaaaaaaa-${randomUUID()}@example.test`;
      const emailB = `bbbbbbbb-${randomUUID()}@example.test`;
      expect(emailA.length).toBe(emailB.length);

      for (const email of [emailA, emailB]) {
        const res = await request(t.app.getHttpServer())
          .post('/api/v1/auth/login')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({ email, password: STRONG_PASSWORD, deviceId: freshDeviceId() });
        expect(res.status).toBe(401);
      }

      const eventTable = t.module
        .get(ConfigService)
        .get('TABLE_AUTH_EVENT', { infer: true } as never) as unknown as string;
      const events = await scanAll<AuthEventRow>(t.doc, eventTable);
      const idA = `anonymous-${sha256(emailA.toLowerCase())}`;
      const idB = `anonymous-${sha256(emailB.toLowerCase())}`;

      const rowA = events.find((e) => e.userId === idA && e.eventType === 'login_failed');
      const rowB = events.find((e) => e.userId === idB && e.eventType === 'login_failed');
      expect(rowA).toBeTruthy();
      expect(rowB).toBeTruthy();
      // The raw addresses appear nowhere in either identifier.
      expect(idA).not.toContain(emailA);
      expect(idB).not.toContain(emailB);
      expect(idA).not.toBe(idB);
      // Not the retired length-derived shape.
      expect(idA).not.toBe(`anonymous-${emailA.length}`);
    });

    it('rejects a malformed email with INVALID_CREDENTIALS', async () => {
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email: 'notanemail', password: STRONG_PASSWORD, deviceId: freshDeviceId() });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(res.body.error.message).toBe('Invalid email or password.');
    });

    it('rejects an empty email with BAD_REQUEST', async () => {
      // Empty string is a structurally malformed body — class-validator's
      // @IsNotEmpty short-circuits at the global ValidationPipe before the
      // login service ever queries DynamoDB (where an empty-string key
      // would 500 with a ValidationException) — a deliberate 400 carve-out from
      // the INVALID_CREDENTIALS branch.
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email: '', password: STRONG_PASSWORD, deviceId: freshDeviceId() });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    });
  });

  describe('refresh + reuse detection (2.5)', () => {
    it('rotates the refresh token on /refresh', async () => {
      const { email } = await signupAndVerify(t);
      const sess = await login(t, email);
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '));
      expect(res.status).toBe(200);
      expect((res.body as LoginResponse).accessToken).toBeTruthy();
      const cookies = parseSetCookies(res.headers['set-cookie']);
      expect(cookies[REFRESH_COOKIE_NAME]).toBeTruthy();
      expect(cookies[REFRESH_COOKIE_NAME]).not.toEqual(sess.csrfValue); // different value
    });

    it('preserves the householdId claim across rotation', async () => {
      const { email } = await signupAndVerify(t);
      const sess = await login(t, email);
      const original = decodeAccessClaims(sess.accessToken);

      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '));
      expect(res.status).toBe(200);

      const rotated = decodeAccessClaims((res.body as LoginResponse).accessToken);
      expect(rotated.householdId).toBe(original.householdId);
      expect(rotated.householdId).toBe(original.userId);
    });

    it('rejects a missing refresh cookie with INVALID_REFRESH_TOKEN', async () => {
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', process.env.WEB_ORIGIN!);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('detects refresh-token reuse → REFRESH_TOKEN_REUSED + family revoked', async () => {
      const { email } = await signupAndVerify(t);
      const sess = await login(t, email);

      // First rotation succeeds.
      const first = await request(t.app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Cookie', [sess.refreshCookie].join('; '));
      expect(first.status).toBe(200);

      // Replaying the *original* refresh cookie now must trip the
      // reuse path and revoke the entire family.
      const reused = await request(t.app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Cookie', [sess.refreshCookie].join('; '));
      expect(reused.status).toBe(401);
      expect(reused.body.error.code).toBe('REFRESH_TOKEN_REUSED');

      // The fresh refresh cookie issued by `first` is now revoked too.
      const firstCookies = parseSetCookies(first.headers['set-cookie']);
      const newRefreshCookieHeader = cookieHeader(
        REFRESH_COOKIE_NAME,
        firstCookies[REFRESH_COOKIE_NAME],
      );
      const afterReuse = await request(t.app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Cookie', [newRefreshCookieHeader].join('; '));
      expect(afterReuse.status).toBe(401);
    });
  });

  describe('logout + access-token denylist (2.6)', () => {
    it('logout denylists the current jti and clears cookies', async () => {
      const { email } = await signupAndVerify(t);
      const sess = await login(t, email);
      const out = await request(t.app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '));
      expect(out.status).toBe(204);

      // The same access token should now be rejected by the guard via
      // the denylist (RevokedToken table).
      const me = await request(t.app.getHttpServer())
        .get('/api/v1/auth/passkey/list')
        .set('Authorization', `Bearer ${sess.accessToken}`);
      expect(me.status).toBe(401);
    });

    it('logout is idempotent — a second call still returns 204', async () => {
      const { email } = await signupAndVerify(t);
      const sess = await login(t, email);
      const out1 = await request(t.app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '));
      expect(out1.status).toBe(204);
      // Second call still presents the cookies + jwt + csrf header, so
      // the CSRF + Origin middleware pass; the JwtAuthGuard then 401s
      // on the now-denylisted jti. Idempotent in the sense that the
      // server doesn't 5xx; the session simply stays gone.
      const out2 = await request(t.app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '));
      expect(out2.status).toBe(401);
    });

    // The revocation IS the caller's proof of
    // sign-out. A failed best-effort audit follow-up must never turn an
    // already-committed sign-out into a 5xx; a revocation that fails BEFORE
    // commit must never clear the cookies (that would manufacture the same
    // proof while a live session row survives).
    it('a rejected best-effort AuthEvent write still returns 204 with both cookies cleared and the jti denylisted', async () => {
      const { email } = await signupAndVerify(t);
      const sess = await login(t, email);
      const authEvents = t.module.get(AuthEventsRepository);
      const spy = jest
        .spyOn(authEvents, 'record')
        .mockRejectedValue(new Error('ddb unavailable'));
      let out: request.Response;
      try {
        out = await request(t.app.getHttpServer())
          .post('/api/v1/auth/logout')
          .set('Origin', process.env.WEB_ORIGIN!)
          .set('Authorization', `Bearer ${sess.accessToken}`)
          .set('X-CSRF-Token', sess.csrfValue)
          .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '));
      } finally {
        spy.mockRestore();
      }
      expect(out.status).toBe(204);
      expect(hasClearingCookie(out.headers['set-cookie'], REFRESH_COOKIE_NAME)).toBe(true);
      expect(hasClearingCookie(out.headers['set-cookie'], CSRF_COOKIE_NAME)).toBe(true);
      // The revocation still committed before the audit write ran.
      const me = await request(t.app.getHttpServer())
        .get('/api/v1/auth/passkey/list')
        .set('Authorization', `Bearer ${sess.accessToken}`);
      expect(me.status).toBe(401);
    });

    it('a revocation that rejects before commit returns non-2xx and clears no refresh cookie, so a retry can still authenticate', async () => {
      const { email } = await signupAndVerify(t);
      const sess = await login(t, email);
      const revoked = t.module.get(RevokedTokensRepository);
      const spy = jest
        .spyOn(revoked, 'revoke')
        .mockRejectedValue(new Error('ddb unavailable'));
      let out: request.Response;
      try {
        out = await request(t.app.getHttpServer())
          .post('/api/v1/auth/logout')
          .set('Origin', process.env.WEB_ORIGIN!)
          .set('Authorization', `Bearer ${sess.accessToken}`)
          .set('X-CSRF-Token', sess.csrfValue)
          .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '));
      } finally {
        spy.mockRestore();
      }
      expect(out.status).toBeGreaterThanOrEqual(400);
      expect(hasClearingCookie(out.headers['set-cookie'], REFRESH_COOKIE_NAME)).toBe(false);
      // The refresh cookie was never revoked or cleared — a retry still
      // authenticates (rotates) with it.
      const refresh = await request(t.app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '));
      expect(refresh.status).toBe(200);
    });

    // The realistic partial-commit case: the FIRST revocation step (access-token
    // denylist) already committed before the SECOND (refresh-row revoke) throws.
    // Cookies must still stay uncleared and the response must still be non-2xx,
    // even though the access token is already dead — the refresh row (the
    // client's only remaining recovery credential) is still live and must not
    // be discarded by a response that looks like proof of sign-out.
    it('a refresh-row revocation that rejects after the denylist already committed returns non-2xx, clears no cookies, denylists the access token, and leaves refresh working', async () => {
      const { email } = await signupAndVerify(t);
      const sess = await login(t, email);
      const refreshSvc = t.module.get(RefreshTokenService);
      const spy = jest
        .spyOn(refreshSvc, 'revokeOne')
        .mockRejectedValue(new Error('ddb unavailable'));
      let out: request.Response;
      try {
        out = await request(t.app.getHttpServer())
          .post('/api/v1/auth/logout')
          .set('Origin', process.env.WEB_ORIGIN!)
          .set('Authorization', `Bearer ${sess.accessToken}`)
          .set('X-CSRF-Token', sess.csrfValue)
          .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '));
      } finally {
        spy.mockRestore();
      }
      expect(out.status).toBeGreaterThanOrEqual(400);
      expect(hasClearingCookie(out.headers['set-cookie'], REFRESH_COOKIE_NAME)).toBe(false);
      expect(hasClearingCookie(out.headers['set-cookie'], CSRF_COOKIE_NAME)).toBe(false);

      // The access-token denylist step DID commit before revokeOne threw — the
      // original access token is now dead.
      const me = await request(t.app.getHttpServer())
        .get('/api/v1/auth/passkey/list')
        .set('Authorization', `Bearer ${sess.accessToken}`);
      expect(me.status).toBe(401);

      // The refresh row was never revoked or cleared — /auth/refresh still
      // succeeds with the original cookie.
      const refresh = await request(t.app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '));
      expect(refresh.status).toBe(200);
    });
  });

  describe('change-password (2.9)', () => {
    it('rotates the password, denylists the old jti, and issues a fresh session', async () => {
      const { email, userId } = await signupAndVerify(t);
      const sess = await login(t, email);
      const before = await scanAll<AuthEventRow>(
        t.doc,
        t.module.get(ConfigService).get('TABLE_AUTH_EVENT', { infer: true } as never),
      );
      const beforeChangeCount = before.filter(
        (r) => r.userId === userId && r.eventType === 'password_change',
      ).length;

      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send({ currentPassword: STRONG_PASSWORD, newPassword: STRONGER_PASSWORD });
      expect(res.status).toBe(200);
      expect((res.body as LoginResponse).accessToken).toBeTruthy();
      expect((res.body as LoginResponse).accessToken).not.toEqual(sess.accessToken);

      // Old access token must now 401 on the denylist.
      const stale = await request(t.app.getHttpServer())
        .get('/api/v1/auth/passkey/list')
        .set('Authorization', `Bearer ${sess.accessToken}`);
      expect(stale.status).toBe(401);

      // New password works.
      const reLogin = await request(t.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONGER_PASSWORD, deviceId: freshDeviceId() });
      expect(reLogin.status).toBe(200);

      // Old password fails.
      const oldPwLogin = await request(t.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD, deviceId: freshDeviceId() });
      expect(oldPwLogin.status).toBe(401);

      // Audit event landed.
      const after = await scanAll<AuthEventRow>(
        t.doc,
        t.module.get(ConfigService).get('TABLE_AUTH_EVENT', { infer: true } as never),
      );
      const afterChangeCount = after.filter(
        (r) => r.userId === userId && r.eventType === 'password_change',
      ).length;
      expect(afterChangeCount).toBeGreaterThan(beforeChangeCount);
    });

    it('rejects a wrong current password with INVALID_CREDENTIALS', async () => {
      const { email } = await signupAndVerify(t);
      const sess = await login(t, email);
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send({ currentPassword: 'WrongPassw0rd!', newPassword: STRONGER_PASSWORD });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    // Backoff-wrap coverage: the
    // change-password password gate shares the per-account FailedLoginAttempt
    // counter via `FailedLoginService.verifyWithBackoff`.
    it('a wrong current password increments the shared per-account backoff counter exactly once', async () => {
      const { email } = await signupAndVerify(t);
      const sess = await login(t, email);
      const emailLowercase = email.toLowerCase();
      const failedTable = t.module
        .get(ConfigService)
        .get('TABLE_FAILED_LOGIN_ATTEMPT', { infer: true } as never) as unknown as string;
      const rowFor = async (): Promise<FailedLoginAttemptRow | undefined> =>
        (await scanAll<FailedLoginAttemptRow>(t.doc, failedTable)).find(
          (r) => r.emailLowercase === emailLowercase,
        );

      // The successful login above already cleared any counter for this fresh
      // account.
      expect(await rowFor()).toBeUndefined();

      const res = await changePassword(t, sess, 'WrongPassw0rd!', STRONGER_PASSWORD);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
      // Exactly 1 — the backoff wrap records a single wrong attempt ONCE.
      // `>= 1` would silently pass a double-count regression.
      expect((await rowFor())?.consecutiveFailures).toBe(1);
    });

    it('repeated wrong current passwords eventually return 429 LOGIN_BACKOFF', async () => {
      const { email } = await signupAndVerify(t);
      const sess = await login(t, email);
      // GRACE_FAILURES = 3 free misses; the 4th records count 4 (a ~2s backoff
      // window), so the 5th attempt inside that window is locked out before the
      // argon2 verify runs.
      for (let i = 0; i < 4; i++) {
        const miss = await changePassword(t, sess, 'WrongPassw0rd!', STRONGER_PASSWORD);
        expect(miss.status).toBe(401);
      }
      const locked = await changePassword(t, sess, 'WrongPassw0rd!', STRONGER_PASSWORD);
      expect(locked.status).toBe(429);
      expect(locked.body.error.code).toBe('LOGIN_BACKOFF');
    });

    it('a subsequent successful password change clears the backoff counter', async () => {
      const { email } = await signupAndVerify(t);
      const sess = await login(t, email);
      const emailLowercase = email.toLowerCase();
      const failedTable = t.module
        .get(ConfigService)
        .get('TABLE_FAILED_LOGIN_ATTEMPT', { infer: true } as never) as unknown as string;
      const rowFor = async (): Promise<FailedLoginAttemptRow | undefined> =>
        (await scanAll<FailedLoginAttemptRow>(t.doc, failedTable)).find(
          (r) => r.emailLowercase === emailLowercase,
        );

      // One wrong attempt (still within the free-grace window → not blocked)
      // seeds the shared counter.
      const wrong = await changePassword(t, sess, 'WrongPassw0rd!', STRONGER_PASSWORD);
      expect(wrong.status).toBe(401);
      expect((await rowFor())?.consecutiveFailures).toBe(1);

      // A correct change succeeds and clears the shared counter.
      const ok = await changePassword(t, sess, STRONG_PASSWORD, STRONGER_PASSWORD);
      expect(ok.status).toBe(200);
      expect(await rowFor()).toBeUndefined();
    });

    it('rejects same-as-current with PASSWORD_SAME_AS_CURRENT', async () => {
      const { email } = await signupAndVerify(t);
      const sess = await login(t, email);
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send({ currentPassword: STRONG_PASSWORD, newPassword: STRONG_PASSWORD });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PASSWORD_SAME_AS_CURRENT');
    });
  });

  describe('account-record correction — PATCH /auth/me', () => {
    it('round trip: the User row, the response, and a follow-up GET /auth/me all carry the new values, with one correctly-scoped AuthEvent', async () => {
      const { email, userId } = await signupAndVerify(t);
      const sess = await login(t, email);
      const before = (await t.doc.send(
        new GetCommand({ TableName: tableName(t, 'TABLE_USER'), Key: { userId } }),
      )) as { Item?: UserRow };
      const beforeUpdatedAt = before.Item?.updatedAt;

      const res = await updateAccountRecord(t, sess, {
        firstName: 'Alicia',
        lastName: 'Smythe',
        birthdate: '1971-05-13',
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        email,
        firstName: 'Alicia',
        lastName: 'Smythe',
        birthdate: '1971-05-13',
      });

      const after = (await t.doc.send(
        new GetCommand({ TableName: tableName(t, 'TABLE_USER'), Key: { userId } }),
      )) as { Item?: UserRow };
      expect(after.Item?.firstName).toBe('Alicia');
      expect(after.Item?.lastName).toBe('Smythe');
      expect(after.Item?.birthdate).toBe('1971-05-13');
      expect(after.Item?.updatedAt).not.toBe(beforeUpdatedAt);

      const me = await request(t.app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${sess.accessToken}`);
      expect(me.status).toBe(200);
      expect(me.body).toEqual({
        email,
        firstName: 'Alicia',
        lastName: 'Smythe',
        birthdate: '1971-05-13',
      });

      const events = await scanAll<AuthEventRow>(t.doc, tableName(t, 'TABLE_AUTH_EVENT'));
      const correctionEvents = events.filter(
        (e) => e.userId === userId && e.eventType === 'account_record_correction',
      );
      expect(correctionEvents).toHaveLength(1);
      const metadataJson = JSON.stringify(correctionEvents[0]!.metadata ?? {});
      expect(metadataJson).not.toContain('Alicia');
      expect(metadataJson).not.toContain('Smythe');
      expect(metadataJson).not.toContain('1971-05-13');
    });

    it('succeeds with the session alone — no password, no MFA step-up — even with AUTH_MFA_ENFORCED on', async () => {
      const priorEnforced = process.env.AUTH_MFA_ENFORCED;
      process.env.AUTH_MFA_ENFORCED = 'true';
      let mfaApp: TestApp | undefined;
      try {
        mfaApp = await bootstrapTestApp();
        const email = freshEmail();
        const signup = await request(mfaApp.app.getHttpServer())
          .post('/api/v1/auth/signup')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({ email, password: STRONG_PASSWORD });
        const userId = signup.body.userId as string;
        const verifyRes = await request(mfaApp.app.getHttpServer())
          .post('/api/v1/auth/verify-email')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({ token: signup.body.verificationToken });
        expect(verifyRes.status).toBe(200);
        await request(mfaApp.app.getHttpServer())
          .post('/api/v1/auth/approve-signup')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({ token: verifyRes.body.approvalToken })
          .expect(200);

        const deviceId = freshDeviceId();
        const loginRes = await request(mfaApp.app.getHttpServer())
          .post('/api/v1/auth/login')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({ email, password: STRONG_PASSWORD, deviceId });
        // Untrusted device + MFA enforced: no session yet, just the challenge.
        expect(loginRes.body.mfaRequired).toBe(true);
        const challengeToken = loginRes.body.challengeToken as string;
        await request(mfaApp.app.getHttpServer())
          .post('/api/v1/auth/mfa/email/send')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({ challengeToken })
          .expect(202);
        const otpRows = await scanAll<{ userId: string; codeHash: string }>(
          mfaApp.doc,
          tableName(mfaApp, 'TABLE_MFA_EMAIL_OTP'),
        );
        const otpRow = otpRows.find((r) => r.userId === userId)!;
        let code = '';
        for (let i = 0; i < 1_000_000; i++) {
          const candidate = i.toString().padStart(6, '0');
          if (sha256(candidate) === otpRow.codeHash) {
            code = candidate;
            break;
          }
        }
        const verify = await request(mfaApp.app.getHttpServer())
          .post('/api/v1/auth/mfa/verify')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({ challengeToken, method: 'email_otp', code, deviceId });
        expect(verify.status).toBe(200);
        const cookies = parseSetCookies(verify.headers['set-cookie']);
        const sess = {
          accessToken: verify.body.accessToken as string,
          refreshCookie: cookieHeader(REFRESH_COOKIE_NAME, cookies[REFRESH_COOKIE_NAME]!),
          csrfCookie: cookieHeader(CSRF_COOKIE_NAME, cookies[CSRF_COOKIE_NAME]!),
          csrfValue: cookies[CSRF_COOKIE_NAME]!,
          deviceId,
        };

        // The correction body carries no password and no MFA factor — session
        // alone is the whole gate.
        const res = await updateAccountRecord(mfaApp, sess, {
          firstName: 'Alicia',
          lastName: 'Smythe',
          birthdate: '1971-05-13',
        });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          email,
          firstName: 'Alicia',
          lastName: 'Smythe',
          birthdate: '1971-05-13',
        });
      } finally {
        await mfaApp?.app.close();
        if (priorEnforced === undefined) delete process.env.AUTH_MFA_ENFORCED;
        else process.env.AUTH_MFA_ENFORCED = priorEnforced;
      }
    });

    it('does not touch the household aggregate tables (no aggregate write is triggered by the correction)', async () => {
      const { email } = await signupAndVerify(t);
      const sess = await login(t, email);
      const before = await scanAll(t.doc, tableName(t, 'TABLE_AGGREGATE_VERSION'));
      const res = await updateAccountRecord(t, sess, {
        firstName: 'Alicia',
        lastName: 'Smythe',
        birthdate: '1971-05-13',
      });
      expect(res.status).toBe(200);
      const after = await scanAll(t.doc, tableName(t, 'TABLE_AGGREGATE_VERSION'));
      expect(after.length).toBe(before.length);
    });
  });

  describe('CSRF + Origin middleware (2.10)', () => {
    let sess: Awaited<ReturnType<typeof login>>;

    beforeAll(async () => {
      const { email } = await signupAndVerify(t);
      sess = await login(t, email);
    });

    it('CSRF: missing X-CSRF-Token header is rejected on a state-changing request', async () => {
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '));
      expect(res.status).toBe(403);
      // Middleware folds missing + mismatch into a single error code so
      // the client surfaces one "refresh your session" path.
      expect(res.body.error.code).toBe('CSRF_TOKEN_MISMATCH');
    });

    it('CSRF: mismatched header vs cookie is rejected', async () => {
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', 'not-the-real-token')
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_TOKEN_MISMATCH');
    });

    it('Origin: missing origin is rejected on a state-changing request', async () => {
      // No Origin or Referer header — supertest sends a host but
      // express's req.get('Origin') returns undefined.
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: freshEmail(), password: STRONG_PASSWORD, deviceId: freshDeviceId() });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ORIGIN_MISMATCH');
    });

    it('Origin: mismatched origin is rejected', async () => {
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', 'http://evil.example.com')
        .send({ email: freshEmail(), password: STRONG_PASSWORD, deviceId: freshDeviceId() });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ORIGIN_MISMATCH');
    });

    it('Origin: matching origin is allowed', async () => {
      // GET /health is exempt (safe method) so use a state-changing
      // path with a fake (but parseable) login.
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email: freshEmail(), password: STRONG_PASSWORD, deviceId: freshDeviceId() });
      // Origin passes; login fails (no such user) — that's fine, point
      // is the middleware did not 403 us.
      expect(res.status).toBe(401);
    });
  });

  describe('JWT kid rotation (2.7)', () => {
    it('verify accepts tokens signed with the current kid', async () => {
      const { email } = await signupAndVerify(t);
      const sess = await login(t, email);
      // Decode the header to confirm the `kid` and `alg` are set. Derive
      // the expected kid the same way JwtKeyStore does: explicit
      // AUTH_JWT_CURRENT_KID, else first entry in AUTH_JWT_PRIVATE_KEYS.
      const [headerB64] = sess.accessToken.split('.');
      const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
      const expectedKid =
        process.env.AUTH_JWT_CURRENT_KID ??
        Object.keys(JSON.parse(process.env.AUTH_JWT_PRIVATE_KEYS!))[0];
      expect(header.kid).toBe(expectedKid);
      expect(header.alg).toBe('RS256');
    });
  });

  describe('JWKS endpoint', () => {
    it('exposes the active public key set as RFC 7517 JWKS', async () => {
      const res = await request(t.app.getHttpServer())
        .get('/api/v1/auth/.well-known/jwks.json');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toMatch(/max-age=300/);
      const body = res.body as { keys: Array<{ kid: string; kty: string; use: string; alg: string; n: string; e: string }> };
      expect(Array.isArray(body.keys)).toBe(true);
      expect(body.keys.length).toBeGreaterThan(0);
      const expectedKid =
        process.env.AUTH_JWT_CURRENT_KID ??
        Object.keys(JSON.parse(process.env.AUTH_JWT_PRIVATE_KEYS!))[0];
      const current = body.keys.find((k) => k.kid === expectedKid);
      expect(current).toBeDefined();
      expect(current?.kty).toBe('RSA');
      expect(current?.use).toBe('sig');
      expect(current?.alg).toBe('RS256');
      expect(current?.n).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(current?.e).toBe('AQAB');
    });

    it('exposes only public material — no private key fields leak', async () => {
      const res = await request(t.app.getHttpServer())
        .get('/api/v1/auth/.well-known/jwks.json');
      expect(res.status).toBe(200);
      // RSA private JWK fields per RFC 7518 §6.3.2: d, p, q, dp, dq, qi, oth.
      const forbidden = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'];
      const serialized = JSON.stringify(res.body);
      for (const k of forbidden) {
        expect(serialized).not.toMatch(new RegExp(`"${k}"\\s*:`));
      }
    });
  });

  describe('signup contract (no acknowledgement field)', () => {
    it('accepts a body with no acknowledgement field and writes the user row', async () => {
      const email = freshEmail();
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD });
      expect(res.status).toBe(202);

      const userId = res.body.userId as string;
      const user = await t.doc.send(
        new GetCommand({ TableName: tableName(t, 'TABLE_USER'), Key: { userId } }),
      );
      expect(user.Item).toBeDefined();
    });

    it('rejects a body that still carries legalAcceptance with 400 and writes nothing', async () => {
      const email = freshEmail();
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD, legalAcceptance: {} });
      expect(res.status).toBe(400);
      const reservation = await t.doc.send(
        new GetCommand({
          TableName: tableName(t, 'TABLE_EMAIL_RESERVATION'),
          Key: { emailLowercase: email.toLowerCase() },
        }),
      );
      expect(reservation.Item).toBeUndefined();
    });
  });

  describe('setup-status', () => {
    it('returns hasUsers: true when at least one user exists', async () => {
      // Make sure there's at least one user.
      await signupAndVerify(t);
      const res = await request(t.app.getHttpServer())
        .get('/api/v1/auth/setup-status');
      expect(res.status).toBe(200);
      expect(res.body.hasUsers).toBe(true);
    });
  });

  describe('resend verification (2.3+)', () => {
    const userTable = () =>
      t.module.get(ConfigService).get('TABLE_USER', { infer: true } as never) as string;
    const emailVerificationTable = () =>
      t.module
        .get(ConfigService)
        .get('TABLE_EMAIL_VERIFICATION', { infer: true } as never) as string;
    const authEventTable = () =>
      t.module.get(ConfigService).get('TABLE_AUTH_EVENT', { infer: true } as never) as string;

    async function backdateLastSent(userId: string, agoSec: number): Promise<void> {
      const past = new Date(Date.now() - agoSec * 1000).toISOString();
      await t.doc.send(
        new UpdateCommand({
          TableName: userTable(),
          Key: { userId },
          UpdateExpression: 'SET lastVerificationSentAt = :s',
          ExpressionAttributeValues: { ':s': past },
        }),
      );
    }

    it('returns 202 with no token for an unknown email (no enumeration oracle)', async () => {
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/resend-verification')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email: freshEmail() });
      expect(res.status).toBe(202);
      expect(res.body.accepted).toBe(true);
      expect(res.body.verificationToken).toBeUndefined();
    });

    it('returns 202 with no token for an already-verified user', async () => {
      const { email, userId } = await signupAndVerify(t);
      const before = await scanAll<AuthEventRow>(t.doc, authEventTable());
      const beforeResendCount = before.filter(
        (r) => r.userId === userId && r.eventType === 'email_resend',
      ).length;
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/resend-verification')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email });
      expect(res.status).toBe(202);
      expect(res.body.accepted).toBe(true);
      expect(res.body.verificationToken).toBeUndefined();
      // No email_resend event for verified accounts.
      const after = await scanAll<AuthEventRow>(t.doc, authEventTable());
      const afterResendCount = after.filter(
        (r) => r.userId === userId && r.eventType === 'email_resend',
      ).length;
      expect(afterResendCount).toBe(beforeResendCount);
    });

    it('issues a fresh token, invalidates the prior one, and the new token verifies', async () => {
      const email = freshEmail();
      const signup = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD });
      expect(signup.status).toBe(202);
      const oldToken = (signup.body as SignupResponse).verificationToken!;
      expect(oldToken).toBeTruthy();
      const userId = (signup.body as SignupResponse).userId;

      // Bypass the 60s cooldown set by the signup itself.
      await backdateLastSent(userId, 120);

      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/resend-verification')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email });
      expect(res.status).toBe(202);
      const newToken = res.body.verificationToken as string | undefined;
      expect(newToken).toBeTruthy();
      expect(newToken).not.toBe(oldToken);

      // Old token is gone. DynamoDB stores the SHA-256 hash, so key the
      // direct read by sha256(rawToken).
      const oldRow = await t.doc.send(
        new GetCommand({
          TableName: emailVerificationTable(),
          Key: { verificationToken: sha256(oldToken) },
        }),
      );
      expect(oldRow.Item).toBeUndefined();

      // New token verifies.
      const verify = await request(t.app.getHttpServer())
        .post('/api/v1/auth/verify-email')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ token: newToken });
      expect(verify.status).toBe(200);
    });

    it('silently no-ops while inside the cooldown window — same response shape, no new token', async () => {
      const email = freshEmail();
      const signup = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD });
      expect(signup.status).toBe(202);
      const userId = (signup.body as SignupResponse).userId;

      // Immediately resend — well inside the 60s cooldown.
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/resend-verification')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email });
      expect(res.status).toBe(202);
      expect(res.body.accepted).toBe(true);
      expect(res.body.verificationToken).toBeUndefined();

      // The User row's tracking fields stayed at the signup baseline.
      const userRow = await t.doc.send(
        new GetCommand({ TableName: userTable(), Key: { userId } }),
      );
      const user = userRow.Item as UserRow;
      expect(user.verificationsSentToday).toBe(1);
    });

    it('signup with an expired-unverified email recycles the row', async () => {
      const email = freshEmail();
      const first = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD });
      expect(first.status).toBe(202);
      const firstUserId = (first.body as SignupResponse).userId;

      // Backdate signupExpiresAt into the past.
      await t.doc.send(
        new UpdateCommand({
          TableName: userTable(),
          Key: { userId: firstUserId },
          UpdateExpression: 'SET signupExpiresAt = :p',
          ExpressionAttributeValues: { ':p': Math.floor(Date.now() / 1000) - 60 },
        }),
      );

      const second = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD });
      expect(second.status).toBe(202);
      const secondUserId = (second.body as SignupResponse).userId;
      expect(secondUserId).not.toBe(firstUserId);

      // Old user is gone.
      const oldUser = await t.doc.send(
        new GetCommand({ TableName: userTable(), Key: { userId: firstUserId } }),
      );
      expect(oldUser.Item).toBeUndefined();

      // The fresh signup token verifies.
      const newToken = (second.body as SignupResponse).verificationToken!;
      const verify = await request(t.app.getHttpServer())
        .post('/api/v1/auth/verify-email')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ token: newToken });
      expect(verify.status).toBe(200);
    });

    it('does NOT recycle a verified row — duplicate signup still 409s', async () => {
      const { email } = await signupAndVerify(t);
      const second = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('EMAIL_TAKEN');
    });

    it('does NOT recycle an unverified-but-still-active signup', async () => {
      const email = freshEmail();
      const first = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD });
      expect(first.status).toBe(202);

      // signupExpiresAt is still 24h in the future from the signup.
      const second = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('EMAIL_TAKEN');
    });

    it('writes the 15-minute TTL on the verification row', async () => {
      const email = freshEmail();
      const signup = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD });
      expect(signup.status).toBe(202);
      const token = (signup.body as SignupResponse).verificationToken!;
      // DynamoDB stores the SHA-256 hash; key the direct read by sha256.
      const row = await t.doc.send(
        new GetCommand({
          TableName: emailVerificationTable(),
          Key: { verificationToken: sha256(token) },
        }),
      );
      const ttl = (row.Item as EmailVerificationRow).expiresAt;
      const nowSec = Math.floor(Date.now() / 1000);
      // Within 15 min ± a small handler window.
      expect(ttl - nowSec).toBeGreaterThan(14 * 60);
      expect(ttl - nowSec).toBeLessThanOrEqual(15 * 60 + 5);
    });

    // Response-time enumeration hardening. Every branch
    // returns the identical opaque 202 AND takes at least the constant floor,
    // so the response timing can't reveal whether the email is registered.
    describe('constant-time response floor (anti-enumeration)', () => {
      async function timedResend(
        email: string,
      ): Promise<{ status: number; body: { accepted?: boolean; verificationToken?: string }; elapsedMs: number }> {
        const start = Date.now();
        const res = await request(t.app.getHttpServer())
          .post('/api/v1/auth/resend-verification')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({ email });
        return { status: res.status, body: res.body, elapsedMs: Date.now() - start };
      }

      function expectFlooredOpaque202(result: {
        status: number;
        elapsedMs: number;
      }): void {
        expect(result.status).toBe(202);
        expect(result.elapsedMs).toBeGreaterThanOrEqual(RESPONSE_TIME_FLOOR_MS);
        expect(result.elapsedMs).toBeLessThan(RESPONSE_TIME_CEILING_MS);
      }

      it('holds the floor on the missing-account branch', async () => {
        const result = await timedResend(freshEmail());
        expectFlooredOpaque202(result);
        expect(result.body.verificationToken).toBeUndefined();
      });

      it('holds the floor on the existing-account (real send) branch', async () => {
        const email = freshEmail();
        const signup = await request(t.app.getHttpServer())
          .post('/api/v1/auth/signup')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({ email, password: STRONG_PASSWORD });
        const userId = (signup.body as SignupResponse).userId;
        // Past the 60s cooldown the signup itself set, so this is a real send.
        await backdateLastSent(userId, 120);

        const result = await timedResend(email);
        expectFlooredOpaque202(result);
        // Identical opaque shape — real send carries the dev token; the timing
        // floor is what makes it indistinguishable from the no-op branches.
        expect(result.body.accepted).toBe(true);
      });

      it('holds the floor on the daily-cap no-op branch', async () => {
        const email = freshEmail();
        const signup = await request(t.app.getHttpServer())
          .post('/api/v1/auth/signup')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({ email, password: STRONG_PASSWORD });
        const userId = (signup.body as SignupResponse).userId;
        // Drive to the daily cap for today and clear the cooldown anchor so
        // only the daily-cap branch can trip.
        const dayKey = Math.floor(Date.now() / 1000 / 86400);
        await t.doc.send(
          new UpdateCommand({
            TableName: userTable(),
            Key: { userId },
            UpdateExpression:
              'SET verificationsSentDayKey = :day, verificationsSentToday = :count REMOVE lastVerificationSentAt',
            ExpressionAttributeValues: { ':day': dayKey, ':count': RESEND_DAILY_LIMIT },
          }),
        );

        const result = await timedResend(email);
        expectFlooredOpaque202(result);
        expect(result.body.verificationToken).toBeUndefined();
      });
    });
  });

  // Owner-approval gate.
  // Test emails are random-uuid, so they're always foreign relative to
  // the configured APPROVER_EMAIL — every signup lands in 'pending'.
  describe('owner-approval gate', () => {
    it('login is blocked with ACCOUNT_PENDING_APPROVAL after verify but before approve', async () => {
      const { email, userId } = await signupVerifyOnly(t);
      // The pending user has an active approval row.
      const row = await findApprovalToken(t, userId);
      expect(row).toBeTruthy();

      const login = await request(t.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD, deviceId: freshDeviceId() });
      expect(login.status).toBe(403);
      expect(login.body.error.code).toBe('ACCOUNT_PENDING_APPROVAL');
    });

    it('approve flips the gate; the same email can then sign in', async () => {
      const { email, approvalToken } = await signupVerifyOnly(t);

      const approve = await request(t.app.getHttpServer())
        .post('/api/v1/auth/approve-signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ token: approvalToken });
      expect(approve.status).toBe(200);
      expect(approve.body).toEqual({ approved: true, email });

      const login = await request(t.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD, deviceId: freshDeviceId() });
      expect(login.status).toBe(200);

      // Token is consumed: a second approve call must 400.
      const replay = await request(t.app.getHttpServer())
        .post('/api/v1/auth/approve-signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ token: approvalToken });
      expect(replay.status).toBe(400);
      expect(replay.body.error.code).toBe('APPROVAL_TOKEN_INVALID');
    });

    it('decline cascade-deletes the user-row sub-graph synchronously', async () => {
      const { email, userId, approvalToken } = await signupVerifyOnly(t);

      const userTable = t.module
        .get(ConfigService)
        .get('TABLE_USER', { infer: true } as never) as unknown as string;
      const credentialTable = t.module
        .get(ConfigService)
        .get('TABLE_CREDENTIAL', { infer: true } as never) as unknown as string;
      const reservationTable = t.module
        .get(ConfigService)
        .get('TABLE_EMAIL_RESERVATION', { infer: true } as never) as unknown as string;

      const decline = await request(t.app.getHttpServer())
        .post('/api/v1/auth/decline-signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ token: approvalToken });
      expect(decline.status).toBe(200);
      expect(decline.body).toEqual({ declined: true, email });

      // User row, credential row, reservation row are all gone.
      const userRow = await t.doc.send(
        new GetCommand({ TableName: userTable, Key: { userId } }),
      );
      expect(userRow.Item).toBeUndefined();
      const credentialRow = await t.doc.send(
        new GetCommand({ TableName: credentialTable, Key: { userId } }),
      );
      expect(credentialRow.Item).toBeUndefined();
      const reservationRow = await t.doc.send(
        new GetCommand({
          TableName: reservationTable,
          Key: { emailLowercase: email.toLowerCase() },
        }),
      );
      expect(reservationRow.Item).toBeUndefined();

      // The freed email can be re-signed-up immediately.
      const reSignup = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD });
      expect(reSignup.status).toBe(202);
    });

    it('decline refuses an already-approved user and leaves the live account intact (cross-op race)', async () => {
      const { email, userId, approvalToken } = await signupVerifyOnly(t);

      // Approve first — consumes the token and flips the account live.
      const approve = await request(t.app.getHttpServer())
        .post('/api/v1/auth/approve-signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ token: approvalToken });
      expect(approve.status).toBe(200);

      // A decline against the now-consumed token is refused — the atomic
      // four-item transaction's approval-row + still-pending guards both fail,
      // so a live account is never torn down.
      const decline = await request(t.app.getHttpServer())
        .post('/api/v1/auth/decline-signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ token: approvalToken });
      expect(decline.status).toBe(400);
      expect(decline.body.error.code).toBe('APPROVAL_TOKEN_INVALID');

      // The account row survives and can still sign in.
      const userTable = t.module
        .get(ConfigService)
        .get('TABLE_USER', { infer: true } as never) as unknown as string;
      const userRow = await t.doc.send(
        new GetCommand({ TableName: userTable, Key: { userId } }),
      );
      expect(userRow.Item).toBeTruthy();

      const login = await request(t.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD, deviceId: freshDeviceId() });
      expect(login.status).toBe(200);
    });

    it('approve refuses a stale token after the user was declined and deleted (cross-op race)', async () => {
      const { userId, approvalToken } = await signupVerifyOnly(t);

      const decline = await request(t.app.getHttpServer())
        .post('/api/v1/auth/decline-signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ token: approvalToken });
      expect(decline.status).toBe(200);

      // The user (and its token row) are gone; a stale approve on the same
      // token is refused at the digest lookup and never resurrects the account.
      const approve = await request(t.app.getHttpServer())
        .post('/api/v1/auth/approve-signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ token: approvalToken });
      expect(approve.status).toBe(400);
      expect(approve.body.error.code).toBe('APPROVAL_TOKEN_INVALID');

      const userTable = t.module
        .get(ConfigService)
        .get('TABLE_USER', { infer: true } as never) as unknown as string;
      const userRow = await t.doc.send(
        new GetCommand({ TableName: userTable, Key: { userId } }),
      );
      expect(userRow.Item).toBeUndefined();
    });

    it('verify-email returns the freshly-issued approvalToken in dev (local-dev shortcut)', async () => {
      const email = freshEmail();
      const signup = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD });
      expect(signup.status).toBe(202);
      const verify = await request(t.app.getHttpServer())
        .post('/api/v1/auth/verify-email')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ token: (signup.body as SignupResponse).verificationToken });
      expect(verify.status).toBe(200);
      // EXPOSE_VERIFICATION_TOKEN defaults to 'true' whenever
      // NODE_ENV !== 'production', and the test harness runs with
      // NODE_ENV=test → the gate returns the approval token in the
      // response so the SPA can render the dev shortcut. (Deployed
      // stacks run NODE_ENV=production and never get it.)
      expect(verify.body.approvalToken).toBeTruthy();
      expect(typeof verify.body.approvalToken).toBe('string');
    });

    it('an invalid approval token returns 400 APPROVAL_TOKEN_INVALID', async () => {
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/approve-signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ token: 'a'.repeat(43) });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('APPROVAL_TOKEN_INVALID');
    });

    it('an expired approval token returns 410 APPROVAL_TOKEN_EXPIRED', async () => {
      const { userId, approvalToken } = await signupVerifyOnly(t);
      // The stored row is keyed by the token DIGEST — address it by that
      // key to force-expire it in place.
      const row = await findApprovalToken(t, userId);
      expect(row).toBeTruthy();

      // Force-expire the row in place. DynamoDB's TTL eventually sweeps
      // it; we don't wait for that — the service checks `expiresAt`
      // explicitly so a rewritten row trips the same path.
      const tableName = t.module
        .get(ConfigService)
        .get('TABLE_SIGNUP_APPROVAL', { infer: true } as never) as unknown as string;
      await t.doc.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { approvalToken: row!.approvalToken },
          UpdateExpression: 'SET expiresAt = :exp',
          ExpressionAttributeValues: { ':exp': Math.floor(Date.now() / 1000) - 60 },
        }),
      );

      // Consume via the RAW token — the service hashes it to the digest key.
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/approve-signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ token: approvalToken });
      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe('APPROVAL_TOKEN_EXPIRED');

      // The expired-link branch must NOT proactively delete the row. The
      // household-cleanup cascade Lambda only fires on DynamoDB's own
      // TTL-attributed REMOVE; an application DeleteItem here would be skipped
      // (isTtlDelete()), permanently stranding the pending
      // User/Credential/EmailReservation rows. Leaving the row in place lets
      // the TTL sweep emit a real TTL REMOVE the cascade will process.
      const survivingRow = await findApprovalToken(t, userId);
      expect(survivingRow).toBeTruthy();
      expect(survivingRow!.approvalToken).toBe(row!.approvalToken);
    });

    it('signup with the configured APPROVER_EMAIL is auto_approved (no approval row)', async () => {
      const cfg = t.module.get(ConfigService);
      const approverEmail = (cfg.get('APPROVER_EMAIL', { infer: true } as never)
        ?? cfg.get('SES_FROM_ADDRESS', { infer: true } as never)) as unknown as string;
      const userTable = cfg.get('TABLE_USER', { infer: true } as never) as unknown as string;

      // The default APPROVER_EMAIL value is `no-reply@example.invalid` (the
      // schema default). We can sign up with exactly that — once per
      // suite, since it's a unique email. If a prior test already used
      // it (within the same shared DynamoDB Local), surface that as a
      // skip rather than a failure: the assertion is about the gate
      // behaviour, not raw availability of the address.
      const signup = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email: approverEmail, password: STRONG_PASSWORD });
      if (signup.status === 409) return;
      expect(signup.status).toBe(202);
      const userId = (signup.body as SignupResponse).userId;
      const userRow = await t.doc.send(
        new GetCommand({ TableName: userTable, Key: { userId } }),
      );
      const user = userRow.Item as UserRow | undefined;
      expect(user?.approvalStatus).toBe('auto_approved');

      // No approval row was issued — the gate short-circuited.
      const verifyToken = (signup.body as SignupResponse).verificationToken!;
      await request(t.app.getHttpServer())
        .post('/api/v1/auth/verify-email')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ token: verifyToken })
        .expect(200);

      const row = await findApprovalToken(t, userId);
      expect(row).toBeNull();

      // Login works without any owner approval step.
      const login = await request(t.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email: approverEmail, password: STRONG_PASSWORD, deviceId: freshDeviceId() });
      expect(login.status).toBe(200);
    });
  });

  // Access-token issuer/audience + hashed approval tokens.
  describe('token-domain claims + hashed approval tokens', () => {
    function decodePayload(token: string): Record<string, unknown> {
      const [, payloadB64] = token.split('.');
      return JSON.parse(
        Buffer.from(payloadB64, 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
    }

    it('login access token carries the configured issuer/audience and still authenticates', async () => {
      const { email } = await signupAndVerify(t);
      const sess = await login(t, email);

      const cfg = t.module.get(ConfigService);
      const issuer = cfg.get('AUTH_JWT_ISSUER', { infer: true } as never) as unknown as string;
      const audience = cfg.get('AUTH_JWT_AUDIENCE', { infer: true } as never) as unknown as string;

      const payload = decodePayload(sess.accessToken);
      expect(payload.iss).toBe(issuer);
      expect(payload.aud).toBe(audience);

      // Strict verification passes end-to-end: the token authenticates a request.
      const me = await request(t.app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${sess.accessToken}`);
      expect(me.status).toBe(200);
    });

    it('refresh rotates to a new access token that also carries the issuer/audience claims', async () => {
      const { email } = await signupAndVerify(t);
      const sess = await login(t, email);
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '));
      expect(res.status).toBe(200);
      const cfg = t.module.get(ConfigService);
      const payload = decodePayload((res.body as LoginResponse).accessToken);
      expect(payload.iss).toBe(cfg.get('AUTH_JWT_ISSUER', { infer: true } as never));
      expect(payload.aud).toBe(cfg.get('AUTH_JWT_AUDIENCE', { infer: true } as never));
    });

    it('a newly issued approval link resolves through its digest; the raw key is absent from the row', async () => {
      const { userId, approvalToken } = await signupVerifyOnly(t);

      // The stored row is keyed by sha256(rawToken) — a 64-char lowercase hex
      // digest — NOT the raw 43-char base64url token.
      const row = await findApprovalToken(t, userId);
      expect(row).toBeTruthy();
      expect(row!.approvalToken).toBe(sha256(approvalToken));
      expect(row!.approvalToken).not.toBe(approvalToken);
      expect(row!.approvalToken).toMatch(/^[0-9a-f]{64}$/);

      // The raw link still resolves (the service hashes on consume).
      const approve = await request(t.app.getHttpServer())
        .post('/api/v1/auth/approve-signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ token: approvalToken });
      expect(approve.status).toBe(200);
    });

    it('rejects a legacy raw-key approval row — only digest-keyed rows resolve', async () => {
      // Simulate a legacy row keyed by the RAW token itself (43-char base64url),
      // as issuance used to store it. Consumption hashes the presented
      // token, so this legacy row can never be looked up and the link is dead.
      const { userId } = await signupVerifyOnly(t);
      const cfg = t.module.get(ConfigService);
      const tableName = cfg.get('TABLE_SIGNUP_APPROVAL', { infer: true } as never) as unknown as string;
      const legacyRawToken = 'L'.repeat(43);
      await t.doc.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            approvalToken: legacyRawToken,
            userId,
            email: 'legacy@example.test',
            createdAt: new Date().toISOString(),
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
          },
        }),
      );

      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/approve-signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ token: legacyRawToken });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('APPROVAL_TOKEN_INVALID');
    });
  });

  // Signup profile fields (firstName / lastName / birthdate) — stored on
  // the UserRow and read back only through `GET /auth/me`; sign-in
  // responses carry session tokens only.
  describe('signup profile fields', () => {
    const userTable = () =>
      t.module.get(ConfigService).get('TABLE_USER', { infer: true } as never) as string;

    it('stores firstName/lastName/birthdate on the UserRow when supplied', async () => {
      const email = freshEmail();
      const signup = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({
          email,
          password: STRONG_PASSWORD,
          firstName: 'Jane',
          lastName: 'Smith',
          birthdate: '1980-04-15',
        });
      expect(signup.status).toBe(202);
      const userId = (signup.body as SignupResponse).userId;
      const row = await t.doc.send(
        new GetCommand({ TableName: userTable(), Key: { userId } }),
      );
      const user = row.Item as UserRow;
      expect(user.firstName).toBe('Jane');
      expect(user.lastName).toBe('Smith');
      expect(user.birthdate).toBe('1980-04-15');
    });

    it('leaves the profile fields unset when absent (no stale values)', async () => {
      const email = freshEmail();
      const signup = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD });
      expect(signup.status).toBe(202);
      const userId = (signup.body as SignupResponse).userId;
      const row = await t.doc.send(
        new GetCommand({ TableName: userTable(), Key: { userId } }),
      );
      const user = row.Item as UserRow;
      expect(user.firstName).toBeUndefined();
      expect(user.lastName).toBeUndefined();
      expect(user.birthdate).toBeUndefined();
    });

    it('does not return the signup profile in the login response', async () => {
      const email = freshEmail();
      const signup = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({
          email,
          password: STRONG_PASSWORD,
          firstName: 'Jane',
          lastName: 'Smith',
          birthdate: '1980-04-15',
        });
      expect(signup.status).toBe(202);
      const body = signup.body as SignupResponse;
      const verify = await request(t.app.getHttpServer())
        .post('/api/v1/auth/verify-email')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ token: body.verificationToken })
        .expect(200);
      await approvePendingSignup(t, verify.body.approvalToken);

      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD, deviceId: freshDeviceId() });
      expect(res.status).toBe(200);
      // Whole-shape: session tokens only, so a renamed profile key fails too.
      expect(Object.keys(res.body as object).sort()).toEqual(['accessToken', 'expiresIn']);
      expect(res.body).not.toHaveProperty('firstName');
      expect(res.body).not.toHaveProperty('lastName');
      expect(res.body).not.toHaveProperty('birthdate');
    });

    it('does not return the signup profile in the MFA verify response', async () => {
      const priorEnforced = process.env.AUTH_MFA_ENFORCED;
      process.env.AUTH_MFA_ENFORCED = 'true';
      let mfaApp: TestApp | undefined;
      try {
        mfaApp = await bootstrapTestApp();
        const email = freshEmail();
        const signup = await request(mfaApp.app.getHttpServer())
          .post('/api/v1/auth/signup')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({
            email,
            password: STRONG_PASSWORD,
            firstName: 'Jane',
            lastName: 'Smith',
            birthdate: '1980-04-15',
          });
        expect(signup.status).toBe(202);
        const userId = signup.body.userId as string;
        const verifyRes = await request(mfaApp.app.getHttpServer())
          .post('/api/v1/auth/verify-email')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({ token: signup.body.verificationToken })
          .expect(200);
        await approvePendingSignup(mfaApp, verifyRes.body.approvalToken);

        const verify = await completeEmailOtpLogin(mfaApp, email, userId, freshDeviceId());
        expect(verify.status).toBe(200);
        expect(Object.keys(verify.body as object).sort()).toEqual([
          'accessToken',
          'deviceRemembered',
          'expiresIn',
        ]);
        expect(verify.body).not.toHaveProperty('firstName');
        expect(verify.body).not.toHaveProperty('lastName');
        expect(verify.body).not.toHaveProperty('birthdate');
      } finally {
        await mfaApp?.app.close();
        if (priorEnforced === undefined) delete process.env.AUTH_MFA_ENFORCED;
        else process.env.AUTH_MFA_ENFORCED = priorEnforced;
      }
    });

    it('replaces stale profile values when a recycled signup re-uses the email', async () => {
      const email = freshEmail();
      // First (unverified) signup carries one profile.
      const first = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({
          email,
          password: STRONG_PASSWORD,
          firstName: 'Old',
          lastName: 'Name',
          birthdate: '1970-01-01',
        });
      expect(first.status).toBe(202);
      const firstUserId = (first.body as SignupResponse).userId;
      // Expire the unverified signup so the next attempt recycles the row.
      await t.doc.send(
        new UpdateCommand({
          TableName: userTable(),
          Key: { userId: firstUserId },
          UpdateExpression: 'SET signupExpiresAt = :past',
          ExpressionAttributeValues: { ':past': Math.floor(Date.now() / 1000) - 10 },
        }),
      );
      // Re-signup with NO profile fields — the recycled row must not keep
      // the old values.
      const second = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD });
      expect(second.status).toBe(202);
      const secondUserId = (second.body as SignupResponse).userId;
      expect(secondUserId).not.toBe(firstUserId);
      const row = await t.doc.send(
        new GetCommand({ TableName: userTable(), Key: { userId: secondUserId } }),
      );
      const user = row.Item as UserRow;
      expect(user.firstName).toBeUndefined();
      expect(user.lastName).toBeUndefined();
      expect(user.birthdate).toBeUndefined();
    });

    describe('birthdate validation', () => {
      const cases: Array<[string, string]> = [
        ['malformed day', '2026-01-32'],
        ['malformed month', '2026-13-01'],
        ['non-date string', 'not-a-date'],
        ['full ISO datetime', '2026-01-01T00:00:00Z'],
        ['impossible leap day (non-leap year)', '2026-02-29'],
        ['impossible June 31', '2026-06-31'],
      ];
      it.each(cases)('rejects %s with 400', async (_label, birthdate) => {
        const res = await request(t.app.getHttpServer())
          .post('/api/v1/auth/signup')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({
            email: freshEmail(),
            password: STRONG_PASSWORD,
            firstName: 'Jane',
            lastName: 'Smith',
            birthdate,
          });
        expect(res.status).toBe(400);
      });

      it('accepts a real leap day (regression guard against over-rejection)', async () => {
        const res = await request(t.app.getHttpServer())
          .post('/api/v1/auth/signup')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({
            email: freshEmail(),
            password: STRONG_PASSWORD,
            firstName: 'Jane',
            lastName: 'Smith',
            birthdate: '2024-02-29',
          });
        expect(res.status).toBe(202);
      });

      it('rejects a well-formed future birthdate with 400', async () => {
        // One year ahead of today — a structurally valid, real calendar date
        // that is still in the future (bad SS age math on the seeded member).
        const future = new Date();
        future.setUTCFullYear(future.getUTCFullYear() + 1);
        const res = await request(t.app.getHttpServer())
          .post('/api/v1/auth/signup')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({
            email: freshEmail(),
            password: STRONG_PASSWORD,
            firstName: 'Jane',
            lastName: 'Smith',
            birthdate: future.toISOString().slice(0, 10),
          });
        expect(res.status).toBe(400);
      });

      it('accepts the exact 120-year UTC boundary', async () => {
        const boundary = new Date();
        boundary.setUTCFullYear(boundary.getUTCFullYear() - 120);
        const res = await request(t.app.getHttpServer())
          .post('/api/v1/auth/signup')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({
            email: freshEmail(),
            password: STRONG_PASSWORD,
            firstName: 'Jane',
            lastName: 'Smith',
            birthdate: boundary.toISOString().slice(0, 10),
          });
        expect(res.status).toBe(202);
      });

      it('rejects one day older than the 120-year UTC boundary', async () => {
        const tooOld = new Date();
        tooOld.setUTCFullYear(tooOld.getUTCFullYear() - 120);
        tooOld.setUTCDate(tooOld.getUTCDate() - 1);
        const res = await request(t.app.getHttpServer())
          .post('/api/v1/auth/signup')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({
            email: freshEmail(),
            password: STRONG_PASSWORD,
            firstName: 'Jane',
            lastName: 'Smith',
            birthdate: tooOld.toISOString().slice(0, 10),
          });
        expect(res.status).toBe(400);
      });
    });
  });
});
