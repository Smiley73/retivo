/**
 * Balance-projection MC bundle: the page-level resolution for the Monte Carlo input builder plus the monthly cashflow series builders, as one unit-testable surface.
 */
import {
  defaultAssetMixForAccountType,
  type AssetMix,
  type DownturnGuardrailsOverride,
  type ExpensePayload,
  type IncomeStreamPayload,
  type AccountPayload,
  type AccountBalancePayload,
  type HouseholdMemberPayload,
  type SocialSecurityBenefitPayload,
  type Aggregate,
} from '../db/types';
import {
  addOneOff,
  emptyMonthlySeries,
  type MonthlyCashflowSeries,
} from './monthly-cashflow';
import type { CbpValidationResult, ResolvedCbpElection } from './cbp-resolution';
import {
  resolveAccountFloorsForScenario,
  resolveContributionGrowth,
  type ResolvedAccountFloor,
  type ResolvedContributionGrowth,
  type ScenarioAggregate,
} from './scenario-resolution';
import {
  buildLedgerEntry,
  type AccountMcLedgerEntry,
} from './balance-projection-bundle-mc-ledger';
import type { CalibrationSnapshot } from './calibration';
import { splitRolloverByRmd } from './rmd-rollover-split';
import type { RmdTable } from './rmd';

export type { AccountMcLedgerEntry };

/** Per-month spendable-income row; a subset of `IncomeProjectionMonth`. */
export interface MonthlyIncomeRow {
  year: number;
  month0: number;
  pensionIncome: number;
  partTimeIncome: number;
  oneOffIncome: number;
  /** Lump-sum *portfolio* addition — feeds depositInflow, not spendable. */
  depositInflow: number;
}

/** Per-month SS row. */
export interface MonthlySsRow {
  year: number;
  month0: number;
  total: number;
}

/**
 * Per-month expense row. `total` mixes a recurring run-rate ($/yr at this month) with the literal
 * one-off spike (event-month dollars); `oneOffEssential` + `oneOffDiscretionary` expose the spike
 * so callers divide only the run-rate by 12.
 */
export interface MonthlyExpenseRow {
  year: number;
  month0: number;
  total: number;
  oneOffEssential: number;
  oneOffDiscretionary: number;
}

/**
 * Targeted post-retirement deposit event (CBP lump-sum, one-off windfall, secondary post-primary
 * monthly contribution), pre-classified so the MC builder can tag its `source`.
 */
export interface ClassifiedDepositEvent {
  /** Absolute step index in the MC kernel — `(year - todayYear) * 12 + month0`. */
  month: number;
  /**
   * Nominal dollars at the event month; for a post-primary spouse contribution it is
   * `amountPre + amountPost`, the sum the no-ledger kernel path reads.
   */
  amount: number;
  /**
   * Pre-tax slice of a post-primary spouse contribution, credited to the destination's `pre`
   * bucket; undefined for CBP / one-off events, which route `amount` by destination treatment.
   */
  amountPre?: number;
  /**
   * Designated-Roth slice of a post-primary spouse contribution, routed to the destination's `post`
   * bucket regardless of treatment (a MIXED account's Roth slice stays RMD-exempt, SECURE 2.0
   * §325). Undefined for CBP / one-off events.
   */
  amountPost?: number;
  accountId?: string;
}

/**
 * Convert per-month expense rows to a series anchored at (retirementYear, January); rows outside
 * [retirementYear..horizonYear] are dropped.
 */
export function buildMonthlyExpenseSeries(args: {
  rows: ReadonlyArray<MonthlyExpenseRow>;
  retirementYear: number;
  horizonYear: number;
}): MonthlyCashflowSeries {
  const series = emptyMonthlySeries(args.retirementYear, args.horizonYear);
  if (series.values.length === 0) return series;
  for (const row of args.rows) {
    // Split before scaling: the run-rate ($/yr) divides by 12, the one-off spike stays whole in its
    // event month.
    const oneOff = row.oneOffEssential + row.oneOffDiscretionary;
    const runRate = row.total - oneOff;
    addOneOff(series, row.year, row.month0, runRate / 12 + oneOff);
  }
  return series;
}

/**
 * Convert per-month income rows (SS, pension, part-time, spendable one-off) to one income series.
 * `depositInflow` is not folded in: portfolio additions feed `buildMonthlyDepositSeries`.
 */
export function buildMonthlyIncomeSeries(args: {
  ssRows: ReadonlyArray<MonthlySsRow>;
  incomeRows: ReadonlyArray<MonthlyIncomeRow>;
  retirementYear: number;
  horizonYear: number;
}): MonthlyCashflowSeries {
  const series = emptyMonthlySeries(args.retirementYear, args.horizonYear);
  if (series.values.length === 0) return series;
  for (const row of args.ssRows) {
    addOneOff(series, row.year, row.month0, row.total / 12);
  }
  for (const row of args.incomeRows) {
    // Pension and part-time are $/yr run-rates; `oneOffIncome` is a literal event amount kept
    // whole.
    const runRate = row.pensionIncome + row.partTimeIncome;
    addOneOff(series, row.year, row.month0, runRate / 12 + row.oneOffIncome);
  }
  return series;
}

