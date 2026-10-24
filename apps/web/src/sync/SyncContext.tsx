// Sync state machine and badge state, exposed with actions (forceRefresh, retryNow) via `useSync`.
// pending -> syncing-push -> synced; stale -> syncing-pull -> synced; offline resumes online; error retries with backoff.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import {
  clearAllStores,
  clearMutationQueue,
  ConcurrentQueueMutationError,
  deleteAggregateLocally,
  getAggregateIncludingDeleted,
  isKnownAggregateType,
  listFailedConflicts,
  listFailedErrors,
  listMutationsByAggregate,
  listPendingMutations,
  putAggregate,
  readDeviceMetadata,
  readKeyCacheEntry,
  reEnqueueMutationWithFreshId,
  removeMutation,
  updateDeviceMetadata,
  updateMutationStatus,
  withBatchedStoreSignals,
  writeKeyCacheEntry,
} from '../db/store.js';
import { cryptoUuid } from '../lib/crypto-uuid.js';
import type { DeviceMetadata, PendingMutation } from '../db/types.js';
import { collapseAndReQueue } from './mutation-queue.js';
import { latestEdit } from './auto-repair.js';
import { MockSyncClient } from './mock-sync.js';
import {
  HttpSyncClient,
  SyncApiError,
  type SyncTransport,
} from './sync-client.js';
import type {
  SnapshotListItem,
  SyncBadgeState,
  SyncSnapshot,
} from './types.js';
import { setRegisteredDeviceId } from './device-id.js';
import { notifyWorkspaceChanged } from '../lib/workspace-events.js';
import { recordSyncError, recordSyncWarn } from '../lib/diagnostics/logger.js';
import {
  applyPulledChange,
  assertNoSchemaAhead,
  bootstrapSchemaCarriers,
  idFragment,
  plaintextPayload,
  repairRejections,
  SchemaAheadError,
} from './pull-apply.js';
import {
  buildErrorDetail,
  handleSchemaAhead,
  isRollbackDetectedRejection,
  setOnRollbackDetectedOutsideSync,
} from './error-detail.js';
import { readQuarantinedLocalCopies, recordDecryptOutcome } from './quarantine.js';
import { resolveRetryDelayMs } from '../lib/retry-backoff.js';

// Content-equality gate for the mutation lists on the context value: `refreshCounts` returns fresh arrays every poll,
// so comparing the rendered fields (id, status, expectedVersion, reason) keeps the prior reference and avoids
// re-rendering every `useSync()` consumer and re-resolving labels.
function sameMutationList(
  a: readonly PendingMutation[],
  b: readonly PendingMutation[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.status !== y.status ||
      x.expectedVersion !== y.expectedVersion ||
      x.reason !== y.reason
    ) {
      return false;
    }
  }
  return true;
}

// The push batch under the one-mutation-per-aggregate-per-batch rule: keeps the earliest un-pushed mutation per
// aggregate and defers siblings to the next round, so an early sibling's rejection can never coexist with a later
// sibling's apply in one server batch (a silent overwrite of a real remote edit). Capped by the server's 100-mutation
// limit.
function firstPerAggregate(
  pending: readonly PendingMutation[],
  cap: number,
): PendingMutation[] {
  const seen = new Set<string>();
  const batch: PendingMutation[] = [];
  for (const m of pending) {
    if (seen.has(m.aggregateId)) continue;
    seen.add(m.aggregateId);
    batch.push(m);
    if (batch.length >= cap) break;
  }
  return batch;
}

const POLL_IDLE_MS = 5 * 60 * 1000;
const POLL_ACTIVE_MS = 30 * 1000;
// A backgrounded tab returning to visible cancels the long idle wait and pulls at once, so a deploy that landed
// meanwhile doesn't wait up to 5 min for the version-banner detector to see a fresh `X-Build-Id`; debounced against
// rapid focus toggles.
const REWAKE_DEBOUNCE_MS = 5 * 1000;
// Refocus during an error-state backoff waits min(remaining backoff, this + jitter) instead of polling at once, which
// would defeat the backoff exactly when a person is watching the result. Separate from REWAKE_DEBOUNCE_MS, which
// debounces only the non-error cadence.
const REFOCUS_BASE_MS = 5 * 1000;
const REFOCUS_JITTER_MS = 1 * 1000;
// Mirrors the server's @ArrayMaxSize(100) on POST /sync/push; a longer queue (demo load, bulk edit, long offline
// session) pushes in sequential batches.
const PUSH_BATCH_SIZE = 100;

// Badge message for mutations parked as `failed-error` (e.g. a FRESHNESS_HEAD_INVALID reject), shared with {@link
// unsyncedBadgeGuard} so later ticks keep the wording instead of flipping to a false `synced`.
const FAILED_ERROR_BADGE_MESSAGE = 'Some edits could not be sent';

// Permanent push rejections: none can succeed by blind retry, so the `flushPending` catch parks the batch instead of
// hot-looping. `SCHEMA_VERSION_TOO_NEW` needs a newer build. `TIMESTAMP_OUT_OF_SERVER_WINDOW` belongs here because a
// queued mutation's timestamp is frozen at enqueue and a stamp behind the past window only drifts further, so left
// retryable it would block every later edit forever at poll cadence. Excluded: the generic `BAD_REQUEST` (malformed
// shapes no legitimate client sends; parking it risks swallowing codes this set hasn't learned) and the quota `429`
// `PUSH_QUOTA_EXCEEDED`, which clears the next UTC day and must keep retrying.
const PERMANENT_PUSH_REJECTION_CODES = new Set([
  'FRESHNESS_HEAD_INVALID',
  'TIMESTAMP_OUT_OF_SERVER_WINDOW',
  'SCHEMA_VERSION_TOO_NEW',
  'ENCRYPTION_REQUIRED',
  'FRESHNESS_COUNTER_TOO_FAR_AHEAD',
]);

// Badge truthfulness guard: the state that must replace a would-be `synced` when the queue drained but unresolved work
// lingers, else null. Conflicts win over parked `failed-error` batches as the more actionable prompt; both keep the
// badge off `synced`. Shared by all three `synced` transitions so ordering and wording match.
function unsyncedBadgeGuard(counts: {
  conflicts: readonly PendingMutation[];
  failedErrors: readonly PendingMutation[];
}): SyncBadgeState | null {
  if (counts.conflicts.length > 0) {
    return { kind: 'stale', message: 'Refresh needed' };
  }
  if (counts.failedErrors.length > 0) {
    return { kind: 'error', message: FAILED_ERROR_BADGE_MESSAGE, phase: 'push' };
  }
  return null;
}

// Bounded retry for the post-commit local cleanup after a full clear's 2xx: the sweep already committed, so a transient
// IDB blip on the cursor reset, freshness-pin clear or queue drop should self-heal (every step is idempotent) instead
// of surfacing a false "couldn't delete workspace data". Only when every attempt fails does the clear surface a typed
// post-commit error and keep the poll suspended.
const CLEAR_CLEANUP_ATTEMPTS = 3;
const CLEAR_CLEANUP_RETRY_MS = 60;

// Fixed pause between cleanup retries: one client settling its own IDB, so no jitter. Named `sleep` to avoid shadowing
// the poll scheduler's `delay`.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thrown by `clearWorkspace` when the server clear committed (2xx) but the post-commit local cleanup (cursor reset,
 * freshness-pin clear, mutation-queue drop) failed after {@link CLEAR_CLEANUP_ATTEMPTS} attempts. Distinct from a
 * pre-commit `SyncApiError`: the workspace was erased server-side, so the caller must not show the "couldn't delete"
 * copy. The poll stays suspended, because the queue may still hold stale `create`s a flush would re-push onto the swept
 * server, and the caller keeps the user on the page rather than reloading, which would resurrect the deleted data on
 * the next poll.
 */
export class WorkspaceClearCleanupError extends Error {
  constructor(
    /** The server's 2xx outcome. */
    public readonly result: { ok: boolean; historyErased: boolean },
  ) {
    super(
      'Workspace cleared on the server, but the local sync-state cleanup could not be completed.',
    );
    this.name = 'WorkspaceClearCleanupError';
  }
}

