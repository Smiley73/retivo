/** Shared types for the drawdown engine: inputs, per-year rows and the tax-cashflow hook. */
import type {
  AccountTaxTreatment,
  AccountType,
  CustomDrawdownOrder,
  WithdrawalStrategy,
} from '../db/types';
import type { MonthlyCashflowSeries } from './monthly-cashflow';
import type { MagiCapWindowRuntime } from './drawdown-engine-per-account-strategy-helpers';

export interface DrawdownInput {
  /** Combined balance at the start of the retirement year; the per-account branch draws from `accounts`. */
  portfolioAtRetirement: number;
  /** Annual return rate, percent; the per-account branch grows each account by its own rate. */
  ratePct: number;
  /** Per-month gross expenses. Must align to (retirementYear, 0). */
  expensesByMonth: MonthlyCashflowSeries;
  /** Per-month non-portfolio income. Must align to (retirementYear, 0). */
  incomeByMonth: MonthlyCashflowSeries;
  /** Per-month household deposit series. Under `accounts` each per-account
   *  ledger also carries its own deposit slot. */
  depositsByMonth: MonthlyCashflowSeries;
  /**
   * Per-month HSA-qualified medical demand in integer cents, a subset of `expensesByMonth` (out-of-pocket
   * `isMedical` categories, premiums excluded), aligned to (retirementYear, 0). Drives the medical-qualified
   * HSA pass; absent or empty makes it a no-op.
   */
  medicalDemandByMonth?: ReadonlyArray<number>;
  /** First year of drawdown. */
  retirementYear: number;
  /** Last year to simulate (inclusive). */
  horizonYear: number;
  /**
   * Withdrawal ordering strategy; the named kinds run the year-by-year strategy-aware path. Defaults to
   * `taxEfficient`.
   */
  withdrawalStrategy?: WithdrawalStrategy;
  /** Per-account ledger set; when supplied the engine runs the per-account branch. */
  accounts?: ReadonlyArray<DrawdownAccountInput>;
  /**
   * Per-account RMD context, the only input that drives the RMD floor. Under a strategy-aware strategy the
   * engine computes the per-owner floor each year start from the prior year-end balances; surplus credits the
   * first POST_TAX non-Roth account, else `DrawdownYear.rmdOverflowToCashCents`.
   */
  rmdContext?: RmdContextInput;
  /**
   * Per-owner QCD context; when supplied, the engine runs the 70½-gated forced-outflow pass, which debits the
   * QCD from the source IRA, offsets only that owner's IRA-pool RMD floor, and stamps `qcdCents` /
   * `netTaxableRmdCents`.
   */
  qcdContext?: QcdContextInput;
  /**
   * Custom tier ordering for `customOrder`: each tier is an array of account ids, tier 0 drained first;
   * `excludedAccountIds` are never drawn from.
   */
  customDrawdownOrder?: CustomDrawdownOrder;
  /**
   * MAGI-cap window schedule pre-built by the runner (`resolveMagiCapWindows`), sorted by
   * `(startYear, endYear, originalIndex)`. The engine selects at most one active window per year
   * (`selectActiveMagiCapWindow`); absent or empty means no cap.
   */
  magiCapWindows?: ReadonlyArray<MagiCapWindowRuntime>;
  /**
   * Per-year tax-cashflow hook; when supplied, the engine raises each year's withdrawal target by the
   * solver's tax cashflow need (federal tax plus the IRMAA cash portion, minus the ACA PTC offset). Absent
   * means tax-free.
   */
  taxCashflow?: TaxCashflowHook;
}

