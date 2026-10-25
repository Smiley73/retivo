// FailedLoginService.verifyWithBackoff, the shared password re-verify and backoff primitive: a failure is recorded only on a genuine wrong password (verify resolves false), never on a backend fault
// (verify throws); a catch-all that counted any thrown error could let a transient fault after a correct password eventually 429-lock a legitimate account.
import 'reflect-metadata';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import { FailedLoginService } from './failed-login.service.js';
import type { FailedLoginAttemptsRepository } from '../dynamo/failed-login-attempts.repository.js';
import type { FailedLoginAttemptRow } from '../dynamo/types.js';
import type { TrustedDeviceService } from './trusted-device.service.js';
import type { LoginGuessingNoticeService } from './login-guessing-notice.service.js';

const EMAIL = 'alice@example.test';

function buildTrustedDevices() {
  return {
    recordDeviceFailure: jest.fn().mockResolvedValue(undefined),
    clearDeviceFailures: jest.fn().mockResolvedValue(undefined),
  } as unknown as TrustedDeviceService;
}

function buildNotice() {
  return { notifyIfNeeded: jest.fn().mockResolvedValue(undefined) } as unknown as LoginGuessingNoticeService;
}

function makeService() {
  const repo = {
    find: jest.fn(),
    increment: jest.fn(),
    clear: jest.fn(),
  } as unknown as FailedLoginAttemptsRepository;
  const trustedDevices = buildTrustedDevices();
  const notice = buildNotice();
  const service = new FailedLoginService(repo, trustedDevices, notice);
  const checkBackoff = jest.spyOn(service, 'checkBackoff');
  const recordFailure = jest
    .spyOn(service, 'recordFailure')
    .mockResolvedValue(undefined);
  const clear = jest.spyOn(service, 'clear').mockResolvedValue(undefined);
  return { service, repo, checkBackoff, recordFailure, clear };
}

function attemptRow(over: Partial<FailedLoginAttemptRow> = {}): FailedLoginAttemptRow {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    emailLowercase: EMAIL,
    consecutiveFailures: 1,
    lastFailedAt: new Date(nowSec * 1000).toISOString(),
    expiresAt: nowSec + 24 * 60 * 60,
    ...over,
  };
}

async function reject(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the call to reject');
    },
    (err: unknown) => err,
  );
}

