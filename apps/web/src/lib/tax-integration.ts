/**
 * Tax-integration layer: wires the federal, SS-taxation, IRMAA, ACA-PTC and RMD engines into one per-year call surface for both
 * runners; `applyTaxYearForFilingPlan` is the production entry point.
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
  DEFAULT_TAX_CALIBRATION_BUNDLE,
  TaxIntegrationInvalidInputError,
  friendlyProjectionErrorMessage,
  dollarsToCents,
  centsToDollars,
  resolveSnapshotYear,
  buildScaledFederalTaxConfig,
  isRothAccount,
  computeMagi,
  resolveAssumedTaxableYieldConfig,
  resolveAssumedYieldComponents,
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

// Splits the inflation-scaled household IRMAA surcharge across the beneficiaries who owe it: month-aware IRMAA prorates Part B
// and D by each member's own months, so an even split would withhold the wrong amount from each SS check. Weights are the
// unscaled per-beneficiary charges, allocated by `allocateCentsByWeight` so the parts sum to the scaled total to the cent.
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

/** `TaxYearInput` plus the filing-plan facts; every field is optional and an absent one reproduces the single-status result. They live here because only the filing-plan orchestration uses them. */
export interface FilingPlanTaxYearInput extends TaxYearInput {
  /** Whether an MFS filer lived with their spouse during the tax year (§86(c)(1)(C)(ii)): true makes both §86 base amounts $0. Only meaningful when `filingStatus === 'MFS'`. */
  readonly mfsLivedWithSpouse?: boolean;
  /** Filing status of the return IRMAA's two-year look-back reads: IRMAA tiers on the look-back return, so a couple that filed MFJ two years ago keeps the joint schedule in the survivor's first Single year. Absent uses the current `filingStatus`. */
  readonly irmaaLookbackFilingStatus?: FilingStatus;
  /** Whether the look-back MFS return lived with the spouse, selecting the steeper `byMfs` schedule; absent means lived apart. */
  readonly irmaaLookbackMfsLivedWithSpouse?: boolean;
}

/** The basis share of a taxable-account withdrawal when the caller states none. */
export const DEFAULT_ASSUMED_COST_BASIS_FRACTION = 0.5;

