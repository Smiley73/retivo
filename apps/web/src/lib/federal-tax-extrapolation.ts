/**
 * Federal tax-config inflation extrapolation — synthesizes a future-year
 * `TaxConfig` by scaling the latest published table's dollar thresholds when a
 * projection year runs past the calibration snapshot's newest key. Extracted
 * from tax-integration-helpers.ts (shape-limit split).
 *
 * Consumers should continue importing from `./tax-integration` (or
 * `./tax-integration-helpers`) — both re-export everything declared here.
 */

import type { CalibrationSnapshot } from './calibration';
import type {
  TaxConfig,
  TaxBracket,
  LtcgBracket,
  FilingStatusBrackets,
  LtcgBrackets,
} from './federal-tax';
import { resolveSnapshotYear } from './tax-integration-helpers';

/** Last tax year the OBBBA senior bonus deduction is available (statutory
 *  expiry). Extrapolated configs for a year past this never carry the slot. */
const SENIOR_BONUS_DEDUCTION_LAST_YEAR = 2028;

/** Round a scaled ordinary-bracket floor DOWN to the next-lowest $25. The
 *  inflation adjustment is rounded DOWN (26 U.S.C. §1(f)(7)), and the $25 (rather
 *  than $50) granularity applies to the Single/MFS ordinary tables — §1(f)(7)
 *  reserves the $50 rounding for joint returns, surviving spouses, and heads of
 *  household, leaving Single and MFS on the $25 step. (`Math.floor`, not
 *  round-to-nearest.) */
function roundBracketFloorDownTo25(scaled: number): number {
  return Math.floor(scaled / 25) * 25;
}

/** Round a scaled bracket floor DOWN to the next-lowest $50. The inflation
 *  adjustment for the MFJ/HoH/QSS ordinary tables rounds DOWN to the next-lowest
 *  $50 — 26 U.S.C. §1(f)(7) explicitly groups "joint returns or surviving
 *  spouses, and ... heads of households" together at the $50 step; §1(j)(5)(C)
 *  applies the same $50 floor granularity to ALL LTCG/QDI capital-gain
 *  thresholds. (`Math.floor`, not round-to-nearest.) */
function roundBracketFloorDownTo50(scaled: number): number {
  return Math.floor(scaled / 50) * 50;
}

/** Round a scaled standard-deduction / age-65 add-on amount to the nearest $50
 *  (round-half-up). Unchanged by the extrapolation-rounding-floor corrections —
 *  only the ordinary + LTCG bracket floors round DOWN to the statutory
 *  granularity. */
function roundDeductionToNearest50(scaled: number): number {
  return Math.round(scaled / 50) * 50;
}

/** Scale ORDINARY bracket floors by `factor`, rounding each DOWN via `roundFloor`
 *  — the caller passes the status-correct $25 (Single/MFS) or $50 (MFJ/HoH/QSS)
 *  granularity per 26 U.S.C. §1(f)(7); the first floor (0) stays 0 (0 × factor =
 *  0). Rate is unchanged. */
function scaleBracketFloors<B extends TaxBracket>(
  brackets: readonly B[],
  factor: number,
  roundFloor: (scaled: number) => number,
): B[] {
  return brackets.map((b) => ({ ...b, floor: roundFloor(b.floor * factor) }));
}

/** Scale LTCG/QDI bracket floors by `factor`, rounding each DOWN to the
 *  next-lowest $50 (IRC §1(j)(5)(C) — the capital-gain thresholds use the $50
 *  granularity, NOT the ordinary-bracket $25, and round DOWN like the ordinary
 *  floors). The first floor (0) stays 0. Rate is unchanged. */
function scaleLtcgBracketFloors<B extends LtcgBracket>(
  brackets: readonly B[],
  factor: number,
): B[] {
  return brackets.map((b) => ({ ...b, floor: roundBracketFloorDownTo50(b.floor * factor) }));
}

