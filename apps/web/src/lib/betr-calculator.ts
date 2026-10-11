/**
 * Roth Conversion break-even tax rate (BETR) math library.
 *
 * Pure functions only — no I/O, no React. Computes Vanguard's break-even tax
 * rate across four tax-payment-source variants, splits a proposed conversion
 * into per-bracket tranches with convert/hold verdicts, and assembles the
 * working-years summary + retirement-years per-row analysis the Roth conversion comparison page
 * renders. All federal bracket lookups route through the `federal-tax.ts` thin
 * wrappers (`nextBracketCeiling`, `federalOrdinaryTaxCents`, `marginalOrdinaryRate`)
 * and the `federal-tax-extrapolation.ts` snapshot resolver so post-2026 rows
 * (2030/2035) never throw `UnsupportedTaxYearError`.
 */

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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The four tax-payment-source variants a BETR can be computed for. */
export type BETRSource = 'ira' | 'taxEfficient' | 'taxInefficient' | 'cash';

/**
 * Per-source BETR knobs. All optional with Vanguard-reference defaults.
 *   - `rIra`        — the IRA's assumed annual real growth rate (e.g. 0.07).
 *   - `rSrc`        — the outside source's pre-drag annual growth rate. Defaults to `rIra`.
 *   - `dragPct`     — annual tax drag on the outside source (fraction, e.g. 0.10).
 *                     Defaults per source: taxEfficient 0.10, taxInefficient 0.25.
 *   - `cashRatePct` — for the `cash` source, the cash interest rate (ordinary income),
 *                     dragged at `T_now`. Defaults to `rSrc`.
 *   - `under59Penalty` — `ira` source only: when true, the tax-payment withdrawal
 *                     is taken before 59½, so the withheld-tax dollars carry the
 *                     10% §72(t) early-distribution penalty and the from-IRA BETR
 *                     becomes `T_now × (1 + EARLY_WITHDRAWAL_PENALTY_RATE)`. Off by
 *                     default; ignored by the non-IRA branches (display-only).
 */
export interface BETROpts {
  readonly rSrc?: number;
  readonly dragPct?: number;
  readonly cashRatePct?: number;
  readonly under59Penalty?: boolean;
}

/** One bracket-boundary tranche of a proposed conversion. */
export interface ConversionTranche {
  /** Tranche size in integer cents. */
  readonly amountCents: number;
  /** Marginal ordinary rate applied to this tranche (fraction). */
  readonly T_now: number;
  /** BETR for this tranche under the analyzed source. */
  readonly betr: number;
  /** 'convert' when `T_future > betr`; else 'hold'. */
  readonly verdict: 'convert' | 'hold';
  /** All-in effective rate for this tranche (retirement rows only). */
  readonly allInRate?: number;
}

/** Headroom before the next ordinary bracket boundary. */
export interface BracketHeadroomResult {
  /** Dollars (cents) of room left in the current bracket before the next ceiling. */
  readonly headroomCents: number;
  /** The next bracket ceiling in cents (`Infinity` when already in the top bracket). */
  readonly ceilingCents: number;
  /** Marginal ordinary rate at the current taxable income (fraction). */
  readonly currentRate: number;
}

/** Working-years aggregate summary for the Roth conversion comparison page's working-years panel. */
export interface WorkingYearsBETRSummary {
  /** Bracket headroom in cents at the user's working-years taxable income. */
  readonly bracketHeadroomCents: number;
  /** Average RMD-era marginal ordinary rate (representative T_future). */
  readonly T_future: number;
  /** Owner's SECURE 2.0 RMD trigger age (73 or 75). */
  readonly rmdTriggerAge: 73 | 75;
  /** Per-bracket tranches of the bracket-fill amount. */
  readonly tranches: readonly ConversionTranche[];
  /** Sum of all 'convert'-verdict tranche amounts (the Apply amount), in cents. */
  readonly convertTotalCents: number;
}

/** Per-row retirement-years analysis entry. */
export interface RetirementYearBETRRow {
  readonly drawdownYear: DrawdownYear;
  readonly T_now: number;
  readonly T_future: number;
  /** Years from this row to the life-expectancy anchor. */
  readonly n: number;
  readonly tranches: readonly ConversionTranche[];
  readonly allInRate: number;
}