interface SyncContextValue extends SyncSnapshot {
  /**
   * The un-synced mutation lists behind the counts, for the sync inspector, exposed behind a content-equality gate.
   * `failedErrorMutations` is `[]` in production today (nothing writes `failed-error`).
   */
  pendingMutations: readonly PendingMutation[];
  conflictMutations: readonly PendingMutation[];
  failedErrorMutations: readonly PendingMutation[];
  /**
   * Wipes local IndexedDB and the mutation queue and reseeds from the server snapshot. `ok` is the reseed outcome;
   * `wiped` reports whether `clearAllStores()` ran (a failed reseed after `wiped: true` needs a reload, which the
   * cursor-reset invariant makes re-bootstrap).
   */
  forceRefresh(): Promise<{ ok: boolean; wiped: boolean }>;
  retryNow(): Promise<void>;
  /**
   * Epoch-ms deadline of the next scheduled retry while `state.kind` is `'error'`, else null; the badge counts down to
   * it.
   */
  nextRetryAt: number | null;
  /**
   * Resolves one parked `failed-conflict` mutation. `keep` re-bases the edit onto the server's true version with a
   * fresh id and pushes (a create-over-live becomes `update @ currentVersion`, a NOT_FOUND-on-update `create @ 0`),
   * which also heals the wedged counter. `discard` drops the edit and adopts the server copy via a pull, re-escalating
   * if the aggregate cannot converge. Injected into `<UnsyncedMutationList>` by its hosts.
   */
  resolveConflict(mutation: PendingMutation, choice: 'keep' | 'discard'): Promise<void>;
  /**
   * "Check & repair": re-queues each parked `failed-conflict` as a fresh-id `pending` row (so the original id can't
   * replay the server's 7-day cached CONFLICT) and flushes, so the reject loop re-classifies each: it resolves a
   * since-fixed conflict silently and rehydrates a legacy row's server facts to unlock keep/discard.
   */
  checkAndRepair(): Promise<void>;
  /** Called by features after queueing a new mutation. */
  notifyPending(): void;
  /**
   * Pushes pending mutations and pulls remote changes; `{ ok: false }` carries a user-facing reason. A precondition for
   * destructive workspace operations (import, demo reload) so they don't proceed on stale local state.
   */
  syncRoundTrip(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** The household's snapshots, newest first, for "Restore previous version". */
  listSnapshots(): Promise<SnapshotListItem[]>;
  /**
   * Restores a previous snapshot: clears the freshness pin (persisted and in-memory), has the server wipe and
   * reinitialise at the snapshot, wipes local IndexedDB and force-bootstraps. `ok` is the local reseed outcome; `wiped`
   * says whether local stores were cleared (a failed reseed after `wiped: true` needs a reload).
   */
  restoreSnapshot(snapshotId: string): Promise<{ ok: boolean; wiped: boolean }>;
  /**
   * Server-authoritative "Delete workspace data" clear. Runs under the destructive-op fence after awaiting any
   * in-flight flush, calls `POST /sync/workspace/clear`, and on 2xx clears the freshness pin, resets the sync cursor
   * (so the post-clear reload force-bootstraps the empty snapshot) and drops the local mutation queue inside the fence,
   * so a post-fence poll can't re-push deleted `create`s onto the swept server. It does not wipe the aggregate stores
   * or reload: the WorkspaceToolsCard handler does, gated on the 2xx. Rejects with `SyncApiError` on non-2xx, so the
   * caller keeps the queue and skips the wipe. If the server clear committed but the local cleanup fails after bounded
   * retries it rejects with `WorkspaceClearCleanupError` and keeps the poll suspended, so the caller can tell "never
   * swept" from "swept, cleanup failed". `eraseHistory` also purges S3 backup history; `purgeHistoryOnly` is the
   * purge-only retry.
   */
  clearWorkspace(args: {
    currentPassword: string;
    eraseHistory: boolean;
    purgeHistoryOnly?: boolean;
  }): Promise<{ ok: boolean; historyErased: boolean }>;
  /**
   * Runs a destructive workspace overwrite (demo reload over existing data) atomically w.r.t. the poll: sets the
   * destructive-op fence so a tick returns early instead of flushing half-queued wipe/load mutations, runs `fn` inside
   * the sync mutex, and clears the fence in a `finally` (the success path's reload discards the per-mount ref).
   * Resolves to `fn`'s value.
   */
  runDestructive<T>(fn: () => Promise<T>): Promise<T>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

interface SyncProviderProps {
  children: ReactNode;
  householdId: string | null;
  /**
   * Canonical device id from AuthContext (the JWT's), stamped on every queued mutation and the push body; a mismatch
   * draws `403 DEVICE_MISMATCH`.
   */
  deviceId: string;
  apiBaseUrl: string;
  getAccessToken: () => string | null;
  getCsrfToken: () => string | null;
  refreshAccessToken?: () => Promise<string | null>;
  /** Called on a push `DEVICE_MISMATCH`; the host forces a re-login, keeping SyncProvider auth-agnostic. */
  onDeviceMismatch?: () => void | Promise<void>;
  /** The active household data key; null keeps the encrypted freshness path off. */
  getHdk?: () => CryptoKey | null;
  mock?: boolean;
}

export function SyncProvider({
  children,
  householdId,
  deviceId,
  apiBaseUrl,
  getAccessToken,
  getCsrfToken,
  refreshAccessToken,
  onDeviceMismatch,
  getHdk,
  mock,
}: SyncProviderProps) {
  // Latest server-acknowledged freshness counter this device pins, updated after each push/pull/bootstrap that echoes a
  // head and read by the HTTP client. The server echoes a head only when the client sends one (HDK-gated), so it stays
  // 0 until a key is in use.
  const pinnedFreshnessCounterRef = useRef<number>(0);
  const transportRef = useRef<SyncTransport>(
    mock
      ? new MockSyncClient()
      : new HttpSyncClient({
          apiBaseUrl,
          getAccessToken,
          getCsrfToken,
          refreshAccessToken,
          getHdk: getHdk ?? (() => null),
          getPinnedFreshnessCounter: () => pinnedFreshnessCounterRef.current,
          getHouseholdId: () => householdIdRef.current ?? '',
          reportDecryptOutcome: (outcome) => {
            void recordDecryptOutcome(outcome);
          },
        }),
  );
  // Seed 'syncing-pull' when a householdId at mount means `initialSync` fires at once: the default 'synced' would
  // mislead, and App.tsx's first-run modal gates on `kind === 'synced'`, which honest seeding keeps from firing before
  // the first server round-trip.
  const [state, setState] = useState<SyncBadgeState>(() =>
    householdId ? { kind: 'syncing-pull' } : { kind: 'synced', lastSyncedAt: null },
  );
  const [pendingCount, setPendingCount] = useState(0);
  const [conflictCount, setConflictCount] = useState(0);
  const [pendingMutations, setPendingMutations] = useState<readonly PendingMutation[]>([]);
  const [conflictMutations, setConflictMutations] = useState<readonly PendingMutation[]>([]);
  const [failedErrorMutations, setFailedErrorMutations] = useState<readonly PendingMutation[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  // Mirror of the badge `kind`, written at set-time: the mount-once polling effect reads it (not reactive `state`) to
  // pick the next delay, so a synced-to-error transition retries at the backoff delay instead of re-arming at
  // POLL_IDLE_MS. Every state write goes through `setSyncState`.
  const stateKindRef = useRef<SyncBadgeState['kind']>(
    householdId ? 'syncing-pull' : 'synced',
  );
  const setSyncState = useCallback((next: SyncBadgeState) => {
    // Record every `error` transition in the diagnostics timeline once, centralised here so no raise site can be missed
    // (push, bootstrap, pull and schema-ahead all route through). The `[sync]` console.warn sites are not recorded: the
    // console shim already captures them.
    if (next.kind === 'error') {
      recordSyncError(
        `[sync] ${[next.phase, next.code, next.message]
          .filter(Boolean)
          .join(' ')}`.trim(),
      );
    } else if (next.kind === 'stale') {
      // The badge flips to "Refresh needed": mark the timeline with WHEN (the per-mutation reasons WHY are recorded in
      // the reject loop), at warn level.
      recordSyncWarn(
        `[sync] refresh needed — ${conflictCountRef.current} unresolved conflict(s)`,
      );
    }
    stateKindRef.current = next.kind;
    // Mirror a fresh error's parsed Retry-After into a ref the scheduler reads synchronously; every error state funnels
    // through here.
    errorRetryAfterMsRef.current = next.kind === 'error' ? next.retryAfterMs ?? null : null;
    setState(next);
  }, []);
  // Latest pending count, read by the polling effect to choose POLL_ACTIVE_MS vs POLL_IDLE_MS without re-arming.
  const pendingCountRef = useRef<number>(0);
  // Latest conflict count, so `setSyncState` can annotate the `stale` diagnostic.
  const conflictCountRef = useRef<number>(0);
  // Latest `failed-error` (permanently parked) count: lets the scheduler tell a fresh transient error about to back off
  // from a lingering park keeping the badge on 'error' (see `errorCounterRef`).
  const failedErrorCountRef = useRef<number>(0);
  // Consecutive-error counter, incremented only at the three transient raise sites (flushPending's non-permanent catch,
  // the bootstrap catch, the pull catch), never by a permanent park or the scheduler (which can't tell a fresh failure
  // from a lingering park). Reset by the scheduler on the first tick that hits none of them, and by
  // `forceRefresh`/`retryNow`; cleared per household by `resetRetryPolicy`.
  const errorCounterRef = useRef<number>(0);
  // The current error's parsed `Retry-After` (ms or null), mirrored by `setSyncState` and consulted by the scheduler's
  // override rule; null also means the error carried no header.
  const errorRetryAfterMsRef = useRef<number | null>(null);
  // Deadline of the next poll in the error state, reactive for the badge countdown (null otherwise) and mirrored into a
  // ref so the refocus handler reads the remaining backoff without being a dependency of the mount-once effect.
  const [nextRetryAt, setNextRetryAt] = useState<number | null>(null);
  const nextRetryAtRef = useRef<number | null>(null);
  // Set by the mount-once polling effect to "recompute the error wait from the refs above and re-arm the timer now". A
  // ref because the non-tick error entry points (`initialSync`, `notifyPending`, `retryNow`, `forceRefresh`, the online
  // listener) are declared before that effect runs. A poll tick's own error transition doesn't use it: its
  // end-of-callback reschedule already covers that.
  const rearmNowRef = useRef<(() => void) | null>(null);
  // Set by the same effect to "arm the poll timer at the mount cadence, from now". Called on a household change so the
  // new household's polling starts as a fresh mount's would, not inheriting the prior household's error backoff or
  // cadence.
  const restartPollRef = useRef<(() => void) | null>(null);
  // True when the current `error` is a permanent park with nothing retryable pending (`failedErrorCountRef` nonzero,
  // `pendingCountRef` zero): nothing scheduled will resend the parked rows, so no "Retrying in Ns" deadline is
  // published; only a user action clears a park.
  function isPureParkErrorState(): boolean {
    return failedErrorCountRef.current > 0 && pendingCountRef.current === 0;
  }
  // The next error-state wait, floored at the idle/active cadence while a permanently parked batch lingers: a park
  // never clears by retrying, so an unrelated nonzero consecutive-error counter must not make it poll more often than
  // the flat cadence.
  function computeErrorDelayMs(): number {
    const attempt = Math.max(0, errorCounterRef.current - 1);
    const computed = resolveRetryDelayMs(attempt, errorRetryAfterMsRef.current);
    if (failedErrorCountRef.current === 0) return computed;
    const cadence = pendingCountRef.current > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS;
    return Math.max(computed, cadence);
  }
  // Runs a non-tick sync operation and re-arms the poll scheduler afterward only if the operation advanced the
  // consecutive-error counter, i.e. hit one of the three transient raise sites. `rearmNowRef` keys on the badge `kind`,
  // which the truthfulness guard pins at 'error' while a batch stays parked; an unconditional re-arm pushed the armed
  // poll out a full idle cadence on every edit-driven push, so a user editing more often than POLL_IDLE_MS never ran a
  // pull tick. A `finally` so a raise that surfaces as a throw still re-arms. Callers that reset the counter
  // (`forceRefresh`, `retryNow`) do so before calling this, so "moved" means "this attempt raised".
  const rearmIfRaised = useCallback(async <T,>(op: () => Promise<T>): Promise<T> => {
    const before = errorCounterRef.current;
    try {
      return await op();
    } finally {
      if (errorCounterRef.current !== before) rearmNowRef.current?.();
    }
  }, []);
  // Forgets the current household's retry-policy state (error counter, Retry-After, published deadline) and re-arms the
  // poll at the mount cadence. SyncProvider doesn't remount across a household change, so without this the next
  // household's first transient error would wait at an inherited, already-grown ceiling and the badge could count down
  // to a deadline that was never its own.
  const resetRetryPolicy = useCallback(() => {
    errorCounterRef.current = 0;
    errorRetryAfterMsRef.current = null;
    nextRetryAtRef.current = null;
    setNextRetryAt(null);
    restartPollRef.current?.();
  }, []);
  const onlineRef = useRef<boolean>(navigator.onLine);
  const pollTimerRef = useRef<number | null>(null);
  // Time of the last poll completion, for the visibility rewake handler to decide whether an extra pull is due; seeded
  // with mount time so a refocus in the first 5 s falls inside the debounce.
  const lastPollAtRef = useRef<number>(Date.now());
  // The householdId already given an initial sync, so it doesn't re-fire on re-render or in StrictMode; reset on
  // logout.
  const initialSyncedHouseholdRef = useRef<string | null>(null);
  // Serialize push attempts: many `notifyPending()` calls in a bulk operation (the demo loader queues ~150) would
  // otherwise fan out concurrent flushes against an overlapping list, thrashing badge state and burning request budget.
  // While one flush is in flight, extra triggers only set `pendingRerunRef`, and the run re-fires once on completion if
  // more work arrived.
  const flushInFlightRef = useRef<boolean>(false);
  const pendingRerunRef = useRef<boolean>(false);
  // Latest `flushPendingExclusive` for the re-fire in `flushPending`'s finally; declared before it exists, so it goes
  // through a per-render ref (like pullRef below).
  const flushPendingExclusiveRef = useRef<() => Promise<boolean>>(
    () => Promise.resolve(true),
  );
  // A flush is enqueued on the mutex but hasn't started. `flushPendingExclusive` defers via a microtask, so
  // `flushInFlightRef` isn't true yet when a burst of `notifyPending` calls fires in one tick; without this flag each
  // call would enqueue its own flush instead of coalescing into one. Cleared the instant the enqueued flush begins and
  // sets `flushInFlightRef`, so there is no window where both are false.
  const flushScheduledRef = useRef<boolean>(false);
  // Sync mutex: a promise chain serializing the top-level entry points (poll tick's pull+flush, initialSync,
  // notifyPending/retryNow/ online flush, forceRefresh, syncRoundTrip, restoreSnapshot) so pull, bootstrap, flush and
  // restore never interleave their `deviceMetadata` read-modify-writes. Taken only at entry points, never inside the
  // inner pull/flushPending/applyBootstrap, because those call each other (pull's CURSOR_EXPIRED handler runs
  // flushPending + applyBootstrap); re-acquiring inside would deadlock against the entry point holding it.
  const syncLockRef = useRef<Promise<void>>(Promise.resolve());
  const runExclusive = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    // Release in `finally` so a throw can't wedge the chain; the caller awaits `result`, not the tail.
    const result = syncLockRef.current.then(fn, fn);
    syncLockRef.current = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }, []);
  // The running `flushPending` promise (null when idle). A restore awaits it before the server sweep: a push committing
  // after the sweep would recreate data the confirm dialog said was lost, and clearing the local queue can't recall a
  // request already on the wire.
  const flushPromiseRef = useRef<Promise<boolean> | null>(null);
  // True during `restoreSnapshot`: `flushPending` returns early so the poll or a stray `notifyPending` cannot push
  // stale local state over the restored snapshot.
  const restoreInProgressRef = useRef<boolean>(false);
  // True during a destructive workspace overwrite (demo reload): `flushPending`/`pull`/`syncRoundTrip` return early so
  // a poll tick can't flush half-queued wipe/load mutations. Unlike restore (whose logout stops the poll) the demo path
  // keeps SyncProvider mounted, so this fence is what makes it atomic w.r.t. the poll. Set before the mutex is taken,
  // cleared in `runDestructive`'s `finally`.
  const destructiveOpInProgressRef = useRef<boolean>(false);
  // Set when a 2xx `clearWorkspace` committed but its post-commit local cleanup (cursor reset, freshness-pin clear,
  // queue drop) failed after bounded retries. Fences `flushPending`/`pull`/`syncRoundTrip` like the destructive-op
  // fence: the queue may still hold stale `create`s that a flush would re-push onto the swept server. It survives the
  // fenced window, cleared only when a later clear's cleanup succeeds or the page is discarded.
  const clearCleanupFailedRef = useRef<boolean>(false);
  // Set when a `clearWorkspace` call failed ambiguously (abort, timeout or network drop with no HTTP response), so the
  // client can't tell whether the sweep committed; a definite non-2xx `SyncApiError` means it did not. If it did, the
  // next poll hits `CURSOR_EXPIRED`, whose handler normally flushes the queue before re-bootstrapping and would re-push
  // the deleted `create`s onto the swept server. While set, that handler skips the pre-bootstrap flush and
  // re-bootstraps from the server's true state (empty if the clear landed, a safe no-op if not). Unlike
  // `clearCleanupFailedRef` it does not suspend the poll (it must reach `CURSOR_EXPIRED`); it is lifted by a successful
  // reseed or by a normal pull confirming no committed clear expired this cursor. In memory only.
  const clearOutcomeAmbiguousRef = useRef<boolean>(false);
  // Latest `onDeviceMismatch` in a ref so `flushPending` can call it without listing the prop as a dependency, which
  // would re-create the callback every render and re-arm the poll chain.
  const onDeviceMismatchRef = useRef(onDeviceMismatch);
  useEffect(() => {
    onDeviceMismatchRef.current = onDeviceMismatch;
  }, [onDeviceMismatch]);
  // Latest householdId in a ref so the once-constructed transport's `getHouseholdId` always reads the current value.
  const householdIdRef = useRef(householdId);
  useEffect(() => {
    householdIdRef.current = householdId;
  }, [householdId]);
  // The forced-export transport runs its own HttpSyncClient outside the poll, so a rollback-detected rejection caught
  // there can't reach `setSyncState`; register the shared hook so it still flips the badge.
  useEffect(() => {
    setOnRollbackDetectedOutsideSync(() => {
      setSyncState({ kind: 'rollback-detected' });
    });
    return () => setOnRollbackDetectedOutsideSync(() => {});
  }, [setSyncState]);

  const refreshCounts = useCallback(async () => {
    const [pending, conflicts, failedErrors] = await Promise.all([
      listPendingMutations(),
      listFailedConflicts(),
      // `failed-error` rows are batches parked after a permanent push rejection.
      listFailedErrors(),
    ]);
    // Mirror into refs so the mount-once polling effect reads the latest counts without listing them as deps, which
    // would re-arm the timer and defeat the active/idle cadence.
    pendingCountRef.current = pending.length;
    conflictCountRef.current = conflicts.length;
    failedErrorCountRef.current = failedErrors.length;
    setPendingCount(pending.length);
    setConflictCount(conflicts.length);
    // Keep the prior array ref when content is unchanged, so an unchanged poll doesn't churn the context value or
    // re-resolve labels.
    setPendingMutations((prev) => (sameMutationList(prev, pending) ? prev : pending));
    setConflictMutations((prev) => (sameMutationList(prev, conflicts) ? prev : conflicts));
    setFailedErrorMutations((prev) =>
      sameMutationList(prev, failedErrors) ? prev : failedErrors,
    );
    return { pending, conflicts, failedErrors };
  }, []);

  // Pushes pending mutations; true on a clean flush (no pending, no conflicts, no transport error), false otherwise,
  // with badge state updated as a side effect. Retry/polling ignore the result; `syncRoundTrip` uses it to gate
  // destructive operations. If another flush is running it sets `pendingRerunRef` and returns true at once: the
  // in-flight run re-fires so the rerun sees mutations queued mid-flight.
  const flushPending = useCallback(async (): Promise<boolean> => {
    if (!householdId) return true;
    // Fences: never start a push during a restore (it would race the server sweep and re-commit stale local state over
    // the snapshot), a destructive overwrite's wipe/load window, or after a committed clear whose queue drop did not
    // finish (stale `create`s would resurrect on the swept server).
    if (
      restoreInProgressRef.current ||
      destructiveOpInProgressRef.current ||
      clearCleanupFailedRef.current
    )
      return true;
    if (!onlineRef.current) {
      setSyncState({ kind: 'offline' });
      return false;
    }
    if (flushInFlightRef.current) {
      pendingRerunRef.current = true;
      return true;
    }
    flushInFlightRef.current = true;
    // Expose this run's promise so `restoreSnapshot` can await an in-flight flush before telling the server to sweep.
    let settle: (v: boolean) => void = () => {};
    flushPromiseRef.current = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const run = async (): Promise<boolean> => {
      // Loop so a mutation queued mid-flight flushes in the same call; each iteration drains the whole queue in
      // PUSH_BATCH_SIZE chunks. The cap bounds re-flush rounds, not mutations; 8 is well above any realistic demo-load
      // or bulk-edit re-queue.
      let iterations = 0;
      while (iterations < 8) {
        iterations += 1;
        pendingRerunRef.current = false;
        const { pending, conflicts, failedErrors } = await refreshCounts();
        if (pending.length === 0) {
          // Badge truthfulness: an empty queue must not declare 'synced' while conflicts or parked `failed-error`
          // batches linger, which would drop the user's cue to resolve; conflicts rank ahead of parked errors.
          const unsynced = unsyncedBadgeGuard({ conflicts, failedErrors });
          if (unsynced) {
            setSyncState(unsynced);
            return false;
          }
          // An empty flush did no network work, so it can't declare 'synced' over a live transient error (nonzero
          // counter; a permanent park is caught above). The tick pairs `pull` with this flush, and with nothing queued
          // (the normal idle case) it would flip a pull's fresh 429 or outage back to 'synced', discarding its
          // Retry-After, backoff, badge and countdown and re-arming a full POLL_IDLE_MS out. Leave the error; the next
          // pull clears it.
          if (stateKindRef.current === 'error' && errorCounterRef.current > 0) {
            return false;
          }
          setSyncState({ kind: 'synced', lastSyncedAt });
          return true;
        }
        setSyncState({ kind: 'syncing-push' });
        // One mutation per aggregate per batch (see firstPerAggregate), capped at the server's 100. A retried batch is
        // safe: the server dedupes by `(householdId#deviceId#mutationId)`. Declared before the try so the
        // permanent-rejection catch can park exactly this batch's ids.
        const batch = firstPerAggregate(pending, PUSH_BATCH_SIZE);
        try {
          {
            const result = await transportRef.current.push({
              householdId,
              deviceId,
              mutations: batch,
            });
            // Pin the server-acknowledged freshness head (present only when the HDK is unlocked and the client sent
            // one), persisted so it survives a reload.
            if (result.freshnessHead) {
              pinnedFreshnessCounterRef.current =
                result.freshnessHead.freshnessCounter;
              // Persist only the counter in one atomic IDB transaction so a concurrent pull's cursor write isn't
              // clobbered by a stale full-row spread.
              const counter = result.freshnessHead.freshnessCounter;
              await updateDeviceMetadata((current) => ({
                ...(current ?? defaultMeta(deviceId)),
                deviceId,
                freshnessCounter: counter,
              }));
            }
            for (const r of result.applied) {
              await removeMutation(r.mutationId);
              // Create-over-tombstone revive: a rare event worth a PII-safe breadcrumb (id fragment only).
              if (r.recreatedOverTombstone === true) {
                recordSyncWarn(
                  `[sync] recreated aggregate over tombstone — ${idFragment(r.aggregateId)} (v${r.newVersion})`,
                );
              }
            }
            // Auto-repair every rejection before parking anything as a terminal conflict: one action per aggregate
            // (silent re-base or drop where one resolution is safe, escalate to keep/discard where a real choice
            // exists), persisting the server's `currentVersion`/`currentUpdatedAt` on any parked row.
            if (result.rejected.length > 0) {
              await repairRejections(result.rejected, householdId);
            }
          }
          const now = new Date().toISOString();
          setLastSyncedAt(now);
          const after = await refreshCounts();
          // A successful push of a new mutation must not flip to 'synced' while conflicts or an earlier parked
          // `failed-error` batch linger (`after.pending` can be empty yet un-sent work stays in the inspector); same
          // guard as the empty-queue site.
          const unsynced = unsyncedBadgeGuard(after);
          if (unsynced) {
            setSyncState(unsynced);
            return false;
          }
          if (after.pending.length === 0) {
            setSyncState({ kind: 'synced', lastSyncedAt: now });
            return true;
          }
          // More pending arrived mid-flight: surface 'pending' and loop.
          setSyncState({ kind: 'pending', count: after.pending.length });
        } catch (err) {
          // Freshness rollback: rejected before any local write, so the queue is untouched.
          if (isRollbackDetectedRejection(err)) {
            setSyncState({ kind: 'rollback-detected' });
            return false;
          }
          // Permanent push rejection (`PERMANENT_PUSH_REJECTION_CODES`): the server rejected the whole push (400/403,
          // nothing committed) for a reason only a buggy or untrusted client triggers, and blind retry never helps.
          // Park every mutation in the batch as `failed-error` (excluded from `listPendingMutations`), so the poll's
          // next-tick `flushPending` never resends them; they stay visible via `listFailedErrors()`. No `reason`
          // argument: `PendingMutation.reason` is a closed conflict-classification union. Distinct from the client-side
          // rollback branch above despite the shared word "freshness". Returns false without re-throwing.
          if (err instanceof SyncApiError && PERMANENT_PUSH_REJECTION_CODES.has(err.code)) {
            for (const m of batch) {
              await updateMutationStatus(m.id, 'failed-error');
            }
            await refreshCounts();
            setSyncState({
              kind: 'error',
              ...buildErrorDetail(err, 'push', FAILED_ERROR_BADGE_MESSAGE),
            });
            return false;
          }
          // DEVICE_MISMATCH: the JWT's device id no longer matches this client's (the wiped-deviceId edge from
          // clear-data). Only reachable online, so hand off to the host's logout and clean re-login to re-bind it,
          // before the generic error state.
          if (err instanceof SyncApiError && err.code === 'DEVICE_MISMATCH') {
            await onDeviceMismatchRef.current?.();
            return false;
          }
          // Transient push failure: one of the three sites allowed to advance the consecutive-error counter.
          errorCounterRef.current += 1;
          setSyncState({
            kind: 'error',
            ...buildErrorDetail(err, 'push', 'Sync failed'),
          });
          return false;
        }
      }
      // Hit the iteration cap with pending left: the next external trigger (poll, notifyPending) picks up the rest.
      return false;
    };
    try {
      return await run();
    } finally {
      flushInFlightRef.current = false;
      const rerun = pendingRerunRef.current;
      pendingRerunRef.current = false;
      // Resolve and drop this run's promise so a later `restoreSnapshot` awaits only a genuinely in-flight flush.
      settle(true);
      flushPromiseRef.current = null;
      // Honor the coalescing contract: a trigger landing after this run's final queue read could only set the flag and
      // would wait up to POLL_IDLE_MS, so re-fire one follow-up flush (self-limiting: it drains the queue and exits
      // when empty).
      if (rerun) void flushPendingExclusiveRef.current();
    }
  }, [householdId, deviceId, lastSyncedAt, refreshCounts]);

  // Mutex-guarded flush entry point for the top-level callers (notifyPending, retryNow, online flush) so a flush can't
  // interleave its `deviceMetadata` writes with a pull, bootstrap or restore. Coalescing is preserved:
  // `flushInFlightRef` is checked before the mutex, so a `notifyPending` burst during a running flush only sets
  // `pendingRerunRef` instead of queuing N lock acquisitions; only a flush that will do work takes the lock.
  const flushPendingExclusive = useCallback(async (): Promise<boolean> => {
    if (flushInFlightRef.current || flushScheduledRef.current) {
      pendingRerunRef.current = true;
      return true;
    }
    flushScheduledRef.current = true;
    return runExclusive(() => {
      // Cleared the instant the flush begins; `flushPending` sets `flushInFlightRef` synchronously before its first
      // await, so a burst in this window still coalesces.
      flushScheduledRef.current = false;
      return flushPending();
    });
  }, [runExclusive, flushPending]);

  // Shared bootstrap-and-apply path for `forceRefresh` (wipe local, re-fetch) and `initialSync` on a fresh device (no
  // wipe); `clearFirst` is the only difference. Declared before `pull` because its CURSOR_EXPIRED catch delegates here
  // and `useCallback` deps are evaluated eagerly.
  const applyBootstrap = useCallback(
    async (clearFirst: boolean): Promise<{ ok: boolean; wiped: boolean }> => {
      if (!householdId) return { ok: false, wiped: false };
      setSyncState({ kind: 'syncing-pull' });
      // True once `clearAllStores()` resolves. It is one IDB transaction, so a throw inside it aborts with data intact
      // (`wiped:false`); a throw in any later step means the aggregates are gone (`wiped:true`). The pre-wipe cursor
      // write sits before it and doesn't move the boundary.
      let wiped = false;
      try {
        const result = await transportRef.current.bootstrap({ force: clearFirst });
        // Pre-flight schema check before mutating IDB: one snapshot or post-snapshot row ahead of this bundle halts
        // without clearing, leaving the user's last known-good state.
        assertNoSchemaAhead(bootstrapSchemaCarriers(result));
        // Quarantine: a `clearFirst` bootstrap wipes and refills from this response, and the transport already dropped
        // rows it couldn't decrypt (the server holds no household key, so shape-valid garbage is caught only at
        // decrypt). Refilling blindly would delete the last readable local copy of each such aggregate, and halting
        // wedged CURSOR_EXPIRED auto-recovery on one poisoned row, so carry their local copies across the wipe (re-put
        // below): the device loses only that row, as on pull.
        const preservedQuarantined = clearFirst
          ? await readQuarantinedLocalCopies(result.quarantined ?? [])
          : [];
        if (clearFirst) {
          // Persist syncCursor:'0' before wiping: a crash between wipe and the final metadata write then leaves "cursor
          // 0, stores intact" (a harmless redundant merge), whereas the inverse order leaves "stores wiped, cursor
          // stale" and the post-reload `initialSync` would pull incrementally into an empty store instead of
          // re-bootstrapping. The success path's final write overwrites it. Field-level update: only syncCursor, never
          // a possibly-stale full-row spread.
          await updateDeviceMetadata((current) => ({
            ...(current ?? defaultMeta(deviceId)),
            deviceId,
            syncCursor: '0',
          }));
          // Preserve the key cache across the wipe: a force-bootstrap refills the same household and doesn't invalidate
          // its key, but `clearAllStores()` drops `keyCache`. User-driven callers re-cache via `recacheHdk()`; the
          // auto-recovery callers (the CURSOR_EXPIRED catch, post-reload `initialSync`) have no in-memory HDK to
          // re-cache from, so without this a cursor-expiry recovery would show "couldn't unlock your encrypted data"
          // over a session whose password and recovery key still work. The unlock path re-verifies the restored key
          // against the live envelope set.
          const preservedKeyCache = await readKeyCacheEntry();
          await clearAllStores();
          if (preservedKeyCache) {
            await writeKeyCacheEntry(preservedKeyCache);
          }
          wiped = true;
          // Wipe the mutation queue too, or stale `failed-conflict` rows survive and pin the badge to "Refresh needed"
          // after the replay.
          await clearMutationQueue();
        }
        // Batch per-row fine signals into one per touched store, so a mounted page re-reads once per type, not once per
        // row.
        await withBatchedStoreSignals(async (batch) => {
          // Quarantined aggregates' last-known-good copies go back first, at their old version, so a later decryptable
          // copy below still applies over them.
          for (const { type, row } of preservedQuarantined) {
            await putAggregate(type, row, batch);
          }
          for (const a of result.workspaceSnapshot.aggregates) {
            if (!isKnownAggregateType(a.aggregateType)) {
              // Snapshots can carry retired types until the next compaction (rolling-deploy rationale at
              // `isKnownAggregateType` in store.ts).
              console.warn(
                `[sync] Skipping snapshot aggregate with unknown aggregateType=${a.aggregateType} (id=${a.id})`,
              );
              continue;
            }
            await putAggregate(a.aggregateType, {
              id: a.id,
              householdId,
              aggregateType: a.aggregateType,
              schemaVersion: a.schemaVersion,
              version: a.version,
              updatedAt: a.updatedAt,
              deletedAt: a.deletedAt,
              deviceId: a.deviceId,
              payload: plaintextPayload(a.payload),
            }, batch);
          }
          for (const c of result.postSnapshotMutations) {
            await applyPulledChange(c, householdId, batch);
          }
        });
        // Field-level update of only the fields this bootstrap owns (deviceId, cursor, lastSyncedAt, freshness when
        // echoed), so a concurrent flush's freshness persist isn't reverted.
        const head = result.freshnessHead;
        if (head) {
          pinnedFreshnessCounterRef.current = head.freshnessCounter;
        }
        const next = await updateDeviceMetadata((current) => ({
          ...(current ?? defaultMeta(deviceId)),
          // Align the persisted deviceId with the canonical (JWT) one; a stale IDB id would mismatch on push.
          deviceId,
          syncCursor: result.syncCursor,
          lastSyncedAt: result.timestamp,
          ...(head ? { freshnessCounter: head.freshnessCounter } : {}),
        }));
        setLastSyncedAt(next.lastSyncedAt);
        // If the network dropped mid-bootstrap, keep 'offline' rather than a stale 'synced'.
        if (onlineRef.current) {
          setSyncState({ kind: 'synced', lastSyncedAt: next.lastSyncedAt });
        }
        // Pages that mounted and read an empty store before this finished (the whole workspace on a fresh device) must
        // re-read, or the dashboard sits on "0 accounts" until a refresh. Fires regardless of `onlineRef`: the data
        // landed either way.
        notifyWorkspaceChanged();
        return { ok: true, wiped };
      } catch (err) {
        if (!onlineRef.current) return { ok: false, wiped };
        // Freshness rollback or unauthenticated payload: the HTTP client throws inside `bootstrap()` before the wipe or
        // apply loop, so `wiped` is still false (reject-before-write).
        if (isRollbackDetectedRejection(err)) {
          setSyncState({ kind: 'rollback-detected' });
          return { ok: false, wiped };
        }
        if (err instanceof SchemaAheadError) {
          // A calm "update needed" badge, not a red error; `setSyncState` auto-records only `error`/`stale`, so record
          // the breadcrumb here.
          const detail = handleSchemaAhead(err);
          recordSyncWarn(`[sync] ${detail.code} — reload required to read latest changes`);
          setSyncState({ kind: 'update-available' });
          return { ok: false, wiped };
        }
        // Transient bootstrap failure: one of the three sites allowed to advance the consecutive-error counter.
        errorCounterRef.current += 1;
        setSyncState({ kind: 'error', ...buildErrorDetail(err, 'bootstrap', 'Refresh failed') });
        return { ok: false, wiped };
      }
    },
    [householdId, deviceId],
  );

  // Pulls remote changes since the last cursor. True on success (or a no-op offline or without a household); false on
  // any transport, schema or apply error. Updates the badge state either way.
  const pull = useCallback(async (): Promise<boolean> => {
    if (!householdId || !onlineRef.current) return false;
    // Fences: a poll pull during a restore, a destructive overwrite or an unfinished clear cleanup must not run; during
    // a restore it would read-modify-write DeviceMetadata and overwrite the just-restored syncCursor '0' and cleared
    // freshness pin with stale metadata. Mirrors `flushPending`.
    if (
      restoreInProgressRef.current ||
      destructiveOpInProgressRef.current ||
      clearCleanupFailedRef.current
    )
      return false;
    setSyncState({ kind: 'syncing-pull' });
    let meta = (await readDeviceMetadata()) ?? defaultMeta(deviceId);
    let anyChanges = false;
    try {
      // Follow `hasMore` and drain every backlogged page in one pull, so the client never sits on partially-applied
      // cross-aggregate state between ticks. Bounded: past the bound the next poll resumes from the persisted cursor.
      const MAX_PULL_PAGES = 50;
      // Batch per-row fine signals into one per touched store across the whole drain; a schema-ahead throw inside still
      // flushes the already-applied stores, then re-throws to the catch below.
      await withBatchedStoreSignals(async (batch) => {
        for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
          const result = await transportRef.current.pull({ since: meta.syncCursor });
          // Pre-flight schema check: a row ahead of this bundle's registry halts the whole batch, so a payload we can't
          // render is never half-applied; reload swaps in a bundle that knows the migration.
          assertNoSchemaAhead(result.changes);
          for (const c of result.changes) {
            await applyPulledChange(c, householdId, batch);
          }
          // Field-level update of only cursor, lastSyncedAt and freshness-if-echoed, so a concurrent flush's freshness
          // persist isn't reverted; the merged row drives the next page's `since`.
          const head = result.freshnessHead;
          if (head) {
            pinnedFreshnessCounterRef.current = head.freshnessCounter;
          }
          const newCursor = result.newCursor;
          const next = await updateDeviceMetadata((current) => ({
            ...(current ?? defaultMeta(deviceId)),
            deviceId,
            syncCursor: newCursor,
            lastSyncedAt: new Date().toISOString(),
            ...(head ? { freshnessCounter: head.freshnessCounter } : {}),
          }));
          meta = next;
          if (result.changes.length > 0) anyChanges = true;
          if (!result.hasMore) break;
        }
      });
      setLastSyncedAt(meta.lastSyncedAt);
      // Keep 'offline' if the network dropped mid-pull.
      if (onlineRef.current) {
        // Badge truthfulness: a successful pull must not flip to 'synced' while conflicts or a parked `failed-error`
        // batch remain; same guard and ordering as the push sites.
        const { conflicts, failedErrors } = await refreshCounts();
        const unsynced = unsyncedBadgeGuard({ conflicts, failedErrors });
        if (unsynced) {
          setSyncState(unsynced);
        } else {
          setSyncState({ kind: 'synced', lastSyncedAt: meta.lastSyncedAt });
        }
      }
      // Nudge mounted readers after committing pulled rows; skipped for an empty batch, since an empty poll pull would
      // only churn every listening page's IDB re-read.
      if (anyChanges) {
        notifyWorkspaceChanged();
      }
      // A pull that completed without CURSOR_EXPIRED proves an ambiguously failed `clearWorkspace` did not land (a
      // committed clear expires this cursor), so the queue is still needed: lift the marker and resume flush-first
      // cursor-expiry recovery.
      clearOutcomeAmbiguousRef.current = false;
      return true;
    } catch (err) {
      if (!onlineRef.current) return false;
      // Freshness rollback or unauthenticated payload: thrown inside `pull()` before the apply loop, so no local write
      // happened.
      if (isRollbackDetectedRejection(err)) {
        setSyncState({ kind: 'rollback-detected' });
        return false;
      }
      // CURSOR_EXPIRED: the cursor predates the compactor watermark (`mutationLogCursorBase`), where an incremental
      // pull would silently miss data, so re-bootstrap.
      if (err instanceof SyncApiError && err.code === 'CURSOR_EXPIRED') {
        // Normally flush pending mutations before the bootstrap wipes the queue: cursor expiry is often caused by this
        // device's own compacted pushes, so the queue can hold valid offline edits. Exception: if a just-attempted
        // `clearWorkspace` failed ambiguously, this CURSOR_EXPIRED may mean that clear committed (its watermark bump
        // expired our cursor), and flushing the stale pre-delete queue would re-push the deleted `create`s onto the
        // swept server. Skip the flush and re-bootstrap from the server's true state (the old queue is discarded with
        // an empty reseed if the clear landed; a safe no-op if not).
        if (!clearOutcomeAmbiguousRef.current) {
          // Best-effort: the bootstrap is mandatory, and a flush already in flight returns true.
          try {
            await flushPending();
          } catch {
            // Bootstrap is mandatory; never let a flush failure skip it.
          }
        }
        // applyBootstrap swallows failure into `{ ok:false }`, so propagate the outcome: a failed mandatory reseed is a
        // pull failure (the store may be wiped or stale).
        const refreshed = await applyBootstrap(true);
        // Only a successful reseed resolves an ambiguous-clear outcome; a failed one keeps the marker so the next
        // CURSOR_EXPIRED retry still skips the resurrecting flush.
        if (refreshed.ok) clearOutcomeAmbiguousRef.current = false;
        return refreshed.ok;
      }
      if (err instanceof SchemaAheadError) {
        // Calm "update needed" badge; record the breadcrumb explicitly (as in `applyBootstrap`).
        const detail = handleSchemaAhead(err);
        recordSyncWarn(`[sync] ${detail.code} — reload required to read latest changes`);
        setSyncState({ kind: 'update-available' });
        return false;
      }
      // Transient pull failure: one of the three sites allowed to advance the consecutive-error counter.
      errorCounterRef.current += 1;
      setSyncState({ kind: 'error', ...buildErrorDetail(err, 'pull', 'Pull failed') });
      return false;
    }
  }, [householdId, deviceId, applyBootstrap, flushPending, refreshCounts]);

