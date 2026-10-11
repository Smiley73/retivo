/**
 * Self-service snapshot restore.
 *
 * `POST /api/v1/sync/restore` resets a household's durable sync state to
 * a chosen S3 snapshot so the user can undo bad edits, accidental
 * deletes, or a demo-loader overwrite. The flow:
 *
 *   1. Fetch the chosen snapshot (strict — 404 SNAPSHOT_NOT_FOUND if the
 *      id is unknown / belongs to another household).
 *   2. Sweep ALL household sync rows via the shared, audited
 *      `HouseholdSweepService` (the third authorised consumer of that
 *      BatchWriteItem sweep, alongside `DELETE /auth/account` and the
 *      encrypted-workspace reset — see AGENTS.md, "Project-specific
 *      security").
 *   3. MINT A FRESH snapshot object (current timestamp) from the chosen
 *      snapshot's contents, via `SnapshotsService.write`. The restore
 *      then points `WorkspaceMeta` at this FRESH key rather than the
 *      chosen (possibly old, low-ranked) one — so the daily janitor's
 *      newest-N retention always protects the live pointer. Pointing at
 *      an old chosen key let the janitor delete the very object the
 *      workspace pointed at (rank > MIN_KEEP + age > MIN_AGE_DAYS) →
 *      next bootstrap `NoSuchKey` → empty workspace.
 *   4. Repopulate `AggregateVersion` rows from the snapshot so the first
 *      post-restore push asserts the correct version (no spurious
 *      CONFLICT).
 *   5. Reinitialize `WorkspaceMeta` pointing at the FRESH snapshot — LAST
 *      (the pointer flip comes last), so the next
 *      `GET /sync/bootstrap` serves it and the hourly compactor treats it
 *      as the new baseline (its `queryAllSince(> cursor)` returns empty →
 *      no-op → it cannot re-apply rolled-up mutations and undo the
 *      restore) only once every `AggregateVersion` row already exists. A
 *      crash before this step leaves `WorkspaceMeta` ABSENT (step 2 already
 *      deleted it) rather than pointing at a fresh snapshot whose
 *      aggregates lack version rows — the pre-reorder crash mode wedged
 *      every push with a permanent `NOT_FOUND` until a human re-ran the
 *      restore; the reorder shifts it to a transient empty view that a
 *      re-run safely converges. Logged (never silently swallowed) as
 *      `RestoreReseedIncomplete` — see {@link restore}.
 *
 * Ordering: the chosen snapshot is fetched (step 1) BEFORE the sweep so a
 * missing/cross-household id 404s without touching durable state; the
 * fresh snapshot is minted AFTER the sweep (step 3) so a mid-restore
 * failure cannot strand a fresh object while old sync rows still
 * reference the prior state.
 *
 * Idempotent in the CORRECTNESS sense for the WINNING caller: step 2 is
 * delete-on-empty, with its `WorkspaceMeta` delete run FIRST and FENCED on
 * the `restoreEpoch` read just before it (an older restore that
 * resumes after a newer one completed fails there, before touching any
 * other row, instead of erasing the newer row and its epoch); step 4
 * (`AggregateVersion` reseed) is an unconditional PutItem per row; step 5
 * (`WorkspaceMeta` flip) is a CONDITIONAL PutItem that rejects any
 * epoch-bearing row — after this caller's own fenced delete, one can only be
 * a newer restore/clear's commit. A losing call throws
 * {@link RestoreEpochLostError} at either step rather than silently
 * reporting success for a pointer it did not write (a same-cutoff compactor
 * pass or a concurrent restore could otherwise repoint `WorkspaceMeta` back
 * to stale state with no cursor-visible signal). A retry that DOES win after
 * a partial failure re-sweeps (no-op), MINTS ANOTHER fresh key, and repoints —
 * so the flow is NOT byte-idempotent (each retry leaves a superseded fresh
 * copy), but the final pointer is always a valid recent snapshot. The
 * superseded copies are themselves recent, so the janitor keeps them under
 * newest-N and only ages them out later.
 *
 * The user's session is intentionally NOT revoked — they are actively
 * restoring and stay signed in. The sweep also clears DeviceRegistry
 * rows; with a preserved session the row stays absent until next login,
 * verified benign because no `apps/api/src/sync` code reads DeviceRegistry
 * on push or bootstrap (it is audit-only).
 */
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