describe('FailedLoginService.verifyWithBackoff', () => {
  it('throws 429 LOGIN_BACKOFF without testing the password when the account is within the backoff window', async () => {
    const { service, checkBackoff, recordFailure, clear } = makeService();
    checkBackoff.mockResolvedValue({ blocked: true, retryAfterSec: 8 });
    const verify = jest.fn();

    const err = await reject(
      service.verifyWithBackoff({ emailLowercase: EMAIL, verify }),
    );

    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toMatchObject({
      code: 'LOGIN_BACKOFF',
    });
    expect(verify).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('clears the counter and records no failure when the password matches', async () => {
    const { service, checkBackoff, recordFailure, clear } = makeService();
    checkBackoff.mockResolvedValue({ blocked: false, retryAfterSec: 0 });
    const verify = jest.fn().mockResolvedValue(true);

    await service.verifyWithBackoff({ emailLowercase: EMAIL, verify });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith(EMAIL, undefined);
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it('records exactly one failure and throws 401 INVALID_CREDENTIALS when the password does not match', async () => {
    const { service, checkBackoff, recordFailure, clear } = makeService();
    checkBackoff.mockResolvedValue({ blocked: false, retryAfterSec: 0 });
    const verify = jest.fn().mockResolvedValue(false);

    const err = await reject(
      service.verifyWithBackoff({ emailLowercase: EMAIL, verify }),
    );

    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getStatus()).toBe(401);
    expect((err as UnauthorizedException).getResponse()).toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledWith(EMAIL, null, null, undefined);
    expect(clear).not.toHaveBeenCalled();
  });

  it('propagates a backend fault thrown by verify WITHOUT recording a failure or clearing the counter (regression: no lockout on a transient fault after a correct password)', async () => {
    const { service, checkBackoff, recordFailure, clear } = makeService();
    checkBackoff.mockResolvedValue({ blocked: false, retryAfterSec: 0 });
    const backendFault = new Error('DynamoDB unavailable');
    const verify = jest.fn().mockRejectedValue(backendFault);

    const err = await reject(
      service.verifyWithBackoff({ emailLowercase: EMAIL, verify }),
    );

    expect(err).toBe(backendFault);
    // A thrown error is a backend fault, not an auth failure, so the backoff counter is left untouched.
    expect(recordFailure).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });
});

describe('FailedLoginService.checkBackoff — derived from count + latest failure', () => {
  function build() {
    const repo = {
      find: jest.fn(),
      increment: jest.fn(),
      clear: jest.fn(),
    } as unknown as FailedLoginAttemptsRepository;
    const notice = buildNotice();
    return { service: new FailedLoginService(repo, buildTrustedDevices(), notice), repo, notice };
  }

  it('is unblocked when there is no row', async () => {
    const { service, repo } = build();
    (repo.find as jest.Mock).mockResolvedValue(null);
    expect(await service.checkBackoff(EMAIL)).toEqual({ blocked: false, retryAfterSec: 0 });
  });

  it('is unblocked within the 3-failure grace window', async () => {
    const { service, repo } = build();
    (repo.find as jest.Mock).mockResolvedValue(attemptRow({ consecutiveFailures: 3 }));
    expect(await service.checkBackoff(EMAIL)).toEqual({ blocked: false, retryAfterSec: 0 });
  });

  it('blocks for ~2 s on the 4th consecutive failure', async () => {
    const { service, repo } = build();
    (repo.find as jest.Mock).mockResolvedValue(
      attemptRow({ consecutiveFailures: 4, lastFailedAt: new Date().toISOString() }),
    );
    const state = await service.checkBackoff(EMAIL);
    expect(state.blocked).toBe(true);
    expect(state.retryAfterSec).toBeGreaterThan(0);
    expect(state.retryAfterSec).toBeLessThanOrEqual(2);
  });

  it('caps the wait at 64 s (2^6) regardless of how high the count climbs', async () => {
    const { service, repo } = build();
    (repo.find as jest.Mock).mockResolvedValue(
      attemptRow({ consecutiveFailures: 50, lastFailedAt: new Date().toISOString() }),
    );
    const state = await service.checkBackoff(EMAIL);
    expect(state.blocked).toBe(true);
    expect(state.retryAfterSec).toBeLessThanOrEqual(64);
    expect(state.retryAfterSec).toBeGreaterThan(32);
  });

  it('is unblocked once the derived window has elapsed (old failure timestamp)', async () => {
    const { service, repo } = build();
    // The 4th failure earns a 2 s wait, but the miss was 60 s ago.
    (repo.find as jest.Mock).mockResolvedValue(
      attemptRow({
        consecutiveFailures: 4,
        lastFailedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    expect(await service.checkBackoff(EMAIL)).toEqual({ blocked: false, retryAfterSec: 0 });
  });

  it('recordFailure performs one atomic increment (no read/modify/write) and checks the guessing-notice threshold', async () => {
    const { service, repo, notice } = build();
    (repo.increment as jest.Mock).mockResolvedValue(attemptRow({ consecutiveFailures: 5 }));
    await service.recordFailure(EMAIL, '1.2.3.4', 'jest');
    expect(repo.increment).toHaveBeenCalledTimes(1);
    expect(repo.increment).toHaveBeenCalledWith(EMAIL, 24 * 60 * 60);
    // The race fix must not fall back to a separate read before writing.
    expect(repo.find).not.toHaveBeenCalled();
    expect(notice.notifyIfNeeded).toHaveBeenCalledWith(EMAIL, 5, '1.2.3.4', 'jest');
  });

  it('treats a row holding only a guessing-notice stamp (no counter) as unblocked', async () => {
    const { service, repo } = build();
    (repo.find as jest.Mock).mockResolvedValue({
      emailLowercase: EMAIL,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      guessingNoticeSentAt: new Date().toISOString(),
    });
    expect(await service.checkBackoff(EMAIL)).toEqual({ blocked: false, retryAfterSec: 0 });
  });
});

describe('FailedLoginService — trusted-device bypass', () => {
  function build() {
    const repo = {
      find: jest.fn(),
      increment: jest.fn(),
      clear: jest.fn(),
    } as unknown as FailedLoginAttemptsRepository;
    const trustedDevices = buildTrustedDevices();
    const notice = buildNotice();
    return { service: new FailedLoginService(repo, trustedDevices, notice), repo, trustedDevices, notice };
  }

  const TRUST = { trusted: true, userId: 'u1', deviceId: 'dev1' };

  it('checkBackoff never blocks a trusted device, without reading the per-address row', async () => {
    const { service, repo } = build();
    expect(await service.checkBackoff(EMAIL, TRUST)).toEqual({ blocked: false, retryAfterSec: 0 });
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('recordFailure routes a trusted-device miss to the per-device counter, not the per-address one', async () => {
    const { service, repo, trustedDevices } = build();
    await service.recordFailure(EMAIL, null, null, TRUST);
    expect(trustedDevices.recordDeviceFailure).toHaveBeenCalledWith('u1', 'dev1', null, null);
    expect(repo.increment).not.toHaveBeenCalled();
  });

  it('clear also clears the per-device counter for a trusted device', async () => {
    const { service, repo, trustedDevices } = build();
    await service.clear(EMAIL, TRUST);
    expect(repo.clear).toHaveBeenCalledWith(EMAIL);
    expect(trustedDevices.clearDeviceFailures).toHaveBeenCalledWith('u1', 'dev1');
  });

  it('an untrusted context (or none) leaves per-device counters untouched on clear', async () => {
    const { service, repo, trustedDevices } = build();
    await service.clear(EMAIL, { trusted: false, userId: 'u1', deviceId: 'dev1' });
    expect(repo.clear).toHaveBeenCalledWith(EMAIL);
    expect(trustedDevices.clearDeviceFailures).not.toHaveBeenCalled();
  });
});