/**
 * Applies all five tax engines to one projection year: SS taxation first (its taxable SS feeds MAGI), then MAGI, then federal
 * tax, IRMAA and ACA-PTC (independent, sharing MAGI); the RMD is an independent pre-pass whose result informs
 * `rmdFloorCents` while enforcement lives in the drawdown engine. Clamps the upper bound through `resolveSnapshotYear`, so a
 * future year never throws UnsupportedTaxYearError; a year below the minimum key still throws from the engine.
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
    // Roth withdrawals are omitted from the income and MAGI sums: the taxable earnings and the 10% penalty are worked out upstream
    // by the owner-level Roth basis tracker, which routes earnings in as ordinary income.
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
  // A fraction outside [0, 1] would give negative or over-stated LTCG and silently wrong federal tax and MAGI.
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

  // The QCD is part of the pre-tax IRA distribution but excluded from ordinary income and MAGI, so every income and MAGI sum
  // reads the reduced `taxablePreTaxWithdrawalDollars` (including the IRMAA Y+2 ring). Clamped at the pre-tax total: a QCD is
  // part of, never on top of, the distribution.
  const taxablePreTaxWithdrawalDollars = Math.max(
    0,
    preTaxWithdrawalDollars - Math.max(0, qcdIncomeExclusionDollars),
  );

  // HSA buckets: medical-qualified dollars (funded against modeled `isMedical` demand) are 100% qualified, with $0 income and no
  // penalty; the emergency residual is governed by `hsaQualifiedMedicalExpensePct` (that share qualified, the rest ordinary income
  // plus the 20% additional tax before 65). The percentage is clamped to [0, 100] defensively.
  const hsaQualifiedFraction = Math.min(100, Math.max(0, hsaQualifiedMedicalExpensePct)) / 100;
  // Derive the emergency residual in integer cents when the snapshot carries committed cents, so medical plus emergency
  // reconcile exactly (the residual is never independently rounded); otherwise fall back to the dollar fields.
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
  // Brokerage-like POST_TAX balances throw off taxable income every year even without a withdrawal, in three explicit
  // tax-character streams: qualified dividends (LTCG/QDI rates), ordinary interest (ordinary rates and the NIIT base), and
  // tax-exempt municipal interest ($0 federal tax; a §36B/IRMAA MAGI add-back only, explicit calibration, never inferred from a
  // bond allocation). The yield is reinvested, so the runner adds it to cost basis instead of reducing the balance.
  const assumedYield = resolveAssumedTaxableYieldConfig(bundle.assumedTaxableYield, taxYear);
  const yieldBase = Math.max(0, brokerageLikeStartBalanceDollars);
  const totalAssumedYieldDollars = yieldBase * Math.max(0, assumedYield.totalYieldPct);
  const yieldComponents = resolveAssumedYieldComponents(assumedYield);
  const assumedYieldQdiDollars = totalAssumedYieldDollars * yieldComponents.qdiFraction;
  const assumedYieldTaxExemptDollars =
    totalAssumedYieldDollars * yieldComponents.taxExemptFraction;
  const assumedYieldOrdinaryInterestDollars =
    totalAssumedYieldDollars * yieldComponents.ordinaryFraction;
  // Total tax-exempt interest: the caller's muni interest plus the assumed municipal stream; it feeds §86 provisional income and
  // both MAGIs as the §36B add-back, but is not federal taxable income and not §1411 NII.
  const totalTaxExemptInterestDollars = taxExemptInterestDollars + assumedYieldTaxExemptDollars;

  // HSA nonqualified income, the ordinary-interest yield and cash-like interest (taxed the year it accrues; HSA growth stays
  // tax-free) fold into other ordinary income, flowing through §86, MAGI and federal tax like a pension.
  const ordinaryIncomeWithHsa =
    otherOrdinaryIncomeDollars +
    hsaNonqualifiedDollars +
    assumedYieldOrdinaryInterestDollars +
    cashInterestDollars;

  // Beyond the latest published federal table, a synthesized inflation-scaled TaxConfig (floors, deductions and add-ons × the same
  // `thresholdScalingFactor` IRMAA uses; NIIT frozen) avoids reusing frozen latest-year thresholds.
  const {
    lookupYear: federalLookupYear,
    snapshot: federalSnapshot,
    taxYearExtrapolated,
  } = resolveFederalTaxSnapshotForYear(bundle.federalTax, taxYear, inflationRatePct);

  // LTCG proxy first, since §86 provisional income includes LTCG/QDI (IRS Pub 590-A). Only BROKERAGE / OTHER POST_TAX
  // withdrawals feed it: `postTaxCashLikeWithdrawalDollars` (cash, CD, HSA principal) is return of already-taxed principal, with
  // $0 taxable income and $0 MAGI. LTCG/QDI is the withdrawal-time gain (evolving cost-basis proxy) plus the yield's qualified-dividend stream.
  const ltcgDollars =
    postTaxNonRothWithdrawalDollars * (1 - assumedCostBasisFraction) + assumedYieldQdiDollars;
  // otherAGI excludes taxable SS, which is what §86 computes.
  const otherAgiForSsCents = dollarsToCents(
    taxablePreTaxWithdrawalDollars + ltcgDollars + ordinaryIncomeWithHsa,
  );
  const grossSsCents = dollarsToCents(grossSsDollars);
  // §86 provisional income includes tax-exempt interest, the caller's plus the assumed municipal stream.
  const taxExemptInterestCents = dollarsToCents(totalTaxExemptInterestDollars);

  const ssResult = computeSsTaxation(
    {
      grossSsCents,
      otherAgiCents: otherAgiForSsCents,
      taxExemptInterestCents,
      filingStatus,
      taxYear,
      mfsLivedWithSpouse: input.mfsLivedWithSpouse ?? false,
    },
    bundle.ssTax,
  );

  // Two MAGIs diverge by law: federal/IRMAA MAGI includes only the taxable part of SS (§86); ACA PTC MAGI (IRC §36B(d)(2)(B)) adds
  // the entire SS benefit, including the nontaxable part, which can change PTC eligibility.
  const taxableSsDollars = centsToDollars(ssResult.taxableSsCents);
  const magiDollars = computeMagi({
    ordinaryIncomeDollars: taxablePreTaxWithdrawalDollars + ordinaryIncomeWithHsa + taxableSsDollars,
    ltcgDollars,
    taxExemptInterestDollars: totalTaxExemptInterestDollars,
  });
  const magiCents = dollarsToCents(magiDollars);
  const nontaxableSsDollars = Math.max(0, grossSsDollars - taxableSsDollars);
  const acaMagiCents = dollarsToCents(magiDollars + nontaxableSsDollars);

  // federal-tax takes ordinaryIncome and ltcgAndQdi in dollars, not cents.
  const ordinaryIncomeDollars = taxablePreTaxWithdrawalDollars + ordinaryIncomeWithHsa + taxableSsDollars;
  // NIIT base: the LTCG/QDI stream plus the ordinary-interest yield and cash-like interest (interest and non-qualified dividends
  // are NII too, §1411(c)); tax-exempt municipal interest is not NII.
  const netInvestmentIncomeDollars =
    ltcgDollars + assumedYieldOrdinaryInterestDollars + cashInterestDollars;
  const federalResult = computeFederalTax(
    {
      year: federalLookupYear,
      filingStatus,
      ordinaryIncome: ordinaryIncomeDollars,
      ltcgAndQdi: ltcgDollars,
      netInvestmentIncome: netInvestmentIncomeDollars,
      // The senior-deduction phase-out reads MAGI before that deduction; the statutory base is AGI plus §911/931/933 exclusions and
      // does not add back tax-exempt interest as Medicare/IRMAA MAGI does, so strip it.
      magiForSeniorDeduction: Math.max(0, magiDollars - totalTaxExemptInterestDollars),
      taxpayersAge65Plus,
    },
    federalSnapshot,
  );

  let irmaaSurchargeCents = 0;
  let irmaaTier: TaxYearResult['irmaaTier'] = 'none';
  let irmaaSurchargeCentsByMember: readonly MemberIrmaaSurcharge[] | undefined;

  // Health facts for the year's member set, resolved and memoized once (seed-independent, so Monte Carlo pays once per run-year, not per path-year).
  const healthFacts = healthCoverageYearFacts(members, taxYear);

  if (healthFacts.anyMedicareMonths && magiTwoYearsPriorDollars !== undefined) {
    const { effectiveYear: irmaaYear, thresholdScalingFactor: irmaaScaling } =
      resolveSnapshotYear(bundle.irmaa, taxYear, inflationRatePct);
    // Deflate the look-back MAGI by the inflation scaling so it compares against the clamped (older) thresholds.
    const adjustedMagiTwoYearsPrior = magiTwoYearsPriorDollars / irmaaScaling;
    // Tier on the look-back return's filing status when known, else the current year's; the MFS lived-together fact travels with whichever status is used.
    const lookbackFilingStatus = input.irmaaLookbackFilingStatus ?? filingStatus;
    const lookbackMfsLivedWithSpouse =
      input.irmaaLookbackFilingStatus === undefined
        ? (input.mfsLivedWithSpouse ?? false)
        : (input.irmaaLookbackMfsLivedWithSpouse ?? false);
    // Part B and Part D are prorated separately by each beneficiary's own months; a member with no stored months resolves to 12/12 or 0/0, matching a whole-year `computeIrmaa`.
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
    // Re-inflate the surcharge cents to projection-year dollars: the look-back MAGI was deflated for tiering, but the surcharge
    // dollars are frozen at the clamped snapshot year (about 35% low by 2036 at 3%). Scaling here leaves tiering untouched (no
    // double-deflation), mirroring the federal re-inflation.
    irmaaSurchargeCents = Math.round(
      irmaaResult.totalHouseholdAnnualCents * irmaaScaling,
    );
    irmaaTier = irmaaResult.tier;
    // Each beneficiary's own scaled surcharge, allocated out of the scaled household total by unscaled share so they sum to
    // `irmaaSurchargeCents` exactly: two beneficiaries on one return can owe different amounts, so the solver must not re-divide evenly.
    irmaaSurchargeCentsByMember = allocateMemberIrmaaSurcharges(
      healthFacts.irmaaBeneficiaries,
      irmaaResult,
      irmaaSurchargeCents,
    );
  }

  let acaPtcSubsidyCents = 0;
  let acaPtcTier: TaxYearResult['acaPtcTier'] = 'below-fpl';
  let fplPercentage = 0;
  let acaMagiAboveFplCents = 0;

  // An MFS return is ineligible for the PTC (§36B(c)(1)(C)) and `computeAcaPtc` throws rather than credit one, so the gate rejects MFS before the engine call.
  if (healthFacts.marketplaceCoverageMonths > 0 && acaPtcEligibleForFilingStatus(filingStatus)) {
    const { effectiveYear: acaYear, thresholdScalingFactor: acaScaling } =
      resolveSnapshotYear(bundle.acaPtc, taxYear, inflationRatePct);
    let benchmarkSlcspCents: number;
    if (acaBenchmarkSlcspDollars !== undefined) {
      // A per-year user override replaces the rough fallback. The editor collects a whole-year price, so it is prorated to the
      // household's coverage months, the same range the expected contribution is prorated by (else a part-year household gets
      // `12 × B − m × C` instead of `m × (B − C)`).
      benchmarkSlcspCents = overrideBenchmarkCentsForCoverageMonths(
        acaBenchmarkSlcspDollars,
        healthFacts.marketplaceCoverageMonths,
      );
    } else {
      benchmarkSlcspCents = growRoughBenchmarkCents(
        dollarsToCents(healthFacts.defaultBenchmarkAnnualDollars),
        taxYear,
        input.medicalInflationRatePct,
      );
    }
    // Deflate ACA MAGI (which includes nontaxable SS, unlike the federal/IRMAA MAGI) so the FPL% comparison uses an inflation-consistent poverty line, as IRMAA does.
    const acaMagiDeflatedCents = Math.round(acaMagiCents / acaScaling);
    const acaResult = computeAcaPtc(
      {
        taxYear: acaYear,
        filingStatus,
        householdSize,
        magiCents: acaMagiDeflatedCents,
        benchmarkAnnualSlcspCents: benchmarkSlcspCents,
        ...(input.acaFplRegion !== undefined ? { fplRegion: input.acaFplRegion } : {}),
        // Re-inflate the expected-contribution output to projection-year dollars (the MAGI input was deflated for tier classification only); the benchmark is not scaled here.
        expectedContributionScalingFactor: acaScaling,
        // §36B(b)(2) sums the credit over coverage months, so the contribution is prorated over the same range as the covered-member-month benchmark.
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

  const memberRmd = computeMemberRmds(members, accounts, taxYear, bundle.rmd);
  const { rmdFloorCents, rmdApplicable, rmdPerAccountCents } = memberRmd;

  // The owner's birthdate resolves each account's exact 59½ / 65 cutoff. Penalty basis: the pre-tax tranche for IRA/401k-style
  // accounts, the nonqualified portion for HSAs.
  const birthdateByMember = new Map(members.map((m) => [m.memberId, m.isoBirthdate]));
  const penaltyAccountInputs: PenaltyAccountInput[] = penaltyAccounts.map((acc) => {
    const ownerBirthdate = birthdateByMember.get(acc.ownerId);
    if (acc.type === 'HSA') {
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
      // The base is already source-exemption-resolved, so the penalty engine must not re-test the account type and drop a governmental-457(b) in-plan-rollover recapture.
      ...(acc.rothOrderedAdditionalTaxBase === true
        ? { rothOrderedAdditionalTaxBase: true }
        : {}),
      // §72(t)(2)(A)(ii): a post-death inherited distribution carries no 10% additional tax at any age.
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

  // The early-withdrawal and HSA additional taxes are part of the federal liability (Form 5329 / Schedule 2), so they fold
  // into `federalTaxCents` for the cashflow solver, and are also surfaced separately.
  const federalTaxWithPenaltyCents =
    federalResult.totalTax + earlyWithdrawalPenaltyCents + hsaAdditionalTaxCents;
  // One shared denominator (`grossIncomeForEffectiveRateDollars`) so single-return and merged separate-return rates cannot drift.
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
    // Fact-based RMD disclosures ride the year result for the report and estimate notes; each is omitted when no account carries RMD facts.
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

/** Total RMD floor (cents) + per-account RMD (cents) for one projection year. */
interface MemberRmdResult {
  readonly rmdFloorCents: number;
  /** True when at least one owner reached the SECURE 2.0 trigger age this tax year (the per-account map is then applicable, possibly `{}` at a $0 floor). */
  readonly rmdApplicable: boolean;
  readonly rmdPerAccountCents: Record<string, number>;
  /** See the `TaxYearResult` fields; absent (not `[]`) when no account carried RMD facts. */
  readonly rmdWithheldAccounts?: readonly RmdWithheldAccount[];
  readonly rmdStillWorkingDeferredAccountIds?: readonly string[];
  readonly rmdFirstYearDeferrals?: readonly RmdFirstYearDeferralDetail[];
  readonly rmdDeferredCatchUpCents?: number;
}

