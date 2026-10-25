// Sync push pipeline: each mutation is its own TransactWriteItems (conditional AggregateVersion Put, append-only
// MutationLog Put, conditional IdempotencyKey Put), followed by a best-effort WorkspaceMeta bump.
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { PushResponseBody } from '@retirement/contracts';
import KSUID from 'ksuid';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { IdempotencyKeyRepository } from '../dynamo/idempotency-key.repository.js';
import { WorkspaceMetaRepository } from '../dynamo/workspace-meta.repository.js';
import { isStrictEncryptedEnvelope } from '../common/encrypted-envelope.js';
import type {
  AggregateVersionRow,
  AppliedMutationResult,
  IdempotencyKeyRow,
  MutationLogRow,
  RejectedMutationResult,
} from '../dynamo/types.js';
import type { PushMutationDto } from './dto/push.dto.js';

const MAX_PAYLOAD_BYTES = 64 * 1024;

/** Daily push quota in mutations per household, sized above the demo loader burst; rolls over at the UTC day boundary. */
export const MAX_DAILY_MUTATIONS = 10_000;
export const MAX_DAILY_BYTES = 50 * 1024 * 1024;

/**
 * Largest freshness-counter step a push may take over the stored value (the client advances by 1 per attempt).
 * A larger jump is forged and fails the push, the one freshness-head fault that does.
 */
export const FRESHNESS_COUNTER_MAX_STEP = 1000;

// A re-appended stranded row is minted one second above the cursor KSUID timestamp, so it sorts strictly above the cursor
// whatever its payload. A fresh KSUID.random() carries the current second and could sort below a same-second or future cursor.
const KSUID_STRAND_SUCCESSOR_MS = 1000;

interface PushArgs {
  householdId: string;
  deviceId: string;
  mutations: PushMutationDto[];
  /** Opaque to the server, which never verifies the MAC; the encryption guard rejects a push without it. */
  freshnessHead?: { freshnessCounter: number; cursorTag: string };
}

type CancelTarget = 'aggregate' | 'log' | 'idempotency' | 'unknown';

type ApplyOutcome =
  | { kind: 'committed'; applied: AppliedMutationResult; sequenceId: string }
  | { kind: 'replayed-applied'; applied: AppliedMutationResult }
  | { kind: 'rejected'; outcome: RejectedMutationResult };

// `bytes` is measured once in preflight and reused by the daily byte quota; a `cached` replay writes nothing and is free.
type PreflightItem =
  | { type: 'cached'; result: AppliedMutationResult | RejectedMutationResult }
  | { type: 'pending'; idemKey: string; mutation: PushMutationDto; bytes: number }
  | {
      type: 'stale-rejection';
      idemKey: string;
      mutation: PushMutationDto;
      cachedExpectedVersion: number | undefined;
      bytes: number;
    };

interface CommittedRow {
  mutation: PushMutationDto;
  newVersion: number;
  sequenceId: string;
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly mutationLogTable: string;
  private readonly aggregateVersionTable: string;
  private readonly idempotencyKeyTable: string;

  constructor(
    @Inject(DYNAMO_DOC_CLIENT) private readonly doc: DynamoDBDocumentClient,
    private readonly idem: IdempotencyKeyRepository,
    private readonly meta: WorkspaceMetaRepository,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.mutationLogTable = config.get('TABLE_MUTATION_LOG', { infer: true });
    this.aggregateVersionTable = config.get('TABLE_AGGREGATE_VERSION', { infer: true });
    this.idempotencyKeyTable = config.get('TABLE_IDEMPOTENCY_KEY', { infer: true });
  }

