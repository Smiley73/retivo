/**
 * Shared FE/BE wire envelopes for sync push / pull / bootstrap, with a paired
 * Zod schema + `z.infer` type for each shape so the runtime validator and the
 * static type can never drift.
 *
 * ZERO-KNOWLEDGE PAYLOAD BOUNDARY (see docs/security.md → "Encryption"). Every `payload` field here stays
 * OPAQUE (`z.unknown()`), matching the API's own `payload: unknown`
 * (apps/api/src/sync/pull.service.ts). The server never holds a typed opinion
 * about a payload's shape, so the shared contract must not either. The web
 * sync-client narrows the opaque payload to its own richer
 * `Record<string, unknown> | EncryptedPayloadEnvelope` union at the point of use
 * (after decrypting in place) — that union is deliberately web-local and is NOT
 * hoisted here.
 *
 * FIELD-PERMISSIVE BY DESIGN. These schemas are parsed at the sync client's
 * pull / bootstrap boundary with `safeParse` and warn-and-degrade semantics: an
 * unknown-`aggregateType` row or a known-type field drift (missing/extra/retyped
 * field) must NEVER throw-and-abort an offline-first client's sync cycle. Extra
 * keys don't fail (Zod strips unknown keys rather than rejecting), optional
 * fields are modelled `.optional()` / `.nullish()`, and the client applies the
 * response even when validation fails (it only emits a diagnostic warning). See
 * docs/architecture.md → "The wire contract and drift".
 */
import { z } from 'zod';

/**
 * Server-echoed zero-knowledge freshness head (docs/security.md → "Unlocking"). Stored opaquely
 * server-side; the client verifies the MAC + pins the counter.
 */
export const freshnessHeadSchema = z.object({
  freshnessCounter: z.number(),
  cursorTag: z.string(),
});
export type FreshnessHeadBody = z.infer<typeof freshnessHeadSchema>;

const operationSchema = z.enum(['create', 'update', 'delete']);
export type SyncOperation = z.infer<typeof operationSchema>;

/**
 * One pulled mutation / post-snapshot change on the wire. `payload` is OPAQUE
 * (see the module note) — plaintext on the dark path, an encrypted envelope
 * once the HDK is unlocked; the client decrypts in place before applying.
 */
export const syncChangeSchema = z.object({
  aggregateId: z.string(),
  aggregateType: z.string(),
  operation: operationSchema,
  payload: z.unknown(),
  version: z.number(),
  schemaVersion: z.number(),
  updatedAt: z.string(),
  deviceId: z.string(),
});
export type SyncChange = z.infer<typeof syncChangeSchema>;

/** `GET /sync/pull` response body. */
export const pullResponseSchema = z.object({
  changes: z.array(syncChangeSchema),
  newCursor: z.string(),
  hasMore: z.boolean(),
  freshnessHead: freshnessHeadSchema.nullish(),
});
export type PullResponseBody = z.infer<typeof pullResponseSchema>;

/** One synced aggregate row as frozen into an S3 snapshot (bootstrap). `payload`
 *  is OPAQUE (see the module note). */
export const snapshotAggregateSchema = z.object({
  id: z.string(),
  householdId: z.string(),
  schemaVersion: z.number(),
  version: z.number(),
  updatedAt: z.string(),
  deletedAt: z.string().optional(),
  deviceId: z.string(),
  aggregateType: z.string(),
  payload: z.unknown(),
});
export type SnapshotAggregate = z.infer<typeof snapshotAggregateSchema>;

/** `GET /sync/bootstrap` response body. */
export const bootstrapResponseSchema = z.object({
  snapshotId: z.string().nullable(),
  workspaceSnapshot: z.object({
    householdId: z.string(),
    aggregates: z.array(snapshotAggregateSchema),
  }),
  postSnapshotMutations: z.array(syncChangeSchema),
  syncCursor: z.string(),
  timestamp: z.string(),
  freshnessHead: freshnessHeadSchema.nullish(),
});
export type BootstrapResponseBody = z.infer<typeof bootstrapResponseSchema>;

/** One applied push mutation result. */
export const pushedMutationAppliedSchema = z.object({
  status: z.literal('applied'),
  mutationId: z.string(),
  aggregateId: z.string(),
  newVersion: z.number(),
  newUpdatedAt: z.string(),
  /** KSUID of the MutationLog row; absent on a transparent idempotency replay. */
  sequenceId: z.string().optional(),
  /** `true` only when this `create` revived a tombstoned aggregate (docs/architecture.md → "Keeping sync data safe"). */
  recreatedOverTombstone: z.boolean().optional(),
});
export type PushedMutationApplied = z.infer<typeof pushedMutationAppliedSchema>;

/** One rejected push mutation result. */
export const pushedMutationRejectedSchema = z.object({
  status: z.literal('rejected'),
  mutationId: z.string(),
  aggregateId: z.string(),
  reason: z.enum(['CONFLICT', 'NOT_FOUND', 'SCHEMA_MISMATCH']),
  currentVersion: z.number(),
  currentUpdatedAt: z.string(),
  /** Current server row's soft-delete timestamp; `null` when live or absent. */
  currentDeletedAt: z.string().nullable(),
});
export type PushedMutationRejected = z.infer<typeof pushedMutationRejectedSchema>;

/** `POST /sync/push` response body. */
export const pushResponseSchema = z.object({
  applied: z.array(pushedMutationAppliedSchema),
  rejected: z.array(pushedMutationRejectedSchema),
  syncCursor: z.string(),
  freshnessHead: freshnessHeadSchema.nullish(),
});
export type PushResponseBody = z.infer<typeof pushResponseSchema>;

/** One snapshot listing entry for the self-service restore UI. */
export const snapshotListItemSchema = z.object({
  snapshotId: z.string(),
  timestamp: z.string(),
});
export type SnapshotListItem = z.infer<typeof snapshotListItemSchema>;