/**
 * Household-pool monthly deposit series: targeted one-off windfalls and CBP lump-sum payouts
 * arriving via `depositInflow`. Post-primary spouse contributions are excluded because they route
 * per-account with their pre/post split, and pooling them would double-count and drop their account
 * target. Inflows before primary's retirement month are skipped (routed to accumulation upstream).
 */
export function buildMonthlyDepositSeries(args: {
  incomeRows: ReadonlyArray<MonthlyIncomeRow>;
  retirementYear: number;
  horizonYear: number;
  primaryRetirementAbsMonth: number;
}): MonthlyCashflowSeries {
  const series = emptyMonthlySeries(args.retirementYear, args.horizonYear);
  if (series.values.length === 0) return series;
  for (const row of args.incomeRows) {
    if (row.depositInflow === 0) continue;
    const abs = row.year * 12 + row.month0;
    if (abs < args.primaryRetirementAbsMonth) continue;
    addOneOff(series, row.year, row.month0, row.depositInflow);
  }
  return series;
}

/**
 * Downturn-guardrail block on the MC bundle, present only when the resolved scenario enables the
 * guardrail. Real series are today's-dollar per drawdown year (index 0 = the first).
 */
export interface GuardrailBundleBlock {
  readonly config: DownturnGuardrailsOverride;
  /** Real total spending on the 100% baseline path, per drawdown year. */
  readonly baselineTotalRealByYear: number[];
  /** Real net spending need (total − guaranteed income) on the baseline path. */
  readonly baselineNetNeedRealByYear: number[];
  /** Real essential-only spending on the baseline path (the cut floor). */
  readonly essentialRealByYear: number[];
  /** Effective-tax gross-up proxy for the funded-ratio liability. */
  readonly effectiveTaxRate: number;
}

/**
 * Pre-resolved MC bundle, built once on the page. Scalars are today's-dollar retirement-start
 * values the kernel inflates by sampled CPI; `events` are nominal dollars at their event month and
 * are not inflated.
 */
export interface BalanceProjectionMcBundle {
  // --- identity + anchors --------------------------------------------
  /** Scenario the bundle was resolved against. Drives cache keys. */
  scenarioId: string;
  todayYear: number;
  /**
   * Month-of-year (0..11) "today" falls on; the today-anchor for per-path CPI scaling of
   * tracks-inflation contributions. Defaults to 0.
   */
  todayMonthIndex: number;
  retirementYear: number;
  primaryRetirementMonth0: number;
  horizonYear: number;
  /** Primary retirement as a fractional year, for the fan chart's vertical marker. */
  retirementFractionalYear: number;
  /** Fan-chart life-expectancy markers; display-only. */
  lifeMarkers: ReadonlyArray<{
    fractionalYear: number;
    label: string;
    color: string;
  }>;

  // --- engine-facing scalars (today's-dollar) ------------------------
  portfolioToday: number;
  /**
   * Household-blended asset mix across non-CBP active accounts; the MC runner reads per-account
   * mixes off `accountMcLedger`.
   */
  blendedMix: AssetMix;
  annualContribution: number;
  /**
   * Windowed per-month expense base in today's dollars from `todayYear`, length
   * `(horizonYear − todayYear + 1) × 12`; each expense is charged only in its start/end window.
   */
  monthlyExpenseBase: number[];
  /**
   * Per-effective-rate windowed expense buckets, present only when a category inflates at a rate
   * other than the scenario's; each `amount` matches `monthlyExpenseBase` in length and the buckets
   * sum to it per step. Absent means the kernel runs the scalar path.
   */
  monthlyExpenseBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
  /**
   * Per-month today's-dollar HSA medical-demand base, the `isMedical` subset of
   * `monthlyExpenseBase`; present only when a category is flagged `isMedical`.
   */
  monthlyMedicalDemandBase?: number[];
  /**
   * Inflation rate (%) of the `isMedical` categories; present only alongside
   * `monthlyMedicalDemandBase`.
   */
  medicalDemandRatePct?: number;
  /**
   * Per-rate medical-demand buckets, present only when the `isMedical` categories span more than
   * one effective rate.
   */
  monthlyMedicalDemandBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
  /** Modeled Medical expenses (every `isMedical` row): per-month base, rate and buckets. */
  monthlyMedicalExpenseBase?: number[];
  medicalExpenseRatePct?: number;
  monthlyMedicalExpenseBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
  /**
   * Nominal annual SS benefit by year offset from `todayYear` (length
   * `horizonYear - todayYear + 1`); the kernel reads it without CPI scaling.
   */
  ssByYear: number[];
  /** Nominal annual non-SS income, indexed like `ssByYear`. */
  incomeByYear: number[];
  /** Resolved annual scenario inflation rate (%), used to mean-shift the CPI bootstrap. */
  scenarioInflationPct: number;
  /**
   * Guardrail config plus real baseline per-drawdown-year series and an effective-tax proxy;
   * present only when a scenario in the chain enables the guardrail, so a no-guardrail
   * `MonteCarloInput` and `mcCacheKey` carry no guardrail fields.
   */
  downturnGuardrails?: GuardrailBundleBlock;

