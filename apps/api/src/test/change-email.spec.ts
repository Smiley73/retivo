/**
 * Self-service email-change flow integration tests against the local emulator.
 *
 * Covers: GET /auth/me (typed record + unauthenticated rejection); the happy
 * path (confirm swaps email + moves the EmailReservation); new-email collision
 * (EMAIL_TAKEN) at request + at confirm-race; the per-user change-email send
 * cooldown / daily cap; wrong password; the password-only path (MFA off) +
 * the failed/absent MFA step-up (MFA on, separate app); expired/absent pending
 * intent rejected at send-otp + verify-step-up; stale/superseded change-email
 * token rejected at confirm; pending-PasswordReset invalidated on swap;
 * unauthenticated rejection on every authenticated endpoint; CSRF positive/
 * negative on the authenticated state-changing endpoints (confirm exempt);
 * purpose cross-consumption rejected both ways.
 *
 * The MFA-on block sets AUTH_MFA_ENFORCED=true before bootstrap (read at
 * service construction), restored after — mirrors mfa.spec.ts.
 */
import request from 'supertest';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { generateSync } from 'otplib';
import {
  STRONG_PASSWORD,
  bootstrapTestApp,
  freshDeviceId,
  freshEmail,
  scanAll,
  signupVerifyLogin,
  type Session,
  type TestApp,
  recoverEmailOtp,
  signupAndLoginMfa,
  enrollTotp,
  table,
  authSet,
} from './test-helpers.js';
import { CSRF_COOKIE_NAME } from '../auth/cookie-config.js';
import { sha256 } from '../auth/refresh-token.service.js';
import type {
  AuthEventRow,
  EmailReservationRow,
  EmailVerificationRow,
  PasswordResetRow,
  UserRow,
} from '../dynamo/types.js';

const ORIGIN = () => process.env.WEB_ORIGIN!;
const NEW_PASSWORD = 'BrandNewPassw0rd!2';

interface ChangeEmailRequestResponse {
  stepUpRequired: boolean;
  methods?: string[];
  recoveryMethods?: string[];
  changeEmailToken?: string;
}

async function changeEmailRequest(
  t: TestApp,
  s: Session,
  newEmail: string,
  currentPassword = STRONG_PASSWORD,
): Promise<request.Response> {
  return authSet(s)(
    request(t.app.getHttpServer()).post('/api/v1/auth/change-email/request'),
  ).send({ newEmail, currentPassword });
}

async function confirm(t: TestApp, token: string | undefined): Promise<request.Response> {
  return request(t.app.getHttpServer())
    .post('/api/v1/auth/change-email/confirm')
    .set('Origin', ORIGIN())
    .send({ token });
}

async function countAuthEvents(
  t: TestApp,
  userId: string,
  eventType: AuthEventRow['eventType'],
): Promise<number> {
  const rows = await scanAll<AuthEventRow>(t.doc, table(t, 'TABLE_AUTH_EVENT'));
  return rows.filter((r) => r.userId === userId && r.eventType === eventType).length;
}

async function readUser(t: TestApp, userId: string): Promise<UserRow> {
  const rows = await scanAll<UserRow>(t.doc, table(t, 'TABLE_USER'));
  const row = rows.find((r) => r.userId === userId);
  expect(row).toBeTruthy();
  return row!;
}

/** Clear the change-email send cooldown so a second mint in the same test
 * second is not blocked by the 60s window. */
async function clearChangeEmailCooldown(t: TestApp, userId: string): Promise<void> {
  await t.doc.send(
    new UpdateCommand({
      TableName: table(t, 'TABLE_USER'),
      Key: { userId },
      UpdateExpression: 'REMOVE lastPendingEmailSentAt',
    }),
  );
}

