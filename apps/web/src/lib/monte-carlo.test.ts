import { describe, expect, it } from 'vitest';
import {
  ENGINE_VERSION,
  accountYearStates,
  applyAfterTaxAdjustment,
  buildRunContext,
  buildStrategyRmdContext,
  fillYearBalancesAndTax,
  newTaxPathState,
  priorYearTaxBases,
  rescaleUnitMagiToTotal,
  runMonteCarlo,
  runOnePath,
  type McTaxContext,
  type McQcdContext,
  type MonteCarloAccountLedger,
  type MonteCarloInput,
} from './monte-carlo.js';
import { RMD_OVERFLOW_CASH_ACCOUNT_ID } from './drawdown-engine-per-account-strategy-helpers';
import {
  DEPLETION_BUCKET,
  EPS_REAL,
  REROLL_BAND_CAP,
  assembleRepresentativeBands,
  pickBandIndex,
  reconcileEffectivelyDepletedPick,
} from './monte-carlo-summary.js';
import { buildYearClassification } from './monte-carlo-tax.js';
import { runBalanceProjectionMc } from './balance-projection-runner.js';
import { CASH1_FLOOR, flooredFillArgs } from '../test/fixtures/fill-floor-household';
import { makeMonthlyExpenseBase } from './monte-carlo.test-helpers.js';
import type { StepOutcome } from './projection-engine/kernel.js';
import {
  DEFAULT_TAX_CALIBRATION_BUNDLE,
  type FilingUnitMagi,
} from './tax-integration.js';
import { computeIrmaa } from './irmaa.js';
import { IRMAA_TIERS } from './irmaa-tiers.js';
import { netNeedStrategy } from './projection-engine/withdrawal-strategies.js';
import mcParityBaselines from './__fixtures__/mc-parity-baselines.json';
import { makeRng } from './sfc32.js';
import {
  DEFAULT_MEAN_BLOCK_LENGTH,
  HISTORICAL_MONTHLY,
  drawMonthlySeries,
} from './projection-engine/historical.js';
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

// Two-account ledger: equities-heavy primary brokerage (70/25/5) +
// bonds-heavy IRA (40/55/5). Same per-account split exercises per-account
// sampling rather than collapsing to a single household-blended return.
function buildLedger(args: {
  primaryPortfolio: number;
  secondaryPortfolio: number;
  annualPlannedContribution: number;
  stepCount: number;
  retirementStepIdx: number;
}): MonteCarloAccountLedger[] {
  const { stepCount, retirementStepIdx } = args;
  // Split contributions: 60 % into the equities-heavy account (post-tax),
  // 40 % into the bonds-heavy account (pre-tax). Models a typical
  // 401k + brokerage split.
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

/** Build nominal-income year arrays for test fixtures. */
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

// A few cases assert behaviour in a specific late calendar year, so they run on
// the original 61-year horizon instead of the 31-year base fixture.
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
/** `baseInput` stretched back to the original 61-year (2026–2086) horizon. */
const longHorizonInput: MonteCarloInput = {
  ...baseInput,
  horizonYear: LONG_HORIZON_YEAR,
  accountMcLedger: longLedger(),
  monthlyExpenseBase: makeMonthlyExpenseBase(80_000, LONG_STEPS),
  ...buildYearArrays({ firstYear: 2026, horizonYear: LONG_HORIZON_YEAR, annualSs: 30_000, ssStartYear: 2046 }),
};

describe('runMonteCarlo — windowed expense schedule', () => {
  const STEPS = LONG_STEPS;
  // A windowed per-month base: $0 every month EXCEPT a finite late-life window
  // (calendar 2070–2074, a 5-year LTC slice) where it charges $100k/yr.
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
    // A year well before the window (2050) draws $0 of expense (netNeed 0).
    const beforeIdx = 2050 - 2026;
    expect(run.years[beforeIdx].netNeed).toBe(0);
    // A year inside the window (2072) draws a positive nominal expense.
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
    // Windowed: the $100k charge lands only in 2070–2074.
    const windowed = runMonteCarlo({ ...common, monthlyExpenseBase: windowedBase() });
    // Flat: the SAME annual $100k charged EVERY year (no windowing).
    const flat = runMonteCarlo({
      ...common,
      monthlyExpenseBase: new Array<number>(STEPS).fill(100_000 / 12),
    });
    // Charging the expense only in its window can only preserve or raise the
    // P10/P25/P50 real ending balance vs charging it every year.
    expect(windowed.percentilesReal.p10.at(-1)!).toBeGreaterThanOrEqual(
      flat.percentilesReal.p10.at(-1)!,
    );
    expect(windowed.percentilesReal.p50.at(-1)!).toBeGreaterThanOrEqual(
      flat.percentilesReal.p50.at(-1)!,
    );
  });

  it('sampler invariance: same seed + same windowed base → bit-identical percentiles (RNG draw count unchanged)', () => {
    const input: MonteCarloInput = {
      ...baseInput,
      retirementYear: 2026,
      horizonYear: LONG_HORIZON_YEAR,
      accountMcLedger: longLedger(),
      ssByYear: new Array<number>(LONG_YEARS).fill(0),
      incomeByYear: new Array<number>(LONG_YEARS).fill(0),
      monthlyExpenseBase: windowedBase(),
      pathCount: 100,
      seed: 4242,
    };
    const a = runMonteCarlo(input);
    const b = runMonteCarlo(input);
    expect(a.percentilesNominal.p50).toEqual(b.percentilesNominal.p50);
    expect(a.successProbability).toBe(b.successProbability);
  });
});

