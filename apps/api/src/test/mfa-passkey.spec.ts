/**
 * Passkey-as-second-factor integration tests.
 * Covers the parts that run in-process without a hardware/software authenticator
 * simulator: the scoped `mfa/passkey/start` endpoint (allowCredentials + token
 * gating), the public/CSRF-exempt/Origin-checked posture, and the
 * method-conditional `mfa/verify` DTO validation. The full WebAuthn signature
 * path (a real assertion → session) lives in the manual / e2e suite, as the
 * existing passkey.spec.ts notes; the cryptographic branch is unit-tested in
 * passkey-assertion.service.spec.ts.
 *
 * Runs with AUTH_MFA_ENFORCED=true so `POST /auth/login` mints a challenge
 * token the passkey-start endpoint can be gated on.
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { ConfigService } from '@nestjs/config';
import {
  STRONG_PASSWORD,
  bootstrapTestApp,
  freshDeviceId,
  scanAll,
  type TestApp,
  signupVerifyApprove,
} from './test-helpers.js';
import { JwtKeyStore } from '../auth/jwt-key-store.js';
import { MFA_CHALLENGE_PURPOSE } from '../auth/mfa-challenge.service.js';
import { PasskeyAssertionService } from '../auth/passkey-assertion.service.js';
import type { AuthEventRow, TrustedDeviceRow } from '../dynamo/types.js';

const ORIGIN = () => process.env.WEB_ORIGIN!;

interface ChallengeResponse {
  mfaRequired?: true;
  challengeToken?: string;
  methods?: string[];
}

/** A DTO-valid WebAuthn authentication response envelope (base64url fields). */
function validAuthResponse() {
  return {
    id: 'cred-id',
    rawId: 'AAAA',
    response: { clientDataJSON: 'AAAA', authenticatorData: 'AAAA', signature: 'AAAA' },
    clientExtensionResults: {},
    type: 'public-key' as const,
  };
}

