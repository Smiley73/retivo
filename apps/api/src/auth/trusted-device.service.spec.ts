// TrustedDeviceService: the hash round trip (sha256 of the secret), expiry (a past `expiresAt` fails verify and best-effort deletes the row), revoke, and cross-user
// isolation (lookup keyed by userId and deviceId). The repository and AuthEvents are stubbed; the real sha256 drives the hash check.
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { TrustedDeviceService } from './trusted-device.service.js';
import type { TrustedDeviceRepository } from '../dynamo/trusted-device.repository.js';
import type { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import type { RevokedTokensRepository } from '../dynamo/revoked-tokens.repository.js';
import type { TrustedDeviceRow } from '../dynamo/types.js';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function buildAuth(): AuthEventsRepository {
  return { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuthEventsRepository;
}

function buildRevoked(): RevokedTokensRepository {
  return {
    conditionCheckGenerationNotRetiredTransactItem: jest.fn().mockReturnValue({ ConditionCheck: {} }),
  } as unknown as RevokedTokensRepository;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function row(over: Partial<TrustedDeviceRow> = {}): TrustedDeviceRow {
  return {
    userId: 'userA',
    deviceId: 'dev1',
    tokenHash: sha256('the-secret'),
    createdAt: new Date().toISOString(),
    expiresAt: nowSec() + 30 * 86_400,
    lastUsedAt: new Date().toISOString(),
    ip: null,
    userAgent: null,
    ...over,
  };
}

describe('TrustedDeviceService — verify', () => {
  it('returns false when no cookie value is presented', async () => {
    const repo = { get: jest.fn() } as unknown as TrustedDeviceRepository;
    const svc = new TrustedDeviceService(repo, buildAuth(), buildRevoked());
    expect(await svc.verify('userA', 'dev1', undefined)).toBe(false);
    expect(repo.get).not.toHaveBeenCalled();
  });

  it('accepts the matching cookie value (hash round-trip)', async () => {
    const stampLastUsed = jest.fn().mockResolvedValue(undefined);
    const repo = {
      get: jest.fn().mockResolvedValue(row()),
      delete: jest.fn(),
      stampLastUsed,
    } as unknown as TrustedDeviceRepository;
    const svc = new TrustedDeviceService(repo, buildAuth(), buildRevoked());
    expect(await svc.verify('userA', 'dev1', 'the-secret')).toBe(true);
    expect(stampLastUsed).toHaveBeenCalledWith('userA', 'dev1');
  });

  it('still returns true when the best-effort lastUsedAt stamp throws', async () => {
    // A transient DynamoDB fault stamping the last-use time must never fail the login it rides along with.
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const stampLastUsed = jest.fn().mockRejectedValue(new Error('ProvisionedThroughputExceeded'));
    const repo = {
      get: jest.fn().mockResolvedValue(row()),
      delete: jest.fn(),
      stampLastUsed,
    } as unknown as TrustedDeviceRepository;
    const svc = new TrustedDeviceService(repo, buildAuth(), buildRevoked());
    expect(await svc.verify('userA', 'dev1', 'the-secret')).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('rejects a wrong cookie value', async () => {
    const repo = {
      get: jest.fn().mockResolvedValue(row()),
      delete: jest.fn(),
    } as unknown as TrustedDeviceRepository;
    const svc = new TrustedDeviceService(repo, buildAuth(), buildRevoked());
    expect(await svc.verify('userA', 'dev1', 'wrong-secret')).toBe(false);
  });

  it('rejects + deletes an expired trust row even on a matching secret', async () => {
    const del = jest.fn().mockResolvedValue(undefined);
    const repo = {
      get: jest.fn().mockResolvedValue(row({ expiresAt: nowSec() - 1 })),
      delete: del,
    } as unknown as TrustedDeviceRepository;
    const svc = new TrustedDeviceService(repo, buildAuth(), buildRevoked());
    expect(await svc.verify('userA', 'dev1', 'the-secret')).toBe(false);
    expect(del).toHaveBeenCalledWith('userA', 'dev1');
  });

  it('rejects + deletes a legacy ISO-string `expiresAt` row (clean cutover)', async () => {
    const del = jest.fn().mockResolvedValue(undefined);
    const repo = {
      // A pre-cutover row whose TTL is still an ISO string must fail the numeric guard, so old device trust never skips the challenge.
      get: jest.fn().mockResolvedValue(
        row({ expiresAt: '2030-01-01T00:00:00.000Z' as unknown as number }),
      ),
      delete: del,
    } as unknown as TrustedDeviceRepository;
    const svc = new TrustedDeviceService(repo, buildAuth(), buildRevoked());
    expect(await svc.verify('userA', 'dev1', 'the-secret')).toBe(false);
    expect(del).toHaveBeenCalledWith('userA', 'dev1');
  });

  it('still returns false when the best-effort hygiene delete throws', async () => {
    // A transient fault on the hygiene delete must not crash verify; it falls through to the same MFA re-challenge.
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const del = jest.fn().mockRejectedValue(new Error('ProvisionedThroughputExceeded'));
    const repo = {
      get: jest.fn().mockResolvedValue(row({ expiresAt: nowSec() - 1 })),
      delete: del,
    } as unknown as TrustedDeviceRepository;
    const svc = new TrustedDeviceService(repo, buildAuth(), buildRevoked());
    expect(await svc.verify('userA', 'dev1', 'the-secret')).toBe(false);
    expect(del).toHaveBeenCalledWith('userA', 'dev1');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('cross-user isolation: user B misses user A row (keyed lookup returns null)', async () => {
    const repo = {
      get: jest.fn(async (userId: string) => (userId === 'userA' ? row() : null)),
      delete: jest.fn(),
    } as unknown as TrustedDeviceRepository;
    const svc = new TrustedDeviceService(repo, buildAuth(), buildRevoked());
    expect(await svc.verify('userB', 'dev1', 'the-secret')).toBe(false);
  });
});

describe('TrustedDeviceService — set + revoke', () => {
  it('set stores sha256(secret) and sets the device-trust cookie', async () => {
    const putChecked = jest.fn().mockResolvedValue(undefined);
    const repo = { putChecked } as unknown as TrustedDeviceRepository;
    const auth = buildAuth();
    const svc = new TrustedDeviceService(repo, auth, buildRevoked());
    const cookie = jest.fn();
    const clearCookie = jest.fn();
    const res = { cookie, clearCookie } as unknown as Response;

    await svc.set('userA', 'dev1', 3, res, '1.2.3.4', 'UA');

    const stored = putChecked.mock.calls[0][0] as TrustedDeviceRow;
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // The cookie carries the raw secret and the row its hash, which must match.
    const cookieSecret = cookie.mock.calls[0][1] as string;
    expect(sha256(cookieSecret)).toBe(stored.tokenHash);
    expect(cookie.mock.calls[0][2]).toEqual(expect.objectContaining({ path: '/api/v1' }));
    // The mint also expires the same-name cookie a pre-widening browser still holds at /api/v1/auth, so it never ends up with two.
    expect(clearCookie).toHaveBeenCalledWith(
      cookie.mock.calls[0][0],
      expect.objectContaining({ path: '/api/v1/auth', maxAge: 0 }),
    );
    expect(auth.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'mfa_device_trusted' }),
    );
  });

  it('set guards the row on the challenge session generation, and a retired one stores no row and sets no cookie', async () => {
    const check = { ConditionCheck: { Key: { jti: 'gen:userA:3' } } };
    const revoked = {
      conditionCheckGenerationNotRetiredTransactItem: jest.fn().mockReturnValue(check),
    } as unknown as RevokedTokensRepository;
    const putChecked = jest
      .fn()
      .mockImplementation(
        async (_row: TrustedDeviceRow, _check: unknown, onCheckFailed: () => never) => {
          onCheckFailed();
        },
      );
    const repo = { putChecked } as unknown as TrustedDeviceRepository;
    const auth = buildAuth();
    const svc = new TrustedDeviceService(repo, auth, revoked);
    const cookie = jest.fn();
    const res = { cookie, clearCookie: jest.fn() } as unknown as Response;

    await expect(svc.set('userA', 'dev1', 3, res, null, null)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'MFA_CHALLENGE_INVALID' }),
    });

    expect(revoked.conditionCheckGenerationNotRetiredTransactItem).toHaveBeenCalledWith('userA', 3);
    expect(putChecked.mock.calls[0][1]).toBe(check);
    expect(cookie).not.toHaveBeenCalled();
    expect(auth.record).not.toHaveBeenCalled();
  });

  it('reissueCookie re-sets an already-verified secret at /api/v1 with its remaining lifetime and expires the /api/v1/auth copy', () => {
    const svc = new TrustedDeviceService({} as TrustedDeviceRepository, buildAuth(), buildRevoked());
    const cookie = jest.fn();
    const clearCookie = jest.fn();
    const res = { cookie, clearCookie } as unknown as Response;
    const tenDaysSec = 10 * 86_400;

    svc.reissueCookie(res, 'the-secret', nowSec() + tenDaysSec);

    expect(clearCookie).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ path: '/api/v1/auth', maxAge: 0 }),
    );
    const [name, value, opts] = cookie.mock.calls[0] as [string, string, { path: string; maxAge: number }];
    expect(name).toBe(clearCookie.mock.calls[0][0]);
    // The same secret (no rotation) at the widened path, for the row's remaining TTL, not a fresh 30 days.
    expect(value).toBe('the-secret');
    expect(opts.path).toBe('/api/v1');
    expect(opts.maxAge).toBeGreaterThan((tenDaysSec - 5) * 1000);
    expect(opts.maxAge).toBeLessThanOrEqual(tenDaysSec * 1000);
  });

  it('reissueCookie writes nothing for an already-elapsed expiry', () => {
    const svc = new TrustedDeviceService({} as TrustedDeviceRepository, buildAuth(), buildRevoked());
    const cookie = jest.fn();
    const clearCookie = jest.fn();
    const res = { cookie, clearCookie } as unknown as Response;

    svc.reissueCookie(res, 'the-secret', nowSec() - 1);

    expect(cookie).not.toHaveBeenCalled();
    expect(clearCookie).not.toHaveBeenCalled();
  });

  it('revoke deletes the keyed row and audits', async () => {
    const del = jest.fn().mockResolvedValue(undefined);
    const repo = { delete: del } as unknown as TrustedDeviceRepository;
    const auth = buildAuth();
    const svc = new TrustedDeviceService(repo, auth, buildRevoked());

    await svc.revoke('userA', 'dev1');
    expect(del).toHaveBeenCalledWith('userA', 'dev1');
    expect(auth.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'mfa_device_forgotten',
        ip: null,
        userAgent: null,
        metadata: { deviceId: 'dev1' },
      }),
    );
  });

  it('revoke carries the caller ip/userAgent into the audit row', async () => {
    const repo = { delete: jest.fn().mockResolvedValue(undefined) } as unknown as TrustedDeviceRepository;
    const auth = buildAuth();
    const svc = new TrustedDeviceService(repo, auth, buildRevoked());

    await svc.revoke('userA', 'dev1', '1.2.3.4', 'UA');
    expect(auth.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'mfa_device_forgotten', ip: '1.2.3.4', userAgent: 'UA' }),
    );
  });

  it('revoke carries an optional reason in the audit metadata', async () => {
    const repo = { delete: jest.fn().mockResolvedValue(undefined) } as unknown as TrustedDeviceRepository;
    const auth = buildAuth();
    const svc = new TrustedDeviceService(repo, auth, buildRevoked());

    await svc.revoke('userA', 'dev1', null, null, 'failed_attempts_ceiling');
    expect(auth.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'mfa_device_forgotten',
        metadata: { deviceId: 'dev1', reason: 'failed_attempts_ceiling' },
      }),
    );
  });
});

