/** Public type surface for the Monte Carlo engine; every symbol is re-exported from `monte-carlo.ts`.
 * Guardrails: docs/math-projections.md ("Spending guardrails"). */
import type { RmdAccountProfileFacts } from './rmd';
import type {
  AssetMix,
  AccountTaxTreatment,
  AccountType,
  DownturnGuardrailsOverride,
  MagiCapOverride,
} from '../db/types.js';
import type { McTaxContext } from './monte-carlo-tax.js';
import type { DrawdownYear, DrawdownAccountYear } from './drawdown-engine-types.js';

/** Representative-run tier: the path at the P50 / P25 / P10 real-ending-balance rank (`mc-typical` / `mc-pessimistic` / `mc-bad-luck`). */
export type McBasis = 'mc-typical' | 'mc-pessimistic' | 'mc-bad-luck';

/**
 * A representative path (P10/P25/P50 real-ending-balance rank, pathIndex tie-break) replayed under full per-year capture, shaped like `DrawdownByMethodResult`.
 * Real series deflate by the path's own sampled CPI, not the scenario's deterministic deflator, so a high-inflation path sees its real balance compressed.
 */
export interface RepresentativeRun {
  readonly firstYear: number;
  readonly seed: number;
  /** Per-year drawdown rows in nominal dollars. Drawdown-phase rows also carry `accountBalances` and the `rmdFloorCents` / `rmdShortfallCents` stamped by the RMD post-pass; pre-retirement rows carry neither, and none exist in `successOnly` mode (no replay). */
  readonly years: ReadonlyArray<DrawdownYear>;
  readonly depletionYear: number | null;
  readonly perMonthWithdrawal: Float64Array;
  /** Real (today's-dollar) balance by year, deflated by the path's own CPI; index = calendar year offset from `firstYear`. */
  readonly realBalanceByYear: number[];
  /** Real investment growth by year; same deflation and indexing. */
  readonly realGrowthByYear: number[];
  /** `1 / cumCpi` at year-end, so `realBalanceByYear[i] = years[i].balance * realFactorByYear[i]`; MC display surfaces deflate by the path's own CPI with it. On the strategy path the tail `[years.length, horizonYears)` is left at zero and never indexed. */
  readonly realFactorByYear: number[];
  /** Per-account year-end balances for the pre-retirement years, stacking fields only (`balance` / `preEnd` / `postEnd`). A separate field because `years[]` accumulation rows must carry no `accountBalances`: the accumulation-vs-drawdown discriminators in the RMD/tax post-passes and chart filters rely on that. Absent when not captured (`successOnly`) or with no pre-retirement years. */
  readonly accumulationAccountBalances?: ReadonlyArray<{
    readonly year: number;
    readonly accountBalances: ReadonlyMap<string, DrawdownAccountYear>;
  }>;
  /** Inherited-account ids: distributions are on account of the original owner's death, so §72(t)(2)(A)(ii) waives the 10% additional tax at any beneficiary age. */
  readonly deathExemptAccountIds?: readonly string[];
}

/** Dated portfolio addition; `buildStepInputs` folds `month < retirementStepIdx` into `contribPost` and later months into `deposit`. */
export interface MonteCarloPortfolioEvent {
  /** Step index (0 = January of `firstYear`). */
  readonly month: number;
  /** Nominal dollars; for a `secondaryContribution`, `amountPre + amountPost`. */
  readonly amount: number;
  /** Pre-tax slice of a `secondaryContribution`, routed to the destination's `pre` bucket. */
  readonly amountPre?: number;
  /** Designated-Roth slice of a `secondaryContribution`, routed to `post` regardless of treatment (SECURE 2.0 §325). */
  readonly amountPost?: number;
  readonly source: 'cbpLumpSum' | 'targetedOneOff' | 'secondaryContribution';
  readonly targetAccountId?: string;
}

