/**
 * Deterministic-mode harness for MC — when `injectedReturns` and
 * `injectedCpi` are supplied, the kernel skips historical sampling
 * and uses the caller-provided per-month series instead. The cross-engine
 * pin tests depend on this contract.
 */
import { describe, expect, it } from 'vitest';
import {
  runMonteCarlo,
  type MonteCarloAccountLedger,
  type MonteCarloInput,
} from './monte-carlo.js';
import { makeMonthlyExpenseBase } from './monte-carlo.test-helpers.js';

const BASE_STEPS = (2086 - 2026 + 1) * 12;
const BASE_RETIREMENT_STEP = (2046 - 2026) * 12;

function buildLedger(): MonteCarloAccountLedger[] {
  const contribPre = new Float64Array(BASE_STEPS);
  const monthlyPre = 20_000 / 12;
  for (let i = 0; i < BASE_RETIREMENT_STEP; i += 1) contribPre[i] = monthlyPre;
  return [
    {
      id: 'main',
      initialPre: 500_000,
      initialPost: 0,
      contribPre,
      contribPost: new Float64Array(BASE_STEPS),
      deposit: new Float64Array(BASE_STEPS),
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
    },
  ];
}

// Build nominal year arrays for SS + other income.
const INJ_YEARS = 2086 - 2026 + 1; // 61
const INJ_SS_BY_YEAR = Array.from({ length: INJ_YEARS }, (_, i) =>
  i >= 2046 - 2026 ? 30_000 : 0,
);
const INJ_INCOME_BY_YEAR = new Array<number>(INJ_YEARS).fill(0);

const baseInput: MonteCarloInput = {
  portfolioToday: 500_000,
  accountMcLedger: buildLedger(),
  annualContribution: 20_000,
  firstYear: 2026,
  retirementYear: 2046,
  horizonYear: 2086,
  monthlyExpenseBase: makeMonthlyExpenseBase(80_000, BASE_STEPS),
  ssByYear: INJ_SS_BY_YEAR,
  incomeByYear: INJ_INCOME_BY_YEAR,
  pathCount: 50,
  seed: 12345,
  strategyKind: 'taxEfficient',
};

const stepCount =
  (baseInput.horizonYear - baseInput.firstYear + 1) * 12;

function flatReturns(monthlyPct: number): Float64Array {
  const arr = new Float64Array(stepCount);
  arr.fill(monthlyPct);
  return arr;
}

describe('runMonteCarlo — injected-returns mode', () => {
  it('every path produces the same balance series when injected arrays are supplied', () => {
    // Flat 0.5 %/mo return + 0.2 %/mo CPI — exact deterministic.
    const injectedReturns = flatReturns(0.5);
    const injectedCpi = flatReturns(0.2);
    const out = runMonteCarlo({
      ...baseInput,
      injectedReturns,
      injectedCpi,
      pathCount: 20,
    });
    // Determinism collapses the fan: every percentile band coincides.
    for (let y = 0; y < out.horizonYears; y += 1) {
      expect(out.percentilesNominal.p50[y]).toBeCloseTo(
        out.percentilesNominal.p10[y],
        6,
      );
      expect(out.percentilesNominal.p25[y]).toBeCloseTo(
        out.percentilesNominal.p10[y],
        6,
      );
    }
  });

  it('two runs with identical injected arrays return bit-identical percentiles', () => {
    const injectedReturns = flatReturns(0.4);
    const injectedCpi = flatReturns(0.15);
    const a = runMonteCarlo({
      ...baseInput,
      injectedReturns,
      injectedCpi,
      seed: 1,
    });
    const b = runMonteCarlo({
      ...baseInput,
      injectedReturns,
      injectedCpi,
      seed: 2, // seed irrelevant under injection
    });
    expect(a.percentilesNominal.p50).toEqual(b.percentilesNominal.p50);
    expect(a.percentilesReal.p10).toEqual(b.percentilesReal.p10);
    expect(a.successProbability).toBe(b.successProbability);
  });

  it('throws when only one of injectedReturns / injectedCpi is supplied', () => {
    expect(() =>
      runMonteCarlo({
        ...baseInput,
        injectedReturns: flatReturns(0.5),
      }),
    ).toThrow(/injectedReturns and injectedCpi/);
    expect(() =>
      runMonteCarlo({
        ...baseInput,
        injectedCpi: flatReturns(0.2),
      }),
    ).toThrow(/injectedReturns and injectedCpi/);
  });

  it('throws when an injected array length does not equal stepCount', () => {
    const tooShort = new Float64Array(stepCount - 1);
    const okSized = flatReturns(0.2);
    expect(() =>
      runMonteCarlo({
        ...baseInput,
        injectedReturns: tooShort,
        injectedCpi: okSized,
      }),
    ).toThrow(/length/);
  });
});
