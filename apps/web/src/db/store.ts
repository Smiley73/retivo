// IndexedDB wrapper: one object store per aggregate type plus the mutation queue and device metadata; `DB_VERSION` is the
// IDB schema version. The only module allowed `idb` or `deleteDatabase` (AGENTS.md "Project-specific security").
import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPObjectStore,
} from 'idb';
import type {
  AccountBalancePayload,
  AccountPayload,
  AccountType,
  Aggregate,
  AggregateType,
  DeviceMetadata,
  PendingMutation,
  SelectedScenario,
} from './types.js';
import { currentSchemaVersion, migrate } from './migrations.js';

const DB_NAME = 'retirement';
const DB_VERSION = 9;

// Cap (ms) on waiting for a blocked IDB operation before failing closed with a typed error rather than hanging; shared
// by `dropLocalDatabase` (blocked `deleteDatabase`) and `db` (blocked v9 `openDB`).
const IDB_BLOCKED_TIMEOUT_MS = 2000;

/**
 * `deleteDatabase` stayed blocked past the timeout (another tab holds the IDB open); typed so the cross-user transition
 * guard fails closed and the UI shows "close all other tabs then retry".
 */
export class DatabaseDropBlockedError extends Error {
  constructor() {
    super('IndexedDB delete was blocked by another connection and did not complete');
    this.name = 'DatabaseDropBlockedError';
  }
}

/**
 * The v9 `openDB` upgrade stayed blocked past {@link IDB_BLOCKED_TIMEOUT_MS} (an older tab with no `blocking()` handler
 * still holds the IDB). Typed so callers see an honest failure, and `dbPromise` is reset so a retry works once that tab
 * closes.
 */
export class DatabaseUpgradeBlockedError extends Error {
  constructor() {
    super('IndexedDB upgrade was blocked by another connection and did not complete');
    this.name = 'DatabaseUpgradeBlockedError';
  }
}

/**
 * The aggregate's live queue stack, re-read inside the collapse transaction, no longer matches the snapshot the caller
 * classified: a concurrent `queueLocalMutation` for the same aggregate landed in between. The collapse writes nothing
 * rather than stomp that edit; auto-repair leaves the rejection pending and re-routes next flush (closing the
 * check-and-mutate TOCTOU). The `aggregateId` is a property, not in the message, so a stray log never carries the raw
 * id.
 */
export class ConcurrentQueueMutationError extends Error {
  constructor(public readonly aggregateId: string) {
    super(
      'Queue stack changed under an in-flight repair collapse; aborting to avoid a lost update',
    );
    this.name = 'ConcurrentQueueMutationError';
  }
}

/**
 * The caller's `decide` refused the write: the account has real balance history and the submitted type differs from the
 * persisted one. The id and the freshly persisted type are properties, not in the message, so a refusal message built
 * from anything else (e.g. a snapshot taken when the editor opened) can't name a type the person is already past.
 */
export class AccountRetypeBlockedError extends Error {
  constructor(
    public readonly accountId: string,
    public readonly persistedType: AccountType,
  ) {
    super(
      'Account type change refused: this account has real balance history',
    );
    this.name = 'AccountRetypeBlockedError';
  }
}

/**
 * The in-transaction balance read requested by `needsBalanceRead` itself failed; distinct from {@link
 * AccountRetypeBlockedError} so the caller shows "could not check" instead of claiming the account has (or lacks)
 * history it never read.
 */
export class AccountRetypeCheckFailedError extends Error {
  constructor(public readonly accountId: string) {
    super(
      'Could not read this account’s balance history to check the type change',
    );
    this.name = 'AccountRetypeCheckFailedError';
  }
}

/**
 * Device-local row caching the household data key as exported raw bytes (survives structured clone). It lives in the
 * `keyCache` store inside the `retirement` IDB, never a second database, so it is dropped exactly when the IDB is. A
 * singleton keyed by {@link KEY_CACHE_ID}; `householdId` lets a stale entry from a prior household be detected and
 * ignored.
 */
export interface KeyCacheEntry {
  id: string;
  householdId: string;
  hdkExported: ArrayBuffer;
}

/** Singleton key for the {@link KeyCacheEntry} row in the `keyCache` store. */
export const KEY_CACHE_ID = 'hdk';

/**
 * Cached Monte Carlo result row, local-only. Two independently enforced LRU budgets (ordinary `'primary'` and
 * market-stress entries) evict only within the class that went over; `monte-carlo-cache.ts` owns the caps. Invalidated
 * when `engineVersion` differs from the build's `ENGINE_VERSION`.
 */
export interface MonteCarloCacheEntry {
  /** SHA-256 (16 hex chars) of the projection-relevant aggregate snapshot; the primary key. */
  id: string;
  /** Engine version at compute time; mismatches are recomputed on read. */
  engineVersion: number;
  /** Serialized `MonteCarloSummary`, opaque to the store. */
  summary: unknown;
  /** Last-read timestamp (ms epoch) — drives LRU eviction. */
  lastAccessedAt: number;
  /**
   * Which LRU budget the entry is charged to; absent means `'primary'`, so older and ordinary entries keep it with no
   * migration. `'marketStress'` marks a comparison's seed-inclusive entries, capped separately so a comparison can't
   * evict the per-scenario results the Scenarios page reads.
   */
  entryClass?: 'marketStress';
}

/**
 * One persisted on-device diagnostics entry (v9), local-only and not aggregate data: a breadcrumb or error mirrored
 * from the `lib/diagnostics` logger so it survives a crash or reload. `seq` is allocated inside the append transaction
 * (max via index + 1) so prune order holds across tabs within a same-millisecond batch. Opaque via `Record<string,
 * unknown>`; the logger owns the typed contract.
 */
export interface DiagnosticLogEntry {
  /** Primary key — the entry's stable id (UUID/ULID from the logger). */
  id: string;
  /** Strictly-monotonic insertion order; drives the prune cursor. */
  seq: number;
  /** Remaining logger fields (level/source/ts/message/detail/…), opaque here. */
  [key: string]: unknown;
}

