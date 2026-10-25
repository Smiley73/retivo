// Scheduled snapshot compactor (docs/architecture.md, "Background Lambdas"): replay MutationLog into a new S3 snapshot,
// advance the WorkspaceMeta cursor, then delete the covered rows. It runs with no access to any auth table.
import fs from 'node:fs';

import {
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { gunzipSync, gzipSync } from 'node:zlib';
import KSUID from 'ksuid';
import { DYNAMO_DOC_CLIENT, S3_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { isStrictEncryptedEnvelope } from '../common/encrypted-envelope.js';
import type {
  MutationLogRow,
  WorkspaceMetaRow,
} from '../dynamo/types.js';

interface SnapshotAggregate {
  id: string;
  householdId: string;
  schemaVersion: number;
  version: number;
  updatedAt: string;
  deletedAt?: string;
  deviceId: string;
  aggregateType: string;
  payload: Record<string, unknown>;
}

export interface CompactorRunSummary {
  householdsProcessed: number;
  householdsSkipped: number;
  totalMutationsCompacted: number;
  totalSnapshotBytes: number;
  durationMs: number;
  /**
   * Households whose compaction a safety budget bounded (a partial prefix or a true skip); unlike
   * `householdsSkipped`, ordinary no-ops are not counted.
   */
  budgetLimitedHouseholdIds: string[];
}

export interface CompactorHouseholdMetric {
  householdId: string;
  mutationsCompacted: number;
  snapshotBytes: number;
  durationMs: number;
  /** Set when a safety budget bounded this household to a prefix. */
  budgetLimited?: boolean;
}

// Compaction safety budgets: internal bounds, deliberately not stack config. A household just under all three byte
// caps could exceed the 1024 MB Lambda heap from JSON expansion alone, so they are single-digit MB. `maxMergedBytes`
// (8 MiB uncompressed) sits above the ~6.7 MiB uncompressed equivalent of the 5 MiB gzipped bootstrap ceiling
// (`MAX_RESPONSE_BYTES`; base64 ciphertext deflates only to ~0.75x): a merged-size refusal is permanent (merged only
// grows), so a lower cap would starve a servable household every hour. `CompactorService.budgets` is public and
// mutable so a test can trip a budget with a few rows; production never reassigns it.
interface CompactorBudgets {
  // Mutation-log page-read row cap per household; paging stops once any read budget trips.
  maxLogRows: number;
  maxLogBytes: number;
  // Decompressed baseline byte cap, enforced at `gunzipSync` via `maxOutputLength` rather than trusting the S3
  // compressed size.
  maxSnapshotBytes: number;
  // Serialized merged-snapshot byte cap, checked before gzip and the S3 write. At or above the bootstrap ceiling
  // equivalent, so anything bootstrap can serve is written; strictly below `maxSnapshotBytes`, because the read cap
  // covers the whole decompressed envelope while this estimate covers aggregates only, and a merge the read cap then
  // refuses is the same permanent skip.
  maxMergedBytes: number;
  householdDeadlineMs: number;
  runDeadlineMs: number;
  // Reserve subtracted from the run deadline so the summary log still writes before Lambda freezes. Must be at least
  // `householdDeadlineMs`: a household starting just before the run deadline may run that long.
  runDeadlineReserveMs: number;
}

const DEFAULT_COMPACTOR_BUDGETS: CompactorBudgets = {
  maxLogRows: 20_000,
  // Single-digit-MB class: JSON expansion of a household at these caps stays well under the 1024 MB heap; an
  // over-cap page compacts as a prefix and resumes next run.
  maxLogBytes: 8 * 1024 * 1024,
  // Above maxMergedBytes with headroom: the next run fetchSnapshot enforces this cap against the whole envelope,
  // not just the aggregates.
  maxSnapshotBytes: 12 * 1024 * 1024,
  // Above the ~6.7 MiB uncompressed equivalent of the bootstrap ceiling, so nothing bootstrap can serve is refused
  // (a permanent skip), and below maxSnapshotBytes.
  maxMergedBytes: 8 * 1024 * 1024,
  householdDeadlineMs: 90_000,
  runDeadlineMs: 270_000,
  // At least householdDeadlineMs plus slack for the call in flight when the deadline trips.
  runDeadlineReserveMs: 100_000,
};

// Thrown by `fetchSnapshot` when the decompressed baseline exceeds `maxSnapshotBytes`: a true skip, since no prefix
// work fixes it, unlike its other errors which take the fail-closed path.
class SnapshotOversizedError extends Error {
  constructor(householdId: string, snapshotId: string, maxBytes: number) {
    super(
      `Compactor: baseline snapshot for ${householdId}/${snapshotId} exceeds the ${maxBytes}-byte decompression cap`,
    );
  }
}

// Thrown by `compactHousehold` for a true skip forced by a safety budget; `runOnce` catches it to record the
// household and cause and continue.
class CompactorBudgetSkipError extends Error {
  constructor(
    readonly householdId: string,
    // The budget cause; named `budgetCause` to avoid colliding with `Error.prototype.cause`.
    readonly budgetCause: string,
  ) {
    super(`Compactor budget skip for household ${householdId}: ${budgetCause}`);
  }
}

// Outcome of the verify-then-delete sweep: rows inspected, covered rows deleted, and uncovered rows kept (a
// KSUID-disorder strand or a latent orphan); `kept > 0` drives the CompactorCoverageViolation metric.
interface CoverageSweepResult {
  verified: number;
  deleted: number;
  kept: number;
}

// Safety margin for the cutoff: KSUIDs are minted before the push transaction commits with 1-second precision, so an
// in-flight push can commit below rows that committed earlier. A row landing below the cutoff would be excluded from
// snapshots, pull and bootstrap forever. Rows older than the margin (above clock skew plus transaction latency)
// cannot have a lower-KSUID sibling still in flight, so every row at or above `now - margin` is excluded.
const COMPACTION_SAFETY_MARGIN_MS = 60_000;

@Injectable()
export class CompactorService {
  private readonly logger = new Logger(CompactorService.name);
  private readonly workspaceMetaTable: string;
  private readonly mutationLogTable: string;
  private readonly snapshotsBucket: string;
  // Deployment stack (`local` when unset); scopes the EMF namespace so a dev compaction event cannot trip a prod
  // alarm.
  private readonly stack: string;

  /** Compaction safety budgets; public and mutable so a test can trip one with a few rows. */
  budgets: CompactorBudgets = DEFAULT_COMPACTOR_BUDGETS;

  constructor(
    @Inject(DYNAMO_DOC_CLIENT) private readonly doc: DynamoDBDocumentClient,
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.workspaceMetaTable = config.get('TABLE_WORKSPACE_META', { infer: true });
    this.mutationLogTable = config.get('TABLE_MUTATION_LOG', { infer: true });
    this.snapshotsBucket = config.get('SNAPSHOTS_BUCKET', { infer: true });
    this.stack = config.get('STACK', { infer: true }) ?? 'local';
  }

  /**
   * @param remainingTimeMs The Lambda `getRemainingTimeInMillis()` at invocation, used to derive the run deadline;
   * local and test invocations fall back to `budgets.runDeadlineMs`.
   */
  async runOnce(remainingTimeMs?: number): Promise<CompactorRunSummary> {
    const runStart = Date.now();
    const households = await this.listHouseholdIds();
    // Start at a pseudo-random offset and wrap: a run deadline cutting the loop short would otherwise always starve
    // the same tail, since Scan order is stable. Rotation beats a persisted least-recently-compacted order, which
    // would cost an attribute and a write per household per run.
    const offset =
      households.length > 0 ? Math.floor(Math.random() * households.length) : 0;
    const rotated = households.slice(offset).concat(households.slice(0, offset));

    const runDeadlineAt =
      runStart +
      (remainingTimeMs ?? this.budgets.runDeadlineMs) -
      this.budgets.runDeadlineReserveMs;

    const summary: CompactorRunSummary = {
      householdsProcessed: 0,
      householdsSkipped: 0,
      totalMutationsCompacted: 0,
      totalSnapshotBytes: 0,
      durationMs: 0,
      budgetLimitedHouseholdIds: [],
    };
    for (const householdId of rotated) {
      // Run deadline: stop starting households so the summary log writes before Lambda freezes; the rest are picked
      // up by the rotation next run.
      if (Date.now() >= runDeadlineAt) break;
      try {
        const result = await this.compactHousehold(householdId);
        if (result === null) summary.householdsSkipped += 1;
        else {
          summary.householdsProcessed += 1;
          summary.totalMutationsCompacted += result.mutationsCompacted;
          summary.totalSnapshotBytes += result.snapshotBytes;
          if (result.budgetLimited) summary.budgetLimitedHouseholdIds.push(householdId);
        }
      } catch (err) {
        if (err instanceof CompactorBudgetSkipError) {
          // Already logged and metric-emitted: an intentional bounded skip, not a failure.
          summary.householdsSkipped += 1;
          summary.budgetLimitedHouseholdIds.push(householdId);
          continue;
        }
        this.logger.error(
          `Compactor failed for household ${householdId}: ${err instanceof Error ? err.message : 'unknown'}`,
        );
        summary.householdsSkipped += 1;
      }
    }
    summary.durationMs = Date.now() - runStart;
    this.logger.log({
      'metric.kind': 'compactor_run',
      ...summary,
      msg: 'Compactor run',
    });
    return summary;
  }

  /** Returns the per-household metric on success, or null when there is nothing to compact. */
  async compactHousehold(
    householdId: string,
  ): Promise<CompactorHouseholdMetric | null> {
    const start = Date.now();
    const meta = await this.fetchMeta(householdId);
    if (!meta) return null;

    const since = meta.latestSnapshotCursor ?? '0';
    const householdDeadlineAt = start + this.budgets.householdDeadlineMs;
    const { rows: allRecent, budgetTripped } = await this.queryAllSince(
      householdId,
      since,
      householdDeadlineAt,
    );
    if (allRecent.length === 0) return null;

    // Drop every row at or above the boundary KSUID (now - margin) so a racing in-flight push with a lower KSUID
    // cannot land below the cutoff.
    const boundary = KSUID.fromParts(
      Date.now() - COMPACTION_SAFETY_MARGIN_MS,
      Buffer.alloc(16),
    ).string;
    const recent = allRecent.filter((r) => r.sequenceId < boundary);
    if (recent.length === 0) {
      if (budgetTripped) {
        // A read or time budget cut the page short and nothing survived the margin: a true skip, not the ordinary no-op
        // below.
        this.emitBudgetLimitedMetric();
        this.logger.log({
          'metric.kind': 'compactor_budget',
          householdId,
          cause: 'read_budget_no_usable_rows',
          outcome: 'skip',
          msg: 'Compactor budget tripped with nothing usable below the COMPACTION_SAFETY_MARGIN_MS boundary; skipping this run',
        });
        throw new CompactorBudgetSkipError(householdId, 'read_budget_no_usable_rows');
      }
      // Nothing safely outside the margin yet; the next hourly run picks these rows up.
      return null;
    }

    const cutoff = recent[recent.length - 1].sequenceId;

    // Re-check the household deadline: `queryAllSince` only bounds the read phase, and none of fetch, merge, write
    // or delete is deadline-aware. Nothing has been written yet, so this is a clean true skip.
    if (Date.now() >= householdDeadlineAt) {
      this.emitBudgetLimitedMetric();
      this.logger.log({
        'metric.kind': 'compactor_budget',
        householdId,
        cause: 'household_deadline_before_write',
        outcome: 'skip',
        msg: 'Compactor budget: household deadline reached after the read; skipping the write/delete phases for this run',
      });
      throw new CompactorBudgetSkipError(householdId, 'household_deadline_before_write');
    }

    // An oversized baseline is a true skip: no prefix work fixes it, unlike a read-budget trip, which compacts what
    // it has.
    let baseline: SnapshotAggregate[];
    try {
      baseline = await this.fetchSnapshot(
        householdId,
        meta.latestSnapshotId,
        this.budgets.maxSnapshotBytes,
      );
    } catch (err) {
      if (err instanceof SnapshotOversizedError) {
        this.emitBudgetLimitedMetric();
        this.logger.log({
          'metric.kind': 'compactor_budget',
          householdId,
          cause: 'baseline_oversized',
          outcome: 'skip',
          msg: 'Compactor budget: baseline snapshot exceeds the decompression cap; skipping this run',
        });
        throw new CompactorBudgetSkipError(householdId, 'baseline_oversized');
      }
      throw err;
    }
    const merged = this.applyMutations(baseline, recent);

    // Estimate the merged size from its parts before one giant JSON.stringify, so an oversized merge is a true skip
    // that never materializes the full string. It under-counts the envelope boilerplate, which is negligible.
    let estimatedMergedBytes = 0;
    for (const a of merged) {
      estimatedMergedBytes += Buffer.byteLength(JSON.stringify(a), 'utf8');
    }
    if (estimatedMergedBytes > this.budgets.maxMergedBytes) {
      // Also a true skip: writing an over-cap snapshot would only move the problem into S3 and the next bootstrap read.
      this.emitBudgetLimitedMetric();
      this.logger.log({
        'metric.kind': 'compactor_budget',
        householdId,
        cause: 'merged_oversized',
        outcome: 'skip',
        msg: 'Compactor budget: merged snapshot exceeds the write cap; skipping this run',
      });
      throw new CompactorBudgetSkipError(householdId, 'merged_oversized');
    }

    // Re-check the household deadline: the S3 read, gunzip and merge are not deadline-aware, and a slow baseline
    // could otherwise carry this pass through the write and cursor flip with no budget left for the delete sweep.
    // Nothing has been written yet.
    if (Date.now() >= householdDeadlineAt) {
      this.emitBudgetLimitedMetric();
      this.logger.log({
        'metric.kind': 'compactor_budget',
        householdId,
        cause: 'household_deadline_before_upload',
        outcome: 'skip',
        msg: 'Compactor budget: household deadline reached after fetch/merge; skipping the write/delete phases for this run',
      });
      throw new CompactorBudgetSkipError(householdId, 'household_deadline_before_upload');
    }

    const newSnapshotId = new Date().toISOString().replace(/[:.]/g, '-');
    const body = JSON.stringify({
      householdId,
      generatedAt: new Date().toISOString(),
      cutoff,
      aggregates: merged,
    });
    const gzipped = gzipSync(Buffer.from(body, 'utf8'));
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.snapshotsBucket,
        Key: `${householdId}/${newSnapshotId}.json.gz`,
        Body: gzipped,
        ContentType: 'application/json',
        ContentEncoding: 'gzip',
      }),
    );

    // Advance the cursor atomically, aborting if another run moved it or the restore epoch observed at the top of the
    // pass changed: a restore bumps it before its sweep, so a same-cutoff restore mid-pass (cursor unchanged) still
    // aborts. An absent `restoreEpoch` is a distinct pinned state (legacy or never restored).
    const epochCondition =
      meta.restoreEpoch === undefined
        ? 'attribute_not_exists(restoreEpoch)'
        : 'restoreEpoch = :obsEpoch';
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.workspaceMetaTable,
          Key: { householdId },
          UpdateExpression:
            'SET latestSnapshotId = :sid, latestSnapshotCursor = :cur, ' +
            'mutationLogCursorBase = :cur, lastUpdatedAt = :now',
          ConditionExpression:
            '((attribute_not_exists(latestSnapshotCursor) AND :prev = :empty) OR ' +
            `latestSnapshotCursor = :prev) AND (${epochCondition})`,
          ExpressionAttributeValues: {
            ':sid': newSnapshotId,
            ':cur': cutoff,
            ':now': new Date().toISOString(),
            ':prev': meta.latestSnapshotCursor ?? null,
            ':empty': null,
            ...(meta.restoreEpoch !== undefined ? { ':obsEpoch': meta.restoreEpoch } : {}),
          },
        }),
      );
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'ConditionalCheckFailedException') {
        this.logger.warn(
          `Compactor lost cursor race for household ${householdId}; retry next hour.`,
        );
        return null;
      }
      throw err;
    }

    // Verify-then-delete: the coverage map is the max version durably reachable per aggregate in the snapshot just
    // written, and a row is deleted only when that covers its version, so an uncovered strand or orphan is kept. No
    // extra restore guard is needed: the snapshot could only be written because the cursor update already passed its
    // epoch-pinned condition.
    const coverageByAggregate = new Map(merged.map((a) => [a.id, a.version]));
    const sweep = await this.deleteUpToCutoff(
      householdId,
      cutoff,
      coverageByAggregate,
      householdDeadlineAt,
    );
    if (sweep.kept > 0) this.emitCoverageViolationMetric(sweep.kept);
    this.logger.log({
      'metric.kind': 'compactor_coverage',
      householdId,
      straysVerified: sweep.verified,
      straysDeleted: sweep.deleted,
      straysKept: sweep.kept,
      msg: 'Compactor coverage sweep',
    });

    const metric: CompactorHouseholdMetric = {
      householdId,
      mutationsCompacted: recent.length,
      snapshotBytes: gzipped.byteLength,
      durationMs: Date.now() - start,
      ...(budgetTripped ? { budgetLimited: true } : {}),
    };
    if (budgetTripped) {
      this.emitBudgetLimitedMetric();
      this.logger.log({
        'metric.kind': 'compactor_budget',
        householdId,
        cause: 'read_budget_prefix',
        outcome: 'prefix',
        prefixRows: recent.length,
        totalRowsRead: allRecent.length,
        msg: 'Compactor budget tripped mid-read; compacted a bounded prefix and will resume next run',
      });
    }
    this.logger.log({
      'metric.kind': 'compactor_household',
      ...metric,
      msg: 'Compactor household',
    });
    return metric;
  }

  private async fetchMeta(householdId: string): Promise<WorkspaceMetaRow | null> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.workspaceMetaTable, Key: { householdId } }),
    );
    return (r.Item as WorkspaceMetaRow | undefined) ?? null;
  }

  private async listHouseholdIds(): Promise<string[]> {
    // One key-only Scan page per few thousand households; the cost tracks that row count only. Revisit if the
    // enumeration needs more than a page or two (a per-active-household DynamoDB Streams trigger is the next step).
    const out: string[] = [];
    let key: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new ScanCommand({
          TableName: this.workspaceMetaTable,
          ProjectionExpression: 'householdId',
          ExclusiveStartKey: key,
        }),
      );
      for (const item of r.Items ?? []) {
        const id = (item as WorkspaceMetaRow).householdId;
        if (id) out.push(id);
      }
      key = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (key);
    return out;
  }

  // Pages MutationLog since `since`, stopping mid-page once the row count or payload-byte budget trips or the
  // household deadline passes. Trimming after a full read would defeat the purpose: the unbounded loop let one
  // oversized log OOM the process and starve every later household.
  private async queryAllSince(
    householdId: string,
    since: string,
    householdDeadlineAt: number,
  ): Promise<{ rows: MutationLogRow[]; budgetTripped: boolean }> {
    const out: MutationLogRow[] = [];
    let bytes = 0;
    let lastKey: Record<string, unknown> | undefined;
    const overBudget = (): boolean =>
      out.length >= this.budgets.maxLogRows ||
      bytes >= this.budgets.maxLogBytes ||
      Date.now() >= householdDeadlineAt;
    while (true) {
      if (overBudget()) return { rows: out, budgetTripped: true };
      const r = await this.doc.send(
        new QueryCommand({
          TableName: this.mutationLogTable,
          KeyConditionExpression: 'householdId = :h AND sequenceId > :s',
          ExpressionAttributeValues: { ':h': householdId, ':s': since },
          ExclusiveStartKey: lastKey,
        }),
      );
      for (const row of (r.Items as MutationLogRow[] | undefined) ?? []) {
        if (overBudget()) return { rows: out, budgetTripped: true };
        out.push(row);
        bytes += Buffer.byteLength(row.payload ?? '', 'utf8');
      }
      if (!r.LastEvaluatedKey) return { rows: out, budgetTripped: false };
      lastKey = r.LastEvaluatedKey as Record<string, unknown>;
    }
  }

  private async fetchSnapshot(
    householdId: string,
    snapshotId: string | null,
    maxDecompressedBytes: number,
  ): Promise<SnapshotAggregate[]> {
    if (!snapshotId) return [];
    try {
      const r = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.snapshotsBucket,
          Key: `${householdId}/${snapshotId}.json.gz`,
        }),
      );
      const arr = await (r.Body as { transformToByteArray: () => Promise<Uint8Array> })
        .transformToByteArray();
      const parsed = JSON.parse(
        gunzipSync(Buffer.from(arr), { maxOutputLength: maxDecompressedBytes }).toString(
          'utf8',
        ),
      ) as { aggregates: SnapshotAggregate[] };
      return parsed.aggregates ?? [];
    } catch (err) {
      // The decompressed baseline exceeds the safety cap: a true skip the caller decides on, so propagate a
      // distinguishable error rather than the fail-closed path.
      if ((err as { code?: string })?.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new SnapshotOversizedError(householdId, snapshotId, maxDecompressedBytes);
      }
      // Fail-closed read: only NoSuchKey is soft (the pointer can reference a key the janitor already swept; the next
      // compaction rewrites it). Any other error means the baseline is unreadable, not empty, and compacting against an
      // empty one would drop every aggregate it held. Log, emit a metric and rethrow so the per-household catch skips
      // this household.
      const name = (err as { name?: string })?.name;
      if (name === 'NoSuchKey') return [];
      this.logger.error({
        'metric.kind': 'compactor_snapshot_read_error',
        householdId,
        snapshotId,
        errorName: name ?? 'unknown',
        errorMessage: err instanceof Error ? err.message : 'unknown',
        errorStack: err instanceof Error ? err.stack : undefined,
        msg: 'Compactor snapshot read failed; skipping household',
      });
      this.emitSnapshotReadErrorMetric();
      throw err;
    }
  }

  // `householdId` stays in the structured log, not a metric dimension. The namespace is per-stack, so a dev event cannot
  // trip a prod alarm.
  private emitSnapshotReadErrorMetric(): void {
    const emf = {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: `Retivo/${this.stack}/Compactor`,
            Dimensions: [[]],
            Metrics: [{ Name: 'CompactorSnapshotReadError', Unit: 'Count' }],
          },
        ],
      },
      CompactorSnapshotReadError: 1,
    };
    this.writeEmfLine(emf, 'CompactorSnapshotReadError');
  }

  // The value is the count of uncovered rows kept this run. Alarmed in `infrastructure/src/monitoring.ts`.
  private emitCoverageViolationMetric(keptCount: number): void {
    const emf = {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: `Retivo/${this.stack}/Compactor`,
            Dimensions: [[]],
            Metrics: [{ Name: 'CompactorCoverageViolation', Unit: 'Count' }],
          },
        ],
      },
      CompactorCoverageViolation: keptCount,
    };
    this.writeEmfLine(emf, 'CompactorCoverageViolation');
  }

  // The cause stays in the `compactor_budget` log, so a household that repeatedly fails to drain shows whichever budget
  // tripped. Alarmed in `infrastructure/src/monitoring.ts`.
  private emitBudgetLimitedMetric(): void {
    const emf = {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: `Retivo/${this.stack}/Compactor`,
            Dimensions: [[]],
            Metrics: [{ Name: 'CompactorBudgetLimited', Unit: 'Count' }],
          },
        ],
      },
      CompactorBudgetLimited: 1,
    };
    this.writeEmfLine(emf, 'CompactorBudgetLimited');
  }

  // Writes one EMF line with a synchronous fd-1 write, not `process.stdout.write`: under Lambda freeze an async write
  // can sit unflushed and vanish. A failed write never aborts compaction.
  private writeEmfLine(emf: unknown, metricName: string): void {
    try {
      fs.writeSync(1, `${JSON.stringify(emf)}\n`);
    } catch {
      this.logger.warn(`compactor: failed to write ${metricName} metric line`);
    }
  }

  private applyMutations(
    baseline: SnapshotAggregate[],
    mutations: MutationLogRow[],
  ): SnapshotAggregate[] {
    const byId = new Map(baseline.map((a) => [a.id, a]));
    for (const m of mutations) {
      const payload = safeParse(m.payload);
      const existing = byId.get(m.aggregateId);
      const next: SnapshotAggregate = {
        id: m.aggregateId,
        householdId: m.householdId,
        schemaVersion: m.schemaVersion,
        version: m.version,
        updatedAt: new Date(m.timestamp).toISOString(),
        deviceId: m.deviceId,
        aggregateType: m.aggregateType,
        // An encrypted payload is a complete aggregate, not a patch: replace the snapshot payload, since spreading an
        // opaque envelope would blend old and new ciphertext fields. Legacy plaintext payloads keep the spread-merge.
        payload: isStrictEncryptedEnvelope(payload)
          ? payload
          : { ...(existing?.payload ?? {}), ...payload },
      };
      if (m.operation === 'delete') next.deletedAt = next.updatedAt;
      byId.set(m.aggregateId, next);
    }
    return [...byId.values()];
  }

  private async deleteUpToCutoff(
    householdId: string,
    cutoff: string,
    coverageByAggregate: Map<string, number>,
    householdDeadlineAt: number,
  ): Promise<CoverageSweepResult> {
    // Query every row with `sequenceId <= cutoff` (the folded rows and any stray a crash left after the cursor bump),
    // and delete only rows the snapshot covers: a KSUID-disorder strand or latent orphan was never read into any
    // snapshot, so it is kept, reported through the CompactorCoverageViolation metric and re-checked next run. The
    // projection includes `aggregateId` and `version` (aliased: a reserved word).
    let lastKey: Record<string, unknown> | undefined;
    let verified = 0;
    let deleted = 0;
    let kept = 0;
    do {
      // The cursor already advanced, so stopping early is safe: unverified covered rows stay and are re-verified next
      // run.
      if (Date.now() >= householdDeadlineAt) break;
      const page = await this.doc.send(
        new QueryCommand({
          TableName: this.mutationLogTable,
          KeyConditionExpression: 'householdId = :h AND sequenceId <= :c',
          ExpressionAttributeValues: { ':h': householdId, ':c': cutoff },
          ProjectionExpression: 'sequenceId, aggregateId, #v',
          ExpressionAttributeNames: { '#v': 'version' },
          ExclusiveStartKey: lastKey,
        }),
      );
      const items =
        (page.Items as
          | Array<{ sequenceId: string; aggregateId: string; version: number }>
          | undefined) ?? [];
      verified += items.length;
      const covered = items.filter((row) => {
        const snapshotVersion = coverageByAggregate.get(row.aggregateId);
        return snapshotVersion !== undefined && snapshotVersion >= row.version;
      });
      kept += items.length - covered.length;
      // Re-check the deadline between batches (a key-only page can carry thousands of rows). `deleted` counts per
      // batch actually sent, so a mid-page break never over-reports.
      let deadlineHit = false;
      for (let i = 0; i < covered.length; i += 25) {
        if (Date.now() >= householdDeadlineAt) {
          deadlineHit = true;
          break;
        }
        const batch = covered.slice(i, i + 25);
        await this.doc.send(
          new BatchWriteCommand({
            RequestItems: {
              [this.mutationLogTable]: batch.map((m) => ({
                DeleteRequest: { Key: { householdId, sequenceId: m.sequenceId } },
              })),
            },
          }),
        );
        deleted += batch.length;
      }
      if (deadlineHit) break;
      lastKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    return { verified, deleted, kept };
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}
