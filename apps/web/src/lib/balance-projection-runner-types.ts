/**
 * Shared types for the balance-projection runner and its Monte Carlo bundle assembler, including
 * `PipelineContext`.
 */
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  RetirementAgePerMember,
  SocialSecurityBenefitPayload,
} from '../db/types';
import type {
  ScenarioAggregate,
  resolveScenario,
} from './scenario-resolution';
import type { TaxCalibrationBundle } from './tax-integration';
// Imported from leaf modules so the context type stays cycle-free.
import type { RothDistributionFacts } from './roth-distribution-tax';
import type { RmdAccountProfileFacts } from './rmd';
import type { ProjectionContext } from './projection-context';
import type { ProjectionOutput } from './projection';
import type {
  ClassifiedDepositEvent,
  MonthlyExpenseRow,
  MonthlyIncomeRow,
  buildMonthlyDepositSeries,
  buildMonthlyExpenseSeries,
  buildMonthlyIncomeSeries,
} from './balance-projection-bundle';

/** Optional candidate SS override applied above the resolved chain. */
export interface CandidateOverlay {
  readonly socialSecurity: {
    readonly primary: RetirementAgePerMember;
    readonly secondary?: RetirementAgePerMember;
    /** Per-member survivor claim ages; absent preserves the target's stored `survivor` section. */
    readonly survivor?: {
      readonly primary?: RetirementAgePerMember;
      readonly secondary?: RetirementAgePerMember;
    };
  };
}

/**
 * Which per-account return rate the runner uses: `'planned'` is the planning return, `'twr'` the empirical
 * time-weighted return (null with under two yearly balances, falling back to the planned rate).
 */
export type ProjectionMethod = 'planned' | 'twr';

export interface RunBalanceProjectionArgs {
  readonly scenarioId: string;
  readonly scenarios: ReadonlyArray<ScenarioAggregate>;
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly balances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  readonly ssBenefits: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  readonly expenses: ReadonlyArray<Aggregate<ExpensePayload>>;
  readonly incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  /**
   * Anchor as plain numbers, not a `Date`: the call site picks the timezone (page: local; optimizer: UTC);
   * echoed back on the result so the renderer's `viewDeflator` reads one source.
   */
  readonly todayYear: number;
  readonly todayMonthIndex: number;
  readonly candidateOverlay?: CandidateOverlay;
  /** Defaults to `'planned'`. */
  readonly method?: ProjectionMethod;
  /** Calibration bundle for the five tax engines; defaults to `DEFAULT_TAX_CALIBRATION_BUNDLE`. */
  readonly taxBundle?: TaxCalibrationBundle;
  /**
   * Precomputed ids of the household's `isMedical` categories (structured-clone-safe). Every `.categoryRates`
   * consumer must read it through `medicalCategoryIdSet(args.medicalCategoryIds)` or MC and deterministic
   * parity breaks; absent falls back to the seeded `cat-medical` id, and an empty array means no medical
   * categories.
   */
  readonly medicalCategoryIds?: ReadonlyArray<string>;
}

interface RunBalanceProjectionAtHorizonResult {
  readonly atHorizonTodayDollars: number;
  readonly ssStartYear: number;
  readonly retirementYear: number;
  readonly horizonYear: number;
  readonly ctx: ProjectionContext;
  /**
   * True when the requested `method` could be evaluated; false for `'twr'` only when no non-CBP account has
   * an empirical rate, in which case `atHorizonTodayDollars` is 0.
   * @132 delete
   */
  readonly methodAvailable: boolean;
}

/** Per-account, per-year balance breakdown for the chart and table; dollar values are nominal. */
export interface AccountYearRow {
  readonly year: number;
  readonly nominalBalance: number;
  readonly growthCarry: number;
  readonly contributionsThisYear: number;
  readonly withdrawalsThisYear: number;
}

