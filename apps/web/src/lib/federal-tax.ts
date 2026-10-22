/**
 * Pure-function US federal income tax engine for tax years 2024–2026.
 *
 * Covers: ordinary brackets, LTCG/QDI preferential brackets (stacking),
 * standard deduction (base + age-65 add-on), the OBBBA senior bonus
 * deduction (tax years 2025–2028, with a MAGI phase-out), and NIIT (3.8%
 * on NII above threshold). Does NOT cover AMT, itemized deductions, QBI
 * deduction, SS provisional-income test, or state taxes.
 *
 * 2026 uses the OBBBA-permanent TCJA seven-rate schedule
 * (10/12/22/24/32/35/37%) — OBBBA (signed July 2025) repealed the TCJA
 * sunset, so 2026 no longer reverts to pre-TCJA rates.
 *
 * Config: apps/web/src/lib/federal-tax-config.ts
 */

import type { CalibrationSnapshot } from './calibration';

/**
 * Filing statuses supported by this engine.
 *
 * `MFS` (married filing separately) and `QSS` (qualifying surviving spouse)
 * are fully computable and reachable from production. The scalar
 * `deriveFilingStatus` (filing-status.ts) returns only `Single`/`MFJ`/`HoH`,
 * but the filing plan does not go through it: `resolveFilingPlanForYear`
 * resolves each projection year into tax units and `applyTaxYearForFilingPlan`
 * applies this engine per unit, so a `separate` plan reaches `MFS` and a
 * survivor status window reaches `QSS`. See docs/math-taxes.md, "Filing status
 * and tax units".
 *
 * Federal-tax treatment of the two statuses:
 *   - `MFS` carries its OWN calibrated bracket / standard-deduction / LTCG
 *     tables plus the §1411 $125,000 NIIT threshold (NOT half of MFJ's). MFS is
 *     INELIGIBLE for the OBBBA senior bonus deduction (§70103 requires joint
 *     filing for a married taxpayer) — it always gets $0 there.
 *   - `QSS` is tax-computed on the MFJ rate schedule (26 U.S.C. §1(a)/§2(a)):
 *     its config keys reference the MFJ ordinary brackets, standard deduction,
 *     LTCG brackets, and NIIT threshold. It stays a DISTINCT `FilingStatus`
 *     label (never coerced to `'MFJ'`) so downstream code — SS taxation, IRMAA,
 *     eligibility windows, resolved-tax-unit reporting — can still treat QSS as
 *     an individual filer. The QSS senior-deduction phase-out uses the $75,000
 *     non-joint base (a QSS return is not a joint return), and QSS gets one
 *     age-65 add-on at the married rate.
 */
export type FilingStatus = 'Single' | 'MFJ' | 'HoH' | 'MFS' | 'QSS';

/** Tax years with compiled bracket tables. Outside → UnsupportedTaxYearError. */
export type TaxYear = 2024 | 2025 | 2026;

/** A single bracket band. `floor` = bottom of bracket (inclusive). */
export interface TaxBracket {
  readonly floor: number;
  readonly rate: number; // 0.10 … 0.37
}

/**
 * Per-filing-status bracket table. Ordered ascending by floor.
 * `QSS` references the `MFJ` schedule (§1(a)/§2(a)) — see `FilingStatus`.
 */
export interface FilingStatusBrackets {
  readonly Single: readonly TaxBracket[];
  readonly MFJ: readonly TaxBracket[];
  readonly HoH: readonly TaxBracket[];
  readonly MFS: readonly TaxBracket[];
  readonly QSS: readonly TaxBracket[];
}

/** Standard deduction amounts per filing status. `QSS` = `MFJ` (§63(c)(2)). */
interface StandardDeduction {
  readonly Single: number;
  readonly MFJ: number;
  readonly HoH: number;
  readonly MFS: number;
  readonly QSS: number;
}

/** Age-65 add-on to the standard deduction.
 *  `singleOrHoH` applies to Single and HoH. */