  async push(args: PushArgs): Promise<PushResponseBody> {
    // Classify every mutation before any write, so a mixed batch 403s with nothing persisted, createIfMissing included.
    const preflight = await this.preflightBatch(args);

    const applied: AppliedMutationResult[] = [];
    const rejected: RejectedMutationResult[] = [];
    const committedRows: CommittedRow[] = [];
    let lastSequenceId = '';

    // Reached only when the whole batch survived preflight. The counter bound and quota check below reuse this row.
    const meta = await this.meta.createIfMissing(args.householdId);

    if (args.freshnessHead) {
      this.enforceFreshnessCounterBound(args.freshnessHead.freshnessCounter, meta);
    }

    // Charge what this request will write (pending and stale-rejection items): replays are free and a retried batch never double-charges.
    let quotaMutations = 0;
    let quotaBytes = 0;
    for (const item of preflight) {
      if (item.type === 'cached') continue;
      quotaMutations += 1;
      quotaBytes += item.bytes;
    }
    if (quotaMutations > 0) {
      const charge = await this.meta.chargeDailyQuota(
        args.householdId,
        quotaMutations,
        quotaBytes,
        MAX_DAILY_MUTATIONS,
        MAX_DAILY_BYTES,
      );
      if (!charge.ok) {
        this.logger.warn({
          'metric.kind': 'push_quota_exceeded',
          householdId: args.householdId,
          budget: charge.exceeded,
          msg: 'Push quota exceeded',
        });
        throw new HttpException(
          {
            code: 'PUSH_QUOTA_EXCEEDED',
            message: `Daily push ${charge.exceeded} budget exceeded for this household; try again after the next UTC day boundary.`,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    for (const item of preflight) {
      if (item.type === 'cached') {
        if (item.result.status === 'applied') applied.push(item.result);
        else rejected.push(item.result);
        continue;
      }

      const result =
        item.type === 'stale-rejection'
          ? await this.reevaluateStaleRejection(
              args.householdId,
              item.idemKey,
              item.mutation,
              item.cachedExpectedVersion,
            )
          : await this.applyOne(args.householdId, item.idemKey, item.mutation);
      if (result.kind === 'committed') {
        applied.push(result.applied);
        // A replay wrote nothing to MutationLog, so it must not move lastSequenceId.
        lastSequenceId = result.sequenceId;
        committedRows.push({
          mutation: item.mutation,
          newVersion: result.applied.newVersion,
          sequenceId: result.sequenceId,
        });
      } else if (result.kind === 'replayed-applied') {
        applied.push(result.applied);
      } else {
        rejected.push(result.outcome);
      }
    }

    if (lastSequenceId) {
      const maxVersion = applied.reduce((m, a) => Math.max(m, a.newVersion), 0);
      if (maxVersion > 0) {
        await this.meta.bumpVersionIfHigher(args.householdId, maxVersion);
      }
      // Post-commit and best-effort: a throw must never turn an acknowledged write into a 5xx.
      await this.reappendStrandedRows(args.householdId, committedRows).catch(
        (err) => {
          this.logger.warn(
            `Post-commit strand re-append failed for household ${args.householdId}: ${
              err instanceof Error ? err.message : 'unknown'
            }`,
          );
        },
      );
    }

    // Non-atomic with acceptance and never fails the push; echo the stored head so the client pins it, not its proposal.
    let freshnessHead: PushResponseBody['freshnessHead'];
    if (args.freshnessHead) {
      const stored = await this.meta.bumpFreshnessHead(
        args.householdId,
        args.deviceId,
        args.freshnessHead.freshnessCounter,
        args.freshnessHead.cursorTag,
      );
      freshnessHead = stored
        ? { freshnessCounter: stored.storedCounter, cursorTag: stored.storedTag }
        : null;
    }

    return {
      applied,
      rejected,
      syncCursor: lastSequenceId || (await this.currentCursor(args.householdId)),
      ...(freshnessHead !== undefined ? { freshnessHead } : {}),
    };
  }

  private async preflightBatch(args: PushArgs): Promise<PreflightItem[]> {
    const items: PreflightItem[] = [];
    for (const mutation of args.mutations) {
      const bytes = enforcePayloadSize(mutation);

      const idemKey = IdempotencyKeyRepository.composeKey(
        args.householdId,
        args.deviceId,
        mutation.id,
      );
      const cached = await this.idem.lookup(idemKey);
      if (cached) {
        // A rejection cached at the same version is a true duplicate; at another version (or a legacy row without one) the client rebased
        // and retried, so it is tagged stale-rejection and the apply pass clears the occupied key before re-evaluating.
        const isTrustworthyReplay =
          cached.response.status === 'applied' ||
          cached.expectedVersion === mutation.version;
        if (isTrustworthyReplay) {
          items.push({ type: 'cached', result: cached.response });
          continue;
        }
        this.enforceEncryptionForMutation(args, mutation);
        items.push({
          type: 'stale-rejection',
          idemKey,
          mutation,
          cachedExpectedVersion: cached.expectedVersion,
          bytes,
        });
        continue;
      }

      // Unconditional encryption guard, after the lookup so a retry of a committed mutation replays its cached response.
      this.enforceEncryptionForMutation(args, mutation);

      items.push({ type: 'pending', idemKey, mutation, bytes });
    }
    return items;
  }

  private enforceEncryptionForMutation(args: PushArgs, m: PushMutationDto): void {
    if (!args.freshnessHead) {
      throw new ForbiddenException({
        code: 'ENCRYPTION_REQUIRED',
        message:
          'Every push must include a freshnessHead; plaintext or missing-head pushes are not accepted.',
      });
    }
    if (!isStrictEncryptedEnvelope(m.payload)) {
      throw new ForbiddenException({
        code: 'ENCRYPTION_REQUIRED',
        message:
          'Every mutation payload must be a strict encrypted envelope; plaintext payloads are not accepted.',
        details: { mutationId: m.id, aggregateId: m.aggregateId },
      });
    }
  }

  // A forged counter far above the stored one would make every honest device read as a rollback forever. A household with no
  // stored counter (new, or just restored: reinitializeForRestore omits the freshness fields) accepts any well-formed counter.
  private enforceFreshnessCounterBound(
    counter: number,
    meta: { freshnessCounter?: number },
  ): void {
    const stored = meta.freshnessCounter;
    if (stored === undefined) return;
    if (counter > stored + FRESHNESS_COUNTER_MAX_STEP) {
      throw new BadRequestException({
        code: 'FRESHNESS_COUNTER_TOO_FAR_AHEAD',
        message: `freshnessHead.freshnessCounter (${counter}) is more than ${FRESHNESS_COUNTER_MAX_STEP} above the stored value (${stored}).`,
      });
    }
  }

  private async applyOne(
    householdId: string,
    idemKey: string,
    m: PushMutationDto,
  ): Promise<ApplyOutcome> {
    const sequenceId = (await KSUID.random()).string;
    const newVersion = m.version + 1;
    const newUpdatedAt = new Date().toISOString();
    const appliedResult: AppliedMutationResult = {
      status: 'applied',
      mutationId: m.id,
      aggregateId: m.aggregateId,
      newVersion,
      newUpdatedAt,
    };
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: this.buildApplyItems(
            householdId,
            idemKey,
            m,
            sequenceId,
            newVersion,
            newUpdatedAt,
            appliedResult,
          ),
        }),
      );
      return {
        kind: 'committed',
        applied: { ...appliedResult, sequenceId },
        sequenceId,
      };
    } catch (err) {
      if (err instanceof TransactionCanceledException) {
        return this.handleCancel(err, householdId, idemKey, m);
      }
      throw err;
    }
  }