// Household RMD floor and per-account map for one year, from one member loop. Accounts are scoped to each member's `ownerId`
// to avoid double-counting across spouses; an account with a Roth-designated pocket passes it as `rothPortionCents`
// (SECURE 2.0 §325) so the base is pre-tax only. Engine throws (`UnsupportedTaxYearError`, validation) propagate.
function computeMemberRmds(
  members: readonly TaxMemberInput[],
  accounts: readonly TaxAccountSnapshot[],
  taxYear: number,
  rmdSnapshot: CalibrationSnapshot<RmdTable>,
): MemberRmdResult {
  let rmdFloorCents = 0;
  let rmdApplicable = false;
  const rmdPerAccountCents: Record<string, number> = {};
  // Fact-based disclosures accumulate across owners; `anyFacts` decides whether they are reported, so a fact-free household keeps the legacy shape.
  const anyFacts = accounts.some((acc) => acc.rmdFacts !== undefined);
  const withheldAccounts: RmdWithheldAccount[] = [];
  const stillWorkingDeferredAccountIds: string[] = [];
  const firstYearDeferrals: RmdFirstYearDeferralDetail[] = [];
  let deferredCatchUpCents = 0;

  for (const member of members) {
    // Scope accounts to this member's `ownerId`. An inherited account is admitted even when the living-owner test rejects its
    // type (an inherited Roth IRA owes beneficiary distributions), because `resolveRmdRule` owns that decision; the filter only
    // keeps non-RMD-subject types out.
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
        // An account with a Roth-designated pocket declares it as `rothPortionCents` so the engine subtracts it (SECURE 2.0 §325):
        // a MIXED plan's sub-account, or the whole balance of a pure Roth account (how an inherited Roth stops being a pre-tax
        // base). The shared `rmdDeclaredRothPortionCents` keeps this producer and the two MC producers on the same base, and the
        // two-years-prior catch-up base carries the same pair.
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
        // The §401(a)(9)(C) later-of first-distribution year needs the separation year; absent withholds the affected account.
        ...(member.retirementYear !== undefined
          ? { retirementYear: member.retirementYear }
          : {}),
      },
      rmdSnapshot,
    );
    rmdFloorCents += rmdResult.ownerRmdCents;
    // Any owner at or over the trigger age makes the per-account map applicable this year, even at a $0 floor.
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
 * Total RMD floor in cents for one projection year: the thin `.rmdFloorCents` wrapper over `computeMemberRmds` that the Monte
 * Carlo engine reuses so its floor never diverges from the deterministic engine's. Engine throws propagate, as in `applyTaxYear`.
 */