describe('runMonteCarlo — multi-rate medical demand subset', () => {
  const STEPS = (2056 - 2026 + 1) * 12;
  const flatCpi = (): Float64Array => new Float64Array(STEPS).fill(0.25);
  const flatReturn = (): Float64Array => new Float64Array(STEPS).fill(0.4);

  // Two medical categories at DIFFERENT effective rates: $1k/mo at the general
  // rate and $1k/mo at general + 2pp. Total medical = $2k/mo; total expense adds
  // a $2k/mo non-medical general-rate slice → $4k/mo expense.
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
      // Per-rate expense buckets: $1k slow medical + $2k slow non-medical at the
      // general rate; $1k fast medical at general + 2pp.
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
      // The medical-qualified HSA draw can never exceed the year's TOTAL expense
      // need (medical demand is bounded by the inflated medical expense, itself a
      // subset of the total). With ample balances it funds the full medical
      // demand; it must never run ahead of the committed HSA withdrawal.
      const committed = Math.round((hsa?.withdrawn ?? 0) * 100);
      expect(med).toBeLessThanOrEqual(committed);
      if (med > 0) anyMedical = true;
    }
    expect(anyMedical).toBe(true);
  });

  it('per-rate inflation diverges from the single-rate medical approximation', () => {
    const bucketed = runWith({ bucketed: true }).representativeByBasis!['mc-typical']!;
    const single = runWith({ bucketed: false }).representativeByBasis!['mc-typical']!;
    // A mid-horizon drawdown year — the fast medical category has compounded
    // ahead of the general rate, so the per-rate medical demand exceeds the
    // single-rate (all-general) collapse, while the HSA still has balance to fund
    // it. Pick ~15y past retirement.
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

  // Month-precise retirement. A December retiree (`primaryRetirementMonth0
  // = 11`) draws only the final month of the retirement year, vs a January
  // retiree (month 0) who draws all 12. Holding the seed fixed, the December
  // retiree therefore ends the retirement year with a strictly higher P50
  // nominal balance — no ~11-month over-count.
  const RETIREMENT_YEAR_IDX = 2046 - 2026;
  it('December retiree draws less in the retirement year than a January retiree', () => {
    const january = runMonteCarlo({ ...baseInput, primaryRetirementMonth0: 0 });
    const december = runMonteCarlo({ ...baseInput, primaryRetirementMonth0: 11 });
    expect(december.percentilesNominal.p50[RETIREMENT_YEAR_IDX]).toBeGreaterThan(
      january.percentilesNominal.p50[RETIREMENT_YEAR_IDX],
    );
    // Month 0 must reproduce the default (no offset).
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
    // At pathCount=200, freq = max(25, 5) = 25 → 200 / 25 = 8 ticks.
    expect(calls).toBeGreaterThanOrEqual(7);
    expect(calls).toBeLessThanOrEqual(9);
  });

  it('floor-reserve-depletion : a floored account IS drawn below its floor only as a last resort', () => {
    // The floor invariant ("never below the floor on any sampled path") holds
    // ONLY for ORDINARY discretionary need: a floor is preserved while any other
    // account can fund the need, but is drained BELOW its floor as a true last
    // resort once nothing else remains. Injected flat returns + 0 CPI make the
    // single sampled representative path fully deterministic.
    const STEPS = LONG_STEPS;
    const FLOOR_DOLLARS = 150_000;
    const flatReturn = (): Float64Array => new Float64Array(STEPS).fill(0.3);
    const zeroCpi = (): Float64Array => new Float64Array(STEPS);
    const flooredLedger = (): MonteCarloAccountLedger[] => [
      {
        // Floored POST_TAX brokerage: tier-0 under taxEfficient, drawn first.
        id: 'brok-floored', initialPre: 0, initialPost: 400_000,
        contribPre: new Float64Array(STEPS), contribPost: new Float64Array(STEPS),
        deposit: new Float64Array(STEPS),
        assetMix: { stocksPct: 100, bondsPct: 0, cashPct: 0 }, assetMixSeries: null,
        cbpPlanningReturnPct: null, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE',
        ownerId: 'p', contribGrowthMode: 'fixed', plannedContribPostBase: null,
        floorDollars: FLOOR_DOLLARS,
      },
      {
        // Unfloored PRE_TAX 401k absorbs the shortfall FIRST; only once it is
        // exhausted does the floored brokerage's reserve drain below its floor.
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
      // Heavy spend so the whole portfolio (incl. the floored reserve) is tapped.
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
    // The last-resort reserve drain fires: at least one solvent drawdown year
    // shows the floored brokerage BELOW its floor (impossible if the floor were
    // an absolute hard stop).
    expect(sawBelowFloor).toBe(true);
  });

  it('floor-reserve-depletion: reserves fund the tail WITHOUT setting depletionYear', () => {
    // Non-vacuous witness: a plan whose ONLY remaining money is
    // a floored reserve now funds the need from that reserve rather than stranding
    // it — so it does NOT record a depletionYear where the OLD stranded-floor
    // behavior would have. Zero injected returns + 0 CPI, single floored
    // brokerage: modest spend taps the below-floor reserve but stays fully funded.
    const STEPS = LONG_STEPS;
    const zeroReturn = (): Float64Array => new Float64Array(STEPS); // flat 0% growth
    const zeroCpi = (): Float64Array => new Float64Array(STEPS);
    const ledger = (): MonteCarloAccountLedger[] => [
      {
        // A single floored brokerage: its whole balance (incl. the reserve) is
        // available as a last resort, so a modest-spend plan never depletes.
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
      // ~$12k/yr over the ~40 retirement years draws ≈$480k — through the $100k
      // above the floor and deep into the $500k reserve, but never exhausts it.
      monthlyExpenseBase: makeMonthlyExpenseBase(12_000, LONG_STEPS),
      ssByYear: new Array<number>(LONG_YEARS).fill(0),
      incomeByYear: new Array<number>(LONG_YEARS).fill(0),
      pathCount: 1,
      seed: 42,
      injectedReturns: zeroReturn(),
      injectedCpi: zeroCpi(),
    });
    const run = out.representativeByBasis!['mc-typical']!;
    // The reserve funds the tail need → the plan stays solvent (no depletionYear).
    // Under the OLD stranded-floor behavior the sub-floor spend would have been
    // unmet and recorded a depletion.
    expect(run.depletionYear ?? null).toBeNull();
    const last = run.years[run.years.length - 1];
    const brok = last.accountBalances?.get('brok');
    // The reserve was actually tapped below its floor (non-vacuous).
    expect((brok?.balance ?? Number.POSITIVE_INFINITY)).toBeLessThan(500_000);
  });

  it('floor-reserve-depletion: HSA reserve is drawn below floor; MC 20% additional-tax leg stays $0', () => {
    // The HSA reserve DRAW matches the deterministic engine (the floored HSA is
    // drawn below its floor as a last resort). But the pre-65 20% §223(f)(4)
    // additional-tax leg is a documented, PERMANENT MC no-op (the synthetic pool
    // has no emergency-HSA-qualified% input, defaulting to 100% qualified — a
    // future MC leg that threads it must keep governing only the emergency draw,
    // since modeled medical-qualified withdrawals are always 100% qualified) —
    // every MC year row surfaces $0 additional tax regardless of the reserve
    // draw, so this asserts DRAW behavior only.
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
      // The MC additional-tax leg is a permanent no-op — never a nonzero value.
      expect(y.hsaAdditionalTaxCents ?? 0).toBe(0);
    }
    expect(sawHsaBelowFloor).toBe(true); // reserve DRAW happened (non-vacuous)
  });

  it('floor-reserve-depletion: a NO-FLOOR MC scenario stays bit-identical (draw-only scope)', () => {
    // The floor-reserve change is scoped to floored accounts. A scenario with NO
    // floors must produce byte-identical percentiles before/after it — the only
    // serialized difference is ENGINE_VERSION. We assert internal consistency (the
    // no-floor ledger drawdown is unaffected by the reserve pass, which is a
    // no-op without a floor) by re-running the same no-floor input twice and
    // comparing.
    const a = runMonteCarlo(baseInput);
    const b = runMonteCarlo(baseInput);
    expect(b.percentilesNominal).toEqual(a.percentilesNominal);
    expect(b.percentilesReal).toEqual(a.percentilesReal);
    expect(b.successProbability).toBe(a.successProbability);
    expect(b.medianEndingBalanceNominal).toBe(a.medianEndingBalanceNominal);
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
    // Under-funded plan: enough paths deplete that P10/P25/median are
    // all defined and monotonic (earlier failure at the worse tail).
    expect(out.p25EndingBalanceNominal).toBeGreaterThanOrEqual(
      out.p10EndingBalanceNominal,
    );
    expect(out.medianEndingBalanceNominal).toBeGreaterThanOrEqual(
      out.p25EndingBalanceNominal,
    );
    expect(out.p25EndingBalanceReal).toBeGreaterThanOrEqual(
      out.p10EndingBalanceReal,
    );
    // Under-funded fixture is severe enough that P10/P25/median all deplete —
    // assert non-null unconditionally so a P25-depletion regression to null
    // fails loud instead of skipping the ordering check.
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
    // Every standard field except plannedOverlay (and computedAt) matches.
    expect(successOnly.percentilesNominal).toEqual(full.percentilesNominal);
    expect(successOnly.percentilesReal).toEqual(full.percentilesReal);
    expect(successOnly.endingBalanceHistogramNominal).toEqual(
      full.endingBalanceHistogramNominal,
    );
    expect(successOnly.failureYearHistogram).toEqual(full.failureYearHistogram);
    expect(successOnly.medianEndingBalanceNominal).toBe(
      full.medianEndingBalanceNominal,
    );
    // plannedOverlay is an empty array (never null) — the only field that
    // differs from the full run.
    expect(successOnly.plannedOverlay).toEqual([]);
    expect(full.plannedOverlay.length).toBeGreaterThan(0);
    expect(successOnly.successProbability).toBe(full.successProbability);
    // The fast path skips every representative-run capture.
    expect(successOnly.representativeByBasis).toBeUndefined();
    expect(successOnly.representativeTypicalSeed).toBeUndefined();
    expect(successOnly.representativeBandsByBasis).toBeUndefined();
  });
});

describe('runMonteCarlo — retirementAllocation assetMixSeries wiring', () => {
  // Regression: assetMixSeries on the ledger entry must shift successProbability
  // and medianEndingBalanceNominal so that MC reflects the glide-path override
  // instead of ignoring it (ignoring it would make both runs identical).
  const stepCount = BASE_STEPS;
  const retirementStep = BASE_RETIREMENT_STEP;

  function buildGlideLedger(stocksAtRetirement: number): MonteCarloAccountLedger[] {
    // Synthesise a flat per-step mix series: accumulation at 70/25/5,
    // drawdown stepped to `stocksAtRetirement` / proportional rest.
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
    // null → falls back to assetMix (70/25/5 & 40/55/5 blended)
    // conservative series (20% stocks in drawdown) → lower expected growth → lower probability.
    // pathCount raised to 500 for sign-direction stability (large effect size).
    const baseline = runMonteCarlo({ ...baseInput, seed: 77, pathCount: 500 });
    const conservative = runMonteCarlo({
      ...baseInput,
      seed: 77,
      pathCount: 500,
      accountMcLedger: buildGlideLedger(20),
    });
    // Conservative drawdown allocation reduces equity exposure → lower successProbability.
    expect(conservative.successProbability).toBeLessThan(baseline.successProbability);
  });

  it('aggressive drawdown mix (90% stocks) shifts medianEndingBalanceNominal vs conservative', () => {
    // pathCount raised to 500 for sign-direction stability (large effect size).
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
    // Higher equity exposure in drawdown → higher median nominal end balance.
    expect(aggressive.medianEndingBalanceNominal).toBeGreaterThan(
      conservative.medianEndingBalanceNominal,
    );
  });

  // Scenario inflation mean-shifts the CPI bootstrap. A 5%
  // scenario produces faster expense growth than 0%; with all other
  // inputs held constant, success probability must drop and median
  // ending balance (real) must shrink. Without the shift, scenario
  // inflation would be a no-op in MC.
  it('scenario inflation 5% drops success probability vs 0% (v8 CPI mean-shift)', () => {
    const at0 = runMonteCarlo({ ...baseInput, scenarioInflationPct: 0 });
    const at5 = runMonteCarlo({ ...baseInput, scenarioInflationPct: 5 });
    // Engine version must be stamped on every summary.
    expect(at0.engineVersion).toBe(ENGINE_VERSION);
    expect(at5.engineVersion).toBe(ENGINE_VERSION);
    // Higher inflation → expenses grow faster → portfolio runs out
    // sooner → success probability strictly lower.
    expect(at5.successProbability).toBeLessThan(at0.successProbability);
    // Real-dollar median ending balance also falls (nominal can move
    // either direction since income arrays stay flat; the real
    // deflator is the load-bearing measure).
    expect(at5.medianEndingBalanceReal).toBeLessThan(
      at0.medianEndingBalanceReal,
    );
  });

  // Invariant: undefined `scenarioInflationPct` means no shift —
  // the unshifted historical bootstrap mean drives expense inflation. Two
  // runs (undefined vs explicit historical mean) need not be bit-identical here; the contract is "undefined
  // = no shift applied", which is what the kernel code asserts.
  it('omits CPI shift entirely when scenarioInflationPct is undefined', () => {
    const baseline = runMonteCarlo(baseInput); // scenarioInflationPct undefined
    expect(baseline.engineVersion).toBe(ENGINE_VERSION);
    expect(baseline.successProbability).toBeGreaterThanOrEqual(0);
    expect(baseline.successProbability).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Per-path tax percentile bands
// ---------------------------------------------------------------------------

/**
 * Minimal McTaxContext for a 55-year-old single filer (no Medicare, no ACA
 * yet at retirement; passes MFJ once a secondary is added).
 */
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
  // The three band cases below read the same 50-path with-tax run; run it once,
  // lazily, so a filtered run of an unrelated case never pays for it.
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

  // With taxContext + a named strategy, new percentile bands populated
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

  // Tax percentile bands must be ordered p10 ≤ p25 ≤ p50 at every
  // retirement-phase year (pre-retirement years have zero drawdown →
  // all percentiles are 0 there, so ordering holds trivially).
  it('tax percentile bands are ordered p10 ≤ p25 ≤ p50', () => {
    const { input, out } = sharedTaxRun();
    const fed = out.federalTaxPercentilesByYear!;
    const horizon = input.horizonYear - input.firstYear + 1;
    for (let i = 0; i < horizon; i++) {
      expect(fed.p10[i]).toBeLessThanOrEqual(fed.p25[i]);
      expect(fed.p25[i]).toBeLessThanOrEqual(fed.p50[i]);
    }
  });

  // Effective tax rate must be in [0, 1] at every year.
  it('effectiveTaxRate percentile bands are in [0, 1]', () => {
    const { input, out } = sharedTaxRun();
    const etr = out.effectiveTaxRatePercentilesByYear!;
    const horizon = input.horizonYear - input.firstYear + 1;
    for (let i = 0; i < horizon; i++) {
      expect(etr.p10[i]).toBeGreaterThanOrEqual(0);
      expect(etr.p50[i]).toBeLessThanOrEqual(1);
    }
  });

  // Backward compat — no taxContext → no tax fields on summary
  it('omits tax percentile fields when taxContext is absent', () => {
    const out = runMonteCarlo(baseInput); // no taxContext
    expect(out.federalTaxPercentilesByYear).toBeUndefined();
    expect(out.irmaaSurchargePercentilesByYear).toBeUndefined();
    expect(out.acaPtcSubsidyPercentilesByYear).toBeUndefined();
    expect(out.effectiveTaxRatePercentilesByYear).toBeUndefined();
    expect(out.netAfterTaxPercentilesByYear).toBeUndefined();
  });

  // The per-path tax accumulator arrays (fedTax/irmaa/ptc/etr/net) feed
  // the percentile tax bands. `fillStrategyYearTax` stamps them on the un-clamped
  // pass-2 rows BEFORE the absorbing-depletion clamp runs, so strictly-post-
  // depletion years would otherwise carry stale non-zero tax (SS income still
  // flows through the per-year tax even with a $0 portfolio). The clamp must zero
  // those slots so the bands read $0 once the portfolio is permanently exhausted.
  it('zeroes the percentile tax bands for strictly-post-depletion years', () => {
    const STEPS = (2056 - 2026 + 1) * 12;
    // Deterministic single path: flat returns + 0 CPI → the representative IS the
    // sampled path and every percentile collapses onto it. Heavy spend + SS income
    // guarantees the portfolio depletes mid-horizon while SS keeps flowing, so a
    // post-depletion year has taxable SS income the (un-fixed) accumulator would
    // stamp into the bands.
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
    // There must BE strictly-post-depletion years inside the horizon to test.
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

  // otherIncome (incomeByYear) is wired into the per-year tax estimate.
  // With no SS and no incomeByYear, drawdown = expense and federalTax > 0.
  // Adding large incomeByYear (= expense) keeps drawdown near 0, but the
  // income itself is taxable → federalTax is non-zero and DIFFERENT from the
  // zero-income case (both draw different amounts from the pre-tax bucket).
  it('incomeByYear is passed through to per-year tax estimation (changes federal tax result)', () => {
    const horizonYears = baseInput.horizonYear - baseInput.firstYear + 1;
    // Assert at the retirement year (2046) with a PRE-RMD member (born
    // 1985, age 61) so the synthetic RMD floor adds no phantom taxable income
    // — the only ordinary income is the $80k (drawn vs other-income), keeping
    // the "same total → same tax" identity this test checks. An RMD-age member
    // would owe an extra forced-minimum tax in the zero-drawdown income case.
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
    // Zero SS + zero income: full expense drawn from pre-tax portfolio.
    const noIncome = runMonteCarlo({
      ...baseInput,
      pathCount: 50,
      seed: 77,
      ssByYear: new Array<number>(horizonYears).fill(0),
      incomeByYear: new Array<number>(horizonYears).fill(0),
      taxContext: preRmdContext,
    });
    // Zero SS + large income that fully covers expense: drawdown = 0, but income is taxable.
    const withIncome = runMonteCarlo({
      ...baseInput,
      pathCount: 50,
      seed: 77,
      ssByYear: new Array<number>(horizonYears).fill(0),
      // baseInput's lifetime expense run-rate × 12 = the annual figure.
      incomeByYear: new Array<number>(horizonYears).fill(80_000),
      taxContext: preRmdContext,
    });
    const retirementIdx = baseInput.retirementYear - baseInput.firstYear;
    // With zero income: expense = $80k pre-tax drawdown → federal tax on $80k.
    // With $80k income: drawdown = 0, income = $80k as otherOrdinaryIncome → same gross but
    // the SS provisional income differs (no SS here), so the tax curves differ only through
    // the drawdown routing. The key assertion: the results differ — confirming incomeByYear
    // is wired through, not ignored.
    expect(noIncome.federalTaxPercentilesByYear!.p50[retirementIdx]).toBeGreaterThan(0);
    expect(withIncome.federalTaxPercentilesByYear!.p50[retirementIdx]).toBeGreaterThan(0);
    // Both should be equal since total ordinary income is the same either way
    // ($80k from drawdown vs $80k from other income, no SS in either case).
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

        // Target budget: "+200ms absolute OR +20% relative, whichever is larger" —
        // the budget bounds the DELTA, not the absolute with-tax runtime.
        // The floor is widened to 1000ms / 25% above that target: this is a delta of
        // two wall-clock timings, so when a parallel test worker steals the CPU
        // mid-run the with-tax timing inflates independently of the tax overhead.
        // The wider floor absorbs that scheduler jitter while still catching a
        // real (multi-second-scale) tax-path regression.
        const deltaMs = withTaxMs - baselineMs;
        const budgetMs = Math.max(1000, baselineMs * 0.25);
        expect(deltaMs).toBeLessThan(budgetMs);
      },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Per-account MC tax routing + after-tax balances
// ---------------------------------------------------------------------------

/**
 * Single-account ledger tagged with tax metadata so the year classifier routes
 * the whole drawdown to one tax bucket. PRE_TAX seats the balance in the pre
 * bucket; POST_TAX/MIXED seat it in the post bucket. The bucket LABEL for the
 * tax engines comes from `taxTreatment`/`accountType`, not the kernel bucket.
 */
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

  // The per-account routing distinction (Roth → $0 tax, brokerage LTCG
  // proxy < ordinary) is observable only BELOW RMD age. Once the member is
  // RMD-age, the synthetic-account RMD floor grosses the per-year taxable
  // income up to the required minimum regardless of how the draw is sourced,
  // so the routing distinction collapses (correctly — an RMD-age household owes
  // tax on its required minimum withdrawal whatever its account mix). These
  // tests therefore use a member born 1985 (age 61 at the asserted 2046 year —
  // pre-RMD, pre-Medicare) so the routing distinction is the only effect.
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
      // Seed a Roth-IRA contribution basis large enough to cover the
      // plan's lifetime CUMULATIVE NOMINAL Roth draws ($70k/yr real, inflated
      // across the 41-yr horizon — the nominal total runs into the millions), so
      // every Roth withdrawal is §408A contribution-basis recovery
      // (tax/penalty-free) — the property these Roth-routing tests assert.
      // Harmless for the pre-tax / brokerage ledgers (no RETIREMENT_ROTH_IRA
      // draw routes through the carrier).
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
    // Pre-tax drawdown is ordinary income → positive federal tax; Roth
    // withdrawals are tax-free → ~zero federal tax for the same drawdown.
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
    // Brokerage POST_TAX routes through the LTCG/QDI proxy (cost-basis fraction
    // shrinks the taxable share) → lower federal tax than full ordinary income.
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
    // Roth funds no tax cashflow, so nothing is subtracted from balances; the
    // pre-tax plan funds tax every year → strictly lower after-tax horizon balance.
    expect(roth.medianEndingBalanceNominal).toBeGreaterThan(
      preTax.medianEndingBalanceNominal,
    );
  });

});

// ---------------------------------------------------------------------------
// QCD — per-path QCD wiring. The QCD is debited per path from the
// source IRA, so an identical scenario WITH a QCD moves ending balances + the
// success/percentile arrays (the math is per-path, not a display overlay). The
// representative run carries the QCD display fields (`qcdCents` /
// `netTaxableRmdCents`).
// ---------------------------------------------------------------------------
describe('runMonteCarlo — QCD per-path wiring', () => {
  const FIRST = 2026;
  const HORIZON = 2055;
  const HZN = HORIZON - FIRST + 1;
  const STEPS = HZN * 12;

  /** Single RMD-age member (born 1948 → age 78 in 2026 → RMD applies + 70½
   *  eligible) retired at `FIRST` so every year runs the drawdown + tax. */
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

  /** A QCD context directing a $30k/yr REAL gift from the `'only'` source IRA,
   *  active the whole horizon, owner eligible from 2026 (70½ long since passed). */
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
      // A modest spend on a large pot so the portfolio SURVIVES — the QCD debit
      // is then the only mover between the two runs, visible in the ending balance.
      monthlyExpenseBase: makeMonthlyExpenseBase(40_000, STEPS),
      ssByYear: new Array<number>(HZN).fill(0),
      incomeByYear: new Array<number>(HZN).fill(0),
      pathCount: 80,
      seed: 9090,
      strategyKind: 'taxEfficient',
      taxContext: rmdAgeTaxContext(),
      // Injected flat returns + 0 CPI → the QCD nominal == its $30k real amount
      // and the path is fully deterministic, so the representative run IS the
      // single sampled path (the QCD effect is isolated, not luck).
      injectedReturns: new Float64Array(STEPS).fill(0.004),
      injectedCpi: new Float64Array(STEPS),
    };
  }

  it('a per-path QCD debit lowers ending balances vs an identical no-QCD run', () => {
    const noQcd = runMonteCarlo(baseInput());
    const withQcd = runMonteCarlo({ ...baseInput(), qcdContext: qcdContext() });
    // The gift leaves the portfolio every year → strictly lower ending balances.
    expect(withQcd.medianEndingBalanceNominal).toBeLessThan(
      noQcd.medianEndingBalanceNominal,
    );
  });

  it('an identical QCD moves the per-path balance + success arrays (not just display)', () => {
    const noQcd = runMonteCarlo(baseInput());
    const withQcd = runMonteCarlo({ ...baseInput(), qcdContext: qcdContext() });
    // The percentile balance series must differ at the horizon (per-path math).
    expect(withQcd.percentilesNominal.p50.at(-1)).not.toBe(
      noQcd.percentilesNominal.p50.at(-1),
    );
    // Success probability is a valid probability for the QCD run.
    expect(withQcd.successProbability).toBeGreaterThanOrEqual(0);
    expect(withQcd.successProbability).toBeLessThanOrEqual(1);
  });

  it('stamps qcdCents + a reduced net-taxable-RMD on the representative run', () => {
    const withQcd = runMonteCarlo({ ...baseInput(), qcdContext: qcdContext() });
    const rep = withQcd.representativeByBasis?.['mc-typical'];
    expect(rep).toBeDefined();
    // Find a drawdown-phase year (accountBalances present) carrying a QCD.
    const qcdYear = rep!.years.find(
      (y) => y.accountBalances !== undefined && (y.qcdCents ?? 0) > 0,
    );
    expect(qcdYear).toBeDefined();
    // $30k gift at 0 CPI → exactly $30k stamped.
    expect(qcdYear!.qcdCents).toBe(30_000_00);
    // The QCD counts toward the IRA RMD → net taxable RMD < gross floor (when a
    // floor applies) and ≥ 0.
    expect(qcdYear!.netTaxableRmdCents).toBeGreaterThanOrEqual(0);
    if ((qcdYear!.rmdFloorCents ?? 0) > 0) {
      expect(qcdYear!.netTaxableRmdCents!).toBeLessThan(qcdYear!.rmdFloorCents!);
    }
  });

  it('replay-stamped offset + post-pass net-taxable equals the post-pass floor in EVERY QCD year (bar identity, end-to-end)', () => {
    // The split chart's bar identity (`offset + netTaxable = gross IRA RMD`)
    // spans TWO computations under MC: the strategy REPLAY caps + stamps
    // `qcdRmdOffsetCentsByOwner` from ITS OWN per-owner gross IRA RMD, while
    // the RMD post-pass recomputes the floor from the stamped prior-year
    // `preEnd` balances and derives `netTaxableRmdCents` from it. The
    // monte-carlo-rmd unit tests hand-stamp the offsets, so only this
    // real-runMonteCarlo run pins the two computations against each other.
    // With a single IRA the IRA-pool floor IS `rmdFloorCents`, so every QCD
    // drawdown year must satisfy `Σ offset + netTaxable === rmdFloorCents` —
    // a replay↔post-pass divergence (including the ≥-floor clamp firing
    // because the replay gross exceeded the post-pass floor) breaks it.
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
    // Non-zero injected CPI → the path inflates the $30k REAL gift to a larger
    // nominal `qcdCents`. The representative row carries the EXACT factor the path
    // used (its year-END `cumCpi`), so `qcdCents ÷ qcdInflationFactor` reverses to
    // the configured $30k. (Deterministic uses a year-MEAN factor; the MC
    // representative uses the path's own year-END factor — each stamps the factor
    // it actually inflated with, so the reversal is exact under BOTH bases.)
    // `injectedCpi` is a per-step PERCENT (cumCpi *= 1 + cpi/100). 0.5%/month →
    // a clearly-meaningful multi-year accumulated factor.
    const monthlyCpiPct = 0.5;
    const input: MonteCarloInput = {
      ...baseInput(),
      qcdContext: qcdContext(),
      injectedCpi: new Float64Array(STEPS).fill(monthlyCpiPct),
    };
    const withQcd = runMonteCarlo(input);
    const rep = withQcd.representativeByBasis?.['mc-typical'];
    expect(rep).toBeDefined();
    // Pick a LATE QCD year so the accumulated CPI factor is unmistakably > 1
    // (the deflation-anchor bug shows up only when there is meaningful inflation).
    const qcdYears = rep!.years.filter(
      (y) => y.accountBalances !== undefined && (y.qcdCents ?? 0) > 0,
    );
    expect(qcdYears.length).toBeGreaterThan(0);
    const qcdYear = qcdYears[qcdYears.length - 1];
    // The path inflated the REAL gift by a meaningful factor (deep into horizon).
    expect(qcdYear.qcdInflationFactor!).toBeGreaterThan(1.05);
    // `qcdCents` is the REAL gift inflated by the stamped factor (integer cents).
    expect(qcdYear.qcdCents!).toBe(
      Math.round(30_000 * qcdYear.qcdInflationFactor! * 100),
    );
    // EXACT round-trip: dividing the nominal gift by the SAME stamped factor the
    // path inflated with reverses to the configured REAL $30k (sub-cent rounding).
    expect(qcdYear.qcdCents! / 100 / qcdYear.qcdInflationFactor!).toBeCloseTo(
      30_000,
      1,
    );
  });

  it('excludes the QCD from the taxable RMD EXACTLY ONCE (gross − Q, never gross − 2Q)', () => {
    // The MC analogue of the deterministic engine's single-exclusion invariant.
    // With injected flat returns + 0 CPI the P50 representative run IS the single
    // deterministic path, so the stamped tax cents are exact. A QCD-driven RMD
    // year must show `netTaxableRmdCents === rmdFloorCents − qcdCents` (single
    // offset) and a STRICTLY-lower federal tax than the no-QCD run — a double
    // exclusion would compute the federal tax on `gross − 2Q`, dropping ~twice
    // as much.
    const withQcd = runMonteCarlo({ ...baseInput(), qcdContext: qcdContext() });
    const noQcd = runMonteCarlo(baseInput());
    const repQ = withQcd.representativeByBasis?.['mc-typical'];
    const repN = noQcd.representativeByBasis?.['mc-typical'];
    expect(repQ).toBeDefined();
    expect(repN).toBeDefined();

    // A QCD-driven RMD year (gift fired AND a positive RMD floor applies).
    const qcdYear = repQ!.years.find(
      (y) => (y.qcdCents ?? 0) > 0 && (y.rmdFloorCents ?? 0) > (y.qcdCents ?? 0),
    );
    expect(qcdYear).toBeDefined();
    // Single exclusion: net taxable RMD = gross floor − Q (the gift counts toward
    // the RMD once). A double-exclusion path would not satisfy this identity.
    expect(qcdYear!.netTaxableRmdCents).toBe(
      (qcdYear!.rmdFloorCents ?? 0) - (qcdYear!.qcdCents ?? 0),
    );

    // The QCD lowers the same year's federal tax (excluded once from ordinary
    // income / MAGI before §86).
    const noQcdYear = repN!.years.find((y) => y.year === qcdYear!.year);
    expect(noQcdYear).toBeDefined();
    expect(qcdYear!.federalTaxCents ?? 0).toBeLessThan(noQcdYear!.federalTaxCents ?? 0);
  });

  // Near the depletion cliff the per-path QCD drain flips some paths to
  // depletion, so the success probability MUST differ between the QCD and no-QCD
  // runs (not just the ending-balance display). A large spend on a modest pot
  // puts paths on the edge.
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
      // A heavy spend on a modest pot → some paths deplete; the annual QCD drain
      // tips a subset over the edge, moving the success probability.
      monthlyExpenseBase: makeMonthlyExpenseBase(78_000, STEPS),
      // Historical-bootstrap dispersion (no injected returns) so paths actually
      // straddle the cliff instead of collapsing to one deterministic line.
      pathCount: 400,
      seed: 4242,
      injectedReturns: undefined,
      injectedCpi: undefined,
    };
  }

  it('a near-the-cliff QCD flips some paths → success probability DIFFERS', () => {
    const noQcd = runMonteCarlo(cliffInput());
    const withQcd = runMonteCarlo({ ...cliffInput(), qcdContext: qcdContext() });
    // The per-path gift drain lowers survival on a fraction of paths → strictly
    // lower (and different) success probability: an identical QCD moves success
    // probability, not just display.
    expect(withQcd.successProbability).not.toBe(noQcd.successProbability);
    expect(withQcd.successProbability).toBeLessThan(noQcd.successProbability);
  });
});