/**
 * Minimal scenario context the BETR functions consume — a typed projection
 * read, populated by the Roth conversion comparison page from the scenario aggregate.
 * Kept focused (not the full aggregate) so the math library stays pure and
 * unit-testable; the comparison page builds it from the resolved scenario.
 * The method is described under "The break-even comparison" in
 * `docs/math-retirement-accounts.md`.
 */
export interface BETRScenarioContext {
  readonly filingStatus: FilingStatus;
  /** Scenario owner's birth YEAR (drives the SECURE 2.0 RMD trigger age). */
  readonly ownerBirthYear: number;
  /** Number of household members age 65+ in retirement (federal age-65 add-on). */
  readonly taxpayersAge65Plus: number;
  /** Calendar year used as the n=0 horizon anchor (life-expectancy year). */
  readonly lifeExpectancyAnchorYear: number;
  /** Current calendar year (working-years n anchor). */
  readonly currentCalendarYear: number;
  /** First retirement calendar year (working-years n target). */
  readonly retirementYear: number;
  /** User-entered working-years taxable income (post-deduction dollars), or undefined. */
  readonly preRetirementTaxableIncomeDollars?: number;
  /** Existing flat annual working-years conversion already configured (dollars). */
  readonly existingAnnualConversionDollars: number;
  /** Assumed IRA growth rate (fraction) for the BETR opportunity-cost term. */
  readonly rIra: number;
  // --- All-in probe inputs (retirement rows only) ---
  readonly grossSsAnnualCents: number;
  readonly beneficiariesOnMedicareCount: 0 | 1 | 2;
  readonly householdSize: number;
  readonly benchmarkAnnualSlcspCents: number;
  /** The household's federal-poverty-level region, threaded so the
   *  probe sizes the lost credit against the same poverty line the projection
   *  uses. Absent → `'contiguous'`. */
  readonly acaFplRegion?: AcaFplRegion;
  /** The household's Marketplace coverage MONTHS in the retirement
   *  year, so the probe prorates the expected contribution the same way
   *  §36B(b)(2) does. Absent → 12. */
  readonly acaCoverageMonths?: number;
  readonly inflationRatePct: number;
  readonly taxExemptInterestCents: number;
}

// ---------------------------------------------------------------------------
// Constants (Vanguard-reference defaults)
// ---------------------------------------------------------------------------

/** Vanguard-reference per-source annual tax drag (fraction). Exported so the
 *  page can pass the SELECTED source's slider override while non-selected
 *  comparison rows keep their own default. */
export const DEFAULT_DRAG_BY_SOURCE: Record<BETRSource, number> = {
  ira: 0,
  taxEfficient: 0.1,
  taxInefficient: 0.25,
  cash: 0,
};

/** Default IRA opportunity-cost growth rate (fraction) for the BETR term —
 *  fixed at 7% independent of the scenario's real-return assumption. */
export const DEFAULT_IRA_GROWTH_RATE = 0.07 as const;

const CENTS_FACTOR = 100;

// ---------------------------------------------------------------------------
// BETR formula
// ---------------------------------------------------------------------------

