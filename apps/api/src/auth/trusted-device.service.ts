/**
 * Manages the "remember this device for ~30 days" MFA-skip trust window.
 * Mirrors the refresh-token at-rest pattern:
 * an opaque random secret rides in an httpOnly `SameSite=Strict` cookie scoped
 * to `/api/v1` (widened from `/api/v1/auth` so the same
 * cookie also reaches `POST /sync/workspace/clear` — see cookie-config.ts);
 * only its SHA-256 hash is stored in the `TrustedDevice` row. A device whose
 * presented cookie secret hashes to the stored `tokenHash` (and whose row has
 * not expired) skips the MFA challenge at login.
 *
 * Keyed `(userId, deviceId)` so device trust is per-user-per-device — user B
 * signing in on the same browser misses user A's row and is correctly
 * challenged (cross-user isolation).
 *
 * The raw secret is NEVER stored or logged (only the SHA-256 hash reaches
 * DynamoDB), mirroring RefreshToken.
 *
 * See docs/security.md, "Trust this device".
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { TrustedDeviceRepository } from '../dynamo/trusted-device.repository.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
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
 * Display-safe trusted-device listing entry. `expiresAt` is an ISO string
 * converted from the stored numeric epoch-second TTL at the response boundary;
 * the at-rest `tokenHash` is never surfaced.
 */
