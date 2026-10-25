import { describe, expect, it } from 'vitest';
import {
  buildCashflowSeries,
  type CashflowSeriesInput,
  type SourceSplit,
} from './cashflow-series';
import { buildViewDeflator } from './view-deflator';
import type { ExpenseProjectionMonthlyPoint } from './expense-projection';
import type { IncomeMonthOutput } from './income-projection';
import type { SsMonthOutput } from './ss-projection';

const FROM = 2030;
const END = 2032; // 2032 = trailing all-zero year (trim probe).

// Flat $24k/yr SS, $12k pension, $6k part-time, $3k one-off, $30k expenses (24k essential + 6k discretionary) in 2030-2031; zero in 2032.
const ANNUAL = {
  ss: 24_000,
  pensionAnnuity: 12_000,
  partTime: 6_000,
  oneOff: 3_000,
  deposits: 1_000,
  withdrawal: 9_000,
  essential: 24_000,
  discretionary: 6_000,
  // Per-year portfolio tax cash (federalTax + irmaa − acaPtc, nominal dollars); default all-zero so non-tax cases are unaffected.
  taxes: 5_000,
};

function ssMonth(year: number, m: number, total: number): SsMonthOutput {
  return {
    fractionalYear: year + m / 12,
    year,
    month0: m,
    total,
    byMember: { primary: total },
  };
}

function incMonth(year: number, m: number, on: boolean): IncomeMonthOutput {
  return {
    fractionalYear: year + m / 12,
    year,
    month0: m,
    pensionIncome: on ? ANNUAL.pensionAnnuity : 0,
    partTimeIncome: on ? ANNUAL.partTime : 0,
    oneOffIncome: on ? ANNUAL.oneOff : 0,
    depositInflow: on ? ANNUAL.deposits : 0,
    total: 0,
  };
}

function expMonth(
  year: number,
  m: number,
  on: boolean,
): ExpenseProjectionMonthlyPoint {
  // Per-month run-rate (`monthlyBucket` does the ÷ 12). The fixtures are inflation-free at the engine level, so `*Base` equals nominal; the glided-base case overrides it.
  return {
    fractionalYear: year + m / 12,
    year,
    month0: m,
    essential: on ? ANNUAL.essential : 0,
    discretionary: on ? ANNUAL.discretionary : 0,
    total: on ? ANNUAL.essential + ANNUAL.discretionary : 0,
    oneOffEssential: 0,
    oneOffDiscretionary: 0,
    essentialBase: on ? ANNUAL.essential : 0,
    discretionaryBase: on ? ANNUAL.discretionary : 0,
    oneOffEssentialBase: 0,
    oneOffDiscretionaryBase: 0,
  };
}

function buildMonthlySeries(): NonNullable<
  CashflowSeriesInput['monthlySeries']
> {
  const ssMonths: SsMonthOutput[] = [];
  const incomeMonths: IncomeMonthOutput[] = [];
  const expenseMonths: ExpenseProjectionMonthlyPoint[] = [];
  for (let y = FROM; y <= END; y += 1) {
    const active = y < 2032;
    for (let m = 0; m < 12; m += 1) {
      ssMonths.push(ssMonth(y, m, active ? ANNUAL.ss : 0));
      incomeMonths.push(incMonth(y, m, active));
      expenseMonths.push(expMonth(y, m, active));
    }
  }
  return { ssMonths, incomeMonths, expenseMonths };
}

function makeInput(
  overrides: Partial<CashflowSeriesInput> = {},
): CashflowSeriesInput {
  const sourceSplitByYear = new Map<number, SourceSplit>();
  const depositsByYear = new Map<number, number>();
  const engineWithdrawnByYear = new Map<number, number>();
  const fundedByYear = new Map<number, boolean>();
  const taxCashByYear = new Map<number, number>();
  for (let y = FROM; y <= END; y += 1) {
    const active = y < 2032;
    sourceSplitByYear.set(y, {
      ss: active ? ANNUAL.ss : 0,
      pensionAnnuity: active ? ANNUAL.pensionAnnuity : 0,
      partTime: active ? ANNUAL.partTime : 0,
      oneOff: active ? ANNUAL.oneOff : 0,
    });
    depositsByYear.set(y, active ? ANNUAL.deposits : 0);
    engineWithdrawnByYear.set(y, active ? ANNUAL.withdrawal : 0);
    taxCashByYear.set(y, 0);
    // Default: NOT funded, so `reconcileYearlyCashflow` returns the engine-actual `engineWithdrawn` verbatim; funded cases flip this to true.
    fundedByYear.set(y, false);
  }
  const extendedExpenseRows = [FROM, FROM + 1, END].map((y) => ({
    year: y,
    essential: y < 2032 ? ANNUAL.essential : 0,
    discretionary: y < 2032 ? ANNUAL.discretionary : 0,
    total: y < 2032 ? ANNUAL.essential + ANNUAL.discretionary : 0,
    essentialBase: y < 2032 ? ANNUAL.essential : 0,
    discretionaryBase: y < 2032 ? ANNUAL.discretionary : 0,
    totalBase: y < 2032 ? ANNUAL.essential + ANNUAL.discretionary : 0,
  }));
  const perMonth = new Float64Array(36);
  for (let i = 0; i < 24; i += 1) perMonth[i] = ANNUAL.withdrawal / 12;
  // 3% inflation anchored Jan 2030 so the December-anchor factor is real; without an MC run `basisDeflator` collapses to the same flat `viewDeflator`.
  const deflator = buildViewDeflator('today', {
    nowYear: FROM,
    nowMonthIndex: 0,
    inflationPct: 3,
  });
  return {
    fromYear: FROM,
    drawdownEndYear: END,
    sourceSplitByYear,
    depositsByYear,
    extendedExpenseRows,
    displayMode: 'future',
    engineWithdrawnByYear,
    fundedByYear,
    taxCashByYear,
    perMonthWithdrawal: perMonth,
    monthlySeries: buildMonthlySeries(),
    viewDeflator: deflator,
    basisDeflator: (year: number) => deflator(year, 11),
    ...overrides,
  };
}

