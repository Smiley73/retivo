/**
 * Tax-integration post-pass for the deterministic balance-projection
 * runner. Walks the drawdown years emitted by `simulateDrawdown` and
 * calls `applyTaxYear` from `tax-integration.ts` for each year,
 * annotating `DrawdownYear` with the 15 optional tax fields.
 *
 * The post-pass runs for EVERY named
 * strategy. The per-account engine builds an `accountBalances` map, so the
 * post-pass classifies the COMMITTED per-account split by its real tax
 * treatment. Only the bucket-allocation path (no `accountBalances` map) falls
 * back to all-pre-tax inside `splitWithdrawalsByTaxTreatment`. Every drawdown
 * row carries the 15 display tax fields.
 *
 * MAGI look-back:
 *   - Year 0 of drawdown: use `magiBootstrapLookbackMinus2` (= MAGI(ret−2))
 *     when provided. Year 1: use `magiBootstrapLookbackMinus1` (= MAGI(ret−1)).
 *   - When a member is on Medicare in projection year 0 or 1 and the
 *     scenario stores NO bootstrap value for that lookback year, ESTIMATE the
 *     lookback MAGI from the engine's own projected year-0 MAGI
 *     (`magiBuffer[0]`, built from resolved income streams + SS + drawdown) and
 *     set the per-year `magiEstimatedFromProjection` disclosure flag. When the
 *     engine cannot produce a year-0 MAGI (below the calibration floor) the
 *     estimate falls back to $0 but the disclosure flag STILL fires.
 *   - Year 2+: use the MAGI computed in the year 2 years prior.
 *
 * RMD prior-year balance (rmd engine):
 *   - Year 0: use the per-account balances at retirement from the
 *     drawdown ledger input (approximated from ledger.accounts).
 *   - Year 1+: use `DrawdownYear.accountBalances` from the prior year.
 *
 * Helper extraction: `buildMemberInputs`,
 * `buildAccountSnapshotsFromPriorYear`, `splitWithdrawalsByTaxTreatment`,
 * `otherOrdinaryIncomeForYear`, `grossSsForYear`, `resolveHouseholdDeathYears`,
 * `countTaxpayersAge65Plus` live in
 * `./balance-projection-runner-tax-helpers`.
 *
 * SHAPE-LIMIT EXCEPTION (recorded justification; CODING_STANDARDS ≤ 800 lines):
 * this file is over the 800-line limit. Why: it is the deterministic tax
 * post-pass — the year loop and the per-year solver wiring run in sequence over
 * the same `TaxYearInput` / MAGI-lookback state, and the chokepoint
 * `computeYearTaxWithMagiLookback` already consolidates the per-year tax
 * computation so the loop body stays thin. The pure helpers already live in the
 * sibling `balance-projection-runner-tax-helpers.ts` (`buildMemberInputs`,
 * `splitWithdrawalsByTaxTreatment`, the SS / death-year / age-65 helpers), so
 * the clean seam is taken; what remains threads the rolling MAGI buffer and
 * prior-year RMD balances through the loop, which a split would re-export.
 * The per-tax-unit filing-status pass-through (including the separate-return
 * and surviving-spouse statuses) and the annual cash-like interest ride the
 * same per-year loop and `TaxYearBuildArgs` seam, with the same rolling
 * MAGI-buffer / prior-year-RMD state and no new seam, so this stays a single
 * cohesive deterministic tax post-pass. The credit applied to premiums is only
 * wired here: the hook sums the year's Medical expenses and hands them to the
 * solver, which computes the line through `credit-applied-to-premiums.ts`. Recorded future split path: when next
 * touched, lift the per-year solver loop (and its MAGI-buffer threading) into a
 * sibling module driven by `computeYearTaxWithMagiLookback`. Trigger: a change
 * adding 5 or more lines here must either refactor the file back under the
 * limit or re-justify this exception in this note.
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

// Re-export the base tax-integration validation error for runner callers.
export { TaxIntegrationInvalidInputError } from './tax-integration';

// ---------------------------------------------------------------------------
// Filing-plan resolution per projection year
// ---------------------------------------------------------------------------

/** One projection year's resolved filing facts. */
interface YearFilingResolution {
  /** Resolved tax units, or `undefined` when the plan could not be resolved
   *  from a legacy scalar — the branch that keeps the legacy scalar path. */
  readonly taxUnits: readonly ResolvedTaxUnit[] | undefined;
  /** Household role → member id, so a unit's roles map onto the member rows. */
  readonly memberIdByRole: { readonly primary?: string; readonly secondary?: string };
  /** §86(c)(1)(C)(ii) — MFS spouses lived together during the year. */
  readonly mfsLivedWithSpouse: boolean;
  /** The returns filed TWO YEARS AGO, one entry per tax unit. Each
   *  of this year's units reads its OWN look-back return out of this list, so
   *  two separate returns land on their own MAGI and their own tier schedule
   *  and a survivor is tiered on the joint return they actually filed. Empty
   *  in the two bootstrap years (the ring has no entry yet). */
  readonly irmaaLookbackUnits: readonly FilingUnitMagi[];
  /** The returns the household filed in a BOOTSTRAP look-back year (a
   *  pre-projection year the ring has no entry for), when that year had MORE
   *  THAN ONE return. `buildTaxYearInput` pairs them with the year's household
   *  bootstrap MAGI to rebuild the per-return ring, so a mixed `MFS`+`HoH`
   *  couple's first two projection years tier each spouse on their OWN schedule
   *  exactly as every later year does. Absent for a single-return look-back —
   *  the `irmaaLookbackFilingStatus` scalar below already says the same thing. */
  readonly bootstrapLookbackUnits: readonly BootstrapLookbackUnit[] | undefined;
  /** Legacy fallback only — the single look-back status a year with NO
   *  resolvable units tiers on. */
  readonly irmaaLookbackFilingStatus: FilingStatus | undefined;
  readonly irmaaLookbackMfsLivedWithSpouse: boolean | undefined;
}

/** One buffered projection year of the per-tax-unit IRMAA look-back ring
 *  Index `i` holds the returns filed in projection year `i`. */
type FilingUnitRingEntry = readonly FilingUnitMagi[] | undefined;

/** Args for `buildTaxYearInput`. */
interface TaxYearBuildArgs {
  readonly taxYear: number;
  /** Legacy scalar-derived status — the fallback used when `filing.taxUnits`
   *  is absent (an unresolvable legacy scalar conversion). */
  readonly filingStatus: ReturnType<typeof deriveFilingStatus>;
  /** The year's resolved filing facts. */
  readonly filing: YearFilingResolution;
  /** Each member's OWN gross SS for the year, so a `separate` couple's
   *  two returns carry only their own benefit (§86 / IRS Pub 555). */
  readonly ownSsDollarsByMemberId: Readonly<Record<string, number>>;
  /** Member ids that attain age 65 by year end (IRS born-Jan-1 rule). */
  readonly age65PlusMemberIds: readonly string[];
  /** Owner-attributed withdrawal / income / balance dollars, so a
   *  `separate` couple's two returns each report what they actually own. */
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
  /** The scenario's federal-poverty-level region for the ACA FPL
   *  denominator. `undefined` → contiguous 48 states + DC. */
  readonly acaFplRegion: import('./aca-ptc').AcaFplRegion | undefined;
  readonly taxpayersAge65Plus: number;
  readonly costBasisFraction: number;
  /** Brokerage-like (POST_TAX BROKERAGE/OTHER) balance at the start of the
   *  year — the yield-drag base. 0 when unknown (solver pre-commit path). */
  readonly brokerageLikeStartBalanceDollars: number;
  /** Annual ordinary taxable interest from cash-like accounts
   *  (savings/money-market/CD realized growth; HSA excluded). 0 when unknown
   *  (solver pre-commit path — same documented approximation). */
  readonly cashInterestDollars: number;
  readonly inflationRatePct: number;
  readonly medicalInflationRatePct: number;
  readonly hsaQualifiedMedicalExpensePct: number;
  readonly earlyWithdrawalPenaltyExemptAccountIds: readonly string[];
  readonly penaltyAccounts: readonly PenaltyAccountSnapshot[];
}

