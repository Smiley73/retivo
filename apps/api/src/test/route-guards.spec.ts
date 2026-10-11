/**
 * Route guards, proven once per protected route.
 *
 * Every protected route sits behind the same three layers: the Origin check
 * and the CSRF double-submit check (state-changing methods only), then the
 * global JWT guard. This table-driven spec asserts the whole chain for each
 * route in one app boot, so individual feature specs do not each re-prove
 * "no token -> 401", "no CSRF header -> 403" and "bad Origin -> 403".
 *
 * Exemption-specific cases (CSRF-exempt pre-session routes, public routes)
 * stay in their own specs: they prove behaviour specific to one endpoint.
 */
import request from 'supertest';
import { CSRF_COOKIE_NAME } from '../auth/cookie-config.js';
import {
  bootstrapTestApp,
  signupVerifyLogin,
  type Session,
  type TestApp,
} from './test-helpers.js';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Every JWT-guarded route that previously carried its own auth-gate cases. */
const SAFE_ROUTES: Array<[Method, string]> = [
  ['get', '/api/v1/auth/me'],
  ['get', '/api/v1/auth/key-envelopes'],
  ['get', '/api/v1/auth/account-export'],
  ['get', '/api/v1/auth/mfa/status'],
  ['get', '/api/v1/auth/mfa/trusted-devices'],
  ['get', '/api/v1/auth/passkey/list'],
  ['get', '/api/v1/health/dependencies'],
  ['get', '/api/v1/sync/pull?since=0'],
  ['get', '/api/v1/sync/bootstrap'],
  ['get', '/api/v1/sync/bootstrap?force=true'],
  ['get', '/api/v1/sync/snapshots'],
];

const STATE_CHANGING_ROUTES: Array<[Method, string]> = [
  ['patch', '/api/v1/auth/me'],
  ['post', '/api/v1/auth/change-password'],
  ['post', '/api/v1/auth/change-email/request'],
  ['post', '/api/v1/auth/logout'],
  ['post', '/api/v1/auth/verify-password'],
  ['post', '/api/v1/auth/change-email/send-otp'],
  ['post', '/api/v1/auth/change-email/verify-step-up'],
  ['delete', '/api/v1/auth/account'],
  ['post', '/api/v1/auth/encrypted-workspace-reset'],
  ['put', '/api/v1/auth/key-envelopes/password'],
  ['delete', '/api/v1/auth/key-envelopes/password'],
  ['delete', '/api/v1/auth/key-envelopes/recovery'],
  ['post', '/api/v1/auth/key-envelopes/activate'],
  ['post', '/api/v1/auth/mfa/trusted-devices/forget'],
  ['post', '/api/v1/auth/mfa/totp/enroll/start'],
  ['post', '/api/v1/auth/mfa/totp/enroll/confirm'],
  ['post', '/api/v1/auth/mfa/totp/disable'],
  ['post', '/api/v1/auth/mfa/totp/confirm-restriction'],
  ['post', '/api/v1/auth/passkey/register/start'],
  ['post', '/api/v1/auth/passkey/register/finish'],
  ['post', '/api/v1/auth/passkey/some-credential-id/remove'],
  ['post', '/api/v1/auth/passkey/some-credential-id/confirm-restriction'],
  ['post', '/api/v1/auth/step-up/passkey/options'],
  ['post', '/api/v1/auth/step-up/email-otp/send'],
  ['post', '/api/v1/sync/push'],
  ['post', '/api/v1/sync/restore'],
  ['post', '/api/v1/sync/workspace/clear'],
];

describe('route guards', () => {
  let t: TestApp;
  let s: Session;

  beforeAll(async () => {
    t = await bootstrapTestApp();
    s = await signupVerifyLogin(t);
  });

  afterAll(async () => {
    await t.app.close();
  });

  const call = (method: Method, path: string): request.Test =>
    request(t.app.getHttpServer())[method](path).set('Origin', process.env.WEB_ORIGIN!);

  describe('safe methods', () => {
    it.each(SAFE_ROUTES)('%s %s -> 401 without a bearer token', async (method, path) => {
      const res = await call(method, path);
      expect(res.status).toBe(401);
    });
  });

  describe('state-changing methods', () => {
    it.each(STATE_CHANGING_ROUTES)(
      '%s %s -> 403 CSRF_TOKEN_MISMATCH with no cookies and no token',
      async (method, path) => {
        const res = await call(method, path).send({});
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('CSRF_TOKEN_MISMATCH');
      },
    );

    it.each(STATE_CHANGING_ROUTES)(
      '%s %s -> 401 when CSRF and Origin pass but there is no bearer token',
      async (method, path) => {
        // A self-consistent CSRF pair clears the middleware so the JWT guard
        // itself is what rejects the request.
        const res = await call(method, path)
          .set('X-CSRF-Token', 'x')
          .set('Cookie', `${CSRF_COOKIE_NAME}=x`)
          .send({});
        expect(res.status).toBe(401);
      },
    );

    it.each(STATE_CHANGING_ROUTES)(
      '%s %s -> 403 CSRF_TOKEN_MISMATCH for a session with a missing or mismatched header',
      async (method, path) => {
        const base = () =>
          call(method, path)
            .set('Authorization', `Bearer ${s.accessToken}`)
            .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '));
        const missing = await base().send({});
        expect(missing.status).toBe(403);
        expect(missing.body.error.code).toBe('CSRF_TOKEN_MISMATCH');
        const mismatched = await base().set('X-CSRF-Token', 'not-the-real-token').send({});
        expect(mismatched.status).toBe(403);
        expect(mismatched.body.error.code).toBe('CSRF_TOKEN_MISMATCH');
      },
    );

    it.each(STATE_CHANGING_ROUTES)(
      '%s %s -> 403 ORIGIN_MISMATCH for a session with a foreign Origin',
      async (method, path) => {
        const res = await request(t.app.getHttpServer())
          [method](path)
          .set('Origin', 'https://evil.example')
          .set('Authorization', `Bearer ${s.accessToken}`)
          .set('X-CSRF-Token', s.csrfValue)
          .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
          .send({});
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('ORIGIN_MISMATCH');
      },
    );
  });
});
