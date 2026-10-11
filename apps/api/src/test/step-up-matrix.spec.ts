/**
 * Step-up proof matrix, proven once per gated endpoint.
 *
 * With `AUTH_MFA_ENFORCED=true`, every destructive or factor-changing write
 * demands the account password plus a fresh step-up factor. The five outcomes
 * are the same for every endpoint, so this table-driven spec runs them across
 * all of them in a single app boot instead of each feature spec carrying its
 * own copy:
 *
 *   - valid authenticator-app code            -> success
 *   - emailed code (the no-lockout floor)     -> success
 *   - correct password, no factor             -> 400 STEP_UP_PROOF_MISSING
 *   - wrong factor code                       -> 401 MFA_CODE_INVALID
 *   - wrong emailed code                      -> 401 MFA_CODE_INVALID
 *   - wrong password (with a valid factor)    -> 401 INVALID_CREDENTIALS
 *
 * Endpoint-specific behaviour (replay, restriction lifecycle, audit rows that
 * differ per endpoint, flag-off floors) stays in the feature specs.
 *
 * `@simplewebauthn/server`'s registration verifier is mocked to a deterministic
 * verified outcome (same seam as enrollment-gate.spec.ts) so the passkey
 * enrollment endpoint can be driven without a software authenticator.
 */

const verifyRegistrationResponse = jest.fn();
jest.mock('@simplewebauthn/server', () => ({
  ...jest.requireActual('@simplewebauthn/server'),
  verifyRegistrationResponse: (...args: unknown[]) => verifyRegistrationResponse(...args),
}));

