/**
 * Balance-projection bundle module — collects the page-level resolution
 * work for the Monte Carlo input builder into a single, independently-
 * unit-testable surface.
 *
 * Exports:
 *   - `buildMonthlyExpenseSeries` — pure converter from per-month rows
 *     to a `MonthlyCashflowSeries`.
 *   - `buildMonthlyIncomeSeries` — SS + pension + part-time + oneOff
 *     spendable, monthly.
 *   - `buildMonthlyDepositSeries` — targeted one-offs + CBP lump-sums
 *     + synthesized secondary post-primary contributions, monthly.
 *   - `buildBalanceProjectionMcBundle` — packages every input the MC
 *     builder needs into a typed bundle.
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

// Re-exported so existing consumers keep importing the MC ledger entry type
// from this module (public API unchanged).
export type { AccountMcLedgerEntry };

/** Per-month spendable-income row contract. Mirrors the subset of
 *  `IncomeProjectionMonth` the bundle needs (the income-projection
 *  helper emits more fields the bundle ignores). */
export interface MonthlyIncomeRow {
  year: number;
  month0: number;
  pensionIncome: number;
  partTimeIncome: number;
  oneOffIncome: number;
  /** Lump-sum *portfolio* addition — feeds depositInflow, not spendable. */
  depositInflow: number;
}

/** Per-month SS row contract. */
export interface MonthlySsRow {
  year: number;
  month0: number;
  /** Combined SS run-rate, $/yr at this month. */
  total: number;
}

/** Per-month expense row contract. `total` mixes a recurring run-rate
 *  ($/yr at this month) with the literal one-off spike (event-month
 *  dollars). The drawdown engine consumes them with different
 *  arithmetic — divide the run-rate share by 12 to get monthly
 *  dollars, but charge one-off spikes at full amount in their event
 *  month. The `oneOffEssential` + `oneOffDiscretionary` fields surface
 *  the spike portion so callers can split correctly. */
export interface MonthlyExpenseRow {
  year: number;
  month0: number;
  total: number;
  oneOffEssential: number;
  oneOffDiscretionary: number;
}

/** Targeted post-retirement deposit event (CBP lump-sum, one-off
 *  windfall, secondary post-primary monthly contribution). Pre-classified
 *  so the MC builder can tag events with the right `source`. */
export interface ClassifiedDepositEvent {
  /** Absolute step index in the MC kernel — `(year - todayYear) * 12 + month0`. */
  month: number;
  /** Nominal-dollar amount at the event month. For account-less event types
   *  (CBP lump-sum / one-off windfall) this is the whole event amount. For a
   *  post-primary spouse contribution it is `amountPre + amountPost` (the
   *  summed value the no-ledger kernel path reads — kept so that path stays
   *  byte-identical). */
  amount: number;
  /** Pre-tax (pre-tax-designated) slice of a post-primary spouse
   *  contribution. Carried so the destination account's `pre` bucket receives
   *  exactly the pre-tax dollars (no longer inferred from destination
   *  treatment). Undefined for CBP / one-off events (they route the whole
   *  `amount` by destination treatment). */
  amountPre?: number;
  /** Designated-Roth (post-tax) slice of a post-primary spouse contribution —
   *  routed to the destination account's `post` bucket regardless of
   *  treatment (a MIXED account's Roth slice stays RMD-exempt, §325).
   *  Undefined for CBP / one-off events. */
  amountPost?: number;
  /** Optional account id for caller correlation. */
  accountId?: string;
}

/**
 * Convert per-month expense rows to a `MonthlyCashflowSeries` anchored at
 * (retirementYear, January). Each row contributes its `total / 12`
 * monthly run-rate divided into a one-month deposit — the engine pools
 * them per-month and treats the result as actual dollars per month.
 *
 * Rows outside the [retirementYear..horizonYear] window are silently
 * dropped — the projection helper sometimes emits trailing months past
 * the death cutoff at zero.
 */
