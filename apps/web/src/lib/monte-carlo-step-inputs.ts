/** Per-run / per-path step-input assembly for the Monte Carlo runner: resolves each path's CPI, return, expense and income series
 * and its per-account kernel inputs. */
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
import type { RunContext } from './monte-carlo.js';

export interface BuildStepInputsResult {
  readonly step: StepInputs;
  readonly stepCount: number;
  readonly retirementStepIdx: number;
  /** The path's full-horizon cumulative CPI factor by step; read here because the kernel `StepOutcome.cumCpi` is truncated at the retirement boundary on the strategy path. */
  readonly cumCpi: Float64Array;
  readonly nominalExpenseByYear: Float64Array;
  /** Per-step nominal HSA medical demand in integer cents: the per-path-inflated `isMedical` subset of the expense series. */
  readonly medicalDemandCents: Float64Array;
  readonly nominalMedicalExpenseByYear: Float64Array;
}

/** Per-year sum of `base[i]` over each year's months; computed once per run so every path's products keep bit-identical operands. */
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
  // `primaryRetirementMonth0` shifts the first drawdown step within the retirement year so a December retiree does not over-count ~11 months of spending.
  const retirementStepIdx = Math.max(
    0,
    (input.retirementYear - input.firstYear) * 12 + (input.primaryRetirementMonth0 ?? 0),
  );
  const tuples = buildSampledOrInjectedTuples(input, seed, stepCount, ctx.cpiShiftMonthly);
  const series = buildHouseholdSeries(input, tuples.cpiPct, stepCount, retirementStepIdx, ctx);
  // Accounts are cloned per path inside `buildPerAccountStepInputs`; mutating the caller's ledger would compound across paths.
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

function assembleStepInputs(args: {
  stepCount: number;
  legacyZero: Float64Array;
  cpiPct: Float64Array;
  deposit: Float64Array;
  expense: Float64Array;
  income: Float64Array;
  retirementStepIdx: number;
  accounts: KernelAccount[];
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

/**
 * CPI bootstrap centering shift, `(scenarioAnnual - historicalAnnual) / 12`; seed-independent, so computed once per run.
 * It moves only CPI: a scenario inflation rate above the historical mean (about 3.5% a year) lowers real returns, below it raises them.
 */
export function cpiShiftMonthlyFor(input: MonteCarloInput): number {
  const base =
    input.scenarioInflationPct === undefined
      ? 0
      : (input.scenarioInflationPct - historicalMonthlySummary().cpi.arithMeanPct * 12) /
          12;
  // The "Higher inflation" stress adds a flat percentage-point bump on the same monthly mean-shift (percent units, `/12`); guarded so 0 keeps the parity fixtures byte-identical.
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
  // Tuples are drawn as consecutive-month blocks (stationary bootstrap) so volatility clustering carries across months.
  const rng = makeRng(seed);
  const columns = historicalColumns();
  const sampledIdx = drawMonthlyIndices(rng, stepCount, input.meanBlockLength);
  // The shift is additive per month, so residual variance, skew and autocorrelation carry over and only the long-run mean moves.
  for (let i = 0; i < stepCount; i += 1) {
    cpiPct[i] = columns.cpiPct[sampledIdx[i]] + cpiShiftMonthly;
  }
  return { cpiPct, sampledIdx, columns, injectedReturnPct: null };
}

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
  nominalExpenseByYear: Float64Array;
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
  const monthlyExpenseBase = input.monthlyExpenseBase;
  // Per-rate bucket: grows by the sampled CPI plus the mean-shift `(bucketRate - scenarioInflationPct)/12` on a local `cpiPct` copy (percent units, no `/100`).
  // The factor is full-horizon cumulative (1 at today, never reset at window open); windowing enters only through the per-month base. Shared `cpiPct`/`cumCpi` are never mutated.
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
  // Year-end nominal: year-sum of the base times the year-end cumCpi (per bucket when bucketed). The year-sum half is seed-independent, hoisted into `ctx.baseExpenseYearSums` / `ctx.bucketBaseYearSums`.
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
  // CPI-scale SS and tracksInflation income per path; `deterministicCumCpi` (seed-independent, hoisted onto `RunContext`) un-anchors the precomputed nominal values before re-anchoring to the path's CPI. Non-COLA income keeps the precomputed nominal.
  const deterministicCumCpi = ctx.deterministicCumCpi;
  // HSA reserve: medical demand inflates at the medical rate's mean-shift, like the matching expense bucket, so it stays a subset of inflated expense; converted to integer cents.
  const medicalDemandBase = input.monthlyMedicalDemandBase;
  const medicalBuckets = input.monthlyMedicalDemandBucketsBase;
  const medicalDemandCents = new Float64Array(stepCount);
  if (medicalBuckets && medicalBuckets.length > 0 && ctx.medicalBucketShiftPct) {
    // Each medical bucket inflates at its own rate's mean-shift, then sums, so demand stays a subset of medical expense when categories carry different rates; the shift is hoisted onto `ctx.medicalBucketShiftPct`.
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
      let monthExpense = 0;
      for (let b = 0; b < buckets.length; b += 1) {
        monthExpense += buckets[b].amount[i] * bucketCumCpi[b][i];
      }
      expense[i] = monthExpense;
    } else {
      expense[i] = monthlyExpenseBase[i] * cumCpi[i];
    }
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

function buildPerAccountStepInputs(args: {
  input: MonteCarloInput;
  stepCount: number;
  retirementStepIdx: number;
  sampledIdx: Int32Array | null;
  columns: HistoricalColumns | null;
  injectedReturnPct: Float64Array | null;
  deposit: Float64Array;
  cumCpi: Float64Array;
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
    // Fee/return stress shocks ride on the sampled return series only (skipped in CBP-fixed and injected-parity modes).
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
