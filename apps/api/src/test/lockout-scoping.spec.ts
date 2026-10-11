/**
 * API-integration tests for lockout scoping: failed-password
 * counting stays keyed on the email address, but a device presenting a valid
 * trusted-device cookie is never blocked by another party's guesses, has its
 * own per-device ceiling that revokes only that device on crossing, and the
 * per-address guessing notice fires at most once per 24h. Runs with
 * AUTH_MFA_ENFORCED=true (device trust is minted via that flow) against the
 * local emulator (`pnpm emu:up` required).
 */
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  STRONG_PASSWORD,
  bootstrapTestApp,
  freshDeviceId,
  freshEmail,
  parseSetCookies,
  scanAll,
  type TestApp,
  recoverEmailOtp,
  signupVerifyApprove,
} from './test-helpers.js';
import type { AuthEventRow, FailedLoginAttemptRow, TrustedDeviceRow } from '../dynamo/types.js';
import {
  CSRF_COOKIE_NAME,
  DEVICE_TRUST_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
} from '../auth/cookie-config.js';
import { sha256 } from '../auth/refresh-token.service.js';
import { FailedLoginAttemptsRepository } from '../dynamo/failed-login-attempts.repository.js';

const ORIGIN = () => process.env.WEB_ORIGIN!;
const TTL_SEC = 24 * 60 * 60;

interface ChallengeResponse {
  mfaRequired?: true;
  challengeToken?: string;
  accessToken?: string;
  deviceRemembered?: boolean;
}

function loginRaw(
  t: TestApp,
  email: string,
  password: string,
  deviceId: string,
  cookies: string[] = [],
): request.Test {
  const req = request(t.app.getHttpServer()).post('/api/v1/auth/login').set('Origin', ORIGIN());
  if (cookies.length) req.set('Cookie', cookies.join('; '));
  return req.send({ email, password, deviceId });
}

async function clearEmailOtpCooldown(t: TestApp, userId: string): Promise<void> {
  const userTable = t.module
    .get(ConfigService)
    .get('TABLE_USER', { infer: true } as never) as unknown as string;
  await t.doc.send(
    new UpdateCommand({
      TableName: userTable,
      Key: { userId },
      UpdateExpression: 'REMOVE mfaEmailOtpLastSentAt',
    }),
  );
}

/** Complete an email-OTP login with `rememberDevice:true` and return the
 *  session + the minted device-trust cookie (as a header pair and raw). */
async function loginAndTrustDevice(
  t: TestApp,
  email: string,
  userId: string,
  deviceId: string,
): Promise<{
  accessToken: string;
  refreshCookie: string;
  csrfCookie: string;
  csrfValue: string;
  trustHeader: string;
  trustSecret: string;
}> {
  const login = await loginRaw(t, email, STRONG_PASSWORD, deviceId);
  const challengeToken = (login.body as ChallengeResponse).challengeToken!;
  await request(t.app.getHttpServer())
    .post('/api/v1/auth/mfa/email/send')
    .set('Origin', ORIGIN())
    .send({ challengeToken })
    .expect(202);
  const code = await recoverEmailOtp(t, userId);
  const verify = await request(t.app.getHttpServer())
    .post('/api/v1/auth/mfa/verify')
    .set('Origin', ORIGIN())
    .send({ challengeToken, method: 'email_otp', code, deviceId, rememberDevice: true })
    .expect(200);
  const cookies = parseSetCookies(verify.headers['set-cookie']);
  const trust = cookies[DEVICE_TRUST_COOKIE_NAME];
  return {
    accessToken: (verify.body as ChallengeResponse).accessToken!,
    refreshCookie: `${REFRESH_COOKIE_NAME}=${encodeURIComponent(cookies[REFRESH_COOKIE_NAME])}`,
    csrfCookie: `${CSRF_COOKIE_NAME}=${encodeURIComponent(cookies[CSRF_COOKIE_NAME])}`,
    csrfValue: cookies[CSRF_COOKIE_NAME],
    trustHeader: `${DEVICE_TRUST_COOKIE_NAME}=${encodeURIComponent(trust)}`,
    trustSecret: trust,
  };
}

/** The raw `Set-Cookie` lines of a response that set (or clear) the
 *  device-trust cookie — a cookie's identity is (name, path), so a migration
 *  response carries two: the `/api/v1/auth` clear and the `/api/v1` re-issue. */
