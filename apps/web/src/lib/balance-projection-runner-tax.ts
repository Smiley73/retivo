/**
 * Tax-integration post-pass for the deterministic runner: calls `applyTaxYear` for each drawdown year to
 * annotate `DrawdownYear` with the tax fields, and builds the tax-cashflow hook the drawdown engine funds tax
 * through.
 * See `docs/math-taxes.md`.
 */

import type {
  DrawdownAccountInput,
  DrawdownYear,
  TaxCashflowHook,
  TaxCashflowYearClassification,
  TaxCashflowYearOutcome,
} from './drawdown-engine-types';
import type { PipelineContext, SsRunRateRow } from './balance-projection-runner-types';
import type { MonthlyIncomeRow } from './balance-projection-bundle';
import { deriveFilingStatus, resolveFilingPlanForYear } from './filing-status';
import type { FilingPlanResolution, ResolvedTaxUnit } from './filing-status';
import type { FilingStatus } from './federal-tax';
import {
  buildFilingPlanContextForYear,
  hasAttainedAgeByYearEnd,
} from './balance-projection-runner-tax-helpers';
import {
  applyTaxYear,
  applyTaxYearForFilingPlan,
  bootstrapLookbackRing,
  dollarsToCents,
  resolveAssumedTaxableYieldConfig,
  type ApplyFilingPlanYearInput,
  type BootstrapLookbackUnit,
  type FilingUnitMagi,
  type OwnerAttributedAmounts,
  type TaxCalibrationBundle,
  type TaxAccountSnapshot,
  type PenaltyAccountSnapshot,
  type TaxMemberInput,
  type TaxYearInput,
} from './tax-integration';
import {
  anyMemberOnMedicare,
  storedAcaBenchmarkOverrides,
} from './tax-integration-helpers';
import { solveTaxCashflow, solveFillConversion } from './tax-cashflow-solver';
import { sumYearCents } from './credit-applied-to-premiums';
import {
  advanceBrokerageLikeBasis,
  buildAccountSnapshotsFromPriorYear,
  buildBrokerageLikeYearAccounts,
  buildCashLikeYearAccounts,
  buildMemberInputs,
  buildPenaltyAccountsForYear,
  brokerageStartBalanceByOwner,
  buildSolverPenaltyAccountsForYear,
  computeCashLikeInterestByOwner,
  computeCashLikeInterestDollars,
  countTaxpayersAge65Plus,
  derivePerAccountRmdShortfallCents,
  grossSsForYear,
  otherOrdinaryIncomeForYear,
  ownSsByMemberForYear,
  resolveHouseholdDeathYears,
  solverDesignatedRothBalanceCentsByOwner,
  splitWithdrawalsByTaxTreatment,
  type BrokerageLikeBasisState,
} from './balance-projection-runner-tax-helpers';
import { stampZeroConversionPoint } from './balance-projection-runner-tax-zero-point';
import {
  applyRothBasisOrdering,
  creditRothConversionToBasisCarrier,
  seedFactBasedRothBasisCarrier,
  seedDesignatedRothCarrier,
  mergeFactBasedRothIraSeeds,
  flattenRothIraPoolsByOwner,
  mergeDesignatedRothSeeds,
  type DesignatedRothCarrier,
  seedSolverDesignatedRothStates,
  seedSolverInheritedDesignatedRothStates,
  type RothBasisCarrier,
} from './balance-projection-runner-roth-basis';

export { TaxIntegrationInvalidInputError } from './tax-integration';

// One projection year's resolved filing facts.
interface YearFilingResolution {
  /**
   * Resolved tax units, or `undefined` when the legacy scalar cannot be converted, which keeps the legacy
   * scalar path.
   */
  readonly taxUnits: readonly ResolvedTaxUnit[] | undefined;
  /** Household role → member id, so a unit's roles map onto the member rows. */
  readonly memberIdByRole: { readonly primary?: string; readonly secondary?: string };
  /** §86(c)(1)(C)(ii): MFS spouses lived together during the year. */
  readonly mfsLivedWithSpouse: boolean;
  /**
   * The returns filed two years ago, one per tax unit, each unit reading its own look-back return so separate
   * returns tier on their own MAGI and a survivor on the joint return filed. Empty in the two bootstrap
   * years.
   */
  readonly irmaaLookbackUnits: readonly FilingUnitMagi[];
  /**
   * The returns filed in a bootstrap look-back year that had more than one, paired with the household
   * bootstrap MAGI to rebuild the per-return ring so each spouse tiers on their own schedule. Absent for a
   * single-return look-back.
   */
  readonly bootstrapLookbackUnits: readonly BootstrapLookbackUnit[] | undefined;
  /** Legacy fallback: the single look-back status a year with no resolvable units tiers on. */
  readonly irmaaLookbackFilingStatus: FilingStatus | undefined;
  readonly irmaaLookbackMfsLivedWithSpouse: boolean | undefined;
}

/**
 * One buffered projection year of the per-tax-unit IRMAA look-back ring: index `i` holds the returns filed in
 * year `i`.
 */
type FilingUnitRingEntry = readonly FilingUnitMagi[] | undefined;

interface TaxYearBuildArgs {
  readonly taxYear: number;
  /** Legacy scalar-derived status, used when `filing.taxUnits` is absent. */
  readonly filingStatus: ReturnType<typeof deriveFilingStatus>;
  readonly filing: YearFilingResolution;
  /**
   * Each member's own gross SS for the year, so a `separate` couple's returns carry only their own benefit
   * (§86, Pub 555).
   */
  readonly ownSsDollarsByMemberId: Readonly<Record<string, number>>;
  /** Member ids that attain age 65 by year end (IRS born-Jan-1 rule). */
  readonly age65PlusMemberIds: readonly string[];
  /**
   * Owner-attributed withdrawal, income and balance dollars, so a `separate` couple's returns each report
   * what they own.
   */
  readonly ownerAttributedAmounts: OwnerAttributedAmounts;
  readonly grossSsDollars: number;
  readonly preTax: number;
  readonly postTaxNonRoth: number;
  readonly postTaxCashLike: number;
  readonly roth: number;
  readonly otherOrdinaryIncomeDollars: number;
  readonly accounts: readonly TaxAccountSnapshot[];
  readonly members: readonly TaxMemberInput[];
  readonly householdSize: number;
  readonly magiTwoYearsPriorDollars: number | undefined;
  readonly acaBenchmarkSlcspDollars: number | undefined;
  /** The scenario's FPL region for the ACA denominator; `undefined` means contiguous 48 states plus DC. */
  readonly acaFplRegion: import('./aca-ptc').AcaFplRegion | undefined;
  readonly taxpayersAge65Plus: number;
  readonly costBasisFraction: number;
  /**
   * Brokerage-like (POST_TAX BROKERAGE/OTHER) balance at year start, the yield-drag base; 0 when unknown
   * (solver pre-commit path).
   */
  readonly brokerageLikeStartBalanceDollars: number;
  /**
   * Annual ordinary taxable interest from cash-like accounts (HSA excluded); 0 when unknown (solver
   * pre-commit path).
   */
  readonly cashInterestDollars: number;
  readonly inflationRatePct: number;
  readonly medicalInflationRatePct: number;
  readonly hsaQualifiedMedicalExpensePct: number;
  readonly earlyWithdrawalPenaltyExemptAccountIds: readonly string[];
  readonly penaltyAccounts: readonly PenaltyAccountSnapshot[];
}

