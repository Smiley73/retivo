// Step-up for change-password, TOTP disable and passkey removal under AUTH_MFA_ENFORCED=true; the shared outcomes live in step-up-matrix.spec.ts, so only the missing-factor audit is here.
// The flag-off floor for totp/disable is the second describe; auth.spec.ts and passkey.spec.ts cover change-password and passkey removal with the flag unset.
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

// With AUTH_MFA_ENFORCED unset the factor-management ops stay at password-only (`enforceStepUpFactor` returns early). Boots a separate app, since the flag is read at service construction.
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
