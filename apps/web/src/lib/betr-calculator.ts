// Roth conversion break-even tax rate (BETR) math: pure functions for the four tax-payment-source
// variants, per-bracket tranches with convert/hold verdicts, and the working-years and retirement-years analyses.

import type { AcaFplRegion } from './aca-ptc';
import {
  marginalOrdinaryRate,
  nextBracketCeiling,
  SENIOR_BONUS_DEDUCTION_LAST_YEAR,
  type FilingStatus,
  type TaxConfig,
} from './federal-tax';
import { resolveFederalTaxSnapshotForYear } from './federal-tax-extrapolation';
import { EARLY_WITHDRAWAL_PENALTY_RATE } from './early-withdrawal-penalty';
import { rmdTriggerAge } from './rmd';
import {
  computeAllInConversionCost,
  type AllInConversionCostInput,
} from './conversion-cost-calculator';
import type { CalibrationSnapshot } from './calibration';
import type { TaxCalibrationBundle } from './tax-integration-helpers';
import type { DrawdownYear } from './drawdown-engine-types';

/** The four tax-payment-source variants a BETR can be computed for. */
export type BETRSource = 'ira' | 'taxEfficient' | 'taxInefficient' | 'cash';

/**
 * Per-source BETR knobs, all optional. `rSrc` defaults to `rIra`; `dragPct` to the
 * per-source default; `cashRatePct` (the `cash` source, ordinary income dragged at
 * `T_now`) to `rSrc`. `under59Penalty` (`ira` source only, display-only) means the
 * tax-payment withdrawal is before 59½, so the from-IRA BETR is
 * `T_now × (1 + EARLY_WITHDRAWAL_PENALTY_RATE)`.
 */
export interface BETROpts {
  readonly rSrc?: number;
  readonly dragPct?: number;
  readonly cashRatePct?: number;
  readonly under59Penalty?: boolean;
}

export interface ConversionTranche {
  readonly amountCents: number;
  readonly T_now: number;
  readonly betr: number;
  readonly verdict: 'convert' | 'hold';
  readonly allInRate?: number;
}

interface BracketHeadroomResult {
  readonly headroomCents: number;
  readonly ceilingCents: number;
  readonly currentRate: number;
}

export interface WorkingYearsBETRSummary {
  readonly bracketHeadroomCents: number;
  readonly T_future: number;
  readonly rmdTriggerAge: 73 | 75;
  readonly tranches: readonly ConversionTranche[];
  readonly convertTotalCents: number;
}

export interface RetirementYearBETRRow {
  readonly drawdownYear: DrawdownYear;
  readonly T_now: number;
  readonly T_future: number;
  readonly n: number;
  readonly tranches: readonly ConversionTranche[];
  readonly allInRate: number;
}

/**
 * Minimal scenario context the BETR functions consume, kept narrow so the math
 * stays pure. The method is under "The break-even comparison" in
 * `docs/math-retirement-accounts.md`.
 */
export interface BETRScenarioContext {
  readonly filingStatus: FilingStatus;
  readonly ownerBirthYear: number;
  readonly taxpayersAge65Plus: number;
  /** n=0 horizon anchor: the life-expectancy year. */
  readonly lifeExpectancyAnchorYear: number;
  readonly currentCalendarYear: number;
  readonly retirementYear: number;
  readonly preRetirementTaxableIncomeDollars?: number;
  readonly existingAnnualConversionDollars: number;
  readonly rIra: number;
  readonly grossSsAnnualCents: number;
  readonly beneficiariesOnMedicareCount: 0 | 1 | 2;
  readonly householdSize: number;
  readonly benchmarkAnnualSlcspCents: number;
  /** Sizes the lost credit against the projection's poverty line. Absent: `'contiguous'`. */
  readonly acaFplRegion?: AcaFplRegion;
  /** Marketplace coverage months in the retirement year, to prorate the expected contribution. Absent: 12. */
  readonly acaCoverageMonths?: number;
  readonly inflationRatePct: number;
  readonly taxExemptInterestCents: number;
}

/** Exported so the page can pass the selected source's slider override while other rows keep their default. */
export const DEFAULT_DRAG_BY_SOURCE: Record<BETRSource, number> = {
  ira: 0,
  taxEfficient: 0.1,
  taxInefficient: 0.25,
  cash: 0,
};

/** IRA opportunity-cost growth rate for the BETR term, fixed at 7% whatever the scenario's real return. */
export const DEFAULT_IRA_GROWTH_RATE = 0.07 as const;

const CENTS_FACTOR = 100;