/** Assemble the per-year tax input for a single projection year. */
function buildTaxYearInput(args: TaxYearBuildArgs): ApplyFilingPlanYearInput {
  return {
    taxYear: args.taxYear,
    // The resolved units drive the filing status when the plan resolved;
    // `filingStatus` remains the legacy fallback for an unresolved scalar.
    filingStatus: args.filingStatus,
    taxUnits: args.filing.taxUnits,
    memberIdByRole: args.filing.memberIdByRole,
    grossSsDollarsByMemberId: args.ownSsDollarsByMemberId,
    age65PlusMemberIds: args.age65PlusMemberIds,
    ownerAttributedAmounts: args.ownerAttributedAmounts,
    mfsLivedWithSpouse: args.filing.mfsLivedWithSpouse,
    // Covers the simulated years and the two bootstrap years, whose ring entry
    // is rebuilt from the look-back year's own returns + this year's household
    // bootstrap MAGI so both spouses never share one spouse's IRMAA schedule.
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

/** Arguments to `annotateYearWithTaxResult` (an args object rather than
 *  eight positional parameters ending in a boolean after four numbers, which
 *  made a silent argument swap easy). */
interface AnnotateYearArgs {
  readonly ctx: PipelineContext;
  readonly year: DrawdownYear;
  readonly result: ReturnType<typeof applyTaxYear>;
  readonly preTaxDollars: number;
  readonly grossSsDollars: number;
  readonly postTaxNonRothDollars: number;
  readonly postTaxCashLikeDollars: number;
  /** True when the plan models NO medical spending at all
   *  (`shared.noMedicalSpendingModeled`). Combined with a charged IRMAA
   *  surcharge it means the base Medicare premium is missing. */
  readonly noMedicalSpendingModeled: boolean;
}

/** Mutate a `DrawdownYear` with all 15 tax fields from `TaxYearResult`. */
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
  // Prefer the per-account RMD shortfall (`rmdPerAccountCents`) so a
  // single account's missed RMD surfaces even when household netting (account A
  // overshooting masks account B's miss) would report $0. Falls back to the
  // household-level `max(0, rmdFloorCents − totalPreTaxWithdrawn)` when the
  // per-account map / `accountBalances` is unavailable (bucket-allocation path).
  const perAccountShortfallCents = derivePerAccountRmdShortfallCents(
    ctx,
    year,
    result.rmdPerAccountCents,
  );
  const preTaxWithdrawnCents = dollarsToCents(preTaxDollars);
  // In the household fallback the QCD is debited directly to the IRA
  // pre-tax bucket (not part of `preTaxDollars`) yet COUNTS TOWARD the IRA RMD
  // (§408(d)(8)). Credit the total per-owner IRA-pool offset toward the floor so
  // an over-RMD QCD year shows no phantom shortfall. (The per-account path above
  // already scopes the credit to each owner's IRA pool; this fallback runs only
  // on the bucket-allocation path, which the QCD engine does not currently feed,
  // so the offset is typically absent — credited here for correctness parity.)
  const qcdOffsetCents = Object.values(year.qcdRmdOffsetCentsByOwner ?? {}).reduce(
    (sum, c) => sum + Math.max(0, c),
    0,
  );
  const rmdShortfallCents =
    perAccountShortfallCents ??
    Math.max(0, rmdFloorCents - preTaxWithdrawnCents - qcdOffsetCents);
  // netAfterTaxCents: gross income (SS + pre-tax + post-tax-non-roth +
  // post-tax-cash-like return-of-principal) minus taxes plus PTC. Cash-like
  // dollars are tax-free spendable income so they belong in the gross.
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
  // Display-only decomposition of `rmdFloorCents`: stamp the per-account
  // required RMD the RMD pre-pass already computed (`result.rmdPerAccountCents`,
  // BOTH owners merged — ids are unique across owners) so the Withdrawal
  // Guidance page can present the RMD by legal aggregation group. Present (a
  // possibly-empty `{}` at a $0 floor) when ≥ 1 owner reached their trigger age;
  // left ABSENT below every owner's trigger age. Stamped ONLY here in the
  // deterministic post-pass — never on the strategy-engine / kernel / MC paths —
  // so it never serializes into the MC capture (no ENGINE_VERSION bump).
  if (result.rmdApplicable) {
    year.perAccountRmdCents = { ...result.rmdPerAccountCents };
  }
  // Surplus disposition fields are ENGINE-set (per-account strategy path); the
  // post-pass must not clobber them. `?? 0` defaults the unmodeled paths
  // (bucket-allocation) to 0 while preserving any non-zero value the engine stamped.
  year.rmdReinvestedCents = year.rmdReinvestedCents ?? 0;
  year.rmdOverflowToCashCents = year.rmdOverflowToCashCents ?? 0;
  year.irmaaSurchargeCents = result.irmaaSurchargeCents;
  year.irmaaTier = result.irmaaTier;
  // Readiness warning: an IRMAA surcharge is being charged while
  // the plan models no medical spending anywhere, so the base Medicare premium
  // (a user-entered medical expense, never modeled) is missing and the plan
  // understates retirement health costs. Only the affirmatively-missing case is
  // flagged; a plan that DOES record medical spending is left alone, since the
  // projection cannot tell whether that amount includes the premium.
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
  // Carry the engine's own RMD disclosures onto the row so the
  // Projected-withdrawals page can state them in plain English. Each is stamped
  // only when the engine reported something, so a fact-free household's rows are
  // unchanged (and nothing new serializes on a $0-disclosure year).
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

/** Shared per-year-loop context — fixed across the entire run. */
interface TaxLoopShared {
  readonly ctx: PipelineContext;
  readonly ssRows: ReadonlyArray<SsRunRateRow>;
  readonly nonSsIncomeRows: ReadonlyArray<MonthlyIncomeRow>;
  readonly ledgerAccounts: ReadonlyArray<DrawdownAccountInput>;
  readonly bundle: TaxCalibrationBundle;
  /** Seed cost-basis fraction (`assumedCostBasisFractionOfTaxableWithdrawal ??
   *  0.5`). The post-pass evolves a per-account basis from this seed; the
   *  solver path uses it statically (no per-account balance pre-commit). */
  readonly seedBasisFraction: number;
  /** Stored MAGI bootstrap for projection year 0 (= MAGI(ret−2)). */
  readonly magiBootstrapMinus2: number | undefined;
  /** Stored MAGI bootstrap for projection year 1 (= MAGI(ret−1)). */
  readonly magiBootstrapMinus1: number | undefined;
  readonly acaPtcBenchmarkOverrides: ReadonlyArray<{ taxYear: number; annualSlcspDollars: number }>;
  readonly inflationRatePct: number;
  readonly medicalInflationRatePct: number;
  readonly hsaQualifiedMedicalExpensePct: number;
  readonly earlyWithdrawalPenaltyExemptAccountIds: readonly string[];
  readonly primaryDeathYear: number;
  readonly secondaryDeathYear: number;
  /** Per-calendar-year rolled-CBP RMD ordinary income (dollars) — the
   *  rollover-year RMD carved from a linked-CBP lump-sum landing in/after the
   *  source owner's RMD trigger year. Added to the year's ordinary-income inlet
   *  (taxed exactly once; the cash leg is added to the spendable income series
   *  upstream). Empty when no split fired. */
  readonly rolledRmdIncomeByYear: ReadonlyMap<number, number>;
  /** True when the plan models NO medical spending at all.
   *  Combined with a charged IRMAA surcharge it means the base Medicare premium
   *  (a user-entered medical expense) is missing. OPTIONAL: only the
   *  annotation post-pass consumes it, so the funding-hook builder — whose
   *  callers have no expense inventory — simply omits it rather than supplying a
   *  meaningless value. Absent → the readiness flag is never raised. */
  readonly noMedicalSpendingModeled?: boolean;
}

/** Resolved IRMAA look-back for one projection year. `estimatedFromProjection`
 *  is true only on the estimate path (years 0–1, on Medicare, no stored bootstrap →
 *  estimate from `magiBuffer[0]`). */
interface MagiLookbackResolution {
  readonly value: number | undefined;
  readonly estimatedFromProjection: boolean;
}

/** Stored bootstrap for projection year `i` (0 → minus2, 1 → minus1). */
function storedBootstrapForYear(
  i: number,
  minus2: number | undefined,
  minus1: number | undefined,
): number | undefined {
  if (i === 0) return minus2;
  if (i === 1) return minus1;
  return undefined;
}

/**
 * Resolve `magiTwoYearsPriorDollars` for projection year `i`:
 *   - i ≥ 2: rolling buffer entry `magiBuffer[i - 2]`.
 *   - i ∈ {0, 1}: the stored lookback field (minus2 for year 0, minus1 for
 *     year 1). When that field is absent AND the household has a Medicare
 *     member this year (`onMedicareThisYear`), ESTIMATE the lookback from the
 *     engine's projected year-0 MAGI (`estimatedYear0Magi`) and flag it.
 *     `estimatedYear0Magi` is `undefined` for year 0 before its own MAGI is
 *     known — the caller handles year 0 via a recompute (see `processTaxYear`).
 *   - otherwise: `undefined` (IRMAA skipped).
 */
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
  // No stored bootstrap. Estimate from the projected year-0 MAGI when a
  // member is on Medicare this year. The flag fires even when the estimate is
  // $0 (below-floor fallback) so the disclosure always shows.
  if (onMedicareThisYear && estimatedYear0Magi !== undefined) {
    return { value: estimatedYear0Magi, estimatedFromProjection: true };
  }
  return { value: undefined, estimatedFromProjection: false };
}

/** Outcome of one year's tax compute. `result` is null when the year is
 *  below the calibration floor (no modelable tax — caller skips the
 *  annotation but still counts the year as processed). */
interface YearTaxComputation {
  result: ReturnType<typeof applyTaxYear> | null;
  estimatedFromProjection: boolean;
}

/** MAGI look-back stepping + tax compute for one projection year:
 *  resolve the two-year-prior MAGI (ring / stored bootstrap / projected
 *  estimate), run `applyTaxYear`, perform the year-0 own-MAGI IRMAA
 *  recompute when on Medicare with no stored bootstrap, and handle the
 *  below-calibration-floor fallback. Always appends this year's MAGI
 *  sample to `magiBuffer` ($0 on the below-floor path) so the IRMAA
 *  two-year look-back ring stays index-aligned.
 *  Slightly over the 60-line shape cap (~63 physical lines): a quarter of
 *  the body is the decision commentary, which must stay with the code
 *  it explains — trimming it to hit the count would cost more than the cap buys. */
function computeYearTaxWithMagiLookback(args: {
  i: number;
  magiBuffer: number[];
  shared: TaxLoopShared;
  onMedicareThisYear: boolean;
  buildInput: (magiTwoYearsPriorDollars: number | undefined) => ApplyFilingPlanYearInput;
}): YearTaxComputation {
  const { i, magiBuffer, shared, onMedicareThisYear, buildInput } = args;
  // The year-0 projected MAGI estimate for the missing-bootstrap path.
  // For year 1 it is already in `magiBuffer[0]`; for year 0 it is the year's
  // OWN MAGI, which is only known after a first compute, so year 0 is handled
  // by a recompute below (estimatedYear0Magi stays undefined for the first pass).
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
    // Year-0 recompute: when on Medicare in year 0 with no stored
    // minus2 bootstrap, the lookback estimate IS this year's own projected
    // MAGI. The first compute (above, lookback undefined → IRMAA skipped)
    // yields that MAGI; recompute IRMAA with it as the look-back and flag it.
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
    // Year below the calibration floor (e.g. a retired-in-the-past account
    // projected from a pre-snapshot year) → no modelable tax. Skip the
    // annotation gracefully; advance the buffer so the IRMAA look-back stays
    // index-aligned (the post-pass mirrors the engine's graceful degradation).
    if (isUnsupportedTaxYear(err)) {
      magiBuffer.push(0);
      // Below-floor fallback: when a member is on Medicare in projection
      // year 0–1 with no stored bootstrap and the engine cannot produce a
      // year-0 MAGI, the estimate falls back to $0 (IRMAA naturally skipped)
      // but the disclosure flag STILL fires so the assumption is surfaced.
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

/** Per-year body extracted from `applyTaxIntegrationToDrawdownYears`
 *  Mutates the `year` and appends a MAGI sample into
 *  `magiBuffer`. Returns false when zero members are alive (caller
 *  should still advance i but leave the year's tax fields undefined). */
function processTaxYear(
  year: DrawdownYear,
  i: number,
  years: ReadonlyArray<DrawdownYear>,
  shared: TaxLoopShared,
  magiBuffer: number[],
  unitRing: FilingUnitRingEntry[],
  rothBasisCarrier: RothBasisCarrier,
  /** The ACCOUNT-keyed designated-Roth carrier (pro-rata regime).
   *  Mutated in place across the year loop alongside `rothBasisCarrier`. */
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
  // Resolve the year's filing plan into tax units. `taxUnits === undefined`
  // is the legacy branch — an unresolvable legacy scalar keeps `filingStatus` above.
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
  // The year TWO before this one sizes a first-year-deferral catch-up
  // ("two RMDs in one year"); absent in the first two projection years, where the
  // engine reports the catch-up as a blocker instead of guessing a base.
  const priorPriorYear = i > 1 ? years[i - 2] : undefined;
  const accounts = buildAccountSnapshotsFromPriorYear(
    ctx,
    priorYear,
    shared.ledgerAccounts,
    priorPriorYear,
  );
  // Advance the per-brokerage-like-account cost-basis accumulator with
  // this year's contributions + reinvested yield BEFORE the withdrawal, take
  // the pre-withdrawal basis fraction for the withdrawal-time LTCG gain, then
  // deplete basis. The start-of-year brokerage-like balance is the yield base.
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
  // Annual ordinary taxable interest from cash-like accounts (savings/
  // money-market/CD realized growth; HSA excluded — tax-free). Same helper +
  // formula as the MC representative-display post-pass (monte-carlo-tax-burden.ts);
  // both engines' FUNDED per-path/per-year tax deliberately omit this component.
  const cashLikeYearAccounts = buildCashLikeYearAccounts(ctx, year, priorYear, shared.ledgerAccounts);
  const cashInterestDollars = computeCashLikeInterestDollars(cashLikeYearAccounts);
  // The owner behind each of those dollars, so a `separate` couple's two
  // returns report what they actually own instead of half of everything.
  const ownerAttributedAmounts: OwnerAttributedAmounts = {
    preTaxWithdrawalDollars: withdrawalSplit.byOwner.preTax,
    postTaxNonRothWithdrawalDollars: withdrawalSplit.byOwner.postTaxNonRoth,
    postTaxCashLikeWithdrawalDollars: withdrawalSplit.byOwner.postTaxCashLike,
    rothWithdrawalDollars: withdrawalSplit.byOwner.roth,
    cashInterestDollars: computeCashLikeInterestByOwner(cashLikeYearAccounts),
    brokerageLikeStartBalanceDollars: brokerageStartBalanceByOwner(brokerageYearAccounts),
  };
  const acaOverride = shared.acaPtcBenchmarkOverrides.find((o) => o.taxYear === taxYear);
  // The look-back gate must use the SAME month-aware
  // predicate the IRMAA surcharge gate uses. Reading the whole-year
  // `onMedicare` boolean here would let a beneficiary with stated Medicare months but
  // a false age-derived flag pass the surcharge gate with no look-back MAGI —
  // the surcharge would be silently skipped and its disclosure never rendered.
  const onMedicareThisYear = anyMemberOnMedicare(members);
  // Cumulative owner-level §408A Roth-IRA ordering. Consume each owner's
  // remaining derived basis first (tax/penalty-free); the earnings excess above
  // the owner's cumulative basis is taxed as ordinary income AND fed to the Roth
  // earnings-penalty branch (10% pre-59½). The carrier is mutated across years.
  //
  // Computed ONCE here — it is MAGI-independent. `buildInput` (below) is called
  // up to twice for the IRMAA look-back recompute, but the Roth split is
  // identical for every look-back value and the carrier mutation MUST run only
  // once per year, so `rothSplit` is resolved outside the closure and reused.
  const rothSplit = applyRothBasisOrdering(
    ctx,
    year,
    rothBasisCarrier,
    designatedRothCarrier,
  );

  /** Assemble the per-year input for a given IRMAA look-back value. */
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
      // Fold the Roth earnings-excess (above cumulative §408A basis)
      // into ordinary income. MAGI-independent → safe to add for every
      // look-back value (rothSplit was computed once, above).
      //
      // A Fill-mode Roth conversion is ALSO ordinary income for the
      // year — it raises BOTH divergent MAGIs (federal/IRMAA + ACA, via the
      // shared ordinary-income → MAGI add-back), NIIT (MAGI-threshold), and the
      // senior-bonus phase-out (conversion-inclusive MAGI). It SUMS on top
      // of withdrawals; it is NOT a distribution, so it is deliberately absent
      // from `penaltyAccounts` (excluded from the §72(t) 10% penalty).
      otherOrdinaryIncomeDollars:
        otherOrdinaryIncomeForYear(shared.nonSsIncomeRows, taxYear) +
        rothSplit.earningsExcessDollars +
        (year.rothConvertedCents ?? 0) / 100 +
        // The rollover-year RMD from a linked-CBP lump-sum is ordinary
        // income for the year, taxed exactly once via this canonical inlet.
        // No-double-tax: the rolled-CBP source is excluded from the
        // per-account ledger entirely, so the forced-RMD reconciliation never
        // counts these dollars (`rmdFloorByAccountDollars` sees only ledger
        // accounts).
        (shared.rolledRmdIncomeByYear.get(taxYear) ?? 0),
      accounts,
      members,
      householdSize: members.length,
      magiTwoYearsPriorDollars,
      acaBenchmarkSlcspDollars: acaOverride?.annualSlcspDollars,
      // The scenario's FPL region (Alaska / Hawaii use their own,
      // higher HHS poverty guidelines). Absent → contiguous 48 + DC.
      acaFplRegion: ctx.acaFplRegion,
      taxpayersAge65Plus: countTaxpayersAge65Plus(ctx, taxYear, primaryAlive, secondaryAlive),
      // Per-account pre-withdrawal cost basis + start-of-year brokerage-like
      // balance (the yield base), threaded from advanceBrokerageLikeBasis.
      costBasisFraction: preWithdrawalBasisFraction,
      brokerageLikeStartBalanceDollars: startBalanceDollars,
      // Annual cash-like interest (MAGI-independent → identical across the
      // IRMAA look-back recompute; computed once above).
      cashInterestDollars,
      inflationRatePct: shared.inflationRatePct,
      medicalInflationRatePct: shared.medicalInflationRatePct,
      hsaQualifiedMedicalExpensePct: shared.hsaQualifiedMedicalExpensePct,
      earlyWithdrawalPenaltyExemptAccountIds: shared.earlyWithdrawalPenaltyExemptAccountIds,
      // Append the Roth earnings-penalty accounts to the per-year
      // penalty inputs. MAGI-independent → identical across look-back values.
      penaltyAccounts: [...buildPenaltyAccountsForYear(ctx, year), ...rothSplit.penaltyAccounts],
    });

  const computed = computeYearTaxWithMagiLookback({
    i,
    magiBuffer,
    shared,
    onMedicareThisYear,
    buildInput,
  });
  // Buffer THIS year's returns (each with its own members, status, and
  // MAGI) so the year-two-later surcharge tiers every return on its own
  // look-back. A below-floor year buffers an empty list, exactly like the $0
  // MAGI sample the helper already pushed.
  unitRing[i] = computed.result?.filingUnitMagi ?? [];
  if (computed.estimatedFromProjection) year.magiEstimatedFromProjection = true;
  // Credit this year's Fill-mode converted principal to the target Roth's
  // §408A basis carrier, AFTER `applyRothBasisOrdering` (rothSplit, above) drew
  // down basis for this year's Roth withdrawals — the converted dollars land at
  // year-end, so they are basis only for LATER years. Runs on both the
  // below-floor and modelable paths (a conversion can occur in a below-floor
  // year too, though the engine only converts when a cap is active).
  creditRothConversionToBasisCarrier(ctx, year, rothBasisCarrier);
  // Below the calibration floor — no modelable tax; the year still counts as
  // processed (the helper already advanced the MAGI ring with a $0 sample).
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

/** Shared error `code` for every engine's `UnsupportedTaxYearError`. A
 *  projection year below the calibration floor has no modelable tax. */
function isUnsupportedTaxYear(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'UNSUPPORTED_TAX_YEAR'
  );
}

/**
 * Apply tax-integration to all drawdown years in-place.
 *
 * Mutates `years` by setting the 15 optional tax fields on each
 * `DrawdownYear` (federalTaxCents, taxableSsCents, etc.). Runs for every named
 * strategy.
 *
 * @param years - The mutable `DrawdownYear[]` from `simulateDrawdown`.
 * @param ssRows - Per-month SS income rows for SS gross rollup.
 * @param nonSsIncomeRows - Per-month non-SS income rows for `otherOrdinaryIncome`.
 * @param ledgerAccounts - Per-account drawdown inputs (for year-0 RMD basis).
 * @param ctx - Pipeline context (members, accounts, scenario overrides).
 * @param bundle - Calibration bundle for the 5 tax engines.
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
  /** True when the plan models ANY medical spending
   *  (`CashflowSeries.anyMedicalSpendingModeled`). Its NEGATION — combined with
   *  a charged IRMAA surcharge — sets the missing-base-Medicare-premium
   *  readiness flag.
   *
   *  This is the FULL `isMedical` expense inventory, NOT the
   *  HSA-qualified `medicalDemandByMonth` sub-series the drawdown engine
   *  spends: Medicare, Medigap and drug-plan premiums are never HSA-qualified
   *  (§223(d)(2)(C)(iv) allows only a narrow set), so a household that DID
   *  record its premiums would otherwise be told it models no medical spending
   *  at all.
   *
   *  OMITTED means "this caller has no expense inventory", which is NOT
   *  the same as "the plan models nothing". Only an explicit `false` raises the
   *  flag; `undefined` suppresses it, so a focused unit test that never passes
   *  an expense series can never stamp a readiness warning. */
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
    // The stored array reaches this engine straight off an
    // envelope-only-validated scenario aggregate; the ONE shared enumerator
    // shape-checks it so a non-array import cannot throw the whole projection
    // and a malformed row cannot price a benchmark.
    acaPtcBenchmarkOverrides: storedAcaBenchmarkOverrides(resolved.acaPtcBenchmark),
    inflationRatePct: ctx.projCtx.inflationPct,
    medicalInflationRatePct: ctx.medicalInflationRatePct,
    hsaQualifiedMedicalExpensePct: resolved.hsaQualifiedMedicalExpensePct ?? 100,
    earlyWithdrawalPenaltyExemptAccountIds: resolved.earlyWithdrawalPenaltyExemptAccountIds ?? [],
    // ONE shared derivation with the Monte Carlo twin
    // (`resolveHouseholdDeathYears`). `undefined` (no derivable death year) maps
    // to `Infinity` here because this engine compares plain numbers; MC omits
    // the field and treats it as alive. Both therefore read the member as ALIVE
    // — never `NaN`, which silently made a member with a malformed
    // imported birthdate dead in every year on this engine only.
    primaryDeathYear: deathYears.primaryDeathYear ?? Infinity,
    secondaryDeathYear: deathYears.secondaryDeathYear ?? Infinity,
    rolledRmdIncomeByYear,
    noMedicalSpendingModeled,
  };
  // Rolling MAGI buffer: index i holds MAGI in dollars for year[i].
  // IRMAA for year[i] uses magiBuffer[i - 2].
  const magiBuffer: number[] = [];
  // The parallel PER-TAX-UNIT look-back ring. Index i holds
  // one entry per return filed in year[i] (its own members, status, and MAGI);
  // IRMAA for year[i] reads unitRing[i - 2], so every return is tiered on the
  // return IT filed two years earlier — a survivor's first Single year uses the
  // joint return's own MAGI + schedule, and two separate returns never share
  // one merged MAGI or one tier ladder.
  const unitRing: FilingUnitRingEntry[] = [];
  // The FACT-BASED §408A carriers, seeded once per run.
  //
  // Two carriers, because the two regimes differ: the owner-keyed carrier
  // holds each owner's REMAINING Roth-IRA regular-contribution basis and conversion
  // lots, both derived from the pool's recorded balance history
  // (contribution-first, lots FIFO with their own five-year clocks), while the
  // ACCOUNT-keyed designated carrier holds each employer designated-Roth account's
  // own basis, five-year participation clock and in-plan-rollover lots (pro rata,
  // never pooled). A single pooled carrier seeded from at-retirement BALANCES
  // would treat an entire projected Roth balance as recoverable basis.
  //
  // Deterministic-only additions the MC seed never sees: the working-years
  // converted-principal Roth-IRA basis, and the same-account MIXED in-plan
  // conversion basis credited to its exact target account.
  const rothBasisCarrier = seedFactBasedRothBasisCarrier(
    mergeFactBasedRothIraSeeds(
      // POOL-keyed: an owner's own Roth IRAs share one entry. An INHERITED
      // Roth IRA contributes no pool here and therefore no carrier entry:
      // its dollars are wholesale tax-free and never reach this carrier.
      ctx.rothDistributionFacts.rothIraByPool,
      ctx.preRetirementConversionBasisCentsByOwner,
      // DATED, so each engine-generated conversion becomes a real lot with
      // its own five-tax-year §408A(d)(3)(F) recapture window.
      ctx.preRetirementConversionBasisCentsByOwnerYear,
    ),
  );
  const designatedRothCarrier = seedDesignatedRothCarrier(
    mergeDesignatedRothSeeds(
      ctx.rothDistributionFacts.designatedByAccount,
      ctx.mixedInPlanConversionBasisCentsByAccount,
      // DATED in-plan rollover lots (§402A(c)(4)(D) recapture windows).
      ctx.mixedInPlanConversionBasisCentsByAccountYear,
    ),
  );
  // Per-brokerage-like-account cost-basis accumulator carried across
  // years (basis grows with reinvested yield + contributions, depletes on
  // withdrawal). Seeded from the same fraction the static value used.
  const basisState: BrokerageLikeBasisState = {
    basisByAccountId: new Map<string, number>(),
    seedBasisFraction,
  };
  for (let i = 0; i < years.length; i += 1) {
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
    // When a year is skipped (zero alive members), the buffer must
    // still advance so the `i - 2` look-back for subsequent years stays
    // aligned with the projection year index. Push 0 — the surviving cohort
    // had no taxable income in the dead year, which is the correct IRMAA
    // basis (zero MAGI two years prior).
    if (!processed) magiBuffer.push(0);
  }
}

