// Step-up primitive: the step-up/email-otp/send and step-up/passkey/options prep endpoints (authorized, unauthenticated 401, CSRF 403) and the per-operation
// single-use and binding guarantees of a TOTP and an Email-OTP step-up code. Runs under AUTH_MFA_ENFORCED=true (read at service construction), restored after.

// Mocks only `verifyAuthenticationResponse` (there is no software authenticator) so a passkey step-up reaches a deterministic verified outcome; `generateAuthenticationOptions` stays real for the options tests.
const verifyAuthenticationResponse = jest.fn();
jest.mock('@simplewebauthn/server', () => ({
  ...jest.requireActual('@simplewebauthn/server'),
  verifyAuthenticationResponse: (...args: unknown[]) =>
    verifyAuthenticationResponse(...args),
}));

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { generateSync } from 'otplib';
import {
  STRONG_PASSWORD,
  bootstrapTestApp,
  freshEmail,
  scanAll,
  type TestApp,
  recoverCodeHash,
  signupAndLoginMfa,
  enrollTotp,
  table,
  authSet,
} from './test-helpers.js';
import { MfaEmailOtpService } from '../auth/mfa-email-otp.service.js';
import { PasskeyAssertionService } from '../auth/passkey-assertion.service.js';
import { stepUpOtpPk } from '../dynamo/mfa-email-otp.repository.js';
import { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import type { AuthEventRow, MfaEmailOtpRow, PasskeyRow } from '../dynamo/types.js';

const ORIGIN = () => process.env.WEB_ORIGIN!;

function stepUpClientDataJSON(challenge: string): string {
  return Buffer.from(JSON.stringify({ challenge, type: 'webauthn.get' })).toString(
    'base64url',
  );
}

function stepUpAssertion(credentialId: string, challenge: string) {
  return {
    id: credentialId,
    rawId: credentialId,
    response: {
      clientDataJSON: stepUpClientDataJSON(challenge),
      authenticatorData: 'AA',
      signature: 'AA',
    },
    clientExtensionResults: {},
    type: 'public-key' as const,
  };
}

function seedPasskeyRow(userId: string, credentialId: string): PasskeyRow {
  return {
    userId,
    credentialId,
    publicKey: Buffer.from('pk').toString('base64url'),
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
    transports: null,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
}

describe('step-up re-auth primitive', () => {
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

  describe('POST /auth/step-up/passkey/options', () => {
    it('returns scoped WebAuthn options for an authenticated caller', async () => {
      const s = await signupAndLoginMfa(t);
      const res = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/step-up/passkey/options'),
      ).send({ purpose: 'change_email' });
      expect(res.status).toBe(200);
      expect(typeof res.body.challenge).toBe('string');
      expect(Array.isArray(res.body.allowCredentials)).toBe(true);
    });

    it('rejects an unknown purpose with 400', async () => {
      const s = await signupAndLoginMfa(t);
      const res = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/step-up/passkey/options'),
      ).send({ purpose: 'not_a_purpose' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/step-up/email-otp/send', () => {
    it('emails a purpose-stamped code on the namespaced <userId>#stepup row', async () => {
      const s = await signupAndLoginMfa(t);
      const res = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/step-up/email-otp/send'),
      ).send({ purpose: 'delete_account' });
      expect(res.status).toBe(202);

      const rows = await scanAll<MfaEmailOtpRow>(t.doc, table(t, 'TABLE_MFA_EMAIL_OTP'));
      const stepRow = rows.find((r) => r.userId === stepUpOtpPk(s.userId));
      expect(stepRow).toBeDefined();
      expect(stepRow!.purpose).toBe('delete_account');
    });

    it('records step_up_challenge only for a committed send — a cooldown no-op writes none', async () => {
      const s = await signupAndLoginMfa(t);
      const send = (): request.Test =>
        authSet(s)(
          request(t.app.getHttpServer()).post('/api/v1/auth/step-up/email-otp/send'),
        ).send({ purpose: 'delete_account' });

      await send().expect(202);
      // A second send inside the 60 s cooldown is a silent no-op, so it must not record another step_up_challenge.
      await send().expect(202);

      const events = await scanAll<AuthEventRow>(t.doc, table(t, 'TABLE_AUTH_EVENT'));
      const challenges = events.filter(
        (e) =>
          e.userId === s.userId &&
          e.eventType === 'step_up_challenge' &&
          (e.metadata?.method as string | undefined) === 'email_otp',
      );
      expect(challenges).toHaveLength(1);
    });
  });

  describe('per-operation single-use / binding', () => {
    it('consumes a step-up TOTP code — the same code is rejected on a second step-up', async () => {
      const s = await signupAndLoginMfa(t);
      const secret = await enrollTotp(t, s);
      const code = generateSync({ secret });

      await request(t.app.getHttpServer())
        .post('/api/v1/auth/change-email/request')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('X-CSRF-Token', s.csrfValue)
        .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
        .send({ newEmail: freshEmail('one'), currentPassword: STRONG_PASSWORD })
        .expect(200);
      const first = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/change-email/verify-step-up'),
      ).send({ method: 'totp', code });
      expect(first.status).toBe(200);

      await request(t.app.getHttpServer())
        .post('/api/v1/auth/change-email/request')
        .set('Origin', ORIGIN())
        .set('Authorization', `Bearer ${s.accessToken}`)
        .set('X-CSRF-Token', s.csrfValue)
        .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
        .send({ newEmail: freshEmail('two'), currentPassword: STRONG_PASSWORD })
        .expect(200);
      const second = await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/change-email/verify-step-up'),
      ).send({ method: 'totp', code });
      expect(second.status).toBe(401);
      expect(second.body.error.code).toBe('MFA_CODE_INVALID');
    });

    it('binds a step-up Email-OTP code to its purpose — a wrong purpose is rejected', async () => {
      const s = await signupAndLoginMfa(t);
      const otpSvc = t.module.get(MfaEmailOtpService);

      await otpSvc.sendStepUp({
        userId: s.userId,
        email: s.email,
        purpose: 'delete_account',
        ip: null,
        userAgent: null,
      });
      const rows = await scanAll<MfaEmailOtpRow>(t.doc, table(t, 'TABLE_MFA_EMAIL_OTP'));
      const stepRow = rows.find((r) => r.userId === stepUpOtpPk(s.userId))!;
      const code = await recoverCodeHash(stepRow.codeHash);

      const wrong = await otpSvc.verifyStepUp({
        userId: s.userId,
        code,
        purpose: 'change_password',
        ip: null,
        userAgent: null,
      });
      expect(wrong.ok).toBe(false);

      const right = await otpSvc.verifyStepUp({
        userId: s.userId,
        code,
        purpose: 'delete_account',
        ip: null,
        userAgent: null,
      });
      expect(right.ok).toBe(true);
    });
  });

  describe('passkey step-up (b cross-flow-replay guard)', () => {
    let svc: PasskeyAssertionService;
    let passkeys: PasskeysRepository;

    beforeEach(() => {
      verifyAuthenticationResponse.mockReset();
      svc = t.module.get(PasskeyAssertionService);
      passkeys = t.module.get(PasskeysRepository);
    });

    it('verifies a purpose-scoped passkey assertion and advances the credential counter', async () => {
      const userId = randomUUID();
      const credentialId = randomUUID();
      await passkeys.insert(seedPasskeyRow(userId, credentialId));

      const options = await svc.generateStepUpOptions(userId, 'change_email');
      verifyAuthenticationResponse.mockResolvedValue({
        verified: true,
        authenticationInfo: { newCounter: 1 },
      });

      const result = await svc.verifyStepUpAssertion(
        userId,
        'change_email',
        stepUpAssertion(credentialId, options.challenge) as never,
      );

      expect(result).toEqual({ credentialId });
      const stored = await passkeys.find(userId, credentialId);
      expect(stored?.counter).toBe(1);
      expect(stored?.lastUsedAt).not.toBeNull();
    });

    it('rejects a change_email-minted challenge under delete_account, yet it still authorizes change_email', async () => {
      const userId = randomUUID();
      const credentialId = randomUUID();
      await passkeys.insert(seedPasskeyRow(userId, credentialId));

      const options = await svc.generateStepUpOptions(userId, 'change_email');
      const assertion = stepUpAssertion(credentialId, options.challenge);

      // Under the wrong purpose the challenge namespace has no entry, so it is rejected before any signature check.
      await expect(
        svc.verifyStepUpAssertion(userId, 'delete_account', assertion as never),
      ).rejects.toMatchObject({ response: { code: 'MFA_CODE_INVALID' } });
      expect(verifyAuthenticationResponse).not.toHaveBeenCalled();

      verifyAuthenticationResponse.mockResolvedValue({
        verified: true,
        authenticationInfo: { newCounter: 1 },
      });
      const ok = await svc.verifyStepUpAssertion(
        userId,
        'change_email',
        assertion as never,
      );
      expect(ok).toEqual({ credentialId });
    });
  });
});
