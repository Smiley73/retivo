/**
 * Sync push pipeline. Each mutation runs inside its own
 * TransactWriteItems with three operations:
 *   1. Conditional Put on AggregateVersion (operation-aware version-check)
 *   2. PutItem on MutationLog (append-only)
 *   3. Conditional Put on IdempotencyKey (attribute_not_exists guards the race)
 *
 * Plus a best-effort WorkspaceMeta.latestVersion bump after the
 * transaction commits.
 */
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

/**
 * Daily push-quota budget ("a household can no longer write an unbounded amount of
 * data per day"). Sized generously above any one household's legitimate
 * workload — the demo dataset (apps/web/src/lib/demo-data-loader.ts) loads
 * on the order of a few hundred aggregate rows in one sitting, and normal
 * editing pushes a handful of mutations per batch, a few batches an hour —
 * while still bounding a runaway or hostile client well below "unbounded".
 * The budget rolls over on the next UTC day boundary
 * (`WorkspaceMetaRepository.chargeDailyQuota`); nothing resets it early.
 */
export const MAX_DAILY_MUTATIONS = 10_000;
export const MAX_DAILY_BYTES = 50 * 1024 * 1024;

/**
 * Freshness-counter step bound ("one crafted mutation can no longer wedge every device in
 * the household"). The client's counter advances by exactly 1 per push
 * ATTEMPT (`bumpCounter`, apps/web/src/crypto/freshness.ts) and pins only
 * the server-ECHOED value (never its own optimistic proposal), so under
 * normal operation a proposed counter is never more than a handful above the
 * stored one — a run of un-echoed pushes only happens on a rare transient
 * `bumpFreshnessHead` write/read failure. 1,000 is far above any plausible
 * legitimate run of those while still catching a clearly implausible/forged
 * jump. Deliberately overrides the principle that the freshness head must never
 * fail a push — the SAME kind of narrow exception the shape check
 * (`FRESHNESS_HEAD_INVALID`, sync.controller.ts) already carves out.
 */
export const FRESHNESS_COUNTER_MAX_STEP = 1000;

// A re-appended stranded MutationLog row is minted at the
// cursor's KSUID timestamp + 1 second so it sorts STRICTLY above the cursor
// regardless of payload — mirrors `computeConvergenceWatermark`
// (restore.service.ts). A fresh `KSUID.random()` carries the current-second
// timestamp and could sort BELOW a same-second/future cursor, re-manufacturing
// the strand.
const KSUID_STRAND_SUCCESSOR_MS = 1000;

interface PushArgs {
  householdId: string;
  deviceId: string;
  mutations: PushMutationDto[];
  /**
   * Optional zero-knowledge freshness head. The server
   * persists both fields opaquely and never verifies the MAC. Optional in the
   * type; the encryption guard rejects a push that omits it.
   */
  freshnessHead?: { freshnessCounter: number; cursorTag: string };
}

type CancelTarget = 'aggregate' | 'log' | 'idempotency' | 'unknown';

type ApplyOutcome =
  | { kind: 'committed'; applied: AppliedMutationResult; sequenceId: string }
  | { kind: 'replayed-applied'; applied: AppliedMutationResult }
  | { kind: 'rejected'; outcome: RejectedMutationResult };

/**
 * A single mutation's preflight classification. The
 * preflight pass resolves every mutation to one of these BEFORE any DB write,
 * so a keyed-household encryption violation can fail the whole batch atomically
 * (nothing persisted) instead of after an earlier mutation already committed.
 *   - `cached`  — the idempotency lookup hit a TRUSTWORTHY replay (an applied
 *     outcome, or a rejection whose recorded `expectedVersion` matches this
 *     mutation's version — a true duplicate); replay the stored response
 *     inline.
 *   - `pending` — never cached; passed the encryption guard; apply it.
 *   - `stale-rejection` — the idempotency lookup hit a
 *     REJECTED outcome whose recorded `expectedVersion` does NOT match this
 *     mutation's version (or a legacy row with none at all) — the client
 *     re-based and retried with a corrected version. Passed the encryption
 *     guard like `pending` (nothing has actually landed for a rejection), but
 *     the apply pass must first conditionally clear the stale cache row
 *     before re-evaluating, since the occupied key would otherwise cancel
 *     the fresh attempt's own idempotency Put.
 *
 * `pending` and `stale-rejection` also carry `bytes` — the mutation's payload size, measured once
 * here by {@link enforcePayloadSize} and reused by the daily byte quota in `push()` rather than
 * re-measuring. `cached` carries none: a trustworthy replay writes nothing this request, so it is
 * free (never charged twice).
 */
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

