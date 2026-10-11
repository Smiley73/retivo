/**
 * Scheduled snapshot compactor (docs/architecture.md, "Background Lambdas").
 *
 * For each household:
 *   1. Read latestSnapshotCursor from WorkspaceMeta.
 *   2. Take cutoff = max(sequenceId) in MutationLog at job start.
 *   3. Load the latest snapshot from S3 (or empty if none) and replay
 *      mutations with latestSnapshotCursor < sequenceId <= cutoff.
 *   4. Serialize + gzip + upload to s3://<bucket>/<householdId>/<snapshotId>.json.gz.
 *   5. Atomically update WorkspaceMeta (conditional on cursor unchanged
 *      since job start). On race → abort and let the next hour retry.
 *   6. Cursor-bounded delete on MutationLog where sequenceId <= cutoff.
 *      In-flight pushes (sequenceId > cutoff) are preserved.
 *
 * Runs in the compactor Lambda's IAM context — it has no access to any
 * auth table.
 */
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
   * Household ids whose compaction this run was bounded by a safety budget —
   * either a partial-prefix compaction or a true skip.
   * Distinct from `householdsSkipped`, which also counts the ordinary no-op
   * outcomes (nothing to compact, everything inside the safety margin, a lost
   * cursor race) that are not budget-related.
   */
  budgetLimitedHouseholdIds: string[];
}

export interface CompactorHouseholdMetric {
  householdId: string;
  mutationsCompacted: number;
  snapshotBytes: number;
  durationMs: number;
  /** Set when a safety budget bounded this household to a prefix — see
   *  {@link CompactorRunSummary.budgetLimitedHouseholdIds}. */
  budgetLimited?: boolean;
}

/**
 * Compaction safety budgets. The byte caps were
 * originally sized at 100 MB each against the compactor Lambda's DECLARED
 * 1024 MB memory (`infrastructure/src/lambda.ts`) — a raw-byte-count
 * argument that ignored what those bytes cost once parsed: a household
 * sitting just under all three caps simultaneously (the mutation-log page,
 * the decompressed baseline, and the merged result all live in one pass) can
 * exceed 1024 MB from JSON.parse/JSON.stringify expansion alone, well before
 * the AWS-SDK/Node baseline. They are now sized in the single-digit-MB class
 * instead, with the bootstrap ceiling as the floor for the WRITE cap:
 * `MAX_RESPONSE_BYTES` caps a bootstrap response at 5 MiB *gzipped*
 * (`bootstrap.service.ts`), and payloads are base64 ciphertext
 * that deflate shrinks only to ~0.75x (6 bits of entropy per character), so
 * the largest aggregate set bootstrap can still serve is ~6.7 MiB
 * uncompressed. `maxMergedBytes` (8 MiB, uncompressed) sits above that:
 * everything still servable is still compacted, and what it refuses
 * (> 8 MiB, i.e. > ~6 MiB gzipped) is already undeliverable. The gap
 * matters because a merged-size refusal is PERMANENT — merged = baseline +
 * prefix only grows — so a write cap below the ceiling would turn a
 * large-but-servable household into a `merged_oversized` skip every hour
 * whose log never drains, the starvation shape these budgets exist to
 * close. At these caps, worst-case live heap for one household — the log
 * page (8 MiB plus row overhead), the baseline's decompress + parse (12 MiB,
 * ~3-5x its byte count in V8 heap), and the merged stringify + gzip (≤ 8 MiB
 * plus zlib buffers) — is on the order of 100 MB, comfortably below 1024 MB
 * with the Node/AWS-SDK baseline included. These are internal safety bounds, not
 * stack config — deliberately NOT wired through
 * `infrastructure/src/config.ts`. The owner should still sanity-check the
 * numbers below against real household sizes before this ships.
 *
 * `CompactorService.budgets` is a public, mutable instance field (not a
 * constructor default) so a test can trip a budget with a handful of rows
 * instead of a gigabyte; production code never reassigns it.
 */
