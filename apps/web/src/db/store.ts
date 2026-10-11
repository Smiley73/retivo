/**
 * IndexedDB wrapper. One object store per aggregate type plus stores
 * for the local mutation queue and per-device metadata. Schema version
 * here is the *IDB schema version*, not the per-aggregate `schemaVersion`
 * — bumping it triggers `upgrade()` to add new stores.
 *
 * The working store is fully local (see "Browser storage" in
 * docs/architecture.md); reads come from these
 * stores immediately, writes append to `mutations` and flush via the
 * sync client.
 */
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

/**
 * Cap (ms) we wait for a blocked IDB operation to release before failing
 * closed with a typed error instead of hanging indefinitely. Shared by
 * {@link dropLocalDatabase} (a blocked `deleteDatabase`) and {@link db} (a
 * blocked v9 `openDB`) so both honest-timeout paths use one constant.
 */
const IDB_BLOCKED_TIMEOUT_MS = 2000;

/**
 * Thrown by {@link dropLocalDatabase} when `deleteDatabase` stays blocked
 * past the timeout (another tab still holds the IDB open). A typed error so
 * the cross-user transition guard can fail closed and the UI can surface the
 * "close all other tabs then retry" prompt.
 */
export class DatabaseDropBlockedError extends Error {
  constructor() {
    super('IndexedDB delete was blocked by another connection and did not complete');
    this.name = 'DatabaseDropBlockedError';
  }
}

/**
 * Thrown by {@link db} when the v9 `openDB` upgrade stays blocked past
 * {@link IDB_BLOCKED_TIMEOUT_MS} (an older-version tab still holds the IDB
 * open and never released — e.g. a pre-this-feature v8 bundle with no
 * `blocking()` handler during a rollout). A typed error so callers see an
 * honest failure rather than an indefinite hang, and so the cached
 * `dbPromise` is reset for a clean retry once the blocking tab closes.
 */
export class DatabaseUpgradeBlockedError extends Error {
  constructor() {
    super('IndexedDB upgrade was blocked by another connection and did not complete');
    this.name = 'DatabaseUpgradeBlockedError';
  }
}

/**
 * Thrown by the transactional queue-collapse primitives
 * ({@link collapseToFailedConflict}, {@link replaceQueueMutationsAtomically})
 * when the aggregate's live queue stack — re-read INSIDE the collapse
 * transaction — no longer matches the snapshot the caller classified: a
 * `queueLocalMutation` from a concurrent user edit for the SAME aggregate
 * landed between the caller's stack read and this commit. The collapse aborts
 * (writes nothing) rather than stomping that edit; the auto-repair pass catches
 * this, leaves the rejection pending, and re-routes the aggregate on the next
 * flush round with the fresh stack (closes the
 * check-and-mutate TOCTOU). The `aggregateId` is kept as a structured property,
 * not interpolated into the message, so a stray log never carries the raw id.
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
 * Thrown by {@link writeAccountWithRetypeGuard} when the caller's `decide`
 * callback refuses the write — the account has real balance history and the
 * submitted type differs from what's persisted. The aggregate id AND the fresh, ACTUALLY-persisted
 * type the write was refused against are structured properties, not
 * interpolated into the message, mirroring {@link ConcurrentQueueMutationError}
 * — a caller building a refusal message from anything else (e.g. a snapshot
 * taken when the editor opened) can end up naming a type the person is
 * already past.
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
 * Thrown by {@link writeAccountWithRetypeGuard} when the in-transaction
 * balance read the caller's `needsBalanceRead` requested itself fails —
 * distinct from {@link AccountRetypeBlockedError} so the caller can render the
 * "could not check" copy rather than claim the account has (or lacks) real
 * history it was never able to read.
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
 * Device-local cache row for the household data key (HDK), used by the
 * zero-knowledge encryption boundary. Held as
 * exported raw bytes so it survives an IDB structured-clone round-trip.
 *
 * It lives in the `keyCache` store **inside** the `retirement` IDB — never a
 * second database — so it rides the centralized `dropLocalDatabase()` /
 * `clearAllLocalData()` teardown (the HDK is dropped exactly when the IDB is
 * dropped, no parallel clearing). The store is a singleton: one HDK per device,
 * keyed by the fixed {@link KEY_CACHE_ID}; `householdId` is carried as a field
 * so a stale entry from a prior household can be detected and ignored.
 */
export interface KeyCacheEntry {
  /** Fixed singleton keyPath value — always {@link KEY_CACHE_ID}. */
  id: string;
  householdId: string;
  hdkExported: ArrayBuffer;
}

/** Singleton key for the {@link KeyCacheEntry} row in the `keyCache` store. */
export const KEY_CACHE_ID = 'hdk';

