/**
 * Roth conversion comparison — pure Apply write-back helpers.
 *
 * Two builders the Roth conversion comparison page calls on Apply. Both are pure: they assemble
 * the override fragments the page then merges into the scenario payload and
 * persists via `saveScenario` / `queueLocalMutation` with `expectedVersion`.
 *
 *  - `buildWorkingYearsConversionWindow` — one flat working-years
 *    `preRetirementRothConversions` window spanning the current calendar year →
 *    the retirement age, whose `annualAmountDollars` is the sum of every
 *    'convert'-verdict tranche from the single IRA-source tranche set.
 *  - `buildRetirementFillWindow` — one pre-RMD MAGI-cap Fill window
 *    `retirementStart → age:rmdTriggerAge` (73 born ≤1959 / 75 born ≥1960,
 *    SECURE 2.0 §107), filling up to the chosen MAGI line's cliff (the IRMAA
 *    tier-1 threshold or the ACA 400%-FPL boundary), routed through
 *    `buildNextMagiCap` (the single MAGI-cap persistence rule).
 *  - `buildSuggestionCapWindows` / `buildSuggestionCap` — a ranked suggestion's
 *    ladder as the scenario's whole MAGI-cap ladder (one year-anchored Fill
 *    window per searched year), routed through `buildNextMagiCap` the same way.
 */

import type {
  MagiCapLine,
  MagiCapOverride,
  MagiCapWindow,
  ScenarioOverrides,
} from '../db/types';
import type { ConversionTranche } from './betr-calculator';
import type { FilingStatus } from './federal-tax';
import { buildNextMagiCap } from './magi-cap-persistence';
import { resolveSnapshotYear, type TaxCalibrationBundle } from './tax-integration-helpers';
import { rmdTriggerAge } from './rmd';

/** Whole-dollar `preRetirementRothConversions` working-years window shape. */
export type PreRetirementRothConversionWindow = NonNullable<
  ScenarioOverrides['preRetirementRothConversions']
>[number];

const CENTS_FACTOR = 100;
/** ACA subsidy cliff — the §36B 400%-of-FPL boundary used by the retirement Fill window. */
export const ACA_FPL_CLIFF_MULTIPLE = 4;

/**
 * One flat working-years conversion window from the IRA-source tranche set.
 *
 * `annualAmountDollars` = sum of the 'convert'-verdict tranche amounts —
 * the bracket-fill amount analyzed. There is a SINGLE tranche set, computed
 * once by `computeWorkingYearsBETRSummary`; it is IRA-source-based (BETR =
 * T_now, n-independent) and does NOT vary per selected tax-payment source, so
 * the Apply amount is the same regardless of which source the user is viewing.
 *
 * The window reuses the EXACT `MagiCapWindow` anchor shapes the
 * `preRetirementRothConversions` schema requires: `start: { kind: 'year' }`,
 * `end: { kind: 'age', years: retirementAge }`.
 *
 * @param convertTranches The IRA-source tranche set (verdict filtered here).
 * @param sourceAccountId Pre-tax account the conversions draw from.
 * @param targetRothId    Destination Roth IRA (§408A guard enforced on resolve).
 * @param currentYear     The window's first calendar year.
 * @param retirementAge   The window's end age (exclusive — the year the owner
 *                        reaches it).
 */
export function buildWorkingYearsConversionWindow(args: {
  convertTranches: readonly ConversionTranche[];
  sourceAccountId: string;
  targetRothId: string;
  currentYear: number;
  retirementAge: number;
}): PreRetirementRothConversionWindow {
  const annualAmountCents = args.convertTranches
    .filter((t) => t.verdict === 'convert')
    .reduce((sum, t) => sum + t.amountCents, 0);
  return {
    sourceAccountId: args.sourceAccountId,
    targetRothAccountId: args.targetRothId,
    annualAmountDollars: annualAmountCents / CENTS_FACTOR,
    start: { kind: 'year', year: args.currentYear },
    end: { kind: 'age', memberId: 'primary', years: args.retirementAge, months: 0 },
  };
}