export function computeRmdFloorCents(
  members: readonly TaxMemberInput[],
  accounts: readonly TaxAccountSnapshot[],
  taxYear: number,
  rmdSnapshot: CalibrationSnapshot<RmdTable>,
): number {
  return computeMemberRmds(members, accounts, taxYear, rmdSnapshot).rmdFloorCents;
}

/** The year's filing-plan inputs layered on top of `FilingPlanTaxYearInput`. */
export interface ApplyFilingPlanYearInput extends FilingPlanTaxYearInput {
  /**
   * The year's resolved tax units (`resolveFilingPlanForYear`). Absent means the plan could not be resolved (ambiguous legacy
   * scalar, unknown plan kind): fall back to the legacy single-status `applyTaxYear` with the caller's `filingStatus`, dropping
   * nothing, while the UI shows the resolution prompt. An empty array means every member is deceased; callers skip such years and
   * this degrades to the legacy path rather than fabricating an all-zero result.
   */
  readonly taxUnits?: readonly ResolvedTaxUnit[];
  /** Household role → member id, mapping a unit's primary/secondary roles onto `members` / `accounts` / `penaltyAccounts`. Required for a multi-unit year; a unit whose roles cannot be mapped keeps every household member (fail-open, never drop). */
  readonly memberIdByRole?: { readonly primary?: string; readonly secondary?: string };
  /** Gross SS dollars per member id: SS is attributed to its recipient, not split (§86 / IRS Pub 555), so each separate return carries only its own benefit. Absent means the even split. */
  readonly grossSsDollarsByMemberId?: Readonly<Record<string, number>>;
  /** Member ids who attain 65 by the end of `taxYear` (IRS born-Jan-1 rule applied by the caller), attributing the age add-on and senior bonus to the unit that claims it. Absent fills the household `taxpayersAge65Plus` across units in order. */
  readonly age65PlusMemberIds?: readonly string[];
  /** Owner-attributed dollars (`memberId → dollars`) for income and withdrawal fields derived from accounts with a known owner; a unit's return reports only its own members' entries. A field absent here falls back to the even split, the approximation for genuinely shared household income only. */
  readonly ownerAttributedAmounts?: OwnerAttributedAmounts;
  /**
   * The IRMAA two-year look-back per return (`TaxYearResult.filingUnitMagi` buffered two years ago). Each unit picks the entry
   * covering its own members, so separate returns tier on their own look-back MAGI and schedule, and a survivor whose look-back
   * year was joint tiers on that return's full MAGI and MFJ schedule. Absent uses the household `magiTwoYearsPriorDollars` /
   * `irmaaLookbackFilingStatus` scalars. A bootstrap year (0–1) has no buffered entry, so both engines rebuild one from the
   * look-back year's returns and an even split of the stored bootstrap MAGI (`bootstrapLookbackRing`).
   */
  readonly irmaaLookbackUnits?: readonly FilingUnitMagi[];
}