export function buildMonthlyExpenseSeries(args: {
  rows: ReadonlyArray<MonthlyExpenseRow>;
  retirementYear: number;
  horizonYear: number;
}): MonthlyCashflowSeries {
  const series = emptyMonthlySeries(args.retirementYear, args.horizonYear);
  if (series.values.length === 0) return series;
  for (const row of args.rows) {
    // `total` mixes recurring run-rate ($/yr) with literal one-off
    // spikes (event-month dollars). Split before scaling: divide the
    // run-rate share by 12 (→ monthly dollars), keep the spike share
    // at full amount in its event month.
    const oneOff = row.oneOffEssential + row.oneOffDiscretionary;
    const runRate = row.total - oneOff;
    addOneOff(series, row.year, row.month0, runRate / 12 + oneOff);
  }
  return series;
}

/**
 * Convert per-month income rows (SS + pension + part-time + spendable
 * one-off) to a single income `MonthlyCashflowSeries`. Mirrors the
 * page's pre-extracted inline construction; the engine sums these
 * dollars into `income[]` for net-need computation.
 *
 * `depositInflow` is intentionally NOT folded here —
 * portfolio additions feed `buildMonthlyDepositSeries`, not income.
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
    // SS is a pure run-rate — divide by 12 for monthly dollars.
    addOneOff(series, row.year, row.month0, row.total / 12);
  }
  for (const row of args.incomeRows) {
    // Pension + part-time are run-rates ($/yr at this month); divide
    // by 12. `oneOffIncome` is the spendable one-off literal event
    // amount — keep at full value in its event month (the income
    // projection helper emits it as the literal payout, not a rate).
    const runRate = row.pensionIncome + row.partTimeIncome;
    addOneOff(series, row.year, row.month0, runRate / 12 + row.oneOffIncome);
  }
  return series;
}

/**
 * Build the household-pool monthly deposit series the drawdown engine
 * consumes: targeted one-off windfalls + CBP lump-sum payouts that
 * arrive via `MonthlyIncomeRow.depositInflow` (still
 * household-spread in both engines). Post-primary spouse contributions
 * are NOT folded here: they route per-account, carrying their
 * pre/post split, via the per-account ledger (deterministic) and the MC
 * ledger's split deposit slots — so summing them into the household pool
 * (and then proportional-spreading) would double-count + drop their
 * account target.
 *
 * Inflows whose absolute month falls before primary's retirement month
 * are silently skipped — those are routed to per-account accumulation
 * upstream.
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
 * Pre-resolved MC bundle. Built once on the page; the MC builder
 * consumes it as a single argument and returns either a
 * validation failure (`input === undefined`) or a complete
 * `BuiltMonteCarloInputs`.
 *
 * Scalars are **today's-dollar** retirement-start values — the MC
 * kernel inflates them forward by sampled CPI. `events` carry nominal
 * dollars at their event month (the kernel does not inflate events).
 */
/**
 * Downturn-guardrail block carried on the MC bundle (guardrails). Present only
 * when the resolved scenario ENABLES the guardrail. All REAL series are today's-
 * dollar per DRAWDOWN year, index 0 = the first drawdown (retirement) year,
 * length = drawdown-year count.
 */
export interface GuardrailBundleBlock {
  readonly config: DownturnGuardrailsOverride;
  /** REAL total spending on the 100% baseline path, per drawdown year. */
  readonly baselineTotalRealByYear: number[];
  /** REAL net spending need (total − guaranteed income) on the baseline path. */
  readonly baselineNetNeedRealByYear: number[];
  /** REAL essential-only spending on the baseline path (the cut floor). */
  readonly essentialRealByYear: number[];
  /** Effective-tax gross-up proxy for the funded-ratio liability. */
  readonly effectiveTaxRate: number;
}

export interface BalanceProjectionMcBundle {
  // --- identity + anchors --------------------------------------------
  /** Scenario the bundle was resolved against. Drives cache keys. */
  scenarioId: string;
  /** Calendar year of step 0 (= MC `firstYear`). */
  todayYear: number;
  /** Month-of-year (0..11) "today" falls on. The today-anchor for
   *  tracks-inflation per-path contribution CPI scaling — threaded
   *  into `MonteCarloInput.todayMonthIndex`. Defaults to 0 (January). */
  todayMonthIndex: number;
  /** Calendar year of primary's retirement (step `retirementStepIdx`). */
  retirementYear: number;
  /** Month-of-year (0..11) for primary's retirement step. */
  primaryRetirementMonth0: number;
  /** Last calendar year to simulate. */
  horizonYear: number;
  /** Primary retirement as a fractional year — passed straight through
   *  to the fan chart's vertical marker. */
  retirementFractionalYear: number;
  /** Life-expectancy markers for the fan chart. Display-only — the
   *  builder ignores them. */
  lifeMarkers: ReadonlyArray<{
    fractionalYear: number;
    label: string;
    color: string;
  }>;

