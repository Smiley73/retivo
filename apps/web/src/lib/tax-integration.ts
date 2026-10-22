/**
 * Tax-integration layer — wires the five tax engines (federal-tax,
 * SS-taxation, IRMAA, ACA-PTC, RMD) into a single per-year call surface
 * consumed by the deterministic balance-projection runner and the Monte
 * Carlo engine.
 *
 * Design notes:
 *   - LTCG/QDI proxy: `assumedCostBasisFractionOfTaxableWithdrawal`.
 *   - MAGI 2-years-prior buffer is maintained by the caller; bootstrap arg.
 *   - `isRothAccount` helper.
 *   - Engagement gates per engine.
 *   - This layer never throws UnsupportedTaxYearError; it uses resolveSnapshotYear.
 *   - Call order: SS-taxation → MAGI → federal-tax + IRMAA + ACA-PTC.
 *   - Units boundary: cashflow runtime in dollars; engines in integer cents.
 *   - resolveSnapshotYear clamps to latest key + sets taxYearExtrapolated.
 *
 * See `docs/math-taxes.md` for the tax calculation in plain words.
 *
 * Types, helpers, and calibration bundle live in `./tax-integration-helpers`
 * (extracted for shape-limit compliance). All symbols are re-exported
 * from this module so consumer import paths are unchanged.
 *
 * `applyTaxYearForFilingPlan` is the PRODUCTION
 * entry point both engines call. It takes the projection year's resolved
 * tax units (`resolveFilingPlanForYear`) and applies the full per-year engine
 * ONCE PER UNIT, then sums the household totals — so a `separate` couple's two
 * returns are computed independently (own bracket table, own §86 base, own
 * IRMAA tier, own ACA eligibility) instead of collapsing onto one household
 * filing status. A single-unit year (individual / joint / survivor / a bounded
 * QSS-HoH window) short-circuits to one `applyTaxYear` call with the resolved
 * status, and an UNRESOLVED legacy-scalar conversion keeps the legacy path with
 * `taxUnits` omitted (no silent unit drop; the UI surfaces the prompt).
 */

import { computeFederalTax } from './federal-tax';
import { computeSsTaxation } from './ss-taxation';
import { computeMonthAwareIrmaa } from './irmaa';
import { computeAcaPtc, acaPtcEligibleForFilingStatus, growRoughBenchmarkCents } from './aca-ptc';
import {
  computeRmd,
  rmdDeclaredRothPortionCents,
  isQualifyingAccount,
  isInheritedRmdSubjectType,
  type RmdWithheldAccount,
  type RmdFirstYearDeferralDetail,
} from './rmd';
import type { RmdAccountInput, RmdAccountType, RmdTable } from './rmd';
import type { CalibrationSnapshot } from './calibration';
import type { FilingStatus } from './federal-tax';
import type { ResolvedTaxUnit } from './filing-status';
import {
  TaxIntegrationInvalidInputError,
  dollarsToCents,
  centsToDollars,
  resolveSnapshotYear,
  resolveFederalTaxSnapshotForYear,
  resolveAssumedTaxableYieldConfig,
  resolveAssumedYieldComponents,
  computeMagi,
  healthCoverageYearFacts,
  overrideBenchmarkCentsForCoverageMonths,
  allocateCentsByWeight,
} from './tax-integration-helpers';
import {
  computeEarlyWithdrawalPenalty,
  type PenaltyAccountInput,
} from './early-withdrawal-penalty';
import type {
  FilingUnitMagi,
  UnitIrmaaSurcharge,
  MemberIrmaaSurcharge,
  IrmaaMemberEnrollment,
  TaxCalibrationBundle,
  TaxYearInput,
  TaxYearResult,
  TaxMemberInput,
  TaxAccountSnapshot,
} from './tax-integration-helpers';

export {
  // Calibration bundle
  DEFAULT_TAX_CALIBRATION_BUNDLE,
  // Error types
  TaxIntegrationInvalidInputError,
  friendlyProjectionErrorMessage,
  // Unit helpers
  dollarsToCents,
  centsToDollars,
  // Snapshot resolution
  resolveSnapshotYear,
  buildScaledFederalTaxConfig,
  // Roth helper
  isRothAccount,
  // MAGI
  computeMagi,
  // Assumed taxable-yield resolution + explicit tax-character split
  resolveAssumedTaxableYieldConfig,
  resolveAssumedYieldComponents,
  // Per-return IRMAA look-back reconstruction + exact cent allocation
  allocateCentsByWeight,
  bootstrapLookbackRing,
} from './tax-integration-helpers';

export type {
  TaxCalibrationBundle,
  TaxMemberInput,
  TaxAccountSnapshot,
  PenaltyAccountSnapshot,
  TaxYearInput,
  TaxYearResult,
  FilingUnitMagi,
  BootstrapLookbackUnit,
} from './tax-integration-helpers';

// ---------------------------------------------------------------------------
// Core per-year computation
// ---------------------------------------------------------------------------

/**
 * Split the year's already-inflation-scaled household IRMAA
 * surcharge back onto the individual beneficiaries who owe it.
 *
 * Without month-aware IRMAA every beneficiary on one return would owe the SAME
 * amount, and the cashflow solver could re-divide the household total evenly.
 * With Part B and Part D prorated by each member's own enrolment months a
 * spouse enrolled for 3 months owes a quarter of what a full-year spouse owes,
 * and withholding half of the household total from each spouse's Social
 * Security check is simply wrong. Weights are the UNSCALED per-beneficiary
 * charges and the split runs through `allocateCentsByWeight`, so the parts sum
 * back to the scaled household total to the cent.
 */
function allocateMemberIrmaaSurcharges(
  beneficiaries: readonly IrmaaMemberEnrollment[],
  irmaaResult: {
    readonly partBAnnualCentsPerBeneficiary: number;
    readonly partDAnnualCentsPerBeneficiary: number;
  },
  scaledHouseholdCents: number,
): readonly MemberIrmaaSurcharge[] | undefined {
  if (beneficiaries.length === 0) return undefined;
  const weights = beneficiaries.map(
    (b) =>
      Math.round((irmaaResult.partBAnnualCentsPerBeneficiary * b.partBMonths) / 12) +
      Math.round((irmaaResult.partDAnnualCentsPerBeneficiary * b.partDMonths) / 12),
  );
  const shares = allocateCentsByWeight(scaledHouseholdCents, weights);
  return beneficiaries.map((b, i) => ({ memberId: b.memberId, surchargeCents: shares[i] }));
}

/**
 * `TaxYearInput` plus the three filing-plan facts. Every field is
 * optional, so a caller that omits them keeps type-checking and its output is
 * the single-status result (an absent field reproduces the legacy behaviour exactly).
 *
 * These live here rather than on `TaxYearInput` because they are meaningful
 * only to the filing-plan orchestration this module owns.
 */
export interface FilingPlanTaxYearInput extends TaxYearInput {
  /**
   * §86(c)(1)(C)(ii) — whether an `MFS` filer lived with their spouse at any
   * time during the tax year. When true the §86 base amounts are both $0, so
   * SS benefits are taxable from the first dollar. Only meaningful when
   * `filingStatus === 'MFS'`; absent → lived apart.
   */
  readonly mfsLivedWithSpouse?: boolean;
  /**
   * The filing status of the return IRMAA's two-year look-back actually
   * reads. IRMAA is tiered on the LOOK-BACK return, so a couple that filed
   * `MFJ` two years ago keeps the joint tier schedule in the surviving
   * spouse's first `Single` year. Absent → the current year's `filingStatus`
   * (the legacy behaviour).
   */
  readonly irmaaLookbackFilingStatus?: FilingStatus;
  /** Whether the look-back `MFS` return lived with the spouse that year —
   *  selects the steeper `byMfs` IRMAA schedule. Absent → lived apart. */
  readonly irmaaLookbackMfsLivedWithSpouse?: boolean;
}

/** The share of a taxable-account withdrawal that is basis, not income, when the
 *  caller states none. */
export const DEFAULT_ASSUMED_COST_BASIS_FRACTION = 0.5;

/**
 * Apply all five tax engines to a single projection year.
 *
 * Call order:
 *   1. SS-taxation → taxableSsCents (output feeds MAGI composition)
 *   2. MAGI composition
 *   3. Federal-tax + IRMAA + ACA-PTC (independent of each other, share MAGI)
 *   4. RMD (independent pre-pass — called here but enforcement is in the
 *      drawdown engine; result informs rmdFloorCents on DrawdownYear)
 *
 * This function never throws UnsupportedTaxYearError — it clamps the upper
 * bound via resolveSnapshotYear. A taxYear below the minimum snapshot key
 * still throws from the engine. All other validation errors propagate as-is.
 */
