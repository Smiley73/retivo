/**
 * Monte Carlo per-category inflation (medical-cost inflation).
 *
 * Covers:
 *  - the verbatim-scalar parity (absent buckets `toEqual`s the captured
 *    fixture) for a named strategy with and without a tax context;
 *  - the +2pp Medical bucket growing ~2pp/yr faster via the injected-CPI
 *    numeric harness (the SOLE unit guard);
 *  - custom non-cat-medical bucket; same-rate-multi-bucket == single-bucket;
 *    a Medical override changing MC output; bucket-composition (windowed +
 *    discretionary-multiplier); recurring + one-off; non-finite-no-NaN;
 *    percentilesReal real-growth.
 */
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

/** Windowed per-month bucket base from a flat annual amount (lifetime fixture):
 *  the run-rate ÷ 12 across every month. Mirrors `makeMonthlyExpenseBase` but
 *  shapes the per-rate `monthlyExpenseBucketsBase` entry. */
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

// Strip the volatile fields + JSON-roundtrip so the comparison matches the
// captured fixture exactly (the representative runs carry `ReadonlyMap`s that
// `JSON.stringify` renders as `{}` in BOTH the fixture and the live summary —
// the percentile / depletion / success / histogram numbers, the real
// byte-identity guard, survive the roundtrip intact).
function strip(summary: ReturnType<typeof runMonteCarlo>): unknown {
  const clone = JSON.parse(JSON.stringify(summary)) as Record<string, unknown>;
  delete clone.engineVersion;
  delete clone.computedAt;
  return clone;
}

// --- verbatim-scalar parity -----------------------------------------------

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
    // The `namedStrategy` half was re-captured when the representative
    // DISPLAY tax cents began carrying the taxable-income model (yield drag,
    // evolving cost basis, cash interest; the brokerage-account fixture's stamped
    // federal tax moved). The no-tax half is unchanged from its original capture.
    expect(strip(runMonteCarlo(namedTaxInput))).toEqual(mcV34Parity.namedStrategy);
  });

  it('an empty bucket-set is NOT supplied — buckets are absent, never []', () => {
    // The runner emits buckets only when ≥1 effective rate ≠ general; the engine
    // must take the verbatim scalar path when the field is absent. (A direct []
    // would reduce to a zero expense — a wrong path the runner never produces.)
    expect(baseInput.monthlyExpenseBucketsBase).toBeUndefined();
  });
});

// --- injected-CPI numeric spread (the SOLE unit guard) --------------------

const INJ_STEPS = STEPS;
function flat(monthlyPct: number): Float64Array {
  const arr = new Float64Array(INJ_STEPS);
  arr.fill(monthlyPct);
  return arr;
}

// A well-funded injected base whose paths SURVIVE the whole horizon, so the
// terminal ending-balance comparison reads a positive (non-floored-to-0) value.
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

