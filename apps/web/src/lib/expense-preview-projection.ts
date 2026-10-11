/**
 * Pure projection logic for the live single-expense form preview.
 *
 * Extracted from `<ExpenseProjectionPreview>` so the component stays a
 * thin `React.memo` wrapper: everything here is pure (no React, no
 * IndexedDB), each function is independently testable, and the file/
 * function shape limits hold. `buildPreview` is the single entry point
 * the component calls; it returns the `PreviewResult` discriminant the
 * component renders verbatim.
 *
 * form". The projection context comes from the shared
 * `buildExpenseProjectionContext` (same builder the Expenses page uses),
 * resolved under the form's TARGET scenario so the preview matches what
 * Save produces: scenario-patch → `scenarioForPatch`; scenario-only add
 * → `scenarioForAdd`; otherwise the primary scenario.
 *
 * The date→fractional-year helpers use arithmetic identical to
 * ExpensesPage's `buildProjection` so the preview's markers land on the
 * same x as the page chart's. Kept local: ExpensesPage's marker
 * derivation is deliberately not extracted (only the ctx builder is
 * shared).
 */
import {
  buildExpenseProjectionContext,
  findEarliestExpenseStartMonth,
  projectExpensesByMonth,
  type ExpenseProjectionMonthlyPoint,
} from './expense-projection';
import type { CashflowChartMarker } from './cashflow-chart-types';
import type { TooltipMember } from '../components/tooltip-member';
import { resolveScenario } from './scenario-resolution';
import type { ScenarioAggregate } from './scenario-resolution';
import { glideProblem, isNeutralGlide } from './expense-glide-format';
import { resolveStartMonth } from './schedule-resolution';
import { resolveMemberRetirementDates } from './retirement-date-math';
import { CHART_COLORS, lifeMarkerColors, type ChartTheme } from './tokens';
import {
  DEFAULT_LIFE_EXPECTANCY_AGE,
  type Aggregate,
  type ExpensePayload,
  type HouseholdMemberPayload,
} from '../db/types';

const SHORT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Projected death year (integer `deathYear = birthYear + ageYears`).
 *
 * Death is modelled as Dec 31 of `deathYear`, so the birth
 * month/day no longer shift the result — only the birth *year* matters.
 * The ISO regex + `month < 1 || month > 12` guard are preserved so an
 * invalid birthdate still returns `null` (the null contract must not
 * change). Pure.
 */
export function projectedDeathFractionalYear(
  birthdate: string,
  ageYears: number,
): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthdate);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return year + ageYears;
}

/** ISO `YYYY-MM-DD` → fractional year, same arithmetic as
 *  `projectedDeathFractionalYear` minus the age offset. Pure. */
export function isoToFractionalYear(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  const monthIndex = month - 1;
  const dim = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return year + (monthIndex + (day - 1) / dim) / 12;
}

/** ISO date/month → `MMM YYYY` (e.g. `Apr 2031`). Pure. */
export function formatShortIsoMonth(iso: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return iso;
  return `${SHORT_MONTHS[monthIndex]} ${match[1]}`;
}

export type PreviewResult =
  | { kind: 'no-amount' }
  | { kind: 'unresolvable' }
  | { kind: 'invalid-glide'; message: string }
  | {
      kind: 'ok';
      rows: ExpenseProjectionMonthlyPoint[];
      markers: CashflowChartMarker[];
      members: TooltipMember[];
    };

export interface ResolvedCtx {
  ctx: ReturnType<typeof buildExpenseProjectionContext>;
  resolved: ReturnType<typeof resolveScenario>;
  primary: Aggregate<HouseholdMemberPayload>;
  secondary: Aggregate<HouseholdMemberPayload> | null;
  primaryRetirementIso: string;
  retirementYear: number;
}

/** Pick the effective scenario id: the passed target if it exists in
 *  the list, else the primary scenario's id, else null. Pure. */
