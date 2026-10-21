/**
 * Annual tax-cashflow solver. Closes the withdrawal/tax feedback
 * loop: federal income tax, the IRMAA cash portion, and the ACA
 * premium-tax-credit offset become a same-year cash need that the drawdown
 * engine funds by raising the year's withdrawal target.
 *
 * Within-year fixpoint: a household that owes more tax must withdraw
 * more, which raises MAGI, which can raise the current-year-MAGI-dependent
 * costs (federal tax, SS §86 taxation, ACA PTC). The solver iterates the
 * trial withdrawal → tax → new trial withdrawal cycle until the net tax
 * cost moves by less than `$1`, hard-stopping at `8` passes. IRMAA is a
 * CONSTANT input for the year (2-year MAGI look-back from `magiBuffer[i-2]`,
 * resolved by the caller); it only feeds the cash/SS-withholding need, it
 * is NOT re-solved inside the loop — keeping the iteration a contraction
 * and matching the existing look-back mechanic.
 *
 * Graceful degradation: when the loop does not
 * converge inside the pass cap, or when the funding callback reports the
 * portfolio cannot supply the grossed-up withdrawal, the solver returns
 * the last computed values plus a diagnostic — it NEVER throws.
 *
 * IRMAA payment handling is hybrid: the caller splits the year's
 * IRMAA surcharge into a portion withheld from a member's Social Security
 * (when that member is receiving benefits) and a portion paid as same-year
 * cash (when the member is on Medicare but not yet claiming SS). Only the
 * cash portion lands in `totalTaxCashflowNeedCents` (a direct tax payment
 * from the portfolio). The withheld portion is reported separately as
 * `irmaaWithheldFromSsCents`; it is NOT folded into the cash field. The
 * runner adds the withheld amount to the engine draw add-on separately
 * because the spendable income series spends GROSS SS — the withheld
 * surcharge shrinks the member's SS check, so the portfolio must fund the
 * difference. See `toTaxCashflowOutcome` in
 * `balance-projection-runner-tax.ts`.
 *
 * Withheld IRMAA → MAGI feedback: the extra draw the runner makes to
 * cover the SS-withheld surcharge is itself taxable pre-tax income, so the
 * solver's per-pass trial target adds the withheld cents on top of the
 * ordinary need + cash tax need. This taxes the withheld-funded draw (so it is
 * not under-counted) while keeping the convergence guard — which keys on
 * the withheld-FREE `needCents` — a contraction, because the withheld
 * surcharge is a CONSTANT within-year input (2-year MAGI look-back). The
 * withheld principal is still counted exactly once on the committing draw
 * (in the runner's `addedNeedDollars`); only the federal tax on it rises.
 *
 * Credit applied to premiums: when the caller supplies the year's modeled
 * Medical expenses, the part of the ACA credit left after federal tax and the
 * IRMAA cash need lowers the year's draw (capped at those expenses and at the
 * draw itself). Each pass computes it from that pass's own credit, and it
 * enters the next trial target and the convergence test the same way the tax
 * need does. The loop stays a contraction: a lower draw raises the credit by at
 * most the applicable percentage of the MAGI it removes, and the line is capped.
 */
import { applyTaxYearForFilingPlan } from './tax-integration';
import type {
  ApplyFilingPlanYearInput,
  TaxCalibrationBundle,
  TaxMemberInput,
  TaxYearResult,
} from './tax-integration';
import { dollarsToCents } from './tax-integration';
import { creditAppliedToPremiumsCents } from './credit-applied-to-premiums';

/** Shared error `code` thrown by every engine's `UnsupportedTaxYearError`
 *  (federal-tax / ss-taxation / irmaa / aca-ptc / rmd). A projection year
 *  below the calibration floor has no modelable tax — the solver degrades
 *  gracefully (zero need) rather than throwing. */
const UNSUPPORTED_TAX_YEAR_CODE = 'UNSUPPORTED_TAX_YEAR';

function isUnsupportedTaxYear(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === UNSUPPORTED_TAX_YEAR_CODE
  );
}

/** A zero tax cashflow result — returned when the year is below the
 *  calibration floor (graceful degradation). `taxYearResult` is left
 *  undefined-safe by the caller's null guard. */
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

/** Neutral `TaxYearResult` used when no tax can be modeled for the year. */
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
  magiCents: 0,
  effectiveTaxRate: 0,
  taxYearExtrapolated: false,
  earlyWithdrawalPenaltyCents: 0,
  hsaAdditionalTaxCents: 0,
  penaltySkippedForMissingBirthdate: false,
};

