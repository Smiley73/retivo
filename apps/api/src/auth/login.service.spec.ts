/**
 * Unit tests for the MFA login branch:
 *   - AUTH_MFA_ENFORCED=false → session issued directly (unchanged behaviour),
 *   - AUTH_MFA_ENFORCED=true + untrusted device → MfaChallenge (no session),
 *   - AUTH_MFA_ENFORCED=true + trusted device → session, audited
 *     `mfa: 'device_trusted'`.
 *
 * Pure unit test: every collaborator is stubbed. argon2 runs against a real
 * hash so the password verify passes.
 */
import 'reflect-metadata';
import * as argon2 from 'argon2';
import type { ConfigService } from '@nestjs/config';
import type { EnvConfig } from '../common/env.config.js';
import { LoginService, type LoginResult } from './login.service.js';
import type { UsersRepository } from '../dynamo/users.repository.js';
import type { CredentialsRepository } from '../dynamo/credentials.repository.js';
import type { FailedLoginService } from './failed-login.service.js';
import type { AccessTokenService } from './jwt.service.js';
import type { RefreshTokenService } from './refresh-token.service.js';
import type { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import type { UserMfaRepository } from '../dynamo/user-mfa.repository.js';
import type { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import type { MfaChallengeService } from './mfa-challenge.service.js';
import type { TrustedDeviceService } from './trusted-device.service.js';
import type { UserRow } from '../dynamo/types.js';

type TypedConfig = ConfigService<EnvConfig, true>;

const PASSWORD = 'correct-horse-battery';
/** The stubbed trust row's epoch-second expiry (carried on a trusted login's
 *  result so the controller can re-issue the cookie). */
const TRUST_EXPIRES_AT = Math.floor(Date.now() / 1000) + 10 * 86_400;

function user(): UserRow {
  return {
    userId: 'u1',
    email: 'a@b.test',
    emailLowercase: 'a@b.test',
    householdId: 'u1',
    emailVerifiedAt: new Date().toISOString(),
    approvalStatus: 'approved',
    createdAt: '',
    updatedAt: '',
  };
}

async function build(opts: {
  mfaEnforced: boolean;
  trusted?: boolean;
  totpEnabled?: boolean;
  /** Number of enrolled passkeys for the challenge user. */
  passkeyCount?: number;
  /** Make the stubbed per-address backoff report this many seconds of wait
   *  (the trust bypass is `checkBackoff`'s own concern and stays stubbed). */
  blockedForSec?: number;
}) {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const auth = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuthEventsRepository;
  const sessionUser: UserRow = user();
  const users = {
    findByEmail: jest.fn().mockResolvedValue(sessionUser),
    findByIdConsistent: jest.fn().mockResolvedValue(sessionUser),
    findById: jest.fn().mockResolvedValue(sessionUser),
  } as unknown as UsersRepository;
  const credentials = {
    findByUserId: jest.fn().mockResolvedValue({ userId: 'u1', argon2Hash: hash, updatedAt: '' }),
  } as unknown as CredentialsRepository;
  const failed = {
    checkBackoff: jest.fn().mockResolvedValue(
      opts.blockedForSec
        ? { blocked: true, retryAfterSec: opts.blockedForSec }
        : { blocked: false, retryAfterSec: 0 },
    ),
    recordFailure: jest.fn(),
    clear: jest.fn().mockResolvedValue(undefined),
  } as unknown as FailedLoginService;
  const signMock = jest
    .fn()
    .mockReturnValue({ token: 'access', jti: 'jti', expiresInSec: 300 });
  const tokens = { sign: signMock } as unknown as AccessTokenService;
  const refresh = {
    issueInitial: jest.fn().mockResolvedValue({ token: 'refresh', row: {} }),
  } as unknown as RefreshTokenService;
  const userMfa = {
    get: jest.fn().mockResolvedValue({ userId: 'u1', totpEnabled: !!opts.totpEnabled, updatedAt: '' }),
  } as unknown as UserMfaRepository;
  const passkeys = {
    listForUser: jest
      .fn()
      .mockResolvedValue(
        Array.from({ length: opts.passkeyCount ?? 0 }, (_, i) => ({
          userId: 'u1',
          credentialId: `cred-${i}`,
        })),
      ),
  } as unknown as PasskeysRepository;
  const mfaChallenge = {
    sign: jest.fn().mockReturnValue('challenge.jwt'),
  } as unknown as MfaChallengeService;
  const trustedDevices = {
    verify: jest.fn().mockResolvedValue(!!opts.trusted),
    resolveTrust: jest.fn().mockResolvedValue(
      opts.trusted
        ? {
            trusted: true,
            userId: sessionUser.userId,
            deviceId: args.deviceId,
            expiresAt: TRUST_EXPIRES_AT,
          }
        : { trusted: false, userId: sessionUser.userId, deviceId: args.deviceId },
    ),
  } as unknown as TrustedDeviceService;
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'AUTH_REFRESH_TOKEN_TTL_MIN') return 30;
      if (key === 'AUTH_MFA_ENFORCED') return opts.mfaEnforced ? 'true' : 'false';
      return undefined;
    }),
  } as unknown as TypedConfig;

  const svc = new LoginService(
    users,
    credentials,
    failed,
    tokens,
    refresh,
    auth,
    userMfa,
    passkeys,
    mfaChallenge,
    trustedDevices,
    config,
  );
  return { svc, auth, trustedDevices, failed, signMock, users, credentials, refresh, mfaChallenge };
}