  // --- engine-facing scalars (today's-dollar) ------------------------
  /** Combined balance at firstYear, excluding annuity-elected CBPs. */
  portfolioToday: number;
  /** Household-blended asset mix across all non-CBP active accounts.
   *  Retained for back-compat with non-MC consumers; the MC runner now
   *  reads per-account asset mix off `accountMcLedger`. */
  blendedMix: AssetMix;
  /** Sum of annual planned contributions across accounts. */
  annualContribution: number;
  /** Windowed per-month expense base in today's dollars. One entry per
   *  projection month from `todayYear`; length =
   *  `(horizonYear − todayYear + 1) × 12`. Charges each expense only in its
   *  active start/end window. Threaded straight to
   *  `MonteCarloInput.monthlyExpenseBase`. */
  monthlyExpenseBase: number[];
  /** Per-effective-rate windowed expense buckets. Present only when ≥ 1
   *  category inflates at a rate ≠ the
   *  scenario general rate; each `amount` is a per-month today's-dollar array
   *  the same length as `monthlyExpenseBase`, with `Σ_b amount_b[i] ===
   *  monthlyExpenseBase[i]` per step. Absent ⇒ the MC kernel runs the verbatim
   *  scalar `monthlyExpenseBase` path. Threaded straight to
   *  `MonteCarloInput.monthlyExpenseBucketsBase`. */
  monthlyExpenseBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
  /** Per-month today's-dollar HSA medical-demand base (HSA withdrawal-reserve)
   *  — the `isMedical` subset of `monthlyExpenseBase`. Present only when
   *  ≥ 1 category is flagged `isMedical`. Threaded into
   *  `MonteCarloInput.monthlyMedicalDemandBase`. */
  monthlyMedicalDemandBase?: number[];
  /** Effective inflation rate (%) the `isMedical` categories grow at. Present
   *  only alongside `monthlyMedicalDemandBase`. Threaded into
   *  `MonteCarloInput.medicalDemandRatePct`. */
  medicalDemandRatePct?: number;
  /** Per-effective-rate medical-demand buckets — present only when the
   *  `isMedical` categories span > 1 effective rate, so each medical sub-series
   *  inflates at its own rate. Threaded into
   *  `MonteCarloInput.monthlyMedicalDemandBucketsBase`. */
  monthlyMedicalDemandBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
  /** Per-month today's-dollar modeled Medical expenses (every `isMedical` row),
   *  rate and buckets, for the matching `MonteCarloInput` fields. */
  monthlyMedicalExpenseBase?: number[];
  medicalExpenseRatePct?: number;
  monthlyMedicalExpenseBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
  /** Pre-computed nominal annual SS benefit by year-offset from
   *  `todayYear`. Length = `horizonYear - todayYear + 1`. Already in
   *  nominal (calendar-year) dollars — the MC kernel reads directly,
   *  no CPI scaling. */
  ssByYear: number[];
  /** Pre-computed nominal annual non-SS income by year-offset from
   *  `todayYear`. Same length and indexing as `ssByYear`. Already in
   *  nominal dollars. */
  incomeByYear: number[];
  /** Resolved annual scenario inflation rate (%). Threaded into
   *  `MonteCarloInput.scenarioInflationPct` so the kernel can mean-shift
   *  the CPI bootstrap. */
  scenarioInflationPct: number;
  /** Downturn-guardrail config + baseline REAL per-drawdown-year net-need /
   *  essential / total spending series + effective-tax proxy (guardrails).
   *  Present ONLY when a scenario in the chain ENABLES the guardrail; absent
   *  otherwise so a no-guardrail scenario's serialized `MonteCarloInput` (and
   *  `mcCacheKey`) carries no guardrail fields. Assembled by the runner
   *  (`assembleMcBundle`) and threaded into `MonteCarloInput` by
   *  `mcInputFromBundle`. */
  downturnGuardrails?: GuardrailBundleBlock;

