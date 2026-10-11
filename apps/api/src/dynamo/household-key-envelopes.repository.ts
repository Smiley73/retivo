/**
 * Repository over the dedicated `HouseholdKeyEnvelope` table. PK `householdId`, SK `slotId`. Slot
 * rows hold wrapped household-data-key material; SK = `ENVELOPE_META` holds the per-household
 * envelope-set integrity row.
 *
 * The server stores everything OPAQUELY: it never unwraps, decrypts, or
 * logs `wrappedKey`, and it never recomputes or validates the
 * `envelopeSetTag` HMAC (it holds no household data key). Its only active
 * role is enforcing a monotonic `envelopeSetVersion` on write so a stale
 * client cannot roll the set version backwards.
 *
 * Out of the compactor's privilege boundary by design — key material must
 * never enter the snapshot-compaction role.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { BaseRepository } from './base.repository.js';
import {
  backoffMs,
  runTransactWrite,
  sleep,
  TransientTransactionError,
} from './transact-write.js';
import {
  ARCHIVE_SLOT_ID_LOWER_BOUND,
  ARCHIVE_SLOT_ID_UPPER_BOUND,
  archiveExpiresAt,
  archiveMetaSlotId,
  archiveSlotId,
  ENVELOPE_META_SLOT_ID,
  isArchiveSlotId,
  PASSWORD_SLOT_ID,
  type HouseholdEnvelopeMetaArchiveRow,
  type HouseholdEnvelopeMetaRow,
  type HouseholdKeyEnvelopeRow,
} from './types.js';

/**
 * Thrown when the atomic slot+meta transaction is rejected because the stored
 * `envelopeSetVersion` no longer equals the client's expected predecessor
 * (a stale / non-monotonic bump, or another writer won). The controller maps
 * this to `409 STALE_ENVELOPE_VERSION`.
 */
export class StaleEnvelopeVersionError extends Error {
  constructor(message = 'Envelope-set version is stale or non-monotonic') {
    super(message);
    this.name = 'StaleEnvelopeVersionError';
  }
}

/**
 * Thrown when the atomic slot+meta transaction is cancelled for a TRANSIENT
 * reason (a `TransactionConflict` or throughput/throttling code) that survives
 * a bounded retry — never a `ConditionalCheckFailed` (that is a real
 * version conflict, {@link StaleEnvelopeVersionError}). The controller maps
 * this to a `503`, so a network/throughput blip can never masquerade as
 * another writer's edit.
 */
export class EnvelopeTransactionConflictError extends Error {
  constructor(message = 'Envelope transaction could not commit; retry later') {
    super(message);
    this.name = 'EnvelopeTransactionConflictError';
  }
}

/**
 * Thrown when a password-slot write's session write-authority `ConditionCheck`
 * fails — the caller's session carries no
 * recorded credential revision, or one the credential row has since moved
 * past (a rotation landed between the session's issuance and this write). The
 * controller maps this to `409 UPGRADE_REQUIRED` — the same status the
 * version-conflict case (`StaleEnvelopeVersionError`) returns.
 */
export class SessionCredentialStaleError extends Error {
  constructor(message = "Session's write authority is stale or missing") {
    super(message);
    this.name = 'SessionCredentialStaleError';
  }
}

/**
 * Thrown when a stable envelope-set read cannot bracket a consistent
 * `{ slots, meta }` snapshot within the bounded retry: an atomic slot+meta
 * write kept landing between the two consistent meta reads, so every attempt
 * saw the meta version/tag change mid-read. The controller maps this to a
 * `503 ENVELOPE_READ_CONFLICT` rather than ever returning a torn pair (old
 * slots with new meta, or vice versa) that the client's HMAC verification
 * would mistake for tampering and fail closed on.
 */
export class EnvelopeReadConflictError extends Error {
  constructor(message = 'Envelope set could not be read consistently; retry later') {
    super(message);
    this.name = 'EnvelopeReadConflictError';
  }
}

/** Bounded attempts for the bracketed stable-set read. */
const MAX_STABLE_READ_ATTEMPTS = 3;