  // --- validation + classified events --------------------------------
  /**
   * CBP validation against the active scenario; when `ok === false` the MC builder returns
   * `input: undefined`.
   */
  cbpValidation: CbpValidationResult;
  /**
   * One event per linked `lumpSum` pension stream, at the stream's `start` month with the source
   * CBP balance compounded to that month at `planningReturnPct`. The source CBP is excluded from
   * the per-account ledger (`skipsPortfolio: true`).
   */
  cbpLumpSumEvents: ReadonlyArray<ClassifiedDepositEvent>;
  targetedOneOffEvents: ReadonlyArray<ClassifiedDepositEvent>;
  /** Synthesized monthly contributions from the secondary working past primary's retirement. */
  postPrimaryContributionEvents: ReadonlyArray<ClassifiedDepositEvent>;
  plainPensionPlacementEvents: ReadonlyArray<ClassifiedDepositEvent>;
  /**
   * Rolled-CBP RMD income by calendar year, carved from linked-CBP lump-sums landing in or after
   * the source owner's RMD trigger year; the MC runner adds it to per-path `otherIncome` (spendable
   * and taxable) so both engines agree. Empty when no split.
   */
  rolledRmdIncomeByYear: ReadonlyMap<number, number>;

  // --- aggregates carried for the remediation banner -----------------
  /** Raw accounts list so callers can resolve owner names + deep-links. */
  accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;

  // --- per-account MC ledger ------------------------------------
  /**
   * Per-account ledger for the MC runner, one entry per active account (annuity-elected CBPs
   * excluded). The `Float64Array`s are empty placeholders: the runner allocates per-step series
   * once it knows the step count.
   */
  accountMcLedger: ReadonlyArray<AccountMcLedgerEntry>;
}

/**
 * Input for `buildBalanceProjectionMcBundle`: already-resolved page state, so tests can construct
 * it from literals.
 */
export interface BalanceProjectionMcBundleArgs {
  scenarioId: string;
  scenarios: ReadonlyArray<ScenarioAggregate>;
  accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  balances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  expenses: ReadonlyArray<Aggregate<ExpensePayload>>;
  ssBenefits: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  /**
   * Pre-resolved CBP election map (from `resolveLinkedCbpIncomeStreams`); `null` when validation
   * failed.
   */
  cbpElections: ReadonlyMap<string, ResolvedCbpElection> | null;
  cbpValidation: CbpValidationResult;
  todayYear: number;
  /**
   * Today's month index (0 = Jan), anchoring contribution-growth baking to the deterministic
   * engine; defaults to 0 for direct-bundle test callers.
   */
  todayMonthIndex?: number;
  retirementYear: number;
  primaryRetirementMonth0: number;
  horizonYear: number;
  retirementFractionalYear: number;
  lifeMarkers: ReadonlyArray<{
    fractionalYear: number;
    label: string;
    color: string;
  }>;
  /**
   * Per-account effective payload (post-scenario-override) and latest balance; MIXED accounts
   * should pass `latestBalancePreTax` / `latestBalancePostTax`, else the split falls back to 50/50.
   */
  accountBundles: ReadonlyArray<{
    account: Aggregate<AccountPayload>;
    latestBalance: number;
    latestBalancePreTax?: number | null;
    latestBalancePostTax?: number | null;
    /**
     * Per-step glide-derived mix series for non-CBP accounts with `retirementAllocation`; null or
     * omitted keeps the flat `assetMix`.
     */
    assetMixSeries?: ReadonlyArray<AssetMix> | null;
  }>;
  /**
   * Windowed per-month expense base in today's dollars; length
   * `(horizonYear − todayYear + 1) × 12`.
   */
  monthlyExpenseBase: number[];
  /**
   * Per-effective-rate windowed expense buckets, as on `BalanceProjectionMcBundle`. Absent means
   * the scalar path.
   */
  monthlyExpenseBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
  /**
   * Per-month today's-dollar HSA medical-demand base (the `isMedical` subset of
   * `monthlyExpenseBase`).
   */
  monthlyMedicalDemandBase?: number[];
  /** Inflation rate (%) of the `isMedical` categories. */
  medicalDemandRatePct?: number;
  /** Per-rate medical-demand buckets when the `isMedical` categories span more than one rate. */
  monthlyMedicalDemandBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
  /** Modeled Medical expenses (every `isMedical` row) base, rate and buckets. */
  monthlyMedicalExpenseBase?: number[];
  medicalExpenseRatePct?: number;
  monthlyMedicalExpenseBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
  /**
   * Nominal annual SS benefit by year offset from `todayYear`; length must equal
   * `horizonYear - todayYear + 1`.
   */
  ssByYear: number[];
  /** Nominal annual non-SS income, indexed like `ssByYear`. */
  incomeByYear: number[];
  scenarioInflationPct: number;
  /** Pre-classified events from the page; CBP lump-sums are computed inside the factory. */
  targetedOneOffEvents: ReadonlyArray<ClassifiedDepositEvent>;
  postPrimaryContributionEvents: ReadonlyArray<ClassifiedDepositEvent>;
  /**
   * Post-retirement plain-pension lump-sum placements (carry `accountId`), routed per-account via
   * `routeEventsToLedger` with a household-spread fallback when the target is not in the MC ledger.
   * Omitted means none.
   */
  plainPensionPlacementEvents?: ReadonlyArray<ClassifiedDepositEvent>;
  /**
   * Source-CBP owner ISO birthdate by CBP account id for the rollover-year RMD split; a miss means
   * no split.
   */
  cbpOwnerBirthdateByAccountId?: ReadonlyMap<string, string>;
  /** The run's RMD calibration snapshot; when omitted the split never fires. */
  rmdSnapshot?: CalibrationSnapshot<RmdTable>;
  /**
   * Linked-CBP lump-sum event month by source CBP account id, as the absolute month
   * (`year * 12 + month0`); tells `applyCbpAccount` how long to compound and where to route the
   * deposit. Omitted falls back to the retirement-step anchor.
   */
  cbpLumpSumEventAbsMonth?: ReadonlyMap<string, number>;
}

