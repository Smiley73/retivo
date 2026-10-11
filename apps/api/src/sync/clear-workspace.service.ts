/**
 * "Delete workspace data" use-case orchestrator. Owns the whole server-authoritative clear:
 * password re-verify wrapped with per-account backoff, the started / completed / failed audit
 * sequencing, and dispatch to `RestoreService`'s sweep+mint+repoint clear (or the purge-only
 * erase-history retry). The HTTP controller delegates the entire use case here so the auth-service
 * coupling (VerifyPasswordService, FailedLoginService) lives in the service layer, not the delivery
 * layer — mirroring `DeleteAccountService`.
 *
 * Audit contract:
 *   - `workspace_clear_failed` — a rejected password / backoff lockout BEFORE
 *     any sweep (a rejected authorization attempt on an irreversible sweep must
 *     be auditable — unlike delete-account, which emits `_started` only after a
 *     successful verify), an erase-history S3 purge failure (the clear still
 *     committed — a 2xx `historyErased:false`), OR an unexpected server
 *     fault before/during the sweep (so a `_started` never dangles without an
 *     ending). Every `_failed` row carries a machine-readable
 *     `metadata.reason` ({@link ClearFailureReason}) so an audit reader can
 *     tell a refused person from an infra fault without cross-referencing
 *     server logs.
 *   - `workspace_clear_started` — after a successful verify, before the sweep.
 *   - `workspace_clear_completed` — on a committed clear whose history request
 *     (if any) succeeded.
 * `currentPassword` is NEVER logged.
 */
import { HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { AccessTokenClaims } from '../auth/jwt.service.js';
import { VerifyPasswordService } from '../auth/verify-password.service.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import type { ClearWorkspaceDto } from './dto/clear-workspace.dto.js';
import { RestoreService, type ClearWorkspaceResult } from './restore.service.js';

/**
 * Machine-readable cause on every `workspace_clear_failed` row
 * (`metadata.reason`):
 *   - `invalid_credentials` — wrong password (or the User row is gone);
 *   - `login_backoff` — refused by the per-account backoff window (429);
 *   - `history_purge_failed` — the clear committed but the optional
 *     erase-history purge did not (2xx `historyErased:false`);
 *   - `server_error` — an unexpected backend fault before or during the
 *     sweep. Nobody was refused — distinguishing this from the rejection
 *     reasons is what keeps the audit trail readable as a security signal.
 */
type ClearFailureReason =
  | 'invalid_credentials'
  | 'login_backoff'
  | 'history_purge_failed'
  | 'server_error';

/** Request-scoped audit closure — captures the caller + ip/userAgent so each
 *  clear event is written with one folded call. */
type RecordClearEvent = (
  eventType:
    | 'workspace_clear_started'
    | 'workspace_clear_completed'
    | 'workspace_clear_failed',
  metadata?: { reason?: ClearFailureReason } & Record<string, unknown>,
) => Promise<void>;

/**
 * Classify a reverify failure for the `workspace_clear_failed` audit row: the
 * two rejection shapes `verifyWithBackoff` throws (401 wrong password / 429
 * lockout) map to their reasons; anything else is an infra fault, not a
 * refused person.
 */
function clearFailureReason(err: unknown): ClearFailureReason {
  if (err instanceof HttpException) {
    if (err.getStatus() === 401) return 'invalid_credentials';
    if (err.getStatus() === 429) return 'login_backoff';
  }
  return 'server_error';
}

@Injectable()
export class ClearWorkspaceService {
  constructor(
    private readonly users: UsersRepository,
    private readonly verifyPassword: VerifyPasswordService,
    private readonly authEvents: AuthEventsRepository,
    private readonly restore: RestoreService,
  ) {}

  async clearWorkspace(
    me: AccessTokenClaims,
    dto: ClearWorkspaceDto,
    ip: string | null,
    userAgent: string | null,
    deviceTrustToken?: string,
  ): Promise<{ ok: true; historyErased: boolean }> {
    const recordEvent: RecordClearEvent = (eventType, metadata) =>
      this.authEvents.record({
        userId: me.userId,
        eventType,
        ip,
        userAgent,
        metadata: { householdId: me.householdId, ...metadata },
      });

    // Password re-verify + per-account backoff BEFORE any sweep; a
    // rejected attempt / lockout audits workspace_clear_failed. A
    // trusted device's cookie bypasses the backoff here
    // too — inherited by construction from VerifyPasswordService.
    await this.reverifyPassword(
      me,
      dto.currentPassword,
      ip,
      userAgent,
      deviceTrustToken,
      recordEvent,
    );

    await recordEvent('workspace_clear_started');

    let result: ClearWorkspaceResult;
    try {
      result =
        dto.purgeHistoryOnly === true
          ? await this.restore.purgeHistory(me.householdId)
          : await this.restore.clearToEmpty(me.householdId, {
              eraseHistory: dto.eraseHistory,
            });
    } catch (err) {
      // The clear died mid-flight (sweep / mint / repoint) — close the audit
      // trail so a `_started` never dangles without an ending, tagged as an
      // infra fault (nobody was refused).
      await recordEvent('workspace_clear_failed', { reason: 'server_error' });
      throw err;
    }

    const eraseRequested =
      dto.eraseHistory === true || dto.purgeHistoryOnly === true;
    if (eraseRequested && !result.historyErased) {
      // The clear committed (2xx) but the erase-history S3 purge failed — the
      // old backups age out on the janitor schedule and stay restorable until
      // then. Audit the purge failure.
      await recordEvent('workspace_clear_failed', {
        reason: 'history_purge_failed',
      });
    } else {
      await recordEvent('workspace_clear_completed', {
        historyErased: result.historyErased,
      });
    }
    return { ok: true, historyErased: result.historyErased };
  }

  /**
   * Password re-verify via {@link VerifyPasswordService.verify}, which now owns the per-account
   * backoff internally — dropping this service's former outer `verifyWithBackoff` wrap so a single
   * wrong password isn't double-counted. A missing user row, a backoff lockout (429), a wrong
   * password (401), or a backend fault each audit workspace_clear_failed exactly once —
   * tagged with a {@link ClearFailureReason} so a refused person and an infra fault stay
   * distinguishable — before rethrowing so the status code is preserved. `VerifyPasswordService`
   * owns the argon2 primitive + the `password_verify` audit; `currentPassword` is never logged.
   */
  private async reverifyPassword(
    me: AccessTokenClaims,
    currentPassword: string,
    ip: string | null,
    userAgent: string | null,
    deviceTrustToken: string | undefined,
    recordEvent: RecordClearEvent,
  ): Promise<void> {
    try {
      const user = await this.users.findById(me.userId);
      if (!user) {
        // The JWT claim says this user exists but the row is gone — treat as
        // INVALID_CREDENTIALS so a partially-completed prior flow leaks nothing.
        throw new UnauthorizedException({
          code: 'INVALID_CREDENTIALS',
          message: 'Current password is incorrect.',
        });
      }
      await this.verifyPassword.verify({
        userId: me.userId,
        currentPassword,
        ip,
        userAgent,
        deviceId: me.deviceId,
        deviceTrustToken,
      });
    } catch (err) {
      await recordEvent('workspace_clear_failed', {
        reason: clearFailureReason(err),
      });
      throw err;
    }
  }
}