import request from 'supertest';
import { generateSync } from 'otplib';
import {
  STRONG_PASSWORD,
  authSet,
  bootstrapTestApp,
  enrollTotp,
  scanAll,
  sendAndRecoverStepUpOtp,
  signupAndLoginMfa,
  table,
  type Session,
  type TestApp,
} from './test-helpers.js';
import { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import type { AuthEventRow, PasskeyRow, UserMfaRow } from '../dynamo/types.js';

const NEW_PASSWORD = 'NewPassw0rd!Rotate';
const WRONG_PASSWORD = 'WrongPassw0rd!';

type Reject = 'missing' | 'wrongPassword' | 'wrongFactor';

interface Prepared {
  /** TOTP secret when an authenticator app was enrolled during setup. */
  secret?: string;
  /** Fire the endpoint with `proof` merged in and the given account password. */
  send(proof: Record<string, unknown>, password?: string): request.Test;
  /** Endpoint-specific assertions on a successful response. */
  afterOk?(res: request.Response): Promise<void>;
  /** Endpoint-specific assertions after a rejection (nothing was changed). */
  afterReject?(kind: Reject): Promise<void>;
}

interface Op {
  name: string;
  /** Purpose the emailed step-up code is bound to. */
  purpose: string;
  ok: number;
  /** Whether a live authenticator-app code can prove this op. */
  totpProves: boolean;
  /** Prepare account state; `totp` enrols an authenticator app first. */
  prepare(s: Session, totp: boolean): Promise<Prepared>;
}

function validRegistrationResponse(id: string) {
  return {
    id,
    rawId: 'AAAA',
    response: { clientDataJSON: 'AAAA', attestationObject: 'AAAA' },
    clientExtensionResults: {},
    type: 'public-key' as const,
  };
}

function stubSuccessfulRegistration(): void {
  verifyRegistrationResponse.mockImplementation(async (args: { response: { id: string } }) => ({
    verified: true,
    registrationInfo: {
      credential: {
        id: args.response.id,
        publicKey: new Uint8Array(Buffer.from('AAAA', 'base64url')),
        counter: 0,
        transports: undefined,
      },
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
    },
  }));
}

describe('step-up proof matrix (AUTH_MFA_ENFORCED=true)', () => {
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

  beforeEach(() => {
    verifyRegistrationResponse.mockReset();
  });

  const api = () => request(t.app.getHttpServer());

  async function insertPasskey(userId: string, credentialId: string): Promise<void> {
    const row: PasskeyRow = {
      userId,
      credentialId,
      publicKey: 'AAAA',
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
      transports: null,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    await t.module.get(PasskeysRepository).insert(row);
  }

  async function countAuthEvents(userId: string, eventType: AuthEventRow['eventType']) {
    const rows = await scanAll<AuthEventRow>(t.doc, table(t, 'TABLE_AUTH_EVENT'));
    return rows.filter((r) => r.userId === userId && r.eventType === eventType).length;
  }

  async function totpEnabledFor(userId: string): Promise<boolean> {
    const rows = await scanAll<UserMfaRow>(t.doc, table(t, 'TABLE_USER_MFA'));
    return rows.find((r) => r.userId === userId)?.totpEnabled === true;
  }

  const OPS: Op[] = [
    {
      name: 'DELETE /auth/account',
      purpose: 'delete_account',
      ok: 204,
      totpProves: true,
      async prepare(s, totp) {
        const secret = totp ? await enrollTotp(t, s) : undefined;
        return {
          secret,
          send: (proof, password = STRONG_PASSWORD) =>
            authSet(s)(api().delete('/api/v1/auth/account')).send({
              currentPassword: password,
              ...proof,
            }),
        };
      },
    },
    {
      name: 'POST /auth/encrypted-workspace-reset',
      purpose: 'encrypted_workspace_reset',
      ok: 204,
      totpProves: true,
      async prepare(s, totp) {
        const secret = totp ? await enrollTotp(t, s) : undefined;
        return {
          secret,
          send: (proof, password = STRONG_PASSWORD) =>
            authSet(s)(api().post('/api/v1/auth/encrypted-workspace-reset')).send({
              confirmation: 'DELETE',
              currentPassword: password,
              ...proof,
            }),
        };
      },
    },
    {
      name: 'POST /auth/change-password',
      purpose: 'change_password',
      ok: 200,
      totpProves: true,
      async prepare(s, totp) {
        const secret = totp ? await enrollTotp(t, s) : undefined;
        return {
          secret,
          send: (proof, password = STRONG_PASSWORD) =>
            authSet(s)(api().post('/api/v1/auth/change-password')).send({
              currentPassword: password,
              newPassword: NEW_PASSWORD,
              ...proof,
            }),
          afterOk: async (res) => {
            expect(res.body.accessToken).toBeTruthy();
          },
        };
      },
    },
    {
      name: 'POST /auth/mfa/totp/disable',
      purpose: 'mfa_totp_disable',
      ok: 200,
      totpProves: true,
      // The authenticator app is the factor being removed, so it is always
      // enrolled; the emailed code is then the no-lockout floor.
      async prepare(s) {
        const secret = await enrollTotp(t, s);
        return {
          secret,
          send: (proof, password = STRONG_PASSWORD) =>
            authSet(s)(api().post('/api/v1/auth/mfa/totp/disable')).send({
              currentPassword: password,
              ...proof,
            }),
          afterOk: async (res) => {
            expect(res.body.totpEnabled).toBe(false);
          },
          afterReject: async () => {
            const status = await authSet(s)(api().get('/api/v1/auth/mfa/status'));
            expect(status.body.totpEnabled).toBe(true);
          },
        };
      },
    },
    {
      name: 'POST /auth/passkey/:credentialId/remove',
      purpose: 'passkey_remove',
      ok: 200,
      totpProves: true,
      async prepare(s, totp) {
        const secret = totp ? await enrollTotp(t, s) : undefined;
        const credentialId = `cred-${s.userId}`;
        await insertPasskey(s.userId, credentialId);
        const find = () => t.module.get(PasskeysRepository).find(s.userId, credentialId);
        return {
          secret,
          send: (proof, password = STRONG_PASSWORD) =>
            authSet(s)(api().post(`/api/v1/auth/passkey/${encodeURIComponent(credentialId)}/remove`)).send({
              currentPassword: password,
              ...proof,
            }),
          afterOk: async () => {
            expect(await find()).toBeNull();
          },
          afterReject: async () => {
            expect(await find()).not.toBeNull();
          },
        };
      },
    },
    {
      name: 'POST /auth/passkey/register/finish',
      purpose: 'passkey_enroll',
      ok: 200,
      totpProves: true,
      async prepare(s, totp) {
        stubSuccessfulRegistration();
        const secret = totp ? await enrollTotp(t, s) : undefined;
        await authSet(s)(api().post('/api/v1/auth/passkey/register/start')).send({});
        const blockedBefore = await countAuthEvents(s.userId, 'factor_enrollment_blocked');
        const rows = () => t.module.get(PasskeysRepository).listForUser(s.userId);
        return {
          secret,
          send: (proof, password = STRONG_PASSWORD) =>
            authSet(s)(api().post('/api/v1/auth/passkey/register/finish')).send({
              response: validRegistrationResponse('cred-1'),
              stepUp: { currentPassword: password, ...proof },
            }),
          afterOk: async () => {
            const list = await rows();
            expect(list).toHaveLength(1);
            expect(list[0].restrictedPostReset).toBeUndefined();
          },
          afterReject: async (kind) => {
            expect(await rows()).toHaveLength(0);
            if (kind === 'wrongPassword') expect(verifyRegistrationResponse).not.toHaveBeenCalled();
            if (kind === 'missing') {
              expect(await countAuthEvents(s.userId, 'factor_enrollment_blocked')).toBe(
                blockedBefore + 1,
              );
            }
          },
        };
      },
    },
    {
      name: 'POST /auth/mfa/totp/enroll/confirm',
      purpose: 'mfa_totp_enroll',
      ok: 200,
      // An enrolled authenticator app would make this a re-enrolment, so only
      // the emailed-code floor proves it.
      totpProves: false,
      async prepare(s) {
        const start = await authSet(s)(api().post('/api/v1/auth/mfa/totp/enroll/start')).send({});
        const secret = start.body.secret as string;
        const blockedBefore = await countAuthEvents(s.userId, 'factor_enrollment_blocked');
        return {
          send: (proof, password = STRONG_PASSWORD) =>
            authSet(s)(api().post('/api/v1/auth/mfa/totp/enroll/confirm')).send({
              code: generateSync({ secret }),
              stepUp: { currentPassword: password, ...proof },
            }),
          afterOk: async (res) => {
            expect(res.body.totpEnabled).toBe(true);
          },
          afterReject: async (kind) => {
            expect(await totpEnabledFor(s.userId)).toBe(false);
            if (kind === 'missing') {
              expect(await countAuthEvents(s.userId, 'factor_enrollment_blocked')).toBe(
                blockedBefore + 1,
              );
            }
          },
        };
      },
    },
  ];

  const totpOps = OPS.filter((op) => op.totpProves).map((op) => [op.name, op] as const);
  const allOps = OPS.map((op) => [op.name, op] as const);

  it.each(totpOps)('%s -> succeeds with a valid authenticator-app code', async (_n, op) => {
    const s = await signupAndLoginMfa(t);
    const p = await op.prepare(s, true);
    const res = await p.send({ method: 'totp', code: generateSync({ secret: p.secret! }) });
    expect(res.status).toBe(op.ok);
    await p.afterOk?.(res);
  });

  it.each(allOps)('%s -> succeeds via the emailed-code floor', async (_n, op) => {
    const s = await signupAndLoginMfa(t);
    const p = await op.prepare(s, false);
    const code = await sendAndRecoverStepUpOtp(t, s, op.purpose);
    const res = await p.send({ method: 'email_otp', code });
    expect(res.status).toBe(op.ok);
    await p.afterOk?.(res);
  });

  it.each(allOps)('%s -> 400 STEP_UP_PROOF_MISSING for a correct password with no factor', async (_n, op) => {
    const s = await signupAndLoginMfa(t);
    const p = await op.prepare(s, false);
    const res = await p.send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('STEP_UP_PROOF_MISSING');
    await p.afterReject?.('missing');
  });

  it.each(allOps)('%s -> 401 MFA_CODE_INVALID for a wrong factor code', async (_n, op) => {
    const s = await signupAndLoginMfa(t);
    const p = await op.prepare(s, op.totpProves);
    const res = await p.send({ method: op.totpProves ? 'totp' : 'email_otp', code: '000000' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MFA_CODE_INVALID');
    await p.afterReject?.('wrongFactor');
  });

  it.each(allOps)('%s -> 401 MFA_CODE_INVALID for a wrong emailed code', async (_n, op) => {
    const s = await signupAndLoginMfa(t);
    const p = await op.prepare(s, false);
    const res = await p.send({ method: 'email_otp', code: '000000' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MFA_CODE_INVALID');
    await p.afterReject?.('wrongFactor');
  });

  it.each(allOps)('%s -> 401 INVALID_CREDENTIALS for a wrong password, before any factor work', async (_n, op) => {
    const s = await signupAndLoginMfa(t);
    const p = await op.prepare(s, op.totpProves);
    const proof = op.totpProves
      ? { method: 'totp', code: generateSync({ secret: p.secret! }) }
      : { method: 'email_otp', code: await sendAndRecoverStepUpOtp(t, s, op.purpose) };
    const res = await p.send(proof, WRONG_PASSWORD);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    await p.afterReject?.('wrongPassword');
  });
});