interface Age65AddOn {
  readonly singleOrHoH: number;
  readonly mfj: number; // per qualifying spouse (multiply by 1 or 2)
}

/**
 * NIIT (Net Investment Income Tax, IRC §1411) thresholds. Not CPI-indexed.
 * `MFS` is $125,000 — statutorily fixed, NOT half of MFJ's $250,000 by
 * coincidence-of-arithmetic. `QSS` = `MFJ` ($250,000, §1411(b)(1)).
 */
interface NiitThresholds {
  readonly Single: number;
  readonly MFJ: number;
  readonly HoH: number;
  readonly MFS: number;
  readonly QSS: number;
}

/** LTCG / QDI preferential rate brackets.
 *  `floor` is taxable income at which that rate begins (after ordinary
 *  income is "stacked" below the LTCG income). */
export interface LtcgBracket {
  readonly floor: number;
  readonly rate: number; // 0.00 | 0.15 | 0.20
}

export interface LtcgBrackets {
  readonly Single: readonly LtcgBracket[];
  readonly MFJ: readonly LtcgBracket[];
  readonly HoH: readonly LtcgBracket[];
  readonly MFS: readonly LtcgBracket[];
  readonly QSS: readonly LtcgBracket[];
}

/**
 * OBBBA senior bonus deduction (tax years 2025–2028 only). A per-filer
 * deduction for taxpayers age 65+, phased out above a MAGI base at a flat
 * rate. Present only on the 2025–2028 configs; absent → no deduction
 * (2024 and 2029+ are $0 by construction). Lowers taxable income, not MAGI.
 */
export interface SeniorBonusDeduction {
  /** Maximum deduction per qualifying taxpayer age 65+ (e.g. $6,000). */
  readonly perFilerCap: number;
  /**
   * MAGI above which the deduction phases out, per filing status. Only a JOINT
   * return uses the $150,000 base; the eligible non-joint statuses — `Single`,
   * `HoH`, and `QSS` (a surviving-spouse return is not a joint return) — use the
   * $75,000 base. `MFS` is INELIGIBLE (§70103 requires joint filing for a
   * married taxpayer), so its key is unused: `computeSeniorBonusDeduction`
   * returns $0 for MFS before reading this base.
   */
  readonly phaseoutBaseMagi: {
    readonly Single: number;
    readonly MFJ: number;
    readonly HoH: number;
    readonly MFS: number;
    readonly QSS: number;
  };
  /** Phase-out rate applied to `max(0, MAGI − base)` (e.g. 0.06). */
  readonly phaseoutRatePct: number;
}

/** Shape of one year's tax configuration (CalibrationSnapshot<TaxConfig>). */
export interface TaxConfig {
  readonly brackets: FilingStatusBrackets;
  readonly standardDeduction: StandardDeduction;
  readonly age65AddOn: Age65AddOn;
  readonly niitThresholds: NiitThresholds;
  readonly ltcgBrackets: LtcgBrackets;
  /**
   * OBBBA senior bonus deduction. Present only for tax years 2025–2028;
   * absent → no deduction (year-gated by config presence, so extrapolated
   * future years never carry it forward).
   */
  readonly seniorBonusDeduction?: SeniorBonusDeduction;
}

export interface TaxInput {
  /** Calendar tax year. Runtime validates via snapshot lookup (throws UnsupportedTaxYearError). */
  readonly year: TaxYear | number;
  readonly filingStatus: FilingStatus;
  /** Ordinary (non-LTCG) income before any deduction. Must be ≥ 0. */
  readonly ordinaryIncome: number;
  /** Long-term capital gains + qualified dividends. Must be ≥ 0. */
  readonly ltcgAndQdi: number;
  /** Net investment income (≥ ltcgAndQdi; also includes interest, rents, etc.).
   *  Used for NIIT calculation. Defaults to ltcgAndQdi when omitted.
   *  Note: defaulting to ltcgAndQdi is a known under-estimate of NII
   *  (optimistic on tax owed, not conservative) when passive ordinary income
   *  such as rental income is also NII. */
  readonly netInvestmentIncome?: number;
  /** Number of qualifying taxpayers age 65+. 0, 1, or 2 (MFJ only for 2). */
  readonly taxpayersAge65Plus?: number;
  /**
   * MAGI used for the OBBBA senior bonus deduction phase-out (whole dollars).
   * The deduction lowers taxable income but NOT MAGI, so the phase-out must
   * read a MAGI computed BEFORE the deduction is subtracted. Defaults to the
   * engine's own `ordinaryIncome + ltcgAndQdi` when absent. Only consulted for
   * tax years whose config carries `seniorBonusDeduction` (2025–2028).
   */
  readonly magiForSeniorDeduction?: number;
}

