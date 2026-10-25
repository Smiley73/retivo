// Self-service snapshot restore and workspace clear: sweep household sync rows, mint a fresh snapshot, reseed versions, flip the pointer last.
// The sweep is the shared audited path; see AGENTS.md, "Project-specific security".
import { Injectable, Logger } from '@nestjs/common';
import KSUID from 'ksuid';
import { AccountSnapshotPurgeService } from '../auth/account-snapshot-purge.service.js';
import { HouseholdSweepService } from '../auth/household-sweep.service.js';
import { AggregateVersionRepository } from '../dynamo/aggregate-version.repository.js';
import { MutationLogRepository } from '../dynamo/mutation-log.repository.js';
import { WorkspaceMetaRepository } from '../dynamo/workspace-meta.repository.js';
import type { AggregateVersionRow } from '../dynamo/types.js';
import { isActiveAggregateType } from './aggregate-types.js';
import { SnapshotsService } from './snapshots.service.js';

// One-second bump, as KSUID_STRAND_SUCCESSOR_MS in push.service.ts: the successor sorts above any same-second cursor.
const KSUID_SUCCESSOR_MS = 1000;
const KSUID_PAYLOAD_BYTES = 16;

/** Outcome of a workspace clear / erase-history retry. */
export interface ClearWorkspaceResult {
  /** True only when erase-history was requested and the S3 purge succeeded; the workspace is cleared either way. */
  historyErased: boolean;
}

@Injectable()
export class RestoreService {
  private readonly logger = new Logger(RestoreService.name);

  constructor(
    private readonly snapshots: SnapshotsService,
    private readonly sweep: HouseholdSweepService,
    private readonly workspaceMeta: WorkspaceMetaRepository,
    private readonly aggregateVersions: AggregateVersionRepository,
    private readonly mutationLog: MutationLogRepository,
    private readonly snapshotPurge: AccountSnapshotPurgeService,
  ) {}

