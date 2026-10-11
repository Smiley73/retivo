/**
 * Filing-status derivation helper AND the year/member filing-plan resolver.
 *
 * Two layers live here:
 *
 * 1. `deriveFilingStatus` — the legacy scalar helper. Derives a single
 *    `FilingStatus` for a household given a scenario context. The scenario's
 *    scalar `filingStatus` override takes precedence over the household
 *    composition rule. HoH is only available via explicit override (no
 *    automatic HoH detection — the household model lacks child/dependent
 *    tracking). This is the frozen, transition-UNSAFE path the tax engines
 *    still call; it is retained unchanged for backward callers.
 *
 * 2. `resolveFilingPlanForYear` — the transition-safe filing-plan resolver.
 *    It consumes a scenario's `taxFilingPlan` when present
 *    and otherwise derives a filing-plan VIEW from the legacy scalar via an
 *    explicit scalar × household-cardinality matrix (see `resolveFromScalar`).
 *    Both engines resolve every projection year through it and hand the
 *    resulting tax units to `applyTaxYearForFilingPlan`. It never guesses: an ambiguous
 *    legacy scalar (a two-member `Single`/`HoH`, a one-member `MFJ`, or an
 *    unknown scalar value) — or a stored plan that is corrupt or no longer
 *    matches the household (a one-person plan on a couple that has since added a
 *    spouse) — resolves to an explicit `unresolved` result, and the
 *    engines then keep the legacy scalar path while the scenario editor prompts
 *    the user to resolve it — rather than silently dropping a spouse's tax unit.
 *
 * Stored-shape note: the legacy scalar maps to a plan as follows. A one-member
 * household's `Single` files `Single`; its `HoH` becomes an open-ended `HoH`
 * window; its `MFJ` is invalid (joint filing needs a spouse). A two-member
 * household's `MFJ` files joint while both spouses are alive (including the
 * death year), then `Single`; its `Single` / `HoH` is ambiguous (it does not say
 * how each spouse files). Invalid and ambiguous combinations are `unresolved`.
 */

import type { ScheduleStart, ScheduleEnd } from '../db/types/aggregate-base';
import type { FilingStatus } from './federal-tax';

/** Override shape stored in ScenarioOverrides.filingStatus (legacy scalar). */
export type FilingStatusOverride = 'MFJ' | 'Single' | 'HoH';

export interface FilingStatusContext {
  /** True when the primary household member is alive in the projection year. */
  primaryAlive: boolean;
  /** True when the secondary household member is alive in the projection year. */
  secondaryAlive: boolean;
  /** Scenario-level override, if any. */
  filingStatusOverride?: FilingStatusOverride;
}

/**
 * Derive the FilingStatus to use for tax computations.
 *
 * Logic:
 * 1. If `filingStatusOverride` is set, use it (no validation — caller
 *    is responsible for surfacing HoH limitations to the user).
 * 2. Otherwise: MFJ when both members are alive; Single when only one is alive
 *    (year-of-death+1 surviving spouse auto-defaults to Single — tax-conservative).
 *
 * This legacy scalar derivation excludes MFS/QSS (rare, usually
 * disadvantageous) — its automatic
 * derivation (step 2) yields only MFJ or Single, and HoH is reachable solely
 * via explicit override (step 1); it never emits MFS/QSS. The federal tax
 * engine itself now computes MFS/QSS (see TaxUnitFilingStatus below); this
 * function is the frozen scalar path, unrelated to that broader per-unit
 * support.
 */
export function deriveFilingStatus(ctx: FilingStatusContext): FilingStatus {
  if (ctx.filingStatusOverride !== undefined) {
    return ctx.filingStatusOverride;
  }
  return ctx.primaryAlive && ctx.secondaryAlive ? 'MFJ' : 'Single';
}

// ---------------------------------------------------------------------------
// Filing plan — types + resolver.
//
// These types are co-located with the resolver (their primary consumer) and
// with `FilingStatusOverride`; `ScenarioOverrides.taxFilingPlan` imports
// `TaxFilingPlan` from here, exactly as it already imports `FilingStatusOverride`.
// They cannot live in `db/types/scenario-overrides.ts` because that module
// imports this one — the reverse edge would be a type-only import CYCLE, which
// `.dependency-cruiser.cjs` `no-circular` rejects as an error.
// ---------------------------------------------------------------------------

/**
 * Federal filing statuses a tax unit may carry within a filing plan. `MFS`
 * and `QSS` are fully computable by the tax engines (federal-tax.ts,
 * irmaa.ts, ss-taxation.ts, aca-ptc.ts) and PRODUCTION-REACHABLE:
 * `applyTaxYearForFilingPlan` applies the per-year engine per resolved tax
 * unit, so a `separate` plan reaches MFS and a survivor `statusWindow` reaches
 * QSS.
 */
export type TaxUnitFilingStatus = 'Single' | 'MFJ' | 'MFS' | 'HoH' | 'QSS';

/**
 * One user-entered filing-status window. A YEAR-BOUNDED window overlays the base
 * status the plan files otherwise in its covered tax years — e.g. a surviving
 * spouse's `QSS` dependent years, or an eligible `HoH` window. It never overrides
 * a live `MFJ`/`separate` (both-spouses-alive) year; exceptions apply only to the
 * post-death survivor's (or a one-person plan's) own return, and they outrank the
 * plan's STANDING status whatever order the two are stored in.
 *
 * An OPEN-ENDED window (`openEndedStatusWindow`) is not an exception at all: it is
 * how a plan expresses its standing filing status for every year.
 *
 * Reuses the STATIC `age` / `year` anchor kinds shared across the overrides file
 * (an older client seeing an unknown future kind ignores the entry). `end` is
 * EXCLUSIVE, matching `MagiCapWindow` — the window covers `[startYear, endYear)`
 * with anchors collapsed to whole tax years. An `age` anchor whose member's
 * birth year is not supplied to the resolver is treated as inactive (never
 * guessed).
 */