function buildTaxYearInput(args: TaxYearBuildArgs): ApplyFilingPlanYearInput {
  return {
    taxYear: args.taxYear,
    // Resolved units drive the filing status; `filingStatus` is the fallback for an unresolved scalar.
    filingStatus: args.filingStatus,
    taxUnits: args.filing.taxUnits,
    memberIdByRole: args.filing.memberIdByRole,
    grossSsDollarsByMemberId: args.ownSsDollarsByMemberId,
    age65PlusMemberIds: args.age65PlusMemberIds,
    ownerAttributedAmounts: args.ownerAttributedAmounts,
    mfsLivedWithSpouse: args.filing.mfsLivedWithSpouse,
    // Bootstrap-year ring entries are rebuilt from the look-back year's own returns and this year's household
    // bootstrap MAGI, so both spouses never share one IRMAA schedule.
    irmaaLookbackUnits:
      args.filing.irmaaLookbackUnits.length > 0
        ? args.filing.irmaaLookbackUnits
        : (bootstrapLookbackRing(
            args.filing.bootstrapLookbackUnits,
            args.magiTwoYearsPriorDollars,
          ) ?? args.filing.irmaaLookbackUnits),
    irmaaLookbackFilingStatus: args.filing.irmaaLookbackFilingStatus,
    irmaaLookbackMfsLivedWithSpouse: args.filing.irmaaLookbackMfsLivedWithSpouse,
    grossSsDollars: args.grossSsDollars,
    preTaxWithdrawalDollars: args.preTax,
    postTaxNonRothWithdrawalDollars: args.postTaxNonRoth,
    postTaxCashLikeWithdrawalDollars: args.postTaxCashLike,
    rothWithdrawalDollars: args.roth,
    otherOrdinaryIncomeDollars: args.otherOrdinaryIncomeDollars,
    taxExemptInterestDollars: 0, // muni interest modeled as zero; see BalanceProjectionEstimateNote.tsx
    assumedCostBasisFraction: args.costBasisFraction,
    brokerageLikeStartBalanceDollars: args.brokerageLikeStartBalanceDollars,
    cashInterestDollars: args.cashInterestDollars,
    householdSize: args.householdSize,
    members: args.members,
    accounts: args.accounts,
    magiTwoYearsPriorDollars: args.magiTwoYearsPriorDollars,
    acaBenchmarkSlcspDollars: args.acaBenchmarkSlcspDollars,
    acaFplRegion: args.acaFplRegion,
    taxpayersAge65Plus: args.taxpayersAge65Plus,
    inflationRatePct: args.inflationRatePct,
    medicalInflationRatePct: args.medicalInflationRatePct,
    hsaQualifiedMedicalExpensePct: args.hsaQualifiedMedicalExpensePct,
    earlyWithdrawalPenaltyExemptAccountIds: args.earlyWithdrawalPenaltyExemptAccountIds,
    penaltyAccounts: args.penaltyAccounts,
  };
}

// An args object rather than eight positional parameters, to avoid silent argument swaps.
interface AnnotateYearArgs {
  readonly ctx: PipelineContext;
  readonly year: DrawdownYear;
  readonly result: ReturnType<typeof applyTaxYear>;
  readonly preTaxDollars: number;
  readonly grossSsDollars: number;
  readonly postTaxNonRothDollars: number;
  readonly postTaxCashLikeDollars: number;
  /**
   * True when the plan models no medical spending; with a charged IRMAA surcharge it means the base Medicare
   * premium is missing.
   */
  readonly noMedicalSpendingModeled: boolean;
}

function annotateYearWithTaxResult(args: AnnotateYearArgs): void {
  const {
    ctx,
    year,
    result,
    preTaxDollars,
    grossSsDollars,
    postTaxNonRothDollars,
    postTaxCashLikeDollars,
    noMedicalSpendingModeled,
  } = args;
  const rmdFloorCents = result.rmdFloorCents;
  // Prefer the per-account RMD shortfall so one account's missed RMD surfaces even when another's overshoot
  // would net it to $0; falls back to the household figure on the bucket-allocation path.
  const perAccountShortfallCents = derivePerAccountRmdShortfallCents(
    ctx,
    year,
    result.rmdPerAccountCents,
  );
  const preTaxWithdrawnCents = dollarsToCents(preTaxDollars);
  // In the household fallback the QCD is debited from the IRA pre-tax bucket yet counts toward the IRA RMD
  // (§408(d)(8)), so credit the owner IRA-pool offsets to avoid a phantom shortfall.
  const qcdOffsetCents = Object.values(year.qcdRmdOffsetCentsByOwner ?? {}).reduce(
    (sum, c) => sum + Math.max(0, c),
    0,
  );
  const rmdShortfallCents =
    perAccountShortfallCents ??
    Math.max(0, rmdFloorCents - preTaxWithdrawnCents - qcdOffsetCents);
  const netAfterTaxCents = Math.max(
    0,
    dollarsToCents(grossSsDollars + preTaxDollars + postTaxNonRothDollars + postTaxCashLikeDollars)
      - result.federalTaxCents - result.irmaaSurchargeCents + result.acaPtcSubsidyCents,
  );

  year.federalTaxCents = result.federalTaxCents;
  year.taxableSsCents = result.taxableSsCents;
  year.ssTaxationTier = result.ssTaxationTier;
  year.rmdFloorCents = rmdFloorCents;
  year.rmdShortfallCents = rmdShortfallCents;
  // Display-only per-account RMD decomposition of `rmdFloorCents`, stamped only here in the deterministic
  // post-pass (never on the engine, kernel or MC paths, so no `ENGINE_VERSION` bump); present once an owner
  // reached their trigger age, absent before.
  if (result.rmdApplicable) {
    year.perAccountRmdCents = { ...result.rmdPerAccountCents };
  }
  // Surplus disposition fields are engine-set; `?? 0` defaults only the unmodeled paths and preserves any
  // engine value.
  year.rmdReinvestedCents = year.rmdReinvestedCents ?? 0;
  year.rmdOverflowToCashCents = year.rmdOverflowToCashCents ?? 0;
  year.irmaaSurchargeCents = result.irmaaSurchargeCents;
  year.irmaaTier = result.irmaaTier;
  // Readiness warning: an IRMAA surcharge with no modeled medical spending means the base Medicare premium
  // (user-entered) is missing. Only that case is flagged, since a plan with medical spending may already
  // include it.
  if (result.irmaaSurchargeCents > 0 && noMedicalSpendingModeled) {
    year.medicareBasePremiumMissing = true;
  }
  year.acaPtcSubsidyCents = result.acaPtcSubsidyCents;
  year.acaPtcTier = result.acaPtcTier;
  year.magiCents = result.magiCents;
  year.fplPercentage = result.fplPercentage;
  year.effectiveTaxRate = result.effectiveTaxRate;
  year.netAfterTaxCents = netAfterTaxCents;
  year.taxYearExtrapolated = result.taxYearExtrapolated;
  year.earlyWithdrawalPenaltyCents = result.earlyWithdrawalPenaltyCents;
  year.hsaAdditionalTaxCents = result.hsaAdditionalTaxCents;
  year.penaltySkippedForMissingBirthdate = result.penaltySkippedForMissingBirthdate;
  // Engine RMD disclosures are stamped only when reported, so a fact-free household's rows are unchanged.
  if ((result.rmdWithheldAccounts?.length ?? 0) > 0) {
    year.rmdWithheldAccountIds = result.rmdWithheldAccounts!.map((w) => w.accountId);
  }
  if ((result.rmdStillWorkingDeferredAccountIds?.length ?? 0) > 0) {
    year.rmdStillWorkingDeferredAccountIds = [
      ...result.rmdStillWorkingDeferredAccountIds!,
    ];
  }
  if ((result.rmdFirstYearDeferrals?.length ?? 0) > 0) {
    year.rmdFirstYearDeferredAccountIds = result.rmdFirstYearDeferrals!.map(
      (d) => d.accountId,
    );
  }
  if ((result.rmdDeferredCatchUpCents ?? 0) > 0) {
    year.rmdDeferredCatchUpCents = result.rmdDeferredCatchUpCents;
  }
}