/** Cached Monte Carlo result row. Local-only, not synced. Two INDEPENDENTLY
 *  enforced LRU budgets are applied on insert — one for ordinary (`'primary'`)
 *  entries and one for the market-stress comparison's — and eviction only ever
 *  drops entries from the budget that went over, so neither kind can push the
 *  other out. `monte-carlo-cache.ts` owns both caps and is the place to read
 *  their current sizes. Invalidated when `engineVersion` doesn't match the
 *  current build's `ENGINE_VERSION`. */
export interface MonteCarloCacheEntry {
  /** SHA-256 (16 hex chars) of the projection-relevant aggregate
   *  snapshot. Acts as the primary key. */
  id: string;
  /** Monte Carlo engine version at the time the entry was computed.
   *  Mismatched entries are silently re-computed on read. */
  engineVersion: number;
  /** Serialized `MonteCarloSummary`. Kept opaque to the store; the
   *  cache helper handles the typed cast. */
  summary: unknown;
  /** Last-read timestamp (ms epoch) — drives LRU eviction. */
  lastAccessedAt: number;
  /** Which LRU BUDGET this entry is charged to.
   *  ABSENT means `'primary'`, so every entry written before the split — and
   *  every ordinary run since — keeps the primary budget with no migration.
   *  `'marketStress'` marks the seed-inclusive entries one market-stress
   *  comparison writes; they are capped separately so a comparison can never
   *  evict the per-scenario results the Scenarios page reads. */
  entryClass?: 'marketStress';
}

/**
 * One persisted on-device diagnostics entry (v9). Local-only, NOT synced and
 * NOT aggregate data — a debugging breadcrumb/error captured by the
 * `lib/diagnostics` logger and mirrored here so entries survive a crash/reload.
 * `seq` is a strictly-monotonic counter allocated INSIDE the append
 * transaction (read max-via-index + 1) so prune order stays correct across
 * tabs even within a same-millisecond batch. Shape mirrors the in-memory
 * `DiagnosticEntry`; the store keeps it opaque via `Record<string, unknown>`
 * so the logger owns the typed contract.
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

/**
 * Per-store change-notification registry. Each `AggregateStore` carries a
 * monotonically increasing version counter and a set of subscribers; a
 * single-row write to that store (`putAggregate` / `deleteAggregateLocally`)
 * bumps the counter and wakes only that store's subscribers, so a reactive
 * read hook can re-read on **any** write to its own type without the consumer
 * wiring a manual revision dependency (the live-query read layer).
 *
 * This is the per-type FINE signal. The bulk-fill paths (sync bootstrap/pull,
 * demo loader, expense-categories bootstrap, data-import, scenario cascades)
 * wrap their write loop in {@link withBatchedStoreSignals}: inside the scope
 * each write records its touched store on the batch instead of firing per row,
 * and the scope flushes **one** fine signal per touched store on exit. They
 * additionally keep their existing end-of-loop coarse `WORKSPACE_CHANGED_EVENT`
 * (where they had one), which the hook folds into the same re-read via a union.
 * `clearAllStores` is the one single-call path that touches every store, so it
 * notifies all of them.
 *
 * The counter is a `useSyncExternalStore`-friendly sync snapshot: the data
 * read itself is async (`listAggregates`), so the subscribed value is a
 * version number, not the rows.
 */
const storeVersions = new Map<AggregateStore, number>();
const storeListeners = new Map<AggregateStore, Set<() => void>>();

/** Current change-version for a store (0 until its first write). */
export function getStoreVersion(store: AggregateStore): number {
  return storeVersions.get(store) ?? 0;
}

/**
 * Subscribe to single-write changes on one aggregate store. Returns an
 * unsubscribe function. Pairs with {@link getStoreVersion} for
 * `useSyncExternalStore`.
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

/** Bump a store's version and wake its subscribers. */
function notifyStoreChanged(store: AggregateStore): void {
  storeVersions.set(store, getStoreVersion(store) + 1);
  storeListeners.get(store)?.forEach((listener) => listener());
}

/**
 * Per-load signal-suppression scope handle. A `Batch` is just the set of
 * stores a bulk load has written to inside one {@link withBatchedStoreSignals}
 * scope. While a batch is threaded through `putAggregate` /
 * `deleteAggregateLocally`, those mutators record the touched store on it
 * instead of firing the per-row fine signal; the scope then emits one
 * `notifyStoreChanged` per touched store on exit. Each scope owns a fresh
 * `Batch`, so two un-serialized bulk loads never share or clobber each other's
 * touched-store set (the concurrency-safety guarantee — no global flag).
 */
export type Batch = Set<AggregateStore>;

/**
 * Either record the touched store on the batch (suppressing the per-row fine
 * signal until scope exit) or notify immediately when no batch is in scope.
 * The single decision point both single-write mutators share.
 */
function recordOrNotify(store: AggregateStore, batch: Batch | undefined): void {
  if (batch) {
    batch.add(store);
  } else {
    notifyStoreChanged(store);
  }
}