describe('buildCashflowSeries — Yearly', () => {
  it('emits exactly one point per active year, Dec-anchored', () => {
    const { cashflowYearly, breakdownYearly } = buildCashflowSeries(
      makeInput(),
    );
    expect(cashflowYearly.map((r) => r.year)).toEqual([FROM, FROM + 1]);
    expect(breakdownYearly.map((r) => r.year)).toEqual([FROM, FROM + 1]);
    for (const r of cashflowYearly) {
      expect(r.month0).toBe(0);
      expect(r.fractionalYear).toBe(r.year);
    }
  });

  it('a flat nominal stream is constant across the year and equals the year-by-year table value', () => {
    const input = makeInput();
    const { cashflowYearly, breakdownYearly } = buildCashflowSeries(input);
    for (const r of breakdownYearly) {
      const expectedSs = ANNUAL.ss * input.viewDeflator(r.year, 11);
      expect(r.ss).toBeCloseTo(expectedSs, 6);
    }
    const y2030 = cashflowYearly.find((r) => r.year === FROM)!;
    const expectedEarned2030 =
      (ANNUAL.ss + ANNUAL.pensionAnnuity + ANNUAL.partTime + ANNUAL.oneOff) *
      input.viewDeflator(FROM, 11);
    expect(y2030.earned).toBeCloseTo(expectedEarned2030, 6);
    expect(y2030.withdrawal).toBeCloseTo(
      ANNUAL.withdrawal * input.viewDeflator(FROM, 11),
      6,
    );
  });

  it('yearly income-breakdown carries the full per-source stack', () => {
    const input = makeInput();
    const { breakdownYearly } = buildCashflowSeries(input);
    const r = breakdownYearly.find((x) => x.year === FROM)!;
    const f = input.viewDeflator(FROM, 11);
    expect(r.ss).toBeCloseTo(ANNUAL.ss * f, 6);
    expect(r.pensionAnnuity).toBeCloseTo(ANNUAL.pensionAnnuity * f, 6);
    expect(r.partTime).toBeCloseTo(ANNUAL.partTime * f, 6);
    expect(r.oneOff).toBeCloseTo(ANNUAL.oneOff * f, 6);
    expect(r.portfolioAdd).toBeCloseTo(ANNUAL.deposits * f, 6);
    expect(r.withdrawal).toBeCloseTo(ANNUAL.withdrawal * f, 6);
    const earned =
      (ANNUAL.ss + ANNUAL.pensionAnnuity + ANNUAL.partTime + ANNUAL.oneOff) * f;
    expect(r.total).toBeCloseTo(
      earned + ANNUAL.withdrawal * f + ANNUAL.deposits * f,
      6,
    );
  });

  it('yearly cashflow carries the essential/discretionary split, not just a total', () => {
    const input = makeInput();
    const { cashflowYearly } = buildCashflowSeries(input);
    const r = cashflowYearly.find((x) => x.year === FROM)!;
    const f = input.viewDeflator(FROM, 11);
    expect(r.essential).toBeCloseTo(ANNUAL.essential * f, 6);
    expect(r.discretionary).toBeCloseTo(ANNUAL.discretionary * f, 6);
    expect(r.total).toBeCloseTo(
      (ANNUAL.essential + ANNUAL.discretionary) * f,
      6,
    );
  });

  it('trims trailing all-zero years (no flat-zero tail past the last expense year)', () => {
    const { cashflowYearly, breakdownYearly } = buildCashflowSeries(
      makeInput(),
    );
    expect(cashflowYearly.some((r) => r.year === 2032)).toBe(false);
    expect(breakdownYearly.some((r) => r.year === 2032)).toBe(false);
    expect(cashflowYearly.at(-1)!.year).toBe(FROM + 1);
  });
});