/**
 * A mutation whose apply transaction really committed this request — the
 * inputs the post-commit strand guard needs to re-append a
 * cursor-dominating copy of its `MutationLog` row.
 */
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
    // Two-pass push so a batch is atomic across the encryption boundary:
    // preflight EVERY mutation first — idempotency
    // lookup + the unconditional encryption guard — and only if the whole batch
    // passes do we touch any DB state. A mixed batch like `[encrypted,
    // plaintext]` must fail 403 with NOTHING written, including the
    // side-effecting `createIfMissing`. Encryption is now enforced on EVERY
    // household, keyed or not: there is no server-side plaintext push
    // path. The guard still runs AFTER each idempotency lookup so a genuine
    // retry of an ALREADY-committed encrypted mutation replays its cached
    // response instead of being re-checked (the idempotency contract wins for
    // writes that already landed); the old "plaintext committed before
    // activation" framing is retired because no plaintext write can land.
    const preflight = await this.preflightBatch(args);

    const applied: AppliedMutationResult[] = [];
    const rejected: RejectedMutationResult[] = [];
    const committedRows: CommittedRow[] = [];
    let lastSequenceId = '';

    // Pass 2 (apply): reached only when the whole batch survived preflight, so
    // `createIfMissing` never fires as an orphaned side effect of a batch that
    // 403s there. The stored-relative freshness-counter bound and the daily
    // quota check run right below,
    // reusing THIS row (`meta`) rather than a second GetItem per push. A batch
    // that clears preflight but fails one of those two newer checks has
    // already caused this row to be created — harmless (idempotent, carries
    // no mutation data) and the accepted cost of reusing the read.
    const meta = await this.meta.createIfMissing(args.householdId);

    if (args.freshnessHead) {
      this.enforceFreshnessCounterBound(args.freshnessHead.freshnessCounter, meta);
    }

    // Daily push-quota: charge every mutation this request will
    // actually attempt to write — the preflight's `pending` and
    // `stale-rejection` items — so a trustworthy idempotent replay (`cached`)
    // is free and a retried batch never double-charges. One quota write per
    // push request, not per mutation; skipped entirely when nothing would be
    // charged (an all-replay batch).
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
        // Structured line (style of the existing metric-filter targets —
        // janitor.service.ts, compactor.service.ts) naming the household and
        // which budget was hit. Observability only — no CloudWatch
        // filter or alarm is added for it.
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
        // applyOne stamped the real KSUID onto result.applied already
        // (existing public response carries `applied[i].sequenceId`).
        applied.push(result.applied);
        // Only real commits advance the cursor + drive the meta bump.
        // A replay (race-loser) re-uses the winner's cached response but
        // wrote nothing to MutationLog this request, so it must not move
        // lastSequenceId — matches the cached branch above.
        lastSequenceId = result.sequenceId;
        // Track the real commit for the post-commit strand guard.
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
      // Strand guard: re-append any committed row whose
      // minted KSUID landed at/below an already-taken compaction cutoff so it
      // stays pull-visible. Post-commit + best-effort — a throw here must never
      // turn a durable, acknowledged write into a 5xx.
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

    // Best-effort monotonic freshness-head persistence — non-atomic with mutation acceptance, never
    // fails the push. Echo the server-acknowledged head so the client pins the stored value rather
    // than its optimistic proposal.
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

  /**
   * Preflight every mutation in the batch BEFORE any DB write. For each mutation: enforce payload
   * size, then do the idempotency lookup.
   *
   * A cache hit is trustworthy replay (`cached`, short-circuits inline) when
   * it's an APPLIED outcome (a genuine retry of an already-committed
   * encrypted mutation never re-hits the encryption guard below) OR a
   * REJECTED outcome whose recorded `expectedVersion` matches this mutation's
   * `version` (a true duplicate — same mutation id, same attempted version).
   *
   * A REJECTED cache hit at a DIFFERENT version — or a legacy row that predates `expectedVersion`
   * entirely, which always mismatches — means the client re-based and retried with a corrected
   * version. Nothing has actually landed for a rejection, so this mutation is treated like a
   * never-seen one: it MUST still pass {@link enforceEncryptionForMutation}, and is tagged
   * `stale-rejection` so the apply pass conditionally clears the stale cache row before
   * re-evaluating it (the occupied key would otherwise cancel the fresh attempt's own idempotency
   * Put).
   *
   * A non-cached mutation must pass {@link enforceEncryptionForMutation}
   * unconditionally (every household, keyed or not); a violation
   * throws `403 ENCRYPTION_REQUIRED` HERE, before the caller calls
   * `createIfMissing` or applies anything, so a mixed batch like
   * `[encrypted, plaintext]` fails atomically with nothing persisted
   * (matches the device-/household-mismatch guards: the WHOLE batch fails).
   */
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

      // Enforce the zero-knowledge boundary on every not-yet-committed mutation.
      // Every push MUST carry a freshnessHead and a strict encrypted payload; a
      // violation throws and fails the WHOLE batch before any write (no partial
      // commit, no orphaned createIfMissing).
      this.enforceEncryptionForMutation(args, mutation);

      items.push({ type: 'pending', idemKey, mutation, bytes });
    }
    return items;
  }

  /**
   * Zero-knowledge enforcement boundary for a single
   * not-yet-committed mutation. Every pushed mutation `payload` MUST be a strict
   * encrypted envelope AND the request MUST carry a `freshnessHead` — on EVERY
   * household, regardless of slot presence (there is no plaintext
   * push path). A plaintext payload or a missing head is rejected with
   * `403 ENCRYPTION_REQUIRED` before any DB write — the server is the boundary
   * that keeps payloads opaque. Setup happens via `PUT /auth/key-envelopes/:slotId`,
   * not via a plaintext push, and the bootstrap pull does not go through this guard.
   *
   * Called per mutation AFTER the idempotency lookup so a genuine retry of an
   * already-committed encrypted mutation short-circuits on its cached response
   * before this guard — the idempotency contract wins for writes that already
   * landed. Fails the WHOLE batch like the device-mismatch guards.
   */
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

  /**
   * Stored-relative freshness-counter bound. A single crafted counter far above
   * the stored value would wedge every OTHER device in the household permanently — once the server
   * echoes and a device pins a counter that high, every honest device's own (much lower) proposal
   * reads as a rollback forever.
   *
   * A household with NO stored counter (`meta.freshnessCounter === undefined` —
   * a brand-new household, or one whose head was just cleared by a
   * restore) accepts any well-formed counter unconditionally: trust-on-
   * first-use must survive a restore, whose `reinitializeForRestore`
   * deliberately omits the freshness fields so the client re-pins. A naive
   * "counter must be <= stored + step" would otherwise wedge every restored
   * household permanently, since the client's local counter survives the
   * reset and can already sit far above zero.
   *
   * Deliberately overrides the principle that the freshness head must never fail a push —
   * see {@link FRESHNESS_COUNTER_MAX_STEP}.
   */
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
        // Race guard: a duplicate (householdId, deviceId, mutationId)
        // that slipped past the pre-lookup must cancel the transaction
        // so the replay path returns the original cached response.
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

  /**
   * Strand guard. A KSUID `sequenceId` is minted
   * (`applyOne`, `KSUID.random()`) BEFORE the push transaction commits, and
   * KSUIDs carry 1-second timestamp precision, so a pathological commit delay
   * can land a durable `MutationLog` row AT OR BELOW an already-taken
   * compaction cutoff (`WorkspaceMeta.latestSnapshotCursor`). Pull returns only
   * rows strictly ABOVE the cursor, so such a strand is invisible to every
   * device and the compactor's coverage check keeps it forever.
   * Re-append each stranded row with a CURSOR-DOMINATING sequenceId —
   * `KSUID.fromParts(cursorTs + 1s, originalPayload)` (mirrors
   * `computeConvergenceWatermark`), NOT a fresh `KSUID.random()` whose
   * current-second timestamp could sort BELOW a same-second/future cursor
   * (e.g. a `workspace/clear` watermark). The re-append reuses each row's own
   * KSUID payload so multiple stranded rows in one push get DISTINCT dominating
   * ids. Same aggregateId/version/payload; the original strand stays in the log
   * (never returned by pull) and the compactor merges the duplicate
   * `(aggregateId, version)` rows idempotently (last-write-wins per aggregate).
   * The `AggregateVersion` row is already correct, so no version write repeats.
   * The single cursor `GetItem` is piggybacked on the post-commit
   * `WorkspaceMeta` touch. Best-effort + post-commit — the caller swallows any
   * throw so a durable, acknowledged write never becomes a 5xx.
   */
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
      // A non-KSUID sentinel cursor (a legacy '0') is lexically below every
      // real KSUID, so no real sequenceId can sit at/below it — nothing to do.
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
      // Create: row must not exist. DTO guarantees m.version === 0.
      return {
        Put: {
          TableName: this.aggregateVersionTable,
          Item: row,
          ConditionExpression: 'attribute_not_exists(aggregateId)',
        },
      };
    }
    // Update / delete: row must exist at the expected version.
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

  /**
   * Tombstone-revival counterpart of {@link aggregateConditionalPut}: the
   * `AggregateVersion` Put for a tombstone revival, swapping the ordinary
   * create/update condition for one requiring the row to still be a
   * tombstone at the EXACT version read moments earlier (race-safe — a
   * concurrent write landing in between fails this condition).
   *
   * The tombstone check MUST be `attribute_type(deletedAt, 'S')`, not
   * `attribute_exists(deletedAt)`. Every LIVE row also carries a
   * `deletedAt` attribute — `buildApplyItems` writes it as explicit
   * `null`, not omitted, and this doc client is configured with
   * `removeUndefinedValues: true` (which strips `undefined`, never `null`) —
   * so `null` marshals to a present DynamoDB `NULL` attribute and
   * `attribute_exists` is true for a live row too, providing zero actual
   * protection. `attribute_type(deletedAt, 'S')` is true only when
   * `deletedAt` is a String (a real tombstone timestamp), so a concurrent
   * write that lands the row back to LIVE between the tombstone read above
   * and this transaction now correctly fails the condition instead of
   * silently overwriting the live row.
   */
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
      // Defensive: cache row missing despite the cancel claiming a
      // conflict on it. Fall through to the conflict path so we still
      // surface a deterministic rejection rather than re-raising.
      return this.buildConflictOutcome(householdId, idemKey, m);
    }
    if (target === 'unknown') {
      // No cancellation reason is `ConditionalCheckFailed` — the cancel
      // came from a TRANSIENT cause (TransactionConflict from concurrent
      // transactions on the same item, throttling, etc.), NOT a genuine
      // version/idempotency conflict. Rethrow so the global exception filter
      // returns a 5xx and the client retries. Do NOT call
      // buildConflictOutcome: it would fabricate a CONFLICT and cache it in
      // the idempotency table for 7 days, turning a retryable hiccup into a
      // permanent rejection of a valid mutation.
      throw err;
    }
    if (target === 'aggregate' && m.operation === 'create') {
      // Tombstone revival: a `create`'s `attribute_not_exists` condition
      // failed — the aggregateId already exists. If it's a tombstone
      // (soft-deleted), revive it instead of permanently conflicting. A live row falls through to
      // the ordinary conflict below.
      const revived = await this.tryRecreateOverTombstone(householdId, idemKey, m);
      if (revived) return revived;
    }
    // target is 'aggregate' (genuine version conflict, or a live row on a
    // create) or 'log' (no condition on the log Put — treated as conflict,
    // unchanged).
    return this.buildConflictOutcome(householdId, idemKey, m);
  }

  /**
   * Version-aware, TOCTOU-safe rejection replay. A cached
   * REJECTED outcome is only a trustworthy replay when the incoming
   * mutation's `version` matches the `expectedVersion` recorded at cache
   * time — a mismatch (or a legacy row that predates the field, which
   * ALWAYS mismatches by design) means the client re-based and retried with
   * a corrected version, so the stale rejection must not be replayed as-is.
   *
   * On a mismatch: conditionally delete the cached row (guarded on it still
   * being that exact rejection — closes the TOCTOU against a concurrently
   * applied idempotency row) and re-run `applyOne` as a fresh attempt. On a
   * conditional-delete failure (something changed underneath since the
   * lookup above), replay whatever now occupies the key instead of assuming
   * either outcome.
   */
  private async replayIdempotencyRow(
    householdId: string,
    idemKey: string,
    m: PushMutationDto,
  ): Promise<ApplyOutcome | null> {
    const cached = await this.idem.lookup(idemKey);
    if (!cached) return null;
    const r = cached.response;
    if (r.status === 'applied') {
      // Race-loser path: B already committed and wrote the cache row.
      // A's response IS B's cached row (transparent idempotency).
      // A wrote no MutationLog row this request, so its outcome must
      // be 'replayed-applied' — the caller skips cursor advancement.
      return { kind: 'replayed-applied', applied: r };
    }
    if (cached.expectedVersion === m.version) {
      // True duplicate: same mutation id, same attempted version, still
      // rejected. Stable exact-replay (unchanged pre-existing behavior).
      return { kind: 'rejected', outcome: r };
    }
    const deleted = await this.idem.delete(idemKey, cached.expectedVersion);
    if (!deleted) {
      // Changed underneath (a concurrent request already applied or
      // re-cached this key) — replay whatever is there now rather than
      // assume the delete's intended outcome.
      const now = await this.idem.lookup(idemKey);
      if (!now) return null;
      return now.response.status === 'applied'
        ? { kind: 'replayed-applied', applied: now.response }
        : { kind: 'rejected', outcome: now.response };
    }
    // The stale rejection is gone; re-evaluate this mutation from scratch as
    // if this were its first attempt at the corrected version.
    return this.applyOne(householdId, idemKey, m);
  }

  /**
   * The preflight-driven counterpart of
   * {@link replayIdempotencyRow}. Preflight already determined this
   * mutation's cached row is a REJECTED outcome at a DIFFERENT
   * `expectedVersion` than the incoming one (`cachedExpectedVersion`, read at
   * preflight time) — conditionally delete that stale cache row (TOCTOU-safe:
   * only if it's STILL that exact rejection) and re-run `applyOne` as a fresh
   * attempt. On a conditional-delete failure (a concurrent request changed
   * the key between preflight's lookup and this delete), replay whatever now
   * occupies it; if the key is transiently empty (the concurrent racer
   * deleted it but hasn't rewritten yet), fall through to `applyOne` —
   * `applyOne`'s own idempotency-conflict handling reconciles a genuine
   * concurrent racer the same way it already does for two identical
   * never-cached requests.
   */
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
      // Additive read-only tombstone flag: the client's auto-repair reads
      // it to distinguish recreate-over-own-tombstone (safe) from a collision
      // with a live remote row. Null when the row is live or absent.
      currentDeletedAt: cur?.deletedAt ?? null,
    };
    // First-writer-wins cache write so a future replay returns a stable response even when two
    // racers share (h, d, m) but target different aggregates (a client bug pattern — the
    // idempotency contract treats any second use of the same mutationId as a duplicate of the
    // first). attribute_not_exists guards the race; on collision we swallow the cancel since
    // whichever row landed first is already a valid cache. `m.version` is stamped as the row's
    // `expectedVersion` so a later replay carrying a DIFFERENT (corrected) version can tell itself
    // apart from a true duplicate of this exact rejection.
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
        // Best-effort; collision = first-writer-wins (intended).
      });
    return { kind: 'rejected', outcome };
  }

  /**
   * Revive a tombstoned aggregate on a `create` whose
   * `attribute_not_exists` condition failed. Returns `null` for a LIVE row
   * (the caller falls through to the ordinary `CONFLICT`) or absent row (not
   * reachable here — `attribute_not_exists` can only fail when a row DOES
   * exist).
   *
   * Re-runs the FULL 3-item `TransactWriteItems` — the same
   * `buildApplyItems` shape (`AggregateVersion` Put + `MutationLog` append +
   * conditional `IdempotencyKey` Put) — with ONLY the `AggregateVersion`
   * condition swapped to require the EXACT tombstone version. **Never a bare
   * Put**: a bare Put would write just the counter row, dropping the
   * `MutationLog` append (a counter ahead of durable content — the exact
   * state this transaction exists to prevent) and the `IdempotencyKey` write
   * (breaking 7-day idempotency). The swapped condition is race-safe: a
   * concurrent write landing between the read below and this transaction
   * fails the condition, and the cancellation is reclassified via
   * `classifyTransactCancel` — an idempotency race replays through
   * {@link replayIdempotencyRow}; anything else re-delegates to
   * {@link handleCancel} so a losing revival gets one more attempt against
   * the now-current row (bounded by real concurrent racers, same as the
   * rest of this file's optimistic-retry paths).
   */
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
    // `deletedAt` is set to the row's `updatedAt` on a delete mutation and null
    // otherwise (see `buildApplyItems`); surface it so the rejection can carry
    // the tombstone flag.
    return { version: row.version, updatedAt: row.updatedAt, deletedAt: row.deletedAt ?? null };
  }

  private async currentCursor(householdId: string): Promise<string> {
    const meta = await this.meta.find(householdId);
    return meta?.mutationLogCursorBase ?? '0';
  }
}

/** Byte length of a mutation's payload, measured ONE way in this file —
 * {@link enforcePayloadSize}'s
 *  per-mutation 64 KB cap and the daily byte quota in `push()` both reuse
 *  this, so there is never a second notion of "payload bytes". */
function payloadBytes(m: PushMutationDto): number {
  return Buffer.byteLength(JSON.stringify(m.payload), 'utf8');
}

/** Enforces the per-mutation 64 KB cap and returns the measured byte count
 *  so the caller (`preflightBatch`) can reuse it for the daily byte quota. */
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

/**
 * Identify which TransactItems entry triggered the cancel.
 *
 * Index map mirrors `buildApplyItems` order:
 *   0 = aggregate-version conditional Put
 *   1 = mutation-log Put
 *   2 = idempotency-key conditional Put
 */
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
