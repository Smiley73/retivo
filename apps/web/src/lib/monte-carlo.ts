/**
 * Monte Carlo runner — drives N paths through the shared monthly-
 * stepping kernel. Per-step return + CPI drawn from the joined
 * Shiller + Ken French dataset (sampler window 1950-01 onward). Each
 * account independently applies the sampled tuple to its own
 * `assetMix` to compute its monthly return (per-account
 * sampling). CBP planning-rate accounts ignore the tuple and use
 * `monthlyEquivalent(planningReturnPct)` instead. Outputs are
 * aggregated to household-portfolio percentiles (P10/P25/P50) plus
 * depletion-year + ending-balance summary stats.
 *
 * Sibling helpers in `monte-carlo-per-account.ts` carry the per-
 * account input assembly + household-level-event routing.
 *
 * The model is explained in docs/math-projections.md ("The Monte Carlo
 * stress test").
 *
 * SHAPE-LIMIT EXCEPTION (recorded justification; CODING_STANDARDS ≤ 800 lines):
 * this file is over the 800-line limit. Why it cannot be split: it is the
 * math-engine kernel — the per-path monthly-stepping loop plus the tax
 * threading that runs inside it. The remaining loop and tax branch share
 * the per-path state types `PathTaxAcc` / `TaxPathContext` (the in-loop tax
 * accumulator and its enclosing per-path context), so peeling the tax branch
 * into its own module would force re-exporting 3+ internal per-path state types
 * across a hot boundary — a strictly worse seam than the current single file.
 * The clean seams that DON'T touch per-path state are already factored apart
 * from the loop: the per-account input assembly + household-event routing live
 * in `monte-carlo-per-account.ts`; the post-loop result reducers
 * (`assembleMonteCarloSummary` / `depletionYearPercentile`) live in
 * `monte-carlo-summary.ts`, imported back here as an inert import cycle
 * alongside the `monte-carlo-shard.ts` one (every cross-module reference is a
 * call-site binding, never module-eval-time); the per-run step-input assembly
 * lives in `monte-carlo-step-inputs.ts`; and the per-owner RMD math lives in
 * `monte-carlo-rmd.ts`. Design facts that sit inside the in-file seams:
 *  - The representative-run capture helpers (`captureKernelRun` /
 *    `captureStrategyRun` / `assembleRepresentativeByBasis`, plus the
 *    per-account `buildKernelAccountBalances` map builder) read a path's
 *    `StepOutcome` + the per-path `PathTaxAcc`, the exact in-loop state types
 *    that block peeling the loop out; extracting them would force re-exporting
 *    `PathOutcome` / `PathTaxAcc` / `RunContext` across a hot boundary.
 *  - The seed-independent `RunContext` fields (`deterministicCumCpi` /
 *    `baseExpenseYearSums` / `bucketBaseYearSums` / `medicalBucketShiftPct` /
 *    `ledgerTaxMeta` / `survivorStateByYear`) are hoisted out of the per-path
 *    computations onto the one per-run hook (`buildRunContext`).
 *  - This file exports `assembleMonteCarloSummary` + `PathLoopAccumulation` and
 *    imports the path-range loop (`runPathRange` / `mergePathRanges` /
 *    `assembleAccumulationFromTyped`) from `monte-carlo-shard.ts`; `runOnePath`
 *    stays in-file (the sibling imports it back as a value), so no per-path
 *    state type crosses that boundary. `runMonteCarlo` drives the same
 *    two-stage pipeline the sharded coordinator does (serial ≡ 1-shard).
 *  - The per-tax-unit filing-status pass-through (including MFS/QSS) threads
 *    the same per-path `TaxPathContext` / `RunContext` seams.
 *  - The credit applied to premiums rides the same seams: the per-year medical
 *    cap sits on `TaxPathContext` beside `nominalExpenseByYear`, the funded line
 *    accumulates on `PathTaxAcc` and is stamped on the captured rows from there;
 *    the minimum itself lives in `credit-applied-to-premiums.ts`, and so does
 *    the monthly spread of a negative tax draw (proportional to each month's
 *    need) the strategy path folds into the expense slice.
 *  - The taxable-income accumulator (`advanceMcTaxableIncomeState`) runs ONLY in
 *    the representative display post-pass (`monte-carlo-tax-burden.ts`), never
 *    in the funded per-path loop; its math lives in the shared deterministic
 *    helpers, not here.
 * Re-verification mechanism: the MC parity-baseline regression gate
 * (monte-carlo*.test.ts plus the captured BPP parity fixture) pins numeric
 * output, so any future refactor here is checked against a frozen baseline
 * rather than by eye.
 * Trigger: a change adding 5 or more lines here must either refactor the file
 * back under 800 lines or re-justify this exception in this note.
 */
import {
  runStepKernel,
  type KernelAccount,
  type StepInputs,
} from './projection-engine/kernel.js';
import {
  runYearByYearStrategyAware,
  type RunYearByYearArgs,
  type GuardrailRuntimeContext,
} from './drawdown-engine-per-account-strategy.js';
import {
  fundedRatio,
  applyGuardrailStep,
  initGuardrailState,
  type GuardrailConfig,
} from './guardrails.js';
import type {
  DrawdownAccountInput,
  DrawdownInput,
  RmdContextInput,
  QcdContextInput,
} from './drawdown-engine-types.js';
import { isInheritedRmdSubjectType, isQualifyingAccount } from './rmd.js';
import {
  buildMagiCapConfig,
} from './drawdown-engine-per-account-magi-cap.js';
import type { MagiCapWindowRuntime } from './drawdown-engine-per-account-strategy-helpers.js';
import {
  compareMagiCapWindows,
  resolveQcdLimitCentsForYear,
} from './balance-projection-runner-drawdown.js';
import { DEFAULT_INFLATION_PCT } from '../db/types.js';
import {
  advanceAfterTaxBase,
  applyPerYearTaxForPath,
  applyPerYearTaxForPathWithConversion,
  buildKernelWholePortfolioPreTaxByOwner,
  buildPreTaxCentsByOwnerIdx,
  buildPriorPreTaxByOwnerFromIdx,
  buildSurvivorStatesByYear,
  buildYearClassification,
  classifyMcWithdrawal,
  creditMcConversionToBasisCarrier,
  deriveMcSurvivors,
  seedMcAggregateRothBasisCarrier,
  MC_AGGREGATE_ROTH_OWNER_KEY,
  type AfterTaxBaseState,
  type McAccountYearState,
  type McAccountYearWithdrawal,
  type McLedgerTaxMeta,
  // The pooled designated-Roth state + its pro-rata denominator helper.
  seedMcDesignatedRothPool,
  mcDesignatedRothPoolBalanceDollars,
  type McDesignatedRothPool,
  type McSurvivorState,
  type McTaxAccumulators,
  type McTaxYearResult,
} from './monte-carlo-tax.js';
// The shared MC RMD helpers (one `computeRmd` seam for the representative
// display floor AND the funded per-path floor).
import {
  buildMcFactRmdRequiredCentsByOwnerIdx,
  type McRmdBalanceCents,
} from './monte-carlo-rmd.js';
// Re-exported so the unit suite can drive the absorbing prior-base pass.
export { priorYearTaxBases } from './monte-carlo-tax.js';
import type { RothBasisCarrier } from './balance-projection-runner-roth-basis.js';
import type { StepOutcome } from './projection-engine/kernel.js';
import { buildMcFillConversionHook } from './monte-carlo-fill-conversion.js';
import { foldYearDrawIntoExpense, sumPositiveNeed } from './credit-applied-to-premiums.js';
// Sharding: the per-path loop lives in the sibling
// `monte-carlo-shard.ts`, which imports `runOnePath` back as a value. All
// cross-module references are call-site bindings (never module-eval-time), so
// the resulting ESM cycle is inert at runtime.
import {
  runPathRange,
  mergePathRanges,
  assembleAccumulationFromTyped,
} from './monte-carlo-shard.js';
// Post-loop reducer: `assembleMonteCarloSummary` lives in
// the sibling `monte-carlo-summary.ts`, which imports `runOnePath` /
// `buildRunContext` / `seedForPathIndex` / `RunContext` / `PathLoopAccumulation`
// back from THIS file (see the `assembleMonteCarloSummary` import a few lines
// below) — a sanctioned inert 2-node cycle (`.dependency-cruiser.cjs`),
// matching the existing `monte-carlo.ts` <-> `monte-carlo-shard.ts` exception.
import { assembleMonteCarloSummary } from './monte-carlo-summary.js';
// Per-path step-input assembly: the
// `(input, seed, ctx) → BuildStepInputsResult` boundary lives in the sibling
// `monte-carlo-step-inputs.ts`, which imports `RunContext` (type-only, erased at
// compile time) back from THIS file. `buildRunContext` calls `computeYearSums` /
// `cpiShiftMonthlyFor` and `runOnePath` calls `buildStepInputs`, all imported
// back here as values — an inert 2-node cycle (`.dependency-cruiser.cjs`),
// matching the existing shard/summary cycles.
import {
  buildStepInputs,
  computeYearSums,
  cpiShiftMonthlyFor,
} from './monte-carlo-step-inputs.js';
export type { McTaxContext } from './monte-carlo-tax.js';
export type {
  MonteCarloAccountLedger,
  MonteCarloInput,
  McRmdContext,
  McQcdContext,
  MonteCarloSummary,
  McBasis,
  RepresentativeRun,
} from './monte-carlo-types.js';
import type {
  MonteCarloInput,
  MonteCarloSummary,
  RepresentativeRun,
} from './monte-carlo-types.js';
import type { FilingUnitMagi } from './tax-integration.js';
import { allocateCentsByWeight } from './tax-integration.js';
import type { DrawdownYear, DrawdownAccountYear } from './drawdown-engine-types.js';

/** ENGINE_VERSION — the version stamp on every saved Monte Carlo result. Bump
 *  it with any change that affects the math; output that stays byte-identical
 *  means no bump, and the frozen parity fixtures prove which case applies. A
 *  cached summary carrying a lower version is recomputed when it is read.
 *
 *  The number is pinned by `cross-engine-pin.test.ts` and
 *  `db/monte-carlo-cache.test.ts`. The "ENGINE_VERSION bump — required
 *  companion edits" checklist in AGENTS.md lists everything a bump has to
 *  update. docs/math-projections.md, under "The Monte Carlo stress test",
 *  explains the version for readers.
 */
export const ENGINE_VERSION = 73;

/* ---------- engine ---------- */

export interface PathOutcome {
  readonly balanceByYearNominal: number[];
  readonly balanceByYearReal: number[];
  readonly depletionYear: number | null;
  readonly endingBalanceNominal: number;
  readonly endingBalanceReal: number;
  /** Per-year federal tax in dollars. Defined when taxContext present. */
  readonly federalTaxByYear?: number[];
  /** Per-year IRMAA surcharge in dollars. Defined when taxContext present. */
  readonly irmaaSurchargeByYear?: number[];
  /** Per-year ACA PTC subsidy in dollars. Defined when taxContext present. */
  readonly acaPtcSubsidyByYear?: number[];
  /** Per-year ACA credit applied to premiums (the part that lowered the year's
   *  draw), dollars. Defined when taxContext present. */
  readonly acaCreditAppliedToPremiumsByYear?: number[];
  /** Per-year effective tax rate (0..1). Defined when taxContext present. */
  readonly effectiveTaxRateByYear?: number[];
  /** Per-year net-after-tax withdrawal in dollars. Defined when taxContext present. */
  readonly netAfterTaxByYear?: number[];
  /**
   * Full per-year representative-run capture. Populated ONLY when the
   * path is replayed under `captureRun` (the P10/P25/P50 seed replays in
   * `assembleMonteCarloSummary`); `undefined` on the hot per-path sweep so
   * the 10 000-path loop allocates nothing extra. Carries the
   * `DrawdownByMethodResult`-shaped run (nominal `years` + `depletionYear` +
   * `perMonthWithdrawal`) plus the path's own-CPI real per-year balance /
   * growth. `seed` is filled by the caller from the path index.
   */
  readonly representative?: Omit<RepresentativeRun, 'seed'>;
}

/** Seed-independent, per-run derived values shared across all paths of a single
 *  `runMonteCarlo` call (computed once in `runOnePath`'s caller). `legacyZero` is
 *  a read-only zero `Float64Array(stepCount)` that backs the kernel's unused
 *  single-pool placeholder inputs (`mainReturnPct`/`contribPre`/`contribPost`);
 *  both kernel branches READ these and never WRITE them, so a shared instance is
 *  safe. `cpiShiftMonthly` is the seed-independent CPI bootstrap centering shift.
 *
 *  The remaining fields are all pure functions of `input`, hoisted out of the
 *  per-path `buildHouseholdSeries` / `newTaxPathState` computations that would
 *  otherwise rebuild them 10,000× a run: `deterministicCumCpi` (the
 *  scenario-flat cumulative CPI series), `baseExpenseYearSums`/`bucketBaseYearSums`
 *  (the seed-independent year-sum half of the year-END nominal-expense product),
 *  `medicalBucketShiftPct` (the per-bucket medical-demand mean-shift),
 *  `ledgerTaxMeta` (fixed-order per-account tax metadata), and
 *  `survivorStateByYear` (precomputed per-year survivor state, `null` when
 *  no `taxContext`). */
export interface RunContext {
  readonly stepCount: number;
  readonly legacyZero: Float64Array;
  readonly cpiShiftMonthly: number;
  readonly deterministicCumCpi: Float64Array;
  readonly baseExpenseYearSums: Float64Array;
  readonly bucketBaseYearSums: Float64Array[] | null;
  readonly medicalBucketShiftPct: number[] | null;
  readonly ledgerTaxMeta: McLedgerTaxMeta[];
  readonly survivorStateByYear: ReadonlyArray<McSurvivorState | null> | null;
}

/** Compute the per-run shared context once. The legacy-zero array is only shared
 *  when the per-account branch will run (`accountMcLedger.length > 0`); for an
 *  empty ledger the single-pool branch reads these inputs, so — out of an
 *  abundance of caution, matching the all-zero status quo either way — a fresh
 *  zero array is allocated per path in that case (see `assembleStepInputs`). */
export function buildRunContext(input: MonteCarloInput): RunContext {
  const horizonYears = input.horizonYear - input.firstYear + 1;
  const stepCount = horizonYears * 12;
  const legacyZero =
    input.accountMcLedger.length > 0
      ? new Float64Array(stepCount)
      : new Float64Array(0);

  // The deterministic (scenario-flat) cumulative CPI series is a pure
  // function of `scenarioInflationPct` — identical for every path — so it is
  // built ONCE here instead of once per path.
  const scenarioMonthlyInflation =
    (input.scenarioInflationPct ?? DEFAULT_INFLATION_PCT) / 100 / 12;
  const deterministicCumCpi = new Float64Array(stepCount);
  let detCum = 1;
  for (let i = 0; i < stepCount; i += 1) {
    detCum *= 1 + scenarioMonthlyInflation;
    deterministicCumCpi[i] = detCum;
  }

  // Seed-independent year-sums of the today's-dollar expense base(s).
  const baseExpenseYearSums = computeYearSums(input.monthlyExpenseBase, stepCount, horizonYears);
  const bucketBaseYearSums = input.monthlyExpenseBucketsBase
    ? input.monthlyExpenseBucketsBase.map((b) => computeYearSums(b.amount, stepCount, horizonYears))
    : null;

  // The per-bucket medical-demand mean-shift is a pure function of
  // `input` — hoisted out of the per-step medical-demand loop instead of being
  // recomputed every step, every path.
  const generalRatePct = input.scenarioInflationPct ?? DEFAULT_INFLATION_PCT;
  const medicalBucketShiftPct = input.monthlyMedicalDemandBucketsBase
    ? input.monthlyMedicalDemandBucketsBase.map((b) => (b.ratePct - generalRatePct) / 12)
    : null;

  // Precompute per-year survivor state once when a taxContext is present.
  const survivorStateByYear = input.taxContext
    ? buildSurvivorStatesByYear(input.taxContext, input.firstYear, horizonYears, input.retirementYear)
    : null;

  return {
    stepCount,
    legacyZero,
    cpiShiftMonthly: cpiShiftMonthlyFor(input),
    deterministicCumCpi,
    baseExpenseYearSums,
    bucketBaseYearSums,
    medicalBucketShiftPct,
    ledgerTaxMeta: ledgerTaxMeta(input),
    survivorStateByYear,
  };
}

/** Per-path tax accumulators (display bands) + the running after-tax draw. */
interface PathTaxAcc {
  fedTax: number[];
  irmaa: number[];
  ptc: number[];
  /** ACA credit applied to premiums, dollars. */
  credit: number[];
  etr: number[];
  net: number[];
}

function newPathTaxAcc(horizonYears: number): PathTaxAcc {
  return {
    fedTax: new Array<number>(horizonYears).fill(0),
    irmaa: new Array<number>(horizonYears).fill(0),
    ptc: new Array<number>(horizonYears).fill(0),
    credit: new Array<number>(horizonYears).fill(0),
    etr: new Array<number>(horizonYears).fill(0),
    net: new Array<number>(horizonYears).fill(0),
  };
}

/** Zero the per-path display accumulators in place between passes (the
 *  strategy-path two-pass reuses one `PathTaxAcc` across both tax fills). */
function resetPathTaxAcc(acc: PathTaxAcc): void {
  acc.fedTax.fill(0);
  acc.irmaa.fill(0);
  acc.ptc.fill(0);
  acc.credit.fill(0);
  acc.etr.fill(0);
  acc.net.fill(0);
}

/** Ledger tax metadata in fixed array order — built once per run, reused for
 *  every path (seed-independent). Pre-resolves each account's
 *  scenario penalty exemption (id ∈ `earlyWithdrawalPenaltyExemptAccountIds`)
 *  so the classifier can accumulate per-source penalty-exempt dollars. */
