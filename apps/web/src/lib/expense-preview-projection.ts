// Pure projection logic for the live single-expense form preview; `buildPreview` is the entry point.
// The context comes from `buildExpenseProjectionContext` under the form's target scenario, so the preview matches what Save produces.

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

/** Projected death year (`birthYear + ageYears`, Dec 31); an invalid birthdate returns `null`. */
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

/** ISO `YYYY-MM-DD` to fractional year; same arithmetic as ExpensesPage's `buildProjection`, so the markers land on the same x. */
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

function resolveEffectiveScenarioId(
  scenarios: ScenarioAggregate[],
  targetScenarioId: string | null,
): string | null {
  const baseScenario = scenarios.find((s) => s.payload.isPrimary) ?? null;
  return targetScenarioId && scenarios.some((s) => s.id === targetScenarioId)
    ? targetScenarioId
    : (baseScenario?.id ?? null);
}

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
 * Plain-language warning for an invalid glide, shown before projecting (an invalid
 * moving glide would render a misleading flat curve). It uses the Save path's
 * `glideProblem` validator, except that a neutral no-op glide (`isNeutralGlide`)
 * and one-off expenses (never glided; their glide section is hidden) return null,
 * so for a moving glide the preview and the Save block agree.
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
    // Keeps the retirement month so a mid-year retiree's month-precise rule evaluates correctly.
    month0: rc.ctx.retirementMonth0 ?? 0,
  };
  return glideProblem(draft.discretionaryGlide, rc.ctx, probe, draft.end);
}

// `theme` is a parameter so a live theme toggle re-flips the colors; reading it inside this pure
// builder was invisible to the component's `useMemo`.
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
    // Integer `deathYear`: the monthly chart maps it to December, so the marker hugs the last data point.
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
 * Life-expectancy markers plus the retirement marker. Null when no life-expectancy
 * marker computes or the window ends before retirement (both `unresolvable`).
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
  // The retirement boundary is always inside [fromYear, lastFullYear] here; the SVG engine
  // clamps a left-edge marker into view.
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

function trimTrailingZeroMonths(
  projected: ExpenseProjectionMonthlyPoint[],
): ExpenseProjectionMonthlyPoint[] {
  let lastNonZero = projected.length - 1;
  while (lastNonZero >= 0 && projected[lastNonZero].total === 0) {
    lastNonZero--;
  }
  return projected.slice(0, lastNonZero >= 0 ? lastNonZero + 1 : 0);
}

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
 * Resolves the draft under the target scenario and projects it in isolation: a
 * guard result when there is no amount or the context cannot resolve, else the
 * chart inputs. `theme` is a parameter so the marker colors follow a live toggle.
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
