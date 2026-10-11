/**
 * Self-service workspace import. Decompresses (if needed), validates,
 * and replays the aggregates from a previously-exported bundle into
 * IndexedDB via the standard local-mutation queue.
 *
 * Export-bundle compatibility: envelope and per-aggregate ceiling checks reject
 * newer-than-client bundles; older-than-client bundles pass through and
 * are migrated up to current via the same `migrate()` chain reads use.
 *
 * Hardening pass (this file is the only place untrusted JSON enters the
 * workspace, so it carries the bulk of import-side guardrails):
 *   - File-size + decompressed-size caps to bound DoS via giant payloads.
 *   - Prototype-pollution guard: every nested object is checked for
 *     `__proto__` / `constructor` / `prototype` own-keys before the
 *     payload reaches IndexedDB. JSON.parse already strips `__proto__`
 *     in modern V8 (returns a property, not a __proto__ binding), but
 *     defense-in-depth — any future helper that does `Object.assign`
 *     against an attacker-controlled `constructor.prototype` key would
 *     prototype-pollute every plain object in the page.
 *   - Bounded nesting depth + property width so a degenerate payload
 *     can't blow the stack or starve the main thread on Object.keys.
 *   - Zod envelope schema validates the outer shape before any per-
 *     aggregate work runs.
 *   - Per-aggregate metadata: id / householdId / version / schemaVersion
 *     are typed via zod; payload-is-object remains a manual check (per-
 *     payload zod schemas are not used — too much surface).
 */
import { z } from 'zod';
import {
  clearMutationQueue,
  listAggregates,
  listAggregatesIncludingDeleted,
  withBatchedStoreSignals,
} from '../db/store';
import {
  NAMED_WITHDRAWAL_STRATEGY_KINDS,
  currentSchemaVersion,
  migrate,
} from '../db/migrations';
import { queueLocalMutation } from '../sync/mutation-queue';
import type { Aggregate, AggregateType } from '../db/types';
import {
  AGGREGATE_TYPES_IN_DEPENDENCY_ORDER,
  EXPORT_BUNDLE_FORMAT,
  LEGACY_EXPORT_BUNDLE_FORMAT,
  EXPORT_BUNDLE_VERSION,
  type ExportBundle,
} from './data-export';
import { ensureDefaultExpenseCategories } from './expense-categories-bootstrap';
import { reconcileScenarios } from './scenario-mutations';
import type { ScenarioAggregate } from './scenario-resolution';

const SUPPORTED_BUNDLE_VERSION = EXPORT_BUNDLE_VERSION;

/** Reject the input file before we even read it into memory if it's
 *  larger than this. 50 MB is comfortably bigger than any realistic
 *  household bundle (the sync push API caps a single push at 5 MB
 *  compressed; a full workspace export is typically < 1 MB raw) and
 *  small enough to be a hard ceiling against pathological inputs. */
const MAX_INPUT_BYTES = 50 * 1024 * 1024;

/** A gzipped payload that decompresses to more than this is rejected.
 *  Higher than `MAX_INPUT_BYTES` to allow the typical 10× compression
 *  ratio of an export bundle, but still bounded so a "zip bomb"
 *  payload can't run the tab out of memory. */
const MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024;

/** Max nesting depth on any value inside the bundle. The deepest
 *  legitimate shape we ship today is ~6 levels (aggregate → payload →
 *  scenario.overrides → expenses → added → entry → schedule.start /
 *  end). 32 leaves a wide safety margin without exposing the
 *  recursive walk to stack overflow. */
const MAX_NESTING_DEPTH = 32;

/** Max number of own-keys on any single object inside the bundle.
 *  No legitimate aggregate payload exceeds ~20 keys; 256 is an order-
 *  of-magnitude safety margin. */
const MAX_OBJECT_KEYS = 256;

/** Max array length on any single array. Plenty of headroom for the
 *  realistic upper bound (e.g. a household with 60 years of monthly
 *  account-balance rows ≈ 720). 100 000 stops a malicious payload
 *  from forcing an O(N) iteration that starves the tab. */
