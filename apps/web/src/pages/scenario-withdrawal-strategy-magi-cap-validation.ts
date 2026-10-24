/** Save-time validation for MAGI-cap windows: ceilings entered, valid timeframes, no overlap. Anchors resolve against the scenario's real primary retirement year/month, the baseline the engine uses; a window with an unresolvable anchor is excluded from the overlap math. */
import type { Aggregate, HouseholdMemberPayload } from '../db/types';
import {
  resolveStartMonth,
  resolveEndMonth,
  type ScheduleResolveContext,
} from '../lib/schedule-resolution';
import { resolveMemberRetirementDates } from '../lib/retirement-date-math';
import { resolveScenario, type ScenarioAggregate } from '../lib/scenario-resolution';
import type { DraftMagiCapWindow } from './scenario-withdrawal-strategy-shared';

export interface MagiCapRetirementAnchor {
  retirementYear: number;
  retirementMonth0: number;
}

// Used only when the primary's retirement date can't resolve; overlap among all-retirementStart windows is invariant to the year.
const SYNTHETIC_RETIREMENT_YEAR = 2000;

export function resolveScenarioRetirementAnchor(
  scenario: ScenarioAggregate,
  scenarios: ReadonlyArray<ScenarioAggregate>,
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): MagiCapRetirementAnchor {
  const fallback: MagiCapRetirementAnchor = {
    retirementYear: SYNTHETIC_RETIREMENT_YEAR,
    retirementMonth0: 0,
  };
  const primary = members.find((m) => m.payload.isPrimary);
  if (!primary) return fallback;
  try {
    const resolved = resolveScenario(scenario.id, scenarios as ScenarioAggregate[]);
    const map = resolveMemberRetirementDates(
      resolved.retirementAge,
      members.map((m) => ({
        id: m.id,
        isPrimary: m.payload.isPrimary,
        birthdate: m.payload.birthdate ?? '',
      })),
    );
    const iso = map.get(primary.id);
    if (!iso) return fallback;
    return {
      retirementYear: Number(iso.slice(0, 4)),
      retirementMonth0: Number(iso.slice(5, 7)) - 1,
    };
  } catch {
    return fallback;
  }
}

function magiCapWindowsCeilingError(
  windows: DraftMagiCapWindow[],
): string | null {
  const missing = windows.some((w) => w.magiCeilingAnnualDollars === null);
  return missing
    ? 'Enter an annual cap for every window before saving.'
    : null;
}

function buildResolveCtx(
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
  anchor: MagiCapRetirementAnchor,
): ScheduleResolveContext {
  const primary = members.find((m) => m.payload.isPrimary)?.payload.birthdate;
  const secondary = members.find((m) => !m.payload.isPrimary)?.payload.birthdate;
  return {
    retirementYear: anchor.retirementYear,
    retirementMonth0: anchor.retirementMonth0,
    primary: primary ? { birthdate: primary } : undefined,
    secondary: secondary ? { birthdate: secondary } : undefined,
  };
}

function resolveWindowMonths(
  window: DraftMagiCapWindow,
  ctx: ScheduleResolveContext,
): { start: { year: number }; end: { year: number } } | null {
  const start = resolveStartMonth(window.start, ctx);
  if (!start) return null;
  const end = resolveEndMonth(window.end, start, ctx);
  if (!end) return null;
  return { start, end };
}

// Half-open [startYear, endYear); a null result (broken anchor or inverted end) is excluded from the overlap check.
function resolveWindowInterval(
  window: DraftMagiCapWindow,
  ctx: ScheduleResolveContext,
): { startYear: number; endYear: number } | null {
  const months = resolveWindowMonths(window, ctx);
  if (!months) return null;
  if (months.end.year <= months.start.year) return null;
  return { startYear: months.start.year, endYear: months.end.year };
}

/** Blocks save when a window's end lands on or before its start; unresolvable anchors are reported separately. */
export function magiCapWindowTimeframeError(
  windows: DraftMagiCapWindow[],
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
  anchor: MagiCapRetirementAnchor,
): string | null {
  const ctx = buildResolveCtx(members, anchor);
  const inverted = windows.some((w) => {
    const months = resolveWindowMonths(w, ctx);
    return months !== null && months.end.year <= months.start.year;
  });
  return inverted
    ? "A cap window's end must come after its start. Adjust the start or end so the window covers at least one year."
    : null;
}

/** Tab labels: `<first> - <last>` for a resolved span (half-open, so last is endYear - 1), `From <startYear>` when only the start resolves, `Window <n>` otherwise; a one-year window is labelled by its year alone. */
export function magiCapWindowTabLabels(
  windows: DraftMagiCapWindow[],
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
  anchor: MagiCapRetirementAnchor,
): string[] {
  const ctx = buildResolveCtx(members, anchor);
  return windows.map((w, i) => {
    const startMonth = resolveStartMonth(w.start, ctx);
    if (!startMonth) return `Window ${i + 1}`;
    const endMonth = resolveEndMonth(w.end, startMonth, ctx);
    const lastYear = endMonth ? endMonth.year - 1 : null;
    if (lastYear === startMonth.year) return `${startMonth.year}`;
    return lastYear !== null && lastYear >= startMonth.year
      ? `${startMonth.year} - ${lastYear}`
      : `From ${startMonth.year}`;
  });
}

/** Reports the first overlapping pair; adjacency (endYear === next.startYear) is valid. */
export function magiCapWindowOverlapError(
  windows: DraftMagiCapWindow[],
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
  anchor: MagiCapRetirementAnchor,
): string | null {
  const ctx = buildResolveCtx(members, anchor);
  const intervals = windows
    .map((w) => resolveWindowInterval(w, ctx))
    .filter((i): i is { startYear: number; endYear: number } => i !== null)
    .sort((a, b) => a.startYear - b.startYear || a.endYear - b.endYear);
  for (let i = 1; i < intervals.length; i += 1) {
    if (intervals[i].startYear < intervals[i - 1].endYear) {
      return 'Cap windows must not overlap. Adjust a window so each covers a separate stretch of years.';
    }
  }
  return null;
}

/** Combined save gate: ceilings, then timeframes, then non-overlap; the first blocking message or null. */
export function magiCapWindowsSaveError(
  windows: DraftMagiCapWindow[],
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
  anchor: MagiCapRetirementAnchor,
): string | null {
  return (
    magiCapWindowsCeilingError(windows) ??
    magiCapWindowTimeframeError(windows, members, anchor) ??
    magiCapWindowOverlapError(windows, members, anchor)
  );
}
