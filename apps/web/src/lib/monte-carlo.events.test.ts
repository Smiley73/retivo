/**
 * Dated portfolio-addition events in the MC kernel — proves the event
 * lands in its event month and shifts later balances upward by the
 * deposited amount (plus the residual growth on it).
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

// Single-account fixture: a 70/25/5 brokerage account holding the full
// 500k portfolio. Keeps the events tests focused on event routing —
// per-account dimension is exercised more rigorously in monte-carlo.test.ts.
function buildSingleLedger(args: {
  portfolio: number;
  annualPlannedContribution: number;
}): MonteCarloAccountLedger[] {
  const contribPre = new Float64Array(BASE_STEPS);
  const monthlyPre = args.annualPlannedContribution / 12;
  for (let i = 0; i < BASE_RETIREMENT_STEP; i += 1) contribPre[i] = monthlyPre;
  return [
    {
      id: 'main',
      initialPre: args.portfolio,
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

// Build nominal year arrays for SS + other income (no CPI scaling in MC).
const BASE_YEARS = 2086 - 2026 + 1; // 61
const BASE_SS_BY_YEAR = Array.from({ length: BASE_YEARS }, (_, i) =>
  i >= 2046 - 2026 ? 30_000 : 0,
);
const BASE_INCOME_BY_YEAR = new Array<number>(BASE_YEARS).fill(0);

const baseInput: MonteCarloInput = {
  portfolioToday: 500_000,
  accountMcLedger: buildSingleLedger({
    portfolio: 500_000,
    annualPlannedContribution: 20_000,
  }),
  annualContribution: 20_000,
  firstYear: 2026,
  retirementYear: 2046,
  horizonYear: 2086,
  monthlyExpenseBase: makeMonthlyExpenseBase(80_000, BASE_STEPS),
  ssByYear: BASE_SS_BY_YEAR,
  incomeByYear: BASE_INCOME_BY_YEAR,
  pathCount: 100,
  seed: 12345,
  strategyKind: 'taxEfficient',
};

describe('runMonteCarlo — dated portfolio-addition events', () => {
  it('an empty events array behaves identically to omitted events', () => {
    const without = runMonteCarlo(baseInput);
    const withEmpty = runMonteCarlo({ ...baseInput, events: [] });
    expect(withEmpty.percentilesNominal.p50).toEqual(without.percentilesNominal.p50);
    expect(withEmpty.successProbability).toBe(without.successProbability);
    expect(withEmpty.medianEndingBalanceNominal).toBe(without.medianEndingBalanceNominal);
  });

  it('CBP lump-sum event at primary retirement month shifts at-retirement balance up by ~$50k', () => {
    // Retirement month = (2046 - 2026) * 12 = 240 (January of 2046).
    const retirementMonth = (baseInput.retirementYear - baseInput.firstYear) * 12;
    const without = runMonteCarlo(baseInput);
    const withEvent = runMonteCarlo({
      ...baseInput,
      events: [
        { month: retirementMonth, amount: 50_000, source: 'cbpLumpSum' },
      ],
    });
    // The percentiles for the retirement year (year 20 from firstYear)
    // should be ~$50k higher. Returns still apply afterward so the gap
    // grows slightly through later years; we just pin the at-retirement
    // bump to within a generous tolerance band.
    const yearAtRetirement = baseInput.retirementYear - baseInput.firstYear;
    const baselineP50 = without.percentilesNominal.p50[yearAtRetirement];
    const bumpedP50 = withEvent.percentilesNominal.p50[yearAtRetirement];
    const delta = bumpedP50 - baselineP50;
    // The lump-sum lands in January of retirement year and compounds
    // through year-end. With historical bootstrap blended returns the
    // year-end value of $50k can drift either way by a few percent, so
    // tolerate a wide band — the point is that the event added ~$50k,
    // not zero and not $500k.
    expect(delta).toBeGreaterThan(40_000);
    expect(delta).toBeLessThan(80_000);
  });

  it('targetedOneOff event during accumulation lifts portfolio before retirement', () => {
    // Place the event at month 60 (5 years in, mid-accumulation).
    const eventMonth = 60;
    const without = runMonteCarlo(baseInput);
    const withEvent = runMonteCarlo({
      ...baseInput,
      events: [
        { month: eventMonth, amount: 25_000, source: 'targetedOneOff', targetAccountId: 'acct-xyz' },
      ],
    });
    // Year 6 (right after the event) should be measurably higher.
    const yearIdx = 6;
    expect(
      withEvent.percentilesNominal.p50[yearIdx],
    ).toBeGreaterThan(without.percentilesNominal.p50[yearIdx]);
  });

  it('secondaryContribution event after retirement adds to drawdown deposits', () => {
    // 12 months after retirement — clearly in drawdown phase.
    const eventMonth = (baseInput.retirementYear - baseInput.firstYear) * 12 + 12;
    const without = runMonteCarlo(baseInput);
    const withEvent = runMonteCarlo({
      ...baseInput,
      events: [
        { month: eventMonth, amount: 30_000, source: 'secondaryContribution' },
      ],
    });
    // Year after the deposit lands should be higher under the deposit.
    const yearIdx = baseInput.retirementYear - baseInput.firstYear + 1;
    expect(
      withEvent.percentilesNominal.p50[yearIdx],
    ).toBeGreaterThan(without.percentilesNominal.p50[yearIdx]);
  });
});