export function applyTaxYear(
  input: FilingPlanTaxYearInput,
  bundle: TaxCalibrationBundle,
): TaxYearResult {
  const {
    taxYear,
    filingStatus,
    grossSsDollars,
    preTaxWithdrawalDollars,
    postTaxNonRothWithdrawalDollars,
    postTaxCashLikeWithdrawalDollars = 0,
    // rothWithdrawalDollars intentionally omitted from the income/MAGI sums —
    // Roth withdrawals carry no ordinary income tax in this function. The taxable
    // earnings and the 10% early-withdrawal penalty are worked out upstream by
    // the owner-level Roth basis tracker (`balance-projection-runner-roth-basis.ts`
    // for the deterministic projection), which routes the earnings in as ordinary
    // income and feeds the penalty branch. There, a Roth IRA (one pool per owner)
    // orders each draw contributions first, then conversion lots oldest year
    // first (each lot on its own five-tax-year clock), then earnings; the pool's
    // five-tax-year clock and age 59½ decide whether the draw is qualified.
    // Designated-Roth employer-plan accounts (Roth 401(k)/403(b)/457(b)/TSP and
    // the Roth-designated part of a MIXED account) are not ordered that way: each
    // has its own clock, and a nonqualified draw splits pro rata between basis
    // and earnings. Monte Carlo is coarser (`McRothOrderedProfile` in
    // `monte-carlo-tax.ts`): it pools every owner's Roth IRA into one bucket
    // using the latest owner's clock and requiring every owner to be 59½, and
    // pools all designated-Roth accounts into one pro-rata slice using the latest
    // first-participation year. See docs/math-retirement-accounts.md,
    // "Roth withdrawal rules".
    otherOrdinaryIncomeDollars,
    taxExemptInterestDollars,
    cashInterestDollars = 0,
    qcdIncomeExclusionDollars = 0,
    assumedCostBasisFraction = DEFAULT_ASSUMED_COST_BASIS_FRACTION,
    brokerageLikeStartBalanceDollars = 0,
    householdSize,
    members,
    accounts,
    magiTwoYearsPriorDollars,
    acaBenchmarkSlcspDollars,
    taxpayersAge65Plus,
    inflationRatePct,
    hsaQualifiedMedicalExpensePct = 100,
    earlyWithdrawalPenaltyExemptAccountIds = [],
    penaltyAccounts = [],
  } = input;

  // --- Input validation ---
  const dollarFields: Array<[string, number]> = [
    ['grossSsDollars', input.grossSsDollars],
    ['preTaxWithdrawalDollars', input.preTaxWithdrawalDollars],
    ['postTaxNonRothWithdrawalDollars', input.postTaxNonRothWithdrawalDollars],
    ['postTaxCashLikeWithdrawalDollars', postTaxCashLikeWithdrawalDollars],
    ['rothWithdrawalDollars', input.rothWithdrawalDollars],
    ['otherOrdinaryIncomeDollars', input.otherOrdinaryIncomeDollars],
    ['taxExemptInterestDollars', input.taxExemptInterestDollars],
    ['cashInterestDollars', cashInterestDollars],
    ['qcdIncomeExclusionDollars', qcdIncomeExclusionDollars],
  ];
  for (const [field, value] of dollarFields) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TaxIntegrationInvalidInputError(
        `${field} must be a finite non-negative number; got ${value}`,
      );
    }
  }
  if (!Number.isInteger(householdSize) || householdSize < 1) {
    throw new TaxIntegrationInvalidInputError(
      `householdSize must be a positive integer; got ${householdSize}`,
    );
  }
  // assumedCostBasisFraction must be a finite fraction in [0, 1]:
  // ltcgDollars = postTaxNonRothWithdrawalDollars × (1 − fraction); a value
  // outside [0, 1] produces negative or over-stated LTCG and silently wrong
  // federal tax + MAGI downstream.
  if (
    assumedCostBasisFraction !== undefined &&
    (!Number.isFinite(assumedCostBasisFraction) ||
      assumedCostBasisFraction < 0 ||
      assumedCostBasisFraction > 1)
  ) {
    throw new TaxIntegrationInvalidInputError(
      `assumedCostBasisFraction must be a finite number in [0, 1]; got ${assumedCostBasisFraction}`,
    );
  }

  // --- QCD income exclusion ---
  // The Qualified Charitable Distribution is part of the pre-tax IRA
  // distribution but excluded from ordinary income / MAGI. Subtract it from the
  // pre-tax withdrawal income that feeds §86 provisional income, the federal/
  // IRMAA MAGI, and the ACA-PTC MAGI (all derived below). Clamp at the pre-tax
  // total — a QCD is part of, never on top of, the distribution. Every
  // downstream income/MAGI sum reads `taxablePreTaxWithdrawalDollars` instead of
  // the gross `preTaxWithdrawalDollars` so BOTH MAGI lines + the IRMAA Y+2 ring
  // drop by the QCD (the IRMAA look-back ring advances `magiCents`, computed from
  // the reduced base).
  const taxablePreTaxWithdrawalDollars = Math.max(
    0,
    preTaxWithdrawalDollars - Math.max(0, qcdIncomeExclusionDollars),
  );

  // --- HSA nonqualified income ---
  // An HSA withdrawal splits into two buckets fed by the drawdown routing:
  //   - MEDICAL-qualified dollars (`hsaMedicalQualifiedDollars`): funded against
  //     modeled `isMedical` demand → 100% qualified/tax-free. $0 income, no
  //     penalty (excluded from both sums below).
  //   - EMERGENCY/nonmedical dollars (the residual): governed by
  //     `hsaQualifiedMedicalExpensePct` — that share is treated as qualified
  //     receipts, the rest is ordinary income + the 20% additional tax pre-65.
  // The percentage scopes ONLY the emergency residual, not the
  // medical-qualified dollars. Clamp to
  // [0, 100] defensively (the UI clamps, but engine callers vary).
  const hsaQualifiedFraction = Math.min(100, Math.max(0, hsaQualifiedMedicalExpensePct)) / 100;
  // Derive the emergency residual in INTEGER CENTS when the snapshot
  // carries the committed cents, so medical + emergency reconcile EXACTLY to
  // the committed HSA withdrawal cents (the emergency slice is the residual,
  // never independently rounded). Fall back to the dollar fields for legacy
  // callers that did not surface the cent split.
  const hsaEmergencyDollars = (acc: {
    hsaWithdrawalDollars: number;
    hsaMedicalQualifiedDollars?: number;
    hsaWithdrawalCents?: number;
    hsaMedicalQualifiedCents?: number;
  }): number => {
    if (acc.hsaWithdrawalCents !== undefined) {
      const totalCents = Math.max(0, acc.hsaWithdrawalCents);
      const medicalCents = Math.max(0, acc.hsaMedicalQualifiedCents ?? 0);
      return Math.max(0, totalCents - medicalCents) / 100;
    }
    const total = Math.max(0, acc.hsaWithdrawalDollars);
    const medical = Math.max(0, acc.hsaMedicalQualifiedDollars ?? 0);
    return Math.max(0, total - medical);
  };
  const hsaNonqualifiedDollars = penaltyAccounts.reduce((sum, acc) => {
    if (acc.type !== 'HSA') return sum;
    return sum + hsaEmergencyDollars(acc) * (1 - hsaQualifiedFraction);
  }, 0);
  // --- Assumed taxable-account yield drag ---
  // Brokerage-like POST_TAX balances throw off taxable investment income every
  // year even with no withdrawal, split into three EXPLICIT tax-character
  // streams: qualified dividends (LTCG/QDI rates), ordinary interest /
  // non-qualified dividends (ordinary rates AND the NIIT base), and tax-exempt
  // municipal interest ($0 federal tax; §36B/IRMAA MAGI add-back only — never
  // inferred from a bond allocation, explicit calibration only). The yield is
  // assumed reinvested, so it does NOT reduce the balance; the reinvested
  // dollars are added to cost basis by the runner (so the yield is never counted
  // twice). Cash-like / pre-tax / Roth balances are excluded by the caller
  // (it passes only the brokerage-like start balance).
  const assumedYield = resolveAssumedTaxableYieldConfig(bundle.assumedTaxableYield, taxYear);
  const yieldBase = Math.max(0, brokerageLikeStartBalanceDollars);
  const totalAssumedYieldDollars = yieldBase * Math.max(0, assumedYield.totalYieldPct);
  const yieldComponents = resolveAssumedYieldComponents(assumedYield);
  const assumedYieldQdiDollars = totalAssumedYieldDollars * yieldComponents.qdiFraction;
  const assumedYieldTaxExemptDollars =
    totalAssumedYieldDollars * yieldComponents.taxExemptFraction;
  const assumedYieldOrdinaryInterestDollars =
    totalAssumedYieldDollars * yieldComponents.ordinaryFraction;
  // Total tax-exempt interest = the caller-supplied muni interest (unused
  // by the runners today) + the assumed yield's explicit tax-exempt stream.
  // Feeds §86 provisional income and both MAGIs as the §36B add-back, but is
  // NOT federal taxable income and NOT §1411 NII.
  const totalTaxExemptInterestDollars = taxExemptInterestDollars + assumedYieldTaxExemptDollars;

  // Fold HSA nonqualified income + the ordinary-interest yield stream + the
  // annual cash-like interest (savings/money-market/CD growth taxed the
  // year it accrues; HSA growth stays tax-free) into the year's other ordinary
  // income so all flow through §86 / MAGI / federal tax exactly like a pension
  // distribution.
  const ordinaryIncomeWithHsa =
    otherOrdinaryIncomeDollars +
    hsaNonqualifiedDollars +
    assumedYieldOrdinaryInterestDollars +
    cashInterestDollars;

  // --- Snapshot year resolution ---
  // For years beyond the latest published federal table, build a
  // synthesized inflation-scaled TaxConfig (ordinary-bracket floors, standard
  // deductions, age-65 add-ons, LTCG floors × the same thresholdScalingFactor
  // IRMAA uses; NIIT frozen) so future-year federal estimates don't reuse the
  // frozen latest-year thresholds. Mirrors IRMAA/ACA extrapolation.
  const {
    lookupYear: federalLookupYear,
    snapshot: federalSnapshot,
    taxYearExtrapolated,
  } = resolveFederalTaxSnapshotForYear(bundle.federalTax, taxYear, inflationRatePct);

  // --- Step 1: SS-taxation (must run before MAGI composition) ---
  // LTCG proxy computed first: §86 provisional income includes LTCG/QDI
  // (per IRS Pub 590-A; capital gains count toward provisional income).
  // Only BROKERAGE / OTHER POST_TAX withdrawals feed the proxy.
  // postTaxCashLikeWithdrawalDollars (cash / CD / HSA principal) is EXCLUDED
  // from both the LTCG proxy below and the MAGI composition (Step 2) — those
  // dollars are return of already-taxed principal ($0 taxable income, $0 MAGI).
  // LTCG/QDI = withdrawal-time capital gains (evolving cost-basis proxy)
  // + the qualified-dividend stream from the annual yield drag. Both are
  // taxed at preferential LTCG/QDI rates and both feed §86 provisional income.
  const ltcgDollars =
    postTaxNonRothWithdrawalDollars * (1 - assumedCostBasisFraction) + assumedYieldQdiDollars;
  // otherAGI = pre-tax withdrawals + LTCG + other ordinary income
  // (taxable SS excluded — not yet known; that's what §86 computes)
  const otherAgiForSsCents = dollarsToCents(
    taxablePreTaxWithdrawalDollars + ltcgDollars + ordinaryIncomeWithHsa,
  );
  const grossSsCents = dollarsToCents(grossSsDollars);
  // §86 provisional income includes tax-exempt interest — caller-supplied
  // plus the assumed yield's explicit municipal stream.
  const taxExemptInterestCents = dollarsToCents(totalTaxExemptInterestDollars);

  const ssResult = computeSsTaxation(
    {
      grossSsCents,
      otherAgiCents: otherAgiForSsCents,
      taxExemptInterestCents,
      filingStatus,
      taxYear,
      // §86(c)(1)(C)(ii) zero base for an MFS filer who lived with their
      // spouse. Inert for every other status and for callers that omit it.
      mfsLivedWithSpouse: input.mfsLivedWithSpouse ?? false,
    },
    bundle.ssTax,
  );

  // --- Step 2: MAGI composition ---
  // Two MAGI definitions diverge by law:
  //   - Federal / IRMAA MAGI: AGI add-backs, includes only the TAXABLE portion
  //     of Social Security (§86).
  //   - ACA PTC MAGI (§36B / IRC §36B(d)(2)(B)): AGI plus the ENTIRE Social
  //     Security benefit — including the nontaxable portion. For SS recipients
  //     this raises MAGI above the federal/IRMAA figure, which can change PTC
  //     eligibility. The unified figure understated ACA MAGI.
  const taxableSsDollars = centsToDollars(ssResult.taxableSsCents);
  const magiDollars = computeMagi({
    ordinaryIncomeDollars: taxablePreTaxWithdrawalDollars + ordinaryIncomeWithHsa + taxableSsDollars,
    ltcgDollars,
    // The §36B add-back includes the assumed yield's tax-exempt stream.
    taxExemptInterestDollars: totalTaxExemptInterestDollars,
  });
  const magiCents = dollarsToCents(magiDollars);
  // ACA MAGI adds back the nontaxable SS portion (gross − taxable).
  const nontaxableSsDollars = Math.max(0, grossSsDollars - taxableSsDollars);
  const acaMagiCents = dollarsToCents(magiDollars + nontaxableSsDollars);

  // --- Step 3a: Federal income tax ---
  // CRITICAL: federal-tax takes ordinaryIncome and ltcgAndQdi in DOLLARS (not cents)
  const ordinaryIncomeDollars = taxablePreTaxWithdrawalDollars + ordinaryIncomeWithHsa + taxableSsDollars;
  // NIIT base: net investment income = the LTCG/QDI stream (withdrawal
  // gains + qualified-dividend yield) PLUS the ordinary-interest yield stream
  // PLUS the annual cash-like interest (interest / non-qualified dividends are
  // net investment income too, §1411(c)). Tax-exempt municipal interest is NOT
  // NII. This replaces the engine's `ltcgAndQdi`-only default, which
  // under-stated NII.
  const netInvestmentIncomeDollars =
    ltcgDollars + assumedYieldOrdinaryInterestDollars + cashInterestDollars;
  const federalResult = computeFederalTax(
    {
      year: federalLookupYear,
      filingStatus,
      ordinaryIncome: ordinaryIncomeDollars,
      ltcgAndQdi: ltcgDollars,
      netInvestmentIncome: netInvestmentIncomeDollars,
      // The senior-deduction phase-out reads MAGI BEFORE the deduction (it
      // lowers taxable income, not MAGI). Pass the integration layer's MAGI so
      // the phase-out base is correct (the engine's own income sum omits taxable
      // SS / tax-exempt interest add-backs).
      // The statutory OBBBA senior-deduction MAGI is AGI plus §911/931/933
      // foreign/territory exclusions only — it does NOT add back tax-exempt
      // (muni) interest the way Medicare/IRMAA MAGI does. Now that tax-exempt
      // interest can be non-zero (the assumed yield's explicit municipal
      // stream), the senior-deduction base excludes the tax-exempt add-back.
      magiForSeniorDeduction: Math.max(0, magiDollars - totalTaxExemptInterestDollars),
      taxpayersAge65Plus,
    },
    federalSnapshot,
  );

  // --- Step 3b: IRMAA ---
  let irmaaSurchargeCents = 0;
  let irmaaTier: TaxYearResult['irmaaTier'] = 'none';
  let irmaaSurchargeCentsByMember: readonly MemberIrmaaSurcharge[] | undefined;

  // Every household health fact this year needs, resolved (and memoized)
  // ONCE for the year's member set: the Medicare engagement gate, the
  // per-beneficiary enrolment months, the household Marketplace coverage months
  // and the rough benchmark. All are seed-independent, so Monte Carlo pays for
  // them once per run-year rather than once per PATH-year.
  const healthFacts = healthCoverageYearFacts(members, taxYear);

  if (healthFacts.anyMedicareMonths && magiTwoYearsPriorDollars !== undefined) {
    const { effectiveYear: irmaaYear, thresholdScalingFactor: irmaaScaling } =
      resolveSnapshotYear(bundle.irmaa, taxYear, inflationRatePct);
    // Deflate look-back MAGI by the inflation scaling factor so it compares
    // correctly against the clamped (older) thresholds. Mathematically
    // equivalent to inflating the stored thresholds forward.
    const adjustedMagiTwoYearsPrior = magiTwoYearsPriorDollars / irmaaScaling;
    // Tier on the LOOK-BACK return's filing status when the caller knows
    // it (the filing plan buffers it alongside the look-back MAGI). Absent →
    // the current year's status, the legacy behaviour. The MFS lived-together
    // fact travels with whichever status is used, so a look-back MFS return is
    // never scored against the current year's living arrangement.
    const lookbackFilingStatus = input.irmaaLookbackFilingStatus ?? filingStatus;
    const lookbackMfsLivedWithSpouse =
      input.irmaaLookbackFilingStatus === undefined
        ? (input.mfsLivedWithSpouse ?? false)
        : (input.irmaaLookbackMfsLivedWithSpouse ?? false);
    // Part B and Part D are prorated SEPARATELY by each
    // beneficiary's own enrolment months. A member with no stored months
    // resolves to 12/12 (or 0/0), so a scenario without monthly facts produces
    // the same total as a whole-year `computeIrmaa` call.
    const irmaaResult = computeMonthAwareIrmaa(
      {
        taxYear: irmaaYear,
        lookback: {
          magiCents: dollarsToCents(adjustedMagiTwoYearsPrior),
          filingStatus: lookbackFilingStatus,
          mfsLivedWithSpouse: lookbackMfsLivedWithSpouse,
        },
        beneficiaries: healthFacts.irmaaBeneficiaries,
      },
      bundle.irmaa,
    );
    // Re-inflate the OUTPUT surcharge cents to projection-year
    // dollars. The MAGI look-back was deflated above for tier classification
    // against the clamped (older) thresholds, but the surcharge DOLLARS that
    // `computeIrmaa` returns are frozen at the clamped snapshot year, so they
    // would otherwise stay ~35% low by 2036 @3%. Scaling the total here keeps
    // the tier classification untouched (no double-deflation) and mirrors the
    // federal-tax re-inflation pattern. The per-beneficiary surcharge
    // cents are part of the returned total; we scale the household total the
    // runner consumes.
    irmaaSurchargeCents = Math.round(
      irmaaResult.totalHouseholdAnnualCents * irmaaScaling,
    );
    irmaaTier = irmaaResult.tier;
    // Keep each beneficiary's OWN scaled surcharge. Once Part B
    // and Part D are prorated by each member's own months, two beneficiaries on
    // one return no longer owe equal amounts, so the cashflow solver can no
    // longer re-divide the household total evenly when it withholds from each
    // spouse's Social Security. The per-member cents are allocated out of the
    // already-scaled household total by each member's unscaled share, so they
    // sum back to `irmaaSurchargeCents` exactly.
    irmaaSurchargeCentsByMember = allocateMemberIrmaaSurcharges(
      healthFacts.irmaaBeneficiaries,
      irmaaResult,
      irmaaSurchargeCents,
    );
  }

  // --- Step 3c: ACA PTC ---
  let acaPtcSubsidyCents = 0;
  let acaPtcTier: TaxYearResult['acaPtcTier'] = 'below-fpl';
  let fplPercentage = 0;
  let acaMagiAboveFplCents = 0;

  // An `MFS` return is statutorily ineligible for the PTC (§36B(c)(1)(C))
  // and `computeAcaPtc` throws rather than silently crediting one, so the gate
  // must reject MFS BEFORE the engine call. Inert for every other status.
  if (healthFacts.marketplaceCoverageMonths > 0 && acaPtcEligibleForFilingStatus(filingStatus)) {
    const { effectiveYear: acaYear, thresholdScalingFactor: acaScaling } =
      resolveSnapshotYear(bundle.acaPtc, taxYear, inflationRatePct);
    let benchmarkSlcspCents: number;
    if (acaBenchmarkSlcspDollars !== undefined) {
      // A per-year user override replaces the rough age-priced
      // fallback entirely. The editor collects a WHOLE-YEAR price
      // ("Benchmark plan cost for the year"), so it is prorated to the
      // household's coverage months before it reaches the engine — the same
      // month range the expected contribution below is prorated by. Without
      // that, a part-year household would get `12 × B − m × C` instead of the
      // statutory `m × (B − C)`.
      benchmarkSlcspCents = overrideBenchmarkCentsForCoverageMonths(
        acaBenchmarkSlcspDollars,
        healthFacts.marketplaceCoverageMonths,
      );
    } else {
      // The rough fallback is the SUM over covered members of each
      // member's own age-priced monthly premium × their covered months, not the
      // oldest member's annual premium × the covered-member count.
      benchmarkSlcspCents = growRoughBenchmarkCents(
        dollarsToCents(healthFacts.defaultBenchmarkAnnualDollars),
        taxYear,
        input.medicalInflationRatePct,
      );
    }
    // Deflate MAGI by the inflation factor so the FPL% comparison uses an
    // inflation-consistent poverty line (equivalent to inflating the clamped
    // FPL bands forward). Mirrors IRMAA's MAGI-deflation approach.
    // ACA uses the ACA-specific MAGI (includes nontaxable SS), NOT the
    // federal/IRMAA MAGI.
    const acaMagiDeflatedCents = Math.round(acaMagiCents / acaScaling);
    const acaResult = computeAcaPtc(
      {
        taxYear: acaYear,
        filingStatus,
        householdSize,
        magiCents: acaMagiDeflatedCents,
        benchmarkAnnualSlcspCents: benchmarkSlcspCents,
        // Alaska / Hawaii use their own (higher) HHS poverty
        // guidelines. Absent → `'contiguous'`, the unchanged 48-state schedule.
        ...(input.acaFplRegion !== undefined ? { fplRegion: input.acaFplRegion } : {}),
        // Re-inflate the expected-contribution OUTPUT back to projection-year
        // dollars (the MAGI input was deflated above for tier classification
        // only). The benchmark is not scaled here: the rough fallback was grown
        // above and an override is used as entered.
        expectedContributionScalingFactor: acaScaling,
        // §36B(b)(2) sums the credit over COVERAGE MONTHS. The benchmark
        // above is already summed over covered member-months, so the expected
        // contribution must be prorated by the same range or a part-year
        // household is charged a full year's contribution against a part-year
        // benchmark (which usually floors the credit to $0).
        coverageMonths: healthFacts.marketplaceCoverageMonths,
      },
      bundle.acaPtc,
    );
    acaPtcSubsidyCents = acaResult.annualPtcCents;
    acaPtcTier = acaResult.tier;
    fplPercentage = acaResult.fplPercentage;
    // Headroom above the poverty line, re-inflated to projection-year dollars;
    // floored so a draw lowered by it stays at or above the line.
    if (fplPercentage >= 100) {
      acaMagiAboveFplCents = Math.max(
        0,
        Math.floor((acaMagiDeflatedCents - Math.ceil(acaResult.fplDollars * 100)) * acaScaling),
      );
    }
  }

  // --- Step 4: RMD (independent pre-pass) ---
  const memberRmd = computeMemberRmds(members, accounts, taxYear, bundle.rmd);
  const { rmdFloorCents, rmdApplicable, rmdPerAccountCents } = memberRmd;

  // --- Step 5: Early-withdrawal / HSA additional tax ---
  // Map each account's owner to its birthdate so the penalty engine can resolve
  // the exact 59½ / 65 cutoff. Penalty basis: pre-tax tranche for IRA/401k-style
  // accounts; nonqualified portion for HSAs (the engine multiplies the HSA basis
  // by the 20% rate directly).
  const birthdateByMember = new Map(members.map((m) => [m.memberId, m.isoBirthdate]));
  const penaltyAccountInputs: PenaltyAccountInput[] = penaltyAccounts.map((acc) => {
    const ownerBirthdate = birthdateByMember.get(acc.ownerId);
    if (acc.type === 'HSA') {
      // The 20% additional tax applies ONLY to the nonqualified slice of the
      // EMERGENCY portion. Medical-qualified dollars carry $0 penalty.
      return {
        id: acc.id,
        type: acc.type,
        penaltyBasisDollars: hsaEmergencyDollars(acc) * (1 - hsaQualifiedFraction),
        ownerBirthdate,
      };
    }
    return {
      id: acc.id,
      type: acc.type,
      penaltyBasisDollars: acc.penaltyPreTaxWithdrawalDollars,
      ownerBirthdate,
      // Forward the "already source-exemption-resolved §408A/§402A base"
      // marker so the penalty engine does not re-test the account type and drop a
      // governmental-457(b) in-plan-rollover recapture.
      ...(acc.rothOrderedAdditionalTaxBase === true
        ? { rothOrderedAdditionalTaxBase: true }
        : {}),
      // §72(t)(2)(A)(ii): a post-death inherited distribution carries no
      // 10% additional tax at any beneficiary age.
      ...(acc.inheritedFromDeceasedOwner === true
        ? { inheritedFromDeceasedOwner: true }
        : {}),
    };
  });
  const penalty = computeEarlyWithdrawalPenalty(
    penaltyAccountInputs,
    taxYear,
    earlyWithdrawalPenaltyExemptAccountIds,
  );
  const earlyWithdrawalPenaltyCents = dollarsToCents(penalty.ira401kPenaltyDollars);
  const hsaAdditionalTaxCents = dollarsToCents(penalty.hsaAdditionalTaxDollars);

  // --- Final assembly ---
  // The early-withdrawal / HSA additional taxes are part of the federal tax
  // liability (Form 5329 / Schedule 2), so they are folded into
  // `federalTaxCents` — this routes them through the cashflow solver and the
  // year-row annotation automatically. They are also surfaced separately for
  // display.
  const federalTaxWithPenaltyCents =
    federalResult.totalTax + earlyWithdrawalPenaltyCents + hsaAdditionalTaxCents;
  // One shared denominator formula (see
  // `grossIncomeForEffectiveRateDollars`), so the single-return and merged
  // separate-return displayed rates cannot drift apart.
  const grossIncomeDollars = grossIncomeForEffectiveRateDollars(input);
  const effectiveTaxRate =
    grossIncomeDollars > 0 ? centsToDollars(federalTaxWithPenaltyCents) / grossIncomeDollars : 0;

  return {
    federalTaxCents: federalTaxWithPenaltyCents,
    taxableSsCents: ssResult.taxableSsCents,
    ssTaxationTier: ssResult.tier,
    rmdFloorCents,
    rmdApplicable,
    rmdPerAccountCents,
    // The fact-based RMD disclosures (withheld accounts, still-working
    // deferrals, first-year April-1 deferrals and their catch-up) ride the year
    // result so the report + estimate notes can list them. Each is OMITTED when
    // no account carries RMD facts, keeping the legacy result shape unchanged.
    ...(memberRmd.rmdWithheldAccounts !== undefined
      ? { rmdWithheldAccounts: memberRmd.rmdWithheldAccounts }
      : {}),
    ...(memberRmd.rmdStillWorkingDeferredAccountIds !== undefined
      ? { rmdStillWorkingDeferredAccountIds: memberRmd.rmdStillWorkingDeferredAccountIds }
      : {}),
    ...(memberRmd.rmdFirstYearDeferrals !== undefined
      ? { rmdFirstYearDeferrals: memberRmd.rmdFirstYearDeferrals }
      : {}),
    ...(memberRmd.rmdDeferredCatchUpCents !== undefined
      ? { rmdDeferredCatchUpCents: memberRmd.rmdDeferredCatchUpCents }
      : {}),
    irmaaSurchargeCents,
    ...(irmaaSurchargeCentsByMember !== undefined ? { irmaaSurchargeCentsByMember } : {}),
    irmaaTier,
    acaPtcSubsidyCents,
    acaPtcTier,
    fplPercentage,
    acaMagiAboveFplCents,
    magiCents,
    effectiveTaxRate,
    taxYearExtrapolated,
    earlyWithdrawalPenaltyCents,
    hsaAdditionalTaxCents,
    penaltySkippedForMissingBirthdate: penalty.skippedForMissingBirthdate,
  };
}