function deviceTrustSetCookies(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as string[] | string | undefined;
  const lines = !raw ? [] : Array.isArray(raw) ? raw : [raw];
  return lines.filter((l) => l.startsWith(`${DEVICE_TRUST_COOKIE_NAME}=`));
}

describe('lockout scoping: per-address backoff vs. trusted-device bypass', () => {
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

  it('a stranger drives the address counter past the block; a trusted device still signs in with the correct password, but a NEW device is still blocked', async () => {
    const { email, userId } = await signupVerifyApprove(t);
    const strangerDevice = freshDeviceId();
    const trustedDevice = freshDeviceId();
    const newDevice = freshDeviceId();

    // Mint device trust on `trustedDevice` first (a clean login, before any
    // failures exist).
    const { trustHeader } = await loginAndTrustDevice(t, email, userId, trustedDevice);

    // A stranger, from an UNTRUSTED device, drives the per-address counter
    // past the block (3 free misses, the 4th earns a ~2s wait).
    for (let i = 0; i < 4; i++) {
      const miss = await loginRaw(t, email, 'WrongPassw0rd!', strangerDevice);
      expect(miss.status).toBe(401);
    }
    const blocked = await loginRaw(t, email, 'WrongPassw0rd!', strangerDevice);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('LOGIN_BACKOFF');
    // The on-screen sign-in copy ships from the API verbatim — LoginPage renders the message.
    expect(blocked.body.error.message).toMatch(
      /^Too many failed sign-in attempts for this email address\. Try again in \d+ seconds?\. If this wasn't you, someone else may be trying passwords — a device you've already chosen to remember can still sign in\.$/,
    );

    // A brand-new, untrusted device is still blocked — the residual risk is
    // deliberate and must be pinned, not silently removed. Checked BEFORE the
    // (argon2-heavy) trusted-device call below so the still-short backoff
    // window (~2s, at exactly 4 misses) can't have elapsed by the time this
    // request lands.
    const newDeviceLogin = await loginRaw(t, email, STRONG_PASSWORD, newDevice);
    expect(newDeviceLogin.status).toBe(429);
    expect(newDeviceLogin.body.error.code).toBe('LOGIN_BACKOFF');

    // The trusted device, with the CORRECT password, still signs in —
    // however deep the per-address counter is, and however much time has
    // passed since the last miss (the bypass is not time-sensitive).
    const trustedLogin = await loginRaw(t, email, STRONG_PASSWORD, trustedDevice, [trustHeader]);
    expect(trustedLogin.status).toBe(200);
    expect((trustedLogin.body as ChallengeResponse).mfaRequired).toBeUndefined();
    expect((trustedLogin.body as ChallengeResponse).accessToken).toBeTruthy();
  });

  it('the per-device ceiling revokes only that device: the trust row is gone, the address counter is untouched, another device is unaffected, and the revoked device is MFA-challenged next time', async () => {
    const { email, userId } = await signupVerifyApprove(t);
    const deviceA = freshDeviceId();
    const deviceB = freshDeviceId();

    const a = await loginAndTrustDevice(t, email, userId, deviceA);
    await clearEmailOtpCooldown(t, userId);
    const b = await loginAndTrustDevice(t, email, userId, deviceB);

    // A trusted device serves NO backoff wait — 5 wrong attempts run back to
    // back without ever hitting 429, each 401.
    for (let i = 0; i < 5; i++) {
      const miss = await loginRaw(t, email, 'WrongPassw0rd!', deviceA, [a.trustHeader]);
      expect(miss.status).toBe(401);
    }

    const trustTable = t.module
      .get(ConfigService)
      .get('TABLE_TRUSTED_DEVICE', { infer: true } as never) as unknown as string;
    const trustRows = await scanAll<TrustedDeviceRow>(t.doc, trustTable);
    expect(trustRows.find((r) => r.userId === userId && r.deviceId === deviceA)).toBeUndefined();
    // deviceB's trust survives untouched.
    expect(trustRows.find((r) => r.userId === userId && r.deviceId === deviceB)).toBeDefined();

    const failedTable = t.module
      .get(ConfigService)
      .get('TABLE_FAILED_LOGIN_ATTEMPT', { infer: true } as never) as unknown as string;
    const addrRow = (await scanAll<FailedLoginAttemptRow>(t.doc, failedTable)).find(
      (r) => r.emailLowercase === email.toLowerCase(),
    );
    expect(addrRow).toBeUndefined();

    // deviceB's own sign-in is unaffected.
    const bLogin = await loginRaw(t, email, STRONG_PASSWORD, deviceB, [b.trustHeader]);
    expect(bLogin.status).toBe(200);
    expect((bLogin.body as ChallengeResponse).mfaRequired).toBeUndefined();

    // deviceA, even with the correct password and its now-stale cookie, is
    // MFA-challenged — trust was revoked, not the account.
    const aLoginAgain = await loginRaw(t, email, STRONG_PASSWORD, deviceA, [a.trustHeader]);
    expect((aLoginAgain.body as ChallengeResponse).mfaRequired).toBe(true);
  });

  it('sends one guessing notice per 24h, including across a clear', async () => {
    const { email, userId } = await signupVerifyApprove(t);
    const emailLowercase = email.toLowerCase();
    const repo = t.module.get(FailedLoginAttemptsRepository);
    const authTable = t.module
      .get(ConfigService)
      .get('TABLE_AUTH_EVENT', { infer: true } as never) as unknown as string;
    const noticeCount = async (): Promise<number> =>
      (await scanAll<AuthEventRow>(t.doc, authTable)).filter(
        (r) => r.userId === userId && r.eventType === 'login_guessing_notice_sent',
      ).length;

    // A trusted device, minted up front, bypasses the per-address block
    // (below) — used as the real "sign in successfully" step, since a real
    // untrusted login can't clear a block it just earned inside its own
    // backoff window.
    const trustedDevice = freshDeviceId();
    const trust = await loginAndTrustDevice(t, email, userId, trustedDevice);

    // Fast-forward the counter to 9 with an old timestamp (so the backoff
    // window has already elapsed) rather than waiting out each real window.
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() - 120_000);
    for (let i = 0; i < 9; i++) await repo.increment(emailLowercase, TTL_SEC);
    nowSpy.mockRestore();

    // The 10th failure, a real request, crosses the threshold.
    const cross = await loginRaw(t, email, 'WrongPassw0rd!', freshDeviceId());
    expect(cross.status).toBe(401);
    expect(await noticeCount()).toBe(1);

    // A successful sign-in (via the trusted device, bypassing the address
    // block it just earned) clears the counter but preserves the stamp.
    const ok = await loginRaw(t, email, STRONG_PASSWORD, trustedDevice, [trust.trustHeader]);
    expect(ok.status).toBe(200);

    // A second burst crosses the threshold again inside the same 24h window
    // — no second notice. A naive implementation passes every earlier
    // assertion and fails only this one.
    const nowSpy2 = jest.spyOn(Date, 'now').mockReturnValue(Date.now() - 120_000);
    for (let i = 0; i < 9; i++) await repo.increment(emailLowercase, TTL_SEC);
    nowSpy2.mockRestore();
    const cross2 = await loginRaw(t, email, 'WrongPassw0rd!', freshDeviceId());
    expect(cross2.status).toBe(401);
    expect(await noticeCount()).toBe(1);
  });

  it('an unknown email at the threshold sends no notice and records nothing user-linked', async () => {
    const emailLowercase = freshEmail().toLowerCase();
    const repo = t.module.get(FailedLoginAttemptsRepository);
    const authTable = t.module
      .get(ConfigService)
      .get('TABLE_AUTH_EVENT', { infer: true } as never) as unknown as string;
    const totalNotices = async (): Promise<number> =>
      (await scanAll<AuthEventRow>(t.doc, authTable)).filter(
        (r) => r.eventType === 'login_guessing_notice_sent',
      ).length;
    const before = await totalNotices();

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() - 120_000);
    for (let i = 0; i < 9; i++) await repo.increment(emailLowercase, TTL_SEC);
    nowSpy.mockRestore();

    const cross = await loginRaw(t, emailLowercase, 'WrongPassw0rd!', freshDeviceId());
    expect(cross.status).toBe(401);
    expect(await totalNotices()).toBe(before);
  });

  it('the bypass reaches POST /auth/verify-password (data_export purpose), not just the login primitive', async () => {
    const { email, userId } = await signupVerifyApprove(t);
    const deviceId = freshDeviceId();
    const s = await loginAndTrustDevice(t, email, userId, deviceId);

    const verifyPassword = (
      currentPassword: string,
      withTrust: boolean,
    ): request.Test => {
      const req = request(t.app.getHttpServer())
        .post('/api/v1/auth/verify-password')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('X-CSRF-Token', s.csrfValue);
      const cookies = [s.csrfCookie, ...(withTrust ? [s.trustHeader] : [])];
      return req.set('Cookie', cookies.join('; ')).send({
        currentPassword,
        purpose: 'data_export',
      });
    };

    // Drive the address counter past the block WITHOUT presenting the trust
    // cookie (an untrusted verify-password attempt counts per-address).
    for (let i = 0; i < 4; i++) {
      const miss = await verifyPassword('WrongPassw0rd!', false);
      expect(miss.status).toBe(401);
    }
    const blocked = await verifyPassword(STRONG_PASSWORD, false);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('LOGIN_BACKOFF');

    // The SAME account, with the trust cookie presented, still verifies.
    const ok = await verifyPassword(STRONG_PASSWORD, true);
    expect(ok.status).toBe(204);
  });

  // Regression: change-password re-verifies via its own inline
  // `verifyWithBackoff` call (not `VerifyPasswordService`), which previously
  // never threaded the caller's device identity at all — a trusted device's
  // password change was blocked exactly like a stranger's guesses.
  it('the bypass reaches POST /auth/change-password too, not just login and verify-password', async () => {
    const { email, userId } = await signupVerifyApprove(t);
    const deviceId = freshDeviceId();
    const s = await loginAndTrustDevice(t, email, userId, deviceId);

    const changePassword = (
      currentPassword: string,
      withTrust: boolean,
    ): request.Test => {
      const req = request(t.app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('X-CSRF-Token', s.csrfValue);
      const cookies = [s.csrfCookie, ...(withTrust ? [s.trustHeader] : [])];
      return req.set('Cookie', cookies.join('; ')).send({
        currentPassword,
        newPassword: 'NewPassw0rd!Rotate',
      });
    };

    // Drive the address counter past the block WITHOUT presenting the trust
    // cookie (an untrusted change-password attempt counts per-address, same
    // as login/verify-password).
    for (let i = 0; i < 4; i++) {
      const miss = await changePassword('WrongPassw0rd!', false);
      expect(miss.status).toBe(401);
    }
    const blocked = await changePassword(STRONG_PASSWORD, false);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('LOGIN_BACKOFF');

    // The SAME account, with the trust cookie presented, clears the password
    // gate — proven by reaching the NEXT gate (the fresh step-up factor,
    // required because this suite runs AUTH_MFA_ENFORCED=true) instead of
    // 429 LOGIN_BACKOFF. A pre-fix build 429s here regardless of the cookie.
    const ok = await changePassword(STRONG_PASSWORD, true);
    expect(ok.status).toBe(400);
    expect(ok.body.error.code).toBe('STEP_UP_PROOF_MISSING');
  });

  // Regression: a device remembered BEFORE the cookie path was widened
  // holds its (still-valid) cookie at `/api/v1/auth`. A browser
  // sends that to login but never to `/api/v1/sync/workspace/clear`, and a
  // trusted login skips the MFA verify that is the only other place the cookie
  // is written — so without a migration that device kept per-address-only
  // behaviour on workspace-clear until its trust expired. Driven through a real
  // path-aware cookie jar seeded the way such a browser holds the cookie.
  it('migrates a pre-widening /api/v1/auth device-trust cookie on its next trusted login, after which the bypass reaches POST /sync/workspace/clear', async () => {
    const { email, userId } = await signupVerifyApprove(t);
    const emailLowercase = email.toLowerCase();
    const deviceId = freshDeviceId();
    const s = await loginAndTrustDevice(t, email, userId, deviceId);
    const repo = t.module.get(FailedLoginAttemptsRepository);

    // Backdate the trust row's TTL to 10 days out, so the re-issued cookie's
    // Max-Age is only correct if it carries the REMAINING lifetime rather
    // than a fresh 30 days.
    const tenDaysSec = 10 * 86_400;
    const trustTable = t.module
      .get(ConfigService)
      .get('TABLE_TRUSTED_DEVICE', { infer: true } as never) as unknown as string;
    await t.doc.send(
      new UpdateCommand({
        TableName: trustTable,
        Key: { userId, deviceId },
        UpdateExpression: 'SET expiresAt = :e',
        ExpressionAttributeValues: { ':e': Math.floor(Date.now() / 1000) + tenDaysSec },
      }),
    );

    // The jar: same name + secret as the live trust, scoped to the narrower
    // pre-widening path (domain pinned to supertest's host so a later
    // Set-Cookie clear at that exact path collides with — and removes — it).
    const browser = request.agent(t.app.getHttpServer());
    browser.jar.setCookie(
      `${DEVICE_TRUST_COOKIE_NAME}=${encodeURIComponent(s.trustSecret)}; Path=/api/v1/auth`,
      '127.0.0.1',
      '/api/v1/auth',
    );
    const clearWorkspace = (accessToken: string, csrfValue: string, cookies: string[]) => {
      const req = browser
        .post('/api/v1/sync/workspace/clear')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${accessToken}`)
        .set('X-CSRF-Token', csrfValue);
      if (cookies.length) req.set('Cookie', cookies.join('; '));
      return req.send({ currentPassword: STRONG_PASSWORD, eraseHistory: false });
    };

    // Another party drives the address counter deep (7 misses → a 16 s
    // window, so this is not runner-speed sensitive).
    for (let i = 0; i < 7; i++) await repo.increment(emailLowercase, TTL_SEC);

    // Pre-migration: the jar does not send a /api/v1/auth cookie to /sync, so
    // the correct password is still refused per-address — the exact gap.
    const before = await clearWorkspace(s.accessToken, s.csrfValue, [s.refreshCookie, s.csrfCookie]);
    expect(before.status).toBe(429);
    expect(before.body.error.code).toBe('LOGIN_BACKOFF');

    // The trusted login (the legacy cookie DOES reach /api/v1/auth/login)
    // bypasses the block and re-issues the cookie: same secret at /api/v1 for
    // the remaining ~10 days, plus a clear of the /api/v1/auth copy.
    const migrate = await browser
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN())
      .send({ email, password: STRONG_PASSWORD, deviceId });
    expect(migrate.status).toBe(200);
    expect((migrate.body as ChallengeResponse).mfaRequired).toBeUndefined();
    const dt = deviceTrustSetCookies(migrate);
    const legacyClear = dt.find((l) => /;\s*Path=\/api\/v1\/auth(;|$)/i.test(l));
    expect(legacyClear).toMatch(/Expires=Thu, 01 Jan 1970/);
    const reissued = dt.find((l) => /;\s*Path=\/api\/v1(;|$)/i.test(l));
    expect(reissued).toBeDefined();
    expect(reissued!.startsWith(`${DEVICE_TRUST_COOKIE_NAME}=${encodeURIComponent(s.trustSecret)};`)).toBe(true);
    const maxAge = Number(/Max-Age=(\d+)/.exec(reissued!)![1]);
    expect(maxAge).toBeGreaterThan(tenDaysSec - 60);
    expect(maxAge).toBeLessThanOrEqual(tenDaysSec);
    // The trust row itself is untouched — no rotation, no re-mint audit.
    const rows = await scanAll<TrustedDeviceRow>(t.doc, trustTable);
    const row = rows.find((r) => r.userId === userId && r.deviceId === deviceId)!;
    expect(row.tokenHash).toBe(sha256(s.trustSecret));
    expect(row.expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + tenDaysSec);

    // Post-migration: the same jar (now holding only the /api/v1 cookie, the
    // legacy one removed by the clear) sends it to /sync, so the correct
    // password clears the workspace through the bypass despite a re-elevated
    // address counter. The login above rotated the session, so use its tokens.
    const migrated = parseSetCookies(migrate.headers['set-cookie']);
    for (let i = 0; i < 7; i++) await repo.increment(emailLowercase, TTL_SEC);
    const after = await clearWorkspace(
      (migrate.body as ChallengeResponse).accessToken!,
      migrated[CSRF_COOKIE_NAME],
      [],
    );
    expect(after.status).toBe(201);
    expect(after.body.ok).toBe(true);
  });
});