/**
 * Run `fn` with a fresh signal-suppression batch and, on the way out, flush
 * **one** fine `notifyStoreChanged` per store the batch touched. Bulk writers
 * wrap their write loop in this and thread the supplied `batch` into every
 * `putAggregate` / `deleteAggregateLocally` (directly or via
 * `queueLocalMutation` / `saveScenario` / `applyPulledChange`) so a row-by-row
 * burst collapses to one fine signal per touched store instead of N per row.
 *
 * The flush runs on **both** the success and the error path (an exception
 * inside the scope still wakes the touched-store subscribers, then re-throws)
 * — a thrown error mid-bulk must not strand mounted readers on stale data.
 * Per-type isolation holds: only stores actually written wake.
 *
 * Each call owns its own `Batch` set, so overlapping loads (e.g. a demo load
 * during a background sync `pull`) each flush only their own touched stores.
 * The coarse `WORKSPACE_CHANGED_EVENT` is NOT owned here — callers
 * keep their existing end-of-loop `notifyWorkspaceChanged()`.
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

/**
 * Same-origin BroadcastChannel name for the cross-tab IDB-release nudge
 * (see "Browser storage" in docs/architecture.md). When a cross-user login needs to
 * drop the IDB but another tab still holds it open, the dropping tab posts
 * {@link IDB_RELEASE_NUDGE} on this channel; every other tab closes its
 * cached handle (below) so the queued `deleteDatabase` can complete and the
 * blocked login can be retried.
 */
const IDB_NUDGE_CHANNEL = 'retivo.idb.nudge';
/** Message payload telling other tabs to close their IDB handle. */
const IDB_RELEASE_NUDGE = 'release-idb';

let nudgeChannel: BroadcastChannel | null = null;

/**
 * Lazily open the cross-tab nudge channel and register the release listener.
 * Stateful singleton with lifecycle cleanup ({@link closeNudgeChannel}) per
 * CODING_STANDARDS "stateful singletons need lifecycle cleanup". A tab that
 * receives the nudge closes its cached IDB handle so another tab's pending
 * `deleteDatabase` is no longer blocked. Closing the handle is safe: the next
 * `db()` call transparently reopens it.
 */
function ensureNudgeChannel(): void {
  if (nudgeChannel || typeof BroadcastChannel === 'undefined') return;
  nudgeChannel = new BroadcastChannel(IDB_NUDGE_CHANNEL);
  nudgeChannel.onmessage = (event: MessageEvent) => {
    if (event.data !== IDB_RELEASE_NUDGE) return;
    void closeIdbHandle();
  };
}

/**
 * Close the cached IDB handle (if open) and null the promise so the next
 * {@link db} call reopens a fresh connection. Used by the cross-tab nudge
 * listener so this tab stops blocking another tab's `deleteDatabase`.
 */
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
 * Notify every other same-origin tab to close its IDB handle so a pending
 * `deleteDatabase` can complete. Emitted by the cross-user transition guard
 * before/around a drop (see auth/user-transition.ts). No-op where
 * BroadcastChannel is unavailable (older runtimes / SSR).
 */
export function nudgeOtherTabsToReleaseIdb(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  ensureNudgeChannel();
  nudgeChannel?.postMessage(IDB_RELEASE_NUDGE);
}

/**
 * Tear down the nudge channel. Lifecycle cleanup for the stateful singleton
 * above; call from teardown paths / tests so the listener is not leaked.
 */
export function closeNudgeChannel(): void {
  nudgeChannel?.close();
  nudgeChannel = null;
}

/**
 * Wrap a pending `openDB` promise with a bounded blocked-timeout. The
 * returned promise resolves with the handle on a normal open, but if the
 * caller arms the timeout via {@link ArmableOpen.armBlockedTimeout} (from the
 * `openDB` `blocked()` callback) and the open has not resolved within
 * {@link IDB_BLOCKED_TIMEOUT_MS}, it REJECTS with
 * {@link DatabaseUpgradeBlockedError} so `db()` surfaces an honest error
 * instead of an indefinite hang. A late real resolution (the blocking tab
 * finally closed) is not double-settled: the handle is closed and discarded so
 * it is never returned as a half-state. The arm-timer is cleared on resolve.
 *
 * Factored out of {@link db} so the bounded-wait is unit-testable without
 * driving a real `onblocked` (which `fake-indexeddb` cannot trigger).
 */