// ---------------------------------------------------------------------------
// RMD seam (extracted from applyTaxYear for Monte Carlo reuse and shape)
// ---------------------------------------------------------------------------

/** Total RMD floor (cents) + per-account RMD (cents) for one projection year. */
interface MemberRmdResult {
  readonly rmdFloorCents: number;
  /** True when ≥ 1 owner reached their SECURE 2.0 trigger age this tax year
   *  (so the per-account map is applicable — possibly `{}` at a $0 floor —
   *  rather than absent below trigger age). */
  readonly rmdApplicable: boolean;
  readonly rmdPerAccountCents: Record<string, number>;
  /** See the matching `TaxYearResult` fields. Absent (not `[]`) when no
   *  account in the year carried RMD facts, so the legacy shape is preserved. */
  readonly rmdWithheldAccounts?: readonly RmdWithheldAccount[];
  readonly rmdStillWorkingDeferredAccountIds?: readonly string[];
  readonly rmdFirstYearDeferrals?: readonly RmdFirstYearDeferralDetail[];
  readonly rmdDeferredCatchUpCents?: number;
}

/**
 * Compute the household's Required Minimum Distribution (RMD) for one
 * projection year: the total RMD floor (cents) and the per-account RMD map
 * (cents). Runs the member loop exactly once — `applyTaxYear` consumes both
 * fields, and `computeRmdFloorCents` is the thin `.rmdFloorCents` wrapper the
 * Monte Carlo engine reuses (so the engine and MC share one floor derivation).
 *
 * Accounts are scoped to each member's `ownerId` to avoid double-counting RMD
 * obligations across spouses; an account with a Roth-designated pocket (MIXED, or
 * a pure Roth account) passes that pocket as `rothPortionCents` (SECURE 2.0 §325)
 * so the RMD basis is the pre-tax portion only.
 *
 * @param members      Per-member info (birthdate drives the SECURE 2.0 trigger age).
 * @param accounts     Per-account prior-year balances + ownership for the year.
 * @param taxYear      Calendar year the RMD is computed for.
 * @param rmdSnapshot  RMD divisor table (Uniform Lifetime), from `bundle.rmd`.
 * @returns            `{ rmdFloorCents, rmdPerAccountCents }`.
 * @throws Surfaces the RMD engine's `UnsupportedTaxYearError` / validation
 *         throws to the caller (no swallowing — same contract as `applyTaxYear`).
 */