  private buildApplyItems(
    householdId: string,
    idemKey: string,
    m: PushMutationDto,
    sequenceId: string,
    newVersion: number,
    newUpdatedAt: string,
    appliedResult: AppliedMutationResult,
  ): NonNullable<TransactWriteCommand['input']['TransactItems']> {
    const aggregateVersionRow: AggregateVersionRow = {
      householdId,
      aggregateId: m.aggregateId,
      aggregateType: m.aggregateType,
      version: newVersion,
      updatedAt: newUpdatedAt,
      deletedAt: m.operation === 'delete' ? newUpdatedAt : null,
    };
    const logRow = this.buildLogRow(householdId, m, sequenceId, newVersion);
    const idemRow = IdempotencyKeyRepository.rowFor(idemKey, appliedResult);
    return [
      this.aggregateConditionalPut(m, aggregateVersionRow),
      { Put: { TableName: this.mutationLogTable, Item: logRow } },
      {
        // A duplicate that slipped past the lookup cancels the transaction so the replay path returns the cached response.
        Put: {
          TableName: this.idempotencyKeyTable,
          Item: idemRow,
          ConditionExpression: 'attribute_not_exists(#k)',
          ExpressionAttributeNames: { '#k': 'key' },
        },
      },
    ];
  }

  private buildLogRow(
    householdId: string,
    m: PushMutationDto,
    sequenceId: string,
    newVersion: number,
  ): MutationLogRow {
    return {
      householdId,
      sequenceId,
      deviceId: m.deviceId,
      aggregateId: m.aggregateId,
      aggregateType: m.aggregateType,
      operation: m.operation,
      payload: JSON.stringify(m.payload),
      version: newVersion,
      timestamp: m.timestamp,
      schemaVersion: m.schemaVersion,
    };
  }