/** Per-year withdrawal classification fed to the tax-cashflow solver. */
export interface TaxCashflowYearClassification {
  readonly preTaxDollars: number;
  readonly postTaxNonRothDollars: number;
  readonly postTaxCashLikeDollars: number;
  readonly rothDollars: number;
  readonly fundedDollars: number;
  /**
   * The inherited Roth IRA portion of the year's Roth draw, in whole dollars: a subset of `rothDollars`, like
   * `hsaMedicalQualifiedDollars` is of `postTaxCashLikeDollars`. These dollars are tax-free and carry no
   * §408A basis, so `buildSolverPenaltyAccountsForYear` consumes `rothDollars - this` against the basis
   * carrier.
   */
  readonly rothInheritedTaxFreeDollars?: number;
  /**
   * The committed non-inherited designated-Roth portion of the year's Roth draw (pure Roth employer plans and
   * MIXED Roth-designated post sub-buckets), in whole dollars: a subset of `rothDollars`, disjoint from the
   * inherited one. The solver runs it through the pooled §402A pro-rata regime and only the remainder through
   * the §408A carrier.
   */
  readonly rothDesignatedDollars?: number;
  /**
   * The committed inherited designated-Roth portion of the year's Roth draw, in whole dollars: a third
   * disjoint subset of `rothDollars`. The solver runs it through the inherited slice, where the owner's death
   * is the qualifying event (§402A(d)(2)(B)(i)) and the 10% is waived (§72(t)(2)(A)(ii)), never through the
   * §408A carrier.
   */
  readonly rothInheritedDesignatedDollars?: number;
  /**
   * Per-account attribution of the non-inherited Roth-IRA remainder of `rothDollars` (the §408A slice), in
   * whole dollars by account id, so the solver charges each owner's own §408A state, not a housemate's;
   * absent falls back to a single-ledger-owner pick.
   */
  readonly rothIraDollarsByAccountId?: ReadonlyMap<string, number>;
  /**
   * Per-account attribution of `rothDesignatedDollars`, with the same contract as
   * `rothIraDollarsByAccountId`.
   */
  readonly rothDesignatedDollarsByAccountId?: ReadonlyMap<string, number>;
  /** Per-account attribution of `rothInheritedDesignatedDollars`, with the same contract. */
  readonly rothInheritedDesignatedDollarsByAccountId?: ReadonlyMap<string, number>;
  /**
   * Portion of the year's HSA draw funded against modeled `isMedical` demand, in whole dollars: a subset of
   * `postTaxCashLikeDollars`. The solver passes it to `PenaltyAccountSnapshot.hsaMedicalQualifiedDollars` so
   * the §223(f)(4) nonqualified basis narrows to the emergency residual, as in the committing post-pass.
   */
  readonly hsaMedicalQualifiedDollars?: number;
  /**
   * The classifier-modeled HSA total draw (medical-first qualified plus emergency residual), in whole
   * dollars. When present the solver uses it as the §223(f)(4) HSA basis instead of a balance-share estimate,
   * so the funding gross-up matches the committing kernel.
   */
  readonly hsaWithdrawalDollars?: number;
}

/**
 * Outcome of one year's tax-cashflow solve, returned so the engine can raise the target and stamp the row's
 * diagnostics.
 */
export interface TaxCashflowYearOutcome {
  /**
   * Same-year amount to add to the net withdrawal target, in dollars: the cash tax need
   * (`totalTaxCashflowNeedCents`) plus the IRMAA withheld from Social Security (the check shrinks while the
   * income series spends gross SS), minus `acaCreditAppliedToPremiumsCents`, so it can be negative but never
   * below minus the year's ordinary need.
   */
  readonly addedNeedDollars: number;
  readonly federalTaxCashNeedCents: number;
  readonly irmaaWithheldFromSsCents: number;
  readonly irmaaCashNeedCents: number;
  readonly acaPtcCashflowOffsetCents: number;
  readonly acaCreditAppliedToPremiumsCents: number;
  readonly totalTaxCashflowNeedCents: number;
  readonly taxCashflowIterations: number;
  readonly taxCashflowConverged: boolean;
  readonly taxCashflowShortfallCents: number;
}

/**
 * Per-year tax-cashflow hook the runner injects. The engine calls
 * `solveForYear(yearIndex, ordinaryNetNeedDollars, classify)` once per year before the committing draw, where
 * `classify(targetDollars)` returns the per-bucket split the withdrawals would produce. The hook never
 * throws.
 */