describe('buildCashflowSeries — full death-year terminal row (no proration)', () => {
  // `lastDeathFractional` is the integer death year (Dec 31 of the terminal year); the death-year row carries full annual values, so passing it must not change the series.
  const DEATH = FROM + 1; // integer death year (= 2031).

  it('the death-year Yearly row carries full annual values (no proration)', () => {
    const whole = buildCashflowSeries(makeInput());
    const withDeath = buildCashflowSeries(makeInput({ lastDeathFractional: DEATH }));
    const wholeDeath = whole.cashflowYearly.find((r) => r.year === FROM + 1)!;
    const death = withDeath.cashflowYearly.find((r) => r.year === FROM + 1)!;
    expect(withDeath.cashflowYearly.length).toBe(whole.cashflowYearly.length);
    expect(death.fractionalYear).toBe(FROM + 1);
    expect(death.essential).toBeCloseTo(wholeDeath.essential, 9);
    expect(death.discretionary).toBeCloseTo(wholeDeath.discretionary, 9);
    expect(death.total).toBeCloseTo(wholeDeath.total, 9);
    expect(death.earned).toBeCloseTo(wholeDeath.earned, 9);
    expect(death.withdrawal).toBeCloseTo(wholeDeath.withdrawal, 9);
    expect(death.totalIncome).toBeCloseTo(wholeDeath.totalIncome, 9);
  });

  it('the death-year row is the terminal row (trailing all-zero years trimmed)', () => {
    const { cashflowYearly, breakdownYearly } = buildCashflowSeries(
      makeInput({ lastDeathFractional: DEATH }),
    );
    expect(cashflowYearly.at(-1)!.year).toBe(FROM + 1);
    expect(breakdownYearly.at(-1)!.year).toBe(FROM + 1);
  });

  it('the breakdown death-year row carries full per-source values', () => {
    const whole = buildCashflowSeries(makeInput());
    const withDeath = buildCashflowSeries(makeInput({ lastDeathFractional: DEATH }));
    const wholeDeath = whole.breakdownYearly.find((r) => r.year === FROM + 1)!;
    const death = withDeath.breakdownYearly.find((r) => r.year === FROM + 1)!;
    expect(death.ss).toBeCloseTo(wholeDeath.ss, 9);
    expect(death.portfolioAdd).toBeCloseTo(wholeDeath.portfolioAdd, 9);
    expect(death.total).toBeCloseTo(wholeDeath.total, 9);
  });

  it('passing lastDeathFractional does not change the Yearly or Monthly series', () => {
    const whole = buildCashflowSeries(makeInput());
    const withDeath = buildCashflowSeries(makeInput({ lastDeathFractional: DEATH }));
    expect(withDeath.cashflowYearly).toEqual(whole.cashflowYearly);
    expect(withDeath.breakdownYearly).toEqual(whole.breakdownYearly);
    expect(withDeath.cashflowMonthly).toEqual(whole.cashflowMonthly);
    expect(withDeath.breakdownMonthly).toEqual(whole.breakdownMonthly);
  });

  it('null lastDeathFractional → series unchanged', () => {
    const whole = buildCashflowSeries(makeInput());
    const nullDeath = buildCashflowSeries(
      makeInput({ lastDeathFractional: null }),
    );
    expect(nullDeath.cashflowYearly).toEqual(whole.cashflowYearly);
  });
});

// Clean steady state (one-off and deposits zeroed): the only shape where Σ(12 Monthly) == Yearly.
function steadyInput(): CashflowSeriesInput {
  const base = makeInput();
  for (const r of base.monthlySeries!.incomeMonths) {
    r.oneOffIncome = 0;
    r.depositInflow = 0;
  }
  for (const [y, s] of base.sourceSplitByYear) {
    base.sourceSplitByYear.set(y, { ...s, oneOff: 0 });
  }
  for (const y of base.depositsByYear.keys()) base.depositsByYear.set(y, 0);
  return base;
}

const monthOf = <T extends { year: number; month0: number }>(
  rows: T[],
  m: number,
): T => rows.find((r) => r.year === FROM && r.month0 === m)!;

const sumFrom = <T extends { year: number }>(
  rows: T[],
  pick: (r: T) => number,
  year = FROM,
): number =>
  rows.filter((r) => r.year === year).reduce((a, r) => a + pick(r), 0);

