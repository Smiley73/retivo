/**
 * Expense-category + expense aggregate payloads, plus the per-expense
 * discretionary-glide shape. The cross-aggregate schedule/anchor vocabulary
 * (`ScheduleStart` / `ScheduleEnd` / `GlideAnchor` / `HouseholdRole`) lives in
 * `aggregate-base.ts`.
 */

import type { GlideAnchor, ScheduleEnd, ScheduleStart } from './aggregate-base';

/**
 * Expense category aggregate. Household-keyed; one row per category.
 * Seeded with eight defaults on first post-bootstrap render.
 */
export interface ExpenseCategoryPayload extends Record<string, unknown> {
  /** Required, max 40, unique within household (case-folded, trimmed). */
  name: string;
  /**
   * Optional generic "medical" marker (schemaVersion 2). When `true` the
   * category carries the medical special-casing — today the
   * `general + DEFAULT_MEDICAL_INFLATION_SPREAD_PCT` inflation default. The
   * persisted flag (not the seeded `cat-medical` id) is the canonical "is
   * this medical?" signal, so a deleted-and-recreated Medical category keeps
   * its medical behaviour. Absent ⇒ not medical. The strict `=== true`
   * normalisation lives ONLY in `medicalCategoryIdsFrom`
   * (`expense-category-resolvers.ts`); never read this raw boolean directly.
   */
  isMedical?: boolean;
}

/**
 * Default category names seeded on first post-bootstrap render.
 * Order is the alphabetical render order; the seed inserts each as a
 * separate `create` mutation (matching the auto-base-scenario pattern).
 */
export const DEFAULT_EXPENSE_CATEGORIES: readonly string[] = [
  'Entertainment',
  'Food',
  'Housing',
  'Insurance',
  'Medical',
  'Other',
  'Transportation',
  'Utilities',
] as const;

/**
 * Retirement expense aggregate. Household-keyed; one row per expense.
 */
export type ExpenseFrequency =
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'yearly'
  | 'oneOff';

export type ExpenseClassification = 'essential' | 'discretionary';

/**
 * Per-expense optional canonical field modelling the retirement
 * spending glide: this expense's real-terms spending rises or falls as
 * the household ages (a fall is the classic go-go → slow-go → no-go
 * decline; a rise models escalating costs such as later-life care).
 * Classification-agnostic — applies to essential and discretionary
 * expenses alike. Absent (the default) ⇒ flat real spend for the
 * expense, engine output byte-identical to before. Overridable per
 * scenario through the shared expense editor like any other
 * `ExpensePayload` key. (The stored field name `discretionaryGlide` is
 * retained for forward-compat — no migration — though it now applies to
 * any classification.)
 *
 * The curve, evaluated against the expense's own glide clock: flat 100%
 * before `glideStart` → linear interpolation to `endMultiplierPct` at
 * `glideEnd` → flat at `endMultiplierPct` (until any plateau anchor) →
 * step to `floor.multiplierPct` from `floor.anchor` onward. Composes
 * independent-multiplicatively with the discretionary adjustment
 * (discretionary-only) and the inflation factor.
 *
 * `floor` is direction-aware: a *floor* (second, lower plateau) for a
 * declining glide (`endMultiplierPct < 100`), a *ceiling* (higher
 * plateau capping the rise) for a rising glide (`endMultiplierPct >
 * 100`) — the same field reinterpreted by direction, no schema change.
 *
 * Save-time validation: every anchor must resolve (an `age` anchor with
 * `years <= 0` on glide-start / glide-end / floor is rejected); the
 * glide-end anchor must resolve strictly after glide-start; the plateau
 * percentage is `≤ endMultiplierPct` for a decline and `≥
 * endMultiplierPct` for a rise; and the plateau anchor must resolve
 * strictly after the glide-end anchor. Both percentages clamp to 0–200
 * (`<100` declines, `>100` rises). The UI labels `endMultiplierPct` /
 * `floor.multiplierPct` as "End percentage" / "Floor (or Ceiling)
 * percentage"; the stored field names are unchanged.
 *
 * A value with `endMultiplierPct: 100` and no effective floor/ceiling
 * (floor absent, or `floor.multiplierPct: 100`) is a mathematical no-op
 * (the engine multiplier is `1` every active month). A scenario patch
 * that clears an inherited glide no longer stores this neutral — it
 * writes a `null` clear-marker on the `discretionaryGlide` key (the
 * resolver drops it → engine default; see `PatchWithClears`).
 */
export interface DiscretionaryGlideOverride {
  /** 0–200, clamped; `<100` declines, `100` is neutral, `>100` increases
   *  (up to 2× the entered amount). */
  endMultiplierPct: number;
  glideStart: GlideAnchor;
  glideEnd: GlideAnchor;
  /** Post-glide-end plateau, direction-aware: a *floor* (`multiplierPct
   *  ≤ endMultiplierPct`) for a declining glide, a *ceiling*
   *  (`multiplierPct ≥ endMultiplierPct`) for a rising one. */
  floor?: { multiplierPct: number; anchor: GlideAnchor };
}

export interface ExpensePayload extends Record<string, unknown> {
  /** Required, max 60, unique within household (case-folded, trimmed). */
  name: string;
  /** Optional single-line, max 200; surfaces under name in the list. */
  description?: string;
  /** Required, ≥ 0. Two decimals. Stored in dollars. */
  amount: number;
  frequency: ExpenseFrequency;
  classification: ExpenseClassification;
  /** References an ExpenseCategory aggregate id. */
  categoryId: string;
  start: ScheduleStart;
  /** Required iff frequency !== 'oneOff'; absent for one-off events. */
  end?: ScheduleEnd;
  /**
   * Optional per-expense spending glide (rise or fall over retirement).
   * Absent ⇒ flat real spend (engine output byte-identical). Read for any
   * classification (essential or discretionary); the stored field
   * name is retained for forward-compat. See `DiscretionaryGlideOverride`.
   * Absent on a freshly created expense unless the user enables the glide.
   */
  discretionaryGlide?: DiscretionaryGlideOverride;
  /**
   * Whether this expense can be paid tax-free from an HSA.
   * Sparse-optional — **absent ⇒ NOT HSA-qualified** (conservative default).
   * Only meaningful for expenses whose `categoryId` resolves to an
   * `isMedical`-flagged category; the engine ignores this flag on non-medical
   * rows. Strict `=== true` check (CWE-20): any imported non-boolean value
   * reads as not-qualified. Consumer entry-point: `isHsaQualifiedMedical` in
   * `lib/expense-category-resolvers.ts` — no consumer reads this raw.
   */
  hsaQualified?: boolean;
}