export interface FilingStatusWindow {
  readonly status: TaxUnitFilingStatus;
  readonly start: Extract<ScheduleStart, { kind: 'age' | 'year' }>;
  readonly end: Extract<ScheduleEnd, { kind: 'age' | 'year' }>;
}

/**
 * One tax unit inside a `separate` filing plan: a single spouse filing on their
 * own return, with the federal filing status and tax-household size that return
 * uses. `householdSize` is the return's tax-family count (drives FPL / PTC and
 * bracket selection). `applyTaxYearForFilingPlan` runs the
 * complete per-year engine once per unit.
 */
export interface FilingPlanTaxUnit {
  /** Which household member files this unit. */
  readonly memberId: 'primary' | 'secondary';
  /** Federal filing status this unit files under while active. */
  readonly filingStatus: TaxUnitFilingStatus;
  /** Tax-household (return) size for this unit. Positive integer. */
  readonly householdSize: number;
}

/**
 * Individual (single-member) filing plan: no spouse. Files `Single` every year;
 * optional `statusWindows` apply eligible `HoH` (or other) years on top.
 */
export interface IndividualFilingPlan {
  readonly kind: 'individual';
  readonly statusWindows?: readonly FilingStatusWindow[];
}

/**
 * Joint (married-couple) filing plan. Files `MFJ` while BOTH spouses are alive,
 * INCLUDING the year a spouse dies (death-year joint treatment — the dying
 * member counts as alive in their death year), then `Single` for later years.
 * The frozen scalar `filingStatus: 'MFJ'` could not express that post-death
 * transition and would keep filing `MFJ` forever. Optional `statusWindows` carry user-entered survivor exceptions
 * (`QSS` dependent years, later `HoH`) that override the post-death `Single`
 * default in their covered years.
 */
export interface JointFilingPlan {
  readonly kind: 'joint';
  readonly statusWindows?: readonly FilingStatusWindow[];
}

/**
 * Separate filing plan: both spouses alive but filing as two independent tax
 * units (e.g. MFS), each with its own status and tax-household size. After a
 * death the surviving unit follows the same post-death rule as the joint plan
 * (`Single`, unless a `statusWindow` says otherwise).
 */
export interface SeparateFilingPlan {
  readonly kind: 'separate';
  readonly units: readonly [FilingPlanTaxUnit, FilingPlanTaxUnit];
  readonly statusWindows?: readonly FilingStatusWindow[];
  /**
   * §86(c)(1)(C)(ii) — whether the spouses lived together at any time during
   * the tax year while filing separately. When true, an `MFS` unit's Social
   * Security base amounts are both $0, so its benefits are taxable from the
   * first dollar, and IRMAA uses the steeper married-filing-separately tier
   * schedule. Sparse-optional: absent → lived apart, which is the
   * lower-tax reading, so it is collected explicitly in the filing editor
   * rather than inferred. Only consulted while both spouses are alive.
   */
  readonly livedTogether?: boolean;
}

/**
 * Scenario-level tax filing plan. Sparse-optional on `ScenarioOverrides`; a
 * discriminated union over the household shape. Expressive enough to represent
 * every filing case: joint while both
 * alive, separate tax units, death-year joint treatment, post-death `Single`,
 * and year-bounded `QSS`/`HoH` exceptions.
 */
export type TaxFilingPlan =
  | IndividualFilingPlan
  | JointFilingPlan
  | SeparateFilingPlan;

/** A single tax unit's resolved filing status for one projection year. */
export interface ResolvedTaxUnit {
  /** Household member(s) composing the unit for this year. */
  readonly memberIds: readonly ('primary' | 'secondary')[];
  /** Federal filing status the unit files under this year. */
  readonly filingStatus: TaxUnitFilingStatus;
  /** Tax-household (return) size, when the plan carries one (separate units). */
  readonly householdSize?: number;
}

/**
 * Why a filing-plan year could not be resolved from the legacy scalar. Each is
 * surfaced in the scenario filing editor for the user to resolve rather than
 * guessed; the engines keep the legacy scalar path meanwhile.
 */
export type FilingPlanUnresolvedReason =
  /** Two-member household with a `Single`/`HoH` scalar — which spouse's unit is
   *  dropped is genuinely ambiguous; never silently drop a spouse's tax unit. */
  | 'two-member-scalar-ambiguous'
  /** One-member household with an `MFJ` scalar — joint filing needs a spouse. */
  | 'one-member-joint-invalid'
  /** Scalar value outside the known `MFJ`/`Single`/`HoH` set. */
  | 'unknown-scalar'
  /** Plan `kind` outside the known `individual`/`joint`/`separate` set (a newer
   *  client's plan kind or corrupt data reaching this older resolver). */
  | 'unknown-plan-kind'
  /** Plan `kind` is known but the payload cannot be used for this household —
   *  either structurally invalid (a `separate` plan whose `units` are missing /
   *  not an exact primary+secondary pair, or a malformed `statusWindows` entry)
   *  or written for a DIFFERENT household composition (an `individual`
   *  plan on a household that has since gained a spouse). Never
   *  dereferenced or applied blindly: the year routes to the legacy-scalar fallback
   *  instead of crashing the whole projection or silently dropping a spouse's
   *  tax unit. */
  | 'invalid-plan-shape';

/** Result of resolving a filing plan for a single projection year. */
export type FilingPlanResolution =
  | { readonly kind: 'resolved'; readonly taxUnits: readonly ResolvedTaxUnit[] }
  | { readonly kind: 'unresolved'; readonly reason: FilingPlanUnresolvedReason; readonly detail: string };