// ---------------------------------------------------------------------------
// Per-tax-unit resolution seam
// ---------------------------------------------------------------------------

/**
 * Resolve a projection year's filing plan into tax units from the pipeline
 * context. The transition-safe successor to `deriveFilingStatus`: it returns
 * one resolved tax unit for a joint / survivor / individual year, two for a
 * `separate` couple, or an `unresolved` result when the legacy scalar cannot be
 * safely converted (the caller then keeps the scalar-status path and the scenario
 * editor prompts the user, never guessing a split).
 *
 * The scenario's stored `taxFilingPlan` supersedes the legacy scalar; it is
 * layered on here (rather than inside `buildFilingPlanContextForYear`) so the
 * shared context builder keeps serving both the deterministic and the MC seam.
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

/**
 * The filing status of the return the household filed in `taxYear`, for a
 * year the projection never simulated.
 *
 * Projection years 0–1 tier IRMAA on returns filed BEFORE the projection starts,
 * so the per-unit ring has no entry for them. Leaving the look-back status
 * undefined would make the deterministic engine fall back to the CURRENT year's status
 * (`tax-integration.ts`'s `irmaaLookbackFilingStatus ?? filingStatus`), while
 * Monte Carlo resolves `taxYear - 2`'s own plan — so a spouse dying in
 * projection year 0 would have year 1 tiered on the survivor's `Single` schedule in one
 * engine and the couple's `MFJ` schedule in the other, off the SAME stored plan.
 * This mirrors MC's `resolveMcFilingForYear` for those two years: resolve the
 * plan for the look-back year with that year's own alive-state, falling back to
 * the legacy scalar derivation for the look-back year (never the current year's)
 * when the plan cannot be resolved.
 *
 * A look-back year with TWO returns (a separate-filing couple) also
 * reports them individually in `units`, so the caller can rebuild the per-return
 * look-back ring instead of collapsing both spouses onto the first one's
 * schedule.
 */
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

