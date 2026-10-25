// MfaService unit tests: TOTP ±1 step window, enrollment promotion, idempotent disable and the per-account TOTP lock, with the repository and
// AuthEvents stubbed and otplib's real TOTP driving the math.
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { generateSecret, generateSync, verifySync } from 'otplib';
import { MfaService } from './mfa.service.js';
import type {
  TotpFailureState,
  UserMfaRepository,
} from '../dynamo/user-mfa.repository.js';
import type { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import type { UserMfaRow } from '../dynamo/types.js';

function buildAuth(): AuthEventsRepository {
  return { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuthEventsRepository;
}

// Default lock stubs for tests that do not exercise the lock: every attempt wins its reservation as failure #1, inside the 3-failure grace window.
function defaultLockStubs(): {
  reserveTotpAttempt: jest.Mock;
  clearTotpFailure: jest.Mock;
} {
  return {
    reserveTotpAttempt: jest.fn().mockResolvedValue({
      totpFailureCount: 1,
      totpLastFailureAt: new Date().toISOString(),
    }),
    clearTotpFailure: jest.fn().mockResolvedValue(undefined),
  };
}

// Matches the service's ±1-step (±30 s) verify tolerance; otplib v13's default @noble plugin is sync-capable, keeping the helpers synchronous.
const TOTP_EPOCH_TOLERANCE_SECONDS = 30;
const totp = {
  generateSecret: (): string => generateSecret(),
  generate: (secret: string): string => generateSync({ secret }),
  check: (code: string, secret: string): boolean =>
    verifySync({
      secret,
      token: code,
      epochTolerance: TOTP_EPOCH_TOLERANCE_SECONDS,
    }).valid,
};

describe('MfaService — TOTP', () => {
  it('accepts a current code and the immediately previous step (±1 window)', () => {
    const secret = totp.generateSecret();
    const code = totp.generate(secret);
    expect(totp.check(code, secret)).toBe(true);
  });

  it('verifyTotp returns true on a live code and stamps lastVerifiedAt', async () => {
    const secret = totp.generateSecret();
    const row: UserMfaRow = {
      userId: 'u1',
      totpEnabled: true,
      totpSecret: secret,
      updatedAt: new Date().toISOString(),
    };
    const update = jest.fn().mockResolvedValue(undefined);
    const userMfa = {
      get: jest.fn().mockResolvedValue(row),
      getConsistent: jest.fn().mockResolvedValue(row),
      update,
      ...defaultLockStubs(),
    } as unknown as UserMfaRepository;
    const svc = new MfaService(userMfa, buildAuth());

    const ok = await svc.verifyTotp('u1', totp.generate(secret));
    expect(ok).toBe(true);
    expect(update).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ lastVerifiedAt: expect.any(String) }),
    );
  });

  it('verifyTotp returns false on a code outside the window', async () => {
    const secret = totp.generateSecret();
    const row: UserMfaRow = {
      userId: 'u1',
      totpEnabled: true,
      totpSecret: secret,
      updatedAt: new Date().toISOString(),
    };
    const userMfa = {
      get: jest.fn().mockResolvedValue(row),
      getConsistent: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue(undefined),
      ...defaultLockStubs(),
    } as unknown as UserMfaRepository;
    const svc = new MfaService(userMfa, buildAuth());

    const wrong = totp.generate(totp.generateSecret());
    const ok = await svc.verifyTotp('u1', wrong);
    expect(ok).toBe(false);
  });

  it('verifyTotp returns false (not throw) on a malformed code', async () => {
    // otplib v13's verify() throws TokenFormatError/TokenLengthError on non-digit or wrong-length input; the service must collapse that to false so the controller returns 401 MFA_CODE_INVALID, not a 500.
    const secret = totp.generateSecret();
    const row: UserMfaRow = {
      userId: 'u1',
      totpEnabled: true,
      totpSecret: secret,
      updatedAt: new Date().toISOString(),
    };
    const userMfa = {
      get: jest.fn().mockResolvedValue(row),
      getConsistent: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue(undefined),
      ...defaultLockStubs(),
    } as unknown as UserMfaRepository;
    const svc = new MfaService(userMfa, buildAuth());

    for (const bad of ['abcdef', '1234567', '12345', '', '12 456']) {
      await expect(svc.verifyTotp('u1', bad)).resolves.toBe(false);
    }
  });

  it('verifyTotp returns false when TOTP is not enabled', async () => {
    const notEnabled = {
      userId: 'u1',
      totpEnabled: false,
      updatedAt: '',
    };
    const userMfa = {
      get: jest.fn().mockResolvedValue(notEnabled),
      getConsistent: jest.fn().mockResolvedValue(notEnabled),
      update: jest.fn(),
    } as unknown as UserMfaRepository;
    const svc = new MfaService(userMfa, buildAuth());
    expect(await svc.verifyTotp('u1', '000000')).toBe(false);
  });
});