  // --- validation + classified events --------------------------------
  /** CBP validation against the active scenario. When `ok === false`,
   *  the MC builder returns `input: undefined`. */
  cbpValidation: CbpValidationResult;
  /** CBP lump-sum events: one entry per linked `lumpSum` pension stream,
   *  anchored at the stream's `start` (the event month) with the source
   *  CBP balance compounded forward to that month at `planningReturnPct`.
   *  The source CBP is excluded from the per-account ledger (mirrors the
   *  bundle factory's `skipsPortfolio: true`); these events route the
   *  transferred balance to the target account's per-account
   *  `depositsByMonth[eventMonth]` slot. */
  cbpLumpSumEvents: ReadonlyArray<ClassifiedDepositEvent>;
  /** Targeted one-off windfalls (non-CBP). */
  targetedOneOffEvents: ReadonlyArray<ClassifiedDepositEvent>;
  /** Synthesized monthly contributions from secondary working past
   *  primary's retirement. */
  postPrimaryContributionEvents: ReadonlyArray<ClassifiedDepositEvent>;
  /** Post-retirement plain-pension lump-sum placement events. */
  plainPensionPlacementEvents: ReadonlyArray<ClassifiedDepositEvent>;
  /** Per-CALENDAR-YEAR rolled-CBP RMD income (dollars) carved from
   *  linked-CBP lump-sums landing in/after the source owner's RMD trigger
   *  year. The MC runner adds it to the per-path `otherIncome` (spendable +
   *  taxable) so the two engines agree to the cent. Empty when no split. */
  rolledRmdIncomeByYear: ReadonlyMap<number, number>;

  // --- aggregates carried for the remediation banner -----------------
  /** Raw accounts list so callers can resolve owner names + deep-links. */
  accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  /** Raw members list (same banner consumer). */
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;

  // --- per-account MC ledger ------------------------------------
  /** Per-account ledger for the MC runner. One entry per active account
   *  that enters the simulation (annuity-elected CBPs excluded).
   *  Empty `Float64Array`s as placeholder — the MC runner allocates the
   *  actual per-step series during input assembly (it needs the step
   *  count, which depends on the simulation horizon the runner owns). */
  accountMcLedger: ReadonlyArray<AccountMcLedgerEntry>;
}

