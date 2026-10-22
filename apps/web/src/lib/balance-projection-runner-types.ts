/**
 * Internal shared types for `balance-projection-runner.ts` +
 * `balance-projection-runner-mc.ts`. Split out so both files can
 * import the `PipelineContext` shape without a circular import.
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
// The fact-based Roth/RMD profile shapes the pipeline context carries.
// Both are imported from LEAF modules (`roth-distribution-tax` has no imports at
// all; `rmd` never reaches back here) so the context type stays cycle-free.
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
    /** Per-member SURVIVOR claim ages (the independent survivor
     *  dimension). Absent → the target's stored `survivor` section, if any,
     *  is preserved unchanged. */
    readonly survivor?: {
      readonly primary?: RetirementAgePerMember;
      readonly secondary?: RetirementAgePerMember;
    };
  };
}

/**
 * Selects which per-account return rate the runner uses:
 *  - `'planned'` — `account.payload.planningReturnPct` (with any scenario
 *    return override). Always defined.
 *  - `'twr'` — empirical per-account TWR from the balance-history
 *    (`accountReturns(balances).twr`). Null for an account with fewer than
 *    two yearly balances; that account falls back to its planned rate
 *    inside the Historical view. The runner short-circuits with
 *    `methodAvailable: false` only in the degenerate all-fallback case (no
 *    non-CBP account carries an empirical rate).
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
   * Anchor passed as plain numbers, not a `Date`. Removes every
   * `getUTC*` / `get*` call inside the runner — the call site picks
   * the timezone semantics it wants (BPP: local; optimizer: UTC for
   * cross-machine reproducibility). The runner echoes these back on
   * `RunBalanceProjectionFullResult.todayYear` / `todayMonthIndex` so
   * the renderer's `viewDeflator` reads from one compile-visible
   * source.
   */
  readonly todayYear: number;
  readonly todayMonthIndex: number;
  readonly candidateOverlay?: CandidateOverlay;
  /** Defaults to `'planned'` for backwards compatibility — every legacy
   *  caller continues to read planned. */
  readonly method?: ProjectionMethod;
  /** Optional calibration bundle for the five tax engines. Defaults to
   *  `DEFAULT_TAX_CALIBRATION_BUNDLE` when absent. Tests inject a trimmed
   *  bundle to avoid importing the full calibration constants. */
  readonly taxBundle?: TaxCalibrationBundle;
  /**
   * Precomputed ids of the household's `isMedical` categories — the flag-
   * derived medical-id set. Each id materialises the uncapped
   * `general + DEFAULT_MEDICAL_INFLATION_SPREAD_PCT` inflation default the
   * chain hasn't set. A plain `ReadonlyArray<string>` (structured-clone-safe,
   * rides the existing MC/optimizer worker serialization — no new boundary).
   *
   * SINGLE-SOURCE RULE: every `.categoryRates`-consuming caller off one
   * `RunBalanceProjectionArgs` reads THIS field via the shared
   * `medicalCategoryIdSet(args.medicalCategoryIds)` adapter
   * (`lib/expense-category-resolvers.ts`); a missed caller would silently
   * diverge and break MC↔deterministic parity. Absent ⇒ the adapter falls
   * back to the seeded `cat-medical` id. An empty array
   * means "no medical categories".
   */
  readonly medicalCategoryIds?: ReadonlyArray<string>;
}

/**
 * Narrow at-horizon facade — what the optimizer's per-candidate hot
 * path needs. Same shape as the legacy `RunBalanceProjectionResult`.
 * Kept separate from the full-result so the optimizer doesn't allocate
 * the BPP-rendering bundle 81×N times.
 */
export interface RunBalanceProjectionAtHorizonResult {
  readonly atHorizonTodayDollars: number;
  readonly ssStartYear: number;
  readonly retirementYear: number;
  readonly horizonYear: number;
  readonly ctx: ProjectionContext;
  /** True when the requested `method` could be evaluated end-to-end.
   *  Planned is always true. For `'twr'`: false only in the degenerate
   *  all-fallback case (no active non-CBP account has an empirical rate);
   *  a single short-history account falls back to its planned rate instead.
   *  The runner returns `atHorizonTodayDollars: 0` in the
   *  degenerate case and callers surface the "Insufficient history" branch. */
  readonly methodAvailable: boolean;
}