function computeMemberRmds(
  members: readonly TaxMemberInput[],
  accounts: readonly TaxAccountSnapshot[],
  taxYear: number,
  rmdSnapshot: CalibrationSnapshot<RmdTable>,
): MemberRmdResult {
  let rmdFloorCents = 0;
  let rmdApplicable = false;
  const rmdPerAccountCents: Record<string, number> = {};
  // The fact-based disclosures, accumulated across owners. `anyFacts`
  // decides whether they are REPORTED at all, so a fact-free household keeps the
  // legacy result shape exactly.
  const anyFacts = accounts.some((acc) => acc.rmdFacts !== undefined);
  const withheldAccounts: RmdWithheldAccount[] = [];
  const stillWorkingDeferredAccountIds: string[] = [];
  const firstYearDeferrals: RmdFirstYearDeferralDetail[] = [];
  let deferredCatchUpCents = 0;

  for (const member of members) {
    // Scope accounts to this member's ownerId to avoid double-counting
    // RMD obligations across spouses in married households.
    //
    // An INHERITED account is admitted even when the living-owner test
    // rejects its type (an inherited Roth IRA owes beneficiary distributions),
    // because `resolveRmdRule` inside the engine owns that decision now. The
    // caller-side filter therefore only has to keep NON-RMD-subject types out.
    const memberAccounts: RmdAccountInput[] = accounts
      .filter((acc) => {
        if (acc.ownerId !== member.memberId) return false;
        if (acc.rmdFacts?.inheritedAccount === true) {
          return isInheritedRmdSubjectType(acc.type as RmdAccountType);
        }
        return isQualifyingAccount(acc.type as RmdAccountType, acc.taxTreatment);
      })
      .map((acc) => {
        const base: RmdAccountInput = {
          id: acc.id,
          balanceDec31PriorYearCents: dollarsToCents(acc.balancePriorYearDollars),
          // Safe: the filter above proves the type is an RmdAccountType.
          accountType: acc.type as RmdAccountType,
          taxTreatment: acc.taxTreatment,
          ...(acc.rmdFacts !== undefined ? { facts: acc.rmdFacts } : {}),
          ...(acc.balanceTwoYearsPriorDollars !== undefined
            ? {
                balanceDec31TwoYearsPriorCents: dollarsToCents(
                  acc.balanceTwoYearsPriorDollars,
                ),
              }
            : {}),
        };
        // An account WITH a Roth-designated pocket declares that pocket as
        // `rothPortionCents` so the RMD engine subtracts it per SECURE 2.0 §325 —
        // a MIXED plan's designated-Roth sub-account, or the whole balance of a
        // pure Roth account (POST_TAX / ROTH), which is how an INHERITED Roth
        // account stops being treated as a pre-tax base.
        // PRE_TAX / HSA accounts have no Roth portion to subtract. The
        // declaration goes through the engine's own shared
        // `rmdDeclaredRothPortionCents` so this producer and the two MC producers
        // cannot land on different bases for the same account. The
        // two-years-prior catch-up base carries the SAME §325 pair so both bases
        // net identically.
        const rothPortionCents = rmdDeclaredRothPortionCents(
          acc.taxTreatment,
          base.balanceDec31PriorYearCents,
          dollarsToCents(acc.postBalancePriorYearDollars ?? 0),
        );
        const twoYearsPriorCents = base.balanceDec31TwoYearsPriorCents;
        const rothPortionTwoYearsPriorCents =
          twoYearsPriorCents === undefined
            ? undefined
            : rmdDeclaredRothPortionCents(
                acc.taxTreatment,
                twoYearsPriorCents,
                dollarsToCents(acc.postBalanceTwoYearsPriorDollars ?? 0),
              );
        return {
          ...base,
          ...(rothPortionCents !== undefined ? { rothPortionCents } : {}),
          ...(rothPortionTwoYearsPriorCents !== undefined
            ? { rothPortionTwoYearsPriorCents }
            : {}),
        };
      });

    if (memberAccounts.length === 0) continue;

    const rmdResult = computeRmd(
      {
        isoBirthdate: member.isoBirthdate,
        taxYear,
        accounts: memberAccounts,
        // The §401(a)(9)(C) later-of first-distribution year needs the
        // member's separation year; absent → the affected account WITHHOLDS
        // rather than assuming the trigger-age year.
        ...(member.retirementYear !== undefined
          ? { retirementYear: member.retirementYear }
          : {}),
      },
      rmdSnapshot,
    );
    rmdFloorCents += rmdResult.ownerRmdCents;
    // Any owner at/over their SECURE 2.0 trigger age makes the household's
    // per-account map APPLICABLE this year (even at a $0 floor when no owner
    // carries a qualifying balance) — vs ABSENT below every owner's trigger age.
    if (rmdResult.applicable) rmdApplicable = true;
    for (const [id, cents] of Object.entries(rmdResult.perAccountRmdCents)) {
      rmdPerAccountCents[id] = (rmdPerAccountCents[id] ?? 0) + cents;
    }
    withheldAccounts.push(...(rmdResult.withheldAccounts ?? []));
    stillWorkingDeferredAccountIds.push(...(rmdResult.stillWorkingDeferredAccountIds ?? []));
    firstYearDeferrals.push(...(rmdResult.firstYearDeferrals ?? []));
    deferredCatchUpCents += rmdResult.deferredCatchUpCents ?? 0;
  }

  return {
    rmdFloorCents,
    rmdApplicable,
    rmdPerAccountCents,
    ...(anyFacts
      ? {
          rmdWithheldAccounts: withheldAccounts,
          rmdStillWorkingDeferredAccountIds: stillWorkingDeferredAccountIds,
          rmdFirstYearDeferrals: firstYearDeferrals,
          rmdDeferredCatchUpCents: deferredCatchUpCents,
        }
      : {}),
  };
}