export interface FilingPlanContext {
  /** Scenario's stored filing plan. When present it supersedes the scalar. */
  readonly taxFilingPlan?: TaxFilingPlan;
  /** Legacy scalar override. Used only when no plan is set; the scenario filing
   *  editor converts it to a plan the first time the user edits filing. */
  readonly filingStatusOverride?: FilingStatusOverride;
  /** True when the household has a secondary member (a couple); false = individual. */
  readonly hasSecondaryMember: boolean;
  /** True when the primary member is alive in the projection year (death year counts as alive). */
  readonly primaryAlive: boolean;
  /** True when the secondary member is alive in the projection year (death year counts as alive). */
  readonly secondaryAlive: boolean;
  /** The projection (calendar) tax year — resolves year-bounded `statusWindows`. */
  readonly taxYear: number;
  /** Primary member's birth year — resolves `age`-anchored windows. Absent → age windows inactive. */
  readonly primaryBirthYear?: number;
  /** Secondary member's birth year — resolves `age`-anchored windows. Absent → age windows inactive. */
  readonly secondaryBirthYear?: number;
}

/** Every filing status a stored plan may legitimately carry. */
const KNOWN_UNIT_STATUSES: ReadonlySet<string> = new Set<TaxUnitFilingStatus>([
  'Single',
  'MFJ',
  'MFS',
  'HoH',
  'QSS',
]);

/**
 * Why one `statusWindows` entry cannot be used, or `undefined` when it carries
 * every field the resolver and the summary formatters read.
 *
 * Both the VALIDATION path (`invalidPlanShapeDetail`, which turns a malformed
 * window into an `unresolved` result) and the FORMATTING path
 * (`summarizeFilingPlan`, which builds the report card and the PDF settings
 * table) ask this one question, so a window the resolver rejects can never reach
 * `describeFilingStatusWindow` and throw on a missing anchor mid-report.
 */
function invalidStatusWindowDetail(w: unknown): string | undefined {
  if (typeof w !== 'object' || w === null || Array.isArray(w)) {
    return 'A filing-plan exception window is not an object.';
  }
  const entry = w as Partial<FilingStatusWindow>;
  if (typeof entry.status !== 'string' || !KNOWN_UNIT_STATUSES.has(entry.status)) {
    return `A filing-plan exception window carries an unknown status '${String(entry.status)}'.`;
  }
  for (const anchor of [entry.start, entry.end]) {
    if (typeof anchor !== 'object' || anchor === null) {
      return 'A filing-plan exception window is missing a start or end year.';
    }
    const a = anchor as { kind?: unknown; year?: unknown; years?: unknown };
    if (a.kind === 'year' && typeof a.year === 'number') continue;
    if (a.kind === 'age' && typeof a.years === 'number') continue;
    return `A filing-plan exception window has an unusable anchor of kind '${String(a.kind)}'.`;
  }
  return undefined;
}

/** True when `w` carries every field the window formatters dereference. */
function isWellFormedStatusWindow(w: unknown): w is FilingStatusWindow {
  return invalidStatusWindowDetail(w) === undefined;
}

/**
 * Structural validation of a KNOWN-kind `taxFilingPlan` payload.
 *
 * `taxFilingPlan` is user/sync data with no runtime schema behind it, so every
 * field the resolver dereferences is validated first: a `separate` plan must
 * carry exactly two units forming an exact `primary`+`secondary` BIJECTION (a
 * duplicate owner would double-count that spouse's accounts; an omitted owner
 * would silently drop the other spouse — the exact outcome the unknown-kind
 * guard exists to prevent), and every `statusWindows` entry must carry a known
 * status plus a resolvable `age`/`year` anchor on both ends.
 *
 * @returns `undefined` when the payload is well-formed, else the human-readable
 *          reason it is not (the caller turns it into an `unresolved` result,
 *          which routes the year to the legacy fallback rather than throwing).
 */
function invalidPlanShapeDetail(plan: TaxFilingPlan): string | undefined {
  const windows = (plan as { statusWindows?: unknown }).statusWindows;
  if (windows !== undefined) {
    if (!Array.isArray(windows)) return 'Filing-plan exception windows are not a list.';
    for (const w of windows as readonly unknown[]) {
      const windowProblem = invalidStatusWindowDetail(w);
      if (windowProblem !== undefined) return windowProblem;
    }
  }
  if (plan.kind !== 'separate') return undefined;
  const units = (plan as { units?: unknown }).units;
  if (!Array.isArray(units) || units.length !== 2) {
    return 'A separate-returns filing plan must carry exactly two returns, one per spouse.';
  }
  const roles = new Set<string>();
  for (const u of units as readonly unknown[]) {
    if (typeof u !== 'object' || u === null) return 'A separate return entry is not an object.';
    const unit = u as Partial<FilingPlanTaxUnit>;
    if (unit.memberId !== 'primary' && unit.memberId !== 'secondary') {
      return `A separate return is assigned to an unknown spouse '${String(unit.memberId)}'.`;
    }
    if (roles.has(unit.memberId)) {
      return `Both separate returns are assigned to the same spouse ('${unit.memberId}').`;
    }
    roles.add(unit.memberId);
    if (typeof unit.filingStatus !== 'string' || !KNOWN_UNIT_STATUSES.has(unit.filingStatus)) {
      return `A separate return carries an unknown filing status '${String(unit.filingStatus)}'.`;
    }
    if (
      typeof unit.householdSize !== 'number' ||
      !Number.isInteger(unit.householdSize) ||
      unit.householdSize < 1
    ) {
      return `A separate return carries an invalid number of people (${String(unit.householdSize)}).`;
    }
  }
  return undefined;
}