export interface TaxResult {
  readonly ordinaryTax: number;   // cents
  readonly ltcgTax: number;       // cents
  readonly niitTax: number;       // cents
  readonly totalTax: number;      // cents (sum of above)
  readonly effectiveRatePct: number; // (totalTax / totalGrossIncome) * 100
  /** Marginal rate on the last dollar of ordinary income (0.10 … 0.37).
   *  Returns 0 when taxableOrdinary = 0. */
  readonly marginalOrdinaryRate: number;
  /** LTCG rate applicable to the last dollar of LTCG/QDI (0.00, 0.15, 0.20).
   *  Returns 0 when ltcgAndQdi = 0. */
  readonly marginalLtcgRate: number;
}

export class UnsupportedTaxYearError extends Error {
  readonly code = 'UNSUPPORTED_TAX_YEAR' as const;
  constructor(public readonly year: number) {
    super(
      `Tax year ${year} is outside the supported range (2024–2026). ` +
        'Update federal-tax-config.ts when new brackets are published.',
    );
    this.name = 'UnsupportedTaxYearError';
  }
}

export class InvalidTaxInputError extends Error {
  readonly code = 'INVALID_TAX_INPUT' as const;
  constructor(public readonly field: string, value: number) {
    super(`TaxInput.${field} must be ≥ 0 and finite, got ${value}.`);
    this.name = 'InvalidTaxInputError';
  }
}

const NIIT_RATE = 0.038;
const CENTS_FACTOR = 100;

/**
 * Last tax year the OBBBA senior bonus deduction is available (statutory
 * expiry, Pub. L. 119-21 §70103). A year past this never receives the
 * deduction even if its resolved config still carries the slot — guards the
 * clamp-without-inflation extrapolation path where the latest published config
 * (which carries the slot) is reused for a post-2028 projection year.
 */
export const SENIOR_BONUS_DEDUCTION_LAST_YEAR = 2028;

/**
 * Round dollars to integer cents (half-up).
 * Exported for unit-testing the rounding contract.
 */
export function toCents(dollars: number): number {
  return Math.round(dollars * CENTS_FACTOR);
}

/** Fail-fast: throw InvalidTaxInputError unless value is finite and ≥ 0. */
function validateFiniteNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new InvalidTaxInputError(field, value);
  }
}

/**
 * Compute ordinary income tax from bracket table.
 * Returns dollars (pre-rounding).
 */
function computeOrdinaryTax(
  taxableOrdinary: number,
  brackets: readonly TaxBracket[],
): number {
  if (taxableOrdinary <= 0) return 0;
  let tax = 0;
  let remaining = taxableOrdinary;
  for (let i = brackets.length - 1; i >= 0; i--) {
    const { floor, rate } = brackets[i];
    if (remaining > floor) {
      tax += (remaining - floor) * rate;
      remaining = floor;
    }
  }
  return tax;
}

/** Find marginal bracket for a given taxable income amount. */
function marginalBracket(
  taxableIncome: number,
  brackets: readonly TaxBracket[],
): TaxBracket {
  for (let i = brackets.length - 1; i >= 0; i--) {
    if (taxableIncome > brackets[i].floor) return brackets[i];
  }
  return brackets[0];
}