describe('buildCashflowSeries — Monthly (true monthly dollars)', () => {
  it('(a) mechanical decomposition: recurring ÷12, withdrawal no ×12, Dec-anchor flat, spikes literal', () => {
    const input = steadyInput();
    const SPIKE = 50_000;
    const ESS_SPIKE = 1_200;
    const inc = input.monthlySeries!.incomeMonths[5]; // FROM, month0 5
    inc.oneOffIncome = SPIKE;
    inc.depositInflow = SPIKE;
    input.monthlySeries!.expenseMonths[5].oneOffEssential = ESS_SPIKE;
    const f = input.viewDeflator(FROM, 11);
    const { cashflowMonthly: c, breakdownMonthly: b } =
      buildCashflowSeries(input);
    const b0 = monthOf(b, 0);
    const c0 = monthOf(c, 0);
    expect(b0.ss).toBeCloseTo((ANNUAL.ss / 12) * f, 6);
    expect(b0.pensionAnnuity).toBeCloseTo((ANNUAL.pensionAnnuity / 12) * f, 6);
    expect(b0.partTime).toBeCloseTo((ANNUAL.partTime / 12) * f, 6);
    expect(c0.essential).toBeCloseTo((ANNUAL.essential / 12) * f, 6);
    expect(c0.discretionary).toBeCloseTo((ANNUAL.discretionary / 12) * f, 6);
    expect(c0.withdrawal).toBeCloseTo((ANNUAL.withdrawal / 12) * f, 6); // engine $/mo, NOT ×12
    expect(c0.earned).toBeCloseTo(monthOf(c, 11).earned, 9);
    const b5 = monthOf(b, 5);
    expect(b5.oneOff).toBeCloseTo(SPIKE * f, 6);
    expect(b5.portfolioAdd).toBeCloseTo(SPIKE * f, 6);
    const essSpike = ((ANNUAL.essential - ESS_SPIKE) / 12 + ESS_SPIKE) * f;
    expect(monthOf(c, 5).essential).toBeCloseTo(essSpike, 6);
    expect(monthOf(b, 4).oneOff).toBe(0);
  });

  it('(b) steady-state Σ(12 Monthly) == Yearly point == year-by-year table', () => {
    const input = steadyInput();
    const f = input.viewDeflator(FROM, 11);
    const s = buildCashflowSeries(input);
    const yC = s.cashflowYearly.find((r) => r.year === FROM)!;
    const yB = s.breakdownYearly.find((r) => r.year === FROM)!;
    const mEarned = sumFrom(s.cashflowMonthly, (r) => r.earned);
    const mWdraw = sumFrom(s.cashflowMonthly, (r) => r.withdrawal);
    const mEss = sumFrom(s.cashflowMonthly, (r) => r.essential);
    const mSs = sumFrom(s.breakdownMonthly, (r) => r.ss);
    expect(mEarned).toBeCloseTo(yC.earned, 4);
    expect(mWdraw).toBeCloseTo(yC.withdrawal, 4);
    expect(mEss).toBeCloseTo(yC.essential, 4);
    expect(mSs).toBeCloseTo(yB.ss, 4);
    const tableEarned =
      (ANNUAL.ss + ANNUAL.pensionAnnuity + ANNUAL.partTime) * f;
    expect(yC.earned).toBeCloseTo(tableEarned, 6);
    expect(monthOf(s.cashflowMonthly, 0).earned).toBeCloseTo(yC.earned / 12, 4);
  });

  it('(c) mid-year SS claim diverges from the annual rollup (table authoritative); engine covers need → no spurious shortfall', () => {
    const input = steadyInput();
    const f = input.viewDeflator(FROM, 11);
    for (const r of input.monthlySeries!.ssMonths) {
      if (r.year === FROM && r.month0 < 4) r.total = 0;
    }
    const monExp = (ANNUAL.essential + ANNUAL.discretionary) / 12;
    const earnedNoSs = (ANNUAL.pensionAnnuity + ANNUAL.partTime) / 12;
    for (let m = 0; m < 12; m += 1) {
      input.perMonthWithdrawal![m] = m < 4 ? monExp - earnedNoSs : 0;
    }
    const { cashflowMonthly, breakdownMonthly } = buildCashflowSeries(input);
    const sumSs = sumFrom(breakdownMonthly, (r) => r.ss);
    expect(sumSs).toBeCloseTo((8 / 12) * ANNUAL.ss * f, 4);
    expect(sumSs).toBeLessThan(ANNUAL.ss * f);
    for (const r of cashflowMonthly.filter((x) => x.year === FROM)) {
      expect(r.shortfallHeight).toBe(0); // no spurious shortfall
    }
  });

  it('(c) genuine post-depletion shortfall surfaces at monthly magnitude', () => {
    const input = steadyInput(); // FROM+1: depleted + no earned income.
    for (let i = 12; i < 24; i += 1) input.perMonthWithdrawal![i] = 0;
    for (const r of input.monthlySeries!.ssMonths) {
      if (r.year === FROM + 1) r.total = 0;
    }
    for (const r of input.monthlySeries!.incomeMonths) {
      if (r.year === FROM + 1) {
        r.pensionIncome = 0;
        r.partTimeIncome = 0;
      }
    }
    const f = input.viewDeflator(FROM + 1, 11);
    const { cashflowMonthly } = buildCashflowSeries(input);
    const m = cashflowMonthly.find(
      (r) => r.year === FROM + 1 && r.month0 === 6,
    )!;
    const monExp = ((ANNUAL.essential + ANNUAL.discretionary) / 12) * f;
    expect(m.shortfallHeight).toBeCloseTo(monExp, 4); // monthly magnitude
    expect(m.shortfallHeight).toBeLessThan(monExp * 12); // NOT annual
  });

  it('(d) Yearly path output is independent of the Monthly series (regression guard)', () => {
    const a = buildCashflowSeries(steadyInput());
    const b = steadyInput();
    b.monthlySeries = null;
    const c = buildCashflowSeries(b);
    expect(c.cashflowYearly).toEqual(a.cashflowYearly);
    expect(c.breakdownYearly).toEqual(a.breakdownYearly);
  });

  it('(e) suppressSubDollar floors a sub-$1 displayed shortfall, keeps ≥$1', () => {
    const input = steadyInput();
    const zero = (m: number, essNominal: number): void => {
      input.perMonthWithdrawal![m] = 0;
      input.monthlySeries!.ssMonths[m].total = 0;
      const inc = input.monthlySeries!.incomeMonths[m];
      inc.pensionIncome = 0;
      inc.partTimeIncome = 0;
      const exp = input.monthlySeries!.expenseMonths[m];
      exp.essential = essNominal;
      exp.oneOffEssential = essNominal;
      exp.discretionary = 0;
      exp.oneOffDiscretionary = 0;
    };
    zero(6, 0.5); // sub-$1 displayed → floored to 0
    zero(7, 100); // ≥$1 displayed → kept
    const f = input.viewDeflator(FROM, 11);
    const { cashflowMonthly } = buildCashflowSeries(input);
    expect(monthOf(cashflowMonthly, 6).shortfallHeight).toBe(0);
    const kept = monthOf(cashflowMonthly, 7).shortfallHeight;
    expect(kept).toBeGreaterThan(1);
    expect(kept).toBeCloseTo(100 * f, 4);
  });

  it('collapses Monthly to empty when monthlySeries is null', () => {
    const { cashflowMonthly, breakdownMonthly, cashflowYearly } =
      buildCashflowSeries(makeInput({ monthlySeries: null }));
    expect(cashflowMonthly).toEqual([]);
    expect(breakdownMonthly).toEqual([]);
    expect(cashflowYearly.length).toBeGreaterThan(0);
  });
});