describe('TrustedDeviceService — resolveTrust (constant-time hazard)', () => {
  it('resolves trusted:true for a genuine userId with a matching cookie, carrying the row expiry', async () => {
    const live = row();
    const repo = { get: jest.fn().mockResolvedValue(live) } as unknown as TrustedDeviceRepository;
    const svc = new TrustedDeviceService(repo, buildAuth(), buildRevoked());
    const ctx = await svc.resolveTrust('userA', 'dev1', 'the-secret');
    // `expiresAt` lets a trusted login re-issue the cookie with its remaining lifetime without a second Get.
    expect(ctx).toEqual({
      trusted: true,
      userId: 'userA',
      deviceId: 'dev1',
      expiresAt: live.expiresAt,
    });
  });

  it('resolves trusted:false without an expiry for a wrong secret', async () => {
    const repo = { get: jest.fn().mockResolvedValue(row()) } as unknown as TrustedDeviceRepository;
    const svc = new TrustedDeviceService(repo, buildAuth(), buildRevoked());
    const ctx = await svc.resolveTrust('userA', 'dev1', 'wrong-secret');
    expect(ctx).toEqual({ trusted: false, userId: 'userA', deviceId: 'dev1' });
  });

  it('issues the SAME lookup shape for an unresolved (null) identity as a real one', async () => {
    const get = jest.fn().mockResolvedValue(null);
    const repo = { get } as unknown as TrustedDeviceRepository;
    const svc = new TrustedDeviceService(repo, buildAuth(), buildRevoked());
    const ctx = await svc.resolveTrust(null, 'dev1', 'some-cookie');
    expect(ctx.trusted).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('TrustedDeviceService — per-device failure ceiling', () => {
  it('recordDeviceFailure does not revoke below the ceiling', async () => {
    const incrementFailure = jest.fn().mockResolvedValue(row({ consecutiveFailures: 4 }));
    const del = jest.fn();
    const repo = { incrementFailure, delete: del } as unknown as TrustedDeviceRepository;
    const auth = buildAuth();
    const svc = new TrustedDeviceService(repo, auth, buildRevoked());

    await svc.recordDeviceFailure('userA', 'dev1');
    expect(del).not.toHaveBeenCalled();
  });

  it('recordDeviceFailure at the ceiling revokes only this device, tagged with the ceiling reason', async () => {
    const incrementFailure = jest.fn().mockResolvedValue(row({ consecutiveFailures: 5 }));
    const del = jest.fn().mockResolvedValue(undefined);
    const repo = { incrementFailure, delete: del } as unknown as TrustedDeviceRepository;
    const auth = buildAuth();
    const svc = new TrustedDeviceService(repo, auth, buildRevoked());

    await svc.recordDeviceFailure('userA', 'dev1');
    expect(del).toHaveBeenCalledWith('userA', 'dev1');
    expect(auth.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'mfa_device_forgotten',
        metadata: { deviceId: 'dev1', reason: 'failed_attempts_ceiling' },
      }),
    );
  });

  it('recordDeviceFailure no-ops when the device row is already gone', async () => {
    const incrementFailure = jest.fn().mockResolvedValue(null);
    const del = jest.fn();
    const repo = { incrementFailure, delete: del } as unknown as TrustedDeviceRepository;
    const svc = new TrustedDeviceService(repo, buildAuth(), buildRevoked());

    await svc.recordDeviceFailure('userA', 'dev1');
    expect(del).not.toHaveBeenCalled();
  });

  it('clearDeviceFailures delegates to the repository', async () => {
    const clearFailure = jest.fn().mockResolvedValue(undefined);
    const repo = { clearFailure } as unknown as TrustedDeviceRepository;
    const svc = new TrustedDeviceService(repo, buildAuth(), buildRevoked());

    await svc.clearDeviceFailures('userA', 'dev1');
    expect(clearFailure).toHaveBeenCalledWith('userA', 'dev1');
  });
});

describe('TrustedDeviceService — list', () => {
  it('excludes expired entries and converts the numeric TTL to an ISO string', async () => {
    const live = row({ deviceId: 'live', expiresAt: nowSec() + 3600 });
    const expired = row({ deviceId: 'expired', expiresAt: nowSec() - 1 });
    const legacyIso = row({
      deviceId: 'legacy',
      expiresAt: '2030-01-01T00:00:00.000Z' as unknown as number,
    });
    const repo = {
      listByUser: jest.fn().mockResolvedValue([live, expired, legacyIso]),
    } as unknown as TrustedDeviceRepository;
    const svc = new TrustedDeviceService(repo, buildAuth(), buildRevoked());

    const listed = await svc.list('userA');

    // The expired numeric row and the pre-cutover ISO-string row are excluded.
    expect(listed.map((d) => d.deviceId)).toEqual(['live']);
    expect(listed[0].expiresAt).toBe(new Date(live.expiresAt * 1000).toISOString());
    expect(listed[0]).not.toHaveProperty('tokenHash');
  });
});

describe('TrustedDeviceService — revokeAll', () => {
  it('deletes every row for the user, expired ones included, and audits each with the reason', async () => {
    const rows = [
      row({ deviceId: 'dev1' }),
      row({ deviceId: 'dev2' }),
      row({ deviceId: 'dev3', expiresAt: nowSec() - 60 }),
    ];
    const del = jest.fn().mockResolvedValue(undefined);
    const repo = {
      listByUser: jest.fn().mockResolvedValue(rows),
      delete: del,
    } as unknown as TrustedDeviceRepository;
    const auth = buildAuth();
    const svc = new TrustedDeviceService(repo, auth, buildRevoked());

    await svc.revokeAll('userA', '1.2.3.4', 'ua', 'password_reset');

    expect(del.mock.calls.map((c: unknown[]) => c[1]).sort()).toEqual(['dev1', 'dev2', 'dev3']);
    const record = auth.record as jest.Mock;
    expect(record).toHaveBeenCalledTimes(3);
    for (const [event] of record.mock.calls as Array<[{ eventType: string; metadata: { reason: string } }]>) {
      expect(event.eventType).toBe('mfa_device_forgotten');
      expect(event.metadata.reason).toBe('password_reset');
    }
  });

  it('is a no-op for a user with no rows', async () => {
    const del = jest.fn();
    const repo = {
      listByUser: jest.fn().mockResolvedValue([]),
      delete: del,
    } as unknown as TrustedDeviceRepository;
    const auth = buildAuth();
    const svc = new TrustedDeviceService(repo, auth, buildRevoked());

    await svc.revokeAll('userA', null, null, 'password_change');

    expect(del).not.toHaveBeenCalled();
    expect(auth.record).not.toHaveBeenCalled();
  });
});