interface Schema extends DBSchema {
  households: { key: string; value: Aggregate; indexes: { householdId: string; updatedAt: string } };
  householdMembers: { key: string; value: Aggregate; indexes: { householdId: string; updatedAt: string } };
  accounts: { key: string; value: Aggregate; indexes: { householdId: string; updatedAt: string } };
  accountBalances: { key: string; value: Aggregate; indexes: { householdId: string; updatedAt: string } };
  socialSecurityBenefits: { key: string; value: Aggregate; indexes: { householdId: string; updatedAt: string } };
  scenarios: { key: string; value: Aggregate; indexes: { householdId: string; updatedAt: string } };
  expenseCategories: { key: string; value: Aggregate; indexes: { householdId: string; updatedAt: string } };
  expenses: { key: string; value: Aggregate; indexes: { householdId: string; updatedAt: string } };
  incomeStreams: { key: string; value: Aggregate; indexes: { householdId: string; updatedAt: string } };
  mutations: { key: string; value: PendingMutation; indexes: { status: string; aggregateId: string } };
  deviceMetadata: { key: 'self'; value: DeviceMetadata & { id: 'self' } };
  selectedScenario: { key: 'self'; value: SelectedScenario & { id: 'self' } };
  monteCarloResults: { key: string; value: MonteCarloCacheEntry; indexes: { lastAccessedAt: number } };
  keyCache: { key: string; value: KeyCacheEntry };
  diagnosticLogs: { key: string; value: DiagnosticLogEntry; indexes: { seq: number } };
}

export type AggregateStore =
  | 'households'
  | 'householdMembers'
  | 'accounts'
  | 'accountBalances'
  | 'socialSecurityBenefits'
  | 'scenarios'
  | 'expenseCategories'
  | 'expenses'
  | 'incomeStreams';

const STORE_BY_TYPE: Record<AggregateType, AggregateStore> = {
  household: 'households',
  householdMember: 'householdMembers',
  account: 'accounts',
  accountBalance: 'accountBalances',
  socialSecurityBenefit: 'socialSecurityBenefits',
  scenario: 'scenarios',
  expenseCategory: 'expenseCategories',
  expense: 'expenses',
  incomeStream: 'incomeStreams',
};

// Per-store change notification: each `AggregateStore` has a version counter and subscribers, and a single-row write
// (`putAggregate`/`deleteAggregateLocally`) bumps it and wakes only that store's subscribers, so a reactive read hook
// re-reads on any write to its own type without a manual revision dependency. Bulk-fill paths wrap their loop in {@link
// withBatchedStoreSignals} and flush one signal per touched store on exit, keeping their end-of-loop coarse
// `WORKSPACE_CHANGED_EVENT`; `clearAllStores` notifies every store. The counter is a `useSyncExternalStore`-friendly
// sync snapshot because the read itself is async.
const storeVersions = new Map<AggregateStore, number>();
const storeListeners = new Map<AggregateStore, Set<() => void>>();

/** Current change-version for a store (0 until its first write). */
export function getStoreVersion(store: AggregateStore): number {
  return storeVersions.get(store) ?? 0;
}

/**
 * Subscribes to single-write changes on one aggregate store; returns the unsubscribe. Pairs with {@link
 * getStoreVersion} for `useSyncExternalStore`.
 */