interface ArmableOpen {
  promise: Promise<IDBPDatabase<Schema>>;
  /** Call from the `openDB` `blocked()` callback to start the failure timer. */
  armBlockedTimeout: () => void;
}

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
          // Timed out already → discard the late handle so it is never cached
          // as a half-state (the db() caller already reset dbPromise).
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
  // Register the cross-tab release listener as soon as a connection is
  // opened, so this tab will yield its handle when another tab needs to
  // drop the database.
  ensureNudgeChannel();
  if (!dbPromise) {
    let armBlockedTimeout: () => void = () => {};
    const rawOpen = openDB<Schema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // v2: removed the 'plans' store.
        if (db.objectStoreNames.contains('plans' as never)) {
          db.deleteObjectStore('plans' as never);
        }
        // The loop below covers v6's added `incomeStreams` store too;
        // any object store missing from the live schema gets created
        // with the standard household/updatedAt indexes.
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
        // v7: Monte Carlo result cache (LRU N=5, local-only, not synced).
        if (!db.objectStoreNames.contains('monteCarloResults')) {
          const os = db.createObjectStore('monteCarloResults', { keyPath: 'id' });
          os.createIndex('lastAccessedAt', 'lastAccessedAt');
        }
        // v8: device-local household-data-key cache (singleton, local-only,
        // not synced) for zero-knowledge payload encryption.
        // Inside the `retirement` IDB so it rides the centralized nuke.
        if (!db.objectStoreNames.contains('keyCache')) {
          db.createObjectStore('keyCache', { keyPath: 'id' });
        }
        // v9: on-device diagnostics log (local-only, NOT synced, NOT
        // aggregate data). The `seq` index drives the append-time prune
        // cursor. Preserved across clearAllStores / force-bootstrap
        // but wiped by every dropLocalDatabase.
        if (!db.objectStoreNames.contains('diagnosticLogs')) {
          const os = db.createObjectStore('diagnosticLogs', { keyPath: 'id' });
          os.createIndex('seq', 'seq');
        }
      },
      // A v9 open blocked by an open v8 tab would otherwise stall db() and
      // freeze all IDB I/O in this tab. Close this tab's cached handle so a
      // sibling's upgrade can proceed (mirrors the nudge closeIdbHandle); the
      // bounded blocked-timeout below then guarantees the promise db() returns
      // REJECTS with DatabaseUpgradeBlockedError (and the cache is reset for a
      // clean retry) rather than hanging forever.
      blocking() {
        void closeIdbHandle();
      },
      blocked() {
        console.warn(
          '[db] IndexedDB upgrade to v9 is blocked by another open tab; close other tabs of this app to finish upgrading',
        );
        // Arm the bounded failure path: a sibling that never releases (e.g. a
        // pre-this-feature v8 tab with no blocking() handler during rollout)
        // would otherwise leave this promise pending forever.
        armBlockedTimeout();
      },
      terminated() {
        // The browser killed the connection (e.g. storage pressure). Drop the
        // cached promise so the next db() call reopens a fresh handle.
        dbPromise = null;
      },
    });
    const wrapped = wrapOpenWithBlockedTimeout(rawOpen);
    armBlockedTimeout = wrapped.armBlockedTimeout;
    // On a blocked-timeout reject (or any open error), reset the cached promise
    // so a later db() call retries cleanly instead of awaiting a rejected
    // promise forever. Re-throw so the awaiting caller sees the error.
    // Guard the reset against a sibling that already replaced the cache (e.g. a
    // terminated() reopen) so we only null our own chain.
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
 * Like {@link listAggregates}, but **does not** filter tombstones.
 * Used by the demo-reload and import paths to detect cloud-side
 * tombstones (which bootstrap wrote into IDB with `deletedAt` set) so
 * a subsequent reload can queue `update @ tombstone_version` instead
 * of `create @ 0` — cloud's `attribute_not_exists OR version=:expected`
 * condition would always reject create-at-0 against an existing
 * tombstoned row, leaving the badge stuck on "Refresh needed".
 *
 * Don't use this for UI reads — the workspace should never display
 * deleted rows. Reserved for the bookkeeping paths that need to
 * reason about cloud version chains, including past tombstones.
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
 * Like {@link getAggregate}, but **does not** filter tombstones: returns
 * the migrated row even when it carries a `deletedAt` (a soft-delete
 * tombstone). `null` only when the row is genuinely absent.
 *
 * Reserved for the bookkeeping paths that must reason about a row the
 * cloud has tombstoned — e.g. the discard convergence check in
 * `resolveConflict`, where adopting a remote deletion leaves the local
 * row a pulled tombstone that {@link getAggregate} would (wrongly) read as
 * absent, failing the convergence predicate. Don't use this for UI reads —
 * the workspace must never display a deleted row (use {@link getAggregate}).
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
  // Upgrade any row a prior (schema-behind) build queued before it can be
  // pushed. The read stays `readonly`; the (rare) persist is a separate
  // read-check-write — see listStatusRowsUpgraded for why.
  const migrated = await listStatusRowsUpgraded(handle, 'pending');
  // The `status` index orders ties by primary key (random UUID), so flush
  // order would be random. Sort by the monotonic `timestamp` so the server
  // applies same-aggregate mutations in creation order (an update can't be
  // pushed before its create). queueLocalMutation guarantees strict
  // (non-tying) timestamps.
  return migrated.sort((a, b) => a.timestamp - b.timestamp);
}

export async function listFailedConflicts(): Promise<PendingMutation[]> {
  const handle = await db();
  return listStatusRowsUpgraded(handle, 'failed-conflict');
}