export type TaxCashflowHook = {
  /**
   * True when the runner reprices each Fill-converted year without its conversion, so the engine records the
   * draws that paid the conversion's tax (`DrawdownYear.rothConversionTaxFundingCentsByAccount`).
   */
  readonly recordsConversionZeroPoint?: boolean;
  readonly solveForYear: (
    yearIndex: number,
    ordinaryNetNeedDollars: number,
    classify: (targetDollars: number) => TaxCashflowYearClassification,
  ) => TaxCashflowYearOutcome;
  /**
   * Fill-mode Roth-conversion solve, called once per year after the monthly loop when a MAGI cap is active
   * under Fill with a target Roth and headroom. Runs the outer bisection on the committed classification and
   * returns the converted dollars, sized so realized MAGI lands at the ceiling and rounded down to whole
   * cents. Side-effect-free; consumes no RNG.
   */
  readonly solveFillConversionForYear?: (
    yearIndex: number,
    withdrawalClassification: TaxCashflowYearClassification,
    convertibleRoomDollars: number,
    capMagiLine: 'irmaa' | 'aca',
    magiCeilingDollars: number,
  ) => number;
  /**
   * Funds the same-year incremental ordinary-income tax a committed conversion creates: returns the extra
   * same-year cash need (federal plus IRMAA cash minus ACA offset), the delta between the
   * conversion-inclusive and withdrawals-only solves, regardless of `capMagiLine`.
   * It replaces the year's live IRMAA look-back MAGI sample with the conversion-inclusive one, so the Y+2
   * surcharge is funded. Paired with `solveFillConversionForYear`.
   */
  readonly fundConversionTaxForYear?: (
    yearIndex: number,
    withdrawalClassification: TaxCashflowYearClassification,
    convertedDollars: number,
  ) => number;
};

/** Per-owner metadata and calibration the engine needs for the RMD floor at each year start. */
export interface RmdContextInput {
  /**
   * Owner-id keyed metadata: birthdate (trigger age and divisor) and projected death year (the engine skips
   * the floor after it).
   */
  readonly ownerMeta: ReadonlyMap<string, { readonly isoBirthdate: string; readonly deathYear: number }>;
  /**
   * Account id to owner id, so the per-owner floor enforces only against that owner's qualifying accounts.
   */
  readonly ownerByAccountId: ReadonlyMap<string, string>;
  /** RMD calibration snapshot — the engine forwards this to `computeRmd`. */
  readonly rmdSnapshot: import('./calibration').CalibrationSnapshot<import('./rmd').RmdTable>;
  /**
   * Per-account stored RMD profile facts by account id, so the forced withdrawal resolves the same
   * per-account rule as the tax floor and the disclosures. A plain `Record` because the MC path rebuilds it
   * from the structured-clone-safe `McRmdContext`. Accounts with no recorded fact are absent, and the field
   * is omitted for a fact-free household, keeping `computeRmd` on its legacy branch.
   */
  readonly rmdFactsByAccountId?: Readonly<Record<string, import('./rmd').RmdAccountProfileFacts>>;
  /**
   * Each owner's separation-from-service calendar year by owner id, for the §401(a)(9)(C) later-of first
   * distribution year; an absent owner makes that resolution withhold rather than assume the trigger-age
   * year.
   */
  readonly retirementYearByOwner?: Readonly<Record<string, number>>;
}

/**
 * One resolved QCD directive for the forced-outflow pass; `endYear` is exclusive (a single-year gift has
 * `startYear === endYear - 1`) and the directing member is the source account's owner.
 */
interface QcdContextEntry {
  readonly memberId: string;
  readonly sourceAccountId: string;
  /**
   * Real (today's-dollars) annual amount; the engine inflates it to nominal per year via
   * `inflationFactorForYear`.
   */
  readonly annualAmountDollars: number;
  /** First active tax year (inclusive), already clamped to the 70½ floor. */
  readonly startYear: number;
  /** Exclusive end tax year (active THROUGH `endYear − 1`). */
  readonly endYear: number;
}

/**
 * Per-owner QCD context for the 70½-gated forced-outflow pass: metadata and calibration only, since the
 * engine reads the source IRA's prior-year-end balance itself.
 */
export interface QcdContextInput {
  /** Resolved QCD directives across both owners. */
  readonly entries: ReadonlyArray<QcdContextEntry>;
  /**
   * Owner id to first 70½-eligible tax year; an owner with no birthdate is absent and skipped, never forced
   * out before 70½.
   */
  readonly firstEligibleYearByOwner: ReadonlyMap<string, number>;
  /** Cumulative inflation factor applied to the real annual amount for the tax year. */
  readonly inflationFactorForYear: (taxYear: number) => number;
  /**
   * The indexed per-person §408(d)(8) QCD exclusion limit for the tax year, in integer cents, extrapolated
   * forward past the latest published year.
   */
  readonly qcdLimitCentsForYear: (taxYear: number) => number;
}

