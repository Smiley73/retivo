// Passkey controller surface: option generation, the auth gate on management endpoints and idempotent removal. The full WebAuthn signature path needs
// an authenticator and lives in the manual/e2e suite.

// Mocks only `verifyRegistrationResponse` (no software authenticator) so register/finish reaches a deterministic verified outcome.
const verifyRegistrationResponse = jest.fn();
jest.mock('@simplewebauthn/server', () => ({
  ...jest.requireActual('@simplewebauthn/server'),
  verifyRegistrationResponse: (...args: unknown[]) =>
    verifyRegistrationResponse(...args),
}));

import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import {
  STRONG_PASSWORD,
  bootstrapTestApp,
  scanAll,
  signupVerifyLogin as login,
  type TestApp,
} from './test-helpers.js';
import type { AuthEventRow } from '../dynamo/types.js';

describe('passkey API', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  describe('register/start', () => {
    it('returns valid registration options for an authenticated user', async () => {
      const s = await login(t);
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/passkey/register/start')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('X-CSRF-Token', s.csrfValue)
        .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '));
      expect(res.status).toBe(200);
      expect(res.body.challenge).toBeTruthy();
      expect(res.body.rp).toBeTruthy();
      expect(res.body.authenticatorSelection?.userVerification).toBe('required');
      expect(res.body.authenticatorSelection?.residentKey).toBe('required');
      // PRF must be requested at credential creation: strict third-party passkey managers (Keeper, 1Password) only return PRF at assertion when it was.
      expect(res.body.extensions?.prf).toBeDefined();
    });
  });

  describe('authenticate/start', () => {
    it('is public and returns a challenge', async () => {
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/passkey/authenticate/start')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.challenge).toBeTruthy();
      expect(res.body.userVerification).toBe('required');
    });
  });

  describe('list / delete', () => {
    it('list returns an empty array for a user with no passkeys', async () => {
      const s = await login(t);
      const res = await request(t.app.getHttpServer())
        .get('/api/v1/auth/passkey/list')
        .set('Authorization', `Bearer ${s.accessToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(0);
    });

    // Removal is a body-bearing POST gated by a password re-verify present regardless of the MFA flag; this app runs with AUTH_MFA_ENFORCED off, so the gate is password-only: the flag-off degrade floor.
    it('remove is idempotent — 200 with the right password even when the credentialId is unknown (no notice for a no-op)', async () => {
      const s = await login(t);
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/passkey/never-existed-credential-id/remove')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('X-CSRF-Token', s.csrfValue)
        .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
        .send({ currentPassword: STRONG_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ noticeSent: false });
    });

    it('remove rejects a wrong password with 401 (password baseline)', async () => {
      const s = await login(t);
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/passkey/some-credential-id/remove')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('X-CSRF-Token', s.csrfValue)
        .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
        .send({ currentPassword: 'WrongPassw0rd!' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('register/finish (DTO validation + auth gate)', () => {
    it('records passkey_enroll with the caller ip/userAgent', async () => {
      const s = await login(t);
      const start = await request(t.app.getHttpServer())
        .post('/api/v1/auth/passkey/register/start')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('X-CSRF-Token', s.csrfValue)
        .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '));
      expect(start.status).toBe(200);

      verifyRegistrationResponse.mockResolvedValueOnce({
        verified: true,
        registrationInfo: {
          credential: { id: 'enroll-audit-cred', publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
        },
      });
      const finish = await request(t.app.getHttpServer())
        .post('/api/v1/auth/passkey/register/finish')
        .set('Origin', process.env.WEB_ORIGIN!)
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('X-CSRF-Token', s.csrfValue)
        .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
        .set('User-Agent', 'jest-passkey-enroll-agent')
        .send({
          response: {
            id: 'enroll-audit-cred',
            rawId: 'enroll-audit-cred',
            response: { clientDataJSON: 'eA', attestationObject: 'eA' },
            clientExtensionResults: {},
            type: 'public-key',
          },
          stepUp: { currentPassword: STRONG_PASSWORD },
        });
      expect(finish.status).toBe(200);

      const eventTable = t.module
        .get(ConfigService)
        .get('TABLE_AUTH_EVENT', { infer: true } as never) as unknown as string;
      const events = await scanAll<AuthEventRow>(t.doc, eventTable);
      const enrolled = events.find(
        (e) => e.userId === s.userId && e.eventType === 'passkey_enroll',
      );
      expect(enrolled).toBeTruthy();
      expect(enrolled!.ip).toBeTruthy();
      expect(enrolled!.userAgent).toBe('jest-passkey-enroll-agent');
    });
  });
});