/** Drawdown-engine per-year row, surfaced for BPP yearly-table rendering. */
export interface DrawdownYearRow {
  readonly year: number;
  readonly nominalBalance: number;
  readonly withdrawal: number;
  readonly expense: number;
  readonly income: number;
  readonly ss: number;
  readonly deposit: number;
  // Tax-integration fields, mirroring the optional fields on `DrawdownYear`.
  readonly federalTaxCents?: number;
  readonly taxableSsCents?: number;
  readonly ssTaxationTier?: 'none' | 'fifty' | 'eighty-five';
  readonly rmdFloorCents?: number;
  readonly rmdShortfallCents?: number;
  /** RMD surplus reinvested into a real POST_TAX non-Roth account (cents); see `DrawdownYear`. */
  readonly rmdReinvestedCents?: number;
  /** RMD surplus held as cash in the synthetic carrier (cents), preserved in the balance. */
  readonly rmdOverflowToCashCents?: number;
  readonly irmaaSurchargeCents?: number;
  readonly irmaaTier?: 'none' | 'tier1' | 'tier2' | 'tier3' | 'tier4' | 'tier5';
  readonly acaPtcSubsidyCents?: number;
  readonly acaPtcTier?: 'below-fpl' | 'sliding' | 'cap-applies' | 'above-400-cliff';
  readonly acaCreditAppliedToPremiumsCents?: number;
  /**
   * Mirrors `DrawdownYear.magiCapBreachDollars`: pre-tax dollars over the MAGI cap, from a taxable-depletion
   * breach or a mandatory-RMD breach.
   */
  readonly magiCapBreachDollars?: number;
  /**
   * Mirrors `DrawdownYear.magiCapTierOverrideDollars`: cap excess routed to a later-tier taxable account.
   */
  readonly magiCapTierOverrideDollars?: number;
  /**
   * Mirrors `DrawdownYear.rothConvertedCents`: Fill-mode conversion principal this year, integer cents (an
   * internal transfer, not a flow).
   */
  readonly rothConvertedCents?: number;
  /**
   * Mirrors `DrawdownYear.rothConversionDegradedNoTarget`: Fill had headroom but no target Roth resolved.
   */
  readonly rothConversionDegradedNoTarget?: boolean;
  readonly magiCents?: number;
  readonly fplPercentage?: number;
  readonly effectiveTaxRate?: number;
  readonly netAfterTaxCents?: number;
  readonly taxYearExtrapolated?: boolean;
}

export interface WithdrawalEvent {
  readonly month: number;
  readonly amount: number;
  readonly sourceAccountId: string;
}

/**
 * Per-month cashflow series for the chart bands; each is the `MonthlyCashflowSeries` the drawdown engine
 * consumes.
 */
export interface MonthlyCashflowSeriesPublic {
  readonly incomeByMonth: import('./monthly-cashflow').MonthlyCashflowSeries;
  readonly expensesByMonth: import('./monthly-cashflow').MonthlyCashflowSeries;
  readonly depositsByMonth: import('./monthly-cashflow').MonthlyCashflowSeries;
}

export interface LifeExpectancyMarker {
  readonly memberId: string;
  readonly fractionalYear: number;
  readonly label: string;
}

export interface RetirementMarkerOutput {
  readonly memberId: string;
  readonly year: number;
  readonly month0: number;
  readonly label: string;
}

/**
 * Full page bundle returned by `runBalanceProjection`: the narrow result's fields, the rendering surfaces,
 * `cbpResolution` (always set, even when `methodAvailable: false` short-circuits) and the `todayYear` /
 * `todayMonthIndex` round-trip.
 */
export interface RunBalanceProjectionFullResult
  extends RunBalanceProjectionAtHorizonResult {
  readonly accountYears: ReadonlyMap<string, ReadonlyArray<AccountYearRow>>;
  readonly drawdownYears: ReadonlyArray<DrawdownYearRow>;
  readonly withdrawalEvents: ReadonlyArray<WithdrawalEvent>;
  readonly monthlyCashflowSeries: MonthlyCashflowSeriesPublic;
  readonly lifeExpectancyMarkers: ReadonlyArray<LifeExpectancyMarker>;
  readonly retirementMarkers: ReadonlyArray<RetirementMarkerOutput>;
  readonly cbpResolution: CbpValidationResult | null;
  readonly todayYear: number;
  readonly todayMonthIndex: number;
}

export interface AccountProjection {
  readonly account: Aggregate<AccountPayload>;
  readonly latestBalance: number;
  readonly ownerRetirementDate: string | null;
  readonly outputs: Record<ProjectionMethod, ProjectionOutput | null>;
  readonly ratePctByMethod: Record<ProjectionMethod, number | null>;
  readonly perMonthContribution: { preTax: number; postTax: number };
}

/**
 * Per-method deterministic drawdown slice with the raw engine `years`; `null` when the method produced no
 * drawdown (zero portfolio, missing custom order, or a caught MAGI-cap calibration failure).
 */
export interface PageDrawdownMethodResult {
  readonly years: ReadonlyArray<
    import('./drawdown-engine').DrawdownYear
  >;
  readonly depletionYear: number | null;
  readonly perMonthWithdrawal: Float64Array;
  /** Today's-dollar at-horizon portfolio balance for this method. */
  readonly atHorizonTodayDollars: number;
  /** Per-account, per-year nominal balance (accumulation phase). */
  readonly accountYears: ReadonlyMap<string, ReadonlyArray<AccountYearRow>>;
  /**
   * Net at-retirement portfolio this method's drawdown ran against, excluding annuity-elected and
   * pre-retirement-lump-sum-elected CBP; nominal, at the accumulation projection's retirement boundary.
   */
  readonly netPortfolioAtRetirement: number;
}