  const forceRefresh = useCallback(
    // Mutex-guarded so a user-driven force bootstrap doesn't interleave its wipe and metadata writes with a poll pull
    // or flush.
    async (): Promise<{ ok: boolean; wiped: boolean }> => {
      // Asking for a full refresh resets the consecutive-error counter regardless of outcome.
      errorCounterRef.current = 0;
      // A failed force-refresh raises its own error outside the poll tick, so re-arm the scheduler to the right backoff
      // now instead of leaving a possibly minutes-away timer; gated on the refresh itself having raised.
      return rearmIfRaised(() => runExclusive(() => applyBootstrap(true)));
    },
    [runExclusive, applyBootstrap, rearmIfRaised],
  );

  // Best-effort push, then pull: the precondition for destructive workspace operations (demo reload, bundle import), so
  // local IDB reflects server state before aggregates are tombstoned or rewritten; otherwise server aggregates not yet
  // pulled slip past the wipe's local-only scan and reappear next pull. Push failure is tolerated: those callers clear
  // the queue and tombstone everything anyway, and blocking on "Refresh needed" would strand the user. Pull is
  // mandatory. Returns `{ ok: false, reason }` on offline or pull failure; push failures are silent (the badge still
  // shows them).
  const syncRoundTrip = useCallback(async (): Promise<
    { ok: true } | { ok: false; reason: string }
  > => {
    if (!householdId) return { ok: false, reason: 'Not signed in.' };
    if (!onlineRef.current) {
      setSyncState({ kind: 'offline' });
      return { ok: false, reason: 'You appear to be offline. Reconnect and try again.' };
    }
    // Fences: a round-trip during a restore must not queue behind it on the mutex and then re-push stale state or write
    // a stale cursor over the restored snapshot; a demo overwrite holds the mutex for its wipe-to-load window; an
    // unfinished clear cleanup keeps it suspended too. Bail before touching the mutex, mirroring the inner pull/flush
    // fences.
    if (
      restoreInProgressRef.current ||
      destructiveOpInProgressRef.current ||
      clearCleanupFailedRef.current
    ) {
      return {
        ok: false,
        reason: 'A workspace operation is in progress. Try again once it finishes.',
      };
    }
    // Flush and pull run as one exclusive critical section so neither interleaves `deviceMetadata` writes with a poll,
    // bootstrap or restore. This is the popover's "Sync now", so a transient failure must re-arm the scheduler and
    // publish a countdown deadline like every other non-tick raise path, not leave a static "Sync failed" behind the
    // old cadence.
    return rearmIfRaised(() =>
      runExclusive(async () => {
        // Best-effort push: conflicts and errors update the badge but don't block the round-trip, since the caller is
        // about to wipe the queue.
        await flushPending();
        const pullOk = await pull();
        if (!pullOk) {
          return {
            ok: false,
            reason: 'Could not pull the latest server state. Check your connection and try again.',
          };
        }
        return { ok: true };
      }),
    );
  }, [householdId, runExclusive, flushPending, pull, rearmIfRaised]);