function ledgerTaxMeta(input: MonteCarloInput): McLedgerTaxMeta[] {
  const exemptIds = new Set(
    input.taxContext?.earlyWithdrawalPenaltyExemptAccountIds ?? [],
  );
  const rmdFacts = input.mcRmdContext?.rmdFactsByAccountId;
  return input.accountMcLedger.map((e) => ({
    taxTreatment: e.taxTreatment,
    accountType: e.accountType,
    ...(exemptIds.has(e.id) ? { scenarioPenaltyExempt: true } : {}),
    // §72(t)(2)(A)(ii): a distribution from an INHERITED account is made on
    // account of the original owner's death and carries no 10% additional tax at
    // any beneficiary age. Pre-resolved per source here so the pooled MC penalty
    // leg excludes exactly those dollars.
    ...(rmdFacts?.[e.id]?.inheritedAccount === true
      ? { deathExemptInherited: true }
      : {}),
  }));
}

/** Sum each account's withdrawal across year `y`'s 12 steps + read its
 *  start-of-year pre/post buckets from the prior year-end (or initial buckets
 *  for y=0). Returns `undefined` when the kernel ran the single-pool branch
 *  (no per-account arrays) → all-pre-tax fallback.
 *
 *  Exported for unit testing the y=0-vs-y>0 start-of-year-bucket boundary
 *  — not part of the module's public runner API. */
export function accountYearStates(
  input: MonteCarloInput,
  out: StepOutcome,
  y: number,
  stepCount: number,
): McAccountYearState[] | undefined {
  const accW = out.accountWithdrawal;
  const accPre = out.accountPreEnd;
  const accPost = out.accountPostEnd;
  if (!accW || !accPre || !accPost) return undefined;
  const firstStep = y * 12;
  const lastStep = Math.min(stepCount - 1, (y + 1) * 12 - 1);
  const priorStep = firstStep - 1; // year start = prior year-end.
  return input.accountMcLedger.map((entry, a) => {
    let withdrawalDollars = 0;
    for (let s = firstStep; s <= lastStep; s += 1) withdrawalDollars += accW[a][s];
    const preBalanceStartDollars =
      priorStep >= 0 ? accPre[a][priorStep] : entry.initialPre;
    const postBalanceStartDollars =
      priorStep >= 0 ? accPost[a][priorStep] : entry.initialPost;
    return { withdrawalDollars, preBalanceStartDollars, postBalanceStartDollars };
  });
}

export interface TaxPathContext {
  readonly input: MonteCarloInput;
  /** The kernel `StepOutcome`, or `null` on the strategy path when the kernel
   *  was SKIPPED (already-retired, `retStart === 0`) OR when it
   *  ran truncated (drawdown-phase output discarded). Read ONLY by
   *  `applyTaxForYear` → `accountYearStates`, which runs exclusively on the
   *  no-ledger kernel path (`runOnePathKernel` / `fillYearBalancesAndTax`)
   *  where `out` is always the full non-null kernel outcome; the strategy path
   *  never dereferences it (`fillStrategyYearTax` does not read `.out`). The
   *  reader guards with a hard throw against a null. */
  readonly out: StepOutcome | null;
  readonly stepCount: number;
  readonly meta: McLedgerTaxMeta[];
  readonly acc: PathTaxAcc;
  /** Per-year same-year tax cashflow (nominal dollars) subtracted from balances;
   *  negative when the credit applied to premiums exceeds the tax need. */
  readonly taxDrawByYear: number[];
  /** This path's cumulative §408A Roth basis carrier, seeded
   *  fresh per path under the single aggregate key from the SUMMED household
   *  `taxContext.rothBasisCentsByOwner`. */
  readonly rothBasisCarrier: RothBasisCarrier;
  /** This path's pooled designated-Roth state (§402A(d)(4) pro rata against
   *  REMAINING basis + the pooled in-plan-rollover recapture lots), seeded fresh
   *  per path. Mutable object (not reassigned) so the pass-2 reseed can restore it
   *  in place. `null` when the household records no designated-Roth facts. */
  designatedRothPool: McDesignatedRothPool | null;
  /** Per-year windowed nominal expense at the year-END step. The per-year tax
   *  fallback drawdown + `netAfterTax` display read `nominalExpenseByYear[y]` so
   *  the tax path stays consistent with the windowed expense DRAW. */
  readonly nominalExpenseByYear: Float64Array;
  /** Per-year modeled Medical expenses at the year-END step (every `isMedical`
   *  row, before any guardrail scaling or tax fold): the cap on the ACA credit
   *  applied to premiums. */
  readonly nominalMedicalExpenseByYear: Float64Array;
  /** Per-year draw need before any tax is folded in (the sum of the positive
   *  monthly needs the strategy engine draws), indexed like `taxDrawByYear`: the
   *  cap on the credit applied to premiums. Absent on the no-ledger kernel path,
   *  where the year's net expense stands in. */
  readonly drawNeedByYear?: Float64Array;
  /** The run's precomputed per-year survivor state (from
   *  `RunContext.survivorStateByYear`), `null` when no `taxContext` was
   *  supplied for the run. Index = year offset from `firstYear`. */
  readonly survivorStateByYear: ReadonlyArray<McSurvivorState | null> | null;
}

/** Per-year MAGI ring-buffer state for the IRMAA 2-year look-back. */
interface MagiRing {
  minus2: number | undefined;
  minus1: number | undefined;
  /** The same two look-back years PER TAX UNIT: one entry per return
   *  filed that year, so each of the surcharge year's returns is tiered on its
   *  OWN look-back MAGI and its OWN schedule (a mixed `MFS`+`HoH` couple does
   *  not share one ladder, and a survivor is tiered on the joint return
   *  they actually filed rather than the merged two-return household MAGI). */
  unitsMinus2: readonly FilingUnitMagi[] | undefined;
  unitsMinus1: readonly FilingUnitMagi[] | undefined;
}

/** Run the per-year tax estimate + record the same-year tax cashflow. Mutates
 *  `ctx.acc` / `ctx.taxDrawByYear` and advances the MAGI ring. Extracted from
 *  `runOnePath` for the per-function cap. */
function applyTaxForYear(
  ctx: TaxPathContext,
  y: number,
  _endStep: number,
  priorBalance: number,
  magi: MagiRing,
): void {
  const { input, out } = ctx;
  // `TaxPathContext.out` is nullable because the strategy path
  // may skip/truncate the kernel and store `null`. This reader runs ONLY on the
  // no-ledger kernel path, where `out` is always the full kernel outcome — throw
  // loudly rather than silently substitute if that invariant is ever violated.
  if (out === null) throw new Error('taxState.out required on the kernel path');
  const classification = buildYearClassification(
    ctx.meta,
    accountYearStates(input, out, y, ctx.stepCount),
  );
  // The no-ledger kernel fallback has no per-account split, so it keeps the
  // documented whole-portfolio approximation — assign the whole prior balance to
  // the single survivor whose age yields the largest floor (reproduces the
  // MAX-over-survivors synthetic floor through the per-owner `computeMcRmdFloorCents`).
  const taxYear = input.firstYear + y;
  // Use the precomputed per-run survivor state when
  // present (never `?.[y]` chained into `.survivors` — an out-of-bounds `y`
  // would throw `undefined.survivors` — and never `??`-masked, which would
  // silently re-derive a legitimately precomputed `null` "nobody alive"
  // year); absent → derive in-function.
  const survivorState = ctx.survivorStateByYear
    ? ctx.survivorStateByYear[y]
    : deriveMcSurvivors(input.taxContext!, taxYear, input.retirementYear);
  const priorPreTaxByOwner =
    survivorState === null
      ? new Map<string, number>()
      : buildKernelWholePortfolioPreTaxByOwner(
          survivorState.survivors,
          priorBalance,
          taxYear,
          input.taxContext!.taxBundle.rmd,
        );
  const taxResult = applyPerYearTaxForPath({
    taxCtx: input.taxContext!,
    taxYear,
    retirementYear: input.retirementYear,
    grossSsDollars: input.ssByYear[y] ?? 0,
    // The windowed nominal expense at this year-END step.
    nominalExpense: ctx.nominalExpenseByYear[y] ?? 0,
    medicalExpenseDollars: ctx.nominalMedicalExpenseByYear[y] ?? 0,
    otherIncome: input.incomeByYear[y] ?? 0,
    priorBalance,
    priorPreTaxByOwner,
    magiMinus2: magi.minus2,
    irmaaLookbackUnitsMinus2: magi.unitsMinus2,
    classification,
    // NOTE: the taxable-income yield / evolving-basis / cash-interest inputs are
    // deliberately NOT threaded into the FUNDED per-path tax (see the
    // fillStrategyYearTax note — the deterministic funding solver keeps the same
    // documented pre-commit approximation, preserving the cross-engine
    // funded-balance parity).
    rothBasisCarrier: ctx.rothBasisCarrier,
    // The pooled designated-Roth state. The no-ledger kernel fallback has no
    // per-account balances, so no year balance is supplied — the pool falls back to
    // its own running balance for the pro-rata denominator.
    ...(ctx.designatedRothPool !== null
      ? { designatedRothPool: ctx.designatedRothPool }
      : {}),
    // Reuse the `survivorState` already resolved above (object
    // or precomputed null) so the tri-state check inside
    // `applyPerYearTaxForPathWithConversion` never re-derives it — mirrors
    // the `fillStrategyYearTax` call site's `survivorState` threading.
    survivorState,
  });
  if (taxResult === null) return;
  accumulatePerYearTaxResult(ctx.acc, ctx.taxDrawByYear, y, taxResult, magi);
}

/** Shared per-year tax-accumulation tail: stamp the display accumulators +
 *  same-year tax draw at index `y` and advance the IRMAA MAGI ring. Used by
 *  BOTH the kernel `applyTaxForYear` and the strategy-path tax fill
 *  (`fillStrategyYearTax`) so the index-stamp + ring advance never diverge. */
function accumulatePerYearTaxResult(
  acc: PathTaxAcc,
  taxDrawByYear: number[],
  y: number,
  taxResult: McTaxYearResult,
  magi: MagiRing,
  // The MAGI value to advance the IRMAA look-back ring with. Defaults to
  // the funded result's MAGI; the Fill strategy path overrides it with the
  // conversion-INCLUSIVE MAGI so a conversion's Y+2 surcharge is funded even
  // though the year's FUNDED tax excludes that same conversion (the engine funds
  // it separately, drawdown-engine-roth-conversion.ts).
  magiForRingDollars: number = taxResult.magiDollars,
): void {
  acc.fedTax[y] = taxResult.fedTax;
  acc.irmaa[y] = taxResult.irmaa;
  acc.ptc[y] = taxResult.ptc;
  acc.credit[y] = taxResult.acaCreditAppliedToPremiums;
  acc.etr[y] = taxResult.effectiveTaxRate;
  acc.net[y] = taxResult.netAfterTax;
  taxDrawByYear[y] = taxResult.taxCashflowDollars;
  magi.minus2 = magi.minus1;
  magi.minus1 = magiForRingDollars;
  magi.unitsMinus2 = magi.unitsMinus1;
  // The per-return ring must carry the SAME total the scalar ring
  // carries. On the Fill path `magiForRingDollars` is the conversion-INCLUSIVE
  // MAGI while the per-unit figures come from the conversion-EXCLUSIVE funded
  // result, so rescale them onto the ring total (the conversion is a
  // household-level income event with no per-return attribution in MC).
  magi.unitsMinus1 = rescaleUnitMagiToTotal(taxResult.filingUnitMagi, magiForRingDollars);
}

/**
 * Rescale a year's per-return MAGI entries so they sum to `totalDollars`,
 * preserving each return's share. A zero-MAGI year with entries splits
 * the total evenly; no entries yields none.
 *
 * The split is EXACT to the cent. Rounding each return independently let
 * two equal returns of an odd-cent total both round up, putting the per-return
 * ring one cent above the household scalar ring it is supposed to reconcile
 * with. Two years later that ring IS the IRMAA look-back, and a single cent
 * across a tier threshold moves the household onto a higher Medicare surcharge
 * for the whole year, so the leftover cents are distributed by largest remainder
 * instead (`allocateCentsByWeight`).
 *
 * Exported for the conservation + IRMAA-boundary regression tests; the ring
 * advance is the only production caller.
 */
export function rescaleUnitMagiToTotal(
  units: readonly FilingUnitMagi[],
  totalDollars: number,
): readonly FilingUnitMagi[] {
  if (units.length === 0) return units;
  const targetCents = Math.round(totalDollars * 100);
  const currentCents = units.reduce((sum, u) => sum + u.magiCents, 0);
  if (currentCents === targetCents) return units;
  // One return takes the whole total by definition. Short-circuited because this
  // runs in the per-path hot loop and single-return years are the common case.
  if (units.length === 1) return [{ ...units[0], magiCents: targetCents }];
  // A non-positive current total carries no usable shares, so the weights fall
  // back to an equal split — which `allocateCentsByWeight` also conserves exactly.
  const weights = units.map((u) => (currentCents > 0 ? u.magiCents : 1));
  const rescaled = allocateCentsByWeight(targetCents, weights);
  return units.map((u, index) => ({ ...u, magiCents: rescaled[index] }));
}

/** Subtract the cumulative same-year tax cashflow from each year's pre-tax
 *  balance. Tax is funded the year it is owed, so each year's balance is
 *  reduced by all tax drawn through that year. Cumulative nominal subtraction
 *  (no re-grown foregone return) is the deterministic, conservative-enough
 *  proxy for re-running the kernel per path. Recomputes the after-tax depletion
 *  year: the first drawdown year whose after-tax balance is ≤ 0. After-tax
 *  depletion is absorbing — once a year goes to zero, every later year is
 *  forced to zero too (a subsequent good-market year cannot revive a depleted
 *  after-tax portfolio), mirroring the kernel's absorbing pre-tax depletion.
 *
 *  Exported for unit testing the absorbing-zeroing branch + the
 *  min(preTax, afterTax) depletion-year reconciliation — not part of
 *  the module's public runner API. */
export function applyAfterTaxAdjustment(
  balanceNominal: number[],
  balanceReal: number[],
  taxDrawByYear: number[],
  out: StepOutcome,
  firstYear: number,
  stepCount: number,
  preTaxDepletionYear: number | null,
): number | null {
  const horizonYears = balanceNominal.length;
  let cumTax = 0;
  let afterTaxDepletionYear: number | null = null;
  for (let y = 0; y < horizonYears; y += 1) {
    cumTax += taxDrawByYear[y];
    const endStep = Math.min(stepCount - 1, (y + 1) * 12 - 1);
    // Absorbing: once depleted, every later year stays at zero regardless of
    // whether that year's own (balance − cumTax) would be positive.
    if (afterTaxDepletionYear !== null) {
      balanceNominal[y] = 0;
      balanceReal[y] = 0;
      continue;
    }
    if (cumTax <= 0) continue;
    const adjustedNominal = Math.max(0, balanceNominal[y] - cumTax);
    if (adjustedNominal <= 0 && balanceNominal[y] > 0) {
      afterTaxDepletionYear = firstYear + y;
    }
    balanceNominal[y] = adjustedNominal;
    balanceReal[y] = adjustedNominal / out.cumCpi[endStep];
  }
  // After-tax depletion can only be the same or earlier than pre-tax.
  if (preTaxDepletionYear === null) return afterTaxDepletionYear;
  if (afterTaxDepletionYear === null) return preTaxDepletionYear;
  return Math.min(preTaxDepletionYear, afterTaxDepletionYear);
}

/** Build the per-path tax state (display accumulators + tax-draw array +
 *  fixed-order ledger metadata) when a taxContext is present, else null.
 *  Exported for unit testing — not part of the public runner API. */
export function newTaxPathState(
  input: MonteCarloInput,
  // Nullable — the strategy path passes the possibly-`null`
  // `kernelOut` (skipped/truncated kernel). It is stored as-is and never read
  // on the strategy path; the no-ledger kernel path always passes a full
  // non-null `StepOutcome`.
  out: StepOutcome | null,
  stepCount: number,
  horizonYears: number,
  // The per-year windowed nominal expense
  // at the year-END step from `buildStepInputs` (always supplied).
  nominalExpenseByYear: Float64Array,
  // The per-year modeled Medical expenses at the year-END step from
  // `buildStepInputs` (the cap on the credit applied to premiums).
  nominalMedicalExpenseByYear: Float64Array,
  // The per-run context — supplies the fixed-order ledger tax
  // metadata + the precomputed per-year survivor state, both hoisted out of
  // the per-path build.
  ctx: RunContext,
  // The per-year pre-fold draw need (strategy path only).
  drawNeedByYear?: Float64Array,
): TaxPathContext | null {
  if (input.taxContext === undefined) return null;
  return {
    input,
    out,
    stepCount,
    meta: ctx.ledgerTaxMeta,
    acc: newPathTaxAcc(horizonYears),
    taxDrawByYear: new Array<number>(horizonYears).fill(0),
    rothBasisCarrier: seedMcAggregateRothBasisCarrier(
      input.taxContext.rothBasisCentsByOwner,
      // The aggregate carrier also carries the household's recorded conversion
      // lots, so the MC pool runs the real §408A order (lots FIFO with their own
      // five-tax-year recapture clocks), not one contribution-first bucket.
      input.taxContext.rothOrderedProfile,
    ),
    // The designated-Roth slice runs the SAME stateful engine the
    // deterministic per-account path runs, against one pooled synthetic account,
    // so the pool's LIFETIME basis shelter is capped at the recorded basis.
    designatedRothPool:
      seedMcDesignatedRothPool(input.taxContext.rothOrderedProfile) ?? null,
    nominalExpenseByYear,
    nominalMedicalExpenseByYear,
    ...(drawNeedByYear !== undefined ? { drawNeedByYear } : {}),
    survivorStateByYear: ctx.survivorStateByYear,
  };
}