/**
 * Owner-attributed dollar amounts for one projection year: each map is keyed by member id and holds that owner's own share of
 * the household total its sibling scalar carries. The deterministic runner classifies withdrawals per account and so knows the
 * owner; the Monte Carlo kernel pools the household and supplies only gross SS (`grossSsDollarsByMemberId`), so the rest falls
 * back to the even split, the approximation disclosed in the report (docs/math-taxes.md, "Filing status and tax units").
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

// §86 tier ordering, least to most benefit taxed, used to pick the household display tier from per-unit results (cash figures sum exactly; only the categorical badge collapses).
const SS_TIER_ORDER: readonly TaxYearResult['ssTaxationTier'][] = ['none', 'fifty', 'eighty-five'];
// IRMAA tier ordering, with the same display-collapse rule.
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

// A multi-unit year is computable only when every unit's roles map to real member ids and no id lands on two returns;
// otherwise each unit would report the whole household and `mergeUnitResults` would double the RMD floor, the early-withdrawal
// penalty and the Medicare beneficiary count. Returns one owned-id set per unit, or `null` so the caller takes the legacy
// single-status path (nothing dropped or double-counted).
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

interface UnitBuildContext {
  readonly input: ApplyFilingPlanYearInput;
  readonly unit: ResolvedTaxUnit;
  /** Even-split share for genuinely unattributed household dollars. */
  readonly share: number;
  readonly ownedIds: ReadonlySet<string>;
  /** Ids owned by any unit; an owner outside it belongs to no return. */
  readonly allUnitOwnedIds: ReadonlySet<string>;
  /** True for exactly one unit: the one that absorbs unassignable owners. */
  readonly absorbsUnassignedOwners: boolean;
  /** Share of a user-entered ACA SLCSP override this unit receives: the full override when it is the only PTC-eligible return, 0 when ineligible (MFS, §36B(c)(1)(C)). */
  readonly acaBenchmarkShare: number;
  /** Age-65+ taxpayers already attributed to earlier units on the fallback path (no `age65PlusMemberIds`). */
  readonly age65AlreadyTaken: number;
}

