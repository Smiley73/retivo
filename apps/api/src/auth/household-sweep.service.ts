// Shared household-data sweep (MutationLog, IdempotencyKey, AggregateVersion, WorkspaceMeta, DeviceRegistry) and session revocation.
// Authorised consumers: see AGENTS.md, "Project-specific security". Key-envelope rows are not part of it.
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
   * The WorkspaceMeta row as the sweep deleted it (`ALL_OLD`; null if none), so it reflects every push-quota charge
   * committed before. Household-triggerable consumers merge its counters back via `carryQuotaForward`; account
   * deletion ignores it.
   */
  priorWorkspaceMeta: WorkspaceMetaRow | null;
}

export interface SweepHouseholdDataOptions {
  /**
   * Restore and clear only: fences the WorkspaceMeta delete on the `restoreEpoch` the caller observed, running it
   * first and conditionally; it throws RestoreEpochLostError before any other row is touched when a newer restore
   * completed since. Unfenced, an older sweep would erase that row and its pointer flip would silently undo a
   * completed operation. `observedEpoch: undefined` is a real observation, hence the wrapper object.
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
   * Hard-deletes every household-scoped sync row; idempotent after a partial failure. The WorkspaceMeta step is the
   * single capturing delete (`ReturnValues: ALL_OLD`), so a consumer carrying the push quota forward has no
   * read-then-delete window for an in-flight charge to vanish into. With a `restoreEpochFence` it moves to the front
   * and becomes conditional (see `SweepHouseholdDataOptions`).
   */
  async sweepHouseholdData(
    householdId: string,
    opts: SweepHouseholdDataOptions = {},
  ): Promise<SweepHouseholdDataResult> {
    const fence = opts.restoreEpochFence;
    // The fenced WorkspaceMeta delete runs first: the epoch check must precede the other deletes, or a losing
    // restore would already have destroyed the winner reseeded rows.
    const priorWorkspaceMeta = fence
      ? await this.workspaceMeta.deleteForRestore(householdId, fence.observedEpoch)
      : null;
    await this.mutationLog.deleteAllForHousehold(householdId);
    await this.idempotencyKeys.deleteAllForHousehold(householdId);
    await this.aggregateVersions.deleteAllForHousehold(householdId);
    // Already deleted by the fence; an unconditional re-delete would erase a newer restore row committed during the
    // sweep.
    const capturedWorkspaceMeta = fence
      ? priorWorkspaceMeta
      : await this.workspaceMeta.deleteReturningPrior(householdId);
    await this.deviceRegistry.deleteAllForHousehold(householdId);
    return { priorWorkspaceMeta: capturedWorkspaceMeta };
  }

  /**
   * Revokes every session for the user via `SessionRevocationService`, denylisting access jtis from all refresh rows.
   * Idempotent.
   */
  async revokeAllSessions(args: RevokeAllSessionsArgs): Promise<void> {
    await this.sessions.revokeAll({
      userId: args.userId,
      extraJti: { jti: args.currentJti, expiresAt: args.currentAccessExp },
    });
  }
}
