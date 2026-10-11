/**
 * Account-preserving encrypted-workspace reset.
 *
 * The recovery path for an authenticated user whose encrypted household
 * data is unreadable (every unwrapper lost). It wipes the unreadable
 * household sync state + snapshots + key envelopes and revokes all
 * sessions, but keeps the account credentials and the AuthEvent audit
 * history — so the user re-bootstraps clean against a now-empty,
 * re-keyable household instead of deleting the account.
 *
 * Order mirrors `DeleteAccountService` (purge-first — most reversible):
 *   audit started → revoke all sessions → S3 snapshot purge → shared
 *   household-data sweep → key-envelope delete → audit completed.
 *
 * The snapshot purge runs BEFORE any irreversible DynamoDB delete: a
 * purge failure throws here, leaving the account intact with only
 * sessions revoked (recoverable by re-login + retry). The household
 * sync-row sweep reuses the shared `HouseholdSweepService` — no
 * second `BatchWriteItem` code path. Key-envelope deletion is NOT part of
 * the shared sweep; it belongs exclusively to this flow, so account
 * deletion never touches the key table.
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { EnvConfig } from '../common/env.config.js';
import { AccountSnapshotPurgeService } from './account-snapshot-purge.service.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { HouseholdKeyEnvelopesRepository } from '../dynamo/household-key-envelopes.repository.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import { WorkspaceMetaRepository } from '../dynamo/workspace-meta.repository.js';
import { HouseholdSweepService } from './household-sweep.service.js';
import { VerifyPasswordService } from './verify-password.service.js';
import { StepUpService, type StepUpMethod } from './step-up.service.js';

export interface ResetEncryptedWorkspaceArgs {
  userId: string;
  householdId: string;
  currentJti: string;
  currentAccessExp: number;
  /** Password re-verify — always required now
   * (the flag-off floor is phrase + password). */
  currentPassword: string;
  /** Fresh step-up factor — required when `AUTH_MFA_ENFORCED` is on. */
  method?: StepUpMethod;
  code?: string;
  assertion?: AuthenticationResponseJSON;
  ip: string | null;
  userAgent: string | null;
  /** Device identity — lets a trusted
   *  device's password re-verify bypass the per-address backoff, mirroring
   *  login/delete-account. */
  deviceId?: string;
  deviceTrustToken?: string;
}

@Injectable()
export class EncryptedWorkspaceResetService {
  private readonly logger = new Logger(EncryptedWorkspaceResetService.name);
  private readonly mfaEnforced: boolean;

  constructor(
    private readonly sweep: HouseholdSweepService,
    private readonly householdKeyEnvelopes: HouseholdKeyEnvelopesRepository,
    private readonly snapshotPurge: AccountSnapshotPurgeService,
    private readonly auth: AuthEventsRepository,
    private readonly users: UsersRepository,
    private readonly verifyPasswordSvc: VerifyPasswordService,
    private readonly stepUpSvc: StepUpService,
    private readonly workspaceMeta: WorkspaceMetaRepository,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.mfaEnforced = config.get('AUTH_MFA_ENFORCED', { infer: true }) === 'true';
  }