  const listSnapshots = useCallback(
    (): Promise<SnapshotListItem[]> => transportRef.current.listSnapshots(),
    [],
  );

  // Restores a previous snapshot. The server `restore()` runs first: if it throws, nothing was restored, so the
  // freshness pins, cursor and queue keep their values (clearing pins on a failed restore would weaken rollback
  // detection). The persisted freshness clear and in-memory reset happen before `applyBootstrap(true)`, or a stale-high
  // counter would survive the bootstrap, re-hydrate the pin on reload and trip a false rollback-detected.
  // Partial-failure safety: `applyBootstrap` wipes only after its fetch succeeds, so if `restore()` succeeded but the
  // fetch fails, the device would keep OLD aggregates, cursor and queue, and the next poll could re-push stale state
  // and undo the restore (a restored snapshot's null watermark gives no CURSOR_EXPIRED for since='0', leaving stale
  // data behind a 'synced' badge). So the instant the server restore resolves we persist `syncCursor:'0'`, clear the
  // queue (the confirm dialog already warns pending edits are lost) and eagerly `clearAllStores()`, and report
  // `wiped:true` even if the fetch fails: a reload then force-bootstraps the restored snapshot into the empty store.
  // The eager wipe is idempotent with `applyBootstrap`'s own on success.
  const restoreSnapshot = useCallback(
    async (snapshotId: string): Promise<{ ok: boolean; wiped: boolean }> => {
      if (!householdId) return { ok: false, wiped: false };
      // Fence the flush loop before taking the mutex, so `flushPending` returns early while the restore waits its turn;
      // reset in `finally` so a failed restore re-enables syncing.
      restoreInProgressRef.current = true;
      try {
        // The restore's metadata writes, wipe and bootstrap run as one critical section; `applyBootstrap` is called
        // un-guarded because we already hold the lock.
        return await runExclusive(async () => {
          // Await any in-flight flush so no push is mid-send at the server sweep (a push committing after it would
          // recreate data the confirm dialog said was lost). Under the mutex this resolves at once; kept as
          // belt-and-braces.
          await flushPromiseRef.current;
          // 1. The server wipes and reinitialises first; if it throws, the pins, cursor and queue keep their prior
          // values (nothing was restored, so rollback detection stays armed).
          await transportRef.current.restore(snapshotId);
          // 2. Force a "must re-bootstrap, nothing to push" state before the fallible fetch: cursor '0' routes the next
          // initialSync/poll
          // through force-bootstrap, the cleared queue drops pending edits, and the same write clears the persisted
          // freshness pin so a
          // reload can't re-hydrate a stale-high counter; the in-memory reset follows. Field-level update, one atomic
          // transaction.
          await updateDeviceMetadata((current) => ({
            ...(current ?? defaultMeta(deviceId)),
            deviceId,
            syncCursor: '0',
            freshnessCounter: undefined,
          }));
          await clearMutationQueue();
          pinnedFreshnessCounterRef.current = 0;
          // Wipe the stores before the fetch: after a failed fetch, stale aggregates that a since='0' pull can't expire
          // (no CURSOR_EXPIRED) would sit behind a 'synced' badge. Idempotent with applyBootstrap's own wipe on
          // success.
          await clearAllStores();
          // 3. Bootstrap from the restored snapshot. We already wiped locally, so report `wiped:true` even if the fetch
          // fails: the modal
          // then says to reload, and cursor '0' makes that reload re-bootstrap into the empty store.
          const result = await applyBootstrap(true);
          return result.ok ? result : { ok: false, wiped: true };
        });
      } finally {
        // On success the device is already post-restore (cursor '0', empty queue, restored snapshot); on failure the
        // fence must lift so the next poll can retry.
        restoreInProgressRef.current = false;
      }
    },
    [householdId, deviceId, runExclusive, applyBootstrap],
  );