/**
 * Break-even tax rate for one tax-payment source. From-IRA it is `T_now`,
 * whatever n and r (paying the tax from the IRA is source-agnostic); with
 * `under59Penalty` only the withheld-tax leg is penalized, since the conversion
 * principal is not a distribution. From outside it is
 * `T_now × ((1 + r_src_aft) / (1 + r_ira))^n`, the opportunity cost of the outside
 * dollar that would have compounded; `n = 0` gives `T_now` for every source.
 * Degenerate rates (near -1) stay finite.
 *
 * @param T_now Current marginal rate (fraction).
 * @param n Years of compounding (>= 0).
 * @param rIra IRA growth rate (fraction).
 */
export function computeBETR(
  source: BETRSource,
  T_now: number,
  n: number,
  rIra: number,
  opts: BETROpts,
): number {
  if (source === 'ira') {
    return opts.under59Penalty ? T_now * (1 + EARLY_WITHDRAWAL_PENALTY_RATE) : T_now;
  }
  if (n <= 0) return T_now;

  const drag = opts.dragPct ?? DEFAULT_DRAG_BY_SOURCE[source];
  let rSrcAfterDrag: number;
  if (source === 'cash') {
    const cashRate = opts.cashRatePct ?? opts.rSrc ?? rIra;
    rSrcAfterDrag = cashRate * (1 - T_now);
  } else {
    const rSrc = opts.rSrc ?? rIra;
    rSrcAfterDrag = rSrc * (1 - drag);
  }

  // Floored above 0 so a rate <= -1 yields a finite result, not NaN or Infinity.
  const srcBase = Math.max(1e-9, 1 + rSrcAfterDrag);
  const iraBase = Math.max(1e-9, 1 + rIra);
  return T_now * Math.pow(srcBase / iraBase, n);
}

/**
 * Headroom before the next ordinary bracket boundary: `max(0, ceiling − taxableIncome − conversion)`.
 * `taxableIncomeCents` is already post-deduction.
 */
function computeBracketHeadroom(
  taxableIncomeCents: number,
  conversionCents: number,
  year: number,
  filingStatus: FilingStatus,
  snapshot: CalibrationSnapshot<TaxConfig>,
): BracketHeadroomResult {
  const ceilingCents = nextBracketCeiling(taxableIncomeCents, year, filingStatus, snapshot);
  // Takes dollars; the headroom math is in cents.
  const currentRate = marginalOrdinaryRate(
    year,
    filingStatus,
    taxableIncomeCents / CENTS_FACTOR,
    snapshot,
  );
  if (!Number.isFinite(ceilingCents)) {
    return { headroomCents: Infinity, ceilingCents, currentRate };
  }
  const headroomCents = Math.max(0, ceilingCents - taxableIncomeCents - conversionCents);
  return { headroomCents, ceilingCents, currentRate };
}

/**
 * Splits a proposed conversion into per-bracket tranches, each with its marginal
 * `T_now`, the source BETR, and a verdict (`convert` when `T_future > betr`).
 * `allInRate` is filled later by `computeRetirementYearsBETR`.
 */
function computeConversionTranches(
  taxableIncomeCents: number,
  proposedCents: number,
  T_future: number,
  n: number,
  rIra: number,
  source: BETRSource,
  opts: BETROpts,
  year: number,
  filingStatus: FilingStatus,
  snapshot: CalibrationSnapshot<TaxConfig>,
): ConversionTranche[] {
  const tranches: ConversionTranche[] = [];
  let remaining = Math.max(0, proposedCents);
  let cursor = Math.max(0, taxableIncomeCents);

  // Bounds the loop if a snapshot ever returned a degenerate ceiling.
  let guard = 0;
  while (remaining > 0 && guard < 64) {
    guard += 1;
    const ceilingCents = nextBracketCeiling(cursor, year, filingStatus, snapshot);
    // Probe one cent above `cursor`: on a bracket floor the strict `>` would return the lower bracket.
    const T_now = marginalOrdinaryRate(
      year,
      filingStatus,
      (cursor + 1) / CENTS_FACTOR,
      snapshot,
    );
    const roomToCeiling = Number.isFinite(ceilingCents)
      ? Math.max(0, ceilingCents - cursor)
      : remaining;
    const amountCents = Math.min(remaining, roomToCeiling);
    if (amountCents <= 0) break;
    const betr = computeBETR(source, T_now, n, rIra, opts);
    tranches.push({
      amountCents,
      T_now,
      betr,
      verdict: T_future > betr ? 'convert' : 'hold',
    });
    remaining -= amountCents;
    cursor += amountCents;
    if (!Number.isFinite(ceilingCents)) break;
  }
  return tranches;
}