/** Fill the per-year nominal/real balance arrays + (when a taxContext is
 *  present) run the per-year tax estimate. Single-pass forward: the
 *  synthetic RMD account's prior-year base is the prior year's after-tax balance,
 *  tracked incrementally (O(horizon)) and ABSORBING (`advanceAfterTaxBase`) so a
 *  raw pre-tax recovery never revives a depleted base — consistent with
 *  the absorbing depletion design. Still no within-year fixpoint.
 *
 *  Exported for unit testing — not part of the public runner API. */
export function fillYearBalancesAndTax(
  out: StepOutcome,
  balanceByYearNominal: number[],
  balanceByYearReal: number[],
  stepCount: number,
  taxState: TaxPathContext | null,
): void {
  const horizonYears = balanceByYearNominal.length;
  // Seed the IRMAA look-back ring from the threaded MAGI bootstrap so
  // projection year 0 (consumes `minus2` = MAGI(ret−2)) and year 1 (consumes
  // `minus1` = MAGI(ret−1)) charge IRMAA in agreement with the deterministic
  // engine. When no bootstrap is threaded both slots stay `undefined` and MC
  // charges $0 IRMAA for years 0–1 (the deterministic engine's projected-MAGI
  // estimate is NOT mirrored into the kernel here).
  const magi: MagiRing = {
    minus2: taxState?.input.taxContext?.magiBootstrapLookbackMinus2,
    minus1: taxState?.input.taxContext?.magiBootstrapLookbackMinus1,
    // The two pre-projection bootstrap years carry a household MAGI only
    // (no stored per-return breakdown), so the ring starts empty and every unit
    // falls back to that scalar until the projection has filed two of its own
    // years.
    unitsMinus2: undefined,
    unitsMinus1: undefined,
  };
  let cumTax = 0;
  let baseState: AfterTaxBaseState = { base: 0, depleted: false };
  for (let y = 0; y < horizonYears; y += 1) {
    const endStep = Math.min(stepCount - 1, (y + 1) * 12 - 1);
    const nominal = out.preEnd[endStep] + out.postEnd[endStep];
    balanceByYearNominal[y] = nominal;
    balanceByYearReal[y] = nominal / out.cumCpi[endStep];
    if (!taxState) continue;
    // Year-0 RMD base is today's portfolio, not the year-end balance that
    // hasn't been computed yet. Matches the deterministic engine's prior-year-balance rule.
    // y>0 → the absorbing after-tax balance carried forward.
    const priorBalance = y === 0 ? taxState.input.portfolioToday : baseState.base;
    applyTaxForYear(taxState, y, endStep, priorBalance, magi);
    // Advance after this year's draw is populated so the running after-tax base
    // (the NEXT year's prior base) reflects tax through the just-finished year.
    cumTax += taxState.taxDrawByYear[y];
    baseState = advanceAfterTaxBase(baseState, nominal, cumTax);
  }
}

/* ---------- Representative-run full capture ---------- */

/** Build the per-account `DrawdownYear.accountBalances` map for one
 *  drawdown-phase kernel year. Reads the per-account year-end pre/post
 *  sub-bucket balances + per-account withdrawal the kernel already computed
 *  (`accountPreEnd` / `accountPostEnd` / `accountWithdrawal`) — the same data
 *  the 10 000-path hot loop discards — into the SAME `DrawdownAccountYear`
 *  shape the strategy engine emits, so the Account Balance Stack + RMD post-
 *  pass consume both engine paths through one contract. `preEnd` is
 *  the pre-tax sub-bucket end balance, `postEnd` the post-tax/Roth sub-bucket
 *  end balance; `withdrawn` is the account's whole-year withdrawal. The kernel
 *  path also surfaces the per-account pre/post withdrawal split
 *  (`accountPreWithdrawn` / `accountPostWithdrawn`) so `preWithdrawnCents`
 *  is populated on kernel rows — the RMD shortfall derivation uses the
 *  exact pre-tax tranche for MIXED accounts. Returns `undefined` when
 *  the kernel ran the single-pool branch (no per-account arrays). */
function buildKernelAccountBalances(
  input: MonteCarloInput,
  out: StepOutcome,
  y: number,
  endStep: number,
  stepCount: number,
): ReadonlyMap<string, DrawdownAccountYear> | undefined {
  const accPre = out.accountPreEnd;
  const accPost = out.accountPostEnd;
  const accW = out.accountWithdrawal;
  if (!accPre || !accPost || !accW) return undefined;
  // Per-account medical-qualified HSA dollars from the kernel's
  // medical-first pass, so the MC representative row carries the
  // same medical/emergency split the deterministic path does.
  const accMed = out.accountMedicalQualifiedWithdrawal;
  // The per-account pre/post withdrawal split is threaded through the
  // kernel output so MIXED accounts' shortfall derivation is exact, not the
  // total-`withdrawn` proxy.
  const accPreW = out.accountPreWithdrawn;
  const accPostW = out.accountPostWithdrawn;
  const firstStep = y * 12;
  const lastStep = Math.min(stepCount - 1, endStep);
  const map = new Map<string, DrawdownAccountYear>();
  input.accountMcLedger.forEach((entry, a) => {
    let withdrawn = 0;
    let medical = 0;
    let preWithdrawnSum = 0;
    let postWithdrawnSum = 0;
    for (let s = firstStep; s <= lastStep; s += 1) {
      withdrawn += accW[a][s];
      medical += accMed?.[a]?.[s] ?? 0;
      preWithdrawnSum += accPreW?.[a]?.[s] ?? 0;
      postWithdrawnSum += accPostW?.[a]?.[s] ?? 0;
    }
    const preEnd = accPre[a][endStep];
    const postEnd = accPost[a][endStep];
    const priorEndStep = endStep - 12;
    const priorPreEnd =
      priorEndStep >= 0 ? (accPre[a][priorEndStep] ?? entry.initialPre) : entry.initialPre;
    // Cap medical-qualified cents at the committed withdrawal cents so the
    // emergency residual stays ≥ 0 and the buckets reconcile to the cent.
    const withdrawnCents = Math.round(withdrawn * 100);
    const medicalCents = entry.accountType === 'HSA' && medical > 0
      ? Math.min(withdrawnCents, Math.round(medical * 100))
      : 0;
    // Populate the pre/post split when the kernel surfaced it.
    // `accPreW` is non-null iff the per-account branch ran (same condition as
    // `accW`). Mirrors `buildAccountBalanceMap` (drawdown-engine-per-account.ts).
    const hasSplit = accPreW != null;
    const preWithdrawnCents = hasSplit ? Math.round(preWithdrawnSum * 100) : undefined;
    const postWithdrawnCents = hasSplit ? Math.round(postWithdrawnSum * 100) : undefined;
    map.set(entry.id, {
      balance: preEnd + postEnd,
      preEnd,
      postEnd,
      withdrawn,
      deposit: 0,
      priorPreEnd,
      ...(preWithdrawnCents !== undefined ? { preWithdrawnCents, postWithdrawnCents } : {}),
      ...(medicalCents > 0 ? { medicalQualifiedWithdrawnCents: medicalCents } : {}),
    });
  });
  return map;
}

/** Build the per-account year-end stacking balances for ONE pre-retirement
 *  (accumulation) kernel year. Reads the kernel's already-computed
 *  per-account year-end pre/post sub-bucket arrays (`accountPreEnd` /
 *  `accountPostEnd`) — the same data the hot loop discards — into the
 *  `DrawdownAccountYear` shape with STACKING FIELDS ONLY (`balance` / `preEnd`
 *  / `postEnd`; `withdrawn` / `deposit` are 0; no tax / RMD / conversion cents).
 *  Used to populate `RepresentativeRun.accumulationAccountBalances`; the
 *  `years[]` accumulation rows are left untouched (no `accountBalances`), so the
 *  phase discriminator stays valid. Returns `undefined` when the kernel ran the
 *  single-pool branch (no per-account arrays). */
function buildKernelAccumulationBalances(
  input: MonteCarloInput,
  out: StepOutcome,
  endStep: number,
): ReadonlyMap<string, DrawdownAccountYear> | undefined {
  const accPre = out.accountPreEnd;
  const accPost = out.accountPostEnd;
  if (!accPre || !accPost) return undefined;
  const map = new Map<string, DrawdownAccountYear>();
  input.accountMcLedger.forEach((entry, a) => {
    const preEnd = accPre[a][endStep];
    const postEnd = accPost[a][endStep];
    map.set(entry.id, {
      balance: preEnd + postEnd,
      preEnd,
      postEnd,
      withdrawn: 0,
      deposit: 0,
    });
  });
  return map;
}

/** Build a full per-year `DrawdownYear[]` + the path's own-CPI real balance /
 *  growth from a kernel `StepOutcome` (no-ledger kernel path). Mirrors
 *  the deterministic `drawdown-engine.ts` per-year roll-up: balance is the
 *  year-end pre+post pool, `withdrawn` / `growth` / `deposit` sum the 12 steps,
 *  `netNeed = max(0, expense − income)`, `depleted` from `depletionStepIdx`.
 *  Real deflation uses the path's sampled `out.cumCpi` (NOT the scenario
 *  deflator). Tax cents come from the per-path tax accumulator (dollars →
 *  cents) when present. */
function captureKernelRun(
  input: MonteCarloInput,
  out: StepOutcome,
  stepCount: number,
  taxAcc: PathTaxAcc | null,
  retStart: number,
): Omit<RepresentativeRun, 'seed'> {
  const horizonYears = input.horizonYear - input.firstYear + 1;
  const years: DrawdownYear[] = new Array(horizonYears);
  const realBalanceByYear: number[] = new Array(horizonYears).fill(0);
  const realGrowthByYear: number[] = new Array(horizonYears).fill(0);
  const realFactorByYear: number[] = new Array(horizonYears).fill(0);
  // Per-account accumulation balances captured into the SEPARATE additive
  // field (NOT onto `years[]`), so the phase discriminator stays valid.
  const accumulationAccountBalances: {
    year: number;
    accountBalances: ReadonlyMap<string, DrawdownAccountYear>;
  }[] = [];
  for (let y = 0; y < horizonYears; y += 1) {
    let growth = 0;
    let withdrawn = 0;
    let expense = 0;
    let income = 0;
    let deposit = 0;
    for (let m = 0; m < 12; m += 1) {
      const i = y * 12 + m;
      if (i >= stepCount) break;
      growth += out.growth[i];
      withdrawn += out.withdrawal[i];
      expense += out.expense[i];
      income += out.income[i];
      // Pre-retirement accumulation contributions AND drawdown-phase lump-sum
      // deposits both add to the portfolio without a withdrawal, so the
      // `deposit` field carries their sum — keeping the year reconciliation
      // `balance = prior + growth − withdrawn + deposit` exact in both phases.
      deposit += out.deposit[i] + out.contributions[i];
    }
    const endStep = Math.min(stepCount - 1, (y + 1) * 12 - 1);
    const balance = out.preEnd[endStep] + out.postEnd[endStep];
    const cpi = out.cumCpi[endStep] || 1;
    const netNeed = Math.max(0, expense - income);
    const depleted = withdrawn < netNeed - 1e-6;
    const row: DrawdownYear = {
      year: input.firstYear + y,
      balance,
      withdrawn,
      netNeed,
      growth,
      deposit,
      depleted,
    };
    if (taxAcc) {
      row.federalTaxCents = Math.round((taxAcc.fedTax[y] ?? 0) * 100);
      row.irmaaSurchargeCents = Math.round((taxAcc.irmaa[y] ?? 0) * 100);
      row.acaPtcSubsidyCents = Math.round((taxAcc.ptc[y] ?? 0) * 100);
      row.acaCreditAppliedToPremiumsCents = Math.round((taxAcc.credit[y] ?? 0) * 100);
    }
    // Attach the per-account balance map on drawdown-phase years only
    // (`y * 12 >= retStart` — `retStart` is the whole-year retirement
    // boundary). Pre-retirement accumulation rows carry no map, matching the
    // strategy-engine path's pre-retirement rows.
    if (y * 12 >= retStart) {
      const accountBalances = buildKernelAccountBalances(
        input,
        out,
        y,
        endStep,
        stepCount,
      );
      if (accountBalances) row.accountBalances = accountBalances;
    } else {
      // Accumulation-phase per-account balances → the separate additive
      // field. `years[]` accumulation rows stay free of `accountBalances` (no
      // discriminator flip).
      const accBalances = buildKernelAccumulationBalances(input, out, endStep);
      if (accBalances) {
        accumulationAccountBalances.push({
          year: input.firstYear + y,
          accountBalances: accBalances,
        });
      }
    }
    years[y] = row;
    realBalanceByYear[y] = balance / cpi;
    realGrowthByYear[y] = growth / cpi;
    // The exact reciprocal feeding realBalanceByYear: basisDeflator
    // multiplies a nominal display cent by this factor to land in the same
    // real frame as the MC balance line.
    realFactorByYear[y] = 1 / cpi;
  }
  const depletionYear =
    out.depletionStepIdx === -1
      ? null
      : input.firstYear + Math.floor(out.depletionStepIdx / 12);
  return {
    firstYear: input.firstYear,
    years,
    depletionYear,
    // The cashflow band indexes `perMonthWithdrawal` from the RETIREMENT year
    // (`(year − retirementYear) * 12 + month0`), so slice the full-horizon
    // kernel withdrawal series at the retirement-year whole-year boundary —
    // matching the deterministic runner's drawdown-phase-only series.
    perMonthWithdrawal: out.withdrawal.slice(Math.min(retStart, stepCount)),
    realBalanceByYear,
    realGrowthByYear,
    realFactorByYear,
    ...(accumulationAccountBalances.length > 0 ? { accumulationAccountBalances } : {}),
  };
}

/** Build a representative run from the strategy-engine's own per-year
 *  `DrawdownYear[]` (already nominal) spliced with the kernel's pre-retirement
 *  accumulation years. Real deflation uses the path's sampled CPI from
 *  `cumCpi`. The strategy-path drawdown funds tax per path via the
 *  two-pass expense fold (see `runOnePathViaStrategyEngine`); the captured rows
 *  reflect that funded (pass-2) drawdown, and the representative DISPLAY tax
 *  cents are stamped separately by `applyMcTaxToRepresentativeYears`. */
function captureStrategyRun(
  input: MonteCarloInput,
  preRetYears: DrawdownYear[],
  retYears: DrawdownYear[],
  depletionYear: number | null,
  perMonthWithdrawal: Float64Array,
  cumCpi: Float64Array,
  stepCount: number,
  // Per-account accumulation balances (stacking fields only), captured by
  // the caller from the kernel's pre-retirement `accountPreEnd`/`accountPostEnd`.
  accumulationAccountBalances: ReadonlyArray<{
    year: number;
    accountBalances: ReadonlyMap<string, DrawdownAccountYear>;
  }>,
): Omit<RepresentativeRun, 'seed'> {
  const horizonYears = input.horizonYear - input.firstYear + 1;
  const years: DrawdownYear[] = [...preRetYears, ...retYears].slice(0, horizonYears);
  const realBalanceByYear: number[] = new Array(horizonYears).fill(0);
  const realGrowthByYear: number[] = new Array(horizonYears).fill(0);
  // Allocated full-length; the unused tail [years.length, horizonYears)
  // stays zero and is never indexed (consumers key by calendar year over the
  // run's own `years`).
  const realFactorByYear: number[] = new Array(horizonYears).fill(0);
  for (let y = 0; y < years.length; y += 1) {
    const endStep = Math.min(stepCount - 1, (y + 1) * 12 - 1);
    const cpi = cumCpi[endStep] || 1;
    realBalanceByYear[y] = years[y].balance / cpi;
    realGrowthByYear[y] = years[y].growth / cpi;
    // The exact reciprocal feeding realBalanceByYear.
    realFactorByYear[y] = 1 / cpi;
  }
  return {
    firstYear: input.firstYear,
    years,
    depletionYear,
    perMonthWithdrawal: perMonthWithdrawal.slice(),
    realBalanceByYear,
    realGrowthByYear,
    realFactorByYear,
    ...(accumulationAccountBalances.length > 0 ? { accumulationAccountBalances } : {}),
  };
}

/** Running per-account year-START pre/post buckets carried across the strategy
 *  two-pass adapter (year y reads the prior row's year-END `preEnd`/`postEnd`; year-0
 *  reads `accountsIn[a].initialPre/initialPost`). Keyed by account id. */
type StrategyStartBuckets = Map<string, { pre: number; post: number }>;

/** Adapt ONE strategy `DrawdownYear` row into the per-account
 *  `McAccountYearWithdrawal[]` the tax estimator consumes. Withdrawal +
 *  tax treatment come from the row + the ledger; the year-START pre/post (used
 *  only for the MIXED split) come from the carried `startBuckets`, which are
 *  then advanced to this row's year-END balances for the next year.
 *  `scenarioExemptIds` marks per-source scenario penalty exemption so the
 *  classifier preserves provenance for the mixed-pool penalty split. */