/** Resolve one projection year's filing facts and read the two-year look-back
 *  returns out of the per-unit ring. Never throws: an unresolved plan
 *  yields `taxUnits: undefined`, which routes the year down the legacy scalar
 *  path unchanged. */
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
  // The lived-together fact is a couple-level input on the `separate` plan and
  // is only meaningful while both spouses are alive and filing separately.
  const mfsLivedWithSpouse =
    plan?.kind === 'separate' && (taxUnits?.length ?? 0) > 1 && plan.livedTogether === true;
  const lookbackUnits = (yearIndex >= 2 ? unitRing[yearIndex - 2] : undefined) ?? [];
  // Projection years 0–1 have no ring entry; resolve the pre-projection
  // look-back year's own return instead of inheriting this year's status.
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
    // A two-return bootstrap look-back is rebuilt per return in
    // `buildTaxYearInput`, which is where the year's household bootstrap MAGI
    // (resolved by `magiLookback`) becomes available to divide across them.
    bootstrapLookbackUnits: bootstrapLookback?.units,
    // Legacy fallback (no resolvable units): the single-status
    // look-back. A resolved year reads `irmaaLookbackUnits` per return instead.
    irmaaLookbackFilingStatus: lookbackUnits[0]?.filingStatus ?? bootstrapLookback?.status,
    irmaaLookbackMfsLivedWithSpouse:
      lookbackUnits[0]?.mfsLivedWithSpouse ?? bootstrapLookback?.mfsLivedWithSpouse,
  };
}