/**
 * Build an inflation-scaled `TaxConfig` for a future tax year beyond the
 * latest published federal table. Ordinary-bracket floors are multiplied by
 * `factor` and rounded DOWN to the statutory granularity (26 U.S.C. §1(f)(7)):
 * $25 for the Single/MFS tables, $50 for the MFJ/HoH/QSS tables; LTCG-bracket
 * floors are scaled and rounded DOWN to the next-lowest $50 (§1(j)(5)(C) — the
 * capital-gain thresholds use the $50 granularity); standard
 * deductions and age-65 add-ons are scaled and rounded to the nearest $50.
 * NIIT thresholds stay frozen (statutorily not CPI-indexed), matching
 * `computeFederalTax`'s contract.
 *
 * The OBBBA senior bonus deduction (not CPI-indexed) is carried forward
 * unchanged only when `targetYear` is within its 2025–2028 statutory window;
 * past 2028 the slot is dropped so the deduction expires (year-gated by config
 * presence). When `targetYear` is omitted the base slot is preserved as-is.
 *
 * `factor` is the `thresholdScalingFactor` returned by `resolveSnapshotYear`
 * for the federal snapshot; passing 1 normalizes every bracket floor to its
 * statutory rounding step rather than guaranteeing a value-equal copy — for
 * HoH specifically, the published 32% floor ($201,775) is not itself a $50
 * multiple, so factor 1 legitimately maps it to $201,750 (see the
 * status-aware rounding note above).
 */
export function buildScaledFederalTaxConfig(
  base: TaxConfig,
  factor: number,
  targetYear?: number,
): TaxConfig {
  // MFS carries its own calibrated floors (scaled like the others). QSS
  // reuses the scaled MFJ result so the QSS-computes-like-MFJ invariant holds in
  // extrapolated years too (federal-tax.ts).
  // Ordinary floors round DOWN status-aware per §1(f)(7) — Single/MFS to
  // $25, MFJ/HoH/QSS to $50. §1(f)(7) explicitly groups joint returns, surviving
  // spouses, and heads of household together at the $50 step, so HoH rounds with
  // MFJ/QSS, NOT Single/MFS. QSS inherits the (now-$50-scaled) MFJ array; HoH keeps
  // its own $50-scaled floors.
  const scaleStatusBrackets = (b: FilingStatusBrackets): FilingStatusBrackets => {
    const mfj = scaleBracketFloors(b.MFJ, factor, roundBracketFloorDownTo50);
    return {
      Single: scaleBracketFloors(b.Single, factor, roundBracketFloorDownTo25),
      MFJ: mfj,
      HoH: scaleBracketFloors(b.HoH, factor, roundBracketFloorDownTo50),
      MFS: scaleBracketFloors(b.MFS, factor, roundBracketFloorDownTo25),
      QSS: mfj,
    };
  };
  const scaleLtcg = (b: LtcgBrackets): LtcgBrackets => {
    // LTCG floors round DOWN to $50, not the ordinary-bracket $25.
    const mfj = scaleLtcgBracketFloors(b.MFJ, factor);
    return {
      Single: scaleLtcgBracketFloors(b.Single, factor),
      MFJ: mfj,
      HoH: scaleLtcgBracketFloors(b.HoH, factor),
      MFS: scaleLtcgBracketFloors(b.MFS, factor),
      QSS: mfj,
    };
  };
  // Carry the senior bonus deduction forward only inside its statutory window.
  const seniorBonusDeduction =
    base.seniorBonusDeduction !== undefined &&
    (targetYear === undefined || targetYear <= SENIOR_BONUS_DEDUCTION_LAST_YEAR)
      ? base.seniorBonusDeduction
      : undefined;
  return {
    brackets: scaleStatusBrackets(base.brackets),
    standardDeduction: {
      Single: roundDeductionToNearest50(base.standardDeduction.Single * factor),
      MFJ: roundDeductionToNearest50(base.standardDeduction.MFJ * factor),
      HoH: roundDeductionToNearest50(base.standardDeduction.HoH * factor),
      MFS: roundDeductionToNearest50(base.standardDeduction.MFS * factor),
      // QSS standard deduction = MFJ (§63(c)(2)).
      QSS: roundDeductionToNearest50(base.standardDeduction.MFJ * factor),
    },
    age65AddOn: {
      singleOrHoH: roundDeductionToNearest50(base.age65AddOn.singleOrHoH * factor),
      mfj: roundDeductionToNearest50(base.age65AddOn.mfj * factor),
    },
    // NIIT thresholds are NOT CPI-indexed — frozen at 2013 enactment levels.
    niitThresholds: { ...base.niitThresholds },
    ltcgBrackets: scaleLtcg(base.ltcgBrackets),
    ...(seniorBonusDeduction !== undefined ? { seniorBonusDeduction } : {}),
  };
}