interface TaxLoopShared {
  readonly ctx: PipelineContext;
  readonly ssRows: ReadonlyArray<SsRunRateRow>;
  readonly nonSsIncomeRows: ReadonlyArray<MonthlyIncomeRow>;
  readonly ledgerAccounts: ReadonlyArray<DrawdownAccountInput>;
  readonly bundle: TaxCalibrationBundle;
  /**
   * Seed cost-basis fraction (`assumedCostBasisFractionOfTaxableWithdrawal ?? 0.5`); the post-pass evolves a
   * per-account basis from it and the solver uses it statically.
   */
  readonly seedBasisFraction: number;
  /** Stored MAGI bootstrap for projection year 0 (MAGI(ret-2)). */
  readonly magiBootstrapMinus2: number | undefined;
  /** Stored MAGI bootstrap for projection year 1 (MAGI(ret-1)). */
  readonly magiBootstrapMinus1: number | undefined;
  readonly acaPtcBenchmarkOverrides: ReadonlyArray<{ taxYear: number; annualSlcspDollars: number }>;
  readonly inflationRatePct: number;
  readonly medicalInflationRatePct: number;
  readonly hsaQualifiedMedicalExpensePct: number;
  readonly earlyWithdrawalPenaltyExemptAccountIds: readonly string[];
  readonly primaryDeathYear: number;
  readonly secondaryDeathYear: number;
  /**
   * Per-calendar-year rolled-CBP RMD ordinary income (dollars) from linked-CBP lump-sums landing in or after
   * the source owner's RMD trigger year; taxed once (the cash leg is added to the income series upstream).
   * Empty when no split fired.
   */
  readonly rolledRmdIncomeByYear: ReadonlyMap<number, number>;
  /**
   * True when the plan models no medical spending; optional because only the annotation post-pass consumes
   * it, and absent never raises the readiness flag.
   */
  readonly noMedicalSpendingModeled?: boolean;
}

// Resolved IRMAA look-back for one projection year; `estimatedFromProjection` marks the years 0-1 estimate
// from `magiBuffer[0]` for a Medicare member with no stored bootstrap.
interface MagiLookbackResolution {
  readonly value: number | undefined;
  readonly estimatedFromProjection: boolean;
}

function storedBootstrapForYear(
  i: number,
  minus2: number | undefined,
  minus1: number | undefined,
): number | undefined {
  if (i === 0) return minus2;
  if (i === 1) return minus1;
  return undefined;
}

// Resolves `magiTwoYearsPriorDollars` for year `i`: the rolling buffer entry for `i >= 2`, the stored
// bootstrap for years 0-1, or for a Medicare member with none the projected year-0 MAGI (flagged). Year 0's
// own MAGI is unknown until a first compute, which `processTaxYear` handles with a recompute.
function magiLookback(args: {
  i: number;
  magiBuffer: number[];
  minus2: number | undefined;
  minus1: number | undefined;
  onMedicareThisYear: boolean;
  estimatedYear0Magi: number | undefined;
}): MagiLookbackResolution {
  const { i, magiBuffer, minus2, minus1, onMedicareThisYear, estimatedYear0Magi } = args;
  if (i >= 2) return { value: magiBuffer[i - 2], estimatedFromProjection: false };
  const stored = storedBootstrapForYear(i, minus2, minus1);
  if (stored !== undefined) return { value: stored, estimatedFromProjection: false };
  // The flag fires even when the estimate is $0 (below-floor fallback), so the disclosure always shows.
  if (onMedicareThisYear && estimatedYear0Magi !== undefined) {
    return { value: estimatedYear0Magi, estimatedFromProjection: true };
  }
  return { value: undefined, estimatedFromProjection: false };
}

// `result` is null below the calibration floor (no modelable tax); the caller skips annotation but counts the
// year as processed.
interface YearTaxComputation {
  result: ReturnType<typeof applyTaxYear> | null;
  estimatedFromProjection: boolean;
}

// MAGI look-back stepping and tax compute for one year: resolves the two-year-prior MAGI, runs
// `applyTaxYear`, recomputes year 0 on its own MAGI when on Medicare with no stored bootstrap, and handles
// the below-floor fallback. Always appends this year's MAGI sample so the IRMAA ring stays index-aligned.
function computeYearTaxWithMagiLookback(args: {
  i: number;
  magiBuffer: number[];
  shared: TaxLoopShared;
  onMedicareThisYear: boolean;
  buildInput: (magiTwoYearsPriorDollars: number | undefined) => ApplyFilingPlanYearInput;
}): YearTaxComputation {
  const { i, magiBuffer, shared, onMedicareThisYear, buildInput } = args;
  // Year 0's own MAGI is known only after a first compute, so year 0 recomputes below and its first pass has
  // no estimate.
  const estimatedYear0Magi = i === 1 ? magiBuffer[0] : undefined;
  const lookback = magiLookback({
    i,
    magiBuffer,
    minus2: shared.magiBootstrapMinus2,
    minus1: shared.magiBootstrapMinus1,
    onMedicareThisYear,
    estimatedYear0Magi,
  });

  let result: ReturnType<typeof applyTaxYear>;
  let estimatedFromProjection = lookback.estimatedFromProjection;
  try {
    result = applyTaxYearForFilingPlan(buildInput(lookback.value), shared.bundle);
    // Year-0 recompute: the lookback estimate is this year's own MAGI, from the first compute (IRMAA
    // skipped).
    if (
      i === 0 &&
      onMedicareThisYear &&
      shared.magiBootstrapMinus2 === undefined &&
      !estimatedFromProjection
    ) {
      const estimate = result.magiCents / 100;
      result = applyTaxYearForFilingPlan(buildInput(estimate), shared.bundle);
      estimatedFromProjection = true;
    }
  } catch (err) {
    // A year below the calibration floor has no modelable tax: skip annotation but advance the buffer so the
    // look-back stays index-aligned.
    if (isUnsupportedTaxYear(err)) {
      magiBuffer.push(0);
      // Below-floor fallback: the estimate is $0 (IRMAA skipped) but the disclosure flag still fires.
      const flagBelowFloorEstimate =
        i <= 1 &&
        onMedicareThisYear &&
        storedBootstrapForYear(i, shared.magiBootstrapMinus2, shared.magiBootstrapMinus1) ===
          undefined;
      return { result: null, estimatedFromProjection: flagBelowFloorEstimate };
    }
    throw err;
  }
  magiBuffer.push(result.magiCents / 100);
  return { result, estimatedFromProjection };
}

