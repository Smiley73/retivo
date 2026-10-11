/**
 * Helpers for queueing a domain mutation. Feature code calls
 * `queueLocalMutation()` after they've already updated the local
 * IndexedDB aggregate store; this just appends to the pending queue
 * and triggers a flush.
 */
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

// Strictly-monotonic logical clock for queued-mutation timestamps. The
// flush order (listPendingMutations) sorts by `timestamp`, so two edits
// to the same aggregate within one millisecond must NOT tie — a tie would
// let the IDB primary-key (random UUID) decide order and an update could
// be pushed before its create. Advancing past `lastQueuedTimestamp + 1`
// guarantees a strict ordering even under same-ms bursts. The counter is
// wall-clock-anchored across module reloads (it resets to 0, and the next
// timestamp is ≥ Date.now() ≥ any pre-reload value), so cross-reload order
// holds unless a reload completes within the same millisecond as a queued
// edit — accepted as unreachable in practice.
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
  // SyncProvider registers the canonical deviceId at mount. Pre-mount
  // callers (or mis-wired tests) would queue with no device id, which
  // the API would reject — so we throw early with a clear message.
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

  // Reflect the mutation in the local aggregate store so reads see it
  // immediately. The optimistic aggregate carries `expectedVersion + 1`
  // so subsequent edits-before-sync don't both target the same version.
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
  /** The version the fresh mutation targets (the server's true counter for an
   *  auto-repair re-base, or `0` for a NOT_FOUND-on-update recreate). */
  expectedVersion: number;
  schemaVersion: number;
  payload: Record<string, unknown>;
  /** Every old queue row for this aggregate to remove in the same transaction
   *  (the whole poison train). */
  removeMutationIds: readonly string[];
}

/**
 * Transactional collapse/re-queue for the auto-repair pass + manual keep
 * resolution. Removes the aggregate's stale queue
 * rows, corrects the local aggregate version, and appends ONE fresh mutation
 * (a NEW {@link cryptoUuid} id — mints past the 7-day server rejection cache so
 * the corrected version is actually re-evaluated) — all in one IDB transaction
 * via {@link replaceQueueMutationsAtomically}, so a crash mid-collapse never
 * drops the un-synced edit. The fresh mutation is `pending`; the corrected
 * aggregate carries `expectedVersion + 1` (the same optimistic bump
 * {@link queueLocalMutation} applies) and a `deletedAt` tombstone for a delete.
 * Returns the fresh mutation.
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

/** The caller's domain guard for {@link queueGuardedAccountUpdate} — what
 *  `db/store.ts`'s domain-free transactional primitive is missing without a
 *  caller to supply it. Both
 *  functions are synchronous, called from inside the write's IDB transaction. */
export interface AccountRetypeGuard {
  /** `true` when this write needs the account's fresh balance rows before it
   *  can be decided — e.g. the submitted type differs from what the fresh
   *  account row carries. `false` means "write immediately" (an ordinary
   *  edit takes no history read at all). */
  needsHistoryRead: (freshAccount: Aggregate<AccountPayload>) => boolean;
  /** `true` allows the write; `false` refuses it. `balances` is defined only
   *  when `needsHistoryRead` returned `true` for the same fresh account row. */
  allow: (
    freshAccount: Aggregate<AccountPayload>,
    balances: ReadonlyArray<Aggregate<AccountBalancePayload>> | undefined,
  ) => boolean;
}

/**
 * Sibling to {@link queueLocalMutation} for the account editor's guarded
 * save: builds the same optimistic aggregate + `PendingMutation` shape —
 * same device-id guard, `schemaVersion`, `expectedVersion + 1` bump, and the
 * SAME `lastQueuedTimestamp` counter this module already owns (a second
 * counter would let two same-millisecond writes tie, and
 * `listPendingMutations` would then flush them in random order) — but routes
 * both through `db/store.ts`'s domain-free transactional primitive with the
 * caller's `guard`, instead of two separate `putAggregate` +
 * `queueMutation` calls. Always an `update` — the guard exists for editing an
 * account that already has a persisted type to compare against.
 *
 * Throws whatever {@link writeAccountWithRetypeGuard} throws
 * (`AccountRetypeBlockedError`, `AccountRetypeCheckFailedError`, or the
 * general account-not-found/request-fault `Error`) — the caller distinguishes
 * them.
 */
export async function queueGuardedAccountUpdate(args: {
  householdId: string;
  aggregateId: string;
  /** The version captured when the editor opened — unchanged by this write; a
   *  version fence is out of scope. */
  expectedVersion: number;
  /** Builds the payload to write from the fresh, persisted account row, so
   *  fields the editor doesn't surface (e.g. the planned-contribution carry-
   *  forward) come from what's ACTUALLY persisted, never a snapshot taken at
   *  open. */
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


