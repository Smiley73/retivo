// Repository over the HouseholdKeyEnvelope table (SK ENVELOPE_META is the integrity row); the server stores slots opaquely and only
// enforces a monotonic envelopeSetVersion. Key material stays out of the compactor role by design.
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
 * Thrown when the stored `envelopeSetVersion` no longer equals the client expected predecessor; the controller maps
 * it to 409 STALE_ENVELOPE_VERSION.
 */
export class StaleEnvelopeVersionError extends Error {
  constructor(message = 'Envelope-set version is stale or non-monotonic') {
    super(message);
    this.name = 'StaleEnvelopeVersionError';
  }
}

/**
 * Thrown when the slot+meta transaction is cancelled for a transient reason that survives the bounded retry; mapped
 * to 503, so a blip never masquerades as another writer edit.
 */
export class EnvelopeTransactionConflictError extends Error {
  constructor(message = 'Envelope transaction could not commit; retry later') {
    super(message);
    this.name = 'EnvelopeTransactionConflictError';
  }
}

/**
 * Thrown when a password-slot write session write-authority ConditionCheck fails (no recorded revision, or one the
 * credential has moved past); mapped to 409 UPGRADE_REQUIRED.
 */
export class SessionCredentialStaleError extends Error {
  constructor(message = "Session's write authority is stale or missing") {
    super(message);
    this.name = 'SessionCredentialStaleError';
  }
}

/**
 * Thrown when a stable read cannot bracket a consistent `{ slots, meta }` within the bounded retry; mapped to 503
 * ENVELOPE_READ_CONFLICT rather than returning a torn pair the client HMAC check would take for tampering.
 */
export class EnvelopeReadConflictError extends Error {
  constructor(message = 'Envelope set could not be read consistently; retry later') {
    super(message);
    this.name = 'EnvelopeReadConflictError';
  }
}

const MAX_STABLE_READ_ATTEMPTS = 3;

// Concurrency of the per-row DeleteItem sweep: the api role has no BatchWriteItem here, and 25 is BatchWriteItem own
// per-request cap.
const DELETE_SWEEP_CONCURRENCY = 25;

/**
 * What a write is about to displace, from one consistent snapshot near commit time: the slot at the written id, the
 * live meta row, and every live slot id at that version.
 */
export interface EnvelopeArchiveInput {
  previousSlot: HouseholdKeyEnvelopeRow | undefined;
  previousMeta: EnvelopeMeta | null;
  previousSlotIds: readonly string[];
}