/** Back-compat alias retained for existing callers. */
export type RunBalanceProjectionResult = RunBalanceProjectionAtHorizonResult;

/**
 * Per-account, per-year balance breakdown surfaced for BPP rendering
 * (chart bands, year-by-year table). All dollar values are nominal —
 * the renderer applies `realDeflatorAt(ctx, year, 11)` before display.
 */
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
  // Tax-integration fields — populated for EVERY named withdrawalStrategy
  // (tax cashflow funds all strategies). Mirror the optional fields on
  // DrawdownYear so BPP can render tax detail rows.
  readonly federalTaxCents?: number;
  readonly taxableSsCents?: number;
  readonly ssTaxationTier?: 'none' | 'fifty' | 'eighty-five';
  readonly rmdFloorCents?: number;
  readonly rmdShortfallCents?: number;
  /** RMD surplus reinvested into a real POST_TAX-non-Roth account (cents).
   *  Surplus disposition split with `rmdOverflowToCashCents` — see
   *  `DrawdownYear`. */
  readonly rmdReinvestedCents?: number;
  /** RMD surplus held as cash in the synthetic carrier (cents), preserved in
   *  the balance. */
  readonly rmdOverflowToCashCents?: number;
  readonly irmaaSurchargeCents?: number;
  readonly irmaaTier?: 'none' | 'tier1' | 'tier2' | 'tier3' | 'tier4' | 'tier5';
  readonly acaPtcSubsidyCents?: number;
  readonly acaPtcTier?: 'below-fpl' | 'sliding' | 'cap-applies' | 'above-400-cliff';
  /** Mirrors `DrawdownYear.acaCreditAppliedToPremiumsCents`. */
  readonly acaCreditAppliedToPremiumsCents?: number;
  /** Mirrors `DrawdownYear.magiCapBreachDollars` — pre-tax dollars exceeding the
   *  MAGI cap this year. Populated by either (1) taxable-depletion breach
   *  (cap-aware tier loop ran out of later taxable balance to absorb the overage),
   *  or (2) mandatory-RMD breach (pre-loop RMD enforcement forced pre-tax
   *  above `magiCeilingAnnualDollars`). */
  readonly magiCapBreachDollars?: number;
  /** Mirrors `DrawdownYear.magiCapTierOverrideDollars` — cap-excess routed to a
   *  later-tier taxable account via skip-ahead. */
  readonly magiCapTierOverrideDollars?: number;
  /** Mirrors `DrawdownYear.rothConvertedCents` — dollars moved from pre-tax /
   *  MIXED-pre into the target Roth via a Fill-mode auto-conversion this year
   *  (integer cents). An internal transfer, NOT a Portfolio Flow. */
  readonly rothConvertedCents?: number;
  /** Mirrors `DrawdownYear.rothConversionDegradedNoTarget` — Fill mode had cap
   *  headroom but no target Roth resolved, so it converted $0 (the page
   *  surfaces a "no target Roth" notice). */
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
 * Per-month cashflow series surfaced for BPP chart bands. Each field
 * is the same `MonthlyCashflowSeries` the drawdown engine consumes —
 * the renderer reads `values[k]` for the (startYear + month) bucket.
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
 * Full BPP-rendering bundle. Returned by `runBalanceProjection`. Carries:
 *
 *  - every field on the legacy narrow result (carry-forward; existing
 *    callers reading those fields work unchanged);
 *  - additive BPP-rendering surfaces (`accountYears`, `drawdownYears`,
 *    `monthlyCashflowSeries`, marker arrays);
 *  - `cbpResolution` — unconditional (ordering invariant: phase
 *    order is CBP-validation → method-availability check → projection;
 *    set even when `methodAvailable: false` short-circuits);
 *  - `todayYear` / `todayMonthIndex` — typed identity round-trip from
 *    the caller's args.
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
 * Per-method deterministic drawdown slice of the page result. Carries
 * the RAW drawdown-engine `years` (with `accountBalances` / `growth` /
 * bucket detail / `depleted`) so the page's chart, year-by-year table,
 * portfolio-flow, and account-balance-stack surfaces consume it directly —
 * no thinning that would strand a surface on the page-local pipeline.
 * `null` when the method produced no drawdown (zero portfolio, missing
 * custom order, MAGI-cap calibration failure — caught + logged).
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
  /** Net at-retirement portfolio total this method's drawdown ran against —
   *  `computePortfolioAtRetirement`'s already-computed figure (excludes
   *  annuity-elected and pre-retirement-lump-sum-elected CBP accounts),
   *  surfaced rather than discarded so the SWR comparison (a later page-level
   *  consumer) can read it. NOMINAL, struck at the accumulation projection's
   *  retirement boundary — the same quantity `displayedTotals` deflates via
   *  `viewDeflator(retirementYear, 11)`. Additive: every other reader of this
   *  result (Dashboard, PDF export, stress/optimizer) ignores the field. */
  readonly netPortfolioAtRetirement: number;
}

