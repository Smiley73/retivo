// Fresh-proof gate and post-reset restriction for the two factor-enrollment writes (passkey/register/finish, mfa/totp/enroll/confirm), with
// AUTH_MFA_ENFORCED on and off, and the restriction lifecycle of factors enrolled inside a reset window.

// The full WebAuthn signature path needs an authenticator, so the verification entry points are mocked to a deterministic verified outcome.
const verifyRegistrationResponse = jest.fn();
const verifyAuthenticationResponse = jest.fn();
jest.mock('@simplewebauthn/server', () => ({
  ...jest.requireActual('@simplewebauthn/server'),
  verifyRegistrationResponse: (...args: unknown[]) => verifyRegistrationResponse(...args),
  verifyAuthenticationResponse: (...args: unknown[]) => verifyAuthenticationResponse(...args),
}));

import request from 'supertest';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { generateSync } from 'otplib';
import {
  STRONG_PASSWORD,
  bootstrapTestApp,
  freshDeviceId,
  parseSetCookies,
  scanAll,
  signupVerifyLogin,
  type Session,
  type TestApp,
  recoverEmailOtp,
  signupAndLoginMfa,
  sendAndRecoverStepUpOtp,
  table,
  authSet,
} from './test-helpers.js';
import { REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME } from '../auth/cookie-config.js';
import { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import type { AuthEventRow, PasskeyRow, UserMfaRow } from '../dynamo/types.js';

const ORIGIN = () => process.env.WEB_ORIGIN!;

// `verifyRegistrationResponse` is mocked, so the field values are inert; only the shape must clear the global ValidationPipe.
function validRegistrationResponse(id: string) {
  return {
    id,
    rawId: 'AAAA',
    response: { clientDataJSON: 'AAAA', attestationObject: 'AAAA' },
    clientExtensionResults: {},
    type: 'public-key' as const,
  };
}

// `parseClientDataJSON` needs real JSON for the challenge namespace lookup to match.
function webauthnClientDataJSON(challenge: string, type: 'webauthn.get' = 'webauthn.get'): string {
  return Buffer.from(JSON.stringify({ challenge, type })).toString('base64url');
}

// `userHandle`, when given, is the raw userId the discoverable-login path decodes.
function authResponse(credentialId: string, challenge: string, userHandle?: string) {
  return {
    id: credentialId,
    rawId: credentialId,
    response: {
      clientDataJSON: webauthnClientDataJSON(challenge),
      authenticatorData: 'AA',
      signature: 'AA',
      ...(userHandle ? { userHandle: Buffer.from(userHandle, 'utf8').toString('base64url') } : {}),
    },
    clientExtensionResults: {},
    type: 'public-key' as const,
  };
}

function stubSuccessfulRegistration(): void {
  verifyRegistrationResponse.mockImplementation(
    async (args: { response: { id: string } }) => ({
      verified: true,
      registrationInfo: {
        credential: {
          id: args.response.id,
          publicKey: new Uint8Array(Buffer.from('AAAA', 'base64url')),
          counter: 0,
          transports: undefined,
        },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    }),
  );
}

function seedPasskeyRow(userId: string, credentialId: string, createdAt: string): PasskeyRow {
  return {
    userId,
    credentialId,
    publicKey: 'AAAA',
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
    transports: null,
    createdAt,
    lastUsedAt: null,
  };
}

describe('factor-enrollment gate + post-reset restriction', () => {
  describe('AUTH_MFA_ENFORCED=true', () => {
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

    beforeEach(() => {
      verifyRegistrationResponse.mockReset();
      verifyAuthenticationResponse.mockReset();
    });

    async function requestReset(email: string): Promise<string> {
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/request-password-reset')
        .set('Origin', ORIGIN())
        .send({ email })
        .expect(202);
      return res.body.resetToken as string;
    }

    // Opens and completes the restriction window by resetting the password, then completes a fresh MFA login; Email-OTP is the only eligible factor at that point.
    async function resetPasswordAndReloginMfa(s: Session): Promise<Session> {
      const resetToken = await requestReset(s.email);
      await request(t.app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .set('Origin', ORIGIN())
        .send({ token: resetToken, newPassword: STRONG_PASSWORD })
        .expect(204);
      const deviceId = freshDeviceId();
      const login = await request(t.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', ORIGIN())
        .send({ email: s.email, password: STRONG_PASSWORD, deviceId });
      const challengeToken = login.body.challengeToken as string;
      // `signupAndLoginMfa` sent an Email-OTP moments ago, inside the 60s cooldown.
      await t.doc.send(
        new UpdateCommand({
          TableName: table(t, 'TABLE_USER'),
          Key: { userId: s.userId },
          UpdateExpression: 'REMOVE mfaEmailOtpLastSentAt',
        }),
      );
      await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/email/send')
        .set('Origin', ORIGIN())
        .send({ challengeToken })
        .expect(202);
      const code = await recoverEmailOtp(t, s.userId);
      const verify = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/verify')
        .set('Origin', ORIGIN())
        .send({ challengeToken, method: 'email_otp', code, deviceId });
      const cookies = parseSetCookies(verify.headers['set-cookie']);
      return {
        ...s,
        accessToken: verify.body.accessToken,
        refreshCookie: `${REFRESH_COOKIE_NAME}=${encodeURIComponent(cookies[REFRESH_COOKIE_NAME])}`,
        csrfCookie: `${CSRF_COOKIE_NAME}=${encodeURIComponent(cookies[CSRF_COOKIE_NAME])}`,
        csrfValue: cookies[CSRF_COOKIE_NAME],
        deviceId,
      };
    }

    async function countAuthEvents(
      userId: string,
      eventType: AuthEventRow['eventType'],
    ): Promise<number> {
      const rows = await scanAll<AuthEventRow>(t.doc, table(t, 'TABLE_AUTH_EVENT'));
      return rows.filter((r) => r.userId === userId && r.eventType === eventType).length;
    }

    async function registerStart(s: Session): Promise<void> {
      await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/start'),
      ).send({});
    }

    async function enrollStart(s: Session): Promise<string> {
      const res = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/start'),
      ).send({});
      return res.body.secret as string;
    }

    // After `enroll/start` the row exists holding only a pending secret.
    async function totpEnabledFor(userId: string): Promise<boolean> {
      const rows = await scanAll<UserMfaRow>(t.doc, table(t, 'TABLE_USER_MFA'));
      return rows.find((r) => r.userId === userId)?.totpEnabled === true;
    }

    // The strictly advancing counter lets one seeded passkey prove several step-ups: the counter write is conditional and a repeated value reads as a cloned credential.
    let nextAssertionCounter = 0;
    async function stepUpPasskeyProof(
      s: Session,
      purpose: 'passkey_enroll' | 'mfa_totp_enroll',
      credentialId: string,
    ): Promise<{ method: 'passkey'; response: ReturnType<typeof authResponse> }> {
      verifyAuthenticationResponse.mockResolvedValue({
        verified: true,
        authenticationInfo: { newCounter: ++nextAssertionCounter },
      });
      const options = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/step-up/passkey/options'),
      ).send({ purpose });
      return { method: 'passkey', response: authResponse(credentialId, options.body.challenge) };
    }

    describe('POST /auth/passkey/register/finish', () => {
      it.each([
        ['no stepUp at all', undefined],
        ['stepUp: {} (no currentPassword)', {}],
      ])('rejects %s with 400 BAD_REQUEST and writes no passkey row', async (_label, stepUp) => {
        const s = await signupAndLoginMfa(t);
        stubSuccessfulRegistration();
        await registerStart(s);
        const res = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/finish'),
        ).send({ response: validRegistrationResponse('cred-1'), stepUp });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('BAD_REQUEST');
        expect(verifyRegistrationResponse).not.toHaveBeenCalled();
        expect(await t.module.get(PasskeysRepository).listForUser(s.userId)).toHaveLength(0);
      });

      it('a proof cannot be replayed: the same body sent twice enrolls once', async () => {
        const s = await signupAndLoginMfa(t);
        stubSuccessfulRegistration();
        await registerStart(s);
        const otpCode = await sendAndRecoverStepUpOtp(t, s, 'passkey_enroll');
        const body = {
          response: validRegistrationResponse('cred-replay'),
          stepUp: { currentPassword: STRONG_PASSWORD, method: 'email_otp', code: otpCode },
        };
        const first = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/finish'),
        ).send(body);
        expect(first.status).toBe(200);
        const second = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/finish'),
        ).send(body);
        // The registration challenge is single-use, independent of the step-up proof's own single-use-ness.
        expect(second.status).toBe(400);
        const rows = await t.module.get(PasskeysRepository).listForUser(s.userId);
        expect(rows.filter((r) => r.credentialId === 'cred-replay')).toHaveLength(1);
      });
    });

    describe('POST /auth/mfa/totp/enroll/confirm', () => {
      it.each([
        ['no stepUp at all', undefined],
        ['stepUp: {} (no currentPassword)', {}],
      ])('rejects %s with 400 BAD_REQUEST and leaves TOTP off', async (_label, stepUp) => {
        const s = await signupAndLoginMfa(t);
        const secret = await enrollStart(s);
        const res = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/confirm'),
        ).send({ code: generateSync({ secret }), stepUp });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('BAD_REQUEST');
        expect(await totpEnabledFor(s.userId)).toBe(false);
      });

      it('a wrong/mistyped code does not burn the step-up proof: retrying with the right code and the SAME proof succeeds (regression)', async () => {
        const s = await signupAndLoginMfa(t);
        const secret = await enrollStart(s);
        const otpCode = await sendAndRecoverStepUpOtp(t, s, 'mfa_totp_enroll');
        const wrong = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/confirm'),
        ).send({
          code: '000000',
          stepUp: { currentPassword: STRONG_PASSWORD, method: 'email_otp', code: otpCode },
        });
        expect(wrong.status).toBe(401);
        expect(wrong.body.error.code).toBe('MFA_CODE_INVALID');

        // The Email-OTP proof must still be unconsumed.
        const retry = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/confirm'),
        ).send({
          code: generateSync({ secret }),
          stepUp: { currentPassword: STRONG_PASSWORD, method: 'email_otp', code: otpCode },
        });
        expect(retry.status).toBe(200);
        expect(retry.body.totpEnabled).toBe(true);
      });

      it('a proof cannot be replayed: the same body sent twice enrolls once', async () => {
        const s = await signupAndLoginMfa(t);
        const secret = await enrollStart(s);
        const otpCode = await sendAndRecoverStepUpOtp(t, s, 'mfa_totp_enroll');
        const body = {
          code: generateSync({ secret }),
          stepUp: { currentPassword: STRONG_PASSWORD, method: 'email_otp', code: otpCode },
        };
        const first = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/confirm'),
        ).send(body);
        expect(first.status).toBe(200);
        const second = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/confirm'),
        ).send(body);
        // The Email-OTP code is single-use and the pending secret was already promoted, so the replay fails on both counts.
        expect(second.status).toBe(401);
      });
    });

    describe('the emailed code is the floor only for an account with no enrolled factor', () => {
      it('passkey register/finish: refused with 401 STEP_UP_FACTOR_NOT_ELIGIBLE once an authenticator app is enrolled — no row written, audited; the authenticator itself still proves it', async () => {
        const s = await signupAndLoginMfa(t);
        // Allowed: nothing is enrolled yet, so the emailed code is the floor.
        const secret = await enrollStart(s);
        const totpOtp = await sendAndRecoverStepUpOtp(t, s, 'mfa_totp_enroll');
        const totpEnroll = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/confirm'),
        ).send({
          code: generateSync({ secret }),
          stepUp: { currentPassword: STRONG_PASSWORD, method: 'email_otp', code: totpOtp },
        });
        expect(totpEnroll.status).toBe(200);

        // The attacker shape: password and mailbox, no reset ever requested, not holding the victim's authenticator.
        stubSuccessfulRegistration();
        await registerStart(s);
        const blockedBefore = await countAuthEvents(s.userId, 'factor_enrollment_blocked');
        const failedBefore = await countAuthEvents(s.userId, 'step_up_failed');
        const otpCode = await sendAndRecoverStepUpOtp(t, s, 'passkey_enroll');
        const refused = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/finish'),
        ).send({
          response: validRegistrationResponse('cred-via-email'),
          stepUp: { currentPassword: STRONG_PASSWORD, method: 'email_otp', code: otpCode },
        });
        expect(refused.status).toBe(401);
        expect(refused.body.error.code).toBe('STEP_UP_FACTOR_NOT_ELIGIBLE');
        expect(verifyRegistrationResponse).not.toHaveBeenCalled();
        expect(await t.module.get(PasskeysRepository).listForUser(s.userId)).toHaveLength(0);
        expect(await countAuthEvents(s.userId, 'factor_enrollment_blocked')).toBe(blockedBefore + 1);
        expect(await countAuthEvents(s.userId, 'step_up_failed')).toBe(failedBefore + 1);

        // The refused attempt consumed the registration challenge, so start again.
        await registerStart(s);
        const ok = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/finish'),
        ).send({
          response: validRegistrationResponse('cred-via-totp'),
          stepUp: { currentPassword: STRONG_PASSWORD, method: 'totp', code: generateSync({ secret }) },
        });
        expect(ok.status).toBe(200);
        const rows = await t.module.get(PasskeysRepository).listForUser(s.userId);
        expect(rows.map((r) => r.credentialId)).toEqual(['cred-via-totp']);
        expect(rows[0].restrictedPostReset).toBeUndefined();
      });

      it('mfa/totp/enroll/confirm: refused with 401 STEP_UP_FACTOR_NOT_ELIGIBLE once a passkey is enrolled — TOTP stays off; the passkey itself still proves it', async () => {
        const s = await signupAndLoginMfa(t);
        await t.module
          .get(PasskeysRepository)
          .insert(seedPasskeyRow(s.userId, 'enrolled-passkey', new Date().toISOString()));
        const secret = await enrollStart(s);
        const otpCode = await sendAndRecoverStepUpOtp(t, s, 'mfa_totp_enroll');
        const refused = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/confirm'),
        ).send({
          code: generateSync({ secret }),
          stepUp: { currentPassword: STRONG_PASSWORD, method: 'email_otp', code: otpCode },
        });
        expect(refused.status).toBe(401);
        expect(refused.body.error.code).toBe('STEP_UP_FACTOR_NOT_ELIGIBLE');
        expect(await totpEnabledFor(s.userId)).toBe(false);

        const ok = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/confirm'),
        ).send({
          code: generateSync({ secret }),
          stepUp: {
            currentPassword: STRONG_PASSWORD,
            ...(await stepUpPasskeyProof(s, 'mfa_totp_enroll', 'enrolled-passkey')),
          },
        });
        expect(ok.status).toBe(200);
        expect(ok.body.totpEnabled).toBe(true);
      });

      it('a restricted-only account keeps the Email-OTP floor (a restricted factor is not eligible), so it cannot be bricked', async () => {
        const s0 = await signupAndLoginMfa(t);
        const s = await resetPasswordAndReloginMfa(s0);
        // Enrolled inside the window, so restricted, and the account's only factor: it must not count as "an enrolled factor" for the rule.
        const secret = await enrollStart(s);
        const otpCode1 = await sendAndRecoverStepUpOtp(t, s, 'mfa_totp_enroll');
        const totpEnroll = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/confirm'),
        ).send({
          code: generateSync({ secret }),
          stepUp: { currentPassword: STRONG_PASSWORD, method: 'email_otp', code: otpCode1 },
        });
        expect(totpEnroll.status).toBe(200);

        stubSuccessfulRegistration();
        await registerStart(s);
        const otpCode2 = await sendAndRecoverStepUpOtp(t, s, 'passkey_enroll');
        const passkeyEnroll = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/finish'),
        ).send({
          response: validRegistrationResponse('floor-passkey'),
          stepUp: { currentPassword: STRONG_PASSWORD, method: 'email_otp', code: otpCode2 },
        });
        expect(passkeyEnroll.status).toBe(200);
        // Restricted like the TOTP before it: the floor lets the person act, the restriction keeps it harmless.
        const row = await t.module.get(PasskeysRepository).find(s.userId, 'floor-passkey');
        expect(row?.restrictedPostReset).toBe(true);
      });
    });

    describe('post-reset restriction lifecycle', () => {
      it('a factor enrolled inside an open reset window is persisted restricted', async () => {
        const s0 = await signupAndLoginMfa(t);
        const s = await resetPasswordAndReloginMfa(s0);
        const secret = await enrollStart(s);
        const otpCode = await sendAndRecoverStepUpOtp(t, s, 'mfa_totp_enroll');
        const res = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/confirm'),
        ).send({
          code: generateSync({ secret }),
          stepUp: { currentPassword: STRONG_PASSWORD, method: 'email_otp', code: otpCode },
        });
        expect(res.status).toBe(200);

        const rows = await scanAll<UserMfaRow>(t.doc, table(t, 'TABLE_USER_MFA'));
        const row = rows.find((r) => r.userId === s.userId)!;
        expect(row.totpRestrictedPostReset).toBe(true);
        expect(row.totpRestrictedByResetRequestedAt).toBeTruthy();

        const disableRes = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/disable'),
        ).send({
          currentPassword: STRONG_PASSWORD,
          method: 'totp',
          code: generateSync({ secret }),
        });
        expect(disableRes.status).toBe(401);

        const deviceId = freshDeviceId();
        const login = await request(t.app.getHttpServer())
          .post('/api/v1/auth/login')
          .set('Origin', ORIGIN())
          .send({ email: s.email, password: STRONG_PASSWORD, deviceId });
        expect(login.body.methods).not.toContain('totp');
        expect(login.body.methods).toContain('email_otp');
        const challengeToken = login.body.challengeToken as string;
        const loginVerify = await request(t.app.getHttpServer())
          .post('/api/v1/auth/mfa/verify')
          .set('Origin', ORIGIN())
          .send({
            challengeToken,
            method: 'totp',
            code: generateSync({ secret }),
            deviceId,
          });
        expect(loginVerify.status).toBe(401);
      });

      it('confirming with a predating factor lifts it; confirming with the restricted factor itself, or another restricted factor, does not', async () => {
        const s0 = await signupAndLoginMfa(t);
        const predatingId = 'predates-reset';
        await t.module
          .get(PasskeysRepository)
          .insert(seedPasskeyRow(s0.userId, predatingId, new Date(Date.now() - 60_000).toISOString()));

        const s = await resetPasswordAndReloginMfa(s0);
        const secret = await enrollStart(s);
        // A predating passkey is an eligible enrolled factor, so the emailed code is not accepted; restriction follows the open window, not the proof.
        const enroll = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/confirm'),
        ).send({
          code: generateSync({ secret }),
          stepUp: {
            currentPassword: STRONG_PASSWORD,
            ...(await stepUpPasskeyProof(s, 'mfa_totp_enroll', predatingId)),
          },
        });
        expect(enroll.status).toBe(200);

        // The restricted TOTP cannot satisfy the underlying step-up for its own confirmation.
        const selfConfirm = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/confirm-restriction'),
        ).send({ method: 'totp', code: generateSync({ secret }) });
        expect(selfConfirm.status).toBe(401);
        const stillRestrictedAfterSelf = (
          await scanAll<UserMfaRow>(t.doc, table(t, 'TABLE_USER_MFA'))
        ).find((r) => r.userId === s.userId)!;
        expect(stillRestrictedAfterSelf.totpRestrictedPostReset).toBe(true);

        // A passkey also enrolled inside the window cannot re-confirm either.
        const passkeyStart = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/start'),
        ).send({});
        expect(passkeyStart.status).toBe(200);
        stubSuccessfulRegistration();
        const passkeyEnroll = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/finish'),
        ).send({
          response: validRegistrationResponse('restricted-passkey'),
          stepUp: {
            currentPassword: STRONG_PASSWORD,
            ...(await stepUpPasskeyProof(s, 'passkey_enroll', predatingId)),
          },
        });
        expect(passkeyEnroll.status).toBe(200);
        const restrictedPasskeyRow = (
          await t.module.get(PasskeysRepository).listForUser(s.userId)
        ).find((p) => p.credentialId === 'restricted-passkey')!;
        expect(restrictedPasskeyRow.restrictedPostReset).toBe(true);

        const optionsForOther = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/step-up/passkey/options'),
        ).send({ purpose: 'mfa_totp_enroll' });
        const otherRestrictedConfirm = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/confirm-restriction'),
        ).send({
          method: 'passkey',
          response: authResponse('restricted-passkey', optionsForOther.body.challenge),
        });
        expect(otherRestrictedConfirm.status).toBe(401);

        const confirm = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/confirm-restriction'),
        ).send(await stepUpPasskeyProof(s, 'mfa_totp_enroll', predatingId));
        expect(confirm.status).toBe(200);
        const lifted = (await scanAll<UserMfaRow>(t.doc, table(t, 'TABLE_USER_MFA'))).find(
          (r) => r.userId === s.userId,
        )!;
        expect(lifted.totpRestrictedPostReset).toBeUndefined();
      });

      it('POST /auth/passkey/:credentialId/confirm-restriction: confirming with a predating factor lifts it', async () => {
        const s0 = await signupAndLoginMfa(t);
        const predatingId = 'predates-reset-passkey-lift';
        await t.module
          .get(PasskeysRepository)
          .insert(seedPasskeyRow(s0.userId, predatingId, new Date(Date.now() - 60_000).toISOString()));

        const s = await resetPasswordAndReloginMfa(s0);
        stubSuccessfulRegistration();
        await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/start'),
        ).send({});
        // The predating passkey proves the enrollment instead of the emailed code, and the new passkey is still restricted because restriction follows the open window.
        const enroll = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/finish'),
        ).send({
          response: validRegistrationResponse('restricted-target'),
          stepUp: {
            currentPassword: STRONG_PASSWORD,
            ...(await stepUpPasskeyProof(s, 'passkey_enroll', predatingId)),
          },
        });
        expect(enroll.status).toBe(200);
        const restrictedRow = await t.module
          .get(PasskeysRepository)
          .find(s.userId, 'restricted-target');
        expect(restrictedRow?.restrictedPostReset).toBe(true);
        expect(restrictedRow?.restrictedByResetRequestedAt).toBeTruthy();

        const confirm = await authSet(s)(
          request(t.app.getHttpServer()).post(
            '/api/v1/auth/passkey/restricted-target/confirm-restriction',
          ),
        ).send(await stepUpPasskeyProof(s, 'passkey_enroll', predatingId));
        expect(confirm.status).toBe(200);
        expect(confirm.body).toEqual({ restrictedPostReset: false });

        const lifted = await t.module
          .get(PasskeysRepository)
          .find(s.userId, 'restricted-target');
        expect(lifted?.restrictedPostReset).toBeUndefined();
        expect(lifted?.restrictedByResetRequestedAt).toBeUndefined();
      });

      it('POST /auth/passkey/:credentialId/confirm-restriction: a restricted passkey cannot confirm itself (it cannot even satisfy the underlying step-up) and stays restricted', async () => {
        const s0 = await signupAndLoginMfa(t);
        const s = await resetPasswordAndReloginMfa(s0);
        stubSuccessfulRegistration();
        await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/start'),
        ).send({});
        const otpCode = await sendAndRecoverStepUpOtp(t, s, 'passkey_enroll');
        const enroll = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/finish'),
        ).send({
          response: validRegistrationResponse('self-restricted'),
          stepUp: { currentPassword: STRONG_PASSWORD, method: 'email_otp', code: otpCode },
        });
        expect(enroll.status).toBe(200);

        verifyAuthenticationResponse.mockResolvedValue({
          verified: true,
          authenticationInfo: { newCounter: 1 },
        });
        const options = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/step-up/passkey/options'),
        ).send({ purpose: 'passkey_enroll' });
        const selfConfirm = await authSet(s)(
          request(t.app.getHttpServer()).post(
            '/api/v1/auth/passkey/self-restricted/confirm-restriction',
          ),
        ).send({
          method: 'passkey',
          response: authResponse('self-restricted', options.body.challenge),
        });
        expect(selfConfirm.status).toBe(401);
        expect(selfConfirm.body.error.code).toBe('MFA_CODE_INVALID');

        const stillRestricted = await t.module
          .get(PasskeysRepository)
          .find(s.userId, 'self-restricted');
        expect(stillRestricted?.restrictedPostReset).toBe(true);
      });

      it('POST /auth/passkey/:credentialId/confirm-restriction: a non-restricted credentialId is rejected with 400 FACTOR_NOT_RESTRICTED', async () => {
        const s = await signupAndLoginMfa(t);
        await t.module.get(PasskeysRepository).insert(
          seedPasskeyRow(s.userId, 'never-restricted', new Date().toISOString()),
        );
        const res = await authSet(s)(
          request(t.app.getHttpServer()).post(
            '/api/v1/auth/passkey/never-restricted/confirm-restriction',
          ),
        ).send({ method: 'totp', code: '000000' });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('FACTOR_NOT_RESTRICTED');
      });

      it('a restricted passkey is refused at authenticate/finish with no session issued', async () => {
        const s0 = await signupAndLoginMfa(t);
        const s = await resetPasswordAndReloginMfa(s0);
        stubSuccessfulRegistration();
        await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/start'),
        ).send({});
        const otpCode = await sendAndRecoverStepUpOtp(t, s, 'passkey_enroll');
        const enroll = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/finish'),
        ).send({
          response: validRegistrationResponse('login-restricted'),
          stepUp: { currentPassword: STRONG_PASSWORD, method: 'email_otp', code: otpCode },
        });
        expect(enroll.status).toBe(200);

        verifyAuthenticationResponse.mockResolvedValue({
          verified: true,
          authenticationInfo: { newCounter: 1 },
        });
        const start = await request(t.app.getHttpServer())
          .post('/api/v1/auth/passkey/authenticate/start')
          .set('Origin', ORIGIN());
        expect(start.status).toBe(200);
        const finish = await request(t.app.getHttpServer())
          .post('/api/v1/auth/passkey/authenticate/finish')
          .set('Origin', ORIGIN())
          .send({
            deviceId: freshDeviceId(),
            response: authResponse('login-restricted', start.body.challenge, s.userId),
          });
        expect(finish.status).toBe(401);
        expect(finish.body.error.code).toBe('PASSKEY_RESTRICTED_POST_RESET');
        expect(finish.headers['set-cookie']).toBeUndefined();
      });

      it('restriction outlives the window: a row whose enrollment sits inside a window that has since closed stays restricted', async () => {
        const s = await signupAndLoginMfa(t);
        // A restricted row with a long-closed window (25h ago > FACTOR_RESTRICTION_WINDOW_SEC) is restricted purely from its stored attribute, never re-derived from window state.
        const longClosed = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        const restrictedId = 'outlives-window';
        await t.module.get(PasskeysRepository).insert({
          ...seedPasskeyRow(s.userId, restrictedId, longClosed),
          restrictedPostReset: true,
          restrictedByResetRequestedAt: longClosed,
        });
        const rows = await scanAll<{ userId: string; currentResetToken?: string }>(
          t.doc,
          table(t, 'TABLE_USER'),
        );
        expect(rows.find((r) => r.userId === s.userId)?.currentResetToken).toBeUndefined();

        const row = (await t.module.get(PasskeysRepository).listForUser(s.userId)).find(
          (p) => p.credentialId === restrictedId,
        )!;
        expect(row.restrictedPostReset).toBe(true);

        const status = await authSet(s)(
          request(t.app.getHttpServer()).get('/api/v1/auth/mfa/status'),
        );
        expect(status.body.methods).not.toContain('passkey');
      });
    });
  });

  describe('AUTH_MFA_ENFORCED=false (the floor — wrong proof still refused)', () => {
    let t: TestApp;
    let priorEnforced: string | undefined;

    beforeAll(async () => {
      priorEnforced = process.env.AUTH_MFA_ENFORCED;
      process.env.AUTH_MFA_ENFORCED = 'false';
      t = await bootstrapTestApp();
    });

    afterAll(async () => {
      await t.app.close();
      if (priorEnforced === undefined) delete process.env.AUTH_MFA_ENFORCED;
      else process.env.AUTH_MFA_ENFORCED = priorEnforced;
    });

    beforeEach(() => {
      verifyRegistrationResponse.mockReset();
    });

    it('passkey register/finish: a wrong password is refused even with the flag off — the case the enrollment gate exists to stop', async () => {
      const s = await signupVerifyLogin(t);
      await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/start'),
      ).send({});
      const res = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/finish'),
      ).send({
        response: validRegistrationResponse('cred-1'),
        stepUp: { currentPassword: 'TotallyWrongPassw0rd!' },
      });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(verifyRegistrationResponse).not.toHaveBeenCalled();
      const rows = await t.module.get(PasskeysRepository).listForUser(s.userId);
      expect(rows).toHaveLength(0);
    });

    it('passkey register/finish: the correct password alone (no factor) succeeds — the degrade floor', async () => {
      const s = await signupVerifyLogin(t);
      stubSuccessfulRegistration();
      await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/start'),
      ).send({});
      const res = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/finish'),
      ).send({
        response: validRegistrationResponse('cred-1'),
        stepUp: { currentPassword: STRONG_PASSWORD },
      });
      expect(res.status).toBe(200);
    });

    it('mfa/totp/enroll/confirm: a wrong password is refused even with the flag off', async () => {
      const s = await signupVerifyLogin(t);
      const start = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/start'),
      ).send({});
      const secret = start.body.secret as string;
      const res = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/confirm'),
      ).send({
        code: generateSync({ secret }),
        stepUp: { currentPassword: 'TotallyWrongPassw0rd!' },
      });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('mfa/totp/enroll/confirm: the correct password alone (no factor) succeeds — the degrade floor', async () => {
      const s = await signupVerifyLogin(t);
      const start = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/start'),
      ).send({});
      const secret = start.body.secret as string;
      const res = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/confirm'),
      ).send({
        code: generateSync({ secret }),
        stepUp: { currentPassword: STRONG_PASSWORD },
      });
      expect(res.status).toBe(200);
      expect(res.body.totpEnabled).toBe(true);
    });
  });
});