/** Member ids that attain age 65 by the END of `taxYear` (IRS born-Jan-1 rule),
 *  so the age add-on and senior bonus land on the return that claims them. */
function age65PlusMemberIdsForYear(
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

// ---------------------------------------------------------------------------
// Tax-cashflow hook — funds federal tax + IRMAA cash − ACA PTC into
// the drawdown engine's per-year withdrawal target via the annual solver.
// ---------------------------------------------------------------------------

/** Build the shared per-year-loop context once (mirrors the post-pass). */
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
    // The stored array reaches this engine straight off an
    // envelope-only-validated scenario aggregate; the ONE shared enumerator
    // shape-checks it so a non-array import cannot throw the whole projection
    // and a malformed row cannot price a benchmark.
    acaPtcBenchmarkOverrides: storedAcaBenchmarkOverrides(resolved.acaPtcBenchmark),
    inflationRatePct: ctx.projCtx.inflationPct,
    medicalInflationRatePct: ctx.medicalInflationRatePct,
    hsaQualifiedMedicalExpensePct: resolved.hsaQualifiedMedicalExpensePct ?? 100,
    earlyWithdrawalPenaltyExemptAccountIds: resolved.earlyWithdrawalPenaltyExemptAccountIds ?? [],
    // ONE shared derivation with the Monte Carlo twin
    // (`resolveHouseholdDeathYears`). `undefined` (no derivable death year) maps
    // to `Infinity` here because this engine compares plain numbers; MC omits
    // the field and treats it as alive. Both therefore read the member as ALIVE
    // — never `NaN`, which silently made a member with a malformed
    // imported birthdate dead in every year on this engine only.
    primaryDeathYear: deathYears.primaryDeathYear ?? Infinity,
    secondaryDeathYear: deathYears.secondaryDeathYear ?? Infinity,
    rolledRmdIncomeByYear,
    // Only the annotation post-pass consumes this; the funding hook never
    // stamps the disclosure flag, so the fact is omitted here.
  };
}

