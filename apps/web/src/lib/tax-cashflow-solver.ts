/**
 * Annual tax-cashflow solver: federal tax, the IRMAA cash portion and the ACA credit offset become a same-year cash need the drawdown engine funds by raising the withdrawal target; it never throws.
 * `solveFillConversion` sizes Fill-mode Roth conversions against the same tax surface.
 */
import { applyTaxYearForFilingPlan } from './tax-integration';
import type {
  ApplyFilingPlanYearInput,
  TaxCalibrationBundle,
  TaxMemberInput,
  TaxYearResult,
} from './tax-integration';
import { DEFAULT_ASSUMED_COST_BASIS_FRACTION, dollarsToCents } from './tax-integration';
import {
  creditAppliedToPremiumsCents,
  drawIncomeCents,
  povertyLineLimitCents,
} from './credit-applied-to-premiums';

// Shared `code` of every engine's `UnsupportedTaxYearError`: a year below the calibration floor has
// no modelable tax, so the solver degrades to zero need instead of throwing.
const UNSUPPORTED_TAX_YEAR_CODE = 'UNSUPPORTED_TAX_YEAR';

function isUnsupportedTaxYear(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === UNSUPPORTED_TAX_YEAR_CODE
  );
}

function zeroTaxCashflowResult(): TaxCashflowResult {
  return {
    federalTaxCashNeedCents: 0,
    irmaaWithheldFromSsCents: 0,
    irmaaCashNeedCents: 0,
    acaPtcCashflowOffsetCents: 0,
    acaCreditAppliedToPremiumsCents: 0,
    totalTaxCashflowNeedCents: 0,
    taxCashflowIterations: 0,
    taxCashflowConverged: true,
    taxCashflowShortfallCents: 0,
    taxYearResult: ZERO_TAX_YEAR_RESULT,
  };
}

const ZERO_TAX_YEAR_RESULT: TaxYearResult = {
  federalTaxCents: 0,
  taxableSsCents: 0,
  ssTaxationTier: 'none',
  rmdFloorCents: 0,
  rmdApplicable: false,
  rmdPerAccountCents: {},
  irmaaSurchargeCents: 0,
  irmaaTier: 'none',
  acaPtcSubsidyCents: 0,
  acaPtcTier: 'below-fpl',
  fplPercentage: 0,
  acaMagiAboveFplCents: 0,
  magiCents: 0,
  effectiveTaxRate: 0,
  taxYearExtrapolated: false,
  earlyWithdrawalPenaltyCents: 0,
  hsaAdditionalTaxCents: 0,
  penaltySkippedForMissingBirthdate: false,
};

const CONVERGENCE_DOLLARS = 1;
const MAX_PASSES = 8;

// CMS collects the Part B/D surcharge from each beneficiary's own Social Security, so a member's
// surcharge is withheld only from that member's own SS (capped at it); the remainder, and the whole
// surcharge of a Medicare member not yet claiming SS, is a same-year cash need. Withholding never
// reaches a spouse's SS.
interface IrmaaPaymentAvailability {
  // A Medicare member absent from the map (or mapped to 0) has no own SS to absorb withholding.
  readonly ownSsDollarsByMemberId: Readonly<Record<string, number>>;
}

/**
 * Inputs to one annual solve. `taxInputBase` is the per-year tax input except for the
 * withdrawal-classification fields, which the solver overwrites each pass from the callback's
 * classification.
 */