function resolveEffectiveScenarioId(
  scenarios: ScenarioAggregate[],
  targetScenarioId: string | null,
): string | null {
  const baseScenario = scenarios.find((s) => s.payload.isPrimary) ?? null;
  return targetScenarioId && scenarios.some((s) => s.id === targetScenarioId)
    ? targetScenarioId
    : (baseScenario?.id ?? null);
}

/** Resolve the primary member's retirement date (ISO) for the resolved
 *  scenario, or null when it can't resolve. Pure. */
function resolvePrimaryRetirementIso(
  resolved: ReturnType<typeof resolveScenario>,
  members: Aggregate<HouseholdMemberPayload>[],
  primary: Aggregate<HouseholdMemberPayload>,
): string | null {
  const retirementMap = resolveMemberRetirementDates(
    resolved.retirementAge,
    members.map((m) => ({
      id: m.id,
      isPrimary: m.payload.isPrimary,
      birthdate: m.payload.birthdate ?? '',
    })),
  );
  return retirementMap.get(primary.id) ?? null;
}

/**
 * Resolve the draft's target scenario and build the projection
 * context. Returns the resolved bundle, or an `unresolvable`
 * discriminant when the scenario / retirement / birthdate context
 * can't resolve. Pure.
 */
export function resolveTargetCtx(
  members: Aggregate<HouseholdMemberPayload>[],
  scenarios: ScenarioAggregate[],
  targetScenarioId: string | null,
): ResolvedCtx | { kind: 'unresolvable' } {
  const effectiveId = resolveEffectiveScenarioId(scenarios, targetScenarioId);
  if (!effectiveId) return { kind: 'unresolvable' };

  const primary = members.find((m) => m.payload.isPrimary) ?? null;
  const secondary = members.find((m) => !m.payload.isPrimary) ?? null;
  if (!primary?.payload.birthdate) return { kind: 'unresolvable' };

  const resolved = resolveScenario(effectiveId, scenarios);
  const primaryRetirementIso = resolvePrimaryRetirementIso(
    resolved,
    members,
    primary,
  );
  if (!primaryRetirementIso) return { kind: 'unresolvable' };
  const retirementYear = new Date(primaryRetirementIso).getUTCFullYear();
  if (!Number.isFinite(retirementYear)) return { kind: 'unresolvable' };

  const ctx = buildExpenseProjectionContext({
    resolved,
    primary: primary.payload,
    secondary: secondary?.payload ?? null,
    primaryRetirementIso,
  });
  return {
    ctx,
    resolved,
    primary,
    secondary,
    primaryRetirementIso,
    retirementYear,
  };
}

/**
 * Surface an invalid glide configuration in plain language BEFORE
 * projecting — an *actually-moving* (rise or fall) invalid glide otherwise
 * renders a misleading flat / non-updating curve, which the preview
 * pre-empts. Same `glideProblem` validator the form's Save path uses,
 * against this expense's own resolved start + resolved `end`.
 *
 * Suppressed (returns null) in **all** modes — canonical, scenario-patch,
 * scenario-only-add — when the glide is a value-equivalent no-op
 * (`isNeutralGlide`: `endMultiplierPct === 100`, no effective
 * floor/ceiling): it
 * multiplies by 1 every month, so the preview renders a non-misleading
 * flat curve with nothing to warn about. Preview-only and deliberate —
 * Save still structurally validates a stored glide config (so a stored
 * no-op mis-config, e.g. glide-end before glide-start at the default
 * 100% End, cannot silently become an active decline if End% is later
 * lowered), except the scenario-patch *off* sentinel where the neutral
 * object means "cleared", not "an enabled no-op glide".
 *
 * Net invariant: for a **non-neutral / actually-moving (rise or fall)**
 * glide the
 * preview warning and the Save block can never disagree in any mode (the
 * Save path threads the add-target, matching this function's target
 * resolution). The no-op divergence — preview-suppressed but
 * Save-validated — is by design, not a contradiction.
 *
 * A one-off is never glided: the engine early-returns multiplier 1 for
 * `frequency === 'oneOff'` (stored/inherited glide ignored) and the form
 * hides the glide section for one-offs; validating that hidden, ignored
 * glide would surface an unfixable preview warning, so it is skipped
 * here — one rule across Save + preview + engine.
 */