/**
 * The MAGI line's "fill to the cliff" annual ceiling in whole nominal dollars at
 * `retirementYear`. IRMAA → the tier-1 surcharge threshold; ACA → 400% of the
 * household-sized federal poverty line. Both base-year thresholds are scaled to
 * the retirement year via the same `resolveSnapshotYear` factor `applyTaxYear`
 * uses, so the ceiling lands in the same nominal dollars the engine compares the
 * year's MAGI against.
 */
function fillCeilingDollars(args: {
  magiLine: MagiCapLine;
  filingStatus: FilingStatus;
  householdSize: number;
  retirementYear: number;
  inflationRatePct: number;
  bundle: TaxCalibrationBundle;
}): number {
  if (args.magiLine === 'irmaa') {
    // IRMAA for year Y is assessed on the MAGI from year Y−2, so a conversion in
    // `retirementYear` moves the surcharge in `retirementYear + 2`; resolve the
    // surcharge year's table to price the fill ceiling against it (mirrors the
    // conversion-cost probe's `year + 2` IRMAA path).
    const { effectiveYear, thresholdScalingFactor } = resolveSnapshotYear(
      args.bundle.irmaa,
      args.retirementYear + 2,
      args.inflationRatePct,
    );
    const table = args.bundle.irmaa.values[effectiveYear];
    const entries = args.filingStatus === 'MFJ' ? table.byMfj : table.bySingle;
    return Math.round(entries[0].thresholdDollars * thresholdScalingFactor);
  }
  const { effectiveYear, thresholdScalingFactor } = resolveSnapshotYear(
    args.bundle.acaPtc,
    args.retirementYear,
    args.inflationRatePct,
  );
  const { fpl } = args.bundle.acaPtc.values[effectiveYear];
  const fplDollars = fpl.base + Math.max(0, args.householdSize - 1) * fpl.increment;
  // The ACA fill line is fixed at 400% FPL regardless of the snapshot's regime.
  // The 400% hard cliff is statutory only in `pre-arpa` (2026+), the
  // dominant retirement-year case; in `ira-expanded` years (2024-2025) 400% FPL
  // is the flat-8.5%-cap INFLECTION rather than a hard cliff, so the fill ceiling
  // there is a conservative subsidy benchmark, not a cliff.
  return Math.round(ACA_FPL_CLIFF_MULTIPLE * fplDollars * thresholdScalingFactor);
}

/**
 * One pre-RMD MAGI-cap Fill window `retirementStart → age:rmdTriggerAge`,
 * wrapped through `buildNextMagiCap` so it obeys the same persistence rule as
 * the withdrawal-strategy editor (a real child override unless it deep-equals an
 * inherited parent ladder). The window's ceiling fills up to the chosen MAGI
 * line's cliff (`fillCeilingDollars`); `capMode: 'fill'` auto-converts the
 * leftover headroom into `targetRothId`.
 *
 * The Fill ceiling is an IRMAA/ACA boundary — neither is on the federal-tax
 * snapshot — so this takes the full `TaxCalibrationBundle` plus the filing
 * status / household size / retirement year / inflation the IRMAA + ACA
 * snapshots need, rather than one federal snapshot. The output is the
 * persisted `magiCap` override fragment.
 *
 * @returns the `buildNextMagiCap` fragment the caller merges into `overrides`.
 */
export function buildRetirementFillWindow(args: {
  ownerBirthYear: number;
  retirementYear: number;
  magiLine: MagiCapLine;
  targetRothId: string;
  filingStatus: FilingStatus;
  householdSize: number;
  inflationRatePct: number;
  localOverrides: ScenarioOverrides;
  parentCap: MagiCapOverride | undefined;
  bundle: TaxCalibrationBundle;
}):
  | { magiCap: MagiCapOverride }
  | { magiCap?: undefined }
  | Record<string, never> {
  const triggerAge = rmdTriggerAge(args.ownerBirthYear);
  const ceilingDollars = fillCeilingDollars({
    magiLine: args.magiLine,
    filingStatus: args.filingStatus,
    householdSize: args.householdSize,
    retirementYear: args.retirementYear,
    inflationRatePct: args.inflationRatePct,
    bundle: args.bundle,
  });
  const window: MagiCapWindow = {
    start: { kind: 'retirementStart' },
    end: { kind: 'age', memberId: 'primary', years: triggerAge, months: 0 },
    magiCeilingAnnualDollars: ceilingDollars,
    capMode: 'fill',
    capMagiLine: args.magiLine,
    targetRothAccountId: args.targetRothId,
  };
  const fragment = buildNextMagiCap({
    magiCapEnabled: true,
    magiCapWindows: [window],
    localOverrides: args.localOverrides,
    parentCap: args.parentCap,
  });
  // buildNextMagiCap only returns the disable sentinel when magiCapEnabled is
  // false; with it true the result is the real `{ windows }` override or `{}`
  // (inheritance preserved). Narrow out the never-reached sentinel branch so the
  // caller's merge type stays a real MagiCapOverride.
  if ('magiCap' in fragment && fragment.magiCap !== undefined && 'disabled' in fragment.magiCap) {
    return {};
  }
  return fragment as
    | { magiCap: MagiCapOverride }
    | { magiCap?: undefined }
    | Record<string, never>;
}