/** Per-account ledger entry for the MC runner; mirrors `AccountMcLedgerEntry` in `balance-projection-bundle.ts`. */
export interface MonteCarloAccountLedger {
  readonly id: string;
  readonly initialPre: number;
  readonly initialPost: number;
  readonly contribPre: Float64Array;
  readonly contribPost: Float64Array;
  /** Summed post-retirement deposit dollars; the kernel reads this. */
  readonly deposit: Float64Array;
  /** Pre-tax slice of the post-primary spouse contribution (named-strategy slice only). */
  readonly depositPre?: Float64Array;
  /** Designated-Roth slice of the same contribution (named-strategy slice only); always routed to `post`. */
  readonly depositPost?: Float64Array;
  readonly assetMix: AssetMix | null;
  /** Per-step glide-derived mix; when present it overrides the flat `assetMix`. */
  readonly assetMixSeries: ReadonlyArray<AssetMix> | null;
  readonly cbpPlanningReturnPct: number | null;
  /** Drives withdrawal classification: PRE_TAX is ordinary income, ROTH tax-free, POST_TAX taxable basis by `accountType`, MIXED split by the current pre/post ratio. `undefined` (no tax metadata) falls back to all-pre-tax. */
  readonly taxTreatment?: AccountTaxTreatment;
  /** Splits POST_TAX non-Roth withdrawals into the LTCG/QDI proxy (`BROKERAGE` / `OTHER`) and cash-like return of principal (`SAVINGS` / `MONEY_MARKET` / `CD` / `HSA`). `undefined` falls back to all-pre-tax. */
  readonly accountType?: AccountType;
  /** Owning member id; groups accounts per owner for the RMD floor (an account with no `ownerId` is its own owner). */
  readonly ownerId?: string;
  /** `'fixed'`: growth is baked into `contribPre`/`contribPost`. `'tracks-inflation'`: a today's-dollars base the runner scales by each path's `cumCpi[i]`. `undefined` is flat-nominal (no per-path scaling). */
  readonly contribGrowthMode?: 'tracks-inflation' | 'fixed';
  /** Planned-only post-tax contribution base (today's dollars) before targeted event dollars were routed onto `contribPost`; present only for `'tracks-inflation'` accounts, whose planned portion the runner CPI-scales per path. */
  readonly plannedContribPostBase?: Float64Array | null;
  /** Per-account minimum balance floor, eligible when `taxTreatment` is POST_TAX or HSA; sanitized by `resolveAccountFloorsForScenario` (CWE-20: non-finite or negative means no floor). */
  readonly floorDollars?: number;
  /** HSA draw mode when `floorDollars` is set; absent is 'emergencyOnly'. */
  readonly floorHsaMode?: 'emergencyOnly' | 'strict';
}

/** RMD metadata for the representative post-pass when `taxContext` is absent (injected-return and unit-test runs); with `taxContext`, that carries the same data. */
export interface McRmdContext {
  readonly members: McTaxContext['members'];
  readonly rmdSnapshot: McTaxContext['taxBundle']['rmd'];
  readonly primaryDeathYear?: number;
  readonly secondaryDeathYear?: number;
  /** Per-account normalized RMD profile facts, routed into the shared `computeRmd` engine. A plain `Record`, not a `Map`: `JSON.stringify(new Map())` is `{}`, which would hide the facts from `mcCacheKey` and let households with different beneficiary facts share a cached summary (every cache-key input in this file is a plain array or `Record` for the same reason). Accounts without facts are omitted. */
  readonly rmdFactsByAccountId?: Readonly<Record<string, RmdAccountProfileFacts>>;
  /** Each owner's separation-from-service year by member id, resolving the §401(a)(9)(C) later-of first-distribution year; an owner absent here withholds that resolution. */
  readonly retirementYearByOwner?: Readonly<Record<string, number>>;
}

/**
 * Per-path Qualified Charitable Distribution context, serializable (plain data, no closures) so it survives `postMessage` and the cache key.
 * The engine inflates each real annual amount by the path's `cumCpi` and resolves the indexed §408(d)(8) limit per tax year. Absent means a no-QCD run.
 */
export interface McQcdContext {
  /** Resolved QCD directives across both owners, grouped by `memberId`. */
  readonly entries: ReadonlyArray<{
    readonly memberId: string;
    readonly sourceAccountId: string;
    /** Real (today's-dollars) annual amount, inflated per path-year via `cumCpi`. */
    readonly annualAmountDollars: number;
    /** First active tax year, inclusive; clamped to the 70½ floor. */
    readonly startYear: number;
    /** Exclusive end tax year. */
    readonly endYear: number;
  }>;
  /** Owner id to first 70½-eligible tax year; an owner absent here is skipped. */
  readonly firstEligibleYearByOwner: Readonly<Record<string, number>>;
  /** Annual scenario inflation (percent); the limit is indexed, so years past the latest published figure are extrapolated by this rate. */
  readonly inflationPct: number;
}

