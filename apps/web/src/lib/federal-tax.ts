/**
 * US federal income tax engine for 2024–2026: ordinary and stacked LTCG/QDI brackets, standard deduction with age-65
 * add-on, the OBBBA senior bonus deduction and NIIT. No AMT, itemized deductions, QBI, SS provisional income or state tax.
 */

import type { CalibrationSnapshot } from './calibration';

/**
 * MFS and QSS are reached through the filing plan (`applyTaxYearForFilingPlan`, per tax unit), not the scalar
 * `deriveFilingStatus`; see docs/math-taxes.md, "Filing status and tax units". MFS has its own calibrated tables and
 * the §1411 $125,000 NIIT threshold, and is ineligible for the OBBBA senior bonus (§70103 requires a joint return for a
 * married taxpayer). QSS is computed on the MFJ schedule (26 U.S.C. §1(a)/§2(a)) but stays a distinct label so SS
 * taxation, IRMAA and eligibility windows treat it as an individual filer; its senior-deduction phase-out uses the
 * $75,000 non-joint base and it gets one age-65 add-on at the married rate.
 */
export type FilingStatus = 'Single' | 'MFJ' | 'HoH' | 'MFS' | 'QSS';

/** Tax years with compiled bracket tables. Outside → UnsupportedTaxYearError. */
export type TaxYear = 2024 | 2025 | 2026;

export interface TaxBracket {
  readonly floor: number;
  readonly rate: number; // 0.10 … 0.37
}

/** Per-filing-status bracket table, ascending by floor; QSS references the MFJ schedule (§1(a)/§2(a)). */
export interface FilingStatusBrackets {
  readonly Single: readonly TaxBracket[];
  readonly MFJ: readonly TaxBracket[];
  readonly HoH: readonly TaxBracket[];
  readonly MFS: readonly TaxBracket[];
  readonly QSS: readonly TaxBracket[];
}

// QSS equals MFJ (§63(c)(2)).
interface StandardDeduction {
  readonly Single: number;
  readonly MFJ: number;
  readonly HoH: number;
  readonly MFS: number;
  readonly QSS: number;
}

interface Age65AddOn {
  readonly singleOrHoH: number;
  readonly mfj: number; // per qualifying spouse (multiply by 1 or 2)
}

// NIIT thresholds (IRC §1411) are not CPI-indexed: MFS is a fixed $125,000, QSS equals MFJ (§1411(b)(1)).
interface NiitThresholds {
  readonly Single: number;
  readonly MFJ: number;
  readonly HoH: number;
  readonly MFS: number;
  readonly QSS: number;
}

/** Preferential LTCG/QDI rate bracket; `floor` is the taxable income where the rate begins, after ordinary income is stacked below. */
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
 * OBBBA senior bonus deduction (2025–2028): a per-filer deduction for taxpayers 65+, phased out above a MAGI base at a
 * flat rate. Absent from the 2024 and 2029+ configs; lowers taxable income, not MAGI.
 */
export interface SeniorBonusDeduction {
  readonly perFilerCap: number;
  /** MAGI base per status: $150,000 for a joint return, $75,000 for Single, HoH and QSS. MFS is ineligible (§70103), so its key is unused. */
  readonly phaseoutBaseMagi: {
    readonly Single: number;
    readonly MFJ: number;
    readonly HoH: number;
    readonly MFS: number;
    readonly QSS: number;
  };
  readonly phaseoutRatePct: number;
}

export interface TaxConfig {
  readonly brackets: FilingStatusBrackets;
  readonly standardDeduction: StandardDeduction;
  readonly age65AddOn: Age65AddOn;
  readonly niitThresholds: NiitThresholds;
  readonly ltcgBrackets: LtcgBrackets;
  /** Present only for 2025–2028 (year-gated by config presence). */
  readonly seniorBonusDeduction?: SeniorBonusDeduction;
}