function strategyYearWithdrawals(
  year: DrawdownYear,
  ledger: ReadonlyArray<MonteCarloInput['accountMcLedger'][number]>,
  startBuckets: StrategyStartBuckets,
  scenarioExemptIds: ReadonlySet<string>,
  /** Account ids whose distributions are made on account of the original
   *  owner's death (inherited accounts), so their §72(t) leg is waived. */
  deathExemptIds: ReadonlySet<string> = new Set(),
): McAccountYearWithdrawal[] {
  const accountBalances = year.accountBalances;
  return ledger.map((entry) => {
    const row = accountBalances?.get(entry.id);
    const start = startBuckets.get(entry.id) ?? { pre: 0, post: 0 };
    const result: McAccountYearWithdrawal = {
      taxTreatment: entry.taxTreatment,
      accountType: entry.accountType,
      withdrawalDollars: row?.withdrawn ?? 0,
      preBalanceStartDollars: start.pre,
      postBalanceStartDollars: start.post,
      ...(scenarioExemptIds.has(entry.id) ? { scenarioPenaltyExempt: true } : {}),
      ...(deathExemptIds.has(entry.id) ? { deathExemptInherited: true } : {}),
    };
    // Advance the carry to this row's year-END balances (next year's start).
    if (row !== undefined) startBuckets.set(entry.id, { pre: row.preEnd, post: row.postEnd });
    return result;
  });
}

/** Stable per-owner index ordering for `preTaxCentsByOwnerIdx`: the
 *  tax-context member ids. Only member-owned pre-tax accounts can carry an RMD,
 *  so an account owned by a non-member id never contributes to the per-owner
 *  floor — dropping it (no slot) is correct. */
function mcOwnerIds(input: MonteCarloInput): string[] {
  return input.taxContext?.members.map((m) => m.memberId) ?? [];
}

/** Drawdown-ENTRY per-owner pre-tax (RMD-eligible) cents, indexed by owner
 *  position — the year-0 prior basis.
 *
 *  The per-account pre-tax basis comes from `accountsIn[a].initialPre`
 *  — the KERNEL-ACCUMULATED drawdown-entry balance (post-accumulation), NOT the
 *  ledger's `initialPre` (today's balance at MC-run start). For a future-retirement
 *  scenario (`retirementYear > firstYear`) the accounts grow through accumulation
 *  before drawdown begins, so the ledger value understates the year-0 RMD basis.
 *  Account TYPE / TREATMENT / OWNER come from the ledger metadata, joined to the
 *  drawdown-entry balance by account id.
 *
 *  Both sub-buckets are passed through as `{ preCents, postCents }`: the shared
 *  `buildMcRmdAccountInput` assembles the base from the FULL balance and hands the
 *  Roth-designated pocket to the engine as the §325 portion, which nets a MIXED
 *  account down to its pre-tax slice and a pure Roth account down to zero. Zeroing
 *  `postCents` here instead would make this producer disagree with the
 *  representative path about the same account's base. */
function buildEntryFactRmdRequiredCentsByOwnerIdx(
  input: MonteCarloInput,
  accountsIn: ReadonlyArray<DrawdownAccountInput>,
  ownerIds: ReadonlyArray<string>,
  /** The FIRST drawdown tax year — the year the entry-basis floor applies to. */
  firstDrawdownTaxYear: number,
): number[] | undefined {
  const facts = input.mcRmdContext?.rmdFactsByAccountId;
  const members = input.taxContext?.members ?? input.mcRmdContext?.members;
  const rmdSnapshot = input.taxContext?.taxBundle.rmd ?? input.mcRmdContext?.rmdSnapshot;
  if (facts === undefined || members === undefined || rmdSnapshot === undefined) {
    return undefined;
  }
  const priorBalancesCents = new Map<string, McRmdBalanceCents>();
  for (const acc of accountsIn) {
    priorBalancesCents.set(acc.id, {
      preCents: Math.round(acc.initialPre * 100),
      postCents: Math.round(acc.initialPost * 100),
    });
  }
  return buildMcFactRmdRequiredCentsByOwnerIdx({
    ledger: input.accountMcLedger,
    ownerIds,
    members,
    rmdSnapshot,
    // Year 0 of drawdown: the entry balances ARE the Dec-31 prior-year base.
    // No two-years-prior base exists, so a first-year-deferral catch-up is
    // reported as a blocker rather than guessed.
    taxYear: firstDrawdownTaxYear,
    priorBalancesCents,
    rmdFactsByAccountId: facts,
    ...(input.mcRmdContext?.retirementYearByOwner !== undefined
      ? { retirementYearByOwner: input.mcRmdContext.retirementYearByOwner }
      : {}),
  });
}

function buildEntryPreTaxCentsByOwnerIdx(
  input: MonteCarloInput,
  accountsIn: ReadonlyArray<DrawdownAccountInput>,
  ownerIds: ReadonlyArray<string>,
): number[] {
  const idx = ownerIds.map(() => 0);
  const slotByOwner = new Map<string, number>();
  ownerIds.forEach((id, i) => slotByOwner.set(id, i));
  // Join the ledger's classification metadata to the drawdown-entry
  // pre-tax balance (the kernel-accumulated value) by account id.
  const entryPreById = new Map<string, number>();
  for (const acc of accountsIn) entryPreById.set(acc.id, acc.initialPre);
  // An account carrying recorded RMD facts is EXCLUDED here — its required
  // withdrawal is computed per account through the shared engine
  // (`buildEntryFactRmdRequiredCentsByOwnerIdx`), so leaving it in the pooled
  // Uniform-Lifetime basis too would double-count it.
  const rmdFacts = input.mcRmdContext?.rmdFactsByAccountId;
  for (const entry of input.accountMcLedger) {
    const treatment = entry.taxTreatment;
    const type = entry.accountType;
    if (treatment === undefined || type === undefined) continue;
    if (!isQualifyingAccount(type, treatment)) continue;
    if (rmdFacts?.[entry.id] !== undefined) continue;
    const entryPre = entryPreById.get(entry.id);
    if (entryPre === undefined) continue;
    const preTaxCents = Math.round(entryPre * 100);
    if (preTaxCents <= 0) continue;
    const slot = slotByOwner.get(entry.ownerId ?? entry.id);
    if (slot === undefined) continue;
    idx[slot] += preTaxCents;
  }
  return idx;
}

/** Per-account Dec-31 sub-bucket balances (cents) from one captured drawdown
 *  row, for the fact-based funded RMD pass. Absent map → empty.
 *
 *  BOTH sub-buckets are passed through unconditionally — the §325 Roth-designated
 *  netting is the shared engine resolver's job, never a producer's. */
function rowBalancesCents(
  row: DrawdownYear | undefined,
): ReadonlyMap<string, McRmdBalanceCents> {
  const out = new Map<string, McRmdBalanceCents>();
  for (const [id, acct] of row?.accountBalances ?? []) {
    out.set(id, {
      preCents: Math.round(acct.preEnd * 100),
      postCents: Math.round(acct.postEnd * 100),
    });
  }
  return out;
}

/** Stamp `preTaxCentsByOwnerIdx` (+ the fact-based required-withdrawal
 *  companion) onto each drawdown row from its captured `accountBalances` + the
 *  ledger. Mutates the rows in place.
 *
 *  An account carrying recorded RMD facts leaves the pooled Uniform-Lifetime
 *  basis and is instead run through the SHARED `computeRmd` engine per owner
 *  (`buildMcFactRmdRequiredCentsByOwnerIdx`), so the FUNDED per-path floor
 *  honours the real beneficiary schedule / table selection / deferral instead of
 *  merely dropping the account. The required cents are stamped for the year the
 *  floor applies to — the row's year + 1, since the next year's floor reads this
 *  row's Dec-31 balances. A fact-free household stamps nothing new. */
function stampPreTaxCentsByOwnerIdx(
  years: DrawdownYear[],
  input: MonteCarloInput,
  ownerIds: ReadonlyArray<string>,
): void {
  const facts = input.mcRmdContext?.rmdFactsByAccountId;
  const members = input.taxContext?.members ?? input.mcRmdContext?.members;
  const rmdSnapshot = input.taxContext?.taxBundle.rmd ?? input.mcRmdContext?.rmdSnapshot;
  for (let i = 0; i < years.length; i += 1) {
    const row = years[i];
    row.preTaxCentsByOwnerIdx = buildPreTaxCentsByOwnerIdx(
      row.accountBalances,
      input.accountMcLedger,
      ownerIds,
      // A fact-carrying account leaves the pooled owner basis — the pooled
      // Uniform-Lifetime divisor cannot express a beneficiary schedule, a
      // still-working deferral, or a withheld result.
      facts,
    );
    if (facts === undefined || members === undefined || rmdSnapshot === undefined) continue;
    if (row.accountBalances === undefined) continue;
    row.factRmdRequiredCentsByOwnerIdx = buildMcFactRmdRequiredCentsByOwnerIdx({
      ledger: input.accountMcLedger,
      ownerIds,
      members,
      rmdSnapshot,
      // The floor computed FROM this row's Dec-31 balances applies to next year.
      taxYear: row.year + 1,
      priorBalancesCents: rowBalancesCents(row),
      ...(i > 0 ? { twoYearsPriorBalancesCents: rowBalancesCents(years[i - 1]) } : {}),
      rmdFactsByAccountId: facts,
      ...(input.mcRmdContext?.retirementYearByOwner !== undefined
        ? { retirementYearByOwner: input.mcRmdContext.retirementYearByOwner }
        : {}),
    });
  }
}

/** Build the per-year-index `priorPreTaxByOwner` maps the strategy tax fill +
 *  Fill conversion hook consume. Index 0 = the drawdown-entry
 *  pre-tax map; index i (>0) = the prior committed year's per-owner pre-tax
 *  (from `years[i-1].preTaxCentsByOwnerIdx`). Mirrors the `priorBalanceByYearIndex`
 *  pattern (the prior-year-END basis), so the committed pass-2 tax floor and
 *  the conversion solve floor share one source. */
function buildPriorPreTaxByOwnerByYearIndex(
  years: ReadonlyArray<DrawdownYear>,
  entryIdx: readonly number[],
  ownerIds: ReadonlyArray<string>,
  /** The year-0 fact-based required-withdrawal companion (see
   *  `buildPriorPreTaxByOwnerFromIdx`). Later years read the stamped row field. */
  entryFactRmdIdx?: readonly number[],
): ReadonlyMap<string, number>[] {
  const out: ReadonlyMap<string, number>[] = new Array(years.length);
  out[0] = buildPriorPreTaxByOwnerFromIdx(entryIdx, ownerIds, entryFactRmdIdx);
  for (let i = 1; i < years.length; i += 1) {
    out[i] = buildPriorPreTaxByOwnerFromIdx(
      years[i - 1].preTaxCentsByOwnerIdx,
      ownerIds,
      years[i - 1].factRmdRequiredCentsByOwnerIdx,
    );
  }
  return out;
}

/** Strategy-path tax fill: walk the pass-1 strategy years, classify each
 *  year's per-account withdrawal, run `applyPerYearTaxForPath`, and accumulate
 *  the per-path tax arrays + same-year tax draw.
 *  `priorBalance` threads the kernel rule (year-0 = drawdown-entry portfolio
 *  total, i.e. sum of accountsIn.initialPre+initialPost; y>0 = prior strategy
 *  row's total end balance). Correctly handles future-retirement inputs where
 *  year-0 is past accumulation and the portfolio has grown beyond portfolioToday.
 *  `priorPreTaxByOwnerByYearIndex` carries year i's prior per-owner pre-tax
 *  basis feeding the per-owner RMD floor (`computeMcRmdFloorCents`).
 *  Mutates `taxState.acc` / `taxState.taxDrawByYear`.
 *
 *  Exported for unit testing the shared-QCD-offset wiring (the committed
 *  pass-2 tax must read the shared pass-1 `qcdRmdOffsetByYearIndex`, not the
 *  current row's offset) — not part of the module's public runner API. */
export function fillStrategyYearTax(
  input: MonteCarloInput,
  retYears: DrawdownYear[],
  accountsIn: ReadonlyArray<DrawdownAccountInput>,
  preRetirementYears: number,
  taxState: TaxPathContext,
  // When supplied (Fill mode only), the per-year prior-balance basis the
  // conversion hook ALSO used to derive its synthetic RMD floor — index i carries
  // year i's prior balance (year 0 falls back to the drawdown-entry total). Passing
  // the SAME array here makes the committed tax's synthetic floor and the
  // conversion solve's floor a single source, so they never desync across passes.
  // Omitted (Minimize / no cap) → the committed tax keeps using THIS pass's running
  // prior-year-END balance.
  priorBalanceByYearIndex: ReadonlyArray<number> | undefined,
  // Per-year prior per-owner pre-tax basis feeding the per-owner RMD
  // floor (`computeMcRmdFloorCents`). Index i = year i's prior basis (index 0 =
  // drawdown-entry pre-tax map). REQUIRED — an empty map per year yields a $0
  // floor (no pre-tax balance), so a Roth-heavy / all-taxable household sees no
  // phantom RMD income.
  priorPreTaxByOwnerByYearIndex: ReadonlyArray<ReadonlyMap<string, number>>,
  // When supplied (Fill two-pass only), the per-owner QCD IRA-pool RMD
  // offset the conversion hook ALSO used — index i carries year i's offset, derived
  // ONCE from pass-1 committed rows. Passing the SAME array here makes the committed
  // tax's offset-reduced RMD floor and the conversion solve's a single source, so the
  // QCD offset (like the floor basis) never desyncs across passes (the documented
  // one-pass-stale approximation applied uniformly). Omitted (Minimize / no-cap, which
  // has no conversion solve) → the committed tax reads THIS row's offset
  // (`retYears[i].qcdRmdOffsetCentsByOwner`).
  qcdRmdOffsetByYearIndex?: ReadonlyArray<ReadonlyMap<string, number>>,
): void {
  const magi: MagiRing = {
    minus2: input.taxContext?.magiBootstrapLookbackMinus2,
    minus1: input.taxContext?.magiBootstrapLookbackMinus1,
    unitsMinus2: undefined,
    unitsMinus1: undefined,
  };
  // Year-0 start buckets = the drawdown-entry pre/post buckets (kernel
  // balances at retStart-1), carried forward to year-END balances thereafter.
  const startBuckets: StrategyStartBuckets = new Map(
    accountsIn.map((acc) => [acc.id, { pre: acc.initialPre, post: acc.initialPost }]),
  );
  // Per-source scenario penalty exemption for the year classifier.
  const scenarioExemptIds = new Set(
    input.taxContext?.earlyWithdrawalPenaltyExemptAccountIds ?? [],
  );
  // Per-source §72(t)(2)(A)(ii) death exemption (inherited accounts).
  const deathExemptIds = new Set(
    Object.entries(input.mcRmdContext?.rmdFactsByAccountId ?? {})
      .filter(([, facts]) => facts.inheritedAccount === true)
      .map(([id]) => id),
  );
  // Drawdown-entry total balance: equals portfolioToday when preRetirementYears === 0;
  // grows to the end-of-accumulation balance when preRetirementYears > 0, matching the
  // kernel rule for priorBalance on the first retirement year.
  const entryTotal = accountsIn.reduce((sum, a) => sum + a.initialPre + a.initialPost, 0);
  let priorTotalBalance = entryTotal;
  for (let i = 0; i < retYears.length; i += 1) {
    const y = preRetirementYears + i;
    if (y >= taxState.acc.fedTax.length) break;
    // The designated-Roth pocket balance at the START of this year — read
    // BEFORE `strategyYearWithdrawals` advances `startBuckets` to year-END, so it
    // is the PRE-distribution balance the §402A(d)(4) pro rata divides by (the
    // deterministic per-account path uses `postEnd + draw`, the same quantity up to
    // the year's growth).
    const designatedRothPoolBalanceDollars =
      taxState.designatedRothPool !== null
        ? mcDesignatedRothPoolBalanceDollars(input.accountMcLedger, startBuckets)
        : 0;
    const classification = classifyMcWithdrawal(
      strategyYearWithdrawals(
        retYears[i],
        input.accountMcLedger,
        startBuckets,
        scenarioExemptIds,
        deathExemptIds,
      ),
    );
    // A committed Fill-mode Roth conversion is ALSO ordinary income for
    // the year. It must (a) advance the per-path MagiRing on a conversion-INCLUSIVE
    // basis so the conversion's Y+2 IRMAA look-back is FUNDED (mirrors the
    // deterministic `magiBuffer` replacement), but (b) NOT enter the year's FUNDED
    // same-year tax — the engine funds the conversion's same-year incremental tax
    // separately (`fundConversionTaxForYear`, drawn from MAGI-neutral post
    // balances). Folding it into the funded tax too would double-fund it.
    // `applyPerYearTaxForPathWithConversion` returns the WITHDRAWALS-ONLY funded
    // result + the conversion-inclusive MAGI for the ring. The conversion is NOT a
    // distribution → never folded into the pre-tax withdrawal (which would wrongly
    // feed the §72(t) penalty basis).
    const rothConvertedDollars = (retYears[i].rothConvertedCents ?? 0) / 100;
    // When the shared prior-balance basis is supplied (Fill mode), the
    // synthetic RMD floor uses the SAME array the conversion hook used (index i =
    // year i's prior balance; year 0 / absent → drawdown-entry total), so the
    // committed tax and the conversion solve see one floor. Otherwise keep this
    // pass's running prior-year-END balance (Minimize / no-cap).
    const priorBalance =
      priorBalanceByYearIndex !== undefined
        ? (i <= 0 ? entryTotal : priorBalanceByYearIndex[i] ?? entryTotal)
        : priorTotalBalance;
    const taxOutcome = applyPerYearTaxForPathWithConversion({
      taxCtx: input.taxContext!,
      taxYear: input.firstYear + y,
      retirementYear: input.retirementYear,
      grossSsDollars: input.ssByYear[y] ?? 0,
      // The windowed nominal expense at this year-END step.
      nominalExpense: taxState.nominalExpenseByYear[y] ?? 0,
      medicalExpenseDollars: taxState.nominalMedicalExpenseByYear[y] ?? 0,
      ...(taxState.drawNeedByYear !== undefined
        ? { drawNeedDollars: taxState.drawNeedByYear[y] ?? 0 }
        : {}),
      otherIncome: input.incomeByYear[y] ?? 0,
      // The conversion is ADDITIONAL ordinary income for MAGI — it drives only the
      // ring (conversion-inclusive MAGI), never the funded same-year cashflow.
      additionalOrdinaryIncomeDollars: rothConvertedDollars,
      priorBalance,
      // Per-owner pre-tax RMD-floor basis for this year.
      priorPreTaxByOwner: priorPreTaxByOwnerByYearIndex[i] ?? new Map<string, number>(),
      // QCD: the per-owner IRA-pool RMD offset, already stamped on this
      // row by the strategy engine's `applyQcdPrePass`. It reduces each owner's
      // per-owner RMD floor so the gross-up never re-adds the QCD-satisfied RMD as
      // phantom taxable income. The gift is excluded from ordinary income / MAGI
      // EXACTLY ONCE, STRUCTURALLY — `applyQcdPrePass` debits it from the IRA
      // balance WITHOUT recording it as a taxable pre-tax withdrawal, so this
      // year's `classification.preTaxDollars` already excludes it (mirroring the
      // deterministic engine, which likewise never sets `qcdIncomeExclusionDollars`).
      // Threading `qcdIncomeExclusionDollars` here too would
      // double-exclude; the offset-reduced floor + structural debit are the
      // single exclusion, pinned cent-for-cent vs the deterministic engine by the
      // cross-engine-pin QCD full-series parity case.
      // In the Fill two-pass the shared `qcdRmdOffsetByYearIndex`
      // (pass-1-derived) is supplied → read year i's offset from it, so the
      // committed tax's offset-reduced RMD floor matches the conversion solve's
      // (same single source as the `priorPreTaxByOwnerByYearIndex` floor basis).
      // Absent (Minimize / no-cap) → fall back to THIS row's offset. Mirrors the
      // `priorPreTaxByOwnerByYearIndex ?? retYears` fallback shape already used
      // for the floor basis.
      ...(qcdRmdOffsetByYearIndex !== undefined
        ? (qcdRmdOffsetByYearIndex[i] !== undefined
            ? { qcdRmdOffsetCentsByOwner: new Map(qcdRmdOffsetByYearIndex[i]) }
            : {})
        : retYears[i].qcdRmdOffsetCentsByOwner !== undefined
          ? {
              qcdRmdOffsetCentsByOwner: new Map(
                Object.entries(retYears[i].qcdRmdOffsetCentsByOwner ?? {}),
              ),
            }
          : {}),
      magiMinus2: magi.minus2,
      irmaaLookbackUnitsMinus2: magi.unitsMinus2,
      classification,
      // NOTE: the taxable-income yield base / evolved basis / cash-like interest
      // are deliberately NOT threaded into the FUNDED per-path tax — the
      // deterministic engine's funding solver keeps the same documented
      // pre-commit approximation (static seed fraction, $0 yield base, $0
      // interest), so threading them here would desync the two engines'
      // funded balances (the cross-engine $1 ending-balance parity contract).
      // The exact model lands on the DISPLAY surfaces of both engines: the
      // deterministic post-pass annotation and the MC representative tax
      // burden (`applyMcTaxToRepresentativeYears`).
      rothBasisCarrier: taxState.rothBasisCarrier,
      // The pooled designated-Roth state + the year's REAL designated-Roth
      // pocket balance (from the carried per-account start buckets), so the
      // §402A(d)(4) pro-rata fraction is `remaining basis / current balance` rather
      // than a frozen snapshot fraction re-applied for decades.
      ...(taxState.designatedRothPool !== null
        ? {
            designatedRothPool: taxState.designatedRothPool,
            designatedRothPoolBalanceDollars,
          }
        : {}),
      // `?.[y]` yields `undefined` (= derive in-function) when
      // the precompute is absent.
      survivorState: taxState.survivorStateByYear?.[y],
    });
    // Credit this year's converted principal to the aggregate §408A
    // basis carrier AFTER the per-year tax (which already consumed basis for THIS
    // year's Roth withdrawals via `applyMcRothBasisOrdering`). Converted dollars
    // land at year-END → basis only for LATER years' Roth withdrawals, never the
    // same year's; without this a later Roth withdrawal beyond the seeded basis
    // would re-tax converted principal as earnings (+10% penalty), diverging from
    // the deterministic engine. Safe across both passes: `reseedRothBasisCarrier`
    // restarts the carrier from full seeded basis before pass-2, which re-credits.
    creditMcConversionToBasisCarrier(
      taxState.rothBasisCarrier,
      retYears[i].rothConvertedCents ?? 0,
      // Dated, so the converted principal carries its own five-taxable-year
      // §408A(d)(3)(F) recapture window exactly as in the deterministic engine.
      input.firstYear + y,
    );
    // Advance the running prior-year-END balance ONLY on the non-shared
    // (Minimize / no-cap) path — its sole reader is the priorBalance ternary
    // above. On the Fill (shared-array) branch this write is dead, so guard it.
    if (priorBalanceByYearIndex === undefined) priorTotalBalance = retYears[i].balance;
    if (taxOutcome === null) continue;
    accumulatePerYearTaxResult(
      taxState.acc,
      taxState.taxDrawByYear,
      y,
      taxOutcome.result,
      magi,
      taxOutcome.magiInclusiveDollars,
    );
  }
}