/** Password login → return the minted MFA challenge token. */
async function challengeTokenFor(
  t: TestApp,
  email: string,
  deviceId: string = freshDeviceId(),
): Promise<string> {
  // The challenge is bound to this login deviceId: a subsequent mfa/verify must present the SAME
  // deviceId.
  const login = await request(t.app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('Origin', ORIGIN())
    .send({ email, password: STRONG_PASSWORD, deviceId });
  expect(login.status).toBe(200);
  expect((login.body as ChallengeResponse).mfaRequired).toBe(true);
  return (login.body as ChallengeResponse).challengeToken!;
}

describe('passkey as a second factor', () => {
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

  describe('mfa/passkey/start', () => {
    it('returns scoped allowCredentials for a valid challenge token (empty for a no-passkey user)', async () => {
      const { email } = await signupVerifyApprove(t);
      const challengeToken = await challengeTokenFor(t, email);
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/passkey/start')
        .set('Origin', ORIGIN())
        .send({ challengeToken });
      expect(res.status).toBe(200);
      expect(res.body.challenge).toBeTruthy();
      expect(res.body.userVerification).toBe('required');
      // A no-passkey user gets an empty allowCredentials (no enumeration signal) — a forged/expired
      // token returns the same MFA_CHALLENGE_* error regardless of passkey count.
      expect(res.body.allowCredentials).toEqual([]);
    });

    it('rejects a forged/invalid challenge token with 401 MFA_CHALLENGE_INVALID', async () => {
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/passkey/start')
        .set('Origin', ORIGIN())
        .send({ challengeToken: 'not-a-valid-challenge-jwt' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('MFA_CHALLENGE_INVALID');
    });

    it('rejects an expired challenge token with 401 MFA_CHALLENGE_EXPIRED', async () => {
      const { userId } = await signupVerifyApprove(t);
      // Mint a correctly-signed challenge token (right key/kid/purpose) but
      // already past its TTL, so it fails only the expiry check — distinct from
      // the forged-token MFA_CHALLENGE_INVALID case above.
      const { kid, privateKey } = t.module.get(JwtKeyStore).current();
      const expiredToken = jwt.sign(
        { userId, purpose: MFA_CHALLENGE_PURPOSE },
        privateKey,
        { algorithm: 'RS256', keyid: kid, expiresIn: -10 },
      );
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/passkey/start')
        .set('Origin', ORIGIN())
        .send({ challengeToken: expiredToken });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('MFA_CHALLENGE_EXPIRED');
    });

    it('rejects a missing challenge token with 400', async () => {
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/passkey/start')
        .set('Origin', ORIGIN())
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('CSRF + Origin posture', () => {
    it('succeeds with no X-CSRF-Token header (the endpoint is CSRF-exempt)', async () => {
      const { email } = await signupVerifyApprove(t);
      const challengeToken = await challengeTokenFor(t, email);
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/passkey/start')
        .set('Origin', ORIGIN())
        .send({ challengeToken });
      expect(res.status).toBe(200);
    });

    it('is rejected with a disallowed Origin (Origin/Referer still enforced)', async () => {
      const { email } = await signupVerifyApprove(t);
      const challengeToken = await challengeTokenFor(t, email);
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/mfa/passkey/start')
        .set('Origin', 'https://evil.example.com')
        .send({ challengeToken });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ORIGIN_MISMATCH');
    });
  });

  describe('mfa/verify — passkey arm controller seam (verifyMfaAssertion stubbed)', () => {
    // The full WebAuthn signature path needs a hardware/software authenticator,
    // so stub PasskeyAssertionService.verifyMfaAssertion to return a credentialId
    // and exercise the controller's passkey arm: the trust-mint (passkey is
    // always a routine factor) + the AuthEvent metadata.credentialId spread.
    it('records the login AuthEvent with mfa=passkey + credentialId and mints a TrustedDevice on rememberDevice', async () => {
      const { email, userId } = await signupVerifyApprove(t);
      const deviceId = freshDeviceId();
      const challengeToken = await challengeTokenFor(t, email, deviceId);
      const STUB_CREDENTIAL_ID = 'stub-credential-id';

      const svc = t.module.get(PasskeyAssertionService);
      const spy = jest
        .spyOn(svc, 'verifyMfaAssertion')
        .mockResolvedValue({ credentialId: STUB_CREDENTIAL_ID });
      try {
        const res = await request(t.app.getHttpServer())
          .post('/api/v1/auth/mfa/verify')
          .set('Origin', ORIGIN())
          .send({
            challengeToken,
            method: 'passkey',
            response: validAuthResponse(),
            rememberDevice: true,
            deviceId,
          });
        expect(res.status).toBe(200);
        expect(res.body.accessToken).toBeTruthy();
        // passkey is always a routine factor → trust is minted.
        expect(res.body.deviceRemembered).toBe(true);
        expect(spy).toHaveBeenCalledWith(userId, expect.objectContaining({ id: 'cred-id' }));
      } finally {
        spy.mockRestore();
      }

      // (a) the login AuthEvent carries metadata.mfa='passkey' + the credentialId.
      const cfg = t.module.get(ConfigService);
      const authEventTable = cfg.get('TABLE_AUTH_EVENT', { infer: true } as never) as unknown as string;
      const events = await scanAll<AuthEventRow>(t.doc, authEventTable);
      const loginEvent = events.find(
        (e) => e.userId === userId && e.eventType === 'login' && e.metadata?.mfa === 'passkey',
      );
      expect(loginEvent).toBeTruthy();
      expect(loginEvent!.metadata?.credentialId).toBe(STUB_CREDENTIAL_ID);

      // (b) a TrustedDevice row was minted for (userId, deviceId).
      const trustedTable = cfg.get('TABLE_TRUSTED_DEVICE', { infer: true } as never) as unknown as string;
      const devices = await scanAll<TrustedDeviceRow>(t.doc, trustedTable);
      const trusted = devices.find((d) => d.userId === userId && d.deviceId === deviceId);
      expect(trusted).toBeTruthy();
    });
  });
});