/**
 * Break-even tax rate for one tax-payment source.
 *
 * From-IRA: `BETR = T_now` regardless of n / r (paying the tax from the
 * IRA is algebraically source-agnostic). When `opts.under59Penalty` is set the
 * tax-payment withdrawal happens before 59½, so the withheld-tax dollars take
 * the 10% §72(t) early-distribution penalty and the from-IRA BETR becomes
 * `T_now × (1 + EARLY_WITHDRAWAL_PENALTY_RATE)`. The conversion principal itself
 * is not a distribution and stays penalty-free (see `early-withdrawal-penalty.ts`),
 * so only the withheld-tax leg (= `T_now`) is penalized. The page derives the
 * owner-boundary that toggles this flag; the option is off by default.
 *
 * From-outside: `BETR = T_now × ((1 + r_src_aft) / (1 + r_ira))^n`, where
 * `r_src_aft` is the source's after-drag growth. The outside dollar used to pay
 * the tax would otherwise have compounded; the ratio captures that opportunity
 * cost. `n = 0` collapses every source to `T_now`.
 *
 * Returns a finite number for degenerate inputs (e.g. `rIra` near -1) — guards
 * against NaN/Infinity by flooring the denominator base above zero.
 *
 * @param source The tax-payment-source variant.
 * @param T_now  Current marginal rate (fraction).
 * @param n      Years of compounding (≥ 0).
 * @param rIra   IRA growth rate (fraction).
 * @param opts   Per-source knobs (drag, source rate).
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
    // Cash interest is ordinary income, dragged at T_now.
    const cashRate = opts.cashRatePct ?? opts.rSrc ?? rIra;
    rSrcAfterDrag = cashRate * (1 - T_now);
  } else {
    const rSrc = opts.rSrc ?? rIra;
    rSrcAfterDrag = rSrc * (1 - drag);
  }

  // Floor both compounding bases above 0 so a pathological rate (≤ -1) yields a
  // finite result rather than NaN (negative base ^ non-integer) or Infinity.
  const srcBase = Math.max(1e-9, 1 + rSrcAfterDrag);
  const iraBase = Math.max(1e-9, 1 + rIra);
  return T_now * Math.pow(srcBase / iraBase, n);
}

// ---------------------------------------------------------------------------
// Bracket headroom + tranches
// ---------------------------------------------------------------------------

/**
 * Headroom before the next ordinary bracket boundary. `taxableIncomeCents` is
 * ALREADY post-deduction (no deduction re-subtracted). Bracket lookup
 * delegates to `nextBracketCeiling` (single source of truth). `year: number`
 * routes post-2026 rows through the extrapolating snapshot.
 *
 * `headroomCents = max(0, ceiling − taxableIncome − conversion)`.
 */
export function computeBracketHeadroom(
  taxableIncomeCents: number,
  conversionCents: number,
  year: number,
  filingStatus: FilingStatus,
  snapshot: CalibrationSnapshot<TaxConfig>,
): BracketHeadroomResult {
  const ceilingCents = nextBracketCeiling(taxableIncomeCents, year, filingStatus, snapshot);
  // marginalOrdinaryRate takes taxable income in DOLLARS (bracket floors are
  // dollars); the headroom math is in cents, so convert at the call boundary.
  const currentRate = marginalOrdinaryRate(
    year,
    filingStatus,
    taxableIncomeCents / CENTS_FACTOR,
    snapshot,
  );
  if (!Number.isFinite(ceilingCents)) {
    // Already in the top bracket — unbounded room (no higher boundary).
    return { headroomCents: Infinity, ceilingCents, currentRate };
  }
  const headroomCents = Math.max(0, ceilingCents - taxableIncomeCents - conversionCents);
  return { headroomCents, ceilingCents, currentRate };
}

/**
 * Split a proposed conversion into per-bracket tranches at each bracket
 * boundary above the current taxable income. Each tranche carries its own
 * marginal `T_now`, the source BETR at that rate, and a convert/hold verdict
 * (`convert` when `T_future > betr`). `year: number` for post-2026 rows.
 *
 * The `allInRate` per tranche is left undefined here; `computeRetirementYearsBETR`
 * fills it from the conversion-cost probe for retirement rows.
 */