describe('MfaService — enroll confirm', () => {
  it('promotes the pending secret only when the code verifies', async () => {
    const secret = totp.generateSecret();
    const row: UserMfaRow = {
      userId: 'u1',
      totpEnabled: false,
      pendingTotpSecret: secret,
      updatedAt: '',
    };
    const confirmTotpEnrollment = jest.fn().mockResolvedValue(true);
    const userMfa = {
      get: jest.fn().mockResolvedValue(row),
      confirmTotpEnrollment,
    } as unknown as UserMfaRepository;
    const svc = new MfaService(userMfa, buildAuth());

    const ok = await svc.enrollConfirm('u1', totp.generate(secret), null);
    expect(ok).toBe(true);
    expect(confirmTotpEnrollment).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ totpSecret: secret, expectedPendingSecret: secret }),
    );
  });

  it('returns false, and does not audit, when the promotion loses a concurrent race (the conditional write rejects it)', async () => {
    // confirmTotpEnrollment reports a lost race (a concurrent enrollment promoted a different pending secret between read and write); its write used to be unconditional, so enrollConfirm always reported true.
    const secret = totp.generateSecret();
    const row: UserMfaRow = {
      userId: 'u1',
      totpEnabled: false,
      pendingTotpSecret: secret,
      updatedAt: '',
    };
    const confirmTotpEnrollment = jest.fn().mockResolvedValue(false);
    const userMfa = {
      get: jest.fn().mockResolvedValue(row),
      confirmTotpEnrollment,
    } as unknown as UserMfaRepository;
    const auth = buildAuth();
    const svc = new MfaService(userMfa, auth);

    const ok = await svc.enrollConfirm('u1', totp.generate(secret), null);
    expect(ok).toBe(false);
    expect(auth.record).not.toHaveBeenCalled();
  });

  it('rejects a wrong code and does not promote', async () => {
    const secret = totp.generateSecret();
    const confirmTotpEnrollment = jest.fn();
    const userMfa = {
      get: jest.fn().mockResolvedValue({
        userId: 'u1',
        totpEnabled: false,
        pendingTotpSecret: secret,
        updatedAt: '',
      }),
      confirmTotpEnrollment,
    } as unknown as UserMfaRepository;
    const svc = new MfaService(userMfa, buildAuth());

    const ok = await svc.enrollConfirm('u1', totp.generate(totp.generateSecret()), null);
    expect(ok).toBe(false);
    expect(confirmTotpEnrollment).not.toHaveBeenCalled();
  });

  it('returns false when no pending secret exists', async () => {
    const userMfa = {
      get: jest.fn().mockResolvedValue({ userId: 'u1', totpEnabled: false, updatedAt: '' }),
      confirmTotpEnrollment: jest.fn(),
    } as unknown as UserMfaRepository;
    const svc = new MfaService(userMfa, buildAuth());
    expect(await svc.enrollConfirm('u1', '123456', null)).toBe(false);
  });

  it('does not promote when TOTP became enabled between start and confirm (closes the re-enroll-over-live-secret race)', async () => {
    const secret = totp.generateSecret();
    const confirmTotpEnrollment = jest.fn();
    const userMfa = {
      // totpEnabled with a pendingTotpSecret also present is the race this guards against.
      get: jest.fn().mockResolvedValue({
        userId: 'u1',
        totpEnabled: true,
        totpSecret: 'live-secret',
        pendingTotpSecret: secret,
        updatedAt: '',
      }),
      confirmTotpEnrollment,
    } as unknown as UserMfaRepository;
    const svc = new MfaService(userMfa, buildAuth());

    const ok = await svc.enrollConfirm('u1', totp.generate(secret), null);
    expect(ok).toBe(false);
    expect(confirmTotpEnrollment).not.toHaveBeenCalled();
  });
});

