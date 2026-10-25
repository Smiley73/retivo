// Account-preserving encrypted-workspace reset: the recovery path when encrypted household data is unreadable. Wipes sync state, snapshots and
// key envelopes and revokes sessions, keeping credentials and audit history; purge-first like `DeleteAccountService`.
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
  /** Password re-verify, always required (the flag-off floor is phrase plus password). */
  currentPassword: string;
  /** Fresh step-up factor, required when `AUTH_MFA_ENFORCED` is on. */
  method?: StepUpMethod;
  code?: string;
  assertion?: AuthenticationResponseJSON;
  ip: string | null;
  userAgent: string | null;
  /** Lets a trusted device bypass the per-address backoff, as in login. */
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
    // The phrase is validated at the DTO layer; the caller must clear the password re-verify and, when
    // `AUTH_MFA_ENFORCED` is on, a fresh step-up before the started audit.
    const user = await this.users.findById(args.userId);
    if (!user) {
      // The claim names a user whose row is gone: a credential failure, leaking no state.
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Current password is incorrect.',
      });
    }

    // `VerifyPasswordService` owns the per-account backoff and its `password_verify` audit, so a single wrong
    // password is not double-counted. A lockout is 429, a wrong password 401, a backend fault uncounted;
    // `currentPassword` is never logged.
    await this.verifyPasswordSvc.verify({
      userId: args.userId,
      currentPassword: args.currentPassword,
      ip: args.ip,
      userAgent: args.userAgent,
      deviceId: args.deviceId,
      deviceTrustToken: args.deviceTrustToken,
    });

    // Step-up layered on phrase and password when the flag is on.
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

    // Audit first: the AuthEvent table is never swept, so the started event survives an aborted reset.
    await this.auth.record({
      userId: args.userId,
      eventType: 'encrypted_workspace_reset_started',
      ip: args.ip,
      userAgent: args.userAgent,
      metadata: { householdId: args.householdId },
    });

    try {
      // Revoke every session so each device re-bootstraps against the empty, re-keyable household.
      await this.sweep.revokeAllSessions({
        userId: args.userId,
        currentJti: args.currentJti,
        currentAccessExp: args.currentAccessExp,
      });

      // Purge S3 snapshots before any irreversible DynamoDB delete: a failure leaves the account intact, recoverable
      // by re-login and retry.
      await this.snapshotPurge.purge(args.householdId);

      // The sweep capturing WorkspaceMeta delete returns the push-quota state, so a household-triggerable reset
      // cannot grant a fresh budget.
      const { priorWorkspaceMeta } = await this.sweep.sweepHouseholdData(
        args.householdId,
      );

      // Recreate the empty WorkspaceMeta with `createIfMissing` (no fresh snapshot to point `reinitializeForRestore`
      // at) and merge the captured counters back with an atomic ADD, which keeps both a concurrent push fresh charge
      // and the captured counters.
      await this.workspaceMeta.createIfMissing(args.householdId);
      await this.workspaceMeta.carryQuotaForward(args.householdId, priorWorkspaceMeta);

      // Key-envelope rows are exclusive to this flow, outside the shared sweep.
      await this.householdKeyEnvelopes.deleteAllForHousehold(args.householdId);
    } catch (err) {
      // Log the failure server-side before rethrowing, for an operator trail; only the householdId, already in the
      // audit row.
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