/**
 * Method-agnostic context the page reads once per scenario, from a single `buildPipelineContext` and
 * `buildCashflowSeries` pass; `accountProjections` is the per-account projection set the breakdown table and
 * chart read.
 * @317 delete
 */
export interface PageSharedContext {
  readonly accountProjections: ReadonlyArray<AccountProjection>;
  readonly monthlyCashflowSeries: MonthlyCashflowSeriesPublic;
  readonly lifeExpectancyMarkers: ReadonlyArray<LifeExpectancyMarker>;
  readonly retirementMarkers: ReadonlyArray<RetirementMarkerOutput>;
  readonly cbpResolution: CbpValidationResult | null;
  readonly ctx: ProjectionContext;
  readonly retirementYear: number;
  readonly horizonYear: number;
  readonly ssStartYear: number;
  readonly methodAvailable: boolean;
  readonly medicalInflationRatePct: number;
  /**
   * Non-CBP accounts without an empirical TWR rate, which project on their planned rate in the Historical
   * view; `[]` when none.
   */
  readonly fallbackAccounts: ReadonlyArray<{ id: string; name: string }>;
  /**
   * Per-calendar-year working-years Roth conversion amount in integer cents (mirrors `PipelineContext`), for
   * the Roth conversions chart's pre-retirement bars.
   */
  readonly preRetirementConversionCentsByYear: ReadonlyMap<number, number>;
  readonly todayYear: number;
  readonly todayMonthIndex: number;
}

/**
 * Both-methods page result from one `runBalanceProjectionForPage` call: the shared context plus the
 * per-method drawdown slices.
 */
export interface RunBalanceProjectionPageResult {
  readonly planned: PageDrawdownMethodResult | null;
  readonly twr: PageDrawdownMethodResult | null;
  readonly sharedCtx: PageSharedContext;
}

export type PreDepositList = ReadonlyArray<{
  year: number;
  month0: number;
  preTax: number;
  postTax: number;
}>;

/**
 * Source-leg pre-tax withdrawals for the working-years Roth-conversion engine, passed to `project()` as
 * `preRetirementWithdrawals`.
 * @360 delete
 */
export type PreWithdrawalList = ReadonlyArray<{
  year: number;
  month0: number;
  preTax: number;
}>;

type ProjectionOutputForCbp = import('./projection').ProjectionOutput;
export type CbpValidationResult = ReturnType<
  typeof import('./cbp-resolution').validateCbpResolution
>;

