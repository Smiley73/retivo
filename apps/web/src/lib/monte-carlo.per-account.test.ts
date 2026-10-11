/**
 * Per-account MC sampling — determinism contract.
 *
 * Pins the per-account sampling rule:
 *   - One historical `(stocks, bonds, cash, cpi)` tuple sampled per
 *     simulated month per path (the same number of RNG draws as a
 *     single-pool engine).
 *   - That same tuple is applied to each account's own `assetMix` to
 *     produce N parallel monthly return series.
 *   - Two runs with the same seed + same per-account ledger return
 *     bit-identical percentiles + `successProbability`.
 *   - Two accounts with the SAME mix produce a percentile series
 *     numerically equal to one consolidated account with that mix —
 *     proves the per-account fan-out doesn't change RNG semantics.
 *
 * A household-blended mix would give different percentile arrays; the
 * per-account-mix shift is part of the intended numerical result.
 */
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

/** Two-account ledger: equities-heavy brokerage + bonds-heavy IRA. */
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
// SS starts at retirement (FIRST_YEAR + (RETIREMENT_YEAR - FIRST_YEAR) offset).
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
  it('two runs with identical seed + ledger produce bit-identical percentile arrays', () => {
    const ledgerA = twoAccountLedger();
    const ledgerB = twoAccountLedger();
    const a = runMonteCarlo(baseInput(ledgerA));
    const b = runMonteCarlo(baseInput(ledgerB));
    expect(a.percentilesNominal.p10).toEqual(b.percentilesNominal.p10);
    expect(a.percentilesNominal.p25).toEqual(b.percentilesNominal.p25);
    expect(a.percentilesNominal.p50).toEqual(b.percentilesNominal.p50);
    expect(a.percentilesReal.p50).toEqual(b.percentilesReal.p50);
    expect(a.successProbability).toBe(b.successProbability);
    expect(a.medianEndingBalanceNominal).toBe(b.medianEndingBalanceNominal);
  });

  it('swapping the ledger account order changes nothing (left-fold determinism)', () => {
    // The kernel sums per-account end-balances via a deterministic
    // left-fold by account index. Swapping the order is a kind of
    // determinism stress test — float addition isn't associative, so a
    // bit-identical assertion would over-pin (sum order matters); a
    // tight numerical agreement is the right contract.
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
    // Two ledgers: (1) a single CBP at planningReturnPct = 0; (2) the
    // same ledger with planningReturnPct = 10. The fan-chart spread for
    // the CBP-only ledger must be ZERO (no sampling variance) and the
    // p50 trajectory must differ between the two rates. Pins the
    // "CBP rate is deterministic across MC paths" invariant.
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
    // Fan collapses: every percentile coincides at every year for both.
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
    // Higher rate → bigger ending balance.
    expect(
      growing.percentilesNominal.p50[growing.horizonYears - 1],
    ).toBeGreaterThan(flat.percentilesNominal.p50[flat.horizonYears - 1]);
  });

  it('per-account fan-out preserves the single-account result under same mix', () => {
    // Pin: ONE account with 500k @ 70/25/5 should produce the same
    // percentile arrays as TWO accounts with 250k each @ 70/25/5 — both
    // share the same household mix, just split. Per-account drawdown
    // applies the SAME sampled tuple to each account's mix, then sums
    // — equivalent to summing the inputs first. Both runs are
    // pre-retirement-only (`retirementYear = horizonYear`) so drawdown
    // doesn't enter and the proportional-split clamp can't perturb
    // results.
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
      // Float-addition order differs (1× vs 2× per-account end-balance
      // adds per step), so use a tight numerical tolerance rather than
      // bit-identical equality.
      expect(two.percentilesNominal.p50[y]).toBeCloseTo(
        one.percentilesNominal.p50[y],
        4,
      );
    }
  });
});