/** Convergence threshold: stop once the net tax cost moves < `$1`. */
const CONVERGENCE_DOLLARS = 1;
/** Hard cap on solver passes. */
const MAX_PASSES = 8;

/**
 * Per-member IRMAA payment availability for the year. The caller
 * resolves each member's OWN annual Social Security benefit. CMS collects
 * the Part B/D surcharge per beneficiary out of that beneficiary's own
 * Social Security — so the split is per-member, not from a household pool:
 * a Medicare member's surcharge is withheld only from THAT member's own SS
 * (capped at it); any uncovered remainder — and the entire surcharge of a
 * Medicare member who is not yet claiming their own SS — becomes a same-year
 * cash need funded from the portfolio. Withholding NEVER reaches across to a
 * spouse's SS.
 */
interface IrmaaPaymentAvailability {
  /** Each member's OWN annual Social Security dollars, keyed by `memberId`.
   *  A Medicare member absent from the map (or mapped to 0) has no own SS to
   *  absorb withholding → their whole surcharge falls to the cash need. */
  readonly ownSsDollarsByMemberId: Readonly<Record<string, number>>;
}

/**
 * Inputs to one annual solve. `taxInput` is the assembled per-year tax
 * input EXCEPT for the withdrawal-classification fields, which the solver
 * recomputes each pass from the funding callback. The solver overwrites
 * `preTaxWithdrawalDollars` / `postTaxNonRothWithdrawalDollars` /
 * `postTaxCashLikeWithdrawalDollars` / `rothWithdrawalDollars` on each pass
 * from the classification the callback returns for the trial target.
 */
export interface TaxCashflowSolveArgs {
  /** The ordinary (non-tax) net spending need for the year, in dollars. */
  readonly ordinaryNetNeedDollars: number;
  /** Assembled per-year tax input. Withdrawal-classification fields are
   *  replaced each pass by the callback's classification. */
  readonly taxInputBase: ApplyFilingPlanYearInput;
  /** Calibration bundle for the five tax engines. */
  readonly bundle: TaxCalibrationBundle;
  /** Per-member IRMAA payment availability (hybrid handling). */
  readonly irmaaPayment: IrmaaPaymentAvailability;
  /**
   * Funding callback: given a TOTAL year withdrawal target (ordinary +
   * tax), classify the resulting withdrawals by tax bucket. Returns the
   * per-bucket classification AND the actual dollars the portfolio could
   * supply (`fundedDollars`) — when `fundedDollars < target` the portfolio
   * is depleted and the tax cashflow cannot be fully funded.
   *
   * Pure with respect to the solver: the engine implementation runs a
   * trial (non-committing) year simulation; the real committing draw runs
   * once after convergence using the solver's final target.
   */
  readonly classifyForTarget: (totalTargetDollars: number) => WithdrawalClassification;
  /**
   * The year's modeled Medical expenses (every `isMedical` row), in integer
   * cents. Present only on the committing solve; absent means no credit is
   * applied to premiums (the Roth-conversion funding solves difference two
   * zero-need solves and must not see the line).
   */
  readonly medicalExpenseCents?: number;
}

/** Per-bucket withdrawal classification returned by the funding callback. */
export interface WithdrawalClassification {
  readonly preTaxDollars: number;
  readonly postTaxNonRothDollars: number;
  readonly postTaxCashLikeDollars: number;
  readonly rothDollars: number;
  /** The INHERITED Roth IRA portion of `rothDollars` (a SUBSET of it, not a
   *  separate bucket). Passed through untouched by the solver: it changes only how
   *  much of the Roth tranche `buildSolverPenaltyAccountsForYear` charges against
   *  the §408A basis carrier, never any funded or taxable total. Absent → none. */
  readonly rothInheritedTaxFreeDollars?: number;
  /** Dollars the portfolio could actually supply for the requested target.
   *  Less than the target → depletion / unfundable. */
  readonly fundedDollars: number;
}