// Deflate the year-END bucketed expense to compare real growth. Under injected
// CPI of 0.25 %/mo (~3 %/yr general) the +2pp bucket should grow ~2 %/yr faster
// than the general bucket in real terms.
describe('Medical cost inflation — injected-CPI numeric spread', () => {
  // Build a per-bucket nominal year-END expense the same way the engine does, to
  // assert the +2pp shift compounds to ~2 %/yr extra. Mirrors buildHouseholdSeries.
  function bucketNominalAtYear(
    amount: number,
    bucketRatePct: number,
    generalRatePct: number,
    cpiPct: Float64Array,
    year: number,
  ): number {
    const extraShiftPct = (bucketRatePct - generalRatePct) / 12;
    const endStep = Math.min(INJ_STEPS - 1, (year + 1) * 12 - 1);
    let cum = 1;
    for (let i = 0; i <= endStep; i += 1) cum *= 1 + (cpiPct[i] + extraShiftPct) / 100;
    return amount * cum;
  }

  it('a +2pp Medical bucket grows ~2pp/yr faster than the general bucket', () => {
    const cpiPct = flat(0.25); // ~3.04 %/yr
    const general = 3;
    const medical = 5; // general + 2pp
    // Compare 20 years out. The shift is an ADDITIVE MONTHLY mean-shift
    // `(5−3)/12 = 0.1667 pp/mo` — so the medical bucket grows ~2 pp/yr
    // faster, landing the relative gap just above `(1.02)^20 ≈ 1.486` (the
    // documented additive-vs-compounded linearization seam nudges it up a few
    // percent). Must NOT be 100× too small (the unit-bug the byte-identical
    // tests can't catch — a `/100` slip would give a gap of ~1.0004).
    const yr = 20;
    const generalNominal = bucketNominalAtYear(1, general, general, cpiPct, yr);
    const medicalNominal = bucketNominalAtYear(1, medical, general, cpiPct, yr);
    const ratio = medicalNominal / generalNominal;
    expect(ratio).toBeGreaterThan(1.019 ** yr); // ~1.456 — clearly ~2pp faster
    expect(ratio).toBeLessThan(1.022 ** yr); // ~1.544 — bounded by the seam
  });

  // ENGINE-anchored guard. The check above re-implements the shift
  // formula locally and never calls the engine, so a `/100` or magnitude slip
  // in `buildHouseholdSeries` (`extraShiftPct = (b.ratePct − generalRatePct)/12`,
  // applied as `(cpiPct[i] + extraShiftPct)/100`) would not fail it. Drive the
  // engine directly: a +2pp Medical bucket vs an equal-dollar all-general single
  // bucket, read the ENGINE-PRODUCED year-N nominal expense draw, and assert the
  // medical-vs-general ratio lands in the expected ~(1.02)^N band — tight enough
  // that a 100×-too-small or 2×-off shift fails.
  it('the ENGINE-produced year-N nominal expense draw grows ~2pp/yr faster for a +2pp Medical bucket', () => {
    // Zero SS + zero non-SS income so the per-year drawdown (`years[].withdrawn`)
    // IS the engine's nominal expense draw — the signal the bucket shift moves.
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
    // `netNeed = max(0, expense − income)` with zero income IS the engine's
    // year-N nominal expense draw (the bucketed sum across the per-rate buckets,
    // grown by each bucket's effective rate). Year offset 40 (calendar 2066) is
    // 20 full drawdown years past retirement (RET offset 20), so the +2pp shift
    // has compounded ~20 years' worth.
    const n = RET - FIRST + 20; // calendar offset 40 (year 2066), 20 drawdown years in
    const gExpense = gRun.years[n].netNeed;
    const mExpense = mRun.years[n].netNeed;
    expect(gExpense).toBeGreaterThan(0);
    expect(mExpense).toBeGreaterThan(0);
    const ratio = mExpense / gExpense;
    // The per-bucket cumulative shift compounds from step 0 (firstYear), so at
    // year offset 40 (endStep = 491, i.e. 492 months) the +2pp additive MONTHLY
    // mean-shift accumulates to a medical-vs-general ratio of
    //   ((1 + (0.25 + (5−3)/12)/100) / (1 + 0.25/100))^492 ≈ 2.264.
    // A `/100` unit slip would make the shift ~100× too small → ratio ≈ 1.0007
    // (fails the lower bound); a 2×-too-big (~4pp) shift → ratio ≈ 5.1 (fails the
    // upper bound). The band is tight around the analytic ~2.26.
    expect(ratio).toBeGreaterThan(2.15);
    expect(ratio).toBeLessThan(2.40);
  });

  it('a Medical bucket lifts the path expense DRAW over a flat-general scenario', () => {
    const general = survivableInjected;
    const withMedical: MonteCarloInput = {
      ...general,
      monthlyExpenseBucketsBase: [
        bucket(3, 50_000),
        bucket(5, 30_000), // +2pp medical
      ],
    };
    // Faster medical inflation → higher nominal spend → lower P50 ending balance.
    const a = runMonteCarlo(general);
    const b = runMonteCarlo(withMedical);
    expect(a.percentilesNominal.p50.at(-1)!).toBeGreaterThan(0);
    expect(b.percentilesNominal.p50.at(-1)!).toBeLessThan(
      a.percentilesNominal.p50.at(-1)!,
    );
  });
});

// --- bucket equivalences + composition ------------------------------------

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
    // Two same-rate buckets carry the SAME effective rate as one merged bucket;
    // the only difference is fp-add association of the per-bucket monthly slices
    // (`30k/12·c + 50k/12·c` vs `80k/12·c`), so the distribution is identical to
    // sub-cent tolerance — the additive shift adds NO extra variance.
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
    // ratePct === scenarioInflationPct → extraShift 0 → byte-identical to scalar.
    expect(oneBucket.percentilesNominal.p50).toEqual(scalar.percentilesNominal.p50);
  });
});

// --- defensive: non-finite cannot reach successProbability ----------------

describe('Medical cost inflation — defensive non-finite guard', () => {
  it('finite buckets never produce a NaN successProbability', () => {
    // The runner builds buckets from the sanitised finite map, so every
    // bucket rate is finite by construction (a non-finite rate is unreachable in
    // production — `computeExpenseScalar` throws at construction if one appears).
    // A faster-inflating finite bucket must never leak a NaN into the success
    // number via the per-bucket cumulative-CPI math.
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

// --- named-strategy draw → classification shift ---------------------------

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
    // Same dollars, but split into a faster-inflating Medical bucket. The
    // bucketed expense DRAW drives the per-account withdrawal classification →
    // MAGI → tax, so the success/percentile numbers move vs the all-general run.
    const general = runMonteCarlo(namedTaxInput());
    const medical = runMonteCarlo(
      namedTaxInput({
        monthlyExpenseBucketsBase: [
          bucket(3, 50_000),
          bucket(5, 30_000),
        ],
      }),
    );
    // Faster medical inflation → larger draws → strictly worse (or equal-at-1)
    // success; the percentile fan must differ.
    expect(medical.percentilesNominal.p50).not.toEqual(general.percentilesNominal.p50);
    expect(medical.successProbability).toBeLessThanOrEqual(general.successProbability);
  });
});

// --- percentilesReal real growth (no double-strip) ------------------------

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
    // Real (CPI-deflated) ending balance is lower with the faster-inflating
    // bucket — the real spend rose by the +2pp spread despite the deflator
    // (the bucket nominal is deflated by the GENERAL cumCpi, not its own, so
    // the +2pp residual survives — no double-strip).
    expect(general.percentilesReal.p50.at(-1)!).toBeGreaterThan(0);
    expect(medical.percentilesReal.p50.at(-1)!).toBeLessThan(
      general.percentilesReal.p50.at(-1)!,
    );
  });
});