const MAX_ARRAY_LENGTH = 100_000;

/**
 * Wider array-length ceiling scoped to the additive, DIAGNOSTIC-ONLY
 * `account` top-level bundle section —
 * never parsed into `ExportBundle.aggregates`,
 * never applied to IndexedDB, and never pushed to the server (see
 * `data-export.ts`'s `account` field doc comment and `applyImport`'s
 * ignore-the-account-section tests). That section's `history` carries the
 * whole retained AuthEvent history with NO truncation
 * (`account-export.service.ts`), which is reachable well past
 * `MAX_ARRAY_LENGTH` within the one-year retention window (roughly one
 * refresh every five minutes ≈ 105,000 events) even though the compact rows
 * stay far under `MAX_DECOMPRESSED_BYTES`. Applying the tighter
 * `MAX_ARRAY_LENGTH` here would make the app reject its own valid export.
 */
const MAX_IGNORED_ACCOUNT_SECTION_ARRAY_LENGTH = 1_000_000;

/** Own-key names that are forbidden on any object in the bundle.
 *  JSON.parse drops `__proto__` (V8 treats it as a regular property,
 *  not the [[Prototype]] slot), but any subsequent `Object.assign` /
 *  `{...spread}` against an attacker-controlled `constructor` or
 *  `prototype` key would prototype-pollute Object.prototype. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Forward-compatibility hook: if a future release renames an aggregate
// type, map the old wire name -> new internal name here so existing
// bundles keep importing without user intervention. Empty today.
const LEGACY_TYPE_RENAMES: Record<string, AggregateType> = {};

const KNOWN_TYPES: ReadonlySet<AggregateType> = new Set(
  AGGREGATE_TYPES_IN_DEPENDENCY_ORDER,
);

export type DataImportErrorCode =
  | 'MALFORMED_BUNDLE'
  | 'BUNDLE_VERSION_UNSUPPORTED'
  | 'AGGREGATE_VERSION_UNSUPPORTED'
  | 'BUNDLE_TOO_LARGE'
  | 'BUNDLE_FORBIDDEN_KEY'
  | 'BUNDLE_TOO_DEEP'
  | 'BUNDLE_OBJECT_TOO_WIDE'
  | 'BUNDLE_ARRAY_TOO_LONG';

export class DataImportError extends Error {
  constructor(
    public readonly code: DataImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DataImportError';
  }
}

export interface ValidatedBundle {
  bundle: ExportBundle;
  /** Aggregate type names present in the file but unknown to this client (after rename map). */
  unknownTypes: Array<{ type: string; count: number }>;
}

/**
 * Read a user-selected file into a parsed envelope. Sniffs the gzip
 * magic bytes (1f 8b); falls back to a plain UTF-8 JSON decode for raw
 * `.json` files, which the file picker also accepts. Enforces the
 * `MAX_INPUT_BYTES` and `MAX_DECOMPRESSED_BYTES` ceilings before
 * handing the parsed object back so an oversized or zip-bomb payload
 * never gets walked.
 */