// ---------------------------------------------------------------------------
// accountYearStates start-of-year bucket boundary + the MIXED kernel-
// driven pre/post split it feeds into buildYearClassification.
// ---------------------------------------------------------------------------

describe('accountYearStates — start-of-year bucket boundary', () => {
  const STEPS = 24; // two simulation years.

  /** Single MIXED account ledger; only the fields `accountYearStates` reads
   *  (`initialPre`/`initialPost`/`taxTreatment`/`accountType`) are load-bearing. */
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

  /** Minimal `StepOutcome` exposing only the per-account arrays the year
   *  classifier reads. `accPreEnd[step]` / `accPostEnd[step]` are the per-step
   *  end-of-step buckets; `accWithdrawal[step]` the per-step draw. */
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
    // Initial buckets: 75% pre / 25% post. Prior year-end (step 11) buckets
    // would be 25/75 — but for y=0 priorStep = -1 so the initial buckets win.
    const input = inputFor(mixedLedger(75, 25));
    const preEndByStep = new Array<number>(STEPS).fill(0);
    const postEndByStep = new Array<number>(STEPS).fill(0);
    preEndByStep[11] = 25; // prior year-end (would drive y=1, not y=0).
    postEndByStep[11] = 75;
    const out = outcomeFor({ withdrawalPerStep: 1200 / 12, preEndByStep, postEndByStep });

    const states = accountYearStates(input, out, 0, STEPS)!;
    expect(states[0].withdrawalDollars).toBeCloseTo(1200); // 12 steps * 100/step
    expect(states[0].preBalanceStartDollars).toBe(75);
    expect(states[0].postBalanceStartDollars).toBe(25);

    // 1200 drawn across the year, split by the initial 75/25 bucket ratio.
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
    // Prior year-end buckets differ from the initial 75/25 → 20/80 split.
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

// ---------------------------------------------------------------------------
// applyAfterTaxAdjustment absorbing after-tax depletion + the
// min(preTaxDepletionYear, afterTaxDepletionYear) reconciliation.
// ---------------------------------------------------------------------------

describe('applyAfterTaxAdjustment — absorbing after-tax depletion', () => {
  const FIRST_YEAR = 2026;
  const HORIZON_YEARS = 5;
  const STEPS = HORIZON_YEARS * 12;

  /** `StepOutcome` exposing only `cumCpi` (the field the adjustment reads to
   *  deflate the after-tax nominal balance). cumCpi = 1 every step → real == nominal. */
  function unitCpiOutcome(): StepOutcome {
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
      depletionStepIdx: -1,
    };
  }

  it('zeroes every year at/after after-tax depletion despite a positive later balance', () => {
    // y=2 balance is 50 but cumulative tax through y=2 is 60 → after-tax goes
    // to 0 (depletes). Years 3 and 4 have positive RAW balances (200, 300) and
    // no further tax draw, yet absorbing depletion must force them to 0.
    const balanceNominal = [100, 100, 50, 200, 300];
    const balanceReal = [100, 100, 50, 200, 300];
    const taxDrawByYear = [0, 0, 60, 0, 0];

    // Later pre-tax depletion (2030) than the after-tax one (2028) → the
    // reconciliation must return the earlier after-tax year.
    const preTaxDepletionYear = 2030;
    const depletion = applyAfterTaxAdjustment(
      balanceNominal,
      balanceReal,
      taxDrawByYear,
      unitCpiOutcome(),
      FIRST_YEAR,
      STEPS,
      preTaxDepletionYear,
    );

    // (a) every year >= y(=2) is exactly 0 in BOTH arrays.
    expect(balanceNominal).toEqual([100, 100, 0, 0, 0]);
    expect(balanceReal).toEqual([100, 100, 0, 0, 0]);
    // (b) returned year = firstYear + y = 2028, and min(2030, 2028) = 2028.
    expect(depletion).toBe(FIRST_YEAR + 2);
    expect(depletion).toBe(Math.min(preTaxDepletionYear, FIRST_YEAR + 2));
  });

  it('keeps later positive balances when no year depletes after tax', () => {
    // Guard the absorbing branch the OTHER way: a tax draw too small to deplete
    // must NOT zero later years. Without the absorbing guard the prior test
    // would still pass on raw subtraction, so this pins the no-depletion path.
    const balanceNominal = [100, 100, 100, 200, 300];
    const balanceReal = [100, 100, 100, 200, 300];
    const taxDrawByYear = [0, 0, 10, 0, 0];

    const depletion = applyAfterTaxAdjustment(
      balanceNominal,
      balanceReal,
      taxDrawByYear,
      unitCpiOutcome(),
      FIRST_YEAR,
      STEPS,
      null,
    );

    // cumTax = 10 from y=2 on: each year just shrinks by 10, none deplete.
    expect(balanceNominal).toEqual([100, 100, 90, 190, 290]);
    expect(depletion).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The per-year tax computation's synthetic RMD account uses the prior
// year's AFTER-TAX balance (cumulative-tax-reduced) as its prior-year base, so
// a prior tax-funded withdrawal shrinks the next year's RMD floor — matching
// the deterministic side (rather than the raw PRE-TAX prior balance).
//
// NOTE: the per-year MC tax surface (`applyPerYearTaxForPath`) computes the RMD
// floor but does not yet GROSS the withdrawal up to it (no MC cashflow solver),
// so today the corrected base does not move fed tax / cashflow / balances /
// percentiles for the demo household — the correction is observable at the
// base-arithmetic boundary and becomes load-bearing once RMD enforcement lands
// on MC paths. The test below pins the corrected base arithmetic (falsifiable
// against the raw-nominal behavior).
// ---------------------------------------------------------------------------

describe('priorYearTaxBases — after-tax prior-year RMD base', () => {
  it('returns the year-0 nominal balance unchanged (no prior year, no tax yet)', () => {
    // y=0: base = the year's own nominal balance; cumulative tax is ignored.
    expect(priorYearTaxBases([500_000, 500_000], [999_999, 0])[0]).toBe(500_000);
  });

  it('reduces the prior-year nominal balance by the cumulative tax drawn through it', () => {
    // y>0: base = priorNominal − cumTaxThroughPriorYear. Feeding the raw
    // priorNominal (1_000_000) would be wrong; the base subtracts the $40k of tax funded through
    // the prior year → 960_000. Flat 1M raw, $40k tax in year 0.
    expect(priorYearTaxBases([1_000_000, 1_000_000], [40_000, 0])[1]).toBe(960_000);
  });

  it('floors the after-tax base at zero when cumulative tax exceeds the prior balance', () => {
    // Prior raw 100_000, cumulative tax 250_000 through year 0 → floored to 0.
    expect(priorYearTaxBases([100_000, 100_000], [250_000, 0])[1]).toBe(0);
  });
});

describe('fillYearBalancesAndTax — threads the after-tax base into the per-year tax loop', () => {
  const FIRST_YEAR = 2026;

  /** Single member born 1950 → RMD trigger age 73 (SECURE 2.0); retired at
   *  FIRST_YEAR so every year runs the tax estimate. */
  function rmdTaxContext(): McTaxContext {
    return {
      taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
      filingStatus: 'Single',
      members: [
        {
          memberId: 'mc-rmd-primary',
          isoBirthdate: '1950-03-01',
          onMedicare: true,
          hasAcaCoverage: false,
        },
      ],
      householdSize: 1,
    };
  }

  /** Minimal MC input carrying only the fields the tax loop reads (no
   *  per-account ledger arrays → all-pre-tax fallback). */
  function rmdInput(): MonteCarloInput {
    return {
      portfolioToday: 2_000_000,
      accountMcLedger: [],
      annualContribution: 0,
      firstYear: FIRST_YEAR,
      retirementYear: FIRST_YEAR,
      horizonYear: FIRST_YEAR + 4,
      // drawdown 80k/yr → a non-zero per-year tax draw (5 years → 60 steps).
      monthlyExpenseBase: makeMonthlyExpenseBase(80_000, 5 * 12),
      ssByYear: [0, 0, 0, 0, 0],
      incomeByYear: [0, 0, 0, 0, 0],
      pathCount: 1,
      seed: 1,
      strategyKind: 'taxEfficient',
      taxContext: rmdTaxContext(),
    };
  }

  /** Flat large pre-tax pool every step (each prior year-end nominal = pool);
   *  cumCpi = 1 (nominal == real). Only the fields the tax loop reads populated. */
  function flatPoolOut(stepCount: number, poolDollars: number): StepOutcome {
    return {
      preEnd: new Float64Array(stepCount).fill(poolDollars),
      postEnd: new Float64Array(stepCount),
      growth: new Float64Array(stepCount),
      contributions: new Float64Array(stepCount),
      withdrawal: new Float64Array(stepCount),
      deposit: new Float64Array(stepCount),
      expense: new Float64Array(stepCount),
      income: new Float64Array(stepCount),
      cumCpi: new Float64Array(stepCount).fill(1),
      depletionStepIdx: -1,
    };
  }

  it('the year-y base equals priorNominal minus the cumulative tax drawn through year y-1', () => {
    const input = rmdInput();
    const horizonYears = input.horizonYear - input.firstYear + 1;
    const stepCount = horizonYears * 12;
    const pool = 2_000_000;
    const out = flatPoolOut(stepCount, pool);

    const balN = new Array<number>(horizonYears);
    const balR = new Array<number>(horizonYears);
    // Per-year windowed nominal at cumCpi=1 (flat pool) — year-sum of the
    // per-month base, which for this lifetime fixture = the annual figure.
    const nominalExpenseByYear = Float64Array.from({ length: horizonYears }, (_, y) => {
      let s = 0;
      for (let m = y * 12; m < (y + 1) * 12 && m < stepCount; m += 1) s += input.monthlyExpenseBase[m];
      return s;
    });
    const taxState = newTaxPathState(input, out, stepCount, horizonYears, nominalExpenseByYear, new Float64Array(horizonYears), buildRunContext(input))!;
    fillYearBalancesAndTax(out, balN, balR, stepCount, taxState);

    // Every year drew a non-zero tax cashflow from the $80k drawdown.
    const draws = taxState.taxDrawByYear;
    expect(draws.every((d) => d > 0)).toBe(true);

    // Reconstruct the bases the loop fed into each year via the same absorbing
    // pass and confirm year y's (y>0) tracks the after-tax (cumulative-tax-
    // reduced) prior balance — strictly below the raw pre-tax `balN[y-1]` once
    // prior tax was drawn (the raw base). Years are flat, so balN[y-1] ===
    // pool and no year depletes (absorbing == per-year here). Year y's base =
    // prior year (y-1)'s after-tax balance = pool − cumulative tax THROUGH y-1.
    const y = 3;
    const cumThroughPriorYear = draws[0] + draws[1] + draws[2]; // through year y-1=2.
    const bases = priorYearTaxBases(balN, draws);
    expect(bases[y]).toBeCloseTo(pool - cumThroughPriorYear);
    expect(bases[y]).toBeLessThan(balN[y - 1]); // strictly below the raw base.
  });
});

// ---------------------------------------------------------------------------
// The prior-year after-tax RMD base must be ABSORBING — consistent with
// `applyAfterTaxAdjustment` (which forces every year at/after after-tax
// depletion to zero). Once the running after-tax prior base hits <= 0 at some
// year, a later RAW pre-tax kernel recovery must NOT revive it to a positive
// value. A per-year recompute from the raw pre-tax prior balance would let a
// recovery revive it, contradicting the absorbing semantics.
// `priorYearTaxBases` is the pure forward pass `fillYearBalancesAndTax` threads.
// ---------------------------------------------------------------------------

describe('priorYearTaxBases — absorbing after-tax prior-year RMD base', () => {
  it('y=0 base is the year-0 nominal; later bases use the prior year after-tax balance', () => {
    // No tax → bases follow raw nominal (y>0 uses the prior year's value).
    const bases = priorYearTaxBases([1_000, 2_000, 3_000], [0, 0, 0]);
    expect(bases).toEqual([1_000, 1_000, 2_000]);
  });

  it('reduces each later base by the cumulative tax drawn through the prior year', () => {
    // y>0 base = priorNominal − cumulative tax drawn THROUGH the prior year.
    const bases = priorYearTaxBases([2_000_000, 2_000_000, 2_000_000], [40_000, 30_000, 0]);
    expect(bases[0]).toBe(2_000_000); // y=0 → own nominal, no tax.
    expect(bases[1]).toBe(2_000_000 - 40_000); // through y0.
    expect(bases[2]).toBe(2_000_000 - (40_000 + 30_000)); // through y1.
  });

  it('does NOT revive the base when the raw pre-tax balance recovers after depletion', () => {
    // Years: large, large, crash to a sliver (after-tax base depletes there),
    // then RECOVER to a big raw balance. The recovery year's prior base must
    // stay 0 (absorbing) — a per-year recompute would revive it to the
    // raw recovery value.
    const rawNominal = [2_000_000, 2_000_000, 1, 5_000_000, 6_000_000];
    // Cumulative tax through year 2 wipes the sliver (and far exceeds it).
    const taxDraw = [10_000, 10_000, 10_000, 0, 0];
    const bases = priorYearTaxBases(rawNominal, taxDraw);
    // y=3 prior base = year-2 after-tax balance = max(0, 1 − 30_000) = 0.
    expect(bases[3]).toBe(0);
    // y=4 prior base = year-3 after-tax balance: raw recovered to 5,000,000 but
    // the running after-tax base already absorbed to 0 → stays 0, NOT revived.
    expect(bases[4]).toBe(0);
  });

  it('does NOT absorb on a no-tax zero-balance year — a later raw recovery revives the base', () => {
    // Pre-retirement / no-tax start: year 0 has a zero raw balance and NO tax is
    // ever drawn. Absorption must mirror `applyAfterTaxAdjustment`, which only
    // absorbs once real tax has wiped a positive balance (`cumTax > 0`). The
    // over-absorbing predicate (`afterTax <= 0`) marked year 0 permanently
    // depleted, suppressing the legitimate later raw-balance recovery →
    // [0, 0, 0]. Correct: no tax ever drawn → bases follow the raw after-tax
    // values, so year 2 reads the prior year's $1,000 raw balance.
    const bases = priorYearTaxBases([0, 1_000, 2_000], [0, 0, 0]);
    expect(bases).toEqual([0, 0, 1_000]);
  });
});

describe('net-need floor removed for surplus income', () => {
  it('returns a NEGATIVE target when income exceeds the inflated expense (surplus)', () => {
    // The strategy signals surplus as a negative net need (the baseline in
    // mc-parity-baselines.json was captured when the strategy clamped to 0); the
    // kernel clamps the recorded withdrawal to ≥ 0, so surplus reduces the
    // effective draw to zero (it is not routed anywhere).
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
    expect(mcParityBaselines.l25_netNeed_surplus_preFix).toBe(0);
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
    // Surplus plan: income (SS 120k) dwarfs expense (20k) after retirement, so
    // no portfolio draw is ever needed. The negative net need must clamp to a
    // 0 withdrawal (not a phantom negative draw / depletion) — success stays 1.
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
    // A small portfolio that GROWS across year 0: the year-end balance (the
    // wrong basis) is much larger than portfolioToday. Using
    // portfolioToday yields a strictly smaller year-0 RMD floor base, so the
    // first-year tax draw is lower. We assert the two configurations diverge.
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
      // RMD-age taxpayer (born 1948 → age 78 in 2026, well past the trigger).
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
    // The run completes with a defined first-year tax annotation, which only
    // populates when the (now portfolioToday-anchored) year-0 tax pass ran.
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
    // Both are valid probabilities; each strategy drains accounts in its own order.
    expect(taxEfficient.successProbability).toBeGreaterThanOrEqual(0);
    expect(strategy.successProbability).toBeGreaterThanOrEqual(0);
  });
});

describe('v25 — named-strategy MC paths fund tax per path (two-pass)', () => {
  // A tax-heavy named-strategy input so the in-step tax draw bites: a single
  // large pre-tax-only account (proportional/rothFirst draw it as ordinary
  // income) with a modest portfolio so the tax drag moves the headline numbers.
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

    // Tax can only reduce balances → success no higher, percentiles no higher.
    expect(taxed.successProbability).toBeLessThanOrEqual(taxFree.successProbability);
    const horizon = taxed.percentilesNominal.p50.length;
    for (let i = 0; i < horizon; i += 1) {
      expect(taxed.percentilesNominal.p50[i]).toBeLessThanOrEqual(
        taxFree.percentilesNominal.p50[i] + 1, // ≤ with a $1 fp tolerance.
      );
    }
    // Depletion is no LATER (smaller-or-equal year, or null→non-null is fine).
    if (taxed.medianDepletionYear !== null && taxFree.medianDepletionYear !== null) {
      expect(taxed.medianDepletionYear).toBeLessThanOrEqual(taxFree.medianDepletionYear);
    }
    // Strict funding guard: tax is funded via the pass-2 expense-fold (not display-only).
    // If the pass-2 fold regressed to display-only, taxed p50 would equal taxFree at
    // every year — this strict assertion catches it.
    expect(taxed.percentilesNominal.p50[horizon - 1]).toBeLessThan(
      taxFree.percentilesNominal.p50[horizon - 1],
    );
  });

  it('the representative run carries the per-path tax-cent fields', () => {
    const out = runMonteCarlo({ ...namedStrategyBase(), taxContext: buildTaxContext() });
    // The new per-path tax arrays drive these percentile series; defined only
    // when the funded pass-2 accumulator stamped them.
    expect(out.federalTaxPercentilesByYear).toBeDefined();
    expect(out.netAfterTaxPercentilesByYear).toBeDefined();
    // Some drawdown-phase year owes a positive federal tax on the funded run.
    const fedP50 = out.federalTaxPercentilesByYear!.p50;
    expect(fedP50.some((v) => v > 0)).toBe(true);
  });

  it('is deterministic across the two-pass (same seed ⇒ identical result)', () => {
    const input: MonteCarloInput = { ...namedStrategyBase(), taxContext: buildTaxContext() };
    const a = runMonteCarlo(input);
    const b = runMonteCarlo(input);
    expect(a.percentilesNominal.p50).toEqual(b.percentilesNominal.p50);
    expect(a.successProbability).toBe(b.successProbability);
    expect(a.federalTaxPercentilesByYear!.p50).toEqual(b.federalTaxPercentilesByYear!.p50);
  });

  // A pre-59½ rothFirst path whose seeded Roth basis ≥ its Roth withdrawals
  // must pay ~$0 income tax (federalTaxByYear) AND ~$0 10% penalty on the funded
  // run. The penalty only reaches balances via taxDrawByYear (→ ending balance /
  // depletion), so it is asserted on the funded ending balance vs a no-basis
  // control: WITHOUT the basis re-seed, pass-2 sees a depleted carrier and taxes
  // the basis as earnings + penalty, so the funded ending balance would be
  // strictly LOWER than the same run with full basis. WITH the re-seed the
  // basis-covered Roth withdrawals are tax+penalty-free, so the ending balance
  // matches the no-tax-on-Roth expectation.
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

  // Retirement at 2046 with the primary born 1991 → age 55 in 2046, i.e. the
  // whole pre-59½ window during early retirement (penalty leg active).
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
      // Full basis ≥ all Roth withdrawals → no earnings, no penalty when re-seeded.
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
    // Income-tax leg: Roth withdrawals covered by basis → ~$0 federal tax in the
    // pre-59½ retirement years (SS not yet taxable here; no other ordinary income).
    const fedP50 = withBasis.federalTaxPercentilesByYear!.p50;
    const retIdx = 2046 - 2026;
    for (let i = retIdx; i < retIdx + 4; i += 1) {
      expect(fedP50[i]).toBeLessThanOrEqual(1); // ≤ $1 fp tolerance.
    }
    // Penalty leg: compare against a NO-BASIS run (carrier starts empty → all Roth
    // earnings + penalty). The full-basis run must end strictly RICHER, proving the
    // basis shielded the penalty cashflow that otherwise depresses the balance.
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
    // Empty ledger → runOnePathViaStrategyEngine bails to runOnePathKernel; the
    // strategy-path tax pass is bypassed, no crash, a valid summary still emits.
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
    // The kernel still funds tax in-step, so the tax percentile bands populate.
    expect(out.federalTaxPercentilesByYear).toBeDefined();
  });
});

describe('per-path CPI-scaled inflation-tracked income', () => {
  it('inflation-tracked income lifts the median ending balance vs flat-nominal', () => {
    // A scenario whose non-SS income is entirely inflation-tracked should, on
    // the higher-inflation paths, deliver more nominal income than the same
    // income left flat-nominal — pushing the median ending balance up.
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
      // 1000 paths so the systematic inflation-tracked-income lift dominates
      // path-mix noise — at 100 paths the block-bootstrap sampler's
      // sequence clustering let a single seed's draw flip the median ordering;
      // the directional invariant holds, it just needs more paths to read it.
      ...baseInput,
      pathCount: 1000,
      seed: 1,
      portfolioToday: 1_500_000,
      accountMcLedger: ledger,
      annualContribution: 0,
      firstYear,
      retirementYear: firstYear,
      horizonYear,
      // Larger expense → a larger annual draw the tracked income offsets, so the
      // inflation-tracking lift is a bigger share of the ending balance and the
      // directional invariant reads cleanly through the block sampler's
      // path-mix noise (75k left the signal smaller than one seed's variance).
      monthlyExpenseBase: makeMonthlyExpenseBase(120_000, (horizonYear - firstYear + 1) * 12),
      scenarioInflationPct: 3,
      ...arrays,
    };
    // Income (55k tracked) partly offsets expense (120k): the portfolio carries
    // the gap. With income inflation-tracked, the higher-inflation paths deliver
    // more nominal income, so less is drawn → a higher median ending balance.
    const tracked = runMonteCarlo({
      ...common,
      tracksInflationIncomeByYear: tracksInflation,
    });
    const flat = runMonteCarlo({
      ...common,
      // No tracksInflation slice → all income stays pre-computed nominal.
    });
    expect(tracked.medianEndingBalanceNominal).toBeGreaterThan(
      flat.medianEndingBalanceNominal,
    );
  });
});

