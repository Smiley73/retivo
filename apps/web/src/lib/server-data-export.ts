// Server-authoritative "Export my data". Read-only: it writes only the downloaded
// file, and throws rather than ship a stale, partial, ciphertext or conflict-lossy bundle.

import type { Aggregate, AggregateType, PendingMutation } from '../db/types';
import {
  AGGREGATE_TYPES_IN_DEPENDENCY_ORDER,
  EXPORT_BUNDLE_FORMAT,
  EXPORT_BUNDLE_VERSION,
  exportFilename,
  exportFilenameJson,
  gzipJson,
  plainJson,
  triggerBrowserDownload,
  type ExportBundle,
  type UnresolvedLocalChange,
} from './data-export';
import { CLIENT_BUILD_ID } from './build-id';
import { isStrictEncryptedEnvelope } from '../crypto/key-wrapping';
import { currentSchemaVersion, migrate } from '../db/migrations';
import {
  isKnownAggregateType,
  listAggregatesIncludingDeleted,
  listAllMutations,
} from '../db/store';
import { SyncApiError, type SyncTransport } from '../sync/sync-client';
import type { BootstrapResponseBody, PullResponseBody } from '../sync/types';
import { raiseWaitNotice } from './toast-queue';

/**
 * Queue statuses the server has not yet accepted: for these ids the local view,
 * not the server baseline, owns the importable bundle.
 */
export const RETAINED_INTENT_STATUSES: ReadonlySet<PendingMutation['status']> =
  new Set(['pending', 'pushing', 'failed-conflict', 'failed-error']);

// Ceiling so a server that never reports `hasMore: false` cannot spin the export.
const MAX_PULL_PAGES = 10_000;

export type ServerDataExportErrorCode =
  | 'MALFORMED_LOCAL_MUTATION'
  | 'SERVER_STATE_UNAVAILABLE';

/**
 * Thrown when the export cannot be prepared honestly (a malformed retained
 * queue row or a missing server baseline), so the user sees a failure and not
 * a partial download.
 */
export class ServerDataExportError extends Error {
  constructor(
    public readonly code: ServerDataExportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ServerDataExportError';
  }
}

// An undecrypted envelope reaches here when `getHdk()` is null: the sync client
// then skips decryption and verification. Reject it rather than bake ciphertext into the file.
function assertPlaintextPayload(
  payload: unknown,
  aggregateId: string,
): Record<string, unknown> {
  if (isStrictEncryptedEnvelope(payload)) {
    throw new ServerDataExportError(
      'SERVER_STATE_UNAVAILABLE',
      `Server payload for aggregate ${aggregateId} is still encrypted (workspace ` +
        'key locked); export aborted to avoid a ciphertext or partial bundle.',
    );
  }
  return payload as Record<string, unknown>;
}

// Runs the migration an IndexedDB read would have applied: this export never
// writes server state to IndexedDB, and a stale row could carry a field a later
// migration removed (the `account` v6 Roth-basis totals dropped at v7).
function migrateServerAggregate(aggregate: Aggregate): Aggregate {
  const current = currentSchemaVersion(aggregate.aggregateType);
  if (aggregate.schemaVersion >= current) return aggregate;
  return {
    ...aggregate,
    schemaVersion: current,
    payload: migrate(aggregate.aggregateType, aggregate.payload, aggregate.schemaVersion),
  };
}

function emptyByType(): Map<AggregateType, Map<string, Aggregate>> {
  const m = new Map<AggregateType, Map<string, Aggregate>>();
  for (const t of AGGREGATE_TYPES_IN_DEPENDENCY_ORDER) m.set(t, new Map());
  return m;
}

// Unlike the normal apply, which warns and skips unknown types, an export must
// be complete, so an unrecognized type fails it.
function applyServerChange(
  byType: Map<AggregateType, Map<string, Aggregate>>,
  change: PullResponseBody['changes'][number],
  householdId: string,
): void {
  if (!isKnownAggregateType(change.aggregateType)) {
    throw new ServerDataExportError(
      'SERVER_STATE_UNAVAILABLE',
      `Server change for aggregate ${change.aggregateId} has unrecognized type ` +
        `${String(change.aggregateType)}; export aborted to avoid a silently ` +
        'incomplete bundle.',
    );
  }
  const isDelete = change.operation === 'delete';
  byType.get(change.aggregateType)!.set(
    change.aggregateId,
    migrateServerAggregate({
      id: change.aggregateId,
      householdId,
      aggregateType: change.aggregateType,
      schemaVersion: change.schemaVersion,
      version: change.version,
      updatedAt: change.updatedAt,
      deletedAt: isDelete ? change.updatedAt : undefined,
      deviceId: change.deviceId,
      payload: assertPlaintextPayload(change.payload, change.aggregateId),
    }),
  );
}

/**
 * Builds the server aggregate state in memory from a forced bootstrap plus its
 * pull tail; server deletes stay as `deletedAt` tombstones.
 */
