/** Per-account sampling: one sampled tuple per month is applied to each account's own mix. */
import { describe, expect, it } from 'vitest';
import {
  runMonteCarlo,
  type MonteCarloAccountLedger,
  type MonteCarloInput,
} from './monte-carlo.js';
import { makeMonthlyExpenseBase } from './monte-carlo.test-helpers.js';

const FIRST_YEAR = 2026;
const RETIREMENT_YEAR = 2046;
const HORIZON_YEAR = 2086;
const STEP_COUNT = (HORIZON_YEAR - FIRST_YEAR + 1) * 12;

function zeroSteps(): Float64Array {
  return new Float64Array(STEP_COUNT);
}

function twoAccountLedger(): MonteCarloAccountLedger[] {
  return [
    {
      id: 'equities',
      initialPre: 0,
      initialPost: 300_000,
      contribPre: zeroSteps(),
      contribPost: zeroSteps(),
      deposit: zeroSteps(),
      assetMix: { stocksPct: 90, bondsPct: 5, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
    },
    {
      id: 'bonds',
      initialPre: 200_000,
      initialPost: 0,
      contribPre: zeroSteps(),
      contribPost: zeroSteps(),
      deposit: zeroSteps(),
      assetMix: { stocksPct: 20, bondsPct: 70, cashPct: 10 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
    },
  ];
}

const PA_YEARS = HORIZON_YEAR - FIRST_YEAR + 1;
const PA_SS_BY_YEAR = Array.from({ length: PA_YEARS }, (_, i) =>
  FIRST_YEAR + i >= RETIREMENT_YEAR ? 24_000 : 0,
);
const PA_INCOME_BY_YEAR = new Array<number>(PA_YEARS).fill(0);

function baseInput(ledger: MonteCarloAccountLedger[]): MonteCarloInput {
  return {
    portfolioToday: 500_000,
    accountMcLedger: ledger,
    annualContribution: 0,
    firstYear: FIRST_YEAR,
    retirementYear: RETIREMENT_YEAR,
    horizonYear: HORIZON_YEAR,
    monthlyExpenseBase: makeMonthlyExpenseBase(40_000, STEP_COUNT),
    ssByYear: PA_SS_BY_YEAR,
    incomeByYear: PA_INCOME_BY_YEAR,
    pathCount: 200,
    seed: 4242,
    strategyKind: 'taxEfficient',
  };
}

describe('runMonteCarlo — per-account sampling determinism', () => {
  it('swapping the ledger account order changes nothing (left-fold determinism)', () => {
    // Float addition is not associative, so the reversed order agrees to a tolerance, not bit for bit.
    const inOrder = runMonteCarlo(baseInput(twoAccountLedger()));
    const reversed = runMonteCarlo(
      baseInput([twoAccountLedger()[1], twoAccountLedger()[0]]),
    );
    for (let y = 0; y < inOrder.horizonYears; y += 1) {
      expect(reversed.percentilesNominal.p50[y]).toBeCloseTo(
        inOrder.percentilesNominal.p50[y],
        5,
      );
    }
  });

  it('CBP planning rate ignores sampled returns', () => {
    const buildCbpLedger = (rate: number): MonteCarloAccountLedger[] => [
      {
        id: 'cbp',
        initialPre: 0,
        initialPost: 250_000,
        contribPre: zeroSteps(),
        contribPost: zeroSteps(),
        deposit: zeroSteps(),
        assetMix: null,
        assetMixSeries: null,
        cbpPlanningReturnPct: rate,
      },
    ];
    const flat = runMonteCarlo({
      ...baseInput(buildCbpLedger(0)),
      monthlyExpenseBase: makeMonthlyExpenseBase(0, STEP_COUNT),
      ssByYear: PA_INCOME_BY_YEAR,
    });
    const growing = runMonteCarlo({
      ...baseInput(buildCbpLedger(10)),
      monthlyExpenseBase: makeMonthlyExpenseBase(0, STEP_COUNT),
      ssByYear: PA_INCOME_BY_YEAR,
    });
    for (let y = 0; y < flat.horizonYears; y += 1) {
      expect(flat.percentilesNominal.p50[y]).toBeCloseTo(
        flat.percentilesNominal.p10[y],
        2,
      );
      expect(growing.percentilesNominal.p50[y]).toBeCloseTo(
        growing.percentilesNominal.p10[y],
        2,
      );
    }
    expect(
      growing.percentilesNominal.p50[growing.horizonYears - 1],
    ).toBeGreaterThan(flat.percentilesNominal.p50[flat.horizonYears - 1]);
  });

  it('per-account fan-out preserves the single-account result under same mix', () => {
    // Pre-retirement only, so drawdown's proportional-split clamp cannot perturb the result.
    const oneAccountInput: MonteCarloInput = {
      ...baseInput([
        {
          id: 'one',
          initialPre: 0,
          initialPost: 500_000,
          contribPre: zeroSteps(),
          contribPost: zeroSteps(),
          deposit: zeroSteps(),
          assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
          assetMixSeries: null,
          cbpPlanningReturnPct: null,
        },
      ]),
      retirementYear: HORIZON_YEAR,
      monthlyExpenseBase: makeMonthlyExpenseBase(0, STEP_COUNT),
      ssByYear: PA_INCOME_BY_YEAR,
    };
    const twoAccountInput: MonteCarloInput = {
      ...baseInput([
        {
          id: 'half-a',
          initialPre: 0,
          initialPost: 250_000,
          contribPre: zeroSteps(),
          contribPost: zeroSteps(),
          deposit: zeroSteps(),
          assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
          assetMixSeries: null,
          cbpPlanningReturnPct: null,
        },
        {
          id: 'half-b',
          initialPre: 0,
          initialPost: 250_000,
          contribPre: zeroSteps(),
          contribPost: zeroSteps(),
          deposit: zeroSteps(),
          assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
          assetMixSeries: null,
          cbpPlanningReturnPct: null,
        },
      ]),
      retirementYear: HORIZON_YEAR,
      monthlyExpenseBase: makeMonthlyExpenseBase(0, STEP_COUNT),
      ssByYear: PA_INCOME_BY_YEAR,
    };
    const one = runMonteCarlo(oneAccountInput);
    const two = runMonteCarlo(twoAccountInput);
    for (let y = 0; y < one.horizonYears; y += 1) {
      expect(two.percentilesNominal.p50[y]).toBeCloseTo(
        one.percentilesNominal.p50[y],
        4,
      );
    }
  });
});