/** Fold the per-year same-year tax draw into the SLICED retirement-phase
 *  expense array the strategy engine actually receives. `expense` is
 *  retirement-year-relative (index 0 = first retirement month), so year `y`'s
 *  monthly tax lands at `i*12 + m` for `i` = the retirement-relative year. A
 *  negative draw (the credit applied to premiums) follows each month's need. */
function foldTaxIntoStrategyExpense(
  expense: Float64Array,
  income: Float64Array,
  taxDrawByYear: number[],
  preRetirementYears: number,
): void {
  for (let start = 0; start < expense.length; start += 12) {
    const y = preRetirementYears + start / 12;
    foldYearDrawIntoExpense(
      expense, income, start, Math.min(start + 12, expense.length), taxDrawByYear[y] ?? 0,
    );
  }
}

/** Per-year draw need before any tax is folded in, indexed by the full-horizon
 *  year like `taxDrawByYear`: the sum of the positive monthly needs of the
 *  (guardrail-scaled) retirement slice. Years before retirement stay 0. */
function drawNeedByYearFromSlice(
  expense: Float64Array,
  income: Float64Array,
  preRetirementYears: number,
  horizonYears: number,
): Float64Array {
  const needByYear = new Float64Array(horizonYears);
  for (let start = 0; start < expense.length; start += 12) {
    const y = preRetirementYears + start / 12;
    if (y >= horizonYears) break;
    needByYear[y] = sumPositiveNeed(expense, income, start, Math.min(start + 12, expense.length));
  }
  return needByYear;
}

/** Reset the per-path Roth-basis carrier IN PLACE before the pass-2 tax
 *  fill so §408A ordering restarts from full household basis (Roth-First
 *  correctness). The carrier field is `readonly` (cannot be reassigned) but is
 *  a mutable Map — clear it and re-seed the single aggregate entry from the
 *  same summed household basis `seedMcAggregateRothBasisCarrier` uses. */
function reseedRothBasisCarrier(taxState: TaxPathContext): void {
  const carrier = taxState.rothBasisCarrier;
  carrier.clear();
  const seeded = seedMcAggregateRothBasisCarrier(
    taxState.input.taxContext?.rothBasisCentsByOwner,
    taxState.input.taxContext?.rothOrderedProfile,
  );
  const entry = seeded.get(MC_AGGREGATE_ROTH_OWNER_KEY);
  if (entry !== undefined) carrier.set(MC_AGGREGATE_ROTH_OWNER_KEY, entry);
  // The pooled designated-Roth state is equally cumulative, so pass 2 must
  // restart it from the full recorded basis / lots too — otherwise pass 2 would
  // run against basis pass 1 already consumed and over-tax the same withdrawals.
  taxState.designatedRothPool =
    seedMcDesignatedRothPool(taxState.input.taxContext?.rothOrderedProfile) ?? null;
}

/** Build the strategy-engine `RmdContextInput`
 *  from the MC tax context + per-account ledger so the year-by-year strategy
 *  path runs `applyRmdFloorPrePass` INLINE on every named-strategy MC path.
 *  This makes the per-path drawdown enforce real per-owner RMD floors and
 *  populate `DrawdownYear.rmdReinvestedCents` / `rmdOverflowToCashCents` (the
 *  surplus-disposition fields) on each simulated path year, mirroring the
 *  deterministic engine. Owner birthdate + death year come from
 *  `taxContext.members` (members[0] = primary, members[1] = secondary, same
 *  convention as `buildOwnerMeta`); account→owner + calibration come from the
 *  ledger and `taxContext.taxBundle.rmd`. Returns `undefined` when no tax
 *  context or when no ledger account qualifies for RMDs — the engine then skips
 *  RMD enforcement.
 *
 *  Carries the recorded per-account RMD facts + per-owner separation years
 *  straight off `mcRmdContext` (the same plain `Record`s the deterministic
 *  `buildRmdContext` builds from one shared derivation), so the MC forced draw
 *  resolves the same per-account rule as the MC tax floor
 *  (`buildMcFactRmdRequiredCentsByOwnerIdx`) instead of the pooled
 *  Uniform-Lifetime divisor. Admission is inherited-aware: a
 *  household holding ONLY inherited retirement accounts still gets a context.
 *  Exported for tests: the returned context's `rmdFactsByAccountId` forwarding
 *  is what carries the inherited marker onto every MC `AccountRunState`. */
export function buildStrategyRmdContext(input: MonteCarloInput): RmdContextInput | undefined {
  const taxCtx = input.taxContext;
  if (taxCtx === undefined || taxCtx.members.length === 0) return undefined;
  const rmdFactsByAccountId = input.mcRmdContext?.rmdFactsByAccountId;
  const retirementYearByOwner = input.mcRmdContext?.retirementYearByOwner;
  const ownerMeta = new Map<string, { isoBirthdate: string; deathYear: number }>();
  taxCtx.members.forEach((m, idx) => {
    const deathYear = idx === 0 ? taxCtx.primaryDeathYear : taxCtx.secondaryDeathYear;
    // RmdContextInput.deathYear is a plain number (Infinity = alive every year);
    // McTaxContext death years are optional → fall back to +Infinity.
    ownerMeta.set(m.memberId, {
      isoBirthdate: m.isoBirthdate,
      deathYear: deathYear ?? Number.POSITIVE_INFINITY,
    });
  });
  const ownerByAccountId = new Map<string, string>();
  let anyQualifies = false;
  for (const e of input.accountMcLedger) {
    const ownerId = e.ownerId ?? e.id;
    ownerByAccountId.set(e.id, ownerId);
    const accountType = e.accountType ?? 'OTHER';
    const admitted =
      rmdFactsByAccountId?.[e.id]?.inheritedAccount === true
        ? isInheritedRmdSubjectType(accountType)
        : isQualifyingAccount(accountType, e.taxTreatment ?? 'PRE_TAX');
    if (admitted) anyQualifies = true;
  }
  if (!anyQualifies) return undefined;
  return {
    ownerMeta,
    ownerByAccountId,
    rmdSnapshot: taxCtx.taxBundle.rmd,
    ...(rmdFactsByAccountId !== undefined ? { rmdFactsByAccountId } : {}),
    ...(retirementYearByOwner !== undefined ? { retirementYearByOwner } : {}),
  };
}

/**
 * Downturn-guardrail per-path runtime context (explained in
 * docs/math-projections.md, "Spending guardrails"). Threaded
 * into the strategy engine so the funded-ratio spending rule fires per year on
 * THIS path's own sampled CPI. Returns `undefined` when the guardrail is absent
 * / disabled OR the baseline net-need series is missing (never a partial rule).
 *
 * `cumCpi` is the path's per-step cumulative CPI (the full-horizon `cumCpi` from
 * `buildStepInputs`); the year-start
 * cumCpi for drawdown-relative year `y` is the factor at the END of the prior
 * month (`retStart + y*12 − 1`, or 1 at the run start). The baseline REAL series
 * (`guardrail*RealByYear`) are already today's-dollar and path-CPI-independent
 * (retirement expenses track CPI), so only the nominal year-start POOL needs
 * path-CPI deflation. `appliedFactorByYear` is a fresh per-path output the
 * engine fills on the pass it evaluates.
 */
function buildGuardrailRuntimeContext(
  input: MonteCarloInput,
  cumCpi: ArrayLike<number>,
  retStart: number,
  retYearCount: number,
): GuardrailRuntimeContext | undefined {
  const cfg = input.downturnGuardrails;
  if (cfg === undefined || cfg.enabled !== true) return undefined;
  const baselineNetNeed = input.guardrailBaselineRealNetNeedByYear;
  const baselineTotal = input.guardrailBaselineTotalRealByYear;
  const essential = input.guardrailEssentialRealByYear;
  if (
    baselineNetNeed === undefined ||
    baselineTotal === undefined ||
    essential === undefined
  ) {
    return undefined;
  }
  const cumCpiAtYearStart = new Array<number>(retYearCount);
  for (let y = 0; y < retYearCount; y += 1) {
    const priorStep = retStart + y * 12 - 1;
    cumCpiAtYearStart[y] = priorStep >= 0 ? (cumCpi[priorStep] ?? 1) : 1;
  }
  const config: GuardrailConfig = {
    enabled: cfg.enabled,
    lowerBandPct: cfg.lowerBandPct,
    upperBandPct: cfg.upperBandPct,
    stepPct: cfg.stepPct,
    maxRaisePct: cfg.maxRaisePct,
    // Discretionary floor — carried into both the strategy engine and the
    // kernel mirror via `applyGuardrailStep`, which composes the effective floor
    // from `essentialShare` + this share. Copied as-is: in production the resolver
    // (`resolveDownturnGuardrailsForScenario`) already materialized the default 50,
    // so this is always present; a raw MC input that omits it falls to
    // `applyGuardrailStep`'s defensive `?? 0` (the pre-feature cut-all floor).
    discretionaryFloorPct: cfg.discretionaryFloorPct,
  };
  return {
    config,
    baselineTotalRealByYear: baselineTotal,
    baselineNetNeedRealByYear: baselineNetNeed,
    essentialRealByYear: essential,
    cumCpiAtYearStart,
    effectiveTaxRate: input.guardrailEffectiveTaxRate ?? 0,
    appliedFactorByYear: new Array<number>(retYearCount).fill(1),
  };
}

/**
 * Rebuild the per-year windowed nominal expense series with the guardrail's
 * pass-1 spend factor applied, so the two-pass per-path tax (which reads
 * `nominalExpense` per year) and the `netAfterTaxPercentilesByYear` band reflect
 * the guardrail-ADJUSTED withdrawal, not the unadjusted baseline (guardrails,
 * D-tax). The engine scales the monthly `expense` array in place on pass 1 but
 * `nominalExpenseByYear` is built independently by `buildStepInputs`, so a cut/
 * raise would otherwise never reach the tax cashflow / after-tax output.
 *
 * `appliedFactorByYear[i]` is retirement-relative year `i`; horizon index
 * `preRetirementYears + i` (accumulation years keep factor 1). Returns a fresh
 * array — the original series is never mutated. When the guardrail applied no
 * change (all factors === 1) the original array is returned unchanged so a
 * no-op guardrail stays byte-identical.
 */
function guardrailAdjustedNominalExpenseByYear(
  nominalExpenseByYear: Float64Array,
  appliedFactorByYear: readonly number[],
  preRetirementYears: number,
): Float64Array {
  let anyAdjusted = false;
  for (let i = 0; i < appliedFactorByYear.length; i += 1) {
    if (appliedFactorByYear[i] !== 1) {
      anyAdjusted = true;
      break;
    }
  }
  if (!anyAdjusted) return nominalExpenseByYear;
  const adjusted = nominalExpenseByYear.slice();
  for (let i = 0; i < appliedFactorByYear.length; i += 1) {
    const y = preRetirementYears + i;
    if (y < 0 || y >= adjusted.length) continue;
    adjusted[y] = (nominalExpenseByYear[y] ?? 0) * appliedFactorByYear[i];
  }
  return adjusted;
}

/** QCD per-path context. Build the engine's `QcdContextInput` from the
 *  serializable `input.qcdContext`, inflating the REAL annual amount by THIS
 *  path's own cumulative CPI (`cumCpi`) per tax year and resolving the indexed
 *  per-person §408(d)(8) limit (inflation-extrapolated forward by the scenario
 *  inflation rate). Threaded into the strategy engine's `RunYearByYearArgs`
 *  so the SAME `applyQcdPrePass` the deterministic per-account engine runs fires
 *  INLINE on every MC path: debits the gift from the source IRA, offsets the
 *  IRA-pool RMD floor, and (via the rows it stamps) drives the per-path income
 *  exclusion. Returns `undefined` when no QCD resolved (identical to a no-QCD
 *  path) or when there is no ledger/RMD owner→account map (the pass needs it).
 *
 *  Inflation convention: the path's YEAR-END `cumCpi` (`(taxYear − firstYear +
 *  1) × 12 − 1`), the SAME factor the MC kernel uses to inflate `nominalExpense-
 *  ByYear` — so the gift's nominal value is consistent with the per-path nominal
 *  expenses/balances it is capped against. (The deterministic engine uses a
 *  year-MEAN factor; the two agree under zero CPI — the cross-engine-pin parity
 *  basis — and differ only by the same documented year-end-vs-year-mean MC
 *  approximation the expense inflation already carries.) */