/**
 * Shared (method-agnostic) context the page reads once per scenario.
 * Built from a single `buildPipelineContext` + `buildCashflowSeries`
 * pass so the page's twice-per-scenario (Planned + TWR) call does NOT
 * rerun the agnostic phase. `accountProjections` is the canonical
 * per-account projection set
 * the page's per-account breakdown table + chart rows consume (replacing
 * the page-local `loadPageData` re-projection).
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
  /** `PipelineContext.medicalInflationRatePct`. */
  readonly medicalInflationRatePct: number;
  /** Non-CBP accounts that lack an empirical TWR rate and so project
   *  on their planned rate inside the Historical view. Drives the inline
   *  disclosure note. Non-optional; `[]` when none fell back. */
  readonly fallbackAccounts: ReadonlyArray<{ id: string; name: string }>;
  /** Per-calendar-year total working-years Roth conversion amount in INTEGER
   *  CENTS. Mirrors `PipelineContext.preRetirementConversionCentsByYear`; surfaced
   *  here so chart builders that receive only `PageSharedContext` can include
   *  pre-retirement bars in the Roth conversions chart. */
  readonly preRetirementConversionCentsByYear: ReadonlyMap<number, number>;
  readonly todayYear: number;
  readonly todayMonthIndex: number;
}

/**
 * Both-methods page result. One `runBalanceProjectionForPage` call
 * returns the agnostic `sharedCtx` plus the per-method drawdown slices —
 * the page issues a single call instead of two `runBalanceProjection`
 * calls, eliminating the duplicate agnostic-phase work.
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

/** Source-leg pre-tax withdrawals for the working-years Roth-conversion engine
 *  — keyed by source account in `preWithdrawalsByAccount`, threaded into
 *  `project()` as `preRetirementWithdrawals`. */
export type PreWithdrawalList = ReadonlyArray<{
  year: number;
  month0: number;
  preTax: number;
}>;

