/**
 * Server-authoritative "Export my data" preparation.
 *
 * The export reads `GET /sync/bootstrap` + `GET /sync/pull` and the account
 * record under a valid five-minute export-authorization cookie (set by
 * `POST /auth/verify-password` with the `data_export` purpose); the cookie
 * is what lets the account-record section be served. This module turns that
 * cookie-authorized read into an honest, complete export bundle:
 *
 *   1. Read the existing device's tombstone-preserving local aggregates and
 *      every retained mutation-queue row WITHOUT changing either store — taken
 *      BEFORE the server fetch so a concurrent background push that drains a
 *      queue row mid-fetch cannot silently drop the edit from the bundle.
 *   2. FETCH + DECRYPT the current server state in memory (forced bootstrap plus
 *      any required pull pages), never writing it to IndexedDB — and MIGRATE
 *      each served row to this build's payload schema on the way in, the
 *      migration the IndexedDB read path would otherwise have applied.
 *   3. OVERLAY only the aggregate ids that still carry retained unsynced intent
 *      (`pending` / `pushing` / `failed-conflict` / `failed-error`) onto the
 *      server baseline for the importable `aggregates` view — an unrelated stale
 *      local row never beats current server data; a retained local delete stays
 *      absent from `aggregates`.
 *   4. Preserve BOTH the server and local variants (plus the ordered queue
 *      stack) for every overlaid id in an additive `unresolvedLocalChanges`
 *      section, so a newer server update is never silently lost when the local
 *      view wins.
 *
 * READ-ONLY GUARANTEE. This path writes only the downloaded file. It does not
 * write aggregate or mutation rows, alter the queue, enqueue mutations, push,
 * or start background sync. Opening the IndexedDB layer to READ may initialize
 * an empty schema on a genuinely fresh browser profile (no workspace/user data)
 * — the sole allowed local side effect. Any failure to prepare the server
 * baseline, the local overlay, or the supplemental records fails VISIBLY
 * (throws) rather than silently downloading a stale / empty / local-only /
 * conflict-lossy bundle.
 */
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
 * Mutation-queue statuses whose rows represent unsynced local INTENT the export
 * must preserve. A `pushing` row is an interrupted in-flight push; a
 * `failed-conflict` / `failed-error` row is a parked failure. All four mean the
 * server has not yet accepted the edit, so the local view — not the server
 * baseline — owns that aggregate id in the importable bundle.
 */
export const RETAINED_INTENT_STATUSES: ReadonlySet<PendingMutation['status']> =
  new Set(['pending', 'pushing', 'failed-conflict', 'failed-error']);

/** Safety ceiling on the pull-page loop so a misbehaving/never-`hasMore:false`
 *  server can never spin the export forever. Far above any realistic page count
 *  for a single household's tail. */
const MAX_PULL_PAGES = 10_000;

export type ServerDataExportErrorCode =
  | 'MALFORMED_LOCAL_MUTATION'
  | 'SERVER_STATE_UNAVAILABLE';

/**
 * Thrown when the export cannot be prepared honestly: a malformed retained
 * queue row, or a missing server baseline. Surfaced to the UI so the user sees
 * a visible failure instead of a silently wrong/partial download. Transport
 * failures (bad/expired export cookie, network, freshness rollback) propagate
 * as-is from the sync client and are likewise never swallowed here.
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

/** Narrow a served payload to the plaintext record the bundle stores, FAILING
 *  VISIBLY if it is still an encrypted envelope. The sync client decrypts every
 *  envelope in place when the HDK is unlocked; but when `getHdk()` returns null
 *  its `pull()`/`bootstrap()` skip decryption AND freshness/tamper verification
 *  and hand back the raw response body (sync-client.ts null-HDK skip). An export
 *  whose whole purpose is a complete, importable bundle must never bake a
 *  still-ciphertext row into the file, so reject it here rather than casting it
 *  blindly — the whole export then fails visibly. */
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

/**
 * Bring a served row up to this build's payload schema, in memory. The normal
 * bootstrap/pull apply writes a served row into IndexedDB at the server's
 * `schemaVersion` as-is and relies on every READ migrating on the way out
 * (`listAggregates` / `listAggregatesIncludingDeleted`); this export never
 * writes the server state to IndexedDB, so it has to run the same `migrate()`
 * chain itself — otherwise a snapshot or pull row still at an older schema
 * would carry a field a later migration removed (the `account` v6 Roth-basis
 * dollar totals dropped at v7) straight into the downloaded file, both as an
 * importable `aggregates` row and as an `unresolvedLocalChanges.serverAggregate`
 * variant. A row already at (or ahead of) current is returned as-is; the
 * schema-ahead case is the importing client's refusal to handle, not this
 * module's.
 */
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