/**
 * Assemble the MC bundle. `portfolioToday` sums non-CBP active accounts: a lump-sum-elected CBP is
 * a transfer (`skipsPortfolio: true`) that arrives as a dated `cbpLumpSum` event at the stream's
 * `start`, and an annuity-elected CBP becomes monthly income via its linked stream, so neither
 * counts. Lump-sum events route to the target account's deposit series via `routeEventsToLedger`.
 */
export function buildBalanceProjectionMcBundle(
  args: BalanceProjectionMcBundleArgs,
): BalanceProjectionMcBundle {
  const horizonYears = args.horizonYear - args.todayYear + 1;
  const stepCount = horizonYears * 12;
  const retirementStepIdx = Math.max(
    0,
    (args.retirementYear - args.todayYear) * 12 + args.primaryRetirementMonth0,
  );
  // Resolve contribution growth once (override → baseline → tracks-inflation). The resolver throws
  // on an unknown scenario id, so direct-bundle test callers with a stub scenario list get an empty
  // map (every account → tracks-inflation).
  const growthByAccount = args.scenarios.some((s) => s.id === args.scenarioId)
    ? resolveContributionGrowth(args.scenarioId, [...args.scenarios], args.accounts)
    : new Map<string, ResolvedContributionGrowth>();
  // Per-account floor (first-ancestor-wins per field, CWE-20 sanitised) for the strategy-path
  // drawdown; an empty map when the scenario id is unresolvable, like `growthByAccount`.
  const floorsByAccount = args.scenarios.some((s) => s.id === args.scenarioId)
    ? resolveAccountFloorsForScenario(args.scenarioId, [...args.scenarios], args.accounts)
    : new Map<string, ResolvedAccountFloor>();
  const built = buildAccountLedgerAndAggregates({
    accountBundles: args.accountBundles,
    cbpValidation: args.cbpValidation,
    cbpElections: args.cbpElections,
    retirementYear: args.retirementYear,
    primaryRetirementMonth0: args.primaryRetirementMonth0,
    todayYear: args.todayYear,
    todayMonthIndex: args.todayMonthIndex ?? 0,
    stepCount,
    retirementStepIdx,
    cbpLumpSumEventAbsMonth: args.cbpLumpSumEventAbsMonth,
    growthByAccount,
    floorsByAccount,
    cbpOwnerBirthdateByAccountId: args.cbpOwnerBirthdateByAccountId,
    rmdSnapshot: args.rmdSnapshot,
  });
  // Route dated events into the target account's per-step series; untargeted events, or ones whose
  // account is not in the ledger (e.g. an annuity-elected CBP), fall back to the kernel's
  // proportional household `deposit` series.
  routeEventsToLedger({
    accountMcLedger: built.accountMcLedger,
    stepCount,
    retirementStepIdx,
    cbpLumpSumEvents: built.cbpLumpSumEvents,
    targetedOneOffEvents: args.targetedOneOffEvents,
    postPrimaryContributionEvents: args.postPrimaryContributionEvents,
    plainPensionPlacementEvents: args.plainPensionPlacementEvents ?? [],
  });
  return assembleMcBundleResult({ args, built });
}