export interface TaxCashflowSolveArgs {
  /** The ordinary (non-tax) net spending need for the year, in dollars. */
  readonly ordinaryNetNeedDollars: number;
  readonly taxInputBase: ApplyFilingPlanYearInput;
  readonly bundle: TaxCalibrationBundle;
  readonly irmaaPayment: IrmaaPaymentAvailability;
  /**
   * Classifies the withdrawals by tax bucket for a total year withdrawal target (ordinary + tax)
   * and reports the dollars the portfolio could supply (`fundedDollars < target` means depleted).
   * Runs a non-committing trial; the real draw runs once after convergence.
   */
  readonly classifyForTarget: (totalTargetDollars: number) => WithdrawalClassification;
  /**
   * The year's modeled Medical expenses (every `isMedical` row), integer cents; absent applies no
   * credit (the Roth-conversion funding solves difference two zero-need solves and must not see the
   * line).
   */
  readonly medicalExpenseCents?: number;
  /**
   * Taxable Roth earnings already in `taxInputBase`'s ordinary income, dollars (ACA MAGI a lower
   * draw sheds); default 0.
   */
  readonly rothEarningsIncomeDollars?: number;
}

/** Per-bucket withdrawal classification returned by the funding callback. */
interface WithdrawalClassification {
  readonly preTaxDollars: number;
  readonly postTaxNonRothDollars: number;
  readonly postTaxCashLikeDollars: number;
  readonly rothDollars: number;
  /**
   * The inherited Roth IRA portion of `rothDollars` (a subset, not a separate bucket); passed
   * through untouched, it only changes how much of the Roth tranche is charged against the §408A
   * basis carrier.
   */
  readonly rothInheritedTaxFreeDollars?: number;
  /** Dollars the portfolio could supply for the target; less than the target means depletion. */
  readonly fundedDollars: number;
}

/** Result of one annual solve. All monetary fields in integer cents. */
export interface TaxCashflowResult {
  /** Federal income tax owed for the year, in integer cents. */
  readonly federalTaxCashNeedCents: number;
  /**
   * IRMAA surcharge withheld from Social Security, cents. Kept out of `totalTaxCashflowNeedCents`
   * because the runner adds it to the draw separately: spendable income uses gross SS, so the
   * portfolio must fund the shrunken check (see `toTaxCashflowOutcome` in
   * `balance-projection-runner-tax.ts`).
   */
  readonly irmaaWithheldFromSsCents: number;
  /** IRMAA surcharge paid as same-year cash need, cents. */
  readonly irmaaCashNeedCents: number;
  /** ACA PTC offset applied against the tax/health cashflow need, cents. */
  readonly acaPtcCashflowOffsetCents: number;
  /** The credit left after that offset that lowers the year's draw, cents. */
  readonly acaCreditAppliedToPremiumsCents: number;
  /** Total same-year tax cashflow need the withdrawal target must fund:
   *  `max(0, federalTax + irmaaCash − acaPtcOffset)`, cents. */
  readonly totalTaxCashflowNeedCents: number;
  /** Number of solver passes executed (1..MAX_PASSES). */
  readonly taxCashflowIterations: number;
  /** True when the net tax cost converged (< `$1`) before the pass cap. */
  readonly taxCashflowConverged: boolean;
  /** Dollars of the grossed-up withdrawal the portfolio could not supply,
   *  cents. Zero when fully fundable. */
  readonly taxCashflowShortfallCents: number;
  /** The full `TaxYearResult` from the final pass (display annotation). */
  readonly taxYearResult: TaxYearResult;
}

function splitGroupIrmaaPayment(
  surchargeCents: number,
  medicareMembers: readonly TaxMemberInput[],
  availability: IrmaaPaymentAvailability,
): { withheldCents: number; cashCents: number } {
  if (surchargeCents <= 0) return { withheldCents: 0, cashCents: 0 };
  // A positive surcharge with no Medicare member should not occur; treat it as cash rather than
  // divide by zero.
  if (medicareMembers.length === 0) return { withheldCents: 0, cashCents: surchargeCents };
  // Within one return the per-beneficiary surcharge is uniform; the rounding cent goes to the first
  // member so the parts sum to the total.
  const perMemberBase = Math.floor(surchargeCents / medicareMembers.length);
  let remainderCents = surchargeCents - perMemberBase * medicareMembers.length;
  let withheldCents = 0;
  let cashCents = 0;
  for (const member of medicareMembers) {
    let memberSurcharge = perMemberBase;
    if (remainderCents > 0) {
      memberSurcharge += 1;
      remainderCents -= 1;
    }
    const ownSsCents = Math.max(
      0,
      dollarsToCents(availability.ownSsDollarsByMemberId[member.memberId] ?? 0),
    );
    const memberWithheld = Math.min(memberSurcharge, ownSsCents);
    withheldCents += memberWithheld;
    cashCents += memberSurcharge - memberWithheld;
  }
  return { withheldCents, cashCents };
}

