/**
 * Filing-status derivation: the scalar `deriveFilingStatus` and the transition-safe year/member filing-plan resolver.
 * Ambiguous or corrupt input resolves to an explicit `unresolved`; see docs/math-taxes.md, "Filing status and tax units".
 */

import type { ScheduleStart, ScheduleEnd } from '../db/types/aggregate-base';
import type { FilingStatus } from './federal-tax';

/** Override shape stored in ScenarioOverrides.filingStatus (legacy scalar). */
export type FilingStatusOverride = 'MFJ' | 'Single' | 'HoH';

export interface FilingStatusContext {
  primaryAlive: boolean;
  secondaryAlive: boolean;
  filingStatusOverride?: FilingStatusOverride;
}

/**
 * Scalar filing status: `filingStatusOverride` if set (unvalidated), else MFJ with both members alive and Single
 * otherwise (tax-conservative for a surviving spouse). Never emits MFS/QSS, and HoH only by override.
 */
export function deriveFilingStatus(ctx: FilingStatusContext): FilingStatus {
  if (ctx.filingStatusOverride !== undefined) {
    return ctx.filingStatusOverride;
  }
  return ctx.primaryAlive && ctx.secondaryAlive ? 'MFJ' : 'Single';
}

// The plan types live here, not in db/types/scenario-overrides.ts, which imports this module (the reverse would be a
// type-only cycle that `.dependency-cruiser.cjs` `no-circular` rejects).

/** Filing statuses a tax unit may carry: a `separate` plan reaches MFS and a survivor `statusWindow` reaches QSS via `applyTaxYearForFilingPlan`. */
export type TaxUnitFilingStatus = 'Single' | 'MFJ' | 'MFS' | 'HoH' | 'QSS';

/**
 * One user-entered window over `[startYear, endYear)` (`end` exclusive, anchors collapsed to whole tax years). A
 * year-bounded window overlays the plan's base status and outranks the standing status whatever order they are stored
 * in, but never overrides a live MFJ/separate year; an open-ended window is the standing status. An `age` anchor with
 * no supplied birth year is inactive.
 */
export interface FilingStatusWindow {
  readonly status: TaxUnitFilingStatus;
  readonly start: Extract<ScheduleStart, { kind: 'age' | 'year' }>;
  readonly end: Extract<ScheduleEnd, { kind: 'age' | 'year' }>;
}

/** One tax unit inside a `separate` plan: a spouse's own return, with the tax-household size that drives FPL / PTC and bracket selection. */
export interface FilingPlanTaxUnit {
  readonly memberId: 'primary' | 'secondary';
  readonly filingStatus: TaxUnitFilingStatus;
  readonly householdSize: number;
}

/** Single-member plan: files `Single`; `statusWindows` overlay eligible HoH (or other) years. */
export interface IndividualFilingPlan {
  readonly kind: 'individual';
  readonly statusWindows?: readonly FilingStatusWindow[];
}

/**
 * Joint plan: MFJ while both spouses are alive, including the death year (the dying member counts as alive), then
 * `Single`; `statusWindows` carry survivor exceptions (QSS, later HoH) that override the post-death default.
 */
export interface JointFilingPlan {
  readonly kind: 'joint';
  readonly statusWindows?: readonly FilingStatusWindow[];
}

/** Separate plan: both spouses alive but filing as independent units; after a death the survivor follows the joint plan's post-death rule. */
export interface SeparateFilingPlan {
  readonly kind: 'separate';
  readonly units: readonly [FilingPlanTaxUnit, FilingPlanTaxUnit];
  readonly statusWindows?: readonly FilingStatusWindow[];
  /**
   * §86(c)(1)(C)(ii): whether the spouses lived together at any time in the tax year while filing separately. True zeroes
   * an MFS unit's SS base amounts (taxable from the first dollar) and selects IRMAA's steeper MFS schedule. Absent means
   * lived apart, the lower-tax reading, so the editor collects it explicitly; consulted only while both are alive.
   */
  readonly livedTogether?: boolean;
}

/** Scenario-level tax filing plan, a discriminated union over the household shape. */
export type TaxFilingPlan =
  | IndividualFilingPlan
  | JointFilingPlan
  | SeparateFilingPlan;

/** A single tax unit's resolved filing status for one projection year. */
export interface ResolvedTaxUnit {
  readonly memberIds: readonly ('primary' | 'secondary')[];
  readonly filingStatus: TaxUnitFilingStatus;
  readonly householdSize?: number;
}