function assembleMcBundleResult(opts: {
  args: BalanceProjectionMcBundleArgs;
  built: AccountLedgerAndAggregates;
}): BalanceProjectionMcBundle {
  const { args, built } = opts;
  return {
    scenarioId: args.scenarioId,
    todayYear: args.todayYear,
    todayMonthIndex: args.todayMonthIndex ?? 0,
    retirementYear: args.retirementYear,
    primaryRetirementMonth0: args.primaryRetirementMonth0,
    horizonYear: args.horizonYear,
    retirementFractionalYear: args.retirementFractionalYear,
    lifeMarkers: args.lifeMarkers,
    portfolioToday: built.portfolioToday,
    blendedMix: built.blendedMix,
    annualContribution: built.annualContribution,
    monthlyExpenseBase: args.monthlyExpenseBase,
    ...(args.monthlyExpenseBucketsBase !== undefined
      ? { monthlyExpenseBucketsBase: args.monthlyExpenseBucketsBase }
      : {}),
    // HSA withdrawal-reserve: carry the medical-demand base and rate (and per-rate buckets) so
    // `mcInputFromBundle` sees the demand the deterministic engine funds HSA-first against.
    ...(args.monthlyMedicalDemandBase !== undefined
      ? {
          monthlyMedicalDemandBase: args.monthlyMedicalDemandBase,
          medicalDemandRatePct: args.medicalDemandRatePct,
          ...(args.monthlyMedicalDemandBucketsBase !== undefined
            ? { monthlyMedicalDemandBucketsBase: args.monthlyMedicalDemandBucketsBase }
            : {}),
        }
      : {}),
    ...(args.monthlyMedicalExpenseBase !== undefined
      ? {
          monthlyMedicalExpenseBase: args.monthlyMedicalExpenseBase,
          medicalExpenseRatePct: args.medicalExpenseRatePct,
          ...(args.monthlyMedicalExpenseBucketsBase !== undefined
            ? { monthlyMedicalExpenseBucketsBase: args.monthlyMedicalExpenseBucketsBase }
            : {}),
        }
      : {}),
    ssByYear: args.ssByYear,
    incomeByYear: args.incomeByYear,
    scenarioInflationPct: args.scenarioInflationPct,
    cbpValidation: args.cbpValidation,
    cbpLumpSumEvents: built.cbpLumpSumEvents,
    // The household spread already carries every plain-pension lump-sum's dollars (via
    // `depositInflow`), so unmatched targets are not re-appended (that double-counted);
    // `mcInputFromBundle` subtracts only the ledger-matched amounts.
    targetedOneOffEvents: args.targetedOneOffEvents,
    postPrimaryContributionEvents: args.postPrimaryContributionEvents,
    plainPensionPlacementEvents: args.plainPensionPlacementEvents ?? [],
    rolledRmdIncomeByYear: built.rolledRmdIncomeByYear,
    accounts: args.accounts,
    members: args.members,
    accountMcLedger: built.accountMcLedger,
  };
}

interface AccountLedgerAndAggregates {
  readonly accountMcLedger: AccountMcLedgerEntry[];
  readonly cbpLumpSumEvents: ClassifiedDepositEvent[];
  readonly rolledRmdIncomeByYear: ReadonlyMap<number, number>;
  readonly portfolioToday: number;
  readonly blendedMix: AssetMix;
  readonly annualContribution: number;
}

interface LedgerAccumulator {
  readonly accountMcLedger: AccountMcLedgerEntry[];
  readonly cbpLumpSumEvents: ClassifiedDepositEvent[];
  readonly rolledRmdIncomeByYear: Map<number, number>;
  portfolioToday: number;
  totalNonCbpBalance: number;
  stocksWeighted: number;
  bondsWeighted: number;
  cashWeighted: number;
  annualContribution: number;
}

function buildAccountLedgerAndAggregates(args: {
  accountBundles: BalanceProjectionMcBundleArgs['accountBundles'];
  cbpValidation: CbpValidationResult;
  cbpElections: ReadonlyMap<string, ResolvedCbpElection> | null;
  retirementYear: number;
  primaryRetirementMonth0: number;
  todayYear: number;
  todayMonthIndex: number;
  stepCount: number;
  retirementStepIdx: number;
  /**
   * Event month by CBP account id (absolute month); absent falls back to the retirement-step
   * anchor.
   */
  cbpLumpSumEventAbsMonth?: ReadonlyMap<string, number>;
  growthByAccount: ReadonlyMap<string, ResolvedContributionGrowth>;
  floorsByAccount: ReadonlyMap<string, ResolvedAccountFloor>;
  cbpOwnerBirthdateByAccountId?: ReadonlyMap<string, string>;
  rmdSnapshot?: CalibrationSnapshot<RmdTable>;
}): AccountLedgerAndAggregates {
  const acc = emptyLedgerAccumulator();
  const retirementAbsMonth =
    (args.retirementYear - args.todayYear) * 12 + args.primaryRetirementMonth0;
  const cbpEventMonth = Math.max(0, retirementAbsMonth);
  const yearsToRetirement = Math.max(0, retirementAbsMonth / 12);
  for (const bundle of args.accountBundles) {
    walkAccountBundle({
      bundle,
      acc,
      cbpValidation: args.cbpValidation,
      cbpElections: args.cbpElections,
      cbpEventMonth,
      yearsToRetirement,
      stepCount: args.stepCount,
      retirementStepIdx: args.retirementStepIdx,
      todayYear: args.todayYear,
      todayMonthIndex: args.todayMonthIndex,
      cbpLumpSumEventAbsMonth: args.cbpLumpSumEventAbsMonth,
      growthByAccount: args.growthByAccount,
      floorsByAccount: args.floorsByAccount,
      cbpOwnerBirthdateByAccountId: args.cbpOwnerBirthdateByAccountId,
      rmdSnapshot: args.rmdSnapshot,
    });
  }
  return {
    accountMcLedger: acc.accountMcLedger,
    cbpLumpSumEvents: acc.cbpLumpSumEvents,
    rolledRmdIncomeByYear: acc.rolledRmdIncomeByYear,
    portfolioToday: acc.portfolioToday,
    blendedMix: finalizeBlendedMix(acc),
    annualContribution: acc.annualContribution,
  };
}

