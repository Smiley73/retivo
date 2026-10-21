/**
 * Monte-Carlo per-run / per-path step-input assembly, split out of
 * `monte-carlo.ts`: the
 * `(input, seed, ctx: RunContext) → BuildStepInputsResult` boundary that
 * resolves each path's per-step CPI / return / expense / income series plus its
 * per-account kernel inputs. Called at the top of every path.
 *
 * `monte-carlo.ts` imports `buildStepInputs` / `computeYearSums` /
 * `cpiShiftMonthlyFor` back as values while this module imports `RunContext`
 * as a TYPE — an inert import cycle: all cross-module references are
 * call-site bindings (never module-eval-time), same shape as the
 * `monte-carlo-shard.ts` / `monte-carlo-summary.ts` exceptions (see
 * `.dependency-cruiser.cjs`).
 */
import {
  drawMonthlyIndices,
  historicalColumns,
  historicalMonthlySummary,
  type HistoricalColumns,
} from './projection-engine/historical.js';
import type { KernelAccount, StepInputs } from './projection-engine/kernel.js';
import { makeRng } from './sfc32.js';
import {
  buildPerAccountKernelInputs,
  routeHouseholdLevelEvents,
} from './monte-carlo-per-account.js';
import { DEFAULT_INFLATION_PCT } from '../db/types.js';
import type { MonteCarloInput } from './monte-carlo-types.js';
// Inert cycle: `RunContext` is type-only, erased at compile time.
import type { RunContext } from './monte-carlo.js';

export interface BuildStepInputsResult {
  readonly step: StepInputs;
  readonly stepCount: number;
  readonly retirementStepIdx: number;
  /** The path's own full-horizon cumulative CPI factor by step
   *  (`series.cumCpi`). Exposed so the strategy path can read
   *  it directly instead of from the kernel `StepOutcome` — the kernel is
   *  truncated at the retirement boundary there, so its `cumCpi` no longer
   *  spans the full horizon, but this one always does (identical values by
   *  construction: both are the same `cum *= 1 + cpiPct[i]/100` recurrence over
   *  the same per-step `cpiPct`). */
  readonly cumCpi: Float64Array;
  /** Per-year windowed nominal expense at the year-END step. ALWAYS present —
   *  the tax path reads it. */
  readonly nominalExpenseByYear: Float64Array;
  /** Per-step nominal HSA medical-demand (integer cents) — the
   *  per-path-inflated `isMedical` subset of the expense series, fed to the
   *  named-strategy engine's medical-first HSA pass. All-zero when no
   *  `isMedical` category drives the base. */
  readonly medicalDemandCents: Float64Array;
  /** Per-year modeled Medical expenses (every `isMedical` row) at the year-END
   *  step, nominal dollars: the per-path-inflated twin of `nominalExpenseByYear`
   *  for the medical subset. Caps the ACA credit applied to premiums. All-zero
   *  when no `isMedical` category drives the base. */
  readonly nominalMedicalExpenseByYear: Float64Array;
}

/** Helper: per-year sum of `base[i]` over that year's months
 *  (`firstStep = y*12` through `lastStep = min(stepCount-1, (y+1)*12-1)`) —
 *  computed once per run and shared by every path, so each product's operands
 *  stay bit-identical. */
export function computeYearSums(
  base: readonly number[],
  stepCount: number,
  horizonYears: number,
): Float64Array {
  const sums = new Float64Array(horizonYears);
  for (let y = 0; y < horizonYears; y += 1) {
    const firstStep = y * 12;
    const lastStep = Math.min(stepCount - 1, (y + 1) * 12 - 1);
    let sum = 0;
    for (let i = firstStep; i <= lastStep; i += 1) sum += base[i];
    sums[y] = sum;
  }
  return sums;
}