// Per-year body of `applyTaxIntegrationToDrawdownYears`; mutates `year` and appends a MAGI sample. Returns
// false when no member is alive.
function processTaxYear(
  year: DrawdownYear,
  i: number,
  years: ReadonlyArray<DrawdownYear>,
  shared: TaxLoopShared,
  magiBuffer: number[],
  unitRing: FilingUnitRingEntry[],
  rothBasisCarrier: RothBasisCarrier,
  /** Account-keyed designated-Roth carrier (pro-rata regime), mutated in place across the year loop. */
  designatedRothCarrier: DesignatedRothCarrier,
  basisState: BrokerageLikeBasisState,
): boolean {
  const { ctx, primaryDeathYear, secondaryDeathYear } = shared;
  const taxYear = year.year;
  const primaryAlive = taxYear <= primaryDeathYear;
  const secondaryAlive = ctx.secondary !== undefined && taxYear <= secondaryDeathYear;
  const members = buildMemberInputs(ctx, taxYear, primaryAlive, secondaryAlive);
  if (members.length === 0) return false;
  const filingStatus = deriveFilingStatus({
    primaryAlive,
    secondaryAlive,
    filingStatusOverride: ctx.resolvedScenario.filingStatus ?? undefined,
  });
  // `taxUnits === undefined` is the legacy branch: an unresolvable scalar keeps `filingStatus`.
  const filing = resolveYearFiling({
    ctx,
    taxYear,
    yearIndex: i,
    primaryAlive,
    secondaryAlive,
    primaryDeathYear,
    secondaryDeathYear,
    unitRing,
  });
  const grossSsDollars = grossSsForYear(shared.ssRows, taxYear);
  const withdrawalSplit = splitWithdrawalsByTaxTreatment(ctx, year);
  const { preTax, postTaxNonRoth, postTaxCashLike, roth } = withdrawalSplit;
  const priorYear = i > 0 ? years[i - 1] : undefined;
  // The year two before this one sizes a first-year-deferral catch-up; absent in the first two years, where
  // the engine reports a blocker instead of guessing.
  const priorPriorYear = i > 1 ? years[i - 2] : undefined;
  const accounts = buildAccountSnapshotsFromPriorYear(
    ctx,
    priorYear,
    shared.ledgerAccounts,
    priorPriorYear,
  );
  // Advance each brokerage-like account's cost basis with this year's contributions and reinvested yield
  // before the withdrawal, take the pre-withdrawal fraction for the LTCG gain, then deplete basis.
  const assumedYieldPct = resolveAssumedTaxableYieldConfig(
    shared.bundle.assumedTaxableYield,
    taxYear,
  ).totalYieldPct;
  const brokerageYearAccounts = buildBrokerageLikeYearAccounts(ctx, year, priorYear, shared.ledgerAccounts);
  const { startBalanceDollars, preWithdrawalBasisFraction } = advanceBrokerageLikeBasis(
    brokerageYearAccounts,
    basisState,
    assumedYieldPct,
  );
  // Cash-like interest (HSA excluded, tax-free) via the same helper as `monte-carlo-tax-burden.ts`; both
  // engines' funded tax deliberately omits this component.
  const cashLikeYearAccounts = buildCashLikeYearAccounts(ctx, year, priorYear, shared.ledgerAccounts);
  const cashInterestDollars = computeCashLikeInterestDollars(cashLikeYearAccounts);
  // The owner behind each dollar, so a `separate` couple's returns report what they own.
  const ownerAttributedAmounts: OwnerAttributedAmounts = {
    preTaxWithdrawalDollars: withdrawalSplit.byOwner.preTax,
    postTaxNonRothWithdrawalDollars: withdrawalSplit.byOwner.postTaxNonRoth,
    postTaxCashLikeWithdrawalDollars: withdrawalSplit.byOwner.postTaxCashLike,
    rothWithdrawalDollars: withdrawalSplit.byOwner.roth,
    cashInterestDollars: computeCashLikeInterestByOwner(cashLikeYearAccounts),
    brokerageLikeStartBalanceDollars: brokerageStartBalanceByOwner(brokerageYearAccounts),
  };
  const acaOverride = shared.acaPtcBenchmarkOverrides.find((o) => o.taxYear === taxYear);
  // The look-back gate uses the month-aware predicate the IRMAA surcharge gate uses; the whole-year
  // `onMedicare` boolean would let a surcharge be skipped with no look-back MAGI and no disclosure.
  const onMedicareThisYear = anyMemberOnMedicare(members);
  // Cumulative owner-level §408A ordering: basis is consumed first, and the earnings excess is ordinary
  // income and feeds the Roth earnings penalty (10% pre-59½). Computed once, outside `buildInput`, since it
  // is MAGI-independent and the carrier mutation must run once per year.
  const rothSplit = applyRothBasisOrdering(
    ctx,
    year,
    rothBasisCarrier,
    designatedRothCarrier,
  );

  const buildInput = (magiTwoYearsPriorDollars: number | undefined): ApplyFilingPlanYearInput =>
    buildTaxYearInput({
      taxYear,
      filingStatus,
      filing,
      ownSsDollarsByMemberId: ownSsByMemberForYear(
        shared.ssRows,
        taxYear,
        ctx.primary.id,
        ctx.secondary?.id,
      ),
      age65PlusMemberIds: age65PlusMemberIdsForYear(ctx, taxYear, primaryAlive, secondaryAlive),
      ownerAttributedAmounts,
      grossSsDollars,
      preTax,
      postTaxNonRoth,
      postTaxCashLike,
      roth,
      // Roth earnings excess folds into ordinary income, and a Fill-mode conversion adds ordinary income too
      // (raising both MAGIs, NIIT and the senior-bonus phase-out); it is not a distribution, so it is absent
      // from `penaltyAccounts` and the §72(t) penalty.
      otherOrdinaryIncomeDollars:
        otherOrdinaryIncomeForYear(shared.nonSsIncomeRows, taxYear) +
        rothSplit.earningsExcessDollars +
        (year.rothConvertedCents ?? 0) / 100 +
        // The rollover-year RMD is ordinary income taxed once here; the rolled-CBP source is excluded from
        // the ledger, so the forced-RMD reconciliation never counts it.
        (shared.rolledRmdIncomeByYear.get(taxYear) ?? 0),
      accounts,
      members,
      householdSize: members.length,
      magiTwoYearsPriorDollars,
      acaBenchmarkSlcspDollars: acaOverride?.annualSlcspDollars,
      // Alaska and Hawaii use their own, higher HHS poverty guidelines.
      acaFplRegion: ctx.acaFplRegion,
      taxpayersAge65Plus: countTaxpayersAge65Plus(ctx, taxYear, primaryAlive, secondaryAlive),
      costBasisFraction: preWithdrawalBasisFraction,
      brokerageLikeStartBalanceDollars: startBalanceDollars,
      cashInterestDollars,
      inflationRatePct: shared.inflationRatePct,
      medicalInflationRatePct: shared.medicalInflationRatePct,
      hsaQualifiedMedicalExpensePct: shared.hsaQualifiedMedicalExpensePct,
      earlyWithdrawalPenaltyExemptAccountIds: shared.earlyWithdrawalPenaltyExemptAccountIds,
      penaltyAccounts: [...buildPenaltyAccountsForYear(ctx, year), ...rothSplit.penaltyAccounts],
    });

  const computed = computeYearTaxWithMagiLookback({
    i,
    magiBuffer,
    shared,
    onMedicareThisYear,
    buildInput,
  });
  // Buffer this year's returns so the year-two-later surcharge tiers every return on its own look-back; a
  // below-floor year buffers an empty list.
  unitRing[i] = computed.result?.filingUnitMagi ?? [];
  if (computed.estimatedFromProjection) year.magiEstimatedFromProjection = true;
  // Credit converted principal after `applyRothBasisOrdering` drew down basis, since converted dollars land
  // at year end and are basis only for later years; runs on the below-floor path too.
  creditRothConversionToBasisCarrier(ctx, year, rothBasisCarrier);
  // Below the calibration floor the year still counts as processed; the MAGI ring already advanced with $0.
  if (computed.result === null) return true;
  annotateYearWithTaxResult({
    ctx,
    year,
    result: computed.result,
    preTaxDollars: preTax,
    grossSsDollars,
    postTaxNonRothDollars: postTaxNonRoth,
    postTaxCashLikeDollars: postTaxCashLike,
    noMedicalSpendingModeled: shared.noMedicalSpendingModeled === true,
  });
  return true;
}

// Shared error `code` of every engine's `UnsupportedTaxYearError`: a year below the calibration floor has no
// modelable tax.
function isUnsupportedTaxYear(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'UNSUPPORTED_TAX_YEAR'
  );
}

/**
 * Applies tax integration to all drawdown years in place, setting the optional tax fields (federalTaxCents,
 * taxableSsCents, and so on) on each `DrawdownYear`.
 */