/**
 * A ranked suggestion's ladder in the stored shape: one Fill window per searched
 * year, `year` anchors on both ends with equal years (the end resolves to the
 * exclusive boundary the next year starts at, so adjacent windows do not
 * overlap), ascending, each ceiling a whole non-negative dollar never above the
 * search's figure. The line and target Roth ride along per window, unchanged:
 * the line picks the MAGI definition the Fill step sizes against and the target
 * decides whether a conversion happens at all, so dropping either would convert
 * different amounts than the row showed. This is the only place the saved shape
 * is decided; the dialog and the saved-plan marker reuse its output.
 *
 * @throws {Error} on an empty ladder, a window that is not a one-year Fill
 *   window on a year anchor with a target Roth, or two windows for one year
 *   (the search never produces any of them; saving anything else would store a
 *   ladder that was not ranked).
 */
export function buildSuggestionCapWindows(ladder: readonly MagiCapWindow[]): MagiCapWindow[] {
  if (ladder.length === 0) throw new Error('This plan has no years to save.');
  const windows = ladder.map((w): MagiCapWindow => {
    if (
      w.start.kind !== 'year' ||
      w.end.kind !== 'year' ||
      w.start.year !== w.end.year ||
      w.capMode !== 'fill' ||
      w.targetRothAccountId === undefined
    ) {
      throw new Error('This plan is not a list of one-year Fill windows, so it cannot be saved.');
    }
    return {
      start: { kind: 'year', year: w.start.year },
      end: { kind: 'year', year: w.end.year },
      magiCeilingAnnualDollars: Math.max(0, Math.floor(w.magiCeilingAnnualDollars)),
      capMode: 'fill',
      capMagiLine: w.capMagiLine,
      targetRothAccountId: w.targetRothAccountId,
    };
  });
  const yearOf = (w: MagiCapWindow): number => (w.start.kind === 'year' ? w.start.year : 0);
  windows.sort((a, b) => yearOf(a) - yearOf(b));
  for (let i = 1; i < windows.length; i += 1) {
    if (yearOf(windows[i]) === yearOf(windows[i - 1])) {
      throw new Error('This plan has two windows for the same year, so it cannot be saved.');
    }
  }
  return windows;
}

/**
 * The `magiCap` fragment that saves a suggestion's ladder as the scenario's
 * whole ladder, through `buildNextMagiCap` so it obeys the same inheritance
 * rule as every other cap edit (omits the key when a child with no local cap
 * saves the parent's ladder; writes a local ladder over an explicit-disable
 * sentinel). Existing windows are replaced, as `buildRetirementFillWindow`
 * replaces them. Narrows the never-reached disable-sentinel branch the same way.
 */
export function buildSuggestionCap(args: {
  ladder: readonly MagiCapWindow[];
  localOverrides: ScenarioOverrides;
  parentCap: MagiCapOverride | undefined;
}): { magiCap: MagiCapOverride } | { magiCap?: undefined } | Record<string, never> {
  const fragment = buildNextMagiCap({
    magiCapEnabled: true,
    magiCapWindows: buildSuggestionCapWindows(args.ladder),
    localOverrides: args.localOverrides,
    parentCap: args.parentCap,
  });
  if ('magiCap' in fragment && fragment.magiCap !== undefined && 'disabled' in fragment.magiCap) {
    return {};
  }
  return fragment as
    | { magiCap: MagiCapOverride }
    | { magiCap?: undefined }
    | Record<string, never>;
}
