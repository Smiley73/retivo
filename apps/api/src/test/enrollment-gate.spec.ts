/**
 * Fresh-proof gate + post-reset restriction integration tests.
 * Covers the two factor-enrollment WRITES
 * (`passkey/register/finish`, `mfa/totp/enroll/confirm`):
 *   - no proof / wrong proof / valid proof of each factor type, under
 *     AUTH_MFA_ENFORCED=true AND =false (the flag-off case matters most — a wrong password is refused even when the flag
 *     is off);
 *   - a PROOFLESS body — no `stepUp` at all, or `stepUp: {}` without the
 *     password — is refused by the DTO before the controller runs, under
 *     BOTH flag values: the exact "a session alone" case the Done-when
 *     forbids, exercised rather than left to the decorators;
 *   - the emailed code is the floor ONLY for an account with no enrolled
 *     factor: once an eligible passkey/authenticator exists it is refused as
 *     the enrollment proof (that factor itself still proves it), while a
 *     restricted-only account keeps the floor;
 *   - a proof cannot be replayed (the same body sent twice enrolls once);
 *   - a factor enrolled inside an open password-reset window is persisted
 *     restricted; a restricted factor is refused as a step-up factor, absent
 *     from and refused at the login-MFA challenge, refused at the
 *     discoverable passkey login, and lifted only by a predating factor;
 *   - restriction outlives the window that set it (proves it is sticky state,
 *     not read-time-derived).
 *
 * The full WebAuthn signature path needs a hardware/software authenticator
 * (manual/e2e territory — see passkey.spec.ts's header note); `@simplewebauthn/
 * server`'s verification entry points are mocked to a deterministic verified
 * outcome, mirroring step-up.spec.ts / mfa-passkey.spec.ts's existing seam.
 */

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

/** A DTO-valid WebAuthn REGISTRATION response envelope. `verifyRegistrationResponse`
 * is mocked, so the field VALUES are inert — only the shape needs to clear the
 * global ValidationPipe. */
function validRegistrationResponse(id: string) {
  return {
    id,
    rawId: 'AAAA',
    response: { clientDataJSON: 'AAAA', attestationObject: 'AAAA' },
    clientExtensionResults: {},
    type: 'public-key' as const,
  };
}

/** A base64url clientDataJSON carrying the WebAuthn `challenge` (test-only —
 * mirrors step-up.spec.ts's `stepUpClientDataJSON`; `parseClientDataJSON`
 * requires real JSON so the challenge namespace lookup can match). */
function webauthnClientDataJSON(challenge: string, type: 'webauthn.get' = 'webauthn.get'): string {
  return Buffer.from(JSON.stringify({ challenge, type })).toString('base64url');
}

/** A DTO-valid WebAuthn AUTHENTICATION response envelope naming `credentialId`
 * + carrying `challenge` (step-up / login). `userHandle`, when given, is the
 * raw userId the discoverable-login path decodes. */
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

/** Configure the mocked `verifyRegistrationResponse` to succeed, echoing the
 * request's chosen credential id back so the caller controls it. */
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