/** Result of one annual solve. All monetary fields in integer cents. */
export interface TaxCashflowResult {
  /** Federal income tax owed for the year, in integer cents. */
  readonly federalTaxCashNeedCents: number;
  /** IRMAA surcharge withheld from Social Security (no cash draw), cents. */
  readonly irmaaWithheldFromSsCents: number;
  /** IRMAA surcharge paid as same-year cash need, cents. */
  readonly irmaaCashNeedCents: number;
  /** ACA PTC offset applied against the tax/health cashflow need, cents. */
  readonly acaPtcCashflowOffsetCents: number;
  /** The credit left after that offset that lowers the year's draw because the
   *  premium is a modeled Medical expense, cents. Zero without a medical cap. */
  readonly acaCreditAppliedToPremiumsCents: number;
  /** Total same-year tax cashflow need the withdrawal target must fund:
   *  `max(0, federalTax + irmaaCash − acaPtcOffset)`, cents. */
  readonly totalTaxCashflowNeedCents: number;
  /** Number of solver passes executed (1..MAX_PASSES). */
  readonly taxCashflowIterations: number;
  /** True when the net tax cost converged (< `$1`) before the pass cap. */
  readonly taxCashflowConverged: boolean;
  /** Dollars of the grossed-up withdrawal the portfolio could NOT supply,
   *  cents. Zero when fully fundable. */
  readonly taxCashflowShortfallCents: number;
  /** The full `TaxYearResult` from the final pass (display annotation). */
  readonly taxYearResult: TaxYearResult;
}

/** Withheld-vs-cash split for one group of Medicare beneficiaries sharing one
 *  return's surcharge. Each member's share is withheld only from THAT member's
 *  own SS (capped at it); the uncovered remainder falls to the cash need. */
function splitGroupIrmaaPayment(
  surchargeCents: number,
  medicareMembers: readonly TaxMemberInput[],
  availability: IrmaaPaymentAvailability,
): { withheldCents: number; cashCents: number } {
  if (surchargeCents <= 0) return { withheldCents: 0, cashCents: 0 };
  // Defensive: a positive surcharge with no Medicare member should not occur
  // (the engine only assesses IRMAA when a member is on Medicare). Treat the
  // whole surcharge as cash rather than divide by zero.
  if (medicareMembers.length === 0) return { withheldCents: 0, cashCents: surchargeCents };
  // Within ONE return the per-beneficiary surcharge is uniform (CMS publishes one
  // surcharge schedule per tier); distribute any rounding cent to the first
  // member so the per-member parts sum back to the group total.
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

/**
 * Split the year's IRMAA surcharge into a withheld-from-SS portion and a
 * same-year cash portion PER MEMBER (mirrors how CMS collects Part B/D per
 * beneficiary). Each Medicare member's surcharge is withheld only from THAT
 * member's own SS; withholding never reaches across to a spouse's SS.
 *
 * Month-aware IRMAA prorates Part B and Part D by each
 * beneficiary's OWN enrolment months, so two beneficiaries no longer owe equal
 * amounts and the legacy whole-year `onMedicare` boolean no longer identifies
 * who owes anything (a member with stated Medicare months but a false
 * age-derived flag was silently omitted). When the engine reports the
 * per-beneficiary breakdown (`irmaaSurchargeCentsByMember`) it is authoritative:
 * each member's own charge is withheld from that member's own Social Security.
 *
 * When the year filed TWO returns they can land on DIFFERENT IRMAA
 * tiers, so the merged household surcharge must NOT be re-divided equally: the
 * engine hands back each return's own surcharge (`irmaaSurchargeCentsByUnit`)
 * and each return's beneficiaries are charged their own return's amount. That
 * per-unit path remains the fallback for a result carrying no per-beneficiary
 * breakdown (a hand-built `TaxYearResult` in a focused test).
 */
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

/**
 * Compute the total same-year tax cashflow need from the engine results:
 * federal tax + IRMAA cash portion − ACA PTC offset, floored at zero
 * (D-plan: ACA PTC never creates a negative tax cashflow need).
 */
function totalCashflowNeedCents(
  federalTaxCents: number,
  irmaaCashCents: number,
  acaPtcOffsetCents: number,
): number {
  return Math.max(0, federalTaxCents + irmaaCashCents - acaPtcOffsetCents);
}

/** Build the per-pass tax input by overlaying the trial classification. */
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

/** Marker thrown internally when a pass hits a year below the calibration
 *  floor — caught by `solveTaxCashflow` to return the zero result. */
const UNSUPPORTED_YEAR_SENTINEL = Symbol('unsupportedTaxYear');

/** Accumulated state across solver passes — the last-pass figures plus the
 *  loop's convergence diagnostics. All monetary fields in integer cents. */
interface SolverPassState {
  pass: number;
  converged: boolean;
  needCents: number;
  federalCents: number;
  irmaaWithheldCents: number;
  irmaaCashCents: number;
  acaOffsetCents: number;
  creditAppliedCents: number;
  /** The target the last classification was run against (shortfall basis). */
  requestedTargetDollars: number;
  classification: WithdrawalClassification | undefined;
  result: TaxYearResult | undefined;
}

/** Run one solver pass for `totalTargetDollars`: classify, apply the tax
 *  engines, split IRMAA, and record the net cashflow need into `state`. */
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
    // Year below the calibration floor → no modelable tax (graceful
    // degradation). Signalled up to `solveTaxCashflow` via the sentinel.
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
  // ACA offset reported is the portion actually applied against the need
  // (floored — never more than federal + IRMAA cash so the need stays ≥ 0).
  state.acaOffsetCents = Math.min(result.acaPtcSubsidyCents, result.federalTaxCents + cashCents);
  state.needCents = totalCashflowNeedCents(result.federalTaxCents, cashCents, result.acaPtcSubsidyCents);
  // The draw this pass would commit before the line: the ordinary need, the
  // tax need and the IRMAA withheld from Social Security.
  state.creditAppliedCents =
    args.medicalExpenseCents === undefined
      ? 0
      : creditAppliedToPremiumsCents({
          creditCents: result.acaPtcSubsidyCents,
          offsetCents: state.acaOffsetCents,
          medicalCents: args.medicalExpenseCents,
          remainingNeedCents: dollarsToCents(args.ordinaryNetNeedDollars) + state.needCents + withheldCents,
        });
}

