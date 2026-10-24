// Expense-category and expense payloads plus the per-expense glide shape; schedule/anchor vocabulary is in `aggregate-base.ts`.

import type { GlideAnchor, ScheduleEnd, ScheduleStart } from './aggregate-base';

/**
 * Expense category, household-keyed, one row per category; eight defaults are seeded on first post-bootstrap render.
 */
export interface ExpenseCategoryPayload extends Record<string, unknown> {
  /** Required, max 40, unique within household (case-folded, trimmed). */
  name: string;
  /**
   * Marks the category as medical, which carries the `general + DEFAULT_MEDICAL_INFLATION_SPREAD_PCT` inflation
   * default. The persisted flag, not the seeded `cat-medical` id, is the canonical signal, so a recreated Medical
   * category keeps the behaviour. Absent means not medical; read only through `medicalCategoryIdsFrom`
   * (`expense-category-resolvers.ts`), which owns the strict `=== true` check.
   */
  isMedical?: boolean;
}

/**
 * Default category names, in alphabetical render order, seeded as separate `create` mutations on first post-bootstrap
 * render.
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

export type ExpenseFrequency =
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'yearly'
  | 'oneOff';

export type ExpenseClassification = 'essential' | 'discretionary';

/**
 * Per-expense spending glide: real-terms spending rises or falls as the household ages (a fall is the go-go, slow-go,
 * no-go decline; a rise models escalating costs such as later-life care), for any classification. Absent means flat
 * real spend. The stored name `discretionaryGlide` is kept, with no migration, though it applies to any classification.
 * The curve, on the expense's own glide clock: flat 100% before `glideStart`, linear to `endMultiplierPct` at
 * `glideEnd`, flat there until any plateau anchor, then a step to `floor.multiplierPct` from `floor.anchor`. It
 * composes multiplicatively with the discretionary adjustment (discretionary-only) and the inflation factor. `floor` is
 * direction-aware: a floor for a decline (`endMultiplierPct < 100`), a ceiling for a rise. Save-time validation: every
 * anchor resolves (an `age` anchor needs `years > 0`), glide-end falls strictly after glide-start and the plateau
 * anchor strictly after glide-end, the plateau percentage sits on the far side of `endMultiplierPct` for the direction,
 * and both percentages clamp to 0-200. `endMultiplierPct: 100` with no effective floor is a no-op; a scenario patch
 * that clears an inherited glide writes a `null` clear-marker instead (see `PatchWithClears`).
 */
export interface DiscretionaryGlideOverride {
  /** 0-200, clamped; `<100` declines, `100` is neutral, `>100` rises (up to 2x). */
  endMultiplierPct: number;
  glideStart: GlideAnchor;
  glideEnd: GlideAnchor;
  /**
   * Post-glide-end plateau: a floor (`multiplierPct <= endMultiplierPct`) for a decline, a ceiling (`>=`) for a rise.
   */
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
  /** Optional spending glide (see `DiscretionaryGlideOverride`); absent means flat real spend. */
  discretionaryGlide?: DiscretionaryGlideOverride;
  /**
   * HSA-qualified medical expense; absent means not qualified (conservative). Meaningful only under an `isMedical`
   * category. Strict `=== true` check (CWE-20) in `isHsaQualifiedMedical` (`lib/expense-category-resolvers.ts`); never
   * read raw.
   */
  hsaQualified?: boolean;
}