function unitOwns(ctx: UnitBuildContext, ownerId: string): boolean {
  if (ctx.ownedIds.has(ownerId)) return true;
  return ctx.absorbsUnassignedOwners && !ctx.allUnitOwnedIds.has(ownerId);
}

// One unit's member subset, memoized on the household member array's identity: `healthCoverageYearFacts` keys its memo on the
// array it is handed, and a fresh `.filter` per unit/year/path would miss it, rebuilding the benchmark sum and IRMAA
// enrollment list per path-year for separate-filing households. The subset depends on the array's contents plus this unit's
// partition, so the key carries the full partition (own ids, all owned ids, absorb flag), not the unit index. The WeakMap
// entry dies with the array.
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

// A unit's share of one household dollar figure: dollars attributed to an owner land on that owner's return in full, and only the
// unattributed residual splits evenly (the documented approximation for shared income); the per-unit values sum to the household total.
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

function optionalUnitShareOf(
  ctx: UnitBuildContext,
  householdTotal: number | undefined,
  attributed: Readonly<Record<string, number>> | undefined,
): number | undefined {
  return householdTotal === undefined ? undefined : unitShareOf(ctx, householdTotal, attributed);
}

interface UnitIrmaaLookback {
  readonly magiTwoYearsPriorDollars: number | undefined;
  readonly filingStatus: FilingStatus | undefined;
  readonly mfsLivedWithSpouse: boolean | undefined;
}

