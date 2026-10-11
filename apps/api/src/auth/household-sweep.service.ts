/**
 * Shared household-data sweep.
 *
 * Extracted from `DeleteAccountService` so the same audited sync-row sweep
 * + session-revocation logic serves every authorised consumer without a
 * second `BatchWriteItem` code path. The four authorised consumers are:
 * `DELETE /auth/account`, the account-preserving encrypted-workspace reset,
 * `POST /sync/restore` (self-service snapshot restore), and
 * `POST /sync/workspace/clear` (the server-authoritative "Delete workspace
 * data" clear). The locked "DeleteAccountService-only" BatchWriteItem /
 * snapshot-purge scope is widened to "the shared household-data sweep" across
 * those four (see AGENTS.md, "Project-specific security").
 *
 * The sweep covers the household-scoped sync rows only: `MutationLog`,
 * `IdempotencyKey`, `AggregateVersion`, `WorkspaceMeta`, and
 * `DeviceRegistry`. Key-envelope rows are NOT part of the shared sweep —
 * they belong exclusively to the encrypted-workspace reset flow, so
 * account deletion's own auth-state cascade keeps its existing scope.
 */
import { Injectable } from '@nestjs/common';
import { AggregateVersionRepository } from '../dynamo/aggregate-version.repository.js';
import { DeviceRegistryRepository } from '../dynamo/device-registry.repository.js';
import { IdempotencyKeyRepository } from '../dynamo/idempotency-key.repository.js';
import { MutationLogRepository } from '../dynamo/mutation-log.repository.js';
import { WorkspaceMetaRepository } from '../dynamo/workspace-meta.repository.js';
import type { WorkspaceMetaRow } from '../dynamo/types.js';
import { SessionRevocationService } from './session-revocation.service.js';

export interface RevokeAllSessionsArgs {
  userId: string;
  currentJti: string;
  currentAccessExp: number;
}

export interface SweepHouseholdDataResult {
  /**
   * The `WorkspaceMeta` row exactly as it existed when the sweep deleted it
   * (`null` when there was none) — captured by the delete itself
   * (`DeleteItem` + `ReturnValues: 'ALL_OLD'`), so it reflects every daily
   * push-quota charge that committed before the row went away. The
   * household-triggerable consumers (restore, workspace clear,
   * encrypted-workspace reset) merge its quota counters back onto the
   * recreated row via `WorkspaceMetaRepository.carryQuotaForward`;
   * account deletion ignores it.
   */
  priorWorkspaceMeta: WorkspaceMetaRow | null;
}

export interface SweepHouseholdDataOptions {
  /**
   * Restore/clear only: fence the `WorkspaceMeta` delete on the
   * `restoreEpoch` the caller observed before sweeping. The delete then runs
   * FIRST and conditionally (`WorkspaceMetaRepository.deleteForRestore`),
   * throwing `RestoreEpochLostError` before any other row is touched when the
   * row already carries a newer epoch — a restore/clear that started after
   * this caller's read and has already completed. Unfenced, an older restore's
   * sweep erases that newer row, epoch included, and its pointer flip then
   * passes as a fresh write: a silent undo of a completed operation.
   * `observedEpoch: undefined` (a row never restored, or absent) is a real,
   * distinct observation here, not "no fence" — hence the wrapper object.
   */
  restoreEpochFence?: { observedEpoch: number | undefined };
}

@Injectable()
export class HouseholdSweepService {
  constructor(
    private readonly mutationLog: MutationLogRepository,
    private readonly idempotencyKeys: IdempotencyKeyRepository,
    private readonly aggregateVersions: AggregateVersionRepository,
    private readonly workspaceMeta: WorkspaceMetaRepository,
    private readonly deviceRegistry: DeviceRegistryRepository,
    private readonly sessions: SessionRevocationService,
  ) {}

  /**
   * Hard-delete every household-scoped sync row: `MutationLog`,
   * `IdempotencyKey`, `AggregateVersion`, `WorkspaceMeta`, and
   * `DeviceRegistry`. Idempotent — safe to re-run after a partial failure.
   *
   * The `WorkspaceMeta` step is the sweep's single, capturing delete:
   * it returns the row as it stood
   * at that instant so a consumer that must carry the daily push-quota
   * forward has neither a read-then-delete window for an in-flight push's
   * charge to vanish into, nor a second delete that would erase a charge
   * which recreated the row in between. Same tables,
   * same `DeleteItem` — only `ReturnValues` is added, so the audited sweep
   * scope is unchanged.
   *
   * With a `restoreEpochFence` the `WorkspaceMeta` delete moves to the front
   * and becomes conditional — see {@link SweepHouseholdDataOptions}. It still
   * captures the prior row (`deleteForRestore` also returns `ALL_OLD`), so
   * the quota carry-forward behavior is unchanged either way.
   */
  async sweepHouseholdData(
    householdId: string,
    opts: SweepHouseholdDataOptions = {},
  ): Promise<SweepHouseholdDataResult> {
    const fence = opts.restoreEpochFence;
    // Fenced WorkspaceMeta delete FIRST: the epoch check has to run
    // before MutationLog / AggregateVersion are touched, or a losing restore
    // would already have destroyed the winner's reseeded version rows (and
    // any post-restore pushes) by the time it found out it lost.
    const priorWorkspaceMeta = fence
      ? await this.workspaceMeta.deleteForRestore(householdId, fence.observedEpoch)
      : null;
    await this.mutationLog.deleteAllForHousehold(householdId);
    await this.idempotencyKeys.deleteAllForHousehold(householdId);
    await this.aggregateVersions.deleteAllForHousehold(householdId);
    // Already deleted (fenced) above for restore/clear. An unconditional
    // re-delete here would erase a newer restore's row that committed while
    // this sweep was running — the exact hole the fence closes.
    const capturedWorkspaceMeta = fence
      ? priorWorkspaceMeta
      : await this.workspaceMeta.deleteReturningPrior(householdId);
    await this.deviceRegistry.deleteAllForHousehold(householdId);
    return { priorWorkspaceMeta: capturedWorkspaceMeta };
  }

  /**
   * Revoke every session for the user so every device re-bootstraps clean: delegates to the shared
   * {@link SessionRevocationService}, which denylists still-valid access-token jtis
   * from ALL of the user's refresh rows (not just the active ones) — a tightening of this method's
   * own pre-existing active-rows-only scope. Idempotent.
   */
  async revokeAllSessions(args: RevokeAllSessionsArgs): Promise<void> {
    await this.sessions.revokeAll({
      userId: args.userId,
      extraJti: { jti: args.currentJti, expiresAt: args.currentAccessExp },
    });
  }
}