/**
 * Fan-out of the per-row `DeleteItem` sweep in {@link
 * HouseholdKeyEnvelopesRepository.deleteAllForHousehold}. The api role holds no `BatchWriteItem` on
 * this table, so rows go one `DeleteItem` each — but nothing says they must go one AT A TIME. 25 is
 * `BatchWriteItem`'s own per-request cap: the sweep never has more in flight than a batch write
 * would have issued at once.
 */
const DELETE_SWEEP_CONCURRENCY = 25;

/**
 * What an envelope write is about to displace,
 * all three taken from ONE consistent snapshot read close to commit time:
 * the slot at the written id (absent for a brand-new id), the live meta row
 * (absent before first activation), and the id of every live slot at that
 * version — see {@link HouseholdKeyEnvelopesRepository.buildArchiveTransactItems}.
 */
export interface EnvelopeArchiveInput {
  previousSlot: HouseholdKeyEnvelopeRow | undefined;
  previousMeta: EnvelopeMeta | null;
  previousSlotIds: readonly string[];
}

type EnvelopeMeta = {
  envelopeSetVersion: number;
  envelopeSetTag: string;
  /** Server ISO timestamp of the meta row's last write (the account export
   *  reads this alongside `envelopeSetVersion`; every other caller ignores it). */
  updatedAt: string;
  /**
   * `true` only while a non-atomic {@link HouseholdKeyEnvelopesRepository.deleteAllForHousehold}
   * sweep is mid-flight. {@link HouseholdKeyEnvelopesRepository.getStableEnvelopeSet}
   * treats it as a torn read; the standalone version/tag callers ignore it.
   */
  deletionInProgress?: boolean;
};