// A unit's own IRMAA look-back return from the per-unit ring: it reads the entries covering its members, so separate returns tier
// on their own MAGI and schedule (a mixed MFS+HoH couple does not share one), and a survivor whose look-back year was joint
// reads that joint return's full MAGI and MFJ schedule. When several look-back returns cover one current return (filed
// separately then, jointly now), their MAGIs sum and the largest one's schedule applies, a documented approximation of a
// per-beneficiary CMS determination.
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

function age65CountForUnit(
  input: ApplyFilingPlanYearInput,
  unitMembers: readonly TaxMemberInput[],
  alreadyTaken: number,
): number {
  if (input.age65PlusMemberIds !== undefined) {
    const age65 = new Set(input.age65PlusMemberIds);
    return unitMembers.filter((m) => age65.has(m.memberId)).length;
  }
  // Fallback: fill units in order from the household count (capped at the unit's member count) so the total is conserved.
  return Math.max(0, Math.min((input.taxpayersAge65Plus ?? 0) - alreadyTaken, unitMembers.length));
}

// Builds one unit's `applyTaxYear` input from what its return reports: members, RMD and penalty accounts filter by ownership;
// gross SS goes to its recipient (§86 / IRS Pub 555) when `grossSsDollarsByMemberId` is supplied; withdrawals, QCD exclusion,
// brokerage yield base, cash interest and other income go to their owner when `ownerAttributedAmounts` is supplied, with only the
// unattributed residual split evenly; a user ACA SLCSP override goes whole to the PTC-eligible return; the IRMAA look-back is
// the return's own.
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
    // Municipal interest has no owner attribution (the runners model it as $0), so it stays on the even split.
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
    // A user override is used verbatim, so it reaches the PTC-eligible return whole (halving it would break that for an MFS + HoH plan, where HoH is eligible).
    acaBenchmarkSlcspDollars:
      input.acaBenchmarkSlcspDollars === undefined
        ? undefined
        : input.acaBenchmarkSlcspDollars * ctx.acaBenchmarkShare,
    taxpayersAge65Plus: age65CountForUnit(input, unitMembers, ctx.age65AlreadyTaken),
    mfsLivedWithSpouse: input.mfsLivedWithSpouse ?? false,
  };
}