/**
 * Input shape for `buildBalanceProjectionMcBundle`. All fields are
 * already-resolved page state — no IndexedDB, no React, no Date.now().
 * Tests can construct this directly with literal data.
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
  /** Pre-resolved CBP election map (output of
   *  `resolveLinkedCbpIncomeStreams`). May be `null` when validation
   *  failed; the bundle factory only consults this when validation is
   *  `ok`. */
  cbpElections: ReadonlyMap<string, ResolvedCbpElection> | null;
  cbpValidation: CbpValidationResult;
  todayYear: number;
  /** Today's calendar month index (0 = Jan). Forms the today-anchor for
   *  contribution-growth baking so the MC fixed-growth series matches the
   *  deterministic engine for the same calendar month. Omitted → 0
   *  (January) for back-compat with direct-bundle test callers. */
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
  /** Per-account effective payload (post-scenario-override) + latest
   *  balance. Caller resolves overrides upstream. For MIXED-tax
   *  accounts callers should pass `latestBalancePreTax` /
   *  `latestBalancePostTax` so the MC ledger reflects the stored
   *  split — falls back to 50/50 when omitted. */
  accountBundles: ReadonlyArray<{
    account: Aggregate<AccountPayload>;
    latestBalance: number;
    latestBalancePreTax?: number | null;
    latestBalancePostTax?: number | null;
    /** Per-step glide-derived mix series; computed by the runner when
     *  `retirementAllocation` is set. `null` / omitted → flat `assetMix`
     *  path (existing default). Only meaningful for non-CBP accounts. */
    assetMixSeries?: ReadonlyArray<AssetMix> | null;
  }>;
  /** Windowed per-month expense base in today's dollars. One entry per
   *  projection month from `todayYear`; length =
   *  `(horizonYear − todayYear + 1) × 12`. */
  monthlyExpenseBase: number[];
  /** Per-effective-rate windowed expense buckets. Present only when ≥ 1
   *  category inflates at a rate ≠ the
   *  scenario general rate; each `amount` is a per-month array the same length
   *  as `monthlyExpenseBase`, with `Σ_b amount_b[i] === monthlyExpenseBase[i]`.
   *  Absent ⇒ scalar path. */
  monthlyExpenseBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
  /** Per-month today's-dollar HSA medical-demand base (HSA withdrawal-reserve)
   *  — the `isMedical` subset of `monthlyExpenseBase`. Present only when
   *  ≥ 1 category is flagged `isMedical`. Carried through to
   *  `MonteCarloInput.monthlyMedicalDemandBase`. */
  monthlyMedicalDemandBase?: number[];
  /** Effective inflation rate (%) the `isMedical` categories grow at. Present
   *  only alongside `monthlyMedicalDemandBase`. Carried through to
   *  `MonteCarloInput.medicalDemandRatePct`. */
  medicalDemandRatePct?: number;
  /** Per-effective-rate medical-demand buckets — present only when the
   *  `isMedical` categories span > 1 effective rate, so each medical sub-series
   *  inflates at its own rate. Carried through to
   *  `MonteCarloInput.monthlyMedicalDemandBucketsBase`. */
  monthlyMedicalDemandBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
  /** Modeled Medical expenses (every `isMedical` row) base, rate and buckets. */
  monthlyMedicalExpenseBase?: number[];
  medicalExpenseRatePct?: number;
  monthlyMedicalExpenseBucketsBase?: ReadonlyArray<{ ratePct: number; amount: number[] }>;
  /** Pre-computed nominal annual SS benefit by year-offset from
   *  `todayYear`. Length must equal `horizonYear - todayYear + 1`.
   *  Already in nominal (calendar-year) dollars. */
  ssByYear: number[];
  /** Pre-computed nominal annual non-SS income by year-offset from
   *  `todayYear`. Same length and indexing as `ssByYear`. Already in
   *  nominal dollars. */
  incomeByYear: number[];
  /** Resolved annual scenario inflation rate (%). Carried through to
   *  the bundle so the MC kernel can mean-shift the CPI bootstrap. */
  scenarioInflationPct: number;
  /** Pre-classified events the page already separates. CBP lump-sums
   *  are computed inside the factory; the page provides the targeted
   *  one-offs and post-primary contributions split out. */
  targetedOneOffEvents: ReadonlyArray<ClassifiedDepositEvent>;
  postPrimaryContributionEvents: ReadonlyArray<ClassifiedDepositEvent>;
  /** Post-retirement plain-pension lump-sum placement events (carry
   *  `accountId`). Routed per-account whole (→ destination treatment) via
   *  `routeEventsToLedger`, with a household-spread fallback when the target
   *  is not in the MC ledger. Omitted ⇒ none. */
  plainPensionPlacementEvents?: ReadonlyArray<ClassifiedDepositEvent>;
  /** Source-CBP owner ISO birthdate keyed by CBP account id, for the
   *  rollover-year RMD split. A miss → no split (whole amount rolls). */
  cbpOwnerBirthdateByAccountId?: ReadonlyMap<string, string>;
  /** The run's RMD calibration snapshot (no hard-coded trigger ages /
   *  divisors). When omitted the split never fires (whole amount rolls). */
  rmdSnapshot?: CalibrationSnapshot<RmdTable>;
  /** Linked-CBP lump-sum event-month metadata keyed by source
   *  CBP account id, as the **absolute month** (`year * 12 + month0`).
   *  Tells `applyCbpAccount` how long to compound the source CBP
   *  balance forward and which kernel step to route the deposit to.
   *  When omitted (or no entry for a CBP), `applyCbpAccount` falls
   *  back to the retirement-step anchor (kept for direct bundle callers
   *  that don't compute resolved-income event timing). */
  cbpLumpSumEventAbsMonth?: ReadonlyMap<string, number>;
}

