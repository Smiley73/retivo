// MFA endpoints with AUTH_MFA_ENFORCED=true: two-step login (TOTP, Email-OTP, passkey), trusted-device skip and trust eligibility, retired backup
// codes, the auth-rejection matrix and CSRF exemption. Email-OTP codes are stored as sha256, so tests recover the live code by brute force.
import { randomUUID } from 'node:crypto';
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
  authSet,
  freshEmail,
} from './test-helpers.js';
import type { AuthEventRow, PasskeyRow } from '../dynamo/types.js';
import { PasskeysRepository } from '../dynamo/passkeys.repository.js';
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

// Clears the 60s Email-OTP send cooldown so a second send for the same user is not a silent no-op.
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

async function authEventsFor(t: TestApp, userId: string): Promise<AuthEventRow[]> {
  const table = t.module
    .get(ConfigService)
    .get('TABLE_AUTH_EVENT', { infer: true } as never) as unknown as string;
  const rows = await scanAll<AuthEventRow>(t.doc, table);
  return rows.filter((r) => r.userId === userId);
}

function seedPasskeyRow(userId: string, overrides: Partial<PasskeyRow> = {}): PasskeyRow {
  return {
    userId,
    credentialId: randomUUID(),
    publicKey: Buffer.from('pk').toString('base64url'),
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
    transports: null,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    ...overrides,
  };
}