/** Args for `applyMcTaxToRepresentativeYears`. Runs only when a `McTaxContext` is present; the funded per-path tax is stamped upstream, so this stamps display cents only. */
export interface McTaxPostPassArgs {
  readonly years: ReadonlyArray<DrawdownYear>;
  readonly ledger: ReadonlyArray<MonteCarloAccountLedger>;
  readonly taxCtx: McTaxContext;
  readonly firstYear: number;
  readonly retirementYear: number;
  readonly ssByYear: ReadonlyArray<number>;
  readonly incomeByYear: ReadonlyArray<number>;
  /** Calendar year the representative path depleted, or null. The depletion year itself had real taxable activity, so only `year.year > depletionYear` is skipped; null falls back to the `balance === 0` skip. */
  readonly depletionYear?: number | null;
  /** The run's `accumulationAccountBalances`; its last entry seeds the drawdown-entry buckets for the taxable-income replay, and absent (already retired) the ledger initial balances do. */
  readonly accumulationAccountBalances?: ReadonlyArray<{
    readonly year: number;
    readonly accountBalances: ReadonlyMap<string, DrawdownAccountYear>;
  }>;
  readonly deathExemptAccountIds?: readonly string[];
}

export interface MonteCarloInput {
  readonly portfolioToday: number;
  readonly accountMcLedger: ReadonlyArray<MonteCarloAccountLedger>;
  readonly annualContribution: number;
  readonly firstYear: number;
  /** Month within `firstYear` that today falls on (0 = January); the anchor for CPI scaling of tracks-inflation contributions, mirroring the deterministic `asOfMonth = firstYear*12 + todayMonthIndex`. Absent is 0. */
  readonly todayMonthIndex?: number;
  readonly retirementYear: number;
  /** Last calendar year to simulate, inclusive. */
  readonly horizonYear: number;
  /** Windowed per-month expense base in today's dollars, indexed 0 = January of `firstYear`; length must equal the kernel `stepCount` (`(horizonYear - firstYear + 1) * 12`), enforced by throwing guards in `balance-projection-runner-mc.ts` and `runMonteCarlo`. Each expense is charged only in its active window (recurring at run-rate ÷ 12, one-offs whole in their spike month); the kernel inflates per path as `expense[i] = monthlyExpenseBase[i] * cumCpi[i]`. A zero-expense scenario is an all-zero base. */
  readonly monthlyExpenseBase: number[];
  /**
   * Expense base split into per-effective-inflation-rate buckets (percent), so a faster-growing category (e.g. Medical at general + 2 pp) inflates at its own rate
   * via a per-bucket mean-shift `(ratePct - scenarioInflationPct)/12` on `cpiPct`. The shift factor is horizon-cumulative (1 at today, never reset at window open);
   * windowing enters only through `amount[i]`. Bucketed kernel: `expense[i] = Σ_b amount_b[i] * bucketCumCpi[b][i]`.
   * Each `amount` length must equal `monthlyExpenseBase.length`, and `Σ_b amount_b[i] === monthlyExpenseBase[i]` at cent precision.
   * Emitted only when at least one category's rate differs from the general rate; absent otherwise (the kernel runs the scalar loop).
   */
  readonly monthlyExpenseBucketsBase?: ReadonlyArray<{
    readonly ratePct: number;
    readonly amount: number[];
  }>;
  /** Per-month HSA-qualified medical demand base in today's dollars: the `isMedical` subset of `monthlyExpenseBase`, same length and indexing. The kernel inflates it by the medical rate's cumulative CPI, converts to integer cents and feeds the medical-first HSA pass. Absent when no category is flagged. */
  readonly monthlyMedicalDemandBase?: number[];
  /** Effective inflation rate (percent) the `isMedical` categories grow at (default general + 2 pp); its mean-shift keeps inflated demand a subset of inflated expense. Single-rate only: when medical categories carry distinct rates, `monthlyMedicalDemandBucketsBase` is emitted and wins. */
  readonly medicalDemandRatePct?: number;
  /** Per-rate buckets of the medical demand, as `monthlyExpenseBucketsBase` does for expenses; emitted only when the `isMedical` categories span more than one effective rate. Length per bucket = `stepCount`. */
  readonly monthlyMedicalDemandBucketsBase?: ReadonlyArray<{
    readonly ratePct: number;
    readonly amount: number[];
  }>;
  /** Per-month modeled Medical expenses in today's dollars, every `isMedical` row (the HSA demand is its qualified subset): caps the credit applied to premiums. */
  readonly monthlyMedicalExpenseBase?: number[];
  /** Effective rate (percent) of the medical expenses, with per-rate buckets when they span more than one. */
  readonly medicalExpenseRatePct?: number;
  readonly monthlyMedicalExpenseBucketsBase?: MonteCarloInput['monthlyMedicalDemandBucketsBase'];
  /** Nominal annual SS benefit by year offset from `firstYear`; length `horizonYear - firstYear + 1`. */
  readonly ssByYear: number[];
  /** Nominal annual non-SS income, same length and indexing as `ssByYear`. */
  readonly incomeByYear: number[];
  /** Subset of `incomeByYear` that tracks CPI (e.g. COLA pensions); scaled per path by `cumCpi / deterministicCumCpi`. Absent means all non-SS income keeps its precomputed nominal. */
  readonly tracksInflationIncomeByYear?: number[];
  /** Downturn-guardrail config. When present and `enabled`, the named-strategy path scales each year's spending at the year-start boundary, and the same factor flows through the two-pass tax so MAGI, tax, IRMAA, ACA and §86 move with it. Absent or disabled leaves path math unchanged. */
  readonly downturnGuardrails?: DownturnGuardrailsOverride;
  /** Real (today's-dollar) net spending need per drawdown year on the 100% baseline path: total spending minus guaranteed income (survivor-adjusted SS + lifetime pension/annuity); index 0 = retirement year. The funded-ratio liability discounts this series. Only meaningful when `downturnGuardrails.enabled`. */
  readonly guardrailBaselineRealNetNeedByYear?: number[];
  /** Real essential-only spending per drawdown year, setting the per-year cut floor; same indexing and gating. */
  readonly guardrailEssentialRealByYear?: number[];
  /** Real total spending per drawdown year, the denominator for the essential-floor factor; same indexing and gating. */
  readonly guardrailBaselineTotalRealByYear?: number[];
  /** Gross-up fraction in `[0, 1)` for the funded-ratio liability: the PV is divided by `(1 - this)` to fund after-tax spending with pre-tax withdrawals; absent means 0. */
  readonly guardrailEffectiveTaxRate?: number;
  readonly pathCount: number;
  /** PRNG seed; the same seed gives bit-identical output. */
  readonly seed: number;
  readonly withdrawalStrategyId?: string;
  /** Engine-switch discriminant; every named strategy routes through `runOnePathViaStrategyEngine`. */
  readonly strategyKind: 'taxEfficient' | 'proportional' | 'rothFirst' | 'customOrder';
  /** Custom-order tier payload (state indices, tier[0] drained first), required for `'customOrder'`; built by `buildCustomTierIndices` to match the deterministic per-account engine bit for bit. */
  readonly customTiers?: ReadonlyArray<ReadonlyArray<number>>;
  readonly excludedIndices?: ReadonlySet<number>;
  /** Serializable MAGI-ceiling cap window schedule. The runtime `MagiCapRuntimeConfig` carries closures that throw `DataCloneError` under `structuredClone` when the input is posted to the Worker, so only the plain windows plus precomputed bounds cross `postMessage` and the engine rebuilds one runtime config per window via `buildMagiCapConfig`. Absent means no cap routing and no conversions. */
  readonly magiCapOverride?: MagiCapOverride;
  /** Index-aligned resolved `[startYear, endYear)` bounds and broken-anchor flag, one per `magiCapOverride.windows` entry. */
  readonly magiCapWindowBounds?: ReadonlyArray<{
    readonly startYear: number;
    readonly endYear: number;
    readonly brokenAnchor: boolean;
  }>;
  /** Month within the retirement year (0 = January) the primary retires: `retirementStepIdx = (retirementYear - firstYear) * 12 + primaryRetirementMonth0`. Absent snaps to January. */
  readonly primaryRetirementMonth0?: number;
  /** Progress callback, every `max(25, pathCount/40)` paths. */
  readonly onProgress?: (done: number, total: number) => void;
  readonly events?: readonly MonteCarloPortfolioEvent[];
  /** Injected per-month main-portfolio returns (percent). */
  readonly injectedReturns?: Float64Array;
  /** Per-month CPI percent change, companion to `injectedReturns`. */
  readonly injectedCpi?: Float64Array;
  /** Annual scenario inflation (%); centers the CPI bootstrap mean. */
  readonly scenarioInflationPct?: number;
  /** Annual investment-cost drag (%), subtracted from every sampled month as `-annualInvestmentCostPct / 12`. Stress-only: the base plan carries none, and the "Higher fees" stress sets 0.50 pp. Applies only to market-sampled returns (not CBP fixed or injected-parity returns). */
  readonly annualInvestmentCostPct?: number;
  /** Per-asset annual return shock in percentage points (the "Lower returns" stress): a positive reduction subtracted as the blended per-account mean-shift `-(ws*stocksPct + wb*bondsPct + wc*cashPct) / 12`, so the same sampled draws are retained for a before/after comparison. Market-sampled returns only. */
  readonly returnShock?: {
    readonly stocksPct: number;
    readonly bondsPct: number;
    readonly cashPct: number;
  };
  /** Annual inflation shock in percentage points (the "Higher inflation" stress), added to the CPI bootstrap mean-shift as `+ inflationShockPct / 12` on the same sampled residuals. */
  readonly inflationShockPct?: number;
  readonly taxContext?: McTaxContext;
  /** Member ids treated as not on the ACA Marketplace; mirrors `taxContext` but surfaced top-level so the cache key changes even without it. Sorted, deduped, omitted when empty. */
  readonly acaMarketplaceOptOutMemberIds?: readonly string[];
  /** RMD threading for `replayRepresentativePath` when `taxContext` is absent. */
  readonly mcRmdContext?: McRmdContext;
  /** Per-path QCD context: every path runs the 70½-gated forced-outflow pass; the gift is debited first-dollars from the source IRA, offsets that owner's IRA-pool RMD floor and is excluded from ordinary income / MAGI before §86, so ending balances and success probability move. Omitted when no QCD resolved. */
  readonly qcdContext?: McQcdContext;
  /** Optimizer fast path: skips the planned overlay and the representative replay, the dominant per-pair cost; `successProbability` and the other fields match a full run. */
  readonly successOnly?: boolean;
  /** Stationary-bootstrap mean block length L in months; absent is `DEFAULT_MEAN_BLOCK_LENGTH`, `1` is IID. Ignored under injected-return parity. */
  readonly meanBlockLength?: number;
}