/**
 * Assemble the MC bundle. Computes:
 *   - `portfolioToday`: sum of every non-CBP active account balance.
 *     Lump-sum-elected CBPs are EXCLUDED (transfer
 *     semantic — `skipsPortfolio: true`) — their balance flows into
 *     the target account via a dated `cbpLumpSum` event firing at
 *     the income stream's `start` anchor (per-event month, NOT the
 *     retirement step). Annuity-elected CBPs are also excluded —
 *     their balance becomes monthly income via the linked stream.
 *   - `blendedMix`: balance-weighted asset mix across non-CBP accounts.
 *   - `annualContribution`: sum of planned contributions.
 *   - `cbpLumpSumEvents`: source CBP compounded forward to the event
 *     month at `planningReturnPct`. The
 *     dated event routes to the target account's per-step deposit
 *     series via `routeEventsToLedger`.
 *
 * Annuity-elected CBPs contribute zero events and zero portfolio dollars.
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
  // Resolve the per-account contribution-growth rate + mode once
  // (override → baseline → tracks-inflation). `'fixed'` accounts get the
  // growth baked into their ledger contribution series here; tracks-
  // inflation accounts keep a today's-dollars base the runner CPI-scales
  // per path. `resolveContributionGrowth` throws on an unknown
  // scenario id (sibling-resolver contract); the production runner always
  // passes a resolvable chain, but direct-bundle test callers may pass a
  // stub scenario list — fall back to an empty map (every account →
  // tracks-inflation default) so the factory stays robust.
  const growthByAccount = args.scenarios.some((s) => s.id === args.scenarioId)
    ? resolveContributionGrowth(args.scenarioId, [...args.scenarios], args.accounts)
    : new Map<string, ResolvedContributionGrowth>();
  // Resolve the per-account floor (per-field
  // first-ancestor-wins, CWE-20 sanitised) so the MC ledger carries it into the
  // strategy-path drawdown engine — per-path floor enforcement matches the
  // deterministic engine. Falls back to an empty map when the scenario id is
  // not resolvable (direct-bundle test callers), like `growthByAccount`.
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
  // Route every dated event into the target account's per-step series
  // when the event carries a `targetAccountId` resolving to a ledger
  // entry. Untargeted events (or events targeting a non-ledger account
  // — e.g. an annuity-elected CBP) fall back to proportional-to-balance
  // distribution by the kernel via the household-level `deposit`
  // series — the runner handles this fallback when it assembles
  // `MonteCarloInput`.
  // Route ledger-matched plain-pension placements per-account. Events whose
  // target is NOT in the MC ledger are left in the household spread by `mcInput-
  // FromBundle` (it subtracts only the ledger-matched amounts from
  // `targetedOneOffEvents`); the dollars are conserved there, so no
  // fallback re-append is needed (a re-append would double-count them).
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

/** Compose the public `BalanceProjectionMcBundle` from the assembled
 *  per-account ledger + caller args. Extracted from
 *  `buildBalanceProjectionMcBundle` (40-ln function cap). */
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
    // HSA withdrawal-reserve: carry the medical-demand base + its
    // effective rate (and the per-rate buckets when the medical set spans > 1
    // rate) through to the bundle so the production MC path
    // (`mcInputFromBundle`) sees the same medical demand the deterministic
    // engine funds HSA-first against. Absent ⇒ no `isMedical` category.
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
    // The household-spread seam (`targetedOneOffEvents`, sourced from
    // `MonthlyIncomeRow.depositInflow`) ALREADY carries every plain-pension
    // lump-sum's dollars (a targeted lump-sum lands in `depositInflow`). So the
    // unmatched-target fallback is NOT re-appended here (that double-counted the
    // unmatched dollars). `mcInputFromBundle` instead SUBTRACTS the per-account-
    // placed (ledger-matched) plain-pension amounts from this spread — the
    // symmetric mirror of the deterministic `subtractCbpLumpSumsFromHousehold-
    // Deposits(…, plainPensionDeposits)`. Unmatched targets are never subtracted,
    // so they stay in the spread exactly once.
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

/**
 * Walk `accountBundles` once, emitting per-account MC ledger entries +
 * accumulating CBP lump-sum events + portfolio scalars + the blended
 * mix. Extracted from `buildBalanceProjectionMcBundle` (40-ln
 * function cap).
 */
/** Accumulator state mutated as `walkAccountBundle` iterates every
 *  bundle. Held outside the loop so the post-loop blended-mix
 *  finalization (`finalizeBlendedMix`) can read it. */