/** Why a filing-plan year could not be resolved; surfaced in the scenario filing editor rather than guessed, while the engines keep the legacy scalar path. */
export type FilingPlanUnresolvedReason =
  | 'two-member-scalar-ambiguous'
  | 'one-member-joint-invalid'
  | 'unknown-scalar'
  | 'unknown-plan-kind'
  /** Known `kind` but an unusable payload: structurally invalid, or written for a different household (an `individual` plan on a household that gained a spouse). The year takes the legacy fallback instead of crashing or dropping a spouse's unit. */
  | 'invalid-plan-shape';

/** Result of resolving a filing plan for a single projection year. */
export type FilingPlanResolution =
  | { readonly kind: 'resolved'; readonly taxUnits: readonly ResolvedTaxUnit[] }
  | { readonly kind: 'unresolved'; readonly reason: FilingPlanUnresolvedReason; readonly detail: string };

export interface FilingPlanContext {
  /** Stored filing plan; supersedes the scalar. */
  readonly taxFilingPlan?: TaxFilingPlan;
  /** Legacy scalar override; used only when no plan is set. */
  readonly filingStatusOverride?: FilingStatusOverride;
  readonly hasSecondaryMember: boolean;
  /** True while the member is alive in the projection year; the death year counts as alive. */
  readonly primaryAlive: boolean;
  readonly secondaryAlive: boolean;
  readonly taxYear: number;
  /** Primary member's birth year, resolving `age`-anchored windows; absent makes them inactive. */
  readonly primaryBirthYear?: number;
  readonly secondaryBirthYear?: number;
}

const KNOWN_UNIT_STATUSES: ReadonlySet<string> = new Set<TaxUnitFilingStatus>([
  'Single',
  'MFJ',
  'MFS',
  'HoH',
  'QSS',
]);

// Shared by plan validation and the summary formatters, so a window the resolver rejects never reaches `describeFilingStatusWindow`.
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

function isWellFormedStatusWindow(w: unknown): w is FilingStatusWindow {
  return invalidStatusWindowDetail(w) === undefined;
}

// `taxFilingPlan` is untrusted user/sync data with no runtime schema, so validate every field the resolver dereferences: a
// `separate` plan needs exactly two units forming a primary+secondary bijection (a duplicate would double-count a spouse's
// accounts, an omitted owner would drop the other), and each window a known status and resolvable anchors.
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

// The stored value is untrusted: reading `.kind` off a corrupt `null`, array or string would throw and take down the projection, so check it is an object first.
function isPlanObject(plan: unknown): plan is TaxFilingPlan {
  return typeof plan === 'object' && plan !== null && !Array.isArray(plan);
}

function describeStoredPlanShape(plan: unknown): string {
  if (plan === null) return 'an empty value';
  if (Array.isArray(plan)) return 'a list';
  return `a ${typeof plan} value`;
}

function isKnownPlanKind(plan: unknown): plan is TaxFilingPlan {
  if (!isPlanObject(plan)) return false;
  const kind = (plan as { kind?: unknown }).kind;
  return kind === 'individual' || kind === 'joint' || kind === 'separate';
}

// Household composition can change after a plan is saved: an `individual` plan surviving a spouse's addition would silently
// file one Single return for the couple, so it is reported unresolved. A `joint`/`separate` plan whose spouse was removed
// needs no guard (it collapses to the sole member's Single).
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
 * True when `plan` is a stored plan this household can be projected on: known kind, valid payload, and a shape matching
 * current membership. The editor asks this before opening a plan (its controls index units directly), sharing one
 * definition of usable with `resolveFilingPlanForYear`.
 */
export function isWellFormedFilingPlan(
  plan: unknown,
  hasSecondaryMember: boolean,
): plan is TaxFilingPlan {
  if (!isKnownPlanKind(plan)) return false;
  if (invalidPlanShapeDetail(plan) !== undefined) return false;
  return planHouseholdMismatchDetail(plan, hasSecondaryMember) === undefined;
}

// Bounds of an open-ended window: `end` is exclusive so 9999 is effectively unbounded, and the start predates every modeled
// year including the IRMAA two-year look-back. It is how a plan files one status every year, e.g. a one-member HoH scalar.
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

/** True when `w` is open-ended: the plan's standing status, not a year-bounded exception. */
export function isOpenEndedStatusWindow(w: FilingStatusWindow): boolean {
  return (
    w.start.kind === 'year' &&
    w.start.year <= OPEN_ENDED_WINDOW_START_YEAR &&
    w.end.kind === 'year' &&
    w.end.year >= OPEN_ENDED_WINDOW_END_YEAR
  );
}

/** The plan's standing filing status: the open-ended window's status, else `Single`. One definition shared by the resolver, the filing editor and the summary; `windows` must already be well-formed. */
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
  // `age` anchor: birth year plus years, months collapsed as in MagiCapWindow; the member defaults to primary.
  const birthYear = anchor.memberId === 'secondary' ? ctx.secondaryBirthYear : ctx.primaryBirthYear;
  return birthYear === undefined ? undefined : birthYear + anchor.years;
}

