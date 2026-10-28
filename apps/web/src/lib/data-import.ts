// Self-service workspace import: validates an exported bundle and replays it into IndexedDB through the local-mutation queue.
// The only place untrusted JSON enters the workspace, so it holds the import-side caps and key checks.

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

// Caps against hostile input: giant files and decompression bombs, deep or wide
// objects that blow the stack, and long arrays that starve the tab.
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_NESTING_DEPTH = 32;
const MAX_OBJECT_KEYS = 256;
const MAX_ARRAY_LENGTH = 100_000;

// The ignored `account` section can hold a year of auth events (~105,000), past
// MAX_ARRAY_LENGTH, so it gets a wider array ceiling or the app would reject its own export.
const MAX_IGNORED_ACCOUNT_SECTION_ARRAY_LENGTH = 1_000_000;

// `constructor` or `prototype` keys would prototype-pollute through a later
// Object.assign or spread; V8's JSON.parse drops `__proto__` but not the others.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Maps a renamed aggregate type's old wire name to its new one; empty today.
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
 * Reads a user-selected file (gzip by magic bytes, else plain JSON) into a
 * parsed envelope, enforcing the size caps and the key and tree guards.
 * @throws DataImportError
 */
export async function parseImportFile(file: Blob): Promise<unknown> {
  // A gzip file's size is compressed, but a plain `.json` file's is its logical
  // size, so it gets the decompressed ceiling or the app would reject its own large export.
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
    } catch (err) {
      if (err instanceof DataImportError) throw err;
      throw new DataImportError(
        'MALFORMED_BUNDLE',
        'File is gzipped but could not be decompressed.',
      );
    }
  } else {
    text = new TextDecoder().decode(bytes);
  }
  // Scan the text: JSON.parse drops `__proto__`, so a post-parse walk would miss
  // it. Only an object-key position (`"name":`) matches.
  for (const key of FORBIDDEN_KEYS) {
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
  assertSafePlainObjectTree(parsed, 'bundle', 0, MAX_ARRAY_LENGTH);
  return parsed;
}

async function ungzipToText(arrayBuf: ArrayBuffer): Promise<string> {
  // Blob takes the ArrayBuffer, not a Uint8Array view: recent TS rejects
  // Uint8Array<ArrayBufferLike> as a BlobPart.
  const body = new Response(new Blob([arrayBuf])).body;
  if (!body) throw new Error('Response body unavailable in this runtime.');
  const reader = body.pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DECOMPRESSED_BYTES) {
      // Cancelling an already-errored stream can reject; that carries nothing the importer needs.
      await reader.cancel().catch(() => undefined);
      throw new DataImportError(
        'BUNDLE_TOO_LARGE',
        `Decompressed bundle is ${formatBytes(total)}; the importer accepts up to ${formatBytes(MAX_DECOMPRESSED_BYTES)} decompressed.`,
      );
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} bytes`;
}

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
  // Reflect.ownKeys also sees the non-enumerable keys Object.keys misses.
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
    // Only the top-level `account` section, not `bundle.aggregates.account`, gets the wider ceiling.
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

const BundleEnvelopeSchema = z.object({
  // The legacy marker is accepted so pre-rename exports still import.
  format: z.enum([EXPORT_BUNDLE_FORMAT, LEGACY_EXPORT_BUNDLE_FORMAT]),
  version: z.number().int().positive(),
  exportedAt: z.string().optional().default(''),
  exportedByBuildId: z.string().optional().default(''),
  householdId: z.string().min(1),
  deviceId: z.string().optional().default(''),
  // z.record, not the type union: unknown aggregate types reach the UI for confirmation.
  aggregates: z.record(z.string(), z.array(z.unknown())),
  // Retained-conflict evidence the importer ignores; declared so a bundle carrying it validates.
  unresolvedLocalChanges: z.array(z.unknown()).optional(),
});

const AggregateMetaSchema = z.object({
  id: z.string().min(1),
  householdId: z.string().min(1),
  version: z.number().int().nonnegative(),
  schemaVersion: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
});

/**
 * Shape, version and consistency checks. Returns the unknown aggregate types so
 * the UI can prompt. The bundle's `householdId` is not checked against the
 * importer's: `applyImport` rewrites it.
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
  // A mix of household ids in one file is malformed; the UI warns separately about cross-household imports.
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
  // Return the original object so passthrough fields (`updatedAt`, `deletedAt`) survive.
  return raw as Aggregate;
}

function coerceScenarioWithdrawalStrategy(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const overrides = payload.overrides;
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return payload;
  }
  const overridesRecord = overrides as Record<string, unknown>;
  // An absent key is left to the engine boundary and migration; any malformed
  // present shape becomes `taxEfficient`.
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
 * Replaces the workspace with the bundle. Local aggregates the bundle lacks are
 * tombstoned so the server row goes too (a local-only clear would be resurrected
 * by the next pull). Overlapping ids queue as `update` at the local version,
 * fresh ids as `create` at version 0, and older payloads are migrated. Every
 * mutation carries `targetHouseholdId`, so a cross-household bundle lands in the
 * importer's account.
 */
export async function applyImport(
  bundle: ExportBundle,
  targetHouseholdId: string,
): Promise<ApplyImportResult> {
  // A leftover failed-conflict row would keep the SyncBadge on "Refresh needed" after the new flush succeeds.
  await clearMutationQueue();

  // Ids the bundle re-applies become updates: delete-then-recreate would fail the server's version precondition.
  const bundleIdsByType = new Map<AggregateType, Set<string>>();
  for (const t of AGGREGATE_TYPES_IN_DEPENDENCY_ORDER) {
    const ids = new Set<string>();
    for (const a of bundle.aggregates[t] ?? []) ids.add(a.id);
    bundleIdsByType.set(t, ids);
  }

  // No coarse `notifyWorkspaceChanged()` follows: readers wake on these fine signals, flushed at scope exit.
  const counts = {} as Record<AggregateType, number>;
  let total = 0;
  await withBatchedStoreSignals(async (batch) => {
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

    for (const type of AGGREGATE_TYPES_IN_DEPENDENCY_ORDER) {
      const list = bundle.aggregates[type] ?? [];
      counts[type] = 0;
      // Includes tombstones: a create at version 0 would collide with a
      // server-tombstoned row, while an update at its version clears `deletedAt`.
      const existingById = new Map<string, Aggregate>(
        (await listAggregatesIncludingDeleted(type)).map((a) => [a.id, a]),
      );
      for (const a of list) {
        const migrated =
          a.schemaVersion < currentSchemaVersion(type)
            ? (migrate(type, a.payload as Record<string, unknown>, a.schemaVersion) as Record<string, unknown>)
            : (a.payload as Record<string, unknown>);
        // Also runs when `schemaVersion` is current and the v8-to-v9 migration is skipped:
        // a v9 bundle carrying the retired Combined Pot kind is still corrected.
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

  // Older exports can leave zero categories after the tombstone sweep, which breaks the expense form's required category.
  await ensureDefaultExpenseCategories(targetHouseholdId);

  // Demotes an extra base scenario left by a cross-tab first-run race on the exporting device.
  const scenarios = (await listAggregates('scenario')) as ScenarioAggregate[];
  await reconcileScenarios(scenarios, targetHouseholdId);

  return { countsByType: counts, total };
}