function emptyLedgerAccumulator(): LedgerAccumulator {
  return {
    accountMcLedger: [],
    cbpLumpSumEvents: [],
    rolledRmdIncomeByYear: new Map<number, number>(),
    portfolioToday: 0,
    totalNonCbpBalance: 0,
    stocksWeighted: 0,
    bondsWeighted: 0,
    cashWeighted: 0,
    annualContribution: 0,
  };
}

function walkAccountBundle(opts: {
  bundle: BalanceProjectionMcBundleArgs['accountBundles'][number];
  acc: LedgerAccumulator;
  cbpValidation: CbpValidationResult;
  cbpElections: ReadonlyMap<string, ResolvedCbpElection> | null;
  cbpEventMonth: number;
  yearsToRetirement: number;
  stepCount: number;
  retirementStepIdx: number;
  todayYear: number;
  todayMonthIndex: number;
  cbpLumpSumEventAbsMonth?: ReadonlyMap<string, number>;
  growthByAccount: ReadonlyMap<string, ResolvedContributionGrowth>;
  floorsByAccount: ReadonlyMap<string, ResolvedAccountFloor>;
  cbpOwnerBirthdateByAccountId?: ReadonlyMap<string, string>;
  rmdSnapshot?: CalibrationSnapshot<RmdTable>;
}): void {
  const { bundle, acc } = opts;
  const account = bundle.account;
  if (account.payload.active === false) return;
  acc.annualContribution +=
    account.payload.plannedContributionPreTax +
    account.payload.plannedContributionPostTax;
  if (account.payload.type === 'RETIREMENT_CASH_BALANCE') {
    // Event month from the stream's `start` anchor; the retirement-step anchor when absent.
    const eventAbs = opts.cbpLumpSumEventAbsMonth?.get(account.id) ?? null;
    const resolvedEventMonth =
      eventAbs !== null
        ? Math.max(0, eventAbs - opts.todayYear * 12)
        : opts.cbpEventMonth;
    const monthsToEvent = resolvedEventMonth;
    const yearsToEvent = monthsToEvent / 12;
    const handled = applyCbpAccount({
      account,
      latestBalance: bundle.latestBalance,
      latestBalancePostTax: bundle.latestBalancePostTax ?? null,
      cbpValidation: opts.cbpValidation,
      cbpElections: opts.cbpElections,
      cbpEventMonth: resolvedEventMonth,
      yearsToRetirement: yearsToEvent,
      stepCount: opts.stepCount,
      retirementStepIdx: opts.retirementStepIdx,
      accountMcLedger: acc.accountMcLedger,
      cbpLumpSumEvents: acc.cbpLumpSumEvents,
      rolledRmdIncomeByYear: acc.rolledRmdIncomeByYear,
      firstYear: opts.todayYear,
      todayMonthIndex: opts.todayMonthIndex,
      contributionGrowth: opts.growthByAccount.get(account.id),
      ownerBirthdate: opts.cbpOwnerBirthdateByAccountId?.get(account.id),
      rmdSnapshot: opts.rmdSnapshot,
    });
    if (handled.skipsPortfolio) return;
    acc.portfolioToday += handled.portfolioDelta;
    return;
  }
  appendNonCbpLedgerEntry({
    bundle,
    acc,
    opts: {
      stepCount: opts.stepCount,
      retirementStepIdx: opts.retirementStepIdx,
      firstYear: opts.todayYear,
      todayMonthIndex: opts.todayMonthIndex,
      contributionGrowth: opts.growthByAccount.get(account.id),
      floor: opts.floorsByAccount.get(account.id),
    },
  });
}