/**
 * Mirror of `listFailedConflicts` for the `failed-error` status. Returns `[]`
 * in production today — no current code writes `failed-error` (a transport
 * error leaves items `pending`), so this is forward-compat scaffolding for the
 * sync inspector that lights up when a future writer stamps that status.
 */
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
  // Stamp the rejection reason (or clear a stale one when none is passed —
  // any non-failure transition, e.g. a retry back to `pending`). The
  // rejection loop passes the allowlist-normalised reason; every other caller
  // omits it and thereby clears.
  m.reason = reason;
  await tx.store.put(m);
}

export async function removeMutation(id: string): Promise<void> {
  const handle = await db();
  await handle.delete('mutations', id);
}

/**
 * Atomically remove a set of queue mutations in ONE `mutations` readwrite
 * transaction. The auto-repair `drop` path uses this:
 * a simple delete-vs-deleted drop scopes to just the rejected row, while a
 * create-over-tombstone whose local stack ends in a delete (the poison train)
 * scopes to the WHOLE stack so no stale sibling survives to re-conflict.
 * All-or-nothing — a fault mid-removal aborts the transaction, so the queue is
 * never left partially swept. Missing ids are ignored; an empty list is a no-op.
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
    // Roll the whole removal back on any fault — abort explicitly, consume the
    // resulting `tx.done` rejection so it is not an unhandled promise, and
    // re-throw the original error.
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
 * Re-queue a parked mutation as a fresh-id `pending` row in ONE `mutations`
 * transaction (Check & repair): delete `oldId` and put
 * a copy carrying `freshId`, `status:'pending'`, and the rejection facts
 * (`reason` / `currentVersion` / `currentUpdatedAt`) cleared. A FRESH id is
 * mandatory — replaying the original would hit the server's 7-day cached
 * `CONFLICT`; resetting the status to `pending` is required because
 * `flushPending` only pushes `pending` rows. The follow-on rejection re-drives
 * the auto-repair pass — silently resolving a since-fixed conflict and
 * rehydrating a legacy row's server facts (`currentVersion` / `currentUpdatedAt`
 * / tombstone flag). No-op on a missing id.
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

/** Every queue row (any status) for one aggregate id, via the `aggregateId`
 *  index. The auto-repair pass reads the FULL stack (pending + failed-conflict)
 *  for an aggregate so a later pending sibling can't re-poison it after a
 *  collapse. */
export async function listMutationsByAggregate(
  aggregateId: string,
): Promise<PendingMutation[]> {
  const handle = await db();
  const tx = handle.transaction('mutations', 'readonly');
  return tx.store.index('aggregateId').getAll(aggregateId);
}

/** Every queue row (any status). Used by the version-truth capture to recover
 *  each aggregate's last server-acknowledged version before a destructive
 *  `clearMutationQueue()`, and by the
 *  server-authoritative export's `readAllMutations` default.
 *
 *  Migrates a schema-behind row's payload in memory before returning it (so
 *  neither caller ever sees a retired field), but — unlike
 *  {@link listPendingMutations} / {@link listFailedConflicts} /
 *  {@link listFailedErrors}, which persist the upgrade because they already
 *  feed a push or a status write — never persists it. This function is the
 *  read the export's "never writes workspace/queue state" contract depends
 *  on: same in-memory pattern as {@link listAggregatesIncludingDeleted}. */
export async function listAllMutations(): Promise<PendingMutation[]> {
  const handle = await db();
  const rows = await handle.getAll('mutations');
  return rows.map(migrateMutation);
}

