// The "remember this device" MFA-skip trust (~30 days): an opaque secret in an httpOnly SameSite=Strict cookie at `/api/v1`, only
// its SHA-256 stored per (userId, deviceId). See docs/security.md, "Trust this device".
import { Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { TrustedDeviceRepository } from '../dynamo/trusted-device.repository.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { RevokedTokensRepository } from '../dynamo/revoked-tokens.repository.js';
import { TransientTransactionError } from '../dynamo/transact-write.js';
import type { TrustedDeviceRow } from '../dynamo/types.js';
import { sha256 } from './refresh-token.service.js';
import {
  DEVICE_TRUST_COOKIE_NAME,
  DEVICE_TRUST_TTL_SEC,
  clearDeviceTrustCookieOptions,
  deviceTrustCookieOptions,
  legacyDeviceTrustCookieOptions,
} from './cookie-config.js';

/**
 * Display-safe trusted-device listing entry; `expiresAt` is converted to an ISO string at the response boundary and
 * `tokenHash` is never surfaced.
 */
export interface TrustedDeviceListItem {
  deviceId: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
  ip: string | null;
  userAgent: string | null;
}

// Per-device failure ceiling: a trusted device serves no backoff wait, only this. One MFA re-challenge is a cheap
// false positive and bounds how long a stolen cookie can guess.
const DEVICE_FAILURE_CEILING = 5;

// Lookup id for an unknown-email identity: no real user can carry it, so the Get always misses, like the dummy argon2
// hash it mirrors.
const UNRESOLVED_TRUST_LOOKUP_USER_ID = 'unresolved-trust-lookup';

/**
 * A device resolved trust state for the shared backoff primitive plus the identity the per-device counter keys on;
 * `userId` is real only when `trusted` came from a genuine lookup.
 */
export interface DeviceTrustContext {
  trusted: boolean;
  userId: string;
  deviceId: string;
  /**
   * The matched row expiry, present only when `trusted`, so the login can re-issue the cookie with exactly its
   * remaining lifetime.
   */
  expiresAt?: number;
}

// Live-expiry guard: true only for a finite number strictly in the future, so a legacy ISO string, NaN or an elapsed
// value is false.
function isLiveEpochSeconds(expiresAt: unknown, nowMs = Date.now()): boolean {
  return (
    typeof expiresAt === 'number' &&
    Number.isFinite(expiresAt) &&
    expiresAt * 1000 > nowMs
  );
}

@Injectable()
export class TrustedDeviceService {
  private readonly logger = new Logger(TrustedDeviceService.name);

  constructor(
    private readonly trustedDevices: TrustedDeviceRepository,
    private readonly auth: AuthEventsRepository,
    private readonly revoked: RevokedTokensRepository,
  ) {}

  /**
   * Verifies a presented cookie against the stored row for `(userId, deviceId)`; any miss falls back to the MFA
   * challenge. An expired row is best-effort deleted, and a match best-effort stamps `lastUsedAt`, which must never
   * fail the login.
   */
  async verify(
    userId: string,
    deviceId: string,
    cookieValue: string | undefined,
  ): Promise<boolean> {
    return (await this.matchLiveRow(userId, deviceId, cookieValue)) !== null;
  }

  // The live row whose stored hash matches the cookie, or null; split out so `resolveTrust` can carry the expiry
  // without a second Get.
  private async matchLiveRow(
    userId: string,
    deviceId: string,
    cookieValue: string | undefined,
  ): Promise<TrustedDeviceRow | null> {
    if (!cookieValue) return null;
    const row = await this.trustedDevices.get(userId, deviceId);
    if (!row) return null;

    // Hash regardless and compare hash-to-hash.
    if (sha256(cookieValue) !== row.tokenHash) return null;

    // A nonnumeric (legacy ISO) or elapsed expiry fails and the row is best-effort deleted, so a pre-cutover trust
    // row no longer skips MFA.
    if (!isLiveEpochSeconds(row.expiresAt)) {
      // A transient fault on the hygiene delete must never crash the request: swallow and warn, then fall through to
      // the MFA re-challenge. Never log the cookie secret or hash.
      try {
        await this.trustedDevices.delete(userId, deviceId);
      } catch (err) {
        this.logger.warn('Best-effort trusted-device hygiene delete failed', {
          userId,
          deviceId,
          reason: err instanceof Error ? err.name : 'unknown',
        });
      }
      return null;
    }
    // Fire-and-forget: a fault stamping the last-use time must never fail the login.
    try {
      await this.trustedDevices.stampLastUsed(userId, deviceId);
    } catch (err) {
      this.logger.warn('Best-effort trusted-device lastUsedAt stamp failed', {
        userId,
        deviceId,
        reason: err instanceof Error ? err.name : 'unknown',
      });
    }
    return row;
  }

  /**
   * Resolves whether `deviceId` is trusted for `userId` in the same shape whether or not `userId` is real: login
   * decides trust ahead of the backoff check, so an unknown email issues the identical Get against a key nothing can
   * match, rather than skipping the round trip (the constant-time hazard).
   */
  async resolveTrust(
    userId: string | null,
    deviceId: string,
    cookieValue: string | undefined,
  ): Promise<DeviceTrustContext> {
    const lookupUserId = userId ?? UNRESOLVED_TRUST_LOOKUP_USER_ID;
    const row = await this.matchLiveRow(lookupUserId, deviceId, cookieValue);
    return row
      ? { trusted: true, userId: lookupUserId, deviceId, expiresAt: row.expiresAt }
      : { trusted: false, userId: lookupUserId, deviceId };
  }

  /**
   * Records one failed password attempt from a trusted device; crossing the ceiling revokes this device trust only,
   * never the account or the per-address counter.
   */
  async recordDeviceFailure(
    userId: string,
    deviceId: string,
    ip?: string | null,
    userAgent?: string | null,
  ): Promise<void> {
    const row = await this.trustedDevices.incrementFailure(userId, deviceId);
    if (row && (row.consecutiveFailures ?? 0) >= DEVICE_FAILURE_CEILING) {
      await this.revoke(userId, deviceId, ip, userAgent, 'failed_attempts_ceiling');
    }
  }

  /** Clears a trusted device failure counter after a successful password verification. */
  async clearDeviceFailures(userId: string, deviceId: string): Promise<void> {
    await this.trustedDevices.clearFailure(userId, deviceId);
  }

  /**
   * Mints a fresh device-trust secret, stores its hash, and sets the cookie; replaces any prior trust for the pair.
   * Audits `mfa_device_trusted`. The row commits in one transaction with a check that `sessionGeneration`, the one the
   * sign-in challenge was minted under, is not retired, so a password reset or change sweeping devices in between
   * cannot have trust recreated behind it: the write fails closed as an invalid challenge and no cookie is set.
   */
  async set(
    userId: string,
    deviceId: string,
    sessionGeneration: number,
    res: Response,
    ip: string | null,
    userAgent: string | null,
  ): Promise<void> {
    const secret = randomBytes(48).toString('base64url');
    const now = new Date();
    const row: TrustedDeviceRow = {
      userId,
      deviceId,
      tokenHash: sha256(secret),
      createdAt: now.toISOString(),
      // Numeric epoch-second TTL so DynamoDB purges an abandoned row.
      expiresAt: Math.floor(now.getTime() / 1000) + DEVICE_TRUST_TTL_SEC,
      lastUsedAt: now.toISOString(),
      ip,
      userAgent,
    };
    try {
      await this.trustedDevices.putChecked(
        row,
        this.revoked.conditionCheckGenerationNotRetiredTransactItem(userId, sessionGeneration),
        () => {
          throw new UnauthorizedException({
            code: 'MFA_CHALLENGE_INVALID',
            message: 'The MFA challenge is invalid.',
          });
        },
      );
    } catch (err) {
      if (err instanceof TransientTransactionError) {
        throw new ServiceUnavailableException({
          code: 'MFA_TRUST_CONFLICT',
          message: 'Could not remember this device right now. Please retry.',
        });
      }
      throw err;
    }
    this.writeCookie(res, secret, DEVICE_TRUST_TTL_SEC * 1000);
    await this.auth.record({
      userId,
      eventType: 'mfa_device_trusted',
      ip,
      userAgent,
      metadata: { deviceId },
    });
  }

  /**
   * Re-issues an already-verified secret at the widened `/api/v1` path with its remaining lifetime and expires any
   * copy at the pre-widening `/api/v1/auth` path, migrating devices remembered before the widening (their cookie
   * reached login but not `POST /sync/workspace/clear`). Idempotent for a cookie already at `/api/v1`; nothing is
   * rotated, no row touched, no audit.
   */
  reissueCookie(res: Response, secret: string, expiresAtSec: number): void {
    const remainingMs = expiresAtSec * 1000 - Date.now();
    if (remainingMs <= 0) return;
    this.writeCookie(res, secret, remainingMs);
  }

  // Writes the cookie at `/api/v1` and expires the pre-widening copy: a cookie identity is (name, domain, path), so
  // otherwise a legacy browser would hold two and `parseCookies` last-wins would depend on path ordering.
  private writeCookie(res: Response, secret: string, maxAgeMs: number): void {
    res.clearCookie(DEVICE_TRUST_COOKIE_NAME, legacyDeviceTrustCookieOptions());
    res.cookie(DEVICE_TRUST_COOKIE_NAME, secret, deviceTrustCookieOptions(maxAgeMs));
  }

  /**
   * Forgets one device trust (keyed delete) and audits `mfa_device_forgotten`. Does not clear the cookie, since the
   * caller may be forgetting another device. `reason` separates an owner action from an automatic ceiling revocation.
   */
  async revoke(
    userId: string,
    deviceId: string,
    ip?: string | null,
    userAgent?: string | null,
    reason?: string,
  ): Promise<void> {
    await this.trustedDevices.delete(userId, deviceId);
    await this.auth.record({
      userId,
      eventType: 'mfa_device_forgotten',
      ip: ip ?? null,
      userAgent: userAgent ?? null,
      metadata: reason ? { deviceId, reason } : { deviceId },
    });
  }

  /**
   * Forgets the given devices through `revoke`, at most 10 concurrent deletes to avoid hot-partition spikes.
   */
  async revokeMany(
    userId: string,
    deviceIds: string[],
    ip?: string | null,
    userAgent?: string | null,
    reason?: string,
  ): Promise<void> {
    const BATCH = 10;
    for (let i = 0; i < deviceIds.length; i += BATCH) {
      await Promise.all(
        deviceIds
          .slice(i, i + BATCH)
          .map((id) => this.revoke(userId, id, ip, userAgent, reason)),
      );
    }
  }

  /**
   * Forgets every device row for the user, expired ones included; a user with none records nothing. The listing is
   * strongly consistent: a `set` that committed just before a password reset or change retired its generation must
   * be swept here, since its ConditionCheck no longer stops it.
   */
  async revokeAll(
    userId: string,
    ip?: string | null,
    userAgent?: string | null,
    reason?: string,
  ): Promise<void> {
    const rows = await this.trustedDevices.listByUser(userId, { consistentRead: true });
    await this.revokeMany(
      userId,
      rows.map((r) => r.deviceId),
      ip,
      userAgent,
      reason,
    );
  }

  /**
   * Every still-trusted device for the manage-devices list; expired rows are excluded by a filter on the numeric TTL,
   * which is the truth for what is still trusted.
   */
  async list(userId: string): Promise<TrustedDeviceListItem[]> {
    const nowMs = Date.now();
    const rows = await this.trustedDevices.listByUser(userId);
    return rows
      .filter((row) => isLiveEpochSeconds(row.expiresAt, nowMs))
      .map((row) => ({
        deviceId: row.deviceId,
        createdAt: row.createdAt,
        expiresAt: new Date(row.expiresAt * 1000).toISOString(),
        lastUsedAt: row.lastUsedAt,
        ip: row.ip,
        userAgent: row.userAgent,
      }));
  }

  /**
   * Clears the device-trust cookie (forget all), also at the older `/api/v1/auth` path: a clear only matches its
   * exact path, so a browser that minted its cookie before the widening would otherwise keep resending it.
   */
  clearCookie(res: Response): void {
    res.clearCookie(DEVICE_TRUST_COOKIE_NAME, clearDeviceTrustCookieOptions());
    res.clearCookie(DEVICE_TRUST_COOKIE_NAME, legacyDeviceTrustCookieOptions());
  }
}