// Split the year's IRMAA surcharge into withheld-from-SS and same-year cash, per member (CMS
// collects Part B/D per beneficiary). The engine's per-beneficiary breakdown
// (`irmaaSurchargeCentsByMember`) is authoritative: month-aware IRMAA prorates by each
// beneficiary's own enrolment months, so the whole-year `onMedicare` flag does not identify who owes.
// Two returns can land on different IRMAA tiers, so the merged surcharge must not be re-divided
// equally; the per-unit amounts (`irmaaSurchargeCentsByUnit`) are the fallback for a result without
// the per-beneficiary breakdown.
function splitIrmaaPayment(
  result: TaxYearResult,
  members: readonly TaxMemberInput[],
  availability: IrmaaPaymentAvailability,
): { withheldCents: number; cashCents: number } {
  const irmaaSurchargeCents = result.irmaaSurchargeCents;
  if (irmaaSurchargeCents <= 0) return { withheldCents: 0, cashCents: 0 };
  const byMember = result.irmaaSurchargeCentsByMember;
  if (byMember !== undefined && byMember.length > 0) {
    let withheldCents = 0;
    let cashCents = 0;
    for (const { memberId, surchargeCents } of byMember) {
      if (surchargeCents <= 0) continue;
      const ownSsCents = Math.max(
        0,
        dollarsToCents(availability.ownSsDollarsByMemberId[memberId] ?? 0),
      );
      const memberWithheld = Math.min(surchargeCents, ownSsCents);
      withheldCents += memberWithheld;
      cashCents += surchargeCents - memberWithheld;
    }
    return { withheldCents, cashCents };
  }
  const medicareMembers = members.filter((m) => m.onMedicare);
  const byUnit = result.irmaaSurchargeCentsByUnit;
  if (byUnit === undefined || byUnit.length <= 1) {
    return splitGroupIrmaaPayment(irmaaSurchargeCents, medicareMembers, availability);
  }
  let withheldCents = 0;
  let cashCents = 0;
  for (const unit of byUnit) {
    const unitMembers = medicareMembers.filter((m) => unit.memberIds.includes(m.memberId));
    const part = splitGroupIrmaaPayment(unit.surchargeCents, unitMembers, availability);
    withheldCents += part.withheldCents;
    cashCents += part.cashCents;
  }
  return { withheldCents, cashCents };
}

// Floored at zero: the ACA PTC never creates a negative tax cashflow need.
function totalCashflowNeedCents(
  federalTaxCents: number,
  irmaaCashCents: number,
  acaPtcOffsetCents: number,
): number {
  return Math.max(0, federalTaxCents + irmaaCashCents - acaPtcOffsetCents);
}

function taxInputForClassification(
  base: ApplyFilingPlanYearInput,
  cls: WithdrawalClassification,
): ApplyFilingPlanYearInput {
  return {
    ...base,
    preTaxWithdrawalDollars: cls.preTaxDollars,
    postTaxNonRothWithdrawalDollars: cls.postTaxNonRothDollars,
    postTaxCashLikeWithdrawalDollars: cls.postTaxCashLikeDollars,
    rothWithdrawalDollars: cls.rothDollars,
  };
}

// Thrown internally for a year below the calibration floor; caught by `solveTaxCashflow` to return
// the zero result.
const UNSUPPORTED_YEAR_SENTINEL = Symbol('unsupportedTaxYear');