/** Zero-need outcome — a dead year (no living members) funds no tax. */
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

/**
 * Build the `TaxCashflowHook` the drawdown engine calls once per year to
 * fund federal tax + the IRMAA cash portion (minus the ACA PTC offset) into
 * the withdrawal target. Converts the annotation post-pass's per-year input
 * assembly into the solver-driving input (shared helper). Runs for
 * EVERY named strategy.
 *
 * The hook owns a rolling MAGI buffer for the IRMAA 2-year look-back. The
 * engine calls `solveForYear` in ascending year order, so the buffer fills
 * in lockstep with the projection year index. RMD-floor display fields are
 * owned by the separate annotation post-pass; this hook passes empty
 * `accounts` to the solver's `applyTaxYear` (the cashflow need does not
 * depend on the RMD-display floor — the pre-tax classification the engine
 * supplies already reflects the RMD-forced pre-tax draws).
 */
/** Per-year solver input assembled by `buildSolverYearInput`. */
interface SolverYearInput {
  readonly taxInputBase: ApplyFilingPlanYearInput;
  /** Each member's OWN annual SS for the year, keyed by memberId — the
   *  per-member IRMAA-withholding source. A Medicare member absent from
   *  the map has no own SS, so their surcharge is a full cash need. */
  readonly ownSsDollarsByMemberId: Readonly<Record<string, number>>;
}

/** Assemble the per-year tax input (classification fields zeroed — the
 *  solver overwrites them each pass from the engine classifier). Returns
 *  `null` when no member is alive (caller funds zero tax). Pushes the MAGI
 *  sample into the buffer for the dead-year case to keep the look-back
 *  index-aligned.
 *
 *  Resolves the SAME filing plan the annotation post-pass resolves, so the
 *  funded balances and the displayed tax never disagree about which return the
 *  household files. */
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
    // The FUNDING solver has no committed per-account withdrawal split
    // yet (the classifier overwrites the four bucket totals on every pass and
    // reports them per BUCKET, not per owner), so a separate-filing year funds
    // on the even split and the annotation post-pass above reports the exact
    // owner-attributed figures. Same documented "funded-approximate,
    // display-exact" boundary the yield-drag / cost-basis / cash-interest inputs
    // already sit on. Gross Social Security IS attributed here —
    // it comes from the SS series, not the withdrawal classifier.
    ownerAttributedAmounts: {},
    grossSsDollars,
    preTax: 0,
    postTaxNonRoth: 0,
    postTaxCashLike: 0,
    roth: 0,
    otherOrdinaryIncomeDollars:
      otherOrdinaryIncomeForYear(shared.nonSsIncomeRows, taxYear) +
      // Fund the rollover-year RMD's incremental tax in the same year
      // (same canonical ordinary-income inlet as the post-pass).
      (shared.rolledRmdIncomeByYear.get(taxYear) ?? 0),
    accounts: [],
    members,
    householdSize: members.length,
    // Read the two split lookback fields; for the funding solver the
    // projected-MAGI estimate uses the solver's own `magiBuffer[0]`, which
    // is available for year 1 but NOT for year 0 (its own MAGI is unknown
    // before the within-year fixpoint converges, and feeding it back would
    // break the contraction guarantee). So the FUNDING solver estimates IRMAA
    // for year 1 in the no-bootstrap case but funds $0 for year 0; the
    // authoritative year-0 estimate + disclosure lives in the annotation pass
    // (`processTaxYear`), which is what the user sees.
    magiTwoYearsPriorDollars: magiLookback({
      i: yearIndex,
      magiBuffer,
      minus2: shared.magiBootstrapMinus2,
      minus1: shared.magiBootstrapMinus1,
      onMedicareThisYear: anyMemberOnMedicare(members),
      estimatedYear0Magi: yearIndex === 1 ? magiBuffer[0] : undefined,
    }).value,
    acaBenchmarkSlcspDollars: acaOverride?.annualSlcspDollars,
    // Same FPL region as the annotation pass, so the funding solver
    // and the displayed figures price the same poverty line.
    acaFplRegion: ctx.acaFplRegion,
    taxpayersAge65Plus: countTaxpayersAge65Plus(ctx, taxYear, primaryAlive, secondaryAlive),
    // The cashflow solver runs BEFORE the committing per-account draw, so this
    // year's per-account balances are not yet known. It therefore uses the
    // STATIC seed basis fraction, a $0 brokerage-like yield base, and $0
    // cash-like interest (documented approximation — the annual-yield drag,
    // the evolving cost basis, and the cash-like interest are applied
    // exactly in the post-pass annotation, which the user sees; their effect on
    // the within-year cashflow solve is small relative to the draw, mirroring
    // the same pre-commit treatment as `penaltyAccounts`).
    costBasisFraction: shared.seedBasisFraction,
    brokerageLikeStartBalanceDollars: 0,
    cashInterestDollars: 0,
    inflationRatePct: shared.inflationRatePct,
    medicalInflationRatePct: shared.medicalInflationRatePct,
    hsaQualifiedMedicalExpensePct: shared.hsaQualifiedMedicalExpensePct,
    earlyWithdrawalPenaltyExemptAccountIds: shared.earlyWithdrawalPenaltyExemptAccountIds,
    // PASS 1 leaves `penaltyAccounts` empty (federal tax + IRMAA only).
    // The SECOND pass in `solveForYear` re-solves with the penalty inputs built
    // from pass 1's converged (committed) classification, so the early-
    // withdrawal / HSA / Roth-earnings penalty is funded into the year's draw.
    // The post-pass annotation
    // still computes the EXACT per-account penalty against the committed
    // `accountBalances` and owns the displayed `earlyWithdrawalPenaltyCents`.
    penaltyAccounts: [],
  });
  return { taxInputBase, ownSsDollarsByMemberId };
}