/**
 * Total Required Minimum Distribution floor (cents) for one projection year —
 * the thin `.rmdFloorCents` wrapper over {@link computeMemberRmds} that the
 * Monte Carlo engine reuses so its RMD floor logic never diverges from the
 * deterministic tax-integration engine's (no duplicated loop).
 *
 * @param members      Per-member info (birthdate drives the SECURE 2.0 trigger age).
 * @param accounts     Per-account prior-year balances + ownership for the year.
 * @param taxYear      Calendar year the RMD is computed for.
 * @param rmdSnapshot  RMD divisor table (Uniform Lifetime), from `bundle.rmd`.
 * @returns            Total RMD floor across all eligible accounts, in cents
 *                     (0 when no member is RMD-age or no qualifying account).
 * @throws Surfaces the RMD engine's `UnsupportedTaxYearError` / validation
 *         throws to the caller (no swallowing — same contract as `applyTaxYear`).
 */
export function computeRmdFloorCents(
  members: readonly TaxMemberInput[],
  accounts: readonly TaxAccountSnapshot[],
  taxYear: number,
  rmdSnapshot: CalibrationSnapshot<RmdTable>,
): number {
  return computeMemberRmds(members, accounts, taxYear, rmdSnapshot).rmdFloorCents;
}

// ---------------------------------------------------------------------------
// Filing-plan orchestration (the production entry point)
// ---------------------------------------------------------------------------

/** The year's filing-plan inputs layered on top of `FilingPlanTaxYearInput`. */
export interface ApplyFilingPlanYearInput extends FilingPlanTaxYearInput {
  /**
   * The year's resolved tax units (`resolveFilingPlanForYear` → `taxUnits`).
   *
   * ABSENT is meaningful: the caller could not resolve
   * the filing plan (an ambiguous legacy scalar, an unknown plan kind), so this
   * function falls back to the legacy single-status `applyTaxYear` path with
   * the caller's own `filingStatus` and NOTHING is dropped. The UI surfaces the
   * resolution prompt separately — the projection never guesses a split.
   *
   * An EMPTY array means every member is deceased; callers skip such years, and
   * this function degrades to the legacy path rather than returning a fabricated
   * all-zero result.
   */
  readonly taxUnits?: readonly ResolvedTaxUnit[];
  /**
   * Household role → member id, so a resolved unit's `('primary'|'secondary')`
   * roles map onto `members` / `accounts` / `penaltyAccounts`, whose ids are
   * real aggregate ids. Required for a multi-unit year; a unit whose roles
   * cannot be mapped keeps every household member (fail-open, never drop).
   */
  readonly memberIdByRole?: { readonly primary?: string; readonly secondary?: string };
  /** Gross SS dollars per member id. SS is ATTRIBUTED to its recipient rather
   *  than split (§86 / IRS Pub 555), so a `separate` couple's two returns each
   *  carry only their own benefit. Absent → the even split. */
  readonly grossSsDollarsByMemberId?: Readonly<Record<string, number>>;
  /** Member ids that attain age 65 by the END of `taxYear` (IRS born-Jan-1 rule
   *  applied by the caller). Attributes the standard-deduction age add-on and
   *  the senior bonus to the unit that actually claims it. Absent → the
   *  household `taxpayersAge65Plus` is filled across units in order. */
  readonly age65PlusMemberIds?: readonly string[];
  /**
   * Owner-attributed dollars for the income / withdrawal fields that are
   * DERIVED FROM ACCOUNTS the drawdown layer already knows the owner of. Each
   * map is `memberId → dollars`; a unit's return reports only the entries its
   * own members own. A field absent from this object falls back to the even
   * split across units, which stays the documented approximation for genuinely
   * SHARED / unattributed household income only.
   */
  readonly ownerAttributedAmounts?: OwnerAttributedAmounts;
  /**
   * The IRMAA two-year look-back PER RETURN (`TaxYearResult.
   * filingUnitMagi` buffered by the caller two years ago). Each tax unit picks
   * the entry covering its own member(s), so two separate returns are tiered on
   * their OWN look-back MAGI and their OWN schedule, and a survivor whose
   * look-back year was a joint return is tiered on that joint return's full
   * MAGI + `MFJ` schedule. Absent → the household-wide
   * `magiTwoYearsPriorDollars` / `irmaaLookbackFilingStatus` scalars (the
   * single-return contract, unchanged).
   *
   * A BOOTSTRAP projection year (0–1) has no buffered entry, so both
   * engines rebuild one here from the look-back year's own resolved returns plus
   * an even split of the stored household bootstrap MAGI (`bootstrapLookbackRing`).
   * Without it a two-return look-back would collapse onto the first return's status.
   */
  readonly irmaaLookbackUnits?: readonly FilingUnitMagi[];
}