function buildMcQcdRuntimeForPath(
  input: MonteCarloInput,
  cumCpi: Float64Array,
): QcdContextInput | undefined {
  const qcd = input.qcdContext;
  if (qcd === undefined || qcd.entries.length === 0) return undefined;
  const stepCount = cumCpi.length;
  const firstEligibleYearByOwner = new Map<string, number>(
    Object.entries(qcd.firstEligibleYearByOwner),
  );
  const inflationPct = qcd.inflationPct;
  return {
    entries: qcd.entries.map((e) => ({
      memberId: e.memberId,
      sourceAccountId: e.sourceAccountId,
      annualAmountDollars: e.annualAmountDollars,
      startYear: e.startYear,
      endYear: e.endYear,
    })),
    firstEligibleYearByOwner,
    inflationFactorForYear: (taxYear: number): number => {
      // Year-END step for `taxYear`; clamp into range (the resolver already
      // bounded the window, but a defensive clamp keeps a stray year inert).
      const endStep = Math.min(
        stepCount - 1,
        Math.max(0, (taxYear - input.firstYear + 1) * 12 - 1),
      );
      return cumCpi[endStep] ?? 1;
    },
    qcdLimitCentsForYear: (taxYear: number): number =>
      resolveQcdLimitCentsForYear(taxYear, inflationPct),
  };
}

/** Strategy-aware single-path runner for named strategies
 *  (`taxEfficient`, `proportional`, `rothFirst`, `customOrder`). Delegates to
 *  `runYearByYearStrategyAware` using the same
 *  per-account returns sampled by `buildStepInputs`.
 *
 *  Named-strategy paths FUND tax per path via a single-pass
 *  two-pass estimate (no within-year fixpoint):
 *  a pass-1 strategy run feeds `classifyMcWithdrawal` + `applyPerYearTaxForPath`
 *  to estimate each year's tax draw, that tax is folded into the sliced expense
 *  series, and the engine re-runs once so the portfolio funds the tax in
 *  strategy order. The per-path success%/percentile/depletion arrays come from
 *  the funded (pass-2) accumulator; the representative DISPLAY tax cents are
 *  stamped separately by `applyMcTaxToRepresentativeYears`. The Roth-basis
 *  carrier is re-seeded between passes so §408A ordering restarts from full
 *  basis on the funded pass.
 *
 *  Pre-retirement years (accumulation) come from the proportional kernel —
 *  the strategy engine only models the drawdown phase from retirement
 *  onward, so the two are spliced at `retirementStepIdx`. */
/**
 * Rebuild the engine-side runtime MAGI-cap window list from the serializable
 * MC overlay. Pairs each `magiCapOverride.windows[i]`
 * with its index-aligned precomputed bounds `magiCapWindowBounds[i]`, drops
 * non-positive resolved intervals, flags broken-anchor windows inactive,
 * and sorts by the total order `(startYear, endYear, originalIndex)` so
 * `selectActiveMagiCapWindow` is bit-identical to the deterministic engine.
 * Returns `undefined` when there is no cap / no bounds (no closures cross the
 * Worker boundary; the configs are rebuilt here, engine-side).
 */
/**
 * Rebuild the engine-side runtime MAGI-cap window list from the serializable
 * MC overlay. Pairs each `magiCapOverride.windows[i]`
 * with its index-aligned precomputed bounds `magiCapWindowBounds[i]`, drops
 * non-positive resolved intervals, flags broken-anchor windows inactive,
 * and sorts by the total order `(startYear, endYear, originalIndex)` so
 * `selectActiveMagiCapWindow` is bit-identical to the deterministic engine.
 * Returns `undefined` when there is no cap / no bounds (no closures cross the
 * Worker boundary; the configs are rebuilt here, engine-side).
 */
function buildMcMagiCapWindows(
  input: MonteCarloInput,
): ReadonlyArray<MagiCapWindowRuntime> | undefined {
  const overlay = input.magiCapOverride;
  const bounds = input.magiCapWindowBounds;
  if (overlay === undefined || bounds === undefined || overlay.windows.length === 0) {
    return undefined;
  }
  const resolved: MagiCapWindowRuntime[] = [];
  for (let i = 0; i < overlay.windows.length; i += 1) {
    const b = bounds[i];
    if (b === undefined) continue;
    if (b.brokenAnchor) {
      resolved.push({
        startYear: 0,
        endYear: 0,
        originalIndex: i,
        brokenAnchor: true,
        config: buildMagiCapConfig(overlay.windows[i], 0),
      });
      continue;
    }
    if (b.endYear <= b.startYear) continue;
    resolved.push({
      startYear: b.startYear,
      endYear: b.endYear,
      originalIndex: i,
      config: buildMagiCapConfig(overlay.windows[i], b.endYear),
    });
  }
  if (resolved.length === 0) return undefined;
  // Reuse the deterministic engine's comparator so the MC window
  // selection sorts by the SAME `(startYear, endYear, originalIndex)` order.
  resolved.sort(compareMagiCapWindows);
  return resolved;
}

/** Slice the named-strategy `depositsByMonth` (treatment-routed) for one
 *  account: the summed `deposit` minus the post-primary designated-Roth slice
 *  (`depositPost`), which is carried separately in `depositsPostByMonth` and
 *  always lands in `post`. Leaves CBP / one-off (treatment-routed) + the
 *  post-primary pre-tax slice in the pre-eligible slot. `depositPost` absent
 *  (pre-feature / hand-rolled ledger) ⇒ the summed slice passes through. */
function sliceDepositPre(
  acc: KernelAccount,
  retStart: number,
  stepCount: number,
): Float64Array {
  const summed = acc.deposit.slice(retStart, stepCount);
  if (!acc.depositPost) return summed;
  for (let i = 0; i < summed.length; i += 1) {
    summed[i] -= acc.depositPost[retStart + i] ?? 0;
  }
  return summed;
}

/** The strategy path discards ALL drawdown-phase kernel output
 *  — it reads only the kernel's accumulation-phase balances / entry buckets
 *  (steps `< retStart`) plus the full-horizon `cumCpi` (sourced from
 *  `buildStepInputs`, not the kernel). So the kernel only needs to simulate the
 *  accumulation phase `[0, retStart)`. This hands it `retStart`-length
 *  `subarray` VIEWS of every per-step household + per-account array (free — no
 *  copy) so the kernel allocates only `retStart`-sized outputs and runs only
 *  the accumulation steps. Every field the truncated kernel reads is indexed
 *  `< retStart`, and the accumulation recurrence at each step depends only on
 *  that step's inputs + the prior state, so the produced accumulation outputs
 *  are bit-identical to a full-length run's. Caller SKIPS this entirely when
 *  `retStart === 0` (already retired). */
function truncateAccountForAccumulation(acc: KernelAccount, retStart: number): KernelAccount {
  return {
    ...acc,
    contribPre: acc.contribPre.subarray(0, retStart),
    contribPost: acc.contribPost.subarray(0, retStart),
    deposit: acc.deposit.subarray(0, retStart),
    ...(acc.depositPost !== undefined
      ? { depositPost: acc.depositPost.subarray(0, retStart) }
      : {}),
    returnPct: acc.returnPct.subarray(0, retStart),
  };
}

/** Exported for unit testing — not part of the public runner API. */
export function truncateStepForAccumulation(step: StepInputs, retStart: number): StepInputs {
  return {
    ...step,
    mainReturnPct: step.mainReturnPct.subarray(0, retStart),
    cpiPct: step.cpiPct.subarray(0, retStart),
    contribPre: step.contribPre.subarray(0, retStart),
    contribPost: step.contribPost.subarray(0, retStart),
    expense: step.expense.subarray(0, retStart),
    income: step.income.subarray(0, retStart),
    deposit: step.deposit.subarray(0, retStart),
    ...(step.medicalDemandCents !== undefined
      ? { medicalDemandCents: step.medicalDemandCents.subarray(0, retStart) }
      : {}),
    accounts: step.accounts?.map((acc) => truncateAccountForAccumulation(acc, retStart)),
  };
}

