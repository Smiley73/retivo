/**
 * Aggregate envelope + cross-aggregate shared vocabulary — the lowest-level
 * module in the `db/types/` split. Everything here is imported by the
 * per-aggregate payload modules (household, account, scenario-overrides,
 * expense, income, …); this module imports none of them, so it stays free of
 * import cycles. Re-exported through the `db/types` barrel, so every existing
 * `../db/types` import site is unchanged.
 */

// The aggregate inventory is defined once in `@retirement/contracts` (the same
// source the API's `ACTIVE_AGGREGATE_TYPES_LIST` re-exports). Re-exported here
// so every existing `AggregateType` consumer in the web app is unchanged.
import type { AggregateType } from '@retirement/contracts';

export type { AggregateType };

interface AggregateBase {
  id: string;
  householdId: string;
  schemaVersion: number;
  version: number;
  updatedAt: string;
  deletedAt?: string;
  deviceId: string;
  aggregateType: AggregateType;
}

export type Aggregate<T extends Record<string, unknown> = Record<string, unknown>> = AggregateBase & {
  payload: T;
};

/**
 * A sparse per-scenario patch that can additionally *clear* an inherited
 * optional key. Each key is optional (sparse patch) and may carry the
 * key's value OR `null`. A `null` value is the clear-marker: it means
 * "this inherited optional field is intentionally empty in this
 * scenario". The per-id chain merge propagates `null` like any other
 * value (closest-scenario-wins by proximity); the resolver drops
 * `null`-valued keys from the merged payload after the chain merge so
 * the field resolves to "absent" rather than re-inheriting the canonical
 * value. A patch can therefore delete an inherited key. Stored `null` on
 * optionals is otherwise not allowed, so `null` is an unambiguous marker,
 * never a collision with real data.
 */
export type PatchWithClears<T> = { [K in keyof T]?: T[K] | null };

/**
 * Default life expectancy in whole years. Drives `lifetime(...)`
 * end-window math for Expense windows when no scenario override is set.
 *
 * Life expectancy lives on the scenario (`overrides.lifeExpectancy`),
 * not on the household member — the household-level field was removed
 * because it's a planning assumption, not a property of the person.
 */
export const DEFAULT_LIFE_EXPECTANCY_AGE = 95;

/**
 * Maximum modelled age, in whole years — the single app-wide ceiling for
 * every age the user can pick: life-expectancy assumptions and the
 * Start/End/glide age anchors. No person is projected past this age, so
 * year-anchor sliders also stop at the calendar year the oldest member
 * reaches it. One constant so the cap stays consistent everywhere.
 */
export const MAX_AGE = 100;

/** Household-member role. Used wherever a payload references one of the
 *  two members by position rather than by UUID — e.g. schedule anchors
 *  ("at primary's age 65"), `lifetime` end windows ("until last
 *  surviving"). The owning aggregate's `memberId` UUID is the source of
 *  truth for membership; this role is a UI/display affordance. */
export type HouseholdRole = 'primary' | 'secondary';

/**
 * Discriminated union for a recurring or single-event start anchor.
 * Used by Expense, IncomeStream, and any future scheduled aggregate.
 *
 * `age.memberId` is optional: when absent the resolver defaults to the
 * owning aggregate's owner role (income's `memberId` → role). Expense
 * payloads always set it explicitly because an expense can anchor to
 * either spouse independently of the household member who "owns" the
 * row. Income payloads on annuity / lumpSum / oneOff omit it because
 * those kinds always anchor to the stream's owner; partTime sets it
 * explicitly when the user has anchored to the non-owner spouse.
 */
export type ScheduleStart =
  | { kind: 'retirementStart' }
  | { kind: 'age'; memberId?: HouseholdRole; years: number; months: number }
  | { kind: 'year'; year: number };

/**
 * Discriminated union for a recurring window's end anchor. Five kinds
 * cover COBRA-shape (`endOfRetirementYear`), severance-shape
 * (`durationFromStart`), age-anchored, year-anchored, and
 * lifetime-of-member (or last-to-die) windows.
 *
 * Same owner-implicit rule on `age.memberId` as `ScheduleStart`.
 */
export type ScheduleEnd =
  | { kind: 'age'; memberId?: HouseholdRole; years: number; months: number }
  | { kind: 'year'; year: number }
  | { kind: 'lifetime'; whose: HouseholdRole | 'last' }
  | { kind: 'endOfRetirementYear'; offsetYears: number }
  | { kind: 'durationFromStart'; months: number };

/**
 * Anchor vocabulary for an expense's discretionary spending glide path.
 * Mirrors `ScheduleStart` plus the per-expense-relative
 * `durationFromExpenseStart` kind (the glide analogue of
 * `ScheduleEnd.durationFromStart`).
 *
 * - `retirementStart` / `year` / `age` resolve to the **same calendar
 *   point for every expense** (an absolute anchor). `age.memberId`
 *   follows the same owner-implicit rule as `ScheduleStart.age`. The
 *   glide-anchor UI configures `age` **years-only** — `months` is
 *   always stored as `0` for a glide `age` anchor (the picker has no
 *   months sub-input). The structural `months` field is retained so the
 *   type stays a structural superset of `ScheduleStart.age`.
 * - `durationFromExpenseStart` is the only genuinely per-expense kind:
 *   it resolves to N months after *that* expense's own resolved start
 *   month, so two expenses with different starts bend at different
 *   calendar points. The UI configures the offset as years + months
 *   ("after this expense begins"); they combine into the single stored
 *   `months` total (`years * 12 + months`).
 * - `expenseEnd` is glide-end-only: it resolves to the expense's own
 *   resolved `end` window month, so the glide (rise or fall) finishes exactly
 *   when the expense itself ends and tracks any scenario that moves the
 *   expense's `end`. No payload of its own — the resolver reads the
 *   resolved expense `end`. Offered only on the glide-end picker; under
 *   it the floor sub-section is meaningless (a floor strictly after the
 *   expense's own end can never apply) and is disabled / omitted.
 */