export interface PipelineContext {
  readonly scenarioId: string;
  readonly method: ProjectionMethod;
  readonly incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  readonly resolvedScenario: ReturnType<typeof resolveScenario>;
  readonly effectiveScenarios: ReadonlyArray<ScenarioAggregate>;
  readonly primary: Aggregate<HouseholdMemberPayload>;
  readonly secondary: Aggregate<HouseholdMemberPayload> | undefined;
  readonly primaryRetIso: string;
  readonly primaryRetirementYear: number;
  readonly primaryRetirementMonth0: number;
  readonly primaryRetirementAbsMonth: number;
  readonly retirementByMember: ReadonlyMap<string, string | null>;
  readonly horizonYear: number;
  readonly horizonAbsMonth: number;
  readonly ssStartYear: number;
  readonly projCtx: ProjectionContext;
  readonly accountProjections: ReadonlyArray<AccountProjection>;
  readonly cbpLumpSumEventAbsMonth: ReadonlyMap<string, number>;
  readonly preDepositsByAccount: ReadonlyMap<string, PreDepositList>;
  /**
   * CBP-only projections built once so cashflow and MC bundle assembly do not re-project them per candidate.
   */
  readonly cbpProjectionByAccount: ReadonlyMap<string, ProjectionOutputForCbp>;
  /** Cached `validateCbpResolution` result; null when there are no CBP accounts. */
  readonly cbpValidation: CbpValidationResult | null;
  /**
   * True when the requested `method` is computable; false for `'twr'` only when no non-CBP account has an
   * empirical rate.
   */
  readonly methodAvailable: boolean;
  /**
   * Non-CBP accounts without an empirical TWR rate (planned rate under Historical); `[]` when none. Passed to
   * `sharedCtx.fallbackAccounts`.
   */
  readonly fallbackAccounts: ReadonlyArray<{ id: string; name: string }>;
  /** Calibration bundle for the five tax engines; defaults to `DEFAULT_TAX_CALIBRATION_BUNDLE`. */
  readonly taxBundle?: TaxCalibrationBundle;
  /**
   * Per-owner remaining Roth-IRA regular-contribution basis (integer cents) by `AccountPayload.ownerId`,
   * derived from balance history: each §408A pool's contributions less its withdrawals (contributions first,
   * then conversion lots FIFO), over the owner's own Roth IRAs, active or inactive. An inherited Roth IRA
   * contributes none.
   * Seeds the deterministic §408A tracker only; the MC tracker re-derives a drawable-only basis
   * (`mcDrawableRothBasisCentsByOwner`).
   */
  readonly rothBasisCentsByOwner: ReadonlyMap<string, number>;
  /**
   * The fact-based Roth distribution facts (`buildRothDistributionFacts`): per-pool Roth-IRA basis, §408A
   * five-year clock and conversion lots, plus per-account designated-Roth basis, clock, in-plan rollover lots
   * and the governmental-457(b) flag. An owner's own Roth IRAs share one pool (Pub 590-B); an inherited Roth
   * IRA has none; designated-Roth accounts never pool and consume basis pro rata.
   */
  readonly rothDistributionFacts: RothDistributionFacts;
  /**
   * Per-account normalized RMD profile facts (`buildRmdProfileFacts`) by account id; accounts with no stored
   * fact are absent, which keeps the Uniform-Lifetime default.
   */
  readonly rmdProfileFactsByAccountId: ReadonlyMap<string, RmdAccountProfileFacts>;
  /**
   * Per-owner working-years converted-principal basis (integer cents). It seeds only the deterministic §408A
   * carrier and stays out of the MC tax context, which does not model the conversion deposit legs.
   */
  readonly preRetirementConversionBasisCentsByOwner: ReadonlyMap<string, number>;
  /**
   * Per-owner pure designated-Roth employer-plan basis (integer cents): each active account's recorded
   * in-plan-rollover principal, $0 when none. No runtime consumer; the funding pass pools designated state
   * from `rothDistributionFacts.designatedByAccount`.
   */
  readonly pureRothBasisCentsByOwner: ReadonlyMap<string, number>;
  /**
   * Per-owner MIXED Roth-designated employer-plan basis (integer cents): recorded in-plan-rollover principal,
   * $0 when none. No runtime consumer, like `pureRothBasisCentsByOwner`.
   */
  readonly mixedRothDesignatedBasisCentsByOwner: ReadonlyMap<string, number>;
  /**
   * Per-owner same-account MIXED in-plan conversion basis (integer cents) from
   * `computePreRetirementRothConversions`. No runtime consumer: funding takes the principal through the dated
   * per-account maps below. Kept to record that it is engine-generated, unlike recorded account facts.
   */
  readonly mixedInPlanConversionBasisCentsByOwner: ReadonlyMap<string, number>;
  /**
   * The same-account MIXED in-plan conversion basis keyed by target account id: credited by the annotation
   * post-pass to that account's own designated-Roth carrier, so a sibling plan never recovers basis it never
   * received, and seeded into the funding pass via `mergeDesignatedRothSeeds`.
   */
  readonly mixedInPlanConversionBasisCentsByAccount: ReadonlyMap<string, number>;
  /**
   * Working-years Roth-IRA conversion principal dated by conversion tax year (owner id, tax year, cents). A
   * conversion starts its own five-tax-year §408A(d)(3)(F) recapture clock, so it seeds a conversion lot, not
   * undated basis. Deterministic only.
   */
  readonly preRetirementConversionBasisCentsByOwnerYear: ReadonlyMap<
    string,
    ReadonlyMap<number, number>
  >;
  /**
   * Same-account MIXED in-plan conversion principal dated by rollover tax year (account id, tax year, cents),
   * seeded as an in-plan rollover lot so its §402A(c)(4)(D) five-tax-year window applies.
   */
  readonly mixedInPlanConversionBasisCentsByAccountYear: ReadonlyMap<
    string,
    ReadonlyMap<number, number>
  >;
  /**
   * Per-calendar-year total working-years Roth conversion amount in integer cents, across all source and
   * target types; drives the chart's pre-retirement bars.
   */
  readonly preRetirementConversionCentsByYear: ReadonlyMap<number, number>;
  /**
   * Household member ids treated as not on the ACA Marketplace (retiree, COBRA or spousal-employer coverage):
   * they get zero Marketplace months unless the scenario states a count, and the benchmark narrows to the
   * remaining members. Always present (`?? []` applied at assembly).
   */
  readonly acaMarketplaceOptOutMemberIds: ReadonlySet<string>;
  /**
   * Per-member, per-tax-year Medicare and ACA Marketplace coverage months from
   * `ScenarioOverrides.healthCoverageMonths`. Absent uses the birthday-month derivation in
   * `resolveMemberHealthCoverage`; an explicit `marketplaceMonths` wins over the opt-out list, and an absent
   * one for an opted-out member is 0.
   */
  readonly healthCoverageMonths?: import('../db/types').HealthCoverageMonthsOverride;
  /** Federal-poverty-level region for the ACA FPL denominator; absent means `'contiguous'`. */
  readonly acaFplRegion?: import('./aca-ptc').AcaFplRegion;
  /**
   * The scenario's medical inflation rate (percent), resolved once; grows the ACA benchmark from its base
   * year in every engine.
   */
  readonly medicalInflationRatePct: number;
  /**
   * Resolved, hardened per-member QCD directives (invalid entries dropped, `start` clamped to the 70½ floor,
   * window in whole tax years); empty `entries` makes the engine pass a no-op.
   */
  readonly resolvedQcd: import('./scenario-resolution').ResolvedQcd;
}