export function applyTaxIntegrationToDrawdownYears(
  years: DrawdownYear[],
  ssRows: ReadonlyArray<SsRunRateRow>,
  nonSsIncomeRows: ReadonlyArray<MonthlyIncomeRow>,
  ledgerAccounts: ReadonlyArray<DrawdownAccountInput>,
  ctx: PipelineContext,
  bundle: TaxCalibrationBundle,
  /** Per-calendar-year rolled-CBP RMD ordinary income (dollars). */
  rolledRmdIncomeByYear: ReadonlyMap<number, number> = new Map(),
  /**
   * True when the plan models any medical spending (`CashflowSeries.anyMedicalSpendingModeled`); its negation
   * with a charged IRMAA surcharge raises the missing-base-Medicare-premium flag. It is the full `isMedical`
   * inventory, not the HSA-qualified demand, because Medicare, Medigap and drug-plan premiums are never
   * HSA-qualified (§223(d)(2)(C)(iv)).
   * Omitted means the caller has no expense inventory; only an explicit `false` raises the flag.
   */
  anyMedicalSpendingModeled?: boolean,
): void {
  const resolved = ctx.resolvedScenario;
  const deathYears = resolveHouseholdDeathYears(ctx);
  const seedBasisFraction = resolved.assumedCostBasisFractionOfTaxableWithdrawal ?? 0.5;
  const noMedicalSpendingModeled = anyMedicalSpendingModeled === false;
  const shared: TaxLoopShared = {
    ctx,
    ssRows,
    nonSsIncomeRows,
    ledgerAccounts,
    bundle,
    seedBasisFraction,
    magiBootstrapMinus2: resolved.magiBootstrapLookbackMinus2,
    magiBootstrapMinus1: resolved.magiBootstrapLookbackMinus1,
    // The stored array comes from an envelope-only-validated aggregate, so the shared enumerator shape-checks
    // it: a non-array import cannot throw the projection and a malformed row cannot price a benchmark.
    acaPtcBenchmarkOverrides: storedAcaBenchmarkOverrides(resolved.acaPtcBenchmark),
    inflationRatePct: ctx.projCtx.inflationPct,
    medicalInflationRatePct: ctx.medicalInflationRatePct,
    hsaQualifiedMedicalExpensePct: resolved.hsaQualifiedMedicalExpensePct ?? 100,
    earlyWithdrawalPenaltyExemptAccountIds: resolved.earlyWithdrawalPenaltyExemptAccountIds ?? [],
    // Shared derivation with the MC twin (`resolveHouseholdDeathYears`); no derivable death year maps to
    // `Infinity` (alive), never `NaN`, which made a member with a malformed imported birthdate dead every
    // year on this engine only.
    primaryDeathYear: deathYears.primaryDeathYear ?? Infinity,
    secondaryDeathYear: deathYears.secondaryDeathYear ?? Infinity,
    rolledRmdIncomeByYear,
    noMedicalSpendingModeled,
  };
  // Index `i` holds year `i`'s MAGI; IRMAA for year `i` uses `magiBuffer[i - 2]`.
  const magiBuffer: number[] = [];
  // The parallel per-tax-unit look-back ring: IRMAA for year `i` reads `unitRing[i - 2]`, so each return is
  // tiered on the return it filed two years earlier and separate returns never share a MAGI or tier ladder.
  const unitRing: FilingUnitRingEntry[] = [];
  // Fact-based §408A carriers, seeded once per run: the owner-keyed carrier holds remaining Roth-IRA basis
  // and conversion lots (contributions first, lots FIFO with their own clocks), and the account-keyed
  // designated carrier holds each employer plan's own basis, clock and rollover lots (pro rata, never
  // pooled); one pooled carrier seeded from balances would treat a whole projected Roth balance as basis. The
  // working-years conversion basis is deterministic-only.
  const rothBasisCarrier = seedFactBasedRothBasisCarrier(
    mergeFactBasedRothIraSeeds(
      // Pool-keyed: an owner's own Roth IRAs share one entry, and an inherited Roth IRA contributes no pool
      // and no carrier entry, since its dollars are tax-free.
      ctx.rothDistributionFacts.rothIraByPool,
      ctx.preRetirementConversionBasisCentsByOwner,
      // Dated, so each engine-generated conversion becomes a lot with its own five-tax-year §408A(d)(3)(F)
      // recapture window.
      ctx.preRetirementConversionBasisCentsByOwnerYear,
    ),
  );
  const designatedRothCarrier = seedDesignatedRothCarrier(
    mergeDesignatedRothSeeds(
      ctx.rothDistributionFacts.designatedByAccount,
      ctx.mixedInPlanConversionBasisCentsByAccount,
      // Dated in-plan rollover lots (§402A(c)(4)(D) recapture windows).
      ctx.mixedInPlanConversionBasisCentsByAccountYear,
    ),
  );
  // Per-account cost-basis accumulator carried across years (grows with reinvested yield and contributions,
  // depletes on withdrawal).
  const basisState: BrokerageLikeBasisState = {
    basisByAccountId: new Map<string, number>(),
    seedBasisFraction,
  };
  for (let i = 0; i < years.length; i += 1) {
    // Repriced without its conversion on copies of the state; the row's own pass is unchanged.
    stampZeroConversionPoint(years[i], (copy) =>
      processTaxYear(copy, i, years, shared, [...magiBuffer], [...unitRing],
        structuredClone(rothBasisCarrier), structuredClone(designatedRothCarrier), structuredClone(basisState)));
    const processed = processTaxYear(
      years[i],
      i,
      years,
      shared,
      magiBuffer,
      unitRing,
      rothBasisCarrier,
      designatedRothCarrier,
      basisState,
    );
    // A skipped year (no alive members) still pushes 0 so the `i - 2` look-back stays aligned; zero MAGI is
    // the right IRMAA basis for a dead year.
    if (!processed) magiBuffer.push(0);
  }
}

/**
 * Resolves a projection year's filing plan into tax units from the pipeline context: one unit for a joint,
 * survivor or individual year, two for a `separate` couple, or `unresolved` when the legacy scalar cannot be
 * safely converted (the caller keeps the scalar path and the editor prompts the user). The stored
 * `taxFilingPlan` supersedes the legacy scalar.
 */
export function resolveTaxUnitsForYear(
  ctx: PipelineContext,
  taxYear: number,
  primaryAlive: boolean,
  secondaryAlive: boolean,
): FilingPlanResolution {
  return resolveFilingPlanForYear({
    ...buildFilingPlanContextForYear(ctx, taxYear, primaryAlive, secondaryAlive),
    taxFilingPlan: ctx.resolvedScenario.taxFilingPlan,
  });
}

// Filing status of the return filed in `taxYear`, for a year the projection never simulated. Years 0-1 tier
// IRMAA on pre-projection returns, so without this the engine would use the current year's status while MC
// resolves `taxYear - 2`'s own plan, tiering a surviving spouse differently on the two engines. A two-return
// year (separate filers) is also reported per unit.
function resolveBootstrapLookbackFiling(
  ctx: PipelineContext,
  lookbackYear: number,
  primaryDeathYear: number,
  secondaryDeathYear: number,
): {
  status: FilingStatus;
  mfsLivedWithSpouse: boolean;
  units: readonly BootstrapLookbackUnit[] | undefined;
} {
  const primaryAlive = lookbackYear <= primaryDeathYear;
  const secondaryAlive = ctx.secondary !== undefined && lookbackYear <= secondaryDeathYear;
  const resolution = resolveTaxUnitsForYear(ctx, lookbackYear, primaryAlive, secondaryAlive);
  const units =
    resolution.kind === 'resolved' && resolution.taxUnits.length > 0
      ? resolution.taxUnits
      : undefined;
  const plan = ctx.resolvedScenario.taxFilingPlan;
  const mfsLivedWithSpouse =
    plan?.kind === 'separate' && (units?.length ?? 0) > 1 && plan.livedTogether === true;
  const memberIdByRole = { primary: ctx.primary.id, secondary: ctx.secondary?.id };
  return {
    status:
      units?.[0]?.filingStatus ??
      deriveFilingStatus({
        primaryAlive,
        secondaryAlive,
        filingStatusOverride: ctx.resolvedScenario.filingStatus ?? undefined,
      }),
    mfsLivedWithSpouse,
    units:
      units === undefined || units.length < 2
        ? undefined
        : units.map((unit) => ({
            memberIds: unit.memberIds
              .map((role) => memberIdByRole[role])
              .filter((id): id is string => id !== undefined),
            filingStatus: unit.filingStatus,
            mfsLivedWithSpouse: unit.filingStatus === 'MFS' && mfsLivedWithSpouse,
          })),
  };
}