/**
 * True when the stored value is an OBJECT at all, before any `.kind` read.
 *
 * `taxFilingPlan` is untrusted user/sync data with no runtime schema behind it,
 * so its declared type is a compile-time claim only: a corrupt `null`, a JSON
 * array, or a bare string can all reach the resolver and the editor. Reading
 * `.kind` off `null` throws a `TypeError` that takes down the whole projection
 * (and the very editor tab the resolution prompt links to) instead of falling back —
 * so the object check runs first and everything else routes to the legacy-scalar fallback.
 */
function isPlanObject(plan: unknown): plan is TaxFilingPlan {
  return typeof plan === 'object' && plan !== null && !Array.isArray(plan);
}

/** Plain-English name for a corrupt stored value's shape (never dereferences it). */
function describeStoredPlanShape(plan: unknown): string {
  if (plan === null) return 'an empty value';
  if (Array.isArray(plan)) return 'a list';
  return `a ${typeof plan} value`;
}

/** True for a plan `kind` this resolver understands. Anything else — including a
 *  non-object payload — is a newer client's plan kind or corrupt data. */
function isKnownPlanKind(plan: unknown): plan is TaxFilingPlan {
  if (!isPlanObject(plan)) return false;
  const kind = (plan as { kind?: unknown }).kind;
  return kind === 'individual' || kind === 'joint' || kind === 'separate';
}

/**
 * The stored plan describes a DIFFERENT household than the one that
 * exists now.
 *
 * Household composition is editable AFTER a filing plan is saved, so an
 * `individual` plan written while the user was the only member survives verbatim
 * once a spouse is added. Resolved literally it would file ONE `Single` return
 * for the whole couple every year — the narrower single schedule and deduction,
 * applied silently, with the summary reporting it as "resolved". Report it as
 * unresolvable instead: the year takes the legacy-scalar fallback and the filing
 * editor asks how the two of them file.
 *
 * The mirror case (a `joint` / `separate` plan whose spouse was REMOVED) needs no
 * guard — with no secondary member the per-year alive-state already collapses
 * both kinds to the sole member's `Single` survivor unit, which is the correct
 * treatment for a one-person household.
 *
 * @returns `undefined` when the plan matches the household, else the
 *          human-readable reason it does not.
 */
function planHouseholdMismatchDetail(
  plan: TaxFilingPlan,
  hasSecondaryMember: boolean,
): string | undefined {
  if (plan.kind === 'individual' && hasSecondaryMember) {
    return 'The saved filing choice covers one person on their own, but this household now includes a spouse, so it does not say how the two of you file.';
  }
  return undefined;
}

/**
 * True when `plan` is a stored filing plan this household can actually be
 * projected on: a known `kind`, a structurally valid payload, and a shape
 * that matches the household's CURRENT membership.
 *
 * The scenario filing editor asks this before opening on a stored plan —
 * its controls index `units[0]`/`units[1]` directly, so a corrupt payload would
 * crash the very tab the resolution prompt links to. Sharing this predicate with
 * `resolveFilingPlanForYear` keeps ONE definition of "usable plan": the editor
 * cannot open on a plan the engines refuse, nor reject one they accept.
 */
export function isWellFormedFilingPlan(
  plan: unknown,
  hasSecondaryMember: boolean,
): plan is TaxFilingPlan {
  // `unknown` rather than `TaxFilingPlan | undefined` on purpose: the
  // stored value's declared type is a compile-time claim about untrusted data,
  // and this predicate is the boundary that turns it into a checked fact.
  if (!isKnownPlanKind(plan)) return false;
  if (invalidPlanShapeDetail(plan) !== undefined) return false;
  return planHouseholdMismatchDetail(plan, hasSecondaryMember) === undefined;
}

// ---------------------------------------------------------------------------
// Standing (open-ended) vs year-bounded exception windows.
//
// `statusWindows` carries two DIFFERENT kinds of entry — the plan's standing
// filing status (an open-ended window covering every tax year) and the
// year-bounded exceptions that overlay it — so the resolver, the filing editor,
// and the summary formatters all read them through the helpers below rather than
// re-deriving "which one is the standing status" three times.
// ---------------------------------------------------------------------------

/**
 * Bounds of an OPEN-ENDED status window — one that covers every tax year any
 * projection can reach. `end` is EXCLUSIVE, so year 9999 is effectively
 * unbounded, and the start predates every modeled year including the IRMAA
 * two-year look-back.
 *
 * This is how a plan expresses "files this status every year" for a household
 * whose plan kind carries no status of its own — notably a one-member household
 * whose legacy scalar was `HoH`, which the resolver's conversion matrix
 * maps to an open-ended HoH plan.
 */
const OPEN_ENDED_WINDOW_START_YEAR = 1900;
const OPEN_ENDED_WINDOW_END_YEAR = 9999;

/** An open-ended (every-year) window for `status`. */
export function openEndedStatusWindow(status: TaxUnitFilingStatus): FilingStatusWindow {
  return {
    status,
    start: { kind: 'year', year: OPEN_ENDED_WINDOW_START_YEAR },
    end: { kind: 'year', year: OPEN_ENDED_WINDOW_END_YEAR },
  };
}

/** True when `w` is an open-ended (every-year) window — the plan's standing
 *  filing status rather than a year-bounded survivor exception. */
export function isOpenEndedStatusWindow(w: FilingStatusWindow): boolean {
  return (
    w.start.kind === 'year' &&
    w.start.year <= OPEN_ENDED_WINDOW_START_YEAR &&
    w.end.kind === 'year' &&
    w.end.year >= OPEN_ENDED_WINDOW_END_YEAR
  );
}

/**
 * The plan's STANDING filing status: the status every year files unless a
 * year-bounded exception window covers it, or `Single` when the plan carries no
 * open-ended window.
 *
 * ONE definition, shared by the resolver's fallback, the filing editor's helper
 * copy, and the report/PDF summary sentence — so no surface can describe a
 * standing status the engines do not actually file.
 * `windows` must already be well-formed (`isWellFormedStatusWindow`).
 */