/**
 * Concurrency fence for the transactional queue-collapse primitives: the
 * aggregate's live queue stack (re-read INSIDE the collapse transaction) must
 * still equal the snapshot the caller classified. A concurrent
 * `queueLocalMutation` for the same aggregate adds a row absent from
 * `expectedIds`; committing the collapse would then stomp (or exclude) it — a
 * silent lost update. Throw {@link ConcurrentQueueMutationError} so the caller
 * aborts and re-routes on the next round. A
 * MISSING row is fine (a concurrent apply-remove) — only an unexpected ADDED
 * row signals the lost-update race.
 */
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
 * Park a rejected mutation as `failed-conflict`, persisting the rejection facts
 * the manual Resolve UI re-bases from. Unlike
 * {@link updateMutationStatus}, this writes `reason` + `currentVersion` +
 * `currentUpdatedAt` **together** in one transaction, so persisting the server
 * facts can never clobber the reason (the "preserve reason on a status change"
 * rule). Each omitted fact is written as absent. No-op on a missing id.
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
 * Collapse an aggregate's stack to ONE parked `failed-conflict` representative
 * (escalation): remove the sibling rows and stamp
 * the representative with the rejection facts, all in one `mutations`
 * transaction. Restart-safe — a crash before the tx commits leaves every row
 * `pending`, so the next flush re-escalates identically. No-op on a missing
 * representative. Re-reads the aggregate's live stack inside the transaction
 * first and aborts with {@link ConcurrentQueueMutationError} if a concurrent
 * `queueLocalMutation` landed since the caller's snapshot.
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
    // Concurrency fence: re-read the live stack BEFORE any write and
    // confirm it still matches the caller's snapshot; abort otherwise so the
    // repair pass re-routes next round rather than folding a stale collapse.
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
    // Roll the whole collapse back on any fault (the concurrency abort above,
    // or a request error) — abort explicitly, consume the resulting `tx.done`
    // rejection so it is not an unhandled promise, and re-throw the original.
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
 * Atomically remove a set of queue mutations, write a corrected local aggregate
 * row, and append ONE fresh mutation — all in a single IDB readwrite
 * transaction over `mutations` + the aggregate's store.
 * The collapse/re-queue primitive the auto-repair
 * re-base + manual keep resolution use: unlike {@link queueLocalMutation}
 * (aggregate write + queue write in SEPARATE transactions), a crash mid-collapse
 * here can never drop the un-synced edit — the whole swap commits or none of it
 * does. Fires the aggregate store's fine change signal after commit so
 * mounted readers re-read.
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
    // Concurrency fence: re-read the aggregate's live queue stack INSIDE
    // this transaction, BEFORE any write, and confirm it still matches the
    // caller's snapshot (`removeMutationIds`). A `queueLocalMutation` from a
    // concurrent user edit that landed after the caller read the stack adds a
    // row absent from that snapshot; writing `correctedAggregate` here would
    // stomp it (a silent lost update). Abort instead — the repair pass re-reads
    // and re-routes the aggregate on the next round.
    assertQueueStackUnchanged(
      await mutations.index('aggregateId').getAll(args.freshMutation.aggregateId),
      args.removeMutationIds,
      args.freshMutation.aggregateId,
    );
    // Append the fresh mutation FIRST, then remove the stale rows, so if any
    // step throws the un-synced edit is never the casualty (queue-before-remove
    // — the restart-safe ordering). The explicit abort below rolls the
    // whole swap back on any fault; the ordering is the belt to that suspenders.
    await mutations.put(args.freshMutation);
    await tx.objectStore(store).put(args.correctedAggregate);
    for (const id of args.removeMutationIds) {
      if (id === args.freshMutation.id) continue;
      await mutations.delete(id);
    }
    await tx.done;
  } catch (err) {
    // A request error (e.g. a DataCloneError) must roll the whole transaction
    // back — abort explicitly, then consume the resulting `tx.done` rejection so
    // it is not an unhandled promise, and re-throw the original error.
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

/** The aggregate + queue row {@link writeAccountWithRetypeGuard} commits on a
 *  successful write. */
export interface GuardedAccountWrite {
  readonly aggregate: Aggregate<AccountPayload>;
  readonly mutation: PendingMutation;
}

/** What the caller's `decide` callback in {@link writeAccountWithRetypeGuard}
 *  returns: either the write to commit, or a refusal (writes nothing). */
export type GuardedAccountDecision = GuardedAccountWrite | { readonly refuse: true };

/**
 * Guarded account save:
 * ONE IndexedDB `readwrite` transaction over the `accounts`, `accountBalances`
 * and `mutations` stores that reads the account's FRESH, tombstone-filtered,
 * migrated row first, optionally reads that account's fresh, tombstone-
 * filtered, migrated balance rows, then asks the caller's `decide` callback
 * for a verdict — all before any write, so a blocked type change writes
 * nothing (mirrors {@link replaceQueueMutationsAtomically}: re-read inside,
 * explicit abort on fault, {@link notifyStoreChanged} only after commit).
 *
 * `db/` may not import `pages/` or `sync/` (`.dependency-cruiser.cjs` →
 * `db-layering`), so this primitive is domain-free: it knows nothing about
 * account *types* or retype rules, only that a caller-supplied predicate
 * decides whether the balance read is needed at all, and a caller-supplied
 * decision decides whether to write or refuse. `decide` (and
 * `needsBalanceRead`) MUST be synchronous and must not await anything
 * non-IDB — an IDB transaction auto-commits as soon as control returns to the
 * event loop with no pending request, so an `await` on a plain promise inside
 * either callback would silently end the transaction out from under the
 * write that follows.
 *
 * Throws {@link AccountRetypeBlockedError} when `decide` refuses, or
 * {@link AccountRetypeCheckFailedError} when the balance read itself fails
 * (only reachable when `needsBalanceRead` returned `true`). Any other fault —
 * including the account row being absent or tombstoned — is a plain `Error`:
 * the pre-existing general save-failure path, not this feature's to type.
 */
export async function writeAccountWithRetypeGuard(args: {
  accountId: string;
  /** Synchronous. Called with the fresh account row; `true` means this write
   *  also needs that account's fresh balance rows before `decide` can judge
   *  it (e.g. "the submitted type differs from what's persisted"). */
  needsBalanceRead: (freshAccount: Aggregate<AccountPayload>) => boolean;
  /** Synchronous. Called with the fresh account row and — only when
   *  `needsBalanceRead` returned `true` — that account's fresh balance rows. */
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
    // Roll the whole write back on any fault (a refusal, a failed balance
    // read, a missing account, or a request error) — abort explicitly,
    // consume the resulting `tx.done` rejection so it is not an unhandled
    // promise, and re-throw the original error.
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
 * Drop every entry from the mutation queue (pending + failed-conflict).
 * Used by the demo-reload overwrite path: legacy `failed-conflict`
 * mutations from a previously broken load would otherwise survive the
 * wipe and keep the badge stuck on "Refresh needed" even after a clean
 * sync round-trip.
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
 * Atomic read-modify-write of the singleton `deviceMetadata` row inside ONE
 * IDB `readwrite` transaction (get → updater → put → await tx.done). IDB
 * transactions are atomic even across tabs, so this closes the lost-update
 * class the plain `readDeviceMetadata`/`writeDeviceMetadata` pair exposes:
 * two sync flows that each read the full row, mutate one field, and write the
 * whole row back would otherwise let last-writer-wins clobber a sibling
 * field's just-persisted value (e.g. a pull's `syncCursor` reverted by a
 * concurrent freshness-pin persist). The `updater` must update ONLY the
 * fields it owns and spread the rest of `current` so the transaction's read
 * (not a stale earlier read) is the merge base. `current` is `null` on a
 * first write; callers seed the row's identity fields then.
 *
 * Returns the persisted row so callers can read back the merged result.
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
 * Read the cached household-data-key entry, or null when none is cached. The
 * `keyCache` store is a singleton keyed by {@link KEY_CACHE_ID}; callers must
 * still confirm the entry's `householdId` matches the active household before
 * trusting the bytes (a stale entry survives until the next IDB drop).
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

/**
 * Append diagnostics entries AND prune the store back to `max` in ONE
 * `readwrite` transaction (mirrors `monte-carlo-cache.ts` `putCached`'s
 * put+count+cursor-evict). The strictly-monotonic `seq` is allocated
 * INSIDE this transaction — read the current max via the `seq` index and
 * increment — so insertion order stays correct across tabs even within a
 * same-millisecond batch (a module-level counter would collide across tabs,
 * an ISO-`ts` index can't order a same-ms batch). Prune evicts the lowest
 * `seq` rows first via the index cursor. The supplied entries' own `seq` is
 * overwritten here so the store owns the authoritative ordering.
 *
 * Returns the entries as persisted (with their allocated `seq`) so the caller
 * can keep the in-memory ring aligned.
 */
/**
 * Evict the lowest-`seq` `diagnosticLogs` rows until the store holds at most
 * `max`. Single eviction policy, shared by the atomic append-time prune and the
 * standalone `pruneDiagnosticLogs` backstop. Operates on an OPEN
 * `diagnosticLogs` `readwrite` transaction store so it can run inside the
 * append's one-transaction window.
 */
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
  // Prune from the oldest (lowest seq) until within bounds — same policy as the
  // standalone backstop (one shared helper).
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
 * Prune the diagnostics store back to `max` rows (lowest `seq` first). The
 * startup / cross-tab / crash backstop for the atomic append-time prune.
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
 * Audit the working store: does it currently hold any aggregate whose
 * `householdId` differs from `expectedHouseholdId`? Used by
 * `AuthContext.maybeResetForNewUser` as a defence-in-depth check that
 * doesn't trust the localStorage user-transition tracker (an attacker
 * with DevTools could wipe or fake it). One `count()` per store via
 * the `householdId` index — DOM-bound but cheap.
 *
 * Returns `true` iff at least one store has at least one row whose
 * `householdId` does not equal the expected value. Empty stores
 * (legitimate first-ever login) return `false`.
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
 * Drop every store. Used by `bootstrap?force=true` (the Full Sync reset in
 * SyncContext). Includes `keyCache`: after a Full Sync wipes all sync data the
 * device's cached HDK must go too, otherwise the device sits in a logically
 * inconsistent state (appears unlocked over freshly-wiped data).
 * `deviceMetadata` and `selectedScenario` are deliberately preserved so the
 * device keeps its `deviceId`/scenario pointer across a force-bootstrap.
 * `diagnosticLogs` is likewise preserved — device-local debugging state
 * survives a same-user reset; only `dropLocalDatabase()` + the card
 * Clear wipe it.
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
  // Wake every aggregate-store subscriber: a clear empties all of them, so
  // each reactive reader must re-read (and see its store empty).
  for (const store of Object.values(STORE_BY_TYPE) as AggregateStore[]) {
    notifyStoreChanged(store);
  }
}