export function buildStepInputs(
  input: MonteCarloInput,
  seed: number,
  ctx: RunContext,
): BuildStepInputsResult {
  const stepCount = ctx.stepCount;
  // Month-precise retirement snap. `primaryRetirementMonth0` (0 = Jan,
  // 11 = Dec) shifts the first drawdown step within the retirement year so a
  // December retiree does not over-count ~11 months of retirement-year
  // spending. Absent → January-of-retirementYear boundary snap.
  const retirementStepIdx = Math.max(
    0,
    (input.retirementYear - input.firstYear) * 12 + (input.primaryRetirementMonth0 ?? 0),
  );
  const tuples = buildSampledOrInjectedTuples(input, seed, stepCount, ctx.cpiShiftMonthly);
  const series = buildHouseholdSeries(input, tuples.cpiPct, stepCount, retirementStepIdx, ctx);
  // Account arrays are CLONED per path inside `buildPerAccountStepInputs`
  // — mutating the caller's ledger from event-routing here would
  // compound across paths and turn a 200-path sweep into a 200×
  // contribution multiplier. `series.cumCpi` is the path's own cumulative
  // CPI factor by step; tracks-inflation contributions are scaled per path
  // (re-anchored at `todayMonthIndex` inside `scaleTracksInflationContrib`)
  // so they stay flat-real on every inflation path.
  const accounts = buildPerAccountStepInputs({
    input,
    stepCount,
    retirementStepIdx,
    sampledIdx: tuples.sampledIdx,
    columns: tuples.columns,
    injectedReturnPct: tuples.injectedReturnPct,
    deposit: series.deposit,
    cumCpi: series.cumCpi,
    todayMonthIndex: input.todayMonthIndex ?? 0,
  });
  const step = assembleStepInputs({
    stepCount,
    legacyZero: ctx.legacyZero,
    cpiPct: tuples.cpiPct,
    deposit: series.deposit,
    expense: series.expense,
    income: series.income,
    retirementStepIdx,
    accounts,
    medicalDemandCents: series.medicalDemandCents,
  });
  return {
    step,
    stepCount,
    retirementStepIdx,
    nominalExpenseByYear: series.nominalExpenseByYear,
    medicalDemandCents: series.medicalDemandCents,
    nominalMedicalExpenseByYear: nominalMedicalExpenseByYear(input, tuples.cpiPct, stepCount),
    cumCpi: series.cumCpi,
  };
}

/**
 * Per-year modeled Medical expenses (every `isMedical` row) at the year-END
 * step: each year's today's-dollar sum times the medical rate's cumulative CPI
 * (the same mean-shift `(rate − general)/12` the HSA demand and the expense
 * buckets use), summed per bucket when the medical categories span several
 * rates. Mirrors how `nominalExpenseByYear` is built, so the cap and the spending
 * it caps are inflated the same way.
 */
function nominalMedicalExpenseByYear(
  input: MonteCarloInput,
  cpiPct: Float64Array,
  stepCount: number,
): Float64Array {
  const horizonYears = Math.ceil(stepCount / 12);
  const out = new Float64Array(horizonYears);
  const generalRatePct = input.scenarioInflationPct ?? DEFAULT_INFLATION_PCT;
  const buckets = input.monthlyMedicalExpenseBucketsBase;
  const series: ReadonlyArray<{ ratePct: number; amount: readonly number[] }> =
    buckets !== undefined && buckets.length > 0
      ? buckets
      : input.monthlyMedicalExpenseBase !== undefined
        ? [{
            ratePct: input.medicalExpenseRatePct ?? generalRatePct,
            amount: input.monthlyMedicalExpenseBase,
          }]
        : [];
  for (const { ratePct, amount } of series) {
    const shiftPct = (ratePct - generalRatePct) / 12;
    let cum = 1;
    let yearSum = 0;
    for (let i = 0; i < stepCount; i += 1) {
      cum *= 1 + (cpiPct[i] + shiftPct) / 100;
      yearSum += amount[i] ?? 0;
      if ((i + 1) % 12 === 0 || i === stepCount - 1) {
        out[Math.floor(i / 12)] += yearSum * cum;
        yearSum = 0;
      }
    }
  }
  return out;
}

/** Pack the resolved per-step arrays + per-account ledger into the
 *  kernel-facing `StepInputs`. Legacy single-pool fields are passed as
 *  zero-filled placeholders; the per-account branch ignores them. The
 *  read-only `legacyZero` backing array is shared across all paths when the
 *  per-account branch will run; for an empty ledger (single-pool branch reads
 *  these) it arrives length-0 and a correctly-sized fresh zero array is
 *  allocated here, preserving the all-zero status quo. */