  // Re-appends rows committed at or below an already-taken compaction cutoff, which pull (strictly above the cursor) would never return.
  private async reappendStrandedRows(
    householdId: string,
    committed: CommittedRow[],
  ): Promise<void> {
    if (committed.length === 0) return;
    const meta = await this.meta.find(householdId);
    const cursor = meta?.latestSnapshotCursor;
    if (!cursor) return;
    const stranded = committed.filter((r) => r.sequenceId <= cursor);
    if (stranded.length === 0) return;
    let dominatingTs: number;
    try {
      dominatingTs =
        KSUID.parse(cursor).date.getTime() + KSUID_STRAND_SUCCESSOR_MS;
    } catch {
      // A legacy '0' cursor sorts below every real KSUID, so nothing can be stranded.
      return;
    }
    for (const row of stranded) {
      const dominatingSeq = KSUID.fromParts(
        dominatingTs,
        KSUID.parse(row.sequenceId).payload,
      ).string;
      await this.doc.send(
        new PutCommand({
          TableName: this.mutationLogTable,
          Item: this.buildLogRow(
            householdId,
            row.mutation,
            dominatingSeq,
            row.newVersion,
          ),
        }),
      );
    }
  }

  private aggregateConditionalPut(
    m: PushMutationDto,
    row: AggregateVersionRow,
  ): { Put: NonNullable<TransactWriteCommand['input']['TransactItems']>[number]['Put'] } {
    if (m.operation === 'create') {
      return {
        Put: {
          TableName: this.aggregateVersionTable,
          Item: row,
          ConditionExpression: 'attribute_not_exists(aggregateId)',
        },
      };
    }
    return {
      Put: {
        TableName: this.aggregateVersionTable,
        Item: row,
        ConditionExpression:
          'attribute_exists(aggregateId) AND version = :expected',
        ExpressionAttributeValues: { ':expected': m.version },
      },
    };
  }

  // attribute_type(deletedAt, 'S'), not attribute_exists: a live row stores deletedAt as an explicit NULL, which attribute_exists
  // also matches, so only the type check proves a tombstone.
  private tombstoneRevivalPut(
    row: AggregateVersionRow,
    tombstoneVersion: number,
  ): { Put: NonNullable<TransactWriteCommand['input']['TransactItems']>[number]['Put'] } {
    return {
      Put: {
        TableName: this.aggregateVersionTable,
        Item: row,
        ConditionExpression:
          'attribute_exists(aggregateId) AND attribute_type(deletedAt, :deletedAtType) AND version = :tombstoneVersion',
        ExpressionAttributeValues: {
          ':deletedAtType': 'S',
          ':tombstoneVersion': tombstoneVersion,
        },
      },
    };
  }