  const resolveConflict = useCallback(
    async (mutation: PendingMutation, choice: 'keep' | 'discard'): Promise<void> => {
      if (!householdId) return;
      // Mutex-guarded so the re-queue/pull and metadata writes don't interleave with a poll; inner flushPending/pull
      // run un-guarded (we hold the lock).
      await runExclusive(async () => {
        const serverVersion = mutation.currentVersion;
        if (choice === 'keep') {
          // Keep re-queues the aggregate's newest local intent (`latestEdit` of the stack), not the clicked conflict's
          // possibly stale payload: the collapse removes every row for the aggregate, so re-queuing the clicked payload
          // would silently delete a later edit made while this conflict sat parked. Op conversion for a keep that can't
          // land as-is, keyed on the newest op but the clicked conflict's rejection facts: a create over a LIVE row
          // becomes `update @ currentVersion` (a `create @ >0` can never satisfy the server's attribute_not_exists +
          // version===0 condition), `NOT_FOUND` on an update becomes `create @ 0` (the row is gone). Every other kept
          // conflict re-bases the newest op onto the server's reported counter, which heals the wedge.
          const stack = await listMutationsByAggregate(mutation.aggregateId);
          const latest = latestEdit(stack);
          let operation = latest.operation;
          let expectedVersion = serverVersion ?? mutation.expectedVersion;
          if (latest.operation === 'update' && mutation.reason === 'NOT_FOUND') {
            operation = 'create';
            expectedVersion = 0;
          } else if (
            latest.operation === 'create' &&
            mutation.reason === 'CONFLICT' &&
            serverVersion != null
          ) {
            operation = 'update';
            expectedVersion = serverVersion;
          }
          try {
            await collapseAndReQueue({
              aggregateType: latest.aggregateType,
              aggregateId: mutation.aggregateId,
              householdId,
              operation,
              expectedVersion,
              schemaVersion: latest.schemaVersion,
              payload: latest.payload,
              removeMutationIds: stack.map((m) => m.id),
            });
          } catch (err) {
            // A `queueLocalMutation` for this aggregate landed during the keep (it isn't fenced by the sync mutex) and
            // the transactional collapse aborted rather than stomp it. Leave the conflict parked and let the fresh edit
            // push on the next flush; any other error propagates.
            if (!(err instanceof ConcurrentQueueMutationError)) throw err;
            await refreshCounts();
            return;
          }
          await flushPending();
        } else if (mutation.operation === 'update' && mutation.reason === 'NOT_FOUND') {
          // Discard of a NOT_FOUND-on-update: accept the server's deletion, dropping the mutation and the local row.
          await removeMutation(mutation.id);
          await deleteAggregateLocally(mutation.aggregateType, mutation.aggregateId);
        } else {
          // Discard adopts the server copy via a pull (`applyPulledChange` overwrites the local aggregate) and verifies
          // convergence: a genuine remote advance reaches `currentVersion` with its content overwritten, whereas a
          // wedge (empty log, nothing to pull) does not; leave that conflict parked (re-escalate) rather than silently
          // drop the un-synced content. A remote deletion converges too: the rejection is a `CONFLICT` carrying
          // `currentDeletedAt` and the pull leaves a tombstone, so read with `getAggregateIncludingDeleted`
          // (`getAggregate` filters tombstones and would never converge). `version >= currentVersion` alone is not
          // enough: the app's optimistic version inflation can push the local version past it off the original poisoned
          // edit. Require the pull to have written the server's true row, i.e. `updatedAt` equal to the persisted
          // `currentUpdatedAt`; a wedge leaves a live local draft with a different `updatedAt`.
          await pull();
          const agg = await getAggregateIncludingDeleted(
            mutation.aggregateType,
            mutation.aggregateId,
          );
          const converged =
            mutation.currentVersion == null ||
            (agg != null &&
              agg.version >= mutation.currentVersion &&
              agg.updatedAt === mutation.currentUpdatedAt);
          if (converged) {
            await removeMutation(mutation.id);
          }
        }
        await refreshCounts();
      });
    },
    [householdId, runExclusive, flushPending, pull, refreshCounts],
  );