export function materializeServerState(
  bootstrap: BootstrapResponseBody,
  pulls: readonly PullResponseBody[],
  householdId: string,
): Map<AggregateType, Map<string, Aggregate>> {
  const byType = emptyByType();
  for (const a of bootstrap.workspaceSnapshot.aggregates) {
    if (!isKnownAggregateType(a.aggregateType)) {
      throw new ServerDataExportError(
        'SERVER_STATE_UNAVAILABLE',
        `Server snapshot aggregate ${a.id} has unrecognized type ` +
          `${String(a.aggregateType)}; export aborted to avoid a silently ` +
          'incomplete bundle.',
      );
    }
    byType.get(a.aggregateType)!.set(
      a.id,
      migrateServerAggregate({
        id: a.id,
        householdId,
        aggregateType: a.aggregateType,
        schemaVersion: a.schemaVersion,
        version: a.version,
        updatedAt: a.updatedAt,
        deletedAt: a.deletedAt,
        deviceId: a.deviceId,
        payload: assertPlaintextPayload(a.payload, a.id),
      }),
    );
  }
  for (const c of bootstrap.postSnapshotMutations) {
    applyServerChange(byType, c, householdId);
  }
  for (const page of pulls) {
    for (const c of page.changes) applyServerChange(byType, c, householdId);
  }
  return byType;
}

// Raises the wait notice only for a 429 with `Retry-After`: `HttpSyncClient` never
// raises (the sync loop shares it), and a 503 with `Retry-After` is not throttling.
async function raiseOnWait<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof SyncApiError && err.status === 429 && err.retryAfterMs != null) {
      raiseWaitNotice(err.retryAfterMs);
    }
    throw err;
  }
}

/**
 * Forces a fresh bootstrap, then walks pull pages to the end. Any transport
 * error throws; the caller must not fall back to a local-only bundle.
 */
export async function fetchServerAuthoritativeState(
  transport: SyncTransport,
): Promise<{ bootstrap: BootstrapResponseBody; pulls: PullResponseBody[] }> {
  const bootstrap = await raiseOnWait(() => transport.bootstrap({ force: true }));
  const pulls: PullResponseBody[] = [];
  let since = bootstrap.syncCursor;
  for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
    const pull = await raiseOnWait(() => transport.pull({ since }));
    pulls.push(pull);
    if (!pull.hasMore) break;
    // No-progress guard: `hasMore` without an advancing cursor would loop forever.
    if (pull.newCursor === since) {
      throw new ServerDataExportError(
        'SERVER_STATE_UNAVAILABLE',
        'Server pull stopped advancing its cursor while still reporting more ' +
          'pages; export aborted to avoid a partial server baseline.',
      );
    }
    since = pull.newCursor;
  }
  // The loop ran out of pages with `hasMore` still true: the baseline is incomplete.
  if (pulls[pulls.length - 1]?.hasMore) {
    throw new ServerDataExportError(
      'SERVER_STATE_UNAVAILABLE',
      `Server pull exceeded the ${MAX_PULL_PAGES}-page ceiling while still ` +
        'reporting more pages; export aborted to avoid a partial server baseline.',
    );
  }
  return { bootstrap, pulls };
}

const SUPPORTED_EXPORT_TYPES: ReadonlySet<string> = new Set(
  AGGREGATE_TYPES_IN_DEPENDENCY_ORDER,
);

function assertValidRetainedMutation(m: PendingMutation): void {
  const ok =
    typeof m.aggregateId === 'string' &&
    m.aggregateId.length > 0 &&
    (m.operation === 'create' || m.operation === 'update' || m.operation === 'delete') &&
    SUPPORTED_EXPORT_TYPES.has(m.aggregateType) &&
    typeof m.timestamp === 'number' &&
    Number.isFinite(m.timestamp) &&
    m.payload !== null &&
    typeof m.payload === 'object' &&
    !Array.isArray(m.payload);
  if (!ok) {
    throw new ServerDataExportError(
      'MALFORMED_LOCAL_MUTATION',
      `Retained queued change for aggregate ${String(m.aggregateId)} is malformed; ` +
        'export aborted to avoid a wrong or partial bundle.',
    );
  }
}

// Same total order the flush path relies on.
function byTimestampThenId(a: PendingMutation, b: PendingMutation): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface MergeExportInput {
  serverByType: Map<AggregateType, Map<string, Aggregate>>;
  /** Includes tombstones. */
  localByType: Map<AggregateType, Map<string, Aggregate>>;
  mutations: readonly PendingMutation[];
  householdId: string;
  deviceId: string;
}

/**
 * Pure merge into the importable `aggregates` plus `unresolvedLocalChanges`. An
 * id with retained intent takes the local variant (a retained delete leaves it
 * out), and its entry keeps both variants and the ordered queue stack. Any other
 * id takes the server baseline, so a stale local row never overwrites current
 * server data.
 */