describe('MfaService — enroll start', () => {
  it('mints a pending secret for a user with no enabled factor', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const userMfa = {
      get: jest.fn().mockResolvedValue({ userId: 'u1', totpEnabled: false, updatedAt: '' }),
      update,
      put: jest.fn(),
    } as unknown as UserMfaRepository;
    const svc = new MfaService(userMfa, buildAuth());

    const result = await svc.enrollStart('u1', 'person@example.test');
    expect(result).not.toBeNull();
    expect(result?.secret).toBeTruthy();
    expect(update).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ pendingTotpSecret: result?.secret }),
    );
  });

  it('rejects starting a new enrollment when TOTP is already enabled, without touching the live secret', async () => {
    const update = jest.fn();
    const put = jest.fn();
    const userMfa = {
      get: jest
        .fn()
        .mockResolvedValue({ userId: 'u1', totpEnabled: true, totpSecret: 'live', updatedAt: '' }),
      update,
      put,
    } as unknown as UserMfaRepository;
    const svc = new MfaService(userMfa, buildAuth());

    const result = await svc.enrollStart('u1', 'person@example.test');
    expect(result).toBeNull();
    expect(update).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});

describe('MfaService — disable (password-only step-up, controller-enforced)', () => {
  it('clears the factor + audits mfa_totp_disabled when enabled', async () => {
    const secret = totp.generateSecret();
    const row: UserMfaRow = {
      userId: 'u1',
      totpEnabled: true,
      totpSecret: secret,
      updatedAt: new Date().toISOString(),
    };
    const put = jest.fn().mockResolvedValue(undefined);
    const userMfa = {
      get: jest.fn().mockResolvedValue(row),
      put,
    } as unknown as UserMfaRepository;
    const auth = buildAuth();
    const svc = new MfaService(userMfa, auth);

    const changed = await svc.disable('u1');
    expect(changed).toBe(true);
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', totpEnabled: false }),
    );
    const cleared = put.mock.calls[0][0] as UserMfaRow;
    expect(cleared.totpSecret).toBeUndefined();
    expect(auth.record).toHaveBeenCalledWith({
      userId: 'u1',
      eventType: 'mfa_totp_disabled',
      ip: null,
      userAgent: null,
    });
  });

  it('clears + audits a corrupt row (totpEnabled true, totpSecret absent)', async () => {
    // A legacy or corrupt row with the flag set but no secret must still be clearable, or the broken factor is stuck and can never be re-enrolled.
    const put = jest.fn().mockResolvedValue(undefined);
    const userMfa = {
      get: jest
        .fn()
        .mockResolvedValue({ userId: 'u1', totpEnabled: true, updatedAt: '' }),
      put,
    } as unknown as UserMfaRepository;
    const auth = buildAuth();
    const svc = new MfaService(userMfa, auth);

    const changed = await svc.disable('u1');
    expect(changed).toBe(true);
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', totpEnabled: false }),
    );
    expect(auth.record).toHaveBeenCalledWith({
      userId: 'u1',
      eventType: 'mfa_totp_disabled',
      ip: null,
      userAgent: null,
    });
  });

  it('no-ops (returns false, no put, no audit) when no factor is enabled', async () => {
    const put = jest.fn();
    const userMfa = {
      get: jest.fn().mockResolvedValue({ userId: 'u1', totpEnabled: false, updatedAt: '' }),
      put,
    } as unknown as UserMfaRepository;
    const auth = buildAuth();
    const svc = new MfaService(userMfa, auth);

    const changed = await svc.disable('u1');
    expect(changed).toBe(false);
    expect(put).not.toHaveBeenCalled();
    expect(auth.record).not.toHaveBeenCalled();
  });
});