/** Map a solver result to the engine-facing per-year outcome.
 *
 *  The engine draw add-on (`addedNeedDollars`) raises the portfolio
 *  withdrawal by BOTH the cash tax need (`totalTaxCashflowNeedCents` — federal
 *  tax + IRMAA cash − ACA offset) AND the IRMAA portion WITHHELD from Social
 *  Security. The withheld surcharge shrinks the member's SS check, but the
 *  drawdown's spendable income series spends GROSS SS, so the portfolio must
 *  cover the shortfall — net spendable SS = gross − withheld. Adding the
 *  withheld amount here is equivalent to reducing the spendable SS series by it
 *  (net need = E − I, so lowering I by W ≡ raising the draw by W). It is counted
 *  exactly once (only in `addedNeedDollars`); `irmaaWithheldFromSsCents` stays
 *  a separate display field and `totalTaxCashflowNeedCents` (the cash portion)
 *  is unchanged. Gross SS still feeds MAGI / §86 / the IRMAA surcharge itself —
 *  this nets only the spendable income, never the tax computation.
 *
 *  The withheld-funded draw is ALSO taxed: the solver folds the withheld
 *  cents into its per-pass trial target (`tax-cashflow-solver.ts`), so the
 *  federal tax inside `totalTaxCashflowNeedCents` reflects the extra
 *  withheld-covering draw. This add-on still counts the withheld PRINCIPAL
 *  exactly once (here); the solver change raises only the tax on it.
 *
 *  The credit applied to premiums lowers the draw: it is subtracted here, so
 *  the add-on can be negative (never below minus the year's ordinary need). */
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