function appendNonCbpLedgerEntry(args: {
  bundle: BalanceProjectionMcBundleArgs['accountBundles'][number];
  acc: LedgerAccumulator;
  opts: {
    stepCount: number;
    retirementStepIdx: number;
    firstYear: number;
    todayMonthIndex: number;
    contributionGrowth: ResolvedContributionGrowth | undefined;
    floor: ResolvedAccountFloor | undefined;
  };
}): void {
  const { bundle, acc, opts } = args;
  const account = bundle.account;
  acc.portfolioToday += bundle.latestBalance;
  acc.totalNonCbpBalance += bundle.latestBalance;
  const mix =
    account.payload.assetMix ??
    defaultAssetMixForAccountType(account.payload.type);
  acc.stocksWeighted += bundle.latestBalance * mix.stocksPct;
  acc.bondsWeighted += bundle.latestBalance * mix.bondsPct;
  acc.cashWeighted += bundle.latestBalance * mix.cashPct;
  acc.accountMcLedger.push(
    buildLedgerEntry({
      account,
      latestBalance: bundle.latestBalance,
      latestBalancePreTax: bundle.latestBalancePreTax ?? null,
      latestBalancePostTax: bundle.latestBalancePostTax ?? null,
      stepCount: opts.stepCount,
      retirementStepIdx: opts.retirementStepIdx,
      cbpPlanningReturnPct: null,
      assetMixSeries: bundle.assetMixSeries ?? null,
      contributionGrowth: opts.contributionGrowth,
      firstYear: opts.firstYear,
      todayMonthIndex: opts.todayMonthIndex,
      ...(opts.floor !== undefined
        ? { floor: { floorDollars: opts.floor.floorDollars, hsaMode: opts.floor.hsaMode } }
        : {}),
    }),
  );
}

function finalizeBlendedMix(acc: LedgerAccumulator): AssetMix {
  if (acc.totalNonCbpBalance > 0) {
    return {
      stocksPct: acc.stocksWeighted / acc.totalNonCbpBalance,
      bondsPct: acc.bondsWeighted / acc.totalNonCbpBalance,
      cashPct: acc.cashWeighted / acc.totalNonCbpBalance,
    };
  }
  return { stocksPct: 70, bondsPct: 25, cashPct: 5 };
}

// Roth-designated cents of a MIXED CBP's grown basis: the stored post-tax share applied to the
// grown basis, matching the deterministic `cbpRothPortionCents`; 0 when no post-tax balance is
// recorded.
function mcCbpRothPortionCents(
  latestBalance: number,
  latestBalancePostTax: number | null,
  basisCents: number,
): number {
  if (
    latestBalancePostTax === null ||
    latestBalancePostTax <= 0 ||
    latestBalance <= 0
  ) {
    return 0;
  }
  const rothFraction = Math.min(1, latestBalancePostTax / latestBalance);
  return Math.round(basisCents * rothFraction);
}

function applyCbpAccount(args: {
  account: Aggregate<AccountPayload>;
  latestBalance: number;
  latestBalancePostTax?: number | null;
  cbpValidation: CbpValidationResult;
  cbpElections: ReadonlyMap<string, ResolvedCbpElection> | null;
  cbpEventMonth: number;
  yearsToRetirement: number;
  stepCount: number;
  retirementStepIdx: number;
  accountMcLedger: AccountMcLedgerEntry[];
  cbpLumpSumEvents: ClassifiedDepositEvent[];
  rolledRmdIncomeByYear: Map<number, number>;
  firstYear: number;
  todayMonthIndex: number;
  contributionGrowth: ResolvedContributionGrowth | undefined;
  ownerBirthdate?: string;
  rmdSnapshot?: CalibrationSnapshot<RmdTable>;
}): { skipsPortfolio: boolean; portfolioDelta: number } {
  const election = args.cbpValidation.ok
    ? args.cbpElections?.get(args.account.id) ?? null
    : null;
  if (election?.kind === 'lumpSum') {
    const planningRate = args.account.payload.planningReturnPct;
    const grown =
      args.latestBalance * Math.pow(1 + planningRate / 100, args.yearsToRetirement);
    // Carve the rollover-year RMD first (taxable ordinary income, distributed) with the same helper
    // as the deterministic seam; only the excess rolls to the target.
    const eventCalendarYear = args.firstYear + Math.floor(args.cbpEventMonth / 12);
    const basisCents = Math.round(grown * 100);
    const split =
      args.rmdSnapshot !== undefined
        ? splitRolloverByRmd({
            basisCents,
            ownerBirthdate: args.ownerBirthdate,
            eventYear: eventCalendarYear,
            sourceTaxTreatment: args.account.payload.taxTreatment,
            // A MIXED source CBP carves its RMD only on the pre-tax portion (SECURE 2.0 §325); the
            // stored post-tax share is applied to the grown basis.
            ...(args.account.payload.taxTreatment === 'MIXED'
              ? {
                  rothPortionCents: mcCbpRothPortionCents(
                    args.latestBalance,
                    args.latestBalancePostTax ?? null,
                    basisCents,
                  ),
                }
              : {}),
            rmdSnapshot: args.rmdSnapshot,
          })
        : { rmdPortionCents: 0, rolloverExcessCents: basisCents };
    args.cbpLumpSumEvents.push({
      month: args.cbpEventMonth,
      amount: split.rolloverExcessCents / 100,
      accountId: election.targetAccountId,
    });
    if (split.rmdPortionCents > 0) {
      const dollars = split.rmdPortionCents / 100;
      args.rolledRmdIncomeByYear.set(
        eventCalendarYear,
        (args.rolledRmdIncomeByYear.get(eventCalendarYear) ?? 0) + dollars,
      );
    }
    // A lump-sum CBP never compounds in the MC ledger; it lands as a deposit on the target.
    return { skipsPortfolio: true, portfolioDelta: 0 };
  }
  if (election?.kind === 'annuity') {
    // Annuity-elected: excluded; income flows via the linked stream.
    return { skipsPortfolio: true, portfolioDelta: 0 };
  }
  // No resolved election (validation failed or unconfigured): compounds at `planningReturnPct`.
  args.accountMcLedger.push(
    buildLedgerEntry({
      account: args.account,
      latestBalance: args.latestBalance,
      stepCount: args.stepCount,
      retirementStepIdx: args.retirementStepIdx,
      cbpPlanningReturnPct: args.account.payload.planningReturnPct,
      contributionGrowth: args.contributionGrowth,
      firstYear: args.firstYear,
      todayMonthIndex: args.todayMonthIndex,
    }),
  );
  return { skipsPortfolio: false, portfolioDelta: args.latestBalance };
}