export function standingFilingStatus(
  windows: readonly FilingStatusWindow[] | undefined,
): TaxUnitFilingStatus {
  return windows?.find(isOpenEndedStatusWindow)?.status ?? 'Single';
}

function anchorYear(
  anchor: Extract<ScheduleStart, { kind: 'age' | 'year' }> | Extract<ScheduleEnd, { kind: 'age' | 'year' }>,
  ctx: FilingPlanContext,
): number | undefined {
  if (anchor.kind === 'year') return anchor.year;
  // `age` anchor: birthYear + years (whole tax year; months collapsed, matching
  // MagiCapWindow). memberId defaults to the primary member.
  const birthYear = anchor.memberId === 'secondary' ? ctx.secondaryBirthYear : ctx.primaryBirthYear;
  return birthYear === undefined ? undefined : birthYear + anchor.years;
}

/**
 * The `status` that applies in `ctx.taxYear`, or `undefined` when no window
 * covers it.
 *
 * A year-bounded EXCEPTION window outranks the plan's STANDING open-ended
 * window whatever order the two are stored in. A standing window covers every tax
 * year, so scanning stored order alone let it shadow every exception behind it:
 * a one-person head-of-household plan that visibly accepted a two-year
 * qualifying-surviving-spouse window kept filing head of household through those
 * years, with the editor showing an exception row (and its statutory warning) that
 * changed nothing and no error anywhere. Exceptions OVERLAY the base the plan
 * files otherwise, so they are matched
 * first and the standing window is the fallback. Among overlapping exceptions the
 * earliest stored one still wins.
 */
function matchingWindowStatus(
  windows: readonly FilingStatusWindow[] | undefined,
  ctx: FilingPlanContext,
): TaxUnitFilingStatus | undefined {
  if (!windows) return undefined;
  let standing: TaxUnitFilingStatus | undefined;
  for (const w of windows) {
    const start = anchorYear(w.start, ctx);
    const end = anchorYear(w.end, ctx);
    if (start === undefined || end === undefined) continue;
    if (ctx.taxYear < start || ctx.taxYear >= end) continue;
    if (isOpenEndedStatusWindow(w)) {
      standing ??= w.status;
      continue;
    }
    return w.status;
  }
  return standing;
}

/** True when both spouses are alive this year (or the sole member is alive). */
function bothSpousesAlive(ctx: FilingPlanContext): boolean {
  return ctx.primaryAlive && ctx.secondaryAlive;
}

/** Post-death (or individual) survivor unit: `Single`, or a matching window. */
function survivorUnit(
  windows: readonly FilingStatusWindow[] | undefined,
  ctx: FilingPlanContext,
): ResolvedTaxUnit {
  const memberIds: ('primary' | 'secondary')[] = ctx.primaryAlive
    ? ['primary']
    : ctx.secondaryAlive
      ? ['secondary']
      : [];
  return { memberIds, filingStatus: matchingWindowStatus(windows, ctx) ?? 'Single' };
}

function resolveFromPlan(plan: unknown, ctx: FilingPlanContext): FilingPlanResolution {
  // The stored value may not be an object at all (a corrupt `null`, a
  // JSON array, a bare string). Check that BEFORE the `.kind` read below, which
  // would otherwise throw a `TypeError` and take down the whole projection
  // rather than routing the year to the legacy-scalar fallback.
  if (!isPlanObject(plan)) {
    return {
      kind: 'unresolved',
      reason: 'invalid-plan-shape',
      detail: `The saved filing choice is not readable (found ${describeStoredPlanShape(plan)}).`,
    };
  }
  // Defend against a corrupt / future `plan.kind` (a newer client's plan kind
  // synced to this older client, or corrupt IndexedDB data): surface it rather
  // than dereference `plan.units` on an unknown shape and throw (never
  // guess). Kept ahead of the all-deceased short-circuit so an unknown kind is
  // flagged even in an all-deceased year (never silently "resolves" to an empty
  // result). Mirrors `resolveFromScalar`'s `unknown-scalar`
  // defense, which likewise runs before its own all-deceased short-circuit.
  if (!isKnownPlanKind(plan)) {
    return {
      kind: 'unresolved',
      reason: 'unknown-plan-kind',
      detail: `Unknown filing-plan kind '${String((plan as { kind?: unknown }).kind)}'; expected one of individual, joint, separate.`,
    };
  }
  // The kind is known, but the payload is untrusted (IndexedDB / sync).
  // Validate every field this function dereferences BEFORE touching it, and
  // BEFORE the all-deceased short-circuit so a corrupt plan is surfaced even in
  // an all-deceased year (mirrors the unknown-kind guard above).
  const shapeProblem = invalidPlanShapeDetail(plan);
  if (shapeProblem !== undefined) {
    return { kind: 'unresolved', reason: 'invalid-plan-shape', detail: shapeProblem };
  }
  // The payload is well-formed but describes a household that no longer
  // exists (a one-person plan on a couple). Same guard placement, same reason:
  // never file one `Single` return for two people just because the plan predates
  // the spouse.
  const mismatch = planHouseholdMismatchDetail(plan, ctx.hasSecondaryMember);
  if (mismatch !== undefined) {
    return { kind: 'unresolved', reason: 'invalid-plan-shape', detail: mismatch };
  }
  // Nobody alive → no tax unit (projection has ended for this household).
  if (!ctx.primaryAlive && !ctx.secondaryAlive) {
    return { kind: 'resolved', taxUnits: [] };
  }
  if (plan.kind === 'individual') {
    return { kind: 'resolved', taxUnits: [survivorUnit(plan.statusWindows, ctx)] };
  }
  if (plan.kind === 'joint') {
    if (bothSpousesAlive(ctx)) {
      return {
        kind: 'resolved',
        taxUnits: [{ memberIds: ['primary', 'secondary'], filingStatus: 'MFJ' }],
      };
    }
    return { kind: 'resolved', taxUnits: [survivorUnit(plan.statusWindows, ctx)] };
  }
  // plan.kind === 'separate' (the only remaining kind after the top-of-function
  // known-kind guard).
  if (bothSpousesAlive(ctx)) {
    return {
      kind: 'resolved',
      taxUnits: plan.units.map((u) => ({
        memberIds: [u.memberId],
        filingStatus: u.filingStatus,
        householdSize: u.householdSize,
      })),
    };
  }
  // A death occurred: only the surviving unit remains, defaulting to Single.
  return { kind: 'resolved', taxUnits: [survivorUnit(plan.statusWindows, ctx)] };
}