export function subscribeToStoreChanges(
  store: AggregateStore,
  listener: () => void,
): () => void {
  let set = storeListeners.get(store);
  if (!set) {
    set = new Set();
    storeListeners.set(store, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}

function notifyStoreChanged(store: AggregateStore): void {
  storeVersions.set(store, getStoreVersion(store) + 1);
  storeListeners.get(store)?.forEach((listener) => listener());
}

/**
 * The stores a bulk load touched inside one {@link withBatchedStoreSignals} scope: mutators given a batch record the
 * store on it instead of firing the per-row signal, and the scope emits one `notifyStoreChanged` per touched store on
 * exit. Each scope owns a fresh `Batch`, so overlapping un-serialized loads never share a touched-store set (no global
 * flag).
 */
export type Batch = Set<AggregateStore>;

function recordOrNotify(store: AggregateStore, batch: Batch | undefined): void {
  if (batch) {
    batch.add(store);
  } else {
    notifyStoreChanged(store);
  }
}

/**
 * Runs `fn` with a fresh signal-suppression batch and flushes one `notifyStoreChanged` per touched store on exit, on
 * the error path too (a mid-bulk throw must not strand readers on stale data; the error re-throws). Bulk writers thread
 * `batch` into every `putAggregate`/`deleteAggregateLocally` (directly or via
 * `queueLocalMutation`/`saveScenario`/`applyPulledChange`). Overlapping loads each flush only their own stores. The
 * coarse `WORKSPACE_CHANGED_EVENT` stays with callers' end-of-loop `notifyWorkspaceChanged()`.
 */
export async function withBatchedStoreSignals<T>(
  fn: (batch: Batch) => Promise<T>,
): Promise<T> {
  const batch: Batch = new Set();
  try {
    return await fn(batch);
  } finally {
    for (const store of batch) {
      notifyStoreChanged(store);
    }
  }
}

let dbPromise: Promise<IDBPDatabase<Schema>> | null = null;

// Same-origin BroadcastChannel for the cross-tab IDB-release nudge (docs/architecture.md "Browser storage"): when a
// cross-user login must drop the IDB while another tab holds it open, the dropping tab posts {@link IDB_RELEASE_NUDGE}
// and every other tab closes its cached handle so the queued `deleteDatabase` completes.
const IDB_NUDGE_CHANNEL = 'retivo.idb.nudge';
const IDB_RELEASE_NUDGE = 'release-idb';

let nudgeChannel: BroadcastChannel | null = null;

// Lazily opens the nudge channel; a receiving tab closes its cached handle (the next `db()` reopens it). A stateful
// singleton with lifecycle cleanup ({@link closeNudgeChannel}).
function ensureNudgeChannel(): void {
  if (nudgeChannel || typeof BroadcastChannel === 'undefined') return;
  nudgeChannel = new BroadcastChannel(IDB_NUDGE_CHANNEL);
  nudgeChannel.onmessage = (event: MessageEvent) => {
    if (event.data !== IDB_RELEASE_NUDGE) return;
    void closeIdbHandle();
  };
}

async function closeIdbHandle(): Promise<void> {
  if (!dbPromise) return;
  try {
    const handle = await dbPromise;
    handle.close();
  } catch {
    // Handle already closing/closed — nothing to release.
  } finally {
    dbPromise = null;
  }
}

/**
 * Tells every other same-origin tab to close its IDB handle so a pending `deleteDatabase` can complete; emitted by the
 * cross-user guard (auth/user-transition.ts). No-op without BroadcastChannel.
 */
export function nudgeOtherTabsToReleaseIdb(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  ensureNudgeChannel();
  nudgeChannel?.postMessage(IDB_RELEASE_NUDGE);
}

/** Tears down the nudge channel (lifecycle cleanup for the singleton); call from teardown paths and tests. */
export function closeNudgeChannel(): void {
  nudgeChannel?.close();
  nudgeChannel = null;
}

interface ArmableOpen {
  promise: Promise<IDBPDatabase<Schema>>;
  /** Call from the `openDB` `blocked()` callback to start the failure timer. */
  armBlockedTimeout: () => void;
}

// Wraps a pending `openDB` promise with a bounded blocked-timeout: once armed (from the `blocked()` callback) and
// unresolved within {@link IDB_BLOCKED_TIMEOUT_MS} it rejects with {@link DatabaseUpgradeBlockedError} instead of
// hanging. A late real resolution is closed and discarded, never returned as a half-state. Factored out of {@link db}
// so the wait is unit-testable without a real `onblocked`, which `fake-indexeddb` cannot trigger.
export function wrapOpenWithBlockedTimeout(
  openPromise: Promise<IDBPDatabase<Schema>>,
  capMs: number = IDB_BLOCKED_TIMEOUT_MS,
): ArmableOpen {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let armed = false;
  let reject!: (err: unknown) => void;
  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const promise = new Promise<IDBPDatabase<Schema>>((resolve, rej) => {
    reject = rej;
    openPromise.then(
      (handle) => {
        clearTimer();
        if (settled) {
          // Already timed out: discard the late handle so it is never cached as a half-state.
          handle.close();
          return;
        }
        settled = true;
        resolve(handle);
      },
      (err) => {
        clearTimer();
        if (settled) return;
        settled = true;
        rej(err);
      },
    );
  });
  const armBlockedTimeout = (): void => {
    if (armed || settled) return;
    armed = true;
    timer = setTimeout(() => {
      timer = null;
      if (settled) return;
      settled = true;
      reject(new DatabaseUpgradeBlockedError());
    }, capMs);
  };
  return { promise, armBlockedTimeout };
}

export function db(): Promise<IDBPDatabase<Schema>> {
  // Register the cross-tab release listener once a connection opens, so this tab yields its handle when another needs
  // to drop the database.
  ensureNudgeChannel();
  if (!dbPromise) {
    let armBlockedTimeout: () => void = () => {};
    const rawOpen = openDB<Schema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // v2: drop the 'plans' store.
        if (db.objectStoreNames.contains('plans' as never)) {
          db.deleteObjectStore('plans' as never);
        }
        // Also creates v6's `incomeStreams`: any missing store gets the standard householdId/updatedAt indexes.
        for (const store of Object.values(STORE_BY_TYPE) as AggregateStore[]) {
          if (!db.objectStoreNames.contains(store)) {
            const os = db.createObjectStore(store, { keyPath: 'id' });
            os.createIndex('householdId', 'householdId');
            os.createIndex('updatedAt', 'updatedAt');
          }
        }
        if (!db.objectStoreNames.contains('mutations')) {
          const os = db.createObjectStore('mutations', { keyPath: 'id' });
          os.createIndex('status', 'status');
          os.createIndex('aggregateId', 'aggregateId');
        }
        if (!db.objectStoreNames.contains('deviceMetadata')) {
          db.createObjectStore('deviceMetadata', { keyPath: 'id' });
        }
        // v3: per-device selected-scenario pointer (singleton, not synced).
        if (!db.objectStoreNames.contains('selectedScenario')) {
          db.createObjectStore('selectedScenario', { keyPath: 'id' });
        }
        // v7: Monte Carlo result cache (local-only).
        if (!db.objectStoreNames.contains('monteCarloResults')) {
          const os = db.createObjectStore('monteCarloResults', { keyPath: 'id' });
          os.createIndex('lastAccessedAt', 'lastAccessedAt');
        }
        // v8: device-local household-data-key cache (singleton, local-only), inside the `retirement` IDB so it rides
        // the centralized teardown.
        if (!db.objectStoreNames.contains('keyCache')) {
          db.createObjectStore('keyCache', { keyPath: 'id' });
        }
        // v9: on-device diagnostics log (local-only); the `seq` index drives the append-time prune. Kept across
        // clearAllStores/force-bootstrap, wiped by every dropLocalDatabase.
        if (!db.objectStoreNames.contains('diagnosticLogs')) {
          const os = db.createObjectStore('diagnosticLogs', { keyPath: 'id' });
          os.createIndex('seq', 'seq');
        }
      },
      // A v9 open blocked by an open v8 tab would stall db() and freeze this tab's IDB I/O: close this tab's cached
      // handle so a sibling's upgrade can proceed (as the nudge does); the blocked-timeout below then rejects with
      // DatabaseUpgradeBlockedError and resets the cache for a clean retry.
      blocking() {
        void closeIdbHandle();
      },
      blocked() {
        console.warn(
          '[db] IndexedDB upgrade to v9 is blocked by another open tab; close other tabs of this app to finish upgrading',
        );
        // Arm the bounded failure path: a sibling that never releases (e.g. a v8 tab without a blocking() handler
        // during rollout) would leave this promise pending forever.
        armBlockedTimeout();
      },
      terminated() {
        // The browser killed the connection (e.g. storage pressure): drop the cached promise so the next db() reopens.
        dbPromise = null;
      },
    });
    const wrapped = wrapOpenWithBlockedTimeout(rawOpen);
    armBlockedTimeout = wrapped.armBlockedTimeout;
    // On a blocked-timeout reject or any open error, reset the cache so a later db() retries cleanly, but only if it is
    // still our own chain (a terminated() reopen may have replaced it); re-throw for the awaiting caller.
    const cached: Promise<IDBPDatabase<Schema>> = wrapped.promise.catch(
      (err: unknown) => {
        if (dbPromise === cached) dbPromise = null;
        throw err;
      },
    );
    dbPromise = cached;
  }
  return dbPromise;
}