/** Assemble the public result from the final pass state. */
function buildResult(state: SolverPassState): TaxCashflowResult {
  // Shortfall: the dollars the portfolio could not supply for the last
  // grossed-up target it was asked to fund (funded vs requested). Sub-cent
  // fp residue is floored away by the whole-cent rounding.
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
 * Solve the annual tax/withdrawal feedback loop. Returns the tax cashflow
 * need + diagnostics; never throws (graceful degradation).
 *
 * The per-pass trial target =
 * `ordinaryNetNeed + (needCents + withheldCents − creditAppliedCents)`:
 * the ordinary need, the cash tax need, AND the SS-withheld IRMAA portion,
 * less the credit applied to premiums, so the federal tax on the
 * withheld-funded draw is included. The
 * initial seed is ordinary-need only (zero tax assumed on pass 1). The
 * withheld addend is a constant within-year offset, so the loop remains a
 * contraction and the `needCents`-keyed convergence test still settles.
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
    requestedTargetDollars: ordinaryNetNeedDollars,
    classification: undefined,
    result: undefined,
  };
  let prevNetCostCents = Number.NaN;
  // Trial target starts at the ordinary need only (zero tax assumed).
  let totalTargetDollars = ordinaryNetNeedDollars;

  try {
    for (state.pass = 1; state.pass <= MAX_PASSES; state.pass += 1) {
      runOnePass(args, totalTargetDollars, state);
      // Convergence test on the net cost (the quantity the loop drives): the
      // tax need less the credit applied to premiums.
      const netCostCents = state.needCents - state.creditAppliedCents;
      if (Number.isFinite(prevNetCostCents)
        && Math.abs(netCostCents - prevNetCostCents) < dollarsToCents(CONVERGENCE_DOLLARS)) {
        state.converged = true;
        break;
      }
      prevNetCostCents = netCostCents;
      // Next trial: fund the ordinary need plus the latest tax cashflow need
      // AND the IRMAA portion withheld from Social Security.
      // The runner spends GROSS SS but the withheld surcharge shrinks the
      // member's SS check, so the portfolio funds that shortfall via an extra
      // draw — which is itself taxable pre-tax income. Folding the withheld
      // cents into the trial target taxes that withheld-funded draw, so it is
      // not under-counted. The convergence guard keys on `state.needCents`
      // (withheld-free) and this stays a contraction because the withheld
      // surcharge is a CONSTANT within-year input (2-year MAGI look-back) — a
      // fixed offset, not an iterated quantity. The withheld principal is still
      // added to the committing draw exactly once in the runner
      // (`addedNeedDollars`); only the federal tax on it rises here.
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

// ---------------------------------------------------------------------------
// Fill-mode Roth-conversion solve — the OUTER monotone bisection
// that wraps the inner tax surface. Sizes the year's auto-conversion so the
// realized MAGI on the user-selected line lands AT the ceiling, never above.
// ---------------------------------------------------------------------------

/** Bisection iteration cap — ~24-32 steps reach cent resolution on a
 *  bracket up to ~$16M (2^28 > 1.6e8 cents); 40 is a safe ceiling that always
 *  terminates well before exhausting the bracket. */
const FILL_CONVERSION_MAX_ITERS = 40;
/** Bisection tolerance: stop once the bracket narrows below `$1` real. */
const FILL_CONVERSION_TOLERANCE_DOLLARS = 1;

/** Inputs to one Fill-mode conversion solve. `taxInputBase` already carries the
 *  year's COMMITTED withdrawal classification (pre/post/cash-like/Roth); the
 *  probe adds the trial conversion as ADDITIONAL ordinary income on top — never
 *  folded into `preTaxWithdrawalDollars` (which would wrongly feed the §72(t)
 *  penalty basis). */
export interface FillConversionSolveArgs {
  /** The year's tax input with committed withdrawals baked in; the conversion
   *  is layered on via `otherOrdinaryIncomeDollars` in each probe. */
  readonly taxInputBase: ApplyFilingPlanYearInput;
  readonly bundle: TaxCalibrationBundle;
  /** MAGI line the ceiling targets: `'irmaa'` uses the federal/IRMAA MAGI
   *  (taxable-SS only); `'aca'` uses the ACA MAGI (full-SS add-back). */
  readonly capMagiLine: 'irmaa' | 'aca';
  /** The user's MAGI ceiling for the year, in whole dollars (the target line). */
  readonly magiCeilingDollars: number;
  /** Gross-dollar residual cap room — the bisection's UPPER BRACKET only.
   *  The realized conversion is ≤ this and further shrunk so MAGI ≤ ceiling. */
  readonly convertibleRoomDollars: number;
}

/** Result of one Fill conversion solve. */
export interface FillConversionSolveResult {
  /** Converted dollars, rounded DOWN to whole cents so realized MAGI never
   *  exceeds the ceiling. Zero when no headroom exists. */
  readonly convertedDollars: number;
  /** Bisection iterations executed (diagnostic). */
  readonly iterations: number;
}

/** Realized MAGI (dollars) on the selected line for a probe conversion. The
 *  probe is side-effect-free — it builds a throwaway per-year input and reads
 *  the resulting MAGI; `applyTaxYearForFilingPlan` mutates nothing. Returns `+Infinity` for
 *  a year below the calibration floor (no modelable tax → treat as "over the
 *  ceiling" so the solve converges to $0 rather than converting blindly). */
function magiOnLineForConversion(
  args: FillConversionSolveArgs,
  convDollars: number,
): number {
  const { taxInputBase, bundle, capMagiLine } = args;
  const probeInput: ApplyFilingPlanYearInput = {
    ...taxInputBase,
    // Callers only ever probe conv ∈ [0, room], so no clamp is needed here.
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
    // ACA MAGI adds back the NONTAXABLE SS portion (full-SS add-back); the
    // conversion→ACA-MAGI slope is a flat 1.0. `magiCents` is the
    // federal/IRMAA MAGI (taxable-SS only); reconstruct the ACA figure.
    const taxableSsDollars = result.taxableSsCents / 100;
    const nontaxableSsDollars = Math.max(0, taxInputBase.grossSsDollars - taxableSsDollars);
    return result.magiCents / 100 + nontaxableSsDollars;
  }
  // IRMAA / federal line: the §86-tier-dependent slope (1.0/1.5/1.85) is
  // already baked into `magiCents` (the SS spillover ran inside the per-year engine).
  return result.magiCents / 100;
}

/**
 * Size the Fill-mode auto-conversion by an OUTER monotone bisection against the
 * engine's actual computed MAGI. `MAGI(conv)` is non-decreasing in `conv`
 * (each converted dollar is ordinary income), so the bisection is
 * unconditionally convergent and deterministic — robust to the §86 spillover
 * kinks where `dMAGI/dconv` jumps to 1.5/1.85.
 *
 * Finds the largest `conv ∈ [0, convertibleRoom]` with `MAGI_line(conv) ≤
 * ceiling`, rounded DOWN to whole cents so realized MAGI never exceeds the
 * ceiling ("not above it"). When even `conv = 0` already exceeds the
 * ceiling (withdrawals alone overshoot), returns $0. When the full room stays
 * under the ceiling, returns the full room. Side-effect-free; consumes no RNG.
 */
export function solveFillConversion(args: FillConversionSolveArgs): FillConversionSolveResult {
  const room = Math.max(0, args.convertibleRoomDollars);
  if (room <= 0) return { convertedDollars: 0, iterations: 0 };

  // Withdrawals-only MAGI already at/over the ceiling → no headroom to fill.
  const magiAtZero = magiOnLineForConversion(args, 0);
  if (magiAtZero >= args.magiCeilingDollars) return { convertedDollars: 0, iterations: 0 };

  // Full room still under the ceiling → convert all of it (no MAGI overshoot).
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
  // `lo` is the largest probed conversion that stayed at/under the ceiling.
  // Round DOWN to whole cents so the committed conversion never tips MAGI over.
  return { convertedDollars: Math.floor(lo * 100) / 100, iterations };
}