const KNOWN_SCALARS: readonly FilingStatusOverride[] = ['MFJ', 'Single', 'HoH'];

function resolveFromScalar(
  scalar: FilingStatusOverride,
  ctx: FilingPlanContext,
): FilingPlanResolution {
  // Defend against a corrupt / future scalar value reaching the resolver: surface
  // it rather than guess. Kept ahead of the alive-state short-circuit so an
  // unknown value is flagged even in an all-deceased year.
  if (!KNOWN_SCALARS.includes(scalar)) {
    return {
      kind: 'unresolved',
      reason: 'unknown-scalar',
      detail: `Unknown legacy filing-status scalar '${String(scalar)}'; expected one of ${KNOWN_SCALARS.join(', ')}.`,
    };
  }
  // Validate the scalar × household-cardinality combination BEFORE the
  // all-deceased short-circuit: a KNOWN-INVALID/ambiguous combination stays
  // `unresolved` even in an all-deceased year (never silently "resolves" to an
  // empty result). Only a VALID
  // combination proceeds to the all-deceased short-circuit below.
  if (!ctx.hasSecondaryMember && scalar === 'MFJ') {
    // One-member MFJ is invalid — joint filing needs a spouse.
    return {
      kind: 'unresolved',
      reason: 'one-member-joint-invalid',
      detail: `Legacy scalar '${scalar}' cannot apply to a one-member household; a spouse is required for joint filing.`,
    };
  }
  if (ctx.hasSecondaryMember && (scalar === 'Single' || scalar === 'HoH')) {
    // Two-member Single / HoH is ambiguous — never silently drop a spouse's unit.
    return {
      kind: 'unresolved',
      reason: 'two-member-scalar-ambiguous',
      detail: `Legacy scalar '${scalar}' on a two-member household does not say how each spouse's tax unit is filed; resolve the filing plan explicitly.`,
    };
  }
  // Combination is valid (one-member Single/HoH, or two-member MFJ). Nobody
  // alive → no tax unit (projection has ended for this household).
  if (!ctx.primaryAlive && !ctx.secondaryAlive) {
    return { kind: 'resolved', taxUnits: [] };
  }
  if (!ctx.hasSecondaryMember) {
    // One-member household (scalar is Single or HoH here).
    if (scalar === 'Single') {
      return { kind: 'resolved', taxUnits: [survivorUnit(undefined, ctx)] };
    }
    // Open-ended HoH: HoH every year the sole member is alive.
    return {
      kind: 'resolved',
      taxUnits: [{ memberIds: ctx.primaryAlive ? ['primary'] : ['secondary'], filingStatus: 'HoH' }],
    };
  }
  // Two-member household (scalar is MFJ here): MFJ while both alive (incl. death
  // year), Single afterward.
  if (bothSpousesAlive(ctx)) {
    return {
      kind: 'resolved',
      taxUnits: [{ memberIds: ['primary', 'secondary'], filingStatus: 'MFJ' }],
    };
  }
  return { kind: 'resolved', taxUnits: [survivorUnit(undefined, ctx)] };
}

/**
 * Resolve the filing plan for a single projection year — the transition-safe
 * successor to `deriveFilingStatus`.
 *
 * Precedence:
 * 1. `taxFilingPlan` present → resolve from it (the authoritative shape).
 * 2. Else `filingStatusOverride` present → derive a plan view from the legacy
 *    scalar via the scalar × household-cardinality matrix (see
 *    `resolveFromScalar`). Ambiguous / invalid / unknown scalars return
 *    `unresolved` — never guessed.
 * 3. Else → derive from household composition alone: a couple files `MFJ` while
 *    both are alive (incl. the death year) then `Single`; a lone member files
 *    `Single`. This mirrors `deriveFilingStatus`'s no-override default.
 *
 * Both the deterministic runner and the Monte Carlo engine
 * call this once per projection year.
 */
export function resolveFilingPlanForYear(ctx: FilingPlanContext): FilingPlanResolution {
  if (ctx.taxFilingPlan !== undefined) {
    return resolveFromPlan(ctx.taxFilingPlan, ctx);
  }
  if (ctx.filingStatusOverride !== undefined) {
    return resolveFromScalar(ctx.filingStatusOverride, ctx);
  }
  // No plan, no scalar — derive from household composition.
  if (!ctx.primaryAlive && !ctx.secondaryAlive) {
    return { kind: 'resolved', taxUnits: [] };
  }
  if (ctx.hasSecondaryMember && bothSpousesAlive(ctx)) {
    return {
      kind: 'resolved',
      taxUnits: [{ memberIds: ['primary', 'secondary'], filingStatus: 'MFJ' }],
    };
  }
  return { kind: 'resolved', taxUnits: [survivorUnit(undefined, ctx)] };
}