/** Find marginal LTCG rate at a given total taxable income level. */
function marginalLtcgBracket(
  totalTaxableIncome: number,
  ltcgBrackets: readonly LtcgBracket[],
): LtcgBracket {
  for (let i = ltcgBrackets.length - 1; i >= 0; i--) {
    if (totalTaxableIncome > ltcgBrackets[i].floor) return ltcgBrackets[i];
  }
  return ltcgBrackets[0];
}

/**
 * Compute LTCG tax on a stacked income level.
 * The LTCG brackets define the rate for each dollar at each income level.
 * Returns dollars (pre-rounding).
 */
function ltcgTaxOnStack(
  stackedIncome: number,
  ltcgBrackets: readonly LtcgBracket[],
): number {
  if (stackedIncome <= 0) return 0;
  let tax = 0;
  let remaining = stackedIncome;
  for (let i = ltcgBrackets.length - 1; i >= 0; i--) {
    const { floor, rate } = ltcgBrackets[i];
    if (remaining > floor) {
      tax += (remaining - floor) * rate;
      remaining = floor;
    }
  }
  return tax;
}

/** Compute standard deduction including age-65 add-ons. */
export function computeStandardDeduction(
  filingStatus: FilingStatus,
  taxpayersAge65Plus: number,
  config: TaxConfig,
): number {
  const base = config.standardDeduction[filingStatus];
  // The married age-65 add-on rate ($1,550/$1,600/$1,650) applies to every
  // married status — MFJ, MFS, and QSS (§63(f)); Single/HoH use the larger
  // non-married rate. Only MFJ can claim TWO add-ons (both spouses on one
  // return); MFS/QSS/Single/HoH are one-taxpayer returns → max 1.
  const isMarriedRate =
    filingStatus === 'MFJ' || filingStatus === 'MFS' || filingStatus === 'QSS';
  const addOn = isMarriedRate ? config.age65AddOn.mfj : config.age65AddOn.singleOrHoH;
  const maxAge65 = filingStatus === 'MFJ' ? 2 : 1;
  return base + addOn * Math.min(taxpayersAge65Plus, maxAge65);
}

/**
 * Compute the OBBBA senior bonus deduction (tax years 2025–2028) in dollars.
 *
 * Returns 0 when the year's config has no `seniorBonusDeduction` slot (2024,
 * 2029+) or no qualifying taxpayer age 65+. One per-filer cap per qualifying
 * taxpayer (clamped: max 2 for MFJ, 1 for Single/HoH — the same clamp the
 * age-65 standard-deduction add-on uses), phased out at `phaseoutRatePct` of
 * `max(0, magi − base)` and floored at $0. The phase-out reads `magi` (which is
 * computed BEFORE this deduction is subtracted) so the deduction lowers taxable
 * income without lowering MAGI.
 *
 * `MFS` is INELIGIBLE and always returns $0: Pub. L. 119-21 §70103 /
 * IRC §151(d)(5)(C)(v) require a married taxpayer to file JOINTLY to claim the
 * deduction. `QSS` (a surviving-spouse return is not "married" for this rule)
 * stays eligible at the $75,000 non-joint base.
 */
export function computeSeniorBonusDeduction(
  year: number,
  filingStatus: FilingStatus,
  taxpayersAge65Plus: number,
  magi: number,
  config: TaxConfig,
): number {
  // MFS is statutorily ineligible (§70103 conditions the deduction on
  // joint filing for a married taxpayer) — $0 regardless of age/MAGI.
  if (filingStatus === 'MFS') return 0;
  // Year gate (statutory expiry): never apply past 2028, even if the resolved
  // config still carries the slot (the clamp-without-inflation extrapolation
  // path reuses the latest published config for a post-2028 projection year).
  if (year > SENIOR_BONUS_DEDUCTION_LAST_YEAR) return 0;
  const slot = config.seniorBonusDeduction;
  if (slot === undefined) return 0;
  const maxFilers = filingStatus === 'MFJ' ? 2 : 1;
  const qualifyingFilers = Math.min(taxpayersAge65Plus, maxFilers);
  if (qualifyingFilers <= 0) return 0;
  const base = slot.phaseoutBaseMagi[filingStatus];
  const phaseout = slot.phaseoutRatePct * Math.max(0, magi - base);
  // One cap per qualifying filer; the phase-out applies per cap (so an MFJ
  // couple with two qualifying filers phases out twice the rate).
  const perFilerAfterPhaseout = Math.max(0, slot.perFilerCap - phaseout);
  return perFilerAfterPhaseout * qualifyingFilers;
}