/**
 * Hard-delete the entire IndexedDB database (all stores + deviceMetadata).
 * Used by the "Clear data on this device" button on the Workspace page
 * (Workspace tools) and by the cross-user transition guard. Closes the cached
 * handle so the next call to `db()` opens a fresh database.
 *
 * If other connections hold the DB open (`onblocked`), the delete is
 * queued by the browser. We wait up to 2 s for them to release; if the
 * delete has not actually completed by then we **reject** with
 * {@link DatabaseDropBlockedError} — the drop is NOT a success and the
 * caller (the cross-user transition guard) must fail closed rather than
 * expose a new account over a previous account's stale rows. The browser keeps the delete queued, so a later retry — once
 * the other tabs have released their handles (nudged via
 * {@link nudgeOtherTabsToReleaseIdb}) — resolves cleanly.
 *
 * @throws {DatabaseDropBlockedError} when the delete stays blocked past the
 *   2 s cap (no other tab released its handle in time).
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
    // Other tabs hold the DB open → the delete is queued. Wait briefly for
    // them to release. If `onsuccess` has not fired by the 2 s cap, the DB is
    // still present → reject so the caller fails closed (does not store the
    // new lastUserId, does not expose the new household). The queued delete
    // still completes later once the last handle closes; the user retries
    // after closing other tabs.
    req.onblocked = () => {
      console.warn('[db] deleteDatabase blocked by another connection; failing closed after 2 s if not released');
      setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new DatabaseDropBlockedError());
      }, IDB_BLOCKED_TIMEOUT_MS);
    };
  });
  // The drop emptied every aggregate store, so wake each reactive reader to
  // re-read (and see its store empty) — mirrors clearAllStores's tail.
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

/**
 * Mirror of {@link migrateAggregate} for a queued mutation row. A mutation
 * queued by an older build persists its payload at the `schemaVersion` in
 * effect when it was written; unlike the aggregate stores (migrated on every
 * read), the `mutations` store is otherwise never migrated, so a stale row
 * would keep round-tripping a field a payload migration has since dropped —
 * out through both `listAllMutations` (export) and `listPendingMutations`
 * (push) — until it flushes. Returns the input unchanged when already
 * current, so callers can cheaply detect "did this change".
 */
