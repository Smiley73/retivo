// Call `queueLocalMutation()` after updating the local aggregate store; it appends to the pending mutation queue.
import {
  putAggregate,
  queueMutation,
  replaceQueueMutationsAtomically,
  writeAccountWithRetypeGuard,
  type Batch,
  type GuardedAccountWrite,
} from '../db/store.js';
import { currentSchemaVersion } from '../db/migrations.js';
import { cryptoUuid } from '../lib/crypto-uuid.js';
import type {
  Aggregate,
  AggregateType,
  AccountBalancePayload,
  AccountPayload,
  PendingMutation,
} from '../db/types.js';
import { getRegisteredDeviceId } from './device-id.js';

// Strictly monotonic logical clock for queued-mutation timestamps. Flush order sorts by `timestamp`, so a
// same-millisecond tie would let the random-UUID key order an update before its create. Wall-clock anchored across
// module reloads (the counter resets to 0 and the next stamp is >= Date.now()); a reload inside the same millisecond as
// a queued edit is accepted as unreachable.
let lastQueuedTimestamp = 0;

interface QueueArgs<T extends Record<string, unknown>> {
  type: AggregateType;
  aggregateId: string;
  householdId: string;
  operation: 'create' | 'update' | 'delete';
  expectedVersion: number;
  payload: T;
}

export async function queueLocalMutation<T extends Record<string, unknown>>(
  args: QueueArgs<T>,
  batch?: Batch,
): Promise<PendingMutation> {
  // SyncProvider registers the canonical deviceId at mount; throw early rather than queue with no device id, which the
  // API would reject.
  const deviceId = getRegisteredDeviceId();
  if (!deviceId) {
    throw new Error(
      'queueLocalMutation called before SyncProvider registered the device id.',
    );
  }
  const schemaVersion = currentSchemaVersion(args.type);
  const id = cryptoUuid();
  const timestamp = Math.max(Date.now(), lastQueuedTimestamp + 1);
  lastQueuedTimestamp = timestamp;
  const mutation: PendingMutation = {
    id,
    aggregateId: args.aggregateId,
    aggregateType: args.type,
    operation: args.operation,
    expectedVersion: args.expectedVersion,
    schemaVersion,
    payload: args.payload,
    timestamp,
    deviceId,
    status: 'pending',
  };

  // Reflect the mutation in the local store so reads see it at once; `expectedVersion + 1` keeps edits-before-sync from
  // targeting the same version.
  if (args.operation !== 'delete') {
    const aggregate: Aggregate = {
      id: args.aggregateId,
      householdId: args.householdId,
      schemaVersion,
      version: args.expectedVersion + 1,
      updatedAt: new Date(mutation.timestamp).toISOString(),
      deviceId,
      aggregateType: args.type,
      payload: args.payload,
    };
    await putAggregate(args.type, aggregate, batch);
  } else {
    await putAggregate(args.type, {
      id: args.aggregateId,
      householdId: args.householdId,
      schemaVersion,
      version: args.expectedVersion + 1,
      updatedAt: new Date(mutation.timestamp).toISOString(),
      deletedAt: new Date(mutation.timestamp).toISOString(),
      deviceId,
      aggregateType: args.type,
      payload: args.payload,
    }, batch);
  }
  await queueMutation(mutation);
  return mutation;
}

interface CollapseArgs {
  aggregateType: AggregateType;
  aggregateId: string;
  householdId: string;
  operation: 'create' | 'update' | 'delete';
  /**
   * The version the fresh mutation targets: the server's true counter for a re-base, `0` for a NOT_FOUND-on-update
   * recreate.
   */
  expectedVersion: number;
  schemaVersion: number;
  payload: Record<string, unknown>;
  /** Every old queue row for this aggregate to remove in the same transaction (the poison train). */
  removeMutationIds: readonly string[];
}

/**
 * Transactional collapse/re-queue for auto-repair and manual keep: removes the aggregate's stale queue rows, corrects
 * the local aggregate (`expectedVersion + 1`, a `deletedAt` tombstone for a delete) and appends one `pending` mutation,
 * in one IDB transaction so a crash never drops the un-synced edit. The fresh mutation gets a new id, minting past the
 * 7-day server rejection cache so the corrected version is re-evaluated.
 */