  async restore(
    householdId: string,
    snapshotId: string,
  ): Promise<{ ok: true }> {
    const snapshot = await this.snapshots.fetchStrict(householdId, snapshotId);

    // Read the epoch before the sweep deletes the row. Strongly consistent: a stale read could mint the same
    // next epoch twice and let this restore silently undo a just-completed one.
    const observedEpoch = (await this.workspaceMeta.findConsistent(householdId))
      ?.restoreEpoch;

    // The sweep deletes WorkspaceMeta first, fenced on observedEpoch: a newer epoch means a restore committed since the
    // read, and the sweep throws RestoreEpochLostError rather than erase it. The delete also captures the daily
    // push-quota state so a restore cannot grant a fresh budget.
    const { priorWorkspaceMeta } = await this.sweep.sweepHouseholdData(householdId, {
      restoreEpochFence: { observedEpoch },
    });

    // Mint a fresh snapshot and point WorkspaceMeta at it, never at the chosen key: the janitor deletes old
    // snapshots by rank, so an old chosen key can vanish under the live pointer (NoSuchKey on next bootstrap).
    const freshSnapshotId = await this.snapshots.write(householdId, snapshot);

    // Reseed before the pointer flip, so a crash leaves WorkspaceMeta absent rather than pointing at aggregates without
    // version rows. Retired aggregate types are skipped. A failure is logged as RestoreReseedIncomplete, not alarmed:
    // a crash runs no catch anyway, and the next restore heals it.
    try {
      for (const a of snapshot.aggregates) {
        if (!isActiveAggregateType(a.aggregateType)) {
          this.logger.warn(
            `Restore: skipping AggregateVersion reseed for retired aggregateType=${a.aggregateType} (id=${a.id})`,
          );
          continue;
        }
        const row: AggregateVersionRow = {
          householdId,
          aggregateId: a.id,
          aggregateType: a.aggregateType,
          version: a.version,
          updatedAt: a.updatedAt,
          deletedAt: a.deletedAt ?? null,
        };
        await this.aggregateVersions.put(row);
      }
    } catch (err) {
      this.logger.warn(
        `RestoreReseedIncomplete: household ${householdId} threw before the WorkspaceMeta pointer flip — WorkspaceMeta stays absent (a transient empty view); re-running the restore converges it. ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      throw err;
    }

    // Pointer flip last, so bootstrap and the compactor only see a snapshot whose version rows all exist. A lost
    // conditional write means a newer restore committed and propagates as RestoreEpochLostError. `cutoff` is
    // '0' for snapshots that predate the field.
    await this.workspaceMeta.reinitializeForRestore(
      householdId,
      freshSnapshotId,
      snapshot.cutoff ?? '0',
      observedEpoch,
    );

    // Atomic ADD, so a charge from a push in flight during the sweep survives.
    await this.workspaceMeta.carryQuotaForward(householdId, priorWorkspaceMeta);

    return { ok: true };
  }

  /**
   * Server-authoritative "Delete workspace data": the restore recipe with an empty aggregate set, repointed with
   * a watermark above every device cursor so other devices hit CURSOR_EXPIRED and bootstrap empty. The S3 purge
   * runs last so WorkspaceMeta never points at a deleted snapshot; its failure does not undo the clear.
   */
  async clearToEmpty(
    householdId: string,
    opts: { eraseHistory: boolean },
  ): Promise<ClearWorkspaceResult> {
    const { watermark, observedEpoch } =
      await this.computeConvergenceWatermark(householdId);

    // Fenced on the epoch read alongside the watermark.
    const { priorWorkspaceMeta } = await this.sweep.sweepHouseholdData(householdId, {
      restoreEpochFence: { observedEpoch },
    });

    const snapshotId = await this.snapshots.write(householdId, {
      aggregates: [],
      cutoff: watermark,
    });

    await this.workspaceMeta.reinitializeForRestore(
      householdId,
      snapshotId,
      watermark,
      observedEpoch,
    );

    await this.workspaceMeta.carryQuotaForward(householdId, priorWorkspaceMeta);

    if (!opts.eraseHistory) {
      return { historyErased: false };
    }
    return {
      historyErased: await this.purgeExceptLiveSnapshot(householdId, snapshotId),
    };
  }

  /**
   * Erase-history retry: purges every snapshot except the live one without sweeping, minting or repointing, so
   * data entered after the reload survives and other devices are not re-expired.
   */
  async purgeHistory(householdId: string): Promise<ClearWorkspaceResult> {
    const meta = await this.workspaceMeta.find(householdId);
    const liveSnapshotId = meta?.latestSnapshotId ?? null;
    if (!liveSnapshotId) {
      // No live pointer means nothing is safe to purge; report historyErased false rather than claim the backups are gone.
      this.logger.warn(
        `Workspace clear purge-only retry: no live snapshot pointer for household ${householdId}; nothing purged`,
      );
      return { historyErased: false };
    }
    return {
      historyErased: await this.purgeExceptLiveSnapshot(
        householdId,
        liveSnapshotId,
      ),
    };
  }

  // Never throws: an S3 failure returns false so the clear or retry still completes.
  private async purgeExceptLiveSnapshot(
    householdId: string,
    snapshotId: string,
  ): Promise<boolean> {
    // Build the keep-key through SnapshotsService.keyFor so it matches the format write() just minted;
    // a drifted format would purge the live object.
    const keepKey = this.snapshots.keyFor(householdId, snapshotId);
    try {
      await this.snapshotPurge.purge(householdId, { keepKeys: [keepKey] });
      return true;
    } catch (err) {
      // Purge-last: the clear is already committed. A failure leaves old snapshots to age out and stay restorable. No PII in the log.
      this.logger.warn(
        `Workspace clear: snapshot history purge failed for household ${householdId} (clear already committed)`,
        err instanceof Error ? err.stack : String(err),
      );
      return false;
    }
  }

  // Live cursors are not enumerable (DeviceRegistry.syncCursor is never written), so bound them by
  // max(log head, WorkspaceMeta cursors) and return its strict successor: a fully synced device holds the bare max
  // and PullService expires only when since < watermark. Also returns the restoreEpoch read off the same row.
  private async computeConvergenceWatermark(
    householdId: string,
  ): Promise<{ watermark: string; observedEpoch: number | undefined }> {
    const candidates: string[] = [];
    const head = await this.mutationLog.maxSequenceId(householdId);
    if (head) candidates.push(head);
    // Strongly consistent, as in restore().
    const meta = await this.workspaceMeta.findConsistent(householdId);
    const observedEpoch = meta?.restoreEpoch;
    if (meta?.latestSnapshotCursor) candidates.push(meta.latestSnapshotCursor);
    if (meta?.mutationLogCursorBase) candidates.push(meta.mutationLogCursorBase);

    const fresh = (await KSUID.random()).string;
    if (candidates.length === 0) return { watermark: fresh, observedEpoch };

    const maxCursor = candidates.reduce((a, b) => (b > a ? b : a));
    let bumped: string;
    try {
      const parsed = KSUID.parse(maxCursor);
      bumped = KSUID.fromParts(
        parsed.date.getTime() + KSUID_SUCCESSOR_MS,
        Buffer.alloc(KSUID_PAYLOAD_BYTES),
      ).string;
    } catch {
      // A non-KSUID legacy cursor (e.g. '0') sorts below any real KSUID, so the fresh clock KSUID dominates it.
      return { watermark: fresh, observedEpoch };
    }
    return { watermark: bumped > fresh ? bumped : fresh, observedEpoch };
  }
}