  async resetEncryptedWorkspace(args: ResetEncryptedWorkspaceArgs): Promise<void> {
    // The confirmation phrase itself is validated at the DTO layer. Before the started audit runs
    // the caller must clear the raised gate: a password re-verify (always) + a fresh step-up factor
    // (when `AUTH_MFA_ENFORCED` is on).
    const user = await this.users.findById(args.userId);
    if (!user) {
      // The JWT claim names a user whose row is gone — treat as a credential
      // failure rather than leaking the state (mirrors DeleteAccountService).
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Current password is incorrect.',
      });
    }

    // Password re-verify via VerifyPasswordService, which now owns the per-account backoff
    // internally — dropping this service's former outer `verifyWithBackoff` wrap so a single wrong
    // password isn't double-counted. A wrong password throws `401 INVALID_CREDENTIALS`
    // (backoff-counted first); a lockout throws `429 LOGIN_BACKOFF`; a backend/transient fault
    // propagates uncounted. `VerifyPasswordService.verify` writes its own `password_verify` /
    // `password_verify_failed` audit; `currentPassword` is never logged.
    await this.verifyPasswordSvc.verify({
      userId: args.userId,
      currentPassword: args.currentPassword,
      ip: args.ip,
      userAgent: args.userAgent,
      deviceId: args.deviceId,
      deviceTrustToken: args.deviceTrustToken,
    });

    // Fresh second-factor step-up — layered on top of phrase + password
    // when the flag is on; skipped on the flag-off floor.
    if (this.mfaEnforced) {
      if (!args.method) {
        throw new BadRequestException({
          code: 'STEP_UP_PROOF_MISSING',
          message: 'A second factor is required to reset your encrypted workspace.',
        });
      }
      await this.stepUpSvc.verify({
        userId: args.userId,
        purpose: 'encrypted_workspace_reset',
        method: args.method,
        code: args.code,
        assertion: args.assertion,
        ip: args.ip,
        userAgent: args.userAgent,
      });
    }

    // Audit first — the AuthEvent table is never swept, so the started
    // event survives even if the reset aborts mid-flight (e.g. a purge
    // failure), giving an audit trail of the attempt.
    await this.auth.record({
      userId: args.userId,
      eventType: 'encrypted_workspace_reset_started',
      ip: args.ip,
      userAgent: args.userAgent,
      metadata: { householdId: args.householdId },
    });

    try {
      // Revoke every session so each device re-bootstraps clean against
      // the now-empty, re-keyable household.
      await this.sweep.revokeAllSessions({
        userId: args.userId,
        currentJti: args.currentJti,
        currentAccessExp: args.currentAccessExp,
      });

      // Purge S3 snapshots BEFORE any irreversible DynamoDB delete. A
      // purge failure throws here, leaving the account intact (only
      // sessions revoked, recoverable by re-login + retry).
      await this.snapshotPurge.purge(args.householdId);

      // Shared household-data sweep: MutationLog, IdempotencyKey, AggregateVersion, WorkspaceMeta,
      // DeviceRegistry. Its WorkspaceMeta delete is the capturing one (`DeleteItem` +
      // `ReturnValues: 'ALL_OLD'`), so the daily push-quota state comes back exactly as it stood
      // when the row went away — no separate read for an in-flight push's charge to slip past, and
      // no second delete to erase a charge that recreated the row in between. An
      // encrypted-workspace reset is household-triggerable and must not grant a fresh budget.
      const { priorWorkspaceMeta } = await this.sweep.sweepHouseholdData(
        args.householdId,
      );

      // Recreate the (now-empty) WorkspaceMeta row, then MERGE the captured
      // counters back onto it. Unlike `RestoreService`/`ClearWorkspaceService`
      // there is no fresh snapshot to point a `reinitializeForRestore` at
      // here (this flow wipes ALL sync state and mints nothing to replace
      // it), so this reuses `createIfMissing`'s bare-row shape — the same
      // row a first-ever push would create. The carry-forward is a separate
      // atomic `ADD` rather than a field on the create: the create's
      // conditional Put defers to a row a concurrent push may already have
      // recreated with its own fresh charge, and an `ADD` keeps BOTH that
      // charge and the captured counters instead of discarding one of them.
      await this.workspaceMeta.createIfMissing(args.householdId);
      await this.workspaceMeta.carryQuotaForward(args.householdId, priorWorkspaceMeta);

      // Key-envelope rows — exclusive to this flow (NOT in the shared
      // sweep): all slots + the ENVELOPE_META sentinel.
      await this.householdKeyEnvelopes.deleteAllForHousehold(args.householdId);
    } catch (err) {
      // Surface the failure in the server log before re-throwing — the
      // operator needs a trail when a reset aborts mid-flight (e.g. a
      // snapshot-purge failure leaving only sessions revoked). No PII /
      // secrets: only the householdId, which is already in the audit row.
      this.logger.warn(
        `Encrypted workspace reset failed for household ${args.householdId}`,
        err instanceof Error ? err.stack : String(err),
      );
      await this.auth.record({
        userId: args.userId,
        eventType: 'encrypted_workspace_reset_failed',
        ip: args.ip,
        userAgent: args.userAgent,
        metadata: { householdId: args.householdId },
      });
      throw err;
    }

    await this.auth.record({
      userId: args.userId,
      eventType: 'encrypted_workspace_reset_completed',
      ip: args.ip,
      userAgent: args.userAgent,
      metadata: { householdId: args.householdId },
    });
  }
}
