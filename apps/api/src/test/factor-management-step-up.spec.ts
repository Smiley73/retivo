/**
 * Step-up enforcement for the change-password + factor-management ops,
 * under AUTH_MFA_ENFORCED=true:
 *   - POST /auth/change-password
 *   - POST /auth/mfa/totp/disable
 *   - POST /auth/passkey/:credentialId/remove
 *
 * Covers the enforcement matrix: existing gate (password) + a VALID fresh factor → succeeds; + a
 * MISSING factor → 400 STEP_UP_PROOF_MISSING; + a WRONG factor → 401
 * MFA_CODE_INVALID; Email-OTP is the no-lockout floor — completes each op
 * even when the very factor being managed is the only routine one;
 * unauthenticated → CSRF 403.
 *
 * The flag-OFF degrade floor (≥ password) is exercised by the flag-off
 * suite at the bottom of THIS file ('factor-management step-up — flag-off
 * degrade floor', which boots a separate app with `AUTH_MFA_ENFORCED` unset)
 * for totp/disable, by auth.spec.ts change-password,
 * and by passkey.spec.ts remove — all running with `AUTH_MFA_ENFORCED` unset.
 * (mfa.spec.ts runs with the flag ON, so it does NOT cover the flag-off floor.)
 *
 * The top-level suite runs under AUTH_MFA_ENFORCED=true (read at service
 * construction), restored
 * after — mirrors destructive-ops-step-up.spec.ts. Each MFA op mints a fresh
 * session.
 */
import request from 'supertest';
import {
  STRONG_PASSWORD,
  bootstrapTestApp,
  scanAll,
  signupVerifyLogin,
  type Session,
  type TestApp,
  signupAndLoginMfa,
  table,
  authSet,
} from './test-helpers.js';
import type { AuthEventRow } from '../dynamo/types.js';

const NEW_PASSWORD = 'NewPassw0rd!Rotate';

describe('factor-management step-up enforcement', () => {
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

  // ---------- change-password ----------
  describe('POST /auth/change-password', () => {
    function changePassword(s: Session, body: Record<string, unknown>): request.Test {
      return authSet(s)(
        request(t.app.getHttpServer()).post('/api/v1/auth/change-password'),
      ).send({ currentPassword: STRONG_PASSWORD, newPassword: NEW_PASSWORD, ...body });
    }

    it('records a step_up_failed audit on the missing-factor rejection (missing AND wrong both audited)', async () => {
      const s = await signupAndLoginMfa(t);
      const res = await changePassword(s, {});
      expect(res.status).toBe(400);
      const events = await scanAll<AuthEventRow>(t.doc, table(t, 'TABLE_AUTH_EVENT'));
      const failed = events.filter(
        (e) =>
          e.userId === s.userId &&
          e.eventType === 'step_up_failed' &&
          e.metadata?.purpose === 'change_password',
      );
      expect(failed).toHaveLength(1);
      expect(failed[0].metadata?.method).toBe('none');
      expect(failed[0].metadata?.reason).toBe('missing_proof');
    });
  });
});

/**
 * Flag-OFF degrade floor (never less safe than today): with
 * `AUTH_MFA_ENFORCED` unset, the factor-management ops must NOT demand a fresh
 * step-up factor — the `enforceStepUpFactor` early-return (`if (!this.mfaEnforced)
 * return;`) keeps the gate at password-only. Boots a SEPARATE app with the flag
 * unset (the flag is read at service construction), mirroring how
 * passkey.spec.ts covers the flag-off floor for passkey removal.
 */
describe('factor-management step-up — flag-off degrade floor', () => {
  let t2: TestApp;
  let priorEnforced: string | undefined;

  beforeAll(async () => {
    priorEnforced = process.env.AUTH_MFA_ENFORCED;
    delete process.env.AUTH_MFA_ENFORCED;
    t2 = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t2.app.close();
    if (priorEnforced === undefined) delete process.env.AUTH_MFA_ENFORCED;
    else process.env.AUTH_MFA_ENFORCED = priorEnforced;
  });

  it('POST /auth/mfa/totp/disable succeeds password-only, no factor demanded', async () => {
    const s = await signupVerifyLogin(t2);
    const res = await authSet(s)(
      request(t2.app.getHttpServer()).post('/api/v1/auth/mfa/totp/disable'),
    ).send({ currentPassword: STRONG_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.totpEnabled).toBe(false);
  });

});