// Returns 0 when no RMD-era row qualifies; the caller renders an insufficient-data state.
function averageRmdEraMarginalRate(
  drawdownYears: readonly DrawdownYear[],
  ctx: BETRScenarioContext,
  bundle: TaxCalibrationBundle,
): number {
  const triggerAge = rmdTriggerAge(ctx.ownerBirthYear);
  const rmdEraStartYear = ctx.ownerBirthYear + triggerAge;
  let sum = 0;
  let count = 0;
  for (const row of drawdownYears) {
    if (row.year < rmdEraStartYear) continue;
    if (row.magiCents === undefined) continue;
    const { lookupYear, snapshot } = resolveFederalTaxSnapshotForYear(
      bundle.federalTax,
      row.year,
      ctx.inflationRatePct,
    );
    const taxableIncomeCents = deriveTaxableIncomeCents(row.magiCents, lookupYear, ctx, snapshot);
    sum += marginalOrdinaryRate(
      lookupYear,
      ctx.filingStatus,
      taxableIncomeCents / CENTS_FACTOR,
      snapshot,
    );
    count += 1;
  }
  return count > 0 ? sum / count : 0;
}

// Treats ordinary and LTCG/QDI as one figure (known limitation); the senior-bonus
// phase-out reads pre-deduction MAGI.
function deriveTaxableIncomeCents(
  magiCents: number,
  year: number,
  ctx: BETRScenarioContext,
  snapshot: CalibrationSnapshot<TaxConfig>,
): number {
  const config = snapshot.values[year];
  if (config === undefined) return Math.max(0, magiCents);
  const filingStatus = ctx.filingStatus;
  const stdDeductionDollars = config.standardDeduction[filingStatus];
  const maxAge65 = filingStatus === 'MFJ' ? 2 : 1;
  const age65Count = Math.min(ctx.taxpayersAge65Plus, maxAge65);
  const age65AddOnDollars =
    (filingStatus === 'MFJ' ? config.age65AddOn.mfj : config.age65AddOn.singleOrHoH) * age65Count;
  const seniorBonusDollars = seniorBonusDeductionDollars(magiCents, year, ctx, config);
  const deductionCents =
    (stdDeductionDollars + age65AddOnDollars + seniorBonusDollars) * CENTS_FACTOR;
  return Math.max(0, magiCents - deductionCents);
}

function seniorBonusDeductionDollars(
  magiCents: number,
  year: number,
  ctx: BETRScenarioContext,
  config: TaxConfig,
): number {
  // Never past the statutory expiry, even if a clamped extrapolated config still carries the slot.
  if (year > SENIOR_BONUS_DEDUCTION_LAST_YEAR) return 0;
  const slot = config.seniorBonusDeduction;
  if (slot === undefined) return 0;
  const maxFilers = ctx.filingStatus === 'MFJ' ? 2 : 1;
  const qualifyingFilers = Math.min(ctx.taxpayersAge65Plus, maxFilers);
  if (qualifyingFilers <= 0) return 0;
  const base = slot.phaseoutBaseMagi[ctx.filingStatus];
  const magiDollars = magiCents / CENTS_FACTOR;
  const phaseout = slot.phaseoutRatePct * Math.max(0, magiDollars - base);
  const perFilerAfterPhaseout = Math.max(0, slot.perFilerCap - phaseout);
  return perFilerAfterPhaseout * qualifyingFilers;
}

/**
 * Working-years summary: T_future from the RMD-era rows, the headroom at the
 * working-years taxable income, and the bracket-fill tranches (BETR only, since SS
 * and full MAGI are unknown before retirement). Zero headroom and no tranches when
 * `preRetirementTaxableIncomeDollars` is absent.
 */
export function computeWorkingYearsBETRSummary(
  ctx: BETRScenarioContext,
  drawdownYears: readonly DrawdownYear[],
  bundle: TaxCalibrationBundle,
): WorkingYearsBETRSummary {
  const triggerAge = rmdTriggerAge(ctx.ownerBirthYear);
  const T_future = averageRmdEraMarginalRate(drawdownYears, ctx, bundle);
  const n = Math.max(0, ctx.retirementYear - ctx.currentCalendarYear);

  if (ctx.preRetirementTaxableIncomeDollars === undefined) {
    return {
      bracketHeadroomCents: 0,
      T_future,
      rmdTriggerAge: triggerAge,
      tranches: [],
      convertTotalCents: 0,
    };
  }

  const taxableIncomeCents = Math.round(ctx.preRetirementTaxableIncomeDollars * CENTS_FACTOR);
  const existingConversionCents = Math.round(ctx.existingAnnualConversionDollars * CENTS_FACTOR);
  // Resolved per year so a post-2026 working year uses the extrapolated table, not the raw snapshot.
  const { lookupYear, snapshot: yearSnapshot } = resolveFederalTaxSnapshotForYear(
    bundle.federalTax,
    ctx.currentCalendarYear,
    ctx.inflationRatePct,
  );
  // T_now is bracket-derived per tranche, not the user-entered rate.
  const headroom = computeBracketHeadroom(
    taxableIncomeCents,
    existingConversionCents,
    lookupYear,
    ctx.filingStatus,
    yearSnapshot,
  );
  const proposedCents = Number.isFinite(headroom.headroomCents) ? headroom.headroomCents : 0;
  // Apply always uses `ira` tranches: the conversion is an IRA → Roth transfer, so the
  // payment source changes only the verdict display, never the amount written.
  const tranches = computeConversionTranches(
    taxableIncomeCents + existingConversionCents,
    proposedCents,
    T_future,
    n,
    ctx.rIra,
    'ira',
    {},
    lookupYear,
    ctx.filingStatus,
    yearSnapshot,
  );
  const convertTotalCents = tranches
    .filter((t) => t.verdict === 'convert')
    .reduce((sum, t) => sum + t.amountCents, 0);

  return {
    bracketHeadroomCents: proposedCents,
    T_future,
    rmdTriggerAge: triggerAge,
    tranches,
    convertTotalCents,
  };
}