function wrongTotpCode(secret: string): string {
  let candidate: string;
  do {
    candidate = generateSync({ secret: generateSecret() });
  } while (candidate === generateSync({ secret }));
  return candidate;
}

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
      expect(challenge.methods).toEqual(['email_otp']);
      expect(challenge.recoveryMethods).toEqual(['email_otp']);
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

      // A valid code, so the only fault is the substituted device: the device check must fire before factor verification.
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
      expect(verify.status).toBe(401);
      expect(verify.body.error.code).toBe('MFA_CHALLENGE_INVALID');
      const cookies = parseSetCookies(verify.headers['set-cookie']);
      expect(cookies[REFRESH_COOKIE_NAME]).toBeUndefined();
      expect(cookies[DEVICE_TRUST_COOKIE_NAME]).toBeUndefined();

      // The rejected attempt must not have burned the one-time OTP: if the device check ran after factor verification, this retry would fail MFA_CODE_INVALID.
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

      // A freshly issued valid OTP leaves the already-consumed challenge as the only fault, so the single-use ledger, not the one-time OTP, rejects the replay.
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

      // The conditional PutItem on the challenge jti admits exactly one winner; the loser is rejected on the single-use OTP or the challenge.
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
      // An accepted code is single-use, so the factor is verified before the challenge is consumed and the two requests race on the
      // conditional step write (UserMfaRepository.consumeTotpStepUpStep): the loser is a wrong code, never a consumed challenge.
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();

      const first = await completeEmailOtpLogin(t, email, userId, deviceId);
      const secret = await enrollTotp(t, authHeaders(first));

      const newDevice = freshDeviceId();
      const login = await loginRaw(t, email, newDevice);
      expect(login.status).toBe(200);
      const challenge = login.body as ChallengeResponse;
      expect(challenge.methods).toEqual(['totp']);
      const challengeToken = challenge.challengeToken!;
      const code = generateSync({ secret });

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
      expect(loser.body.error.code).toBe('MFA_CODE_INVALID');
      const loserCookies = parseSetCookies(loser.headers['set-cookie']);
      expect(loserCookies[REFRESH_COOKIE_NAME]).toBeUndefined();
    });
  });

  describe('authenticator code single use', () => {
    const verifyTotpSignIn = (challengeToken: string, code: string, deviceId: string) =>
      request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/verify')
        .set('Origin', ORIGIN())
        .send({ challengeToken, method: 'totp', code, deviceId });

    async function startChallenge(email: string, deviceId: string): Promise<string> {
      const login = await loginRaw(t, email, deviceId);
      expect(login.status).toBe(200);
      return (login.body as ChallengeResponse).challengeToken!;
    }

    const changeEmailStepUp = async (s: ReturnType<typeof authHeaders>, code: string) => {
      await authSet(s)(request(t.app.getHttpServer()).post('/api/v1/auth/change-email/request'))
        .send({ newEmail: freshEmail('new'), currentPassword: STRONG_PASSWORD })
        .expect(200);
      return authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/change-email/verify-step-up'),
      ).send({ method: 'totp', code });
    };

    it('refuses a code at step-up after sign-in accepted it, and audits the refusal', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const bootstrap = authHeaders(
        await completeEmailOtpLogin(t, email, userId, freshDeviceId()),
      );
      const secret = await enrollTotp(t, bootstrap);
      const code = generateSync({ secret });

      const device = freshDeviceId();
      const signIn = await verifyTotpSignIn(await startChallenge(email, device), code, device);
      expect(signIn.status).toBe(200);

      const stepUp = await changeEmailStepUp(authHeaders(signIn), code);
      expect(stepUp.status).toBe(401);
      expect(stepUp.body.error.code).toBe('MFA_CODE_INVALID');
      const events = await authEventsFor(t, userId);
      expect(events.filter((e) => e.eventType === 'mfa_totp_failed')).toHaveLength(1);
      expect(events.filter((e) => e.eventType === 'mfa_totp_verified')).toHaveLength(1);
    });

    it('refuses a code at sign-in after step-up consumed it, with no session and no verified event', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const bootstrap = authHeaders(
        await completeEmailOtpLogin(t, email, userId, freshDeviceId()),
      );
      const secret = await enrollTotp(t, bootstrap);
      const code = generateSync({ secret });

      const stepUp = await changeEmailStepUp(bootstrap, code);
      expect(stepUp.status).toBe(200);
      const verifiedBefore = (await authEventsFor(t, userId)).filter(
        (e) => e.eventType === 'mfa_totp_verified',
      );
      expect(verifiedBefore).toHaveLength(1);

      const device = freshDeviceId();
      const signIn = await verifyTotpSignIn(await startChallenge(email, device), code, device);
      expect(signIn.status).toBe(401);
      expect(signIn.body.error.code).toBe('MFA_CODE_INVALID');
      expect(parseSetCookies(signIn.headers['set-cookie'])[REFRESH_COOKIE_NAME]).toBeUndefined();
      const events = await authEventsFor(t, userId);
      expect(events.filter((e) => e.eventType === 'mfa_totp_verified')).toHaveLength(1);
      expect(events.filter((e) => e.eventType === 'mfa_totp_failed')).toHaveLength(1);
    });
  });

  describe('trusted-device skip', () => {
    it('a routine-factor verify with rememberDevice lets the next login skip the challenge', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();

      const verify = await completeEmailOtpLogin(t, email, userId, deviceId, true);
      expect(verify.status).toBe(200);
      expect((verify.body as ChallengeResponse).deviceRemembered).toBe(true);
      const cookies = parseSetCookies(verify.headers['set-cookie']);
      const trust = cookies[DEVICE_TRUST_COOKIE_NAME];
      expect(trust).toBeTruthy();

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

      const first = await completeEmailOtpLogin(t, email, userId, deviceId);
      await enrollTotp(t, authHeaders(first));

      const newDevice = freshDeviceId();
      const login = await loginRaw(t, email, newDevice);
      const challengeToken = (login.body as ChallengeResponse).challengeToken!;
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
      expect((verify.body as ChallengeResponse).deviceRemembered).toBe(false);
      const cookies = parseSetCookies(verify.headers['set-cookie']);
      expect(cookies[DEVICE_TRUST_COOKIE_NAME]).toBeUndefined();
    });
  });

  describe('email-code trust on a passkey account', () => {
    it('an unrestricted passkey blocks trust; a restricted one does not', async () => {
      const blocked = await signupVerifyApprove(t);
      await t.module
        .get(PasskeysRepository)
        .insert(seedPasskeyRow(blocked.userId));
      const blockedVerify = await completeEmailOtpLogin(
        t,
        blocked.email,
        blocked.userId,
        freshDeviceId(),
        true,
      );
      expect(blockedVerify.status).toBe(200);
      expect((blockedVerify.body as ChallengeResponse).deviceRemembered).toBe(false);
      expect(
        parseSetCookies(blockedVerify.headers['set-cookie'])[DEVICE_TRUST_COOKIE_NAME],
      ).toBeUndefined();

      const restricted = await signupVerifyApprove(t);
      await t.module
        .get(PasskeysRepository)
        .insert(seedPasskeyRow(restricted.userId, { restrictedPostReset: true }));
      const restrictedVerify = await completeEmailOtpLogin(
        t,
        restricted.email,
        restricted.userId,
        freshDeviceId(),
        true,
      );
      expect(restrictedVerify.status).toBe(200);
      expect((restrictedVerify.body as ChallengeResponse).deviceRemembered).toBe(true);
      expect(
        parseSetCookies(restrictedVerify.headers['set-cookie'])[DEVICE_TRUST_COOKIE_NAME],
      ).toBeTruthy();
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

  describe('totp/disable', () => {
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

      // 257 chars exceeds @MaxLength(256): the ValidationPipe 400s before the password is checked, so the factor is untouched.
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
      // No factor is enabled, so Email-OTP is the no-lockout step-up floor.
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

      const status = await request(t.app.getHttpServer())
        .get('/api/v1/auth/mfa/status')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`);
      expect(status.body.totpEnabled).toBe(false);
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
      const verify = await completeEmailOtpLogin(t, email, userId, deviceId, true);
      const cookies = parseSetCookies(verify.headers['set-cookie']);
      const trust = cookies[DEVICE_TRUST_COOKIE_NAME];
      expect(trust).toBeTruthy();
      const s = authHeaders(verify);

      const forget = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/trusted-devices/forget')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('X-CSRF-Token', s.csrfValue)
        .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
        .send({});
      expect(forget.status).toBe(204);

      // The forget-all response clears the device-trust cookie at both its live /api/v1 path and the older /api/v1/auth path, which a browser that
      // minted it before the path was widened still holds.
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

      // A valid enrollment-gate proof keeps the gate from rejecting first; with no pending secret enrollConfirm returns false, mapped to 401.
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
    // The single-use challenge is consumed only after a successful factor check, so wrong or locked attempts never burn it and `verifyTotp` reuses the same token.
    async function enrollAndChallenge(): Promise<{
      userId: string;
      secret: string;
      challengeToken: string;
      loginDevice: string;
      verifyTotp: (code: string) => request.Test;
    }> {
      const { email, userId } = await signupVerifyApprove(t);
      const bootstrap = authHeaders(
        await completeEmailOtpLogin(t, email, userId, freshDeviceId()),
      );
      const secret = await enrollTotp(t, bootstrap);

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

      // 3 free grace misses; the 4th is compared like any wrong code and trips the lock.
      for (let i = 0; i < 4; i++) {
        const res = await verifyTotp(wrongTotpCode(secret));
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('MFA_CODE_INVALID');
      }

      // The correct code is refused too, so this is an account-scoped lock, not a counter that happens to reject wrong guesses.
      const lockedWithCorrectCode = await verifyTotp(generateSync({ secret }));
      expect(lockedWithCorrectCode.status).toBe(429);
      expect(lockedWithCorrectCode.body.error.code).toBe('RATE_LIMITED');

      // The lock is scoped to the TOTP factor: the same challenge completes via Email-OTP (clear the send cooldown the bootstrap login used).
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

      // The threshold crossing is audited once, not once per refusal.
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