/** A freshly-enrolled, zero-counter passkey row for `userId` (test-only,
 * inserted directly — mirrors factor-management-step-up.spec.ts). */
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

    /** Reset the password (opens + then completes the restriction window),
     * then complete a fresh MFA login with the NEW password. Returns the new
     * session — the only eligible step-up/login factor at this point is
     * Email-OTP (the account has no routine factor yet). */
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
      // Clear the login Email-OTP send cooldown — `signupAndLoginMfa` already
      // sent one for this user moments ago (well under the 60s window).
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

    /** True once the user's TOTP factor is live — after `enroll/start` the
     * row exists holding only a pending secret. */
    async function totpEnabledFor(userId: string): Promise<boolean> {
      const rows = await scanAll<UserMfaRow>(t.doc, table(t, 'TABLE_USER_MFA'));
      return rows.find((r) => r.userId === userId)?.totpEnabled === true;
    }

    /** A fresh step-up passkey proof for `credentialId` under `purpose`:
     * fetches the purpose-scoped options and points the mocked
     * `verifyAuthenticationResponse` at a strictly-advancing counter, so ONE
     * seeded passkey can prove several step-ups in a test (the counter write
     * is conditional — a repeated value reads as a cloned credential). */
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

    // ---------- passkey register/finish ----------

    describe('POST /auth/passkey/register/finish', () => {
      it('rejects a body with no stepUp at all — a session alone — with 400 BAD_REQUEST and writes no passkey row', async () => {
        const s = await signupAndLoginMfa(t);
        // Registration WOULD succeed if the request reached the controller, so
        // "no row written" below is load-bearing rather than vacuous.
        stubSuccessfulRegistration();
        await registerStart(s);
        const res = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/finish'),
        ).send({ response: validRegistrationResponse('cred-1') });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('BAD_REQUEST');
        expect(verifyRegistrationResponse).not.toHaveBeenCalled();
        expect(await t.module.get(PasskeysRepository).listForUser(s.userId)).toHaveLength(0);
      });

      it('rejects stepUp: {} (no currentPassword) with 400 BAD_REQUEST and writes no passkey row', async () => {
        const s = await signupAndLoginMfa(t);
        stubSuccessfulRegistration();
        await registerStart(s);
        const res = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/finish'),
        ).send({ response: validRegistrationResponse('cred-1'), stepUp: {} });
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
        // The registration challenge is single-use (consumed by the first
        // call) independent of the step-up proof's own single-use-ness.
        expect(second.status).toBe(400);
        const rows = await t.module.get(PasskeysRepository).listForUser(s.userId);
        expect(rows.filter((r) => r.credentialId === 'cred-replay')).toHaveLength(1);
      });
    });

    // ---------- mfa/totp/enroll/confirm ----------

    describe('POST /auth/mfa/totp/enroll/confirm', () => {
      it('rejects a body with no stepUp at all — a session alone — with 400 BAD_REQUEST and leaves TOTP off', async () => {
        const s = await signupAndLoginMfa(t);
        const secret = await enrollStart(s);
        const res = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/confirm'),
        ).send({ code: generateSync({ secret }) });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('BAD_REQUEST');
        expect(await totpEnabledFor(s.userId)).toBe(false);
      });

      it('rejects stepUp: {} (no currentPassword) with 400 BAD_REQUEST and leaves TOTP off', async () => {
        const s = await signupAndLoginMfa(t);
        const secret = await enrollStart(s);
        const res = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/confirm'),
        ).send({ code: generateSync({ secret }), stepUp: {} });
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

        // Same body, corrected TOTP code — the Email-OTP proof above must
        // still be unconsumed.
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
        // The step-up Email-OTP code is single-use (consumed by the first
        // call) and the pending secret was already promoted, so the replay
        // fails on both counts.
        expect(second.status).toBe(401);
      });
    });

    // ---------- which factor may prove an enrollment ----------

    describe('the emailed code is the floor only for an account with no enrolled factor', () => {
      it('passkey register/finish: refused with 401 STEP_UP_FACTOR_NOT_ELIGIBLE once an authenticator app is enrolled — no row written, audited; the authenticator itself still proves it', async () => {
        const s = await signupAndLoginMfa(t);
        // Enroll TOTP on the Email-OTP floor — allowed, nothing enrolled yet.
        const secret = await enrollStart(s);
        const totpOtp = await sendAndRecoverStepUpOtp(t, s, 'mfa_totp_enroll');
        const totpEnroll = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/confirm'),
        ).send({
          code: generateSync({ secret }),
          stepUp: { currentPassword: STRONG_PASSWORD, method: 'email_otp', code: totpOtp },
        });
        expect(totpEnroll.status).toBe(200);

        // The attacker shape: password + mailbox, no reset ever requested (so
        // no restriction window), NOT holding the victim's authenticator.
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

        // The account's own enrolled factor proves the same write (the refused
        // attempt consumed the registration challenge, so start again).
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
        // TOTP enrolled inside the window → restricted, and the account's ONLY
        // factor. It must not count as "an enrolled factor" for the rule.
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
        // Still inside the window, so restricted like the TOTP before it — the
        // floor lets the person act; the restriction keeps it harmless.
        const row = await t.module.get(PasskeysRepository).find(s.userId, 'floor-passkey');
        expect(row?.restrictedPostReset).toBe(true);
      });
    });

    // ---------- restriction lifecycle ----------

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

        // Restricted as a step-up factor for an unrelated op.
        const disableRes = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/disable'),
        ).send({
          currentPassword: STRONG_PASSWORD,
          method: 'totp',
          code: generateSync({ secret }),
        });
        expect(disableRes.status).toBe(401);

        // Absent from AND refused at the login-MFA challenge.
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
        // A passkey inserted BEFORE the reset window opens — predates it.
        const predatingId = 'predates-reset';
        await t.module
          .get(PasskeysRepository)
          .insert(seedPasskeyRow(s0.userId, predatingId, new Date(Date.now() - 60_000).toISOString()));

        const s = await resetPasswordAndReloginMfa(s0);
        const secret = await enrollStart(s);
        // The predating passkey is an eligible enrolled factor, so the emailed
        // code is NOT accepted here — the enrollment must prove with it.
        // (Restriction is a function of the open window, not of the proof.)
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

        // Self-confirm: the restricted TOTP naming itself is refused (it
        // cannot even satisfy the underlying step-up).
        const selfConfirm = await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/confirm-restriction'),
        ).send({ method: 'totp', code: generateSync({ secret }) });
        expect(selfConfirm.status).toBe(401);
        const stillRestrictedAfterSelf = (
          await scanAll<UserMfaRow>(t.doc, table(t, 'TABLE_USER_MFA'))
        ).find((r) => r.userId === s.userId)!;
        expect(stillRestrictedAfterSelf.totpRestrictedPostReset).toBe(true);

        // Another restricted factor (a passkey ALSO enrolled inside the same
        // window) cannot re-confirm either.
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

        // The pre-existing, non-restricted passkey DOES lift the restriction.
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
        // A passkey inserted BEFORE the reset window opens — predates it.
        const predatingId = 'predates-reset-passkey-lift';
        await t.module
          .get(PasskeysRepository)
          .insert(seedPasskeyRow(s0.userId, predatingId, new Date(Date.now() - 60_000).toISOString()));

        const s = await resetPasswordAndReloginMfa(s0);
        stubSuccessfulRegistration();
        await authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/start'),
        ).send({});
        // The predating passkey is an eligible enrolled factor, so the emailed
        // code is not accepted — the enrollment proves with the passkey; it is
        // still restricted, because restriction follows the open window.
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
        // No reset has happened for this user — the row is a plain,
        // never-restricted passkey.
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
        // Directly manufacture a restricted row with a LONG-CLOSED window
        // (25h ago > the 24h FACTOR_RESTRICTION_WINDOW_SEC) — the row is
        // restricted PURELY from its own stored attribute, never re-derived
        // from the (now-absent) window state.
        const longClosed = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        const restrictedId = 'outlives-window';
        await t.module.get(PasskeysRepository).insert({
          ...seedPasskeyRow(s.userId, restrictedId, longClosed),
          restrictedPostReset: true,
          restrictedByResetRequestedAt: longClosed,
        });
        // Confirm the User row carries NO trace of an open window at all.
        const rows = await scanAll<{ userId: string; currentResetToken?: string }>(
          t.doc,
          table(t, 'TABLE_USER'),
        );
        expect(rows.find((r) => r.userId === s.userId)?.currentResetToken).toBeUndefined();

        const row = (await t.module.get(PasskeysRepository).listForUser(s.userId)).find(
          (p) => p.credentialId === restrictedId,
        )!;
        expect(row.restrictedPostReset).toBe(true);

        // computeFactors (mfa/status) never offers it.
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

    /** True once the user's TOTP factor is live (see the flag-on twin). */
    async function totpEnabledFor(userId: string): Promise<boolean> {
      const rows = await scanAll<UserMfaRow>(t.doc, table(t, 'TABLE_USER_MFA'));
      return rows.find((r) => r.userId === userId)?.totpEnabled === true;
    }

    // The proofless body under the flag-OFF floor is THE discriminating case:
    // with no second factor demanded, the password is the only remaining
    // control, so a DTO or guard that let `currentPassword` go missing would
    // enroll on a session alone here and nowhere else.
    it('passkey register/finish: a body with no stepUp at all is refused (400 BAD_REQUEST) even with the flag off — no row written', async () => {
      const s = await signupVerifyLogin(t);
      stubSuccessfulRegistration();
      await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/start'),
      ).send({});
      const res = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/finish'),
      ).send({ response: validRegistrationResponse('cred-1') });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(verifyRegistrationResponse).not.toHaveBeenCalled();
      expect(await t.module.get(PasskeysRepository).listForUser(s.userId)).toHaveLength(0);
    });

    it('passkey register/finish: stepUp: {} (no currentPassword) is refused (400 BAD_REQUEST) even with the flag off — no row written', async () => {
      const s = await signupVerifyLogin(t);
      stubSuccessfulRegistration();
      await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/start'),
      ).send({});
      const res = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/passkey/register/finish'),
      ).send({ response: validRegistrationResponse('cred-1'), stepUp: {} });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(verifyRegistrationResponse).not.toHaveBeenCalled();
      expect(await t.module.get(PasskeysRepository).listForUser(s.userId)).toHaveLength(0);
    });

    it('mfa/totp/enroll/confirm: a body with no stepUp at all is refused (400 BAD_REQUEST) even with the flag off — TOTP stays off', async () => {
      const s = await signupVerifyLogin(t);
      const start = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/start'),
      ).send({});
      const secret = start.body.secret as string;
      const res = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/confirm'),
      ).send({ code: generateSync({ secret }) });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(await totpEnabledFor(s.userId)).toBe(false);
    });

    it('mfa/totp/enroll/confirm: stepUp: {} (no currentPassword) is refused (400 BAD_REQUEST) even with the flag off — TOTP stays off', async () => {
      const s = await signupVerifyLogin(t);
      const start = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/start'),
      ).send({});
      const secret = start.body.secret as string;
      const res = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/confirm'),
      ).send({ code: generateSync({ secret }), stepUp: {} });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(await totpEnabledFor(s.userId)).toBe(false);
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

    // Unauthenticated rejection (flag-independent; shares this app).
  });
});