/** Read all non-deleted aggregates of a given type, applying migrations on the way out. */
export async function listAggregates(type: AggregateType): Promise<Aggregate[]> {
  const handle = await db();
  const store = STORE_BY_TYPE[type];
  const all = await handle.getAll(store);
  return all
    .filter((a) => !a.deletedAt)
    .map((a) => migrateAggregate(type, a));
}

/**
 * As {@link listAggregates} but keeps tombstones, for the demo-reload and import bookkeeping that must see cloud-side
 * tombstones (bootstrap writes them with `deletedAt`) so a reload queues `update @ tombstone_version`: the server's
 * `attribute_not_exists OR version=:expected` condition always rejects `create @ 0` over a tombstone, leaving the badge
 * on "Refresh needed". Not for UI reads.
 */
export async function listAggregatesIncludingDeleted(
  type: AggregateType,
): Promise<Aggregate[]> {
  const handle = await db();
  const store = STORE_BY_TYPE[type];
  const all = await handle.getAll(store);
  return all.map((a) => migrateAggregate(type, a));
}

export async function getAggregate(type: AggregateType, id: string): Promise<Aggregate | null> {
  const handle = await db();
  const a = await handle.get(STORE_BY_TYPE[type], id);
  if (!a || a.deletedAt) return null;
  return migrateAggregate(type, a);
}

/**
 * As {@link getAggregate} but returns a tombstoned row (null only when absent), for bookkeeping that must reason about
 * a row the cloud tombstoned, e.g. `resolveConflict`'s discard convergence check, where an adopted remote deletion
 * would read as absent. Not for UI reads.
 */
export async function getAggregateIncludingDeleted(
  type: AggregateType,
  id: string,
): Promise<Aggregate | null> {
  const handle = await db();
  const a = await handle.get(STORE_BY_TYPE[type], id);
  if (!a) return null;
  return migrateAggregate(type, a);
}

export async function putAggregate(
  type: AggregateType,
  aggregate: Aggregate,
  batch?: Batch,
): Promise<void> {
  const handle = await db();
  const store = STORE_BY_TYPE[type];
  await handle.put(store, aggregate);
  recordOrNotify(store, batch);
}

export async function deleteAggregateLocally(
  type: AggregateType,
  id: string,
  batch?: Batch,
): Promise<void> {
  const handle = await db();
  const store = STORE_BY_TYPE[type];
  await handle.delete(store, id);
  recordOrNotify(store, batch);
}

export async function queueMutation(m: PendingMutation): Promise<void> {
  const handle = await db();
  await handle.put('mutations', m);
}

export async function listPendingMutations(): Promise<PendingMutation[]> {
  const handle = await db();
  // Upgrades any row a schema-behind build queued before it can be pushed; the read stays `readonly` and the rare
  // persist is a separate read-check-write (see listStatusRowsUpgraded).
  const migrated = await listStatusRowsUpgraded(handle, 'pending');
  // The `status` index orders ties by random UUID; sort by the strictly monotonic `timestamp` so the server applies
  // same-aggregate mutations in creation order (an update can't precede its create).
  return migrated.sort((a, b) => a.timestamp - b.timestamp);
}

export async function listFailedConflicts(): Promise<PendingMutation[]> {
  const handle = await db();
  return listStatusRowsUpgraded(handle, 'failed-conflict');
}

/** The `failed-error` rows: batches parked after a permanent push rejection. */
export async function listFailedErrors(): Promise<PendingMutation[]> {
  const handle = await db();
  return listStatusRowsUpgraded(handle, 'failed-error');
}

export async function updateMutationStatus(
  id: string,
  status: PendingMutation['status'],
  reason?: PendingMutation['reason'],
): Promise<void> {
  const handle = await db();
  const tx = handle.transaction('mutations', 'readwrite');
  const m = await tx.store.get(id);
  if (!m) return;
  m.status = status;
  // Stamp the rejection reason, or clear a stale one when none is passed (any non-failure transition, e.g. a retry back
  // to `pending`); only the rejection loop passes the allowlist-normalised reason.
  m.reason = reason;
  await tx.store.put(m);
}

export async function removeMutation(id: string): Promise<void> {
  const handle = await db();
  await handle.delete('mutations', id);
}

/**
 * Removes a set of queue mutations in one `mutations` transaction, all-or-nothing, so the queue is never left partially
 * swept. Auto-repair's `drop` path: a simple drop scopes to the rejected row, a created-then-deleted poison train to
 * the whole stack. Missing ids are ignored; an empty list is a no-op.
 */
export async function removeMutations(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const handle = await db();
  const tx = handle.transaction('mutations', 'readwrite');
  try {
    for (const id of ids) {
      await tx.store.delete(id);
    }
    await tx.done;
  } catch (err) {
    // Abort explicitly to roll everything back, consume the `tx.done` rejection so it isn't unhandled, and re-throw the
    // original error.
    try {
      tx.abort();
    } catch {
      // Already aborting/committed — nothing to undo.
    }
    await tx.done.catch(() => undefined);
    throw err;
  }
}

/**
 * Check & repair: re-queues a parked mutation as a fresh-id `pending` row in one transaction (deletes `oldId`, puts a
 * copy with `freshId`, status `pending` and the rejection facts cleared). A fresh id is mandatory since the original
 * would replay the server's 7-day cached `CONFLICT`, and `pending` because `flushPending` pushes only those; the
 * follow-on rejection re-drives auto-repair. No-op on a missing id.
 */
