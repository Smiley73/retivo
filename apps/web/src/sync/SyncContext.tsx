/**
 * SyncContext — owns the sync state machine and exposes badge state
 * + actions (forceRefresh, retryNow) via `useSync`.
 *
 * State transitions:
 *   pending  → syncing-push → synced
 *   stale    → (user clicks refresh) → syncing-pull → synced
 *   offline  → online listener → resume polling
 *   error    → paced retry (full-jitter backoff, `lib/retry-backoff.ts`)
 *
 * The SPA pages plug in via `useSync()` and queue mutations through
 * `queueLocalMutation` from `mutation-queue.ts`.
 *
 * SHAPE-LIMIT EXCEPTION (recorded justification; CODING_STANDARDS ≤ 800 lines):
 * this file is over the 800-line limit. Why it cannot be split: it is the
 * sync orchestrator — the bootstrap / push / pull state machine, the
 * freshness-rollback handling (`FreshnessRollbackError` / `FreshnessError`),
 * and the schema-ahead detection (`recordSchemaAhead`) all run under one shared
 * in-flight mutex and thread the same `SyncErrorDetail`, badge state, and
 * device metadata; splitting a branch out would have to re-export that mutex +
 * error-detail surface and re-enter it from the others, recreating the coupling
 * across files. This is a security / data-integrity-sensitive surface, so a
 * shape-only split would churn it for no behavioral gain. The pieces layered
 * onto it hang off the same chokepoints rather than adding collaborators: the
 * sync inspector's already-fetched mutation lists on the context value (behind
 * a content-equality gate), the shared `PERMANENT_PUSH_REJECTION_CODES` park
 * set, and the error-state poll cadence (a consecutive-error counter
 * incremented at the three existing catch sites and reset on a successful tick
 * / `forceRefresh` / `retryNow`, a refocus gate, and a `nextRetryAt` value
 * threaded onto the context for the badge's countdown, with delays from
 * `lib/retry-backoff.ts`) — all on the SAME poll-scheduler effect and the SAME
 * `setSyncState` chokepoint this file already centralizes. Splitting the
 * scheduler out would need the same stateKindRef/pendingCountRef/mutex
 * re-entry. The cohesive collaborators that COULD live outside already do: the
 * mutation queue (`mutation-queue.ts`), the device registry (`device-id.ts`),
 * and the sync client / transport (`sync-client.ts` → `HttpSyncClient`, plus
 * `mock-sync.ts`). Trigger: a change adding 5 or more lines here must either
 * refactor the file back under the limit or re-justify this exception in this
 * note.
 */
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

/**
 * Content-equality gate for the mutation lists exposed on the context value.
 * `refreshCounts` runs every poll and returns fresh array refs, so
 * blindly setting them would churn the memoized context value every tick and
 * re-render every `useSync()` consumer + re-resolve every label. Compare by the
 * fields the inspector renders (id + status + expectedVersion + reason) so an
 * unchanged poll keeps the prior array reference (a no-op setState).
 */