// Resolves one year's filing facts and reads the two-year look-back returns from the per-unit ring. Never
// throws: an unresolved plan gives `taxUnits: undefined`, the legacy scalar path.
function resolveYearFiling(args: {
  ctx: PipelineContext;
  taxYear: number;
  yearIndex: number;
  primaryAlive: boolean;
  secondaryAlive: boolean;
  primaryDeathYear: number;
  secondaryDeathYear: number;
  unitRing: FilingUnitRingEntry[];
}): YearFilingResolution {
  const { ctx, taxYear, yearIndex, primaryAlive, secondaryAlive, unitRing } = args;
  const resolution = resolveTaxUnitsForYear(ctx, taxYear, primaryAlive, secondaryAlive);
  const taxUnits =
    resolution.kind === 'resolved' && resolution.taxUnits.length > 0
      ? resolution.taxUnits
      : undefined;
  const plan = ctx.resolvedScenario.taxFilingPlan;
  // The lived-together fact is couple-level on the `separate` plan and meaningful only while both spouses are
  // alive and filing separately.
  const mfsLivedWithSpouse =
    plan?.kind === 'separate' && (taxUnits?.length ?? 0) > 1 && plan.livedTogether === true;
  const lookbackUnits = (yearIndex >= 2 ? unitRing[yearIndex - 2] : undefined) ?? [];
  // Years 0-1 have no ring entry; resolve the pre-projection look-back year's own return instead of
  // inheriting this year's status.
  const bootstrapLookback =
    yearIndex >= 2
      ? undefined
      : resolveBootstrapLookbackFiling(
          ctx,
          taxYear - 2,
          args.primaryDeathYear,
          args.secondaryDeathYear,
        );
  return {
    taxUnits,
    memberIdByRole: { primary: ctx.primary.id, secondary: ctx.secondary?.id },
    mfsLivedWithSpouse,
    irmaaLookbackUnits: lookbackUnits,
    // A two-return bootstrap look-back is rebuilt per return in `buildTaxYearInput`, where the year's
    // household bootstrap MAGI becomes available.
    bootstrapLookbackUnits: bootstrapLookback?.units,
    // Legacy single-status look-back; a resolved year reads `irmaaLookbackUnits` per return.
    irmaaLookbackFilingStatus: lookbackUnits[0]?.filingStatus ?? bootstrapLookback?.status,
    irmaaLookbackMfsLivedWithSpouse:
      lookbackUnits[0]?.mfsLivedWithSpouse ?? bootstrapLookback?.mfsLivedWithSpouse,
  };
}

/**
 * Member ids that attain age 65 by the end of `taxYear` (IRS born-Jan-1 rule), so the age add-on and senior
 * bonus land on the return that claims them.
 */
export function age65PlusMemberIdsForYear(
  ctx: PipelineContext,
  taxYear: number,
  primaryAlive: boolean,
  secondaryAlive: boolean,
): string[] {
  const ids: string[] = [];
  if (primaryAlive && hasAttainedAgeByYearEnd(ctx.primary.payload.birthdate, taxYear, 65)) {
    ids.push(ctx.primary.id);
  }
  if (
    ctx.secondary &&
    secondaryAlive &&
    hasAttainedAgeByYearEnd(ctx.secondary.payload.birthdate, taxYear, 65)
  ) {
    ids.push(ctx.secondary.id);
  }
  return ids;
}

function buildTaxLoopShared(
  ctx: PipelineContext,
  ssRows: TaxLoopShared['ssRows'],
  nonSsIncomeRows: ReadonlyArray<MonthlyIncomeRow>,
  ledgerAccounts: ReadonlyArray<DrawdownAccountInput>,
  bundle: TaxCalibrationBundle,
  rolledRmdIncomeByYear: ReadonlyMap<number, number> = new Map(),
): TaxLoopShared {
  const resolved = ctx.resolvedScenario;
  const deathYears = resolveHouseholdDeathYears(ctx);
  return {
    ctx,
    ssRows,
    nonSsIncomeRows,
    ledgerAccounts,
    bundle,
    seedBasisFraction: resolved.assumedCostBasisFractionOfTaxableWithdrawal ?? 0.5,
    magiBootstrapMinus2: resolved.magiBootstrapLookbackMinus2,
    magiBootstrapMinus1: resolved.magiBootstrapLookbackMinus1,
    // The stored array comes from an envelope-only-validated aggregate; the shared enumerator shape-checks
    // it.
    acaPtcBenchmarkOverrides: storedAcaBenchmarkOverrides(resolved.acaPtcBenchmark),
    inflationRatePct: ctx.projCtx.inflationPct,
    medicalInflationRatePct: ctx.medicalInflationRatePct,
    hsaQualifiedMedicalExpensePct: resolved.hsaQualifiedMedicalExpensePct ?? 100,
    earlyWithdrawalPenaltyExemptAccountIds: resolved.earlyWithdrawalPenaltyExemptAccountIds ?? [],
    // Shared derivation with the MC twin; no derivable death year maps to `Infinity` (alive), never `NaN`.
    primaryDeathYear: deathYears.primaryDeathYear ?? Infinity,
    secondaryDeathYear: deathYears.secondaryDeathYear ?? Infinity,
    rolledRmdIncomeByYear,
    // Only the annotation post-pass consumes this; the funding hook omits it.
  };
}

// Zero-need outcome for a dead year, which funds no tax.
function emptyTaxOutcome(): TaxCashflowYearOutcome {
  return {
    addedNeedDollars: 0,
    federalTaxCashNeedCents: 0,
    irmaaWithheldFromSsCents: 0,
    irmaaCashNeedCents: 0,
    acaPtcCashflowOffsetCents: 0,
    acaCreditAppliedToPremiumsCents: 0,
    totalTaxCashflowNeedCents: 0,
    taxCashflowIterations: 0,
    taxCashflowConverged: true,
    taxCashflowShortfallCents: 0,
  };
}

// Per-year solver input assembled by `buildSolverYearInput`.
interface SolverYearInput {
  readonly taxInputBase: ApplyFilingPlanYearInput;
  /**
   * Each member's own annual SS by member id, the per-member IRMAA-withholding source; a Medicare member
   * absent from the map has no own SS, so the surcharge is a full cash need.
   */
  readonly ownSsDollarsByMemberId: Readonly<Record<string, number>>;
}

// Assembles the per-year tax input with classification fields zeroed (the solver overwrites them each pass);
// `null` when no member is alive, pushing the MAGI sample to keep the look-back aligned. Resolves the same
// filing plan as the post-pass, so funded balances and displayed tax agree.
function buildSolverYearInput(
  ctx: PipelineContext,
  shared: TaxLoopShared,
  yearIndex: number,
  taxYear: number,
  magiBuffer: number[],
  unitRing: FilingUnitRingEntry[],
): SolverYearInput | null {
  const primaryAlive = taxYear <= shared.primaryDeathYear;
  const secondaryAlive = ctx.secondary !== undefined && taxYear <= shared.secondaryDeathYear;
  const members = buildMemberInputs(ctx, taxYear, primaryAlive, secondaryAlive);
  if (members.length === 0) {
    magiBuffer.push(0);
    return null;
  }
  const filingStatus = deriveFilingStatus({
    primaryAlive,
    secondaryAlive,
    filingStatusOverride: ctx.resolvedScenario.filingStatus ?? undefined,
  });
  const filing = resolveYearFiling({
    ctx,
    taxYear,
    yearIndex,
    primaryAlive,
    secondaryAlive,
    primaryDeathYear: shared.primaryDeathYear,
    secondaryDeathYear: shared.secondaryDeathYear,
    unitRing,
  });
  const grossSsDollars = grossSsForYear(shared.ssRows, taxYear);
  const ownSsDollarsByMemberId = ownSsByMemberForYear(
    shared.ssRows,
    taxYear,
    ctx.primary.id,
    ctx.secondary?.id,
  );
  const acaOverride = shared.acaPtcBenchmarkOverrides.find((o) => o.taxYear === taxYear);
  const taxInputBase = buildTaxYearInput({
    taxYear,
    filingStatus,
    filing,
    ownSsDollarsByMemberId,
    age65PlusMemberIds: age65PlusMemberIdsForYear(ctx, taxYear, primaryAlive, secondaryAlive),
    // The funding solver has no committed per-account split yet, so a separate-filing year funds on the even
    // split and the post-pass reports the exact owner-attributed figures. Gross SS is attributed here because
    // it comes from the SS series.
    ownerAttributedAmounts: {},
    grossSsDollars,
    preTax: 0,
    postTaxNonRoth: 0,
    postTaxCashLike: 0,
    roth: 0,
    otherOrdinaryIncomeDollars:
      otherOrdinaryIncomeForYear(shared.nonSsIncomeRows, taxYear) +
      // Fund the rollover-year RMD's incremental tax in the same year.
      (shared.rolledRmdIncomeByYear.get(taxYear) ?? 0),
    accounts: [],
    members,
    householdSize: members.length,
    // The funding solver estimates year-1 IRMAA from its own `magiBuffer[0]` but funds $0 for year 0 (its own
    // MAGI is unknown before the fixpoint converges, and feeding it back would break the contraction
    // guarantee); the authoritative year-0 estimate and disclosure live in `processTaxYear`.
    magiTwoYearsPriorDollars: magiLookback({
      i: yearIndex,
      magiBuffer,
      minus2: shared.magiBootstrapMinus2,
      minus1: shared.magiBootstrapMinus1,
      onMedicareThisYear: anyMemberOnMedicare(members),
      estimatedYear0Magi: yearIndex === 1 ? magiBuffer[0] : undefined,
    }).value,
    acaBenchmarkSlcspDollars: acaOverride?.annualSlcspDollars,
    // Same FPL region as the annotation pass.
    acaFplRegion: ctx.acaFplRegion,
    taxpayersAge65Plus: countTaxpayersAge65Plus(ctx, taxYear, primaryAlive, secondaryAlive),
    // The solver runs before the committing draw, so it uses the static seed basis fraction, a $0 yield base
    // and $0 cash-like interest (an approximation); the post-pass applies them exactly.
    costBasisFraction: shared.seedBasisFraction,
    brokerageLikeStartBalanceDollars: 0,
    cashInterestDollars: 0,
    inflationRatePct: shared.inflationRatePct,
    medicalInflationRatePct: shared.medicalInflationRatePct,
    hsaQualifiedMedicalExpensePct: shared.hsaQualifiedMedicalExpensePct,
    earlyWithdrawalPenaltyExemptAccountIds: shared.earlyWithdrawalPenaltyExemptAccountIds,
    // Pass 1 leaves `penaltyAccounts` empty (federal tax and IRMAA only); pass 2 in `solveForYear` builds the
    // penalty inputs from pass 1's committed classification. The post-pass owns the exact displayed penalty.
    penaltyAccounts: [],
  });
  return { taxInputBase, ownSsDollarsByMemberId };
}

