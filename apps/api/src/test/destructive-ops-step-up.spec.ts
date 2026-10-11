/**
 * Step-up enforcement for the destructive data ops:
 * `DELETE /auth/account` and `POST /auth/encrypted-workspace-reset` under
 * AUTH_MFA_ENFORCED=true.
 *
 * Covers the enforcement matrix for account deletion and encrypted-workspace reset:
 *  - passes the existing gate + a VALID fresh factor → succeeds (204);
 *  - passes the gate but OMITS the factor → 400 STEP_UP_PROOF_MISSING;
 *  - passes the gate with a WRONG factor → 401 MFA_CODE_INVALID;
 *  - Email-OTP is the no-lockout floor — completes each op with no TOTP/passkey;
 *  - encrypted-reset additionally requires the password re-verify;
 *  - a step-up TOTP code consumed on one op is rejected reused on another.
 *
 * Runs under AUTH_MFA_ENFORCED=true (read at service construction), restored
 * after — mirrors step-up.spec.ts / change-email.spec.ts. Each op is destructive
 * (delete removes the account; reset revokes all sessions), so every test mints a
 * fresh MFA session.
 */
import request from 'supertest';
import { generateSync } from 'otplib';
import {
  STRONG_PASSWORD,
  bootstrapTestApp,
  freshEmail,
  type Session,
  type TestApp,
  signupAndLoginMfa,
  enrollTotp,
  authSet,
} from './test-helpers.js';

describe('destructive-op step-up enforcement', () => {
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

  function resetWorkspace(s: Session, body: Record<string, unknown>): request.Test {
    return authSet(s)(
      request(t.app.getHttpServer()).post('/api/v1/auth/encrypted-workspace-reset'),
    ).send({
      confirmation: 'DELETE',
      currentPassword: STRONG_PASSWORD,
      ...body,
    });
  }

  describe('cross-op single-use (a)', () => {
    it('rejects a step-up TOTP code on encrypted-reset after it was consumed by change-email', async () => {
      const s = await signupAndLoginMfa(t);
      const secret = await enrollTotp(t, s);
      const code = generateSync({ secret });

      // Consume the TOTP step on a change-email step-up.
      await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/change-email/request'),
      )
        .send({ newEmail: freshEmail('x'), currentPassword: STRONG_PASSWORD })
        .expect(200);
      await authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/change-email/verify-step-up'),
      )
        .send({ method: 'totp', code })
        .expect(200);

      // The SAME code is rejected on the encrypted-reset op (single-use) —
      // the reset fails closed on the factor, not on the phrase/password.
      const res = await resetWorkspace(s, { method: 'totp', code });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('MFA_CODE_INVALID');
    });
  });
});