  // Check & repair: re-queues each parked `failed-conflict` as a fresh-id `pending` row (the original id would replay
  // the server's 7-day cached CONFLICT, and only `pending` rows are pushed), then one flush lets the reject loop
  // re-classify each. Mutex-guarded like `resolveConflict`.
  const checkAndRepair = useCallback(async (): Promise<void> => {
    if (!householdId) return;
    await runExclusive(async () => {
      const conflicts = await listFailedConflicts();
      for (const c of conflicts) {
        await reEnqueueMutationWithFreshId(c.id, cryptoUuid());
      }
      await refreshCounts();
      await flushPending();
    });
  }, [householdId, runExclusive, flushPending, refreshCounts]);

  // Destructive workspace overwrite (demo reload over existing data), atomic w.r.t. the poll like the restore idiom:
  // the fence is set before taking the mutex (so a racing tick returns early), the destructive window runs inside the
  // mutex (so a tick already holding it drains first, closing the TOCTOU on `clearMutationQueue`), and the fence clears
  // in a `finally`. The fence is ordering only: queued mutations stay householdId-stamped, so the server still enforces
  // ownership.
  const runDestructive = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      destructiveOpInProgressRef.current = true;
      try {
        return await runExclusive(fn);
      } finally {
        // Release once `fn` settles; the success path reloads, but a throw-without-reload needs this so the poll
        // resumes.
        destructiveOpInProgressRef.current = false;
      }
    },
    [runExclusive],
  );

  // Server-authoritative "Delete workspace data" clear. Mirrors restoreSnapshot's fence and await-flush ordering but
  // not its `wiped` semantics: the server sweeps the household, and on 2xx this clears only the sync-metadata residue
  // in this provider (freshness pin, cursor); the aggregate wipe and reload stay in the WorkspaceToolsCard handler,
  // gated on the 2xx. A non-2xx throws before any local change, so the caller keeps the queue and skips the wipe.
  const clearWorkspace = useCallback(
    async (args: {
      currentPassword: string;
      eraseHistory: boolean;
      purgeHistoryOnly?: boolean;
    }): Promise<{ ok: boolean; historyErased: boolean }> => {
      // `runDestructive` fences the poll and takes the mutex; awaiting the in-flight flush first stops a push that
      // committed just after the sweep from recreating deleted data (as in restoreSnapshot).
      return runDestructive(async () => {
        await flushPromiseRef.current;
        let result: { ok: boolean; historyErased: boolean };
        try {
          result = await transportRef.current.clearWorkspace(args);
        } catch (err) {
          // A `SyncApiError` is a definite non-2xx (wrong password, throttle, 5xx): the server did not sweep, so the
          // card's pre-commit fail-safe keeps the queue. Any other throw (an `AbortError` from the per-call timeout, a
          // network `TypeError`) means no response: the client can't tell whether the sweep committed, and if it did
          // the next poll's CURSOR_EXPIRED handler would flush the pre-delete queue and re-push the deleted `create`s,
          // so set the ambiguity marker (see `clearOutcomeAmbiguousRef`). Only a full clear can cause this; a
          // `purgeHistoryOnly` retry never sweeps or bumps the watermark. Rethrow either way so the card surfaces the
          // honest "try again" copy.
          if (!args.purgeHistoryOnly && !(err instanceof SyncApiError)) {
            clearOutcomeAmbiguousRef.current = true;
          }
          throw err;
        }
        // Reached only on 2xx. For a full clear the sweep committed, so clear the freshness pin (persisted and
        // in-memory; a stale one would trip a false "Rollback detected" on the post-reload bootstrap of an encrypted
        // household), reset the cursor to '0' so the reload force-bootstraps the empty snapshot, and drop the mutation
        // queue inside this fenced section. Not in the card: it runs after the fence releases, so a poll tick could
        // read the still-present queue and re-push stale `create`s onto the swept server, resurrecting deleted data.
        // The aggregate wipe and reload stay in the card. A `purgeHistoryOnly` retry skips this: it only purges S3
        // backup history against a live, resumed workspace, and resetting the cursor, pin and queue would force a
        // bootstrap and could discard edits entered since the earlier reload. The cleanup runs after the server's 2xx,
        // so a throw here is not "delete failed": the workspace was erased. A bare throw would show the card's false
        // pre-commit copy and release the fence with stale `create`s still queued for the next poll to re-push. So
        // retry the idempotent cleanup a bounded number of times; only if every attempt fails keep the poll suspended
        // (`clearCleanupFailedRef`, which survives the fence release) and throw the typed `WorkspaceClearCleanupError`
        // for the card's honest recovery path.
        if (!args.purgeHistoryOnly) {
          let cleaned = false;
          let lastCleanupErr: unknown;
          for (
            let attempt = 0;
            attempt < CLEAR_CLEANUP_ATTEMPTS && !cleaned;
            attempt += 1
          ) {
            try {
              await updateDeviceMetadata((current) => ({
                ...(current ?? defaultMeta(deviceId)),
                deviceId,
                syncCursor: '0',
                freshnessCounter: undefined,
              }));
              await clearMutationQueue();
              pinnedFreshnessCounterRef.current = 0;
              cleaned = true;
            } catch (err) {
              lastCleanupErr = err;
              recordSyncWarn(
                `[sync] clearWorkspace: post-commit local cleanup attempt ${attempt + 1}/${CLEAR_CLEANUP_ATTEMPTS} failed`,
                err,
              );
              if (attempt < CLEAR_CLEANUP_ATTEMPTS - 1) {
                await sleep(CLEAR_CLEANUP_RETRY_MS);
              }
            }
          }
          if (!cleaned) {
            // Every attempt failed: keep the poll suspended past the fence's release, since the queue may still hold
            // stale `create`s, and surface the committed-but-uncleaned outcome as a typed error.
            clearCleanupFailedRef.current = true;
            recordSyncError(
              '[sync] clearWorkspace: server clear committed (2xx) but local cleanup could not be completed; poll suspended until a retry resolves it',
              lastCleanupErr,
            );
            throw new WorkspaceClearCleanupError(result);
          }
          // Cleanup succeeded (possibly after a retry or a prior failed clear): lift any suspension a previous terminal
          // failure engaged.
          clearCleanupFailedRef.current = false;
        }
        return result;
      });
    },
    [runDestructive, deviceId],
  );

  // First sync after mount/login: bootstraps when this device has never pulled (cursor '0'), else pulls incrementally.
  // Without it the default 'synced' badge would lie for up to 5 min until the poll timer fires.
  const initialSync = useCallback(async (): Promise<void> => {
    if (!householdId) return;
    if (!onlineRef.current) {
      setSyncState({ kind: 'offline' });
      return;
    }
    // Mutex-guarded so the first sync doesn't interleave metadata writes with a poll tick armed at mount; inner
    // applyBootstrap/pull run un-guarded. A mount-time failure raises before any tick has run, leaving only the
    // mount-armed POLL_IDLE_MS timer, so re-arm it to the right backoff at once (gated on the sync itself having
    // raised).
    await rearmIfRaised(() =>
      runExclusive(async () => {
        const meta = await readDeviceMetadata();
        // Hydrate the freshness pin from persisted metadata so a reload keeps enforcing the last acknowledged counter.
        // Unconditional (`?? 0`): the household-switch effect already reset it, and a new household with no counter
        // must not inherit the prior one's stale-high pin.
        pinnedFreshnessCounterRef.current = meta?.freshnessCounter ?? 0;
        const cursor = meta?.syncCursor;
        if (!meta || !cursor || cursor === '0') {
          await applyBootstrap(false);
        } else {
          await pull();
        }
      }),
    );
  }, [householdId, runExclusive, applyBootstrap, pull, rearmIfRaised]);

  const retryNow = useCallback(async () => {
    // A deliberate click to try again, not a claim the server recovered, so it resets the consecutive-error counter
    // regardless of outcome, like `forceRefresh`.
    errorCounterRef.current = 0;
    // Re-arm at once if the retry itself failed (see `forceRefresh`).
    await rearmIfRaised(flushPendingExclusive);
  }, [flushPendingExclusive, rearmIfRaised]);

  const notifyPending = useCallback(() => {
    // A user edit's own push can fail right after it settles: re-arm to the right backoff only when it actually raised,
    // since this is the save hook every editing page calls and a clean push (or a park, which never feeds the counter)
    // must leave the armed poll alone.
    void rearmIfRaised(flushPendingExclusive);
  }, [flushPendingExclusive, rearmIfRaised]);

  // Latest pull/flushPending in refs so the mount-once polling effect calls current closures without listing them as
  // deps, which would re-arm the timer and reset the cadence to POLL_IDLE_MS.
  const pullRef = useRef(pull);
  const flushPendingRef = useRef(flushPending);
  const runExclusiveRef = useRef(runExclusive);
  useEffect(() => {
    pullRef.current = pull;
    flushPendingRef.current = flushPending;
    runExclusiveRef.current = runExclusive;
    flushPendingExclusiveRef.current = flushPendingExclusive;
  });

  // Mirror the canonical deviceId into module scope so non-React helpers (mutation-queue) stamp mutations with the id
  // the JWT carries.
  useEffect(() => {
    setRegisteredDeviceId(deviceId);
  }, [deviceId]);

  // Initial sync once per household; reset on logout so a later login re-fires.
  useEffect(() => {
    if (!householdId) {
      initialSyncedHouseholdRef.current = null;
      // SyncProvider doesn't remount across logout/login or a user switch (AuthAwareProviders passes a changing
      // householdId prop), so refs leak between households: reset the freshness pin so a stale-high counter can't trip
      // a false rollback-detected, and the retry policy, since a signed-out state owes nobody the prior household's
      // attempt count or deadline.
      pinnedFreshnessCounterRef.current = 0;
      resetRetryPolicy();
      return;
    }
    if (initialSyncedHouseholdRef.current === householdId) return;
    initialSyncedHouseholdRef.current = householdId;
    // Reset the pin before initialSync hydrates it from the new household's metadata (`?? 0`), so a switch from a
    // pinned household to one without a counter clears it.
    pinnedFreshnessCounterRef.current = 0;
    // Start this household's retry policy from zero and re-arm the poll at the mount cadence before initialSync can
    // raise its first error. On the very first mount the poll effect below hasn't assigned `restartPollRef` yet, so
    // this only resets the refs and the effect's own mount-time arm counts.
    resetRetryPolicy();
    void initialSync();
  }, [householdId, initialSync, resetRetryPolicy]);

  // Online/offline event listener.
  useEffect(() => {
    const onOnline = () => {
      onlineRef.current = true;
      // An online-triggered flush that fails re-arms immediately, like the other non-tick entry points, and only when
      // it raised.
      void rearmIfRaised(flushPendingExclusive);
    };
    const onOffline = () => {
      onlineRef.current = false;
      setSyncState({ kind: 'offline' });
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [flushPendingExclusive, rearmIfRaised]);

  // Backoff polling: pull on an interval, push when there is pending work. Mount-once with a self-rescheduling timer
  // whose next delay is read from refs (stateKindRef, pendingCountRef, errorCounterRef) at each tick, not from reactive
  // deps, so a synced-to-error or count change doesn't re-arm at POLL_IDLE_MS and defeat the error-retry or active
  // cadence. A tab returning to visible outside the rewake debounce cancels the idle wait and pulls at once, via the
  // same `schedule`.
  useEffect(() => {
    function schedule(delay: number) {
      if (pollTimerRef.current !== null) clearTimeout(pollTimerRef.current);
      pollTimerRef.current = window.setTimeout(async () => {
        // One mutex acquisition around the pull+flush pair makes the tick a single critical section (no concurrent
        // initialSync/forceRefresh/ notifyPending/restore write slips between them) and keeps the pull-then-flush
        // order. Snapshot the error counter first so the reset below can tell "this tick hit a transient raise site"
        // from "the badge reads 'error' only because an unrelated batch is permanently parked": the truthfulness guard
        // projects `kind === 'error'` for a lingering park even on a clean tick, so gating the reset on `kind` would
        // let a park suppress it forever.
        const errorCounterBeforeTick = errorCounterRef.current;
        await runExclusiveRef.current(async () => {
          await pullRef.current();
          await flushPendingRef.current();
        });
        lastPollAtRef.current = Date.now();
        const kind = stateKindRef.current;
        // "First successful tick" reset: a tick that hit none of the three transient raise sites (the only advancers of
        // `errorCounterRef`) resets the counter and any Retry-After it carried. Keyed on the counter's own movement,
        // not the projected `kind`, which a lingering park keeps at 'error'.
        if (errorCounterRef.current === errorCounterBeforeTick) {
          errorCounterRef.current = 0;
        }
        const ms = kind === 'error' ? computeErrorDelayMs() : (pendingCountRef.current > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS);
        // Publish the poll's own next-attempt deadline for the badge countdown, none for a pure permanent-park error:
        // nothing scheduled will resend a parked batch, so a countdown would falsely promise auto-recovery.
        const deadline = kind === 'error' && !isPureParkErrorState() ? Date.now() + ms : null;
        nextRetryAtRef.current = deadline;
        setNextRetryAt(deadline);
        schedule(ms);
      }, delay);
    }

    // Entry points outside the tick (initialSync, notifyPending/retryNow's flush, forceRefresh, syncRoundTrip, the
    // online flush) reach this through `rearmIfRaised` the instant they raise a transient error, re-arming the
    // already-running timer to the right backoff instead of waiting out whatever cadence was armed (up to POLL_IDLE_MS,
    // ignoring any Retry-After). A no-op outside the error state, and never reached by an operation that raised
    // nothing.
    rearmNowRef.current = () => {
      if (stateKindRef.current !== 'error') return;
      // Publish the deadline as the tick's reschedule does, not just re-arm: leaving `nextRetryAtRef`/`nextRetryAt`
      // null (the first error a user sees, e.g. a mount-time `initialSync` failure) or stale-past defeats the badge
      // countdown and the refocus gate, which treats a past deadline as "no wait owed" and polls at once.
      const ms = computeErrorDelayMs();
      const deadline = isPureParkErrorState() ? null : Date.now() + ms;
      nextRetryAtRef.current = deadline;
      setNextRetryAt(deadline);
      schedule(ms);
    };
    // A household change re-arms from scratch at the mount cadence; the prior household's armed deadline is its own.
    // `resetRetryPolicy` clears the published deadline.
    restartPollRef.current = () => schedule(POLL_IDLE_MS);

    function onVisibility() {
      if (document.visibilityState !== 'visible') return;
      // Refocus during an error-state backoff waits min(remaining backoff, 5s + jitter) instead of polling at once;
      // separate from the debounce below, which applies only outside the error state. A null deadline means none has
      // been recorded yet for this error, not "no backoff owed", so treat the wait as unknown-but-nonzero.
      if (stateKindRef.current === 'error') {
        const remaining =
          nextRetryAtRef.current === null
            ? Infinity
            : Math.max(0, nextRetryAtRef.current - Date.now());
        const refocusWait = REFOCUS_BASE_MS + Math.random() * REFOCUS_JITTER_MS;
        const wait = Math.min(remaining, refocusWait);
        // Reflect the shortened wait on the badge countdown at once; still no deadline for a pure park.
        const deadline = isPureParkErrorState() ? null : Date.now() + wait;
        nextRetryAtRef.current = deadline;
        setNextRetryAt(deadline);
        schedule(wait);
        return;
      }
      if (Date.now() - lastPollAtRef.current < REWAKE_DEBOUNCE_MS) return;
      schedule(0);
    }

    schedule(POLL_IDLE_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (pollTimerRef.current !== null) clearTimeout(pollTimerRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
      rearmNowRef.current = null;
      restartPollRef.current = null;
    };
    // Mount-once by design: cadence inputs are read from refs at tick time, so the timer never re-arms at POLL_IDLE_MS
    // on a state or count change.
  }, []);

  const value = useMemo<SyncContextValue>(
    () => ({
      state,
      pendingCount,
      conflictCount,
      pendingMutations,
      conflictMutations,
      failedErrorMutations,
      lastSyncedAt,
      forceRefresh,
      retryNow,
      nextRetryAt,
      resolveConflict,
      checkAndRepair,
      notifyPending,
      syncRoundTrip,
      listSnapshots,
      restoreSnapshot,
      clearWorkspace,
      runDestructive,
    }),
    [
      state,
      pendingCount,
      conflictCount,
      pendingMutations,
      conflictMutations,
      failedErrorMutations,
      lastSyncedAt,
      forceRefresh,
      retryNow,
      nextRetryAt,
      resolveConflict,
      checkAndRepair,
      notifyPending,
      syncRoundTrip,
      listSnapshots,
      restoreSnapshot,
      clearWorkspace,
      runDestructive,
    ],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSync used outside SyncProvider');
  return ctx;
}

function defaultMeta(deviceId: string): DeviceMetadata {
  return {
    deviceId,
    syncCursor: '0',
    lastSyncedAt: null,
    displayName: 'This device',
  };
}