export async function reEnqueueMutationWithFreshId(
  oldId: string,
  freshId: string,
): Promise<void> {
  const handle = await db();
  const tx = handle.transaction('mutations', 'readwrite');
  const m = await tx.store.get(oldId);
  if (!m) {
    await tx.done;
    return;
  }
  await tx.store.delete(oldId);
  const fresh: PendingMutation = {
    ...m,
    id: freshId,
    status: 'pending',
    reason: undefined,
    currentVersion: undefined,
    currentUpdatedAt: undefined,
  };
  await tx.store.put(fresh);
  await tx.done;
}

/**
 * Every queue row (any status) for one aggregate via the `aggregateId` index; auto-repair reads the full stack so a
 * later pending sibling can't re-poison the aggregate after a collapse.
 */
export async function listMutationsByAggregate(
  aggregateId: string,
): Promise<PendingMutation[]> {
  const handle = await db();
  const tx = handle.transaction('mutations', 'readonly');
  return tx.store.index('aggregateId').getAll(aggregateId);
}

/**
 * Every queue row (any status), for the version-truth capture before a destructive `clearMutationQueue()` and the
 * export's `readAllMutations` default. Migrates a schema-behind payload in memory only and never persists it, unlike
 * {@link listPendingMutations}/{@link listFailedConflicts}/{@link listFailedErrors}, because the export's "never writes
 * workspace/queue state" contract depends on this read.
 */
export async function listAllMutations(): Promise<PendingMutation[]> {
  const handle = await db();
  const rows = await handle.getAll('mutations');
  return rows.map(migrateMutation);
}

// Concurrency fence for the transactional collapse primitives: the aggregate's live stack, re-read inside the collapse
// transaction, must still match the caller's snapshot. A concurrent `queueLocalMutation` adds a row absent from
// `expectedIds` that the collapse would stomp (a silent lost update), so throw {@link ConcurrentQueueMutationError} and
// let the caller re-route next round. A missing row is fine (a concurrent apply-remove); only an added one signals the
// race.
function assertQueueStackUnchanged(
  liveStack: readonly PendingMutation[],
  expectedIds: readonly string[],
  aggregateId: string,
): void {
  const expected = new Set(expectedIds);
  for (const m of liveStack) {
    if (!expected.has(m.id)) throw new ConcurrentQueueMutationError(aggregateId);
  }
}

/**
 * Parks a rejected mutation as `failed-conflict`, writing `reason`, `currentVersion` and `currentUpdatedAt` together in
 * one transaction so persisting the server facts can't clobber the reason (the Resolve UI re-bases from them). Omitted
 * facts are written absent. No-op on a missing id.
 */
export async function parkFailedConflict(
  id: string,
  facts: {
    reason?: PendingMutation['reason'];
    currentVersion?: number;
    currentUpdatedAt?: string;
  },
): Promise<void> {
  const handle = await db();
  const tx = handle.transaction('mutations', 'readwrite');
  const m = await tx.store.get(id);
  if (!m) {
    await tx.done;
    return;
  }
  m.status = 'failed-conflict';
  m.reason = facts.reason;
  m.currentVersion = facts.currentVersion;
  m.currentUpdatedAt = facts.currentUpdatedAt;
  await tx.store.put(m);
  await tx.done;
}

/**
 * Escalation: collapses an aggregate's stack to one parked `failed-conflict` representative stamped with the rejection
 * facts, removing the siblings, in one transaction. Restart-safe (a crash before commit leaves every row `pending`, so
 * the next flush re-escalates identically). Re-reads the live stack first and aborts with {@link
 * ConcurrentQueueMutationError} if a concurrent `queueLocalMutation` landed since the snapshot. No-op on a missing
 * representative.
 */
export async function collapseToFailedConflict(args: {
  aggregateId: string;
  representativeId: string;
  removeMutationIds: readonly string[];
  facts: {
    reason?: PendingMutation['reason'];
    currentVersion?: number;
    currentUpdatedAt?: string;
  };
}): Promise<void> {
  const handle = await db();
  const tx = handle.transaction('mutations', 'readwrite');
  try {
    // Re-read the live stack before any write and abort on a mismatch, so the repair re-routes next round instead of
    // folding a stale collapse.
    assertQueueStackUnchanged(
      await tx.store.index('aggregateId').getAll(args.aggregateId),
      args.removeMutationIds,
      args.aggregateId,
    );
    for (const id of args.removeMutationIds) {
      if (id === args.representativeId) continue;
      await tx.store.delete(id);
    }
    const rep = await tx.store.get(args.representativeId);
    if (rep) {
      rep.status = 'failed-conflict';
      rep.reason = args.facts.reason;
      rep.currentVersion = args.facts.currentVersion;
      rep.currentUpdatedAt = args.facts.currentUpdatedAt;
      await tx.store.put(rep);
    }
    await tx.done;
  } catch (err) {
    try {
      tx.abort();
    } catch {
      // Already aborting/committed — nothing to undo.
    }
    await tx.done.catch(() => undefined);
    throw err;
  }
}

/**
 * Atomically removes queue mutations, writes a corrected local aggregate and appends one fresh mutation in a single
 * readwrite transaction over `mutations` and the aggregate's store; the auto-repair re-base and manual keep use it.
 * Unlike {@link queueLocalMutation} (separate transactions), a crash mid-collapse can't drop the un-synced edit. Fires
 * the store's fine change signal after commit.
 */
export async function replaceQueueMutationsAtomically(args: {
  aggregateType: AggregateType;
  correctedAggregate: Aggregate;
  removeMutationIds: readonly string[];
  freshMutation: PendingMutation;
}): Promise<void> {
  const handle = await db();
  const store = STORE_BY_TYPE[args.aggregateType];
  const tx = handle.transaction(['mutations', store], 'readwrite');
  try {
    const mutations = tx.objectStore('mutations');
    // Concurrency fence: re-read the live stack inside this transaction before any write and confirm it matches the
    // caller's snapshot; a concurrent `queueLocalMutation` row would be stomped by `correctedAggregate` (a silent lost
    // update), so abort and let the repair pass re-route.
    assertQueueStackUnchanged(
      await mutations.index('aggregateId').getAll(args.freshMutation.aggregateId),
      args.removeMutationIds,
      args.freshMutation.aggregateId,
    );
    // Append the fresh mutation before removing the stale rows, so a throw never makes the un-synced edit the casualty
    // (queue-before-remove, the restart-safe ordering); the explicit abort rolls everything back.
    await mutations.put(args.freshMutation);
    await tx.objectStore(store).put(args.correctedAggregate);
    for (const id of args.removeMutationIds) {
      if (id === args.freshMutation.id) continue;
      await mutations.delete(id);
    }
    await tx.done;
  } catch (err) {
    // A request error (e.g. a DataCloneError) must roll the whole transaction back: abort, consume the `tx.done`
    // rejection, re-throw.
    try {
      tx.abort();
    } catch {
      // Already aborting/committed — nothing to undo.
    }
    await tx.done.catch(() => undefined);
    throw err;
  }
  notifyStoreChanged(store);
}