/** Same cache shape as `tax-integration-helpers.ts`'s
 *  `resolveSnapshotYear` (duplicated per-module on purpose: this 6-line pattern
 *  is copied rather than extracted into a shared helper across
 *  modules, keeping each file's diff local). */
const FEDERAL_SNAPSHOT_MEMO = new WeakMap<
  CalibrationSnapshot<TaxConfig>,
  Map<string, { lookupYear: number; snapshot: CalibrationSnapshot<TaxConfig>; taxYearExtrapolated: boolean }>
>();
const FEDERAL_SNAPSHOT_MEMO_MAX_ENTRIES = 128;

/**
 * Resolve the `CalibrationSnapshot<TaxConfig>` + lookup year to pass to
 * `computeFederalTax` for a projection year. For years within the
 * published range, the original snapshot + clamped `effectiveYear` are
 * returned unchanged. For years beyond the latest published table, a
 * synthesized snapshot keyed by the numeric future year is returned with an
 * inflation-scaled config so `computeFederalTax` indexes future-year
 * thresholds, not the frozen latest-year ones.
 *
 * Memoized per `(snapshot identity, taxYear, inflationRatePct)` —
 * non-extrapolated years cache too (uniform code path), returning the shared
 * original `snapshot` instance; extrapolated years cache the synthesized
 * scaled snapshot as a shared instance.
 */
export function resolveFederalTaxSnapshotForYear(
  snapshot: CalibrationSnapshot<TaxConfig>,
  taxYear: number,
  inflationRatePct?: number,
): { lookupYear: number; snapshot: CalibrationSnapshot<TaxConfig>; taxYearExtrapolated: boolean } {
  let memo = FEDERAL_SNAPSHOT_MEMO.get(snapshot);
  if (memo === undefined) {
    memo = new Map();
    FEDERAL_SNAPSHOT_MEMO.set(snapshot, memo);
  }
  const cacheKey = `${taxYear}|${inflationRatePct}`;
  const cached = memo.get(cacheKey);
  if (cached !== undefined) return cached;

  const { effectiveYear, taxYearExtrapolated, thresholdScalingFactor } = resolveSnapshotYear(
    snapshot,
    taxYear,
    inflationRatePct,
  );
  let result: { lookupYear: number; snapshot: CalibrationSnapshot<TaxConfig>; taxYearExtrapolated: boolean };
  if (!taxYearExtrapolated) {
    result = { lookupYear: effectiveYear, snapshot, taxYearExtrapolated };
  } else {
    const base = snapshot.values[effectiveYear];
    const scaled = buildScaledFederalTaxConfig(base, thresholdScalingFactor, taxYear);
    // Freeze the synthesized config itself (not just the outer wrapper) — a
    // stray future mutation of the cached, shared-across-paths federal config
    // throws loudly instead of silently drifting every subsequent read.
    Object.freeze(scaled);
    const synthesized: CalibrationSnapshot<TaxConfig> = {
      values: Object.freeze({ [taxYear]: scaled }),
      metadata: snapshot.metadata,
    };
    Object.freeze(synthesized);
    result = { lookupYear: taxYear, snapshot: synthesized, taxYearExtrapolated };
  }
  Object.freeze(result);
  if (memo.size >= FEDERAL_SNAPSHOT_MEMO_MAX_ENTRIES) {
    const oldestKey = memo.keys().next().value;
    if (oldestKey !== undefined) memo.delete(oldestKey);
  }
  memo.set(cacheKey, result);
  return result;
}