// ---------------------------------------------------------------------------
// Shared filing-summary layer
//
// ONE resolver-backed description of a scenario's filing treatment, consumed by
// every surface that shows it: the scenario filing editor, the on-screen report
// card (`report-data.ts`), and the PDF settings table (`report-scenario-
// settings.ts`). Hand-written branch ladders per surface could disagree — an
// unresolved two-member `Single` scalar could read as "one joint return" on
// screen while the engine (and the PDF) filed `Single`.
// Deriving every surface from `resolveFilingPlanForYear`'s ACTUAL result makes
// that class of disagreement unrepresentable.
// ---------------------------------------------------------------------------

/** Title-case, plain-English label for each filing status a plan can produce. */
export const FILING_STATUS_LABELS: Readonly<Record<TaxUnitFilingStatus, string>> = {
  Single: 'Single',
  MFJ: 'Married filing jointly',
  MFS: 'Married filing separately',
  HoH: 'Head of household',
  QSS: 'Qualifying surviving spouse',
};

/** Title-case label for a status value, echoing an unknown value verbatim. */
function filingStatusLabel(status: string): string {
  return FILING_STATUS_LABELS[status as TaxUnitFilingStatus] ?? status;
}

/** Lower-case label for mid-sentence use ("files as married filing jointly"). */
function filingStatusLabelLower(status: string): string {
  return filingStatusLabel(status).toLowerCase();
}

/**
 * ASCII-only description of one year-bounded exception window. jsPDF's standard
 * font carries no arrow / `≤` glyph, so both surfaces read as plain words and
 * the on-screen card and the PDF can never render the same window differently.
 */
function describeFilingStatusWindow(w: FilingStatusWindow): string {
  const bound = (a: FilingStatusWindow['start'] | FilingStatusWindow['end']): string =>
    a.kind === 'year' ? String(a.year) : `age ${a.years}`;
  return `${filingStatusLabel(w.status)} from ${bound(w.start)} up to (but not including) ${bound(w.end)}`;
}

/** One return inside a resolved filing summary. */
interface FilingSummaryUnit {
  readonly memberId: 'primary' | 'secondary';
  readonly statusLabel: string;
  readonly householdSize: number;
}

/** Resolver-backed description of a scenario's filing treatment. */
export interface FilingPlanSummary {
  /** Short label for the CURRENT-year treatment — what a "Filing status" row
   *  shows. Always agrees with what the engines actually file. */
  readonly headline: string;
  /** One-sentence description of the both-spouses-alive years (or the sole
   *  member's years in a one-person household). */
  readonly whileBothAlive: string;
  /** One-sentence description of the death-year + post-death treatment.
   *  `undefined` for a one-member household (nothing to describe). */
  readonly afterADeath: string | undefined;
  /** Per-spouse returns — populated only for a resolved `separate` plan. */
  readonly units: readonly FilingSummaryUnit[];
  /** §86(c)(1)(C)(ii) lived-together fact — only for a `separate` plan. */
  readonly livedTogether: boolean | undefined;
  /** Formatted exception windows, in stored order. */
  readonly windows: readonly string[];
  /** Set when the stored legacy scalar cannot be converted automatically.
   *  The engines keep filing under `headline` (the legacy derivation) meanwhile. */
  readonly unresolvedLegacyDetail: string | undefined;
}

/** Inputs the filing summary needs — the same facts every engine resolves. */
export interface FilingSummaryContext {
  readonly taxFilingPlan?: TaxFilingPlan;
  readonly filingStatusOverride?: FilingStatusOverride;
  readonly hasSecondaryMember: boolean;
  /** Tax year the summary describes. Defaults to the current calendar year. */
  readonly taxYear?: number;
}

/**
 * The resolution prompt for a scenario, or `undefined` when nothing needs
 * resolving. Asks the PRODUCTION resolver the same question the engines ask, so
 * the prompt cannot drift from the branch that actually keeps the legacy path.
 */
export function unresolvedFilingDetail(ctx: FilingSummaryContext): string | undefined {
  const resolution = resolveFilingPlanForYear({
    taxFilingPlan: ctx.taxFilingPlan,
    filingStatusOverride: ctx.filingStatusOverride,
    hasSecondaryMember: ctx.hasSecondaryMember,
    primaryAlive: true,
    secondaryAlive: ctx.hasSecondaryMember,
    taxYear: ctx.taxYear ?? new Date().getFullYear(),
  });
  return resolution.kind === 'unresolved' ? resolution.detail : undefined;
}

/**
 * Death-year + post-death sentence. A `separate` plan does NOT collapse to a
 * joint return in the death year — it resolves both spouses' own returns while
 * both count as alive.
 *
 * `laterYearsStatus` is what `survivorUnit` ACTUALLY resolves once a spouse has
 * died — usually the `Single` default, but a plan carrying a standing open-ended
 * window files that status instead, forever. It is passed in rather than
 * assumed so this sentence cannot claim a status no year is ever filed under.
 *
 * `windows` are the year-bounded exceptions, every one of which really can win its
 * years: they outrank the standing window in the resolver regardless of stored
 * order, so none of them is listed here as an exception that changes
 * nothing.
 */
function describeAfterADeath(
  plan: TaxFilingPlan | undefined,
  windows: readonly string[],
  laterYearsStatus: TaxUnitFilingStatus,
): string {
  const deathYear =
    plan?.kind === 'separate'
      ? 'The year a spouse dies is still filed on two separate returns'
      : 'The year a spouse dies is still filed jointly';
  const laterLabel = filingStatusLabelLower(laterYearsStatus);
  const later =
    windows.length > 0
      ? `; later years file ${laterLabel}, except ${windows.join('; ')}.`
      : `; later years file ${laterLabel}.`;
  return deathYear + later;
}

