import { describe, expect, it } from 'vitest';
import {
  ENGINE_VERSION,
  accountYearStates,
  buildRunContext,
  runMonteCarlo,
  runOnePath,
  seedForPathIndex,
  type McTaxContext,
  type McQcdContext,
  type MonteCarloAccountLedger,
  type MonteCarloInput,
  type MonteCarloSummary,
  type PathLoopAccumulation,
} from './monte-carlo.js';
import { RMD_OVERFLOW_CASH_ACCOUNT_ID } from './drawdown-engine-per-account-strategy-helpers';
import { assembleMonteCarloSummary, pickBandIndex } from './monte-carlo-summary.js';
import { advanceAfterTaxBase, buildYearClassification } from './monte-carlo-tax.js';
import { runBalanceProjectionMc } from './balance-projection-runner.js';
import { CASH1_FLOOR, flooredFillArgs } from '../test/fixtures/fill-floor-household';
import { makeMonthlyExpenseBase } from './monte-carlo.test-helpers.js';
import type { StepOutcome } from './projection-engine/kernel.js';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from './tax-integration.js';
import { netNeedStrategy } from './projection-engine/withdrawal-strategies.js';
import { makeRng } from './sfc32.js';
import { HISTORICAL_MONTHLY, drawMonthlySeries } from './projection-engine/historical.js';
import {
  absReturnAutocorr,
  correlationMatrix,
  drawdownRunFrequency,
} from './projection-engine/sampler-stats.js';
import {
  RECORDER_SERIES_LEN,
  buildRecorderInput,
  concatSampledPaths,
} from './projection-engine/sampler-stats-fixtures.js';
import samplerStats from './projection-engine/__fixtures__/sampler-stats.json';
import { contributionGrowthFactor } from './contribution-growth.js';