/** The aggregate and queue row {@link writeAccountWithRetypeGuard} commits. */
export interface GuardedAccountWrite {
  readonly aggregate: Aggregate<AccountPayload>;
  readonly mutation: PendingMutation;
}

/**
 * The caller's verdict in {@link writeAccountWithRetypeGuard}: the write to commit, or a refusal that writes nothing.
 */
export type GuardedAccountDecision = GuardedAccountWrite | { readonly refuse: true };

/**
 * Guarded account save in one `readwrite` transaction over `accounts`, `accountBalances` and `mutations`: reads the
 * account's fresh, tombstone-filtered, migrated row, optionally its fresh balance rows, then asks the caller's `decide`
 * for a verdict, all before any write, so a blocked type change writes nothing (like {@link
 * replaceQueueMutationsAtomically}: re-read inside, explicit abort on fault, {@link notifyStoreChanged} only after
 * commit). `db/` may not import `pages/` or `sync/` (`.dependency-cruiser.cjs` `db-layering`), so this primitive is
 * domain-free: a caller predicate decides whether the balance read is needed and a caller decision whether to write or
 * refuse. `decide` and `needsBalanceRead` must be synchronous and await nothing non-IDB: an IDB transaction
 * auto-commits once control returns to the event loop with no pending request, so an `await` on a plain promise would
 * end it before the write. Throws {@link AccountRetypeBlockedError} when `decide` refuses, {@link
 * AccountRetypeCheckFailedError} when the balance read fails (only if `needsBalanceRead` returned true), and a plain
 * `Error` for any other fault, including an absent or tombstoned account row.
 */
export async function writeAccountWithRetypeGuard(args: {
  accountId: string;
  /**
   * Synchronous. `true` means the write also needs the account's fresh balance rows before `decide` can judge it (e.g.
   * the submitted type differs from the persisted one).
   */
  needsBalanceRead: (freshAccount: Aggregate<AccountPayload>) => boolean;
  /** Synchronous. Gets the fresh account and, only when `needsBalanceRead` returned true, its fresh balance rows. */
  decide: (
    freshAccount: Aggregate<AccountPayload>,
    balances: ReadonlyArray<Aggregate<AccountBalancePayload>> | undefined,
  ) => GuardedAccountDecision;
}): Promise<GuardedAccountWrite> {
  const handle = await db();
  const tx = handle.transaction(['accounts', 'accountBalances', 'mutations'], 'readwrite');
  let result: GuardedAccountWrite;
  try {
    const accountsStore = tx.objectStore('accounts');
    const rawAccount = await accountsStore.get(args.accountId);
    if (!rawAccount || rawAccount.deletedAt) {
      throw new Error(`Account not found: ${args.accountId}`);
    }
    const freshAccount = migrateAggregate('account', rawAccount) as Aggregate<AccountPayload>;

    let balances: ReadonlyArray<Aggregate<AccountBalancePayload>> | undefined;
    if (args.needsBalanceRead(freshAccount)) {
      let rawBalances: Aggregate[];
      try {
        rawBalances = await tx.objectStore('accountBalances').getAll();
      } catch {
        throw new AccountRetypeCheckFailedError(args.accountId);
      }
      balances = rawBalances
        .filter((b) => !b.deletedAt)
        .map((b) => migrateAggregate('accountBalance', b)) as Aggregate<AccountBalancePayload>[];
    }

    const decision = args.decide(freshAccount, balances);
    if ('refuse' in decision) {
      throw new AccountRetypeBlockedError(args.accountId, freshAccount.payload.type);
    }

    await accountsStore.put(decision.aggregate);
    await tx.objectStore('mutations').put(decision.mutation);
    await tx.done;
    result = decision;
  } catch (err) {
    try {
      tx.abort();
    } catch {
      // Already aborting/committed — nothing to undo.
    }
    await tx.done.catch(() => undefined);
    throw err;
  }
  notifyStoreChanged('accounts');
  return result;
}

/**
 * Drops every mutation-queue entry (pending and failed-conflict), for the demo-reload overwrite: stale
 * `failed-conflict` rows from a broken load would otherwise survive the wipe and pin the badge on "Refresh needed".
 */
export async function clearMutationQueue(): Promise<void> {
  const handle = await db();
  await handle.clear('mutations');
}

export async function readDeviceMetadata(): Promise<DeviceMetadata | null> {
  const handle = await db();
  const r = await handle.get('deviceMetadata', 'self');
  if (!r) return null;
  return { deviceId: r.deviceId, syncCursor: r.syncCursor, lastSyncedAt: r.lastSyncedAt, displayName: r.displayName, freshnessCounter: r.freshnessCounter, envelopeSetVersion: r.envelopeSetVersion, quarantinedRows: r.quarantinedRows };
}

export async function writeDeviceMetadata(metadata: DeviceMetadata): Promise<void> {
  const handle = await db();
  await handle.put('deviceMetadata', { ...metadata, id: 'self' });
}

/**
 * Atomic read-modify-write of the singleton `deviceMetadata` row in one `readwrite` transaction (get, updater, put). It
 * closes the lost-update class of the plain read/write pair, where two sync flows each read the whole row and write it
 * back and last-writer-wins clobbers a sibling field (e.g. a pull's `syncCursor` reverted by a freshness-pin persist).
 * The `updater` must change only the fields it owns and spread the rest of `current`, so the transaction's read is the
 * merge base. `current` is null on a first write, when callers seed the identity fields. Returns the persisted row.
 */