/** Both-spouses-alive sentence for a resolved `separate` plan. */
function describeSeparate(units: readonly FilingSummaryUnit[], livedTogether: boolean): string {
  const sizes = units
    .map(
      (u) =>
        `${u.memberId === 'primary' ? 'Primary' : 'Spouse'}: ${u.statusLabel.toLowerCase()}, ` +
        `${u.householdSize} ${u.householdSize === 1 ? 'person' : 'people'} on the return`,
    )
    .join('; ');
  // §86(c)(1)(C)(ii) caps taxable Social Security at 85% for EVERY filer — living
  // together only removes the MFS base amounts, so benefits are taxed from the
  // first dollar UP TO that 85% cap. It never makes 100% of the benefit taxable.
  const together =
    livedTogether
      ? ' They lived together during the year, so a spouse filing separately is taxed on their Social Security from the first dollar (up to the usual 85% cap) and Medicare uses the higher separate-filer surcharge table.'
      : ' They lived apart for the whole year.';
  return `Two separate returns while both spouses are alive (${sizes}).${together}`;
}

/**
 * Describe a scenario's filing treatment from the PRODUCTION resolver's actual
 * result. Every consumer surface calls this, so the on-screen report,
 * the PDF, and the engines can never disagree about which return was filed —
 * including the unresolved-legacy case, where the summary reports the LEGACY
 * status the engines really used rather than a plan default nobody chose.
 */
export function summarizeFilingPlan(ctx: FilingSummaryContext): FilingPlanSummary {
  const taxYear = ctx.taxYear ?? new Date().getFullYear();
  const plan = ctx.taxFilingPlan;
  const resolution = resolveFilingPlanForYear({
    taxFilingPlan: plan,
    filingStatusOverride: ctx.filingStatusOverride,
    hasSecondaryMember: ctx.hasSecondaryMember,
    primaryAlive: true,
    secondaryAlive: ctx.hasSecondaryMember,
    taxYear,
  });
  const rawWindows: readonly unknown[] =
    isPlanObject(plan) && Array.isArray(plan.statusWindows) ? plan.statusWindows : [];
  // The SAME completeness check the resolver applies. Being "an object" is
  // not enough: `isOpenEndedStatusWindow` and `describeFilingStatusWindow` both
  // read `start`/`end` unconditionally, so an entry missing an anchor used to
  // crash report and PDF generation on a payload the engines had already
  // classified as unresolved. A malformed window is skipped (the plan itself
  // resolves as unresolved, so the sentence below still explains it).
  const storedWindows = rawWindows.filter(isWellFormedStatusWindow);
  const windows = storedWindows
    // An OPEN-ENDED window is the plan's standing filing status (it already
    // drives `headline`), not a year-bounded survivor exception — listing it as
    // one would read as "except head of household from 1900 to 9999".
    .filter((w) => !isOpenEndedStatusWindow(w))
    .map(describeFilingStatusWindow);
  // The death sentence names the status the ENGINES really file for the
  // survivor's later years: the plan's standing (open-ended) window when it has
  // one, which a COUPLE's plan can carry without any filing-editor control showing
  // it (a joint plan whose spouse was temporarily removed picks one up from the
  // one-person control), else the `Single` default. Only a plan the resolver
  // ACCEPTS counts: an unresolved plan is ignored entirely (the engines keep
  // the legacy scalar derivation, whose post-death default is `Single`), so its
  // standing window must not colour this sentence. Every year-bounded exception
  // outranks that standing status in the resolver, so `windows` needs no
  // shadowing filter — each entry it lists really does win its own years.
  const afterADeath = ctx.hasSecondaryMember
    ? describeAfterADeath(
        plan,
        windows,
        resolution.kind === 'resolved' ? standingFilingStatus(storedWindows) : 'Single',
      )
    : undefined;

  if (resolution.kind === 'unresolved') {
    // The engines keep the LEGACY scalar derivation for every year. Report
    // exactly that, never a plan default the user never chose.
    const legacyStatus = deriveFilingStatus({
      primaryAlive: true,
      secondaryAlive: ctx.hasSecondaryMember,
      filingStatusOverride: ctx.filingStatusOverride,
    });
    return {
      headline: filingStatusLabel(legacyStatus),
      whileBothAlive:
        `Filed as ${filingStatusLabelLower(legacyStatus)} — this scenario still uses an older ` +
        'filing setting that could not be read for both spouses, so the projections kept using ' +
        'it unchanged.',
      afterADeath,
      units: [],
      livedTogether: undefined,
      windows,
      unresolvedLegacyDetail: resolution.detail,
    };
  }

  const taxUnits = resolution.taxUnits;
  if (taxUnits.length > 1) {
    const units: FilingSummaryUnit[] = taxUnits.map((u, i) => ({
      memberId: u.memberIds[0] ?? (i === 0 ? 'primary' : 'secondary'),
      statusLabel: filingStatusLabel(u.filingStatus),
      householdSize: u.householdSize ?? 1,
    }));
    const livedTogether =
      plan?.kind === 'separate' ? plan.livedTogether === true : false;
    return {
      headline: 'Separate returns while both spouses are alive',
      whileBothAlive: describeSeparate(units, livedTogether),
      afterADeath,
      units,
      livedTogether,
      windows,
      unresolvedLegacyDetail: undefined,
    };
  }

  const status = taxUnits[0]?.filingStatus ?? 'Single';
  return {
    headline: filingStatusLabel(status),
    whileBothAlive: ctx.hasSecondaryMember
      ? `One ${filingStatusLabelLower(status)} return while both spouses are alive.`
      : `One person in this plan, filing as ${filingStatusLabelLower(status)} each year.`,
    afterADeath,
    units: [],
    livedTogether: undefined,
    windows,
    unresolvedLegacyDetail: undefined,
  };
}