function runOnePathViaStrategyEngine(
  input: MonteCarloInput,
  seed: number,
  ctx: RunContext,
  captureRun = false,
): PathOutcome {
  const {
    step, stepCount, retirementStepIdx, nominalExpenseByYear, nominalMedicalExpenseByYear,
    medicalDemandCents, cumCpi,
  } = buildStepInputs(input, seed, ctx);
  const horizonYears = input.horizonYear - input.firstYear + 1;

  // The strategy engine is per-account only — with no ledger there is nothing
  // for it to model, so fall back to the proportional kernel (which also
  // carries the two-pass tax estimate). Strategy paths in production always have a ledger.
  const stepAccounts = step.accounts;
  if (!stepAccounts || stepAccounts.length === 0) {
    return runOnePathKernel(input, seed, ctx, captureRun);
  }

  // The strategy engine is year-granular: it runs WHOLE years from the
  // retirement-year start (`retYearCount` years, each 12 months). Trim the
  // household + per-account series at the retirement-year boundary
  // (`retStart = preRetirementYears * 12`), NOT the month-precise
  // `retirementStepIdx` — otherwise the sliced arrays would not be a whole
  // number of years and the engine would index past their ends (NaN growth).
  const preRetirementYears = Math.floor(retirementStepIdx / 12);
  const retStart = preRetirementYears * 12;
  const retYearCount = horizonYears - preRetirementYears;

  // Pre-retirement balances + per-account entry buckets come from the kernel.
  // The strategy path discards all drawdown-phase kernel output,
  // so the kernel is handed a TRUNCATED (`subarray`-view) copy of the step that
  // spans only the accumulation phase `[0, retStart)`. When there is no
  // accumulation phase (`retStart === 0`, already retired) the kernel is
  // SKIPPED entirely (`kernelOut = null`) — the `priorStep >= 0 ? … :
  // acc.initialPre` entry-bucket fallbacks and the `y < preRetirementYears`
  // accumulation loop below already degrade to the ledger initial balances.
  const kernelOut =
    retStart > 0 ? runStepKernel(truncateStepForAccumulation(step, retStart)) : null;

  // The entry buckets are the kernel's balances at the step just before the
  // retirement year begins.
  const expense = step.expense.slice(retStart, stepCount);
  const income = step.income.subarray(retStart, stepCount);
  const householdDeposit = step.deposit.subarray(retStart, stepCount);
  const priorStep = retStart - 1;

  const accountsIn: DrawdownAccountInput[] = stepAccounts.map((acc, a) => {
    const ledger = input.accountMcLedger[a];
    const entryPre =
      priorStep >= 0 ? (kernelOut!.accountPreEnd?.[a]?.[priorStep] ?? acc.initialPre) : acc.initialPre;
    const entryPost =
      priorStep >= 0 ? (kernelOut!.accountPostEnd?.[a]?.[priorStep] ?? acc.initialPost) : acc.initialPost;
    return {
      id: acc.id,
      initialPre: entryPre,
      initialPost: entryPost,
      annualRatePct: 0, // overridden by returnPctByMonth
      // The deterministic per-account `applyMonthlyDeposits` seam reads
      // `depositsByMonth` (treatment-routed: CBP/one-off + the post-primary
      // pre-tax slice) + `depositsPostByMonth` (post-primary designated-Roth
      // slice, always → `post`). Slice the summed-minus-Roth into the pre slot
      // so the Roth slice is not double-credited (the named-strategy slice
      // routes `depositPre` to `pre`, `depositPost` to `post`); the no-ledger
      // kernel fallback keeps reading the summed `acc.deposit` unchanged.
      depositsByMonth: {
        startYear: input.retirementYear,
        startMonthIndex: 0,
        values: sliceDepositPre(acc, retStart, stepCount),
      },
      depositsPostByMonth: {
        startYear: input.retirementYear,
        startMonthIndex: 0,
        values: acc.depositPost
          ? acc.depositPost.slice(retStart, stepCount)
          : new Float64Array(stepCount - retStart),
      },
      taxTreatment: ledger?.taxTreatment ?? 'PRE_TAX',
      accountType: ledger?.accountType ?? 'BROKERAGE',
      // `returnPctByMonth` is read-only in the drawdown engine → a free
      // `subarray` view (no copy) in place of `.slice`.
      returnPctByMonth: acc.returnPct.subarray(retStart, stepCount),
      // Thread the per-account floor + HSA mode
      // into the MC strategy-path drawdown engine so per-path enforcement
      // matches the deterministic engine. Eligibility gates effect.
      ...(ledger?.floorDollars !== undefined
        ? { floorDollars: ledger.floorDollars, floorHsaMode: ledger.floorHsaMode }
        : {}),
    };
  });

  const strategyKind = input.strategyKind;
  // Thread the per-account RMD context so the strategy
  // engine runs `applyRmdFloorPrePass` INLINE on every named-strategy MC path
  // — real per-owner RMD floors drive the surplus-disposition fields
  // (`rmdReinvestedCents` / `rmdOverflowToCashCents`) on each path year, not
  // just the representative post-pass. `undefined` for paths with no qualifying
  // accounts or no tax context (RMD enforcement then skipped).
  const rmdContext = buildStrategyRmdContext(input);
  // QCD: thread the per-path QCD context so the strategy engine runs the
  // 70½-gated forced-outflow pass INLINE on this path — debiting the gift from
  // the source IRA + offsetting the IRA-pool RMD floor (per-path balance + tax
  // change). Uses THIS path's own `cumCpi` to inflate the REAL gift. Requires
  // the owner→account map (`rmdContext`); without a tax/RMD context the pass is
  // skipped (no QCD), identical to a no-QCD run.
  const qcdContext = buildMcQcdRuntimeForPath(input, cumCpi);
  // Thread the MAGI-ceiling cap + Fill-mode conversion solve onto the
  // MC strategy path so the cap is enforced and (under Fill) leftover headroom is
  // auto-converted per path via the SAME outer bisection the deterministic engine
  // runs. The conversion hook funds its own same-year
  // incremental tax from cap-safe balances; it consumes no RNG and its probes are
  // side-effect-free, so the per-path result is deterministic and reproduces under
  // the same seed. The pass-1 hook (built here) runs against the DRAFT pass-1
  // prior-balance basis (a no-/entry-total floor for later years); pass 2 REBUILDS
  // the hook with pass-1's committed prior-year-END balances, so the
  // pass-2 conversion solve sees the SAME synthetic RMD floor the pass-2 committed
  // tax uses. Pass-1 and pass-2 conversions can therefore DIFFER in RMD years; the
  // FUNDED pass-2 result is authoritative. `undefined` for Minimize / no cap / no
  // tax context → no cap routing or conversions.
  // Rebuild the closure-bearing runtime MAGI-cap WINDOW LIST HERE,
  // engine-side, from the SERIALIZABLE overlay (the windows array) + the
  // index-aligned precomputed bounds the input carries.
  // `MonteCarloInput` never holds the runtime config (its `findTargetRothIndex` /
  // `findLaterTaxableIndex` closures `DataCloneError` when posted to a Worker).
  // Same preprocessing as the deterministic resolver: broken-anchor / non-
  // positive windows are dropped/flagged and the list is sorted by the total
  // order `(startYear, endYear, originalIndex)` so per-year selection is
  // bit-identical to the deterministic engine.
  const magiCapWindows: ReadonlyArray<MagiCapWindowRuntime> | undefined =
    buildMcMagiCapWindows(input);
  // Drawdown-entry portfolio total — the synthetic RMD-floor basis for
  // retirement year 0, mirroring `fillStrategyYearTax`'s `priorTotalBalance` seed.
  const entryTotalBalance = accountsIn.reduce((sum, a) => sum + a.initialPre + a.initialPost, 0);
  // Per-owner pre-tax (RMD-eligible) basis. The owner index ordering +
  // the drawdown-entry per-owner pre-tax map (the year-0 prior basis).
  const ownerIds = mcOwnerIds(input);
  const entryPreTaxIdx = buildEntryPreTaxCentsByOwnerIdx(input, accountsIn, ownerIds);
  // The fact-based required-withdrawal companion for the year-0 basis (the
  // accounts the pooled basis above deliberately excludes).
  const entryFactRmdIdx = buildEntryFactRmdRequiredCentsByOwnerIdx(
    input,
    accountsIn,
    ownerIds,
    input.firstYear + preRetirementYears,
  );
  const entryPreTaxByOwner = buildPriorPreTaxByOwnerFromIdx(
    entryPreTaxIdx,
    ownerIds,
    entryFactRmdIdx,
  );
  const fillConversionHook = buildMcFillConversionHook({
    input,
    magiCapWindows,
    nominalExpenseByYear,
    preRetirementYears,
    entryTotalBalance,
    entryPreTaxByOwner,
  });
  // HSA withdrawal reserve: slice the per-path medical-demand cents to
  // the retirement window (same `retStart..stepCount` slice as `expense`) so the
  // year-by-year engine's medical-first HSA pass consumes it. All-zero ⇒
  // emergency-only.
  const medicalDemandByMonth = Array.from(medicalDemandCents.slice(retStart, stepCount));
  // Downturn guardrail. Built per path against THIS path's
  // own sampled CPI (the full-horizon `cumCpi` from `buildStepInputs`).
  // Threaded onto the PASS-1 args ONLY — the guardrail scales the shared
  // `expense` array IN PLACE on pass 1, and pass 2 reuses that already-scaled
  // array (factor evaluated on pass 1, reused on pass 2, never
  // re-evaluated). Undefined → no guardrail.
  const guardrail = buildGuardrailRuntimeContext(input, cumCpi, retStart, retYearCount);
  const args: RunYearByYearArgs = {
    input: {
      retirementYear: input.retirementYear,
      medicalDemandByMonth,
    } as unknown as DrawdownInput,
    yearCount: retYearCount,
    accountsIn,
    expense,
    income,
    householdDeposit,
    strategyKind,
    ...(rmdContext !== undefined ? { rmdContext } : {}),
    // QCD: the strategy engine runs `applyQcdPrePass` only when BOTH
    // `qcdContext` AND `rmdContext` are present (it reads the owner→account map
    // off `rmdContext`), so a QCD with no qualifying RMD-context account is inert.
    ...(qcdContext !== undefined ? { qcdContext } : {}),
    ...(input.customTiers !== undefined ? { customTiers: input.customTiers } : {}),
    ...(input.excludedIndices !== undefined ? { excludedIndices: input.excludedIndices } : {}),
    ...(magiCapWindows !== undefined ? { magiCapWindows } : {}),
    ...(fillConversionHook !== undefined ? { taxCashflow: fillConversionHook } : {}),
  };

  // Pass 1: a draft strategy run to estimate each year's tax draw. The
  // guardrail (when active) rides pass 1 ONLY — it scales the shared `expense`
  // array in place here, so pass 2 (which reuses the same array) taxes the
  // guardrail-adjusted withdrawals without re-evaluating the factor.
  const pass1Args: RunYearByYearArgs =
    guardrail !== undefined ? { ...args, guardrail } : args;
  const pass1 = runYearByYearStrategyAware(pass1Args);
  // Stamp the per-owner pre-tax sub-bucket totals on the pass-1 rows so
  // the per-year RMD-floor basis can be read from the prior year's row.
  stampPreTaxCentsByOwnerIdx(pass1.years, input, ownerIds);

  // Two-pass per-path tax. Named
  // strategies fund tax: classify pass-1's per-account withdrawal, estimate
  // each year's tax draw, fold it into the sliced expense, and re-run once so the
  // portfolio funds the tax in strategy order. No within-year fixpoint.
  //
  // The guardrail scaled the monthly `expense` array on pass 1
  // but the tax path reads its own `nominalExpenseByYear`, so rebuild that series
  // with pass-1's applied spend factor per year — otherwise a cut/raise would not
  // move the two-pass tax cashflow or the `netAfterTaxPercentilesByYear` band.
  const taxNominalExpenseByYear =
    guardrail !== undefined
      ? guardrailAdjustedNominalExpenseByYear(
          nominalExpenseByYear,
          guardrail.appliedFactorByYear,
          preRetirementYears,
        )
      : nominalExpenseByYear;
  const taxState = newTaxPathState(
    input, kernelOut, stepCount, horizonYears, taxNominalExpenseByYear,
    nominalMedicalExpenseByYear, ctx,
    // The guardrail has scaled `expense` in place on pass 1 and the tax is not
    // folded in yet: this is the draw both passes make before the tax.
    drawNeedByYearFromSlice(expense, income, preRetirementYears, horizonYears),
  );
  let years = pass1.years;
  let depletionYear = pass1.depletionYear;
  let perMonthWithdrawal = pass1.perMonthWithdrawal;
  if (taxState) {
    // The per-year prior per-owner pre-tax basis from pass-1's committed
    // rows (index 0 = drawdown-entry map). Shared by BOTH the committed pass-2 tax
    // fill AND the pass-2 conversion hook, so the per-owner RMD floor
    // is one source. Also used by the pass-1 fill (its own prior rows are pass-1's).
    const priorPreTaxByOwnerByYearIndex = buildPriorPreTaxByOwnerByYearIndex(
      pass1.years,
      entryPreTaxIdx,
      ownerIds,
      entryFactRmdIdx,
    );
    fillStrategyYearTax(
      input,
      pass1.years,
      accountsIn,
      preRetirementYears,
      taxState,
      undefined,
      priorPreTaxByOwnerByYearIndex,
    );
    foldTaxIntoStrategyExpense(expense, income, taxState.taxDrawByYear, preRetirementYears);
    // The credit applied to premiums is what pass 1 folded into the expense: it
    // is what lowered pass 2's draw. The pass-2 fill taxes the lowered draw and
    // would restate it from a lower MAGI, a figure that never funded anything.
    const creditFundedByYear = taxState.acc.credit.slice();
    // Restart §408A ordering from full basis before the pass-2 tax fill.
    reseedRothBasisCarrier(taxState);
    // Reset the per-path accumulators + tax draw so the pass-2 fill repopulates.
    resetPathTaxAcc(taxState.acc);
    taxState.taxDrawByYear.fill(0);
    // Rebuild the conversion hook for the authoritative pass with the
    // prior-year-END portfolio totals from pass 1's committed rows, so the Fill
    // solve's synthetic RMD floor matches the surface `fillStrategyYearTax` taxes
    // the pass-2 balance against (year i's prior balance = pass1.years[i-1].balance;
    // year 0 keeps the drawdown-entry total). Without it the solve runs against a
    // priorBalance-0 (no-floor) surface and over-converts in RMD years.
    let pass2Args = args;
    // The shared per-year prior-balance basis (pass-1 committed year-END
    // totals). The SAME array seeds the conversion hook's synthetic RMD floor AND
    // the pass-2 committed `fillStrategyYearTax` floor below, so the conversion
    // solve and the committed tax can never see divergent floors. Only built in
    // Fill mode (the hook exists); undefined otherwise → Minimize / no-cap keep
    // the committed tax's running prior-balance.
    let sharedPriorBalanceByYearIndex: number[] | undefined;
    // The shared pass-1-derived per-owner QCD offset, threaded into BOTH
    // the pass-2 conversion hook AND the pass-2 committed `fillStrategyYearTax` below,
    // so the offset (like the floor basis) is sourced from ONE authoritative pass-1
    // array. Only built in Fill mode (the hook exists); undefined otherwise → Minimize
    // / no-cap keep reading the committed tax's per-row offset.
    let sharedQcdRmdOffsetByYearIndex: ReadonlyArray<ReadonlyMap<string, number>> | undefined;
    if (fillConversionHook !== undefined) {
      const priorBalanceByYearIndex: number[] = new Array<number>(pass1.years.length).fill(0);
      for (let i = 1; i < pass1.years.length; i += 1) {
        priorBalanceByYearIndex[i] = pass1.years[i - 1].balance;
      }
      sharedPriorBalanceByYearIndex = priorBalanceByYearIndex;
      // The per-owner QCD IRA-pool RMD offset committed by pass 1,
      // index i = year i's offset (`pass1.years[i].qcdRmdOffsetCentsByOwner`). Derived
      // ONCE from pass-1 and threaded into BOTH the pass-2 conversion hook (the SOLVE)
      // AND the pass-2 committed `fillStrategyYearTax` (the committed TAX, via
      // `sharedQcdRmdOffsetByYearIndex` below), so both reduce the RMD floor by the
      // SAME (pass-1) QCD — never pass-2 rows. This mirrors the documented
      // approximation already applied to the floor basis: deriving from pass-1 keeps
      // the conversion solve and the committed tax CONSISTENT WITH EACH OTHER (no
      // solve/committed desync) at the accepted cost of being one-pass-stale versus
      // the deterministic committing-pass offset.
      const qcdRmdOffsetByYearIndex: ReadonlyArray<ReadonlyMap<string, number>> =
        pass1.years.map((yr) =>
          yr.qcdRmdOffsetCentsByOwner !== undefined
            ? new Map(Object.entries(yr.qcdRmdOffsetCentsByOwner))
            : new Map<string, number>(),
        );
      sharedQcdRmdOffsetByYearIndex = qcdRmdOffsetByYearIndex;
      const pass2Hook = buildMcFillConversionHook({
        input,
        magiCapWindows,
        nominalExpenseByYear,
        preRetirementYears,
        entryTotalBalance,
        entryPreTaxByOwner,
        priorBalanceByYearIndex,
        // The SAME per-owner pre-tax basis the committed pass-2 tax uses.
        priorPreTaxByOwnerByYearIndex,
        // The per-owner QCD offset pass-1 committed (one source with
        // the committed tax's per-row offset).
        qcdRmdOffsetByYearIndex,
      });
      if (pass2Hook !== undefined) pass2Args = { ...args, taxCashflow: pass2Hook };
    }
    // Pass 2: re-run with the augmented (tax-funded) expense slice.
    const pass2 = runYearByYearStrategyAware(pass2Args);
    years = pass2.years;
    depletionYear = pass2.depletionYear;
    perMonthWithdrawal = pass2.perMonthWithdrawal;
    // Re-stamp on the funded pass-2 rows so the captured representative
    // run carries the per-owner pre-tax totals consistent with the committed balances.
    stampPreTaxCentsByOwnerIdx(pass2.years, input, ownerIds);
    // Stamp the NEW per-path arrays from the funded pass-2 drawdown (these
    // feed success%/percentile/depletion; the representative DISPLAY cents are
    // stamped separately by `applyMcTaxToRepresentativeYears`).
    fillStrategyYearTax(
      input,
      pass2.years,
      accountsIn,
      preRetirementYears,
      taxState,
      // The SAME prior-balance basis the conversion hook used, so the
      // committed tax's synthetic RMD floor matches the conversion solve's.
      sharedPriorBalanceByYearIndex,
      // The SAME per-owner pre-tax basis (PASS-1 committed rows) the
      // conversion hook + the committed tax share — one RMD-floor source.
      // INTENTIONAL two-pass design, NOT a bug: `priorPreTaxByOwnerByYearIndex`
      // is built from PASS-1 year-end per-owner pre-tax totals and reused for the
      // PASS-2 committed tax. This is the documented, accepted approximation:
      // deriving the floor from pass-1 keeps the conversion
      // solve and the committed tax CONSISTENT WITH EACH OTHER (no solve/committed
      // desync) at the cost of being one-pass-stale versus the deterministic
      // committing-pass floor — same class as the pass-1-based MAGI ring / IRMAA
      // look-back. Rebuilding it from pass-2 rows would reintroduce that desync.
      priorPreTaxByOwnerByYearIndex,
      // The SAME pass-1-derived per-owner QCD offset the conversion hook
      // used, so the committed pass-2 tax's offset-reduced RMD floor matches the
      // conversion solve's — the offset is sourced from one authoritative pass-1 array
      // exactly like the floor basis above. Undefined on the non-Fill path (unreached
      // here: this branch only runs when fillConversionHook is defined).
      sharedQcdRmdOffsetByYearIndex,
    );
    for (let y = 0; y < creditFundedByYear.length; y += 1) {
      taxState.acc.credit[y] = creditFundedByYear[y];
    }
  }

  // Stamp priorPreEnd on the first drawdown row so that
  // applyMcRmdToRepresentativeYears uses the correct Dec 31 of the last
  // accumulation year (= accountsIn[a].initialPre = accPre[a][priorStep])
  // at the accumulation→drawdown boundary, matching the kernel-path behaviour.
  if (captureRun && years.length > 0 && years[0].accountBalances !== undefined) {
    const firstRowAccts = years[0].accountBalances;
    const stamped = new Map<string, DrawdownAccountYear>();
    firstRowAccts.forEach((acct, id) => {
      const matchIdx = accountsIn.findIndex((ac) => ac.id === id);
      const priorPreEnd = matchIdx >= 0 ? accountsIn[matchIdx].initialPre : acct.preEnd;
      stamped.set(id, { ...acct, priorPreEnd });
    });
    years[0].accountBalances = stamped;
  }

  const balanceByYearNominal: number[] = new Array(horizonYears).fill(0);
  const balanceByYearReal: number[] = new Array(horizonYears).fill(0);
  // Pre-retirement DrawdownYear rows for the representative capture
  // (accumulation phase from the kernel). Only assembled when capturing.
  const preRetYears: DrawdownYear[] = [];
  // Per-account accumulation balances captured into the SEPARATE additive
  // field on the representative run (NOT onto the `preRetYears` rows), so the
  // phase discriminator stays valid. Only assembled when capturing.
  const accumulationAccountBalances: {
    year: number;
    accountBalances: ReadonlyMap<string, DrawdownAccountYear>;
  }[] = [];

  // Pre-retirement years: read the kernel's accumulation balances.
  for (let y = 0; y < preRetirementYears; y += 1) {
    const endStep = Math.min(stepCount - 1, (y + 1) * 12 - 1);
    balanceByYearNominal[y] = kernelOut!.preEnd[endStep] + kernelOut!.postEnd[endStep];
    balanceByYearReal[y] = balanceByYearNominal[y] / cumCpi[endStep];
    if (captureRun) {
      let growth = 0;
      let contributions = 0;
      for (let m = 0; m < 12; m += 1) {
        const i = y * 12 + m;
        if (i >= stepCount) break;
        growth += kernelOut!.growth[i];
        contributions += kernelOut!.contributions[i];
      }
      preRetYears.push({
        year: input.firstYear + y,
        balance: balanceByYearNominal[y],
        withdrawn: 0,
        netNeed: 0,
        growth,
        deposit: contributions,
        depleted: false,
      });
      const accBalances = buildKernelAccumulationBalances(input, kernelOut!, endStep);
      if (accBalances) {
        accumulationAccountBalances.push({
          year: input.firstYear + y,
          accountBalances: accBalances,
        });
      }
    }
  }

  // Absorbing depletion. `depletionYear !== null` means a discretionary
  // withdrawal need went unmet that year. The strategy engine is non-absorbing
  // (it keeps running; post-depletion SS / pension income + positive returns can
  // push the balance back positive). The Bengen/Trinity safe-withdrawal-rate
  // convention treats ruin as PERMANENT, so zero-clamp the balance AT THE SOURCE
  // for every retirement year at or after depletion — `years[0]` is the FIRST
  // retirement year, so the index offset subtracts BOTH `firstYear` and the
  // accumulation period (= `depletionYear − input.retirementYear`), never just
  // `firstYear` (that would leave post-depletion retirement years un-zeroed for
  // future-retirement scenarios). Because the clamp lives on `years[y].balance`,
  // every downstream consumer — the balance arrays below, `captureStrategyRun`,
  // representative ranking, the EPS_REAL gate, the reroll band — reads zeroed
  // values with no further change.
  const depletionRetIndex =
    depletionYear === null ? Number.POSITIVE_INFINITY : depletionYear - input.retirementYear;

  // Retirement years: total year-end balance from the strategy engine.
  for (let y = 0; y < years.length; y += 1) {
    const portfolioYear = preRetirementYears + y;
    if (portfolioYear >= horizonYears) break;
    if (y >= depletionRetIndex) years[y].balance = 0;
    // Strictly-post-depletion years have no portfolio left, so their
    // growth is a phantom artifact of the non-absorbing engine — zero it for
    // display consistency with the clamped $0 balance. The depletion year keeps
    // its real growth (it still had a portfolio that year).
    if (y > depletionRetIndex) years[y].growth = 0;
    // The aggregate `balance` clamp above does not reach the
    // per-account sub-balances the Account Balance Stack chart reads directly.
    // For every year AT OR AFTER depletion (`y >= depletionRetIndex`) the
    // portfolio is permanently $0 by the absorbing convention, so zero each
    // account row's year-END balance fields (`balance`, `preEnd`, `postEnd`,
    // and the carried `priorPreEnd` Dec-31 basis) and the per-owner year-END
    // pre-tax index — keeping the per-account stack summing to the clamped
    // pooled total and the per-owner RMD basis at $0. This includes the
    // depletion year itself (`y === depletionRetIndex`): leaving its sub-account
    // balances non-zero showed positive stacked bars while the clamped pooled
    // total line read $0 — a visible chart inconsistency. Withdrawal/deposit/
    // distribution fields are PRESERVED on every year: the depletion year HAD
    // real draw-to-ruin activity (and on strictly-post-depletion years these are
    // naturally 0). The absorbing convention says the money is gone at year-end,
    // but the activity that depleted it is real. `growth` and the per-path tax
    // arrays below stay STRICTLY-post-depletion (`y > depletionRetIndex`): the
    // depletion year had a real portfolio earning real growth that fed its
    // withdrawals and generated real tax.
    if (y >= depletionRetIndex) {
      const accts = years[y].accountBalances;
      if (accts !== undefined) {
        const zeroed = new Map<string, DrawdownAccountYear>();
        accts.forEach((acct, id) => {
          zeroed.set(id, {
            ...acct,
            balance: 0,
            preEnd: 0,
            postEnd: 0,
            ...(acct.priorPreEnd !== undefined ? { priorPreEnd: 0 } : {}),
          });
        });
        years[y].accountBalances = zeroed;
      }
      if (years[y].preTaxCentsByOwnerIdx !== undefined) {
        years[y].preTaxCentsByOwnerIdx = years[y].preTaxCentsByOwnerIdx!.map(() => 0);
      }
      // The fact-based required-withdrawal companion is the same year-END
      // basis in required-amount form — a $0 portfolio requires $0.
      if (years[y].factRmdRequiredCentsByOwnerIdx !== undefined) {
        years[y].factRmdRequiredCentsByOwnerIdx = years[
          y
        ].factRmdRequiredCentsByOwnerIdx!.map(() => 0);
      }
    }
    if (y > depletionRetIndex) {
      // The balance/account clamp above does not reach the per-path tax
      // accumulator arrays, which `fillStrategyYearTax` populated on the
      // un-clamped pass-2 rows BEFORE this loop. For strictly-post-depletion
      // years the portfolio is permanently $0, so there is no real federal tax,
      // IRMAA, ACA PTC, effective-rate, or net-after-tax cashflow — leaving the
      // stale non-zero values would accumulate into the percentile tax bands
      // (`federalTaxPercentilesByYear`, `irmaaSurchargePercentilesByYear`, …).
      // Zero them at the SAME full-horizon index `fillStrategyYearTax` writes
      // (`preRetirementYears + i`, i.e. `portfolioYear` here). The depletion
      // year itself (`y === depletionRetIndex`) keeps its real tax.
      if (taxState && portfolioYear < taxState.acc.fedTax.length) {
        taxState.acc.fedTax[portfolioYear] = 0;
        taxState.acc.irmaa[portfolioYear] = 0;
        taxState.acc.ptc[portfolioYear] = 0;
        taxState.acc.credit[portfolioYear] = 0;
        taxState.acc.etr[portfolioYear] = 0;
        taxState.acc.net[portfolioYear] = 0;
      }
    }
    // The funded credit applied to premiums rides the captured rows the way the
    // tax draw does (from the pass-2 per-path tax), not the display post-pass.
    if (captureRun && taxState && portfolioYear < taxState.acc.credit.length) {
      years[y].acaCreditAppliedToPremiumsCents = Math.round(taxState.acc.credit[portfolioYear] * 100);
    }
    const totalBalance = years[y].balance;
    balanceByYearNominal[portfolioYear] = totalBalance;
    const endStep = Math.min(stepCount - 1, (portfolioYear + 1) * 12 - 1);
    balanceByYearReal[portfolioYear] = totalBalance / cumCpi[endStep];
  }

  return {
    balanceByYearNominal,
    balanceByYearReal,
    depletionYear,
    endingBalanceNominal: balanceByYearNominal[horizonYears - 1] ?? 0,
    endingBalanceReal: balanceByYearReal[horizonYears - 1] ?? 0,
    // The NEW per-path tax arrays come from the funded pass-2 accumulator
    // (they drive the percentile tax bands / success%); the representative
    // DISPLAY cents are stamped separately by `applyMcTaxToRepresentativeYears`.
    ...(taxState
      ? {
          federalTaxByYear: taxState.acc.fedTax,
          irmaaSurchargeByYear: taxState.acc.irmaa,
          acaPtcSubsidyByYear: taxState.acc.ptc,
          acaCreditAppliedToPremiumsByYear: taxState.acc.credit,
          effectiveTaxRateByYear: taxState.acc.etr,
          netAfterTaxByYear: taxState.acc.net,
        }
      : {}),
    ...(captureRun
      ? {
          representative: captureStrategyRun(
            input,
            preRetYears,
            [...years],
            depletionYear,
            perMonthWithdrawal,
            cumCpi,
            stepCount,
            accumulationAccountBalances,
          ),
        }
      : {}),
  };
}