function buildLedger(args: {
  primaryPortfolio: number;
  secondaryPortfolio: number;
  annualPlannedContribution: number;
  stepCount: number;
  retirementStepIdx: number;
}): MonteCarloAccountLedger[] {
  const { stepCount, retirementStepIdx } = args;
  const monthlyContribPost = (args.annualPlannedContribution * 0.6) / 12;
  const monthlyContribPre = (args.annualPlannedContribution * 0.4) / 12;
  const contribPrePrimary = new Float64Array(stepCount);
  const contribPostPrimary = new Float64Array(stepCount);
  const contribPreSecondary = new Float64Array(stepCount);
  const contribPostSecondary = new Float64Array(stepCount);
  for (let i = 0; i < Math.min(retirementStepIdx, stepCount); i += 1) {
    contribPostPrimary[i] = monthlyContribPost;
    contribPreSecondary[i] = monthlyContribPre;
  }
  return [
    {
      id: 'primary',
      initialPre: 0,
      initialPost: args.primaryPortfolio,
      contribPre: contribPrePrimary,
      contribPost: contribPostPrimary,
      deposit: new Float64Array(stepCount),
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
    },
    {
      id: 'secondary',
      initialPre: args.secondaryPortfolio,
      initialPost: 0,
      contribPre: contribPreSecondary,
      contribPost: contribPostSecondary,
      deposit: new Float64Array(stepCount),
      assetMix: { stocksPct: 40, bondsPct: 55, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
    },
  ];
}

const BASE_STEPS = (2056 - 2026 + 1) * 12;
const BASE_RETIREMENT_STEP = (2046 - 2026) * 12;

function buildYearArrays(args: {
  firstYear: number;
  horizonYear: number;
  annualSs: number;
  ssStartYear: number;
  annualOtherIncome?: number;
}): { ssByYear: number[]; incomeByYear: number[] } {
  const years = args.horizonYear - args.firstYear + 1;
  const ssByYear = Array.from({ length: years }, (_, i) =>
    args.firstYear + i >= args.ssStartYear ? args.annualSs : 0,
  );
  const income = args.annualOtherIncome ?? 0;
  const incomeByYear = Array.from({ length: years }, () => income);
  return { ssByYear, incomeByYear };
}

const baseInput: MonteCarloInput = {
  portfolioToday: 500_000,
  accountMcLedger: buildLedger({
    primaryPortfolio: 300_000,
    secondaryPortfolio: 200_000,
    annualPlannedContribution: 20_000,
    stepCount: BASE_STEPS,
    retirementStepIdx: BASE_RETIREMENT_STEP,
  }),
  annualContribution: 20_000,
  firstYear: 2026,
  retirementYear: 2046,
  horizonYear: 2056,
  monthlyExpenseBase: makeMonthlyExpenseBase(80_000, BASE_STEPS),
  ...buildYearArrays({ firstYear: 2026, horizonYear: 2056, annualSs: 30_000, ssStartYear: 2046 }),
  pathCount: 200,
  seed: 12345,
  strategyKind: 'taxEfficient',
};

// Late-calendar-year cases run on the original 61-year horizon instead of the 31-year base fixture.
const LONG_HORIZON_YEAR = 2086;
const LONG_YEARS = LONG_HORIZON_YEAR - 2026 + 1;
const LONG_STEPS = LONG_YEARS * 12;
const longLedger = (): MonteCarloAccountLedger[] =>
  buildLedger({
    primaryPortfolio: 300_000,
    secondaryPortfolio: 200_000,
    annualPlannedContribution: 20_000,
    stepCount: LONG_STEPS,
    retirementStepIdx: BASE_RETIREMENT_STEP,
  });
const longHorizonInput: MonteCarloInput = {
  ...baseInput,
  horizonYear: LONG_HORIZON_YEAR,
  accountMcLedger: longLedger(),
  monthlyExpenseBase: makeMonthlyExpenseBase(80_000, LONG_STEPS),
  ...buildYearArrays({ firstYear: 2026, horizonYear: LONG_HORIZON_YEAR, annualSs: 30_000, ssStartYear: 2046 }),
};

describe('runMonteCarlo — windowed expense schedule', () => {
  const STEPS = LONG_STEPS;
  // A $100k/yr LTC slice in 2070-2074, $0 in every other month.
  function windowedBase(): number[] {
    const base = new Array<number>(STEPS).fill(0);
    for (let year = 2070; year < 2075; year += 1) {
      for (let m = 0; m < 12; m += 1) base[(year - 2026) * 12 + m] = 100_000 / 12;
    }
    return base;
  }
  const flatCpi = (): Float64Array => new Float64Array(STEPS).fill(0.25);
  const flatReturn = (): Float64Array => new Float64Array(STEPS).fill(0.4);

  it('the nominal expense draw is 0 before the window opens and positive inside (injected-CPI parity)', () => {
    const out = runMonteCarlo({
      ...baseInput,
      retirementYear: 2026,
      horizonYear: LONG_HORIZON_YEAR,
      accountMcLedger: longLedger(),
      ssByYear: new Array<number>(LONG_YEARS).fill(0),
      incomeByYear: new Array<number>(LONG_YEARS).fill(0),
      monthlyExpenseBase: windowedBase(),
      pathCount: 1,
      injectedReturns: flatReturn(),
      injectedCpi: flatCpi(),
    });
    const run = out.representativeByBasis!['mc-typical']!;
    const beforeIdx = 2050 - 2026;
    expect(run.years[beforeIdx].netNeed).toBe(0);
    const insideIdx = 2072 - 2026;
    expect(run.years[insideIdx].netNeed).toBeGreaterThan(0);
  });

  it('sign-error guard: windowing a finite late expense raises (or holds) ending balance vs charging it every year', () => {
    const common = {
      ...baseInput,
      retirementYear: 2026,
      horizonYear: LONG_HORIZON_YEAR,
      accountMcLedger: longLedger(),
      ssByYear: new Array<number>(LONG_YEARS).fill(0),
      incomeByYear: new Array<number>(LONG_YEARS).fill(0),
      pathCount: 300,
      seed: 7,
    };
    const windowed = runMonteCarlo({ ...common, monthlyExpenseBase: windowedBase() });
    const flat = runMonteCarlo({
      ...common,
      monthlyExpenseBase: new Array<number>(STEPS).fill(100_000 / 12),
    });
    expect(windowed.percentilesReal.p10.at(-1)!).toBeGreaterThanOrEqual(
      flat.percentilesReal.p10.at(-1)!,
    );
    expect(windowed.percentilesReal.p50.at(-1)!).toBeGreaterThanOrEqual(
      flat.percentilesReal.p50.at(-1)!,
    );
  });
});

describe('runMonteCarlo — multi-rate medical demand subset', () => {
  const STEPS = (2056 - 2026 + 1) * 12;
  const flatCpi = (): Float64Array => new Float64Array(STEPS).fill(0.25);
  const flatReturn = (): Float64Array => new Float64Array(STEPS).fill(0.4);

  // Two medical categories at different effective rates ($1k/mo general, $1k/mo at +2pp) plus a $2k/mo non-medical general slice.
  const GENERAL_PCT = 3;
  const FAST_PCT = 5;
  const medSlow = (): number[] => new Array<number>(STEPS).fill(1_000);
  const medFast = (): number[] => new Array<number>(STEPS).fill(1_000);
  const nonMedical = (): number[] => new Array<number>(STEPS).fill(2_000);
  const expenseBase = (): number[] => new Array<number>(STEPS).fill(4_000);

  function hsaLedger(): MonteCarloAccountLedger[] {
    return [
      {
        id: 'brok', initialPre: 0, initialPost: 400_000,
        contribPre: new Float64Array(STEPS), contribPost: new Float64Array(STEPS),
        deposit: new Float64Array(STEPS),
        assetMix: { stocksPct: 100, bondsPct: 0, cashPct: 0 }, assetMixSeries: null,
        cbpPlanningReturnPct: null, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE',
        ownerId: 'p', contribGrowthMode: 'fixed', plannedContribPostBase: null,
      },
      {
        id: 'hsa', initialPre: 0, initialPost: 400_000,
        contribPre: new Float64Array(STEPS), contribPost: new Float64Array(STEPS),
        deposit: new Float64Array(STEPS),
        assetMix: { stocksPct: 100, bondsPct: 0, cashPct: 0 }, assetMixSeries: null,
        cbpPlanningReturnPct: null, taxTreatment: 'HSA', accountType: 'HSA',
        ownerId: 'p', contribGrowthMode: 'fixed', plannedContribPostBase: null,
      },
    ];
  }

  function runWith(opts: { bucketed: boolean }): ReturnType<typeof runMonteCarlo> {
    const input: MonteCarloInput = {
      ...baseInput,
      retirementYear: 2026,
      firstYear: 2026,
      horizonYear: 2056,
      accountMcLedger: hsaLedger(),
      ssByYear: new Array<number>(31).fill(0),
      incomeByYear: new Array<number>(31).fill(0),
      monthlyExpenseBase: expenseBase(),
      monthlyExpenseBucketsBase: [
        { ratePct: GENERAL_PCT, amount: medSlow().map((v, i) => v + nonMedical()[i]) },
        { ratePct: FAST_PCT, amount: medFast() },
      ],
      monthlyMedicalDemandBase: medSlow().map((v, i) => v + medFast()[i]), // $2k/mo total
      medicalDemandRatePct: GENERAL_PCT,
      scenarioInflationPct: GENERAL_PCT,
      pathCount: 1,
      seed: 99,
      injectedReturns: flatReturn(),
      injectedCpi: flatCpi(),
      ...(opts.bucketed
        ? {
            monthlyMedicalDemandBucketsBase: [
              { ratePct: GENERAL_PCT, amount: medSlow() },
              { ratePct: FAST_PCT, amount: medFast() },
            ],
          }
        : {}),
    };
    return runMonteCarlo(input);
  }

  it('keeps medical demand a strict subset of the inflated medical expense', () => {
    const out = runWith({ bucketed: true });
    const run = out.representativeByBasis!['mc-typical']!;
    const drawYears = run.years.filter((y) => y.accountBalances);
    expect(drawYears.length).toBeGreaterThan(0);
    let anyMedical = false;
    for (const y of drawYears) {
      const hsa = y.accountBalances!.get('hsa');
      const med = hsa?.medicalQualifiedWithdrawnCents ?? 0;
      // Medical demand is bounded by the inflated medical expense, itself a subset of the total, so the qualified HSA draw never exceeds the committed HSA withdrawal.
      const committed = Math.round((hsa?.withdrawn ?? 0) * 100);
      expect(med).toBeLessThanOrEqual(committed);
      if (med > 0) anyMedical = true;
    }
    expect(anyMedical).toBe(true);
  });

  it('per-rate inflation diverges from the single-rate medical approximation', () => {
    const bucketed = runWith({ bucketed: true }).representativeByBasis!['mc-typical']!;
    const single = runWith({ bucketed: false }).representativeByBasis!['mc-typical']!;
    // Mid-horizon the fast medical category has compounded ahead of the general rate while the HSA can still fund it.
    const lateYear = 2026 + 15;
    const bHsa = bucketed.years.find((y) => y.year === lateYear)?.accountBalances?.get('hsa');
    const sHsa = single.years.find((y) => y.year === lateYear)?.accountBalances?.get('hsa');
    const bMed = bHsa?.medicalQualifiedWithdrawnCents ?? 0;
    const sMed = sHsa?.medicalQualifiedWithdrawnCents ?? 0;
    expect(bMed).toBeGreaterThan(sMed);
  });
});

describe('runMonteCarlo', () => {
  it('produces a summary with the expected shape', () => {
    const out = runMonteCarlo(baseInput);
    expect(out.engineVersion).toBe(ENGINE_VERSION);
    expect(out.seed).toBe(baseInput.seed);
    expect(out.pathCount).toBe(baseInput.pathCount);
    expect(out.firstYear).toBe(2026);
    expect(out.horizonYears).toBe(31); // 2056 - 2026 + 1
    expect(out.percentilesNominal.p50).toHaveLength(31);
    expect(out.percentilesReal.p50).toHaveLength(31);
    expect(out.failureYearHistogram).toHaveLength(31);
    expect(out.endingBalanceHistogramNominal).toHaveLength(31);
    expect(out.endingBalanceHistogramReal).toHaveLength(31);
  });

  it('is deterministic: same seed -> bit-identical percentile arrays', () => {
    const a = runMonteCarlo(baseInput);
    const b = runMonteCarlo(baseInput);
    expect(a.percentilesNominal.p50).toEqual(b.percentilesNominal.p50);
    expect(a.percentilesReal.p10).toEqual(b.percentilesReal.p10);
    expect(a.successProbability).toBe(b.successProbability);
    expect(a.medianEndingBalanceNominal).toBe(b.medianEndingBalanceNominal);
    expect(a.p25DepletionYear).toBe(b.p25DepletionYear);
    expect(a.p25EndingBalanceNominal).toBe(b.p25EndingBalanceNominal);
    expect(a.p25EndingBalanceReal).toBe(b.p25EndingBalanceReal);
  });

  it('different seed -> different percentile arrays', () => {
    const a = runMonteCarlo({ ...baseInput, seed: 1 });
    const b = runMonteCarlo({ ...baseInput, seed: 2 });
    expect(a.percentilesNominal.p50).not.toEqual(b.percentilesNominal.p50);
  });

  // A December retiree (month 11) draws only the final month of the retirement year, so ends it with a higher P50 than a January retiree: no ~11-month over-count.
  const RETIREMENT_YEAR_IDX = 2046 - 2026;
  it('December retiree draws less in the retirement year than a January retiree', () => {
    const january = runMonteCarlo({ ...baseInput, primaryRetirementMonth0: 0 });
    const december = runMonteCarlo({ ...baseInput, primaryRetirementMonth0: 11 });
    expect(december.percentilesNominal.p50[RETIREMENT_YEAR_IDX]).toBeGreaterThan(
      january.percentilesNominal.p50[RETIREMENT_YEAR_IDX],
    );
    const noOffset = runMonteCarlo(baseInput);
    expect(january.percentilesNominal.p50).toEqual(noOffset.percentilesNominal.p50);
  });

  it('successProbability is in [0, 1]', () => {
    const out = runMonteCarlo(baseInput);
    expect(out.successProbability).toBeGreaterThanOrEqual(0);
    expect(out.successProbability).toBeLessThanOrEqual(1);
  });

  it('successProbability = 1 when expenses are dwarfed by income (deep-money plan)', () => {
    const out = runMonteCarlo({
      ...baseInput,
      portfolioToday: 10_000_000,
      accountMcLedger: buildLedger({
        primaryPortfolio: 7_000_000,
        secondaryPortfolio: 3_000_000,
        annualPlannedContribution: 20_000,
        stepCount: BASE_STEPS,
        retirementStepIdx: BASE_RETIREMENT_STEP,
      }),
      monthlyExpenseBase: makeMonthlyExpenseBase(30_000, BASE_STEPS),
      ...buildYearArrays({ firstYear: 2026, horizonYear: 2056, annualSs: 60_000, ssStartYear: 2046 }),
    });
    expect(out.successProbability).toBe(1);
    expect(out.medianDepletionYear).toBeNull();
  });

  it('successProbability is low when expenses far exceed assets+income (under-funded plan)', () => {
    const out = runMonteCarlo({
      ...baseInput,
      portfolioToday: 50_000,
      accountMcLedger: buildLedger({
        primaryPortfolio: 30_000,
        secondaryPortfolio: 20_000,
        annualPlannedContribution: 0,
        stepCount: BASE_STEPS,
        retirementStepIdx: BASE_RETIREMENT_STEP,
      }),
      annualContribution: 0,
      monthlyExpenseBase: makeMonthlyExpenseBase(200_000, BASE_STEPS),
      ...buildYearArrays({ firstYear: 2026, horizonYear: 2056, annualSs: 10_000, ssStartYear: 2046 }),
    });
    expect(out.successProbability).toBeLessThan(0.5);
    expect(out.medianDepletionYear).not.toBeNull();
  });

  it('percentile ordering: p10 <= p25 <= p50 at every year', () => {
    const out = runMonteCarlo(baseInput);
    for (let i = 0; i < out.horizonYears; i++) {
      expect(out.percentilesNominal.p10[i]).toBeLessThanOrEqual(out.percentilesNominal.p25[i]);
      expect(out.percentilesNominal.p25[i]).toBeLessThanOrEqual(out.percentilesNominal.p50[i]);
    }
  });

  it('emits progress callbacks roughly every max(25, total/40) paths', () => {
    let calls = 0;
    runMonteCarlo({
      ...baseInput,
      pathCount: 200,
      onProgress: () => {
        calls += 1;
      },
    });
    expect(calls).toBeGreaterThanOrEqual(7);
    expect(calls).toBeLessThanOrEqual(9);
  });

  it('floor-reserve-depletion : a floored account IS drawn below its floor only as a last resort', () => {
    // A floor holds for ordinary discretionary need but drains below the floor as a last resort once nothing else remains.
    const STEPS = LONG_STEPS;
    const FLOOR_DOLLARS = 150_000;
    const flatReturn = (): Float64Array => new Float64Array(STEPS).fill(0.3);
    const zeroCpi = (): Float64Array => new Float64Array(STEPS);
    const flooredLedger = (): MonteCarloAccountLedger[] => [
      {
        id: 'brok-floored', initialPre: 0, initialPost: 400_000,
        contribPre: new Float64Array(STEPS), contribPost: new Float64Array(STEPS),
        deposit: new Float64Array(STEPS),
        assetMix: { stocksPct: 100, bondsPct: 0, cashPct: 0 }, assetMixSeries: null,
        cbpPlanningReturnPct: null, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE',
        ownerId: 'p', contribGrowthMode: 'fixed', plannedContribPostBase: null,
        floorDollars: FLOOR_DOLLARS,
      },
      {
        // The unfloored 401k absorbs the shortfall first; the floored reserve drains only once it is exhausted.
        id: 'pretax', initialPre: 400_000, initialPost: 0,
        contribPre: new Float64Array(STEPS), contribPost: new Float64Array(STEPS),
        deposit: new Float64Array(STEPS),
        assetMix: { stocksPct: 100, bondsPct: 0, cashPct: 0 }, assetMixSeries: null,
        cbpPlanningReturnPct: null, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_401K',
        ownerId: 'p', contribGrowthMode: 'fixed', plannedContribPostBase: null,
      },
    ];
    const out = runMonteCarlo({
      ...baseInput,
      horizonYear: LONG_HORIZON_YEAR,
      portfolioToday: 800_000,
      accountMcLedger: flooredLedger(),
      annualContribution: 0,
      strategyKind: 'taxEfficient',
      monthlyExpenseBase: makeMonthlyExpenseBase(90_000, LONG_STEPS),
      ssByYear: new Array<number>(LONG_YEARS).fill(0),
      incomeByYear: new Array<number>(LONG_YEARS).fill(0),
      pathCount: 1,
      seed: 42,
      injectedReturns: flatReturn(),
      injectedCpi: zeroCpi(),
    });
    const run = out.representativeByBasis!['mc-typical']!;
    const depCal = run.depletionYear ?? Number.POSITIVE_INFINITY;
    const drawYears = run.years.filter((y) => y.accountBalances && y.year < depCal);
    expect(drawYears.length).toBeGreaterThan(0);
    let sawBelowFloor = false;
    for (const y of drawYears) {
      const brok = y.accountBalances!.get('brok-floored');
      if (!brok) continue;
      if (brok.balance < FLOOR_DOLLARS - 1) sawBelowFloor = true;
    }
    expect(sawBelowFloor).toBe(true);
  });

  it('floor-reserve-depletion: reserves fund the tail WITHOUT setting depletionYear', () => {
    const STEPS = LONG_STEPS;
    const zeroReturn = (): Float64Array => new Float64Array(STEPS); // flat 0% growth
    const zeroCpi = (): Float64Array => new Float64Array(STEPS);
    const ledger = (): MonteCarloAccountLedger[] => [
      {
        id: 'brok', initialPre: 0, initialPost: 600_000,
        contribPre: new Float64Array(STEPS), contribPost: new Float64Array(STEPS),
        deposit: new Float64Array(STEPS),
        assetMix: { stocksPct: 100, bondsPct: 0, cashPct: 0 }, assetMixSeries: null,
        cbpPlanningReturnPct: null, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE',
        ownerId: 'p', contribGrowthMode: 'fixed', plannedContribPostBase: null,
        floorDollars: 500_000, // most of the balance sits behind the floor
      },
    ];
    const out = runMonteCarlo({
      ...baseInput,
      horizonYear: LONG_HORIZON_YEAR,
      portfolioToday: 600_000,
      accountMcLedger: ledger(),
      annualContribution: 0,
      strategyKind: 'taxEfficient',
      // $12k/yr over ~40 retirement years draws ≈$480k: through the $100k above the floor and into the reserve, never exhausting it.
      monthlyExpenseBase: makeMonthlyExpenseBase(12_000, LONG_STEPS),
      ssByYear: new Array<number>(LONG_YEARS).fill(0),
      incomeByYear: new Array<number>(LONG_YEARS).fill(0),
      pathCount: 1,
      seed: 42,
      injectedReturns: zeroReturn(),
      injectedCpi: zeroCpi(),
    });
    const run = out.representativeByBasis!['mc-typical']!;
    expect(run.depletionYear ?? null).toBeNull();
    const last = run.years[run.years.length - 1];
    const brok = last.accountBalances?.get('brok');
    expect((brok?.balance ?? Number.POSITIVE_INFINITY)).toBeLessThan(500_000);
  });

  it('floor-reserve-depletion: HSA reserve is drawn below floor; MC 20% additional-tax leg stays $0', () => {
    // The pre-65 20% §223(f)(4) additional-tax leg is a permanent MC no-op (the synthetic pool has no emergency-qualified% input), so this asserts the draw only.
    const STEPS = LONG_STEPS;
    const zeroReturn = (): Float64Array => new Float64Array(STEPS);
    const zeroCpi = (): Float64Array => new Float64Array(STEPS);
    const ledger = (): MonteCarloAccountLedger[] => [
      {
        id: 'hsa-floored', initialPre: 0, initialPost: 300_000,
        contribPre: new Float64Array(STEPS), contribPost: new Float64Array(STEPS),
        deposit: new Float64Array(STEPS),
        assetMix: { stocksPct: 100, bondsPct: 0, cashPct: 0 }, assetMixSeries: null,
        cbpPlanningReturnPct: null, taxTreatment: 'HSA', accountType: 'HSA',
        ownerId: 'p', contribGrowthMode: 'fixed', plannedContribPostBase: null,
        floorDollars: 150_000, floorHsaMode: 'emergencyOnly',
      },
      {
        id: 'pretax', initialPre: 300_000, initialPost: 0,
        contribPre: new Float64Array(STEPS), contribPost: new Float64Array(STEPS),
        deposit: new Float64Array(STEPS),
        assetMix: { stocksPct: 100, bondsPct: 0, cashPct: 0 }, assetMixSeries: null,
        cbpPlanningReturnPct: null, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_401K',
        ownerId: 'p', contribGrowthMode: 'fixed', plannedContribPostBase: null,
      },
    ];
    const out = runMonteCarlo({
      ...baseInput,
      horizonYear: LONG_HORIZON_YEAR,
      portfolioToday: 600_000,
      accountMcLedger: ledger(),
      annualContribution: 0,
      strategyKind: 'taxEfficient',
      monthlyExpenseBase: makeMonthlyExpenseBase(14_000, LONG_STEPS),
      ssByYear: new Array<number>(LONG_YEARS).fill(0),
      incomeByYear: new Array<number>(LONG_YEARS).fill(0),
      pathCount: 1,
      seed: 42,
      injectedReturns: zeroReturn(),
      injectedCpi: zeroCpi(),
    });
    const run = out.representativeByBasis!['mc-typical']!;
    const depCal = run.depletionYear ?? Number.POSITIVE_INFINITY;
    const drawYears = run.years.filter((y) => y.accountBalances && y.year < depCal);
    let sawHsaBelowFloor = false;
    for (const y of drawYears) {
      const hsa = y.accountBalances!.get('hsa-floored');
      if (hsa && hsa.balance < 150_000 - 1) sawHsaBelowFloor = true;
      expect(y.hsaAdditionalTaxCents ?? 0).toBe(0);
    }
    expect(sawHsaBelowFloor).toBe(true); // reserve DRAW happened (non-vacuous)
  });

  it('emits P25 depletion + ending-balance fields ordered between P10 and median', () => {
    const out = runMonteCarlo({
      ...baseInput,
      portfolioToday: 50_000,
      accountMcLedger: buildLedger({
        primaryPortfolio: 30_000,
        secondaryPortfolio: 20_000,
        annualPlannedContribution: 0,
        stepCount: BASE_STEPS,
        retirementStepIdx: BASE_RETIREMENT_STEP,
      }),
      annualContribution: 0,
      monthlyExpenseBase: makeMonthlyExpenseBase(200_000, BASE_STEPS),
      ...buildYearArrays({ firstYear: 2026, horizonYear: 2056, annualSs: 10_000, ssStartYear: 2046 }),
    });
    expect(out.p25EndingBalanceNominal).toBeGreaterThanOrEqual(
      out.p10EndingBalanceNominal,
    );
    expect(out.medianEndingBalanceNominal).toBeGreaterThanOrEqual(
      out.p25EndingBalanceNominal,
    );
    expect(out.p25EndingBalanceReal).toBeGreaterThanOrEqual(
      out.p10EndingBalanceReal,
    );
    expect(out.p10DepletionYear).not.toBeNull();
    expect(out.p25DepletionYear).not.toBeNull();
    expect(out.medianDepletionYear).not.toBeNull();
    expect(out.p10DepletionYear).toBeLessThanOrEqual(
      out.p25DepletionYear as number,
    );
    expect(out.p25DepletionYear).toBeLessThanOrEqual(
      out.medianDepletionYear as number,
    );
  });

  it('failureYearHistogram sums to (1 - successProbability) * pathCount', () => {
    const out = runMonteCarlo(baseInput);
    const totalFailures = out.failureYearHistogram.reduce((a, b) => a + b, 0);
    const expectedFailures = Math.round((1 - out.successProbability) * out.pathCount);
    expect(totalFailures).toBe(expectedFailures);
  });

  it('plannedOverlay length equals horizonYears', () => {
    const out = runMonteCarlo(baseInput);
    expect(out.plannedOverlay).toHaveLength(out.horizonYears);
  });
});

describe('runMonteCarlo — successOnly fast path', () => {
  it('returns the same successProbability as a full run (tax context)', () => {
    const withTax: MonteCarloInput = {
      ...baseInput,
      pathCount: 50,
      taxContext: buildTaxContext(),
    };
    const full = runMonteCarlo(withTax);
    const successOnly = runMonteCarlo({ ...withTax, successOnly: true });
    expect(successOnly.successProbability).toBe(full.successProbability);
  });

  it('computes identical percentile + histogram fields, differing only on plannedOverlay', () => {
    const full = runMonteCarlo(baseInput);
    const successOnly = runMonteCarlo({ ...baseInput, successOnly: true });
    expect(successOnly.percentilesNominal).toEqual(full.percentilesNominal);
    expect(successOnly.percentilesReal).toEqual(full.percentilesReal);
    expect(successOnly.endingBalanceHistogramNominal).toEqual(
      full.endingBalanceHistogramNominal,
    );
    expect(successOnly.failureYearHistogram).toEqual(full.failureYearHistogram);
    expect(successOnly.medianEndingBalanceNominal).toBe(
      full.medianEndingBalanceNominal,
    );
    expect(successOnly.plannedOverlay).toEqual([]);
    expect(full.plannedOverlay.length).toBeGreaterThan(0);
    expect(successOnly.successProbability).toBe(full.successProbability);
    expect(successOnly.representativeByBasis).toBeUndefined();
    expect(successOnly.representativeTypicalSeed).toBeUndefined();
    expect(successOnly.representativeBandsByBasis).toBeUndefined();
  });
});

describe('runMonteCarlo — retirementAllocation assetMixSeries wiring', () => {
  // assetMixSeries on the ledger must move the results; ignoring it would make both runs identical.
  const stepCount = BASE_STEPS;
  const retirementStep = BASE_RETIREMENT_STEP;

  function buildGlideLedger(stocksAtRetirement: number): MonteCarloAccountLedger[] {
    const bonds = Math.round((100 - stocksAtRetirement) * 0.83);
    const cash = 100 - stocksAtRetirement - bonds;
    const series: Array<{ stocksPct: number; bondsPct: number; cashPct: number }> = [];
    for (let i = 0; i < stepCount; i += 1) {
      if (i < retirementStep) {
        series.push({ stocksPct: 70, bondsPct: 25, cashPct: 5 });
      } else {
        series.push({ stocksPct: stocksAtRetirement, bondsPct: bonds, cashPct: cash });
      }
    }
    return [
      {
        id: 'primary',
        initialPre: 0,
        initialPost: 300_000,
        contribPre: new Float64Array(stepCount),
        contribPost: new Float64Array(stepCount),
        deposit: new Float64Array(stepCount),
        assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
        assetMixSeries: series,
        cbpPlanningReturnPct: null,
      },
      {
        id: 'secondary',
        initialPre: 200_000,
        initialPost: 0,
        contribPre: new Float64Array(stepCount),
        contribPost: new Float64Array(stepCount),
        deposit: new Float64Array(stepCount),
        assetMix: { stocksPct: 40, bondsPct: 55, cashPct: 5 },
        assetMixSeries: series,
        cbpPlanningReturnPct: null,
      },
    ];
  }

  it('assetMixSeries = null vs conservative mix produces different successProbability', () => {
    // 500 paths for sign-direction stability (large effect size).
    const baseline = runMonteCarlo({ ...baseInput, seed: 77, pathCount: 500 });
    const conservative = runMonteCarlo({
      ...baseInput,
      seed: 77,
      pathCount: 500,
      accountMcLedger: buildGlideLedger(20),
    });
    expect(conservative.successProbability).toBeLessThan(baseline.successProbability);
  });

  it('aggressive drawdown mix (90% stocks) shifts medianEndingBalanceNominal vs conservative', () => {
    const conservative = runMonteCarlo({
      ...baseInput,
      seed: 99,
      pathCount: 500,
      accountMcLedger: buildGlideLedger(20),
    });
    const aggressive = runMonteCarlo({
      ...baseInput,
      seed: 99,
      pathCount: 500,
      accountMcLedger: buildGlideLedger(90),
    });
    expect(aggressive.medianEndingBalanceNominal).toBeGreaterThan(
      conservative.medianEndingBalanceNominal,
    );
  });

  // A 5% scenario inflation mean-shifts the CPI bootstrap; without the shift, scenario inflation would be a no-op in MC.
  it('scenario inflation 5% drops success probability vs 0% (v8 CPI mean-shift)', () => {
    const at0 = runMonteCarlo({ ...baseInput, scenarioInflationPct: 0 });
    const at5 = runMonteCarlo({ ...baseInput, scenarioInflationPct: 5 });
    expect(at0.engineVersion).toBe(ENGINE_VERSION);
    expect(at5.engineVersion).toBe(ENGINE_VERSION);
    expect(at5.successProbability).toBeLessThan(at0.successProbability);
    // Nominal can move either direction since income arrays stay flat; the real deflator is the load-bearing measure.
    expect(at5.medianEndingBalanceReal).toBeLessThan(
      at0.medianEndingBalanceReal,
    );
  });
});

function buildTaxContext(opts?: Partial<McTaxContext>): McTaxContext {
  return {
    taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus: 'Single',
    members: [
      {
        memberId: 'mc-test-primary',
        isoBirthdate: '1971-06-15', // age 55 in 2026; Medicare at 65 = 2036
        onMedicare: false,
        hasAcaCoverage: false,
      },
    ],
    householdSize: 1,
    ...opts,
  };
}

describe('runMonteCarlo — v10 tax percentile bands', () => {
  // Shared lazily so a filtered run of an unrelated case does not pay for it.
  let cachedTaxRun: { input: MonteCarloInput; out: ReturnType<typeof runMonteCarlo> } | undefined;
  function sharedTaxRun(): { input: MonteCarloInput; out: ReturnType<typeof runMonteCarlo> } {
    if (!cachedTaxRun) {
      const input: MonteCarloInput = {
        ...baseInput,
        pathCount: 50,
        taxContext: buildTaxContext(),
      };
      cachedTaxRun = { input, out: runMonteCarlo(input) };
    }
    return cachedTaxRun;
  }

  it('populates all five tax percentile series when taxContext supplied', () => {
    const { input, out } = sharedTaxRun();

    expect(out.federalTaxPercentilesByYear).toBeDefined();
    expect(out.irmaaSurchargePercentilesByYear).toBeDefined();
    expect(out.acaPtcSubsidyPercentilesByYear).toBeDefined();
    expect(out.effectiveTaxRatePercentilesByYear).toBeDefined();
    expect(out.netAfterTaxPercentilesByYear).toBeDefined();

    const horizon = input.horizonYear - input.firstYear + 1;
    expect(out.federalTaxPercentilesByYear!.p50).toHaveLength(horizon);
    expect(out.netAfterTaxPercentilesByYear!.p10).toHaveLength(horizon);
  });

  it('tax percentile bands are ordered p10 ≤ p25 ≤ p50', () => {
    const { input, out } = sharedTaxRun();
    const fed = out.federalTaxPercentilesByYear!;
    const horizon = input.horizonYear - input.firstYear + 1;
    for (let i = 0; i < horizon; i++) {
      expect(fed.p10[i]).toBeLessThanOrEqual(fed.p25[i]);
      expect(fed.p25[i]).toBeLessThanOrEqual(fed.p50[i]);
    }
  });

  it('effectiveTaxRate percentile bands are in [0, 1]', () => {
    const { input, out } = sharedTaxRun();
    const etr = out.effectiveTaxRatePercentilesByYear!;
    const horizon = input.horizonYear - input.firstYear + 1;
    for (let i = 0; i < horizon; i++) {
      expect(etr.p10[i]).toBeGreaterThanOrEqual(0);
      expect(etr.p50[i]).toBeLessThanOrEqual(1);
    }
  });

  it('omits tax percentile fields when taxContext is absent', () => {
    const out = runMonteCarlo(baseInput); // no taxContext
    expect(out.federalTaxPercentilesByYear).toBeUndefined();
    expect(out.irmaaSurchargePercentilesByYear).toBeUndefined();
    expect(out.acaPtcSubsidyPercentilesByYear).toBeUndefined();
    expect(out.effectiveTaxRatePercentilesByYear).toBeUndefined();
    expect(out.netAfterTaxPercentilesByYear).toBeUndefined();
  });

  // fillStrategyYearTax stamps the accumulators before the absorbing-depletion clamp, so strictly-post-depletion years would carry stale tax (SS income still flows); the clamp must zero them.
  it('zeroes the percentile tax bands for strictly-post-depletion years', () => {
    const STEPS = (2056 - 2026 + 1) * 12;
    const out = runMonteCarlo({
      ...baseInput,
      portfolioToday: 200_000,
      accountMcLedger: buildLedger({
        primaryPortfolio: 200_000,
        secondaryPortfolio: 0,
        annualPlannedContribution: 0,
        stepCount: STEPS,
        retirementStepIdx: BASE_RETIREMENT_STEP,
      }),
      annualContribution: 0,
      retirementYear: 2046,
      monthlyExpenseBase: makeMonthlyExpenseBase(120_000, STEPS),
      ...buildYearArrays({ firstYear: 2026, horizonYear: 2056, annualSs: 60_000, ssStartYear: 2046 }),
      pathCount: 1,
      seed: 99,
      taxContext: buildTaxContext(),
      injectedReturns: new Float64Array(STEPS).fill(0.05),
      injectedCpi: new Float64Array(STEPS),
    });
    const depCal = out.medianDepletionYear;
    expect(depCal).not.toBeNull();
    const depIdx = depCal! - out.firstYear;
    const horizon = out.horizonYears;
    expect(depIdx + 1).toBeLessThan(horizon);
    const bands = [
      out.federalTaxPercentilesByYear!,
      out.irmaaSurchargePercentilesByYear!,
      out.acaPtcSubsidyPercentilesByYear!,
      out.effectiveTaxRatePercentilesByYear!,
      out.netAfterTaxPercentilesByYear!,
    ];
    for (let y = depIdx + 1; y < horizon; y += 1) {
      for (const band of bands) {
        expect(band.p10[y]).toBe(0);
        expect(band.p25[y]).toBe(0);
        expect(band.p50[y]).toBe(0);
      }
    }
  });

  it('incomeByYear is passed through to per-year tax estimation (changes federal tax result)', () => {
    const horizonYears = baseInput.horizonYear - baseInput.firstYear + 1;
    // Born 1985 (pre-RMD) so no synthetic RMD floor adds phantom income: $80k drawn and $80k of other income carry the same tax.
    const preRmdContext = buildTaxContext({
      members: [
        {
          memberId: 'mc-test-primary',
          isoBirthdate: '1985-06-15',
          onMedicare: false,
          hasAcaCoverage: false,
        },
      ],
    });
    const noIncome = runMonteCarlo({
      ...baseInput,
      pathCount: 50,
      seed: 77,
      ssByYear: new Array<number>(horizonYears).fill(0),
      incomeByYear: new Array<number>(horizonYears).fill(0),
      taxContext: preRmdContext,
    });
    const withIncome = runMonteCarlo({
      ...baseInput,
      pathCount: 50,
      seed: 77,
      ssByYear: new Array<number>(horizonYears).fill(0),
      incomeByYear: new Array<number>(horizonYears).fill(80_000),
      taxContext: preRmdContext,
    });
    const retirementIdx = baseInput.retirementYear - baseInput.firstYear;
    expect(noIncome.federalTaxPercentilesByYear!.p50[retirementIdx]).toBeGreaterThan(0);
    expect(withIncome.federalTaxPercentilesByYear!.p50[retirementIdx]).toBeGreaterThan(0);
    expect(noIncome.federalTaxPercentilesByYear!.p50[retirementIdx]).toBeCloseTo(
      withIncome.federalTaxPercentilesByYear!.p50[retirementIdx],
      0, // within $1
    );
  });

  // Perf budget — 1000-path × 30-year with-tax run within
  // max(200 ms absolute, +20% relative to baseline). Wall-clock budgets are
  // meaningless on a v8-instrumented build, so the coverage run
  // (VITEST_COVERAGE=1, see test:coverage) skips this one test.
  //
  // Wall-clock assertions flake when a parallel agent worktree steals the CPU
  // mid-run, so the whole block is opt-in via PERF_ASSERT (see the
  // no-restricted-properties eslint rule + .env.example). Run it with
  // `PERF_ASSERT=1 pnpm --filter @retirement/web exec vitest run monte-carlo.test`.
  describe.skipIf(!process.env.PERF_ASSERT)(
    'monte-carlo timing (PERF_ASSERT only)',
    () => {
      it.skipIf(process.env.VITEST_COVERAGE === '1')(
        '1000-path 30-year with-tax run completes within perf budget', () => {
        const horizonYear = baseInput.firstYear + 29; // 30 years
        const horizonYears = horizonYear - baseInput.firstYear + 1;
        const perfInput: MonteCarloInput = {
          ...baseInput,
          pathCount: 1000,
          horizonYear,
          monthlyExpenseBase: makeMonthlyExpenseBase(80_000, horizonYears * 12),
          ssByYear: new Array<number>(horizonYears).fill(0),
          incomeByYear: new Array<number>(horizonYears).fill(0),
          accountMcLedger: buildLedger({
            primaryPortfolio: 300_000,
            secondaryPortfolio: 200_000,
            annualPlannedContribution: 20_000,
            stepCount: horizonYears * 12,
            retirementStepIdx:
              (baseInput.retirementYear - baseInput.firstYear) * 12,
          }),
        };
        // Baseline (no tax).
        // eslint-disable-next-line no-restricted-properties -- PERF_ASSERT-gated
        const t0Baseline = performance.now();
        runMonteCarlo(perfInput);
        // eslint-disable-next-line no-restricted-properties -- PERF_ASSERT-gated
        const baselineMs = performance.now() - t0Baseline;

        // With tax.
        // eslint-disable-next-line no-restricted-properties -- PERF_ASSERT-gated
        const t0Tax = performance.now();
        runMonteCarlo({ ...perfInput, taxContext: buildTaxContext() });
        // eslint-disable-next-line no-restricted-properties -- PERF_ASSERT-gated
        const withTaxMs = performance.now() - t0Tax;

        // The budget bounds the delta of two wall-clock timings; the floor is widened to absorb scheduler jitter while still catching a multi-second tax-path regression.
        const deltaMs = withTaxMs - baselineMs;
        const budgetMs = Math.max(1000, baselineMs * 0.25);
        expect(deltaMs).toBeLessThan(budgetMs);
      },
      );
    },
  );
});

function buildTaggedLedger(args: {
  taxTreatment: MonteCarloAccountLedger['taxTreatment'];
  accountType: MonteCarloAccountLedger['accountType'];
  portfolio: number;
  stepCount: number;
}): MonteCarloAccountLedger[] {
  const pre = args.taxTreatment === 'PRE_TAX' ? args.portfolio : 0;
  const post = args.taxTreatment === 'PRE_TAX' ? 0 : args.portfolio;
  return [
    {
      id: 'only',
      initialPre: pre,
      initialPost: post,
      contribPre: new Float64Array(args.stepCount),
      contribPost: new Float64Array(args.stepCount),
      deposit: new Float64Array(args.stepCount),
      assetMix: { stocksPct: 60, bondsPct: 35, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
      taxTreatment: args.taxTreatment,
      accountType: args.accountType,
      ownerId: 'mc-test-primary',
    },
  ];
}

describe('runMonteCarlo — per-account tax routing', () => {
  const STEPS = (2056 - 2026 + 1) * 12;
  const horizon = 2056 - 2026 + 1;
  const retirementIdx = 2046 - 2026;

  // Routing is observable only below RMD age (an RMD-age floor grosses income up whatever the source), so the member is born 1985.
  const preRmdTaxContext = (): McTaxContext =>
    buildTaxContext({
      members: [
        {
          memberId: 'mc-test-primary',
          isoBirthdate: '1985-06-15',
          onMedicare: false,
          hasAcaCoverage: false,
        },
      ],
      // Roth basis large enough that every Roth draw is §408A contribution-basis recovery, tax- and penalty-free.
      rothBasisCentsByOwner: [{ ownerId: 'mc-test-primary', cents: 50_000_000 * 100 }],
    });

  function inputFor(ledger: MonteCarloAccountLedger[]): MonteCarloInput {
    return {
      portfolioToday: 800_000,
      accountMcLedger: ledger,
      annualContribution: 0,
      firstYear: 2026,
      retirementYear: 2046,
      horizonYear: 2056,
      monthlyExpenseBase: makeMonthlyExpenseBase(70_000, horizon * 12),
      ssByYear: new Array<number>(horizon).fill(0),
      incomeByYear: new Array<number>(horizon).fill(0),
      pathCount: 50,
      seed: 4242,
      strategyKind: 'taxEfficient',
      taxContext: preRmdTaxContext(),
    };
  }

  const preTaxLedger = (): MonteCarloAccountLedger[] =>
    buildTaggedLedger({
      taxTreatment: 'PRE_TAX',
      accountType: 'RETIREMENT_IRA',
      portfolio: 800_000,
      stepCount: STEPS,
    });
  const rothLedger = (): MonteCarloAccountLedger[] =>
    buildTaggedLedger({
      taxTreatment: 'ROTH',
      accountType: 'RETIREMENT_ROTH_IRA',
      portfolio: 800_000,
      stepCount: STEPS,
    });

  it('Roth routing produces less tax than pre-tax routing for the same draw', () => {
    const preTax = runMonteCarlo(inputFor(preTaxLedger()));
    const roth = runMonteCarlo(inputFor(rothLedger()));
    expect(preTax.federalTaxPercentilesByYear!.p50[retirementIdx]).toBeGreaterThan(0);
    expect(roth.federalTaxPercentilesByYear!.p50[retirementIdx]).toBe(0);
  });

  it('taxable-brokerage routing taxes less than pre-tax (LTCG proxy vs ordinary)', () => {
    const preTax = runMonteCarlo(inputFor(preTaxLedger()));
    const taxable = runMonteCarlo(
      inputFor(
        buildTaggedLedger({
          taxTreatment: 'POST_TAX',
          accountType: 'BROKERAGE',
          portfolio: 800_000,
          stepCount: STEPS,
        }),
      ),
    );
    expect(taxable.federalTaxPercentilesByYear!.p50[retirementIdx]).toBeLessThan(
      preTax.federalTaxPercentilesByYear!.p50[retirementIdx],
    );
  });

  it('per-account routing keeps the five tax percentile bands populated', () => {
    const out = runMonteCarlo(inputFor(preTaxLedger()));
    expect(out.federalTaxPercentilesByYear).toBeDefined();
    expect(out.irmaaSurchargePercentilesByYear).toBeDefined();
    expect(out.acaPtcSubsidyPercentilesByYear).toBeDefined();
    expect(out.effectiveTaxRatePercentilesByYear).toBeDefined();
    expect(out.netAfterTaxPercentilesByYear).toBeDefined();
    expect(out.federalTaxPercentilesByYear!.p50).toHaveLength(horizon);
  });

  it('Roth-funded plan ends with a higher after-tax balance than the pre-tax plan', () => {
    const preTax = runMonteCarlo(inputFor(preTaxLedger()));
    const roth = runMonteCarlo(inputFor(rothLedger()));
    expect(roth.medianEndingBalanceNominal).toBeGreaterThan(
      preTax.medianEndingBalanceNominal,
    );
  });

});

describe('runMonteCarlo — QCD per-path wiring', () => {
  const FIRST = 2026;
  const HORIZON = 2055;
  const HZN = HORIZON - FIRST + 1;
  const STEPS = HZN * 12;

  function rmdAgeTaxContext(): McTaxContext {
    return {
      taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
      filingStatus: 'Single',
      members: [
        {
          memberId: 'mc-test-primary',
          isoBirthdate: '1948-03-01',
          onMedicare: true,
          hasAcaCoverage: false,
        },
      ],
      householdSize: 1,
    };
  }

  function qcdContext(): McQcdContext {
    return {
      entries: [
        {
          memberId: 'mc-test-primary',
          sourceAccountId: 'only',
          annualAmountDollars: 30_000,
          startYear: FIRST,
          endYear: HORIZON + 1, // exclusive end → active through HORIZON
        },
      ],
      firstEligibleYearByOwner: { 'mc-test-primary': FIRST },
      inflationPct: 0,
    };
  }

  function baseInput(): MonteCarloInput {
    return {
      portfolioToday: 3_000_000,
      accountMcLedger: buildTaggedLedger({
        taxTreatment: 'PRE_TAX',
        accountType: 'RETIREMENT_IRA',
        portfolio: 3_000_000,
        stepCount: STEPS,
      }),
      annualContribution: 0,
      firstYear: FIRST,
      retirementYear: FIRST,
      horizonYear: HORIZON,
      // Modest spend on a large pot so the portfolio survives and the QCD debit is the only mover.
      monthlyExpenseBase: makeMonthlyExpenseBase(40_000, STEPS),
      ssByYear: new Array<number>(HZN).fill(0),
      incomeByYear: new Array<number>(HZN).fill(0),
      pathCount: 80,
      seed: 9090,
      strategyKind: 'taxEfficient',
      taxContext: rmdAgeTaxContext(),
      // Flat injected returns and 0 CPI: the QCD nominal equals $30k and the representative run is the single sampled path.
      injectedReturns: new Float64Array(STEPS).fill(0.004),
      injectedCpi: new Float64Array(STEPS),
    };
  }

  it('a per-path QCD debit lowers ending balances vs an identical no-QCD run', () => {
    const noQcd = runMonteCarlo(baseInput());
    const withQcd = runMonteCarlo({ ...baseInput(), qcdContext: qcdContext() });
    expect(withQcd.medianEndingBalanceNominal).toBeLessThan(
      noQcd.medianEndingBalanceNominal,
    );
  });

  it('stamps qcdCents + a reduced net-taxable-RMD on the representative run', () => {
    const withQcd = runMonteCarlo({ ...baseInput(), qcdContext: qcdContext() });
    const rep = withQcd.representativeByBasis?.['mc-typical'];
    expect(rep).toBeDefined();
    const qcdYear = rep!.years.find(
      (y) => y.accountBalances !== undefined && (y.qcdCents ?? 0) > 0,
    );
    expect(qcdYear).toBeDefined();
    expect(qcdYear!.qcdCents).toBe(30_000_00);
    expect(qcdYear!.netTaxableRmdCents).toBeGreaterThanOrEqual(0);
    if ((qcdYear!.rmdFloorCents ?? 0) > 0) {
      expect(qcdYear!.netTaxableRmdCents!).toBeLessThan(qcdYear!.rmdFloorCents!);
    }
  });

  it('replay-stamped offset + post-pass net-taxable equals the post-pass floor in EVERY QCD year (bar identity, end-to-end)', () => {
    // The replay caps and stamps the offset from its own gross IRA RMD while the post-pass recomputes the floor from stamped balances;
    // with one IRA, offset + netTaxable must equal rmdFloorCents.
    const withQcd = runMonteCarlo({ ...baseInput(), qcdContext: qcdContext() });
    const rep = withQcd.representativeByBasis?.['mc-typical'];
    expect(rep).toBeDefined();
    const qcdYears = rep!.years.filter(
      (y) =>
        y.accountBalances !== undefined &&
        (y.qcdCents ?? 0) > 0 &&
        (y.rmdFloorCents ?? 0) > 0,
    );
    expect(qcdYears.length).toBeGreaterThan(1);
    for (const y of qcdYears) {
      const offsetSum = Object.values(y.qcdRmdOffsetCentsByOwner ?? {}).reduce(
        (s, c) => s + c,
        0,
      );
      expect(offsetSum).toBeGreaterThan(0);
      expect(offsetSum + (y.netTaxableRmdCents ?? 0)).toBe(y.rmdFloorCents);
    }
  });

  it('stamps qcdInflationFactor = the path year-END CPI factor so the today\'s-dollars display round-trips to the REAL gift (MC display-anchor fix)', () => {
    // Non-zero injected CPI inflates the real gift; qcdCents divided by the stamped year-END factor must reverse to the configured $30k (display-anchor bug).
    const monthlyCpiPct = 0.5;
    const input: MonteCarloInput = {
      ...baseInput(),
      qcdContext: qcdContext(),
      injectedCpi: new Float64Array(STEPS).fill(monthlyCpiPct),
    };
    const withQcd = runMonteCarlo(input);
    const rep = withQcd.representativeByBasis?.['mc-typical'];
    expect(rep).toBeDefined();
    const qcdYears = rep!.years.filter(
      (y) => y.accountBalances !== undefined && (y.qcdCents ?? 0) > 0,
    );
    expect(qcdYears.length).toBeGreaterThan(0);
    const qcdYear = qcdYears[qcdYears.length - 1];
    expect(qcdYear.qcdInflationFactor!).toBeGreaterThan(1.05);
    expect(qcdYear.qcdCents!).toBe(
      Math.round(30_000 * qcdYear.qcdInflationFactor! * 100),
    );
    expect(qcdYear.qcdCents! / 100 / qcdYear.qcdInflationFactor!).toBeCloseTo(
      30_000,
      1,
    );
  });

  it('excludes the QCD from the taxable RMD EXACTLY ONCE (gross − Q, never gross − 2Q)', () => {
    // The QCD leaves ordinary income and MAGI once, before §86; a double exclusion would compute federal tax on gross - 2Q.
    const withQcd = runMonteCarlo({ ...baseInput(), qcdContext: qcdContext() });
    const noQcd = runMonteCarlo(baseInput());
    const repQ = withQcd.representativeByBasis?.['mc-typical'];
    const repN = noQcd.representativeByBasis?.['mc-typical'];
    expect(repQ).toBeDefined();
    expect(repN).toBeDefined();

    const qcdYear = repQ!.years.find(
      (y) => (y.qcdCents ?? 0) > 0 && (y.rmdFloorCents ?? 0) > (y.qcdCents ?? 0),
    );
    expect(qcdYear).toBeDefined();
    expect(qcdYear!.netTaxableRmdCents).toBe(
      (qcdYear!.rmdFloorCents ?? 0) - (qcdYear!.qcdCents ?? 0),
    );

    const noQcdYear = repN!.years.find((y) => y.year === qcdYear!.year);
    expect(noQcdYear).toBeDefined();
    expect(qcdYear!.federalTaxCents ?? 0).toBeLessThan(noQcdYear!.federalTaxCents ?? 0);
  });

  // Near the depletion cliff the QCD drain flips some paths, so success probability must differ, not just the ending balance.
  function cliffInput(): MonteCarloInput {
    return {
      ...baseInput(),
      portfolioToday: 900_000,
      accountMcLedger: buildTaggedLedger({
        taxTreatment: 'PRE_TAX',
        accountType: 'RETIREMENT_IRA',
        portfolio: 900_000,
        stepCount: STEPS,
      }),
      monthlyExpenseBase: makeMonthlyExpenseBase(78_000, STEPS),
      // Historical-bootstrap dispersion (no injected returns) so paths straddle the cliff.
      pathCount: 400,
      seed: 4242,
      injectedReturns: undefined,
      injectedCpi: undefined,
    };
  }

  it('a near-the-cliff QCD flips some paths → success probability DIFFERS', () => {
    const noQcd = runMonteCarlo(cliffInput());
    const withQcd = runMonteCarlo({ ...cliffInput(), qcdContext: qcdContext() });
    expect(withQcd.successProbability).not.toBe(noQcd.successProbability);
    expect(withQcd.successProbability).toBeLessThan(noQcd.successProbability);
  });
});

describe('accountYearStates — start-of-year bucket boundary', () => {
  const STEPS = 24; // two simulation years.

  function mixedLedger(initialPre: number, initialPost: number): MonteCarloAccountLedger[] {
    return [
      {
        id: 'mixed',
        initialPre,
        initialPost,
        contribPre: new Float64Array(STEPS),
        contribPost: new Float64Array(STEPS),
        deposit: new Float64Array(STEPS),
        assetMix: { stocksPct: 60, bondsPct: 35, cashPct: 5 },
        assetMixSeries: null,
        cbpPlanningReturnPct: null,
        taxTreatment: 'MIXED',
        accountType: 'RETIREMENT_IRA',
        ownerId: 'mc-test-primary',
      },
    ];
  }

  function outcomeFor(args: {
    withdrawalPerStep: number;
    preEndByStep: number[];
    postEndByStep: number[];
  }): StepOutcome {
    return {
      preEnd: new Float64Array(STEPS),
      postEnd: new Float64Array(STEPS),
      growth: new Float64Array(STEPS),
      contributions: new Float64Array(STEPS),
      withdrawal: new Float64Array(STEPS),
      deposit: new Float64Array(STEPS),
      expense: new Float64Array(STEPS),
      income: new Float64Array(STEPS),
      cumCpi: new Float64Array(STEPS).fill(1),
      accountWithdrawal: [Float64Array.from({ length: STEPS }, () => args.withdrawalPerStep)],
      accountPreEnd: [Float64Array.from(args.preEndByStep)],
      accountPostEnd: [Float64Array.from(args.postEndByStep)],
      accountDeposit: [new Float64Array(STEPS)],
      depletionStepIdx: -1,
    };
  }

  function inputFor(ledger: MonteCarloAccountLedger[]): MonteCarloInput {
    return {
      portfolioToday: 100_000,
      accountMcLedger: ledger,
      annualContribution: 0,
      firstYear: 2026,
      retirementYear: 2026,
      horizonYear: 2027,
      monthlyExpenseBase: makeMonthlyExpenseBase(0, 2 * 12),
      ssByYear: [0, 0],
      incomeByYear: [0, 0],
      pathCount: 1,
      seed: 1,
      strategyKind: 'taxEfficient',
    };
  }

  it("y=0 split uses the ledger's initial pre/post buckets (priorStep < 0)", () => {
    // For y=0 priorStep is -1, so the initial 75/25 buckets win over the 25/75 year-end ones.
    const input = inputFor(mixedLedger(75, 25));
    const preEndByStep = new Array<number>(STEPS).fill(0);
    const postEndByStep = new Array<number>(STEPS).fill(0);
    preEndByStep[11] = 25;
    postEndByStep[11] = 75;
    const out = outcomeFor({ withdrawalPerStep: 1200 / 12, preEndByStep, postEndByStep });

    const states = accountYearStates(input, out, 0, STEPS)!;
    expect(states[0].withdrawalDollars).toBeCloseTo(1200); // 12 steps * 100/step
    expect(states[0].preBalanceStartDollars).toBe(75);
    expect(states[0].postBalanceStartDollars).toBe(25);

    const cls = buildYearClassification(
      [{ taxTreatment: 'MIXED', accountType: 'RETIREMENT_IRA' }],
      states,
    )!;
    expect(cls.preTaxDollars).toBeCloseTo(900); // 1200 * 75/100
    expect(cls.postTaxNonRothDollars).toBeCloseTo(300); // 1200 * 25/100
  });

  it("y=1 split uses the prior year-end (step 11) accumulated buckets", () => {
    const input = inputFor(mixedLedger(75, 25));
    const preEndByStep = new Array<number>(STEPS).fill(0);
    const postEndByStep = new Array<number>(STEPS).fill(0);
    preEndByStep[11] = 20;
    postEndByStep[11] = 80;
    const out = outcomeFor({ withdrawalPerStep: 1200 / 12, preEndByStep, postEndByStep });

    const states = accountYearStates(input, out, 1, STEPS)!;
    expect(states[0].preBalanceStartDollars).toBe(20);
    expect(states[0].postBalanceStartDollars).toBe(80);

    const cls = buildYearClassification(
      [{ taxTreatment: 'MIXED', accountType: 'RETIREMENT_IRA' }],
      states,
    )!;
    expect(cls.preTaxDollars).toBeCloseTo(240); // 1200 * 20/100
    expect(cls.postTaxNonRothDollars).toBeCloseTo(960); // 1200 * 80/100
  });

  it('returns undefined when the kernel ran the single-pool branch (no per-account arrays)', () => {
    const input = inputFor(mixedLedger(75, 25));
    const out: StepOutcome = {
      preEnd: new Float64Array(STEPS),
      postEnd: new Float64Array(STEPS),
      growth: new Float64Array(STEPS),
      contributions: new Float64Array(STEPS),
      withdrawal: new Float64Array(STEPS),
      deposit: new Float64Array(STEPS),
      expense: new Float64Array(STEPS),
      income: new Float64Array(STEPS),
      cumCpi: new Float64Array(STEPS).fill(1),
      depletionStepIdx: -1,
    };
    expect(accountYearStates(input, out, 0, STEPS)).toBeUndefined();
  });
});

describe('advanceAfterTaxBase — absorbing after-tax prior-year RMD base', () => {
  const start = { base: 0, depleted: false };

  it('subtracts the cumulative tax drawn through the year from its nominal balance', () => {
    const year0 = advanceAfterTaxBase(start, 2_000_000, 40_000);
    const year1 = advanceAfterTaxBase(year0, 2_000_000, 70_000);
    expect(year0.base).toBe(2_000_000 - 40_000);
    expect(year1.base).toBe(2_000_000 - 70_000);
  });

  it('floors the base at zero when the cumulative tax exceeds the balance', () => {
    expect(advanceAfterTaxBase(start, 100_000, 250_000).base).toBe(0);
  });

  it('does NOT revive the base when the raw pre-tax balance recovers after depletion', () => {
    // The ledger crashes to a sliver, depleting the base, then recovers.
    let state = advanceAfterTaxBase(start, 2_000_000, 10_000);
    state = advanceAfterTaxBase(state, 2_000_000, 20_000);
    state = advanceAfterTaxBase(state, 1, 30_000);
    expect(state).toEqual({ base: 0, depleted: true });
    expect(advanceAfterTaxBase(state, 5_000_000, 30_000)).toEqual({ base: 0, depleted: true });
  });

  it('does NOT absorb on a no-tax zero-balance year: a later raw recovery revives the base', () => {
    // An over-absorbing `afterTax <= 0` predicate latched year 0 as depleted and suppressed the real recovery.
    const year0 = advanceAfterTaxBase(start, 0, 0);
    expect(year0).toEqual({ base: 0, depleted: false });
    expect(advanceAfterTaxBase(year0, 1_000, 0)).toEqual({ base: 1_000, depleted: false });
  });
});

describe('net-need floor removed for surplus income', () => {
  it('returns a NEGATIVE target when income exceeds the inflated expense (surplus)', () => {
    const target = netNeedStrategy({
      stepIdx: 0,
      stepsRemaining: 100,
      currentBalance: 500_000,
      initialBalance: 500_000,
      inflatedExpense: 3_000,
      income: 5_000,
      cumCpi: 1,
      priorWithdrawal: 0,
    });
    expect(target).toBe(-2_000);
  });

  it('still returns the gap (positive) when expense exceeds income', () => {
    const target = netNeedStrategy({
      stepIdx: 0,
      stepsRemaining: 100,
      currentBalance: 500_000,
      initialBalance: 500_000,
      inflatedExpense: 6_000,
      income: 2_000,
      cumCpi: 1,
      priorWithdrawal: 0,
    });
    expect(target).toBe(4_000);
  });

  it('surplus income never manufactures a depletion (negative net need clamps to 0 draw)', () => {
    const surplus = runMonteCarlo({
      ...baseInput,
      portfolioToday: 800_000,
      monthlyExpenseBase: makeMonthlyExpenseBase(20_000, BASE_STEPS),
      ...buildYearArrays({
        firstYear: 2026,
        horizonYear: 2056,
        annualSs: 120_000,
        ssStartYear: 2046,
      }),
      pathCount: 50,
    });
    expect(surplus.successProbability).toBe(1);
  });
});

describe('year-0 RMD base uses today portfolio (not year-end)', () => {
  it('feeds portfolioToday as the year-0 prior balance into the tax pass', () => {
    const rmdAgeArrays = buildYearArrays({
      firstYear: 2026,
      horizonYear: 2028,
      annualSs: 10_000,
      ssStartYear: 2026,
    });
    const ledger: MonteCarloAccountLedger[] = [
      {
        id: 'ira',
        initialPre: 800_000,
        initialPost: 0,
        contribPre: new Float64Array(3 * 12),
        contribPost: new Float64Array(3 * 12),
        deposit: new Float64Array(3 * 12),
        assetMix: { stocksPct: 80, bondsPct: 15, cashPct: 5 },
        assetMixSeries: null,
        cbpPlanningReturnPct: null,
        taxTreatment: 'PRE_TAX',
        accountType: 'OTHER',
      },
    ];
    const input: MonteCarloInput = {
      portfolioToday: 800_000,
      accountMcLedger: ledger,
      annualContribution: 0,
      firstYear: 2026,
      retirementYear: 2026,
      horizonYear: 2028,
      monthlyExpenseBase: makeMonthlyExpenseBase(20_000, 3 * 12),
      ...rmdAgeArrays,
      pathCount: 30,
      seed: 999,
      strategyKind: 'taxEfficient',
      taxContext: buildTaxContext({
        members: [
          {
            memberId: 'rmd-primary',
            isoBirthdate: '1948-03-01',
            onMedicare: true,
            hasAcaCoverage: false,
          },
        ],
      }),
    };
    const out = runMonteCarlo(input);
    expect(out.federalTaxPercentilesByYear?.p50?.[0]).toBeGreaterThanOrEqual(0);
    expect(out.successProbability).toBeGreaterThanOrEqual(0);
  });
});

describe('per-path strategy engine switch', () => {
  it('runs a named strategy path and returns a valid summary', () => {
    const out = runMonteCarlo({
      ...baseInput,
      pathCount: 40,
      strategyKind: 'proportional',
    });
    expect(out.successProbability).toBeGreaterThanOrEqual(0);
    expect(out.successProbability).toBeLessThanOrEqual(1);
    expect(out.medianEndingBalanceNominal).toBeGreaterThanOrEqual(0);
  });

  it('two named strategies can diverge (different drawdown order)', () => {
    const taxEfficient = runMonteCarlo({
      ...baseInput,
      pathCount: 40,
      strategyKind: 'taxEfficient',
    });
    const strategy = runMonteCarlo({
      ...baseInput,
      pathCount: 40,
      strategyKind: 'rothFirst',
    });
    expect(taxEfficient.successProbability).toBeGreaterThanOrEqual(0);
    expect(strategy.successProbability).toBeGreaterThanOrEqual(0);
  });
});

describe('v25 — named-strategy MC paths fund tax per path (two-pass)', () => {
  // A single large pre-tax-only account with a modest portfolio, so the tax drag moves the headline numbers.
  const taxHeavyLedger = (): MonteCarloAccountLedger[] => [
    {
      id: 'ira',
      initialPre: 600_000,
      initialPost: 0,
      contribPre: new Float64Array(BASE_STEPS),
      contribPost: new Float64Array(BASE_STEPS),
      deposit: new Float64Array(BASE_STEPS),
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
      taxTreatment: 'PRE_TAX',
      accountType: 'OTHER',
    },
  ];

  const namedStrategyBase = (): MonteCarloInput => ({
    ...baseInput,
    pathCount: 80,
    portfolioToday: 600_000,
    accountMcLedger: taxHeavyLedger(),
    annualContribution: 0,
    strategyKind: 'proportional',
  });

  it('success% / percentiles ≤ tax-free; depletion no later (direction)', () => {
    const taxFree = runMonteCarlo(namedStrategyBase());
    const taxed = runMonteCarlo({ ...namedStrategyBase(), taxContext: buildTaxContext() });

    expect(taxed.successProbability).toBeLessThanOrEqual(taxFree.successProbability);
    const horizon = taxed.percentilesNominal.p50.length;
    for (let i = 0; i < horizon; i += 1) {
      expect(taxed.percentilesNominal.p50[i]).toBeLessThanOrEqual(
        taxFree.percentilesNominal.p50[i] + 1, // ≤ with a $1 fp tolerance.
      );
    }
    if (taxed.medianDepletionYear !== null && taxFree.medianDepletionYear !== null) {
      expect(taxed.medianDepletionYear).toBeLessThanOrEqual(taxFree.medianDepletionYear);
    }
    // Strict funding guard: if the pass-2 fold regressed to display-only, taxed p50 would equal tax-free at every year.
    expect(taxed.percentilesNominal.p50[horizon - 1]).toBeLessThan(
      taxFree.percentilesNominal.p50[horizon - 1],
    );
  });

  it('the representative run carries the per-path tax-cent fields', () => {
    const out = runMonteCarlo({ ...namedStrategyBase(), taxContext: buildTaxContext() });
    expect(out.federalTaxPercentilesByYear).toBeDefined();
    expect(out.netAfterTaxPercentilesByYear).toBeDefined();
    const fedP50 = out.federalTaxPercentilesByYear!.p50;
    expect(fedP50.some((v) => v > 0)).toBe(true);
  });

  // A pre-59½ rothFirst path whose seeded basis covers its Roth withdrawals pays no tax or 10% penalty; the penalty reaches balances only via
  // taxDrawByYear, so it is asserted on the ending balance against a no-basis control.
  const rothFirstPre59Ledger = (): MonteCarloAccountLedger[] => [
    {
      id: 'roth',
      initialPre: 0,
      initialPost: 600_000,
      contribPre: new Float64Array(BASE_STEPS),
      contribPost: new Float64Array(BASE_STEPS),
      deposit: new Float64Array(BASE_STEPS),
      assetMix: { stocksPct: 60, bondsPct: 35, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
      taxTreatment: 'ROTH',
      accountType: 'RETIREMENT_ROTH_IRA',
    },
  ];

  // Primary born 1991 retires 2046 at age 55: the whole early retirement is pre-59½, so the penalty leg is active.
  const pre59TaxContext = (): McTaxContext =>
    buildTaxContext({
      members: [
        {
          memberId: 'mc-test-primary',
          isoBirthdate: '1991-06-15',
          onMedicare: false,
          hasAcaCoverage: false,
        },
      ],
      rothBasisCentsByOwner: [{ ownerId: 'mc-test-primary', cents: 5_000_000 * 100 }],
    });

  it('pre-59½ rothFirst with full basis pays no spurious Roth tax/penalty (re-seed)', () => {
    const input: MonteCarloInput = {
      ...baseInput,
      pathCount: 60,
      portfolioToday: 600_000,
      accountMcLedger: rothFirstPre59Ledger(),
      annualContribution: 0,
      strategyKind: 'rothFirst',
      monthlyExpenseBase: makeMonthlyExpenseBase(40_000, BASE_STEPS),
      taxContext: pre59TaxContext(),
    };
    const withBasis = runMonteCarlo(input);
    const fedP50 = withBasis.federalTaxPercentilesByYear!.p50;
    const retIdx = 2046 - 2026;
    for (let i = retIdx; i < retIdx + 4; i += 1) {
      expect(fedP50[i]).toBeLessThanOrEqual(1); // ≤ $1 fp tolerance.
    }
    // No-basis control: the carrier starts empty, so Roth earnings and the penalty depress the balance; the full-basis run must end richer.
    const noBasis = runMonteCarlo({
      ...input,
      taxContext: buildTaxContext({
        members: pre59TaxContext().members,
        rothBasisCentsByOwner: [],
      }),
    });
    expect(withBasis.medianEndingBalanceNominal).toBeGreaterThan(
      noBasis.medianEndingBalanceNominal,
    );
  });

  it('a named-strategy input with no ledger + taxContext falls back to the kernel', () => {
    const input: MonteCarloInput = {
      ...baseInput,
      pathCount: 30,
      accountMcLedger: [],
      strategyKind: 'rothFirst',
      taxContext: buildTaxContext(),
    };
    const out = runMonteCarlo(input);
    expect(out.successProbability).toBeGreaterThanOrEqual(0);
    expect(out.successProbability).toBeLessThanOrEqual(1);
    expect(out.federalTaxPercentilesByYear).toBeDefined();
  });
});

describe('per-path CPI-scaled inflation-tracked income', () => {
  it('inflation-tracked income lifts the median ending balance vs flat-nominal', () => {
    const firstYear = 2026;
    const horizonYear = 2056;
    const years = horizonYear - firstYear + 1;
    const stepCount = years * 12;
    const arrays = buildYearArrays({
      firstYear,
      horizonYear,
      annualSs: 0,
      ssStartYear: firstYear,
      annualOtherIncome: 55_000,
    });
    const tracksInflation = arrays.incomeByYear.slice();
    const ledger: MonteCarloAccountLedger[] = [
      {
        id: 'a',
        initialPre: 1_500_000,
        initialPost: 0,
        contribPre: new Float64Array(stepCount),
        contribPost: new Float64Array(stepCount),
        deposit: new Float64Array(stepCount),
        assetMix: { stocksPct: 60, bondsPct: 35, cashPct: 5 },
        assetMixSeries: null,
        cbpPlanningReturnPct: null,
      },
    ];
    const common = {
      // 1000 paths so the inflation-tracked lift dominates block-bootstrap path-mix noise.
      ...baseInput,
      pathCount: 1000,
      seed: 1,
      portfolioToday: 1_500_000,
      accountMcLedger: ledger,
      annualContribution: 0,
      firstYear,
      retirementYear: firstYear,
      horizonYear,
      // A larger expense makes the tracked-income lift a bigger share of the ending balance (75k left it below one seed's variance).
      monthlyExpenseBase: makeMonthlyExpenseBase(120_000, (horizonYear - firstYear + 1) * 12),
      scenarioInflationPct: 3,
      ...arrays,
    };
    const tracked = runMonteCarlo({
      ...common,
      tracksInflationIncomeByYear: tracksInflation,
    });
    const flat = runMonteCarlo({
      ...common,
    });
    expect(tracked.medianEndingBalanceNominal).toBeGreaterThan(
      flat.medianEndingBalanceNominal,
    );
  });
});

describe('drawMonthlySeries — stationary block bootstrap', () => {
  const f = samplerStats as {
    baseline_iid_autocorr: number;
    empirical_autocorr: number;
    empirical_corr: Record<string, number>;
    baseline_iid_drawdown_freq: number;
    empirical_drawdown_freq: number;
    drawdownRunLength: number;
    baseline_iid_p10: number;
    baseline_iid_success: number;
  };

  it('L = 1 reduces EXACTLY to the prior IID per-month draw (bit-identical dates)', () => {
    // The prior IID sampler is one uniformInt per month with no continuation draw; L = 1 must reproduce its sequence.
    const data = HISTORICAL_MONTHLY;
    const iidRng = makeRng(4242);
    const iidDates = Array.from({ length: 240 }, () => data[iidRng.uniformInt(0, data.length - 1)].date);
    const blockL1 = drawMonthlySeries(makeRng(4242), 240, 1);
    expect(blockL1.map((m) => m.date)).toEqual(iidDates);
  });

  it('injects serial dependence: lag-1 |return| autocorrelation clears the clustering bar', () => {
    const months = concatSampledPaths((seed) =>
      drawMonthlySeries(makeRng(seed), RECORDER_SERIES_LEN),
    );
    const ac = absReturnAutocorr(months);
    // At least baseline IID + 0.05 and at least half the empirical autocorrelation.
    expect(ac).toBeGreaterThanOrEqual(f.baseline_iid_autocorr + 0.05);
    expect(ac).toBeGreaterThanOrEqual(0.5 * f.empirical_autocorr);
  });

  it('reproduces sustained drawdowns: multi-month down-run frequency moves toward empirical', () => {
    const months = concatSampledPaths((seed) =>
      drawMonthlySeries(makeRng(seed), RECORDER_SERIES_LEN),
    );
    const freq = drawdownRunFrequency(months, f.drawdownRunLength);
    expect(freq).toBeGreaterThanOrEqual(f.baseline_iid_drawdown_freq + 0.02);
    expect(Math.abs(freq - f.empirical_drawdown_freq)).toBeLessThanOrEqual(0.05);
  });

  it('preserves the joint cross-asset + return-CPI correlation matrix (±0.03 per entry)', () => {
    const months = concatSampledPaths((seed) =>
      drawMonthlySeries(makeRng(seed), RECORDER_SERIES_LEN),
    );
    const sampled = correlationMatrix(months);
    for (const key of Object.keys(f.empirical_corr)) {
      expect(Math.abs(sampled[key] - f.empirical_corr[key])).toBeLessThanOrEqual(0.03);
    }
  });
});

describe('runMonteCarlo — block-bootstrap tail', () => {
  it('shifts successProbability lower than the IID baseline by a bounded amount', () => {
    const f = samplerStats as { baseline_iid_success: number };
    const input = buildRecorderInput();
    // Averaged over the recorder seed set so the bar reads central tendency, not one seed's noise.
    const seeds = [101, 202, 303];
    const successes = seeds.map(
      (seed) => runMonteCarlo({ ...input, seed, pathCount: 100 }).successProbability,
    );
    const mean = successes.reduce((a, b) => a + b, 0) / successes.length;
    const delta = mean - f.baseline_iid_success;
    expect(delta).toBeLessThanOrEqual(-0.01);
    expect(delta).toBeGreaterThanOrEqual(-0.1);
  });
});

describe('runMonteCarlo — injected-return parity bypasses the block sampler', () => {
  it('injected return series reproduces bit-identically regardless of meanBlockLength', () => {
    const stepCount = (baseInput.horizonYear - baseInput.firstYear + 1) * 12;
    const injectedReturns = new Float64Array(stepCount);
    const injectedCpi = new Float64Array(stepCount);
    for (let i = 0; i < stepCount; i += 1) {
      injectedReturns[i] = 0.4 + (i % 12) * 0.01;
      injectedCpi[i] = 0.2;
    }
    const withInjected: MonteCarloInput = { ...baseInput, injectedReturns, injectedCpi };
    const a = runMonteCarlo({ ...withInjected, meanBlockLength: 1 });
    const b = runMonteCarlo({ ...withInjected, meanBlockLength: 12 });
    const c = runMonteCarlo(withInjected);
    expect(a.percentilesNominal.p50).toEqual(b.percentilesNominal.p50);
    expect(a.percentilesReal.p10).toEqual(b.percentilesReal.p10);
    expect(a.successProbability).toBe(b.successProbability);
    expect(c.percentilesNominal.p50).toEqual(a.percentilesNominal.p50);
  });

  it('v32: injected-CPI run — realFactorByYear === 1 / cumCpi and realBalance === balance × factor', () => {
    const stepCount = (baseInput.horizonYear - baseInput.firstYear + 1) * 12;
    const injectedReturns = new Float64Array(stepCount);
    const injectedCpi = new Float64Array(stepCount);
    for (let i = 0; i < stepCount; i += 1) {
      injectedReturns[i] = 0.4 + (i % 12) * 0.01;
      injectedCpi[i] = 0.2;
    }
    const out = runMonteCarlo({ ...baseInput, injectedReturns, injectedCpi });
    const run = out.representativeByBasis!['mc-typical']!;
    let cum = 1;
    const cumCpiAtYearEnd: number[] = [];
    for (let i = 0; i < stepCount; i += 1) {
      cum *= 1 + injectedCpi[i] / 100;
      if ((i + 1) % 12 === 0) cumCpiAtYearEnd.push(cum);
    }
    for (let i = 0; i < run.years.length; i += 1) {
      const expectedFactor = 1 / cumCpiAtYearEnd[i];
      expect(run.realFactorByYear[i]).toBeLessThanOrEqual(1);
      expect(run.realFactorByYear[i]).toBeCloseTo(expectedFactor, 9);
      expect(run.realBalanceByYear[i]).toBeCloseTo(
        run.years[i].balance * run.realFactorByYear[i],
        6,
      );
    }
  });
});

describe('per-account accumulation contribution growth (v35)', () => {
  // Single non-CBP account with today's-dollars contributions; injected returns make every path identical, so p50 is the single trajectory.
  const FIRST_YEAR = 2026;
  const RET_YEAR = 2031; // short accumulation window keeps the math tractable
  const HZN_YEAR = 2051;
  const STEPS = (HZN_YEAR - FIRST_YEAR + 1) * 12;
  const RET_STEP = (RET_YEAR - FIRST_YEAR) * 12;
  const RET_IDX = RET_YEAR - FIRST_YEAR;
  const ANNUAL_CONTRIB = 12_000;

  function growthLedger(
    mode: 'tracks-inflation' | 'fixed',
    fixedPct: number,
    asOfMonth: number,
  ): MonteCarloAccountLedger {
    const contribPost = new Float64Array(STEPS);
    const base = ANNUAL_CONTRIB / 12;
    for (let i = 0; i < RET_STEP; i += 1) {
      const factor =
        mode === 'fixed'
          ? Math.pow(1 + fixedPct / 100, (FIRST_YEAR * 12 + i - asOfMonth) / 12)
          : 1;
      contribPost[i] = base * factor;
    }
    return {
      id: 'grow',
      initialPre: 0,
      initialPost: 0,
      contribPre: new Float64Array(STEPS),
      contribPost,
      deposit: new Float64Array(STEPS),
      assetMix: { stocksPct: 100, bondsPct: 0, cashPct: 0 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
      contribGrowthMode: mode,
      plannedContribPostBase: mode === 'tracks-inflation' ? contribPost.slice() : null,
    };
  }

  function growthInput(
    ledger: MonteCarloAccountLedger,
    injReturnMonthlyPct: number,
    injCpiMonthlyPct: number,
    todayMonthIndex = 0,
  ): MonteCarloInput {
    const injectedReturns = new Float64Array(STEPS).fill(injReturnMonthlyPct);
    const injectedCpi = new Float64Array(STEPS).fill(injCpiMonthlyPct);
    return {
      portfolioToday: 0,
      accountMcLedger: [ledger],
      annualContribution: ANNUAL_CONTRIB,
      firstYear: FIRST_YEAR,
      todayMonthIndex,
      retirementYear: RET_YEAR,
      horizonYear: HZN_YEAR,
      monthlyExpenseBase: makeMonthlyExpenseBase(0, STEPS),
      ...buildYearArrays({
        firstYear: FIRST_YEAR,
        horizonYear: HZN_YEAR,
        annualSs: 0,
        ssStartYear: RET_YEAR,
      }),
      pathCount: 1,
      seed: 7,
      strategyKind: 'taxEfficient',
      injectedReturns,
      injectedCpi,
    };
  }

  it('a tracks-inflation contribution scales nominally with each path CPI (flat-real)', () => {
    const asOfMonth = FIRST_YEAR * 12;
    const ledger = growthLedger('tracks-inflation', 0, asOfMonth);
    const low = runMonteCarlo(growthInput(ledger, 0, 0.1));
    const high = runMonteCarlo(growthInput(ledger, 0, 0.4));
    expect(low.percentilesNominal.p50[RET_IDX]).toBeGreaterThan(0);
    expect(high.percentilesNominal.p50[RET_IDX]).toBeGreaterThan(
      low.percentilesNominal.p50[RET_IDX],
    );
    const zero = runMonteCarlo(growthInput(ledger, 0, 0));
    expect(low.percentilesNominal.p50[RET_IDX]).toBeGreaterThan(
      zero.percentilesNominal.p50[RET_IDX],
    );
  });

  it('a tracks-inflation account == a fixed account at the same rate (cross-mode parity)', () => {
    const scenarioRatePct = 3;
    const monthlyCpi = (Math.pow(1 + scenarioRatePct / 100, 1 / 12) - 1) * 100;
    const asOfMonth = FIRST_YEAR * 12;
    const tracks = runMonteCarlo(
      growthInput(growthLedger('tracks-inflation', 0, asOfMonth), 0, monthlyCpi),
    );
    const fixed = runMonteCarlo(
      growthInput(growthLedger('fixed', scenarioRatePct, asOfMonth), 0, monthlyCpi),
    );
    for (let i = 0; i < tracks.percentilesNominal.p50.length; i += 1) {
      expect(fixed.percentilesNominal.p50[i]).toBeCloseTo(
        tracks.percentilesNominal.p50[i],
        6,
      );
    }
  });

  it('tracks-inflation parity holds for a NON-January today (todayMonthIndex=5)', () => {
    // Regression: with todayMonthIndex = 0 the step-0 anchor coincides with the correct one; for a May today the per-path CPI scaling must
    // re-anchor to step 5, or the pot grows ~5 extra months of inflation.
    const scenarioRatePct = 3;
    const monthlyCpi = (Math.pow(1 + scenarioRatePct / 100, 1 / 12) - 1) * 100;
    const TODAY_MONTH = 5;
    const asOfMonth = FIRST_YEAR * 12 + TODAY_MONTH;
    const tracks = runMonteCarlo(
      growthInput(growthLedger('tracks-inflation', 0, asOfMonth), 0, monthlyCpi, TODAY_MONTH),
    );
    const fixed = runMonteCarlo(
      growthInput(growthLedger('fixed', scenarioRatePct, asOfMonth), 0, monthlyCpi, TODAY_MONTH),
    );
    for (let i = 0; i < tracks.percentilesNominal.p50.length; i += 1) {
      expect(fixed.percentilesNominal.p50[i], `fixed-bake parity step ${i}`).toBeCloseTo(
        tracks.percentilesNominal.p50[i],
        6,
      );
    }
    // With zero return the at-retirement pot is the sum of the deterministic today-anchored contribution series.
    const base = ANNUAL_CONTRIB / 12;
    let deterministicPot = 0;
    for (let i = 0; i < RET_STEP; i += 1) {
      deterministicPot +=
        base * contributionGrowthFactor(scenarioRatePct, FIRST_YEAR * 12 + i, asOfMonth);
    }
    expect(tracks.percentilesNominal.p50[RET_IDX]).toBeCloseTo(deterministicPot, 4);
  });

  it('an explicit fixed rate above 0 ends with a larger pot than flat-nominal (0)', () => {
    const asOfMonth = FIRST_YEAR * 12;
    const flat = runMonteCarlo(
      growthInput(growthLedger('fixed', 0, asOfMonth), 0, 0),
    );
    const grown = runMonteCarlo(
      growthInput(growthLedger('fixed', 5, asOfMonth), 0, 0),
    );
    expect(grown.percentilesNominal.p50[RET_IDX]).toBeGreaterThan(
      flat.percentilesNominal.p50[RET_IDX],
    );
  });
});

const FIELD_SEED = 5;

// Assembles a summary over a hand-built accumulation, so the representative picks and bands come from the production reducer.
function summarizeField(endingReal: number[], depletionYearByPath: (number | null)[]): MonteCarloSummary {
  const input: MonteCarloInput = { ...baseInput, pathCount: endingReal.length, seed: FIELD_SEED };
  const horizon = input.horizonYear - input.firstYear + 1;
  const balances = (): number[][] => Array.from({ length: horizon }, () => endingReal.slice());
  const acc: PathLoopAccumulation = {
    balancesByYearNominal: balances(),
    balancesByYearReal: balances(),
    taxAcc: null,
    endingNominal: endingReal,
    endingReal,
    depletionYears: depletionYearByPath.filter((d): d is number => d !== null),
    depletionYearByPath,
    failureYearHistogram: new Array<number>(horizon).fill(0),
    successes: depletionYearByPath.filter((d) => d === null).length,
  };
  return assembleMonteCarloSummary(input, buildRunContext(input), acc);
}

function pathIndexOfSeed(seed: number | undefined, pathCount: number): number {
  return Array.from({ length: pathCount }, (_v, i) => i).findIndex(
    (i) => seedForPathIndex(FIELD_SEED, i) === seed,
  );
}

function typicalPickIndex(endingReal: number[], depletionYearByPath: (number | null)[]): number {
  return pathIndexOfSeed(summarizeField(endingReal, depletionYearByPath).representativeTypicalSeed, endingReal.length);
}

describe('representative-run output (v22)', () => {
  const HORIZON = baseInput.horizonYear - baseInput.firstYear + 1;

  // An under-funded multi-account plan depletes most paths, so every tier's rank-p path is effectively depleted and the tie-break reconciles
  // each run-out year to its card stat.
  const consistencyInput: MonteCarloInput = {
    ...baseInput,
    horizonYear: LONG_HORIZON_YEAR,
    pathCount: 400,
    portfolioToday: 600_000,
    accountMcLedger: buildLedger({
      primaryPortfolio: 360_000,
      secondaryPortfolio: 240_000,
      annualPlannedContribution: 0,
      stepCount: LONG_STEPS,
      retirementStepIdx: BASE_RETIREMENT_STEP,
    }),
    annualContribution: 0,
    monthlyExpenseBase: makeMonthlyExpenseBase(110_000, LONG_STEPS),
    ...buildYearArrays({ firstYear: 2026, horizonYear: LONG_HORIZON_YEAR, annualSs: 20_000, ssStartYear: 2046 }),
  };
  type McBasisRun = NonNullable<
    ReturnType<typeof runMonteCarlo>['representativeByBasis']
  >['mc-typical'];

  it('emits a representative run per basis tier, each spanning the horizon from firstYear', () => {
    const out = runMonteCarlo({ ...baseInput, pathCount: 200 });
    expect(out.representativeByBasis).toBeDefined();
    const byBasis = out.representativeByBasis!;
    for (const basis of ['mc-typical', 'mc-pessimistic', 'mc-bad-luck'] as const) {
      const run = byBasis[basis];
      expect(run, basis).not.toBeNull();
      if (!run) continue;
      expect(run.firstYear).toBe(baseInput.firstYear);
      expect(run.years.length).toBe(HORIZON);
      expect(run.years[0].year).toBe(baseInput.firstYear);
      expect(run.realBalanceByYear.length).toBe(HORIZON);
      expect(run.realGrowthByYear.length).toBe(HORIZON);
      expect(run.realFactorByYear.length).toBe(HORIZON);
    }
  });

  it('v32: realFactorByYear satisfies the balance-line identity (strategy path)', () => {
    const out = runMonteCarlo({
      ...baseInput,
      pathCount: 200,
      strategyKind: 'proportional',
    });
    const run = out.representativeByBasis!['mc-typical']!;
    for (let i = 0; i < run.years.length; i += 1) {
      const factor = run.realFactorByYear[i];
      expect(Number.isFinite(factor), `strategy factor ${i}`).toBe(true);
      expect(factor).toBeGreaterThan(0);
      expect(run.realBalanceByYear[i]).toBeCloseTo(run.years[i].balance * factor, 6);
    }
  });

  it('surfaces the three replay seeds, each derivable from the chosen path index', () => {
    const out = runMonteCarlo({ ...baseInput, pathCount: 200 });
    // Each replay seed is (baseSeed + pathIndex * 0x9e3779b1) >>> 0.
    for (const seed of [
      out.representativeTypicalSeed,
      out.representativePessimisticSeed,
      out.representativeBadLuckSeed,
    ]) {
      expect(seed).toBeDefined();
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed! >>> 0).toBe(seed);
    }
  });

  it('reconciles each year: balance ≈ prior + growth − withdrawn + deposit', () => {
    const out = runMonteCarlo({ ...baseInput, pathCount: 200 });
    const run = out.representativeByBasis!['mc-pessimistic']!;
    let prior = baseInput.portfolioToday;
    for (let y = 0; y < run.years.length; y += 1) {
      const yr = run.years[y];
      if (yr.depleted || yr.balance <= 0) {
        prior = yr.balance;
        continue;
      }
      const expected = prior + yr.growth - yr.withdrawn + yr.deposit;
      // Per-account compounding and month-precise CPI leave a small residual, so the tolerance is 2% of the balance.
      const tol = Math.max(1, Math.abs(expected) * 0.02);
      expect(Math.abs(yr.balance - expected)).toBeLessThanOrEqual(tol);
      prior = yr.balance;
    }
  });

  it('ranks by REAL ending balance: Bad-luck (P10) ≤ Pessimistic (P25) ≤ Typical (P50) (within 1 for depleted tiers)', () => {
    // Reconciled depleted tiers end at ~1e-9 residuals ordered by depletion year, so the ending-balance ordering holds to $1 for them.
    const out = runMonteCarlo({ ...baseInput, pathCount: 400 });
    const byBasis = out.representativeByBasis!;
    const realEnd = (b: typeof byBasis['mc-typical']): number =>
      b ? b.realBalanceByYear[b.realBalanceByYear.length - 1] : 0;
    const badLuck = realEnd(byBasis['mc-bad-luck']);
    const pessimistic = realEnd(byBasis['mc-pessimistic']);
    const typical = realEnd(byBasis['mc-typical']);
    expect(badLuck).toBeLessThanOrEqual(pessimistic + 1);
    expect(pessimistic).toBeLessThanOrEqual(typical + 1);
  });

  it('reconciled depleted tiers satisfy the depletion-year ordering p10 ≤ p25 ≤ median', () => {
    const out = runMonteCarlo(consistencyInput);
    const byBasis = out.representativeByBasis!;
    const dep = (b: McBasisRun): number => {
      expect(b).not.toBeNull();
      expect(b!.depletionYear).not.toBeNull();
      return b!.depletionYear as number;
    };
    const badLuck = dep(byBasis['mc-bad-luck']);
    const pessimistic = dep(byBasis['mc-pessimistic']);
    const typical = dep(byBasis['mc-typical']);
    expect(badLuck).toBeLessThanOrEqual(pessimistic);
    expect(pessimistic).toBeLessThanOrEqual(typical);
  });

  it('perMonthWithdrawal length covers the drawdown phase from the retirement year', () => {
    const out = runMonteCarlo({ ...baseInput, pathCount: 200 });
    const run = out.representativeByBasis!['mc-typical']!;
    const drawdownYears = baseInput.horizonYear - baseInput.retirementYear + 1;
    expect(run.perMonthWithdrawal.length).toBe(drawdownYears * 12);
  });

  it('captures through the strategy-engine path (named strategy)', () => {
    const out = runMonteCarlo({
      ...baseInput,
      pathCount: 200,
      strategyKind: 'proportional',
    });
    const run = out.representativeByBasis!['mc-typical'];
    expect(run).not.toBeNull();
    expect(run!.years.length).toBe(HORIZON);
    expect(run!.years[run!.years.length - 1].year).toBe(baseInput.horizonYear);
  });

  it('nominal and real per-year balances differ by the path own CPI (real ≤ nominal late-horizon)', () => {
    const out = runMonteCarlo({ ...baseInput, pathCount: 200 });
    const run = out.representativeByBasis!['mc-typical']!;
    const lastIdx = run.years.length - 1;
    const nominal = run.years[lastIdx].balance;
    const real = run.realBalanceByYear[lastIdx];
    if (nominal > 0) {
      expect(real).toBeLessThan(nominal);
    }
  });

  it('(a) reconciles every effectively-depleted tier exactly to its card depletion stat', () => {
    // The rank-p path is effectively depleted for all three tiers, so each run-out year must equal its card percentile exactly despite the multi-account fp residual.
    const out = runMonteCarlo(consistencyInput);
    const byBasis = out.representativeByBasis!;
    expect(out.medianDepletionYear).not.toBeNull();
    expect(out.p25DepletionYear).not.toBeNull();
    expect(out.p10DepletionYear).not.toBeNull();
    expect(byBasis['mc-typical']!.depletionYear).toBe(out.medianDepletionYear);
    expect(byBasis['mc-pessimistic']!.depletionYear).toBe(out.p25DepletionYear);
    expect(byBasis['mc-bad-luck']!.depletionYear).toBe(out.p10DepletionYear);
  });

  it('(b) the default pick moves toward the card target (a no-op reconcile fails)', () => {
    // Rank-p is path 0 (run-out 2050); the typical card stat is 2070, held by path 2.
    const endingReal = [0.0000003, 0.0000001, 0.0000002, 0.0000004, 0.0000005];
    const depletionYearByPath = [2050, 2080, 2070, 2090, 2060];
    expect(typicalPickIndex(endingReal, depletionYearByPath)).toBe(2);
  });

  it('(c)(f) a revived bounce-back path at the card target is not a candidate, and equidistant depleters tie to the lower pathIndex', () => {
    // Path 1 ran out in 2070 (the card stat) but a later deposit revived it above EPS_REAL; paths 0 and 2 are 5 years either side.
    const endingReal = [0.0000003, 50_000, 0.0000004];
    const depletionYearByPath = [2065, 2070, 2075];
    expect(typicalPickIndex(endingReal, depletionYearByPath)).toBe(0);
  });

  it('(d) a material-balance rank-p path keeps its own pick', () => {
    const endingReal = [0.0000002, 1_234_567, 5_000_000];
    const depletionYearByPath = [2055, 2080, null];
    expect(typicalPickIndex(endingReal, depletionYearByPath)).toBe(1);
  });

  it('(e) a near-$0 cluster with no recorded depletion keeps its rank pick', () => {
    const endingReal = [0.0000003, 0.0000004, 0.0000002];
    const depletionYearByPath = [null, null, null];
    expect(typicalPickIndex(endingReal, depletionYearByPath)).toBe(0);
  });

  it('(h) named-strategy: representativeRun.depletionYear === depletionYearByPath[chosenIndex] (card stat), post-pass leaves it untouched', () => {
    const named = runMonteCarlo({ ...consistencyInput, strategyKind: 'proportional' });
    const byBasis = named.representativeByBasis!;
    expect(named.p25DepletionYear).not.toBeNull();
    const pess = byBasis['mc-pessimistic']!;
    expect(pess.depletionYear).toBe(named.p25DepletionYear);
    const drawdownRow = pess.years.find((y) => y.depleted);
    expect(drawdownRow?.depleted).toBe(true);
    expect(pess.depletionYear).toBeGreaterThanOrEqual(baseInput.retirementYear);
    expect(pess.depletionYear).toBeLessThanOrEqual(consistencyInput.horizonYear);
  });
});

describe('representative-run reroll band (v27)', () => {
  const consistencyInput: MonteCarloInput = {
    ...baseInput,
    pathCount: 400,
    portfolioToday: 600_000,
    accountMcLedger: buildLedger({
      primaryPortfolio: 360_000,
      secondaryPortfolio: 240_000,
      annualPlannedContribution: 0,
      stepCount: BASE_STEPS,
      retirementStepIdx: BASE_RETIREMENT_STEP,
    }),
    annualContribution: 0,
    monthlyExpenseBase: makeMonthlyExpenseBase(110_000, BASE_STEPS),
    ...buildYearArrays({ firstYear: 2026, horizonYear: 2056, annualSs: 20_000, ssStartYear: 2046 }),
  };

  it('exposes a per-tier band of candidate path seeds on the summary', () => {
    const out = runMonteCarlo(consistencyInput);
    expect(out.representativeBandsByBasis).toBeDefined();
    const bands = out.representativeBandsByBasis!;
    for (const basis of ['mc-typical', 'mc-pessimistic', 'mc-bad-luck'] as const) {
      expect(Array.isArray(bands[basis]), basis).toBe(true);
      expect(bands[basis].length, basis).toBeGreaterThanOrEqual(1);
      for (const seed of bands[basis]) {
        expect(Number.isInteger(seed)).toBe(true);
        expect(seed >>> 0).toBe(seed); // unsigned 32-bit replay seed
      }
    }
  });

  // Opt-in: needs a 10,000-path run (the production path count).
  it.skipIf(!process.env.PERF_ASSERT)('±DEPLETION_BUCKET-year window yields ≥2 band members at production pathCount on a depleting fixture', () => {
    // At the production path count a depleting tier's window holds at least 2 paths, so the reroll control is enabled (density regression).
    const out = runMonteCarlo({ ...consistencyInput, pathCount: 10_000 });
    const bands = out.representativeBandsByBasis!;
    expect(bands['mc-pessimistic'].length).toBeGreaterThanOrEqual(2);
    expect(bands['mc-bad-luck'].length).toBeGreaterThanOrEqual(2);
  });

  it('band element 0 == the Part-1 reconciled default pick / seed for every tier', () => {
    const out = runMonteCarlo(consistencyInput);
    const bands = out.representativeBandsByBasis!;
    expect(bands['mc-typical'][0]).toBe(out.representativeTypicalSeed);
    expect(bands['mc-pessimistic'][0]).toBe(out.representativePessimisticSeed);
    expect(bands['mc-bad-luck'][0]).toBe(out.representativeBadLuckSeed);
  });

  it('tolerance-gating: every depleted-tier band member depletes within the bucket of the card stat', () => {
    // A widened gate would pull the far depleter (idx 4, 2090) into the band.
    const endingReal = [0.000001, 0.0000009, 0.0000008, 0.0000007, 0.0000006, 0.0000005];
    const depletionYearByPath = [2070, 2071, 2069, 2072, 2090, 2071];
    const bands = summarizeField(endingReal, depletionYearByPath).representativeBandsByBasis!;
    const memberIndices = bands['mc-pessimistic'].map((seed) => pathIndexOfSeed(seed, endingReal.length));
    for (const idx of memberIndices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(Math.abs(depletionYearByPath[idx]! - 2070)).toBeLessThanOrEqual(2);
    }
    expect(memberIndices).not.toContain(4);
  });


  it('even-spread: a dense in-window set is sampled across distinct depletion years, not the closest cluster', () => {
    // 40 effectively-depleted paths within ±1 of the target: the cap must keep a spread of depletion years, not 25 copies of the closest.
    const n = 40;
    const endingReal = Array.from({ length: n }, () => 0.0000005);
    const depletionYearByPath = Array.from({ length: n }, (_v, i) => 2069 + (i % 3));
    const band = summarizeField(endingReal, depletionYearByPath).representativeBandsByBasis!['mc-pessimistic'];
    expect(band.length).toBe(25);
    const memberYears = new Set(band.map((seed) => depletionYearByPath[pathIndexOfSeed(seed, n)]));
    expect(memberYears.size).toBeGreaterThan(1);
  });


  it('pickBandIndex is pure, in [1, bandLen−1], never 0, and reproducible', () => {
    const basis = 'mc-pessimistic' as const;
    for (let nonce = 0; nonce < 50; nonce += 1) {
      const a = pickBandIndex(10, 12345, basis, nonce);
      const b = pickBandIndex(10, 12345, basis, nonce);
      expect(a).toBe(b); // pure: same args → same index
      expect(a).toBeGreaterThanOrEqual(1);
      expect(a).toBeLessThanOrEqual(9);
    }
    for (let nonce = 0; nonce < 10; nonce += 1) {
      expect(pickBandIndex(2, 999, basis, nonce)).toBe(1);
    }
  });

  it('pickBandIndex walks the alternatives (consecutive nonces visit >1 distinct index)', () => {
    const seen = new Set<number>();
    for (let nonce = 0; nonce < 8; nonce += 1) {
      seen.add(pickBandIndex(8, 42, 'mc-typical', nonce));
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(seen.has(0)).toBe(false);
  });

  it('pickBandIndex is a full permutation: one cycle visits every alternative once, none back-to-back', () => {
    const bandLen = 10;
    const altCount = bandLen - 1;
    const visited: number[] = [];
    for (let nonce = 1; nonce <= altCount; nonce += 1) {
      visited.push(pickBandIndex(bandLen, 777, 'mc-bad-luck', nonce));
    }
    expect(new Set(visited).size).toBe(altCount);
    expect(Math.min(...visited)).toBe(1);
    expect(Math.max(...visited)).toBe(altCount);
    for (let k = 1; k <= altCount; k += 1) {
      const a = pickBandIndex(bandLen, 777, 'mc-bad-luck', k);
      const b = pickBandIndex(bandLen, 777, 'mc-bad-luck', k + 1);
      expect(a).not.toBe(b);
    }
  });

  it('main-thread replay reproduces the WORKER-captured representative run bit-for-bit', () => {
    const out = runMonteCarlo(consistencyInput);
    const seed = out.representativePessimisticSeed!;
    const workerRun = out.representativeByBasis!['mc-pessimistic']!;
    const ctx = buildRunContext(consistencyInput);
    const replay = runOnePath(consistencyInput, seed, ctx, true).representative;
    expect(replay).toBeDefined();
    expect(replay!.years.map((y) => y.balance)).toEqual(
      workerRun.years.map((y) => y.balance),
    );
    expect(replay!.depletionYear).toBe(workerRun.depletionYear);
    expect(replay!.realBalanceByYear).toEqual(workerRun.realBalanceByYear);
    expect(replay!.realFactorByYear).toEqual(workerRun.realFactorByYear);
  });
});

describe('representative-run per-account capture (v23)', () => {
  const RET_IDX = 2046 - 2026;
  const HORIZON = baseInput.horizonYear - baseInput.firstYear + 1;

  function rmdLedger(portfolio: number): MonteCarloAccountLedger[] {
    return [
      {
        id: 'k401',
        initialPre: portfolio,
        initialPost: 0,
        contribPre: new Float64Array(BASE_STEPS),
        contribPost: new Float64Array(BASE_STEPS),
        deposit: new Float64Array(BASE_STEPS),
        assetMix: { stocksPct: 60, bondsPct: 35, cashPct: 5 },
        assetMixSeries: null,
        cbpPlanningReturnPct: null,
        taxTreatment: 'PRE_TAX',
        accountType: 'RETIREMENT_401K',
        ownerId: 'mc-test-primary',
      },
    ];
  }

  // Born 1951 (RMD age 73 attained by 2024): every drawdown year is RMD-age, so the post-pass produces a positive floor.
  const rmdMemberContext = (): McTaxContext =>
    buildTaxContext({
      members: [
        {
          memberId: 'mc-test-primary',
          isoBirthdate: '1951-03-10',
          onMedicare: true,
          hasAcaCoverage: false,
        },
      ],
    });

  it('kernel path: drawdown-phase years carry accountBalances summing to the pooled balance', () => {
    const out = runMonteCarlo({ ...baseInput, pathCount: 200 });
    const run = out.representativeByBasis!['mc-typical']!;
    expect(run.years[RET_IDX - 1].accountBalances).toBeUndefined();
    let checkedDrawdown = false;
    for (let y = RET_IDX; y < run.years.length; y += 1) {
      const yr = run.years[y];
      const map = yr.accountBalances;
      expect(map, `year offset ${y}`).toBeDefined();
      if (!map) continue;
      let sum = 0;
      for (const acct of map.values()) {
        expect(acct.balance).toBeCloseTo(acct.preEnd + acct.postEnd, 4);
        sum += acct.balance;
      }
      expect(sum).toBeCloseTo(yr.balance, 2);
      checkedDrawdown = true;
    }
    expect(checkedDrawdown).toBe(true);
  });

  it('strategy path: drawdown-phase years carry accountBalances from the engine map', () => {
    const out = runMonteCarlo({
      ...baseInput,
      pathCount: 200,
      strategyKind: 'proportional',
    });
    const run = out.representativeByBasis!['mc-typical']!;
    const lastIdx = run.years.length - 1;
    const map = run.years[lastIdx].accountBalances;
    expect(map).toBeDefined();
    let sum = 0;
    for (const acct of map!.values()) sum += acct.balance;
    expect(sum).toBeCloseTo(run.years[lastIdx].balance, 2);
  });

  it('attaches per-owner rmdFloorCents/rmdShortfallCents on RMD-age drawdown years', () => {
    const out = runMonteCarlo({
      ...baseInput,
      pathCount: 200,
      accountMcLedger: rmdLedger(800_000),
      taxContext: rmdMemberContext(),
    });
    const run = out.representativeByBasis!['mc-typical']!;
    const withFloor = run.years.filter((yr) => (yr.rmdFloorCents ?? 0) > 0);
    expect(withFloor.length).toBeGreaterThan(0);
    for (const yr of withFloor) {
      expect(yr.rmdShortfallCents).toBeDefined();
      expect(yr.rmdShortfallCents).toBeGreaterThanOrEqual(0);
      expect(yr.rmdShortfallCents!).toBeLessThanOrEqual(yr.rmdFloorCents!);
    }
  });

  it('leaves rmd fields absent when there is no qualifying tax-deferred account', () => {
    // baseInput accounts have no accountType (OTHER, non-qualifying), so the post-pass populates nothing.
    const out = runMonteCarlo({
      ...baseInput,
      pathCount: 200,
      taxContext: rmdMemberContext(),
    });
    const run = out.representativeByBasis!['mc-typical']!;
    const anyFloor = run.years.some((yr) => (yr.rmdFloorCents ?? 0) > 0);
    expect(anyFloor).toBe(false);
  });

  it('horizon length unchanged + reconciliation still holds with the RMD ledger', () => {
    const out = runMonteCarlo({
      ...baseInput,
      pathCount: 200,
      accountMcLedger: rmdLedger(800_000),
      taxContext: rmdMemberContext(),
    });
    const run = out.representativeByBasis!['mc-typical']!;
    expect(run.years.length).toBe(HORIZON);
  });

  // A $2M pre-tax 401k at RMD age: the forced RMD far exceeds net spending, so the inline pre-pass runs and the surplus flows to overflow cash.
  it('strategy path: inline RMD pre-pass fires for qualifying ledger, surplus flows to rmdOverflowToCashCents on drawdown years', () => {
    const out = runMonteCarlo({
      ...baseInput,
      pathCount: 200,
      strategyKind: 'proportional',
      accountMcLedger: rmdLedger(2_000_000),
      taxContext: rmdMemberContext(),
    });
    const run = out.representativeByBasis!['mc-typical']!;
    const surplusYears = run.years.filter((yr) => (yr.rmdOverflowToCashCents ?? 0) > 0);
    expect(surplusYears.length).toBeGreaterThan(0);
    for (const yr of surplusYears) {
      expect(yr.rmdOverflowToCashCents).toBeGreaterThan(0);
      expect(yr.rmdReinvestedCents).toBeUndefined();
    }
  });

  // An inherited Roth IRA alone must still yield an RMD context (its admission gate accepts it where the living-owner test would not),
  // observable as the synthetic overflow cash carrier.
  const inheritedRothLedger: MonteCarloAccountLedger[] = [
    {
      ...rmdLedger(800_000)[0],
      id: 'inherited-roth-ira',
      initialPre: 0,
      initialPost: 800_000,
      taxTreatment: 'ROTH',
      accountType: 'RETIREMENT_ROTH_IRA',
    },
  ];

  it('strategy path: an inherited Roth IRA alone still yields an RMD context', () => {
    const carrierPresent = (out: ReturnType<typeof runMonteCarlo>): boolean =>
      (out.representativeByBasis!['mc-typical']!.years ?? []).some((yr) =>
        yr.accountBalances?.has(RMD_OVERFLOW_CASH_ACCOUNT_ID),
      );
    const withFacts = runMonteCarlo({
      ...baseInput,
      pathCount: 50,
      strategyKind: 'proportional',
      accountMcLedger: inheritedRothLedger,
      taxContext: rmdMemberContext(),
      mcRmdContext: {
        members: rmdMemberContext().members,
        rmdSnapshot: rmdMemberContext().taxBundle.rmd,
        rmdFactsByAccountId: { 'inherited-roth-ira': { inheritedAccount: true } },
      },
    });
    expect(carrierPresent(withFacts)).toBe(true);

    const withoutFacts = runMonteCarlo({
      ...baseInput,
      pathCount: 50,
      strategyKind: 'proportional',
      accountMcLedger: inheritedRothLedger,
      taxContext: rmdMemberContext(),
    });
    expect(carrierPresent(withoutFacts)).toBe(false);
  });

  // Pins the facts forwarding, separate from the admission gate: drop it and the context still exists, but the engine's inherited-account
  // classification and Fill-target rejection silently diverge from the deterministic engine.
  it('strategy path: the rebuilt RMD context carries rmdFactsByAccountId through to the engine', () => {
    // An inherited Roth IRA cannot receive Fill-converted principal, but only if the engine reads the inherited fact off the rebuilt context.
    const input = runBalanceProjectionMc(flooredFillArgs({ withFloor: false }));
    const convertedCents = (inherited: boolean): number => {
      const taxContext = input.taxContext!;
      const out = runMonteCarlo({
        ...input,
        pathCount: 1,
        seed: 5,
        ...(inherited
          ? {
              mcRmdContext: {
                ...input.mcRmdContext,
                members: taxContext.members,
                rmdSnapshot: taxContext.taxBundle.rmd,
                rmdFactsByAccountId: { roth: { inheritedAccount: true } },
              },
            }
          : {}),
      });
      return (out.representativeByBasis?.['mc-typical']?.years ?? []).reduce(
        (sum, y) => sum + (y.rothConvertedCents ?? 0),
        0,
      );
    };
    expect(convertedCents(false)).toBeGreaterThan(0);
    expect(convertedCents(true)).toBe(0);
  });


  it('strategy path: no surplus fields when ledger is non-qualifying (positive-branch contrast)', () => {
    const out = runMonteCarlo({
      ...baseInput,
      pathCount: 200,
      strategyKind: 'proportional',
      taxContext: rmdMemberContext(),
    });
    const run = out.representativeByBasis!['mc-typical']!;
    const anyOverflow = run.years.some((yr) => (yr.rmdOverflowToCashCents ?? 0) > 0);
    const anyReinvested = run.years.some((yr) => (yr.rmdReinvestedCents ?? 0) > 0);
    expect(anyOverflow).toBe(false);
    expect(anyReinvested).toBe(false);
  });
});

describe('representative-run accumulation capture (v34)', () => {
  const RET_IDX = 2046 - 2026;

  // Frozen first drawdown rows (baseInput, seed 12345, 200 paths, mc-typical, taxEfficient strategy path).
  const FROZEN_V50 = {
    depletionYear: null as number | null,
    firstDrawdownYears: [
      { year: 2046, balance: 5541412.786764895, withdrawn: 123116.80335865493, growth: 396281.27675612294 },
      { year: 2047, balance: 5962116.437162663, withdrawn: 126001.07385001527, growth: 546704.724247783 },
      { year: 2048, balance: 5469252.449963968, withdrawn: 129710.48077189457, growth: -363153.5064268012 },
    ],
  };
  // Frozen first-drawdown RMD and tax cents for an owner past the RMD trigger age at retirement; the per-owner RMD floor drives the per-path tax.
  const FROZEN_V50_RMD = {
    rmdFloorCents: 51389345,
    rmdShortfallCents: 0,
    federalTaxCents: 15120446,
    irmaaSurchargeCents: 0,
  };

  function rmdLedger(portfolio: number): MonteCarloAccountLedger[] {
    return [
      {
        id: 'k401',
        initialPre: portfolio,
        initialPost: 0,
        contribPre: new Float64Array(LONG_STEPS),
        contribPost: new Float64Array(LONG_STEPS),
        deposit: new Float64Array(LONG_STEPS),
        assetMix: { stocksPct: 60, bondsPct: 35, cashPct: 5 },
        assetMixSeries: null,
        cbpPlanningReturnPct: null,
        taxTreatment: 'PRE_TAX',
        accountType: 'RETIREMENT_401K',
        ownerId: 'mc-test-primary',
      },
    ];
  }
  const rmdMemberContext = (): McTaxContext =>
    buildTaxContext({
      members: [
        {
          memberId: 'mc-test-primary',
          isoBirthdate: '1951-03-10',
          onMedicare: true,
          hasAcaCoverage: false,
        },
      ],
    });

  it('kernel path: representative run exposes accumulationAccountBalances for pre-retirement years', () => {
    const out = runMonteCarlo({ ...baseInput, pathCount: 200 });
    const run = out.representativeByBasis!['mc-typical']!;
    const accum = run.accumulationAccountBalances;
    expect(accum).toBeDefined();
    expect(accum!.length).toBe(RET_IDX);
    expect(accum![0].year).toBe(baseInput.firstYear);
    expect(accum![accum!.length - 1].year).toBe(baseInput.retirementYear - 1);
    for (const entry of accum!) {
      for (const acct of entry.accountBalances.values()) {
        expect(acct.balance).toBeCloseTo(acct.preEnd + acct.postEnd, 4);
        expect(acct.withdrawn).toBe(0);
        expect(acct.deposit).toBe(0);
        expect(acct.preWithdrawnCents).toBeUndefined();
        expect(acct.postWithdrawnCents).toBeUndefined();
      }
    }
  });

  it('named-strategy path: representative run exposes accumulationAccountBalances for pre-retirement years', () => {
    const out = runMonteCarlo({
      ...baseInput,
      pathCount: 200,
      strategyKind: 'proportional',
    });
    const run = out.representativeByBasis!['mc-typical']!;
    const accum = run.accumulationAccountBalances;
    expect(accum).toBeDefined();
    expect(accum!.length).toBe(RET_IDX);
    expect(accum![0].year).toBe(baseInput.firstYear);
    for (const acct of accum![0].accountBalances.values()) {
      expect(acct.balance).toBeCloseTo(acct.preEnd + acct.postEnd, 4);
      expect(acct.withdrawn).toBe(0);
      expect(acct.deposit).toBe(0);
    }
  });

  it('years[] accumulation rows still carry NO accountBalances (phase discriminator intact)', () => {
    // The accumulation field lives only on the representative run, not on years[] rows, which consumers use to tell accumulation from drawdown.
    for (const strategyKind of ['taxEfficient', 'proportional'] as const) {
      const out = runMonteCarlo({ ...baseInput, pathCount: 200, strategyKind });
      const run = out.representativeByBasis!['mc-typical']!;
      for (let y = 0; y < RET_IDX; y += 1) {
        expect(run.years[y].accountBalances, `strategy=${strategyKind} year ${y}`).toBeUndefined();
      }
      expect(run.years[RET_IDX].accountBalances).toBeDefined();
    }
  });

  it('is behavior-stable: drawdown rows + depletionYear match the frozen v50 baseline (strategy path)', () => {
    const out = runMonteCarlo({ ...longHorizonInput, pathCount: 200 });
    const run = out.representativeByBasis!['mc-typical']!;
    expect(run.depletionYear).toBe(FROZEN_V50.depletionYear);
    for (let k = 0; k < FROZEN_V50.firstDrawdownYears.length; k += 1) {
      const yr = run.years[RET_IDX + k];
      const frozen = FROZEN_V50.firstDrawdownYears[k];
      expect(yr.year).toBe(frozen.year);
      expect(yr.balance).toBe(frozen.balance);
      expect(yr.withdrawn).toBe(frozen.withdrawn);
      expect(yr.growth).toBe(frozen.growth);
    }
  });

  it('is behavior-stable: first-drawdown RMD floor/shortfall + tax cents match the frozen v50 baseline (RMD-age owner)', () => {
    // An owner past the RMD trigger age at retirement is the most at-risk case for the phase discriminator: the accumulation field must not change the first-drawdown RMD base or floor.
    const input = {
      ...longHorizonInput,
      pathCount: 200,
      accountMcLedger: rmdLedger(800_000),
      taxContext: rmdMemberContext(),
    };
    const out = runMonteCarlo(input);
    const run = out.representativeByBasis!['mc-typical']!;
    const firstDrawdown = run.years[RET_IDX];
    expect(firstDrawdown.rmdFloorCents).toBe(FROZEN_V50_RMD.rmdFloorCents);
    expect(firstDrawdown.rmdShortfallCents).toBe(FROZEN_V50_RMD.rmdShortfallCents);
    expect(firstDrawdown.federalTaxCents).toBe(FROZEN_V50_RMD.federalTaxCents);
    expect(firstDrawdown.irmaaSurchargeCents).toBe(FROZEN_V50_RMD.irmaaSurchargeCents);
    const out2 = runMonteCarlo(input);
    const run2 = out2.representativeByBasis!['mc-typical']!;
    expect(run2.years[RET_IDX].rmdFloorCents).toBe(firstDrawdown.rmdFloorCents);
  });
});

// Driven through the named-strategy assembly path; the raw kernel is already absorbing and would give a false green.
describe('runMonteCarlo — absorbing depletion (named-strategy assembly)', () => {
  const STEPS = (2056 - 2026 + 1) * 12;
  const RET_STEP = (2046 - 2026) * 12; // future retirement → preRetirementYears = 20

  // Deep early-drawdown losses deplete the portfolio, then strong returns attempt the bounce-back the clamp must override.
  function depleteThenBounce(): Float64Array {
    const r = new Float64Array(STEPS);
    for (let i = 0; i < STEPS; i += 1) {
      if (i < RET_STEP) r[i] = 0.2;
      else if (i < RET_STEP + 12 * 6) r[i] = -3.0; // ~36%/yr loss → fast ruin
      else r[i] = 2.5; // strong recovery + SS income would bounce a non-absorbing engine
    }
    return r;
  }
  const zeroCpi = (): Float64Array => new Float64Array(STEPS);

  // Heavy spend and post-depletion SS would bounce a non-absorbing engine back positive.
  function futureRetireInput(): MonteCarloInput {
    return {
      ...baseInput,
      portfolioToday: 100_000,
      accountMcLedger: buildLedger({
        primaryPortfolio: 60_000,
        secondaryPortfolio: 40_000,
        annualPlannedContribution: 0,
        stepCount: STEPS,
        retirementStepIdx: RET_STEP,
      }),
      annualContribution: 0,
      strategyKind: 'taxEfficient',
      monthlyExpenseBase: makeMonthlyExpenseBase(120_000, STEPS),
      ...buildYearArrays({ firstYear: 2026, horizonYear: 2056, annualSs: 80_000, ssStartYear: 2046 }),
      pathCount: 1,
      seed: 99,
      injectedReturns: depleteThenBounce(),
      injectedCpi: zeroCpi(),
    };
  }

  it('zeros balanceByYearNominal from the depletion year onward (correct index, future retirement)', () => {
    const input = futureRetireInput();
    const ctx = buildRunContext(input);
    const out = runOnePath(input, input.seed, ctx, true);

    expect(out.depletionYear).not.toBeNull();
    const dep = out.depletionYear!;
    expect(dep).toBeGreaterThanOrEqual(input.retirementYear);

    for (let y = 0; y < out.balanceByYearNominal.length; y += 1) {
      const calendarYear = input.firstYear + y;
      if (calendarYear >= dep) {
        expect(out.balanceByYearNominal[y]).toBe(0);
        expect(out.balanceByYearReal[y]).toBe(0);
      }
    }
    const preDepIdx = dep - 1 - input.firstYear;
    if (preDepIdx >= input.retirementYear - input.firstYear) {
      expect(out.balanceByYearNominal[preDepIdx]).toBeGreaterThan(0);
    }
    expect(out.endingBalanceNominal).toBe(0);
  });

  it('blast radius: the representative capture + real balances also read the zeroed values', () => {
    const input = futureRetireInput();
    const ctx = buildRunContext(input);
    const out = runOnePath(input, input.seed, ctx, true);
    const dep = out.depletionYear!;
    const run = out.representative!;
    for (const yr of run.years) {
      if (yr.year >= dep) expect(yr.balance).toBe(0);
    }
    for (let y = 0; y < run.realBalanceByYear.length; y += 1) {
      if (input.firstYear + y >= dep) expect(run.realBalanceByYear[y]).toBe(0);
    }
  });

  it('per-account sub-balances + per-owner pre-tax index are zeroed for strictly-post-depletion years', () => {
    // The Account Balance Stack chart reads per-account rows directly, so a non-zero strictly-post-depletion row would draw a phantom stack over the clamped $0 total.
    const input = futureRetireInput();
    const ctx = buildRunContext(input);
    const out = runOnePath(input, input.seed, ctx, true);
    const dep = out.depletionYear!;
    const run = out.representative!;

    let sawStrictlyPostRow = false;
    for (const yr of run.years) {
      if (yr.year <= dep) continue; // strictly AFTER depletion only
      if (yr.accountBalances !== undefined) {
        sawStrictlyPostRow = true;
        yr.accountBalances.forEach((acct) => {
          expect(acct.balance).toBe(0);
          expect(acct.preEnd).toBe(0);
          expect(acct.postEnd).toBe(0);
          if (acct.priorPreEnd !== undefined) expect(acct.priorPreEnd).toBe(0);
        });
      }
      if (yr.preTaxCentsByOwnerIdx !== undefined) {
        for (const cents of yr.preTaxCentsByOwnerIdx) expect(cents).toBe(0);
      }
    }
    expect(sawStrictlyPostRow).toBe(true);
  });

  it('the depletion year row also zeroes per-account end balances + per-owner pre-tax index', () => {
    // The zeroing includes the depletion year itself: its per-account year-end balances and per-owner pre-tax index must also be $0.
    const input = futureRetireInput();
    const ctx = buildRunContext(input);
    const out = runOnePath(input, input.seed, ctx, true);
    const dep = out.depletionYear!;
    const run = out.representative!;

    let sawDepletionRow = false;
    for (const yr of run.years) {
      if (yr.year !== dep) continue; // the depletion year itself
      if (yr.accountBalances !== undefined) {
        sawDepletionRow = true;
        yr.accountBalances.forEach((acct) => {
          expect(acct.balance).toBe(0);
          expect(acct.preEnd).toBe(0);
          expect(acct.postEnd).toBe(0);
          if (acct.priorPreEnd !== undefined) expect(acct.priorPreEnd).toBe(0);
        });
      }
      if (yr.preTaxCentsByOwnerIdx !== undefined) {
        for (const cents of yr.preTaxCentsByOwnerIdx) expect(cents).toBe(0);
      }
    }
    expect(sawDepletionRow).toBe(true);
  });

  it('negative guard: a non-depleting path retains its full balance sequence', () => {
    const input: MonteCarloInput = {
      ...futureRetireInput(),
      portfolioToday: 3_000_000,
      accountMcLedger: buildLedger({
        primaryPortfolio: 2_000_000,
        secondaryPortfolio: 1_000_000,
        annualPlannedContribution: 0,
        stepCount: STEPS,
        retirementStepIdx: RET_STEP,
      }),
      monthlyExpenseBase: makeMonthlyExpenseBase(40_000, STEPS),
      injectedReturns: new Float64Array(STEPS).fill(0.3),
    };
    const ctx = buildRunContext(input);
    const out = runOnePath(input, input.seed, ctx, true);
    expect(out.depletionYear).toBeNull();
    for (let y = input.retirementYear - input.firstYear; y < out.balanceByYearNominal.length; y += 1) {
      expect(out.balanceByYearNominal[y]).toBeGreaterThan(0);
    }
    expect(out.endingBalanceNominal).toBeGreaterThan(0);
  });
});

// Fill conversion-tax funding must respect account floors; driven through the full aggregate to MC pipeline at non-zero inflation so a nominal-vs-real floor comparison would be caught.
describe('Monte Carlo — Fill-mode conversion-tax funding respects account floors', () => {
  const FLOOR_MC_SEED = 9182;

  // Flat injected returns remove market-loss noise, and non-zero CPI makes nominal diverge from real, so a floor compared against a CPI-deflated balance would fail; rates are percent per month.
  const MONTHLY_RETURN = (1.05 ** (1 / 12) - 1) * 100;
  const MONTHLY_CPI = (1.02 ** (1 / 12) - 1) * 100;
  function injected(input: MonteCarloInput): { injectedReturns: Float64Array; injectedCpi: Float64Array } {
    const stepCount = (input.horizonYear - input.firstYear + 1) * 12;
    return {
      injectedReturns: new Float64Array(stepCount).fill(MONTHLY_RETURN),
      injectedCpi: new Float64Array(stepCount).fill(MONTHLY_CPI),
    };
  }

  it('never withdraws a floored cash-like account below its NOMINAL floor to fund conversion tax', () => {
    const inputF = runBalanceProjectionMc(flooredFillArgs({ withFloor: true }));
    const summaryF = runMonteCarlo({ ...inputF, pathCount: 1, seed: FLOOR_MC_SEED, ...injected(inputF) });
    const runF = summaryF.representativeByBasis?.['mc-typical'];
    expect(runF).toBeTruthy();
    const yearsF = runF!.years.filter((y) => y.accountBalances);
    expect(yearsF.length).toBeGreaterThan(0);
    expect(yearsF.reduce((s, y) => s + (y.rothConvertedCents ?? 0), 0)).toBeGreaterThan(0);
    // Scoped to years where the unfloored cash2 still funds (the last-resort reserve pass may draw cash1 below its floor once every other source is exhausted);
    // the floored cash1 is never drawn below its nominal floor.
    for (const y of yearsF) {
      const cash1 = y.accountBalances!.get('cash1');
      const cash2 = y.accountBalances!.get('cash2');
      if (!cash1 || !cash2 || cash2.balance <= 1) continue;
      expect(cash1.balance).toBeGreaterThanOrEqual(CASH1_FLOOR - 1);
    }

    // Without the floor the same path draws cash1 below it, so the floor is the binding constraint.
    const inputN = runBalanceProjectionMc(flooredFillArgs({ withFloor: false }));
    const summaryN = runMonteCarlo({ ...inputN, pathCount: 1, seed: FLOOR_MC_SEED, ...injected(inputN) });
    const runN = summaryN.representativeByBasis?.['mc-typical'];
    const wentBelowUnfloored = (runN?.years ?? []).some((y) => {
      const cash1 = y.accountBalances?.get('cash1');
      const cash2 = y.accountBalances?.get('cash2');
      return !!cash1 && !!cash2 && cash2.balance > 1 && cash1.balance < CASH1_FLOOR - 1;
    });
    expect(wentBelowUnfloored).toBe(true);
  });

});