interface SolverPassState {
  pass: number;
  converged: boolean;
  needCents: number;
  federalCents: number;
  irmaaWithheldCents: number;
  irmaaCashCents: number;
  acaOffsetCents: number;
  creditAppliedCents: number;
  povertyLineLimitCents: number;
  requestedTargetDollars: number;
  classification: WithdrawalClassification | undefined;
  result: TaxYearResult | undefined;
}

function runOnePass(
  args: TaxCashflowSolveArgs,
  totalTargetDollars: number,
  state: SolverPassState,
): void {
  const { taxInputBase, bundle, irmaaPayment, classifyForTarget } = args;
  state.requestedTargetDollars = totalTargetDollars;
  const cls = classifyForTarget(totalTargetDollars);
  state.classification = cls;
  let result: TaxYearResult;
  try {
    result = applyTaxYearForFilingPlan(taxInputForClassification(taxInputBase, cls), bundle);
  } catch (err) {
    if (isUnsupportedTaxYear(err)) throw UNSUPPORTED_YEAR_SENTINEL;
    throw err;
  }
  state.result = result;
  const { withheldCents, cashCents } = splitIrmaaPayment(
    result,
    taxInputBase.members,
    irmaaPayment,
  );
  state.federalCents = result.federalTaxCents;
  state.irmaaWithheldCents = withheldCents;
  state.irmaaCashCents = cashCents;
  // The ACA offset is the portion applied against the need (never more than federal + IRMAA cash,
  // so the need stays ≥ 0).
  state.acaOffsetCents = Math.min(result.acaPtcSubsidyCents, result.federalTaxCents + cashCents);
  state.needCents = totalCashflowNeedCents(result.federalTaxCents, cashCents, result.acaPtcSubsidyCents);
  // With Medical expenses supplied, the credit left after federal tax and IRMAA cash lowers the
  // draw; each pass recomputes it, and it enters the next trial target and the convergence test.
  if (args.medicalExpenseCents === undefined) {
    state.creditAppliedCents = 0;
    return;
  }
  if (state.pass === 1) {
      // Set on pass 1 (the draw before any line) and held, so no trial draw falls below the line
      // and the loop cannot cycle between earning the credit and losing it.
    state.povertyLineLimitCents = povertyLineLimitCents({
      headroomCents: result.acaMagiAboveFplCents,
      ...drawIncomeCents({
        preTaxDollars: cls.preTaxDollars,
        taxableAccountDollars: cls.postTaxNonRothDollars,
        rothEarningsDollars: args.rothEarningsIncomeDollars ?? 0,
        costBasisFraction: taxInputBase.assumedCostBasisFraction ?? DEFAULT_ASSUMED_COST_BASIS_FRACTION,
      }),
    });
  }
  state.creditAppliedCents = creditAppliedToPremiumsCents({
    creditCents: result.acaPtcSubsidyCents,
    offsetCents: state.acaOffsetCents,
    medicalCents: args.medicalExpenseCents,
    // The draw this pass would commit before the line.
    remainingNeedCents: dollarsToCents(args.ordinaryNetNeedDollars) + state.needCents + withheldCents,
    povertyLineLimitCents: state.povertyLineLimitCents,
  });
}

function buildResult(state: SolverPassState): TaxCashflowResult {
  const fundedDollars = state.classification?.fundedDollars ?? 0;
  const shortfallCents = Math.max(0, dollarsToCents(state.requestedTargetDollars - fundedDollars));
  return {
    federalTaxCashNeedCents: state.federalCents,
    irmaaWithheldFromSsCents: state.irmaaWithheldCents,
    irmaaCashNeedCents: state.irmaaCashCents,
    acaPtcCashflowOffsetCents: state.acaOffsetCents,
    acaCreditAppliedToPremiumsCents: state.creditAppliedCents,
    totalTaxCashflowNeedCents: state.needCents,
    taxCashflowIterations: Math.min(state.pass, MAX_PASSES),
    taxCashflowConverged: state.converged,
    taxCashflowShortfallCents: shortfallCents,
    // result is always set: the loop runs at least one pass (MAX_PASSES ≥ 1).
    taxYearResult: state.result!,
  };
}