/** One per-account ledger entry for the per-account drawdown branch. */
export interface DrawdownAccountInput {
  readonly id: string;
  readonly initialPre: number;
  readonly initialPost: number;
  /** Annual return rate, percent, converted to the monthly factor via `monthlyEquivalent()`. */
  readonly annualRatePct: number;
  /**
   * Per-month deposit dollars routed to this account (CBP lump-sum, targeted one-off, and a post-primary
   * spouse contribution's pre-tax slice), landing in the bucket its tax treatment selects (the pre-tax slice
   * always in `pre`).
   */
  readonly depositsByMonth: MonthlyCashflowSeries;
  /**
   * Per-month post-primary spouse post-tax (designated-Roth) slice, always landing in `post` (a MIXED
   * account's Roth slice stays RMD-exempt, §325); omitted means zero.
   */
  readonly depositsPostByMonth?: MonthlyCashflowSeries;
  /** Tax treatment, used to classify per-account withdrawals. */
  readonly taxTreatment: AccountTaxTreatment;
  /** Account type, used with `taxTreatment` to identify Roth accounts. */
  readonly accountType: AccountType;
  /**
   * Per-month per-account return percent, from Monte Carlo (the sampled return) or a deterministic allocation
   * (the blended glide return over the full-run step domain). When present the engine grows the account by
   * `1 + returnPctByMonth[stepIdx] / 100` instead of the scalar rate; its length must equal `yearCount * 12`.
   */
  readonly returnPctByMonth?: Float64Array;
  /**
   * Per-account minimum-balance floor in dollars: a discretionary withdrawal never drops the account below
   * it, so it contributes `max(0, balance - floor)` and surplus re-enters automatically. Floor-eligible
   * accounts only (`POST_TAX`, `HSA`); `floorHsaMode` governs HSA. RMD forced draws are not floor-limited.
   */
  readonly floorDollars?: number;
  /**
   * HSA floor mode, for an HSA account with a positive `floorDollars`: `'emergencyOnly'` (default) blocks
   * only the emergency draw, compared against the post-medical-pass balance; `'strict'` also blocks medical
   * draws. Ignored for POST_TAX accounts.
   */
  readonly floorHsaMode?: 'emergencyOnly' | 'strict';
}

/**
 * Per-bucket gain detail from the runner post-pass under allocation: `gain` is the total gain split by the
 * year's glide growth share, an estimate rather than a realized per-bucket placement. Feeds the Gains
 * tooltip.
 */
interface DrawdownBucketYear {
  gain: number;
}

/** Per-account year row, emitted only when the engine ran the per-account branch. */
export interface DrawdownAccountYear {
  readonly balance: number;
  readonly preEnd: number;
  readonly postEnd: number;
  readonly withdrawn: number;
  readonly deposit: number;
  /**
   * Dec 31 balance of the prior year's pre-tax sub-bucket, captured in the representative-run build; the MC
   * RMD post-pass uses it as the RMD base for the boundary year when the prior row has no `accountBalances`.
   */
  readonly priorPreEnd?: number;
  /**
   * Withdrawn portion from the pre-tax sub-bucket; pre plus post equals `withdrawn` within fp residue. Absent
   * without a per-account split.
   */
  readonly preWithdrawnCents?: number;
  /** Withdrawn portion from the post-tax sub-bucket; same provenance as `preWithdrawnCents`. */
  readonly postWithdrawnCents?: number;
  /**
   * Portion of this HSA account's withdrawal funded against modeled `isMedical` demand, in integer cents;
   * qualified by construction (an approximation of 100% §223 qualification), HSA accounts only.
   * Residual rule: this plus the emergency cents (committed `round(withdrawn * 100)` minus this) sum to the
   * committed cents; the emergency portion is the residual, never rounded independently.
   */
  readonly medicalQualifiedWithdrawnCents?: number;
}