/**
 * Owner-attributed dollar amounts for one projection year. Every map is
 * keyed by household member id and holds that owner's OWN share of the
 * household total the sibling scalar field carries.
 *
 * Supplied by the deterministic runner, which classifies each year's withdrawal
 * per account and therefore knows the owner exactly. The Monte Carlo kernel
 * pools the household into synthetic buckets with no per-owner withdrawal
 * detail, so it supplies only what it genuinely knows (gross Social Security,
 * via `grossSsDollarsByMemberId`) and the remaining fields fall back to the
 * even split — the approximation disclosed in the report (see
 * `docs/math-taxes.md`, "Filing status and tax units").
 */
export interface OwnerAttributedAmounts {
  readonly preTaxWithdrawalDollars?: Readonly<Record<string, number>>;
  readonly postTaxNonRothWithdrawalDollars?: Readonly<Record<string, number>>;
  readonly postTaxCashLikeWithdrawalDollars?: Readonly<Record<string, number>>;
  readonly rothWithdrawalDollars?: Readonly<Record<string, number>>;
  readonly qcdIncomeExclusionDollars?: Readonly<Record<string, number>>;
  readonly brokerageLikeStartBalanceDollars?: Readonly<Record<string, number>>;
  readonly cashInterestDollars?: Readonly<Record<string, number>>;
  readonly otherOrdinaryIncomeDollars?: Readonly<Record<string, number>>;
}

/** §86 tier ordering, least → most benefit taxed. Used to pick the household
 *  DISPLAY tier from per-unit results (the cash figures are summed exactly;
 *  only the single categorical badge has to collapse). */
const SS_TIER_ORDER: readonly TaxYearResult['ssTaxationTier'][] = ['none', 'fifty', 'eighty-five'];
/** IRMAA tier ordering, least → most surcharge. Same display-collapse rule. */
const IRMAA_TIER_ORDER: readonly TaxYearResult['irmaaTier'][] = [
  'none',
  'tier1',
  'tier2',
  'tier3',
  'tier4',
  'tier5',
];

function highestTier<T>(order: readonly T[], values: readonly T[]): T {
  let best = 0;
  for (const v of values) {
    const idx = order.indexOf(v);
    if (idx > best) best = idx;
  }
  return order[best];
}

/**
 * Partition the household's member ids across the year's tax units.
 *
 * A multi-unit year is only computable when every unit's roles map to REAL
 * member ids and no member id lands on two returns: without that partition each
 * unit would silently report the WHOLE household (a fail-open), and
 * `mergeUnitResults` would then sum a doubled RMD floor, a doubled early-
 * withdrawal penalty, and a doubled Medicare beneficiary count.
 *
 * @returns One owned-id set per unit, or `null` when the roles cannot be
 *          partitioned — the caller then routes the year down the legacy
 *          single-status path (nothing dropped AND nothing double-counted).
 */
function partitionUnitMemberIds(
  units: readonly ResolvedTaxUnit[],
  memberIdByRole: ApplyFilingPlanYearInput['memberIdByRole'],
): ReadonlySet<string>[] | null {
  if (memberIdByRole === undefined) return null;
  const seen = new Set<string>();
  const byUnit: ReadonlySet<string>[] = [];
  for (const unit of units) {
    const ids = unit.memberIds
      .map((role) => memberIdByRole[role])
      .filter((id): id is string => id !== undefined);
    if (ids.length === 0) return null;
    for (const id of ids) {
      if (seen.has(id)) return null;
      seen.add(id);
    }
    byUnit.push(new Set(ids));
  }
  return byUnit;
}

/** Immutable per-unit build context (replaces seven positional args,
 *  two of them booleans and one a mutable out-param). */
interface UnitBuildContext {
  readonly input: ApplyFilingPlanYearInput;
  readonly unit: ResolvedTaxUnit;
  /** Even-split share for genuinely UNATTRIBUTED household dollars. */
  readonly share: number;
  /** Member ids this unit's return reports. */
  readonly ownedIds: ReadonlySet<string>;
  /** Ids owned by ANY unit — an owner outside this set belongs to no return. */
  readonly allUnitOwnedIds: ReadonlySet<string>;
  /** True for exactly one unit: the one that absorbs unassignable owners. */
  readonly absorbsUnassignedOwners: boolean;
  /** Share of a user-entered ACA SLCSP override this unit receives: the
   *  FULL override when it is the only PTC-eligible return, 0 when it is
   *  statutorily ineligible (`MFS`, §36B(c)(1)(C)). */
  readonly acaBenchmarkShare: number;
  /** Age-65+ taxpayers already attributed to EARLIER units on the fallback path
   *  (when the caller supplied no `age65PlusMemberIds`). Immutable — replaces
   *  the mutable out-param counter the old positional signature threaded. */
  readonly age65AlreadyTaken: number;
}

/** True when this unit's return reports the given owner's accounts / income. */
function unitOwns(ctx: UnitBuildContext, ownerId: string): boolean {
  if (ctx.ownedIds.has(ownerId)) return true;
  return ctx.absorbsUnassignedOwners && !ctx.allUnitOwnedIds.has(ownerId);
}

/**
 * One unit's member subset, memoized on the HOUSEHOLD member
 * array's identity.
 *
 * `healthCoverageYearFacts` keys its per-year memo on the member array it is
 * handed, which restores the once-per-run-year hot-loop contract for the
 * single-return path (Monte Carlo builds the year's survivor array exactly once
 * per run). A `separate`-filing couple runs through `buildUnitTaxYearInput`
 * instead, and a fresh `.filter(...)` per unit/year/PATH would miss that memo
 * entirely — the per-member benchmark sum, the age-curve `Math.pow` and the
 * IRMAA enrolment list would be rebuilt once per path-year for exactly the
 * households that file two returns.
 *
 * The subset is a pure function of the household array's CONTENTS plus this
 * unit's partition, so the cache key carries the full partition (the unit's own
 * ids, the ids owned by any unit, and the absorb-unassigned flag) — never just
 * the unit index, which would collide if the same array were re-partitioned.
 * The `WeakMap` entry dies with the survivor array; nothing is retained across
 * runs.
 */
const UNIT_MEMBERS_CACHE = new WeakMap<
  readonly TaxMemberInput[],
  Map<string, readonly TaxMemberInput[]>
>();

function unitMembersFor(ctx: UnitBuildContext): readonly TaxMemberInput[] {
  const householdMembers = ctx.input.members;
  let byPartition = UNIT_MEMBERS_CACHE.get(householdMembers);
  if (byPartition === undefined) {
    byPartition = new Map();
    UNIT_MEMBERS_CACHE.set(householdMembers, byPartition);
  }
  const key = [
    ctx.absorbsUnassignedOwners ? '1' : '0',
    [...ctx.ownedIds].sort().join(','),
    [...ctx.allUnitOwnedIds].sort().join(','),
  ].join('|');
  const cached = byPartition.get(key);
  if (cached !== undefined) return cached;
  const unitMembers = householdMembers.filter((m) => unitOwns(ctx, m.memberId));
  byPartition.set(key, unitMembers);
  return unitMembers;
}

/**
 * This unit's share of one household dollar figure.
 *
 * Dollars the caller ATTRIBUTED to an owner land on that owner's return in
 * full. Only the residual the caller could not attribute is split evenly, which
 * is the documented approximation for genuinely shared household income. The
 * per-unit values always sum back to the household total exactly.
 */
function unitShareOf(
  ctx: UnitBuildContext,
  householdTotal: number,
  attributed: Readonly<Record<string, number>> | undefined,
): number {
  if (attributed === undefined) return householdTotal * ctx.share;
  let ownShare = 0;
  let attributedTotal = 0;
  for (const [ownerId, amount] of Object.entries(attributed)) {
    if (!Number.isFinite(amount) || amount <= 0) continue;
    attributedTotal += amount;
    if (unitOwns(ctx, ownerId)) ownShare += amount;
  }
  const unattributed = Math.max(0, householdTotal - attributedTotal);
  return ownShare + unattributed * ctx.share;
}

/** `unitShareOf` for an optional field: `undefined` in → `undefined` out. */
function optionalUnitShareOf(
  ctx: UnitBuildContext,
  householdTotal: number | undefined,
  attributed: Readonly<Record<string, number>> | undefined,
): number | undefined {
  return householdTotal === undefined ? undefined : unitShareOf(ctx, householdTotal, attributed);
}

