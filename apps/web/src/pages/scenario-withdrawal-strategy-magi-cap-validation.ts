/**
 * MAGI-cap WINDOW SCHEDULE save-time validation.
 *
 * Pure helpers shared by the modal (save gate) and the section (inline notices):
 *   - `magiCapWindowsCeilingError` — every window's ceiling must be entered.
 *   - `magiCapWindowOverlapError` — resolved windows must NOT overlap.
 *
 * Window anchors resolve against the household members' birthdates the modal
 * already holds (`HouseholdMemberPayload.birthdate`) AND the scenario's real
 * primary retirement year/month (`resolveScenarioRetirementAnchor`). Resolution
 * reuses the shared `resolveStartMonth` / `resolveEndMonth` so the UI's overlap
 * check uses the SAME `[startYear, endYear)` collapse the engine does. A
 * window whose anchor can't resolve (member with no birthdate) is excluded from
 * the overlap math here — the engine surfaces it as a per-window broken-anchor
 * notice.
 *
 * The retirement anchor MUST be the scenario's real `primaryRetirementYear` /
 * `retirementMonth0`: a ladder mixing `retirementStart`-anchored windows with
 * absolute `year`/`age` windows only overlaps correctly when the static and
 * retirement-relative anchors resolve against the SAME calendar baseline the
 * engine uses.
 */
import type { Aggregate, HouseholdMemberPayload } from '../db/types';
import {
  resolveStartMonth,
  resolveEndMonth,
  type ScheduleResolveContext,
} from '../lib/schedule-resolution';
import { resolveMemberRetirementDates } from '../lib/retirement-date-math';
import { resolveScenario, type ScenarioAggregate } from '../lib/scenario-resolution';
import type { DraftMagiCapWindow } from './scenario-withdrawal-strategy-shared';

/** Resolved `retirementStart` baseline for cap-window anchor resolution: the
 *  scenario's real primary retirement year + 0-indexed month. */
export interface MagiCapRetirementAnchor {
  retirementYear: number;
  retirementMonth0: number;
}

/** Fallback year used only when the scenario's primary retirement date can't be
 *  resolved (e.g. missing birthdate / age). Overlap between two windows that
 *  ALL anchor to `retirementStart` is invariant under the choice of year, so a
 *  stable synthetic year keeps the all-retirement-relative case correct; the
 *  mixed-anchor case relies on the real year being threaded in. */
const SYNTHETIC_RETIREMENT_YEAR = 2000;

/**
 * Resolve the scenario's real primary retirement year + 0-indexed month for
 * cap-window anchor resolution. Mirrors the engine's derivation:
 * `resolveScenario` (inheritance merge) → `resolveMemberRetirementDates`. Falls
 * back to the synthetic year when the primary's retirement date can't resolve
 * (no birthdate / age) — the all-`retirementStart` ladder is invariant to the
 * baseline, and the validator never blocks on an unresolved anchor.
 */
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

/** True when any window's ceiling has not been entered yet (blocks save).
 *  The modal turns this into the save gate; the section shows a per-window hint. */
function magiCapWindowsCeilingError(
  windows: DraftMagiCapWindow[],
): string | null {
  const missing = windows.some((w) => w.magiCeilingAnnualDollars === null);
  return missing
    ? 'Enter an annual cap for every window before saving.'
    : null;
}

/** Build a `ScheduleResolveContext` from the modal's member list and the
 *  scenario's real retirement anchor. A mixed `retirementStart` +
 *  absolute `year`/`age` ladder only overlaps correctly when both anchor
 *  families resolve against the engine's real `primaryRetirementYear`. */
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

/** Resolve a window's start AND end months, or `null` when either anchor can't
 *  resolve (broken — a member with no birthdate). Unlike `resolveWindowInterval`
 *  this does NOT reject an end that lands on/before the start: the caller decides
 *  whether that's an excluded interval (overlap math) or a reportable error
 *  (timeframe validation). */
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

/** Resolve one window to a half-open `[startYear, endYear)` interval, or `null`
 *  when an anchor can't resolve (broken) OR the end lands on/before the start
 *  (inverted — `magiCapWindowTimeframeError` reports that separately). Both
 *  cases are excluded from the overlap check. */
function resolveWindowInterval(
  window: DraftMagiCapWindow,
  ctx: ScheduleResolveContext,
): { startYear: number; endYear: number } | null {
  const months = resolveWindowMonths(window, ctx);
  if (!months) return null;
  if (months.end.year <= months.start.year) return null;
  return { startYear: months.start.year, endYear: months.end.year };
}

/**
 * Timeframe validation (blocks save): a window whose start AND end both resolve
 * but whose end lands on or before the start covers no whole year and is
 * invalid. A window with an unresolvable anchor is NOT reported here (it's a
 * separate per-window broken-anchor notice). `anchor` is the scenario's
 * real primary retirement year/month.
 */
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

/**
 * Tab labels for the windowed editor: a window whose start AND end resolve to a
 * year span shows that span as `<firstYear> - <lastYear>` (e.g. `2050 - 2055`).
 * When only the start resolves — e.g. a "start of retirement" anchor whose end
 * isn't a full year past it yet — the label shows `From <startYear>` so the user
 * still sees the year they picked. A window whose start can't resolve (member
 * with no birthdate) falls back to `Window <n>`. The resolved interval is
 * half-open `[startYear, endYear)`, so the last capped year shown is
 * `endYear - 1` — a window the user enters as 2050→2055 reads back as
 * `2050 - 2055`. A one-year window (a saved Roth conversion plan is a list of
 * them) is labelled by its year alone. `anchor` is the scenario's real primary retirement year/month
 * — same baseline the overlap check uses.
 */
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
    // Half-open [startYear, endYear): the last capped year is endYear - 1.
    const lastYear = endMonth ? endMonth.year - 1 : null;
    if (lastYear === startMonth.year) return `${startMonth.year}`;
    return lastYear !== null && lastYear >= startMonth.year
      ? `${startMonth.year} - ${lastYear}`
      : `From ${startMonth.year}`;
  });
}

/**
 * Non-overlap validation. Resolves every window to a year interval and
 * reports the first overlapping pair (half-open `[startYear, endYear)`;
 * `endYear === next.startYear` is valid adjacency, not an overlap). Returns
 * `null` when the windows are disjoint (or fewer than two resolve). Used inline
 * by the section and as part of the modal save gate. `anchor` is the scenario's
 * real primary retirement year/month.
 */
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
    // Sorted by start; an overlap exists iff this window starts before the
    // previous one ends (strict — adjacency `start === prev.end` is allowed).
    if (intervals[i].startYear < intervals[i - 1].endYear) {
      return 'Cap windows must not overlap. Adjust a window so each covers a separate stretch of years.';
    }
  }
  return null;
}

/** Combined save gate: required ceilings, THEN valid timeframes (end after
 *  start), THEN non-overlap. Returns the first blocking message, or `null`
 *  when the ladder is saveable. `anchor` is the scenario's real primary
 *  retirement year/month. */
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