export function sameMutationList(
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

/**
 * The push batch under the one-mutation-per-`aggregateId`-per-batch rule.
 * `pending` is sorted by `timestamp` (earliest first), so this keeps the
 * earliest un-pushed mutation per aggregate and defers same-aggregate siblings
 * to the next flush round. Bounded by the server's 100-mutation cap. Deferring
 * siblings means an early sibling's rejection can never coexist with a later
 * sibling's apply in one server batch — closing the same-batch silent-overwrite
 * of a real remote edit.
 */
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
// When a backgrounded tab returns to visible, cancel the long idle
// wait and pull immediately — otherwise a deploy that landed while
// the tab was hidden waits up to 5 min for the next poll boundary
// before the version-banner detector sees a fresh `X-Build-Id`.
// Debounced so rapid focus toggles don't fan out a flurry of pulls.
const REWAKE_DEBOUNCE_MS = 5 * 1000;
// A tab regaining focus DURING an error-state backoff waits
// min(remaining backoff, this + jitter) rather than polling immediately —
// a separate mechanism from REWAKE_DEBOUNCE_MS above, which only debounces
// the non-error idle/active cadence. Firing immediately on refocus would
// defeat the backoff exactly when a person is most likely staring at the
// result.
const REFOCUS_BASE_MS = 5 * 1000;
const REFOCUS_JITTER_MS = 1 * 1000;
// Mirrors the server-side @ArrayMaxSize(100) on POST /sync/push and the
// "≤ 100 mutations per request" cap. When the
// local queue exceeds this (e.g. demo-data load, bulk edits, long
// offline session), we push in sequential batches.
const PUSH_BATCH_SIZE = 100;

/**
 * Badge message for mutations parked as `failed-error` (e.g. a whole batch a
 * FRESHNESS_HEAD_INVALID push reject stamped terminal). Shared by the park
 * branch and {@link unsyncedBadgeGuard} so a subsequent flush/poll tick keeps
 * the same wording instead of flipping the badge to a false `synced` once the
 * parked rows leave the pending queue.
 */
const FAILED_ERROR_BADGE_MESSAGE = 'Some edits could not be sent';

/**
 * Permanent push rejections: none
 * of these can ever succeed by blind retry, so the `flushPending` catch below
 * parks the batch instead of hot-looping the endpoint every retry tick.
 * `SCHEMA_VERSION_TOO_NEW` covers the `schemaVersion` bound — it needs a
 * newer app build to ever clear. `TIMESTAMP_OUT_OF_SERVER_WINDOW` covers the
 * server-time-relative `timestamp` bound, and belongs here because a queued
 * mutation's `timestamp` is frozen at enqueue time (`queueLocalMutation`,
 * mutation-queue.ts) and never re-stamped on retry: correcting the device
 * clock does not change it, and a stamp already behind the past window only
 * drifts further behind as real time advances — left retryable, that one
 * mutation would block every later edit on the device behind it forever, at
 * poll cadence. The generic `ValidationPipe` `BAD_REQUEST`
 * is deliberately NOT in this set: it now covers only malformed/unrecognized
 * field shapes on a batch no legitimate client sends, so parking it buys
 * nothing and would only risk swallowing a code this set hasn't been taught
 * yet. The quota `429` (`PUSH_QUOTA_EXCEEDED`) is also excluded — it clears
 * on the next UTC day, so it must keep retrying on the normal poll cadence.
 */
const PERMANENT_PUSH_REJECTION_CODES = new Set([
  'FRESHNESS_HEAD_INVALID',
  'TIMESTAMP_OUT_OF_SERVER_WINDOW',
  'SCHEMA_VERSION_TOO_NEW',
  'ENCRYPTION_REQUIRED',
  'FRESHNESS_COUNTER_TOO_FAR_AHEAD',
]);

/**
 * Badge truthfulness guard. Returns the badge state that must
 * replace a would-be `synced` transition when the pending queue has drained but
 * unresolved work still lingers, or `null` when it is truthful to declare
 * `synced`. Live conflicts win over parked `failed-error` batches because a
 * conflict is the more actionable prompt; both must keep the badge off `synced`
 * so a subsequent successful push/pull can't silently hide them. Shared by all
 * three `synced`-transition sites (empty-queue entry, post-push tail, post-pull
 * tail) so the ordering + wording stay identical.
 */
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

/**
 * Bounded retry for the POST-COMMIT local sync-state cleanup a full clear runs
 * after the server returns 2xx. The sweep has ALREADY committed, so a
 * transient IndexedDB blip on the cursor-reset / freshness-pin clear /
 * mutation-queue drop must self-heal here rather than surface as a false
 * "couldn't delete workspace data" — every step is idempotent, so the whole
 * unit is safe to re-run. Mirrors the WorkspaceToolsCard `LOCAL_WIPE_ATTEMPTS`
 * retry for the aggregate-store wipe. Only when EVERY attempt fails does the
 * clear surface a typed post-commit error and keep the poll suspended.
 */
const CLEAR_CLEANUP_ATTEMPTS = 3;
const CLEAR_CLEANUP_RETRY_MS = 60;

/**
 * Fixed backoff between clear-cleanup retries (see {@link CLEAR_CLEANUP_ATTEMPTS}).
 * One client settling its own IDB, not a fleet retrying a shared endpoint, so no
 * jitter is needed — the pause just lets a transiently blocked/aborted IDB
 * transaction settle before the next attempt. Named `sleep` (not `delay`) to
 * avoid shadowing the poll scheduler's `delay` parameter.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thrown by `clearWorkspace` when the server clear COMMITTED (a 2xx from
 * `POST /sync/workspace/clear`) but the post-commit LOCAL sync-state cleanup
 * (cursor reset + zero-knowledge freshness-pin clear + mutation-queue drop)
 * could not be completed after {@link CLEAR_CLEANUP_ATTEMPTS} attempts. It is a
 * DISTINCT failure boundary from a `SyncApiError` (a pre-commit rejection —
 * wrong password / throttle / 5xx, where nothing was swept): here the workspace
 * WAS erased server-side, so the caller must NOT show the pre-commit "couldn't
 * delete workspace data" copy. While the cleanup is unresolved the sync poll
 * stays suspended (the mutation queue may still hold stale `create`s a flush
 * would re-push onto the freshly-swept server), so the caller keeps the user on
 * the page with an honest recovery path instead of reloading — a reload would
 * silently resurrect the deleted data on the next poll.
 */
export class WorkspaceClearCleanupError extends Error {
  constructor(
    /** The server's 2xx outcome — the clear DID commit server-side. */
    public readonly result: { ok: boolean; historyErased: boolean },
  ) {
    super(
      'Workspace cleared on the server, but the local sync-state cleanup could not be completed.',
    );
    this.name = 'WorkspaceClearCleanupError';
  }
}

interface SyncContextValue extends SyncSnapshot {
  /** The current un-synced mutation lists, for the read-only sync inspector.
   *  Already fetched by `refreshCounts` every poll; exposed here (behind a
   *  content-equality gate) so the badge popover + Diagnostics card can name
   *  which objects are stuck. `failedErrorMutations` is `[]` in production
   *  today (no writer for `failed-error`). */
  pendingMutations: readonly PendingMutation[];
  conflictMutations: readonly PendingMutation[];
  failedErrorMutations: readonly PendingMutation[];
  /** Wipe local IndexedDB + the mutation queue and reseed from the
   *  server snapshot. `ok` is the reseed outcome; `wiped` reports
   *  whether `clearAllStores()` already ran (true → local data is
   *  gone; a failed reseed needs a reload to re-bootstrap, which the
   *  cursor-reset invariant guarantees). Consumed by the Workspace
   *  "Reload from server" handler; the stale-badge / `CURSOR_EXPIRED` callers
   *  await and ignore it. */
  forceRefresh(): Promise<{ ok: boolean; wiped: boolean }>;
  retryNow(): Promise<void>;
  /** Epoch-ms deadline for the next scheduled retry attempt while `state.kind`
   *  is `'error'`; `null` otherwise. Drives the badge's live "Retrying in Ns"
   *  countdown — the badge itself never
   *  computes a delay, it only counts down to this value. */
  nextRetryAt: number | null;
  /** Resolve one parked `failed-conflict` mutation the user's way.
   * `keep` re-bases the stored edit onto the
   *  server's true version with a fresh id and pushes (op-converting a
   *  create-over-live to `update @ currentVersion` and a NOT_FOUND-on-update to
   *  `create @ 0`) — this also heals the wedged-counter case. `discard` drops the
   *  edit and adopts the server copy (via a pull), re-escalating instead of
   *  silently diverging if the aggregate cannot converge. The effectful primitive
   *  the per-row Resolve control in `<UnsyncedMutationList>` calls (injected as a
   *  prop by the badge popover + Diagnostics card). */
  resolveConflict(mutation: PendingMutation, choice: 'keep' | 'discard'): Promise<void>;
  /** Re-run the auto-repair pass over every parked `failed-conflict`
   *  (Check & repair): re-queues each as a fresh-id
   *  `pending` row (so `flushPending` pushes it and the original id can't replay
   *  the server's 7-day cached CONFLICT) then flushes, so the reject loop
   *  re-classifies each — silently resolving a since-fixed conflict and
   *  rehydrating a legacy row's server facts so its keep/discard unlocks. Wired
   *  to the Diagnostics card's "Check & repair" button. */
  checkAndRepair(): Promise<void>;
  /** Called by features after queueing a new mutation. */
  notifyPending(): void;
  /** Push pending mutations + pull remote changes. Returns `{ ok: false }`
   *  with a user-facing reason when the round-trip fails. Intended as
   *  a precondition for destructive workspace operations (import,
   *  demo reload) so they don't proceed on stale local state. */
  syncRoundTrip(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** List the household's available snapshots (newest-first) for the
   *  self-service "Restore previous version" UI. Pass-through to the
   *  sync client. */
  listSnapshots(): Promise<SnapshotListItem[]>;
  /** Restore the workspace to a previous snapshot: clears the ZK
   *  freshness pin (persisted + in-memory), tells the server to wipe +
   *  reinitialise its sync state at the chosen snapshot, then wipes
   *  local IndexedDB and force-bootstraps from the restored snapshot.
   *  `ok` is the local reseed outcome; `wiped` reports whether the local
   *  stores were already cleared (a failed reseed after `wiped:true`
   *  needs a reload to re-bootstrap). */
  restoreSnapshot(snapshotId: string): Promise<{ ok: boolean; wiped: boolean }>;
  /** Server-authoritative "Delete workspace data" clear.
   * Runs under the destructive-op fence and awaits
   *  any in-flight flush, then calls `POST /sync/workspace/clear`. On
   *  a 2xx result it clears the zero-knowledge freshness pin (persisted +
   *  in-memory), resets the sync cursor so the post-clear reload
   *  force-bootstraps the empty snapshot, AND drops the local mutation queue
   *  INSIDE the fence (so a post-fence poll can't re-push just-deleted
   *  `create` mutations onto the swept server) — but does NOT itself wipe the
   *  aggregate stores or reload (the WorkspaceToolsCard handler owns that
   *  residue cleanup + reload, strictly gated on the 2xx). Rejects (typed
   *  `SyncApiError`) on any non-2xx so the caller preserves the mutation queue
   *  and skips the wipe (the fail-safe the old client-tombstone flow lacked).
   *  If the server clear COMMITTED (2xx) but the post-commit local cleanup
   *  cannot complete after bounded retries, rejects with a distinct typed
   *  `WorkspaceClearCleanupError` and keeps the poll suspended, so the
   *  caller can tell "server never swept" from "server swept but local cleanup
   *  failed" and never re-pushes the still-queued mutations.
   *  `eraseHistory` opts into purging S3 backup history; `purgeHistoryOnly` is
   *  the erase-history retry (purge-only, no sweep). */
  clearWorkspace(args: {
    currentPassword: string;
    eraseHistory: boolean;
    purgeHistoryOnly?: boolean;
  }): Promise<{ ok: boolean; historyErased: boolean }>;
  /** Run a destructive workspace overwrite (demo reload over existing data)
   *  atomically w.r.t. the background poll. Sets the destructive-op fence
   *  (so a poll tick early-returns instead of flushing half-queued wipe/load
   *  mutations), then runs `fn` inside the sync mutex, then clears the fence
   *  in a `finally` (so a throw-without-reload re-enables the poll; the
   *  success path's `window.location.reload()` discards the per-mount ref).
   *  Resolves to `fn`'s return value. */
  runDestructive<T>(fn: () => Promise<T>): Promise<T>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

interface SyncProviderProps {
  children: ReactNode;
  householdId: string | null;
  /**
   * Canonical device id from AuthContext (the same value the JWT
   * carries). Used as the push body's `deviceId` and stamped on every
   * queued mutation; misalignment with the JWT triggers a 403
   * `DEVICE_MISMATCH` in the controller.
   */
  deviceId: string;
  apiBaseUrl: string;
  getAccessToken: () => string | null;
  getCsrfToken: () => string | null;
  /** Attempt to refresh the access token on 401. Returns new token or null. */
  refreshAccessToken?: () => Promise<string | null>;
  /**
   * Called when a push gets `DEVICE_MISMATCH`; the host forces a
   * re-login. SyncProvider stays auth-agnostic — the host
   * (AuthAwareProviders) supplies the logout + signout-reason behaviour.
   */
  onDeviceMismatch?: () => void | Promise<void>;
  /**
   * Returns the active household data key (null = plaintext path). When it
   * returns null the encrypted freshness path stays off.
   */
  getHdk?: () => CryptoKey | null;
  /** When true, replace the HTTP transport with the in-process mock. */
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
  // Latest server-acknowledged freshness counter this device pins. Updated after each push/pull/bootstrap that echoes a
  // head; read by the HTTP client when computing/verifying the head.
  // The server only echoes a head when the client sends one
  // (HDK-gated), so this stays 0 until a key is in use.
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
          // Quarantine: the record-keeping
          // itself lives in `sync/quarantine.ts`, not here (shape-limit).
          reportDecryptOutcome: (outcome) => {
            void recordDecryptOutcome(outcome);
          },
        }),
  );
  // Initial state mirrors whether we know we'll have to sync. With a
  // householdId at mount we'll immediately fire `initialSync`, so seed
  // the badge as 'syncing-pull' rather than the misleading default
  // 'synced'. App.tsx's first-run modal gates on `kind === 'synced'`,
  // so honest seeding also keeps that gate from firing before the
  // first server round-trip completes.
  const [state, setState] = useState<SyncBadgeState>(() =>
    householdId ? { kind: 'syncing-pull' } : { kind: 'synced', lastSyncedAt: null },
  );
  const [pendingCount, setPendingCount] = useState(0);
  const [conflictCount, setConflictCount] = useState(0);
  // The full mutation lists behind the counts, for the read-only inspector.
  // Set from the arrays `refreshCounts` already fetches, behind a
  // content-equality gate (`sameMutationList`) so an unchanged poll is a no-op.
  const [pendingMutations, setPendingMutations] = useState<readonly PendingMutation[]>([]);
  const [conflictMutations, setConflictMutations] = useState<readonly PendingMutation[]>([]);
  const [failedErrorMutations, setFailedErrorMutations] = useState<readonly PendingMutation[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  // Mirror the current badge `kind` into a ref written synchronously at
  // set-time. The mount-once polling effect reads this (not the reactive
  // `state`) to pick the next delay, so a synced→error transition retries
  // at the backoff delay without re-arming the timer at POLL_IDLE_MS.
  // Every state write goes through `setSyncState`.
  const stateKindRef = useRef<SyncBadgeState['kind']>(
    householdId ? 'syncing-pull' : 'synced',
  );
  const setSyncState = useCallback((next: SyncBadgeState) => {
    // Record every non-console `error` transition into the diagnostics
    // timeline as exactly one entry. Centralised here — not at each
    // `setSyncState({kind:'error',…})` call site — so a future error site
    // can't be missed (push, bootstrap, pull, and schema-ahead all route
    // through this one point; schema-ahead errors belong in the timeline too).
    // The `[sync]` console.warn sites are NOT recorded here — the console
    // shim already captures them (no double-capture).
    if (next.kind === 'error') {
      recordSyncError(
        `[sync] ${[next.phase, next.code, next.message]
          .filter(Boolean)
          .join(' ')}`.trim(),
      );
    } else if (next.kind === 'stale') {
      // The badge is flipping to "Refresh needed". Mark the timeline so the
      // export/View-recent-activity shows WHEN a refresh was demanded (the
      // per-mutation reasons WHY are recorded at push time — see the reject
      // loop in `flushPending`). Centralised here so all three stale sites
      // (post-push, post-pull) are covered from one point, like the `error`
      // case above. Warn-level via `recordSyncWarn`, not an `error`.
      recordSyncWarn(
        `[sync] refresh needed — ${conflictCountRef.current} unresolved conflict(s)`,
      );
    }
    stateKindRef.current = next.kind;
    // Mirror a fresh error's parsed Retry-After into a ref the scheduler can
    // read synchronously — every error
    // state funnels through here, so this is the one place that needs to
    // know about the field, rather than every individual raise site.
    errorRetryAfterMsRef.current = next.kind === 'error' ? next.retryAfterMs ?? null : null;
    setState(next);
  }, []);
  // Latest pending count, written in `refreshCounts`, read by the polling
  // effect to choose POLL_ACTIVE_MS vs POLL_IDLE_MS without re-arming.
  const pendingCountRef = useRef<number>(0);
  // Latest conflict count, mirrored like `pendingCountRef` so `setSyncState`
  // can annotate the `stale` ("refresh needed") diagnostic with the count
  // without prop-drilling it through every call site.
  const conflictCountRef = useRef<number>(0);
  // Latest `failed-error` (permanently parked) count, mirrored like
  // `pendingCountRef`. The scheduler
  // consults it to tell "a fresh transient error, about to back off" apart
  // from "an unrelated permanently-parked batch keeps the badge on 'error'
  // forever" — see `errorCounterRef` below.
  const failedErrorCountRef = useRef<number>(0);
  // Consecutive-error counter: incremented ONLY at the three
  // transient raise sites (flushPending's non-permanent catch branch, the
  // bootstrap catch, the pull catch) — never by a permanent-park rejection,
  // and never by the scheduler itself (which can't tell a fresh transient
  // failure apart from a lingering park; only the raise sites can). Reset to
  // 0 by the scheduler on the first tick that does NOT hit one of those three
  // sites (a "successful tick"), and by `forceRefresh` / `retryNow`.
  // Per-household state: cleared with the rest of the retry policy on a
  // household change (`resetRetryPolicy` below).
  const errorCounterRef = useRef<number>(0);
  // The most recently parsed `Retry-After` for the CURRENT error (ms, or
  // `null`), mirrored by `setSyncState` from `SyncErrorDetail.retryAfterMs`.
  // Consulted by the scheduler's override rule; a distinct value from
  // "no error" — `null` also correctly means "this error carried no header".
  const errorRetryAfterMsRef = useRef<number | null>(null);
  // Epoch-ms deadline for the next scheduled poll while in the error state,
  // exposed reactively on the context for the badge's live countdown.
  // `null` outside the error state. Mirrored into a ref so the
  // refocus handler can read "remaining backoff" synchronously without
  // being a dependency of the mount-once polling effect.
  const [nextRetryAt, setNextRetryAt] = useState<number | null>(null);
  const nextRetryAtRef = useRef<number | null>(null);
  // Set by the mount-once polling effect (below) to the current render's
  // "recompute the error-state wait from the refs above and re-arm the poll
  // timer to it right now" function. A ref (not a direct call) because the
  // non-tick error-raising entry points below — `initialSync`, `notifyPending`,
  // `retryNow`, `forceRefresh`, the online-listener flush — are declared
  // BEFORE that effect runs; by the time any of them actually fires (after
  // mount), the effect has already assigned it. A
  // poll TICK's own error transition does NOT go through this ref — its
  // end-of-callback reschedule already owns that case — so a tick's error
  // is never armed twice.
  const rearmNowRef = useRef<(() => void) | null>(null);
  // Set by the same mount-once effect to "arm the poll timer at the mount
  // cadence, from now" — exactly what a fresh mount does. Called on a
  // household change so the NEW household's polling
  // starts as a fresh mount's would, instead of inheriting whatever deadline
  // (an error backoff, an active cadence) the PRIOR household's last tick or
  // raise site happened to arm.
  const restartPollRef = useRef<(() => void) | null>(null);
  // Whether the CURRENT `error` badge state is a permanent park with
  // nothing else outstanding to retry — `failedErrorCountRef` (a parked
  // batch, never resent) is nonzero and `pendingCountRef` (real, retryable
  // pending mutations) is zero. Nothing scheduled for this state will ever
  // actually resend the parked rows, so no live "Retrying in Ns" deadline
  // should be published for it
  // — only a user action (forceRefresh/retryNow) clears a park.
  function isPureParkErrorState(): boolean {
    return failedErrorCountRef.current > 0 && pendingCountRef.current === 0;
  }
  // The next error-state wait, floored at the idle/active cadence
  // whenever a permanently parked batch is lingering — a park never
  // clears by retrying, so it must never poll the server more often than
  // today's flat cadence just because an unrelated consecutive-error
  // counter happens to be sitting at a nonzero value (the
  // previous `errorCounterRef.current === 0` carve-out stopped applying the
  // instant ANY transient error preceded the park, even once that error's
  // own tick was long over).
  function computeErrorDelayMs(): number {
    const attempt = Math.max(0, errorCounterRef.current - 1);
    const computed = resolveRetryDelayMs(attempt, errorRetryAfterMsRef.current);
    if (failedErrorCountRef.current === 0) return computed;
    const cadence = pendingCountRef.current > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS;
    return Math.max(computed, cadence);
  }
  // Run a non-tick sync operation (initialSync, notifyPending / retryNow /
  // the online-listener flush, forceRefresh, syncRoundTrip) and re-arm the
  // poll scheduler afterward ONLY if that operation itself advanced the
  // consecutive-error counter — i.e. hit one of the three transient raise
  // sites. `rearmNowRef` keys on the projected badge `kind`, which the
  // badge-truthfulness guard pins at `'error'` for as long as an unrelated
  // batch stays permanently parked; an unconditional re-arm after every
  // flush therefore pushed the armed poll out by a full idle cadence on
  // EVERY successful edit-driven push while a park lingered, so a user
  // editing more often than once per POLL_IDLE_MS never ran a pull tick
  // again for the session.
  // Same snapshot-and-compare rule the tick's own counter reset uses; a park
  // or a clean flush leaves the already-armed cadence alone. `finally` so a
  // raise that surfaces as a throw still re-arms. Callers that reset the
  // counter (`forceRefresh`, `retryNow`) do so BEFORE calling this, so the
  // snapshot is the reset value and "moved" means "this attempt raised".
  const rearmIfRaised = useCallback(async <T,>(op: () => Promise<T>): Promise<T> => {
    const before = errorCounterRef.current;
    try {
      return await op();
    } finally {
      if (errorCounterRef.current !== before) rearmNowRef.current?.();
    }
  }, []);
  // Forget every piece of retry-policy state the current household
  // accumulated — the consecutive-error counter, the Retry-After it was
  // carrying, the published deadline — and re-arm the poll timer at the
  // mount cadence. SyncProvider never remounts across a household change
  // (see the household effect below), so without this a household that
  // signed out mid-backoff handed its attempt count and deadline to the next
  // one: that household's FIRST transient error then waited at an inherited,
  // already-grown ceiling instead of the attempt-0 interval the backoff policy promises, and
  // the badge could count down to a deadline that was never its own.
  const resetRetryPolicy = useCallback(() => {
    errorCounterRef.current = 0;
    errorRetryAfterMsRef.current = null;
    nextRetryAtRef.current = null;
    setNextRetryAt(null);
    restartPollRef.current?.();
  }, []);
  const onlineRef = useRef<boolean>(navigator.onLine);
  const pollTimerRef = useRef<number | null>(null);
  // Tracks the wall-clock time of the last poll completion so the
  // visibility rewake handler can decide whether to fire an extra
  // pull on tab refocus. Seeded with mount time so a refocus within
  // the first 5 s of mount falls inside the debounce.
  const lastPollAtRef = useRef<number>(Date.now());
  // Tracks the householdId we've already kicked off an initial sync
  // for, so we don't re-fire on every re-render or in StrictMode.
  // Reset on logout (householdId → null).
  const initialSyncedHouseholdRef = useRef<string | null>(null);
  // Serialize push attempts. Multiple `notifyPending()` calls during a
  // bulk operation (demo loader queues ~150 mutations sequentially)
  // would otherwise fan out concurrent `flushPending` runs, each
  // calling `transport.push` independently against an overlapping
  // pending list. The server's idempotency keys make the net effect
  // safe — but the client thrashes badge state and burns request
  // budget. Guard: while one flush is in flight, additional triggers
  // only set `pendingRerunRef`; the in-flight run checks that flag on
  // completion and re-fires once if more work arrived mid-flight.
  const flushInFlightRef = useRef<boolean>(false);
  const pendingRerunRef = useRef<boolean>(false);
  // Latest `flushPendingExclusive` for the re-fire in `flushPending`'s
  // finally (it is declared before `flushPendingExclusive` exists, so it
  // must go through a per-render ref — same pattern as pullRef below).
  const flushPendingExclusiveRef = useRef<() => Promise<boolean>>(
    () => Promise.resolve(true),
  );
  // Synchronous "a flush is enqueued on the mutex but hasn't started yet"
  // flag. `flushPendingExclusive` defers the actual flush onto the
  // mutex via a microtask, so `flushInFlightRef` (set synchronously inside
  // `flushPending`) is NOT yet true when a burst of `notifyPending` calls
  // fires in the same tick. Without this flag every call in the burst would
  // see both flags false and enqueue its own flush — N sequential lock
  // acquisitions instead of one coalesced flush. Set true at enqueue,
  // cleared the instant the enqueued flush begins (which then immediately
  // sets `flushInFlightRef`), so there is no window where both are false.
  const flushScheduledRef = useRef<boolean>(false);
  // Sync mutex. A promise chain that serializes the TOP-LEVEL sync
  // entry points (the poll tick's pull+flush pair, initialSync,
  // notifyPending/retryNow/online flush, forceRefresh, syncRoundTrip,
  // restoreSnapshot) so pull / bootstrap / flush / restore can never
  // interleave their `deviceMetadata` read-modify-writes. The lock is
  // acquired ONLY at entry points — never inside the inner pull /
  // flushPending / applyBootstrap implementations — because those call each
  // other (pull's CURSOR_EXPIRED handler runs flushPending + applyBootstrap;
  // restoreSnapshot runs applyBootstrap; syncRoundTrip runs flushPending +
  // pull). Re-acquiring inside an inner fn would deadlock against the
  // entry-point that already holds it.
  const syncLockRef = useRef<Promise<void>>(Promise.resolve());
  const runExclusive = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    // Chain onto the current tail; always release in `finally` so a throw
    // can't wedge the chain. The caller awaits `result`, not the chain tail.
    const result = syncLockRef.current.then(fn, fn);
    syncLockRef.current = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }, []);
  // The currently-running `flushPending` promise (null when idle). A
  // restore awaits this before telling the server to sweep, so no push
  // is mid-send when the sweep runs — an in-flight HTTP push that
  // committed server-side AFTER the sweep would recreate data the
  // confirm dialog said was permanently lost. Clearing the
  // local queue can't recall a request already on the wire, so we fence
  // the restore behind the flush instead.
  const flushPromiseRef = useRef<Promise<boolean> | null>(null);
  // True for the duration of `restoreSnapshot` (server restore +
  // local re-bootstrap). While set, `flushPending` early-returns without
  // starting a new push, so the poll loop / a stray `notifyPending`
  // cannot push stale local state on top of the just-restored snapshot.
  const restoreInProgressRef = useRef<boolean>(false);
  // True for the duration of a destructive workspace overwrite (demo reload
  // over existing data). Mirrors `restoreInProgressRef`: while set,
  // `flushPending`/`pull`/`syncRoundTrip` early-return so a poll tick cannot
  // flush half-queued wipe/load mutations during the wipe→load window. Unlike
  // restore (whose own logout path stops the poll), the demo-overwrite path
  // keeps the SyncProvider mounted, so the fence is what makes the destructive
  // op atomic w.r.t. the still-ticking poll. Set BEFORE the mutex is acquired
  // and cleared in a `finally` (see `runDestructive`).
  const destructiveOpInProgressRef = useRef<boolean>(false);
  // Set when a 2xx `clearWorkspace` committed server-side but its POST-COMMIT
  // local sync-state cleanup (cursor reset + freshness-pin clear + queue drop)
  // could not be completed after bounded retries. While set,
  // `flushPending` / `pull` / `syncRoundTrip` early-return exactly like the
  // destructive-op fence: the mutation queue may still hold stale `create`s, and
  // a flush would re-push them onto the freshly-swept server, resurrecting the
  // just-deleted data. Unlike `destructiveOpInProgressRef` (released in
  // `runDestructive`'s `finally`), this SURVIVES the fenced window — it is
  // cleared only when a later clear's cleanup finally succeeds, or discarded
  // with the page when the card reloads / the user clears the device.
  const clearCleanupFailedRef = useRef<boolean>(false);
  // Set when a `clearWorkspace` transport call failed AMBIGUOUSLY — a
  // browser abort / request timeout / network drop where NO HTTP response was
  // received, so the client cannot tell whether the server committed the sweep
  // before the connection dropped (a definite `SyncApiError` non-2xx, by
  // contrast, means the server did NOT sweep). If the sweep DID commit, the next
  // poll hits `CURSOR_EXPIRED` (the committed clear bumped the watermark past
  // this device's cursor); that handler normally flushes the pending queue
  // BEFORE re-bootstrapping to preserve the device's own offline edits —
  // but here that flush would re-push the just-deleted `create`s onto the
  // freshly-swept server, resurrecting the data the user just deleted. While
  // this flag is set the `CURSOR_EXPIRED` handler SKIPS its pre-bootstrap flush
  // and re-bootstraps straight from the server's true state (empty if the clear
  // landed, still-populated if it did not — a safe no-op). Unlike
  // `clearCleanupFailedRef` this does NOT suspend the poll (the poll must run to
  // reach `CURSOR_EXPIRED`); it is lifted once a successful reseed consumes it,
  // or a normal (non-`CURSOR_EXPIRED`) pull confirms no committed clear expired
  // this cursor. In-memory only (mirroring `clearCleanupFailedRef`): discarded
  // with the page on reload.
  const clearOutcomeAmbiguousRef = useRef<boolean>(false);
  // Keep the latest `onDeviceMismatch` in a ref so the `flushPending`
  // useCallback can call it from its push catch without listing the prop
  // as a dependency (which would re-create the callback every render and
  // re-arm the poll/effect chain). Same fresh-ref pattern as IdleTimer's
  // onWarn/onTimeout.
  const onDeviceMismatchRef = useRef(onDeviceMismatch);
  useEffect(() => {
    onDeviceMismatchRef.current = onDeviceMismatch;
  }, [onDeviceMismatch]);
  // Keep the latest householdId in a ref so the getHouseholdId callback
  // inside the once-constructed transportRef closure always reads the
  // current value (avoids the stale-initial-value issue with useRef init).
  const householdIdRef = useRef(householdId);
  useEffect(() => {
    householdIdRef.current = householdId;
  }, [householdId]);
  // The forced-export transport (`createExportSyncTransport`) runs its own
  // `HttpSyncClient` outside this provider's pull/bootstrap poll, so a
  // rollback-detected rejection caught there (settings data export) can
  // never reach `setSyncState` directly. Register the shared hook
  // so that rejection still flips the badge here.
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
      // `failed-error` rows are batches parked after a permanent push
      // rejection (see the `PERMANENT_PUSH_REJECTION_CODES` branch).
      listFailedErrors(),
    ]);
    // Mirror into a ref so the mount-once polling effect reads the
    // latest count without listing it as a dep (which would re-arm the
    // timer and defeat the active/idle cadence).
    pendingCountRef.current = pending.length;
    conflictCountRef.current = conflicts.length;
    failedErrorCountRef.current = failedErrors.length;
    setPendingCount(pending.length);
    setConflictCount(conflicts.length);
    // Expose the full lists for the inspector, keeping the prior array ref
    // when the content is unchanged so an unchanged poll doesn't churn the
    // context value or re-resolve labels.
    setPendingMutations((prev) => (sameMutationList(prev, pending) ? prev : pending));
    setConflictMutations((prev) => (sameMutationList(prev, conflicts) ? prev : conflicts));
    setFailedErrorMutations((prev) =>
      sameMutationList(prev, failedErrors) ? prev : failedErrors,
    );
    return { pending, conflicts, failedErrors };
  }, []);

  /** Push pending mutations to the server. Returns `true` on a clean
   *  flush (no pending, no conflicts, no transport error); `false`
   *  otherwise. State is updated as a side effect either way so the
   *  badge reflects the outcome. Used by retry/polling (return value
   *  ignored) and by `syncRoundTrip` (return value gates destructive
   *  operations).
   *
   *  Re-entry behaviour: if another flush is already running, mark
   *  `pendingRerunRef` and return `true` immediately — the in-flight
   *  run will re-fire after it finishes so the rerun observes whatever
   *  mutations were queued mid-flight. The early return uses `true`
   *  because the caller (notifyPending / polling) doesn't gate
   *  anything on the outcome; `syncRoundTrip` is the only caller that
   *  reads the return value, and it never re-enters mid-flight. */
  const flushPending = useCallback(async (): Promise<boolean> => {
    if (!householdId) return true;
    // Restore fence: while a restore is sweeping + re-bootstrapping,
    // never start a new push. A push here would race the server sweep and
    // could re-commit stale local state on top of the restored snapshot.
    // Destructive-op fence: same rationale for the demo-overwrite
    // wipe→load window.
    // Clear-cleanup fence: a committed clear whose local queue drop
    // could not finish — never push, or the still-queued stale `create`s would
    // resurrect on the freshly-swept server.
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
    // Expose THIS run's promise so `restoreSnapshot` can await any
    // in-flight flush before it tells the server to sweep. The
    // resolver is wired up once `run()` is invoked below.
    let settle: (v: boolean) => void = () => {};
    flushPromiseRef.current = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const run = async (): Promise<boolean> => {
      // Loop so a mutation queued mid-flight gets flushed in the same
      // call rather than waiting for the next external trigger. Each
      // iteration re-reads the queue and drains it entirely (in
      // PUSH_BATCH_SIZE chunks), so additions that arrived during the
      // previous push are picked up here. The cap bounds the number of
      // re-flush ROUNDS, not the total mutation count — each round
      // already drains the whole queue. 8 is comfortably above any
      // realistic demo-load / bulk-edit re-queue pattern.
      let iterations = 0;
      while (iterations < 8) {
        iterations += 1;
        pendingRerunRef.current = false;
        const { pending, conflicts, failedErrors } = await refreshCounts();
        if (pending.length === 0) {
          // Badge truthfulness: an empty queue must not declare
          // 'synced' while unresolved conflicts or parked `failed-error`
          // batches still linger — that flips the badge from a truthful prompt
          // back to 'synced' on the next poll and drops the user's cue to
          // resolve. The guard keeps conflicts (the more actionable prompt)
          // ahead of parked errors and stays off 'synced' when either lingers.
          const unsynced = unsyncedBadgeGuard({ conflicts, failedErrors });
          if (unsynced) {
            setSyncState(unsynced);
            return false;
          }
          // An empty flush did no network work, so it has no evidence to
          // declare 'synced' over a LIVE transient error — one raised at a
          // raise site and not yet reset (a nonzero counter; a permanent park
          // never feeds it and is caught by the guard above). The poll tick
          // pairs `pull` with this flush unconditionally, and with nothing
          // queued (the normal idle case) this branch flipped a pull's fresh
          // 429 / outage straight back to 'synced': its Retry-After,
          // backoff, error badge and countdown were all discarded and the
          // next attempt re-armed a full POLL_IDLE_MS out. Leave the error in place — the next pull is what
          // clears it — and report "not a clean flush".
          if (stateKindRef.current === 'error' && errorCounterRef.current > 0) {
            return false;
          }
          setSyncState({ kind: 'synced', lastSyncedAt });
          return true;
        }
        setSyncState({ kind: 'syncing-push' });
        // One mutation per `aggregateId` per batch, capped at the
        // server's 100-mutation limit. Same-aggregate siblings wait for the
        // next drain round of the outer loop, so an early sibling's rejection
        // can never coexist with a later sibling's apply in one server batch.
        // Idempotency keys make a retried batch safe — the server dedupes by
        // `(householdId#deviceId#mutationId)` per AGENTS.md. Declared before the
        // try so the `FRESHNESS_HEAD_INVALID` catch branch can park exactly this
        // batch's mutation ids.
        const batch = firstPerAggregate(pending, PUSH_BATCH_SIZE);
        try {
          {
            const result = await transportRef.current.push({
              householdId,
              deviceId,
              mutations: batch,
            });
            // Pin the server-acknowledged freshness head.
            // No-op unless a head is present (only when the HDK is
            // unlocked and the client sent one). Persist alongside the
            // device metadata so the pin survives a reload.
            if (result.freshnessHead) {
              pinnedFreshnessCounterRef.current =
                result.freshnessHead.freshnessCounter;
              // Field-level functional update: persist ONLY the
              // freshness counter inside one atomic IDB transaction so a
              // concurrent pull's cursor write can't be clobbered by a stale
              // full-row spread.
              const counter = result.freshnessHead.freshnessCounter;
              await updateDeviceMetadata((current) => ({
                ...(current ?? defaultMeta(deviceId)),
                deviceId,
                freshnessCounter: counter,
              }));
            }
            for (const r of result.applied) {
              await removeMutation(r.mutationId);
              // Create-over-tombstone revive: a rare event
              // worth a breadcrumb, PII-safe (redaction-surviving id
              // fragment only — never the resolved human name).
              if (r.recreatedOverTombstone === true) {
                recordSyncWarn(
                  `[sync] recreated aggregate over tombstone — ${idFragment(r.aggregateId)} (v${r.newVersion})`,
                );
              }
            }
            // Auto-repair every rejection before parking anything as a terminal
            // conflict. Groups by `aggregateId` (there is
            // at most one rejection per aggregate) and acts once per aggregate:
            // silent re-base / drop where there is exactly one safe resolution,
            // escalate to keep/discard where a real choice exists, and persist
            // the server's `currentVersion` / `currentUpdatedAt` on any parked
            // row. Also records the PII-safe diagnostics line.
            if (result.rejected.length > 0) {
              await repairRejections(result.rejected, householdId);
            }
          }
          const now = new Date().toISOString();
          setLastSyncedAt(now);
          const after = await refreshCounts();
          // Badge truthfulness: a successful push of a NEW
          // mutation must not flip the badge to 'synced' while unresolved
          // conflicts or an earlier parked `failed-error` batch still linger —
          // `after.pending` can be empty (the new edit applied) yet prior
          // un-sent work stays surfaced in the inspector. Same guard/ordering
          // as the empty-queue entry site.
          const unsynced = unsyncedBadgeGuard(after);
          if (unsynced) {
            setSyncState(unsynced);
            return false;
          }
          if (after.pending.length === 0) {
            setSyncState({ kind: 'synced', lastSyncedAt: now });
            return true;
          }
          // More pending arrived mid-flight — surface 'pending' and
          // loop to flush them in the same call.
          setSyncState({ kind: 'pending', count: after.pending.length });
        } catch (err) {
          // Freshness rollback: the client rejected the
          // response before any local write, so the queue is untouched.
          // Surface the dedicated badge.
          if (isRollbackDetectedRejection(err)) {
            setSyncState({ kind: 'rollback-detected' });
            return false;
          }
          // Permanent push rejection (`PERMANENT_PUSH_REJECTION_CODES`,
          // including FRESHNESS_HEAD_INVALID): the server rejected the WHOLE push (400/403, zero
          // mutations committed) for a reason only a buggy or untrusted
          // client ever triggers — none of these ever succeed on blind
          // retry. Park every mutation in the rejected batch as
          // `failed-error` (a terminal status `listPendingMutations()`/
          // `flushPending` already excludes), so the poll loop's
          // unconditional next-tick `flushPending()` never resends them; the
          // parked batch stays visible in the sync inspector via
          // `listFailedErrors()`. No `reason` argument — `PendingMutation.reason`
          // is a closed conflict-classification union with no slot for a
          // batch-level metadata failure. Distinct from the
          // `isRollbackDetectedRejection` branch above (client-side
          // MAC/rollback detection)
          // despite the shared word "freshness". Return `false` without
          // re-throwing.
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
          // DEVICE_MISMATCH: the JWT's device id no longer matches this
          // client's (the wiped-deviceId edge from clear-data).
          // Only fires while online (the push reached the server), so the
          // host's logout + clean re-login can re-bind the device id. Hand
          // off to the host before the generic error state. Mirrors the
          // CURSOR_EXPIRED branch in `pull`.
          if (err instanceof SyncApiError && err.code === 'DEVICE_MISMATCH') {
            await onDeviceMismatchRef.current?.();
            return false;
          }
          // Transient push failure: a genuine tick-ending error, NOT a
          // permanent-rejection park (handled above, which returns before
          // reaching here) — one of the three sites the consecutive-error
          // counter is allowed to advance at.
          errorCounterRef.current += 1;
          setSyncState({
            kind: 'error',
            ...buildErrorDetail(err, 'push', 'Sync failed'),
          });
          return false;
        }
      }
      // Hit the iteration cap with pending still in the queue. Surface
      // the pending state and let the next external trigger (poll,
      // notifyPending) pick up the rest.
      return false;
    };
    try {
      return await run();
    } finally {
      flushInFlightRef.current = false;
      const rerun = pendingRerunRef.current;
      pendingRerunRef.current = false;
      // Resolve + drop this run's tracked promise so a later
      // `restoreSnapshot` awaits only a genuinely in-flight flush.
      settle(true);
      flushPromiseRef.current = null;
      // Honor the coalescing contract: a trigger that landed AFTER this
      // run's final queue read could only set the flag, so its mutation
      // would otherwise wait for the next poll tick (up to POLL_IDLE_MS).
      // Re-fire exactly one follow-up flush; self-limiting because the
      // follow-up drains the queue and early-exits when it is empty.
      if (rerun) void flushPendingExclusiveRef.current();
    }
  }, [householdId, deviceId, lastSyncedAt, refreshCounts]);

  /** Mutex-guarded flush entry point. The TOP-LEVEL flush callers
   *  (notifyPending / retryNow / online-event flush) go through here so a
   *  flush can't interleave its `deviceMetadata` writes with a concurrent
   *  pull/bootstrap/restore.
   *
   *  Coalescing preserved: a `notifyPending` burst arriving while a flush
   *  is already in flight must NOT enqueue N sequential lock acquisitions
   *  (each running a full flush). We therefore check `flushInFlightRef`
   *  BEFORE touching the mutex: when a flush is already running we just set
   *  `pendingRerunRef` (the in-flight run re-fires once on completion) and
   *  return, exactly as the un-guarded `flushPending` early-exit did. Only a
   *  flush that will actually start work acquires the lock. */
  const flushPendingExclusive = useCallback(async (): Promise<boolean> => {
    if (flushInFlightRef.current || flushScheduledRef.current) {
      pendingRerunRef.current = true;
      return true;
    }
    flushScheduledRef.current = true;
    return runExclusive(() => {
      // Cleared the instant the flush begins; `flushPending` then sets
      // `flushInFlightRef` synchronously before its first await, so a burst
      // arriving in this window still coalesces (sees one flag or the other).
      flushScheduledRef.current = false;
      return flushPending();
    });
  }, [runExclusive, flushPending]);

  // Shared bootstrap-and-apply path for both `forceRefresh` (user clicks
  // the stale badge → wipe local + re-fetch) and `initialSync` on a
  // fresh device (no local data → fetch the server's snapshot without
  // wiping). `clearFirst` is the only difference.
  // Declared before `pull` because the CURSOR_EXPIRED catch in `pull`
  // delegates here for auto-recovery; React's `useCallback` deps array
  // is evaluated eagerly so the referenced binding has to exist already.
  const applyBootstrap = useCallback(
    async (clearFirst: boolean): Promise<{ ok: boolean; wiped: boolean }> => {
      if (!householdId) return { ok: false, wiped: false };
      setSyncState({ kind: 'syncing-pull' });
      // Flips to `true` the instant `clearAllStores()` resolves. That
      // call is a single IDB transaction (awaits `tx.done`), so a throw
      // *inside* it aborts the tx and leaves data intact (`wiped:false`);
      // a throw in any subsequent step means the aggregates are already
      // gone (`wiped:true`). The pre-wipe cursor write sits before
      // `clearAllStores()` and therefore does not move this boundary.
      let wiped = false;
      try {
        const result = await transportRef.current.bootstrap({ force: clearFirst });
        // Pre-flight schema check before mutating IDB. If even one
        // snapshot or post-snapshot row is at a higher schemaVersion than
        // this bundle handles, halt without clearing — the existing local
        // data may be incompatible too, but it's at least the user's last
        // known-good state.
        assertNoSchemaAhead(bootstrapSchemaCarriers(result));
        // Quarantine: a `clearFirst`
        // bootstrap wipes local data and refills it from THIS response, and
        // the transport has already dropped every row it could not decrypt
        // (server holds no household key, so a stolen-session push of
        // shape-valid garbage is only caught at decrypt)
        // Refilling blindly would delete the last readable local copy
        // of each such aggregate; halting instead wedged the CURSOR_EXPIRED
        // auto-recovery forever on one poisoned row. So carry those rows'
        // local copies across the wipe (re-put below) and let the rest of the
        // refresh complete — that device loses only that row, as on pull.
        const preservedQuarantined = clearFirst
          ? await readQuarantinedLocalCopies(result.quarantined ?? [])
          : [];
        if (clearFirst) {
          // Persist syncCursor:'0' BEFORE wiping the stores. If a crash
          // lands between the wipe and the final metadata write, the
          // worst case is "cursor 0 but stores intact" → the next load
          // does a redundant-but-harmless snapshot merge. The inverse
          // order would risk "stores wiped but cursor stale", which
          // makes the post-reload `initialSync` take the incremental
          // `pull()` branch into an empty store instead of
          // re-bootstrapping. The success path's final
          // `updateDeviceMetadata` below overwrites this with the real
          // server cursor, so success behaviour is byte-unchanged.
          // Field-level functional update: set ONLY syncCursor inside
          // one atomic transaction — never spread a possibly-stale full row.
          await updateDeviceMetadata((current) => ({
            ...(current ?? defaultMeta(deviceId)),
            deviceId,
            syncCursor: '0',
          }));
          // Preserve the device key cache across the force-bootstrap wipe. A
          // force-bootstrap REFILLS the same household's workspace from the
          // server — it does not invalidate the household data key — but
          // `clearAllStores()` drops `keyCache` (a genuine wipe
          // must not leave a stale unlock key). The user-driven wipe callers
          // (snapshot restore, Reload-from-server) re-cache via `recacheHdk()`
          // afterward, but the AUTO-recovery callers — the CURSOR_EXPIRED
          // catch in `pull()` and the post-reload `initialSync` force-bootstrap
          // — have no in-memory HDK to re-cache from (on a fresh page boot the
          // key only exists once `initializeUnlockState` loads it from this
          // very cache). Without preserving it, a cursor-expiry recovery wipes
          // the cached key and the next reload shows the "couldn't unlock your
          // encrypted data" banner over a session whose password + recovery key
          // still work. Capture the row, let `clearAllStores()` honour the
          // wipe, then restore it (same household → key still valid; the unlock
          // path re-verifies it against the live envelope set before trusting).
          const preservedKeyCache = await readKeyCacheEntry();
          await clearAllStores();
          if (preservedKeyCache) {
            await writeKeyCacheEntry(preservedKeyCache);
          }
          wiped = true;
          // Force-refresh paths must also wipe the mutation queue,
          // otherwise stale `failed-conflict` rows survive the
          // aggregate wipe and `listFailedConflicts()` keeps the badge
          // pinned to "Refresh needed" even after the snapshot replay
          // restores a clean workspace.
          await clearMutationQueue();
        }
        // Batch the snapshot + post-snapshot per-row fine signals into one
        // per touched store on scope exit so a mounted page re-reads once per
        // affected type, not once per row. The coarse `notifyWorkspaceChanged()`
        // tail below is unchanged.
        await withBatchedStoreSignals(async (batch) => {
          // Quarantined aggregates' last-known-good copies go back FIRST, at
          // their old version, so a later decryptable copy in the post-snapshot
          // mutations below still applies over them.
          for (const { type, row } of preservedQuarantined) {
            await putAggregate(type, row, batch);
          }
          for (const a of result.workspaceSnapshot.aggregates) {
            if (!isKnownAggregateType(a.aggregateType)) {
              // Snapshots can carry retired types until the next compaction
              // even after MutationLog is purged — see store.ts
              // `isKnownAggregateType` for the rolling-deploy rationale.
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
        // Field-level functional update: set ONLY the fields this
        // bootstrap owns (deviceId/cursor/lastSyncedAt, +freshness when
        // echoed) inside one atomic transaction, so a concurrent flush's
        // freshness persist can't be reverted by a stale full-row spread.
        const head = result.freshnessHead;
        if (head) {
          pinnedFreshnessCounterRef.current = head.freshnessCounter;
        }
        const next = await updateDeviceMetadata((current) => ({
          ...(current ?? defaultMeta(deviceId)),
          // Force-align the persisted deviceId with the canonical (JWT)
          // value. Without this, an old IDB record could keep a stale
          // id and silently mismatch the JWT on push.
          deviceId,
          syncCursor: result.syncCursor,
          lastSyncedAt: result.timestamp,
          // Pin the server-echoed freshness head. No-op unless a head is present
          // (only once the HDK is unlocked).
          ...(head ? { freshnessCounter: head.freshnessCounter } : {}),
        }));
        setLastSyncedAt(next.lastSyncedAt);
        // If the network dropped while bootstrap was in flight, the
        // offline handler already set state to 'offline'; don't clobber
        // it with a stale 'synced'.
        if (onlineRef.current) {
          setSyncState({ kind: 'synced', lastSyncedAt: next.lastSyncedAt });
        }
        // The snapshot rows are now committed to IDB. Pages that read
        // aggregates on mount (Dashboard, Expenses, …) may have mounted and
        // read an empty store *before* this bootstrap finished — on a fresh
        // device that's the whole workspace. Signal them to re-read; without
        // this the dashboard sits on "0 accounts / $0" until a manual refresh
        // or navigation. Fire regardless of `onlineRef`: the data landed even
        // if the network dropped between the writes and here.
        notifyWorkspaceChanged();
        return { ok: true, wiped };
      } catch (err) {
        if (!onlineRef.current) return { ok: false, wiped };
        // Freshness rollback or an unauthenticated payload:
        // the HTTP client verifies/decrypts inside
        // `bootstrap()` and throws before this method's wipe / apply loop
        // runs, so `wiped` is still false (reject-before-write). Surface the
        // dedicated badge.
        if (isRollbackDetectedRejection(err)) {
          setSyncState({ kind: 'rollback-detected' });
          return { ok: false, wiped };
        }
        if (err instanceof SchemaAheadError) {
          // Calm "update needed" badge, not a red
          // sync error — `setSyncState`'s centralized diagnostics hook only
          // auto-records `error`/`stale` transitions, so record the
          // breadcrumb explicitly here.
          const detail = handleSchemaAhead(err);
          recordSyncWarn(`[sync] ${detail.code} — reload required to read latest changes`);
          setSyncState({ kind: 'update-available' });
          return { ok: false, wiped };
        }
        // Transient bootstrap failure — one of the three sites the
        // consecutive-error counter is allowed to advance at.
        errorCounterRef.current += 1;
        setSyncState({ kind: 'error', ...buildErrorDetail(err, 'bootstrap', 'Refresh failed') });
        return { ok: false, wiped };
      }
    },
    [householdId, deviceId],
  );

  /** Pull remote changes since the last cursor. Returns `true` on
   *  success (or no-op when offline/no household — caller treats those
   *  as transport failures separately if needed). Returns `false` on
   *  any transport, schema, or apply-time error; side-effects the
   *  badge state in all cases. */
  const pull = useCallback(async (): Promise<boolean> => {
    if (!householdId || !onlineRef.current) return false;
    // Restore fence: while a restore is sweeping + re-bootstrapping,
    // a poll pull must not run — it would do a read-modify-write on
    // DeviceMetadata that could overwrite the just-restored
    // syncCursor:'0' / cleared freshness pin with stale metadata.
    // Mirrors the fence in flushPending.
    // Destructive-op fence: same for the demo-overwrite wipe→load window.
    // Clear-cleanup fence: a committed clear with an unfinished local
    // cleanup keeps the whole poll suspended until it is resolved.
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
      // Follow `hasMore`: drain every backlogged page in one pull so
      // the client never sits on partially-applied cross-aggregate state
      // between poll ticks. Bounded so a pathological hasMore loop can't
      // spin forever — on hitting the bound we return `true` and the next
      // poll resumes from the persisted cursor.
      const MAX_PULL_PAGES = 50;
      // Batch every drained page's per-row fine signals into one per touched
      // store on scope exit so a mounted page re-reads once per affected type
      // across the whole multi-page drain, not once per pulled row. The coarse
      // `notifyWorkspaceChanged()` tail below (gated on `anyChanges`) is
      // unchanged. A schema-ahead throw inside still flushes the
      // already-applied stores, then re-throws to the catch below.
      await withBatchedStoreSignals(async (batch) => {
        for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
          const result = await transportRef.current.pull({ since: meta.syncCursor });
          // Pre-flight schema check: if any row is at a higher schemaVersion
          // than this bundle's registry, halt the entire batch so we never
          // half-apply a payload we can't render. The version banner takes
          // over from here; reload swaps in a bundle that knows the migration.
          assertNoSchemaAhead(result.changes);
          for (const c of result.changes) {
            await applyPulledChange(c, householdId, batch);
          }
          // Field-level functional update: set ONLY cursor/lastSyncedAt
          // (+freshness when echoed) inside one atomic transaction, so a
          // concurrent flush's freshness persist isn't reverted by a stale
          // full-row spread. The merged row drives the next page's `since`.
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
            // Pin the server-echoed freshness head. No-op unless a head is present
            // (only once the HDK is unlocked).
            ...(head ? { freshnessCounter: head.freshnessCounter } : {}),
          }));
          meta = next;
          if (result.changes.length > 0) anyChanges = true;
          if (!result.hasMore) break;
        }
      });
      setLastSyncedAt(meta.lastSyncedAt);
      // Mirror applyBootstrap: don't overwrite 'offline' with a stale
      // success if the network dropped mid-pull.
      if (onlineRef.current) {
        // Badge truthfulness: a successful pull must not flip
        // the badge back to 'synced' while unresolved conflicts or a parked
        // `failed-error` batch still sit in the queue — that would silently drop
        // the user's prompt to resolve them. Consult the shared guard (same
        // ordering as the push sites) and stay off 'synced' when it fires.
        const { conflicts, failedErrors } = await refreshCounts();
        const unsynced = unsyncedBadgeGuard({ conflicts, failedErrors });
        if (unsynced) {
          setSyncState(unsynced);
        } else {
          setSyncState({ kind: 'synced', lastSyncedAt: meta.lastSyncedAt });
        }
      }
      // Mirror applyBootstrap: nudge mounted readers to re-read after we
      // commit pulled rows. Gated on a non-empty batch (across all pages)
      // because `pull` runs on a poll cadence — an empty pull changed
      // nothing, so firing would just churn every listening page's IDB
      // re-read for no benefit.
      if (anyChanges) {
        notifyWorkspaceChanged();
      }
      // A normal pull completed WITHOUT CURSOR_EXPIRED — any ambiguously-failed
      // `clearWorkspace` did NOT land server-side (a committed clear would have
      // bumped the watermark and expired this cursor), so the pending queue is
      // legitimately still needed. Lift the ambiguity marker and resume the
      // normal flush-first cursor-expiry recovery for future expiries.
      clearOutcomeAmbiguousRef.current = false;
      return true;
    } catch (err) {
      if (!onlineRef.current) return false;
      // Freshness rollback or an unauthenticated payload:
      // the HTTP client threw inside `pull()` before
      // this method's apply loop, so no local write happened.
      if (isRollbackDetectedRejection(err)) {
        setSyncState({ kind: 'rollback-detected' });
        return false;
      }
      // CURSOR_EXPIRED: client cursor predates the compactor watermark
      // (`mutationLogCursorBase`). Incremental pull would silently miss
      // data, so the server tells us to re-bootstrap instead.
      if (err instanceof SyncApiError && err.code === 'CURSOR_EXPIRED') {
        // Normally flush pending mutations BEFORE the bootstrap wipes the queue.
        // On the reload path cursor expiry is frequently caused by this
        // device's OWN compacted pushes, so the queue can hold valid offline
        // edits — pushing them first avoids silently discarding them.
        //
        // EXCEPTION: if a just-attempted `clearWorkspace` failed
        // ambiguously (abort/timeout/network — outcome unknown), this
        // CURSOR_EXPIRED may be the fingerprint of that clear having actually
        // COMMITTED server-side (its watermark bump expired our cursor).
        // Flushing the stale pre-delete queue first would re-push the
        // just-deleted `create`s onto the swept server, resurrecting the data.
        // Skip the pre-bootstrap flush in that case and re-bootstrap straight
        // from the server's true state: if the clear landed, the old queue is
        // correctly discarded with the empty reseed; if it did NOT land, the
        // device just re-bootstraps its still-populated state (a safe no-op).
        if (!clearOutcomeAmbiguousRef.current) {
          // Best-effort: tolerate conflicts/errors and proceed to the mandatory
          // bootstrap regardless (a flush already in flight early-returns true,
          // which is acceptable here).
          try {
            await flushPending();
          } catch {
            // Bootstrap is mandatory; never let a flush failure skip it.
          }
        }
        // applyBootstrap swallows its failure into `{ ok:false }` rather
        // than throwing, so the reseed outcome must propagate explicitly —
        // a failed mandatory CURSOR_EXPIRED reseed is a pull failure (the
        // store may be wiped or stale), not a success.
        const refreshed = await applyBootstrap(true);
        // Only a SUCCESSFUL reseed resolves an ambiguous-clear outcome — it
        // wiped the queue + stores and re-established the server's true state.
        // A failed bootstrap leaves the marker set so the next CURSOR_EXPIRED
        // retry still skips the resurrecting flush.
        if (refreshed.ok) clearOutcomeAmbiguousRef.current = false;
        return refreshed.ok;
      }
      if (err instanceof SchemaAheadError) {
        // Calm "update needed" badge, not a red
        // sync error — record the breadcrumb explicitly (see the mirror
        // site in `applyBootstrap` above).
        const detail = handleSchemaAhead(err);
        recordSyncWarn(`[sync] ${detail.code} — reload required to read latest changes`);
        setSyncState({ kind: 'update-available' });
        return false;
      }
      // Transient pull failure — one of the three sites the
      // consecutive-error counter is allowed to advance at.
      errorCounterRef.current += 1;
      setSyncState({ kind: 'error', ...buildErrorDetail(err, 'pull', 'Pull failed') });
      return false;
    }
  }, [householdId, deviceId, applyBootstrap, flushPending, refreshCounts]);

  const forceRefresh = useCallback(
    // Mutex-guarded: a user-driven force bootstrap must not interleave
    // its wipe + metadata writes with a concurrent poll pull/flush.
    async (): Promise<{ ok: boolean; wiped: boolean }> => {
      // A user-initiated full refresh resets the consecutive-error
      // counter regardless of outcome — the act of asking IS the reset
      // event, not a claim that the refresh will succeed.
      errorCounterRef.current = 0;
      // A failed force-refresh raises its OWN error
      // outside the poll tick's timer callback — re-arm the scheduler to the
      // correct backoff right now rather than leaving the poll's
      // previously-armed timer (which may be minutes away) as the only
      // thing standing between here and the next retry. Gated on the
      // refresh itself having raised.
      return rearmIfRaised(() => runExclusive(() => applyBootstrap(true)));
    },
    [runExclusive, applyBootstrap, rearmIfRaised],
  );

  /** Push pending mutations (best effort), then pull remote changes.
   *  Used as a precondition for destructive workspace operations
   *  (demo reload, bundle import) so the local IDB reflects
   *  authoritative server state before the operation tombstones or
   *  rewrites aggregates. Without this round-trip, server-side
   *  aggregates the local copy has not pulled yet slip through the
   *  wipe loop's local-only scan and reappear on the next pull,
   *  alongside the freshly-seeded set.
   *
   *  **Push failure is tolerated.** The destructive callers (`applyImport`,
   *  `wipeWorkspaceForDemoReload`) call `clearMutationQueue()` and
   *  tombstone everything anyway, so any `failed-conflict` mutations
   *  left over from previous attempts would be discarded by the wipe.
   *  Blocking the user on "Refresh needed" before they can demo-reload
   *  would strand them in an unrecoverable state. Pull, by contrast,
   *  is mandatory — without an up-to-date local copy the wipe
   *  enumeration is incomplete.
   *
   *  Returns `{ ok: false, reason }` on offline or pull failure;
   *  push failures are silent (state side effects still fire so the
   *  user can see what happened on the badge after the operation). */
  const syncRoundTrip = useCallback(async (): Promise<
    { ok: true } | { ok: false; reason: string }
  > => {
    if (!householdId) return { ok: false, reason: 'Not signed in.' };
    if (!onlineRef.current) {
      setSyncState({ kind: 'offline' });
      return { ok: false, reason: 'You appear to be offline. Reconnect and try again.' };
    }
    // Restore fence: a round-trip raised during an in-flight restore
    // must NOT enqueue behind the restore on the mutex and then run its
    // pull/flush after the restore releases the lock — that would re-push
    // stale state / write a stale cursor on top of the just-restored
    // snapshot. Bail before touching the mutex, mirroring the inner pull /
    // flush fences.
    // Destructive-op fence: a demo-overwrite holds the mutex for its
    // wipe→load window; a round-trip raised meanwhile must bail before
    // touching the mutex, mirroring the restore fence above.
    // Clear-cleanup fence: a committed clear with an unfinished local
    // cleanup keeps the round-trip suspended too.
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
    // Mutex-guarded: flush + pull run as one exclusive critical section
    // so neither interleaves its `deviceMetadata` writes with a concurrent
    // poll/bootstrap/restore. Inner `flushPending`/`pull` stay un-guarded.
    // This is also the popover's "Sync now" — the one control offered from
    // the synced/pending states — so a transient failure here must re-arm
    // the scheduler and publish a countdown deadline like every other
    // non-tick raise path, not leave the badge on a static "Sync failed"
    // behind the pre-failure cadence.
    return rearmIfRaised(() =>
      runExclusive(async () => {
        // Best-effort push. Conflicts / errors update the badge but don't
        // block the round-trip — the caller is about to wipe the queue.
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

  /** Restore the workspace to a previous snapshot. See the
   *  `SyncContextValue.restoreSnapshot` doc comment for the contract.
   *
   *  Order matters on two axes:
   *
   *  1. The server `restore()` runs FIRST. If it throws (404 / network /
   *     server error) nothing was restored, so the zero-knowledge freshness
   *     pins MUST retain their prior values — clearing them on a failed
   *     restore would weaken rollback detection even though the workspace
   *     never changed. Both clears therefore happen only AFTER `restore()`
   *     resolves successfully.
   *
   *  2. The persisted `freshnessCounter` clear (and the in-memory reset)
   *     still happen BEFORE `applyBootstrap(true)` (cursor-reset invariant preserved).
   *     `applyBootstrap(true)` spreads the prior DeviceMetadata when it
   *     writes back (and only sets `freshnessCounter` when the restored
   *     snapshot carries a non-null `freshnessHead`, which a fresh
   *     post-restore WorkspaceMeta does not) — so a stale-high persisted
   *     counter would otherwise survive the bootstrap and re-hydrate the
   *     in-memory pin on the next page reload (initialSync re-hydration),
   *     tripping a false rollback-detected on the next push. Clearing the
   *     persisted value before the bootstrap + resetting the in-memory ref
   *     closes both the in-session and across-reload paths.
   *
   *  3. Partial-failure safety. `applyBootstrap` only wipes
   *     the local aggregate stores + mutation queue and resets the cursor
   *     AFTER its network bootstrap fetch SUCCEEDS. So if `restore()`
   *     succeeded (the server already rolled back) but the bootstrap fetch
   *     then fails, this device would otherwise keep its OLD aggregates,
   *     OLD `syncCursor`, and PENDING mutation queue — and the next poll's
   *     incremental pull / flushPending could re-push that stale state and
   *     silently undo the restore the user just performed. Worse, since a
   *     restored snapshot's watermark is null/'0', PullService emits no
   *     CURSOR_EXPIRED for since='0', so the device can sit on stale
   *     aggregates behind a 'synced' badge. To close that window we
   *     proactively enter a "must re-bootstrap, nothing to push, nothing
   *     locally stored" state the instant the server restore resolves:
   *     persist `syncCursor:'0'` (so the next initialSync/poll
   *     force-bootstraps instead of incremental-pulling from stale state),
   *     clear the local mutation queue, AND eagerly `clearAllStores()` so
   *     the stale aggregates are gone BEFORE the fallible bootstrap fetch
   *     runs. Discarding the queue is the intended semantics — the confirm
   *     dialog already warns "any pending edits on this device will be
   *     permanently lost" — not data loss. Because we have already wiped
   *     locally, we force the returned result to report `wiped:true` even
   *     if `applyBootstrap`'s own fetch fails before its internal wipe:
   *     that engages the modal's "Reload the page to continue" branch, and
   *     a reload deterministically re-bootstraps (cursor '0' →
   *     initialSync force-bootstraps the restored snapshot into the now-
   *     empty store). The eager `clearAllStores()` is idempotent with
   *     `applyBootstrap`'s own clearFirst wipe on the success path (the
   *     snapshot loads either way — no behaviour change on success). All
   *     of this sits AFTER the successful `restore()` (preserving the
   *     invariant: a FAILED restore() leaves pins + cursor + queue +
   *     stores untouched). */
  const restoreSnapshot = useCallback(
    async (snapshotId: string): Promise<{ ok: boolean; wiped: boolean }> => {
      if (!householdId) return { ok: false, wiped: false };
      // 0. Fence the flush loop. Set the restore-in-progress flag
      //    BEFORE acquiring the mutex so `flushPending` early-returns (no new
      //    push starts) even while the restore waits its turn on the lock.
      //    Reset the flag in `finally` so a failed restore re-enables normal
      //    syncing.
      restoreInProgressRef.current = true;
      try {
        // Mutex-guarded: the restore's metadata writes + wipe + bootstrap
        // run as one exclusive critical section, never interleaved with a
        // poll pull/flush. `applyBootstrap` is called UN-guarded here (we
        // already hold the lock) to avoid a self-deadlock.
        return await runExclusive(async () => {
          // Await any flush ALREADY in flight so no push is mid-send when the
          // server sweep runs. An in-flight push that committed
          // server-side AFTER the sweep would recreate the very data the
          // confirm dialog said was permanently lost; clearing the local
          // queue can't recall a request already on the wire. (Under the
          // mutex this resolves immediately — a holding flush released the
          // lock before this body ran — but the await is kept as belt-and-
          // braces.)
          await flushPromiseRef.current;
          // 1. Server wipes + reinitialises its sync state at the snapshot.
          //    Do this BEFORE touching any local state: if it throws, the
          //    persisted + in-memory pins, the cursor, and the mutation queue
          //    all keep their prior values (nothing was restored, so rollback
          //    detection must stay armed and no local state may be discarded).
          await transportRef.current.restore(snapshotId);
          // 2. Restore succeeded. Force this device into a "must re-bootstrap,
          //    nothing to push" state BEFORE the bootstrap fetch, so a bootstrap
          //    that then fails can't leave the device able to re-push stale
          //    state on the next poll. Resetting syncCursor to '0' routes
          //    the next initialSync/poll through the force-bootstrap branch
          //    instead of an incremental pull from stale aggregates; clearing
          //    the queue drops pending mutations (the confirm dialog already
          //    warns they are permanently lost). The same write clears the
          //    PERSISTED ZK freshness pin so a reload can't re-hydrate a
          //    stale-high counter; the in-memory pin reset follows. All of this
          //    stays BEFORE applyBootstrap (cursor-reset invariant preserved).
          // Field-level functional update: set ONLY syncCursor and clear
          // the persisted freshness pin inside one atomic transaction.
          await updateDeviceMetadata((current) => ({
            ...(current ?? defaultMeta(deviceId)),
            deviceId,
            syncCursor: '0',
            freshnessCounter: undefined,
          }));
          await clearMutationQueue();
          pinnedFreshnessCounterRef.current = 0;
          // Eagerly wipe the local aggregate stores BEFORE the fallible
          // bootstrap fetch. applyBootstrap only wipes after its fetch
          // succeeds, so a post-restore fetch failure would otherwise leave
          // stale aggregates that a since='0' pull can't expire (no
          // CURSOR_EXPIRED) — the device would show old data behind a 'synced'
          // badge. Clearing here is idempotent with applyBootstrap's own
          // clearFirst wipe on the success path.
          await clearAllStores();
          // 3. Bootstrap from the restored snapshot (WorkspaceMeta now points
          //    at it). Reuses the standard force path. Because we already wiped
          //    locally, report `wiped:true` even if applyBootstrap's fetch
          //    fails before its internal wipe — the modal's wiped branch then
          //    tells the user to reload, and the cursor:'0' makes that reload
          //    re-bootstrap deterministically into the now-empty store.
          const result = await applyBootstrap(true);
          return result.ok ? result : { ok: false, wiped: true };
        });
      } finally {
        // Re-enable normal syncing. On success the device is already in the
        // post-restore state (cursor '0', empty queue, restored snapshot);
        // on failure the fence must lift so the next poll can retry.
        restoreInProgressRef.current = false;
      }
    },
    [householdId, deviceId, runExclusive, applyBootstrap],
  );

  // Resolve one parked conflict keep/discard. The
  // effectful primitive the per-row Resolve control in `<UnsyncedMutationList>`
  // calls (injected as a prop from the badge popover + Diagnostics card).
  const resolveConflict = useCallback(
    async (mutation: PendingMutation, choice: 'keep' | 'discard'): Promise<void> => {
      if (!householdId) return;
      // Mutex-guarded: the re-queue/pull + metadata writes must not
      // interleave with a poll pull/flush. Inner flushPending/pull run
      // un-guarded (we hold the lock).
      await runExclusive(async () => {
        const serverVersion = mutation.currentVersion;
        if (choice === 'keep') {
          // Keep re-queues the aggregate's NEWEST local intent (`latestEdit` of
          // the queue stack), NOT the clicked conflict's possibly-stale payload.
          // The collapse removes EVERY row for the aggregate (`removeMutationIds`
          // below), so if the user made a later local edit while this conflict sat
          // parked, a newer `pending` sibling exists in the stack; re-queuing the
          // clicked payload would silently delete that newer edit. Picking
          // `latestEdit(stack)` carries its payload/operation/schemaVersion
          // forward — mirroring the auto-repair escalate/rebase collapse, which
          // also parks the latest edit as the representative — so a parked-window
          // edit is never dropped (feature invariant: never silently lose an
          // un-synced edit). With no newer sibling, `latest` === the clicked
          // conflict and behavior is byte-identical.
          //
          // Op conversion for a keep that can't land as-is,
          // keyed on the NEWEST intent's op but the CLICKED conflict's server-
          // state rejection facts:
          //  - create over a LIVE row → `update @ currentVersion` (a
          //    `create @ >0` can never satisfy the server's
          //    attribute_not_exists + version===0 condition), and
          //  - `NOT_FOUND` on an update → `create @ 0` (the server row is gone).
          // Every other kept conflict re-bases the newest op onto the server's
          // true counter (incl. a trailing `delete`) — which is what heals the
          // wedge (push forward at the counter the rejection already reported).
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
            // Concurrency abort: a `queueLocalMutation` for this aggregate
            // landed during the manual keep (queueLocalMutation is un-fenced by
            // the sync mutex). The transactional collapse aborted rather than
            // stomping it. Leave the conflict parked and let the fresh edit push
            // on the next flush — never a silent overwrite. Any other error
            // propagates.
            if (!(err instanceof ConcurrentQueueMutationError)) throw err;
            await refreshCounts();
            return;
          }
          await flushPending();
        } else if (mutation.operation === 'update' && mutation.reason === 'NOT_FOUND') {
          // Discard of a NOT_FOUND-on-update: accept the server's deletion —
          // drop the mutation AND delete the local row.
          await removeMutation(mutation.id);
          await deleteAggregateLocally(mutation.aggregateType, mutation.aggregateId);
        } else {
          // Discard: adopt the server copy via a pull (`applyPulledChange`
          // overwrites the local aggregate with the server version). Verify
          // convergence: a genuine remote advance reaches `currentVersion` AND
          // its content is actually overwritten by the pull; a wedge (empty log,
          // nothing to pull) does not — leave the failed-conflict parked
          // (re-escalate) rather than silently dropping the un-synced content.
          // Adopting a remote DELETION is a convergence case too: when the
          // server row was tombstoned on another device the rejection is a
          // `CONFLICT` carrying `currentDeletedAt` (NOT `NOT_FOUND`, so the
          // dedicated update+NOT_FOUND branch above does not fire), and the pull
          // delivers a `delete` change that leaves the local row a tombstone. Read
          // it with `getAggregateIncludingDeleted` (NOT `getAggregate`, which
          // filters tombstones and would read the adopted deletion as absent →
          // never converging, parking the conflict forever behind a false "try
          // again"). A bare `version >= currentVersion` check is NOT enough: the
          // app's own optimistic version inflation can push the LOCAL
          // version to `>= currentVersion` off the original poisoned edit alone,
          // so a wedge would falsely read as converged while the aggregate still
          // holds the user's stale draft. Require the pull to have written the
          // server's true row — its `updatedAt` must match the server-reported
          // `currentUpdatedAt` persisted on the rejection (item 1), which the pull
          // sets only when it actually delivered `currentVersion`'s content. That
          // `updatedAt` match is what still distinguishes an adopted server row
          // (live OR tombstone) from an un-pulled optimistic-inflation wedge: a
          // wedge leaves the local row a LIVE draft whose `updatedAt` is the local
          // edit time ≠ `currentUpdatedAt`, so it still reads not-converged.
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

  // Check & repair: re-drive the auto-repair pass over
  // every parked conflict. Each `failed-conflict` is re-queued as a fresh-id
  // `pending` row — a fresh id is mandatory (the original would replay the
  // server's 7-day cached CONFLICT) and only `pending` rows are
  // pushed by `flushPending` — then a single flush re-attempts them so the reject
  // loop re-classifies each: silently resolving a since-fixed conflict and
  // rehydrating a legacy row's server facts (`currentVersion` / `currentUpdatedAt`
  // / tombstone flag) so its keep/discard unlocks. Mutex-guarded so the re-queue
  // + flush can't interleave with a poll pull/flush (mirrors `resolveConflict`).
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

  // Run a destructive workspace overwrite (demo reload over existing data)
  // atomically w.r.t. the background poll. Mirrors the restore idiom:
  // set the fence BEFORE acquiring the mutex (so a poll tick that races the
  // start early-returns even while we wait on the lock), run the destructive
  // window INSIDE the mutex (so a tick already holding it drains before we
  // mutate — closing the TOCTOU on `clearMutationQueue`), and clear the fence
  // in a `finally`. The success path ends in `window.location.reload()` which
  // discards this per-mount ref; the throw-without-reload branch relies on the
  // `finally` to re-enable the poll. The fence is presentation/ordering
  // only — it never survives into a new session and queued mutations stay
  // householdId-stamped, so the server still enforces ownership.
  const runDestructive = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      destructiveOpInProgressRef.current = true;
      try {
        return await runExclusive(fn);
      } finally {
        // Release the fence once `fn` has settled (success OR throw). The
        // success path reloads the page, discarding this per-mount ref; the
        // throw-without-reload branch needs this clear so the surviving poll
        // resumes.
        destructiveOpInProgressRef.current = false;
      }
    },
    [runExclusive],
  );

  // Server-authoritative "Delete workspace data" clear.
  // Mirrors restoreSnapshot's fence + await-flush ordering, but with a DIFFERENT
  // contract (no `wiped` semantics): the endpoint sweeps the household to empty
  // server-side, and on a 2xx this only clears the sync-metadata residue that
  // lives inside this provider (the ZK freshness pin + cursor). The aggregate-
  // store wipe + reload stay in the WorkspaceToolsCard handler, strictly gated
  // on the 2xx (item 3). A non-2xx throws out of `transportRef.current
  // .clearWorkspace` before any local state changes, so the caller's fail-safe
  // preserves the mutation queue and skips the wipe.
  const clearWorkspace = useCallback(
    async (args: {
      currentPassword: string;
      eraseHistory: boolean;
      purgeHistoryOnly?: boolean;
    }): Promise<{ ok: boolean; historyErased: boolean }> => {
      // runDestructive fences the poll (no tick pushes mid-clear) and runs the
      // body inside the sync mutex; awaiting the in-flight flush FIRST stops a
      // push that committed just after the server sweep from recreating
      // just-deleted data (same rationale restoreSnapshot documents).
      return runDestructive(async () => {
        await flushPromiseRef.current;
        let result: { ok: boolean; historyErased: boolean };
        try {
          result = await transportRef.current.clearWorkspace(args);
        } catch (err) {
          // Distinguish a DEFINITE server rejection from an AMBIGUOUS transport
          // failure. A `SyncApiError` is a real parsed non-2xx (wrong
          // password / throttle / 5xx) — the server did NOT sweep, so the card's
          // pre-commit fail-safe correctly preserves the queue and skips the
          // wipe. ANY OTHER throw (a browser `AbortError` from the per-call
          // timeout, or a network `TypeError`) means NO response was received:
          // the client cannot tell whether the FULL sweep committed before the
          // connection dropped. If it DID commit, the next poll hits
          // CURSOR_EXPIRED, whose handler would flush the still-present
          // pre-delete queue and re-push the just-deleted `create`s onto the
          // swept server. Set the ambiguity marker so that handler skips its
          // pre-bootstrap flush instead (see `clearOutcomeAmbiguousRef`). Only
          // the FULL clear can cause this — a `purgeHistoryOnly` retry never
          // sweeps / bumps the watermark, so it can't strand a resurrectable
          // queue and must not perturb that handler. Rethrow either way so the card's
          // pre-commit fail-safe still surfaces the honest "try again" copy.
          if (!args.purgeHistoryOnly && !(err instanceof SyncApiError)) {
            clearOutcomeAmbiguousRef.current = true;
          }
          throw err;
        }
        // Reached only on a 2xx (a non-2xx threw above). For a FULL clear the
        // sweep committed server-side, so clear the ZK freshness pin (persisted
        // + in-memory) — leaving it stale would trip a false "Rollback
        // detected" halt for an encrypted household on the post-reload
        // bootstrap — reset the cursor to '0' so the reload
        // force-bootstraps the empty snapshot, AND drop the local mutation
        // queue INSIDE this fenced critical section. The queue clear
        // must happen here, not in the card: the card runs after the fence has
        // released, so a background poll tick could enter `flushPending()` in
        // that window, read the still-present queue, and re-push stale local
        // `create` mutations onto the freshly-swept (empty) server —
        // resurrecting the data the user just deleted. Clearing it under the
        // mutex (exactly as `restoreSnapshot` does) makes the clear atomic
        // w.r.t. the poll; the aggregate-store wipe + reload stay in the card.
        //
        // A `purgeHistoryOnly` RETRY must SKIP this: it only purges S3 backup
        // history (no sweep / mint / repoint, and the server never re-bumps the
        // watermark). It runs against a LIVE, resumed workspace, so resetting
        // the cursor to '0' + clearing the pin + dropping the queue would force
        // the next initialSync/reload to bootstrap and could discard edits the
        // user entered after the earlier reload — the exact data loss the
        // purge-only path exists to avoid.
        //
        // The cleanup runs AFTER the server's 2xx, so a throw here is NOT a
        // "delete failed" — the workspace WAS erased server-side. A bare
        // throw would (a) reach the card's PRE-COMMIT fail-safe, showing a false
        // "couldn't delete workspace data", and (b) release `runDestructive`'s
        // fence with the stale `create`s STILL queued, letting the next poll
        // re-push them onto the swept server. So retry the (idempotent) cleanup
        // unit a bounded number of times to self-heal a transient IDB blip; only
        // if EVERY attempt fails do we keep the poll suspended
        // (`clearCleanupFailedRef`, which survives the fence release) and throw a
        // TYPED `WorkspaceClearCleanupError` the card routes to its honest
        // recovery path — never the pre-commit copy, and never a silent reload.
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
            // Every attempt failed. The queue may still hold stale `create`s, so
            // keep the poll suspended past this fence's release and surface the
            // committed-but-uncleaned outcome as a typed error.
            clearCleanupFailedRef.current = true;
            recordSyncError(
              '[sync] clearWorkspace: server clear committed (2xx) but local cleanup could not be completed; poll suspended until a retry resolves it',
              lastCleanupErr,
            );
            throw new WorkspaceClearCleanupError(result);
          }
          // Cleanup succeeded (possibly after a transient blip / a prior failed
          // clear). Lift any suspension a previous terminal failure engaged.
          clearCleanupFailedRef.current = false;
        }
        return result;
      });
    },
    [runDestructive, deviceId],
  );

  // First sync after mount/login. Bootstraps when this device has never
  // pulled (cursor = '0'), otherwise does an incremental pull. Without
  // this the badge would lie ('synced' default) for the first 5 min
  // until the polling timer fires.
  const initialSync = useCallback(async (): Promise<void> => {
    if (!householdId) return;
    if (!onlineRef.current) {
      setSyncState({ kind: 'offline' });
      return;
    }
    // Mutex-guarded: the first sync (bootstrap or pull) must not
    // interleave its metadata writes with a poll tick that arms at mount.
    // Inner applyBootstrap/pull stay un-guarded (called while holding it).
    // A mount-time bootstrap/pull failure raises its
    // error before any poll tick has ever run, so the mount-armed
    // POLL_IDLE_MS timer is the only thing scheduled — re-arm it to the
    // correct backoff immediately instead of leaving a fresh error
    // sitting behind a stale 5-minute wait. Gated on the sync itself having
    // raised.
    await rearmIfRaised(() =>
      runExclusive(async () => {
        const meta = await readDeviceMetadata();
        // Hydrate the freshness pin from persisted metadata so a reload keeps
        // enforcing the last server-acknowledged counter.
        // Unconditional (`?? 0`): the household-switch effect already reset the
        // pin to 0, and a new household whose metadata carries no counter must
        // hydrate to 0 — never inherit the prior household's stale-high pin.
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
    // The badge's "Retry now" is a deliberate click — a signal to try
    // again now, not a claim the server recovered — so it resets the
    // consecutive-error counter regardless of outcome, exactly like
    // `forceRefresh` above.
    errorCounterRef.current = 0;
    // Re-arm immediately if the retry itself failed
    // — see `forceRefresh` above for why this can't wait for the poll timer.
    await rearmIfRaised(flushPendingExclusive);
  }, [flushPendingExclusive, rearmIfRaised]);

  const notifyPending = useCallback(() => {
    // A user edit's own push can fail right after
    // `flushPendingExclusive` settles — re-arm the scheduler to the correct
    // backoff the instant that happens rather than leaving it behind
    // whatever cadence the poll timer already had armed. Only when the push
    // actually RAISED: this is the save hook every editing page calls, and
    // a clean push (or a park, which never feeds the counter) must leave
    // the armed poll untouched.
    void rearmIfRaised(flushPendingExclusive);
  }, [flushPendingExclusive, rearmIfRaised]);

  // Keep the latest pull/flushPending in refs (updated per render) so the
  // mount-once polling effect always calls the current closures without
  // listing them as deps — listing them would re-arm the timer on every
  // re-creation and reset the cadence to POLL_IDLE_MS.
  const pullRef = useRef(pull);
  const flushPendingRef = useRef(flushPending);
  // The poll tick acquires the mutex ONCE around its pull+flush pair;
  // a ref lets the mount-once effect call the current `runExclusive` without
  // a dep (runExclusive is stable, but keep the ref pattern consistent).
  const runExclusiveRef = useRef(runExclusive);
  useEffect(() => {
    pullRef.current = pull;
    flushPendingRef.current = flushPending;
    runExclusiveRef.current = runExclusive;
    flushPendingExclusiveRef.current = flushPendingExclusive;
  });

  // Mirror the canonical deviceId into module scope so non-React
  // helpers (mutation-queue) stamp queued mutations with the same id
  // the JWT carries.
  useEffect(() => {
    setRegisteredDeviceId(deviceId);
  }, [deviceId]);

  // Initial sync on mount or login. Once per household; reset on logout
  // so a subsequent login re-fires. Polling keeps it fresh after this
  // point.
  useEffect(() => {
    if (!householdId) {
      initialSyncedHouseholdRef.current = null;
      // SyncProvider never remounts across logout→login / user switch
      // (AuthAwareProviders passes a changing householdId prop, no key),
      // so refs leak between households. Reset the freshness pin on clear
      // so a stale-high counter can't carry into the next household and
      // trip a false rollback-detected. Same for the
      // retry policy: the signed-out state owes nobody the prior
      // household's attempt count or deadline.
      pinnedFreshnessCounterRef.current = 0;
      resetRetryPolicy();
      return;
    }
    if (initialSyncedHouseholdRef.current === householdId) return;
    initialSyncedHouseholdRef.current = householdId;
    // Reset the freshness pin BEFORE initialSync hydrates it from the new
    // household's metadata (which hydrates `?? 0`), so a switch from a
    // pinned household to one without a counter clears the pin.
    pinnedFreshnessCounterRef.current = 0;
    // Likewise start this household's retry policy from zero and re-arm
    // the poll at the mount cadence BEFORE initialSync can raise its own
    // first error — a counter, Retry-After, deadline or armed backoff
    // inherited from the prior household is not this one's. On the very first mount the poll effect below has not
    // assigned `restartPollRef` yet, so this only resets the refs and the
    // effect's own mount-time arm is the one that counts.
    resetRetryPolicy();
    void initialSync();
  }, [householdId, initialSync, resetRetryPolicy]);

  // Online/offline event listener.
  useEffect(() => {
    const onOnline = () => {
      onlineRef.current = true;
      // An online-triggered flush that fails must
      // re-arm the scheduler immediately, same as the other non-tick entry
      // points above — and, like them, only when it actually raised.
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

  // Backoff polling — pull on interval; push when there are pending.
  // Mount-once (empty deps) with a self-rescheduling timer. The next
  // delay is computed from refs at each tick completion (stateKindRef,
  // pendingCountRef, errorCounterRef) — NOT from reactive state in the
  // deps — so a synced→error or count change does not re-arm the timer at
  // POLL_IDLE_MS and defeat the error-retry / active cadence. The
  // pull/flushPending refs hold the latest closures (updated per render).
  // Tab returning to `visibility: visible` outside the rewake debounce
  // cancels the long idle wait and pulls immediately so a backgrounded
  // tab catches a fresh deploy on refocus; it reuses the same `schedule`.
  useEffect(() => {
    function schedule(delay: number) {
      if (pollTimerRef.current !== null) clearTimeout(pollTimerRef.current);
      pollTimerRef.current = window.setTimeout(async () => {
        // Acquire the sync mutex ONCE around the pull+flush pair so the
        // tick runs as one critical section — its two metadata writes can't
        // interleave with an initialSync / forceRefresh / notifyPending /
        // restore that fires concurrently. One acquisition for the pair (not
        // two) keeps the pull→flush ordering and avoids a third party slipping
        // a metadata write between them.
        // Snapshot the counter BEFORE this tick's
        // pull+flush so the reset below can tell "this tick itself hit a
        // transient raise site" apart from "the final badge kind merely
        // reads 'error' because an unrelated batch is permanently parked".
        // The badge-truthfulness guard (`unsyncedBadgeGuard`) projects
        // `kind === 'error'` for a lingering park even when THIS tick's own
        // network work raised nothing, so gating the reset on `kind` alone
        // let a parked batch suppress the reset forever.
        const errorCounterBeforeTick = errorCounterRef.current;
        await runExclusiveRef.current(async () => {
          await pullRef.current();
          await flushPendingRef.current();
        });
        lastPollAtRef.current = Date.now();
        const kind = stateKindRef.current;
        // "First successful tick" reset: this tick's pull+flush pair
        // completed without hitting one of the three transient raise sites
        // (those, and only those, advance `errorCounterRef`), so the
        // consecutive-error counter — and any Retry-After it was carrying —
        // resets here, in the one place that can tell a genuinely clean tick
        // from one that merely didn't throw. A lingering permanent park
        // still reports `'error'` via the badge-truthfulness guard even on a
        // clean tick, so the reset is keyed on the counter's own movement,
        // not on the projected `kind`.
        if (errorCounterRef.current === errorCounterBeforeTick) {
          errorCounterRef.current = 0;
        }
        const ms = kind === 'error' ? computeErrorDelayMs() : (pendingCountRef.current > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS);
        // Record the poll's own next-attempt deadline and mirror it
        // onto the context so the badge can count down without computing
        // anything itself — it only ever reads this value. No deadline is
        // published for a pure permanent-park error state: nothing scheduled here will
        // ever actually resend a parked batch, so promising a countdown to
        // one would be a false "this will auto-recover" cue.
        const deadline = kind === 'error' && !isPureParkErrorState() ? Date.now() + ms : null;
        nextRetryAtRef.current = deadline;
        setNextRetryAt(deadline);
        schedule(ms);
      }, delay);
    }

    // Entry points OUTSIDE this tick (initialSync, notifyPending/retryNow's
    // flush, forceRefresh, syncRoundTrip, the online-listener flush) reach
    // this through `rearmIfRaised` the instant they raise a transient
    // error, so an error entered between ticks re-arms the ALREADY-RUNNING
    // timer to the correct backoff immediately, instead of waiting
    // out whatever cadence happened to be armed before it (up to the full
    // POLL_IDLE_MS) with no Retry-After honored for that stale wait.
    // A no-op outside the error state — and never
    // reached at all by an operation that raised nothing, so a lingering
    // park's projected 'error' can't push the armed poll out on every clean
    // edit.
    rearmNowRef.current = () => {
      if (stateKindRef.current !== 'error') return;
      // Publish the
      // deadline exactly as the tick's own reschedule does (lines above), not
      // just re-arm the timer. Leaving `nextRetryAtRef` / `nextRetryAt`
      // untouched here left them either `null` (no poll tick has ever
      // completed yet — the very first error a user sees, e.g. a mount-time
      // `initialSync` failure) or stale-past (a later non-tick raise site
      // re-armed the timer to a NEW deadline while the ref still held an
      // EARLIER tick's). Both defeat the badge countdown and the refocus
      // gate, which treats a stale-but-past deadline as "no wait owed" and
      // polls immediately.
      const ms = computeErrorDelayMs();
      const deadline = isPureParkErrorState() ? null : Date.now() + ms;
      nextRetryAtRef.current = deadline;
      setNextRetryAt(deadline);
      schedule(ms);
    };
    // A household change re-arms from scratch at the mount cadence, exactly
    // as the mount-time `schedule(POLL_IDLE_MS)` below does — the prior household's armed deadline is its own, not the
    // next one's. `resetRetryPolicy` clears the published deadline itself.
    restartPollRef.current = () => schedule(POLL_IDLE_MS);

    function onVisibility() {
      if (document.visibilityState !== 'visible') return;
      // Refocusing DURING an error-state backoff waits
      // min(remaining backoff, 5s + jitter) rather than polling
      // immediately — a separate mechanism from the debounce below, which
      // only applies outside the error state. A `null` deadline means no
      // poll tick (or non-tick raise site) has recorded one yet for the
      // CURRENT error — not "no backoff owed" — so treat the remaining
      // wait as unknown-but-nonzero rather than falling through to the
      // rewake debounce below and polling immediately.
      if (stateKindRef.current === 'error') {
        const remaining =
          nextRetryAtRef.current === null
            ? Infinity
            : Math.max(0, nextRetryAtRef.current - Date.now());
        const refocusWait = REFOCUS_BASE_MS + Math.random() * REFOCUS_JITTER_MS;
        const wait = Math.min(remaining, refocusWait);
        // Reflect the shortened wait on the badge's countdown immediately —
        // it would otherwise keep counting down to the pre-refocus deadline
        // until this tick actually fires. Still no deadline for a pure park.
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
    // Mount-once by design: cadence inputs are read from refs at tick
    // time (pull/flushPending/stateKind/pendingCount/errorCounter), so an
    // empty deps array is correct — the timer never re-arms at POLL_IDLE_MS
    // on a state/count change.
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