export type GlideAnchor =
  | { kind: 'retirementStart' }
  | { kind: 'age'; memberId?: HouseholdRole; years: number; months: number }
  | { kind: 'year'; year: number }
  | { kind: 'durationFromExpenseStart'; months: number }
  | { kind: 'expenseEnd' };

/**
 * Prototype-pollution-dangerous keys (CWE-1321). The single shared source
 * imported by the `categoryRates` migration sanitiser (`db/migrations.ts`),
 * the inflation resolver (`lib/scenario-resolution.ts`), and the medical-id
 * resolver (`lib/expense-category-resolvers.ts`). A category id matching one
 * of these must never reach a plain-object `categoryRates` map nor the
 * report's plain-object indexing. Lives in `db/types/aggregate-base.ts` (the
 * lowest-level module with no cyclic dependents, re-exported from the
 * `db/types` barrel) so `db/migrations.ts` can import it without a
 * `db ← lib ← db` cycle.
 */
export const DANGEROUS_CATEGORY_RATE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

// ---------- Local-only stores (not synced) ----------

export interface PendingMutation {
  id: string; // client UUID
  aggregateId: string;
  aggregateType: AggregateType;
  operation: 'create' | 'update' | 'delete';
  expectedVersion: number;
  schemaVersion: number;
  payload: Record<string, unknown>;
  timestamp: number;
  deviceId: string;
  status: 'pending' | 'pushing' | 'failed-conflict' | 'failed-error';
  /**
   * The server's push-rejection reason, persisted so the sync inspector can
   * show a plain-English "why" for a stuck conflict. Additive optional (no
   * `schemaVersion` / `DB_VERSION` change — the `mutations` queue is a local
   * non-aggregate store). Union mirrors `PushedMutationRejected.reason` (sync/types.ts);
   * an off-allowlist wire reason persists as absent, never a raw string. A
   * status write without a reason clears a stale one — see
   * `updateMutationStatus`.
   */
  reason?: 'CONFLICT' | 'NOT_FOUND' | 'SCHEMA_MISMATCH';
  /**
   * The server's true version counter at rejection time
   * (`PushedMutationRejected.currentVersion`), persisted on a parked
   * `failed-conflict` row so the manual Resolve UI can re-base the kept edit
   * without a server round-trip. Additive optional —
   * same local-non-aggregate-store rule as `reason` (no `schemaVersion` /
   * `DB_VERSION` change). Absent on a `pending` row and on a legacy conflict parked
   * before this shipped.
   */
  currentVersion?: number;
  /**
   * The server row's `updatedAt` at rejection time
   * (`PushedMutationRejected.currentUpdatedAt`), persisted alongside
   * `currentVersion` so the Resolve UI can show a "changed on server at …" line.
   * Additive optional; absent on a `pending` row and on a legacy conflict.
   */
  currentUpdatedAt?: string;
}

export interface DeviceMetadata {
  deviceId: string;
  syncCursor: string;
  lastSyncedAt: string | null;
  displayName: string;
  /**
   * Server-echoed zero-knowledge freshness counter that
   * this device pins and enforces against future sync responses. Absent
   * until the first encrypted sync round-trip stores a head (never present
   * while the HDK is null).
   */
  freshnessCounter?: number;
  /**
   * Locally pinned zero-knowledge envelope-set version. A
   * served slot set whose version is strictly below this pin is a genuine
   * rollback (see `isEnvelopeSetRollback`); after a successful verification
   * the pin advances to `max(pin, servedVersion)`. Absent = no pin yet (any
   * non-negative served version is accepted as the TOFU first contact).
   * Reset only on trusted destructive local resets (the pin lives in
   * `deviceMetadata`, which a full IDB drop / account delete destroys).
   */
  envelopeSetVersion?: number;
  /**
   * Bounded, per-device record of sync rows that failed to decrypt on pull /
   * bootstrap — the server holds no household
   * key, so quarantine of a genuinely undecryptable row is entirely
   * client-side. Never carries ciphertext, only aggregate identity + version
   * + a first-seen stamp; see `sync/quarantine.ts`. Absent = nothing
   * quarantined yet (the common case).
   */
  quarantinedRows?: QuarantinedSyncRow[];
}

/**
 * One sync row quarantined for failing to decrypt. Declared here (the `deviceMetadata` row shape) and re-exported by
 * `sync/quarantine.ts`, the module that owns reading/writing it.
 */
export interface QuarantinedSyncRow {
  aggregateId: string;
  aggregateType: string;
  version: number;
  firstSeenAt: number;
}

/**
 * Per-device pointer to the scenario currently driving any consuming
 * page (today: highlighting on /scenarios; future: projection /
 * dashboards). Singleton row in the local `selectedScenario` store —
 * not an aggregate, never synced.
 */
export interface SelectedScenario {
  scenarioId: string;
  updatedAt: string;
}