/**
 * Withdrawn cents from one account row that count toward its required minimum distribution (SECURE 2.0 §325);
 * shared by `hasRmdShortfall`, `derivePerAccountRmdShortfallCents` and the MC RMD post-pass.
 * PRE_TAX counts in full; MIXED only the pre-tax tranche (the designated-Roth sub-account is separate and
 * RMD-exempt, §325; 0 without the split, conservatively); a pure Roth account in full, because an inherited
 * Roth is subject to post-death distributions (§401(a)(9)(B)) and the amount taken out satisfies them
 * whatever its tax treatment; HSA 0.
 */
export function rmdEligibleWithdrawnCents(
  row: DrawdownAccountYear,
  taxTreatment: AccountTaxTreatment,
): number {
  if (taxTreatment === 'PRE_TAX') return Math.round(row.withdrawn * 100);
  if (taxTreatment === 'MIXED') return row.preWithdrawnCents ?? 0;
  if (taxTreatment === 'POST_TAX' || taxTreatment === 'ROTH') {
    return Math.round(row.withdrawn * 100);
  }
  return 0;
}

export interface DrawdownYear {
  year: number;
  balance: number;
  withdrawn: number;
  netNeed: number;
  growth: number;
  deposit: number;
  depleted: boolean;
  /**
   * Estimated growth/income gain attribution under allocation
   * (`growthBucket.gain = nonCbpGain * growthShare`, `incomeBucket.gain = year.growth - growthBucket.gain`),
   * for the Gains tooltip; not a realized placement.
   */
  growthBucket?: DrawdownBucketYear;
  incomeBucket?: DrawdownBucketYear;
  /**
   * Target growth share (`targetGrowthShareForStep`) for the year; absent without an allocation override.
   */
  growthPct?: number;
  accountBalances?: ReadonlyMap<string, DrawdownAccountYear>;
  /**
   * Per-owner year-end pre-tax (RMD-eligible) sub-bucket totals in integer cents, indexed by `input.owners`;
   * populated only by `runYearByYearStrategyAware`'s retirement-year loop and absent on accumulation rows.
   * MIXED accounts contribute only their pre-tax sub-bucket (SECURE 2.0 §325); Roth, brokerage and HSA
   * contribute 0. Builds `priorPreTaxByOwner` for `computeMcRmdFloorCents`.
   */
  preTaxCentsByOwnerIdx?: readonly number[];
  /**
   * Per-owner already-resolved required-withdrawal cents for the following tax year, for accounts that carry
   * recorded RMD facts and are excluded from the pooled pre-tax basis above (inherited schedule,
   * still-working deferral, Table II divisor or a withheld result cannot be pooled). Produced by
   * `buildMcFactRmdRequiredCentsByOwnerIdx` via `computeRmd`; absent for a fact-free household.
   */
  factRmdRequiredCentsByOwnerIdx?: readonly number[];
  // Federal income tax owed for the year, in integer cents.
  federalTaxCents?: number;
  /** Taxable portion of gross SS benefits per IRS §86, in integer cents. */
  taxableSsCents?: number;
  /** §86 tier applied: 'none' / 'fifty' / 'eighty-five'. */
  ssTaxationTier?: 'none' | 'fifty' | 'eighty-five';
  /** RMD floor enforced for the year, in integer cents. */
  rmdFloorCents?: number;
  /** Portion of RMD not met by portfolio withdrawals (emergency cash), in integer cents. */
  rmdShortfallCents?: number;
  /**
   * Per-account required RMD in integer cents by account id (both owners merged), decomposing `rmdFloorCents`
   * within 1 cent of largest-remainder rounding; only pre-tax and MIXED-pre-tax sub-buckets appear. `{}` when
   * no account qualifies, absent below the owner's SECURE 2.0 trigger age.
   * Display-only: stamped by the deterministic tax post-pass, never on the engine, kernel or MC paths, so it
   * needs no `ENGINE_VERSION` bump.
   */
  perAccountRmdCents?: Record<string, number>;
  /**
   * RMD surplus (forced withdrawal beyond the year's net need) reinvested into a real POST_TAX non-Roth
   * account, in integer cents; at most one of this and `rmdOverflowToCashCents` is non-zero per run. It stays
   * in the portfolio, and the full forced RMD stays ordinary taxable income.
   */
  rmdReinvestedCents?: number;
  /**
   * RMD surplus held as cash in a synthetic POST_TAX cash-like account, used when the household has no real
   * POST_TAX non-Roth account. It stays in the projected balance, grows 0%, carries $0 MAGI, and is spent
   * before any pre-tax draw in later years.
   */
  rmdOverflowToCashCents?: number;
  /** Total household Medicare IRMAA surcharge for the year, in integer cents. */
  irmaaSurchargeCents?: number;
  /** IRMAA tier applied: 'none' | 'tier1'…'tier5'. */
  irmaaTier?: 'none' | 'tier1' | 'tier2' | 'tier3' | 'tier4' | 'tier5';
  /** ACA PTC subsidy received for the year, in integer cents. */
  acaPtcSubsidyCents?: number;
  /** ACA PTC eligibility tier. */
  acaPtcTier?: 'below-fpl' | 'sliding' | 'cap-applies' | 'above-400-cliff';
  /**
   * Dollars of pre-tax withdrawal over the MAGI cap this year: either the cap-aware tier loop found no later
   * taxable balance to absorb the overage, or the mandatory RMD floor forced pre-tax above
   * `magiCeilingAnnualDollars`. Zero or absent means the cap held.
   */
  magiCapBreachDollars?: number;
  /**
   * Dollars routed from the cap-active tier to a later-tier taxable account via skip-ahead; when non-zero,
   * `magiCapBreachDollars` is 0 for the same year.
   */
  magiCapTierOverrideDollars?: number;
  /**
   * Dollars moved from a pre-tax or MIXED-pre bucket into the target Roth by a Fill-mode conversion, in
   * integer cents. It is an internal transfer, taxed as ordinary income but never charted as an inflow.
   * Populated only on the per-account strategy path under an active Fill cap.
   */
  rothConvertedCents?: number;
  /**
   * Cents drawn from each account to pay the year's conversion tax; recorded only when the tax hook sets
   * `recordsConversionZeroPoint`.
   */
  rothConversionTaxFundingCentsByAccount?: ReadonlyMap<string, number>;
  /**
   * The year's federal/IRMAA MAGI with the conversion and its tax draws taken out, in integer cents; stamped
   * on the deterministic path for a year that converted.
   */
  rothZeroConversionMagiCents?: number;
  /** Taxable Social Security of the same repricing, in integer cents. */
  rothZeroConversionTaxableSsCents?: number;
  /**
   * True when Fill mode had leftover cap headroom but no target Roth could be resolved (none designated, or
   * the id is dangling, deleted or non-Roth), so the engine converted $0 and the page shows a "no target
   * Roth" notice.
   */
  rothConversionDegradedNoTarget?: boolean;
  /** Household MAGI for the year, in integer cents. */
  magiCents?: number;
  /** Household MAGI as a percentage of FPL (e.g. 250 = 250%). */
  fplPercentage?: number;
  /** Effective federal tax rate: totalTax / grossIncome (0–1). */
  effectiveTaxRate?: number;
  /** Net withdrawal after deducting federal tax and adding PTC subsidy, in integer cents. */
  netAfterTaxCents?: number;
  /** True when the tax year was extrapolated beyond the latest snapshot year. */
  taxYearExtrapolated?: boolean;
  /** Federal income tax funded as a same-year cash need, in integer cents. */
  federalTaxCashNeedCents?: number;
  /** IRMAA surcharge withheld from Social Security (no cash draw), integer cents. */
  irmaaWithheldFromSsCents?: number;
  /** IRMAA surcharge paid as a same-year cash need, integer cents. */
  irmaaCashNeedCents?: number;
  /** ACA PTC offset applied against the tax cashflow need, integer cents. */
  acaPtcCashflowOffsetCents?: number;
  /** The ACA credit that lowered the year's draw, integer cents; not part of
   *  `totalTaxCashflowNeedCents`. */
  acaCreditAppliedToPremiumsCents?: number;
  /** Total same-year tax cashflow need funded into the withdrawal target,
   *  integer cents: `max(0, federalTax + irmaaCash − acaPtcOffset)`. */
  totalTaxCashflowNeedCents?: number;
  /** Number of solver passes executed for the year (1..8). */
  taxCashflowIterations?: number;
  /** True when the solver's net tax cost converged before the pass cap. */
  taxCashflowConverged?: boolean;
  /**
   * Dollars of the grossed-up withdrawal the portfolio could not supply, in integer cents; zero when fully
   * fundable.
   */
  taxCashflowShortfallCents?: number;
  /**
   * IRA/401k-style 10% early-distribution additional tax, in integer cents; already in `federalTaxCents`.
   */
  earlyWithdrawalPenaltyCents?: number;
  /** HSA 20% additional tax on nonqualified pre-65 withdrawals, integer cents. */
  hsaAdditionalTaxCents?: number;
  /**
   * True when a penalizable account's owner birthdate was missing or unparseable, so its penalty was skipped;
   * shown in the estimate note.
   */
  penaltySkippedForMissingBirthdate?: boolean;
  /**
   * Account ids whose required withdrawal is withheld this year (a required inherited-account fact is missing
   * or the combination is unsupported), each contributing $0 to `rmdFloorCents`. Stamped by the deterministic
   * post-pass only; the page turns it into per-year notes.
   */
  rmdWithheldAccountIds?: readonly string[];
  /**
   * Account ids whose required withdrawal is deferred this year by the §401(a)(9)(C) still-working exception
   * (a legitimate $0).
   */
  rmdStillWorkingDeferredAccountIds?: readonly string[];
  /**
   * Account ids whose first required withdrawal is deferred to April 1 of the following year, so that year
   * carries two.
   */
  rmdFirstYearDeferredAccountIds?: readonly string[];
  /** Deferred prior-year required withdrawal folded into this year's `rmdFloorCents`, in integer cents. */
  rmdDeferredCatchUpCents?: number;
  /**
   * Qualified Charitable Distribution total directed from the owner's source IRA this year, in integer cents:
   * a first-dollars slice that leaves the portfolio once (subtracted from the forced-RMD base, never
   * reinvested) and is excluded from ordinary income and MAGI. Populated by the 70½-gated pass on the
   * per-account strategy path; absent or 0 when none applies.
   */
  qcdCents?: number;
  /**
   * Net taxable RMD after the QCD offset, in integer cents: `gross IRA-pool RMD - min(Q, gross)` summed
   * across owners. Display only; populated alongside `qcdCents`.
   */
  netTaxableRmdCents?: number;
  /**
   * Per-owner QCD RMD offset in integer cents (`min(Q_owner, grossIraPoolRmd_owner)`) by owner id. The QCD is
   * debited straight to the source IRA's pre-tax bucket and counts toward the owner's IRA-pool RMD (IRC
   * §408(d)(8)), so the tax post-pass credits it to that pool when computing `rmdShortfallCents`; IRA pool
   * only, never the 401k/457/TSP/CBP pools.
   */
  qcdRmdOffsetCentsByOwner?: Readonly<Record<string, number>>;
  /**
   * The cumulative inflation factor the engine used to inflate the real QCD amount to nominal `qcdCents`,
   * anchored at the year end (deterministic: December `inflationFactorAt`; MC: the path's year-end `cumCpi`).
   * Display only: the today's-dollars surfaces divide `qcdCents` by it, and it stays authoritative because
   * under MC it is the path's own CPI.
   */
  qcdInflationFactor?: number;
  /**
   * True when this year's IRMAA look-back MAGI was estimated from the projected first-year MAGI
   * (`magiBuffer[0]`) because the member is on Medicare in year 0 or 1 with no stored two-years-prior
   * bootstrap. Set even when the estimate falls back to $0, so the disclosure always fires.
   */
  magiEstimatedFromProjection?: boolean;
  /**
   * True when this year is charged an IRMAA surcharge while the plan models no medical spending at all: base
   * Medicare, Medigap/Advantage and drug-plan premiums are user-entered, so the plan understates health
   * costs. Drives the readiness warning; not set when any medical spending is recorded, since the base
   * premium may or may not be in it.
   */
  medicareBasePremiumMissing?: boolean;
}

export interface DrawdownOutput {
  years: DrawdownYear[];
  depletionYear: number | null;
  perMonthWithdrawal: Float64Array;
}