export interface TaxInput {
  /** Calendar tax year. Runtime validates via snapshot lookup (throws UnsupportedTaxYearError). */
  readonly year: TaxYear | number;
  readonly filingStatus: FilingStatus;
  readonly ordinaryIncome: number;
  readonly ltcgAndQdi: number;
  /** Net investment income (>= ltcgAndQdi) for NIIT; defaults to ltcgAndQdi, which under-estimates NII when passive ordinary income such as rent is also NII. */
  readonly netInvestmentIncome?: number;
  readonly taxpayersAge65Plus?: number;
  /** MAGI for the senior-deduction phase-out, computed before that deduction (it lowers taxable income, not MAGI); defaults to `ordinaryIncome + ltcgAndQdi`. */
  readonly magiForSeniorDeduction?: number;
}

export interface TaxResult {
  readonly ordinaryTax: number;   // cents
  readonly ltcgTax: number;       // cents
  readonly niitTax: number;       // cents
  readonly totalTax: number;      // cents (sum of above)
  readonly effectiveRatePct: number; // (totalTax / totalGrossIncome) * 100
  readonly marginalOrdinaryRate: number;
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

/** Last year the OBBBA senior bonus deduction applies (statutory expiry, Pub. L. 119-21 §70103), enforced even when the clamped config still carries the slot. */
export const SENIOR_BONUS_DEDUCTION_LAST_YEAR = 2028;

/** Rounds dollars to integer cents, half-up. */
export function toCents(dollars: number): number {
  return Math.round(dollars * CENTS_FACTOR);
}

function validateFiniteNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new InvalidTaxInputError(field, value);
  }
}

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

function marginalBracket(
  taxableIncome: number,
  brackets: readonly TaxBracket[],
): TaxBracket {
  for (let i = brackets.length - 1; i >= 0; i--) {
    if (taxableIncome > brackets[i].floor) return brackets[i];
  }
  return brackets[0];
}

function marginalLtcgBracket(
  totalTaxableIncome: number,
  ltcgBrackets: readonly LtcgBracket[],
): LtcgBracket {
  for (let i = ltcgBrackets.length - 1; i >= 0; i--) {
    if (totalTaxableIncome > ltcgBrackets[i].floor) return ltcgBrackets[i];
  }
  return ltcgBrackets[0];
}

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

/** Standard deduction including age-65 add-ons. */
export function computeStandardDeduction(
  filingStatus: FilingStatus,
  taxpayersAge65Plus: number,
  config: TaxConfig,
): number {
  const base = config.standardDeduction[filingStatus];
  // The married add-on rate applies to MFJ, MFS and QSS (§63(f)); Single/HoH use the larger non-married rate.
  // Only MFJ can claim two (both spouses); the rest are one-taxpayer returns.
  const isMarriedRate =
    filingStatus === 'MFJ' || filingStatus === 'MFS' || filingStatus === 'QSS';
  const addOn = isMarriedRate ? config.age65AddOn.mfj : config.age65AddOn.singleOrHoH;
  const maxAge65 = filingStatus === 'MFJ' ? 2 : 1;
  return base + addOn * Math.min(taxpayersAge65Plus, maxAge65);
}

/**
 * OBBBA senior bonus deduction in dollars: one per-filer cap per qualifying taxpayer (max 2 for MFJ, 1 otherwise),
 * phased out at `phaseoutRatePct` of `max(0, magi − base)` and floored at $0. `magi` is computed before this
 * deduction. Returns 0 when the config has no slot or no taxpayer is 65+. MFS always returns $0 (Pub. L. 119-21
 * §70103 / IRC §151(d)(5)(C)(v) require a joint return); QSS stays eligible at the $75,000 base.
 */