export function runOnePath(
  input: MonteCarloInput,
  seed: number,
  ctx: RunContext,
  captureRun = false,
): PathOutcome {
  // Every named strategy routes through the strategy-aware year-by-year engine.
  return runOnePathViaStrategyEngine(input, seed, ctx, captureRun);
}

/**
 * Guardrail mirror for the no-ledger kernel fallback. Scales
 * `expense` per drawdown year IN PLACE from the `out1` year-START pool, using
 * the SAME pure `fundedRatio` / `applyGuardrailStep` helpers + the SAME settled-
 * path net-need construction the strategy engine uses. No-op when the guardrail
 * is absent / disabled or the baseline series are missing. This
 * path is edge / unit-test only (real MC runs have a ledger), so the mirror
 * keeps those inputs behaving consistently rather than silently un-guardrailed.
 */
function applyGuardrailToKernelExpense(
  input: MonteCarloInput,
  out1: StepOutcome,
  expense: Float64Array,
  retStart: number,
  retirementStepIdx: number,
  stepCount: number,
): void {
  const retYearCount = Math.floor((stepCount - retStart) / 12);
  const guardrail = buildGuardrailRuntimeContext(input, out1.cumCpi, retStart, retYearCount);
  if (guardrail === undefined) return;
  const state = initGuardrailState();
  for (let y = 0; y < retYearCount; y += 1) {
    const priorStep = retStart + y * 12 - 1;
    const poolNominal =
      priorStep >= 0 ? out1.preEnd[priorStep] + out1.postEnd[priorStep] : input.portfolioToday;
    const factor = evaluateKernelGuardrailYear(guardrail, state, y, poolNominal);
    if (factor !== 1) {
      const base = retStart + y * 12;
      for (let m = 0; m < 12; m += 1) {
        const i = base + m;
        // Only scale drawdown-phase months (retirement month 0 onward).
        if (i >= retirementStepIdx && i < stepCount) expense[i] *= factor;
      }
    }
  }
}

/** Per-year kernel guardrail step (guardrails). Mirrors the strategy engine's
 *  `evaluateGuardrailForYear` funded-ratio + settled-path net-need math using
 *  the shared pure helpers; kept local to the kernel path. */
function evaluateKernelGuardrailYear(
  guardrail: GuardrailRuntimeContext,
  state: ReturnType<typeof initGuardrailState>,
  y: number,
  poolNominal: number,
): number {
  const priorSettled = state.settledFactor;
  const n = guardrail.baselineNetNeedRealByYear.length;
  const remaining = Math.max(0, n - y);
  const netNeedReal = new Array<number>(remaining);
  const cumOnes = new Array<number>(remaining);
  for (let k = 0; k < remaining; k += 1) {
    const idx = y + k;
    const baseNet = guardrail.baselineNetNeedRealByYear[idx] ?? 0;
    const baseTotal = guardrail.baselineTotalRealByYear[idx] ?? 0;
    netNeedReal[k] = baseNet + baseTotal * (priorSettled - 1);
    cumOnes[k] = 1;
  }
  const ratio = fundedRatio({
    portfolioNominal: poolNominal,
    portfolioCumCpi: guardrail.cumCpiAtYearStart[y] ?? 1,
    netNeedNominalByYear: netNeedReal,
    cumCpiByYear: cumOnes,
    effectiveTaxRate: guardrail.effectiveTaxRate,
  });
  const baseTotalThisYear = guardrail.baselineTotalRealByYear[y] ?? 0;
  const essentialThisYear = guardrail.essentialRealByYear[y] ?? 0;
  const essentialFloorFactor =
    baseTotalThisYear > 0 ? essentialThisYear / baseTotalThisYear : 0;
  return applyGuardrailStep({ state, ratio, config: guardrail.config, essentialFloorFactor }).factor;
}

/** No-ledger proportional-kernel runner with the two-pass in-step tax
 *  correction. The strategy engine is per-account only, so a run with no ledger
 *  (edge / unit-test inputs) falls back here. Pass 1 estimates the per-year tax
 *  draw; pass 2 re-runs the kernel with that tax folded into expenses so the
 *  portfolio funds tax in-step (not an after-the-fact annotation
 *  subtraction). */
function runOnePathKernel(
  input: MonteCarloInput,
  seed: number,
  ctx: RunContext,
  captureRun = false,
): PathOutcome {
  const { step, stepCount, retirementStepIdx, nominalExpenseByYear, nominalMedicalExpenseByYear } =
    buildStepInputs(input, seed, ctx);
  const horizonYears = input.horizonYear - input.firstYear + 1;
  // Whole-year retirement boundary — the representative capture slices the
  // full-horizon withdrawal series here so it aligns with the cashflow band's
  // retirement-year-relative `perMonthWithdrawal` indexing.
  const retStart = Math.floor(retirementStepIdx / 12) * 12;

  // Pass 1: run the kernel to get a draft outcome so we can estimate
  // per-year tax draws before the second (definitive) pass.
  const out1 = runStepKernel(step);
  // Downturn guardrail MIRROR on the no-ledger kernel fallback.
  // Real MC runs carry a ledger and route through `runOnePathViaStrategyEngine`;
  // this branch only serves edge / unit-test no-ledger inputs, so the guardrail
  // is mirrored for consistency: scale `step.expense` per drawdown year from the
  // out1 year-START pool, then the tax passes below tax the adjusted
  // withdrawals. Gated on `enabled` — a disabled / absent config leaves `step`
  // untouched. Evaluated once (against out1) and re-used across
  // both passes because it mutates the shared `step.expense` array in place.
  applyGuardrailToKernelExpense(input, out1, step.expense, retStart, retirementStepIdx, stepCount);
  const taxState = newTaxPathState(
    input, out1, stepCount, horizonYears, nominalExpenseByYear, nominalMedicalExpenseByYear, ctx,
  );

  if (taxState) {
    // Populate taxState.taxDrawByYear from the pass-1 balances.
    const balPass1Nom: number[] = new Array(horizonYears);
    const balPass1Real: number[] = new Array(horizonYears);
    fillYearBalancesAndTax(out1, balPass1Nom, balPass1Real, stepCount, taxState);

    // Augment the expense series with the estimated monthly tax cost so pass 2
    // funds it in-step. `step.expense` is a fresh Float64Array per path — safe to mutate.
    for (let yearStart = Math.floor(retirementStepIdx / 12) * 12; yearStart < stepCount; yearStart += 12) {
      foldYearDrawIntoExpense(
        step.expense,
        step.income,
        Math.max(yearStart, retirementStepIdx),
        Math.min(yearStart + 12, stepCount),
        taxState.taxDrawByYear[yearStart / 12],
      );
    }

    // Pass 2: re-run the kernel with tax folded into expenses.
    const out2 = runStepKernel(step);

    // Reuse taxState (linked to out1) for the pass-2 balance fill.
    // out1.cumCpi === out2.cumCpi because CPI derives from step.cpiPct (unchanged).
    const balanceByYearNominal: number[] = new Array(horizonYears);
    const balanceByYearReal: number[] = new Array(horizonYears);
    // Reset taxState.taxDrawByYear so fillYearBalancesAndTax re-populates from out2 balances.
    // Note: applyTaxForYear inside reads taxState.out (out1) for per-account
    // classification — pass-2 tax figures are a 2nd-order approximation, consistent
    // with the "no within-year fixpoint" design. Balances come from out2 (correct).
    taxState.taxDrawByYear.fill(0);
    fillYearBalancesAndTax(out2, balanceByYearNominal, balanceByYearReal, stepCount, taxState);

    const depletionYear =
      out2.depletionStepIdx === -1
        ? null
        : input.firstYear + Math.floor(out2.depletionStepIdx / 12);

    const pathTaxAcc = taxState.acc;
    // Kernel symmetry: the no-ledger kernel has no absorbing-depletion
    // clamp, so `fillYearBalancesAndTax` stamps non-zero tax for strictly-post-
    // depletion years (SS / other income still flow through the per-year tax even
    // with a $0 portfolio). Zero those acc slots so the kernel path matches the
    // strategy path's absorbing invariant for the percentile tax bands. The
    // kernel indexes `acc` by the full-horizon year directly, so the depletion
    // full-horizon index is the strictly-greater bound; the depletion year keeps
    // its real tax. Low exposure (edge / unit-test no-ledger inputs only).
    if (depletionYear !== null) {
      const depletionYearIdx = depletionYear - input.firstYear;
      for (let y = depletionYearIdx + 1; y < horizonYears; y += 1) {
        pathTaxAcc.fedTax[y] = 0;
        pathTaxAcc.irmaa[y] = 0;
        pathTaxAcc.ptc[y] = 0;
        pathTaxAcc.credit[y] = 0;
        pathTaxAcc.etr[y] = 0;
        pathTaxAcc.net[y] = 0;
      }
    }
    return {
      balanceByYearNominal,
      balanceByYearReal,
      depletionYear,
      endingBalanceNominal: balanceByYearNominal[horizonYears - 1] ?? 0,
      endingBalanceReal: balanceByYearReal[horizonYears - 1] ?? 0,
      federalTaxByYear: pathTaxAcc.fedTax,
      irmaaSurchargeByYear: pathTaxAcc.irmaa,
      acaPtcSubsidyByYear: pathTaxAcc.ptc,
      acaCreditAppliedToPremiumsByYear: pathTaxAcc.credit,
      effectiveTaxRateByYear: pathTaxAcc.etr,
      netAfterTaxByYear: pathTaxAcc.net,
      ...(captureRun
        ? { representative: captureKernelRun(input, out2, stepCount, pathTaxAcc, retStart) }
        : {}),
    };
  }

  // No tax context — single pass, no adjustment needed.
  const balanceByYearNominal: number[] = new Array(horizonYears);
  const balanceByYearReal: number[] = new Array(horizonYears);
  fillYearBalancesAndTax(out1, balanceByYearNominal, balanceByYearReal, stepCount, null);
  const depletionYear =
    out1.depletionStepIdx === -1
      ? null
      : input.firstYear + Math.floor(out1.depletionStepIdx / 12);
  return {
    balanceByYearNominal,
    balanceByYearReal,
    depletionYear,
    endingBalanceNominal: balanceByYearNominal[horizonYears - 1] ?? 0,
    endingBalanceReal: balanceByYearReal[horizonYears - 1] ?? 0,
    ...(captureRun
      ? { representative: captureKernelRun(input, out1, stepCount, null, retStart) }
      : {}),
  };
}

/** Everything `runMonteCarlo`'s path loop accumulates, handed to the summary
 *  assembly. `taxAcc` is null when no `taxContext` was supplied.
 *  Exported for the sharding pipeline (`monte-carlo-shard.ts` Stage 2
 *  reconstructs this shape; the worker `assemble` handler passes it here). */
export interface PathLoopAccumulation {
  balancesByYearNominal: number[][];
  balancesByYearReal: number[][];
  taxAcc: McTaxAccumulators | null;
  endingNominal: number[];
  endingReal: number[];
  depletionYears: number[];
  /** Per-path depletion year in STRICT path-index order (`null` when the
   *  path never ran out) — unlike `depletionYears`, which lists only failed
   *  paths and is not index-aligned. Same whole-year derivation as the card
   *  stat (`firstYear + floor(stepIdx/12)`), so the representative tie-break
   *  can reconcile a chosen path's run-out age to its card percentile. */
  depletionYearByPath: (number | null)[];
  failureYearHistogram: number[];
  successes: number;
}

/** The seed for the path at index `pathIndex` — the same derivation the
 *  hot loop uses (`runMonteCarlo`'s per-path seed). Derivable from the index, so
 *  no extra hot-loop allocation is needed to recover it. */
export function seedForPathIndex(baseSeed: number, pathIndex: number): number {
  return (baseSeed + pathIndex * 0x9e3779b1) >>> 0;
}

/**
 * Fail-fast validation of the pre-computed per-run arrays, run BEFORE any path
 * work. Extracted so the sharded coordinator
 * (`run-monte-carlo-sharded.ts`) can gate malformed input on the main thread —
 * throwing synchronously and identically to the serial path — before fanning
 * any worker dispatch. Covers the 5 pre-loop checks ONLY; the
 * per-path `injectedReturns`/`injectedCpi` guards inside
 * `buildSampledOrInjectedTuples` are deliberately out of scope (never reachable
 * through the sharded/Provider caller).
 */
export function validateMonteCarloInput(input: MonteCarloInput): void {
  const horizon = input.horizonYear - input.firstYear + 1;
  // Guard pre-computed year arrays — a mismatch silently produces
  // wrong income (the `?? 0` fallback in buildHouseholdSeries masks the gap).
  if (input.ssByYear.length !== horizon) {
    throw new Error(
      `runMonteCarlo: ssByYear.length (${input.ssByYear.length}) !== horizon (${horizon})`,
    );
  }
  if (input.incomeByYear.length !== horizon) {
    throw new Error(
      `runMonteCarlo: incomeByYear.length (${input.incomeByYear.length}) !== horizon (${horizon})`,
    );
  }
  // The windowed per-month expense base
  // (and each bucket's per-month array) must equal the kernel stepCount — a
  // mismatch would silently read past/short the base. Throw, never `?? 0`.
  const stepCount = horizon * 12;
  if (input.monthlyExpenseBase.length !== stepCount) {
    throw new Error(
      `runMonteCarlo: monthlyExpenseBase.length (${input.monthlyExpenseBase.length}) !== stepCount (${stepCount})`,
    );
  }
  if (input.monthlyExpenseBucketsBase !== undefined) {
    for (const b of input.monthlyExpenseBucketsBase) {
      if (b.amount.length !== stepCount) {
        throw new Error(
          `runMonteCarlo: monthlyExpenseBucketsBase[${b.ratePct}].length (${b.amount.length}) !== stepCount (${stepCount})`,
        );
      }
    }
  }
  if (input.monthlyMedicalDemandBucketsBase !== undefined) {
    for (const b of input.monthlyMedicalDemandBucketsBase) {
      if (b.amount.length !== stepCount) {
        throw new Error(
          `runMonteCarlo: monthlyMedicalDemandBucketsBase[${b.ratePct}].length (${b.amount.length}) !== stepCount (${stepCount})`,
        );
      }
    }
  }
  // The modeled Medical expenses base (and each bucket) caps the credit applied
  // to premiums; a short array would silently read as zero and drop the cap.
  if (
    input.monthlyMedicalExpenseBase !== undefined &&
    input.monthlyMedicalExpenseBase.length !== stepCount
  ) {
    throw new Error(
      `runMonteCarlo: monthlyMedicalExpenseBase.length (${input.monthlyMedicalExpenseBase.length}) !== stepCount (${stepCount})`,
    );
  }
  if (input.monthlyMedicalExpenseBucketsBase !== undefined) {
    for (const b of input.monthlyMedicalExpenseBucketsBase) {
      if (b.amount.length !== stepCount) {
        throw new Error(
          `runMonteCarlo: monthlyMedicalExpenseBucketsBase[${b.ratePct}].length (${b.amount.length}) !== stepCount (${stepCount})`,
        );
      }
    }
  }
}

export function runMonteCarlo(input: MonteCarloInput): MonteCarloSummary {
  validateMonteCarloInput(input);
  // Seed-independent per-run state (shared legacy-zero placeholder array +
  // hoisted CPI-shift) reused across every path and the overlay.
  const runCtx = buildRunContext(input);

  // Serial run drives the SAME two-stage pipeline the sharded
  // coordinator uses — a single `[0, pathCount)` range → merge → reconstruct →
  // summary. Structurally serial ≡ 1-shard, so a sharded run is bit-identical.
  const range = runPathRange(input, runCtx, 0, input.pathCount, input.onProgress);
  const merged = mergePathRanges([range], input);
  const acc = assembleAccumulationFromTyped(merged, input);
  return assembleMonteCarloSummary(input, runCtx, acc);
}

/** Re-exported so callers don't reach into `projection-engine` for the
 *  default strategy id when building MC inputs. */