describe('self-service email change', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  describe('GET /auth/me', () => {
    it('returns the typed account record for the caller', async () => {
      const s = await signupVerifyLogin(t);
      const res = await authSet(s)(
        request(t.app.getHttpServer()).get('/api/v1/auth/me'),
      );
      expect(res.status).toBe(200);
      expect(res.body.email).toBe(s.email);
      // The typed serializer never leaks token / pending / cooldown fields.
      expect(res.body).not.toHaveProperty('currentVerificationToken');
      expect(res.body).not.toHaveProperty('pendingEmail');
      expect(res.body).not.toHaveProperty('emailLowercase');
      expect(res.body).not.toHaveProperty('approvalStatus');
    });
  });

  describe('happy path (MFA off — password-only)', () => {
    it('confirm swaps email + emailLowercase + moves the EmailReservation', async () => {
      const s = await signupVerifyLogin(t);
      const newEmail = freshEmail('new');

      const req = await changeEmailRequest(t, s, newEmail);
      expect(req.status).toBe(200);
      const body = req.body as ChangeEmailRequestResponse;
      // MFA off → no step-up, token echoed in dev.
      expect(body.stepUpRequired).toBe(false);
      expect(body.changeEmailToken).toBeTruthy();
      expect(await countAuthEvents(t, s.userId, 'email_change_requested')).toBe(1);

      const conf = await confirm(t, body.changeEmailToken);
      expect(conf.status).toBe(200);
      expect(conf.body.changed).toBe(true);
      expect(conf.body.email).toBe(newEmail);

      // User row swapped + pending cleared.
      const user = await readUser(t, s.userId);
      expect(user.email).toBe(newEmail);
      expect(user.emailLowercase).toBe(newEmail.toLowerCase());
      expect(user.pendingEmail ?? null).toBeNull();
      expect(user.currentPendingEmailToken ?? null).toBeNull();

      // EmailReservation moved old→new.
      const reservations = await scanAll<EmailReservationRow>(
        t.doc,
        table(t, 'TABLE_EMAIL_RESERVATION'),
      );
      expect(reservations.find((r) => r.emailLowercase === newEmail.toLowerCase())?.userId).toBe(
        s.userId,
      );
      expect(
        reservations.find((r) => r.emailLowercase === s.email.toLowerCase()),
      ).toBeUndefined();

      // email_change audit recorded; the new email can sign in.
      expect(await countAuthEvents(t, s.userId, 'email_change')).toBe(1);
      const login = await request(t.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', ORIGIN())
        .send({ email: newEmail, password: STRONG_PASSWORD, deviceId: freshDeviceId() });
      expect(login.status).toBe(200);
    });

    it('invalidates a pending PasswordReset on the swap', async () => {
      const s = await signupVerifyLogin(t);
      // Mint a real reset token for this user.
      const reset = await request(t.app.getHttpServer())
        .post('/api/v1/auth/request-password-reset')
        .set('Origin', ORIGIN())
        .send({ email: s.email });
      expect(reset.status).toBe(202);
      const resetToken = reset.body.resetToken as string;
      expect(resetToken).toBeTruthy();

      const newEmail = freshEmail('new');
      const req = await changeEmailRequest(t, s, newEmail);
      const conf = await confirm(t, (req.body as ChangeEmailRequestResponse).changeEmailToken);
      expect(conf.status).toBe(200);

      // The PasswordReset row is gone + the handle cleared → the link is dead.
      const resetRows = await scanAll<PasswordResetRow>(
        t.doc,
        table(t, 'TABLE_PASSWORD_RESET'),
      );
      expect(resetRows.find((r) => r.userId === s.userId)).toBeUndefined();
      const user = await readUser(t, s.userId);
      expect(user.currentResetToken ?? null).toBeNull();
      const consume = await request(t.app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .set('Origin', ORIGIN())
        .send({ token: resetToken, newPassword: NEW_PASSWORD });
      expect(consume.status).toBe(400);
    });
  });

  describe('request-time validation', () => {
    it('rejects a wrong password with 401', async () => {
      const s = await signupVerifyLogin(t);
      const res = await changeEmailRequest(t, s, freshEmail('new'), 'WrongPassw0rd!x');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('rejects a new email equal to the current one (400)', async () => {
      const s = await signupVerifyLogin(t);
      const res = await changeEmailRequest(t, s, s.email);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('EMAIL_SAME_AS_CURRENT');
    });

    it('rejects a new email already in use (409 EMAIL_TAKEN) at request', async () => {
      const taken = await signupVerifyLogin(t);
      const s = await signupVerifyLogin(t);
      const res = await changeEmailRequest(t, s, taken.email);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EMAIL_TAKEN');
    });
  });

  describe('confirm-time uniqueness race', () => {
    it('rejects with 409 EMAIL_TAKEN when the address is claimed between request and confirm', async () => {
      const s = await signupVerifyLogin(t);
      const targetEmail = freshEmail('race');
      const req = await changeEmailRequest(t, s, targetEmail);
      const token = (req.body as ChangeEmailRequestResponse).changeEmailToken;

      // Someone else claims the target address before confirm.
      const claimant = await signupVerifyLogin(t);
      const claimReq = await changeEmailRequest(t, claimant, targetEmail);
      // The claimant pre-check passes (not yet taken at their request time)…
      expect(claimReq.status).toBe(200);
      const claimConf = await confirm(
        t,
        (claimReq.body as ChangeEmailRequestResponse).changeEmailToken,
      );
      expect(claimConf.status).toBe(200);

      // …so when the first user confirms, the reservation is gone → EMAIL_TAKEN.
      const conf = await confirm(t, token);
      expect(conf.status).toBe(409);
      expect(conf.body.error.code).toBe('EMAIL_TAKEN');
      // The first user's email did NOT move.
      const user = await readUser(t, s.userId);
      expect(user.email).toBe(s.email);
    });
  });

  describe('rate limiting (per-user change-email send)', () => {
    it('blocks a second send inside the cooldown with 409 CHANGE_EMAIL_RATE_LIMITED', async () => {
      const s = await signupVerifyLogin(t);
      const first = await changeEmailRequest(t, s, freshEmail('new'));
      expect(first.status).toBe(200);
      // Second request inside the 60s cooldown (no cooldown clear).
      const second = await changeEmailRequest(t, s, freshEmail('new'));
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('CHANGE_EMAIL_RATE_LIMITED');
    });

    it('blocks once the daily cap is reached', async () => {
      const s = await signupVerifyLogin(t);
      const dayKey = Math.floor(Date.now() / 1000 / 86400);
      await t.doc.send(
        new UpdateCommand({
          TableName: table(t, 'TABLE_USER'),
          Key: { userId: s.userId },
          UpdateExpression:
            'SET pendingEmailSentDayKey = :day, pendingEmailSentToday = :count REMOVE lastPendingEmailSentAt',
          ExpressionAttributeValues: { ':day': dayKey, ':count': 5 },
        }),
      );
      const res = await changeEmailRequest(t, s, freshEmail('new'));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CHANGE_EMAIL_RATE_LIMITED');
    });
  });

  describe('stale / superseded change-email token', () => {
    it('a newer request supersedes the old token → old fails at confirm, no swap', async () => {
      const s = await signupVerifyLogin(t);
      const firstEmail = freshEmail('first');
      const a = await changeEmailRequest(t, s, firstEmail);
      const tokenA = (a.body as ChangeEmailRequestResponse).changeEmailToken;
      expect(tokenA).toBeTruthy();

      // A newer request (different address) supersedes token A. Clear the
      // cooldown so the second mint isn't rate-limited.
      await clearChangeEmailCooldown(t, s.userId);
      const secondEmail = freshEmail('second');
      const b = await changeEmailRequest(t, s, secondEmail);
      const tokenB = (b.body as ChangeEmailRequestResponse).changeEmailToken;
      expect(tokenB).toBeTruthy();
      expect(tokenB).not.toEqual(tokenA);

      // Token A is superseded → 400, no swap.
      const confA = await confirm(t, tokenA);
      expect(confA.status).toBe(400);
      expect(confA.body.error.code).toBe('CHANGE_EMAIL_TOKEN_INVALID');
      expect((await readUser(t, s.userId)).email).toBe(s.email);

      // Token B is the one authoritative link.
      const confB = await confirm(t, tokenB);
      expect(confB.status).toBe(200);
      expect(confB.body.email).toBe(secondEmail);
    });

    it('rejects an expired change-email token with 410', async () => {
      const s = await signupVerifyLogin(t);
      const req = await changeEmailRequest(t, s, freshEmail('new'));
      const token = (req.body as ChangeEmailRequestResponse).changeEmailToken!;
      // Force the EmailVerification row past its TTL.
      await t.doc.send(
        new UpdateCommand({
          TableName: table(t, 'TABLE_EMAIL_VERIFICATION'),
          Key: { verificationToken: sha256(token) },
          UpdateExpression: 'SET expiresAt = :past',
          ExpressionAttributeValues: { ':past': Math.floor(Date.now() / 1000) - 10 },
        }),
      );
      const conf = await confirm(t, token);
      expect(conf.status).toBe(410);
      expect(conf.body.error.code).toBe('CHANGE_EMAIL_TOKEN_EXPIRED');
    });

    it('rejects an unknown confirm token with 400', async () => {
      const conf = await confirm(t, 'a'.repeat(43));
      expect(conf.status).toBe(400);
      expect(conf.body.error.code).toBe('CHANGE_EMAIL_TOKEN_INVALID');
    });
  });

  describe('purpose cross-consumption rejected', () => {
    it('a signup verify-email token is rejected at change-email/confirm', async () => {
      const email = freshEmail();
      const signup = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', ORIGIN())
        .send({ email, password: STRONG_PASSWORD });
      const verifyToken = signup.body.verificationToken as string;
      const conf = await confirm(t, verifyToken);
      expect(conf.status).toBe(400);
      expect(conf.body.error.code).toBe('CHANGE_EMAIL_TOKEN_INVALID');
    });

    it('a change-email token is rejected at verify-email', async () => {
      const s = await signupVerifyLogin(t);
      const req = await changeEmailRequest(t, s, freshEmail('new'));
      const token = (req.body as ChangeEmailRequestResponse).changeEmailToken!;
      const verify = await request(t.app.getHttpServer())
        .post('/api/v1/auth/verify-email')
        .set('Origin', ORIGIN())
        .send({ token });
      expect(verify.status).toBe(400);
      // The change-email token survives (not deleted by the rejected verify).
      const rows = await scanAll<EmailVerificationRow>(
        t.doc,
        table(t, 'TABLE_EMAIL_VERIFICATION'),
      );
      expect(rows.find((r) => r.verificationToken === sha256(token))).toBeTruthy();
    });
  });

  describe('unauthenticated rejection on the authenticated endpoints', () => {
    // A bare unauthenticated request is stopped by the CSRF middleware (403)
    // before the JWT guard. To reach the guard (401) the request must carry a
    // self-consistent double-submit CSRF pair but no bearer token.
    const csrf = 'unauth-csrf-token';
    it.each([
      ['change-email/request', { newEmail: 'x@example.test', currentPassword: STRONG_PASSWORD }],
      ['change-email/send-otp', {}],
      ['change-email/verify-step-up', { method: 'email_otp', code: '000000' }],
    ])('rejects POST /auth/%s without a session (401)', async (path, payload) => {
      const res = await request(t.app.getHttpServer())
        .post(`/api/v1/auth/${path}`)
        .set('Origin', ORIGIN())
        .set('X-CSRF-Token', csrf)
        .set('Cookie', `${CSRF_COOKIE_NAME}=${csrf}`)
        .send(payload);
      expect(res.status).toBe(401);
    });

    it('change-email/confirm is public (no 401 for a missing session) but rejects a bad token', async () => {
      // Confirm is token-authenticated, not session-authenticated — a missing
      // session is fine; the invalid token is what's rejected (400).
      const res = await confirm(t, 'a'.repeat(43));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CHANGE_EMAIL_TOKEN_INVALID');
    });
  });

  describe('CSRF posture', () => {
    it('change-email/confirm is CSRF-exempt (no CSRF token needed)', async () => {
      const s = await signupVerifyLogin(t);
      const req = await changeEmailRequest(t, s, freshEmail('new'));
      const token = (req.body as ChangeEmailRequestResponse).changeEmailToken;
      // No CSRF cookie / header — if confirm were not exempt this would 403.
      const conf = await confirm(t, token);
      expect(conf.status).toBe(200);
    });
  });

  describe('pending-intent rejection on the step-up endpoints (MFA off, no pending)', () => {
    it('send-otp + verify-step-up reject when there is no pending intent', async () => {
      const s = await signupVerifyLogin(t);
      const send = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/change-email/send-otp'),
      ).send({});
      expect(send.status).toBe(409);
      expect(send.body.error.code).toBe('PENDING_EMAIL_CHANGE_EXPIRED');

      const verify = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/change-email/verify-step-up'),
      ).send({ method: 'email_otp', code: '000000' });
      expect(verify.status).toBe(409);
      expect(verify.body.error.code).toBe('PENDING_EMAIL_CHANGE_EXPIRED');
    });

    it('rejects an EXPIRED pending intent at send-otp', async () => {
      const s = await signupVerifyLogin(t);
      // Persist a pending intent, then expire it.
      await changeEmailRequest(t, s, freshEmail('new'));
      await t.doc.send(
        new UpdateCommand({
          TableName: table(t, 'TABLE_USER'),
          Key: { userId: s.userId },
          UpdateExpression: 'SET pendingEmailExpiresAt = :past',
          ExpressionAttributeValues: { ':past': Math.floor(Date.now() / 1000) - 10 },
        }),
      );
      const send = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/change-email/send-otp'),
      ).send({});
      expect(send.status).toBe(409);
      expect(send.body.error.code).toBe('PENDING_EMAIL_CHANGE_EXPIRED');
    });
  });
});