export function mergeServerExportBundle(input: MergeExportInput): ExportBundle {
  const retained = input.mutations.filter((m) => RETAINED_INTENT_STATUSES.has(m.status));
  for (const m of retained) assertValidRetainedMutation(m);

  const retainedByType = new Map<AggregateType, Map<string, PendingMutation[]>>();
  for (const t of AGGREGATE_TYPES_IN_DEPENDENCY_ORDER) retainedByType.set(t, new Map());
  for (const m of retained) {
    const perType = retainedByType.get(m.aggregateType)!;
    const stack = perType.get(m.aggregateId);
    if (stack) stack.push(m);
    else perType.set(m.aggregateId, [m]);
  }
  for (const perType of retainedByType.values()) {
    for (const stack of perType.values()) stack.sort(byTimestampThenId);
  }

  const aggregates = {} as Record<AggregateType, Aggregate[]>;
  const unresolvedLocalChanges: UnresolvedLocalChange[] = [];

  for (const type of AGGREGATE_TYPES_IN_DEPENDENCY_ORDER) {
    const serverMap = input.serverByType.get(type) ?? new Map<string, Aggregate>();
    const localMap = input.localByType.get(type) ?? new Map<string, Aggregate>();
    const retainedMap = retainedByType.get(type)!;
    const out: Aggregate[] = [];

    for (const [id, serverAgg] of serverMap) {
      if (retainedMap.has(id)) continue;
      if (serverAgg.deletedAt) continue;
      out.push(serverAgg);
    }

    for (const id of [...retainedMap.keys()].sort()) {
      const stack = retainedMap.get(id)!;
      const serverAgg = serverMap.get(id) ?? null;
      const localAgg = localMap.get(id) ?? null;
      if (localAgg && !localAgg.deletedAt) out.push(localAgg);
      unresolvedLocalChanges.push({
        aggregateType: type,
        aggregateId: id,
        exportedResolution: 'local_view',
        serverAggregate: serverAgg,
        localAggregate: localAgg,
        queuedMutations: stack,
      });
    }

    aggregates[type] = out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  const bundle: ExportBundle = {
    format: EXPORT_BUNDLE_FORMAT,
    version: EXPORT_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    exportedByBuildId: CLIENT_BUILD_ID,
    householdId: input.householdId,
    deviceId: input.deviceId,
    aggregates,
  };
  // Omitted when empty so the file stays byte-compatible with a bundle without it.
  if (unresolvedLocalChanges.length > 0) {
    bundle.unresolvedLocalChanges = unresolvedLocalChanges;
  }
  return bundle;
}

export interface BuildServerExportOptions {
  transport: SyncTransport;
  householdId: string;
  deviceId: string;
  /** Test seams; default to the read-only IndexedDB helpers. */
  readLocalAggregates?: (type: AggregateType) => Promise<Aggregate[]>;
  readAllMutations?: () => Promise<PendingMutation[]>;
  /** Fetches the account-record section; the local-only drill has no server session and omits it. */
  fetchAccount?: () => Promise<Record<string, unknown>>;
}

/**
 * Builds the complete server-authoritative bundle. Read-only: never writes
 * workspace or queue state.
 */
export async function buildServerAuthoritativeExportBundle(
  opts: BuildServerExportOptions,
): Promise<ExportBundle> {
  const readLocalAggregates = opts.readLocalAggregates ?? listAggregatesIncludingDeleted;
  const readAllMutations = opts.readAllMutations ?? listAllMutations;

  // Read local aggregates and the queue before the server fetch: a background
  // push that drains a queue row mid-fetch would otherwise vanish from both the
  // retained set and the stale server baseline, dropping the edit.
  const localByType = emptyByType();
  for (const type of AGGREGATE_TYPES_IN_DEPENDENCY_ORDER) {
    const map = localByType.get(type)!;
    for (const a of await readLocalAggregates(type)) map.set(a.id, a);
  }
  const mutations = await readAllMutations();

  const { bootstrap, pulls } = await fetchServerAuthoritativeState(opts.transport);
  const serverByType = materializeServerState(bootstrap, pulls, opts.householdId);

  const bundle = mergeServerExportBundle({
    serverByType,
    localByType,
    mutations,
    householdId: opts.householdId,
    deviceId: opts.deviceId,
  });

  // A failure (expired export cookie, network) throws: the export must never ship without its account half.
  if (opts.fetchAccount) {
    bundle.account = await opts.fetchAccount();
  }

  return bundle;
}

export type ExportFileFormat = 'gzip' | 'json';

/**
 * Builds the bundle and triggers the download; returns the unresolved
 * local-change count for the completion UI.
 */
export async function exportServerData(
  opts: BuildServerExportOptions,
  format: ExportFileFormat = 'gzip',
): Promise<{ unresolvedCount: number }> {
  const bundle = await buildServerAuthoritativeExportBundle(opts);
  if (format === 'json') {
    const blob = plainJson(bundle);
    triggerBrowserDownload(blob, exportFilenameJson(bundle.householdId, bundle.exportedAt));
  } else {
    const blob = await gzipJson(bundle);
    triggerBrowserDownload(blob, exportFilename(bundle.householdId, bundle.exportedAt));
  }
  return { unresolvedCount: bundle.unresolvedLocalChanges?.length ?? 0 };
}