// Today's-dollars expense basis: 3% inflation anchored Jan 2030; the nominal expense carries month-precise inflation (the old sawtooth), `*Base` is the flat entered real amount.
const INFL = 1.03;
const monthFactor = (year: number, m: number): number =>
  Math.pow(INFL, (year * 12 + m - FROM * 12) / 12);

// A single constant non-glided $24k/yr essential expense; income zeroed so the band is the pure expense reference, unfunded so withdrawal is engine-actual.
function todayFixture(
  overrides: Partial<CashflowSeriesInput> = {},
): CashflowSeriesInput {
  const base = makeInput({ displayMode: 'today', ...overrides });
  for (const r of base.monthlySeries!.incomeMonths) {
    r.pensionIncome = 0;
    r.partTimeIncome = 0;
    r.oneOffIncome = 0;
    r.depositInflow = 0;
  }
  for (const r of base.monthlySeries!.ssMonths) r.total = 0;
  for (const r of base.monthlySeries!.expenseMonths) {
    if (r.year >= 2032) continue;
    r.essential = ANNUAL.essential * monthFactor(r.year, r.month0);
    r.discretionary = 0;
    r.total = r.essential;
    r.essentialBase = ANNUAL.essential;
    r.discretionaryBase = 0;
  }
  for (const [y] of base.sourceSplitByYear) {
    base.sourceSplitByYear.set(y, {
      ss: 0,
      pensionAnnuity: 0,
      partTime: 0,
      oneOff: 0,
    });
  }
  for (const y of base.depositsByYear.keys()) base.depositsByYear.set(y, 0);
  for (const r of base.extendedExpenseRows) {
    if (r.year >= 2032) continue;
    r.essential = ANNUAL.essential; // (year nominal == base when 0% — the
    r.discretionary = 0; //            Yearly assertions use Base anyway)
    r.total = ANNUAL.essential;
    r.essentialBase = ANNUAL.essential;
    r.discretionaryBase = 0;
    r.totalBase = ANNUAL.essential;
  }
  return base;
}