export function glideProblemForDraft(
  draft: ExpensePayload,
  rc: ResolvedCtx,
): string | null {
  if (
    draft.frequency === 'oneOff' ||
    !draft.discretionaryGlide ||
    isNeutralGlide(draft.discretionaryGlide)
  ) {
    return null;
  }
  const probe = resolveStartMonth(draft.start, rc.ctx) ?? {
    year: Number.isFinite(rc.retirementYear) ? rc.retirementYear : 0,
    // Keep the resolved retirement *month* in the fallback so the
    // month-precise before-expense rule is evaluated correctly for a
    // mid-year retiree; only drop to 0 when the retirement date itself
    // can't resolve / month0 is absent.
    month0: rc.ctx.retirementMonth0 ?? 0,
  };
  return glideProblem(draft.discretionaryGlide, rc.ctx, probe, draft.end);
}

/** Life-expectancy markers (one per member with a usable birthdate).
 *  Pure. `theme` is passed explicitly so a live theme toggle
 *  re-flips the marker colors — the prior `currentChartTheme()` read
 *  inside this pure builder was invisible to the component's `useMemo`
 *  + `React.memo`, leaving stale colors on a theme switch. */
function lifeExpectancyMarkers(
  rc: ResolvedCtx,
  theme: ChartTheme,
): CashflowChartMarker[] {
  const { resolved, primary, secondary } = rc;
  const markerColors = lifeMarkerColors(theme);
  const markers: CashflowChartMarker[] = [];
  const addDeathMarker = (
    member: Aggregate<HouseholdMemberPayload> | null,
    slot: 'primary' | 'secondary',
  ): void => {
    if (!member?.payload.birthdate) return;
    const age = resolved.lifeExpectancy?.[slot] ?? DEFAULT_LIFE_EXPECTANCY_AGE;
    const deathYear = projectedDeathFractionalYear(member.payload.birthdate, age);
    if (deathYear === null) return;
    const fallback = slot === 'primary' ? 'Primary' : 'Secondary';
    const firstName = member.payload.firstName.trim() || fallback;
    // Death markers carry the integer `deathYear` + `kind: 'death'`; the
    // always-monthly expenses chart maps them to the December sample
    // (`deathYear + 11/12`) so the marker hugs the last monthly data point.
    // Emitting the integer here keeps `lastFullYear` (`floor(max)`)
    // equal to `deathYear`.
    markers.push({
      fractionalYear: deathYear,
      label: `${firstName} life expectancy ${age}`,
      color: markerColors[slot],
      kind: 'death',
    });
  };
  addDeathMarker(primary, 'primary');
  addDeathMarker(secondary, 'secondary');
  return markers;
}

/**
 * Life-expectancy markers (one per member with a usable birthdate) plus
 * the canonical teal retirement marker, rendered unconditionally
 * whenever retirement falls within the chart's x-domain (mirrors
 * ExpensesPage's `buildProjection` so the preview and the list page
 * agree). Returns null when no life-expectancy marker can be computed or
 * the window ends before retirement (both `unresolvable`).
 */
function buildMarkers(
  rc: ResolvedCtx,
  resolvedExpenses: Array<{
    id: string;
    source: 'canonical';
    payload: ExpensePayload;
  }>,
  theme: ChartTheme,
): {
  markers: CashflowChartMarker[];
  lastFullYear: number;
  fromYear: number;
} | null {
  const { retirementYear } = rc;
  const markers = lifeExpectancyMarkers(rc, theme);
  if (markers.length === 0) return null;

  const lastFullYear = Math.floor(
    Math.max(...markers.map((m) => m.fractionalYear)),
  );
  if (lastFullYear < retirementYear) return null;

  const earliestStart = findEarliestExpenseStartMonth(resolvedExpenses, rc.ctx);
  const fromYear = earliestStart
    ? Math.min(earliestStart.year, retirementYear)
    : retirementYear;
  // Surface the canonical teal retirement marker whenever the retirement
  // boundary falls within the chart's x-domain. The domain is
  // [fromYear, lastFullYear]; `fromYear <= retirementYear` (min with it
  // above) and `lastFullYear >= retirementYear` (guarded above), so the
  // boundary is always in range here — including the common
  // `fromYear === retirementYear` case where the chart starts at
  // retirement. Mirrors ExpensesPage's `buildProjection` so the form
  // preview and the list page render the marker identically. The SVG
  // engine clamps a left-edge marker into view so a marker at the very
  // start of the domain stays visible.
  const retirementFractional = isoToFractionalYear(rc.primaryRetirementIso);
  if (retirementFractional !== null) {
    markers.push({
      fractionalYear: retirementFractional,
      label: `Retires ${formatShortIsoMonth(rc.primaryRetirementIso)}`,
      color: CHART_COLORS[theme].retirementMarker,
    });
  }
  return { markers, lastFullYear, fromYear };
}