// Forward type aliases — declared before `PipelineContext` so the
// interface reads top-down without a forward reference.
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
  /** CBP-only projections pre-built once during context construction.
   *  Threaded through so per-triple hot-path callers (cashflow,
   *  MC bundle assembly) can reuse them instead of re-projecting the
   *  same CBP accounts on every candidate (perf). */
  readonly cbpProjectionByAccount: ReadonlyMap<string, ProjectionOutputForCbp>;
  /** Cached `validateCbpResolution` result; null when no CBP accounts
   *  are present. Lets `assembleMcBundle` skip re-running validation
   *  on every triple. */
  readonly cbpValidation: CbpValidationResult | null;
  /** True when the requested `method` is computable end-to-end. Planned is
   *  always true. For `'twr'`: false only in the degenerate all-fallback
   *  case (no active non-CBP account carries an empirical rate); a single
   *  short-history account falls back to its planned rate. The
   *  runner short-circuits with a sentinel zero in the degenerate case. */
  readonly methodAvailable: boolean;
  /** Non-CBP accounts that lack an empirical TWR rate (project on
   *  their planned rate under the Historical view). `[]` when none fell
   *  back. Threaded to the page result's `sharedCtx.fallbackAccounts` for
   *  the inline disclosure note. */
  readonly fallbackAccounts: ReadonlyArray<{ id: string; name: string }>;
  /** Calibration bundle for the five tax engines. Defaults to
   *  `DEFAULT_TAX_CALIBRATION_BUNDLE` when absent. */
  readonly taxBundle?: TaxCalibrationBundle;
  /** Per-owner REMAINING Roth-IRA regular-contribution basis (integer
   *  cents), keyed by `AccountPayload.ownerId`. **DERIVED from the recorded
   *  balance history**, not from a stored total: each §408A pool's contributions
   *  are credited, its recorded and imputed withdrawals charged (contributions
   *  first, then conversion lots FIFO), and what survives is summed across the
   *  owner's pools. Those pools are their OWN Roth IRAs only — active or inactive,
   *  since a closed account's contribution history is still the taxpayer's basis
   *  — while an inherited Roth IRA contributes no pool and so no basis at all.
   *  A history that leaves nothing contributes $0 (conservative — every
   *  distributed dollar beyond the remaining basis and lots is earnings).
   *  Owners with no Roth IRA are absent. Seeds the DETERMINISTIC cumulative
   *  §408A tracker; the MC tracker does NOT read this map — it seeds from
   *  a DRAWABLE-only re-derivation over the same pools
   *  (`mcDrawableRothBasisCentsByOwner` in `buildMcTaxContext`, which excludes
   *  every `allAccountsInactive` pool's share, so an all-closed pool's
   *  unreachable basis never shelters another owner's MC draw). */
  readonly rothBasisCentsByOwner: ReadonlyMap<string, number>;
  /** The FULL fact-based Roth distribution facts for the household
   *  (`buildRothDistributionFacts`): per-POOL Roth-IRA regular basis, the §408A
   *  five-year clock anchor, and conversion lots; plus PER-ACCOUNT designated-Roth
   *  basis, its own five-year clock, in-plan rollover lots, and the
   *  governmental-457(b) flag. An owner's OWN Roth IRAs share one pool (Pub 590-B),
   *  while an INHERITED Roth IRA has no pool at all — and therefore no basis, no
   *  clock and no lots; designated-Roth accounts never pool either,
   *  which is why they are keyed by account id and consume basis PRO RATA rather
   *  than contribution-first. */
  readonly rothDistributionFacts: RothDistributionFacts;
  /** Per-account normalized RMD profile facts (`buildRmdProfileFacts`),
   *  keyed by account id. Accounts carrying no stored fact are ABSENT, which keeps
   *  the RMD engine on its default Uniform-Lifetime path for a
   *  fact-free household. */
  readonly rmdProfileFactsByAccountId: ReadonlyMap<string, RmdAccountProfileFacts>;
  /** Per-owner working-years converted-principal basis (integer
   *  cents), keyed by `AccountPayload.ownerId`. Held SEPARATE from
   *  `rothBasisCentsByOwner` so it seeds ONLY the DETERMINISTIC §408A basis
   *  carrier (the converted principal withdraws tax-free in deterministic
   *  drawdown). It is deliberately NOT threaded into the MC tax context: Monte
   *  Carlo does not model the conversion deposit legs, so seeding it there would
   *  shield MC Roth withdrawals the MC Roth balance never received. Empty when
   *  no working-years conversion resolved. */
  readonly preRetirementConversionBasisCentsByOwner: ReadonlyMap<string, number>;
  /** Per-owner PURE designated-Roth employer-plan basis (integer
   *  cents), keyed by `AccountPayload.ownerId`. The sum of each ACTIVE pure-Roth
   *  account's recorded in-plan-rollover principal — not the whole at-retirement
   *  balance, which would treat every projected Roth dollar as basis. A plan with
   *  no recorded in-plan rollover contributes $0 (conservative).
   *
   *  NO runtime consumer: the deterministic FUNDING pass — the one
   *  consumer it was derived for — pools designated-Roth state per owner
   *  directly from `rothDistributionFacts.designatedByAccount`
   *  (`seedSolverDesignatedRothStates`), so designated basis never mixes into
   *  its §408A carrier. The deterministic ANNOTATION post-pass reads the same
   *  per-account facts, and Monte Carlo reads `rothOrderedProfile`. Retained
   *  (with its pinned derivation) as a context-surface convenience only. Empty
   *  when no pure-Roth employer accounts are present. */
  readonly pureRothBasisCentsByOwner: ReadonlyMap<string, number>;
  /** Per-owner MIXED Roth-designated employer-plan basis (integer
   *  cents), keyed by `AccountPayload.ownerId`. The sum of each ACTIVE MIXED
   *  Roth-designated account's recorded in-plan-rollover principal, not the
   *  at-retirement post-sub-bucket balance.
   *  No recorded rollover → $0 (conservative). Same status as
   *  `pureRothBasisCentsByOwner` above: no runtime consumer (the funding
   *  pass reads the per-account facts). Empty when none are present. */
  readonly mixedRothDesignatedBasisCentsByOwner: ReadonlyMap<string, number>;
  /** Per-owner same-account MIXED in-plan conversion basis (integer cents),
   *  keyed by `AccountPayload.ownerId`. Populated by
   *  `computePreRetirementRothConversions` for each same-account MIXED in-plan
   *  conversion. Same status as the two roll-ups above: no runtime consumer —
   *  the deterministic FUNDING pass takes this principal through the DATED
   *  per-account maps below (`mergeDesignatedRothSeeds` →
   *  `seedSolverDesignatedRothStates`), exactly as the annotation pass does, so
   *  it arrives as real dated lots instead of undated owner basis. It stays a
   *  separate field only to record PROVENANCE — recorded account facts above vs
   *  ENGINE-GENERATED conversion principal here. MC still does not model the
   *  conversion deposit legs. Empty when no same-account MIXED in-plan
   *  conversion resolved. */
  readonly mixedInPlanConversionBasisCentsByOwner: ReadonlyMap<string, number>;
  /** The SAME same-account MIXED in-plan conversion basis keyed by TARGET
   *  ACCOUNT id. Consumed by the deterministic ANNOTATION post-pass, which credits
   *  it to that account's own designated-Roth carrier (designated-Roth accounts
   *  never pool), so a sibling employer plan can never recover basis it never
   *  received — and by the deterministic FUNDING pass, whose per-owner pooled
   *  designated state seeds from the same `mergeDesignatedRothSeeds` merge.
   *  Empty when no such conversion resolved. */
  readonly mixedInPlanConversionBasisCentsByAccount: ReadonlyMap<string, number>;
  /** The working-years Roth-IRA conversion principal DATED by conversion tax
   *  year (owner id → tax year → integer cents). An engine-generated conversion
   *  starts its OWN five-tax-year §408A(d)(3)(F) recapture clock, so it is seeded as
   *  a real conversion LOT rather than undated regular basis (undated basis could
   *  be withdrawn inside the window with no recapture). Deterministic-only, like
   *  the undated map above. Empty when no such conversion resolved. */
  readonly preRetirementConversionBasisCentsByOwnerYear: ReadonlyMap<
    string,
    ReadonlyMap<number, number>
  >;
  /** The same-account MIXED in-plan conversion principal DATED by rollover
   *  tax year (target account id → tax year → integer cents), seeded as a real
   *  in-plan rollover LOT on that account's designated-Roth carrier so its own
   *  §402A(c)(4)(D) five-tax-year recapture window applies. Empty when none. */
  readonly mixedInPlanConversionBasisCentsByAccountYear: ReadonlyMap<
    string,
    ReadonlyMap<number, number>
  >;
  /** Per-calendar-year total working-years Roth conversion amount in INTEGER
   *  CENTS — summed across all conversions for that year regardless of
   *  source/target type. Drives the pre-retirement bars of the Roth conversions
   *  chart (Fill-mode bars cover post-retirement years). Empty when no
   *  working-years conversion resolved or all clamped to zero. */
  readonly preRetirementConversionCentsByYear: ReadonlyMap<number, number>;
  /** ACA opt-out: household member ids treated as NOT on the ACA Marketplace
   *  (retiree / COBRA / spousal-employer coverage). Such a member resolves to
   *  ZERO Marketplace coverage months unless the scenario states an explicit
   *  month count for them, so no ACA-PTC subsidy is credited and the household
   *  benchmark narrows to the remaining on-Marketplace members. Resolved from
   *  `ScenarioOverrides.acaMarketplaceOptOutMemberIds` with the `?? []` default
   *  applied at context assembly — always present, never undefined. */
  readonly acaMarketplaceOptOutMemberIds: ReadonlySet<string>;
  /** Per-member, per-tax-year Medicare Part B / Part D and ACA Marketplace
   *  coverage MONTHS from `ScenarioOverrides.healthCoverageMonths`. Absent → the
   *  AUTOMATIC birthday-month derivation in `resolveMemberHealthCoverage`:
   *  Medicare entitlement from the month the member turns 65 (the month before
   *  for a first-of-the-month birthday), Marketplace months as its complement
   *  for a retired, age-known, non-opted-out member. It is NOT a whole-year on/off
   *  rule. An explicit `marketplaceMonths` WINS over
   *  the opt-out list above; an absent one for an opted-out member resolves to
   *  0 months. */
  readonly healthCoverageMonths?: import('../db/types').HealthCoverageMonthsOverride;
  /** Federal-poverty-level region for the ACA FPL denominator. Absent →
   *  `'contiguous'` (48 states + DC). */
  readonly acaFplRegion?: import('./aca-ptc').AcaFplRegion;
  /** The scenario's medical inflation rate (percent), resolved once; grows the
   *  rough ACA benchmark from its base year in every engine. */
  readonly medicalInflationRatePct: number;
  /** QCD (Qualified Charitable Distributions): resolved + hardened per-member
   *  directives for the scenario — malformed / cross-owner /
   *  non-PRE_TAX-IRA / invalid-window entries already dropped, `start` clamped to
   *  the 70½ floor, the window resolved to whole tax years. The deterministic
   *  drawdown builds the engine's `QcdContextInput` from this + the indexed
   *  per-person limit (`QCD_LIMITS`) + the scenario inflation. Empty `entries`
   *  when no QCD resolved → the engine pass is a no-op. */
  readonly resolvedQcd: import('./scenario-resolution').ResolvedQcd;
}

