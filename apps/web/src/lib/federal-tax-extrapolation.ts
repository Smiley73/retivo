/** Inflation extrapolation of the federal `TaxConfig`: scales the latest published table when a year passes the snapshot's newest key. */

import type { CalibrationSnapshot } from './calibration';
import type {
  TaxConfig,
  TaxBracket,
  LtcgBracket,
  FilingStatusBrackets,
  LtcgBrackets,
} from './federal-tax';
import { resolveSnapshotYear } from './tax-integration-helpers';

const SENIOR_BONUS_DEDUCTION_LAST_YEAR = 2028;

// Floors round down (26 U.S.C. §1(f)(7)): $25 for the Single/MFS tables.
function roundBracketFloorDownTo25(scaled: number): number {
  return Math.floor(scaled / 25) * 25;
}

// $50 for joint returns, surviving spouses and heads of household (§1(f)(7)); §1(j)(5)(C) applies $50 to every LTCG/QDI threshold.
function roundBracketFloorDownTo50(scaled: number): number {
  return Math.floor(scaled / 50) * 50;
}

// Standard deduction and age-65 add-on round to the nearest $50; only bracket floors round down.
function roundDeductionToNearest50(scaled: number): number {
  return Math.round(scaled / 50) * 50;
}

function scaleBracketFloors<B extends TaxBracket>(
  brackets: readonly B[],
  factor: number,
  roundFloor: (scaled: number) => number,
): B[] {
  return brackets.map((b) => ({ ...b, floor: roundFloor(b.floor * factor) }));
}

function scaleLtcgBracketFloors<B extends LtcgBracket>(
  brackets: readonly B[],
  factor: number,
): B[] {
  return brackets.map((b) => ({ ...b, floor: roundBracketFloorDownTo50(b.floor * factor) }));
}

/**
 * Inflation-scaled `TaxConfig` for a tax year past the latest published table. Ordinary floors round down
 * to $25 (Single/MFS) or $50 (MFJ/HoH/QSS) per 26 U.S.C. §1(f)(7), LTCG floors down to $50 (§1(j)(5)(C)),
 * and standard deductions and age-65 add-ons to the nearest $50; NIIT thresholds stay frozen. The OBBBA
 * senior bonus deduction carries forward only through 2028 (kept as-is when `targetYear` is omitted).
 * `factor` is `thresholdScalingFactor` from `resolveSnapshotYear`; factor 1 still normalizes floors to the
 * rounding step, so HoH's published $201,775 floor becomes $201,750.
 */
function buildScaledFederalTaxConfig(
  base: TaxConfig,
  factor: number,
  targetYear?: number,
): TaxConfig {
  // QSS reuses the scaled MFJ array so QSS-computes-like-MFJ holds in extrapolated years (federal-tax.ts).
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
    const mfj = scaleLtcgBracketFloors(b.MFJ, factor);
    return {
      Single: scaleLtcgBracketFloors(b.Single, factor),
      MFJ: mfj,
      HoH: scaleLtcgBracketFloors(b.HoH, factor),
      MFS: scaleLtcgBracketFloors(b.MFS, factor),
      QSS: mfj,
    };
  };
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
    niitThresholds: { ...base.niitThresholds },
    ltcgBrackets: scaleLtcg(base.ltcgBrackets),
    ...(seniorBonusDeduction !== undefined ? { seniorBonusDeduction } : {}),
  };
}

const FEDERAL_SNAPSHOT_MEMO = new WeakMap<
  CalibrationSnapshot<TaxConfig>,
  Map<string, { lookupYear: number; snapshot: CalibrationSnapshot<TaxConfig>; taxYearExtrapolated: boolean }>
>();
const FEDERAL_SNAPSHOT_MEMO_MAX_ENTRIES = 128;

/**
 * Snapshot and lookup year to pass to `computeFederalTax`: the original snapshot with the clamped year within
 * the published range, otherwise a synthesized inflation-scaled snapshot keyed by the future year. Memoized
 * per `(snapshot, taxYear, inflationRatePct)`; results are shared instances.
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
    // Freeze so a stray mutation of the shared cached config throws instead of drifting every read.
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