export interface CompactorBudgets {
  /** Mutation-log page-read row cap per household — paging stops once
   *  tripped (row count, byte count, or the household deadline below). */
  maxLogRows: number;
  /** Mutation-log page-read accumulated payload-byte cap per household. */
  maxLogBytes: number;
  /** Decompressed baseline-snapshot byte cap, enforced at `gunzipSync` via
   *  node:zlib's `maxOutputLength` rather than trusting the S3 object's
   *  compressed size. */
  maxSnapshotBytes: number;
  /** Serialized merged-snapshot byte cap, checked before gzip + S3 write.
   *  Bounded on BOTH sides. Floor: at or above the uncompressed equivalent
   *  of the bootstrap ceiling (`MAX_RESPONSE_BYTES`, 5 MiB gzipped —
   *  ~6.7 MiB uncompressed for base64 ciphertext, see the interface doc). A
   *  merged set bootstrap can still serve MUST still be written: refusing it
   *  is a PERMANENT `merged_oversized` skip (merged = baseline + prefix only
   *  grows) for a household whose log then never drains. Ceiling: strictly
   *  BELOW `maxSnapshotBytes`, with headroom for the envelope bytes
   *  (`householdId`/`generatedAt`/`cutoff`) that wrap the aggregates on
   *  read: `fetchSnapshot` re-decompresses whatever this compactor writes
   *  against `maxSnapshotBytes`, and the read cap applies to the WHOLE
   *  decompressed envelope while this write cap is an estimate over the
   *  aggregates alone. A merged size this cap lets through but
   *  `maxSnapshotBytes` then refuses to read back is the same permanent
   *  skip, as `baseline_oversized`. */
  maxMergedBytes: number;
  /** Wall-clock budget for one household's whole compaction pass. */
  householdDeadlineMs: number;
  /** Fallback whole-run wall-clock budget used when `runOnce` isn't given
   *  the Lambda's actual remaining time (local/test invocations). */
  runDeadlineMs: number;
  /** Reserve subtracted from the run deadline so the summary log still
   *  writes before Lambda freezes/kills the process. MUST be >=
   *  `householdDeadlineMs`: a household can start just before the run
   *  deadline and is then entitled to run up to `householdDeadlineMs`
   *  longer (every phase of `compactHousehold` now enforces that budget,
   *  not just the mutation-log read) — a smaller reserve would let that
   *  last household blow past the real Lambda timeout before the summary
   *  log writes. */
  runDeadlineReserveMs: number;
}

const DEFAULT_COMPACTOR_BUDGETS: CompactorBudgets = {
  maxLogRows: 20_000,
  // Single-digit-MB class (see the doc comment above) rather than the
  // previous 100 MB: sized so JSON.parse/JSON.stringify expansion of a
  // household right at these caps stays well under the Lambda's 1024 MB
  // heap. A log page above this compacts as a prefix and resumes next run,
  // so it needs no relation to the bootstrap ceiling.
  maxLogBytes: 8 * 1024 * 1024,
  // Above maxMergedBytes with headroom (see that field's doc): a snapshot
  // this compactor writes must still be re-readable by the next run's
  // fetchSnapshot, which enforces this cap against the whole decompressed
  // envelope, not just the aggregates the write-side estimate covers.
  maxSnapshotBytes: 12 * 1024 * 1024,
  // Above the ~6.7 MiB uncompressed equivalent of the 5 MiB gzipped
  // bootstrap ceiling (MAX_RESPONSE_BYTES ÷ the ~0.75 deflate ratio on
  // base64 ciphertext), so nothing bootstrap can still serve is ever refused
  // here — that refusal would be permanent — and below maxSnapshotBytes.
  maxMergedBytes: 8 * 1024 * 1024,
  householdDeadlineMs: 90_000,
  runDeadlineMs: 270_000,
  // >= householdDeadlineMs (see that field's doc) plus slack for the S3/
  // Dynamo call in flight at the moment the deadline trips.
  runDeadlineReserveMs: 100_000,
};