// The status in `ctx.taxYear`, or `undefined`. Year-bounded exceptions are matched first and the standing open-ended window
// is the fallback, whatever order they are stored in (a standing window covers every year and would shadow exceptions
// behind it); among overlapping exceptions the earliest stored wins.
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
  // The stored value may not be an object (corrupt `null`, array, string); check before the `.kind` read, which would throw.
  if (!isPlanObject(plan)) {
    return {
      kind: 'unresolved',
      reason: 'invalid-plan-shape',
      detail: `The saved filing choice is not readable (found ${describeStoredPlanShape(plan)}).`,
    };
  }
  // A corrupt or newer-client `plan.kind` is surfaced rather than dereferenced, ahead of the all-deceased short-circuit so it
  // is flagged even in an all-deceased year, as in `resolveFromScalar`.
  if (!isKnownPlanKind(plan)) {
    return {
      kind: 'unresolved',
      reason: 'unknown-plan-kind',
      detail: `Unknown filing-plan kind '${String((plan as { kind?: unknown }).kind)}'; expected one of individual, joint, separate.`,
    };
  }
  // Known kind but untrusted payload: validate before dereferencing, also ahead of the all-deceased short-circuit.
  const shapeProblem = invalidPlanShapeDetail(plan);
  if (shapeProblem !== undefined) {
    return { kind: 'unresolved', reason: 'invalid-plan-shape', detail: shapeProblem };
  }
  // A well-formed plan for a household that no longer exists (a one-person plan on a couple) is unresolved, never one Single return for two people.
  const mismatch = planHouseholdMismatchDetail(plan, ctx.hasSecondaryMember);
  if (mismatch !== undefined) {
    return { kind: 'unresolved', reason: 'invalid-plan-shape', detail: mismatch };
  }
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
  return { kind: 'resolved', taxUnits: [survivorUnit(plan.statusWindows, ctx)] };
}

const KNOWN_SCALARS: readonly FilingStatusOverride[] = ['MFJ', 'Single', 'HoH'];

