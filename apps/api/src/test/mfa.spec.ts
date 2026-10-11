/**
 * MFA endpoint integration tests against the local emulator. Covers the two-step login
 * challenge (TOTP, Email-OTP, and passkey), trusted-device skip, routine-vs-recovery trust
 * eligibility, retired backup-code rejection, the auth-rejection matrix, and the CSRF-exemption of
 * the pre-session MFA endpoints.
 *
 * Runs with AUTH_MFA_ENFORCED=true (set before bootstrap, restored after) so
 * `POST /auth/login` returns a challenge instead of a session. Email-OTP codes
 * are hashed at rest (sha256), so tests recover the live code by brute-forcing
 * the 6-digit space against the stored `codeHash` — cheap (1M sha256) and the
 * only handle without a dev-shortcut.
 */
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { generateSecret, generateSync } from 'otplib';
import {
  STRONG_PASSWORD,
  bootstrapTestApp,
  freshDeviceId,
  parseSetCookies,
  scanAll,
  type TestApp,
  recoverEmailOtp,
  signupVerifyApprove,
  loginRaw,
  completeEmailOtpLogin,
  enrollTotp,
  sendAndRecoverStepUpOtp,
} from './test-helpers.js';
import type { AuthEventRow } from '../dynamo/types.js';
import {
  REFRESH_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  DEVICE_TRUST_COOKIE_NAME,
} from '../auth/cookie-config.js';

interface ChallengeResponse {
  mfaRequired?: true;
  challengeToken?: string;
  methods?: string[];
  recoveryMethods?: string[];
  accessToken?: string;
  deviceRemembered?: boolean;
}

const ORIGIN = () => process.env.WEB_ORIGIN!;

/** Clear the per-user Email-OTP send cooldown anchor so a second send for the
 * same user in the same test second is not silently no-op'd by the 60s window. */
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

/** Every AuthEvent row for `userId`, newest scan order not guaranteed —
 * callers filter/sort as needed (ip/userAgent assertions, lock-crossing
 * counts). */
async function authEventsFor(t: TestApp, userId: string): Promise<AuthEventRow[]> {
  const table = t.module
    .get(ConfigService)
    .get('TABLE_AUTH_EVENT', { infer: true } as never) as unknown as string;
  const rows = await scanAll<AuthEventRow>(t.doc, table);
  return rows.filter((r) => r.userId === userId);
}

/** A syntactically-valid TOTP code that cannot verify for `secret` — drawn
 * from an unrelated freshly-generated secret. */
function wrongTotpCode(secret: string): string {
  let candidate: string;
  do {
    candidate = generateSync({ secret: generateSecret() });
  } while (candidate === generateSync({ secret }));
  return candidate;
}

/** Authenticated bearer + CSRF headers for a session response. */
function authHeaders(res: request.Response): {
  accessToken: string;
  refreshCookie: string;
  csrfCookie: string;
  csrfValue: string;
} {
  const cookies = parseSetCookies(res.headers['set-cookie']);
  const csrfValue = cookies[CSRF_COOKIE_NAME];
  return {
    accessToken: (res.body as ChallengeResponse).accessToken!,
    refreshCookie: `${REFRESH_COOKIE_NAME}=${encodeURIComponent(cookies[REFRESH_COOKIE_NAME])}`,
    csrfCookie: `${CSRF_COOKIE_NAME}=${encodeURIComponent(csrfValue)}`,
    csrfValue,
  };
}