describe('buildCashflowSeries — today-mode expense basis', () => {
  it('constant non-glided real expense is FLAT across 12 Monthly months (kills the sawtooth) and == amount/12', () => {
    const input = todayFixture();
    const { cashflowMonthly } = buildCashflowSeries(input);
    const months2030 = cashflowMonthly.filter((r) => r.year === FROM);
    expect(months2030).toHaveLength(12);
    const perMonth = ANNUAL.essential / 12; // $2,000
    for (const m of months2030) {
      expect(m.essential).toBeCloseTo(perMonth, 6);
    }
    expect(months2030[0].essential).toBeCloseTo(months2030[11].essential, 9);
  });

  it('today + Yearly: non-glided expense reads the entered annual amount; Σ(12 Monthly) == Yearly == entered (≤$0.01)', () => {
    const input = todayFixture();
    const s = buildCashflowSeries(input);
    const yearly2030 = s.cashflowYearly.find((r) => r.year === FROM)!;
    expect(yearly2030.essential).toBeCloseTo(ANNUAL.essential, 6);
    const sumMonthly = sumFrom(s.cashflowMonthly, (r) => r.essential);
    expect(Math.abs(sumMonthly - ANNUAL.essential)).toBeLessThan(0.01);
    expect(Math.abs(sumMonthly - yearly2030.essential)).toBeLessThan(0.01);
  });

  it('glided discretionary: Monthly discretionary == nominal-month ÷ monthFactor (ramps, NOT flat, NOT inflation)', () => {
    const input = makeInput({ displayMode: 'today' });
    for (const r of input.monthlySeries!.incomeMonths) {
      r.pensionIncome = 0;
      r.partTimeIncome = 0;
      r.oneOffIncome = 0;
      r.depositInflow = 0;
    }
    for (const r of input.monthlySeries!.ssMonths) r.total = 0;
    // A discretionary expense whose real run-rate ramps within 2030 (12k, declining glide) while inflation also ramps: base_m = nominal_m ÷ monthFactor(2030, m).
    const realRate = (m: number): number => 12_000 * (1 - 0.4 * (m / 12));
    for (const r of input.monthlySeries!.expenseMonths) {
      if (r.year !== FROM) {
        r.essential = 0;
        r.discretionary = 0;
        r.total = 0;
        r.essentialBase = 0;
        r.discretionaryBase = 0;
        continue;
      }
      const base = realRate(r.month0);
      r.essential = 0;
      r.essentialBase = 0;
      r.discretionaryBase = base;
      r.discretionary = base * monthFactor(r.year, r.month0);
      r.total = r.discretionary;
    }
    const { cashflowMonthly } = buildCashflowSeries(input);
    const m2030 = cashflowMonthly.filter((r) => r.year === FROM);
    for (const m of m2030) {
      const nominalMonth =
        (realRate(m.month0) * monthFactor(FROM, m.month0)) / 12;
      expect(m.discretionary).toBeCloseTo(
        nominalMonth / monthFactor(FROM, m.month0),
        4,
      );
    }
    expect(m2030[0].discretionary).not.toBeCloseTo(
      m2030[11].discretionary,
      2,
    );
    expect(m2030[0].discretionary).toBeGreaterThan(m2030[11].discretionary);
  });

  it('glided discretionary Yearly == annualBase × (1/12) × Σ glide(m); Σ(12 Monthly) == Yearly (≤$0.01)', () => {
    const input = makeInput({ displayMode: 'today' });
    for (const r of input.monthlySeries!.incomeMonths) {
      r.pensionIncome = 0;
      r.partTimeIncome = 0;
      r.oneOffIncome = 0;
      r.depositInflow = 0;
    }
    for (const r of input.monthlySeries!.ssMonths) r.total = 0;
    const annualBase = 12_000;
    const glide = (m: number): number => 1 - 0.4 * (m / 12);
    for (const r of input.monthlySeries!.expenseMonths) {
      if (r.year !== FROM) {
        r.essential = 0;
        r.discretionary = 0;
        r.total = 0;
        r.essentialBase = 0;
        r.discretionaryBase = 0;
        continue;
      }
      const baseRate = annualBase * glide(r.month0);
      r.essential = 0;
      r.essentialBase = 0;
      r.discretionaryBase = baseRate;
      r.discretionary = baseRate * monthFactor(r.year, r.month0);
      r.total = r.discretionary;
    }
    // Oracle: the inflation-free recompute annualBase × (1/12) × Σ glide(m), not a scalar nominal ÷ inflationFactor.
    let glideSum = 0;
    for (let m = 0; m < 12; m += 1) glideSum += glide(m);
    const oracle = annualBase * (1 / 12) * glideSum;
    for (const r of input.extendedExpenseRows) {
      if (r.year !== FROM) {
        r.essential = 0;
        r.discretionary = 0;
        r.total = 0;
        r.essentialBase = 0;
        r.discretionaryBase = 0;
        r.totalBase = 0;
        continue;
      }
      r.essential = 0;
      r.essentialBase = 0;
      r.discretionaryBase = oracle;
      r.discretionary = 0; // nominal not exercised in today-mode
      r.total = 0;
      r.totalBase = oracle;
    }
    const s = buildCashflowSeries(input);
    const yearly2030 = s.cashflowYearly.find((r) => r.year === FROM)!;
    expect(yearly2030.discretionary).toBeCloseTo(oracle, 6);
    const sumMonthly = sumFrom(s.cashflowMonthly, (r) => r.discretionary);
    expect(Math.abs(sumMonthly - oracle)).toBeLessThan(0.01);
    expect(Math.abs(sumMonthly - yearly2030.discretionary)).toBeLessThan(
      0.01,
    );
  });

  it('Monthly year-gate depleted today-mode ⇒ engine perMonthWithdrawal × f, real per-month gap surfaces', () => {
    const input = todayFixture();
    input.fundedByYear.set(FROM, false);
    for (let i = 0; i < 12; i += 1) input.perMonthWithdrawal![i] = 0;
    const f = input.viewDeflator(FROM, 11);
    const { cashflowMonthly } = buildCashflowSeries(input);
    const m6 = cashflowMonthly.find(
      (r) => r.year === FROM && r.month0 === 6,
    )!;
    const perMonth = ANNUAL.essential / 12; // real $2,000
    expect(m6.withdrawal).toBe(0); // engine perMonthWithdrawal × f
    expect(m6.shortfallHeight).toBeCloseTo(perMonth, 4);
    expect(m6.shortfallHeight).toBeLessThan(perMonth * 12); // monthly, not annual
    expect(f).toBeLessThan(1); // deflator is a real (non-identity) factor
  });

  it('funded year, no earned income: the Monthly plug nets the real expense; Monthly + Yearly shortfall 0', () => {
    const input = todayFixture();
    for (const [y] of input.fundedByYear) {
      input.fundedByYear.set(y, y < 2032);
    }
    const s = buildCashflowSeries(input);
    const perMonth = ANNUAL.essential / 12;
    for (const m of s.cashflowMonthly.filter((r) => r.year === FROM)) {
      expect(m.essential).toBeCloseTo(perMonth, 6);
      expect(m.withdrawal).toBeCloseTo(perMonth, 6);
      expect(m.shortfallHeight).toBe(0);
      expect(m.totalIncome).toBeCloseTo(m.total, 6);
    }
    const yearly2030 = s.cashflowYearly.find((r) => r.year === FROM)!;
    expect(yearly2030.essential).toBeCloseTo(ANNUAL.essential, 6);
    expect(yearly2030.shortfallHeight).toBe(0);
    expect(yearly2030.totalIncome).toBeCloseTo(yearly2030.total, 4);
  });

  it('the counterpart: a genuinely depleted year surfaces the real-magnitude shortfall on the real basis', () => {
    const input = todayFixture();
    input.fundedByYear.set(FROM, false);
    for (let i = 0; i < 12; i += 1) input.perMonthWithdrawal![i] = 0;
    input.engineWithdrawnByYear.set(FROM, 0);
    const s = buildCashflowSeries(input);
    const yearly2030 = s.cashflowYearly.find((r) => r.year === FROM)!;
    expect(yearly2030.essential).toBeCloseTo(ANNUAL.essential, 6);
    expect(yearly2030.shortfallHeight).toBeCloseTo(ANNUAL.essential, 4);
  });

  it('future-mode byte-identical: today→future flip uses the verbatim nominal path', () => {
    const fut = todayFixture({ displayMode: 'future' });
    const today = todayFixture({ displayMode: 'today' });
    const sFut = buildCashflowSeries(fut);
    const sToday = buildCashflowSeries(today);
    const fut2030 = sFut.cashflowMonthly.filter((r) => r.year === FROM);
    expect(fut2030[0].essential).not.toBeCloseTo(fut2030[11].essential, 2);
    const tod2030 = sToday.cashflowMonthly.filter((r) => r.year === FROM);
    expect(tod2030[0].essential).toBeCloseTo(tod2030[11].essential, 6);
    expect(fut2030.map((r) => round6(r.essential))).toEqual(
      input2030NominalEssentials(),
    );
  });
});