function resolveFromScalar(
  scalar: FilingStatusOverride,
  ctx: FilingPlanContext,
): FilingPlanResolution {
  // A corrupt or future scalar is surfaced rather than guessed, ahead of the alive-state short-circuit so it is flagged even in an all-deceased year.
  if (!KNOWN_SCALARS.includes(scalar)) {
    return {
      kind: 'unresolved',
      reason: 'unknown-scalar',
      detail: `Unknown legacy filing-status scalar '${String(scalar)}'; expected one of ${KNOWN_SCALARS.join(', ')}.`,
    };
  }
  // Validate the scalar and household combination before the all-deceased short-circuit, so an invalid or ambiguous one stays unresolved even then.
  if (!ctx.hasSecondaryMember && scalar === 'MFJ') {
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
  if (!ctx.primaryAlive && !ctx.secondaryAlive) {
    return { kind: 'resolved', taxUnits: [] };
  }
  if (!ctx.hasSecondaryMember) {
    if (scalar === 'Single') {
      return { kind: 'resolved', taxUnits: [survivorUnit(undefined, ctx)] };
    }
    return {
      kind: 'resolved',
      taxUnits: [{ memberIds: ctx.primaryAlive ? ['primary'] : ['secondary'], filingStatus: 'HoH' }],
    };
  }
  if (bothSpousesAlive(ctx)) {
    return {
      kind: 'resolved',
      taxUnits: [{ memberIds: ['primary', 'secondary'], filingStatus: 'MFJ' }],
    };
  }
  return { kind: 'resolved', taxUnits: [survivorUnit(undefined, ctx)] };
}

/**
 * Resolves the filing plan for one projection year; both engines call it once per year. Precedence: a stored
 * `taxFilingPlan`; else the legacy scalar via the scalar × household-cardinality matrix (ambiguous, invalid or unknown
 * scalars are `unresolved`, never guessed); else household composition (a couple files MFJ while both are alive,
 * including the death year, then Single; a lone member files Single).
 */
export function resolveFilingPlanForYear(ctx: FilingPlanContext): FilingPlanResolution {
  if (ctx.taxFilingPlan !== undefined) {
    return resolveFromPlan(ctx.taxFilingPlan, ctx);
  }
  if (ctx.filingStatusOverride !== undefined) {
    return resolveFromScalar(ctx.filingStatusOverride, ctx);
  }
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

// Shared filing summary: one resolver-backed description consumed by the filing editor, report card and PDF settings
// table, so no surface can disagree with the engines.

export const FILING_STATUS_LABELS: Readonly<Record<TaxUnitFilingStatus, string>> = {
  Single: 'Single',
  MFJ: 'Married filing jointly',
  MFS: 'Married filing separately',
  HoH: 'Head of household',
  QSS: 'Qualifying surviving spouse',
};

function filingStatusLabel(status: string): string {
  return FILING_STATUS_LABELS[status as TaxUnitFilingStatus] ?? status;
}

function filingStatusLabelLower(status: string): string {
  return filingStatusLabel(status).toLowerCase();
}

// ASCII-only: jsPDF's standard font has no arrow or ≤ glyph, and it keeps the on-screen card and the PDF identical.
function describeFilingStatusWindow(w: FilingStatusWindow): string {
  const bound = (a: FilingStatusWindow['start'] | FilingStatusWindow['end']): string =>
    a.kind === 'year' ? String(a.year) : `age ${a.years}`;
  return `${filingStatusLabel(w.status)} from ${bound(w.start)} up to (but not including) ${bound(w.end)}`;
}

interface FilingSummaryUnit {
  readonly memberId: 'primary' | 'secondary';
  readonly statusLabel: string;
  readonly householdSize: number;
}

/** Resolver-backed description of a scenario's filing treatment. */
export interface FilingPlanSummary {
  /** Label for the current-year treatment; always agrees with what the engines file. */
  readonly headline: string;
  readonly whileBothAlive: string;
  readonly afterADeath: string | undefined;
  readonly units: readonly FilingSummaryUnit[];
  /** §86(c)(1)(C)(ii) lived-together fact — only for a `separate` plan. */
  readonly livedTogether: boolean | undefined;
  readonly windows: readonly string[];
  /** Set when the stored legacy scalar cannot be converted; the engines keep filing under `headline`. */
  readonly unresolvedLegacyDetail: string | undefined;
}

export interface FilingSummaryContext {
  readonly taxFilingPlan?: TaxFilingPlan;
  readonly filingStatusOverride?: FilingStatusOverride;
  readonly hasSecondaryMember: boolean;
  readonly taxYear?: number;
}

/** The resolution prompt for a scenario, or `undefined` when nothing needs resolving; asks the production resolver so it cannot drift from the engines. */
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

// `laterYearsStatus` is what `survivorUnit` actually resolves after a death (a standing open-ended window files that status
// forever), so the sentence cannot claim a status no year is filed under. A separate plan is not collapsed to a joint
// return in the death year. `windows` are exceptions that really win their years.
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

function describeSeparate(units: readonly FilingSummaryUnit[], livedTogether: boolean): string {
  const sizes = units
    .map(
      (u) =>
        `${u.memberId === 'primary' ? 'Primary' : 'Spouse'}: ${u.statusLabel.toLowerCase()}, ` +
        `${u.householdSize} ${u.householdSize === 1 ? 'person' : 'people'} on the return`,
    )
    .join('; ');
  // §86(c)(1)(C)(ii) caps taxable SS at 85% for every filer; living together only removes the MFS base amounts, so benefits
  // are taxed from the first dollar up to that cap, never 100%.
  const together =
    livedTogether
      ? ' They lived together during the year, so a spouse filing separately is taxed on their Social Security from the first dollar (up to the usual 85% cap) and Medicare uses the higher separate-filer surcharge table.'
      : ' They lived apart for the whole year.';
  return `Two separate returns while both spouses are alive (${sizes}).${together}`;
}

/** Describes a scenario's filing treatment from the production resolver's actual result, so report, PDF and engines cannot disagree, including the unresolved-legacy case, where it reports the legacy status the engines used. */
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
  // The same completeness check the resolver applies: `isOpenEndedStatusWindow` and `describeFilingStatusWindow` read
  // `start`/`end` unconditionally, so a malformed window is skipped instead of crashing report and PDF generation.
  const storedWindows = rawWindows.filter(isWellFormedStatusWindow);
  const windows = storedWindows
    // An open-ended window is the standing status (it already drives `headline`), not a year-bounded exception.
    .filter((w) => !isOpenEndedStatusWindow(w))
    .map(describeFilingStatusWindow);
  // The death sentence names the status the engines file for the survivor's later years: the standing window of a plan the
  // resolver accepts, else `Single` (an unresolved plan is ignored; the legacy derivation defaults to Single). Year-bounded
  // exceptions outrank the standing window, so `windows` needs no shadowing filter.
  const afterADeath = ctx.hasSecondaryMember
    ? describeAfterADeath(
        plan,
        windows,
        resolution.kind === 'resolved' ? standingFilingStatus(storedWindows) : 'Single',
      )
    : undefined;

  if (resolution.kind === 'unresolved') {
    // The engines keep the legacy scalar derivation for every year; report exactly that.
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