/** Compute NIIT in cents given MAGI, NII, and the filing-status threshold. */
function computeNiitCents(magi: number, nii: number, threshold: number): number {
  const base = Math.min(nii, Math.max(0, magi - threshold));
  return toCents(base * NIIT_RATE);
}

/**
 * Compute LTCG tax in cents using IRS Schedule D Tax Worksheet stacking.
 * Unused standard-deduction absorbs LTCG when ordinary income < deduction.
 *
 * Per IRS Schedule D Tax Worksheet:
 *   taxableIncome = max(0, ordinaryIncome + ltcgAndQdi - deduction)
 *   taxableLtcg   = min(ltcgAndQdi, taxableIncome)
 *   taxableOrd    = taxableIncome - taxableLtcg
 *   ltcgTax       = ltcgTaxOnStack(taxableIncome) - ltcgTaxOnStack(taxableOrd)
 */
function computeLtcgTax(
  taxableOrdinary: number,
  taxableIncome: number,
  ltcgBrackets: readonly LtcgBracket[],
): number {
  return toCents(
    ltcgTaxOnStack(taxableIncome, ltcgBrackets) -
    ltcgTaxOnStack(taxableOrdinary, ltcgBrackets),
  );
}

/** Compute effective rate percent: totalCents / (totalGross * 100) * 100. */
function computeEffectiveRate(totalCents: number, totalGross: number): number {
  return totalGross > 0 ? (totalCents / CENTS_FACTOR / totalGross) * 100 : 0;
}

/**
 * Derive taxable income components from raw input + standard deduction.
 * Applies IRS Schedule D ordering: deduction against total income first.
 */
function deriveTaxableBasis(
  input: TaxInput,
  totalDeduction: number,
): { taxableIncome: number; taxableOrdinary: number; taxableLtcg: number; magi: number; totalGross: number } {
  const { ordinaryIncome, ltcgAndQdi } = input;
  const totalGross = ordinaryIncome + ltcgAndQdi;
  const magi = totalGross; // no add-backs in v1
  // IRS Schedule D: deduction applies to total income first, unused reduces LTCG
  const taxableIncome = Math.max(0, ordinaryIncome + ltcgAndQdi - totalDeduction);
  const taxableLtcg = Math.min(ltcgAndQdi, taxableIncome);
  const taxableOrdinary = taxableIncome - taxableLtcg;
  return { taxableIncome, taxableOrdinary, taxableLtcg, magi, totalGross };
}

/** Derive marginal rates from taxable components and bracket tables. */
function computeMarginalRates(
  taxableOrdinary: number,
  ltcgAndQdi: number,
  taxableIncome: number,
  brackets: readonly TaxBracket[],
  ltcgBrackets: readonly LtcgBracket[],
): { marginalOrdinaryRate: number; marginalLtcgRate: number } {
  const marginalOrdinaryRateVal = taxableOrdinary > 0
    ? marginalBracket(taxableOrdinary, brackets).rate
    : 0;
  const marginalLtcgRateVal = ltcgAndQdi > 0
    ? marginalLtcgBracket(taxableIncome, ltcgBrackets).rate
    : 0;
  return { marginalOrdinaryRate: marginalOrdinaryRateVal, marginalLtcgRate: marginalLtcgRateVal };
}

/**
 * Compute US federal income tax for one household.
 *
 * @param input — tax inputs; see TaxInput.
 * @param snapshot — `CalibrationSnapshot<TaxConfig>` from `federal-tax-config.ts`.
 *   The function looks up `snapshot.values[input.year]` at call time.
 * @throws {UnsupportedTaxYearError} when `input.year` is not present in snapshot.
 * @throws {InvalidTaxInputError} when any numeric input is negative, NaN, or Infinite.
 */