export interface HistogramBin {
  readonly lower: number;
  readonly count: number;
}

export interface PercentileSeries {
  readonly p10: number[];
  readonly p25: number[];
  readonly p50: number[];
}

export interface MonteCarloSummary {
  readonly engineVersion: number;
  readonly seed: number;
  readonly pathCount: number;
  readonly computedAt: number;
  readonly firstYear: number;
  readonly horizonYears: number;
  readonly percentilesNominal: PercentileSeries;
  readonly percentilesReal: PercentileSeries;
  readonly successProbability: number;
  readonly medianDepletionYear: number | null;
  /** Year by which 10 % of paths have depleted; `null` when fewer deplete. */
  readonly p10DepletionYear: number | null;
  /** Year by which 25 % of paths have depleted; `null` when fewer deplete. */
  readonly p25DepletionYear: number | null;
  readonly medianEndingBalanceNominal: number;
  readonly medianEndingBalanceReal: number;
  readonly p10EndingBalanceNominal: number;
  readonly p10EndingBalanceReal: number;
  readonly p25EndingBalanceNominal: number;
  readonly p25EndingBalanceReal: number;
  readonly failureYearHistogram: number[];
  /** 30 log-spaced bins from $1 000 to $50 000 000 plus a leading "$0" bin; length 31. */
  readonly endingBalanceHistogramNominal: HistogramBin[];
  readonly endingBalanceHistogramReal: HistogramBin[];
  /** Seed-1 path's portfolio total by year; after-tax when a `taxContext` is active. */
  readonly plannedOverlay: number[];
  /** Per-year net-after-tax withdrawal percentile bands, defined when `taxContext` is supplied; length `horizonYears`. */
  readonly netAfterTaxPercentilesByYear?: PercentileSeries;
  readonly federalTaxPercentilesByYear?: PercentileSeries;
  readonly irmaaSurchargePercentilesByYear?: PercentileSeries;
  readonly acaPtcSubsidyPercentilesByYear?: PercentileSeries;
  readonly acaCreditAppliedToPremiumsPercentilesByYear?: PercentileSeries;
  readonly effectiveTaxRatePercentilesByYear?: PercentileSeries;
  /** Representative run per basis tier (P10/P25/P50 by real ending balance), replayed under full capture. `null` for a tier that cannot be assembled; the whole field is absent in `successOnly`. */
  readonly representativeByBasis?: Record<McBasis, RepresentativeRun | null>;
  /** Per-tier band of card-consistent candidate seeds for the reroll control. Element 0 is the default reconciled pick; a reroll walks elements 1..N-1 so every reroll changes the line, replaying on the main thread via `runOnePath` with the same post-passes. Absent in `successOnly`. */
  readonly representativeBandsByBasis?: Record<McBasis, number[]>;
  readonly representativeTypicalSeed?: number;
  readonly representativePessimisticSeed?: number;
  readonly representativeBadLuckSeed?: number;
}