interface LedgerAccumulator {
  readonly accountMcLedger: AccountMcLedgerEntry[];
  readonly cbpLumpSumEvents: ClassifiedDepositEvent[];
  /** Per-calendar-year rolled-CBP RMD income (dollars). */
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
  /** Per-CBP event-month metadata (absolute month). When a CBP
   *  source has an entry, its lump-sum fires at that month with the
   *  balance compounded forward from today; absent or unspecified
   *  falls back to the retirement-step anchor. */
  cbpLumpSumEventAbsMonth?: ReadonlyMap<string, number>;
  /** Resolved per-account contribution-growth. */
  growthByAccount: ReadonlyMap<string, ResolvedContributionGrowth>;
  /** Resolved per-account floor + HSA mode. */
  floorsByAccount: ReadonlyMap<string, ResolvedAccountFloor>;
  /** Source-CBP owner ISO birthdate keyed by CBP account id. */
  cbpOwnerBirthdateByAccountId?: ReadonlyMap<string, string>;
  /** The run's RMD calibration snapshot. */
  rmdSnapshot?: CalibrationSnapshot<RmdTable>;
}): AccountLedgerAndAggregates {
  const acc = emptyLedgerAccumulator();
  const retirementAbsMonth =
    (args.retirementYear - args.todayYear) * 12 + args.primaryRetirementMonth0;
  // Already-retired clamp + fractional-year exponent — see in-line note
  // history at the original call site.
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

/** Per-bundle body of the ledger walk. Updates `acc` in place; routes
 *  CBP accounts through `applyCbpAccount`, non-CBP through the
 *  standard ledger-entry path. Extracted from
 *  `buildAccountLedgerAndAggregates` (40-ln function cap). */
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
    // Resolve the per-CBP event month from threaded metadata
    // (income stream's `start` anchor). When absent, fall back to the
    // retirement-step anchor (direct-bundle-call back-compat).
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
      // The stored post-tax (Roth-designated) balance share, so a MIXED
      // source CBP carves its RMD only on the pre-tax portion (SECURE 2.0 §325).
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

/** Non-CBP account branch: add to portfolio totals + blended-mix
 *  weighted sums + emit the per-account MC ledger entry. Split from
 *  `walkAccountBundle` (40-ln function cap). */
function appendNonCbpLedgerEntry(args: {
  bundle: BalanceProjectionMcBundleArgs['accountBundles'][number];
  acc: LedgerAccumulator;
  opts: {
    stepCount: number;
    retirementStepIdx: number;
    firstYear: number;
    todayMonthIndex: number;
    contributionGrowth: ResolvedContributionGrowth | undefined;
    /** Resolved floor + HSA mode for this account. */
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

/** Post-loop blended-mix finalization. Derives the household-blended
 *  asset mix from the running weighted sums (or the 70/25/5 default
 *  when no non-CBP balance exists). Split from
 *  `buildAccountLedgerAndAggregates` (40-ln function cap). */
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

/** The Roth-designated (post-tax) portion of a MIXED source CBP's grown
 *  basis, in integer cents. Derived from the stored post-tax balance SHARE
 *  applied to the compounded-forward basis (the share — not the raw stored
 *  post-tax dollars — keeps it consistent with the grown basis). Returns 0
 *  when no positive post-tax balance is recorded (whole basis treated pre-tax).
 *  Mirrors the deterministic `cbpRothPortionCents` so the two engines exclude
 *  the same Roth fraction from the rollover-year RMD. */
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

/** CBP-account branch of the ledger walk. Returns whether this CBP
 *  contributes to `portfolioToday` (and how much). */
function applyCbpAccount(args: {
  account: Aggregate<AccountPayload>;
  latestBalance: number;
  /** Stored post-tax (Roth-designated) balance for a MIXED source CBP. */
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
    // Split (linked-CBP only, SAME pure helper as the deterministic seam →
    // cent-exact parity). The rollover-year RMD is carved out FIRST (taxable
    // ordinary income, distributed) and only the excess rolls to the target.
    const eventCalendarYear = args.firstYear + Math.floor(args.cbpEventMonth / 12);
    const basisCents = Math.round(grown * 100);
    const split =
      args.rmdSnapshot !== undefined
        ? splitRolloverByRmd({
            basisCents,
            ownerBirthdate: args.ownerBirthdate,
            eventYear: eventCalendarYear,
            sourceTaxTreatment: args.account.payload.taxTreatment,
            // A MIXED source CBP carves its RMD only on the pre-tax
            // (non-Roth-designated) portion (SECURE 2.0 §325). Apply the stored
            // post-tax balance share to the grown basis so it stays consistent
            // with the compounded-forward basis.
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
      // Only the EXCESS rolls into the target's pre-tax bucket.
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
    // Lump-sum CBP — balance never compounds inside the MC ledger; it
    // lands as a deposit at retirement on the target account.
    return { skipsPortfolio: true, portfolioDelta: 0 };
  }
  if (election?.kind === 'annuity') {
    // Annuity-elected CBP — excluded; income flows via the linked
    // stream instead.
    return { skipsPortfolio: true, portfolioDelta: 0 };
  }
  // CBP without a resolved election (validation failed / unconfigured):
  // emit a ledger entry that compounds at `planningReturnPct`.
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

/** Distribute targeted events into per-account ledger arrays by
 *  `targetAccountId`. Events without a target or whose target isn't in
 *  the ledger set are left for the runner to apply at the household
 *  level. */
function routeEventsToLedger(args: {
  accountMcLedger: AccountMcLedgerEntry[];
  stepCount: number;
  retirementStepIdx: number;
  cbpLumpSumEvents: ReadonlyArray<ClassifiedDepositEvent>;
  targetedOneOffEvents: ReadonlyArray<ClassifiedDepositEvent>;
  postPrimaryContributionEvents: ReadonlyArray<ClassifiedDepositEvent>;
  /** Plain-pension placement events (carry `accountId`). */
  plainPensionPlacementEvents?: ReadonlyArray<ClassifiedDepositEvent>;
}): void {
  const byId = new Map<string, AccountMcLedgerEntry>();
  for (const entry of args.accountMcLedger) byId.set(entry.id, entry);
  // CBP / one-off events carry no pre/post split — the whole `amount` routes
  // to the summed `deposit` slot (the kernel reads it; the named-strategy path
  // routes it by destination treatment). Post-primary spouse contributions
  // DO carry the split (`amountPre`/`amountPost`): route each slice to the
  // matching split slot AND keep `deposit += amountPre + amountPost` so the
  // summed field the no-ledger kernel path reads stays byte-identical.
  const routeWholeAmount = (list: ReadonlyArray<ClassifiedDepositEvent>): void => {
    for (const ev of list) {
      if (ev.month < 0 || ev.month >= args.stepCount) continue;
      if (!ev.accountId) continue;
      const entry = byId.get(ev.accountId);
      if (!entry) continue;
      if (ev.month < args.retirementStepIdx) {
        // Pre-retirement: accumulation phase. Post-tax bucket (one-off
        // / windfall dollars).
        entry.contribPost[ev.month] += ev.amount;
      } else {
        // Post-retirement: drawdown phase. Targeted deposit slot.
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
      // When no split is set (both fields absent), treat the whole amount
      // as pre-tax to prevent silent dollar-drop. All production callers set the
      // split via buildPostPrimaryContributionEvents; this guards against direct-
      // construction callers that omit the split fields.
      const hasSplit = ev.amountPre !== undefined || ev.amountPost !== undefined;
      const pre = hasSplit ? (ev.amountPre ?? 0) : ev.amount;
      const post = hasSplit ? (ev.amountPost ?? 0) : 0;
      if (ev.month < args.retirementStepIdx) {
        // Pre-retirement: accumulation phase. Post-primary contributions are
        // post-(primary)-retirement by construction, so this branch is not
        // taken in production; route defensively to `contribPost` (mirrors the
        // account-less path) if ever a pre-retirement post-primary event lands.
        entry.contribPost[ev.month] += pre + post;
      } else {
        // Post-retirement: split the targeted deposit by source. `deposit`
        // keeps the summed value (kernel byte-identical); the named-strategy
        // slice consumes the split slots.
        entry.depositPre[ev.month] += pre;
        entry.depositPost[ev.month] += post;
        entry.deposit[ev.month] += pre + post;
      }
    }
  };
  // Ledger-matched plain-pension placements route per-account whole (→
  // destination treatment downstream, the same seam linked-CBP uses). A target
  // absent from the MC ledger is left in the household spread by the caller
  // (`mcInputFromBundle` subtracts only the matched amounts), so it is skipped
  // here — the dollars stay in `targetedOneOffEvents` exactly once.
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