  private async handleCancel(
    err: TransactionCanceledException,
    householdId: string,
    idemKey: string,
    m: PushMutationDto,
  ): Promise<ApplyOutcome> {
    const target = classifyTransactCancel(err);
    if (target === 'idempotency') {
      const replayed = await this.replayIdempotencyRow(householdId, idemKey, m);
      if (replayed) return replayed;
      // Cache row missing despite the cancel naming it: fall through to the conflict path.
      return this.buildConflictOutcome(householdId, idemKey, m);
    }
    if (target === 'unknown') {
      // A transient cancel (TransactionConflict, throttling) is rethrown so the client retries; a fabricated CONFLICT would be
      // cached for 7 days and permanently reject a valid mutation.
      throw err;
    }
    if (target === 'aggregate' && m.operation === 'create') {
      // A create over a tombstone revives it; a live row falls through to the conflict below.
      const revived = await this.tryRecreateOverTombstone(householdId, idemKey, m);
      if (revived) return revived;
    }
    return this.buildConflictOutcome(householdId, idemKey, m);
  }

  // Replays an applied or true-duplicate rejection; a rejection cached at another version is deleted and re-applied.
  private async replayIdempotencyRow(
    householdId: string,
    idemKey: string,
    m: PushMutationDto,
  ): Promise<ApplyOutcome | null> {
    const cached = await this.idem.lookup(idemKey);
    if (!cached) return null;
    const r = cached.response;
    if (r.status === 'applied') {
      // Race loser: reuse the winner's cached response; nothing was written to MutationLog, so the caller skips cursor advancement.
      return { kind: 'replayed-applied', applied: r };
    }
    if (cached.expectedVersion === m.version) {
      return { kind: 'rejected', outcome: r };
    }
    const deleted = await this.idem.delete(idemKey, cached.expectedVersion);
    if (!deleted) {
      // Changed underneath: replay whatever occupies the key now.
      const now = await this.idem.lookup(idemKey);
      if (!now) return null;
      return now.response.status === 'applied'
        ? { kind: 'replayed-applied', applied: now.response }
        : { kind: 'rejected', outcome: now.response };
    }
    return this.applyOne(householdId, idemKey, m);
  }

  // An empty key after a failed delete means a racer is mid-rewrite; applyOne's idempotency-conflict handling reconciles it.
  private async reevaluateStaleRejection(
    householdId: string,
    idemKey: string,
    m: PushMutationDto,
    cachedExpectedVersion: number | undefined,
  ): Promise<ApplyOutcome> {
    const deleted = await this.idem.delete(idemKey, cachedExpectedVersion);
    if (!deleted) {
      const now = await this.idem.lookup(idemKey);
      if (now) {
        return now.response.status === 'applied'
          ? { kind: 'replayed-applied', applied: now.response }
          : { kind: 'rejected', outcome: now.response };
      }
    }
    return this.applyOne(householdId, idemKey, m);
  }

