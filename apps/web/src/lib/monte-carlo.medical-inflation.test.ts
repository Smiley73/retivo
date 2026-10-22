/** Per-category (medical) inflation buckets in the MC engine: verbatim-scalar parity fixtures and the injected-CPI spread. */
import { describe, expect, it } from 'vitest';
import {
  runMonteCarlo,
  type MonteCarloAccountLedger,
  type MonteCarloInput,
} from './monte-carlo.js';
import { OPTIMIZER_MC_SEED } from './balance-projection-runner-mc.js';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from './tax-integration.js';
import { makeMonthlyExpenseBase } from './monte-carlo.test-helpers.js';
import mcV34Parity from './__fixtures__/mc-v34-parity-summary.json';

const FIRST = 2026;
const RET = 2046;
const HORIZON = 2086;
const STEPS = (HORIZON - FIRST + 1) * 12;

function bucket(ratePct: number, annualAmount: number): { ratePct: number; amount: number[] } {
  return { ratePct, amount: makeMonthlyExpenseBase(annualAmount, STEPS) };
}
const RET_STEP = (RET - FIRST) * 12;
const YEARS = HORIZON - FIRST + 1;

function buildLedger(): MonteCarloAccountLedger[] {
  const contribPostPrimary = new Float64Array(STEPS);
  const contribPreSecondary = new Float64Array(STEPS);
  for (let i = 0; i < RET_STEP; i += 1) {
    contribPostPrimary[i] = (20_000 * 0.6) / 12;
    contribPreSecondary[i] = (20_000 * 0.4) / 12;
  }
  return [
    {
      id: 'acct-primary',
      initialPre: 0,
      initialPost: 300_000,
      contribPre: new Float64Array(STEPS),
      contribPost: contribPostPrimary,
      deposit: new Float64Array(STEPS),
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
      taxTreatment: 'POST_TAX',
      accountType: 'BROKERAGE',
    },
    {
      id: 'acct-secondary',
      initialPre: 200_000,
      initialPost: 0,
      contribPre: contribPreSecondary,
      contribPost: new Float64Array(STEPS),
      deposit: new Float64Array(STEPS),
      assetMix: { stocksPct: 40, bondsPct: 55, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
      taxTreatment: 'PRE_TAX',
      accountType: 'RETIREMENT_IRA',
    },
  ];
}

function yearArrays(annualSs: number, annualOther: number): {
  ssByYear: number[];
  incomeByYear: number[];
} {
  return {
    ssByYear: Array.from({ length: YEARS }, (_, i) => (FIRST + i >= RET ? annualSs : 0)),
    incomeByYear: Array.from({ length: YEARS }, () => annualOther),
  };
}

const baseInput: MonteCarloInput = {
  portfolioToday: 500_000,
  accountMcLedger: buildLedger(),
  annualContribution: 20_000,
  firstYear: FIRST,
  retirementYear: RET,
  horizonYear: HORIZON,
  monthlyExpenseBase: makeMonthlyExpenseBase(80_000, STEPS),
  ...yearArrays(30_000, 0),
  scenarioInflationPct: 3,
  pathCount: 1000,
  seed: OPTIMIZER_MC_SEED,
  strategyKind: 'taxEfficient',
};

// ReadonlyMaps stringify to {} in both the fixture and the live summary; the percentile, depletion and success numbers survive the roundtrip.
function strip(summary: ReturnType<typeof runMonteCarlo>): unknown {
  const clone = JSON.parse(JSON.stringify(summary)) as Record<string, unknown>;
  delete clone.engineVersion;
  delete clone.computedAt;
  return clone;
}

const namedTaxInput: MonteCarloInput = {
  ...baseInput,
  strategyKind: 'taxEfficient',
  taxContext: {
    taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus: 'MFJ',
    members: [
      { memberId: 'm-primary', isoBirthdate: '1971-06-15', onMedicare: false, hasAcaCoverage: false },
      { memberId: 'm-secondary', isoBirthdate: '1973-04-10', onMedicare: false, hasAcaCoverage: false },
    ],
    householdSize: 2,
    inflationRatePct: 3,
    primaryDeathYear: 2056,
    secondaryDeathYear: 2058,
  },
};

describe('Medical cost inflation — v34 verbatim-scalar parity', () => {
  it('a named strategy with no buckets / no tax context toEquals the captured fixture', () => {
    expect(strip(runMonteCarlo(baseInput))).toEqual(mcV34Parity.namedStrategyNoTax);
  });

  it('a named/tax strategy with no buckets toEquals the captured fixture', () => {
    expect(strip(runMonteCarlo(namedTaxInput))).toEqual(mcV34Parity.namedStrategy);
  });
});

const INJ_STEPS = STEPS;
function flat(monthlyPct: number): Float64Array {
  const arr = new Float64Array(INJ_STEPS);
  arr.fill(monthlyPct);
  return arr;
}

// Paths survive the whole horizon, so the ending balance is positive rather than floored to 0.
function survivableLedger(): MonteCarloAccountLedger[] {
  const contribPost = new Float64Array(STEPS);
  for (let i = 0; i < RET_STEP; i += 1) contribPost[i] = 20_000 / 12;
  return [
    {
      id: 'main',
      initialPre: 0,
      initialPost: 5_000_000,
      contribPre: new Float64Array(STEPS),
      contribPost,
      deposit: new Float64Array(STEPS),
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
      taxTreatment: 'POST_TAX',
      accountType: 'BROKERAGE',
    },
  ];
}

const survivableInjected: MonteCarloInput = {
  ...baseInput,
  portfolioToday: 5_000_000,
  accountMcLedger: survivableLedger(),
  monthlyExpenseBase: makeMonthlyExpenseBase(80_000, STEPS),
  pathCount: 5,
  injectedReturns: flat(0.5),
  injectedCpi: flat(0.25),
};

describe('Medical cost inflation — injected-CPI numeric spread', () => {
  it('the ENGINE-produced year-N nominal expense draw grows ~2pp/yr faster for a +2pp Medical bucket', () => {
    // Zero SS and income, so `withdrawn` is the engine's nominal expense draw.
    const noIncome: MonteCarloInput = {
      ...survivableInjected,
      pathCount: 1,
      ssByYear: Array.from({ length: YEARS }, () => 0),
      incomeByYear: Array.from({ length: YEARS }, () => 0),
    };
    const general = runMonteCarlo({
      ...noIncome,
      monthlyExpenseBucketsBase: [bucket(3, 80_000)],
    });
    const medical = runMonteCarlo({
      ...noIncome,
      monthlyExpenseBucketsBase: [bucket(5, 80_000)], // +2pp, SAME dollars
    });
    const gRun = general.representativeByBasis!['mc-typical']!;
    const mRun = medical.representativeByBasis!['mc-typical']!;
    // netNeed is the nominal expense draw; year offset 40 is 20 drawdown years past retirement.
    const n = RET - FIRST + 20; // calendar offset 40 (year 2066), 20 drawdown years in
    const gExpense = gRun.years[n].netNeed;
    const mExpense = mRun.years[n].netNeed;
    expect(gExpense).toBeGreaterThan(0);
    expect(mExpense).toBeGreaterThan(0);
    const ratio = mExpense / gExpense;
    // Analytic ratio ((1 + (0.25 + (5-3)/12)/100) / (1 + 0.25/100))^492 ≈ 2.264; a /100 unit slip gives ≈ 1.0007 and a 2x shift ≈ 5.1.
    expect(ratio).toBeGreaterThan(2.15);
    expect(ratio).toBeLessThan(2.40);
  });
});

describe('Medical cost inflation — bucket equivalences', () => {
  const inj = survivableInjected;

  it('same-rate multi-bucket == single-bucket (additive shift, not extra variance)', () => {
    const single = runMonteCarlo({
      ...inj,
      monthlyExpenseBucketsBase: [bucket(5, 80_000)],
    });
    const multi = runMonteCarlo({
      ...inj,
      monthlyExpenseBucketsBase: [
        bucket(5, 30_000),
        bucket(5, 50_000),
      ],
    });
    // Two same-rate buckets differ from one merged bucket only by fp-add association.
    for (let y = 0; y < single.percentilesNominal.p50.length; y += 1) {
      expect(multi.percentilesNominal.p50[y]).toBeCloseTo(
        single.percentilesNominal.p50[y],
        4,
      );
      expect(multi.percentilesReal.p50[y]).toBeCloseTo(
        single.percentilesReal.p50[y],
        4,
      );
    }
  });

  it('a custom non-cat-medical bucket above general grows faster (category-id-agnostic)', () => {
    const atGeneral = runMonteCarlo({
      ...inj,
      monthlyExpenseBucketsBase: [bucket(3, 80_000)],
    });
    const customElevated = runMonteCarlo({
      ...inj,
      monthlyExpenseBucketsBase: [bucket(6, 80_000)],
    });
    expect(atGeneral.percentilesNominal.p50.at(-1)!).toBeGreaterThan(0);
    expect(customElevated.percentilesNominal.p50.at(-1)!).toBeLessThan(
      atGeneral.percentilesNominal.p50.at(-1)!,
    );
  });

  it('a single all-general bucket reproduces the scalar path (byte-identical)', () => {
    const scalar = runMonteCarlo(inj);
    const oneBucket = runMonteCarlo({
      ...inj,
      monthlyExpenseBucketsBase: [bucket(3, 80_000)],
    });
    // A rate equal to scenario inflation gives zero extra shift.
    expect(oneBucket.percentilesNominal.p50).toEqual(scalar.percentilesNominal.p50);
  });
});

describe('Medical cost inflation — defensive non-finite guard', () => {
  it('finite buckets never produce a NaN successProbability', () => {
    // A faster finite bucket must not leak NaN through the per-bucket cumulative-CPI math.
    const out = runMonteCarlo({
      ...survivableInjected,
      monthlyExpenseBucketsBase: [
        bucket(3, 60_000),
        bucket(5, 20_000),
      ],
    });
    expect(Number.isNaN(out.successProbability)).toBe(false);
    expect(out.successProbability).toBeGreaterThanOrEqual(0);
    expect(out.successProbability).toBeLessThanOrEqual(1);
  });
});

describe('Medical cost inflation — named-strategy bucketed draw', () => {
  function namedTaxInput(extra?: Partial<MonteCarloInput>): MonteCarloInput {
    return {
      ...baseInput,
      pathCount: 200,
      strategyKind: 'taxEfficient',
      taxContext: {
        taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
        filingStatus: 'MFJ',
        members: [
          { memberId: 'm-primary', isoBirthdate: '1971-06-15', onMedicare: false, hasAcaCoverage: false },
          { memberId: 'm-secondary', isoBirthdate: '1973-04-10', onMedicare: false, hasAcaCoverage: false },
        ],
        householdSize: 2,
        inflationRatePct: 3,
        primaryDeathYear: 2056,
        secondaryDeathYear: 2058,
      },
      ...extra,
    };
  }

  it('a +2pp Medical bucket shifts the named-strategy MC outcome (draw → classification → tax)', () => {
    const general = runMonteCarlo(namedTaxInput());
    const medical = runMonteCarlo(
      namedTaxInput({
        monthlyExpenseBucketsBase: [
          bucket(3, 50_000),
          bucket(5, 30_000),
        ],
      }),
    );
    expect(medical.percentilesNominal.p50).not.toEqual(general.percentilesNominal.p50);
    expect(medical.successProbability).toBeLessThanOrEqual(general.successProbability);
  });
});

describe('Medical cost inflation — percentilesReal coherence', () => {
  it('the bucket nominal expense deflated by the general CPI still rises by ~spread', () => {
    const general = runMonteCarlo({
      ...survivableInjected,
      monthlyExpenseBucketsBase: [bucket(3, 80_000)],
    });
    const medical = runMonteCarlo({
      ...survivableInjected,
      monthlyExpenseBucketsBase: [bucket(5, 80_000)],
    });
    // The bucket nominal is deflated by the general cumCpi, not its own, so the +2pp residual survives (no double strip).
    expect(general.percentilesReal.p50.at(-1)!).toBeGreaterThan(0);
    expect(medical.percentilesReal.p50.at(-1)!).toBeLessThan(
      general.percentilesReal.p50.at(-1)!,
    );
  });
});