function assembleStepInputs(args: {
  stepCount: number;
  legacyZero: Float64Array;
  cpiPct: Float64Array;
  deposit: Float64Array;
  expense: Float64Array;
  income: Float64Array;
  retirementStepIdx: number;
  accounts: KernelAccount[];
  /** Per-step HSA medical-demand (integer cents) for the kernel's
   *  medical-first HSA pass. */
  medicalDemandCents: Float64Array;
}): StepInputs {
  const legacyZero =
    args.legacyZero.length === args.stepCount
      ? args.legacyZero
      : new Float64Array(args.stepCount);
  return {
    mainReturnPct: legacyZero,
    cpiPct: args.cpiPct,
    contribPre: legacyZero,
    contribPost: legacyZero,
    deposit: args.deposit,
    expense: args.expense,
    income: args.income,
    retirementStepIdx: args.retirementStepIdx,
    initialPre: 0,
    initialPost: 0,
    accounts: args.accounts,
    medicalDemandCents: args.medicalDemandCents,
  };
}

/** Resolve the per-step CPI series + per-account return source: either
 *  the path-sampled historical tuple set (sampling mode), or a caller-
 *  supplied injected return series (cross-engine-pin parity mode). */
/** CPI bootstrap centering shift — seed-independent, so computed once per run
 *  and threaded through `buildSampledOrInjectedTuples`. shift_monthly =
 *  (scenarioAnnual − historicalAnnual) / 12; see the per-month application below
 *  for the variance/skew/autocorrelation-preserving rationale. */
// The shift moves only CPI; the sampled nominal returns are untouched. A
// scenario inflation rate ABOVE the historical sample mean (about 3.5% a year)
// raises simulated CPI and so LOWERS real (inflation-adjusted) returns; a rate
// BELOW it lowers CPI and RAISES real returns; at the mean the shift is about
// zero. The methodology modal's "Inflation framing trims real returns" lean
// (MonteCarloMethodologyModal.tsx) therefore holds only above the mean.
export function cpiShiftMonthlyFor(input: MonteCarloInput): number {
  const base =
    input.scenarioInflationPct === undefined
      ? 0
      : (input.scenarioInflationPct - historicalMonthlySummary().cpi.arithMeanPct * 12) /
          12;
  // The "Higher inflation" stress adds a flat
  // percentage-point bump to the realized CPI. It rides on the SAME monthly
  // mean-shift mechanism (percent units, `/12`) so the sampled residuals — and
  // thus the random paths — are untouched. Absent / 0 → the exact unshifted
  // value (guarded so the frozen parity fixtures stay byte-identical).
  const shockPct = input.inflationShockPct ?? 0;
  return shockPct === 0 ? base : base + shockPct / 12;
}

function buildSampledOrInjectedTuples(
  input: MonteCarloInput,
  seed: number,
  stepCount: number,
  cpiShiftMonthly: number,
): {
  cpiPct: Float64Array;
  sampledIdx: Int32Array | null;
  columns: HistoricalColumns | null;
  injectedReturnPct: Float64Array | null;
} {
  const cpiPct = new Float64Array(stepCount);
  const usingInjected =
    input.injectedReturns !== undefined || input.injectedCpi !== undefined;
  if (usingInjected) {
    if (input.injectedReturns === undefined || input.injectedCpi === undefined) {
      throw new Error(
        'monte-carlo: injectedReturns and injectedCpi must both be supplied together',
      );
    }
    if (
      input.injectedReturns.length !== stepCount ||
      input.injectedCpi.length !== stepCount
    ) {
      throw new Error(
        `monte-carlo: injected arrays must have length ${stepCount}, ` +
          `got returns=${input.injectedReturns.length} cpi=${input.injectedCpi.length}`,
      );
    }
    cpiPct.set(input.injectedCpi);
    return { cpiPct, sampledIdx: null, columns: null, injectedReturnPct: input.injectedReturns };
  }
  // One historical tuple per simulated month per path. The same
  // tuple is applied to each account's `assetMix` to produce its
  // monthly return. The tuples are drawn as consecutive-month
  // blocks (stationary bootstrap, mean L = `input.meanBlockLength` ??
  // DEFAULT_MEAN_BLOCK_LENGTH) so volatility clustering carries across months.
  const rng = makeRng(seed);
  // Struct-of-arrays: draw ROW INDICES (identical RNG sequence to `drawMonthlySeries`)
  // and read the packed columns instead of per-row objects.
  const columns = historicalColumns();
  const sampledIdx = drawMonthlyIndices(rng, stepCount, input.meanBlockLength);
  // Center the CPI bootstrap mean on scenario inflation. The shift is
  // applied additively per-month so the historical residuals (variance, skew,
  // autocorrelation within each sampled month) carry over — only the long-run
  // mean moves. The shift itself is seed-independent (`cpiShiftMonthlyFor`),
  // computed once per run and threaded in. `columns.cpiPct[idx[i]]` reads the
  // SAME double `sampledTuple[i].cpiPct` did.
  for (let i = 0; i < stepCount; i += 1) {
    cpiPct[i] = columns.cpiPct[sampledIdx[i]] + cpiShiftMonthly;
  }
  return { cpiPct, sampledIdx, columns, injectedReturnPct: null };
}