export async function updateDeviceMetadata(
  updater: (current: DeviceMetadata | null) => DeviceMetadata,
): Promise<DeviceMetadata> {
  const handle = await db();
  const tx = handle.transaction('deviceMetadata', 'readwrite');
  const existing = await tx.store.get('self');
  const current: DeviceMetadata | null = existing
    ? {
        deviceId: existing.deviceId,
        syncCursor: existing.syncCursor,
        lastSyncedAt: existing.lastSyncedAt,
        displayName: existing.displayName,
        freshnessCounter: existing.freshnessCounter,
        envelopeSetVersion: existing.envelopeSetVersion,
        quarantinedRows: existing.quarantinedRows,
      }
    : null;
  const next = updater(current);
  await tx.store.put({ ...next, id: 'self' });
  await tx.done;
  return next;
}

export async function readSelectedScenario(): Promise<SelectedScenario | null> {
  const handle = await db();
  const r = await handle.get('selectedScenario', 'self');
  if (!r) return null;
  return { scenarioId: r.scenarioId, updatedAt: r.updatedAt };
}

export async function writeSelectedScenario(selected: SelectedScenario): Promise<void> {
  const handle = await db();
  await handle.put('selectedScenario', { ...selected, id: 'self' });
}

export async function clearSelectedScenario(): Promise<void> {
  const handle = await db();
  await handle.delete('selectedScenario', 'self');
}

/**
 * The cached household-data-key entry, or null. Callers must confirm `householdId` matches the active household before
 * trusting the bytes: a stale entry survives until the next IDB drop.
 */
export async function readKeyCacheEntry(): Promise<KeyCacheEntry | null> {
  const handle = await db();
  const r = await handle.get('keyCache', KEY_CACHE_ID);
  return r ?? null;
}

/** Write (or replace) the singleton household-data-key cache entry. */
export async function writeKeyCacheEntry(entry: KeyCacheEntry): Promise<void> {
  const handle = await db();
  await handle.put('keyCache', { ...entry, id: KEY_CACHE_ID });
}

/** Drop the cached household-data-key entry (in-IDB; survives bare logout). */
export async function clearKeyCacheStore(): Promise<void> {
  const handle = await db();
  await handle.clear('keyCache');
}

// Evicts the lowest-`seq` rows until the store holds at most `max`; shared by the append-time prune and the
// `pruneDiagnosticLogs` backstop, running on an open `readwrite` store so it fits the append's one-transaction window.
async function pruneDiagnosticsToMax(
  store: IDBPObjectStore<Schema, ['diagnosticLogs'], 'diagnosticLogs', 'readwrite'>,
  max: number,
): Promise<void> {
  const total = await store.count();
  if (total <= max) return;
  let remaining = total - max;
  let cursor = await store.index('seq').openCursor();
  while (cursor && remaining > 0) {
    await cursor.delete();
    remaining -= 1;
    cursor = await cursor.continue();
  }
}

/**
 * Appends diagnostics entries and prunes the store back to `max` in one `readwrite` transaction. The monotonic `seq` is
 * allocated inside it (current max via the `seq` index, plus one), so order holds across tabs within a same-millisecond
 * batch, which a module-level counter or an ISO-`ts` index cannot give; the entries' own `seq` is overwritten. Returns
 * the entries as persisted, so the caller can keep the in-memory ring aligned.
 */
export async function appendDiagnosticLogs(
  entries: readonly DiagnosticLogEntry[],
  max: number,
): Promise<DiagnosticLogEntry[]> {
  const handle = await db();
  const tx = handle.transaction('diagnosticLogs', 'readwrite');
  const seqIndex = tx.store.index('seq');
  // Highest existing seq (cursor on the seq index, descending) → next seq.
  const last = await seqIndex.openCursor(null, 'prev');
  let nextSeq = (typeof last?.value.seq === 'number' ? last.value.seq : 0) + 1;
  const persisted: DiagnosticLogEntry[] = [];
  for (const entry of entries) {
    const row: DiagnosticLogEntry = { ...entry, seq: nextSeq };
    nextSeq += 1;
    await tx.store.put(row);
    persisted.push(row);
  }
  await pruneDiagnosticsToMax(tx.store, max);
  await tx.done;
  return persisted;
}

/** Read every persisted diagnostics entry in insertion (`seq`) order. */
export async function listDiagnosticLogs(): Promise<DiagnosticLogEntry[]> {
  const handle = await db();
  return handle.getAllFromIndex('diagnosticLogs', 'seq');
}

/**
 * Prunes the diagnostics store back to `max` rows (lowest `seq` first): the startup, cross-tab and crash backstop for
 * the append-time prune.
 */
export async function pruneDiagnosticLogs(max: number): Promise<void> {
  const handle = await db();
  const tx = handle.transaction('diagnosticLogs', 'readwrite');
  await pruneDiagnosticsToMax(tx.store, max);
  await tx.done;
}

/** Drop every persisted diagnostics entry (card Clear + every wipe path). */
export async function clearDiagnosticLogs(): Promise<void> {
  const handle = await db();
  await handle.clear('diagnosticLogs');
}

/**
 * True iff any aggregate store holds a row whose `householdId` differs from `expectedHouseholdId`; empty stores (a
 * first-ever login) are false. A defence-in-depth check for `AuthContext.maybeResetForNewUser` that doesn't trust the
 * localStorage transition tracker (DevTools can wipe or fake it); one `count()` per store via the `householdId` index.
 */
export async function hasForeignHouseholdData(
  expectedHouseholdId: string,
): Promise<boolean> {
  const handle = await db();
  for (const store of Object.values(STORE_BY_TYPE) as AggregateStore[]) {
    const tx = handle.transaction(store, 'readonly');
    const total = await tx.store.count();
    if (total === 0) continue;
    const matching = await tx.store
      .index('householdId')
      .count(expectedHouseholdId);
    if (matching < total) return true;
  }
  return false;
}