/**
 * Thrown by `fetchSnapshot` when the decompressed baseline exceeds
 * `budgets.maxSnapshotBytes` (node:zlib `ERR_BUFFER_TOO_LARGE`). A TRUE skip
 * — no correct snapshot can be written this run, and no amount of prefix
 * work fixes it — distinct from `fetchSnapshot`'s other errors, which stay
 * on the existing fail-closed "unreadable" path.
 */
class SnapshotOversizedError extends Error {
  constructor(householdId: string, snapshotId: string, maxBytes: number) {
    super(
      `Compactor: baseline snapshot for ${householdId}/${snapshotId} exceeds the ${maxBytes}-byte decompression cap`,
    );
  }
}

/**
 * Thrown by `compactHousehold` for a TRUE skip forced by a safety budget —
 * an oversized baseline/merged result, or a read/time budget that left
 * nothing usable below the safety boundary. Distinct from the ordinary
 * `null` "nothing to compact" / lost-cursor-race outcomes, which are not
 * budget-related. `runOnce` catches this specifically to record the
 * household + cause in the run summary and continue — never an uncaught
 * throw that aborts the whole run. Exported so a test can assert on the
 * cause of a direct `compactHousehold` call without going through `runOnce`.
 */
export class CompactorBudgetSkipError extends Error {
  constructor(
    readonly householdId: string,
    /** The budget cause (e.g. `baseline_oversized`) — named `budgetCause`,
     *  not `cause`, to avoid colliding with `Error.prototype.cause`
     *  (`ErrorOptions.cause`, TS lib es2022). */
    readonly budgetCause: string,
  ) {
    super(`Compactor budget skip for household ${householdId}: ${budgetCause}`);
  }
}

/**
 * Outcome of the verify-then-delete coverage sweep. `verified` is
 * the number of `sequenceId <= cutoff` rows inspected, `deleted` those the
 * snapshot covered (safe to reclaim), and `kept` the uncovered rows preserved
 * (a KSUID-disorder strand or a pre-existing latent orphan) — `kept > 0` drives
 * the `CompactorCoverageViolation` metric.
 */
interface CoverageSweepResult {
  verified: number;
  deleted: number;
  kept: number;
}

// Safety margin for the compaction cutoff. KSUIDs are minted BEFORE
// the push transaction commits and carry only 1-second timestamp
// precision plus a random payload, so a racing in-flight push can commit
// with a `sequenceId` BELOW rows that committed earlier. If such a row
// landed below the cutoff it would be permanently excluded from
// snapshots/pull/bootstrap and never deleted — an acknowledged write lost.
// We therefore exclude from this run every row at or above a boundary
// KSUID derived from `now - this margin`: rows OLDER than the margin
// cannot have an uncommitted, lower-KSUID sibling still in flight (the
// margin exceeds max plausible clock skew + transaction latency).
const COMPACTION_SAFETY_MARGIN_MS = 60_000;

@Injectable()
export class CompactorService {
  private readonly logger = new Logger(CompactorService.name);
  private readonly workspaceMetaTable: string;
  private readonly mutationLogTable: string;
  private readonly snapshotsBucket: string;
  /**
   * Deployment stack (`local` when unset), mirroring AuthEventsRepository.
   * Drives the per-stack compactor EMF namespace
   * (`Retivo/${stack}/Compactor`) so a dev compaction event can never
   * trip a prod compactor alarm.
   */
  private readonly stack: string;