describe('enforced MFA endpoints', () => {
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

  describe('two-step login — email OTP path', () => {
    it('login returns a challenge, then email-OTP verify issues a session', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();

      const login = await loginRaw(t, email, deviceId);
      expect(login.status).toBe(200);
      const challenge = login.body as ChallengeResponse;
      expect(challenge.mfaRequired).toBe(true);
      expect(challenge.challengeToken).toBeTruthy();
      // No TOTP enrolled → email_otp is the routine factor.
      expect(challenge.methods).toEqual(['email_otp']);
      expect(challenge.recoveryMethods).toEqual(['email_otp']);
      // No session cookies on the challenge response.
      const challengeCookies = parseSetCookies(login.headers['set-cookie']);
      expect(challengeCookies[REFRESH_COOKIE_NAME]).toBeUndefined();

      const verify = await completeEmailOtpLogin(t, email, userId, deviceId);
      expect(verify.status).toBe(200);
      expect((verify.body as ChallengeResponse).accessToken).toBeTruthy();
      const cookies = parseSetCookies(verify.headers['set-cookie']);
      expect(cookies[REFRESH_COOKIE_NAME]).toBeTruthy();
      expect(cookies[CSRF_COOKIE_NAME]).toBeTruthy();
    });
  });

  describe('MFA challenge device binding', () => {
    it('rejects a verify whose deviceId differs from the challenge-bound device — before any factor/session/trust work', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const loginDevice = freshDeviceId();

      const login = await loginRaw(t, email, loginDevice);
      expect(login.status).toBe(200);
      const challenge = login.body as ChallengeResponse;
      expect(challenge.challengeToken).toBeTruthy();

      // Recover a genuinely VALID email-OTP so the ONLY thing wrong is the
      // substituted device — proving the device check fires before factor
      // verification (a valid code still can't complete on a foreign device).
      await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/email/send')
        .set('Origin', ORIGIN())
        .send({ challengeToken: challenge.challengeToken })
        .expect(202);
      const code = await recoverEmailOtp(t, userId);

      const substituteDevice = freshDeviceId();
      const verify = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/verify')
        .set('Origin', ORIGIN())
        .send({
          challengeToken: challenge.challengeToken,
          method: 'email_otp',
          code,
          deviceId: substituteDevice,
          rememberDevice: true,
        });
      // Maps to the existing MFA_CHALLENGE_INVALID response, not
      // MFA_CODE_INVALID — the device mismatch is caught before the factor.
      expect(verify.status).toBe(401);
      expect(verify.body.error.code).toBe('MFA_CHALLENGE_INVALID');
      // No session and no trusted-device cookie were created.
      const cookies = parseSetCookies(verify.headers['set-cookie']);
      expect(cookies[REFRESH_COOKIE_NAME]).toBeUndefined();
      expect(cookies[DEVICE_TRUST_COOKIE_NAME]).toBeUndefined();

      // Prove the rejected attempt did NOT consume the one-time OTP: reuse the
      // SAME challenge token and SAME code on the CORRECT (challenge-bound)
      // device and it must still succeed. If the device check ran AFTER factor
      // verification, this second attempt would fail MFA_CODE_INVALID because
      // the code was already burned.
      const retry = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/verify')
        .set('Origin', ORIGIN())
        .send({
          challengeToken: challenge.challengeToken,
          method: 'email_otp',
          code,
          deviceId: loginDevice,
        });
      expect(retry.status).toBe(200);
      expect((retry.body as ChallengeResponse).accessToken).toBeTruthy();
      const retryCookies = parseSetCookies(retry.headers['set-cookie']);
      expect(retryCookies[REFRESH_COOKIE_NAME]).toBeTruthy();
    });

    it('accepts a verify on the challenge-bound device (control)', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();
      const verify = await completeEmailOtpLogin(t, email, userId, deviceId);
      expect(verify.status).toBe(200);
      expect((verify.body as ChallengeResponse).accessToken).toBeTruthy();
    });
  });

  describe('MFA challenge single-use', () => {
    it('rejects a sequential replay of a completed challenge and mints no second session', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();

      const login = await loginRaw(t, email, deviceId);
      expect(login.status).toBe(200);
      const challengeToken = (login.body as ChallengeResponse).challengeToken!;

      // First completion succeeds and consumes the challenge's single-use jti.
      await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/email/send')
        .set('Origin', ORIGIN())
        .send({ challengeToken })
        .expect(202);
      const firstCode = await recoverEmailOtp(t, userId);
      const first = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/verify')
        .set('Origin', ORIGIN())
        .send({ challengeToken, method: 'email_otp', code: firstCode, deviceId });
      expect(first.status).toBe(200);
      expect((first.body as ChallengeResponse).accessToken).toBeTruthy();

      // Replay the SAME (still-unexpired) challenge with a genuinely valid,
      // freshly-issued OTP so the ONLY thing wrong is the already-consumed
      // challenge — proving the single-use ledger, not the one-time OTP, rejects
      // the replay.
      await clearEmailOtpCooldown(t, userId);
      await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/email/send')
        .set('Origin', ORIGIN())
        .send({ challengeToken })
        .expect(202);
      const secondCode = await recoverEmailOtp(t, userId);
      const replay = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/verify')
        .set('Origin', ORIGIN())
        .send({ challengeToken, method: 'email_otp', code: secondCode, deviceId });
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('MFA_CHALLENGE_INVALID');
      // No alternative session was minted on the rejected replay.
      const cookies = parseSetCookies(replay.headers['set-cookie']);
      expect(cookies[REFRESH_COOKIE_NAME]).toBeUndefined();
    });

    it('allows exactly one winner across a concurrent replay of the same challenge', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();

      const login = await loginRaw(t, email, deviceId);
      const challengeToken = (login.body as ChallengeResponse).challengeToken!;
      await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/email/send')
        .set('Origin', ORIGIN())
        .send({ challengeToken })
        .expect(202);
      const code = await recoverEmailOtp(t, userId);

      // Fire two identical completions concurrently. The single-winner
      // conditional PutItem on the challenge jti admits exactly one; the loser
      // races on either the OTP (single-use) or the challenge and is rejected.
      const [a, b] = await Promise.all([
        request(t.app.getHttpServer())
          .post('/api/v1/auth/mfa/verify')
          .set('Origin', ORIGIN())
          .send({ challengeToken, method: 'email_otp', code, deviceId }),
        request(t.app.getHttpServer())
          .post('/api/v1/auth/mfa/verify')
          .set('Origin', ORIGIN())
          .send({ challengeToken, method: 'email_otp', code, deviceId }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 401]);
      const winner = a.status === 200 ? a : b;
      expect((winner.body as ChallengeResponse).accessToken).toBeTruthy();
    });

    it('admits exactly one winner across a concurrent TOTP replay of the same challenge', async () => {
      // A REUSABLE factor (TOTP) — unlike a single-use email OTP — is NOT
      // consumed by a verify attempt, so both concurrent requests genuinely
      // pass factor verification with the SAME valid code and race solely on
      // the challenge-jti single-use conditional PutItem
      // (RevokedTokensRepository.consumeMfaChallenge). Exactly one may win; the
      // loser gets MFA_CHALLENGE_INVALID and no session.
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();

      // Bootstrap a session via email-OTP, then enroll TOTP so a re-login
      // presents a TOTP challenge.
      const first = await completeEmailOtpLogin(t, email, userId, deviceId);
      const secret = await enrollTotp(t, authHeaders(first));

      const newDevice = freshDeviceId();
      const login = await loginRaw(t, email, newDevice);
      expect(login.status).toBe(200);
      const challenge = login.body as ChallengeResponse;
      expect(challenge.methods).toEqual(['totp']);
      const challengeToken = challenge.challengeToken!;
      const code = generateSync({ secret });

      // Fire two identical TOTP completions concurrently on the same challenge.
      const [a, b] = await Promise.all([
        request(t.app.getHttpServer())
          .post('/api/v1/auth/mfa/verify')
          .set('Origin', ORIGIN())
          .send({ challengeToken, method: 'totp', code, deviceId: newDevice }),
        request(t.app.getHttpServer())
          .post('/api/v1/auth/mfa/verify')
          .set('Origin', ORIGIN())
          .send({ challengeToken, method: 'totp', code, deviceId: newDevice }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 401]);
      const winner = a.status === 200 ? a : b;
      const loser = a.status === 200 ? b : a;
      expect((winner.body as ChallengeResponse).accessToken).toBeTruthy();
      // The loser is rejected as an already-consumed challenge and mints no
      // session — no refresh cookie on the losing response.
      expect(loser.body.error.code).toBe('MFA_CHALLENGE_INVALID');
      const loserCookies = parseSetCookies(loser.headers['set-cookie']);
      expect(loserCookies[REFRESH_COOKIE_NAME]).toBeUndefined();
    });
  });

  describe('trusted-device skip', () => {
    it('a routine-factor verify with rememberDevice lets the next login skip the challenge', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();

      // First login: complete email-OTP (the routine factor here) + remember.
      const verify = await completeEmailOtpLogin(t, email, userId, deviceId, true);
      expect(verify.status).toBe(200);
      expect((verify.body as ChallengeResponse).deviceRemembered).toBe(true);
      const cookies = parseSetCookies(verify.headers['set-cookie']);
      const trust = cookies[DEVICE_TRUST_COOKIE_NAME];
      expect(trust).toBeTruthy();

      // Second login: same deviceId + trust cookie → session directly.
      const trustHeader = `${DEVICE_TRUST_COOKIE_NAME}=${encodeURIComponent(trust)}`;
      const second = await loginRaw(t, email, deviceId, [trustHeader]);
      expect(second.status).toBe(200);
      expect((second.body as ChallengeResponse).mfaRequired).toBeUndefined();
      expect((second.body as ChallengeResponse).accessToken).toBeTruthy();
      const secondCookies = parseSetCookies(second.headers['set-cookie']);
      expect(secondCookies[REFRESH_COOKIE_NAME]).toBeTruthy();
    });
  });

  describe('isRoutineFactor denial', () => {
    it('email_otp used as recovery on a TOTP account issues a session but mints no trust', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();

      // Bootstrap + enroll TOTP so email_otp becomes a recovery factor.
      const first = await completeEmailOtpLogin(t, email, userId, deviceId);
      await enrollTotp(t, authHeaders(first));

      // Re-login, verify via email_otp (recovery) with rememberDevice.
      const newDevice = freshDeviceId();
      const login = await loginRaw(t, email, newDevice);
      const challengeToken = (login.body as ChallengeResponse).challengeToken!;
      // Second send for the same user — clear the 60s cooldown first.
      await clearEmailOtpCooldown(t, userId);
      await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/email/send')
        .set('Origin', ORIGIN())
        .send({ challengeToken })
        .expect(202);
      const code = await recoverEmailOtp(t, userId);
      const verify = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/verify')
        .set('Origin', ORIGIN())
        .send({
          challengeToken,
          method: 'email_otp',
          code,
          deviceId: newDevice,
          rememberDevice: true,
        });
      expect(verify.status).toBe(200);
      // Session issued, but recovery-factor email_otp is NOT routine → no trust.
      expect((verify.body as ChallengeResponse).deviceRemembered).toBe(false);
      const cookies = parseSetCookies(verify.headers['set-cookie']);
      expect(cookies[DEVICE_TRUST_COOKIE_NAME]).toBeUndefined();
    });
  });

  describe('retired backup-code generation endpoint', () => {
    it('returns 404 for an authenticated stale client', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();
      const s = authHeaders(await completeEmailOtpLogin(t, email, userId, deviceId));
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/backup-codes/regenerate')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('X-CSRF-Token', s.csrfValue)
        .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
        .send({ currentPassword: STRONG_PASSWORD });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('totp/disable — password-only step-up + status reflects disable', () => {
    it('correct password → 200 and status reports totpEnabled:false', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();
      const s = authHeaders(await completeEmailOtpLogin(t, email, userId, deviceId));
      await enrollTotp(t, s);

      // Sanity: status reports TOTP enabled and no retired backup-code field.
      const before = await request(t.app.getHttpServer())
        .get('/api/v1/auth/mfa/status')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`);
      expect(before.status).toBe(200);
      expect(before.body.totpEnabled).toBe(true);
      expect(before.body).not.toHaveProperty('backupCodesCount');

      // Step-up: password + the Email-OTP no-lockout floor (the flag is on).
      const disableCode = await sendAndRecoverStepUpOtp(t, s, 'mfa_totp_disable');
      const disable = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/totp/disable')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('X-CSRF-Token', s.csrfValue)
        .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
        .send({ currentPassword: STRONG_PASSWORD, method: 'email_otp', code: disableCode });
      expect(disable.status).toBe(200);
      expect(disable.body.totpEnabled).toBe(false);

      const after = await request(t.app.getHttpServer())
        .get('/api/v1/auth/mfa/status')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`);
      expect(after.status).toBe(200);
      expect(after.body.totpEnabled).toBe(false);
      expect(after.body).not.toHaveProperty('backupCodesCount');
    });

    it('a wrong password → 401 INVALID_CREDENTIALS and leaves the factor enabled', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();
      const s = authHeaders(await completeEmailOtpLogin(t, email, userId, deviceId));
      await enrollTotp(t, s);

      const disable = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/totp/disable')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('X-CSRF-Token', s.csrfValue)
        .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
        .send({ currentPassword: 'WrongPassw0rd!Nope' });
      expect(disable.status).toBe(401);
      expect(disable.body.error.code).toBe('INVALID_CREDENTIALS');

      const status = await request(t.app.getHttpServer())
        .get('/api/v1/auth/mfa/status')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`);
      expect(status.body.totpEnabled).toBe(true);
    });

    it('a missing currentPassword → 400 BAD_REQUEST', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();
      const s = authHeaders(await completeEmailOtpLogin(t, email, userId, deviceId));
      await enrollTotp(t, s);

      const disable = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/totp/disable')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('X-CSRF-Token', s.csrfValue)
        .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
        .send({});
      expect(disable.status).toBe(400);
    });

    it('a currentPassword over the 256-char bound → 400, factor still enabled', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();
      const s = authHeaders(await completeEmailOtpLogin(t, email, userId, deviceId));
      await enrollTotp(t, s);

      // 257 chars exceeds @MaxLength(256) → the ValidationPipe 400s before the
      // password is ever checked, so the factor is untouched.
      const disable = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/totp/disable')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('X-CSRF-Token', s.csrfValue)
        .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
        .send({ currentPassword: 'a'.repeat(257) });
      expect(disable.status).toBe(400);

      const status = await request(t.app.getHttpServer())
        .get('/api/v1/auth/mfa/status')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`);
      expect(status.body.totpEnabled).toBe(true);
    });

    it('disable when no TOTP is enabled is idempotent → 200 { totpEnabled: false }', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();
      const s = authHeaders(await completeEmailOtpLogin(t, email, userId, deviceId));
      // No enrollTotp — the account has no enabled factor. Email-OTP is the
      // no-lockout step-up floor (the flag is on).
      const code = await sendAndRecoverStepUpOtp(t, s, 'mfa_totp_disable');
      const disable = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/totp/disable')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('X-CSRF-Token', s.csrfValue)
        .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
        .send({ currentPassword: STRONG_PASSWORD, method: 'email_otp', code });
      expect(disable.status).toBe(200);
      expect(disable.body.totpEnabled).toBe(false);
    });

    it('records mfa_totp_disabled with the caller ip/userAgent', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();
      const s = authHeaders(await completeEmailOtpLogin(t, email, userId, deviceId));
      await enrollTotp(t, s);

      const disableCode = await sendAndRecoverStepUpOtp(t, s, 'mfa_totp_disable');
      const disable = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/totp/disable')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('X-CSRF-Token', s.csrfValue)
        .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
        .set('User-Agent', 'jest-mfa-disable-agent')
        .send({ currentPassword: STRONG_PASSWORD, method: 'email_otp', code: disableCode });
      expect(disable.status).toBe(200);

      const events = await authEventsFor(t, userId);
      const disabled = events.find((e) => e.eventType === 'mfa_totp_disabled');
      expect(disabled).toBeTruthy();
      expect(disabled!.ip).toBeTruthy();
      expect(disabled!.userAgent).toBe('jest-mfa-disable-agent');
    });
  });

  describe('mfa/status', () => {
    it('returns the factor status for an enrolled user', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();
      const s = authHeaders(await completeEmailOtpLogin(t, email, userId, deviceId));
      await enrollTotp(t, s);

      const status = await request(t.app.getHttpServer())
        .get('/api/v1/auth/mfa/status')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`);
      expect(status.status).toBe(200);
      expect(status.body.totpEnabled).toBe(true);
      expect(status.body).not.toHaveProperty('backupCodesCount');
      expect(status.body.enrolledAt).toBeTruthy();
    });
  });

  describe('mfa/trusted-devices', () => {
    it('lists a device trusted via a routine-factor rememberDevice verify', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();
      // Email-OTP is the routine factor (no TOTP) → rememberDevice mints trust.
      const verify = await completeEmailOtpLogin(t, email, userId, deviceId, true);
      expect((verify.body as ChallengeResponse).deviceRemembered).toBe(true);
      const s = authHeaders(verify);

      const list = await request(t.app.getHttpServer())
        .get('/api/v1/auth/mfa/trusted-devices')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`);
      expect(list.status).toBe(200);
      const ids = (list.body.devices as { deviceId: string }[]).map((d) => d.deviceId);
      expect(ids).toContain(deviceId);
    });
  });

  describe('mfa/trusted-devices/forget', () => {
    it('forgetting all trusted devices re-challenges the device on its next login', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();
      // Trust the device on first login.
      const verify = await completeEmailOtpLogin(t, email, userId, deviceId, true);
      const cookies = parseSetCookies(verify.headers['set-cookie']);
      const trust = cookies[DEVICE_TRUST_COOKIE_NAME];
      expect(trust).toBeTruthy();
      const s = authHeaders(verify);

      // Forget every trusted device (omitted list).
      const forget = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/trusted-devices/forget')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('X-CSRF-Token', s.csrfValue)
        .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
        .send({});
      expect(forget.status).toBe(204);

      // The forget-all response must clear the
      // device-trust cookie at BOTH its live `/api/v1` path and its
      // older `/api/v1/auth` path, since a browser that
      // minted its cookie before the path was widened still holds a
      // same-name cookie scoped to the narrower path that a single-path
      // clear cannot reach.
      const setCookieHeaders = (
        Array.isArray(forget.headers['set-cookie'])
          ? forget.headers['set-cookie']
          : [forget.headers['set-cookie']]
      ) as string[];
      const deviceTrustClears = setCookieHeaders.filter((h) =>
        h.startsWith(`${DEVICE_TRUST_COOKIE_NAME}=;`),
      );
      expect(deviceTrustClears.some((h) => h.includes('Path=/api/v1;'))).toBe(true);
      expect(deviceTrustClears.some((h) => h.includes('Path=/api/v1/auth;'))).toBe(true);

      // The previously-trusted device, presenting its old trust cookie, is now
      // challenged again rather than getting a session directly.
      const trustHeader = `${DEVICE_TRUST_COOKIE_NAME}=${encodeURIComponent(trust)}`;
      const relogin = await loginRaw(t, email, deviceId, [trustHeader]);
      expect(relogin.status).toBe(200);
      expect((relogin.body as ChallengeResponse).mfaRequired).toBe(true);
      expect((relogin.body as ChallengeResponse).accessToken).toBeUndefined();
    });

    it('records mfa_device_forgotten with the caller ip/userAgent', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();
      const verify = await completeEmailOtpLogin(t, email, userId, deviceId, true);
      const s = authHeaders(verify);

      const forget = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/trusted-devices/forget')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('X-CSRF-Token', s.csrfValue)
        .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
        .set('User-Agent', 'jest-mfa-forget-agent')
        .send({});
      expect(forget.status).toBe(204);

      const events = await authEventsFor(t, userId);
      const forgotten = events.find((e) => e.eventType === 'mfa_device_forgotten');
      expect(forgotten).toBeTruthy();
      expect(forgotten!.ip).toBeTruthy();
      expect(forgotten!.userAgent).toBe('jest-mfa-forget-agent');
    });
  });

  describe('totp/enroll — auth + confirm-without-pending', () => {
    it('totp/enroll/confirm with no pending enrollment → 401 MFA_CODE_INVALID', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();
      const s = authHeaders(await completeEmailOtpLogin(t, email, userId, deviceId));

      // Authenticated + a valid enrollment-gate proof (otherwise the gate itself, not the
      // pending-secret check, rejects the request), but enroll/start was never called → no pending
      // secret, so enrollConfirm returns false and the controller maps that to 401.
      const otpCode = await sendAndRecoverStepUpOtp(t, s, 'mfa_totp_enroll');
      const confirm = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/totp/enroll/confirm')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('X-CSRF-Token', s.csrfValue)
        .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
        .send({
          code: '000000',
          stepUp: { currentPassword: STRONG_PASSWORD, method: 'email_otp', code: otpCode },
        });
      expect(confirm.status).toBe(401);
      expect(confirm.body.error.code).toBe('MFA_CODE_INVALID');
    });

    it('records mfa_totp_enrolled with the caller ip/userAgent', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();
      const s = authHeaders(await completeEmailOtpLogin(t, email, userId, deviceId));

      const start = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/totp/enroll/start')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('X-CSRF-Token', s.csrfValue)
        .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
        .send({});
      const secret = start.body.secret as string;
      const otpCode = await sendAndRecoverStepUpOtp(t, s, 'mfa_totp_enroll');
      const confirm = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/totp/enroll/confirm')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('X-CSRF-Token', s.csrfValue)
        .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
        .set('User-Agent', 'jest-mfa-enroll-agent')
        .send({
          code: generateSync({ secret }),
          stepUp: { currentPassword: STRONG_PASSWORD, method: 'email_otp', code: otpCode },
        });
      expect(confirm.status).toBe(200);

      const events = await authEventsFor(t, userId);
      const enrolled = events.find((e) => e.eventType === 'mfa_totp_enrolled');
      expect(enrolled).toBeTruthy();
      expect(enrolled!.ip).toBeTruthy();
      expect(enrolled!.userAgent).toBe('jest-mfa-enroll-agent');
    });
  });

  describe('per-account TOTP lock', () => {
    /** Enroll TOTP on a fresh account and open a TOTP challenge on a new
     * device. The single-use challenge is only consumed AFTER a successful
     * factor check, so a wrong/locked TOTP attempt never burns it — the
     * returned `verifyTotp` reuses the same challenge token every call. */
    async function enrollAndChallenge(): Promise<{
      userId: string;
      secret: string;
      challengeToken: string;
      loginDevice: string;
      verifyTotp: (code: string) => request.Test;
    }> {
      const { email, userId } = await signupVerifyApprove(t);
      // Bootstrap an authenticated session (no TOTP yet) to enroll TOTP.
      const bootstrap = authHeaders(
        await completeEmailOtpLogin(t, email, userId, freshDeviceId()),
      );
      const secret = await enrollTotp(t, bootstrap);

      // A fresh login now offers TOTP as the routine factor.
      const loginDevice = freshDeviceId();
      const login = await loginRaw(t, email, loginDevice);
      expect(login.status).toBe(200);
      const challenge = login.body as ChallengeResponse;
      expect(challenge.methods).toEqual(['totp']);
      expect(challenge.recoveryMethods).toEqual(['email_otp']);
      const challengeToken = challenge.challengeToken!;

      const verifyTotp = (code: string) =>
        request(t.app.getHttpServer())
          .post('/api/v1/auth/mfa/verify')
          .set('Origin', ORIGIN())
          .send({ challengeToken, method: 'totp', code, deviceId: loginDevice });
      return { userId, secret, challengeToken, loginDevice, verifyTotp };
    }

    it('locks after repeated wrong codes, refuses the correct code too, and the SAME challenge still completes via email OTP (factor-scoped)', async () => {
      const { userId, secret, challengeToken, loginDevice, verifyTotp } =
        await enrollAndChallenge();

      // 3 free (grace) misses, then the 4th miss — compared like any other
      // (a plain wrong code), and the one that trips the lock.
      for (let i = 0; i < 4; i++) {
        const res = await verifyTotp(wrongTotpCode(secret));
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('MFA_CODE_INVALID');
      }

      // Inside the window the correct code is refused too — proving this is
      // an account-scoped lock, not merely a counter that happens to reject
      // wrong guesses.
      const lockedWithCorrectCode = await verifyTotp(generateSync({ secret }));
      expect(lockedWithCorrectCode.status).toBe(429);
      expect(lockedWithCorrectCode.body.error.code).toBe('RATE_LIMITED');

      // The lock is scoped to the TOTP factor: the SAME challenge still
      // completes via email OTP. Clear the per-user send cooldown first — the
      // bootstrap login above already sent+consumed one code for this user.
      await clearEmailOtpCooldown(t, userId);
      await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/email/send')
        .set('Origin', ORIGIN())
        .send({ challengeToken })
        .expect(202);
      const emailCode = await recoverEmailOtp(t, userId);
      const viaEmailOtp = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/verify')
        .set('Origin', ORIGIN())
        .send({ challengeToken, method: 'email_otp', code: emailCode, deviceId: loginDevice });
      expect(viaEmailOtp.status).toBe(200);
      expect((viaEmailOtp.body as ChallengeResponse).accessToken).toBeTruthy();

      // The threshold crossing is audited exactly once, not once per refusal
      // (six verify attempts hit the endpoint above; the lock event fires once).
      const events = await authEventsFor(t, userId);
      const lockEvents = events.filter((e) => e.eventType === 'mfa_totp_locked');
      expect(lockEvents).toHaveLength(1);
    });
  });

  describe('auth-rejection matrix', () => {
    it('mfa/verify with an invalid challenge token → 401', async () => {
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/verify')
        .set('Origin', ORIGIN())
        .send({
          challengeToken: 'not-a-valid-challenge-jwt',
          method: 'email_otp',
          code: '000000',
          deviceId: freshDeviceId(),
        });
      expect(res.status).toBe(401);
    });
  });

  describe('CSRF — MFA public endpoints are exempt', () => {
    it('mfa/email/send and mfa/verify succeed without an X-CSRF-Token header', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();
      const login = await loginRaw(t, email, deviceId);
      const challengeToken = (login.body as ChallengeResponse).challengeToken!;

      // No CSRF cookie/header present at all — endpoint is exempt.
      const send = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/email/send')
        .set('Origin', ORIGIN())
        .send({ challengeToken });
      expect(send.status).toBe(202);

      const code = await recoverEmailOtp(t, userId);
      const verify = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/verify')
        .set('Origin', ORIGIN())
        .send({ challengeToken, method: 'email_otp', code, deviceId });
      expect(verify.status).toBe(200);
      expect((verify.body as ChallengeResponse).accessToken).toBeTruthy();
    });
  });
});