/**
 * Per-month SS run-rate row for the tax-integration pass: `total` is the household rate and `primary` /
 * `secondary` each member's own, so the hybrid-IRMAA split withholds a surcharge only from that member's SS.
 */
export interface SsRunRateRow {
  readonly year: number;
  readonly month0: number;
  readonly total: number;
  /** Primary member's own SS run-rate ($/yr at this month). */
  readonly primary: number;
  /** Secondary member's own SS run-rate ($/yr); absent in single-member households. */
  readonly secondary?: number;
}

export interface CashflowSeries {
  readonly expensesByMonth: ReturnType<typeof buildMonthlyExpenseSeries>;
  readonly incomeByMonth: ReturnType<typeof buildMonthlyIncomeSeries>;
  readonly depositsByMonth: ReturnType<typeof buildMonthlyDepositSeries>;
  readonly expenseRows: ReadonlyArray<MonthlyExpenseRow>;
  readonly nonSsIncomeRows: ReadonlyArray<MonthlyIncomeRow>;
  readonly postPrimaryContributionEvents: ReadonlyArray<ClassifiedDepositEvent>;
  readonly targetedOneOffEvents: ReadonlyArray<ClassifiedDepositEvent>;
  /**
   * Post-retirement plain (non-linked-CBP) pension lump-sum events with their `accountId`, so they place per
   * account rather than through the household-pool spread.
   */
  readonly plainPensionPlacementEvents: ReadonlyArray<ClassifiedDepositEvent>;
  /** Per-month SS income rows (gross, before §86 taxation) for the annual `grossSsDollars`. */
  readonly ssRows: ReadonlyArray<SsRunRateRow>;
  /**
   * Per-month HSA-qualified medical demand in integer cents, a subset of `expensesByMonth` built with the
   * same `(recurring - spike)/12 + spike` bucketing; drives the HSA medical pass, and all-zero makes it a
   * no-op.
   */
  readonly medicalDemandByMonth: ReadonlyArray<number>;
  /**
   * Per-month modeled Medical expenses in integer cents, every `isMedical` row; caps the ACA credit applied
   * to premiums.
   */
  readonly medicalExpenseByMonth: ReadonlyArray<number>;
  /**
   * True when the plan models any `isMedical` expense. Not derived from `medicalDemandByMonth`, which is
   * HSA-filtered: Medicare, Medigap, Medicare Advantage and drug-plan premiums are not HSA-qualified
   * (§223(d)(2)(C)(iv)). Its negation drives the missing-base-Medicare-premium warning.
   */
  readonly anyMedicalSpendingModeled: boolean;
}

export class CbpUnconfiguredError extends Error {
  readonly kind = 'cbp-unconfigured' as const;
  constructor() {
    super('CBP election unconfigured');
    this.name = 'CbpUnconfiguredError';
  }
}

export class NoPrimaryRetirementError extends Error {
  readonly kind = 'no-primary-retirement' as const;
  constructor() {
    super('No primary member or unresolved primary retirement date');
    this.name = 'NoPrimaryRetirementError';
  }
}

/**
 * Thrown by `resolveMagiCapOffYear` when the gating member's birthdate is absent and there is no fallback,
 * since the cap end year cannot be computed.
 */
export class MagiCapCalibrationError extends Error {
  readonly kind = 'magi-cap-calibration' as const;
  constructor(message: string) {
    super(message);
    this.name = 'MagiCapCalibrationError';
  }
}