export function computeFederalTax(
  input: TaxInput,
  snapshot: CalibrationSnapshot<TaxConfig>,
): TaxResult {
  const { year, filingStatus, ordinaryIncome, ltcgAndQdi,
    netInvestmentIncome = ltcgAndQdi, taxpayersAge65Plus = 0 } = input;

  const config = snapshot.values[year];
  if (config === undefined) throw new UnsupportedTaxYearError(year);

  validateFiniteNonNegative(ordinaryIncome, 'ordinaryIncome');
  validateFiniteNonNegative(ltcgAndQdi, 'ltcgAndQdi');
  validateFiniteNonNegative(netInvestmentIncome, 'netInvestmentIncome');
  validateFiniteNonNegative(taxpayersAge65Plus, 'taxpayersAge65Plus');

  // The senior-deduction phase-out reads a MAGI computed BEFORE the deduction
  // is subtracted (the deduction lowers taxable income, not MAGI). Default to
  // the engine's own income sum when the caller does not supply one.
  const magiForSeniorDeduction = input.magiForSeniorDeduction ?? ordinaryIncome + ltcgAndQdi;
  if (input.magiForSeniorDeduction !== undefined) {
    validateFiniteNonNegative(input.magiForSeniorDeduction, 'magiForSeniorDeduction');
  }

  // Standard deduction + age-65 add-on, plus the OBBBA senior bonus deduction
  // (2025–2028). Both reduce total income before the Schedule D LTCG stacking;
  // neither alters MAGI (computed independently in deriveTaxableBasis).
  const seniorBonusDeduction = computeSeniorBonusDeduction(
    year,
    filingStatus,
    taxpayersAge65Plus,
    magiForSeniorDeduction,
    config,
  );
  const totalDeduction =
    computeStandardDeduction(filingStatus, taxpayersAge65Plus, config) + seniorBonusDeduction;
  const { taxableIncome, taxableOrdinary, magi, totalGross } =
    deriveTaxableBasis(input, totalDeduction);

  const brackets = config.brackets[filingStatus];
  const ltcgBrackets = config.ltcgBrackets[filingStatus];

  const ordinaryTax = toCents(computeOrdinaryTax(taxableOrdinary, brackets));
  const ltcgTax = computeLtcgTax(taxableOrdinary, taxableIncome, ltcgBrackets);
  const niitTax = computeNiitCents(magi, netInvestmentIncome, config.niitThresholds[filingStatus]);
  const totalTax = ordinaryTax + ltcgTax + niitTax;

  const { marginalOrdinaryRate, marginalLtcgRate } =
    computeMarginalRates(taxableOrdinary, ltcgAndQdi, taxableIncome, brackets, ltcgBrackets);

  return {
    ordinaryTax, ltcgTax, niitTax, totalTax,
    effectiveRatePct: computeEffectiveRate(totalTax, totalGross),
    marginalOrdinaryRate, marginalLtcgRate,
  };
}

/**
 * Standalone marginal ordinary-income rate helper.
 * Useful for quick rate look-ups without full tax computation.
 *
 * `year` is `number` (not the `TaxYear = 2024|2025|2026` union) so callers
 * passing a `resolveFederalTaxSnapshotForYear`-synthesized future-year snapshot
 * (e.g. a 2030/2035 retirement row) can look it up without a cast. The body
 * already throws `UnsupportedTaxYearError` when the year is absent, so widening
 * the param type stays backward-compatible (all existing `TaxYear` callers pass).
 *
 * @throws {UnsupportedTaxYearError} when `year` is not present in snapshot.
 */