@Injectable()
export class HouseholdKeyEnvelopesRepository extends BaseRepository {
  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_HOUSEHOLD_KEY_ENVELOPE');
  }

  /**
   * Every LIVE slot row for a household, excluding the ENVELOPE_META sentinel
   * and every archive row. `consistentRead` opts into a strongly-consistent
   * `Query` (used by the stable-set bracketing read); the default
   * eventually-consistent read is fine for the standalone callers.
   *
   * Archive rows share this partition but are
   * never a live unlock path, and nothing bounds how many a household holds
   * inside the retention window — every displacing write appends one or two,
   * at whatever rate the write throttle allows. Dropping them in JS after a
   * partition-wide Query would make every live-set read — the GET, the
   * stable-set bracket, and the snapshot read every write starts with — page
   * through all of them. DynamoDB permits exactly one
   * range condition on the sort key, so the archive range is skipped
   * SERVER-SIDE with two key-condition Queries — everything below the
   * `ARCHIVE#` namespace and everything at/after its upper bound — run in
   * parallel; each reads only live rows (plus the sentinel), so the cost
   * scales with the live slot count alone, however many versions are archived.
   * Row order is unchanged from the single Query (sort-key order, archives
   * removed).
   */
  async listSlots(
    householdId: string,
    consistentRead = false,
  ): Promise<HouseholdKeyEnvelopeRow[]> {
    const [belowArchive, aboveArchive] = await Promise.all([
      this.queryLiveRange(
        'householdId = :h AND slotId < :lo',
        { ':h': householdId, ':lo': ARCHIVE_SLOT_ID_LOWER_BOUND },
        consistentRead,
      ),
      this.queryLiveRange(
        'householdId = :h AND slotId >= :hi',
        { ':h': householdId, ':hi': ARCHIVE_SLOT_ID_UPPER_BOUND },
        consistentRead,
      ),
    ]);
    return [...belowArchive, ...aboveArchive];
  }

  /** One paginated sort-key range of {@link listSlots}. */
  private async queryLiveRange(
    keyCondition: string,
    values: Record<string, string>,
    consistentRead: boolean,
  ): Promise<HouseholdKeyEnvelopeRow[]> {
    const out: HouseholdKeyEnvelopeRow[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: keyCondition,
          ExpressionAttributeValues: values,
          ExclusiveStartKey: lastKey,
          ...(consistentRead ? { ConsistentRead: true } : {}),
        }),
      );
      for (const item of (r.Items as HouseholdKeyEnvelopeRow[] | undefined) ?? []) {
        // The sentinel (`slotId = ENVELOPE_META`) sorts inside the upper
        // range; DynamoDB rejects a key attribute in a FilterExpression, so
        // it is dropped here.
        if (item.slotId === ENVELOPE_META_SLOT_ID) continue;
        // Unreachable given the two ranges — kept so a future range mistake
        // fails safe: an archive row must never reach a live-set caller (the
        // GET response, account export, the controller's own eligibility
        // and archive reads).
        if (isArchiveSlotId(item.slotId)) continue;
        out.push(item);
      }
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    return out;
  }

  /**
   * The per-household envelope-set integrity row, or null if none yet.
   * `consistentRead` opts into a strongly-consistent `GetItem` (used by the
   * stable-set bracketing read).
   */
  async getEnvelopeMeta(
    householdId: string,
    consistentRead = false,
  ): Promise<EnvelopeMeta | null> {
    const r = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { householdId, slotId: ENVELOPE_META_SLOT_ID },
        ...(consistentRead ? { ConsistentRead: true } : {}),
      }),
    );
    const row = r.Item as HouseholdEnvelopeMetaRow | undefined;
    if (!row) return null;
    return {
      envelopeSetVersion: row.envelopeSetVersion,
      envelopeSetTag: row.envelopeSetTag,
      updatedAt: row.updatedAt,
      // Only surface the marker when set, so a stable snapshot never carries a
      // stray `deletionInProgress: false` back to the controller/client.
      ...(row.deletionInProgress ? { deletionInProgress: true } : {}),
    };
  }

  /**
   * Read a CONSISTENT `{ slots, meta }` snapshot with no torn-read window.
   * `GET /auth/key-envelopes` previously issued two independent,
   * eventually-consistent reads (a slot `Query` + a meta `GetItem`) with no
   * consistency bracket, so a concurrent atomic slot+meta write
   * ({@link transactUpsertSlot}/{@link transactDeleteSlot}) landing mid-read
   * could hand the client old slots paired with a new meta version/tag (or the
   * reverse). The client HMAC-verifies the tag over the returned slots+version
   * and fails CLOSED on a mismatch, so a torn read looks like tampering — a
   * false lockout from nothing worse than unlucky timing.
   *
   * The read is bracketed: a strongly-consistent meta read, a
   * strongly-consistent slot `Query`, then a second strongly-consistent meta
   * read. The snapshot is accepted only when the two meta reads agree on
   * version + tag (proving no write committed between them). A mismatch means a
   * write landed mid-read; the whole sequence retries a bounded number of times
   * with the shared jittered backoff ({@link backoffMs}). If still torn after
   * the bound, {@link EnvelopeReadConflictError} is thrown (mapped to a `503`)
   * rather than ever returning an inconsistent pair.
   *
   * The version/tag bracket alone does NOT close the race against the separate,
   * non-atomic {@link deleteAllForHousehold} sweep: that sweep removes
   * individual slot rows without bumping the meta version/tag, so both meta
   * reads can agree while the slot `Query` observes a partially-deleted set.
   * `deleteAllForHousehold` therefore stamps the meta sentinel
   * `deletionInProgress` before removing any row and deletes the sentinel last;
   * a bracket that observes the marker on either meta read treats the set as
   * torn and fails closed exactly like a version mismatch. Once the sweep fully
   * completes the meta row is gone, so both reads see `null` and a genuinely
   * consistent empty snapshot is returned.
   *
   * A `null` meta bracket is trusted as that consistent empty snapshot ONLY when
   * the slot `Query` also saw zero rows. Slots present with no meta sentinel at
   * all is never a valid stable set: `markDeletionInProgress` is a conditional
   * `UpdateItem` that no-ops when the sentinel is already absent, so the marker
   * fence can't catch a set that holds slot rows but no sentinel. Such a bracket
   * is treated as torn (retry, then {@link EnvelopeReadConflictError}) rather
   * than handing back `{ slots: [...], meta: null }` the client's tag can't cover.
   */
  async getStableEnvelopeSet(
    householdId: string,
  ): Promise<{ slots: HouseholdKeyEnvelopeRow[]; meta: EnvelopeMeta | null }> {
    for (let attempt = 1; attempt <= MAX_STABLE_READ_ATTEMPTS; attempt++) {
      const metaBefore = await this.getEnvelopeMeta(householdId, true);
      const slots = await this.listSlots(householdId, true);
      const metaAfter = await this.getEnvelopeMeta(householdId, true);
      // A mid-flight household-sweep marker means the slot set may be torn even
      // when version/tag agree — treat it as a conflict, never a stable set.
      const deletionInFlight =
        metaBefore?.deletionInProgress === true ||
        metaAfter?.deletionInProgress === true;
      // A `null === null` meta bracket is only a genuinely-consistent EMPTY set
      // when the slot Query also observed zero rows. Slots present with no meta
      // sentinel at all is torn: `markDeletionInProgress` is a conditional
      // UpdateItem that no-ops when the sentinel is already absent, so a sweep
      // that raced past (or a household that somehow holds slot rows without a
      // sentinel) is never fenced by the deletion marker. Returning
      // `{ slots: [...], meta: null }` would hand the client slots the tag can't
      // cover; fail closed like any other torn read.
      const tornEmptyMetaWithSlots =
        metaBefore === null && metaAfter === null && slots.length > 0;
      if (
        !deletionInFlight &&
        !tornEmptyMetaWithSlots &&
        this.metaEquals(metaBefore, metaAfter)
      ) {
        return { slots, meta: metaAfter };
      }
      if (attempt < MAX_STABLE_READ_ATTEMPTS) await sleep(backoffMs(attempt));
    }
    throw new EnvelopeReadConflictError();
  }

  /** Two meta reads bracket a stable set iff they agree on version + tag. */
  private metaEquals(a: EnvelopeMeta | null, b: EnvelopeMeta | null): boolean {
    if (a === null || b === null) return a === b;
    return (
      a.envelopeSetVersion === b.envelopeSetVersion &&
      a.envelopeSetTag === b.envelopeSetTag
    );
  }

  /**
   * Put (create or replace) a single slot row. Server stores it opaquely. The
   * whole `HouseholdKeyEnvelopeRow` is written verbatim, so every optional
   * attribute (`kdf`, `prfSalt`, `credentialBinding`) round-trips through write
   * and `listSlots` (which projects no subset) without per-field handling.
   */
  async upsertSlot(slot: HouseholdKeyEnvelopeRow): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: slot }),
    );
  }

  /**
   * Conditionally write the envelope-set meta row under a monotonic-version
   * guard: reject if the stored `envelopeSetVersion` is already >= the
   * proposed one. `expectedVersion` is the version the client believed was
   * stored; `null` means "no meta row yet".
   *
   * @throws {StaleEnvelopeVersionError} on a stale / non-monotonic bump.
   */
  async putEnvelopeMeta(
    householdId: string,
    envelopeSetVersion: number,
    envelopeSetTag: string,
    expectedVersion: number | null,
  ): Promise<void> {
    const row: HouseholdEnvelopeMetaRow = {
      householdId,
      slotId: ENVELOPE_META_SLOT_ID,
      envelopeSetVersion,
      envelopeSetTag,
      updatedAt: new Date().toISOString(),
    };
    // First write (no meta row yet): guard on absence. Subsequent writes:
    // guard that the proposed version strictly exceeds the stored one AND
    // matches the client's expected predecessor (optimistic concurrency).
    const condition =
      expectedVersion === null
        ? 'attribute_not_exists(slotId)'
        : 'envelopeSetVersion < :v AND envelopeSetVersion = :expected';
    const values: Record<string, number> =
      expectedVersion === null
        ? { ':v': envelopeSetVersion }
        : { ':v': envelopeSetVersion, ':expected': expectedVersion };
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: row,
          ConditionExpression: condition,
          ...(expectedVersion === null
            ? {}
            : { ExpressionAttributeValues: values }),
        }),
      );
    } catch (err) {
      if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') {
        throw new StaleEnvelopeVersionError();
      }
      throw err;
    }
  }

  /**
   * Build the conditional meta-row write parts for the atomic transaction.
   * Expected version zero permits an absent meta row (the first
   * write); every later write conditions on exact equality with the stored
   * `envelopeSetVersion`, so no write may skip a version and a stale/lost race
   * fails closed. Exposed (not `private`) so the cross-table change-password
   * commit reuses this single definition of the
   * version guard rather than hand-rolling a second one.
   */
  buildMetaPutTransactItem(
    householdId: string,
    envelopeSetVersion: number,
    envelopeSetTag: string,
    expectedVersion: number,
  ): NonNullable<
    ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
  >[number] {
    const row: HouseholdEnvelopeMetaRow = {
      householdId,
      slotId: ENVELOPE_META_SLOT_ID,
      envelopeSetVersion,
      envelopeSetTag,
      updatedAt: new Date().toISOString(),
    };
    if (expectedVersion === 0) {
      return {
        Put: {
          TableName: this.tableName,
          Item: row,
          ConditionExpression: 'attribute_not_exists(slotId)',
        },
      };
    }
    return {
      Put: {
        TableName: this.tableName,
        Item: row,
        ConditionExpression: 'envelopeSetVersion = :expected',
        ExpressionAttributeValues: { ':expected': expectedVersion },
      },
    };
  }

  /**
   * Build the archive `Put` transact items for whatever a write is about to
   * displace: the previous slot row, when one is
   * supplied (a replace/delete — never a brand-new slot id), and the previous
   * `ENVELOPE_META` row, when one exists (every write past first activation).
   * Both are namespaced under {@link archiveSlotId}/{@link archiveMetaSlotId}
   * so they never collide with a live row or an earlier archived version of
   * the same slot, and stamped with a 30-day `expiresAt` TTL
   * ({@link archiveExpiresAt}).
   * Returned items are meant to be appended to the SAME `TransactWriteItems`
   * as the live write, so a crash/timeout can never leave a write committed
   * with its predecessor state lost.
   *
   * `previousMeta` and `previousSlotIds` must come from the SAME snapshot,
   * read immediately before the caller builds its transaction (a consistent
   * read, close to commit time) — the live meta write's own
   * `ConditionExpression` (checked in the SAME transaction) still guards
   * against archiving a value that raced out of date: if another writer
   * landed between that read and this transaction, the meta condition fails
   * and NOTHING in the transaction commits, archive rows included.
   *
   * `previousSlotIds` — every LIVE slot id at `previousMeta.envelopeSetVersion` —
   * is stamped onto the archived meta row as its membership manifest
   * ({@link HouseholdEnvelopeMetaArchiveRow.slotIds}): the
   * archived slot rows alone record only what a later write displaced, which
   * is not enough to reconstruct the exact slot set the archived tag was
   * computed over.
   */
  buildArchiveTransactItems(
    householdId: string,
    previousSlot: HouseholdKeyEnvelopeRow | undefined,
    previousMeta: EnvelopeMeta | null,
    previousSlotIds: readonly string[],
  ): NonNullable<
    ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
  > {
    if (!previousMeta) return []; // First activation — nothing existed to displace.
    const expiresAt = archiveExpiresAt();
    const items: NonNullable<
      ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
    > = [];
    if (previousSlot) {
      items.push({
        Put: {
          TableName: this.tableName,
          Item: {
            ...previousSlot,
            slotId: archiveSlotId(previousMeta.envelopeSetVersion, previousSlot.slotId),
            expiresAt,
          },
        },
      });
    }
    const archivedMeta: HouseholdEnvelopeMetaArchiveRow = {
      householdId,
      slotId: archiveMetaSlotId(previousMeta.envelopeSetVersion),
      envelopeSetVersion: previousMeta.envelopeSetVersion,
      envelopeSetTag: previousMeta.envelopeSetTag,
      updatedAt: previousMeta.updatedAt,
      slotIds: [...previousSlotIds],
      expiresAt,
    };
    items.push({ Put: { TableName: this.tableName, Item: archivedMeta } });
    return items;
  }

  /**
   * Atomic slot upsert: the slot PUT and the conditional envelope-set
   * meta PUT commit together or not at all, closing the crash/timeout window
   * that could otherwise strand a slot under a version the set never advanced
   * to. The meta write conditions on the exact expected predecessor version.
   *
   * `extraConditionItems`: additional
   * `ConditionCheck` items appended after the slot + meta items — used by the
   * `password`-type slot upsert to condition the write on the caller's session
   * still carrying the credential's current revision (a `ConditionCheck` on
   * the `Credential` row), so a superseded session's write fails as a
   * condition of this same transaction rather than a preceding read.
   *
   * `archive`, when supplied, appends the
   * {@link buildArchiveTransactItems} rows to the SAME transaction.
   *
   * @throws {StaleEnvelopeVersionError} on a `ConditionalCheckFailed` meta
   *   cancellation (stale / non-monotonic version, lost race) → `409`.
   * @throws {EnvelopeTransactionConflictError} on a transient cancellation that
   *   survives the bounded retry → `503`.
   */
  async transactUpsertSlot(args: {
    slot: HouseholdKeyEnvelopeRow;
    envelopeSetVersion: number;
    envelopeSetTag: string;
    expectedVersion: number;
    extraConditionItems?: NonNullable<
      ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
    >;
    archive?: EnvelopeArchiveInput;
  }): Promise<void> {
    await this.runSlotMetaTransaction(
      [
        { Put: { TableName: this.tableName, Item: args.slot } },
        this.buildMetaPutTransactItem(
          args.slot.householdId,
          args.envelopeSetVersion,
          args.envelopeSetTag,
          args.expectedVersion,
        ),
        ...(args.extraConditionItems ?? []),
        ...(args.archive
          ? this.buildArchiveTransactItems(
              args.slot.householdId,
              args.archive.previousSlot,
              args.archive.previousMeta,
              args.archive.previousSlotIds,
            )
          : []),
      ],
      args.extraConditionItems?.length ? 2 : undefined,
    );
  }

  /**
   * Atomic slot delete: the slot DELETE and the conditional
   * envelope-set meta PUT commit together or not at all, so a stale delete can
   * never remove a slot while the set version fails to advance. Same conflict /
   * transient mapping as {@link transactUpsertSlot}. `archive`, when supplied,
   * appends the {@link buildArchiveTransactItems} rows to the same transaction.
   */
  async transactDeleteSlot(args: {
    householdId: string;
    slotId: string;
    envelopeSetVersion: number;
    envelopeSetTag: string;
    expectedVersion: number;
    archive?: EnvelopeArchiveInput;
  }): Promise<void> {
    await this.runSlotMetaTransaction([
      {
        Delete: {
          TableName: this.tableName,
          Key: { householdId: args.householdId, slotId: args.slotId },
        },
      },
      this.buildMetaPutTransactItem(
        args.householdId,
        args.envelopeSetVersion,
        args.envelopeSetTag,
        args.expectedVersion,
      ),
      ...(args.archive
        ? this.buildArchiveTransactItems(
            args.householdId,
            args.archive.previousSlot,
            args.archive.previousMeta,
            args.archive.previousSlotIds,
          )
        : []),
    ]);
  }

  /**
   * Atomic first-slot-set activation: every
   * slot the device is activating with, the meta row, and — for meta-only
   * residue (`slots: [], envelopeSetVersion: N > 0`) — the archive of
   * that stale meta row, all in ONE transaction at a SINGLE version bump.
   * Replaces the two-PUT activation (a `password` PUT, then a separate
   * `recovery` PUT) whose intermediate committed-but-incomplete state the old
   * step-up matrix used to exempt outright — that exemption is gone, so
   * activation must never leave such a state to exempt.
   *
   * `extraConditionItems` (mirrors {@link transactUpsertSlot}) is placed
   * immediately after the slot Put items + the meta item, BEFORE any archive
   * items — so `revisionCheckIndex` (a positional index into the same item
   * list `runSlotMetaTransaction` maps failures against) is `slots.length + 1`
   * exactly when a `password` slot is present, never the fixed `2` a
   * single-slot upsert uses. Getting this wrong turns a stale-session
   * rejection into a misleading `STALE_ENVELOPE_VERSION` (the meta item's own
   * failure code) instead of the correct `UPGRADE_REQUIRED`.
   */
  async transactActivateSlots(args: {
    householdId: string;
    slots: HouseholdKeyEnvelopeRow[];
    envelopeSetVersion: number;
    envelopeSetTag: string;
    expectedVersion: number;
    extraConditionItems?: NonNullable<
      ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
    >;
    archive?: EnvelopeArchiveInput;
  }): Promise<void> {
    const slotItems = args.slots.map((slot) => this.buildSlotPutTransactItem(slot));
    await this.runSlotMetaTransaction(
      [
        ...slotItems,
        this.buildMetaPutTransactItem(
          args.householdId,
          args.envelopeSetVersion,
          args.envelopeSetTag,
          args.expectedVersion,
        ),
        ...(args.extraConditionItems ?? []),
        ...(args.archive
          ? this.buildArchiveTransactItems(
              args.householdId,
              args.archive.previousSlot,
              args.archive.previousMeta,
              args.archive.previousSlotIds,
            )
          : []),
      ],
      args.extraConditionItems?.length ? slotItems.length + 1 : undefined,
    );
  }

  /**
   * Build the slot-row `Put` transact item alone, with no condition.
   * Exposed so the cross-table change-password
   * commit composes it alongside the meta item and the credential
   * write-authority `ConditionCheck` in one transaction, reusing this
   * repository's item shape rather than hand-rolling it.
   */
  buildSlotPutTransactItem(
    slot: HouseholdKeyEnvelopeRow,
  ): NonNullable<
    ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
  >[number] {
    return { Put: { TableName: this.tableName, Item: slot } };
  }

  /**
   * Build a `ConditionCheck` asserting NO `password`-type slot exists at the
   * canonical slot id for `householdId`. Used
   * ONLY inside the credential-only change-password commit for a
   * server-confirmed no-slot (recovery-only) household — the absence is
   * asserted as a condition of that same transaction, never a preceding read,
   * so a slot created between the eligibility check and the commit fails the
   * whole change rather than leaving a new login password beside a slot still
   * wrapped under the old one.
   */
  buildPasswordSlotAbsenceCheckTransactItem(
    householdId: string,
  ): NonNullable<
    ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
  >[number] {
    return {
      ConditionCheck: {
        TableName: this.tableName,
        Key: { householdId, slotId: PASSWORD_SLOT_ID },
        ConditionExpression: 'attribute_not_exists(slotId)',
      },
    };
  }

  /**
   * Send a slot+meta transaction via the shared {@link runTransactWrite} runner,
   * which decodes `TransactionCanceledException.CancellationReasons`
   * per item rather than name-catching `ConditionalCheckFailedException` (which
   * a transaction never throws directly) and applies the bounded transient
   * retry with jittered backoff. The slot item carries no
   * `ConditionExpression`; the meta write maps a
   * `ConditionalCheckFailed` to a real version conflict (409,
   * {@link StaleEnvelopeVersionError}). `revisionCheckIndex`,
   * when supplied, names the index of an
   * appended credential write-authority `ConditionCheck` item — a failure
   * there maps to {@link SessionCredentialStaleError} (409) instead. A
   * transient reason that survives the retry is re-wrapped at this repository
   * boundary as {@link EnvelopeTransactionConflictError} (503), the type the
   * controller catches — never a business conflict.
   */
  private async runSlotMetaTransaction(
    transactItems: NonNullable<
      ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
    >,
    revisionCheckIndex?: number,
  ): Promise<void> {
    try {
      await runTransactWrite(this.doc, transactItems, (reasons) => {
        if (
          revisionCheckIndex !== undefined &&
          reasons[revisionCheckIndex]?.Code === 'ConditionalCheckFailed'
        ) {
          throw new SessionCredentialStaleError();
        }
        throw new StaleEnvelopeVersionError();
      });
    } catch (err) {
      if (err instanceof TransientTransactionError) {
        throw new EnvelopeTransactionConflictError();
      }
      throw err;
    }
  }

  /** Delete a single slot row. */
  async deleteSlot(householdId: string, slotId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { householdId, slotId },
      }),
    );
  }

  /**
   * Conditionally stamp the ENVELOPE_META sentinel `deletionInProgress`.
   * A no-op when no meta row exists (already deleted / never created) — the
   * `attribute_exists(slotId)` guard turns the would-be upsert into a
   * `ConditionalCheckFailed`, which is swallowed rather than creating a stray
   * marker row. Called at the START of {@link deleteAllForHousehold} so a
   * concurrent {@link getStableEnvelopeSet} bracket sees the marker and fails
   * closed instead of trusting a partially-swept slot set.
   */
  private async markDeletionInProgress(householdId: string): Promise<void> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { householdId, slotId: ENVELOPE_META_SLOT_ID },
          UpdateExpression: 'SET deletionInProgress = :true',
          ConditionExpression: 'attribute_exists(slotId)',
          ExpressionAttributeValues: { ':true': true },
        }),
      );
    } catch (err) {
      if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') {
        return; // No meta sentinel to stamp — nothing to sweep either.
      }
      throw err;
    }
  }

  /**
   * Hard-delete every row for a household (all slots + the ENVELOPE_META
   * sentinel). Used by account deletion and the encrypted-workspace reset
   * household-sweep.
   *
   * Uses individual `DeleteItem` calls rather than `BatchWriteItem`: the api-role IAM policy grants
   * only `GetItem`/`PutItem`/`Query`/`UpdateItem`/ `DeleteItem` on this table, so `BatchWriteItem`
   * would fail `AccessDenied`. The live rows are a handful (slots + one meta sentinel), but the
   * archive rows this sweep must also remove (every displacing write appends one or two, reaped
   * only by the retention TTL) are unbounded within the window, so the per-row deletes are issued
   * {@link DELETE_SWEEP_CONCURRENCY} at a time rather than strictly one after another.
   *
   * The sweep is NOT atomic, so it fences a concurrent {@link getStableEnvelopeSet}:
   * it first stamps the meta sentinel `deletionInProgress`, then deletes
   * every slot row, and deletes the sentinel LAST. The marker is therefore
   * visible for the entire window in which the slot set is partially deleted, so
   * a racing stable read fails closed (`503`) rather than returning a torn
   * partial-slot snapshot. Deleting the sentinel last also means an interrupted
   * sweep leaves the marker set (still fail-closed) until a retry completes it.
   */
  async deleteAllForHousehold(householdId: string): Promise<void> {
    await this.markDeletionInProgress(householdId);
    let metaKey:
      | Pick<HouseholdKeyEnvelopeRow, 'householdId' | 'slotId'>
      | undefined;
    let lastKey: Record<string, unknown> | undefined;
    do {
      // Strongly-consistent: an eventually-consistent enumeration could
      // miss a recently-committed slot row and leave it behind after the
      // sentinel is deleted last, stranding an orphan slot with no meta row. A
      // later getStableEnvelopeSet would then read both meta brackets as null
      // (meta genuinely gone) and hand back that orphan as a "consistent" empty
      // set — the exact torn state the sentinel guards against, via a missed
      // row rather than a racing writer. This sweep has to enumerate the whole
      // partition (archives included) regardless, so the strong read adds no
      // extra pass.
      const r = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'householdId = :h',
          ExpressionAttributeValues: { ':h': householdId },
          ProjectionExpression: 'householdId, slotId',
          ExclusiveStartKey: lastKey,
          ConsistentRead: true,
        }),
      );
      const rows =
        (r.Items as Pick<HouseholdKeyEnvelopeRow, 'householdId' | 'slotId'>[] | undefined) ??
        [];
      // Defer the sentinel to the very end so the deletion marker stays
      // visible while the slot rows are being removed.
      metaKey ??= rows.find((row) => row.slotId === ENVELOPE_META_SLOT_ID);
      const keys = rows.filter((row) => row.slotId !== ENVELOPE_META_SLOT_ID);
      for (let i = 0; i < keys.length; i += DELETE_SWEEP_CONCURRENCY) {
        await Promise.all(
          keys.slice(i, i + DELETE_SWEEP_CONCURRENCY).map((row) =>
            this.doc.send(
              new DeleteCommand({
                TableName: this.tableName,
                Key: { householdId: row.householdId, slotId: row.slotId },
              }),
            ),
          ),
        );
      }
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    if (metaKey) {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { householdId: metaKey.householdId, slotId: metaKey.slotId },
        }),
      );
    }
  }
}
