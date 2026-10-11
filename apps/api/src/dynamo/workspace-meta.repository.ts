import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { BaseRepository } from './base.repository.js';
import type { WorkspaceMetaRow } from './types.js';

/** UTC day stamp (`YYYY-MM-DD`) — the daily push-quota's reset boundary.
 * Exported for tests. */
export function utcDayStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Outcome of {@link WorkspaceMetaRepository.chargeDailyQuota}. */
export type QuotaChargeResult =
  | { ok: true }
  | { ok: false; exceeded: 'mutations' | 'bytes' };

/**
 * Thrown by `deleteForRestore` / `reinitializeForRestore` when a newer
 * restore/clear already committed for this household (its `restoreEpoch`
 * beat ours). The loser's `AggregateVersion` reseed belongs to a
 * different snapshot than the winning pointer, so the caller must surface
 * this as an error rather than report `{ ok: true }` for state it did not
 * write.
 */
export class RestoreEpochLostError extends Error {
  constructor(readonly householdId: string) {
    super(
      `Workspace restore lost the epoch race for household ${householdId}; a newer restore/clear already committed.`,
    );
  }
}


@Injectable()
export class WorkspaceMetaRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_WORKSPACE_META');
  }

  async find(householdId: string): Promise<WorkspaceMetaRow | null> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { householdId } }),
    );
    return (r.Item as WorkspaceMetaRow | undefined) ?? null;
  }

  /**
   * Strongly-consistent variant of {@link find} (stale-epoch race).
   * `GetItem` is eventually consistent by default — a restore that reads
   * `restoreEpoch` via the default `find` can observe the row as it stood
   * BEFORE a just-completed restore committed, obtain the same
   * `observedEpoch` that restore already consumed, and re-mint the same next
   * epoch: `reinitializeForRestore`'s conditional write then treats the two
   * restores as non-conflicting and lets the second silently repoint
   * `WorkspaceMeta` back to stale state — exactly the same-cutoff silent
   * undo the epoch exists to prevent. Every epoch read that gates a
   * restore/clear (`RestoreService.restore`, `computeConvergenceWatermark`)
   * must use this, not `find`.
   */
  async findConsistent(householdId: string): Promise<WorkspaceMetaRow | null> {
    const r = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { householdId },
        ConsistentRead: true,
      }),
    );
    return (r.Item as WorkspaceMetaRow | undefined) ?? null;
  }

  /**
   * Never carries daily push-quota state: the conditional Put below DEFERS to any row that already
   * exists, so a quota trio passed in here would be silently discarded
   * whenever a concurrent push had already recreated the row.
   * A household-triggerable operation that must preserve the
   * budget across a sweep recreates the bare row with this method and then
   * merges the captured counters back with {@link carryQuotaForward}.
   */
  async createIfMissing(householdId: string): Promise<WorkspaceMetaRow> {
    const row: WorkspaceMetaRow = {
      householdId,
      latestSnapshotId: null,
      latestSnapshotCursor: null,
      latestVersion: 0,
      lastUpdatedAt: new Date().toISOString(),
      mutationLogCursorBase: null,
    };
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: row,
        ConditionExpression: 'attribute_not_exists(householdId)',
      }),
    ).catch((err) => {
      // Already exists — that's fine; this method is idempotent.
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
    });
    // Strongly consistent: an eventually consistent
    // GetItem immediately after the conditional Put above can return the
    // PRE-Put row on a concurrent second call — e.g. a second push landing
    // right after the first stored `freshnessCounter: 1` could read back a
    // row with no `freshnessCounter` at all, and `enforceFreshnessCounterBound`
    // would then treat that stale absence as legitimate trust-on-first-use,
    // accepting a wildly out-of-range counter.
    const existing = await this.consistentFind(householdId);
    return existing ?? row;
  }

  /**
   * Bump the workspace's `latestVersion` if the supplied version exceeds
   * what's stored. Idempotent — safe to call concurrently with other
   * pushes since we use a conditional update.
   */
  async bumpVersionIfHigher(householdId: string, candidate: number): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { householdId },
        UpdateExpression: 'SET latestVersion = :v, lastUpdatedAt = :now',
        ConditionExpression: 'attribute_exists(householdId) AND latestVersion < :v',
        ExpressionAttributeValues: { ':v': candidate, ':now': new Date().toISOString() },
      }),
    ).catch((err) => {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
    });
  }

  /**
   * Best-effort monotonic bump of the household's freshness head.
   *
   * Writes `freshnessCounter` + `cursorTag` ONLY IF the incoming counter
   * strictly exceeds the stored value (or no value is stored yet). Returns
   * the **resulting stored** values so the caller can echo them to the
   * client, which pins the server-acknowledged head (not its optimistic
   * proposal — closing the false-rollback path: a failed write echoes the
   * old head, the client pins the old counter, the next push retries).
   *
   * NEVER throws: a lower-or-equal counter is a no-op, and every transient error is swallowed. This
   * is explicitly non-atomic with mutation acceptance — it must never fail the push. On any
   * non-conditional `UpdateItem` failure it falls back to a `GetItem` read of the stored head so
   * the caller can still echo the server-acknowledged value; only if BOTH the update and the read
   * fail does it return `null` (the caller then echoes nothing and the client keeps its existing
   * pin — no false rollback). The server stores both opaquely and never computes or verifies the
   * MAC (it holds no HDK).
   */
  async bumpFreshnessHead(
    householdId: string,
    _deviceId: string,
    freshnessCounter: number,
    cursorTag: string,
  ): Promise<{ storedCounter: number; storedTag: string } | null> {
    try {
      const r = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { householdId },
          UpdateExpression:
            'SET freshnessCounter = :c, cursorTag = :t, lastUpdatedAt = :now',
          ConditionExpression:
            'attribute_exists(householdId) AND (attribute_not_exists(freshnessCounter) OR freshnessCounter < :c)',
          ExpressionAttributeValues: {
            ':c': freshnessCounter,
            ':t': cursorTag,
            ':now': new Date().toISOString(),
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      const row = r.Attributes as WorkspaceMetaRow | undefined;
      return {
        storedCounter: row?.freshnessCounter ?? freshnessCounter,
        storedTag: row?.cursorTag ?? cursorTag,
      };
    } catch {
      // Conditional failure → the stored counter is >= the proposed one;
      // this is a no-op, not an error. Any other error (transient DynamoDB
      // fault) is also best-effort: the head must never fail the push. In
      // both cases re-read so the caller echoes the already-stored head;
      // only when the read ALSO fails do we return null (the caller echoes
      // nothing and the client keeps its existing pin — no false rollback).
      try {
        const existing = await this.find(householdId);
        if (existing?.freshnessCounter !== undefined) {
          return {
            storedCounter: existing.freshnessCounter,
            storedTag: existing.cursorTag ?? '',
          };
        }
        // Conditional failure but no stored head readable. Return null, NOT
        // a fabricated `{ storedCounter: 0, storedTag: '' }`: an empty tag
        // can never pass the client's MAC verification, so echoing it would
        // surface a FALSE rollback to a successful push. Null tells the
        // caller to echo nothing → the client keeps its existing pin.
        return null;
      } catch {
        return null;
      }
    }
  }

  /**
   * The epoch a restore/clear that observed `observedEpoch` commits under:
   * one past it, with an absent epoch (a legacy row, a row never restored,
   * or a row deleted out from under the reader) counting as 0.
   */
  private static nextRestoreEpoch(observedEpoch: number | undefined): number {
    return (observedEpoch ?? 0) + 1;
  }

  /**
   * Epoch-fenced `WorkspaceMeta` delete — the FIRST step of a restore/clear
   * sweep (`HouseholdSweepService.sweepHouseholdData` with a
   * `restoreEpochFence`). Deletes the row only while it is absent,
   * carries no epoch (a legacy row, or a bootstrap/push `createIfMissing`
   * recreation), or still carries an epoch at or below the one the caller
   * observed before its sweep (`restoreEpoch < :myEpoch`, `myEpoch =
   * observed + 1`). A row carrying a NEWER epoch is a restore/clear that
   * started after this caller's read and has already committed: an
   * unconditional delete here would erase it, epoch included, and the
   * caller's later {@link reinitializeForRestore} would then pass
   * `attribute_not_exists(householdId)` as if nothing had happened — an
   * older restore silently undoing a newer, completed one. Throws
   * {@link RestoreEpochLostError} in that case, before any other household
   * row has been touched.
   *
   * Also the sweep's capturing delete for restore/clear: returns the row exactly as it existed at
   * the moment of deletion (`ReturnValues: 'ALL_OLD'`), same as {@link deleteReturningPrior}, so
   * the caller's later {@link carryQuotaForward} call sees every daily push-quota charge that
   * committed before the row went away.
   */
  async deleteForRestore(
    householdId: string,
    observedEpoch: number | undefined,
  ): Promise<WorkspaceMetaRow | null> {
    const myEpoch = WorkspaceMetaRepository.nextRestoreEpoch(observedEpoch);
    try {
      const r = await this.doc.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { householdId },
          ConditionExpression:
            'attribute_not_exists(householdId) OR attribute_not_exists(restoreEpoch) OR restoreEpoch < :myEpoch',
          ExpressionAttributeValues: { ':myEpoch': myEpoch },
          ReturnValues: 'ALL_OLD',
        }),
      );
      return (r.Attributes as WorkspaceMetaRow | undefined) ?? null;
    } catch (err) {
      if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') {
        throw new RestoreEpochLostError(householdId);
      }
      throw err;
    }
  }

  /**
   * Reinitialize a household's `WorkspaceMeta` after a snapshot restore.
   * Runs after the household-data sweep deleted the row, so it must
   * write the row back pointing at the restored snapshot in one atomic step
   * (a plain `createIfMissing` + update would let a concurrent bootstrap
   * race in with null state). It is an UpdateItem rather than a full-row Put: a push
   * already in flight when the sweep ran can recreate the row with a fresh
   * `chargeDailyQuota` charge between the sweep's delete and this write, and
   * a Put would clobber that charge. The update SETs every pointer field and
   * REMOVEs the freshness head, leaving the quota trio untouched for
   * {@link carryQuotaForward} to merge the captured counters into.
   *
   * **Conditional, not unconditional.** The write is guarded by
   * `restoreEpoch`, a monotonic counter bumped past `observedEpoch` (the
   * value the caller read from this row BEFORE its sweep — see
   * `RestoreService.restore` / `clearToEmpty`). A cursor comparison alone
   * cannot detect a same-cutoff restore racing the compactor (the ordinary
   * case for restoring the MOST RECENT snapshot, where the compactor's own
   * cursor-advance condition would otherwise still pass after this commits);
   * only a value that changes on EVERY restore can.
   *
   * The guard is two-step. The caller's sweep already ran
   * {@link deleteForRestore} as its FIRST step, fenced on `observedEpoch`, so
   * by the time this write runs the row is either still absent, or was
   * recreated epoch-less by a concurrent bootstrap/push `createIfMissing` in
   * the gap (legitimate — this restore must still win against it), or was
   * written by a NEWER restore/clear that completed in that gap. The
   * condition therefore accepts only "absent, or epoch absent" — NOT "epoch
   * strictly below mine": a restore/clear that starts in the gap observes
   * the row as absent and mints epoch 1 again, so a numeric comparison would
   * let an older caller holding a larger `myEpoch` overwrite that newer,
   * completed operation. A conditional failure means a NEWER restore/clear
   * already landed, so it throws {@link RestoreEpochLostError} rather than
   * silently reporting success for state it did not write — the caller's
   * `AggregateVersion` reseed belongs to a different snapshot than the
   * pointer that actually won.
   *
   * - `latestSnapshotId` / `latestSnapshotCursor` point at the restored
   *   snapshot so the next bootstrap serves it.
   * - `mutationLogCursorBase = cutoff` (the snapshot's compaction cutoff):
   *   any device whose pull cursor PREDATES the cutoff gets `CURSOR_EXPIRED`
   *   on its next pull and re-bootstraps onto the restored state. A device
   *   holding a cursor NEWER than the cutoff is NOT force-expired
   *   (`PullService` expires only when `since < watermark`) — it keeps its
   *   stale local state until it next re-bootstraps (e.g. on re-login). This
   *   is the accepted single-device v1 limitation; multi-device convergence
   *   after restore is the documented deferred v2 multi-device (CRDT) concern.
   * - `latestVersion: 0` is bumped correctly on the next push.
   * - The zero-knowledge freshness fields are intentionally REMOVEd:
   *   the client clears its persisted + in-memory pin on restore, so the
   *   server starts fresh and the next encrypted push re-pins TOFU.
   * - The daily push-quota trio (`quotaDay` / `dailyMutationCount` /
   *   `dailyByteCount`) is deliberately NOT touched here — the caller merges
   *   the sweep-captured counters back with {@link carryQuotaForward}.
   *
   * Idempotent in the winning case — a retry after a partial restore failure
   * (still the same, still-highest observed epoch) overwrites any partial
   * state with the same final row; a retry that lost the epoch race to
   * a newer restore now throws instead.
   */
  async reinitializeForRestore(
    householdId: string,
    snapshotId: string,
    cursor: string,
    observedEpoch: number | undefined,
  ): Promise<void> {
    const myEpoch = WorkspaceMetaRepository.nextRestoreEpoch(observedEpoch);
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { householdId },
          UpdateExpression:
            'SET latestSnapshotId = :snap, latestSnapshotCursor = :cursor, latestVersion = :zero, ' +
            'lastUpdatedAt = :now, mutationLogCursorBase = :cursor, restoreEpoch = :myEpoch ' +
            'REMOVE freshnessCounter, cursorTag',
          ConditionExpression:
            'attribute_not_exists(householdId) OR attribute_not_exists(restoreEpoch)',
          ExpressionAttributeValues: {
            ':snap': snapshotId,
            ':cursor': cursor,
            ':zero': 0,
            ':now': new Date().toISOString(),
            ':myEpoch': myEpoch,
          },
        }),
      );
    } catch (err) {
      if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') {
        throw new RestoreEpochLostError(householdId);
      }
      throw err;
    }
  }

  async delete(householdId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: { householdId } }),
    );
  }

  /**
   * Delete the row and return it exactly as it existed at the moment of
   * deletion (`ReturnValues: 'ALL_OLD'`). This is the shared household-data
   * sweep's OWN WorkspaceMeta step (`HouseholdSweepService.sweepHouseholdData`),
   * so every household-triggerable consumer of the sweep — restore, workspace
   * clear, encrypted-workspace reset — captures the daily push-quota state
   * with NO gap between "read the
   * quota" and "the row is gone" for a concurrent `chargeDailyQuota` to land
   * in unseen: a plain `find` (or even a strongly
   * consistent one) followed by a separate delete leaves a window in which an
   * in-flight push can charge the quota after the read but before the delete
   * and have that charge silently dropped, and a separate pre-sweep delete
   * leaves the sweep's second delete to erase a charge that recreated the row
   * in between. `DeleteItem` is atomic against the item, so any charge that
   * committed before this call is reflected in the returned attributes, and
   * any charge that lands after it recreates the row and is merged with the
   * captured counters by {@link carryQuotaForward}. Idempotent: deleting an
   * absent row returns `null`, same as `find` would.
   */
  async deleteReturningPrior(householdId: string): Promise<WorkspaceMetaRow | null> {
    const r = await this.doc.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { householdId },
        ReturnValues: 'ALL_OLD',
      }),
    );
    return (r.Attributes as WorkspaceMetaRow | undefined) ?? null;
  }

  /**
   * Merge a daily push-quota trio captured by {@link deleteReturningPrior}
   * back onto the household's row after a household-triggerable sweep
   * ("the budget is not resettable
   * by any operation the household itself can run"). Runs AFTER the row has
   * been recreated (`createIfMissing` / `reinitializeForRestore`), and is an
   * atomic `ADD` rather than a `SET` or a Put so it composes with a push that
   * was already in flight when the sweep ran:
   *
   *  - no concurrent charge → the recreated row has no quota trio, so `ADD`
   *    lays the captured counters down verbatim;
   *  - a concurrent charge recreated the row with today's fresh count before
   *    this ran → `ADD` folds the captured counters on top, so BOTH survive
   *    (a Put or a conditional-create would keep one and discard the other);
   *  - the captured `quotaDay` is stale (the UTC day rolled over between the
   *    capture and now, and a concurrent charge already stamped the new day)
   *    → the condition fails and the captured counters are dropped, exactly
   *    as `chargeDailyQuota`'s own day roll-over would have discarded them.
   *
   * Nothing captured (no row, or a row that never pushed) is a no-op.
   */
  async carryQuotaForward(
    householdId: string,
    prior: WorkspaceMetaRow | null,
  ): Promise<void> {
    if (!prior?.quotaDay) return;
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { householdId },
          UpdateExpression:
            'ADD dailyMutationCount :addM, dailyByteCount :addB SET quotaDay = :day, lastUpdatedAt = :now',
          ConditionExpression: 'attribute_not_exists(quotaDay) OR quotaDay = :day',
          ExpressionAttributeValues: {
            ':addM': prior.dailyMutationCount ?? 0,
            ':addB': prior.dailyByteCount ?? 0,
            ':day': prior.quotaDay,
            ':now': new Date().toISOString(),
          },
        }),
      );
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      // The row already carries a DIFFERENT (newer) day's counters — the
      // captured ones belong to a day that is over. Dropping them is the
      // same outcome the next push's day roll-over would have produced.
    }
  }

  /**
   * Atomically charge one push batch's mutation count + payload bytes
   * against the household's daily budget, rolling the UTC day over first if
   * needed (the
   * ingress half of "a household can write an unbounded amount per day").
   * One write per push REQUEST, never per mutation.
   *
   * Unlike {@link bumpFreshnessHead} this is NOT best-effort: a write whose
   * outcome cannot be confirmed refuses the batch (`exceeded: 'mutations'`)
   * rather than silently granting a free write.
   *
   * A batch whose OWN count or bytes alone exceed the budget can never be
   * satisfied regardless of stored state, so it is rejected without a
   * DynamoDB call.
   *
   * Otherwise this is up to three conditional `UpdateItem`s, none of which
   * can lose an update:
   *  1. Same-day-or-brand-new-row attempt: `ADD` the batch's counts, gated on
   *     "stored day is today or absent" AND room remaining. The room check is
   *     expressed as `stored <= max - batch` (a literal computed here) rather
   *     than `stored + batch <= max`, because DynamoDB condition expressions
   *     cannot do arithmetic on the stored attribute. `ADD` is server-side
   *     atomic against whatever the LATEST stored value is at write time, so
   *     concurrent callers that both pass the condition never clobber each
   *     other's counts — concurrent pushes can overshoot the budget by at
   *     most one in-flight batch (the room check is evaluated against a
   *     possibly-stale read), which is accepted; a lost update is not.
   *  2. Only on failure: a consistent read distinguishes "today's budget is
   *     spent" (same day, over room) from "the stored day is stale" (roll it
   *     over). A stale day is rolled over with a conditional `SET`, guarded
   *     on the day STILL being stale at write time so a concurrent
   *     roll-over from another in-flight push can never be clobbered.
   *  3. Only if step 2's roll-over lost that race: the day is now current
   *     (the racer set it), so one more same-day `ADD` attempt (step 1's
   *     condition) resolves it.
   */
  async chargeDailyQuota(
    householdId: string,
    addMutations: number,
    addBytes: number,
    maxMutations: number,
    maxBytes: number,
  ): Promise<QuotaChargeResult> {
    const today = utcDayStamp();
    const roomMutations = maxMutations - addMutations;
    const roomBytes = maxBytes - addBytes;
    if (roomMutations < 0) return { ok: false, exceeded: 'mutations' };
    if (roomBytes < 0) return { ok: false, exceeded: 'bytes' };

    const now = new Date().toISOString();
    const chargeSameDay = (dayCondition: string) =>
      this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { householdId },
          UpdateExpression:
            'ADD dailyMutationCount :addM, dailyByteCount :addB SET quotaDay = :today, lastUpdatedAt = :now',
          ConditionExpression:
            `(${dayCondition}) AND (attribute_not_exists(dailyMutationCount) OR dailyMutationCount <= :roomM) ` +
            'AND (attribute_not_exists(dailyByteCount) OR dailyByteCount <= :roomB)',
          ExpressionAttributeValues: {
            ':addM': addMutations,
            ':addB': addBytes,
            ':today': today,
            ':now': now,
            ':roomM': roomMutations,
            ':roomB': roomBytes,
          },
        }),
      );

    try {
      await chargeSameDay('attribute_not_exists(quotaDay) OR quotaDay = :today');
      return { ok: true };
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    }

    // Attempt 1 failed: either today's budget is already spent, or the
    // stored day is stale and needs rolling over. Disambiguate with a
    // strongly-consistent read — this write path never guesses.
    const current = await this.consistentFind(householdId);
    if (current?.quotaDay === today) {
      const spentMutations = current.dailyMutationCount ?? 0;
      return {
        ok: false,
        exceeded: spentMutations + addMutations > maxMutations ? 'mutations' : 'bytes',
      };
    }

    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { householdId },
          UpdateExpression:
            'SET quotaDay = :today, dailyMutationCount = :addM, dailyByteCount = :addB, lastUpdatedAt = :now',
          ConditionExpression: 'attribute_not_exists(quotaDay) OR quotaDay <> :today',
          ExpressionAttributeValues: {
            ':today': today,
            ':addM': addMutations,
            ':addB': addBytes,
            ':now': now,
          },
        }),
      );
      return { ok: true };
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    }

    // A concurrent push rolled the day over between our read and this
    // write — the day is now current, so retry the same-day ADD once more.
    try {
      await chargeSameDay('quotaDay = :today');
      return { ok: true };
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      // Exhausted every attempt without confirming the charge landed — refuse
      // rather than grant a free write.
      return { ok: false, exceeded: 'mutations' };
    }
  }

  /** Strongly-consistent read, used only where a stale eventually-consistent
   *  read could misclassify the quota outcome (see {@link chargeDailyQuota}). */
  private async consistentFind(householdId: string): Promise<WorkspaceMetaRow | null> {
    const r = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { householdId },
        ConsistentRead: true,
      }),
    );
    return (r.Item as WorkspaceMetaRow | undefined) ?? null;
  }
}
