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

/** UTC day stamp (`YYYY-MM-DD`), the daily push-quota reset boundary. */
export function utcDayStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export type QuotaChargeResult =
  | { ok: true }
  | { ok: false; exceeded: 'mutations' | 'bytes' };

/**
 * Thrown by `deleteForRestore` and `reinitializeForRestore` when a newer restore or clear already committed (its
 * `restoreEpoch` won). The caller must surface an error, since its reseed belongs to a different snapshot than the
 * winning pointer.
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
   * Strongly consistent `find`. A restore reading `restoreEpoch` through the default eventually consistent read could
   * see the row from before a just-completed restore and mint the same next epoch, letting the second restore
   * silently undo the first. Every epoch read that gates a restore or clear must use this.
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
   * Never carries daily push-quota state: the conditional Put defers to any existing row, so a quota trio passed here
   * would be silently discarded. A sweep that preserves the budget recreates the bare row with this and merges the
   * counters back with `carryQuotaForward`.
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
      // Already exists; this method is idempotent.
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
    });
    // Strongly consistent: an eventually consistent read right after the Put could miss `freshnessCounter`, and
    // `enforceFreshnessCounterBound` would then treat that stale absence as trust-on-first-use and accept an
    // out-of-range counter.
    const existing = await this.consistentFind(householdId);
    return existing ?? row;
  }

  /**
   * Bumps `latestVersion` if the candidate exceeds the stored value; a conditional update, safe to call concurrently.
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
   * Best-effort monotonic bump of the freshness head: writes `freshnessCounter` and `cursorTag` only if the incoming
   * counter exceeds the stored one, and returns the resulting stored values so the client pins the acknowledged head,
   * not its optimistic proposal. Never throws: a lower counter is a no-op, and a failed update falls back to reading
   * the stored head; only if both fail does it return null, so the client keeps its pin (no false rollback).
   * Non-atomic with mutation acceptance, so it must never fail the push.
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
      // A conditional failure means the stored counter is at least the proposed one; any other error is best-effort
      // too. Both re-read so the caller echoes the stored head.
      try {
        const existing = await this.find(householdId);
        if (existing?.freshnessCounter !== undefined) {
          return {
            storedCounter: existing.freshnessCounter,
            storedTag: existing.cursorTag ?? '',
          };
        }
        // Null, not a fabricated empty head: an empty tag can never pass the client MAC check, so echoing one would
        // show a successful push as a false rollback.
        return null;
      } catch {
        return null;
      }
    }
  }

  // The epoch a restore or clear that observed `observedEpoch` commits under; an absent epoch counts as 0.
  private static nextRestoreEpoch(observedEpoch: number | undefined): number {
    return (observedEpoch ?? 0) + 1;
  }

  /**
   * Epoch-fenced WorkspaceMeta delete, the first step of a restore or clear sweep. Deletes only while the row is
   * absent, carries no epoch, or carries one at or below `observedEpoch`; a newer epoch is a completed restore
   * that an unconditional delete would erase, so it throws RestoreEpochLostError before any other row is touched.
   * Also the sweep capturing delete: returns the row as it existed (`ALL_OLD`) like `deleteReturningPrior`.
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
   * Rewrites a household WorkspaceMeta after the sweep deleted it, pointing at the restored snapshot in one atomic
   * step. An UpdateItem, not a Put: an in-flight push can recreate the row with a quota charge between the sweep and
   * this write, and a Put would clobber it. It SETs the pointer fields, REMOVEs the freshness head (the client clears
   * its pin on restore, so the next push re-pins), and leaves the quota trio for `carryQuotaForward`.
   *
   * The write is conditional on `restoreEpoch`, bumped past `observedEpoch`, since a cursor comparison cannot detect
   * a same-cutoff restore racing the compactor. The condition accepts only "absent, or epoch absent", not "epoch
   * below mine": a restore starting in the gap mints epoch 1 again, so a numeric comparison would let an older caller
   * overwrite a completed newer one. A failure throws RestoreEpochLostError.
   *
   * `mutationLogCursorBase = cutoff`: devices with an older cursor get CURSOR_EXPIRED and re-bootstrap; a device with
   * a newer cursor keeps its stale local state until it re-bootstraps (accepted single-device v1 limitation).
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
   * Deletes the row and returns it as it existed (`ALL_OLD`): the sweep own WorkspaceMeta step, so restore, workspace
   * clear and workspace reset capture the daily quota with no gap in which an in-flight `chargeDailyQuota` is
   * dropped. A read followed by a separate delete would lose a charge landing between them; a charge after this call
   * recreates the row and `carryQuotaForward` merges it. Deleting an absent row returns null.
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
   * Merges a quota trio captured by `deleteReturningPrior` back onto the recreated row after a sweep, so the
   * household cannot reset its budget. An atomic ADD composes with a push in flight during the sweep: no concurrent
   * charge lays the counters down verbatim, a concurrent charge is folded on top, and a stale captured `quotaDay`
   * fails the condition and is dropped, as the day roll-over would have done. Nothing captured is a no-op.
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
      // The row already carries a newer day counters; dropping the captured ones matches the next push day roll-over.
    }
  }

  /**
   * Atomically charges one push batch mutation count and bytes against the household daily budget, rolling the UTC
   * day first. One write per request. Unlike `bumpFreshnessHead` this is not best-effort: a write whose outcome
   * cannot be confirmed refuses the batch (`exceeded: 'mutations'`). A batch exceeding the budget alone is rejected
   * without a DynamoDB call.
   *
   * Up to three conditional UpdateItems, none of which can lose an update: (1) ADD gated on "stored day is today or
   * absent" and room remaining, written as `stored <= max - batch` since conditions cannot do arithmetic; ADD is
   * atomic server-side, so concurrent pushes can overshoot by at most one in-flight batch, which is accepted. (2) On
   * failure, a consistent read tells a spent budget from a stale day, and a stale day is rolled over with a SET
   * guarded on it still being stale. (3) If that roll-over lost the race, one more same-day ADD.
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

    // Either the budget is spent or the stored day is stale; disambiguate with a strongly consistent read.
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

    // A concurrent push rolled the day over; retry the same-day ADD once more.
    try {
      await chargeSameDay('quotaDay = :today');
      return { ok: true };
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      // Could not confirm the charge landed: refuse rather than grant a free write.
      return { ok: false, exceeded: 'mutations' };
    }
  }

  // Strongly consistent read, for where a stale read could misclassify the quota outcome.
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