// Gross income denominator for the displayed effective rate, shared by `applyTaxYear` and the merged separate-return roll-up
// so the two rates cannot drift. The QCD is excluded: a $0-tax charitable transfer is not spendable gross income.
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

// Sums the per-unit results into the household `TaxYearResult`: cash fields sum exactly, and the three categorical display fields collapse to the most-affected unit.
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
  // The denominator stays the household's gross income, as in `applyTaxYear`, so the rate is comparable with a joint year's.
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
    // `below-fpl` is the not-applicable value, so the badge shows the first return that reached the PTC engine.
    acaPtcTier:
      results.find((r) => r.acaPtcTier !== 'below-fpl')?.acaPtcTier ?? 'below-fpl',
    fplPercentage: results.reduce((max, r) => Math.max(max, r.fplPercentage), 0),
    acaMagiAboveFplCents: narrowestAcaMagiAboveFplCents(results),
    // A household figure no single return reports: the basis for the household-level MAGI ceiling the drawdown overlay applies, and not what tiers IRMAA (that reads the per-unit `filingUnitMagi` ring).
    magiCents: sum((r) => r.magiCents),
    effectiveTaxRate:
      grossIncomeDollars > 0 ? centsToDollars(federalTaxCents) / grossIncomeDollars : 0,
    taxYearExtrapolated: results.some((r) => r.taxYearExtrapolated),
    earlyWithdrawalPenaltyCents: sum((r) => r.earlyWithdrawalPenaltyCents),
    hsaAdditionalTaxCents: sum((r) => r.hsaAdditionalTaxCents),
    penaltySkippedForMissingBirthdate: results.some((r) => r.penaltySkippedForMissingBirthdate),
    filingUnitMagi,
    irmaaSurchargeCentsByUnit,
    // A member belongs to exactly one return, so the concatenated list still has one entry per beneficiary and sums to the household total.
    ...(results.some((r) => r.irmaaSurchargeCentsByMember !== undefined)
      ? {
          irmaaSurchargeCentsByMember: results.flatMap(
            (r) => r.irmaaSurchargeCentsByMember ?? [],
          ),
        }
      : {}),
  };
}

function allMemberIds(input: ApplyFilingPlanYearInput): readonly string[] {
  return input.members.map((m) => m.memberId);
}

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
 * Applies the per-year engines across a projection year's resolved tax units and rolls the results up to the household. No
 * units (or a multi-unit year whose roles cannot be partitioned onto real member ids) takes the legacy single-status
 * `applyTaxYear`, so nothing is silently dropped while the UI prompts for a resolution. One unit (individual, joint, survivor,
 * bounded QSS/HoH window) is one `applyTaxYear` with the unit's status and household size and its own IRMAA look-back, so a
 * survivor is not tiered on the last two-return year's merged MAGI. Two units (a separate couple) run the full engine per unit
 * on its own members, accounts, attributed income and look-back, then `mergeUnitResults`: each return gets its own bracket
 * table, §86 base (including the MFS lived-together zero base), ACA eligibility (MFS = $0, §36B(c)(1)(C)), IRMAA tier and RMD
 * floor. A future year never throws UnsupportedTaxYearError, as each call inherits `applyTaxYear`'s clamping.
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
    // The roles cannot be partitioned onto real member ids (absent or partial `memberIdByRole`); per-unit computing would give
    // both returns the whole household and double-count the RMD floor, §72(t) penalty and Medicare beneficiaries, so use the
    // legacy single-status path, exact for the household total.
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
  // A user SLCSP override goes to whichever return may claim the credit: MFS is ineligible (§36B(c)(1)(C)), so it lands whole on
  // the single eligible return, and divides between two eligible (HoH) returns.
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
      // An owner in no unit (a data gap) is reported on the first unit's return rather than dropped, so their RMD, penalty and member row reach the total exactly once.
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
  // Each return's own surcharge, so the cashflow solver withholds the right amount from each spouse's SS when the returns land on different tiers.
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