/** The IRMAA look-back facts for one unit: its OWN look-back return when
 *  the caller buffered a per-unit ring, else the household-wide scalars. */
interface UnitIrmaaLookback {
  readonly magiTwoYearsPriorDollars: number | undefined;
  readonly filingStatus: FilingStatus | undefined;
  readonly mfsLivedWithSpouse: boolean | undefined;
}

/**
 * Select a unit's own IRMAA look-back return from the per-unit ring.
 *
 * A return two years ago covered some set of members. This unit reads the entry
 * (or entries) covering ITS members, so:
 *  - two separate returns each tier on their own MAGI and their own schedule
 *    (a mixed `MFS`+`HoH` couple does not share one schedule);
 *  - a survivor whose look-back year was a JOINT return reads that joint
 *    return's full MAGI + `MFJ` schedule, instead of the merged household MAGI
 *    of a two-return year.
 *
 * When several look-back returns cover one current return (a couple that filed
 * separately two years ago and files jointly now), their MAGIs SUM and the
 * largest one's schedule applies — a documented approximation of a genuinely
 * per-beneficiary CMS determination.
 */
function unitIrmaaLookback(
  input: ApplyFilingPlanYearInput,
  ownedIds: ReadonlySet<string> | undefined,
  share: number,
): UnitIrmaaLookback {
  const ring = input.irmaaLookbackUnits;
  const householdFallback: UnitIrmaaLookback = {
    magiTwoYearsPriorDollars:
      input.magiTwoYearsPriorDollars === undefined
        ? undefined
        : input.magiTwoYearsPriorDollars * share,
    filingStatus: input.irmaaLookbackFilingStatus,
    mfsLivedWithSpouse: input.irmaaLookbackMfsLivedWithSpouse,
  };
  if (ring === undefined || ring.length === 0 || ownedIds === undefined) return householdFallback;
  const matches = ring.filter((entry) => entry.memberIds.some((id) => ownedIds.has(id)));
  if (matches.length === 0) return householdFallback;
  const magiCents = matches.reduce((sum, entry) => sum + entry.magiCents, 0);
  const dominant = matches.reduce((best, entry) => (entry.magiCents > best.magiCents ? entry : best));
  return {
    magiTwoYearsPriorDollars: centsToDollars(magiCents),
    filingStatus: dominant.filingStatus,
    mfsLivedWithSpouse: dominant.mfsLivedWithSpouse,
  };
}

/** Per-unit slice of the household's `taxpayersAge65Plus` (immutable).
 *  `alreadyTaken` is the count earlier units consumed on the fallback path. */
function age65CountForUnit(
  input: ApplyFilingPlanYearInput,
  unitMembers: readonly TaxMemberInput[],
  alreadyTaken: number,
): number {
  if (input.age65PlusMemberIds !== undefined) {
    const age65 = new Set(input.age65PlusMemberIds);
    return unitMembers.filter((m) => age65.has(m.memberId)).length;
  }
  // Fallback: fill units in order from the household count (never exceeding the
  // unit's own member count) so the total across units is conserved.
  return Math.max(0, Math.min((input.taxpayersAge65Plus ?? 0) - alreadyTaken, unitMembers.length));
}

/**
 * Build one tax unit's `applyTaxYear` input by narrowing the household input to
 * what that unit's return actually reports.
 *
 * Attribution rules:
 *  - members, RMD accounts, and penalty accounts are filtered by OWNERSHIP;
 *  - gross Social Security is attributed to its recipient (§86 / IRS Pub 555)
 *    whenever the caller supplies `grossSsDollarsByMemberId`;
 *  - withdrawals, the QCD exclusion, the brokerage yield base, cash interest,
 *    and other ordinary income are attributed to their OWNER whenever the caller
 *    supplies `ownerAttributedAmounts`, with only the genuinely
 *    unattributed residual split evenly;
 *  - a user-entered ACA SLCSP override is passed VERBATIM to the PTC-eligible
 *    return rather than halved;
 *  - the IRMAA look-back is this return's OWN look-back return.
 */
function buildUnitTaxYearInput(ctx: UnitBuildContext): FilingPlanTaxYearInput {
  const { input, unit, share } = ctx;
  const owned = ctx.input.ownerAttributedAmounts;
  const unitMembers = unitMembersFor(ctx);
  const perMemberSs = input.grossSsDollarsByMemberId;
  const grossSsDollars = perMemberSs
    ? unitMembers.reduce((sum, m) => sum + (perMemberSs[m.memberId] ?? 0), 0)
    : input.grossSsDollars * share;
  const lookback = unitIrmaaLookback(input, ctx.ownedIds, share);
  return {
    ...input,
    filingStatus: unit.filingStatus,
    householdSize: unit.householdSize ?? Math.max(1, unitMembers.length),
    members: unitMembers,
    accounts: input.accounts.filter((a) => unitOwns(ctx, a.ownerId)),
    penaltyAccounts: (input.penaltyAccounts ?? []).filter((a) => unitOwns(ctx, a.ownerId)),
    grossSsDollars,
    preTaxWithdrawalDollars: unitShareOf(
      ctx,
      input.preTaxWithdrawalDollars,
      owned?.preTaxWithdrawalDollars,
    ),
    postTaxNonRothWithdrawalDollars: unitShareOf(
      ctx,
      input.postTaxNonRothWithdrawalDollars,
      owned?.postTaxNonRothWithdrawalDollars,
    ),
    postTaxCashLikeWithdrawalDollars: optionalUnitShareOf(
      ctx,
      input.postTaxCashLikeWithdrawalDollars,
      owned?.postTaxCashLikeWithdrawalDollars,
    ),
    rothWithdrawalDollars: unitShareOf(
      ctx,
      input.rothWithdrawalDollars,
      owned?.rothWithdrawalDollars,
    ),
    otherOrdinaryIncomeDollars: unitShareOf(
      ctx,
      input.otherOrdinaryIncomeDollars,
      owned?.otherOrdinaryIncomeDollars,
    ),
    // Municipal interest carries no owner attribution today (the runners model
    // it as $0), so it stays on the even split.
    taxExemptInterestDollars: input.taxExemptInterestDollars * share,
    cashInterestDollars: optionalUnitShareOf(
      ctx,
      input.cashInterestDollars,
      owned?.cashInterestDollars,
    ),
    qcdIncomeExclusionDollars: optionalUnitShareOf(
      ctx,
      input.qcdIncomeExclusionDollars,
      owned?.qcdIncomeExclusionDollars,
    ),
    brokerageLikeStartBalanceDollars: optionalUnitShareOf(
      ctx,
      input.brokerageLikeStartBalanceDollars,
      owned?.brokerageLikeStartBalanceDollars,
    ),
    magiTwoYearsPriorDollars: lookback.magiTwoYearsPriorDollars,
    irmaaLookbackFilingStatus: lookback.filingStatus,
    irmaaLookbackMfsLivedWithSpouse: lookback.mfsLivedWithSpouse,
    // A per-year user override is used verbatim and bypasses ALL fallback
    // scaling. Halving it would break that contract for the `MFS` + `HoH`
    // separate plan (HoH IS PTC-eligible), so the override reaches the eligible
    // return whole.
    acaBenchmarkSlcspDollars:
      input.acaBenchmarkSlcspDollars === undefined
        ? undefined
        : input.acaBenchmarkSlcspDollars * ctx.acaBenchmarkShare,
    taxpayersAge65Plus: age65CountForUnit(input, unitMembers, ctx.age65AlreadyTaken),
    mfsLivedWithSpouse: input.mfsLivedWithSpouse ?? false,
  };
}

/**
 * Gross income denominator for the DISPLAYED effective tax rate (one
 * formula, shared by the single-return `applyTaxYear` and the merged
 * separate-return roll-up, so the two displayed rates cannot drift apart).
 *
 * The QCD is excluded from taxable income, so it is not part of the
 * denominator (a $0-tax charitable transfer, not spendable gross income).
 */
function grossIncomeForEffectiveRateDollars(input: TaxYearInput): number {
  const taxablePreTaxDollars = Math.max(
    0,
    input.preTaxWithdrawalDollars - Math.max(0, input.qcdIncomeExclusionDollars ?? 0),
  );
  return (
    input.grossSsDollars +
    taxablePreTaxDollars +
    input.postTaxNonRothWithdrawalDollars +
    (input.postTaxCashLikeWithdrawalDollars ?? 0) +
    input.otherOrdinaryIncomeDollars
  );
}

/** The smallest headroom among the returns that earn a credit; 0 when none does. */
function narrowestAcaMagiAboveFplCents(results: readonly TaxYearResult[]): number {
  const earning = results.filter((r) => r.acaPtcSubsidyCents > 0);
  return earning.length === 0
    ? 0
    : Math.min(...earning.map((r) => r.acaMagiAboveFplCents));
}

/** Sum the per-unit results into the household `TaxYearResult` the runners
 *  annotate. Cash fields sum exactly; the three categorical DISPLAY fields
 *  collapse to the household's most-affected unit. */