export async function parseImportFile(file: Blob): Promise<unknown> {
  // Sniff the gzip magic bytes on-disk (a 2-byte slice) before committing to a
  // size ceiling, so the two formats get ceilings appropriate to what they
  // actually hold: a gzip file's ON-DISK size is compressed (MAX_INPUT_BYTES,
  // the same ~10x-compression-ratio assumption `MAX_DECOMPRESSED_BYTES`
  // documents), but a plain `.json` file's on-disk size IS its logical
  // content size — the exporter's own uncompressed download option can
  // legitimately exceed MAX_INPUT_BYTES once account history is large, so the
  // plain-file ceiling must match MAX_DECOMPRESSED_BYTES or the app would
  // reject its own valid export.
  const magicBytes = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const isGzip = magicBytes.length >= 2 && magicBytes[0] === 0x1f && magicBytes[1] === 0x8b;
  const inputCeiling = isGzip ? MAX_INPUT_BYTES : MAX_DECOMPRESSED_BYTES;
  if (file.size > inputCeiling) {
    throw new DataImportError(
      'BUNDLE_TOO_LARGE',
      `File is ${formatBytes(file.size)}; the importer accepts files up to ${formatBytes(inputCeiling)}.`,
    );
  }
  const arrayBuf = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuf);
  let text: string;
  if (isGzip) {
    try {
      text = await ungzipToText(arrayBuf);
    } catch {
      throw new DataImportError(
        'MALFORMED_BUNDLE',
        'File is gzipped but could not be decompressed.',
      );
    }
    if (text.length > MAX_DECOMPRESSED_BYTES) {
      throw new DataImportError(
        'BUNDLE_TOO_LARGE',
        `Decompressed bundle is ${formatBytes(text.length)}; the importer accepts up to ${formatBytes(MAX_DECOMPRESSED_BYTES)} decompressed.`,
      );
    }
  } else {
    text = new TextDecoder().decode(bytes);
  }
  // Pre-parse text scan for forbidden keys. V8's JSON.parse silently
  // strips `__proto__` (the parsed object has no enumerable own-key
  // for it), so a post-parse walk via Reflect.ownKeys can't catch
  // every attack. A literal `"__proto__"` / `"constructor"` /
  // `"prototype"` token in the JSON text means the payload was
  // crafted to attempt prototype-pollution, regardless of whether the
  // runtime drops the key — reject before parsing. The token has to
  // appear as a JSON object key (`"name":`) to fire; a payload string
  // value that happens to mention `__proto__` is fine.
  for (const key of FORBIDDEN_KEYS) {
    // \b doesn't help here (JSON keys are quoted strings); match
    // `"key"\s*:` to require object-key position.
    const pattern = new RegExp(`"${key}"\\s*:`);
    if (pattern.test(text)) {
      throw new DataImportError(
        'BUNDLE_FORBIDDEN_KEY',
        `Bundle text contains a forbidden key "${key}" before parsing. Prototype-pollution keys are rejected.`,
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DataImportError('MALFORMED_BUNDLE', 'File is not valid JSON.');
  }
  // Pre-walk the parsed value to enforce depth, width, and array-length
  // guards on the live object graph (forbidden-key check already ran
  // against the text). Throws DataImportError on the first violation,
  // so attacker-shaped payloads never reach validateBundle / applyImport.
  assertSafePlainObjectTree(parsed, 'bundle', 0, MAX_ARRAY_LENGTH);
  return parsed;
}

async function ungzipToText(arrayBuf: ArrayBuffer): Promise<string> {
  // Pass the ArrayBuffer (not a derived Uint8Array view) to Blob so TS
  // accepts the BlobPart — Uint8Array<ArrayBufferLike> trips the
  // "could be SharedArrayBuffer" lib check on recent TS versions.
  const body = new Response(new Blob([arrayBuf])).body;
  if (!body) throw new Error('Response body unavailable in this runtime.');
  return new Response(body.pipeThrough(new DecompressionStream('gzip'))).text();
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} bytes`;
}

/**
 * Recursive guard walker. Throws DataImportError if any nested value
 * carries a forbidden own-key, exceeds `MAX_NESTING_DEPTH`, exposes an
 * object with more than `MAX_OBJECT_KEYS` keys, or an array longer
 * than `maxArrayLength`. Primitive values, null, numbers, strings,
 * booleans all pass instantly.
 *
 * `maxArrayLength` is threaded through the recursion (rather than a fixed
 * module constant) so the top-level `account` section — see
 * `MAX_IGNORED_ACCOUNT_SECTION_ARRAY_LENGTH`'s doc comment — can apply a
 * wider ceiling than the rest of the tree; every other subtree keeps the
 * caller-supplied value unchanged as it recurses.
 *
 * Path tracking helps diagnostics — a violation surfaces the JSON path
 * (e.g. `bundle.aggregates.scenario[2].payload.__proto__`) so a user
 * dropping a hand-edited bundle can find the offending node.
 */
function assertSafePlainObjectTree(
  value: unknown,
  path: string,
  depth: number,
  maxArrayLength: number,
): void {
  if (depth > MAX_NESTING_DEPTH) {
    throw new DataImportError(
      'BUNDLE_TOO_DEEP',
      `Bundle nesting exceeds ${MAX_NESTING_DEPTH} levels at ${path}.`,
    );
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (value.length > maxArrayLength) {
      throw new DataImportError(
        'BUNDLE_ARRAY_TOO_LONG',
        `Array at ${path} has ${value.length} entries; the importer accepts up to ${maxArrayLength}.`,
      );
    }
    for (let i = 0; i < value.length; i += 1) {
      assertSafePlainObjectTree(value[i], `${path}[${i}]`, depth + 1, maxArrayLength);
    }
    return;
  }
  // Plain object — check own-keys (the prototype-pollution surface).
  // `Reflect.ownKeys` is the only API that reliably surfaces *every*
  // own key including non-enumerable + symbol keys; `Object.keys`
  // misses non-enumerable own properties, and modern V8 has
  // historically treated `__proto__` inconsistently across the
  // `Object.keys` / `for..in` / `JSON.parse` boundary.
  const keys = Reflect.ownKeys(value as object).filter(
    (k): k is string => typeof k === 'string',
  );
  if (keys.length > MAX_OBJECT_KEYS) {
    throw new DataImportError(
      'BUNDLE_OBJECT_TOO_WIDE',
      `Object at ${path} has ${keys.length} keys; the importer accepts up to ${MAX_OBJECT_KEYS}.`,
    );
  }
  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new DataImportError(
        'BUNDLE_FORBIDDEN_KEY',
        `Bundle contains a forbidden key "${key}" at ${path}. Prototype-pollution keys are rejected.`,
      );
    }
    // The additive, ignored `account` section (top-level bundle key only —
    // NOT `bundle.aggregates.account`, the real account-aggregate array,
    // which stays on the normal ceiling) gets the wider array-length
    // ceiling for its whole subtree.
    const childMaxArrayLength =
      path === 'bundle' && key === 'account'
        ? MAX_IGNORED_ACCOUNT_SECTION_ARRAY_LENGTH
        : maxArrayLength;
    assertSafePlainObjectTree(
      (value as Record<string, unknown>)[key],
      `${path}.${key}`,
      depth + 1,
      childMaxArrayLength,
    );
  }
}

/**
 * Envelope schema. Validates the outer shape of the bundle before any
 * per-aggregate work runs. `aggregates` is intentionally `z.record(...)`
 * — the importer permits unknown aggregate type names (they surface as
 * `unknownTypes` to the UI for user confirmation), so the envelope
 * doesn't enforce the AGGREGATE_TYPES_IN_DEPENDENCY_ORDER union here.
 *
 * Per-aggregate metadata (id / householdId / version / schemaVersion /
 * payload) is validated by `AggregateMetaSchema` inside
 * `assertAggregateShape`.
 */
const BundleEnvelopeSchema = z.object({
  // Old marker accepted so pre-rename exports still import (normalised to
  // the current marker on the parsed bundle below).
  format: z.enum([EXPORT_BUNDLE_FORMAT, LEGACY_EXPORT_BUNDLE_FORMAT]),
  version: z.number().int().positive(),
  exportedAt: z.string().optional().default(''),
  exportedByBuildId: z.string().optional().default(''),
  householdId: z.string().min(1),
  deviceId: z.string().optional().default(''),
  aggregates: z.record(z.string(), z.array(z.unknown())),
  // Additive supplemental section. The
  // importer ONLY restores the main `aggregates` view and deliberately ignores
  // this field — it is retained-conflict evidence for the user, not import
  // input. Declared optional here so a bundle carrying it validates cleanly (a
  // version-1 bundle simply omits it).
  unresolvedLocalChanges: z.array(z.unknown()).optional(),
});

const AggregateMetaSchema = z.object({
  id: z.string().min(1),
  householdId: z.string().min(1),
  version: z.number().int().nonnegative(),
  schemaVersion: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
  // `deletedAt` and `updatedAt` are optional metadata that older
  // bundles may omit; `passthrough` is implied by .unknown() above
  // — extra keys are fine here, the payload's own forbidden-key
  // check runs in the safe-walk pre-pass.
});

/**
 * Shape + version + intra-bundle consistency checks. Returns the bundle
 * plus any unknown aggregate types so the UI can prompt the user before
 * proceeding (skip-and-continue or cancel).
 *
 * Note: the bundle's `householdId` is **not** checked against the
 * importing user's. Cross-household imports are allowed; the importing
 * user's UI is responsible for warning before proceeding, and
 * `applyImport` rewrites every aggregate's `householdId` to the
 * importing user's at queue time.
 */
export function validateBundle(parsed: unknown): ValidatedBundle {
  const envelopeResult = BundleEnvelopeSchema.safeParse(parsed);
  if (!envelopeResult.success) {
    const first = envelopeResult.error.issues[0];
    const fieldPath = first.path.join('.') || '<root>';
    throw new DataImportError(
      'MALFORMED_BUNDLE',
      `Bundle envelope is malformed at ${fieldPath}: ${first.message}.`,
    );
  }
  const env = envelopeResult.data;
  if (env.version > SUPPORTED_BUNDLE_VERSION) {
    throw new DataImportError(
      'BUNDLE_VERSION_UNSUPPORTED',
      `Bundle envelope is version ${env.version}; this client supports up to ${SUPPORTED_BUNDLE_VERSION}.`,
    );
  }

  const bundleHouseholdId = env.householdId;
  const knownAggregates = {} as Record<AggregateType, Aggregate[]>;
  const unknownTypes: Array<{ type: string; count: number }> = [];
  for (const [rawName, rawList] of Object.entries(env.aggregates)) {
    const resolvedName = (LEGACY_TYPE_RENAMES[rawName] ?? rawName) as AggregateType;
    if (!KNOWN_TYPES.has(resolvedName)) {
      unknownTypes.push({ type: rawName, count: rawList.length });
      continue;
    }
    const typed: Aggregate[] = [];
    for (const raw of rawList) {
      typed.push(validateAggregate(raw, resolvedName, bundleHouseholdId));
    }
    knownAggregates[resolvedName] = typed;
  }

  // Initialize empty arrays for any known type missing from the bundle
  // so downstream iteration is total.
  for (const t of AGGREGATE_TYPES_IN_DEPENDENCY_ORDER) {
    if (!knownAggregates[t]) knownAggregates[t] = [];
  }

  const bundle: ExportBundle = {
    format: EXPORT_BUNDLE_FORMAT,
    version: env.version,
    exportedAt: env.exportedAt,
    exportedByBuildId: env.exportedByBuildId,
    householdId: env.householdId,
    deviceId: env.deviceId,
    aggregates: knownAggregates,
  };

  return { bundle, unknownTypes };
}

function validateAggregate(
  raw: unknown,
  type: AggregateType,
  bundleHouseholdId: string,
): Aggregate {
  const result = AggregateMetaSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const fieldPath = first.path.join('.') || '<root>';
    throw new DataImportError(
      'MALFORMED_BUNDLE',
      `${type} aggregate is malformed at ${fieldPath}: ${first.message}.`,
    );
  }
  const meta = result.data;
  // Every aggregate in a bundle must share the bundle's householdId. A
  // mix of household ids inside one file is a malformed bundle (not a
  // user-actionable cross-household import — the import UI compares the
  // bundle's single householdId to the caller's and warns separately).
  if (meta.householdId !== bundleHouseholdId) {
    throw new DataImportError(
      'MALFORMED_BUNDLE',
      `${type} aggregate ${meta.id} has householdId that does not match the bundle envelope.`,
    );
  }
  if (meta.schemaVersion > currentSchemaVersion(type)) {
    throw new DataImportError(
      'AGGREGATE_VERSION_UNSUPPORTED',
      `${type} aggregate ${meta.id} is at schemaVersion ${meta.schemaVersion}; this client supports up to ${currentSchemaVersion(type)}.`,
    );
  }
  // The validated meta + payload pass through as the typed Aggregate.
  // `updatedAt` / `deletedAt` (and any other passthrough fields the
  // export carried) are preserved on the original `raw` object — zod's
  // `safeParse` against a `z.record` doesn't strip unknown keys, and
  // we return the original reference so applyImport keeps them.
  return raw as Aggregate;
}

/**
 * Coerce a scenario payload's `overrides.withdrawalStrategy.kind` to one
 * of the four named strategies before the payload is applied. A retired
 * Combined Pot value (or any malformed / tampered kind) becomes
 * `taxEfficient`. Runs for EVERY imported scenario regardless of schemaVersion,
 * so a v9 bundle carrying the retired kind — which skips the v8→v9 migration's
 * `schemaVersion < current` gate — is still corrected. An absent strategy is
 * left untouched here (the engine boundary + migration default it; the import
 * never invents a strategy on a payload that didn't carry one). Total /
 * never-throws / idempotent.
 */
function coerceScenarioWithdrawalStrategy(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const overrides = payload.overrides;
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return payload;
  }
  const overridesRecord = overrides as Record<string, unknown>;
  // A truly ABSENT key is left untouched (the engine boundary + migration
  // default it). A PRESENT key with any malformed shape — null, an array, a
  // non-object, or an object whose `.kind` is not a named strategy — is
  // coerced to `taxEfficient` so an invalid shape never reaches the engine.
  if (!('withdrawalStrategy' in overridesRecord)) {
    return payload;
  }
  const strategy = overridesRecord.withdrawalStrategy;
  if (strategy !== null && typeof strategy === 'object' && !Array.isArray(strategy)) {
    const kind = (strategy as Record<string, unknown>).kind;
    if (typeof kind === 'string' && NAMED_WITHDRAWAL_STRATEGY_KINDS.has(kind)) {
      return payload;
    }
  }
  return {
    ...payload,
    overrides: {
      ...overridesRecord,
      withdrawalStrategy: { kind: 'taxEfficient' },
    },
  };
}

export interface ApplyImportResult {
  countsByType: Record<AggregateType, number>;
  total: number;
}

/**
 * Replaces the workspace with the bundle's aggregates. Every existing
 * aggregate not in the bundle is tombstoned via a `delete` mutation so
 * the server-side row also disappears once the sync flush completes —
 * a local-only `clearAllStores()` would not touch the cloud, and the
 * next pull would resurrect the rows. Aggregates that overlap by id
 * are queued as `update` at the local version so the bundle's payload
 * overwrites in place; fresh ids queue as `create` at expectedVersion
 * 0. Older-than-current `schemaVersion` payloads run through the same
 * `migrate()` chain reads use, so the persisted aggregate matches the
 * current shape.
 *
 * `targetHouseholdId` is the importing user's `householdId` (from the
 * JWT claim). Every queued mutation carries this value, regardless of
 * what `householdId` the bundle's aggregates were exported under — a
 * cross-household import (bundle from another account) reassigns the
 * data to the importing user. The UI is expected to warn the user
 * before reaching this function when `bundle.householdId !==
 * targetHouseholdId`.
 */
export async function applyImport(
  bundle: ExportBundle,
  targetHouseholdId: string,
): Promise<ApplyImportResult> {
  // Drop any prior pending or failed-conflict mutations before queueing
  // the import's own. The user's "replace my data" confirmation makes
  // anything already in the queue moot, and a leftover `failed-conflict`
  // row (e.g. from a previous broken push) would keep the SyncBadge
  // stuck on "Refresh needed" even after the new flush finishes
  // cleanly — `listFailedConflicts()` is what the badge keys off, not
  // whether any new mutation conflicted in this round.
  await clearMutationQueue();

  // Index the bundle by (type, id) so the wipe can skip ids that are
  // about to be re-applied — those become updates, not delete-then-
  // recreate, which would conflict on push (server precondition fails
  // because version moves with each tombstone).
  const bundleIdsByType = new Map<AggregateType, Set<string>>();
  for (const t of AGGREGATE_TYPES_IN_DEPENDENCY_ORDER) {
    const ids = new Set<string>();
    for (const a of bundle.aggregates[t] ?? []) ids.add(a.id);
    bundleIdsByType.set(t, ids);
  }

  // Batch both phases' per-row fine signals into one per touched store on
  // scope exit. `applyImport` has NO coarse `notifyWorkspaceChanged()` tail —
  // its mounted readers are woken by these (now batched) fine signals, so the
  // scope-exit flush is load-bearing here.
  const counts = {} as Record<AggregateType, number>;
  let total = 0;
  await withBatchedStoreSignals(async (batch) => {
    // Phase 1 — tombstone every local aggregate the bundle does not bring
    // back. queueLocalMutation also sets `deletedAt` on the local copy so
    // subsequent reads don't see the row.
    for (const t of AGGREGATE_TYPES_IN_DEPENDENCY_ORDER) {
      const existing = await listAggregates(t);
      const keep = bundleIdsByType.get(t) ?? new Set<string>();
      for (const aggr of existing) {
        if (keep.has(aggr.id)) continue;
        await queueLocalMutation({
          type: t,
          aggregateId: aggr.id,
          householdId: aggr.householdId,
          operation: 'delete',
          expectedVersion: aggr.version,
          payload: aggr.payload,
        }, batch);
      }
    }

    // Phase 2 — replay the bundle. Existing-id rows queue as updates at
    // the local version; fresh ids queue as creates at version 0. Every
    // queued mutation carries `targetHouseholdId` (the importing user's),
    // overriding the bundle's original householdId so cross-household
    // imports land in the caller's account.
    for (const type of AGGREGATE_TYPES_IN_DEPENDENCY_ORDER) {
      const list = bundle.aggregates[type] ?? [];
      counts[type] = 0;
      // Includes tombstones so we can resurrect cloud-side rows the
      // server has tombstoned (which never get reaped). Without this,
      // `create @ expectedVersion=0` would collide with the tombstoned
      // `AggregateVersion` row at v=N+1; using `update @ tombstone_version`
      // succeeds and clears `deletedAt` on the cloud copy.
      const existingById = new Map<string, Aggregate>(
        (await listAggregatesIncludingDeleted(type)).map((a) => [a.id, a]),
      );
      for (const a of list) {
        const migrated =
          a.schemaVersion < currentSchemaVersion(type)
            ? (migrate(type, a.payload as Record<string, unknown>, a.schemaVersion) as Record<string, unknown>)
            : (a.payload as Record<string, unknown>);
        // Coerce the withdrawal strategy at the resolver boundary even
        // when `schemaVersion === current` skips the v8→v9 migration above — a
        // v9 bundle carrying the retired Combined Pot (or any non-named) kind
        // is corrected to `taxEfficient` before the payload is applied. Closes
        // the schemaVersion-equals bypass (CWE-20).
        const payload =
          type === 'scenario'
            ? coerceScenarioWithdrawalStrategy(migrated)
            : migrated;
        const local = existingById.get(a.id);
        await queueLocalMutation({
          type,
          aggregateId: a.id,
          householdId: targetHouseholdId,
          operation: local ? 'update' : 'create',
          expectedVersion: local ? local.version : 0,
          payload,
        }, batch);
        counts[type] += 1;
        total += 1;
      }
    }
  });

  // Backfill the 8 default expense categories when the bundle didn't
  // ship any. Older exports (pre-bootstrap) and legacy v1 imports leave
  // the user with zero categories after Phase 1's tombstone sweep,
  // which breaks the Expense form's required-category constraint.
  // `ensureDefaultExpenseCategories` is a no-op when at least one
  // category exists, so bundles that brought their own pass through
  // unchanged.
  await ensureDefaultExpenseCategories(targetHouseholdId);

  // Defensive: bundles created on a device that had two `isPrimary`
  // scenarios (cross-tab first-run race) carry both rows through to
  // Phase 2. Reconcile demotes any extra base so the imported state
  // satisfies the single-base invariant. No-op when the bundle is
  // already well-formed.
  const scenarios = (await listAggregates('scenario')) as ScenarioAggregate[];
  await reconcileScenarios(scenarios, targetHouseholdId);

  return { countsByType: counts, total };
}
