// Aggregate envelope and shared vocabulary: the lowest-level module in `db/types/`, importing none of them (no cycles).

// The aggregate inventory is defined once in `@retirement/contracts` (the API's `ACTIVE_AGGREGATE_TYPES_LIST` uses it
// too).
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
 * A sparse per-scenario patch that can also clear an inherited optional key: each key may hold its value or `null`, the
 * clear-marker for "intentionally empty in this scenario". The chain merge propagates `null` like any value (closest
 * scenario wins); the resolver then drops `null` keys so the field resolves to absent instead of re-inheriting. Stored
 * `null` on optionals is otherwise disallowed, so the marker never collides with real data.
 */
export type PatchWithClears<T> = { [K in keyof T]?: T[K] | null };

/**
 * Default life expectancy in whole years, driving `lifetime(...)` end-window math for expense windows when no scenario
 * override is set. It lives on the scenario (`overrides.lifeExpectancy`), not the member: a planning assumption, not a
 * property of the person.
 */
export const DEFAULT_LIFE_EXPECTANCY_AGE = 95;

/**
 * Maximum modelled age in whole years: the one app-wide ceiling for every pickable age (life expectancy,
 * Start/End/glide age anchors). No one is projected past it, so year-anchor sliders stop at the calendar year the
 * oldest member reaches it.
 */
export const MAX_AGE = 100;

/**
 * Household-member role for payloads that reference a member by position, e.g. schedule anchors ("at primary's age 65")
 * and `lifetime` end windows. The owning aggregate's `memberId` UUID is the source of truth for membership; this role
 * is a UI/display affordance.
 */
export type HouseholdRole = 'primary' | 'secondary';

/**
 * Start anchor for a recurring or single-event window (expense, income stream, future scheduled aggregates).
 * `age.memberId` is optional: absent, the resolver defaults to the owning aggregate's owner role. Expenses always set
 * it (they can anchor to either spouse); income annuity/lumpSum/oneOff omit it (they anchor to the owner) and partTime
 * sets it to anchor to the non-owner spouse.
 */
export type ScheduleStart =
  | { kind: 'retirementStart' }
  | { kind: 'age'; memberId?: HouseholdRole; years: number; months: number }
  | { kind: 'year'; year: number };

/**
 * End anchor for a recurring window: COBRA-shape (`endOfRetirementYear`), severance-shape (`durationFromStart`), or
 * age-, year- or lifetime-of-member (or last-to-die) anchored. `age.memberId` follows `ScheduleStart`'s owner-implicit
 * rule.
 */
export type ScheduleEnd =
  | { kind: 'age'; memberId?: HouseholdRole; years: number; months: number }
  | { kind: 'year'; year: number }
  | { kind: 'lifetime'; whose: HouseholdRole | 'last' }
  | { kind: 'endOfRetirementYear'; offsetYears: number }
  | { kind: 'durationFromStart'; months: number };

/**
 * Anchor vocabulary for an expense's glide path: `ScheduleStart` plus the per-expense `durationFromExpenseStart`.
 * - `retirementStart` / `year` / `age` resolve to the same calendar point for every expense; `age.memberId` follows
 * `ScheduleStart`'s
 *   owner-implicit rule. The glide UI configures `age` years-only, so `months` is always stored `0`; the field remains
 * so the type is   a structural superset of `ScheduleStart.age`.
 * - `durationFromExpenseStart` resolves to N months after that expense's own start (the UI takes years + months and
 * stores
 *   `years * 12 + months`), so expenses with different starts bend at different points.
 * - `expenseEnd` is glide-end-only: it resolves to the expense's own resolved `end` month, so the glide finishes with
 * the expense and
 *   tracks scenarios that move `end`. Under it the floor sub-section is meaningless (a floor after the expense's end
 * never applies)   and is disabled.
 */
export type GlideAnchor =
  | { kind: 'retirementStart' }
  | { kind: 'age'; memberId?: HouseholdRole; years: number; months: number }
  | { kind: 'year'; year: number }
  | { kind: 'durationFromExpenseStart'; months: number }
  | { kind: 'expenseEnd' };

/**
 * Prototype-pollution-dangerous keys (CWE-1321), shared by the `categoryRates` migration sanitiser
 * (`db/migrations.ts`), the inflation resolver (`lib/scenario-resolution.ts`) and the medical-id resolver
 * (`lib/expense-category-resolvers.ts`): a category id matching one must never reach a plain-object `categoryRates` map
 * or the report's indexing. Lives here, the lowest-level module, so `db/migrations.ts` imports it without a `db ← lib ←
 * db` cycle.
 */
export const DANGEROUS_CATEGORY_RATE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

// Local-only stores, never synced.

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
   * The server's push-rejection reason, persisted so the inspector can say why a conflict is stuck; mirrors
   * `PushedMutationRejected.reason`. An off-allowlist wire reason persists as absent, never a raw string; a status
   * write without a reason clears a stale one (`updateMutationStatus`). Additive optional: the `mutations` queue is a
   * local non-aggregate store, so no version bump.
   */
  reason?: 'CONFLICT' | 'NOT_FOUND' | 'SCHEMA_MISMATCH';
  /**
   * The server's true version at rejection time, persisted on a parked `failed-conflict` row so the Resolve UI can
   * re-base the kept edit without a round-trip. Additive optional; absent on a `pending` row and on a legacy conflict.
   */
  currentVersion?: number;
  /**
   * The server row's `updatedAt` at rejection time, persisted with `currentVersion` for the Resolve UI's "changed on
   * server at …" line. Additive optional; absent on a `pending` row and a legacy conflict.
   */
  currentUpdatedAt?: string;
}

export interface DeviceMetadata {
  deviceId: string;
  syncCursor: string;
  lastSyncedAt: string | null;
  displayName: string;
  /**
   * Server-echoed freshness counter this device pins against future sync responses; absent until the first encrypted
   * round-trip stores a head.
   */
  freshnessCounter?: number;
  /**
   * Pinned envelope-set version: a served slot set strictly below it is a rollback (`isEnvelopeSetRollback`); a
   * verified set advances it to `max(pin, served)`. Absent: no pin yet, any non-negative version is accepted (TOFU).
   * Reset only by trusted destructive local resets (a full IDB drop or account delete destroys `deviceMetadata`).
   */
  envelopeSetVersion?: number;
  /**
   * Per-device, bounded record of rows that failed to decrypt on pull/bootstrap (identity, version, first-seen; never
   * ciphertext); see `sync/quarantine.ts`. Absent: nothing quarantined.
   */
  quarantinedRows?: QuarantinedSyncRow[];
}

/**
 * A sync row quarantined for failing to decrypt; declared here as the `deviceMetadata` row shape and re-exported by
 * `sync/quarantine.ts`.
 */
export interface QuarantinedSyncRow {
  aggregateId: string;
  aggregateType: string;
  version: number;
  firstSeenAt: number;
}

/**
 * Per-device pointer to the scenario driving consuming pages; a singleton row in the local `selectedScenario` store,
 * never synced.
 */
export interface SelectedScenario {
  scenarioId: string;
  updatedAt: string;
}