export interface TrustedDeviceListItem {
  deviceId: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Per-device ceiling: a trusted device serves NO
 * backoff wait, only this ceiling. One MFA re-challenge is a cheap false
 * positive; it bounds how long a stolen device-trust cookie can guess.
 */
const DEVICE_FAILURE_CEILING = 5;

/** Lookup key `resolveTrust` uses for an unresolved (unknown-email) identity —
 *  no genuine user row can ever carry this id, so the trusted-device Get always
 *  misses, exactly like the dummy argon2 hash it mirrors. */
const UNRESOLVED_TRUST_LOOKUP_USER_ID = 'unresolved-trust-lookup';

/** A device's resolved trust state for the shared backoff primitive
 *  (`FailedLoginService`), plus the identity the per-device counter is keyed
 *  on. `userId` is a real id only when `trusted` is true from a genuine
 *  lookup — see {@link TrustedDeviceService.resolveTrust}. */
export interface DeviceTrustContext {
  trusted: boolean;
  userId: string;
  deviceId: string;
  /** The matched trust row's epoch-second expiry — present only when
   *  `trusted`, so a trusted login can re-issue the presented cookie at the
   *  widened path with exactly its remaining lifetime
   *  ({@link TrustedDeviceService.reissueCookie}). */
  expiresAt?: number;
}

/**
 * Live-expiry guard for the numeric epoch-second TTL. Returns `true` only when `expiresAt` is a
 * finite number strictly in the future. A legacy ISO-string value (`typeof === 'string'`), a
 * NaN/Infinity, or an already-elapsed numeric value all return `false`.
 */
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
  ) {}

  /**
   * Verify a presented device-trust cookie value against the stored row for
   * `(userId, deviceId)`. Returns `true` only when the row exists, the secret
   * hash matches, and the trust has not expired. A miss (no cookie, no row,
   * wrong user, expired) returns `false` so the caller falls back to the MFA
   * challenge. An expired row is best-effort deleted. On a successful match,
   * best-effort stamps `lastUsedAt` so the
   * manage-devices list reflects the latest use, not just the enrolment time —
   * a stamp failure must never fail the login it is riding along with.
   */
  async verify(
    userId: string,
    deviceId: string,
    cookieValue: string | undefined,
  ): Promise<boolean> {
    return (await this.matchLiveRow(userId, deviceId, cookieValue)) !== null;
  }

  /**
   * The row behind {@link verify}: the live `TrustedDevice` row whose stored
   * hash the presented cookie matches, or `null` for every miss. Split out so
   * {@link resolveTrust} can carry the row's expiry without a second Get.
   */
  private async matchLiveRow(
    userId: string,
    deviceId: string,
    cookieValue: string | undefined,
  ): Promise<TrustedDeviceRow | null> {
    if (!cookieValue) return null;
    const row = await this.trustedDevices.get(userId, deviceId);
    if (!row) return null;

    // Constant-ish: hash regardless, compare hash-to-hash. The stored value is
    // the SHA-256 of the opaque secret (never the raw secret).
    if (sha256(cookieValue) !== row.tokenHash) return null;

    // Numeric epoch-second TTL: a nonnumeric
    // (legacy ISO-string) or elapsed value fails and the row is best-effort
    // deleted — a pre-cutover trust row no longer skips the MFA challenge.
    if (!isLiveEpochSeconds(row.expiresAt)) {
      // Best-effort hygiene delete of the stale/legacy row. A transient fault
      // on the delete must NEVER crash the request — swallow + warn, then fall
      // through to the same MFA re-challenge (return false) the caller takes on
      // the success path. Never log the cookie secret / token hash.
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
    // Best-effort — a transient DynamoDB fault stamping the last-use time must
    // never fail the login it is riding along with (fire-and-forget
    // posture, mirrored from the audit-write pattern above).
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
   * Resolve whether `deviceId` is trusted for `userId`, in the SAME shape
   * whether or not `userId` is real (the constant-time
   * hazard). Login must decide trust ahead of the per-address backoff check,
   * but that decision needs a user lookup; an unknown email has none, so this
   * always issues the identical `TrustedDeviceRepository.get` shape — against
   * a lookup key nothing can ever match — rather than skipping the DB round
   * trip only on the known-email branch. Mirrors the dummy-argon2-hash
   * pattern one layer up.
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
   * Record one failed password attempt from a device already resolved as
   * trusted. Crossing {@link DEVICE_FAILURE_CEILING}
   * revokes THIS device's trust only — never the account, never the
   * per-address counter. A device whose row is already gone (increment
   * returns `null`) has nothing to revoke.
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

  /** Clear a trusted device's failure counter on a successful password
   *  verification from it. */
  async clearDeviceFailures(userId: string, deviceId: string): Promise<void> {
    await this.trustedDevices.clearFailure(userId, deviceId);
  }

  /**
   * Mint a fresh device-trust secret, store its hash in the `TrustedDevice`
   * row, and set the httpOnly device-trust cookie on the response. Replaces any
   * prior trust for `(userId, deviceId)` (a single keyed Put). Audits
   * `mfa_device_trusted`.
   */
  async set(
    userId: string,
    deviceId: string,
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
      // Numeric epoch-second TTL so DynamoDB auto-purges an abandoned trust row.
      expiresAt: Math.floor(now.getTime() / 1000) + DEVICE_TRUST_TTL_SEC,
      lastUsedAt: now.toISOString(),
      ip,
      userAgent,
    };
    await this.trustedDevices.put(row);
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
   * Re-issue an ALREADY-VERIFIED device-trust secret at the widened `/api/v1`
   * path with exactly its remaining lifetime (`expiresAtSec` is the matched
   * row's TTL), expiring any same-name copy still scoped to the pre-widening
   * `/api/v1/auth` path. This is the migration for devices remembered before
   * the cookie was widened: their cookie reaches
   * `POST /auth/login` but was never sent to `POST /sync/workspace/clear`,
   * and nothing else re-mints it until the trust expires (~30 days). Called
   * by the login controller after every trusted-device login — the server
   * cannot tell which path a presented cookie was scoped to, and the re-set
   * is idempotent for a cookie already at `/api/v1`. No secret is rotated,
   * no row is touched, no audit event is added: the trust itself is
   * unchanged, only the cookie's path.
   */
  reissueCookie(res: Response, secret: string, expiresAtSec: number): void {
    const remainingMs = expiresAtSec * 1000 - Date.now();
    if (remainingMs <= 0) return;
    this.writeCookie(res, secret, remainingMs);
  }

  /**
   * Write the device-trust cookie at its current `/api/v1` path AND expire
   * the copy a pre-widening browser still holds at `/api/v1/auth`. A cookie's
   * identity is (name, domain, path), so without the clear a re-remembered
   * legacy browser would hold two same-name cookies and `parseCookies`'
   * last-wins read would depend on RFC 6265's SHOULD-level path ordering.
   */
  private writeCookie(res: Response, secret: string, maxAgeMs: number): void {
    res.clearCookie(DEVICE_TRUST_COOKIE_NAME, legacyDeviceTrustCookieOptions());
    res.cookie(DEVICE_TRUST_COOKIE_NAME, secret, deviceTrustCookieOptions(maxAgeMs));
  }

  /**
   * Forget one device's trust (keyed delete). Audits `mfa_device_forgotten` (carries the caller's
   * `ip`/`userAgent` like the login/step-up events already do). Does NOT clear the cookie — the
   * caller may be forgetting a device other than the one issuing the request; the cookie
   * self-expires. `reason` is an additive metadata field distinguishing an owner-initiated "forget
   * this device" from an automatic ceiling revocation — no new event type.
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
   * Every STILL-TRUSTED device for the user (for the manage-devices listing).
   * Expired rows are excluded by a listing-time filter on the numeric TTL (the
   * filter — not whether a row happens to still exist — is the source of truth
   * for what is "still trusted"). Each entry's numeric epoch-second
   * `expiresAt` is converted to an ISO string at this response boundary.
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
   * Clear the device-trust cookie on the response (used when forgetting
   * all). Also clears it at the older `/api/v1/auth` path —
   * a browser that minted its cookie before the
   * path was widened to `/api/v1` still holds a same-name cookie scoped to
   * that narrower path, which the wider-path clear cannot reach (a cookie
   * clear only matches its own exact path), so without this it would keep
   * being resent indefinitely after a "forget all devices".
   */
  clearCookie(res: Response): void {
    res.clearCookie(DEVICE_TRUST_COOKIE_NAME, clearDeviceTrustCookieOptions());
    res.clearCookie(DEVICE_TRUST_COOKIE_NAME, legacyDeviceTrustCookieOptions());
  }
}