/** Apply one server-side change (post-snapshot mutation or pulled change) onto
 *  the in-memory server map. A `delete` becomes a `deletedAt` tombstone; a
 *  `create`/`update` clears any prior tombstone. Later writes override earlier
 *  ones by id (server order is authoritative). Unlike the normal bootstrap/pull
 *  apply (which warns-and-skips unknown/retired types for rolling-deploy
 *  tolerance), an export must be COMPLETE, so an unrecognized type fails the
 *  whole export visibly rather than silently dropping the row. */
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
 * Materialize the current server-authoritative aggregate state in memory from a
 * forced bootstrap plus its pull tail. The result is tombstone-preserving:
 * server-side deletes are retained as `deletedAt` rows so a deletion is honestly
 * reflected (the row is dropped from the importable view later, but its variant
 * survives into `unresolvedLocalChanges` when the id also has retained intent).
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

/**
 * Run one `SyncTransport` call, raising the shared "please wait" notice
 * when it fails with a throttling `429`
 * `SyncApiError` carrying a `Retry-After` — then rethrow unchanged.
 * `HttpSyncClient` itself deliberately never raises (it is shared with the
 * sync loop, and the sync loop is excluded by CALL SITE, not by error
 * type): this export path is a different call site over the same
 * transport, and the export UI otherwise shows only a spinner while it
 * fails. Gated on `429`, not on the header alone: the S3
 * bootstrap contract returns `503` WITH
 * `Retry-After` on persistent failure, and an
 * enveloped `5xx` raises nothing — a "please wait" toast on an export that
 * has already failed for a non-throttle reason would be misleading.
 */
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
 * Fetch the current server state under the export-authorization cookie: force a
 * fresh bootstrap, then walk pull pages from the bootstrap cursor until the
 * server reports no more. Any transport error (bad/expired cookie, freshness
 * rollback, network) throws out of here — the caller must NOT fall back to a
 * local-only bundle.
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
    // No-progress guard: a server that reports `hasMore` without advancing the
    // cursor would loop forever otherwise. `hasMore` is still true here, so the
    // baseline is provably incomplete — fail visibly rather than build from it.
    if (pull.newCursor === since) {
      throw new ServerDataExportError(
        'SERVER_STATE_UNAVAILABLE',
        'Server pull stopped advancing its cursor while still reporting more ' +
          'pages; export aborted to avoid a partial server baseline.',
      );
    }
    since = pull.newCursor;
  }
  // Page-cap guard: if we exhausted MAX_PULL_PAGES the last page still reported
  // `hasMore: true` (the loop only continues while that holds), so the baseline
  // is incomplete — fail visibly rather than silently exporting a partial pull.
  if (pulls[pulls.length - 1]?.hasMore) {
    throw new ServerDataExportError(
      'SERVER_STATE_UNAVAILABLE',
      `Server pull exceeded the ${MAX_PULL_PAGES}-page ceiling while still ` +
        'reporting more pages; export aborted to avoid a partial server baseline.',
    );
  }
  return { bootstrap, pulls };
}

/** The exact aggregate-type set the export bundle supports (its dependency
 *  order). A retained row for a type outside this set can't be placed in the
 *  bundle, so it is treated as malformed. */
const SUPPORTED_EXPORT_TYPES: ReadonlySet<string> = new Set(
  AGGREGATE_TYPES_IN_DEPENDENCY_ORDER,
);

/** A retained queue row must be well-formed enough to reason about. A malformed
 *  row (unsupported type, bad operation, non-object payload) fails the export
 *  visibly rather than producing a wrong/partial bundle. */
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

/** Deterministic queue order: by mutation timestamp, ties broken by mutation id
 *  (the same total order the flush path relies on). */
function byTimestampThenId(a: PendingMutation, b: PendingMutation): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface MergeExportInput {
  serverByType: Map<AggregateType, Map<string, Aggregate>>;
  /** Local aggregates INCLUDING tombstones, keyed by id per type. */
  localByType: Map<AggregateType, Map<string, Aggregate>>;
  /** Every mutation-queue row (any status). */
  mutations: readonly PendingMutation[];
  householdId: string;
  deviceId: string;
}