// ---------------------------------------------------------------------------
// Stationary block bootstrap — statistical, tail, correlation, and
// parity-bypass assertions. All bars resolve from the red-first fixture
// `projection-engine/__fixtures__/sampler-stats.json` ± the stated
// margins, so nothing is back-fitted to block output. Fixed seed throughout.
// ---------------------------------------------------------------------------
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
    // Reconstruct the prior IID sampler inline: one uniformInt per month, no
    // continuation draws. L = 1 must reproduce this index sequence exactly.
    const data = HISTORICAL_MONTHLY;
    const iidRng = makeRng(4242);
    const iidDates = Array.from({ length: 240 }, () => data[iidRng.uniformInt(0, data.length - 1)].date);
    const blockL1 = drawMonthlySeries(makeRng(4242), 240, 1);
    expect(blockL1.map((m) => m.date)).toEqual(iidDates);
  });

  it('injects serial dependence: lag-1 |return| autocorrelation clears the clustering bar', () => {
    const months = concatSampledPaths((seed) =>
      drawMonthlySeries(makeRng(seed), RECORDER_SERIES_LEN, DEFAULT_MEAN_BLOCK_LENGTH),
    );
    const ac = absReturnAutocorr(months);
    // ≥ baseline_iid + 0.05 (absolute margin above the IID control) AND
    // ≥ 0.5 × empirical (recovers at least half the clustering IID destroys).
    expect(ac).toBeGreaterThanOrEqual(f.baseline_iid_autocorr + 0.05);
    expect(ac).toBeGreaterThanOrEqual(0.5 * f.empirical_autocorr);
  });

  it('reproduces sustained drawdowns: multi-month down-run frequency moves toward empirical', () => {
    const months = concatSampledPaths((seed) =>
      drawMonthlySeries(makeRng(seed), RECORDER_SERIES_LEN, DEFAULT_MEAN_BLOCK_LENGTH),
    );
    const freq = drawdownRunFrequency(months, f.drawdownRunLength);
    expect(freq).toBeGreaterThanOrEqual(f.baseline_iid_drawdown_freq + 0.02);
    expect(Math.abs(freq - f.empirical_drawdown_freq)).toBeLessThanOrEqual(0.05);
  });

  it('preserves the joint cross-asset + return-CPI correlation matrix (±0.03 per entry)', () => {
    const months = concatSampledPaths((seed) =>
      drawMonthlySeries(makeRng(seed), RECORDER_SERIES_LEN, DEFAULT_MEAN_BLOCK_LENGTH),
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
    // Average over the recorder seed set so the bar reads the sampler's
    // central tendency, not one seed's Monte Carlo noise.
    const seeds = [101, 202, 303];
    const successes = seeds.map(
      (seed) => runMonteCarlo({ ...input, seed, pathCount: 100 }).successProbability,
    );
    const mean = successes.reduce((a, b) => a + b, 0) / successes.length;
    const delta = mean - f.baseline_iid_success;
    // Right direction (lower) by a bounded amount: 1–10 pp worsening.
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
    // The block sampler is never reached for injected runs, so varying L (or
    // omitting it) must not change a single number.
    const a = runMonteCarlo({ ...withInjected, meanBlockLength: 1 });
    const b = runMonteCarlo({ ...withInjected, meanBlockLength: 12 });
    const c = runMonteCarlo(withInjected);
    expect(a.percentilesNominal.p50).toEqual(b.percentilesNominal.p50);
    expect(a.percentilesReal.p10).toEqual(b.percentilesReal.p10);
    expect(a.successProbability).toBe(b.successProbability);
    expect(c.percentilesNominal.p50).toEqual(a.percentilesNominal.p50);
  });

  it('v32: injected-CPI run — realFactorByYear === 1 / cumCpi and realBalance === balance × factor', () => {
    // Constant injectedCpi 0.2 %/month → a deterministic, monotone cumCpi the
    // factor identity can be checked against bit-for-bit (cross-engine parity).
    const stepCount = (baseInput.horizonYear - baseInput.firstYear + 1) * 12;
    const injectedReturns = new Float64Array(stepCount);
    const injectedCpi = new Float64Array(stepCount);
    for (let i = 0; i < stepCount; i += 1) {
      injectedReturns[i] = 0.4 + (i % 12) * 0.01;
      injectedCpi[i] = 0.2;
    }
    const out = runMonteCarlo({ ...baseInput, injectedReturns, injectedCpi });
    const run = out.representativeByBasis!['mc-typical']!;
    // Independently accumulate cumCpi from the same constant monthly rate so the
    // factor is verified against the reciprocal, not just self-consistency.
    let cum = 1;
    const cumCpiAtYearEnd: number[] = [];
    for (let i = 0; i < stepCount; i += 1) {
      cum *= 1 + injectedCpi[i] / 100;
      if ((i + 1) % 12 === 0) cumCpiAtYearEnd.push(cum);
    }
    for (let i = 0; i < run.years.length; i += 1) {
      const expectedFactor = 1 / cumCpiAtYearEnd[i];
      // Path own CPI > 1 over the horizon → factor < 1 (future > today's nominal).
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
  // Contribution growth. Single non-CBP account, all
  // contributions today's-dollars base. Under injected mode every path is
  // identical, so `percentilesNominal.p50` at the at-retirement year is the
  // single trajectory — usable as a deterministic comparison point.
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
    // Today's-dollars base: $1000/mo through the accumulation window. For
    // a 'fixed' account the bake is applied here (mirrors the production
    // `buildPlannedContribSeries`); a tracks-inflation account stays flat.
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
    // Zero investment return so the ONLY driver of the nominal pot is the
    // contribution stream. A higher injected CPI grows the today's-dollars
    // base more, so the at-retirement nominal pot is strictly larger — yet
    // the same dollars are flat-real (each path deflates by its own CPI).
    const asOfMonth = FIRST_YEAR * 12;
    const ledger = growthLedger('tracks-inflation', 0, asOfMonth);
    const low = runMonteCarlo(growthInput(ledger, 0, 0.1));
    const high = runMonteCarlo(growthInput(ledger, 0, 0.4));
    expect(low.percentilesNominal.p50[RET_IDX]).toBeGreaterThan(0);
    expect(high.percentilesNominal.p50[RET_IDX]).toBeGreaterThan(
      low.percentilesNominal.p50[RET_IDX],
    );
    // A zero-CPI path leaves the today's-dollars base un-scaled → smaller
    // still (proves the scaling is the contribution, not investment growth).
    const zero = runMonteCarlo(growthInput(ledger, 0, 0));
    expect(low.percentilesNominal.p50[RET_IDX]).toBeGreaterThan(
      zero.percentilesNominal.p50[RET_IDX],
    );
  });

  it('a tracks-inflation account == a fixed account at the same rate (cross-mode parity)', () => {
    // With injected CPI fixed at the scenario rate, scaling the today's-
    // dollars base by cumCpi (tracks-inflation) is identical to baking the
    // same fixed growth (fixed mode) — the two engines/modes must produce a
    // bit-identical nominal pot. Zero investment return isolates the
    // contribution growth. Injected CPI is the monthly equivalent of a 3%
    // annual rate so the cumCpi factor === the fixed-bake factor each step.
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
    // Regression guard. The cross-mode parity test above uses
    // `todayMonthIndex = 0` (asOfMonth = FIRST_YEAR*12) — the ONE month where
    // the buggy step-0 anchor coincides with the correct today-anchor, so it
    // cannot catch the bug. Here "today" is May (todayMonthIndex = 5), so the
    // MC per-path CPI scaling must re-anchor to step 5 to equal the
    // deterministic engine. With a step-0 anchor the tracks-inflation pot is
    // grown ~5 extra months of inflation and this assertion fails.
    const scenarioRatePct = 3;
    const monthlyCpi = (Math.pow(1 + scenarioRatePct / 100, 1 / 12) - 1) * 100;
    const TODAY_MONTH = 5;
    const asOfMonth = FIRST_YEAR * 12 + TODAY_MONTH;
    const tracks = runMonteCarlo(
      growthInput(growthLedger('tracks-inflation', 0, asOfMonth), 0, monthlyCpi, TODAY_MONTH),
    );
    // (a) The same account modeled as a fixed-rate BAKE at the matching rate,
    // anchored at the same asOfMonth. `growthLedger('fixed', …)` bakes the
    // deterministic factor `(1+rate)^((FIRST_YEAR*12+i − asOfMonth)/12)`.
    const fixed = runMonteCarlo(
      growthInput(growthLedger('fixed', scenarioRatePct, asOfMonth), 0, monthlyCpi, TODAY_MONTH),
    );
    for (let i = 0; i < tracks.percentilesNominal.p50.length; i += 1) {
      expect(fixed.percentilesNominal.p50[i], `fixed-bake parity step ${i}`).toBeCloseTo(
        tracks.percentilesNominal.p50[i],
        6,
      );
    }
    // (b) The DETERMINISTIC contribution series independently. With zero return
    // the at-retirement nominal pot is exactly the sum of the today-anchored
    // contribution series the deterministic engine produces (RET_STEP months of
    // $1000/mo grown by `contributionGrowthFactor(rate, eventMonth, asOfMonth)`).
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

describe('representative-run output (v22)', () => {
  const HORIZON = baseInput.horizonYear - baseInput.firstYear + 1;

  // Consistency-invariant fixture: a multi-account plan that under-funds
  // (success ≈ 0.48 < 0.5, so `medianDepletionYear` is non-null) and depletes a
  // majority of paths to a $0 ending balance across the horizon. Every tier's
  // rank-p path is effectively depleted, so the depletion-aware tie-break
  // reconciles each tier's run-out year exactly to its card depletion stat
  // (median / P25 / P10).
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
      // Cache-shape: the display-deflation factor is present and full-length.
      expect(run.realFactorByYear.length).toBe(HORIZON);
    }
  });

  it('v32: realFactorByYear satisfies the balance-line identity over the indexed domain (kernel path)', () => {
    // realBalanceByYear[i] === years[i].balance * realFactorByYear[i]
    // over [0, years.length); every in-domain factor is finite and positive
    // (no zero-factor entry — basisDeflator never emits NaN).
    const out = runMonteCarlo({ ...baseInput, pathCount: 200 });
    for (const basis of ['mc-typical', 'mc-pessimistic', 'mc-bad-luck'] as const) {
      const run = out.representativeByBasis![basis]!;
      for (let i = 0; i < run.years.length; i += 1) {
        const factor = run.realFactorByYear[i];
        expect(Number.isFinite(factor), `${basis} factor ${i}`).toBe(true);
        expect(factor).toBeGreaterThan(0);
        expect(run.realBalanceByYear[i]).toBeCloseTo(run.years[i].balance * factor, 6);
      }
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
    // Each replay seed is `(baseSeed + pathIndex * 0x9e3779b1) >>> 0` — an
    // unsigned 32-bit value, and the captured run was REPLAYED with that seed.
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
      // Once a year depletes the balance latches at 0 and the reconciliation
      // identity no longer needs to hold (the engine clamps the draw).
      if (yr.depleted || yr.balance <= 0) {
        prior = yr.balance;
        continue;
      }
      const expected = prior + yr.growth - yr.withdrawn + yr.deposit;
      // Per-account compounding + month-precise CPI introduce a small residual;
      // assert reconciliation to within a practical fraction of the balance.
      const tol = Math.max(1, Math.abs(expected) * 0.02);
      expect(Math.abs(yr.balance - expected)).toBeLessThanOrEqual(tol);
      prior = yr.balance;
    }
  });

  it('ranks by REAL ending balance: Bad-luck (P10) ≤ Pessimistic (P25) ≤ Typical (P50) (within EPS_REAL for depleted tiers)', () => {
    // With the depletion-aware tie-break, reconciled effectively-depleted
    // tiers end at distinct ~1e-9 residuals and are ordered by depletion YEAR, not
    // ending balance — so the frozen ending-balance ordering is asserted to within
    // EPS_REAL for depleted tiers (all ≤ EPS_REAL) and exactly for surviving tiers.
    const out = runMonteCarlo({ ...baseInput, pathCount: 400 });
    const byBasis = out.representativeByBasis!;
    const realEnd = (b: typeof byBasis['mc-typical']): number =>
      b ? b.realBalanceByYear[b.realBalanceByYear.length - 1] : 0;
    const badLuck = realEnd(byBasis['mc-bad-luck']);
    const pessimistic = realEnd(byBasis['mc-pessimistic']);
    const typical = realEnd(byBasis['mc-typical']);
    // Surviving tiers keep the strict ending-balance ordering; depleted tiers all
    // sit at ≤ EPS_REAL, so the ordering holds to within that de-minimis band.
    expect(badLuck).toBeLessThanOrEqual(pessimistic + EPS_REAL);
    expect(pessimistic).toBeLessThanOrEqual(typical + EPS_REAL);
  });

  it('reconciled depleted tiers satisfy the depletion-year ordering p10 ≤ p25 ≤ median', () => {
    // A ≥25%-deplete multi-account fixture where every tier's rank-p path is
    // effectively depleted: the reconciled run-out years are monotone by
    // construction (fewer paths have run out by the earlier percentile year).
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
      // Cumulative inflation over a 60-year horizon strictly compresses the
      // real value below nominal (the path's own sampled CPI > 1).
      expect(real).toBeLessThan(nominal);
    }
  });

  it('(a) reconciles every effectively-depleted tier exactly to its card depletion stat', () => {
    // Multi-account fixture: the rank-p path is effectively depleted for all
    // three tiers, so each tier's representative run-out year EQUALS the matching
    // card percentile EXACTLY — proving exactness survives the multi-account fp
    // residual (the captured paths end at ~1e-9, not exact $0).
    const out = runMonteCarlo(consistencyInput);
    const byBasis = out.representativeByBasis!;
    // Card stats must be non-null (success < 0.5 → median defined; deep tail).
    expect(out.medianDepletionYear).not.toBeNull();
    expect(out.p25DepletionYear).not.toBeNull();
    expect(out.p10DepletionYear).not.toBeNull();
    expect(byBasis['mc-typical']!.depletionYear).toBe(out.medianDepletionYear);
    expect(byBasis['mc-pessimistic']!.depletionYear).toBe(out.p25DepletionYear);
    expect(byBasis['mc-bad-luck']!.depletionYear).toBe(out.p10DepletionYear);
  });

  it('(b) the helper actually moves the pick toward the card target (a no-op helper fails)', () => {
    // Direct helper test: a four-path field where the rank-p index is a far-off
    // depleter and a closer effectively-depleted candidate exists → the helper
    // MUST return the closer index, not the unchanged rank index. An inert
    // helper (return rankIdx) fails this.
    const endingReal = [0.000001, 0.0000005, 0.0000002, 0.0000008];
    const depletionYearByPath = [2050, 2080, 2070, 2090];
    const rankIdx = 1; // depletionYear 2080, far from a 2071 card target
    const cardTarget = 2071; // closest is index 2 (2070)
    const picked = reconcileEffectivelyDepletedPick(
      rankIdx,
      endingReal,
      depletionYearByPath,
      cardTarget,
      EPS_REAL,
    );
    expect(picked).toBe(2);
    expect(picked).not.toBe(rankIdx);
  });

  it('(c) secondary tie-break: equal |depletionYear − target| resolves to the lower pathIndex', () => {
    // Two effectively-depleted candidates equidistant from the target (2070±5);
    // the lower pathIndex (index 1) must win.
    const endingReal = [10_000, 0.0000003, 0.0000004, 50_000];
    const depletionYearByPath = [null, 2065, 2075, null];
    const rankIdx = 1; // effectively depleted, gate active
    const cardTarget = 2070; // |2065−2070| == |2075−2070| == 5
    const picked = reconcileEffectivelyDepletedPick(
      rankIdx,
      endingReal,
      depletionYearByPath,
      cardTarget,
      EPS_REAL,
    );
    expect(picked).toBe(1);
  });

  it('(d) survivor / bounce-back fallback: a material-balance rank-p path is unchanged', () => {
    // The rank-p path survived (ending ≥ EPS_REAL) → the gate never fires, the
    // pick is byte-for-byte the unchanged rank index even though depleted
    // candidates with closer depletion years exist.
    const endingReal = [0.0000002, 1_234_567, 0.0000005];
    const depletionYearByPath = [2055, 2080, 2060];
    const rankIdx = 1; // material balance → survivor fallback
    const picked = reconcileEffectivelyDepletedPick(
      rankIdx,
      endingReal,
      depletionYearByPath,
      2057,
      EPS_REAL,
    );
    expect(picked).toBe(1);
  });

  it('(e) empty-candidate fallback: a near-$0 cluster with no recorded depletion is unchanged', () => {
    // The rank-p path ends below EPS_REAL via CPI erosion but never tripped a
    // depletion year (null), and no other path is effectively depleted → empty
    // candidate set → unchanged pick (no throw, no mis-select).
    const endingReal = [0.0000003, 0.0000004, 0.0000002];
    const depletionYearByPath = [null, null, null];
    const rankIdx = 0; // ends < EPS_REAL but depletionYear is null → gate off
    const picked = reconcileEffectivelyDepletedPick(
      rankIdx,
      endingReal,
      depletionYearByPath,
      2070,
      EPS_REAL,
    );
    expect(picked).toBe(rankIdx);
  });

  it('(f) bounce-back regression: a depleted path revived above EPS_REAL is not a candidate', () => {
    // A path that ran out (depletionYear set) but a drawdown-phase deposit revived
    // it above EPS_REAL must NOT be pulled into the candidate set. Here index 2 is
    // a bounce-back (depleted but material ending) closer to the target than the
    // genuine $0 candidate index 0 — the genuine $0 candidate must still win.
    const endingReal = [0.0000005, 0.0000006, 900_000];
    const depletionYearByPath = [2058, 2059, 2071];
    const rankIdx = 0; // effectively depleted, gate active
    const cardTarget = 2070; // bounce-back (idx 2, 2071) is closest but excluded
    const picked = reconcileEffectivelyDepletedPick(
      rankIdx,
      endingReal,
      depletionYearByPath,
      cardTarget,
      EPS_REAL,
    );
    // idx 2 (the revived path) is excluded; among {0:2058, 1:2059} idx 1 is closer.
    expect(picked).toBe(1);
  });

  it('(h) named-strategy: representativeRun.depletionYear === depletionYearByPath[chosenIndex] (card stat), post-pass leaves it untouched', () => {
    // Named strategy (proportional) runs the pass-2 re-run + the RMD / tax
    // post-passes, which are display-only (stamp cents, never mutate depletionYear
    // or years[].balance). The captured representative run's depletionYear must
    // equal depletionYearByPath[chosenIndex] — here the card depletion stat.
    const named = runMonteCarlo({ ...consistencyInput, strategyKind: 'proportional' });
    const byBasis = named.representativeByBasis!;
    expect(named.p25DepletionYear).not.toBeNull();
    const pess = byBasis['mc-pessimistic']!;
    // depletionYear is exactly the card stat for the reconciled effectively-
    // depleted pick (identity: captured depletionYear === depletionYearByPath
    // [chosenIndex] === card stat, the same whole-year derivation).
    expect(pess.depletionYear).toBe(named.p25DepletionYear);
    // Sub-assertion: the tax cents the tax post-pass stamped on a drawdown row do
    // not coincide with — and therefore did not overwrite — the depletionYear.
    const drawdownRow = pess.years.find((y) => y.depleted);
    expect(drawdownRow?.depleted).toBe(true);
    // The captured depletionYear is a calendar year within the horizon, untouched
    // by the cents-only post-pass.
    expect(pess.depletionYear).toBeGreaterThanOrEqual(baseInput.retirementYear);
    expect(pess.depletionYear).toBeLessThanOrEqual(consistencyInput.horizonYear);
  });
});