/** Inflate the household-level expense / income series from today's-
 *  dollar scalars. Inflation base = today (firstYear); inputs
 *  inflate forward through accumulation + drawdown so the retirement-
 *  year cash flow matches the deterministic engine. The deposit
 *  series is initialised zero — household-level events route into it
 *  via `buildPerAccountStepInputs`. */
function buildHouseholdSeries(
  input: MonteCarloInput,
  cpiPct: Float64Array,
  stepCount: number,
  retirementStepIdx: number,
  ctx: RunContext,
): {
  expense: Float64Array;
  income: Float64Array;
  deposit: Float64Array;
  cumCpi: Float64Array;
  /** Per-year (offset from `firstYear`) nominal windowed expense at the
   *  year-END step. ALWAYS built — the
   *  tax fallback drawdown + `netAfterTax` display read it instead of a flat
   *  `annualExpense × cumCpi[endStep]`. Scalar path: `sum(monthlyExpenseBase
   *  [months∈year]) × cumCpi[endStep]`; bucketed path: `Σ_b (sum(bucketBase_b
   *  [months∈year]) × bucketCumCpi_b[endStep])` (per-category year-sum × that
   *  bucket's year-END mean-shifted factor). Equals the lifetime
   *  `annualExpense × cumCpi[endStep]` for an all-lifetime expense (year-sum of
   *  today's-base = annual base). */
  nominalExpenseByYear: Float64Array;
  /** Per-step nominal HSA medical-demand (integer cents) — the
   *  per-path-inflated `isMedical` subset of the expense series. All-zero when
   *  no `isMedical` category drives the base. */
  medicalDemandCents: Float64Array;
} {
  const expense = new Float64Array(stepCount);
  const income = new Float64Array(stepCount);
  const deposit = new Float64Array(stepCount);
  const cumCpi = new Float64Array(stepCount);
  let cum = 1;
  for (let i = 0; i < stepCount; i += 1) {
    cum *= 1 + cpiPct[i] / 100;
    cumCpi[i] = cum;
  }
  // The windowed today's-dollar per-month
  // base charges each expense only in its active window (0 outside). Recurring
  // → run-rate ÷ 12 per active month; one-offs → full literal amount in the
  // spike month (already encoded in `monthlyExpenseBase`).
  const monthlyExpenseBase = input.monthlyExpenseBase;
  // Windowing × per-rate medical inflation: when per-effective-rate
  // per-month buckets are supplied, each bucket's per-month base grows by the
  // shared sampled CPI PLUS a percentage-point additive monthly mean-shift
  // `(bucketRate − scenarioInflationPct)/12` added to a LOCAL `cpiPct` copy
  // (mirrors `cpiShiftMonthlyFor`, percent units, no `/100`). The mean-shift
  // factor is the FULL-HORIZON cumulative (cumCpi = 1 at today, NEVER reset at
  // window open) — windowing enters ONLY through the per-month base, so a
  // late-opening Medical window carries the full-horizon general+2pp
  // differential. The shared `cpiPct` / `cumCpi` are NEVER mutated.
  const buckets = input.monthlyExpenseBucketsBase;
  const generalRatePct = input.scenarioInflationPct ?? DEFAULT_INFLATION_PCT;
  const bucketCumCpi: Float64Array[] | null = buckets
    ? buckets.map((b) => {
        const extraShiftPct = (b.ratePct - generalRatePct) / 12;
        const arr = new Float64Array(stepCount);
        let bCum = 1;
        for (let i = 0; i < stepCount; i += 1) {
          bCum *= 1 + (cpiPct[i] + extraShiftPct) / 100;
          arr[i] = bCum;
        }
        return arr;
      })
    : null;
  // Per-year nominal at the year-END step (tax fallback/display).
  // ALWAYS built (windowed). Scalar: year-sum of `monthlyExpenseBase` × year-END
  // cumCpi; bucketed: Σ_b (per-bucket year-sum × that bucket's year-END factor).
  // The today's-dollar year-SUM half of each product is seed-
  // independent, hoisted into `ctx.baseExpenseYearSums` / `ctx.bucketBaseYearSums`
  // — only the per-path CPI factor is computed here.
  const horizonYears = Math.ceil(stepCount / 12);
  const nominalExpenseByYear = new Float64Array(horizonYears);
  for (let y = 0; y < horizonYears; y += 1) {
    const endStep = Math.min(stepCount - 1, (y + 1) * 12 - 1);
    let yearNominal = 0;
    if (buckets && bucketCumCpi && ctx.bucketBaseYearSums) {
      for (let b = 0; b < buckets.length; b += 1) {
        yearNominal += ctx.bucketBaseYearSums[b][y] * bucketCumCpi[b][endStep];
      }
    } else {
      yearNominal = ctx.baseExpenseYearSums[y] * cumCpi[endStep];
    }
    nominalExpenseByYear[y] = yearNominal;
  }
  // CPI-scale SS + tracksInflation income streams per-path so the
  // simulation reflects each path's realized inflation on COLAed benefits.
  // Non-COLA income keeps the pre-computed nominal.
  // `deterministicCumCpi[i]` = the running product of the scenario's flat
  // monthly inflation rate — used to un-anchor the nominal pre-computed
  // values and re-anchor to the path's sampled CPI. Seed-independent,
  // hoisted onto `RunContext` and computed once per run instead of once per
  // path.
  const deterministicCumCpi = ctx.deterministicCumCpi;
  // HSA withdrawal reserve: inflate the today's-dollar medical-demand
  // base per path by the medical effective rate's CPI (the SAME mean-shift the
  // matching expense bucket uses, `(medicalRate − general)/12` added to the
  // shared sampled `cpiPct`) so the nominal medical demand stays a SUBSET of the
  // inflated expense. Converted to integer cents (the engine input contract).
  // All-zero when no `isMedical` category drives the base.
  const medicalDemandBase = input.monthlyMedicalDemandBase;
  const medicalBuckets = input.monthlyMedicalDemandBucketsBase;
  const medicalDemandCents = new Float64Array(stepCount);
  if (medicalBuckets && medicalBuckets.length > 0 && ctx.medicalBucketShiftPct) {
    // Per-rate medical buckets — inflate EACH medical sub-series at its
    // own effective rate's mean-shift, then sum. `Σ_b` of the inflated medical
    // buckets equals the sum of the inflated per-category medical amounts, so
    // the demand stays a strict subset of the inflated medical expense even when
    // two medical categories carry different rates. Mirrors `bucketCumCpi`.
    // The per-bucket shift is seed-independent — hoisted onto
    // `ctx.medicalBucketShiftPct` instead of recomputed every step.
    const medCum = medicalBuckets.map(() => 1);
    for (let i = 0; i < stepCount; i += 1) {
      let monthDemand = 0;
      for (let b = 0; b < medicalBuckets.length; b += 1) {
        medCum[b] *= 1 + (cpiPct[i] + ctx.medicalBucketShiftPct[b]) / 100;
        monthDemand += (medicalBuckets[b].amount[i] ?? 0) * medCum[b];
      }
      medicalDemandCents[i] = Math.round(monthDemand * 100);
    }
  } else if (medicalDemandBase) {
    const medicalRatePct = input.medicalDemandRatePct ?? generalRatePct;
    const medicalShiftPct = (medicalRatePct - generalRatePct) / 12;
    let medCum = 1;
    for (let i = 0; i < stepCount; i += 1) {
      medCum *= 1 + (cpiPct[i] + medicalShiftPct) / 100;
      medicalDemandCents[i] = Math.round((medicalDemandBase[i] ?? 0) * medCum * 100);
    }
  }
  for (let i = retirementStepIdx; i < stepCount; i += 1) {
    const yearOffset = Math.floor(i / 12);
    if (buckets && bucketCumCpi) {
      // Bucketed: sum each bucket's per-month windowed base grown by ITS
      // effective rate (windowing already encoded in the per-month base).
      let monthExpense = 0;
      for (let b = 0; b < buckets.length; b += 1) {
        monthExpense += buckets[b].amount[i] * bucketCumCpi[b][i];
      }
      expense[i] = monthExpense;
    } else {
      expense[i] = monthlyExpenseBase[i] * cumCpi[i];
    }
    // CPI ratio scales SS + inflation-tracked income from the
    // scenario-flat nominal to the path-sampled nominal.
    const cpiRatio = cumCpi[i] / deterministicCumCpi[i];
    const ssNominal = (input.ssByYear[yearOffset] ?? 0) / 12;
    const tracksInflNominal = input.tracksInflationIncomeByYear
      ? (input.tracksInflationIncomeByYear[yearOffset] ?? 0) / 12
      : 0;
    const flatNominal =
      ((input.incomeByYear[yearOffset] ?? 0) -
        (input.tracksInflationIncomeByYear
          ? (input.tracksInflationIncomeByYear[yearOffset] ?? 0)
          : 0)) /
      12;
    income[i] = ssNominal * cpiRatio + tracksInflNominal * cpiRatio + flatNominal;
  }
  return { expense, income, deposit, cumCpi, nominalExpenseByYear, medicalDemandCents };
}