function mergeUnitResults(
  results: readonly TaxYearResult[],
  input: ApplyFilingPlanYearInput,
  filingUnitMagi: readonly FilingUnitMagi[],
  irmaaSurchargeCentsByUnit: readonly UnitIrmaaSurcharge[],
): TaxYearResult {
  const sum = (pick: (r: TaxYearResult) => number): number =>
    results.reduce((total, r) => total + pick(r), 0);
  const rmdPerAccountCents: Record<string, number> = {};
  for (const r of results) {
    for (const [id, cents] of Object.entries(r.rmdPerAccountCents)) {
      rmdPerAccountCents[id] = (rmdPerAccountCents[id] ?? 0) + cents;
    }
  }
  const federalTaxCents = sum((r) => r.federalTaxCents);
  // Denominator stays the HOUSEHOLD's gross income (the same composition
  // `applyTaxYear` uses) so the displayed effective rate is comparable with a
  // joint year's.
  const grossIncomeDollars = grossIncomeForEffectiveRateDollars(input);
  return {
    federalTaxCents,
    taxableSsCents: sum((r) => r.taxableSsCents),
    ssTaxationTier: highestTier(
      SS_TIER_ORDER,
      results.map((r) => r.ssTaxationTier),
    ),
    rmdFloorCents: sum((r) => r.rmdFloorCents),
    rmdApplicable: results.some((r) => r.rmdApplicable),
    rmdPerAccountCents,
    irmaaSurchargeCents: sum((r) => r.irmaaSurchargeCents),
    irmaaTier: highestTier(
      IRMAA_TIER_ORDER,
      results.map((r) => r.irmaaTier),
    ),
    acaPtcSubsidyCents: sum((r) => r.acaPtcSubsidyCents),
    // `below-fpl` is the documented NOT-APPLICABLE value, so the household badge
    // shows the first return that actually reached the PTC engine.
    acaPtcTier:
      results.find((r) => r.acaPtcTier !== 'below-fpl')?.acaPtcTier ?? 'below-fpl',
    fplPercentage: results.reduce((max, r) => Math.max(max, r.fplPercentage), 0),
    acaMagiAboveFplCents: narrowestAcaMagiAboveFplCents(results),
    // The SUM of the returns' MAGIs is a HOUSEHOLD figure no single
    // return reports. It is the right basis for the household-level MAGI
    // ceiling the drawdown overlay applies (one user-entered household ceiling),
    // and it is explicitly NOT what tiers IRMAA: that reads the per-unit
    // `filingUnitMagi` ring below.
    magiCents: sum((r) => r.magiCents),
    effectiveTaxRate:
      grossIncomeDollars > 0 ? centsToDollars(federalTaxCents) / grossIncomeDollars : 0,
    taxYearExtrapolated: results.some((r) => r.taxYearExtrapolated),
    earlyWithdrawalPenaltyCents: sum((r) => r.earlyWithdrawalPenaltyCents),
    hsaAdditionalTaxCents: sum((r) => r.hsaAdditionalTaxCents),
    penaltySkippedForMissingBirthdate: results.some((r) => r.penaltySkippedForMissingBirthdate),
    filingUnitMagi,
    irmaaSurchargeCentsByUnit,
    // Concatenate each return's per-beneficiary surcharges. A member
    // belongs to exactly one return, so the merged list is still one entry per
    // beneficiary and still sums to the household total.
    ...(results.some((r) => r.irmaaSurchargeCentsByMember !== undefined)
      ? {
          irmaaSurchargeCentsByMember: results.flatMap(
            (r) => r.irmaaSurchargeCentsByMember ?? [],
          ),
        }
      : {}),
  };
}

/** Every household member id on the year's input — the look-back ring entry for
 *  a single-return year (the whole household files that one return). */
function allMemberIds(input: ApplyFilingPlanYearInput): readonly string[] {
  return input.members.map((m) => m.memberId);
}

/** The look-back ring entry for a SINGLE-return year. */
function singleReturnLookbackEntry(
  input: ApplyFilingPlanYearInput,
  filingStatus: FilingStatus,
  memberIds: readonly string[],
  magiCents: number,
): FilingUnitMagi {
  return {
    memberIds,
    filingStatus,
    mfsLivedWithSpouse: filingStatus === 'MFS' && (input.mfsLivedWithSpouse ?? false),
    magiCents,
  };
}

/**
 * Apply the per-year tax engines across a projection year's RESOLVED tax units
 * and roll the results up to the household.
 *
 * Three paths, in order:
 *  1. `taxUnits` absent / empty (or a multi-unit year whose roles cannot be
 *     partitioned onto real member ids) → the legacy single-status
 *     `applyTaxYear`. This is the no-silent-unit-drop branch: an unresolvable
 *     legacy scalar keeps filing exactly as it did, and the UI prompts for a
 *     resolution.
 *  2. Exactly one unit (individual, joint, a survivor year, or a bounded
 *     `QSS`/`HoH` window) → one `applyTaxYear` with the unit's resolved status
 *     and tax-household size, reading that return's OWN IRMAA look-back (a
 *     survivor is not tiered on the merged household MAGI of the last
 *     two-return year). Identical to the legacy-scalar result whenever the plan
 *     resolves to the same status the legacy scalar derived.
 *  3. Two units (a `separate` couple while both spouses are alive) → the full
 *     engine PER UNIT on that unit's own members, accounts, owner-attributed
 *     income, and own IRMAA look-back, then {@link mergeUnitResults}. Each
 *     return therefore gets its own bracket table, §86 base (including the MFS
 *     lived-together zero base), ACA eligibility (MFS = $0 by §36B(c)(1)(C)),
 *     IRMAA tier, and RMD floor.
 *
 * Never throws `UnsupportedTaxYearError` for a future projection year — each
 * per-unit call inherits `applyTaxYear`'s clamping contract verbatim.
 */
export function applyTaxYearForFilingPlan(
  input: ApplyFilingPlanYearInput,
  bundle: TaxCalibrationBundle,
): TaxYearResult {
  const units = input.taxUnits;
  if (units === undefined || units.length === 0) {
    const result = applyTaxYear(input, bundle);
    return {
      ...result,
      filingUnitMagi: [
        singleReturnLookbackEntry(
          input,
          input.filingStatus,
          allMemberIds(input),
          result.magiCents,
        ),
      ],
    };
  }
  if (units.length === 1) {
    const unit = units[0];
    const ownedIds = partitionUnitMemberIds(units, input.memberIdByRole)?.[0];
    const lookback = unitIrmaaLookback(input, ownedIds, 1);
    const result = applyTaxYear(
      {
        ...input,
        filingStatus: unit.filingStatus,
        householdSize: unit.householdSize ?? input.householdSize,
        magiTwoYearsPriorDollars: lookback.magiTwoYearsPriorDollars,
        irmaaLookbackFilingStatus: lookback.filingStatus,
        irmaaLookbackMfsLivedWithSpouse: lookback.mfsLivedWithSpouse,
      },
      bundle,
    );
    return {
      ...result,
      filingUnitMagi: [
        singleReturnLookbackEntry(
          input,
          unit.filingStatus,
          ownedIds ? [...ownedIds] : allMemberIds(input),
          result.magiCents,
        ),
      ],
    };
  }
  const ownedIdsByUnit = partitionUnitMemberIds(units, input.memberIdByRole);
  if (ownedIdsByUnit === null) {
    // The roles cannot be partitioned onto real member ids (an absent or
    // partial `memberIdByRole`). Computing per-unit anyway would give BOTH
    // returns the whole household and double-count the RMD floor, the §72(t)
    // penalty, and the Medicare beneficiary count on merge. Fall back to the
    // legacy single-status path, which is exact for the household total.
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        '[tax-integration] multi-unit filing year without a usable memberIdByRole partition — falling back to the single-status path',
      );
    }
    const result = applyTaxYear(input, bundle);
    return {
      ...result,
      filingUnitMagi: [
        singleReturnLookbackEntry(input, input.filingStatus, allMemberIds(input), result.magiCents),
      ],
    };
  }
  const share = 1 / units.length;
  const allUnitOwnedIds = new Set<string>();
  for (const ids of ownedIdsByUnit) for (const id of ids) allUnitOwnedIds.add(id);
  // A user SLCSP override belongs to whichever return may actually claim
  // the credit. `MFS` returns are statutorily ineligible (§36B(c)(1)(C)), so the
  // override lands whole on the single eligible return; when both returns are
  // eligible (two `HoH` units) the one household benchmark divides between them.
  const ptcEligibleUnitCount = units.filter((u) =>
    acaPtcEligibleForFilingStatus(u.filingStatus),
  ).length;
  let age65Taken = 0;
  const perUnit = units.map((unit, index) => {
    const ctx: UnitBuildContext = {
      input,
      unit,
      share,
      ownedIds: ownedIdsByUnit[index],
      allUnitOwnedIds,
      // An owner belonging to NO unit (a data gap) is reported on the FIRST
      // unit's return rather than dropped — their RMD, penalty, and member row
      // still reach the household total exactly once.
      absorbsUnassignedOwners: index === 0,
      acaBenchmarkShare: acaPtcEligibleForFilingStatus(unit.filingStatus)
        ? 1 / Math.max(1, ptcEligibleUnitCount)
        : 0,
      age65AlreadyTaken: age65Taken,
    };
    const unitInput = buildUnitTaxYearInput(ctx);
    age65Taken += unitInput.taxpayersAge65Plus ?? 0;
    return { ctx, unitInput, result: applyTaxYear(unitInput, bundle) };
  });
  const filingUnitMagi: FilingUnitMagi[] = perUnit.map(({ ctx, result }) => ({
    memberIds: [...ctx.ownedIds],
    filingStatus: ctx.unit.filingStatus,
    mfsLivedWithSpouse:
      ctx.unit.filingStatus === 'MFS' && (input.mfsLivedWithSpouse ?? false),
    magiCents: result.magiCents,
  }));
  // Keep each return's own surcharge so the cashflow solver withholds
  // the right amount from each spouse's own Social Security when the two
  // returns land on different tiers.
  const irmaaSurchargeCentsByUnit: UnitIrmaaSurcharge[] = perUnit.map(({ ctx, result }) => ({
    memberIds: [...ctx.ownedIds],
    surchargeCents: result.irmaaSurchargeCents,
  }));
  return mergeUnitResults(
    perUnit.map((u) => u.result),
    input,
    filingUnitMagi,
    irmaaSurchargeCentsByUnit,
  );
}