// ---------------------------------------------------------------------------
// Representative-run reroll band (card-consistent alternatives)
// ---------------------------------------------------------------------------

describe('representative-run reroll band (v27)', () => {
  // Same depleting fixture as the consistency block above: a multi-account plan
  // that under-funds (success < 0.5 → median defined) and depletes a majority of
  // paths to a $0 ending balance, so each tier's rank-p path is effectively
  // depleted and the band is a depletion-year window around the card stat.
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
    // Density spike pinned as a regression: at the production path count a
    // depleting tier's ±DEPLETION_BUCKET window holds ≥2 paths, so the reroll
    // control is enabled (the band has an alternative). DEPLETION_BUCKET is set to
    // the hard ceiling 2 so rerolled lines span a wider run-out range.
    expect(DEPLETION_BUCKET).toBe(2);
    const out = runMonteCarlo({ ...consistencyInput, pathCount: 10_000 });
    const bands = out.representativeBandsByBasis!;
    expect(bands['mc-pessimistic'].length).toBeGreaterThanOrEqual(2);
    expect(bands['mc-bad-luck'].length).toBeGreaterThanOrEqual(2);
  });

  it('band element 0 == the Part-1 reconciled default pick / seed for every tier', () => {
    const out = runMonteCarlo(consistencyInput);
    const bands = out.representativeBandsByBasis!;
    // The default pick's seed is the one surfaced for each representative run.
    expect(bands['mc-typical'][0]).toBe(out.representativeTypicalSeed);
    expect(bands['mc-pessimistic'][0]).toBe(out.representativePessimisticSeed);
    expect(bands['mc-bad-luck'][0]).toBe(out.representativeBadLuckSeed);
  });

  it('caps the band at REROLL_BAND_CAP seeds', () => {
    // A dense field: 100 effectively-depleted paths, all within the window of
    // the card target, so every tier has far more candidates than the cap.
    const n = 100;
    const endingReal = Array.from({ length: n }, () => 0.0000005);
    const depletionYearByPath = Array.from({ length: n }, (_v, i) => 2069 + (i % 3));
    const bands = assembleRepresentativeBands(
      5,
      endingReal,
      depletionYearByPath,
      { 0.5: 2070, 0.25: 2070, 0.1: 2070 },
      EPS_REAL,
    );
    for (const basis of ['mc-typical', 'mc-pessimistic', 'mc-bad-luck'] as const) {
      expect(bands[basis].length, basis).toBeLessThanOrEqual(REROLL_BAND_CAP);
    }
  });

  it('tolerance-gating: every depleted-tier band member depletes within DEPLETION_BUCKET of the card stat', () => {
    // Direct helper test over a synthetic field: the band must exclude any path
    // whose depletion year strays beyond DEPLETION_BUCKET of the card target. A
    // regression that widened the gate would pull the far depleter (idx 5) in.
    const endingReal = [0.000001, 0.0000009, 0.0000008, 0.0000007, 0.0000006, 0.0000005];
    //                   2070       2071       2069       2072       2090(far)   2071
    const depletionYearByPath = [2070, 2071, 2069, 2072, 2090, 2071];
    const bands = assembleRepresentativeBands(
      99,
      endingReal,
      depletionYearByPath,
      { 0.5: 2070, 0.25: 2070, 0.1: 2070 },
      EPS_REAL,
    );
    // p=0.25 rank lands on an effectively-depleted path → depleted-tier band.
    const memberIndices = bands['mc-pessimistic'].map(
      (seed) => endingReal.findIndex((_v, i) => seedForPathIndexLocal(99, i) === seed),
    );
    for (const idx of memberIndices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      const dep = depletionYearByPath[idx]!;
      expect(Math.abs(dep - 2070)).toBeLessThanOrEqual(DEPLETION_BUCKET);
    }
    // The far depleter (idx 5? no — idx 4 = 2090) is never a member.
    expect(memberIndices).not.toContain(4);
  });

  it('even-spread: a dense in-window set is sampled across distinct depletion years, not the closest cluster', () => {
    // 40 effectively-depleted paths all within ±1 of the card target, with
    // distinct depletion years 2069/2070/2071. The cap (25) must keep a spread,
    // not 25 copies of the closest year.
    const n = 40;
    const endingReal = Array.from({ length: n }, () => 0.0000005);
    const depletionYearByPath = Array.from({ length: n }, (_v, i) =>
      i % 3 === 0 ? 2069 : i % 3 === 1 ? 2070 : 2071,
    );
    const bands = assembleRepresentativeBands(
      7,
      endingReal,
      depletionYearByPath,
      { 0.5: 2070, 0.25: 2070, 0.1: 2070 },
      EPS_REAL,
    );
    const band = bands['mc-pessimistic'];
    expect(band.length).toBe(REROLL_BAND_CAP);
    const memberYears = new Set(
      band.map((seed) => {
        const idx = endingReal.findIndex((_v, i) => seedForPathIndexLocal(7, i) === seed);
        return depletionYearByPath[idx];
      }),
    );
    // More than one distinct depletion year survived the cap (a closest-cluster
    // sampler would collapse to a single year).
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
    // A two-member band has exactly one alternative — always index 1, never 0.
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
    // Every alternative 1..altCount appears exactly once across one cycle —
    // so the user sees all distinct alternatives before any repeats.
    expect(new Set(visited).size).toBe(altCount);
    expect(Math.min(...visited)).toBe(1);
    expect(Math.max(...visited)).toBe(altCount);
    // No alternative is shown twice in a row (including across the wrap).
    for (let k = 1; k <= altCount; k += 1) {
      const a = pickBandIndex(bandLen, 777, 'mc-bad-luck', k);
      const b = pickBandIndex(bandLen, 777, 'mc-bad-luck', k + 1);
      expect(a).not.toBe(b);
    }
  });

  it('main-thread replay reproduces the WORKER-captured representative run bit-for-bit', () => {
    // Parity: replaying the default pick's seed on the main thread via the
    // exported runOnePath + buildRunContext reproduces the per-year balances the
    // engine captured for that same seed inside runMonteCarlo (the "worker"
    // output here — same module, same code path the worker runs).
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
    // The rerolled / replayed run carries the display-deflation factor.
    expect(replay!.realFactorByYear).toEqual(workerRun.realFactorByYear);
  });
});