export function computeConversionTranches(
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

  // Guard against an unbounded loop if the snapshot ever returned a degenerate
  // ceiling; brackets are finite in count so this bound is generous.
  let guard = 0;
  while (remaining > 0 && guard < 64) {
    guard += 1;
    const ceilingCents = nextBracketCeiling(cursor, year, filingStatus, snapshot);
    // Evaluate the marginal rate just INSIDE the tranche (cursor + 1¢). When
    // `cursor` lands exactly on a bracket floor, marginalBracket's strict `>`
    // would return the lower bracket; the dollars in (cursor, ceiling] belong to
    // the higher bracket, so probe one cent above the boundary.
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

// ---------------------------------------------------------------------------
// T_future derivation
// ---------------------------------------------------------------------------

/**
 * Average marginal ordinary rate across all RMD-era rows in a projection — the
 * representative `T_future`. RMD-era = the row's calendar year is on/
 * after the owner reaches `rmdTriggerAge`. Rows missing `magiCents` are skipped
 * (no taxable-income proxy possible). Returns 0 when no RMD-era row qualifies
 * (caller renders an insufficient-data state, never NaN).
 */
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

/**
 * Total-taxable-income proxy: `max(0, magiCents − standardDeduction −
 * age65AddOn − seniorBonus)` using the year-keyed snapshot's deduction stack.
 * Treats ordinary + LTCG/QDI as one ordinary figure (known limitation).
 * The senior-bonus phase-out base reads pre-deduction MAGI.
 */
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

/** OBBBA senior-bonus deduction (2025-2028, age-65+) in whole dollars, mirroring
 *  the federal engine's per-filer cap + 6%-of-(MAGI − base) phase-out. */
function seniorBonusDeductionDollars(
  magiCents: number,
  year: number,
  ctx: BETRScenarioContext,
  config: TaxConfig,
): number {
  // Statutory expiry (Pub. L. 119-21 §70103): never apply past 2028, even if a
  // clamped-extrapolation config still carries the slot — mirrors the federal
  // engine's `computeSeniorBonusDeduction` year gate.
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

// ---------------------------------------------------------------------------
// Working-years summary
// ---------------------------------------------------------------------------

/**
 * Working-years aggregate summary for the Roth conversion comparison panel. Computes T_future
 * from the projection's RMD-era rows, the bracket headroom at the user's
 * working-years taxable income, and the bracket-fill tranches (BETR-only — SS
 * and full MAGI are not available pre-retirement, so no all-in rate). Returns a
 * zero-headroom / empty-tranche summary when `preRetirementTaxableIncomeDollars`
 * is absent (the page renders a needs-input state from that).
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
  // Resolve the year-keyed snapshot for the current calendar year so a post-2026
  // working year (currentCalendarYear > 2026) routes through the extrapolated
  // table rather than throwing UnsupportedTaxYearError on the raw snapshot — same
  // resolution the retirement-rows path applies per row.
  const { lookupYear, snapshot: yearSnapshot } = resolveFederalTaxSnapshotForYear(
    bundle.federalTax,
    ctx.currentCalendarYear,
    ctx.inflationRatePct,
  );
  // Working-years T_now is bracket-derived per tranche from the bracket table via
  // marginalOrdinaryRate (evaluated one cent inside each tranche), NOT the
  // user-entered rate — actual bracket rates are more accurate. The page reads
  // these per-tranche results directly.
  const headroom = computeBracketHeadroom(
    taxableIncomeCents,
    existingConversionCents,
    lookupYear,
    ctx.filingStatus,
    yearSnapshot,
  );
  const proposedCents = Number.isFinite(headroom.headroomCents) ? headroom.headroomCents : 0;
  // Working-years Apply always uses source='ira' tranches; the non-IRA source
  // display is informational. The
  // from-IRA variant is BETR = T_now (n-independent), and Apply's convert-verdict
  // tranche SUM is the same bracket-fill amount for every source (only the
  // per-source BETR display differs, shown by the panel via `computeBETR`). The
  // conversion amount is always an IRA → Roth transfer, so the tax-payment source
  // affects only the verdict display, never the amount Apply writes.
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

// ---------------------------------------------------------------------------
// Retirement-years per-row analysis
// ---------------------------------------------------------------------------

/**
 * Per-row retirement-years analysis. Skips any `DrawdownYear` where `magiCents`
 * or `taxableSsCents` is undefined (tax integration not stamped — both are
 * required by the all-in probe) and any `n = 0` anchor-year
 * row. For each remaining row: derives the taxable-income proxy + T_now,
 * the projection's representative T_future, the per-bracket tranches, and the
 * all-in effective rate from `computeAllInConversionCost`.
 *
 * The federal bracket snapshot is sourced per-row from `bundle.federalTax` (the
 * single calibration source of truth, same one `applyTaxYear` uses) — so this
 * function takes no separate `snapshot` param; every retirement row may carry a
 * different extrapolated year-keyed table.
 *
 * @param drawdownYears   The projection's drawdown rows.
 * @param ctx             Scenario context (members / SS / filing / horizon).
 * @param bundle          The full calibration bundle (federal + all-in engines).
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

/**
 * Build one retirement-years row, or `null` when the row is skipped (missing
 * `magiCents`/`taxableSsCents`, or the `n = 0` anchor-year row). The
 * federal bracket snapshot is resolved per-row so post-2026 rows (2030/2035)
 * route through the extrapolated table rather than throwing.
 */
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

/** Assemble the all-in probe input for one retirement row from the row + ctx. */
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
    // Guarded by the caller's undefined-skip — both are present here.
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
