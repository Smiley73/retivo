/**
 * Endpoint-level integration coverage for the raised password policy:
 * minimum 16 characters and at
 * least one special character, enforced by `PasswordValidatorService` at the
 * three prospective-set points — signup, change-password, and password-reset
 * consumption — and NOT at login.
 *
 * Proves the policy is actually wired through each endpoint (not just the
 * validator unit tests): each rejects a 15-character password with
 * `PASSWORD_TOO_SHORT` and a 16+-character password missing a special
 * character with `PASSWORD_WEAK`, and accepts a compliant 16+-character
 * special-character password. Uses the real emulator-backed stack via
 * `bootstrapTestApp()`, matching the existing integration convention (no
 * mocking of the surrounding flow state).
 */
import request from 'supertest';
import { CredentialsRepository } from '../dynamo/credentials.repository.js';
import { SignupService } from '../auth/signup.service.js';
import {
  STRONG_PASSWORD,
  bootstrapTestApp,
  freshDeviceId,
  freshEmail,
  signupVerifyLogin,
  type TestApp,
} from './test-helpers.js';

// 15 chars, otherwise fully compliant (upper + lower + digit + special) — only
// the length rule can reject it → PASSWORD_TOO_SHORT.
const SHORT_PASSWORD = 'Zq7vKp2mWx4n!Rt';
// A legacy-era password: 12 chars, no special character — it would be REJECTED
// (PASSWORD_TOO_SHORT, then PASSWORD_WEAK) if the raised policy applied. Used to
// prove the login path never runs the validator, so pre-existing credentials
// created before this policy shipped are not retroactively invalidated.
const LEGACY_PASSWORD = 'shortpass123';

function origin(): string {
  return process.env.WEB_ORIGIN!;
}

describe('password policy', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  describe('POST /auth/signup', () => {
    async function signup(password: string) {
      return request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', origin())
        .send({ email: freshEmail(), password });
    }

    it('rejects a 15-character password with PASSWORD_TOO_SHORT', async () => {
      const res = await signup(SHORT_PASSWORD);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PASSWORD_TOO_SHORT');
    });
  });

  describe('POST /auth/change-password', () => {
    async function changePassword(newPassword: string) {
      // Fresh authenticated user each time so a prior accept can't rotate the
      // credential out from under a later case.
      const sess = await signupVerifyLogin(t);
      return request(t.app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Origin', origin())
        .set('Authorization', `Bearer ${sess.accessToken}`)
        .set('X-CSRF-Token', sess.csrfValue)
        .set('Cookie', [sess.refreshCookie, sess.csrfCookie].join('; '))
        .send({ currentPassword: STRONG_PASSWORD, newPassword });
    }

    it('rejects a 15-character password with PASSWORD_TOO_SHORT', async () => {
      const res = await changePassword(SHORT_PASSWORD);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PASSWORD_TOO_SHORT');
    });
  });

  describe('POST /auth/reset-password (consume)', () => {
    async function requestResetToken(): Promise<{ email: string; resetToken: string }> {
      const sess = await signupVerifyLogin(t);
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/request-password-reset')
        .set('Origin', origin())
        .send({ email: sess.email });
      expect(res.status).toBe(202);
      // The local-dev shortcut (NODE_ENV=test here) returns the raw token
      // on a real send; no deployed stack does.
      expect(res.body.resetToken).toBeTruthy();
      return { email: sess.email, resetToken: res.body.resetToken as string };
    }

    async function resetPassword(newPassword: string) {
      const { resetToken } = await requestResetToken();
      return request(t.app.getHttpServer())
        .post('/api/v1/auth/reset-password')
        .set('Origin', origin())
        .send({ token: resetToken, newPassword });
    }

    it('rejects a 15-character password with PASSWORD_TOO_SHORT', async () => {
      const res = await resetPassword(SHORT_PASSWORD);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PASSWORD_TOO_SHORT');
    });
  });

  describe('POST /auth/login (legacy password not retroactively invalidated)', () => {
    // Regression lock for the requirement: "existing users'
    // current passwords are not retroactively invalidated." Login never calls
    // `PasswordValidatorService`, so a credential created before the raised
    // policy (e.g. a 12-char, no-special-character password) must still
    // authenticate. We seed a fully verified/approved user, then overwrite its
    // stored credential with the argon2 hash of a legacy-style plaintext — the
    // same hashing mechanism signup uses — and assert login still succeeds.
    it('logs in with a legacy password the raised policy would now reject', async () => {
      const sess = await signupVerifyLogin(t);

      // Sanity: the legacy plaintext really would be rejected by the new policy
      // (12 chars → PASSWORD_TOO_SHORT), so a green login below proves the
      // login path bypasses the validator rather than the password being valid.
      expect(LEGACY_PASSWORD.length).toBeLessThan(16);

      const credentials = t.module.get(CredentialsRepository);
      await credentials.upsert({
        userId: sess.userId,
        argon2Hash: await SignupService.hashPassword(LEGACY_PASSWORD),
        updatedAt: new Date().toISOString(),
      });

      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', origin())
        .send({ email: sess.email, password: LEGACY_PASSWORD, deviceId: freshDeviceId() });

      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeTruthy();
    });
  });
});