function routeEventsToLedger(args: {
  accountMcLedger: AccountMcLedgerEntry[];
  stepCount: number;
  retirementStepIdx: number;
  cbpLumpSumEvents: ReadonlyArray<ClassifiedDepositEvent>;
  targetedOneOffEvents: ReadonlyArray<ClassifiedDepositEvent>;
  postPrimaryContributionEvents: ReadonlyArray<ClassifiedDepositEvent>;
  plainPensionPlacementEvents?: ReadonlyArray<ClassifiedDepositEvent>;
}): void {
  const byId = new Map<string, AccountMcLedgerEntry>();
  for (const entry of args.accountMcLedger) byId.set(entry.id, entry);
  // CBP and one-off events carry no pre/post split: the whole amount goes to the summed `deposit`
  // slot. Post-primary spouse contributions carry `amountPre`/`amountPost`, routed to their slots
  // while `deposit += amountPre + amountPost` stays what the no-ledger kernel path reads.
  const routeWholeAmount = (list: ReadonlyArray<ClassifiedDepositEvent>): void => {
    for (const ev of list) {
      if (ev.month < 0 || ev.month >= args.stepCount) continue;
      if (!ev.accountId) continue;
      const entry = byId.get(ev.accountId);
      if (!entry) continue;
      if (ev.month < args.retirementStepIdx) {
        entry.contribPost[ev.month] += ev.amount;
      } else {
        entry.deposit[ev.month] += ev.amount;
      }
    }
  };
  const routeSplit = (list: ReadonlyArray<ClassifiedDepositEvent>): void => {
    for (const ev of list) {
      if (ev.month < 0 || ev.month >= args.stepCount) continue;
      if (!ev.accountId) continue;
      const entry = byId.get(ev.accountId);
      if (!entry) continue;
      // With neither split field set, treat the whole amount as pre-tax rather than silently
      // dropping dollars (direct-construction callers).
      const hasSplit = ev.amountPre !== undefined || ev.amountPost !== undefined;
      const pre = hasSplit ? (ev.amountPre ?? 0) : ev.amount;
      const post = hasSplit ? (ev.amountPost ?? 0) : 0;
      if (ev.month < args.retirementStepIdx) {
        // Post-primary contributions are post-retirement by construction; this branch is only
        // defensive and mirrors the account-less path.
        entry.contribPost[ev.month] += pre + post;
      } else {
        // `deposit` keeps the summed value; the named-strategy slice consumes the split slots.
        entry.depositPre[ev.month] += pre;
        entry.depositPost[ev.month] += post;
        entry.deposit[ev.month] += pre + post;
      }
    }
  };
  // Ledger-matched placements route whole (destination treatment applies downstream, as for
  // linked-CBP); an unmatched target stays in the household spread, so it is skipped here.
  const routePlainPension = (list: ReadonlyArray<ClassifiedDepositEvent>): void => {
    for (const ev of list) {
      if (ev.month < 0 || ev.month >= args.stepCount) continue;
      if (!ev.accountId || !byId.has(ev.accountId)) continue;
      const entry = byId.get(ev.accountId)!;
      if (ev.month < args.retirementStepIdx) {
        entry.contribPost[ev.month] += ev.amount;
      } else {
        entry.deposit[ev.month] += ev.amount;
      }
    }
  };
  routeWholeAmount(args.cbpLumpSumEvents);
  routeWholeAmount(args.targetedOneOffEvents);
  routeSplit(args.postPrimaryContributionEvents);
  routePlainPension(args.plainPensionPlacementEvents ?? []);
}