function withTax(
  input: CashflowSeriesInput,
  taxNominal: number,
): CashflowSeriesInput {
  for (const [y] of input.taxCashByYear) {
    input.taxCashByYear.set(y, y < 2032 ? taxNominal : 0);
  }
  return input;
}

function zeroIncome(input: CashflowSeriesInput): CashflowSeriesInput {
  for (const [y] of input.sourceSplitByYear) {
    input.sourceSplitByYear.set(y, {
      ss: 0,
      pensionAnnuity: 0,
      partTime: 0,
      oneOff: 0,
    });
  }
  if (input.monthlySeries) {
    for (const r of input.monthlySeries.ssMonths) r.total = 0;
    for (const r of input.monthlySeries.incomeMonths) {
      r.pensionIncome = 0;
      r.partTimeIncome = 0;
      r.oneOffIncome = 0;
    }
  }
  return input;
}

describe('buildCashflowSeries — Taxes band', () => {
  it('funded tie-out: band == taxNominal·f; withdrawal == (expense+taxes−earned)·f == engineWithdrawn (≤$1)', () => {
    const input = zeroIncome(withTax(makeInput(), ANNUAL.taxes));
    const earnedNom = 0;
    const expenseNom = ANNUAL.essential + ANNUAL.discretionary;
    const ordinaryNetNeed = Math.max(0, expenseNom - earnedNom);
    const grossWithdrawn = ordinaryNetNeed + ANNUAL.taxes;
    for (const [y] of input.fundedByYear) {
      input.fundedByYear.set(y, y < 2032);
      input.engineWithdrawnByYear.set(y, y < 2032 ? grossWithdrawn : 0);
    }
    const f = input.viewDeflator(FROM, 11);
    const { cashflowYearly } = buildCashflowSeries(input);
    const r = cashflowYearly.find((x) => x.year === FROM)!;
    expect(r.taxes).toBeCloseTo(ANNUAL.taxes * f, 6);
    const expectedWdraw = (expenseNom + ANNUAL.taxes - earnedNom) * f;
    expect(r.withdrawal).toBeCloseTo(expectedWdraw, 6);
    expect(Math.abs(r.withdrawal - grossWithdrawn * f)).toBeLessThanOrEqual(1);
    expect(r.total).toBeCloseTo((expenseNom + ANNUAL.taxes) * f, 6);
    expect(r.shortfallHeight).toBe(0);
  });

  it('zero-tax funded year: withdrawal byte-identical to the no-tax-field build', () => {
    const base = makeInput(); // all-zero taxes
    for (const [y] of base.fundedByYear) base.fundedByYear.set(y, y < 2032);
    const withZeroMap = makeInput();
    for (const [y] of withZeroMap.fundedByYear) {
      withZeroMap.fundedByYear.set(y, y < 2032);
    }
    expect(buildCashflowSeries(withZeroMap).cashflowYearly).toEqual(
      buildCashflowSeries(base).cashflowYearly,
    );
  });

  it('depleted year: withdrawal stays engine-actual (no double-count); shortfall = (expense+taxes)−totalIncome', () => {
    const input = withTax(makeInput(), ANNUAL.taxes);
    const engineActual = 4_000;
    input.fundedByYear.set(FROM, false);
    input.engineWithdrawnByYear.set(FROM, engineActual);
    input.sourceSplitByYear.set(FROM, {
      ss: 0,
      pensionAnnuity: 0,
      partTime: 0,
      oneOff: 0,
    });
    const f = input.viewDeflator(FROM, 11);
    const r = buildCashflowSeries(input).cashflowYearly.find(
      (x) => x.year === FROM,
    )!;
    expect(r.withdrawal).toBeCloseTo(engineActual * f, 6);
    const expenseNom = ANNUAL.essential + ANNUAL.discretionary;
    const expectedShort = (expenseNom + ANNUAL.taxes) * f - r.totalIncome;
    expect(r.shortfallHeight).toBeCloseTo(expectedShort, 4);
    expect(r.taxes).toBeCloseTo(ANNUAL.taxes * f, 6);
  });

  it('monthly today-mode: Σ(12 months) taxes ≈ annual·f (steady state); funded-month plug nets shortfall to 0 with taxes', () => {
    const input = zeroIncome(
      withTax(steadyInput(), ANNUAL.taxes),
    );
    input.displayMode = 'today';
    for (const [y] of input.fundedByYear) input.fundedByYear.set(y, y < 2032);
    const f = input.viewDeflator(FROM, 11);
    const { cashflowMonthly } = buildCashflowSeries(input);
    const months2030 = cashflowMonthly.filter((r) => r.year === FROM);
    expect(months2030).toHaveLength(12);
    const sumTax = months2030.reduce((a, r) => a + r.taxes, 0);
    expect(sumTax).toBeCloseTo(ANNUAL.taxes * f, 4);
    for (const m of months2030) {
      expect(m.shortfallHeight).toBe(0);
      expect(m.totalIncome).toBeCloseTo(m.total, 6);
    }
  });

  it('cashflow.total and breakdown.expenses both include taxes', () => {
    const input = withTax(makeInput(), ANNUAL.taxes);
    const { cashflowYearly, breakdownYearly } = buildCashflowSeries(input);
    const c = cashflowYearly.find((x) => x.year === FROM)!;
    const b = breakdownYearly.find((x) => x.year === FROM)!;
    const f = input.viewDeflator(FROM, 11);
    const expenseNom = ANNUAL.essential + ANNUAL.discretionary;
    expect(c.total).toBeCloseTo((expenseNom + ANNUAL.taxes) * f, 6);
    expect(b.expenses).toBeCloseTo((expenseNom + ANNUAL.taxes) * f, 6);
  });
});

