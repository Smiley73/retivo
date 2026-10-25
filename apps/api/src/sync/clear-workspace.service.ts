// "Delete workspace data" orchestrator: password re-verify with backoff, audit sequencing, and dispatch to RestoreService.
// `currentPassword` is never logged.
import { HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { AccessTokenClaims } from '../auth/jwt.service.js';
import { VerifyPasswordService } from '../auth/verify-password.service.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import type { ClearWorkspaceDto } from './dto/clear-workspace.dto.js';
import { RestoreService, type ClearWorkspaceResult } from './restore.service.js';

// Cause on every `workspace_clear_failed` row, so an audit reader can tell a refused person from an infra fault.
type ClearFailureReason =
  | 'invalid_credentials'
  | 'login_backoff'
  | 'history_purge_failed'
  | 'server_error';

type RecordClearEvent = (
  eventType:
    | 'workspace_clear_started'
    | 'workspace_clear_completed'
    | 'workspace_clear_failed',
  metadata?: { reason?: ClearFailureReason } & Record<string, unknown>,
) => Promise<void>;

// A 401 or 429 from verify is a refusal; anything else is an infra fault, not a refused person.
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

    // Re-verify before any sweep; a rejected attempt on an irreversible sweep must be auditable (unlike delete-account).
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
      // Close the audit trail so a `_started` never dangles, tagged as an infra fault.
      await recordEvent('workspace_clear_failed', { reason: 'server_error' });
      throw err;
    }

    const eraseRequested =
      dto.eraseHistory === true || dto.purgeHistoryOnly === true;
    if (eraseRequested && !result.historyErased) {
      // The clear committed; only the erase-history purge failed, and the old backups age out on the janitor schedule.
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

  // VerifyPasswordService owns the backoff, so a single wrong password is not double-counted.
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
        // The JWT says the user exists but the row is gone: INVALID_CREDENTIALS, so a partial prior flow leaks nothing.
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