/**
 * One-second bump (ms) added to the max live cursor's KSUID timestamp to derive
 * its STRICT successor. A next-second KSUID sorts above ANY same-second KSUID
 * regardless of payload, so the watermark is provably greater than every live
 * device cursor.
 */
const KSUID_SUCCESSOR_MS = 1000;
/**
 * KSUID payload width (bytes). The successor uses a zero-filled payload — the
 * lowest possible payload in its (bumped) second, which still sorts strictly
 * above the max cursor because the timestamp is one second higher.
 */
const KSUID_PAYLOAD_BYTES = 16;

/** Outcome of a workspace clear / erase-history retry. */
export interface ClearWorkspaceResult {
  /**
   * True only when erase-history was requested AND the S3 backup-history
   * purge succeeded. A purge failure (or eraseHistory not requested) reports
   * `false`; the workspace is still fully cleared.
   */
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

    // Restore epoch: read the CURRENT epoch BEFORE the sweep deletes
    // the row, so the pointer-flip-last write below can pin a monotonic
    // epoch the compactor's cursor-advance condition also checks. A cursor
    // comparison alone can't detect a same-cutoff restore (the ordinary case
    // for restoring the MOST RECENT snapshot) — only a value that changes on
    // every restore can. Strongly consistent (`findConsistent`, not `find`):
    // GetItem is eventually consistent by default, so a plain read here could
    // observe the row as it stood before a just-completed restore, mint the
    // SAME next epoch, and let this restore silently undo that one.
    const observedEpoch = (await this.workspaceMeta.findConsistent(householdId))
      ?.restoreEpoch;

    // Full sweep of household sync state (shared audited path). Its
    // WorkspaceMeta delete is the capturing one, so the daily push-quota
    // state comes back exactly as it stood when the row went away —
    // a restore is
    // household-triggerable and must not grant a fresh budget, and a
    // separate pre-sweep read (eventually consistent, and racing an
    // in-flight push's charge) could carry a stale count forward. The
    // WorkspaceMeta delete itself runs FIRST and fenced on `observedEpoch`: a
    // row already carrying a newer epoch is a restore/clear that completed
    // after the read above, and an unfenced delete would erase it — epoch
    // included — so the pointer flip below would pass as a fresh write and
    // silently undo it. The fence throws RestoreEpochLostError instead,
    // before any other row is touched.
    const { priorWorkspaceMeta } = await this.sweep.sweepHouseholdData(householdId, {
      restoreEpochFence: { observedEpoch },
    });

    // Mint a FRESH snapshot (current timestamp) from the chosen
    // snapshot's contents and point WorkspaceMeta at IT — never at the
    // chosen (possibly old, janitor-deletable) key. The daily janitor
    // keeps the newest N snapshots by key-timestamp rank, so a freshly
    // minted key is always protected; pointing at an old chosen key let
    // the janitor delete the live pointer. Minted AFTER the
    // sweep so a failure here doesn't strand a fresh object over old
    // sync rows. A retry re-sweeps + mints ANOTHER fresh key (not
    // byte-idempotent, but the final pointer is always valid + recent).
    const freshSnapshotId = await this.snapshots.write(householdId, snapshot);

    // Reseed AggregateVersion BEFORE the
    // WorkspaceMeta pointer flip — the flip below is the LAST step. Retired aggregate types are skipped — they cannot be
    // pushed again and have no live IndexedDB store, so a version row for
    // them is dead weight. A throw here leaves WorkspaceMeta absent (step 2
    // already deleted it) rather than pointing at a fresh snapshot whose
    // aggregates lack version rows, so it is logged as
    // `RestoreReseedIncomplete` (best-effort — never silently swallowed;
    // the caller still sees the error) rather than a CloudWatch alarm: the
    // failure is crash-blind (an OOM/timeout/hard-kill runs no catch) and
    // self-heals on the next restore attempt.
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