// Maps a solver result to the engine outcome. `addedNeedDollars` is the cash tax need plus the IRMAA withheld
// from SS: the withheld surcharge shrinks the SS check while the income series spends gross SS, so the
// portfolio covers it, counted once here. Its draw is also taxed (the solver folds it into the trial target),
// and the premium credit is subtracted, so the add-on can be negative.
function toTaxCashflowOutcome(
  result: ReturnType<typeof solveTaxCashflow>,
): TaxCashflowYearOutcome {
  return {
    addedNeedDollars:
      (result.totalTaxCashflowNeedCents +
        result.irmaaWithheldFromSsCents -
        result.acaCreditAppliedToPremiumsCents) /
      100,
    federalTaxCashNeedCents: result.federalTaxCashNeedCents,
    irmaaWithheldFromSsCents: result.irmaaWithheldFromSsCents,
    irmaaCashNeedCents: result.irmaaCashNeedCents,
    acaPtcCashflowOffsetCents: result.acaPtcCashflowOffsetCents,
    acaCreditAppliedToPremiumsCents: result.acaCreditAppliedToPremiumsCents,
    totalTaxCashflowNeedCents: result.totalTaxCashflowNeedCents,
    taxCashflowIterations: result.taxCashflowIterations,
    taxCashflowConverged: result.taxCashflowConverged,
    taxCashflowShortfallCents: result.taxCashflowShortfallCents,
  };
}

/**
 * Builds the `TaxCashflowHook` the drawdown engine calls once per year to fund federal tax and the IRMAA cash
 * portion (minus the ACA PTC offset) into the withdrawal target, for every named strategy.
 * The hook owns a rolling MAGI buffer for the IRMAA two-year look-back and passes empty `accounts` to the
 * solver, since the RMD-display floor does not change the cashflow need; RMD display fields belong to the
 * annotation post-pass.
 */