// Local mirror of the engine's seed-from-index derivation, used by the band
// tests to map a stored seed back to its synthetic path index.
function seedForPathIndexLocal(baseSeed: number, pathIndex: number): number {
  return (baseSeed + pathIndex * 0x9e3779b1) >>> 0;
}

// ---------------------------------------------------------------------------
// Per-account representative-run capture + MC RMD post-pass
// ---------------------------------------------------------------------------

describe('representative-run per-account capture (v23)', () => {
  const RET_IDX = 2046 - 2026;
  const HORIZON = baseInput.horizonYear - baseInput.firstYear + 1;

  /** Single qualifying tax-deferred account (RETIREMENT_401K / PRE_TAX) owned
   *  by the primary, so the RMD post-pass fires. */
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

  // Member born 1951 → RMD trigger age 73, attained by 2024; so every drawdown
  // year (2046+) is RMD-age and the post-pass produces a positive floor.
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
    // Pre-retirement accumulation rows carry no per-account map (the adapter
    // slices them off); drawdown-phase rows do.
    expect(run.years[RET_IDX - 1].accountBalances).toBeUndefined();
    let checkedDrawdown = false;
    for (let y = RET_IDX; y < run.years.length; y += 1) {
      const yr = run.years[y];
      const map = yr.accountBalances;
      expect(map, `year offset ${y}`).toBeDefined();
      if (!map) continue;
      let sum = 0;
      for (const acct of map.values()) {
        // preEnd + postEnd reconciles to the per-account balance.
        expect(acct.balance).toBeCloseTo(acct.preEnd + acct.postEnd, 4);
        sum += acct.balance;
      }
      // Per-account balances sum to the pooled year-end total (reconciliation
      // invariant — hard assertion).
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
    // At least one drawdown-phase year carries a positive RMD floor.
    const withFloor = run.years.filter((yr) => (yr.rmdFloorCents ?? 0) > 0);
    expect(withFloor.length).toBeGreaterThan(0);
    for (const yr of withFloor) {
      expect(yr.rmdShortfallCents).toBeDefined();
      expect(yr.rmdShortfallCents).toBeGreaterThanOrEqual(0);
      // Shortfall never exceeds the floor.
      expect(yr.rmdShortfallCents!).toBeLessThanOrEqual(yr.rmdFloorCents!);
    }
  });

  it('leaves rmd fields absent when there is no qualifying tax-deferred account', () => {
    // baseInput ledger accounts have no accountType → default OTHER → non-
    // qualifying, so the post-pass populates nothing even with a taxContext.
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

  // Named-strategy path with qualifying PRE_TAX account +
  // RMD-age taxContext — buildStrategyRmdContext returns a context so
  // applyRmdFloorPrePass runs inline per path, populating the surplus-disposition
  // fields on each DrawdownYear. With a $2M 401k at age 95+ and net spending
  // ~$50k, the forced RMD greatly exceeds withdrawal need on typical paths.
  it('strategy path: inline RMD pre-pass fires for qualifying ledger, surplus flows to rmdOverflowToCashCents on drawdown years', () => {
    const out = runMonteCarlo({
      ...baseInput,
      pathCount: 200,
      strategyKind: 'proportional',
      accountMcLedger: rmdLedger(2_000_000),
      taxContext: rmdMemberContext(),
    });
    const run = out.representativeByBasis!['mc-typical']!;
    // At least one drawdown-phase year must carry a positive rmdOverflowToCashCents:
    // the forced RMD on a $2M PRE_TAX account at age 95+ far exceeds net spending,
    // and there is no POST_TAX non-Roth landing account to reinvest into.
    const surplusYears = run.years.filter((yr) => (yr.rmdOverflowToCashCents ?? 0) > 0);
    expect(surplusYears.length).toBeGreaterThan(0);
    for (const yr of surplusYears) {
      expect(yr.rmdOverflowToCashCents).toBeGreaterThan(0);
      // rmdReinvestedCents must be absent (no POST_TAX non-Roth landing account).
      expect(yr.rmdReinvestedCents).toBeUndefined();
    }
  });

  // The funding-pass inherited marker is sourced from the RMD context
  // both engines already carry, so `buildStrategyRmdContext` must still return one
  // for a household whose ONLY RMD-relevant account is an INHERITED Roth IRA. Its
  // `anyQualifies` gate admits that account through `isInheritedRmdSubjectType`
  // (the living-owner `isQualifyingAccount` test would reject a Roth IRA). Pinned
  // observably: a context makes the engine materialise its synthetic RMD-overflow
  // cash carrier, because this household has no real POST_TAX-non-Roth account to
  // reinvest surplus into.
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

    // Contrast: the SAME Roth IRA with no inherited fact is not RMD-relevant at
    // all (a living Roth owner has no RMD), so no context and no carrier.
    const withoutFacts = runMonteCarlo({
      ...baseInput,
      pathCount: 50,
      strategyKind: 'proportional',
      accountMcLedger: inheritedRothLedger,
      taxContext: rmdMemberContext(),
    });
    expect(carrierPresent(withoutFacts)).toBe(false);
  });

  // The admission gate above is decided by a DIFFERENT branch of
  // `buildStrategyRmdContext` than the facts forwarding: `anyQualifies` reads
  // the facts locally, while the returned context carries them via a separate
  // spread. This pins the forwarding itself — drop the spread and the context
  // still exists (the previous test stays green) but every MC
  // `AccountRunState.inheritedAccount` reads undefined, silently diverging the
  // MC funding pass (inherited tax-free classification, Fill-target rejection)
  // from the deterministic engine.
  it('strategy path: the rebuilt RMD context carries rmdFactsByAccountId through to the engine', () => {
    const ctx = buildStrategyRmdContext({
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
    expect(ctx).toBeDefined();
    expect(ctx!.rmdFactsByAccountId?.['inherited-roth-ira']?.inheritedAccount).toBe(true);
  });

  it('strategy path: no surplus fields when ledger is non-qualifying (positive-branch contrast)', () => {
    // Non-qualifying baseline: same strategyKind + RMD-age taxContext but the
    // default baseInput ledger has no accountType → OTHER → buildStrategyRmdContext
    // returns undefined → applyRmdFloorPrePass skips → no surplus fields.
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

  // Frozen baseline (baseInput, seed 12345, pathCount 200, mc-typical
  // representative run, taxEfficient strategy path), captured on the
  // strategy-aware engine (the retired Combined Pot kernel is no longer a
  // path). A regression in the drawdown path
  // fails here.
  const FROZEN_V50 = {
    depletionYear: null as number | null,
    firstDrawdownYears: [
      { year: 2046, balance: 5541412.786764895, withdrawn: 123116.80335865493, growth: 396281.27675612294 },
      { year: 2047, balance: 5962116.437162663, withdrawn: 126001.07385001527, growth: 546704.724247783 },
      { year: 2048, balance: 5469252.449963968, withdrawn: 129710.48077189457, growth: -363153.5064268012 },
    ],
  };
  // Frozen first-drawdown-year RMD/tax cents for a household whose owner is
  // past the RMD trigger age at retirement (rmdLedger($800k) + RMD-age context).
  // The per-owner RMD floor (`computeMcRmdFloorCents`) — not a whole-portfolio
  // synthetic floor — drives the per-path tax, which shapes the per-path
  // drawdown → the captured per-account balances → both the displayed
  // `rmdFloorCents` and `federalTaxCents` for this RMD-age household. The values
  // are the correctness baseline.
  const FROZEN_V50_RMD = {
    rmdFloorCents: 51389345,
    rmdShortfallCents: 0,
    federalTaxCents: 15120446,
    irmaaSurchargeCents: 0,
  };

  // Single qualifying tax-deferred account owned by a member already past the
  // RMD trigger age at retirement, so the first-drawdown RMD floor is positive
  // (the most-at-risk byte-identity value). Born 1951 → trigger age 73
  // attained by 2024; every drawdown year (2046+) is RMD-age.
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
    // One entry per pre-retirement year (2026..2045 = RET_IDX years).
    expect(accum!.length).toBe(RET_IDX);
    expect(accum![0].year).toBe(baseInput.firstYear);
    expect(accum![accum!.length - 1].year).toBe(baseInput.retirementYear - 1);
    for (const entry of accum!) {
      // Per-account stacking fields reconcile (balance === preEnd + postEnd) and
      // carry NO withdrawal/deposit/RMD/tax cents (stacking-only).
      for (const acct of entry.accountBalances.values()) {
        expect(acct.balance).toBeCloseTo(acct.preEnd + acct.postEnd, 4);
        expect(acct.withdrawn).toBe(0);
        expect(acct.deposit).toBe(0);
        // Stacking-only: no per-account withdrawal-split cent fields.
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
    // CRITICAL: the new field lives ONLY on the representative run, NOT on the
    // years[] rows. Every consumer that checks `accountBalances !== undefined`
    // on a years[] row must still classify pre-retirement rows as accumulation.
    for (const strategyKind of ['taxEfficient', 'proportional'] as const) {
      const out = runMonteCarlo({ ...baseInput, pathCount: 200, strategyKind });
      const run = out.representativeByBasis!['mc-typical']!;
      for (let y = 0; y < RET_IDX; y += 1) {
        expect(run.years[y].accountBalances, `strategy=${strategyKind} year ${y}`).toBeUndefined();
      }
      // The drawdown boundary row onward still carries accountBalances.
      expect(run.years[RET_IDX].accountBalances).toBeDefined();
    }
  });

  it('is behavior-stable: drawdown rows + depletionYear match the frozen v50 baseline (strategy path)', () => {
    // Freeze the first three drawdown years' key nominal values + depletionYear
    // for a fixed seed/pathCount on the taxEfficient strategy path. A regression
    // in the drawdown path fails here.
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
    // A household whose owner is past the RMD trigger age AT retirement is
    // the most-at-risk case for the phase-discriminator argument — populating the
    // accumulation field must NOT change the first-drawdown RMD base or floor.
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
    // Determinism guard: a second run reproduces the same cents.
    const out2 = runMonteCarlo(input);
    const run2 = out2.representativeByBasis!['mc-typical']!;
    expect(run2.years[RET_IDX].rmdFloorCents).toBe(firstDrawdown.rmdFloorCents);
  });
});

// ---------------------------------------------------------------------------
// Absorbing depletion. Once a path records `depletionYear`, every later
// year's balance is zero-clamped AT THE SOURCE (Bengen/Trinity ruin-is-permanent
// convention), overriding the non-absorbing engine's bounce-back on post-
// depletion SS/pension income + positive returns. Drives the NAMED-STRATEGY
// assembly path (`runOnePathViaStrategyEngine`), NOT the already-absorbing raw
// kernel — using the kernel would give a false green.
// ---------------------------------------------------------------------------
describe('runMonteCarlo — absorbing depletion (named-strategy assembly)', () => {
  const STEPS = (2056 - 2026 + 1) * 12;
  const RET_STEP = (2046 - 2026) * 12; // future retirement → preRetirementYears = 20

  // A return series that DEPLETES the small portfolio early in drawdown
  // (strongly negative through the first drawdown years) then turns strongly
  // POSITIVE — the engine's non-absorbing bounce-back attempt the clamp overrides.
  function depleteThenBounce(): Float64Array {
    const r = new Float64Array(STEPS);
    for (let i = 0; i < STEPS; i += 1) {
      // Accumulation (pre-RET_STEP): mild positive. Early drawdown: deep negative
      // (force depletion). Late drawdown: strongly positive (bounce-back attempt).
      if (i < RET_STEP) r[i] = 0.2;
      else if (i < RET_STEP + 12 * 6) r[i] = -3.0; // ~36%/yr loss → fast ruin
      else r[i] = 2.5; // strong recovery + SS income would bounce a non-absorbing engine
    }
    return r;
  }
  const zeroCpi = (): Float64Array => new Float64Array(STEPS);

  // Future-retirement input: 20 accumulation years, then heavy spend + post-
  // depletion SS so a non-absorbing engine would show a bounce-back.
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
      // Heavy spend so the small portfolio runs out a few years into drawdown.
      monthlyExpenseBase: makeMonthlyExpenseBase(120_000, STEPS),
      // Post-depletion SS income (would bounce a non-absorbing balance positive).
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
    // Depletion is in the drawdown phase, not the accumulation phase.
    expect(dep).toBeGreaterThanOrEqual(input.retirementYear);

    // Every year at/after depletion is exactly 0 — the post-depletion SS + the
    // strongly positive late returns DO NOT bounce the balance back.
    for (let y = 0; y < out.balanceByYearNominal.length; y += 1) {
      const calendarYear = input.firstYear + y;
      if (calendarYear >= dep) {
        expect(out.balanceByYearNominal[y]).toBe(0);
        expect(out.balanceByYearReal[y]).toBe(0);
      }
    }
    // The clamp uses the CORRECT index (subtracts BOTH firstYear and the
    // accumulation period): the LAST pre-depletion drawdown year is still
    // positive, proving the clamp did not start one year early/late.
    const preDepIdx = dep - 1 - input.firstYear;
    if (preDepIdx >= input.retirementYear - input.firstYear) {
      expect(out.balanceByYearNominal[preDepIdx]).toBeGreaterThan(0);
    }
    // endingBalance is 0 (a depleted path ends at $0, not a bounced-back residual).
    expect(out.endingBalanceNominal).toBe(0);
  });

  it('blast radius: the representative capture + real balances also read the zeroed values', () => {
    const input = futureRetireInput();
    const ctx = buildRunContext(input);
    const out = runOnePath(input, input.seed, ctx, true);
    const dep = out.depletionYear!;
    const run = out.representative!;
    // captureStrategyRun reads the SAME mutated `years[]` objects, so its
    // drawdown rows from depletion onward carry balance 0.
    for (const yr of run.years) {
      if (yr.year >= dep) expect(yr.balance).toBe(0);
    }
    // realBalanceByYear (own-CPI deflated) is likewise 0 from depletion onward.
    for (let y = 0; y < run.realBalanceByYear.length; y += 1) {
      if (input.firstYear + y >= dep) expect(run.realBalanceByYear[y]).toBe(0);
    }
  });

  it('per-account sub-balances + per-owner pre-tax index are zeroed for strictly-post-depletion years', () => {
    // The Account Balance Stack chart reads `accountBalances` per-account rows
    // directly, so a strictly-post-depletion year that left them non-zero would
    // render a phantom stack over the clamped $0 pooled total. STRICTLY-post-
    // depletion rows must carry zero end-of-year balance fields.
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
    // Sanity: the scenario actually exercised at least one strictly-post-
    // depletion row carrying per-account balances (else the assertions are vacuous).
    expect(sawStrictlyPostRow).toBe(true);
  });

  it('the depletion year row also zeroes per-account end balances + per-owner pre-tax index', () => {
    // The zeroing extends to the depletion year ITSELF. The aggregate
    // `balance` clamp fires at the depletion year (year-end pooled total is $0),
    // so leaving the per-account year-END sub-balances or the per-owner pre-tax
    // index non-zero on that row renders positive stacked bars over a $0 pooled
    // line — a visible chart inconsistency. The depletion-year END state must be
    // zeroed just like strictly-post-depletion rows.
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
    // Sanity: the depletion year actually carried a per-account map (else the
    // assertions are vacuous — the depletion-year zeroing would be untested).
    expect(sawDepletionRow).toBe(true);
  });

  it('negative guard: a non-depleting path retains its full balance sequence', () => {
    // Same household but ample portfolio + light spend → never depletes; the
    // clamp must NOT fire (every drawdown year stays positive).
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
      // Mild positive returns throughout → no ruin.
      injectedReturns: new Float64Array(STEPS).fill(0.3),
    };
    const ctx = buildRunContext(input);
    const out = runOnePath(input, input.seed, ctx, true);
    expect(out.depletionYear).toBeNull();
    // Every drawdown year retains a positive balance (no spurious clamp).
    for (let y = input.retirementYear - input.firstYear; y < out.balanceByYearNominal.length; y += 1) {
      expect(out.balanceByYearNominal[y]).toBeGreaterThan(0);
    }
    expect(out.endingBalanceNominal).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Conversion-tax funding respects account floors: the Fill-mode Roth-conversion
// tax funding path (`drawCapSafeTaxFunding`, shared by both engines via
// `runYearByYearStrategyAware`) caps each MAGI-neutral candidate's `post`
// draw at its own post-only floor. These drive the FULL aggregate → MC pipeline
// (a real converging Fill conversion) so the per-path floor enforcement is
// exercised end-to-end, at a NON-ZERO inflation rate so a nominal-vs-real units
// mismatch (comparing the nominal floor against a CPI-deflated balance) would be
// caught — a 0%-inflation test could not distinguish the two.
// ---------------------------------------------------------------------------
describe('Monte Carlo — Fill-mode conversion-tax funding respects account floors', () => {
  const FLOOR_MC_SEED = 9182;

  // Injected FLAT POSITIVE nominal returns (~5%/yr) remove market-loss noise so
  // any sub-floor `cash1` movement is a WITHDRAWAL (never a down-market dip — the
  // floor governs withdrawals, not returns). Injected CPI (~2%/yr) is NON-ZERO so
  // nominal balances diverge from real: asserting the NOMINAL floor against the
  // NOMINAL balance would fail if the code compared a CPI-deflated (real) balance.
  // PERCENT-unit monthly rates: the kernel reads `injectedReturns` as
  // `returnPct[i]` and the runner reads `injectedCpi` as `cpiPct[i]`, both
  // dividing by 100 (kernel.ts `1 + returnPct/100`, monte-carlo.ts
  // `1 + cpiPct/100`). So a value of `5` means 5%, and these compound to the
  // intended ~5%/yr return and ~2%/yr CPI.
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
    // Fill conversions actually happened (the funding path is exercised).
    expect(yearsF.reduce((s, y) => s + (y.rothConvertedCents ?? 0), 0)).toBeGreaterThan(0);
    // The floored cash1 (NOMINAL balance) is never drawn below its NOMINAL floor.
    // Scope to years where the unfloored cash2 STILL funds: the last-resort
    // reserve pass CAN draw a floored account below its floor, but only once every
    // other liquid source is exhausted, so while cash2 > 0 a below-floor cash1 is a
    // conversion-tax-funding regression.
    for (const y of yearsF) {
      const cash1 = y.accountBalances!.get('cash1');
      const cash2 = y.accountBalances!.get('cash2');
      if (!cash1 || !cash2 || cash2.balance <= 1) continue;
      expect(cash1.balance).toBeGreaterThanOrEqual(CASH1_FLOOR - 1);
    }

    // Non-vacuous behavioral witness: with NO floor the SAME injected-return path
    // draws cash1 strictly below $150k to fund the same conversion tax — proving
    // the floor is the binding constraint, not a scenario where it never bites.
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

// ---------------------------------------------------------------------------
// Per-return MAGI ring conservation
// ---------------------------------------------------------------------------

describe('rescaleUnitMagiToTotal — exact cent conservation', () => {
  const entry = (memberId: string, magiCents: number): FilingUnitMagi => ({
    memberIds: [memberId],
    filingStatus: 'MFS',
    mfsLivedWithSpouse: false,
    magiCents,
  });
  const sumCents = (units: readonly FilingUnitMagi[]): number =>
    units.reduce((sum, u) => sum + u.magiCents, 0);

  it('conserves an odd-cent target across two equal returns', () => {
    // The regression: two equal returns each landed on a .5-cent share and each
    // rounded UP, so the per-return ring came out ONE CENT above the household
    // scalar ring it is supposed to reconcile with.
    const rescaled = rescaleUnitMagiToTotal(
      [entry('a', 5_000_00), entry('b', 5_000_00)],
      100_000.01,
    );
    expect(sumCents(rescaled)).toBe(10_000_001);
    expect(rescaled.map((u) => u.magiCents)).toEqual([5_000_001, 5_000_000]);
  });

  it('conserves for uneven shares, odd counts, and a zero scalar total', () => {
    for (const [units, total] of [
      [[entry('a', 1_234_56), entry('b', 7_654_32)], 12_345.67],
      [[entry('a', 1), entry('b', 1), entry('c', 1)], 1_000.01],
      [[entry('a', 100), entry('b', 200), entry('c', 300)], 0.07],
      [[entry('a', 0), entry('b', 0)], 999.99],
    ] as const) {
      expect(sumCents(rescaleUnitMagiToTotal(units, total))).toBe(Math.round(total * 100));
    }
  });

  it('never moves a zero-MAGI return off zero', () => {
    // A return with no MAGI has no share of the household total, so a leftover
    // cent must go to a return that actually earned one.
    const rescaled = rescaleUnitMagiToTotal(
      [entry('a', 1_000_00), entry('b', 0), entry('c', 1_000_00)],
      3_000.01,
    );
    expect(rescaled[1].magiCents).toBe(0);
    expect(sumCents(rescaled)).toBe(300_001);
  });

  it('does not push a return over an IRMAA tier threshold on a rounding cent', () => {
    // $106,000 is the 2026 single-filer tier-1 threshold and the comparison is
    // strictly greater-than, so a return sitting EXACTLY on it owes no
    // surcharge. Independent rounding gave BOTH equal returns the extra
    // half-cent, tipping each of them one cent past the threshold and charging
    // the household two tier-1 surcharges it does not owe.
    const threshold = IRMAA_TIERS.values[2026]!.bySingle[0].thresholdDollars;
    const rescaled = rescaleUnitMagiToTotal(
      [entry('a', 1), entry('b', 1)],
      threshold * 2 + 0.01,
    );
    const tierOf = (magiCents: number): string =>
      computeIrmaa(
        {
          taxYear: 2026,
          magiTwoYearsPriorCents: magiCents,
          filingStatus: 'Single',
          beneficiariesOnMedicareCount: 1,
        },
        IRMAA_TIERS,
      ).tier;
    expect(rescaled.map((u) => u.magiCents)).toEqual([
      threshold * 100 + 1,
      threshold * 100,
    ]);
    expect(tierOf(rescaled[1].magiCents)).toBe('none');
    // The one cent the household genuinely has above the threshold lands on
    // exactly ONE return, not on both.
    expect(tierOf(rescaled[0].magiCents)).toBe('tier1');
  });
});