export function marginalOrdinaryRate(
  year: number,
  filingStatus: FilingStatus,
  taxableIncome: number,
  snapshot: CalibrationSnapshot<TaxConfig>,
): number {
  const config = snapshot.values[year];
  if (config === undefined) throw new UnsupportedTaxYearError(year);
  if (taxableIncome <= 0) return 0;
  const brackets = config.brackets[filingStatus];
  return marginalBracket(taxableIncome, brackets).rate;
}

/**
 * Top (inclusive-exclusive) ceiling of the ordinary bracket a given
 * post-deduction taxable income falls in — i.e. the floor of the NEXT bracket
 * up. Returns `Infinity` when the income is already in the top bracket (no
 * higher boundary). The single source of truth for bracket-boundary selection
 * consumed by `betr-calculator.ts`'s `computeBracketHeadroom` /
 * `computeConversionTranches`, so headroom math can't silently diverge from the
 * engine on boundary inclusivity or future-year deduction changes.
 *
 * `taxableIncomeCents` is an integer-cents post-deduction figure; the bracket
 * floors are dollars, so the comparison is done in dollars and the result is
 * returned in cents. `year` is `number` for the same future-year reason as
 * `marginalOrdinaryRate`.
 *
 * @throws {UnsupportedTaxYearError} when `year` is not present in snapshot.
 */
export function nextBracketCeiling(
  taxableIncomeCents: number,
  year: number,
  filingStatus: FilingStatus,
  snapshot: CalibrationSnapshot<TaxConfig>,
): number {
  const config = snapshot.values[year];
  if (config === undefined) throw new UnsupportedTaxYearError(year);
  const brackets = config.brackets[filingStatus];
  const taxableIncomeDollars = taxableIncomeCents / CENTS_FACTOR;
  // Brackets are ascending by floor; find the first floor strictly above the
  // current taxable income — that floor is the current bracket's ceiling.
  for (const bracket of brackets) {
    if (bracket.floor > taxableIncomeDollars) {
      return toCents(bracket.floor);
    }
  }
  return Infinity;
}

/**
 * Ordinary bracket tax (integer cents) on an ALREADY-post-deduction taxable
 * income figure. This is the bracket-only primitive — it carries NO deduction
 * machinery, so it does not re-subtract the standard deduction that the caller
 * (the total-taxable proxy) has already removed. The conversion-cost probe
 * takes the delta of two calls (`income + conversion` minus `income`) to get the
 * marginal federal income-tax cost of a Roth conversion.
 *
 * Distinct from `computeFederalTax`, whose `TaxInput` takes PRE-deduction
 * dollars and subtracts the standard deduction internally (using it on a
 * post-deduction figure would double-count the deduction).
 *
 * `year` is `number` so post-2026 extrapolated snapshots are accepted.
 *
 * @throws {UnsupportedTaxYearError} when `year` is not present in snapshot.
 */
export function federalOrdinaryTaxCents(
  taxableIncomeCents: number,
  year: number,
  filingStatus: FilingStatus,
  snapshot: CalibrationSnapshot<TaxConfig>,
): number {
  const config = snapshot.values[year];
  if (config === undefined) throw new UnsupportedTaxYearError(year);
  const brackets = config.brackets[filingStatus];
  const taxableIncomeDollars = Math.max(0, taxableIncomeCents) / CENTS_FACTOR;
  return toCents(computeOrdinaryTax(taxableIncomeDollars, brackets));
}

/**
 * Standalone marginal LTCG/QDI rate helper.
 * `totalTaxableIncome` = ordinary taxable + LTCG (the stacked total).
 *
 * @throws {UnsupportedTaxYearError} when `year` is not present in snapshot.
 */
export function marginalLtcgRate(
  year: TaxYear,
  filingStatus: FilingStatus,
  totalTaxableIncome: number,
  snapshot: CalibrationSnapshot<TaxConfig>,
): number {
  const config = snapshot.values[year];
  if (config === undefined) throw new UnsupportedTaxYearError(year);
  if (totalTaxableIncome <= 0) return 0;
  const ltcgBrackets = config.ltcgBrackets[filingStatus];
  return marginalLtcgBracket(totalTaxableIncome, ltcgBrackets).rate;
}