/**
 * Per-month SS run-rate row consumed by the tax-integration pass. `total`
 * is the household run-rate; `primary` / `secondary` carry each member's OWN
 * run-rate so the hybrid-IRMAA split can withhold a member's surcharge only
 * from that member's own SS. Run-rate semantics: `mean(rate_m for m in
 * 0..11) = annual sum`.
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
  /** Post-retirement **plain** (non-linked-CBP) pension lump-sum events,
   *  classified per-event with their `accountId` so they place per-account
   *  (deterministic ledger + MC `routeEventsToLedger`) instead of the
   *  household-pool spread. One-off windfalls stay on `depositInflow`. */
  readonly plainPensionPlacementEvents: ReadonlyArray<ClassifiedDepositEvent>;
  /** Per-month SS income rows (gross, before §86 taxation). Used by the
   *  tax-integration pass to compute annual grossSsDollars per year. */
  readonly ssRows: ReadonlyArray<SsRunRateRow>;
  /** Per-month HSA-qualified medical demand in INTEGER CENTS. A STRICT
   *  SUBSET of `expensesByMonth` — the per-month sum of the categories flagged
   *  `isMedical` (resolved via `medicalCategoryIdSet`), built with the SAME
   *  `(recurring − spike)/12 + spike` monthly bucketing as `expensesByMonth`.
   *  Aligned to (retirementYear, January); same length as
   *  `expensesByMonth.values`. Threaded into `DrawdownInput.medicalDemandByMonth`
   *  to drive the HSA medical pass. Empty / no `isMedical` category ⇒ all-zero
   *  (the medical pass is a no-op; emergency-reserve path intact). */
  readonly medicalDemandByMonth: ReadonlyArray<number>;
  /** Per-month modeled Medical expenses in INTEGER CENTS, every `isMedical` row
   *  (`medicalDemandByMonth` is its HSA-qualified subset, same length and
   *  anchoring). Caps the ACA credit applied to premiums. */
  readonly medicalExpenseByMonth: ReadonlyArray<number>;
  /** True when the plan models ANY `isMedical` expense at all,
   *  HSA-qualified or not. Deliberately NOT derived from `medicalDemandByMonth`:
   *  that series is pre-filtered to HSA-QUALIFIED rows, and Medicare, Medigap,
   *  Medicare Advantage and drug-plan premiums are not HSA-qualified
   *  (§223(d)(2)(C)(iv)), so a household that recorded exactly those premiums
   *  has an all-zero demand series yet models medical spending. Its negation
   *  drives the missing-base-Medicare-premium readiness warning. */
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

/** Thrown by `resolveMagiCapOffYear` when the gating member's birthdate
 *  is absent and there is no valid fallback — the cap end-year cannot be
 *  computed, so the run must abort rather than silently use 9999. */
export class MagiCapCalibrationError extends Error {
  readonly kind = 'magi-cap-calibration' as const;
  constructor(message: string) {
    super(message);
    this.name = 'MagiCapCalibrationError';
  }
}