    // Re-point WorkspaceMeta at the FRESH snapshot — the LAST pointer-
    // relevant step. `cutoff` is the MutationLog sequenceId the snapshot was
    // compacted up to; '0' for older snapshots that predate the field — both
    // are valid cursors. A conditional-write loss here (RestoreEpochLostError)
    // means a NEWER restore/clear already committed while this one was
    // running — it propagates as an error rather than a false `{ ok: true }`,
    // since the AggregateVersion rows just reseeded above belong to a
    // different snapshot than the pointer that actually won.
    await this.workspaceMeta.reinitializeForRestore(
      householdId,
      freshSnapshotId,
      snapshot.cutoff ?? '0',
      observedEpoch,
    );

    // Merge the sweep-captured daily push-quota counters back onto the
    // re-pointed row (atomic `ADD`, so a charge from a push that was already
    // in flight during the sweep survives alongside them). Pointer-neutral,
    // hence after the flip.
    await this.workspaceMeta.carryQuotaForward(householdId, priorWorkspaceMeta);

    return { ok: true };
  }

  /**
   * Server-authoritative "Delete workspace data" clear.
   * Reuses the restore recipe with an
   * EMPTY aggregate set:
   *   1. Derive a convergence watermark strictly greater than every live
   *      device cursor — BEFORE the sweep, which deletes the cursor
   *      sources. See {@link computeConvergenceWatermark}.
   *   2. Sweep ALL household sync rows via the shared, audited
   *      `HouseholdSweepService` (the FOURTH authorised consumer of that
   *      BatchWriteItem sweep — see AGENTS.md, "Project-specific security").
   *   3. Mint a FRESH empty snapshot (no aggregates) carrying the watermark
   *      as its cutoff.
   *   4. Repoint `WorkspaceMeta` at it with `mutationLogCursorBase =
   *      watermark`, so every OTHER household device (incl. a spouse's, which
   *      per-user session revocation can't reach) hits `CURSOR_EXPIRED` on its
   *      next pull → `applyBootstrap(true)` → empty.
   *   5. If `eraseHistory`, purge all prior S3 snapshots LAST, keeping the
   *      just-minted empty snapshot (keep-key). The clear ALWAYS commits
   *      regardless of the purge outcome; a purge failure returns
   *      `historyErased:false` (the old backups age out on the janitor
   *      schedule and stay restorable via Restore until then).
   *
   * Ordering: the S3 purge runs LAST — the inverse of delete-account's
   * purge-first order — so `WorkspaceMeta` never points at a deleted
   * snapshot. A clear leaves the workspace live, so a purge-then-partial-
   * sweep would strand the live pointer on a deleted object.
   *
   * The user's session is intentionally NOT revoked (they keep working); the
   * watermark bump (not session revocation) is what converges other devices.
   */
  async clearToEmpty(
    householdId: string,
    opts: { eraseHistory: boolean },
  ): Promise<ClearWorkspaceResult> {
    const { watermark, observedEpoch } =
      await this.computeConvergenceWatermark(householdId);

    // The sweep's WorkspaceMeta delete captures the daily push-quota state
    // as it stood when the row went away — a workspace clear is household-triggerable and must not
    // grant a fresh daily budget. Not read from `computeConvergenceWatermark`'s
    // pre-sweep `find`: that read is eventually consistent and races an
    // in-flight push's charge. Fenced on the epoch read alongside the
    // watermark — see restore().
    const { priorWorkspaceMeta } = await this.sweep.sweepHouseholdData(householdId, {
      restoreEpochFence: { observedEpoch },
    });

    const snapshotId = await this.snapshots.write(householdId, {
      aggregates: [],
      cutoff: watermark,
    });

    // See restore()'s equivalent call for the restore-epoch contract:
    // a lost race throws RestoreEpochLostError rather than a false success.
    await this.workspaceMeta.reinitializeForRestore(
      householdId,
      snapshotId,
      watermark,
      observedEpoch,
    );

    // Merge the captured counters back (atomic `ADD` — see `restore`).
    await this.workspaceMeta.carryQuotaForward(householdId, priorWorkspaceMeta);

    if (!opts.eraseHistory) {
      return { historyErased: false };
    }
    return {
      historyErased: await this.purgeExceptLiveSnapshot(householdId, snapshotId),
    };
  }

  /**
   * Erase-history RETRY: purge every prior snapshot EXCEPT the
   * current live `WorkspaceMeta` snapshot, WITHOUT sweeping / minting /
   * repointing. The reload after a `historyErased:false` clear lands on a
   * live, usable workspace (session kept, Base recreated), so re-running the
   * FULL clear would sweep any data the user entered after the reload — an
   * irreversible loss on an affordance that only promises to erase backups.
   * Purge-only also avoids re-bumping the watermark, so it doesn't needlessly
   * re-fire `CURSOR_EXPIRED` on other devices.
   */
  async purgeHistory(householdId: string): Promise<ClearWorkspaceResult> {
    const meta = await this.workspaceMeta.find(householdId);
    const liveSnapshotId = meta?.latestSnapshotId ?? null;
    if (!liveSnapshotId) {
      // No live snapshot pointer to protect against, so there is nothing safe to purge — this retry
      // did NOT erase any backups (privacy truthfulness). Previously reported `historyErased: true`
      // here despite deleting nothing, a false claim on the one affordance whose entire promise is
      // that the backups are gone.
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

  /**
   * Purge every household snapshot EXCEPT the one keyed `snapshotId` (the
   * live `WorkspaceMeta` pointer). Returns whether the purge succeeded; an S3
   * failure is caught and reported as `false` so the clear / retry ALWAYS
   * completes. Never throws.
   */
  private async purgeExceptLiveSnapshot(
    householdId: string,
    snapshotId: string,
  ): Promise<boolean> {
    // Build the keep-key through SnapshotsService's single key builder so the
    // preserved key is guaranteed to match the format `SnapshotsService.write`
    // just minted the live snapshot with — a drifted inline format would purge
    // the very object WorkspaceMeta was just repointed at.
    const keepKey = this.snapshots.keyFor(householdId, snapshotId);
    try {
      await this.snapshotPurge.purge(householdId, { keepKeys: [keepKey] });
      return true;
    } catch (err) {
      // Purge-last: the clear is already committed. A purge failure
      // leaves the prior snapshots to age out on the janitor schedule and
      // keeps the clear undoable via Restore until then. No PII in the log.
      this.logger.warn(
        `Workspace clear: snapshot history purge failed for household ${householdId} (clear already committed)`,
        err instanceof Error ? err.stack : String(err),
      );
      return false;
    }
  }

  /**
   * A cursor provably greater than every live device cursor. Live
   * cursors are NOT enumerable server-side (`DeviceRegistry.syncCursor` is
   * never written — devices hold their cursor in local IndexedDB), so we
   * upper-bound them: every device cursor is a real `MutationLog` sequenceId
   * that either still lives in the log (≤ head) or was compacted (≤
   * `WorkspaceMeta`'s snapshot cursor / `mutationLogCursorBase`), so
   * `max(head, meta cursors)` bounds them all. We return its STRICT
   * successor — never the bare max, which a fully-synced device holds exactly
   * (`PullService` expires only when `since < watermark`, so equality would
   * never expire). The successor is the next-second KSUID
   * (`timestamp + 1s`, zero payload), which sorts above ANY same-second KSUID
   * regardless of payload. An empty household (no cursors) gets a fresh clock
   * KSUID; take the later of the two so the watermark also carries a
   * current-ish timestamp, keeping post-clear pushes cleanly above it.
   *
   * Also returns `observedEpoch`: the `restoreEpoch` read off this
   * SAME `WorkspaceMeta` row, BEFORE the sweep deletes it, so `clearToEmpty`
   * doesn't need a second round trip to pin the epoch its pointer-flip write
   * checks — see `WorkspaceMetaRepository.reinitializeForRestore`.
   */
  private async computeConvergenceWatermark(
    householdId: string,
  ): Promise<{ watermark: string; observedEpoch: number | undefined }> {
    const candidates: string[] = [];
    const head = await this.mutationLog.maxSequenceId(householdId);
    if (head) candidates.push(head);
    // Strongly consistent (same rationale as `restore()`): this epoch
    // gates `clearToEmpty`'s pointer-flip-last write the same way, so it is
    // just as exposed to a stale eventually-consistent GetItem.
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
      // A non-KSUID sentinel (e.g. a legacy '0' cursor) is lexically below
      // any real KSUID, so the fresh clock KSUID already dominates it.
      return { watermark: fresh, observedEpoch };
    }
    // `bumped` is strictly greater than every live cursor; the fresh KSUID
    // may be higher still (later wall clock) — either choice stays > max.
    return { watermark: bumped > fresh ? bumped : fresh, observedEpoch };
  }
}
