// The password policy (16+ characters, one special character) is wired at signup, change-password and reset consumption, not login: each rejects
// 15 characters (PASSWORD_TOO_SHORT) and 16+ without a special character (PASSWORD_WEAK), and accepts a compliant password.
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

// 15 chars, otherwise compliant: only the length rule can reject it.
const SHORT_PASSWORD = 'Zq7vKp2mWx4n!Rt';
// A legacy 12-char password with no special character: it would be rejected if the policy applied, so it proves login never runs the validator.
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
    // Existing users' passwords must not be retroactively invalidated: login never calls PasswordValidatorService, so a legacy credential still
    // authenticates. The stored credential is overwritten with an argon2 hash of a legacy-style plaintext, as signup would hash it.
    it('logs in with a legacy password the raised policy would now reject', async () => {
      const sess = await signupVerifyLogin(t);

      // A green login then proves the login path bypasses the validator, not that the password is valid.
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