describe('MfaService — per-account TOTP lock', () => {
  function enabledRow(secret: string): UserMfaRow {
    return {
      userId: 'u1',
      totpEnabled: true,
      totpSecret: secret,
      updatedAt: new Date().toISOString(),
    };
  }

  function lockedRow(secret: string): UserMfaRow {
    return {
      ...enabledRow(secret),
      totpFailureCount: 4,
      totpLastFailureAt: new Date().toISOString(),
    };
  }

  // An in-memory stand-in for the repository's lock contract: `reserveTotpAttempt` is a compare-and-swap on the observed failure state, as the real
  // conditional UpdateCommand is, and `getConsistent` reflects every committed swap and clear.
  function lockStateStubs(
    row: UserMfaRow,
    initial: TotpFailureState = {},
  ): {
    userMfa: UserMfaRepository;
    reserveTotpAttempt: jest.Mock;
    clearTotpFailure: jest.Mock;
    state: () => TotpFailureState;
  } {
    let state: TotpFailureState = { ...initial };
    const reserveTotpAttempt = jest.fn(
      async (_userId: string, observed: TotpFailureState, decaySec: number) => {
        if (
          observed.totpFailureCount !== state.totpFailureCount ||
          observed.totpLastFailureAt !== state.totpLastFailureAt
        ) {
          return null;
        }
        const stale =
          state.totpLastFailureAt === undefined ||
          Date.parse(state.totpLastFailureAt) <= Date.now() - decaySec * 1000;
        state = {
          totpFailureCount: stale ? 1 : (state.totpFailureCount ?? 0) + 1,
          totpLastFailureAt: new Date().toISOString(),
        };
        return { ...state };
      },
    );
    const clearTotpFailure = jest.fn(async () => {
      state = {};
    });
    const getConsistent = jest.fn(async () => ({ ...row, ...state }));
    const userMfa = {
      get: getConsistent,
      getConsistent,
      update: jest.fn().mockResolvedValue(undefined),
      consumeTotpStepUpStep: jest.fn().mockResolvedValue(true),
      reserveTotpAttempt,
      clearTotpFailure,
    } as unknown as UserMfaRepository;
    return { userMfa, reserveTotpAttempt, clearTotpFailure, state: () => state };
  }

  const eventsOf = (auth: AuthEventsRepository, eventType: string) =>
    (auth.record as jest.Mock).mock.calls.filter(
      ([arg]: [{ eventType: string }]) => arg.eventType === eventType,
    );

  it('refuses with the shared 429 shape while locked, even for the correct code, and touches no state', async () => {
    const secret = totp.generateSecret();
    const update = jest.fn();
    const reserveTotpAttempt = jest.fn();
    const clearTotpFailure = jest.fn();
    const userMfa = {
      get: jest.fn().mockResolvedValue(lockedRow(secret)),
      getConsistent: jest.fn().mockResolvedValue(lockedRow(secret)),
      update,
      reserveTotpAttempt,
      clearTotpFailure,
    } as unknown as UserMfaRepository;
    const auth = buildAuth();
    const svc = new MfaService(userMfa, auth);

    const code = totp.generate(secret);
    await expect(svc.verifyTotp('u1', code)).rejects.toBeInstanceOf(ThrottlerException);
    await expect(svc.verifyTotp('u1', code)).rejects.toMatchObject({ status: 429 });

    expect(update).not.toHaveBeenCalled();
    expect(reserveTotpAttempt).not.toHaveBeenCalled();
    expect(clearTotpFailure).not.toHaveBeenCalled();
    expect(auth.record).not.toHaveBeenCalled();
  });

  it('verifyTotpForStepUp refuses with the same 429 shape while locked', async () => {
    const secret = totp.generateSecret();
    const consumeTotpStepUpStep = jest.fn();
    const userMfa = {
      get: jest.fn().mockResolvedValue(lockedRow(secret)),
      getConsistent: jest.fn().mockResolvedValue(lockedRow(secret)),
      update: jest.fn(),
      consumeTotpStepUpStep,
      reserveTotpAttempt: jest.fn(),
      clearTotpFailure: jest.fn(),
    } as unknown as UserMfaRepository;
    const svc = new MfaService(userMfa, buildAuth());

    await expect(
      svc.verifyTotpForStepUp('u1', totp.generate(secret)),
    ).rejects.toBeInstanceOf(ThrottlerException);
    expect(consumeTotpStepUpStep).not.toHaveBeenCalled();
  });

  it('a successful verify clears the per-account failure state', async () => {
    const secret = totp.generateSecret();
    const row = enabledRow(secret);
    const clearTotpFailure = jest.fn().mockResolvedValue(undefined);
    const userMfa = {
      get: jest.fn().mockResolvedValue(row),
      getConsistent: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue(undefined),
      reserveTotpAttempt: jest
        .fn()
        .mockResolvedValue({ totpFailureCount: 1, totpLastFailureAt: new Date().toISOString() }),
      clearTotpFailure,
    } as unknown as UserMfaRepository;
    const svc = new MfaService(userMfa, buildAuth());

    expect(await svc.verifyTotp('u1', totp.generate(secret))).toBe(true);
    expect(clearTotpFailure).toHaveBeenCalledWith('u1');
  });

  it('records the lock-crossing event exactly once — on the miss that trips the lock, not on the free misses, and not on the refusal that follows', async () => {
    const secret = totp.generateSecret();
    const { userMfa, reserveTotpAttempt, state } = lockStateStubs(enabledRow(secret));
    const auth = buildAuth();
    const svc = new MfaService(userMfa, auth);
    const wrong = totp.generate(totp.generateSecret());

    // 3 free misses, then the 4th is compared like any other and carries the count past the threshold (a 2 s window stamped now).
    for (let i = 0; i < 4; i++) {
      expect(await svc.verifyTotp('u1', wrong)).toBe(false);
    }
    expect(state().totpFailureCount).toBe(4);
    expect(eventsOf(auth, 'mfa_totp_locked')).toHaveLength(1);

    // Inside the window even the correct code is refused, and the refusal reserves nothing so it cannot extend the window.
    await expect(svc.verifyTotp('u1', totp.generate(secret))).rejects.toBeInstanceOf(
      ThrottlerException,
    );
    expect(reserveTotpAttempt).toHaveBeenCalledTimes(4);
    expect(state().totpFailureCount).toBe(4);
    expect(eventsOf(auth, 'mfa_totp_locked')).toHaveLength(1);
  });

  it('reopens once the window has elapsed: the correct code is compared, verifies, and clears the lock', async () => {
    const secret = totp.generateSecret();
    // Locked at the 4th miss (a 2 s window) stamped 3 s ago: elapsed. The attempt used to be counted before being looked at and re-stamped the clock, so no correct code could verify again for 24 h.
    const elapsed = new Date(Date.now() - 3_000).toISOString();
    const { userMfa, reserveTotpAttempt, clearTotpFailure, state } = lockStateStubs(
      enabledRow(secret),
      { totpFailureCount: 4, totpLastFailureAt: elapsed },
    );
    const auth = buildAuth();
    const svc = new MfaService(userMfa, auth);

    expect(await svc.verifyTotp('u1', totp.generate(secret))).toBe(true);
    expect(reserveTotpAttempt).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ totpFailureCount: 4, totpLastFailureAt: elapsed }),
      expect.any(Number),
    );
    expect(clearTotpFailure).toHaveBeenCalledWith('u1');
    expect(state()).toEqual({});
    expect(eventsOf(auth, 'mfa_totp_locked')).toHaveLength(0);
  });

  it('reopens on the step-up path too: a correct step-up code after the window verifies and clears', async () => {
    const secret = totp.generateSecret();
    const elapsed = new Date(Date.now() - 3_000).toISOString();
    const { userMfa, clearTotpFailure, state } = lockStateStubs(enabledRow(secret), {
      totpFailureCount: 4,
      totpLastFailureAt: elapsed,
    });
    const svc = new MfaService(userMfa, buildAuth());

    expect(await svc.verifyTotpForStepUp('u1', totp.generate(secret))).toBe(true);
    expect(clearTotpFailure).toHaveBeenCalledWith('u1');
    expect(state()).toEqual({});
  });

  it('a wrong code after the window has elapsed counts as one more miss: the window grows, the lock is not re-audited, and a correct code inside the new window is refused', async () => {
    const secret = totp.generateSecret();
    const elapsed = new Date(Date.now() - 3_000).toISOString();
    const { userMfa, reserveTotpAttempt, state } = lockStateStubs(enabledRow(secret), {
      totpFailureCount: 4,
      totpLastFailureAt: elapsed,
    });
    const auth = buildAuth();
    const svc = new MfaService(userMfa, auth);

    expect(await svc.verifyTotp('u1', totp.generate(totp.generateSecret()))).toBe(false);
    expect(state().totpFailureCount).toBe(5);
    expect(state().totpLastFailureAt).not.toBe(elapsed);
    expect(eventsOf(auth, 'mfa_totp_failed')).toHaveLength(1);
    expect(eventsOf(auth, 'mfa_totp_locked')).toHaveLength(0);

    await expect(svc.verifyTotp('u1', totp.generate(secret))).rejects.toBeInstanceOf(
      ThrottlerException,
    );
    expect(reserveTotpAttempt).toHaveBeenCalledTimes(1);
  });

  it('bounds a burst of genuinely concurrent requests to the same attempts an honest sequence gets, not letting every request in the burst evaluate a code', async () => {
    const secret = totp.generateSecret();
    // Every request reads the same unlocked pre-burst row (an attacker with a pool of IPs); the compare-and-swap admits one per state version and the rest re-read against the winner's stamp.
    const { userMfa, state } = lockStateStubs(enabledRow(secret));
    const auth = buildAuth();
    const svc = new MfaService(userMfa, auth);
    const wrong = totp.generate(totp.generateSecret());

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => svc.verifyTotp('u1', wrong)),
    );

    const evaluated = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof ThrottlerException,
    );
    // Only the 3 free misses plus the 4th that trips the lock reach a code comparison; the old read-then-act check let all 10 through.
    expect(evaluated).toHaveLength(4);
    expect(refused).toHaveLength(6);
    expect(state().totpFailureCount).toBe(4);
    expect(eventsOf(auth, 'mfa_totp_locked')).toHaveLength(1);
  });
});