const args = {
  email: 'a@b.test',
  password: PASSWORD,
  deviceId: '11111111-1111-1111-1111-111111111111',
  ip: null,
  userAgent: null,
};

describe('LoginService — enforced-MFA branch', () => {
  it('issues a session directly when AUTH_MFA_ENFORCED is false', async () => {
    const { svc, trustedDevices, failed } = await build({ mfaEnforced: false });
    const result = (await svc.login(args)) as LoginResult;
    expect('mfaRequired' in result).toBe(false);
    expect(result.accessToken).toBe('access');
    // Trust is still resolved (in the same shape as under the flag) and handed
    // to the backoff primitive — the flag governs only the MFA challenge.
    expect(trustedDevices.resolveTrust).toHaveBeenCalledTimes(1);
    expect(failed.checkBackoff).toHaveBeenCalledWith(
      'a@b.test',
      expect.objectContaining({ trusted: false }),
    );
    expect(result.deviceTrust).toBeUndefined();
  });

  // Regression: a device remembered while the flag was on keeps a
  // live trust row + cookie after an operational rollback to 'false'. The
  // pre-fix build passed `undefined` trust to the backoff primitive on this
  // path, so an elevated per-address counter 429'd the correct password.
  it('keeps the trusted-device backoff bypass when AUTH_MFA_ENFORCED is false (MFA rollback)', async () => {
    const { svc, failed } = await build({ mfaEnforced: false, trusted: true });
    const result = (await svc.login({ ...args, deviceTrustToken: 'dt' })) as LoginResult;
    expect('mfaRequired' in result).toBe(false);
    expect(result.accessToken).toBe('access');
    expect(failed.checkBackoff).toHaveBeenCalledWith(
      'a@b.test',
      expect.objectContaining({ trusted: true, userId: 'u1', deviceId: args.deviceId }),
    );
    expect(failed.clear).toHaveBeenCalledWith(
      'a@b.test',
      expect.objectContaining({ trusted: true }),
    );
    // The trusted login also carries the row expiry for the cookie re-issue.
    expect(result.deviceTrust).toEqual({ expiresAt: TRUST_EXPIRES_AT });
  });

  it('throws 429 LOGIN_BACKOFF with the on-screen sign-in copy when blocked', async () => {
    const { svc } = await build({ mfaEnforced: true, blockedForSec: 64 });
    await expect(svc.login(args)).rejects.toMatchObject({
      status: 429,
      response: {
        code: 'LOGIN_BACKOFF',
        message:
          'Too many failed sign-in attempts for this email address. Try again in 64 seconds. ' +
          "If this wasn't you, someone else may be trying passwords — " +
          "a device you've already chosen to remember can still sign in.",
      },
    });
    // Singular at exactly one second left.
    const one = await build({ mfaEnforced: true, blockedForSec: 1 });
    await expect(one.svc.login(args)).rejects.toMatchObject({
      response: { message: expect.stringContaining('Try again in 1 second. ') },
    });
  });

  it('returns an MfaChallenge (no session) when enforced + untrusted device', async () => {
    const { svc, auth } = await build({ mfaEnforced: true, trusted: false, totpEnabled: true });
    const result = await svc.login({ ...args, deviceTrustToken: 'dt' });
    expect('mfaRequired' in result).toBe(true);
    if ('mfaRequired' in result) {
      expect(result.challengeToken).toBe('challenge.jwt');
      expect(result.methods).toEqual(['totp']);
      expect(result.recoveryMethods).toEqual(['email_otp']);
    }
    expect(auth.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'mfa_challenge_issued' }),
    );
  });

  it('offers email_otp as the routine method when TOTP is not enrolled', async () => {
    const { svc } = await build({ mfaEnforced: true, trusted: false, totpEnabled: false });
    const result = await svc.login({ ...args, deviceTrustToken: undefined });
    if ('mfaRequired' in result) {
      expect(result.methods).toEqual(['email_otp']);
      expect(result.recoveryMethods).toEqual(['email_otp']);
    } else {
      throw new Error('expected a challenge');
    }
  });

  it('leads with passkey for a passkey-only user (no TOTP) instead of email_otp', async () => {
    const { svc } = await build({
      mfaEnforced: true,
      trusted: false,
      totpEnabled: false,
      passkeyCount: 1,
    });
    const result = await svc.login({ ...args, deviceTrustToken: undefined });
    if ('mfaRequired' in result) {
      expect(result.methods).toEqual(['passkey']);
      expect(result.recoveryMethods).toEqual(['email_otp']);
    } else {
      throw new Error('expected a challenge');
    }
  });

  it('offers passkey leading + totp for a dual-enrolled user', async () => {
    const { svc } = await build({
      mfaEnforced: true,
      trusted: false,
      totpEnabled: true,
      passkeyCount: 2,
    });
    const result = await svc.login({ ...args, deviceTrustToken: undefined });
    if ('mfaRequired' in result) {
      expect(result.methods).toEqual(['passkey', 'totp']);
      expect(result.recoveryMethods).toEqual(['email_otp']);
    } else {
      throw new Error('expected a challenge');
    }
  });

  it('issues a session tagged device_trusted when enforced + trusted device', async () => {
    const { svc, auth } = await build({ mfaEnforced: true, trusted: true });
    const result = (await svc.login({ ...args, deviceTrustToken: 'dt' })) as LoginResult;
    expect('mfaRequired' in result).toBe(false);
    expect(result.accessToken).toBe('access');
    expect(result.deviceTrust).toEqual({ expiresAt: TRUST_EXPIRES_AT });
    expect(auth.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'login',
        metadata: expect.objectContaining({ mfa: 'device_trusted' }),
      }),
    );
  });
});