// Under MC + Today's the `earned` band deflates by `viewDeflator` while MC-sourced taxes and the reconciled withdrawal deflate by the path's own CPI (`basisDeflator`); the funded reconcile must still tie out.
describe('buildCashflowSeries — earned uses viewDeflator, MC fields use basisDeflator', () => {
  it('funded year with SS income: totalIncome == total AND earned == earnedNominal × viewDeflator', () => {
    const F_VIEW = 0.9;
    const F_MC = 0.5;
    const input = withTax(makeInput({ displayMode: 'today' }), ANNUAL.taxes);
    for (const [y] of input.sourceSplitByYear) {
      input.sourceSplitByYear.set(y, {
        ss: y < 2032 ? ANNUAL.ss : 0,
        pensionAnnuity: 0,
        partTime: 0,
        oneOff: 0,
      });
    }
    const expenseNom = ANNUAL.essential + ANNUAL.discretionary;
    const grossWithdrawn =
      Math.max(0, expenseNom - ANNUAL.ss) + ANNUAL.taxes;
    for (const [y] of input.fundedByYear) {
      input.fundedByYear.set(y, y < 2032);
      input.engineWithdrawnByYear.set(y, y < 2032 ? grossWithdrawn : 0);
    }
    input.viewDeflator = () => F_VIEW;
    input.basisDeflator = () => F_MC;

    const r = buildCashflowSeries(input).cashflowYearly.find(
      (x) => x.year === FROM,
    )!;
    expect(r.totalIncome).toBeCloseTo(r.total, 4);
    expect(r.shortfallHeight).toBe(0);
    expect(r.earned).toBeCloseTo(ANNUAL.ss * F_VIEW, 6);
    // The Taxes band and the grossed-up withdrawal use basisDeflator (0.5): expense (real *Base, no deflator) + taxes·fMc − earned·fView.
    expect(r.taxes).toBeCloseTo(ANNUAL.taxes * F_MC, 6);
    const expectedWdraw =
      expenseNom + ANNUAL.taxes * F_MC - ANNUAL.ss * F_VIEW;
    expect(r.withdrawal).toBeCloseTo(expectedWdraw, 4);
  });
});

function input2030NominalEssentials(): number[] {
  const f = buildViewDeflator('today', {
    nowYear: FROM,
    nowMonthIndex: 0,
    inflationPct: 3,
  })(FROM, 11);
  const out: number[] = [];
  for (let m = 0; m < 12; m += 1) {
    out.push(round6((ANNUAL.essential * monthFactor(FROM, m)) / 12 * f));
  }
  return out;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