function migrateMutation(m: PendingMutation): PendingMutation {
  const current = currentSchemaVersion(m.aggregateType);
  if (m.schemaVersion >= current) return m;
  return {
    ...m,
    schemaVersion: current,
    payload: migrate(m.aggregateType, m.payload, m.schemaVersion),
  };
}

/**
 * Read every mutation-queue row for one `status`, migrating a schema-behind
 * row's payload in memory on the way out, and — only when at least one row
 * WAS behind — persist the upgrade through {@link persistMutationUpgrades}.
 *
 * The read is the plain `readonly` transaction these list functions have
 * always been. They run on every poll tick and every flush (three at a time
 * from `refreshCounts`), so a `readwrite` read would serialize each of those
 * behind — and ahead of — every real queue write (a UI edit's
 * `queueMutation`, a push's `removeMutations`), and stretch the flush's own
 * drain loop by a macrotask turn per read. The write lock is taken only in
 * the upgrade window (a device's first reads after a bundle whose payload
 * schema moved), and only once per row: a persisted row is current on every
 * later read, so the steady state never writes.
 */
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

/**
 * Persist a payload-schema upgrade for the given queue rows — best-effort.
 *
 * ATOMIC relative to concurrent writers: each row is re-read INSIDE this
 * `readwrite` transaction and the migrated copy of THAT row is what gets
 * written, so a status/reason a retried push's `updateMutationStatus` set,
 * or a removal a completed push or conflict sweep made, between the caller's
 * readonly snapshot and this write is never clobbered by a stale put — a row
 * that is gone is skipped, a row already current is left alone.
 *
 * BEST-EFFORT, never a dependency of the read: the caller already holds the
 * complete, correct upgrade in memory and returns it regardless. A failed
 * persist (origin storage at quota is the realistic case, and the upgrade
 * window is exactly when a stale queue may be sitting on a full origin) must
 * not become a failed `listPendingMutations`: the flush that read is feeding
 * is what drains the queue and frees the space, so throwing here would stall
 * the very flush that clears the fault — and take the conflict inspector's
 * lists down with it. Abort explicitly, consume the resulting `tx.done`
 * rejection so it is not an unhandled promise, log, and move on; the rows
 * stay schema-behind on disk, so the next read re-does the upgrade in memory
 * and re-attempts the persist.
 */
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
 * Defense-in-depth check used by SyncContext to skip pulled aggregates
 * whose type isn't in `STORE_BY_TYPE`. The server filters its egress
 * against `ACTIVE_AGGREGATE_TYPES` (apps/api/src/sync/aggregate-types.ts);
 * mirroring on the client lets a removed type land safely if a stale
 * server is still serving it (rolling deploy, S3 snapshot drift).
 */
export function isKnownAggregateType(type: string): type is AggregateType {
  return Object.prototype.hasOwnProperty.call(STORE_BY_TYPE, type);
}
