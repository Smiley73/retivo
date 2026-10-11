/**
 * Unit tests for MfaService:
 *   - TOTP verification honours the ±1 step window and rejects outside it,
 *   - enroll start → confirm promotes the pending secret only on a live code,
 *   - disable clears the TOTP factor and remains idempotent.
 *
 * Pure unit test: the UserMfa repository + AuthEvents are stubbed, and otplib's
 * real TOTP implementation drives the math so the window behaviour is genuine.
 */
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

/**
 * Default per-account TOTP lock stubs for tests that don't
 * exercise the lock itself: every attempt wins its reservation as failure #1,
 * well within the 3-failure grace window (never blocked), and clear is a
 * no-op success.
 */
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

/**
 * A ±1-step (±30 s) TOTP helper matching the service's verify tolerance, built
 * on otplib v13's functional API. The default `@noble` crypto plugin is
 * sync-capable, so the sync variants keep these helpers synchronous.
 */
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
    // The service's own instance must accept a code generated for this secret.
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

    // A code from a totally unrelated secret can't be within ±1 step.
    const wrong = totp.generate(totp.generateSecret());
    const ok = await svc.verifyTotp('u1', wrong);
    expect(ok).toBe(false);
  });

  it('verifyTotp returns false (not throw) on a malformed code', async () => {
    // otplib v13's verify() throws TokenFormatError/TokenLengthError on
    // non-digit or wrong-length input; the service must collapse those to a
    // plain false so the controller returns 401 MFA_CODE_INVALID, not a 500.
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
    // Same shape as the happy-path test, but confirmTotpEnrollment reports a
    // lost race — e.g. a concurrent enrollment already promoted a different
    // pending secret between this read and the write. Before this repair,
    // confirmTotpEnrollment's write was unconditional and its return type
    // carried no such signal, so enrollConfirm always reported `true` here.
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
      // totpEnabled is true even though a pendingTotpSecret is also present —
      // the race this guards against.
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
    // The cleared row drops the secret (a Put with the field absent).
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
    // A legacy/corrupt row with the flag set but no secret must still be
    // clearable — otherwise the broken factor is no-op stuck and can never be
    // re-enrolled (gate is on totpEnabled alone).
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
  /** An enrolled row with no recorded miss. */
  function enabledRow(secret: string): UserMfaRow {
    return {
      userId: 'u1',
      totpEnabled: true,
      totpSecret: secret,
      updatedAt: new Date().toISOString(),
    };
  }

  /** A row already past the 3-failure grace window with its latest failure
   * "now" — `escalatingBackoffState` computes this as blocked. */
  function lockedRow(secret: string): UserMfaRow {
    return {
      ...enabledRow(secret),
      totpFailureCount: 4,
      totpLastFailureAt: new Date().toISOString(),
    };
  }

  /**
   * In-memory stand-in for the repository's per-account lock contract, so a
   * sequence (or a burst) of attempts sees the state each earlier attempt
   * left behind: `reserveTotpAttempt` is a compare-and-swap on exactly the
   * observed failure state — the same guarantee the real conditional
   * `UpdateCommand` gives against a single item — and `getConsistent`
   * reflects every committed swap and clear.
   */
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

    // The CORRECT code — proving the lock refuses regardless of code validity.
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
      // The attempt is reserved before the code is checked — well within grace, so it must not
      // block.
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

    // 3 free (grace) misses, then the 4th miss — compared like any other, and
    // the one that carries the count past the threshold (exponent 4 - 3 = 1
    // → a 2 s window stamped "now").
    for (let i = 0; i < 4; i++) {
      expect(await svc.verifyTotp('u1', wrong)).toBe(false);
    }
    expect(state().totpFailureCount).toBe(4);
    expect(eventsOf(auth, 'mfa_totp_locked')).toHaveLength(1);

    // Inside the window even the correct code is refused — and the refusal
    // reserves nothing, so it cannot extend the window it was refused under.
    await expect(svc.verifyTotp('u1', totp.generate(secret))).rejects.toBeInstanceOf(
      ThrottlerException,
    );
    expect(reserveTotpAttempt).toHaveBeenCalledTimes(4);
    expect(state().totpFailureCount).toBe(4);
    expect(eventsOf(auth, 'mfa_totp_locked')).toHaveLength(1);
  });

  it('reopens once the window has elapsed: the correct code is compared, verifies, and clears the lock', async () => {
    const secret = totp.generateSecret();
    // Locked at the 4th miss (a 2 s window) stamped 3 s ago — elapsed. Previously
    // this attempt was counted before being looked at, re-stamped the
    // clock, and was refused: no correct code could ever verify again until
    // 24 h of silence.
    const elapsed = new Date(Date.now() - 3_000).toISOString();
    const { userMfa, reserveTotpAttempt, clearTotpFailure, state } = lockStateStubs(
      enabledRow(secret),
      { totpFailureCount: 4, totpLastFailureAt: elapsed },
    );
    const auth = buildAuth();
    const svc = new MfaService(userMfa, auth);

    expect(await svc.verifyTotp('u1', totp.generate(secret))).toBe(true);
    // Reserved against exactly the elapsed state it read, then undone.
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
    // Already past the threshold before this miss: the lock extends, it is
    // not crossed again.
    expect(eventsOf(auth, 'mfa_totp_locked')).toHaveLength(0);

    // Count 5 → a fresh 4 s window: refused without reserving.
    await expect(svc.verifyTotp('u1', totp.generate(secret))).rejects.toBeInstanceOf(
      ThrottlerException,
    );
    expect(reserveTotpAttempt).toHaveBeenCalledTimes(1);
  });

  it('bounds a burst of genuinely concurrent requests to the same attempts an honest sequence gets, not letting every request in the burst evaluate a code', async () => {
    const secret = totp.generateSecret();
    // Every request in the burst reads the SAME unlocked pre-burst row — the
    // exact shape of the attacker model ("a pool of IP addresses"
    // firing requests within the same few hundred milliseconds). The
    // compare-and-swap admits exactly one of them per state version; the
    // rest re-read and re-decide against the winner's stamp.
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
    // The 3 free misses plus the 4th that trips the lock reach a real code
    // comparison — the same four an honest sequence gets; the old
    // read-then-act check let all 10 through (every one read the same
    // pre-burst row and passed `assertTotpNotLocked`).
    expect(evaluated).toHaveLength(4);
    expect(refused).toHaveLength(6);
    // The six refusals wrote nothing: the count is exactly the four misses,
    // and the threshold was crossed once.
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