/**
 * Pure merge: combine the server-authoritative baseline, the tombstone-aware
 * local view, and the retained queue into the importable `aggregates` field +
 * the additive `unresolvedLocalChanges` section.
 *
 * For each aggregate id:
 *   - WITH retained intent → the importable view uses the LOCAL variant (local
 *     wins). A retained local delete leaves the local row a tombstone, so it is
 *     omitted from `aggregates`. An `unresolvedLocalChanges` entry preserves the
 *     nullable, tombstone-preserving server + local variants and the ordered
 *     queue stack.
 *   - WITHOUT retained intent → the server baseline wins; server tombstones are
 *     omitted from the importable view (an unrelated stale local row can never
 *     overwrite current server data).
 */
export function mergeServerExportBundle(input: MergeExportInput): ExportBundle {
  const retained = input.mutations.filter((m) => RETAINED_INTENT_STATUSES.has(m.status));
  for (const m of retained) assertValidRetainedMutation(m);

  // Retained stacks grouped by (type, id), each deterministically ordered.
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

    // Server-baseline rows for ids WITHOUT retained intent (non-deleted only).
    for (const [id, serverAgg] of serverMap) {
      if (retainedMap.has(id)) continue;
      if (serverAgg.deletedAt) continue;
      out.push(serverAgg);
    }

    // Retained-intent ids: local view wins the importable slot; both variants +
    // the queue stack go into the supplemental record. Iterate ids in a stable
    // order so the output is deterministic.
    for (const id of [...retainedMap.keys()].sort()) {
      const stack = retainedMap.get(id)!;
      const serverAgg = serverMap.get(id) ?? null;
      const localAgg = localMap.get(id) ?? null;
      // Local view: include only when the local row is live (a retained delete
      // leaves a tombstone → omitted from the importable view).
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
  // Additive + optional: omit entirely when empty so the file stays
  // byte-compatible with a version-1 bundle without it.
  if (unresolvedLocalChanges.length > 0) {
    bundle.unresolvedLocalChanges = unresolvedLocalChanges;
  }
  return bundle;
}

export interface BuildServerExportOptions {
  transport: SyncTransport;
  householdId: string;
  deviceId: string;
  /** Injection seams for tests; default to the real read-only IDB helpers. */
  readLocalAggregates?: (type: AggregateType) => Promise<Aggregate[]>;
  readAllMutations?: () => Promise<PendingMutation[]>;
  /**
   * Fetch the account-record section under the export-authorization cookie
   * Default is the real `fetchAccountExport`
   * client bound to the current access token; tests inject a stub. Optional
   * so the local-only round-trip drill (`buildExportBundle`, which has no
   * server session) never needs one.
   */
  fetchAccount?: () => Promise<Record<string, unknown>>;
}

/**
 * Build the complete server-authoritative export bundle. Read-only: fetches +
 * decrypts server state, reads local aggregates (tombstone-preserving) and the
 * full mutation queue, fetches the account-record section, and merges. Never
 * writes workspace/queue state.
 */
export async function buildServerAuthoritativeExportBundle(
  opts: BuildServerExportOptions,
): Promise<ExportBundle> {
  const readLocalAggregates = opts.readLocalAggregates ?? listAggregatesIncludingDeleted;
  const readAllMutations = opts.readAllMutations ?? listAllMutations;

  // Snapshot the local aggregates and the mutation queue FIRST, then fetch the
  // server state. Ordering matters for concurrency: if a background push
  // completes and removes a queue row DURING the server fetch, that edit is
  // still captured in this already-taken local snapshot — its retained-intent
  // record survives into the bundle — so it can never silently drop out (and if
  // the later server fetch happens to reflect the just-pushed change, the merge
  // already prefers the local view for that id). Reading the server first would
  // leave a window where the row vanishes from both the retained set and the
  // (stale) server baseline, silently losing the edit.
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

  // Account-record section. Fetched under the same
  // export-authorization cookie the workspace fetch above rode on — any
  // failure (expired cookie, network) throws out of here, same as
  // `fetchServerAuthoritativeState`: the export must never silently ship
  // without its account half.
  if (opts.fetchAccount) {
    bundle.account = await opts.fetchAccount();
  }

  return bundle;
}

/** Which file format "Export my data" downloads. */
export type ExportFileFormat = 'gzip' | 'json';

/**
 * Build the server-authoritative bundle and trigger the browser download.
 * Returns the number of unresolved local-change records so the completion UI can
 * tell the user how many are included (and to keep the file even after an
 * import). This is the entry point the "Export my data" flows call.
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