/**
 * Solve the annual tax/withdrawal feedback loop; a non-converged loop or an unfundable draw returns
 * the last values with a diagnostic.
 * Within-year fixpoint: a household owing more tax must withdraw more, which raises MAGI and the
 * MAGI-dependent costs (federal tax, SS §86 taxation, ACA PTC), so the trial target iterates until
 * the net tax cost moves by less than $1, hard-stopping at 8 passes. IRMAA is a constant input for
 * the year (2-year MAGI look-back), keeping the iteration a contraction.
 * Per-pass trial target = `ordinaryNetNeed + (needCents + withheldCents − creditAppliedCents)`,
 * seeded with the ordinary need only.
 */
export function solveTaxCashflow(args: TaxCashflowSolveArgs): TaxCashflowResult {
  const { ordinaryNetNeedDollars } = args;
  const state: SolverPassState = {
    pass: 0,
    converged: false,
    needCents: 0,
    federalCents: 0,
    irmaaWithheldCents: 0,
    irmaaCashCents: 0,
    acaOffsetCents: 0,
    creditAppliedCents: 0,
    povertyLineLimitCents: Number.POSITIVE_INFINITY,
    requestedTargetDollars: ordinaryNetNeedDollars,
    classification: undefined,
    result: undefined,
  };
  let prevNetCostCents = Number.NaN;
  let totalTargetDollars = ordinaryNetNeedDollars;

  try {
    for (state.pass = 1; state.pass <= MAX_PASSES; state.pass += 1) {
      runOnePass(args, totalTargetDollars, state);
      // Convergence test on the net cost (need less the line), which the loop drives.
      const netCostCents = state.needCents - state.creditAppliedCents;
      if (Number.isFinite(prevNetCostCents)
        && Math.abs(netCostCents - prevNetCostCents) < dollarsToCents(CONVERGENCE_DOLLARS)) {
        state.converged = true;
        break;
      }
      prevNetCostCents = netCostCents;
      // Next trial: the withheld IRMAA is funded by an extra draw (the runner spends gross SS) that
      // is itself taxable pre-tax income, so it is folded into the target to avoid under-counting
      // its tax. It is a constant within-year offset, so the `needCents`-keyed convergence test
      // still contracts, and the principal is added once to the committing draw
      // (`addedNeedDollars`).
      totalTargetDollars =
        ordinaryNetNeedDollars +
        (state.needCents + state.irmaaWithheldCents - state.creditAppliedCents) / 100;
    }
  } catch (err) {
    if (err === UNSUPPORTED_YEAR_SENTINEL) return zeroTaxCashflowResult();
    throw err;
  }

  return buildResult(state);
}

// Fill-mode Roth-conversion solve: an outer monotone bisection sizing the year's auto-conversion so
// realized MAGI on the selected line lands at the ceiling, never above.

const FILL_CONVERSION_MAX_ITERS = 40;
const FILL_CONVERSION_TOLERANCE_DOLLARS = 1;

/**
 * Inputs to one Fill-mode conversion solve. `taxInputBase` carries the year's committed
 * withdrawals; each probe adds the trial conversion as additional ordinary income, never in
 * `preTaxWithdrawalDollars` (which would wrongly feed the §72(t) penalty basis).
 */
export interface FillConversionSolveArgs {
  readonly taxInputBase: ApplyFilingPlanYearInput;
  readonly bundle: TaxCalibrationBundle;
  /**
   * MAGI line the ceiling targets: `'irmaa'` is the federal/IRMAA MAGI (taxable SS only), `'aca'`
   * the ACA MAGI (full-SS add-back).
   */
  readonly capMagiLine: 'irmaa' | 'aca';
  readonly magiCeilingDollars: number;
  /**
   * Gross-dollar residual cap room, the bisection's upper bracket; the realized conversion is
   * further shrunk so MAGI ≤ ceiling.
   */
  readonly convertibleRoomDollars: number;
}

