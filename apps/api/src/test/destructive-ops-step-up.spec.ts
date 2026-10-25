// Cross-op single use under AUTH_MFA_ENFORCED=true: a step-up TOTP code consumed by change-email is rejected on POST /auth/encrypted-workspace-reset. The per-endpoint outcomes live in step-up-matrix.spec.ts.
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

      // The same code is rejected (single-use): the reset fails closed on the factor, not on the phrase or password.
      const res = await resetWorkspace(s, { method: 'totp', code });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('MFA_CODE_INVALID');
    });
  });
});