describe('self-service email change — MFA enforced (AUTH_MFA_ENFORCED=true)', () => {
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

  it('request returns stepUpRequired and mints NO token until the factor passes', async () => {
    const s = await signupAndLoginMfa(t);
    const req = await changeEmailRequest(t, s, freshEmail('new'));
    expect(req.status).toBe(200);
    const body = req.body as ChangeEmailRequestResponse;
    expect(body.stepUpRequired).toBe(true);
    expect(body.changeEmailToken).toBeUndefined();
    expect(body.methods).toContain('email_otp');
    // No EmailVerification token minted yet (no change_email row for this user).
    const evRows = await scanAll<EmailVerificationRow>(
      t.doc,
      table(t, 'TABLE_EMAIL_VERIFICATION'),
    );
    expect(
      evRows.filter((r) => r.userId === s.userId && r.purpose === 'change_email'),
    ).toHaveLength(0);
  });

  it('completes via a TOTP step-up factor and confirm swaps the email', async () => {
    const s = await signupAndLoginMfa(t);
    // Enroll TOTP so the routine step-up factor is TOTP (no email send needed).
    const secret = await enrollTotp(t, s);

    const newEmail = freshEmail('new');
    const req = await changeEmailRequest(t, s, newEmail);
    expect((req.body as ChangeEmailRequestResponse).stepUpRequired).toBe(true);
    expect((req.body as ChangeEmailRequestResponse).methods).toContain('totp');

    const verify = await authSet(s)(
      request(t.app.getHttpServer()).post('/api/v1/auth/change-email/verify-step-up'),
    ).send({ method: 'totp', code: generateSync({ secret }) });
    expect(verify.status).toBe(200);
    const token = (verify.body as ChangeEmailRequestResponse).changeEmailToken;
    expect(token).toBeTruthy();

    const conf = await confirm(t, token);
    expect(conf.status).toBe(200);
    expect(conf.body.email).toBe(newEmail);
  });

  it('rejects a wrong step-up code with 401 MFA_CODE_INVALID and mints no token', async () => {
    const s = await signupAndLoginMfa(t);
    await enrollTotp(t, s);

    await changeEmailRequest(t, s, freshEmail('new'));
    const verify = await authSet(s)(
      request(t.app.getHttpServer()).post('/api/v1/auth/change-email/verify-step-up'),
    ).send({ method: 'totp', code: '000000' });
    expect(verify.status).toBe(401);
    expect(verify.body.error.code).toBe('MFA_CODE_INVALID');
    const evRows = await scanAll<EmailVerificationRow>(
      t.doc,
      table(t, 'TABLE_EMAIL_VERIFICATION'),
    );
    expect(
      evRows.filter((r) => r.userId === s.userId && r.purpose === 'change_email'),
    ).toHaveLength(0);
  });

  it('completes via an email-OTP step-up factor and confirm swaps the email', async () => {
    const s = await signupAndLoginMfa(t);
    // No TOTP enrolled — email_otp is the primary MFA step-up factor.
    const newEmail = freshEmail('new');
    const req = await changeEmailRequest(t, s, newEmail);
    const reqBody = req.body as ChangeEmailRequestResponse;
    expect(req.status).toBe(200);
    expect(reqBody.stepUpRequired).toBe(true);
    expect(reqBody.methods).toContain('email_otp');

    // The login flow just sent an email OTP, so the shared per-user Email-OTP
    // cooldown is still active. Clear it so this fresh step-up send is not a
    // silent no-op (mirrors clearChangeEmailCooldown for the reset-anchor case).
    await t.doc.send(
      new UpdateCommand({
        TableName: table(t, 'TABLE_USER'),
        Key: { userId: s.userId },
        UpdateExpression: 'REMOVE mfaEmailOtpLastSentAt',
      }),
    );

    // Trigger the OTP send.
    const sendOtp = await authSet(s)(
      request(t.app.getHttpServer()).post('/api/v1/auth/change-email/send-otp'),
    ).send({});
    expect(sendOtp.status).toBe(202);

    // Recover the OTP preimage from the MFA email OTP table.
    const code = await recoverEmailOtp(t, s.userId);

    // Verify step-up with the email_otp factor → mints the change-email token.
    const verify = await authSet(s)(
      request(t.app.getHttpServer()).post('/api/v1/auth/change-email/verify-step-up'),
    ).send({ method: 'email_otp', code });
    expect(verify.status).toBe(200);
    const token = (verify.body as ChangeEmailRequestResponse).changeEmailToken;
    expect(token).toBeTruthy();

    // Confirm the email swap.
    const conf = await confirm(t, token);
    expect(conf.status).toBe(200);
    expect(conf.body.email).toBe(newEmail);
  });

});