/**
 * Per-row retirement-years analysis. Skips rows without `magiCents` or
 * `taxableSsCents` (the all-in probe needs both) and the `n = 0` anchor year.
 * The bracket snapshot is resolved per row from `bundle.federalTax`, so each row
 * may use a different extrapolated table.
 */
export function computeRetirementYearsBETR(
  drawdownYears: readonly DrawdownYear[],
  ctx: BETRScenarioContext,
  bundle: TaxCalibrationBundle,
): RetirementYearBETRRow[] {
  const T_future = averageRmdEraMarginalRate(drawdownYears, ctx, bundle);
  const rows: RetirementYearBETRRow[] = [];
  for (const row of drawdownYears) {
    const built = buildRetirementRow(row, ctx, bundle, T_future);
    if (built !== null) rows.push(built);
  }
  return rows;
}

function buildRetirementRow(
  row: DrawdownYear,
  ctx: BETRScenarioContext,
  bundle: TaxCalibrationBundle,
  T_future: number,
): RetirementYearBETRRow | null {
  if (row.magiCents === undefined || row.taxableSsCents === undefined) return null;
  const n = ctx.lifeExpectancyAnchorYear - row.year;
  if (n <= 0) return null;

  const { lookupYear, snapshot: yearSnapshot } = resolveFederalTaxSnapshotForYear(
    bundle.federalTax,
    row.year,
    ctx.inflationRatePct,
  );
  const taxableIncomeCents = deriveTaxableIncomeCents(row.magiCents, lookupYear, ctx, yearSnapshot);
  const T_now = marginalOrdinaryRate(
    lookupYear,
    ctx.filingStatus,
    taxableIncomeCents / CENTS_FACTOR,
    yearSnapshot,
  );
  const headroom = computeBracketHeadroom(
    taxableIncomeCents,
    0,
    lookupYear,
    ctx.filingStatus,
    yearSnapshot,
  );
  const proposedCents = Number.isFinite(headroom.headroomCents) ? headroom.headroomCents : 0;
  const tranches = computeConversionTranches(
    taxableIncomeCents,
    proposedCents,
    T_future,
    n,
    ctx.rIra,
    'ira',
    {},
    lookupYear,
    ctx.filingStatus,
    yearSnapshot,
  );
  const probeCents = proposedCents > 0 ? proposedCents : taxableIncomeCents > 0 ? CENTS_FACTOR : 0;
  const allInRate =
    probeCents > 0
      ? computeAllInConversionCost(
          buildAllInInput(row, ctx, taxableIncomeCents, probeCents),
          bundle,
        ).allInRate
      : 0;
  return { drawdownYear: row, T_now, T_future, n, tranches, allInRate };
}

function buildAllInInput(
  row: DrawdownYear,
  ctx: BETRScenarioContext,
  taxableIncomeCents: number,
  conversionCents: number,
): AllInConversionCostInput {
  return {
    year: row.year,
    filingStatus: ctx.filingStatus,
    conversionCents,
    taxableIncomeCents,
    magiCents: row.magiCents as number,
    taxableSsCents: row.taxableSsCents as number,
    grossSsAnnualCents: ctx.grossSsAnnualCents,
    taxExemptInterestCents: ctx.taxExemptInterestCents,
    beneficiariesOnMedicareCount: ctx.beneficiariesOnMedicareCount,
    householdSize: ctx.householdSize,
    benchmarkAnnualSlcspCents: ctx.benchmarkAnnualSlcspCents,
    ...(ctx.acaFplRegion !== undefined ? { acaFplRegion: ctx.acaFplRegion } : {}),
    ...(ctx.acaCoverageMonths !== undefined
      ? { acaCoverageMonths: ctx.acaCoverageMonths }
      : {}),
    inflationRatePct: ctx.inflationRatePct,
  };
}