  /** Compaction safety budgets — see {@link CompactorBudgets}. Public and
   *  mutable so a test can trip a budget with a handful of rows. */
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
   * @param remainingTimeMs The Lambda handler's `context.getRemainingTimeInMillis()`
   *   at invocation, when running under Lambda (`compactor-lambda.ts`) — used
   *   to derive the whole-run deadline. Falls back to
   *   `budgets.runDeadlineMs` for local/test invocations that have no
   *   Lambda context.
   */
  async runOnce(remainingTimeMs?: number): Promise<CompactorRunSummary> {
    const runStart = Date.now();
    const households = await this.listHouseholdIds();
    // Fairness: a run-level deadline that cuts the loop short
    // would otherwise always starve the same tail of households, because
    // Scan order is stable. Start at a pseudo-random offset into the list
    // and wrap. Chosen over a persisted least-recently-compacted ordering,
    // which would cost a new WorkspaceMeta attribute plus one extra write
    // per household per run for a property rotation already gives at this
    // household count.
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
      // Run-level deadline: stop starting new households so the summary log
      // still writes before Lambda freezes/kills the process. The remaining
      // households are untouched (cursor unchanged) and are picked up by
      // the rotation on a later run.
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
          // Already logged + metric-emitted inside compactHousehold — this
          // is an intentional bounded skip, not a failure.
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

  /**
   * Returns the per-household metric (mutationsCompacted, snapshotBytes,
   * durationMs) on success, or null when there is nothing to compact.
   *
   * Shape-limit exception (~200 lines vs the 60-line guidance, grown by the
   * safety-budget and restore-epoch checks): the body
   * is one read-meta → query-log(budgeted) → margin-filter → fetch-baseline
   * (budgeted) → apply → write-snapshot(budgeted) → advance-cursor
   * (epoch-pinned) → delete sequence whose steps are only correct as a unit
   * — splitting it would fragment the consistency boundary the inline
   * comments walk through without making any step independently reusable or
   * testable. Each new budget check is a short, early-return/throw guard
   * rather than added branching depth.
   */
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

    // Safety margin: drop every row at or above the boundary KSUID
    // (now - margin, zero payload) so an in-flight push that commits with
    // a lower KSUID than an already-committed sibling can never land below
    // the cutoff. Rows older than the margin are safe to compact.
    const boundary = KSUID.fromParts(
      Date.now() - COMPACTION_SAFETY_MARGIN_MS,
      Buffer.alloc(16),
    ).string;
    const recent = allRecent.filter((r) => r.sequenceId < boundary);
    if (recent.length === 0) {
      if (budgetTripped) {
        // A read/time budget cut the page short AND nothing it read survived
        // the safety margin — no correct partial snapshot can be written this
        // run (a true skip, not the ordinary "nothing new yet" no-op below).
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
      // Nothing safely outside the margin yet — skip this run; the next
      // hourly run picks these rows up once they age past the boundary.
      return null;
    }

    const cutoff = recent[recent.length - 1].sequenceId;

    // Household deadline, checked again here: `queryAllSince`
    // only bounds the read phase above. A household whose read alone filled
    // the whole budget must not go on to fetchSnapshot/merge/write/delete —
    // none of that is deadline-aware, so it could otherwise run the process
    // past the run deadline's reserve and starve every later household.
    // Nothing has been written yet, so this is a clean TRUE skip.
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

    // Load existing snapshot (if any), apply the recent mutations. An
    // oversized baseline is a TRUE skip — no correct snapshot can be written
    // this run, and no amount of prefix work fixes it (unlike a read-budget
    // trip, which compacts what it has).
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

    // Estimate the merged snapshot's byte size from its parts BEFORE paying
    // for one giant JSON.stringify of the whole envelope: an oversized merge
    // is then a TRUE skip that never materializes the full body string in
    // the first place, rather than allocating it only to discover the cap
    // was already blown. Slightly under-counts the envelope's own
    // boilerplate (householdId/generatedAt/cutoff), which is negligible next
    // to the aggregate payloads it's dominated by.
    let estimatedMergedBytes = 0;
    for (const a of merged) {
      estimatedMergedBytes += Buffer.byteLength(JSON.stringify(a), 'utf8');
    }
    if (estimatedMergedBytes > this.budgets.maxMergedBytes) {
      // Also a TRUE skip: writing an over-cap snapshot would only move the
      // problem into S3 and the next bootstrap read.
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

    // Household deadline, checked again here: fetchSnapshot's
    // S3 read + gunzip and the in-memory merge above are not themselves
    // deadline-aware, so a slow baseline could otherwise carry this pass
    // straight through the S3 write / cursor flip with no budget left for
    // the delete sweep (or for the households still waiting behind this
    // one). Nothing has been written yet, so this is a clean TRUE skip.
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

    // Write the new snapshot.
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

    // Atomically advance the cursor; abort if someone else moved it
    // (another compactor run, or a concurrent migration) OR if the restore
    // epoch observed at the top of this pass has since changed — a
    // restore/clear bumps it BEFORE its sweep, so a same-cutoff restore that
    // lands mid-pass (the cursor alone would look unchanged) still aborts
    // this update. `attribute_not_exists(restoreEpoch)` is a distinct pinned
    // state (legacy rows, or rows never restored) mirrored from the existing
    // cursor condition's absent-value handling.
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

    // Verify-then-delete of consumed + stray mutation log entries.
    // The coverage map is the max version durably reachable per aggregate in
    // the snapshot just written; the sweep deletes a row only when its
    // aggregate's snapshot version covers the row's version, so an uncovered
    // strand/orphan is kept rather than lost. This needs no NEW guard for the
    // restore race: it deletes only rows the snapshot just written
    // covers, and that snapshot could only be written because the cursor
    // UpdateCommand above already passed its epoch-pinned condition — a
    // post-restore interleaving is already caught there, before this runs.
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
    // WorkspaceMeta holds one row per household and this Scan projects only
    // the key, so the hourly enumeration reads one 1 MB page per ~thousands of
    // rows and its cost tracks that row count, nothing else.
    // Who revisits: the operator. Revisit trigger: the enumeration needs more
    // than a page or two, or it shows up in the compactor's run time — a
    // per-active-household trigger (DynamoDB Streams → EventBridge) is the
    // natural next step.
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

  /**
   * Pages `MutationLog` since `since`, stopping — mid-page, not after a full
   * read — once either the row count or the accumulated payload-byte count
   * trips `budgets`, or the household's wall-clock deadline passes. Trimming
   * after a full read would defeat the purpose: the unbounded
   * version of this loop is what let one household's oversized log OOM the
   * process and starve every household after it in stable Scan order.
   */
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
      // Size budget: the decompressed baseline exceeds the safety cap (node:zlib
      // throws ERR_BUFFER_TOO_LARGE at maxOutputLength). Distinct from every
      // branch below — an oversized baseline is not "unreadable", it's a
      // TRUE skip the caller decides on, so propagate a distinguishable
      // error rather than the fail-closed path.
      if ((err as { code?: string })?.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new SnapshotOversizedError(householdId, snapshotId, maxDecompressedBytes);
      }
      // Fail-closed snapshot read. Only a genuine object-miss
      // (`NoSuchKey`) is the soft case → empty baseline; the WorkspaceMeta
      // pointer can legitimately reference a key the janitor already swept
      // (the next compaction rewrites it). Any OTHER error (S3 5xx,
      // `NoSuchBucket`, truncated body, gunzip / JSON failure) means the
      // baseline is unreadable, NOT empty — compacting against an empty
      // baseline would silently drop every aggregate the snapshot held. Log
      // with structured context, emit a CloudWatch metric, and re-throw so the
      // outer per-household try-catch skips this household and continues.
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

  /**
   * Emit a `CompactorSnapshotReadError` CloudWatch metric via Embedded Metric
   * Format: write a single EMF JSON line to stdout; CloudWatch Logs
   * auto-extracts the metric (zero IAM / infra change). `householdId` is a
   * high-cardinality field — it stays in the structured log record above, NOT
   * as a metric dimension, so the metric carries no custom dimensions.
   * Namespace is per-stack (`Retivo/${stack}/Compactor`) so a dev
   * compaction event cannot trip a prod alarm.
   */
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

  /**
   * Emit a `CompactorCoverageViolation` CloudWatch metric via EMF,
   * mirroring {@link emitSnapshotReadErrorMetric}: a single EMF JSON line to
   * stdout, auto-extracted by CloudWatch Logs — zero IAM / infra change. The
   * metric VALUE is the count of uncovered rows KEPT this run (rows the
   * just-written snapshot does not cover at their version). `householdId` stays
   * a high-cardinality field in the structured `compactor_coverage` log record,
   * NOT a metric dimension, so the metric carries no custom dimensions.
   * Namespace is per-stack (`Retivo/${stack}/Compactor`) so a dev
   * coverage violation cannot trip a prod alarm. Alarmed in
   * `infrastructure/src/monitoring.ts`.
   */
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

  /**
   * Emit a `CompactorBudgetLimited` CloudWatch metric via EMF,
   * mirroring {@link emitSnapshotReadErrorMetric}: a single EMF JSON line to
   * stdout, auto-extracted by CloudWatch Logs. Covers every budget outcome
   * (a bounded prefix compaction or a true skip) — the cause distinguishing
   * them stays in the structured `compactor_budget` log line, NOT a metric
   * dimension, so a repeat occurrence for the SAME household across
   * runs (the alarm's real signal — a household not draining) is visible
   * regardless of which specific budget tripped. Namespace is per-stack
   * (`Retivo/${stack}/Compactor`). Alarmed in
   * `infrastructure/src/monitoring.ts`.
   */
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

  /**
   * Write one EMF JSON line to stdout with a synchronous fd-1 write
   * (`fs.writeSync`), NOT `process.stdout.write`. Under Lambda's
   * freeze-after-return model an async stdout write issued near the end of an
   * invocation can sit unflushed in Node's userland pipe buffer and vanish on
   * freeze — the exact loss the operational-metrics.ts writer avoids.
   * `writeSync` hands the bytes to the OS before returning; a failed write must
   * never abort compaction, so it is swallowed with a PII-free breadcrumb.
   */
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
        // An encrypted payload is a COMPLETE aggregate payload,
        // not a patch — REPLACE the snapshot payload entirely.
        // Spread-merging an opaque envelope would blend old + new ciphertext/
        // nonce/keyId fields and corrupt it. Legacy plaintext payloads keep the
        // historical spread-merge (mutation patches over the snapshot).
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
    // Verify-then-delete coverage enforcement. Query EVERY row
    // with `sequenceId <= cutoff` from the start of the partition (both the
    // rows folded into this snapshot AND any stray a crash between the cursor
    // bump and the delete left behind), then delete ONLY the rows the snapshot
    // just written COVERS — its merged version for that aggregate is >= the
    // row's version. The previous delete-on-sight assumed every `<= cutoff` row
    // was already invisible/covered; that is FALSE for a KSUID-disorder strand
    // (a row that committed below an already-taken cutoff and was never read
    // into any snapshot) or a pre-existing latent orphan. An uncovered row is
    // KEPT — never deleted, so an acknowledged-but-unsnapshotted write can
    // never be destroyed — and reported via the `CompactorCoverageViolation`
    // metric + the per-run summary, then re-checked next run (no auto-repair).
    // The already-covered strays a healthy self-heal used to sweep are still
    // deleted, so a healthy run is byte-identical. Projection now includes
    // `aggregateId` + `version` (aliased — `version` is a DynamoDB reserved
    // word) so the in-memory comparison has its inputs.
    let lastKey: Record<string, unknown> | undefined;
    let verified = 0;
    let deleted = 0;
    let kept = 0;
    do {
      // Household deadline: the cursor already advanced above,
      // so stopping the sweep early here is safe — the not-yet-verified
      // covered rows are strays that stay in MutationLog and get re-verified
      // (and deleted) by the next run, not lost data. Without this check a
      // household with a large pre-cursor backlog (e.g. left by an earlier
      // crash) can page through hundreds of BatchWrites with no time bound.
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
      // Household deadline, re-checked between batches: a page
      // can hold far more than 25 covered rows (the projection is key-only,
      // so a single ~1 MB page can carry thousands), and none of those
      // BatchWriteCommand round trips were previously deadline-aware. `deleted`
      // is counted per batch as it actually sends, not for the whole `covered`
      // set up front, so a mid-page break never over-reports rows this run
      // didn't get to delete — those rows are still `<= cutoff` and covered,
      // so the next run's verify-then-delete pass finds and deletes them.
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

// Surface the AggregateVersion type so a future per-household reset
// (e.g. delete-then-recreate from snapshot) has access to it without
// re-declaring.