export function buildTaxCashflowHook(args: {
  readonly ctx: PipelineContext;
  readonly ssRows: TaxLoopShared['ssRows'];
  readonly nonSsIncomeRows: ReadonlyArray<MonthlyIncomeRow>;
  readonly ledgerAccounts: ReadonlyArray<DrawdownAccountInput>;
  readonly bundle: TaxCalibrationBundle;
  readonly retirementYear: number;
  /** Per-calendar-year rolled-CBP RMD ordinary income (dollars). */
  readonly rolledRmdIncomeByYear?: ReadonlyMap<number, number>;
  /**
   * Monthly modeled Medical expenses (every `isMedical` row), integer cents, aligned to (retirementYear,
   * January); absent applies no credit.
   */
  readonly medicalExpenseByMonthCents?: ReadonlyArray<number>;
}): TaxCashflowHook {
  const { ctx, ssRows, nonSsIncomeRows, ledgerAccounts, bundle, retirementYear } = args;
  const shared = buildTaxLoopShared(
    ctx,
    ssRows,
    nonSsIncomeRows,
    ledgerAccounts,
    bundle,
    args.rolledRmdIncomeByYear ?? new Map(),
  );
  const magiBuffer: number[] = [];
  // The funding pass keeps its own filing-status ring, in lockstep with its `magiBuffer`, so its IRMAA
  // look-back matches the post-pass.
  const unitRing: FilingUnitRingEntry[] = [];
  // The funding pass's own §408A carrier, an independent copy seeded from the same facts as the post-pass
  // carrier and owner-keyed (`flattenRothIraPoolsByOwner`). It holds §408A material only: designated-Roth
  // basis stays on the pooled designated state, so a Roth-IRA draw never consumes a designated plan's
  // rollover lots nor the reverse; inherited designated plans use their own pooled state (§402A(d)(2)(B)(i),
  // §72(t)(2)(A)(ii)).
  const rothBasisCarrier = seedFactBasedRothBasisCarrier(
    mergeFactBasedRothIraSeeds(
      flattenRothIraPoolsByOwner(ctx.rothDistributionFacts.rothIraByPool),
      ctx.preRetirementConversionBasisCentsByOwner,
      // Conversion principal stays dated here, matching the annotation carrier's §408A(d)(3)(F) recapture
      // windows.
      ctx.preRetirementConversionBasisCentsByOwnerYear,
    ),
  );
  // The pooled designated-Roth state (basis, dated rollover lots with §402A(c)(4)(D) windows, clock, running
  // balance) seeds from the same merged per-account facts as the annotation carrier, so the funded recapture
  // equals the reported one.
  const designatedSeedFacts = mergeDesignatedRothSeeds(
    ctx.rothDistributionFacts.designatedByAccount,
    ctx.mixedInPlanConversionBasisCentsByAccount,
    ctx.mixedInPlanConversionBasisCentsByAccountYear,
  );
  const solverDesignatedRoth = seedSolverDesignatedRothStates(
    designatedSeedFacts,
    solverDesignatedRothBalanceCentsByOwner(ctx, ledgerAccounts),
  );
  // The inherited pooled companion, entries flagged `inheritedFromDeceasedOwner: true`, fed by the inherited
  // classifier subset.
  const solverInheritedDesignatedRoth = seedSolverInheritedDesignatedRothStates(
    designatedSeedFacts,
    solverDesignatedRothBalanceCentsByOwner(ctx, ledgerAccounts, true),
  );

  const solveForYear = (
    yearIndex: number,
    ordinaryNetNeedDollars: number,
    classify: (target: number) => TaxCashflowYearClassification,
  ): TaxCashflowYearOutcome => {
    const taxYear = retirementYear + yearIndex;
    const yearInput = buildSolverYearInput(
      ctx,
      shared,
      yearIndex,
      taxYear,
      magiBuffer,
      unitRing,
    );
    if (yearInput === null) return emptyTaxOutcome();
    const medicalExpenseCents = sumYearCents(args.medicalExpenseByMonthCents ?? [], yearIndex);
    // Hybrid IRMAA: each Medicare member's surcharge is withheld only from that member's own SS (CMS
    // per-beneficiary collection); a member with no own SS owes full cash.
    // Two-pass penalty funding: pass 1 solves with no penalty inputs; pass 2 builds them from that committed
    // split and re-solves, and is skipped when no penalizable basis exists.
    const pass1 = solveTaxCashflow({
      ordinaryNetNeedDollars,
      taxInputBase: yearInput.taxInputBase,
      bundle,
      irmaaPayment: { ownSsDollarsByMemberId: yearInput.ownSsDollarsByMemberId },
      classifyForTarget: classify,
      medicalExpenseCents,
    });
    // The committed classification covers the draw before the premium credit lowers it
    // (`ordinaryNetNeed + totalTaxCashflowNeed + irmaaWithheldFromSs`); omitting the withheld cents would
    // understate the Roth and penalty basis in withheld-IRMAA years.
    const committedTarget =
      ordinaryNetNeedDollars +
      (pass1.totalTaxCashflowNeedCents + pass1.irmaaWithheldFromSsCents) / 100;
    const committedSplit = classify(committedTarget);
    const { penaltyAccounts, rothEarningsExcessDollars } = buildSolverPenaltyAccountsForYear({
      ctx,
      taxYear,
      ledgerAccounts,
      classification: committedSplit,
      rothBasisCarrier,
      designatedRoth: solverDesignatedRoth,
      inheritedDesignatedRoth: solverInheritedDesignatedRoth,
    });
    // Pass 2 runs when either leg produced something: taxable Roth excess with no penalty snapshot (an owner
    // past 59½) would otherwise go unfunded.
    const result =
      penaltyAccounts.length === 0 && rothEarningsExcessDollars === 0
        ? pass1
        : solveTaxCashflow({
            ordinaryNetNeedDollars,
            taxInputBase: {
              ...yearInput.taxInputBase,
              otherOrdinaryIncomeDollars:
                yearInput.taxInputBase.otherOrdinaryIncomeDollars + rothEarningsExcessDollars,
              penaltyAccounts,
            },
            bundle,
            irmaaPayment: { ownSsDollarsByMemberId: yearInput.ownSsDollarsByMemberId },
            classifyForTarget: classify,
            medicalExpenseCents,
            rothEarningsIncomeDollars: rothEarningsExcessDollars,
          });
    magiBuffer.push(result.taxYearResult.magiCents / 100);
    // The funding solver's ring runs in lockstep with its MAGI buffer, so funded and displayed IRMAA tier on
    // the same return.
    unitRing[yearIndex] = result.taxYearResult.filingUnitMagi ?? [];
    return toTaxCashflowOutcome(result);
  };

  // Fill-mode conversion solve: builds the year's tax input with the committed withdrawal classification and
  // runs the outer bisection against the selected MAGI line. The conversion is added ordinary income, never
  // folded into `preTaxWithdrawalDollars` (not a distribution, so outside the §72(t) basis). Side-effect-free
  // via a throwaway ring copy.
  // The funding carrier is not credited: the committed `rothConvertedCents` can differ, and the post-pass
  // credits the authoritative carrier.
  const solveFillConversionForYear = (
    yearIndex: number,
    withdrawalClassification: TaxCashflowYearClassification,
    convertibleRoomDollars: number,
    capMagiLine: 'irmaa' | 'aca',
    magiCeilingDollars: number,
  ): number => {
    if (convertibleRoomDollars <= 0) return 0;
    const taxYear = retirementYear + yearIndex;
    // Use a snapshot of the look-back ring and the per-unit ring, since `solveForYear` already advanced them
    // for this year.
    const yearInput = buildSolverYearInput(
      ctx,
      shared,
      yearIndex,
      taxYear,
      [...magiBuffer],
      [...unitRing],
    );
    if (yearInput === null) return 0;
    // Bake in the committed withdrawal classification so the bisection's MAGI at conv=0 reflects the year's
    // actual withdrawals.
    const taxInputBase: ApplyFilingPlanYearInput = {
      ...yearInput.taxInputBase,
      preTaxWithdrawalDollars: withdrawalClassification.preTaxDollars,
      postTaxNonRothWithdrawalDollars: withdrawalClassification.postTaxNonRothDollars,
      postTaxCashLikeWithdrawalDollars: withdrawalClassification.postTaxCashLikeDollars,
      rothWithdrawalDollars: withdrawalClassification.rothDollars,
    };
    const { convertedDollars } = solveFillConversion({
      taxInputBase,
      bundle,
      capMagiLine,
      magiCeilingDollars,
      convertibleRoomDollars,
    });
    return convertedDollars;
  };

  // Funds the conversion's same-year incremental ordinary-income tax: the conversion-inclusive funding solve
  // minus the withdrawals-only solve, composed as `toTaxCashflowOutcome` does. The funding draw is cap-safe
  // (MAGI-free), so one incremental solve is exact.
  // It replaces the year's live IRMAA look-back MAGI sample with the conversion-inclusive one, so the Y+2
  // surcharge is funded, not just displayed.
  const fundConversionTaxForYear = (
    yearIndex: number,
    withdrawalClassification: TaxCashflowYearClassification,
    convertedDollars: number,
  ): number => {
    if (convertedDollars <= 0) return 0;
    const taxYear = retirementYear + yearIndex;
    // Snapshot the rings (`solveForYear` already advanced them) so both funding solves see the same look-back
    // MAGI.
    const yearInput = buildSolverYearInput(
      ctx,
      shared,
      yearIndex,
      taxYear,
      [...magiBuffer],
      [...unitRing],
    );
    if (yearInput === null) return 0;
    const baseTaxInput: TaxYearInput = {
      ...yearInput.taxInputBase,
      preTaxWithdrawalDollars: withdrawalClassification.preTaxDollars,
      postTaxNonRothWithdrawalDollars: withdrawalClassification.postTaxNonRothDollars,
      postTaxCashLikeWithdrawalDollars: withdrawalClassification.postTaxCashLikeDollars,
      rothWithdrawalDollars: withdrawalClassification.rothDollars,
    };
    // Only the federal/IRMAA line need is fundable cash; ACA-line Fill controls premium subsidy, whose effect
    // is already in the withdrawals-only solve. Funding the federal/IRMAA increment either way is the true
    // same-year cash cost.
    const fundingNeedCents = (input: TaxYearInput): number => {
      const r = solveTaxCashflow({
        ordinaryNetNeedDollars: 0,
        taxInputBase: input,
        bundle,
        irmaaPayment: { ownSsDollarsByMemberId: yearInput.ownSsDollarsByMemberId },
        // Conversion and withdrawals are baked into the input and the funding draw is cap-safe, so the
        // classifier reports the fixed split for any trial target.
        classifyForTarget: () => {
          const pre = input.preTaxWithdrawalDollars ?? 0;
          const postNonRoth = input.postTaxNonRothWithdrawalDollars ?? 0;
          const postCashLike = input.postTaxCashLikeWithdrawalDollars ?? 0;
          const roth = input.rothWithdrawalDollars ?? 0;
          return {
            preTaxDollars: pre,
            postTaxNonRothDollars: postNonRoth,
            postTaxCashLikeDollars: postCashLike,
            rothDollars: roth,
            fundedDollars: pre + postNonRoth + postCashLike + roth,
          };
        },
      });
      return r.totalTaxCashflowNeedCents + r.irmaaWithheldFromSsCents;
    };
    const withoutConvCents = fundingNeedCents(baseTaxInput);
    const withConvInput: ApplyFilingPlanYearInput = {
      ...baseTaxInput,
      otherOrdinaryIncomeDollars: baseTaxInput.otherOrdinaryIncomeDollars + convertedDollars,
    };
    const withConvCents = fundingNeedCents(withConvInput);
    // Make the live look-back buffer conversion-inclusive so Y+2 IRMAA is funded, replacing the conv=0 sample
    // in both the MAGI sample and the per-return ring entries.
    const convInclusiveResult = applyTaxYearForFilingPlan(withConvInput, bundle);
    const convInclusiveMagi = convInclusiveResult.magiCents / 100;
    if (magiBuffer.length > 0) magiBuffer[magiBuffer.length - 1] = convInclusiveMagi;
    unitRing[yearIndex] = convInclusiveResult.filingUnitMagi ?? [];
    return Math.max(0, withConvCents - withoutConvCents) / 100;
  };

  return {
    recordsConversionZeroPoint: true,
    solveForYear,
    solveFillConversionForYear,
    fundConversionTaxForYear,
  };
}