/**
 * The session generation a login stamps must come from a STRONGLY CONSISTENT
 * base-table read, never from the `EmailIndex` GSI image `findByEmail`
 * returns. A GSI cannot
 * be read consistently at all, and its lag is independent of the base
 * table's — so right after a password reset's `revokeAll` bumps the
 * generation 0 → 1, the index can still say 0 while the base table already
 * holds 1. Stamping the stale 0 fails `RefreshTokenService.issue`'s
 * ConditionCheck and rejects a legitimate sign-in. DynamoDB Local has no GSI
 * replication lag, so the integration suite cannot reproduce this; the
 * stubbed repository below can.
 */
describe('LoginService — session generation pinned from a strongly consistent base-table read (3.resilience.1)', () => {
  /** The index image lagging a just-committed revoke: still 0 while the base
   *  table already holds 1. */
  function staleIndexImage(users: UsersRepository): void {
    (users.findByEmail as jest.Mock).mockResolvedValue({ ...user(), sessionGeneration: 0 });
    (users.findByIdConsistent as jest.Mock).mockResolvedValue({ ...user(), sessionGeneration: 1 });
  }

  it('stamps the base-table generation, not the stale index image, on a directly issued session', async () => {
    const { svc, users, refresh, signMock } = await build({ mfaEnforced: false });
    staleIndexImage(users);

    await svc.login(args);

    expect(refresh.issueInitial).toHaveBeenCalledWith(
      expect.objectContaining({ sessionGeneration: 1 }),
    );
    expect(signMock).toHaveBeenCalledWith(expect.objectContaining({ sessionGeneration: 1 }));
    expect(users.findByIdConsistent).toHaveBeenCalledWith('u1');
  });

  it('carries the base-table generation, not the stale index image, on the MFA challenge', async () => {
    const { svc, users, mfaChallenge } = await build({
      mfaEnforced: true,
      trusted: false,
      totpEnabled: true,
    });
    staleIndexImage(users);

    const result = await svc.login(args);

    expect('mfaRequired' in result).toBe(true);
    expect(mfaChallenge.sign).toHaveBeenCalledWith('u1', args.deviceId, expect.any(String), 1);
  });

  it('takes the consistent User read BEFORE the credential read, so the pinned generation is never newer than the password proof', async () => {
    const { svc, users, credentials } = await build({ mfaEnforced: false });

    await svc.login(args);

    // Reading the generation AFTER the password verifies would re-open a
    // window: a revoke committing between the proof and
    // that read would be adopted silently instead of failing closed.
    const [userRead] = (users.findByIdConsistent as jest.Mock).mock.invocationCallOrder;
    const [credentialRead] = (credentials.findByUserId as jest.Mock).mock.invocationCallOrder;
    expect(userRead).toBeLessThan(credentialRead);
  });

  it('treats an indexed email whose base-table row is gone as an unknown user', async () => {
    const { svc, users, refresh } = await build({ mfaEnforced: false });
    (users.findByIdConsistent as jest.Mock).mockResolvedValue(null);

    await expect(svc.login(args)).rejects.toMatchObject({
      response: { code: 'INVALID_CREDENTIALS' },
    });
    expect(refresh.issueInitial).not.toHaveBeenCalled();
  });
});