export function computeSeniorBonusDeduction(
  year: number,
  filingStatus: FilingStatus,
  taxpayersAge65Plus: number,
  magi: number,
  config: TaxConfig,
): number {
  if (filingStatus === 'MFS') return 0;
  // Year gate (statutory expiry): the clamp-without-inflation path reuses the latest config, which carries the slot, for post-2028 years.
  if (year > SENIOR_BONUS_DEDUCTION_LAST_YEAR) return 0;
  const slot = config.seniorBonusDeduction;
  if (slot === undefined) return 0;
  const maxFilers = filingStatus === 'MFJ' ? 2 : 1;
  const qualifyingFilers = Math.min(taxpayersAge65Plus, maxFilers);
  if (qualifyingFilers <= 0) return 0;
  const base = slot.phaseoutBaseMagi[filingStatus];
  const phaseout = slot.phaseoutRatePct * Math.max(0, magi - base);
  // The phase-out applies per cap, so an MFJ couple with two qualifying filers phases out at twice the rate.
  const perFilerAfterPhaseout = Math.max(0, slot.perFilerCap - phaseout);
  return perFilerAfterPhaseout * qualifyingFilers;
}

function computeNiitCents(magi: number, nii: number, threshold: number): number {
  const base = Math.min(nii, Math.max(0, magi - threshold));
  return toCents(base * NIIT_RATE);
}

// IRS Schedule D Tax Worksheet stacking: unused standard deduction absorbs LTCG when ordinary income is below it.
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

function computeEffectiveRate(totalCents: number, totalGross: number): number {
  return totalGross > 0 ? (totalCents / CENTS_FACTOR / totalGross) * 100 : 0;
}

function deriveTaxableBasis(
  input: TaxInput,
  totalDeduction: number,
): { taxableIncome: number; taxableOrdinary: number; taxableLtcg: number; magi: number; totalGross: number } {
  const { ordinaryIncome, ltcgAndQdi } = input;
  const totalGross = ordinaryIncome + ltcgAndQdi;
  const magi = totalGross; // no add-backs in v1
  const taxableIncome = Math.max(0, ordinaryIncome + ltcgAndQdi - totalDeduction);
  const taxableLtcg = Math.min(ltcgAndQdi, taxableIncome);
  const taxableOrdinary = taxableIncome - taxableLtcg;
  return { taxableIncome, taxableOrdinary, taxableLtcg, magi, totalGross };
}

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
 * Computes US federal income tax for one household from `snapshot.values[input.year]`.
 *
 * @throws {UnsupportedTaxYearError} when `input.year` is not in the snapshot.
 * @throws {InvalidTaxInputError} when any numeric input is negative, NaN or infinite.
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

  // The senior-deduction phase-out reads MAGI before that deduction; the default is the income sum.
  const magiForSeniorDeduction = input.magiForSeniorDeduction ?? ordinaryIncome + ltcgAndQdi;
  if (input.magiForSeniorDeduction !== undefined) {
    validateFiniteNonNegative(input.magiForSeniorDeduction, 'magiForSeniorDeduction');
  }

  // Both deductions reduce total income before the LTCG stacking; neither alters MAGI.
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
 * Marginal ordinary-income rate. `year` is `number` so a synthesized future-year snapshot can be looked up without a cast.
 *
 * @throws {UnsupportedTaxYearError} when `year` is not in the snapshot.
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
 * Ceiling of the ordinary bracket a post-deduction taxable income falls in (the next bracket's floor), or `Infinity`
 * in the top bracket. The one source of bracket-boundary selection for headroom math, so it cannot diverge from the
 * engine on boundary inclusivity. Takes and returns cents; the floors are dollars.
 *
 * @throws {UnsupportedTaxYearError} when `year` is not in the snapshot.
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
  for (const bracket of brackets) {
    if (bracket.floor > taxableIncomeDollars) {
      return toCents(bracket.floor);
    }
  }
  return Infinity;
}

/**
 * Ordinary bracket tax in cents on an already post-deduction taxable income: no deduction machinery, so the
 * conversion-cost probe can difference two calls for a Roth conversion's marginal cost. `computeFederalTax` takes
 * pre-deduction dollars; using it on a post-deduction figure would double-count the deduction.
 *
 * @throws {UnsupportedTaxYearError} when `year` is not in the snapshot.
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
 * Marginal LTCG/QDI rate; `totalTaxableIncome` is ordinary taxable plus LTCG (the stacked total).
 *
 * @throws {UnsupportedTaxYearError} when `year` is not in the snapshot.
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