describe('MfaService — MFA-failure incident log', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('emits an MFA-failure incident warn { factor: "totp" } on a wrong TOTP code', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const secret = totp.generateSecret();
    const row: UserMfaRow = {
      userId: 'u1',
      totpEnabled: true,
      totpSecret: secret,
      updatedAt: new Date().toISOString(),
    };
    const userMfa = {
      get: jest.fn().mockResolvedValue(row),
      getConsistent: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue(undefined),
      ...defaultLockStubs(),
    } as unknown as UserMfaRepository;
    const svc = new MfaService(userMfa, buildAuth());

    const wrong = totp.generate(totp.generateSecret());
    await svc.verifyTotp('u1', wrong);

    expect(warnSpy).toHaveBeenCalledWith('MFA verification failed', {
      userId: 'u1',
      factor: 'totp',
    });
  });

  it('does NOT emit the warn on a successful TOTP verify', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const secret = totp.generateSecret();
    const row: UserMfaRow = {
      userId: 'u1',
      totpEnabled: true,
      totpSecret: secret,
      updatedAt: new Date().toISOString(),
    };
    const userMfa = {
      get: jest.fn().mockResolvedValue(row),
      getConsistent: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue(undefined),
      ...defaultLockStubs(),
    } as unknown as UserMfaRepository;
    const svc = new MfaService(userMfa, buildAuth());

    await svc.verifyTotp('u1', totp.generate(secret));

    expect(warnSpy).not.toHaveBeenCalledWith(
      'MFA verification failed',
      expect.anything(),
    );
  });
});