/** Build the per-account `KernelAccount` set + route any household-
 *  level dated events (events without a ledger-resolvable
 *  `targetAccountId`) into either the household deposit series or
 *  per-account `contribPost` arrays via the sibling helper module. */
function buildPerAccountStepInputs(args: {
  input: MonteCarloInput;
  stepCount: number;
  retirementStepIdx: number;
  sampledIdx: Int32Array | null;
  columns: HistoricalColumns | null;
  injectedReturnPct: Float64Array | null;
  deposit: Float64Array;
  /** Path's own cumulative CPI factor by step. Scales the today's-dollars
   *  base contribution of tracks-inflation accounts per path so it stays
   *  flat-real (the accurate per-path site). */
  cumCpi: Float64Array;
  /** Today-anchor month (0..11). The scaled contribution holds its today's-
   *  dollars value at step `todayMonthIndex` (matches the deterministic
   *  `asOfMonth` anchor). */
  todayMonthIndex: number;
}): KernelAccount[] {
  const accounts = buildPerAccountKernelInputs({
    ledger: args.input.accountMcLedger,
    stepCount: args.stepCount,
    sampledIdx: args.sampledIdx,
    columns: args.columns,
    injectedReturnPct: args.injectedReturnPct,
    cumCpi: args.cumCpi,
    todayMonthIndex: args.todayMonthIndex,
    // The fee/return market-stress shocks ride on the sampled return
    // series only (skipped in CBP-fixed / injected-parity modes).
    annualInvestmentCostPct: args.input.annualInvestmentCostPct ?? 0,
    ...(args.input.returnShock ? { returnShock: args.input.returnShock } : {}),
  });
  if (args.input.events) {
    routeHouseholdLevelEvents({
      events: args.input.events,
      ledger: args.input.accountMcLedger,
      accounts,
      stepCount: args.stepCount,
      retirementStepIdx: args.retirementStepIdx,
      deposit: args.deposit,
    });
  }
  return accounts;
}