/**
 * Clears every aggregate store, `mutations` and `keyCache` (the Full Sync reset in SyncContext): a cached HDK left over
 * freshly wiped data would look unlocked over nothing. `deviceMetadata`, `selectedScenario` and `diagnosticLogs` are
 * preserved, so the device keeps its `deviceId`, scenario pointer and debugging state across a force-bootstrap; only
 * `dropLocalDatabase()` and the card Clear wipe diagnostics.
 */
export async function clearAllStores(): Promise<void> {
  const handle = await db();
  const stores = [
    ...Object.values(STORE_BY_TYPE) as AggregateStore[],
    'mutations' as const,
    'keyCache' as const,
  ];
  const tx = handle.transaction(stores, 'readwrite');
  await Promise.all(stores.map((s) => tx.objectStore(s).clear()));
  await tx.done;
  // A clear empties every aggregate store, so wake each reactive reader.
  for (const store of Object.values(STORE_BY_TYPE) as AggregateStore[]) {
    notifyStoreChanged(store);
  }
}

/**
 * Hard-deletes the whole IndexedDB database, for "Clear data on this device" (Workspace tools) and the cross-user
 * transition guard; the next `db()` opens a fresh one. If other connections hold it open the browser queues the delete;
 * we wait up to 2 s and then reject with {@link DatabaseDropBlockedError}, because a not-yet-completed drop is not a
 * success and the guard must fail closed rather than expose a new account over a previous account's stale rows. The
 * queued delete still completes once other tabs release (nudged via {@link nudgeOtherTabsToReleaseIdb}), so a retry
 * resolves cleanly.
 */
export async function dropLocalDatabase(): Promise<void> {
  if (dbPromise) {
    const handle = await dbPromise;
    handle.close();
    dbPromise = null;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      reject(req.error ?? new Error('Failed to delete IndexedDB'));
    };
    // Other tabs hold the DB open, so the delete is queued. If `onsuccess` hasn't fired by the cap, reject so the
    // caller fails closed (no new lastUserId stored, no new household exposed); the user retries after closing other
    // tabs.
    req.onblocked = () => {
      console.warn('[db] deleteDatabase blocked by another connection; failing closed after 2 s if not released');
      setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new DatabaseDropBlockedError());
      }, IDB_BLOCKED_TIMEOUT_MS);
    };
  });
  // Wake every reactive reader to see its emptied store (as clearAllStores does).
  for (const store of Object.values(STORE_BY_TYPE) as AggregateStore[]) {
    notifyStoreChanged(store);
  }
}

function migrateAggregate(type: AggregateType, aggregate: Aggregate): Aggregate {
  if (aggregate.schemaVersion >= currentSchemaVersion(type)) return aggregate;
  return {
    ...aggregate,
    schemaVersion: currentSchemaVersion(type),
    payload: migrate(type, aggregate.payload, aggregate.schemaVersion),
  };
}

// Mirror of {@link migrateAggregate} for a queued mutation row. The `mutations` store isn't migrated on read like the
// aggregate stores, so a row queued by an older build would keep round-tripping a field a payload migration has since
// dropped (through both `listAllMutations` and `listPendingMutations`) until it flushes. Returns the input unchanged
// when already current, so callers can detect a change.
function migrateMutation(m: PendingMutation): PendingMutation {
  const current = currentSchemaVersion(m.aggregateType);
  if (m.schemaVersion >= current) return m;
  return {
    ...m,
    schemaVersion: current,
    payload: migrate(m.aggregateType, m.payload, m.schemaVersion),
  };
}

// Reads every queue row for one `status`, migrating schema-behind payloads in memory and persisting the upgrade via
// {@link persistMutationUpgrades} only when a row was behind. The read stays `readonly`: these run on every poll tick
// and flush (three at a time from `refreshCounts`), and a `readwrite` read would serialize each behind and ahead of
// real queue writes and add a macrotask turn per read. The write lock is taken only in the upgrade window, once per
// row.
async function listStatusRowsUpgraded(
  handle: IDBPDatabase<Schema>,
  status: PendingMutation['status'],
): Promise<PendingMutation[]> {
  const tx = handle.transaction('mutations', 'readonly');
  const rows = await tx.store.index('status').getAll(status);
  const upgraded = rows.map(migrateMutation);
  const behind = rows.filter((m, i) => upgraded[i] !== m);
  if (behind.length > 0) {
    await persistMutationUpgrades(
      handle,
      behind.map((m) => m.id),
    );
  }
  return upgraded;
}

// Best-effort persist of a payload-schema upgrade. Atomic against concurrent writers: each row is re-read inside the
// `readwrite` transaction and its own migrated copy written, so a status/reason or removal made since the caller's
// readonly snapshot is never clobbered by a stale put (a gone row is skipped, a current one left alone). Never a
// dependency of the read, which already holds the correct upgrade in memory: a failed persist (origin storage at quota
// is the realistic case) must not fail `listPendingMutations`, since that flush drains the queue and frees the space.
// Abort, consume the `tx.done` rejection, log, move on; the rows stay behind on disk and the next read retries.
async function persistMutationUpgrades(
  handle: IDBPDatabase<Schema>,
  ids: readonly string[],
): Promise<void> {
  const tx = handle.transaction('mutations', 'readwrite');
  try {
    for (const id of ids) {
      const current = await tx.store.get(id);
      if (!current) continue;
      const next = migrateMutation(current);
      if (next !== current) await tx.store.put(next);
    }
    await tx.done;
  } catch (err) {
    try {
      tx.abort();
    } catch {
      // Already aborting/committed — nothing to undo.
    }
    await tx.done.catch(() => undefined);
    console.warn(
      '[db] mutation-queue payload upgrade was not persisted; retrying on the next read',
      err,
    );
  }
}

export { STORE_BY_TYPE };

/**
 * True for a type in `STORE_BY_TYPE`; SyncContext uses it to skip pulled aggregates of a removed type that a stale
 * server (rolling deploy, S3 snapshot drift) still serves. The server filters egress against `ACTIVE_AGGREGATE_TYPES`
 * (apps/api/src/sync/aggregate-types.ts).
 */
export function isKnownAggregateType(type: string): type is AggregateType {
  return Object.prototype.hasOwnProperty.call(STORE_BY_TYPE, type);
}