export async function collapseAndReQueue(
  args: CollapseArgs,
): Promise<PendingMutation> {
  const deviceId = getRegisteredDeviceId();
  if (!deviceId) {
    throw new Error(
      'collapseAndReQueue called before SyncProvider registered the device id.',
    );
  }
  const id = cryptoUuid();
  const timestamp = Math.max(Date.now(), lastQueuedTimestamp + 1);
  lastQueuedTimestamp = timestamp;
  const freshMutation: PendingMutation = {
    id,
    aggregateId: args.aggregateId,
    aggregateType: args.aggregateType,
    operation: args.operation,
    expectedVersion: args.expectedVersion,
    schemaVersion: args.schemaVersion,
    payload: args.payload,
    timestamp,
    deviceId,
    status: 'pending',
  };
  const isoNow = new Date(timestamp).toISOString();
  const correctedAggregate: Aggregate = {
    id: args.aggregateId,
    householdId: args.householdId,
    schemaVersion: args.schemaVersion,
    version: args.expectedVersion + 1,
    updatedAt: isoNow,
    ...(args.operation === 'delete' ? { deletedAt: isoNow } : {}),
    deviceId,
    aggregateType: args.aggregateType,
    payload: args.payload,
  };
  await replaceQueueMutationsAtomically({
    aggregateType: args.aggregateType,
    correctedAggregate,
    removeMutationIds: args.removeMutationIds,
    freshMutation,
  });
  return freshMutation;
}

/**
 * The caller's domain guard for {@link queueGuardedAccountUpdate}; both functions are synchronous, called inside the
 * write's IDB transaction.
 */
export interface AccountRetypeGuard {
  /** True when the write needs the account's fresh balance rows first (e.g. the type changed); false writes at once. */
  needsHistoryRead: (freshAccount: Aggregate<AccountPayload>) => boolean;
  /** True allows the write; `balances` is defined only when `needsHistoryRead` returned true. */
  allow: (
    freshAccount: Aggregate<AccountPayload>,
    balances: ReadonlyArray<Aggregate<AccountBalancePayload>> | undefined,
  ) => boolean;
}

/**
 * Guarded save for the account editor: builds the same optimistic aggregate and `PendingMutation` as {@link
 * queueLocalMutation} (same device-id guard, `expectedVersion + 1`, and the same `lastQueuedTimestamp` counter, since a
 * second one would let same-millisecond writes tie) but writes both through `db/store.ts`'s transactional primitive
 * with the caller's `guard`. Always an `update`. Throws what {@link writeAccountWithRetypeGuard} throws
 * (`AccountRetypeBlockedError`, `AccountRetypeCheckFailedError`, or a general error); the caller distinguishes them.
 */
export async function queueGuardedAccountUpdate(args: {
  householdId: string;
  aggregateId: string;
  /** The version captured when the editor opened; this write does not fence on it. */
  expectedVersion: number;
  /**
   * Builds the payload from the fresh persisted row, so fields the editor doesn't surface come from what is persisted,
   * not a snapshot taken at open.
   */
  buildPayload: (freshAccount: Aggregate<AccountPayload>) => AccountPayload;
  guard: AccountRetypeGuard;
}): Promise<GuardedAccountWrite> {
  const deviceId = getRegisteredDeviceId();
  if (!deviceId) {
    throw new Error(
      'queueGuardedAccountUpdate called before SyncProvider registered the device id.',
    );
  }
  const schemaVersion = currentSchemaVersion('account');
  const timestamp = Math.max(Date.now(), lastQueuedTimestamp + 1);
  lastQueuedTimestamp = timestamp;
  const isoNow = new Date(timestamp).toISOString();

  return writeAccountWithRetypeGuard({
    accountId: args.aggregateId,
    needsBalanceRead: args.guard.needsHistoryRead,
    decide: (freshAccount, balances) => {
      if (!args.guard.allow(freshAccount, balances)) return { refuse: true };
      const payload = args.buildPayload(freshAccount);
      const aggregate: Aggregate<AccountPayload> = {
        id: args.aggregateId,
        householdId: args.householdId,
        schemaVersion,
        version: args.expectedVersion + 1,
        updatedAt: isoNow,
        deviceId,
        aggregateType: 'account',
        payload,
      };
      const mutation: PendingMutation = {
        id: cryptoUuid(),
        aggregateId: args.aggregateId,
        aggregateType: 'account',
        operation: 'update',
        expectedVersion: args.expectedVersion,
        schemaVersion,
        payload,
        timestamp,
        deviceId,
        status: 'pending',
      };
      return { aggregate, mutation };
    },
  });
}