/** Trim trailing zero-`total` months so the single line ends at the
 *  last active month. Under Dec-31 death the line stays active through
 *  December of `deathYear`, and the death marker hugs that last data
 *  point (no floating gap). Pure. */
function trimTrailingZeroMonths(
  projected: ExpenseProjectionMonthlyPoint[],
): ExpenseProjectionMonthlyPoint[] {
  let lastNonZero = projected.length - 1;
  while (lastNonZero >= 0 && projected[lastNonZero].total === 0) {
    lastNonZero--;
  }
  return projected.slice(0, lastNonZero >= 0 ? lastNonZero + 1 : 0);
}

/** Tooltip member rows (name + birth year) for each member with a
 *  usable birthdate. Pure. */
function buildTooltipMembers(rc: ResolvedCtx): TooltipMember[] {
  const out: TooltipMember[] = [];
  const pushMember = (
    member: Aggregate<HouseholdMemberPayload> | null,
  ): void => {
    if (!member?.payload.birthdate) return;
    const birthYear = Number(member.payload.birthdate.slice(0, 4));
    if (!Number.isFinite(birthYear)) return;
    const firstName =
      member.payload.firstName.trim() ||
      (member.payload.isPrimary ? 'Primary' : 'Secondary');
    out.push({ firstName, birthYear });
  };
  pushMember(rc.primary);
  pushMember(rc.secondary);
  return out;
}

/**
 * Resolve the draft under the target scenario and project it in
 * isolation. Returns a guard discriminant when there is no amount or
 * the retirement / birthdate context cannot resolve, else the chart
 * inputs. Pure — no React, no IndexedDB.
 *
 * `theme` is passed explicitly so the component can recompute
 * the marker colors when `useTheme()`'s `resolvedTheme` flips — the
 * builder no longer reads the `.dark` class itself, which was
 * invisible to the component's `useMemo` + `React.memo` and left stale
 * colors on a live theme toggle.
 */
export function buildPreview(
  draft: ExpensePayload | null,
  members: Aggregate<HouseholdMemberPayload>[],
  scenarios: ScenarioAggregate[],
  targetScenarioId: string | null,
  theme: ChartTheme,
): PreviewResult {
  if (!draft || draft.amount <= 0) return { kind: 'no-amount' };
  try {
    const rc = resolveTargetCtx(members, scenarios, targetScenarioId);
    if ('kind' in rc) return rc;

    const problem = glideProblemForDraft(draft, rc);
    if (problem) return { kind: 'invalid-glide', message: problem };

    const resolvedExpenses = [
      { id: 'preview', source: 'canonical' as const, payload: draft },
    ];
    const marked = buildMarkers(rc, resolvedExpenses, theme);
    if (!marked) return { kind: 'unresolvable' };
    const { markers, lastFullYear, fromYear } = marked;

    const projected = projectExpensesByMonth(resolvedExpenses, rc.ctx, {
      from: fromYear,
      to: lastFullYear,
    });

    return {
      kind: 'ok',
      rows: trimTrailingZeroMonths(projected),
      markers,
      members: buildTooltipMembers(rc),
    };
  } catch {
    return { kind: 'unresolvable' };
  }
}