/** Result of one Fill conversion solve. */
export interface FillConversionSolveResult {
  /**
   * Converted dollars, rounded down to whole cents so realized MAGI never exceeds the ceiling; zero
   * with no headroom.
   */
  readonly convertedDollars: number;
  /** Bisection iterations executed (diagnostic). */
  readonly iterations: number;
}

// Realized MAGI (dollars) on the selected line for a probe conversion, side-effect-free;
// `+Infinity` for a year below the calibration floor so the solve converges to $0 rather than
// converting blindly.
function magiOnLineForConversion(
  args: FillConversionSolveArgs,
  convDollars: number,
): number {
  const { taxInputBase, bundle, capMagiLine } = args;
  const probeInput: ApplyFilingPlanYearInput = {
    ...taxInputBase,
    otherOrdinaryIncomeDollars: taxInputBase.otherOrdinaryIncomeDollars + convDollars,
  };
  let result: TaxYearResult;
  try {
    result = applyTaxYearForFilingPlan(probeInput, bundle);
  } catch (err) {
    if (isUnsupportedTaxYear(err)) return Number.POSITIVE_INFINITY;
    throw err;
  }
  if (capMagiLine === 'aca') {
    // ACA MAGI adds back the nontaxable SS portion (slope 1.0); `magiCents` is the federal/IRMAA
    // MAGI, so reconstruct the ACA figure.
    const taxableSsDollars = result.taxableSsCents / 100;
    const nontaxableSsDollars = Math.max(0, taxInputBase.grossSsDollars - taxableSsDollars);
    return result.magiCents / 100 + nontaxableSsDollars;
  }
  // The §86-tier slope (1.0/1.5/1.85) is already in `magiCents`.
  return result.magiCents / 100;
}

/**
 * Size the Fill-mode conversion by an outer monotone bisection on the engine's computed MAGI: the
 * largest `conv ∈ [0, convertibleRoom]` with `MAGI_line(conv) ≤ ceiling`, rounded down to whole
 * cents. MAGI is non-decreasing in `conv`, so the bisection converges even across the §86 spillover
 * kinks. Returns $0 when `conv = 0` already exceeds the ceiling and the full room when it stays
 * under.
 */
export function solveFillConversion(args: FillConversionSolveArgs): FillConversionSolveResult {
  const room = Math.max(0, args.convertibleRoomDollars);
  if (room <= 0) return { convertedDollars: 0, iterations: 0 };

  const magiAtZero = magiOnLineForConversion(args, 0);
  if (magiAtZero >= args.magiCeilingDollars) return { convertedDollars: 0, iterations: 0 };

  const magiAtRoom = magiOnLineForConversion(args, room);
  if (magiAtRoom <= args.magiCeilingDollars) {
    return { convertedDollars: Math.floor(room * 100) / 100, iterations: 0 };
  }

  // Bisect: invariant `MAGI(lo) ≤ ceiling < MAGI(hi)`.
  let lo = 0;
  let hi = room;
  let iterations = 0;
  while (hi - lo > FILL_CONVERSION_TOLERANCE_DOLLARS && iterations < FILL_CONVERSION_MAX_ITERS) {
    const mid = lo + (hi - lo) / 2;
    if (magiOnLineForConversion(args, mid) <= args.magiCeilingDollars) {
      lo = mid;
    } else {
      hi = mid;
    }
    iterations += 1;
  }
  // `lo` is the largest probed conversion at/under the ceiling; rounding down keeps the committed
  // conversion from tipping MAGI over.
  return { convertedDollars: Math.floor(lo * 100) / 100, iterations };
}