type EnvelopeMeta = {
  envelopeSetVersion: number;
  envelopeSetTag: string;
  /** Server ISO timestamp of the meta row last write, read by the account export. */
  updatedAt: string;
  /**
   * True only while a non-atomic `deleteAllForHousehold` sweep is mid-flight; `getStableEnvelopeSet` treats it as
   * torn.
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
   * Every live slot row, excluding the ENVELOPE_META sentinel and archive rows. `consistentRead` opts into a strongly
   * consistent Query. Archive rows share the partition and are unbounded within the retention window, so they are
   * skipped server-side with two key-condition ranges instead of paged through in JS.
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
        // The sentinel sorts inside the upper range, and DynamoDB rejects a key attribute in a FilterExpression.
        if (item.slotId === ENVELOPE_META_SLOT_ID) continue;
        // Unreachable given the two ranges; kept so a range mistake fails safe.
        if (isArchiveSlotId(item.slotId)) continue;
        out.push(item);
      }
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    return out;
  }

  /**
   * The per-household envelope-set integrity row, or null if none yet. `consistentRead` opts into a strongly consistent
   * GetItem.
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
      // Only surface the marker when set, so a stable snapshot never carries a stray `deletionInProgress: false`.
      ...(row.deletionInProgress ? { deletionInProgress: true } : {}),
    };
  }

  /**
   * Reads a consistent `{ slots, meta }` with no torn-read window: a consistent meta read, a consistent slot Query,
   * then a second meta read, accepted only when both agree on version and tag and neither sees `deletionInProgress`. A
   * mismatch retries with jittered backoff, then throws EnvelopeReadConflictError. The client HMAC-verifies the tag and
   * fails closed, so a torn read would look like tampering and lock the user out.
   */
  async getStableEnvelopeSet(
    householdId: string,
  ): Promise<{ slots: HouseholdKeyEnvelopeRow[]; meta: EnvelopeMeta | null }> {
    for (let attempt = 1; attempt <= MAX_STABLE_READ_ATTEMPTS; attempt++) {
      const metaBefore = await this.getEnvelopeMeta(householdId, true);
      const slots = await this.listSlots(householdId, true);
      const metaAfter = await this.getEnvelopeMeta(householdId, true);
      // A mid-flight household sweep can leave the slot set torn even when version and tag agree.
      const deletionInFlight =
        metaBefore?.deletionInProgress === true ||
        metaAfter?.deletionInProgress === true;
      // Slots with no meta sentinel are torn: markDeletionInProgress no-ops on an absent sentinel, so the marker cannot
      // fence this case.
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

  private metaEquals(a: EnvelopeMeta | null, b: EnvelopeMeta | null): boolean {
    if (a === null || b === null) return a === b;
    return (
      a.envelopeSetVersion === b.envelopeSetVersion &&
      a.envelopeSetTag === b.envelopeSetTag
    );
  }

  /** Puts (creates or replaces) a single slot row, written verbatim so optional attributes round-trip. */
  async upsertSlot(slot: HouseholdKeyEnvelopeRow): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: slot }),
    );
  }

  /**
   * Writes the meta row under a monotonic-version guard; `expectedVersion` null means no meta row yet.
   *
   * @throws {StaleEnvelopeVersionError} on a stale or non-monotonic bump.
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
    // First write guards on absence; later writes need a strictly higher version that matches the client expected
    // predecessor.
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
   * Builds the conditional meta-row write for the atomic transaction. Expected version 0 permits an absent row; later
   * writes require exact equality, so none skips a version. Exposed so the change-password commit reuses this one
   * version guard.
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
   * Builds archive Puts for what a write is about to displace (the previous slot and the previous ENVELOPE_META), to
   * append to the same TransactWriteItems so a crash cannot lose the predecessor. `previousMeta` and `previousSlotIds`
   * must come from one consistent read near commit time; the live meta condition fails the whole transaction if they
   * raced stale. `previousSlotIds` is stored as the archived meta membership manifest, which archived slot rows alone
   * cannot reconstruct.
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
   * Atomically upserts a slot and the conditional meta row. `extraConditionItems` appends ConditionChecks (the
   * password-slot upsert conditions on the Credential revision), and `archive` appends archive rows to the same
   * transaction.
   *
   * @throws {StaleEnvelopeVersionError} on a ConditionalCheckFailed meta cancellation (409).
   * @throws {EnvelopeTransactionConflictError} on a transient cancellation that survives the retry (503).
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
   * Atomically deletes a slot and writes the conditional meta row; same conflict mapping as `transactUpsertSlot`.
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
   * Atomic first-slot-set activation: every slot, the meta row and, for meta-only residue, the archive of that stale
   * meta, in one transaction at a single version bump, so no committed-but-incomplete state exists.
   * `extraConditionItems` goes after the slot and meta items and before the archive items, so `revisionCheckIndex` is
   * `slots.length + 1`; a wrong index would turn a stale-session rejection into STALE_ENVELOPE_VERSION instead of
   * UPGRADE_REQUIRED.
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
   * Builds the unconditional slot Put so the change-password commit can compose it with the meta item and the
   * credential ConditionCheck.
   */
  buildSlotPutTransactItem(
    slot: HouseholdKeyEnvelopeRow,
  ): NonNullable<
    ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
  >[number] {
    return { Put: { TableName: this.tableName, Item: slot } };
  }

  /**
   * Builds a ConditionCheck asserting no password slot exists, for the credential-only change-password commit of a
   * recovery-only household. Asserted in the same transaction, so a slot created meanwhile fails the change.
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

  // Maps cancellations per item through runTransactWrite: a meta ConditionalCheckFailed is a real version conflict
  // (409), a failure at `revisionCheckIndex` is SessionCredentialStaleError (409), and a transient reason that
  // survives the retry becomes EnvelopeTransactionConflictError (503).
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

  async deleteSlot(householdId: string, slotId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { householdId, slotId },
      }),
    );
  }

  // No-ops on an absent meta row: attribute_exists turns the would-be upsert into a swallowed ConditionalCheckFailed,
  // not a stray marker row.
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
   * Hard-deletes every row for a household (slots, archives, sentinel) for account deletion and the workspace reset.
   * The api role has no BatchWriteItem here, so rows go one DeleteItem each, concurrently. Not atomic, so it stamps
   * `deletionInProgress` first and deletes the sentinel last: a racing `getStableEnvelopeSet` fails closed, and an
   * interrupted sweep stays fail-closed until a retry completes it.
   */
  async deleteAllForHousehold(householdId: string): Promise<void> {
    await this.markDeletionInProgress(householdId);
    let metaKey:
      | Pick<HouseholdKeyEnvelopeRow, 'householdId' | 'slotId'>
      | undefined;
    let lastKey: Record<string, unknown> | undefined;
    do {
      // Strongly consistent: a missed recently committed slot would be orphaned once the sentinel is deleted, and a
      // later stable read would return it as a consistent empty set.
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
      // Delete the sentinel last so the marker stays visible while slot rows are removed.
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