  private async buildConflictOutcome(
    householdId: string,
    idemKey: string,
    m: PushMutationDto,
  ): Promise<{ kind: 'rejected'; outcome: RejectedMutationResult }> {
    const cur = await this.fetchCurrentVersion(householdId, m.aggregateId);
    const reason: RejectedMutationResult['reason'] =
      cur === null && (m.operation === 'update' || m.operation === 'delete')
        ? 'NOT_FOUND'
        : 'CONFLICT';
    const outcome: RejectedMutationResult = {
      status: 'rejected',
      mutationId: m.id,
      aggregateId: m.aggregateId,
      reason,
      currentVersion: cur?.version ?? 0,
      currentUpdatedAt: cur?.updatedAt ?? '',
      // Lets the client auto-repair tell recreating over its own tombstone from colliding with a live remote row.
      currentDeletedAt: cur?.deletedAt ?? null,
    };
    // First writer wins the cache row (attribute_not_exists); a collision means a valid row already landed. expectedVersion tells a
    // true duplicate from a rebased retry.
    const idemRow: IdempotencyKeyRow = IdempotencyKeyRepository.rowFor(
      idemKey,
      outcome,
      m.version,
    );
    await this.doc
      .send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.idempotencyKeyTable,
                Item: idemRow,
                ConditionExpression: 'attribute_not_exists(#k)',
                ExpressionAttributeNames: { '#k': 'key' },
              },
            },
          ],
        }),
      )
      .catch(() => {
      });
    return { kind: 'rejected', outcome };
  }

  // Re-runs the full three-item transaction with only the AggregateVersion condition swapped to the exact tombstone version;
  // a bare Put would drop the MutationLog append and the IdempotencyKey write.
  private async tryRecreateOverTombstone(
    householdId: string,
    idemKey: string,
    m: PushMutationDto,
  ): Promise<ApplyOutcome | null> {
    const cur = await this.fetchCurrentVersion(householdId, m.aggregateId);
    if (!cur || cur.deletedAt === null) return null; // live row — genuine CONFLICT
    const tombstoneVersion = cur.version;
    const newVersion = tombstoneVersion + 1;
    const newUpdatedAt = new Date().toISOString();
    const sequenceId = (await KSUID.random()).string;
    const appliedResult: AppliedMutationResult = {
      status: 'applied',
      mutationId: m.id,
      aggregateId: m.aggregateId,
      newVersion,
      newUpdatedAt,
      recreatedOverTombstone: true,
    };
    const aggregateVersionRow: AggregateVersionRow = {
      householdId,
      aggregateId: m.aggregateId,
      aggregateType: m.aggregateType,
      version: newVersion,
      updatedAt: newUpdatedAt,
      deletedAt: null,
    };
    const logRow = this.buildLogRow(householdId, m, sequenceId, newVersion);
    const idemRow = IdempotencyKeyRepository.rowFor(idemKey, appliedResult);
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            this.tombstoneRevivalPut(aggregateVersionRow, tombstoneVersion),
            { Put: { TableName: this.mutationLogTable, Item: logRow } },
            {
              Put: {
                TableName: this.idempotencyKeyTable,
                Item: idemRow,
                ConditionExpression: 'attribute_not_exists(#k)',
                ExpressionAttributeNames: { '#k': 'key' },
              },
            },
          ],
        }),
      );
      return {
        kind: 'committed',
        applied: { ...appliedResult, sequenceId },
        sequenceId,
      };
    } catch (err) {
      if (err instanceof TransactionCanceledException) {
        return this.handleCancel(err, householdId, idemKey, m);
      }
      throw err;
    }
  }

  private async fetchCurrentVersion(
    householdId: string,
    aggregateId: string,
  ): Promise<{ version: number; updatedAt: string; deletedAt: string | null } | null> {
    const r = await this.doc.send(
      new GetCommand({
        TableName: this.aggregateVersionTable,
        Key: { householdId, aggregateId },
      }),
    );
    if (!r.Item) return null;
    const row = r.Item as AggregateVersionRow;
    return { version: row.version, updatedAt: row.updatedAt, deletedAt: row.deletedAt ?? null };
  }

  private async currentCursor(householdId: string): Promise<string> {
    const meta = await this.meta.find(householdId);
    return meta?.mutationLogCursorBase ?? '0';
  }
}

function payloadBytes(m: PushMutationDto): number {
  return Buffer.byteLength(JSON.stringify(m.payload), 'utf8');
}

function enforcePayloadSize(m: PushMutationDto): number {
  const bytes = payloadBytes(m);
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new PayloadTooLargeException({
      code: 'MUTATION_PAYLOAD_TOO_LARGE',
      message: `Mutation payload exceeds 64 KB (got ${bytes} bytes).`,
      details: { mutationId: m.id, aggregateId: m.aggregateId },
    });
  }
  return bytes;
}

// Index order mirrors buildApplyItems: 0 aggregate version, 1 mutation log, 2 idempotency key.
function classifyTransactCancel(
  err: TransactionCanceledException,
): CancelTarget {
  const reasons = err.CancellationReasons ?? [];
  const isFail = (i: number): boolean =>
    reasons[i]?.Code === 'ConditionalCheckFailed';
  if (isFail(2)) return 'idempotency';
  if (isFail(0)) return 'aggregate';
  if (isFail(1)) return 'log';
  return 'unknown';
}

// re-export for the controller's request-shaping
export type { AppliedMutationResult, RejectedMutationResult };