export function buildTaxCashflowHook(args: {
  readonly ctx: PipelineContext;
  readonly ssRows: TaxLoopShared['ssRows'];
  readonly nonSsIncomeRows: ReadonlyArray<MonthlyIncomeRow>;
  readonly ledgerAccounts: ReadonlyArray<DrawdownAccountInput>;
  readonly bundle: TaxCalibrationBundle;
  readonly retirementYear: number;
  /** Per-calendar-year rolled-CBP RMD ordinary income (dollars). */
  readonly rolledRmdIncomeByYear?: ReadonlyMap<number, number>;
  /** Monthly modeled Medical expenses (every `isMedical` row), integer cents,
   *  aligned to (retirementYear, January) — caps the credit applied to premiums.
   *  Absent → no credit is applied. */
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
  // The funding pass keeps its own filing-status ring, in lockstep
  // with its own `magiBuffer` (the engine calls `solveForYear` in ascending
  // year order), so its IRMAA look-back is tiered on the same look-back return
  // the annotation post-pass uses.
  const unitRing: FilingUnitRingEntry[] = [];
  // The FUNDING pass's own §408A carrier, seeded from the SAME
  // fact-based sources as the post-pass carrier above (an independent copy — the
  // funding solver consumes basis on its own trial path). The funding pass keeps
  // an owner-keyed carrier: §408A pools are flattened only WITHIN each owner
  // (`flattenRothIraPoolsByOwner`), and each drawn owner consumes their OWN
  // basis/lots — and is qualified by their OWN entry's clock + their own 59½
  // status — via the classifier's per-account attribution
  // (`rothIraDollarsByAccountId`); the household-conservative qualification
  // reduction remains only for attribution-free classifications. The post-pass
  // carrier keeps the real pools.
  //
  // The carrier holds §408A material ONLY: Roth-IRA pool basis + conversion
  // lots, and the working-years converted principal. Designated-Roth basis of
  // EVERY kind stays off it: the NON-inherited roll-ups live exclusively on the
  // pooled designated state below (so a Roth-IRA draw can never consume a
  // designated plan's rollover lots, nor a designated draw the owner's §408A
  // contribution basis — the aliasing that mis-funded both directions), and an
  // INHERITED designated plan's basis lives on the separate INHERITED pooled
  // state (its draws carry their own classifier subset; the death event, not
  // §408A ordering, decides their tax — §402A(d)(2)(B)(i) / §72(t)(2)(A)(ii)).
  const rothBasisCarrier = seedFactBasedRothBasisCarrier(
    mergeFactBasedRothIraSeeds(
      flattenRothIraPoolsByOwner(ctx.rothDistributionFacts.rothIraByPool),
      ctx.preRetirementConversionBasisCentsByOwner,
      // Keep engine-generated conversion principal dated in the funding copy,
      // matching the annotation carrier's §408A(d)(3)(F) recapture windows.
      ctx.preRetirementConversionBasisCentsByOwnerYear,
    ),
  );
  // The pooled DESIGNATED-Roth state that accompanies the carrier: basis,
  // dated in-plan-rollover lots (each with its own five-tax-year §402A(c)(4)(D)
  // recapture window), participation clock and running pooled balance, seeded
  // from the SAME merged per-account facts the annotation pass seeds its
  // per-account carrier from — so engine-generated MIXED in-plan conversion
  // principal arrives as dated lots here exactly as it does there. The
  // designated slice of the Roth bucket runs the same
  // `computeDesignatedRothDistribution` pro-rata + ordered-lot allocation
  // against it, which is what makes the funded recapture the figure the
  // annotation reports.
  const designatedSeedFacts = mergeDesignatedRothSeeds(
    ctx.rothDistributionFacts.designatedByAccount,
    ctx.mixedInPlanConversionBasisCentsByAccount,
    ctx.mixedInPlanConversionBasisCentsByAccountYear,
  );
  const solverDesignatedRoth = seedSolverDesignatedRothStates(
    designatedSeedFacts,
    solverDesignatedRothBalanceCentsByOwner(ctx, ledgerAccounts),
  );
  // The INHERITED pooled companion: same primitive, entries flagged
  // `inheritedFromDeceasedOwner: true`, fed by the inherited classifier subset.
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
    // Hybrid IRMAA: each Medicare member's surcharge is withheld only from
    // THAT member's own SS (mirrors CMS per-beneficiary collection). A member
    // on Medicare but not yet claiming their own SS (own SS $0) → full cash
    // need; withholding never reaches across to a spouse's SS.
    //
    // Two-pass penalty funding. PASS 1: solve the cashflow draw with
    // `penaltyAccounts: []` (federal tax + IRMAA only), producing the converged
    // target whose classification is the committed per-bucket split. PASS 2:
    // build the early-withdrawal / HSA / Roth-earnings penalty inputs from that
    // committed split (a FIXED input — pass 2 does not re-classify), then
    // re-solve so the penalty is funded into balances. Skip pass 2 when no
    // penalizable basis exists (no extra draw — the common 59½+ case).
    const pass1 = solveTaxCashflow({
      ordinaryNetNeedDollars,
      taxInputBase: yearInput.taxInputBase,
      bundle,
      irmaaPayment: { ownSsDollarsByMemberId: yearInput.ownSsDollarsByMemberId },
      classifyForTarget: classify,
      medicalExpenseCents,
    });
    // The funded draw `solveTaxCashflow` settles on is
    // `ordinaryNetNeed + (totalTaxCashflowNeed + irmaaWithheldFromSs −
    // acaCreditAppliedToPremiums)` — the withheld IRMAA cents are folded into
    // the trial target so the portfolio covers the SS-check shortfall. The
    // committed classification must therefore classify that SAME full funded
    // draw; omitting the withheld cents under-states the Roth / penalty basis in
    // withheld-IRMAA years.
    const committedTarget =
      ordinaryNetNeedDollars +
      (pass1.totalTaxCashflowNeedCents +
        pass1.irmaaWithheldFromSsCents -
        pass1.acaCreditAppliedToPremiumsCents) /
        100;
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
    // Pass 2 runs when EITHER leg produced something: a year can carry taxable
    // Roth excess (ordinary income) with NO penalty snapshot — e.g. a
    // nonqualified draw by an owner past 59½ — and skipping pass 2 then would
    // leave that income unfunded.
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
          });
    magiBuffer.push(result.taxYearResult.magiCents / 100);
    // The funding solver keeps its own per-return look-back ring in
    // lockstep with its MAGI buffer, so the funded IRMAA and the displayed
    // IRMAA agree on which return each surcharge is tiered against.
    unitRing[yearIndex] = result.taxYearResult.filingUnitMagi ?? [];
    return toTaxCashflowOutcome(result);
  };

  /**
   * Fill-mode conversion solve. Builds the year's tax input with the
   * COMMITTED withdrawal classification baked in, then runs the outer bisection
   * (`solveFillConversion`) to size the auto-conversion against the selected
   * MAGI line. The conversion is layered on as ADDITIONAL ordinary income inside
   * the bisection probes — never folded into `preTaxWithdrawalDollars` (which
   * would wrongly feed the §72(t) penalty basis; a conversion is not a
   * distribution). Side-effect-free: a throwaway copy of the IRMAA
   * look-back ring is used so the year's MAGI sample (already pushed by
   * `solveForYear`) is never double-counted. Returns 0 when no headroom exists.
   *
   * Note: the converted principal becomes Roth §408A basis, credited to the
   * AUTHORITATIVE post-pass carrier against the EXACT committed `rothConvertedCents`
   * (`creditRothConversionToBasisCarrier` in the annotation pass). The funding-pass
   * carrier here is deliberately NOT credited — the engine-committed amount can
   * differ from this solve's result when pre-tax buckets are exhausted, and the
   * post-pass owns the displayed Roth-earnings penalty (the same solver-vs-post-pass
   * precision split used throughout this hook).
   */
  const solveFillConversionForYear = (
    yearIndex: number,
    withdrawalClassification: TaxCashflowYearClassification,
    convertibleRoomDollars: number,
    capMagiLine: 'irmaa' | 'aca',
    magiCeilingDollars: number,
  ): number => {
    if (convertibleRoomDollars <= 0) return 0;
    const taxYear = retirementYear + yearIndex;
    // Reuse a SNAPSHOT of the look-back ring (solveForYear already advanced the
    // real buffer for this year) so the probe sees the same IRMAA look-back MAGI
    // without mutating the live ring.
    // The per-unit look-back ring is likewise snapshotted — `solveForYear`
    // already stamped this year's entry, and the probe must not re-stamp it.
    const yearInput = buildSolverYearInput(
      ctx,
      shared,
      yearIndex,
      taxYear,
      [...magiBuffer],
      [...unitRing],
    );
    if (yearInput === null) return 0;
    // Bake the committed withdrawal classification into the tax input so the
    // bisection's "MAGI at conv=0" reflects the year's actual withdrawals.
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

  /**
   * Fund the conversion's same-year incremental ordinary-income tax. The
   * conversion is sized by `solveFillConversionForYear`; this then computes the
   * EXTRA same-year tax cashflow need it creates so the engine draws it from
   * cap-safe balances (otherwise ending balances are overstated by the unfunded
   * conversion tax and Fill spuriously dominates Minimize).
   *
   * Need = conversion-inclusive funding solve − withdrawals-only funding solve,
   * using the same `totalTaxCashflowNeed + irmaaWithheldFromSs` composition the
   * engine funds for ordinary withdrawals (`toTaxCashflowOutcome`). The
   * conversion is layered as ADDITIONAL ordinary income (never a pre-tax
   * withdrawal — it is not a distribution); the cap-safe funding draw the
   * caller makes is MAGI-free, so a single incremental solve is exact.
   *
   * Side effect: REPLACE the year's live IRMAA look-back MAGI sample
   * (`solveForYear` pushed the conv=0 MAGI) with the conversion-inclusive MAGI,
   * so the conversion's Y+2 surcharge is FUNDED, not merely displayed.
   */
  const fundConversionTaxForYear = (
    yearIndex: number,
    withdrawalClassification: TaxCashflowYearClassification,
    convertedDollars: number,
  ): number => {
    if (convertedDollars <= 0) return 0;
    const taxYear = retirementYear + yearIndex;
    // SNAPSHOT the look-back ring (solveForYear already advanced the live buffer
    // for this year) so both funding solves see the same look-back MAGI.
    // The per-unit look-back ring is likewise snapshotted — `solveForYear`
    // already stamped this year's entry, and the probe must not re-stamp it.
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
    // The conversion solve targets a MAGI line; only the IRMAA/federal line
    // tax need is fundable cash here. (ACA-line Fill controls premium subsidy,
    // not a same-year cash bill the portfolio funds — its consequence is the
    // PTC offset already modeled in the withdrawals-only solve.) Fund the
    // federal/IRMAA incremental need either way: it is the true same-year cash
    // cost of the converted ordinary income.
    const fundingNeedCents = (input: TaxYearInput): number => {
      const r = solveTaxCashflow({
        ordinaryNetNeedDollars: 0,
        taxInputBase: input,
        bundle,
        irmaaPayment: { ownSsDollarsByMemberId: yearInput.ownSsDollarsByMemberId },
        // The conversion + withdrawals are already baked into the tax input; the
        // funding draw is cap-safe (MAGI-free), so the classifier reports the
        // fixed baked split for any trial target (no re-routing of MAGI).
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
    // Make the LIVE look-back buffer conversion-inclusive so Y+2 IRMAA is
    // funded. Replace the conv=0 sample `solveForYear` pushed for this year —
    // both the household MAGI sample AND the per-return ring entries the
    // surcharge year reads, so the two never disagree about this year's MAGI.
    const convInclusiveResult = applyTaxYearForFilingPlan(withConvInput, bundle);
    const convInclusiveMagi = convInclusiveResult.magiCents / 100;
    if (magiBuffer.length > 0) magiBuffer[magiBuffer.length - 1] = convInclusiveMagi;
    unitRing[yearIndex] = convInclusiveResult.filingUnitMagi ?? [];
    return Math.max(0, withConvCents - withoutConvCents) / 100;
  };

  return { solveForYear, solveFillConversionForYear, fundConversionTaxForYear };
}
