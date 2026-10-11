/**
 * Unit tests for the pure cashflow / income-breakdown series builder.
 *
 * The bulk of correctness coverage lives here (not in a heavy
 * BalanceProjectionPage render) because `buildCashflowSeries` is pure.
 *
 * Covers:
 *   - Yearly: one Dec-anchored point per year; a flat nominal stream
 *     equals `nominalAnnual × viewDeflator(year, 11)` — identical to
 *     the year-by-year table (the SS "shrinks each month" bug). Carries
 *     the full per-source stack + essential/discretionary split, not
 *     collapsed to totals.
 *   - Monthly = **true monthly dollars**: recurring ÷ 12, one-off /
 *     lump-sum literal in their month, withdrawal = engine
 *     `perMonthWithdrawal[idx]` (no ×12), Dec-anchored so a flat stream
 *     is constant across 12 months. Guards: mechanical decomposition,
 *     steady-state `Σ(12 Monthly) == Yearly == table`, transition-year
 *     documented divergence (table authoritative; Monthly ≈ Yearly ÷
 *     12, NOT a per-month equal), the `suppressSubDollar` $1 floor.
 *   - trimTrailingZero applied to yearly arrays: a fixture with zero
 *     flows after the last expense year produces no trailing flat-zero
 *     years.
 *   - Today-mode expense basis: a non-glided constant expense
 *     is flat across the 12 Monthly months (== amount/12, no sawtooth)
 *     and reads the entered annual amount Yearly; a glided expense
 *     follows its real monthly glide ramp (per-month `nominal ÷
 *     monthFactor`) with the continuous-annual value the inflation-free
 *     recompute (`annualBase × (1/12) × Σ glide`, NOT a scalar ÷
 *     inflationFactor); the Monthly withdrawal is year-gated on the
 *     `!depleted` signal (funded ⇒ plug, shortfall 0; depleted ⇒
 *     engine-actual, real gap). Future-mode runs the prior nominal
 *     path verbatim (the legacy guards above all run in future-mode).
 */
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

// Flat $24k/yr SS, $12k/yr pension, $6k/yr part-time, $3k/yr one-off,
// $30k/yr expenses (24k essential + 6k discretionary), constant across
// 2030-2031, zero in 2032.
const ANNUAL = {
  ss: 24_000,
  pensionAnnuity: 12_000,
  partTime: 6_000,
  oneOff: 3_000,
  deposits: 1_000,
  withdrawal: 9_000,
  essential: 24_000,
  discretionary: 6_000,
  // Per-year portfolio tax cash (federalTax + irmaa − acaPtc, dollars,
  // nominal). Only exercised by the dedicated tax-band cases that pass a
  // populated `taxCashByYear`; the default map is all-zero so every
  // legacy assertion stays byte-identical.
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
  // Per-month run-rate (the annual ÷ 12 is done by `monthlyBucket`).
  // `*Base` mirrors the nominal split — these fixtures are inflation-
  // free at the engine level (the deflator carries the inflation), so
  // base == nominal for the steady fixture; the glided-base case
  // overrides this explicitly below.
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

/** 2030-01 .. 2032-12 (36 months); 2032 is all-zero. */
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
  // Default fixture: all-zero taxes → the Taxes band is 0 and the funded
  // reconcile grosses up by nothing, so every legacy assertion (which
  // never set taxes) stays byte-identical. The tax-band cases override
  // this map.
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
    // Default fixture: NOT funded, so the unchanged
    // `reconcileYearlyCashflow` returns the engine-actual
    // `engineWithdrawn` verbatim — byte-identical to the prior
    // pre-reconciled `withdrawalByYear` map, keeping every legacy
    // decomposition / Dec-anchor / Σ assertion stable. The funded
    // reconcile + Monthly year-gate get dedicated tests that flip
    // this to `true`.
    fundedByYear.set(y, false);
  }
  const extendedExpenseRows = [FROM, FROM + 1, END].map((y) => ({
    year: y,
    essential: y < 2032 ? ANNUAL.essential : 0,
    discretionary: y < 2032 ? ANNUAL.discretionary : 0,
    total: y < 2032 ? ANNUAL.essential + ANNUAL.discretionary : 0,
    // Inflation-free fixture: base == nominal (the deflator carries
    // the inflation in these tests). The glided-base divergence is
    // covered by a dedicated test that overrides these.
    essentialBase: y < 2032 ? ANNUAL.essential : 0,
    discretionaryBase: y < 2032 ? ANNUAL.discretionary : 0,
    totalBase: y < 2032 ? ANNUAL.essential + ANNUAL.discretionary : 0,
  }));
  const perMonth = new Float64Array(36);
  for (let i = 0; i < 24; i += 1) perMonth[i] = ANNUAL.withdrawal / 12;
  // 3% inflation, anchored Jan 2030 — a real deflator so the December-anchor
  // factor (Monthly + Yearly) is exercised. No MC representative run here, so
  // `basisDeflator` collapses to the same flat `viewDeflator` (the MC-sourced
  // taxes + withdrawal deflate by the same factor as the deterministic stripes).
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
    // 2030 + 2031 active; 2032 all-zero → trimmed away.
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
      // Year-by-year table math: nominalAnnual × viewDeflator(y, 11).
      const expectedSs = ANNUAL.ss * input.viewDeflator(r.year, 11);
      expect(r.ss).toBeCloseTo(expectedSs, 6);
    }
    // Yearly remains the single Dec-anchored ANNUAL point; for a flat
    // steady-state year it equals the SUM of that year's 12 Monthly
    // months (each ≈ Yearly ÷ 12) — not any single month. (Yearly path
    // is untouched by the Monthly true-dollars change.)
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
  // Death = Dec 31 of `deathYear` (the terminal year). `lastDeathFractional`
  // is now the integer death year, and the death-year row carries FULL
  // annual values — there is no partial-year proration helper anymore. So
  // passing `lastDeathFractional` must NOT change the series.
  const DEATH = FROM + 1; // integer death year (= 2031).

  it('the death-year Yearly row carries full annual values (no proration)', () => {
    const whole = buildCashflowSeries(makeInput());
    const withDeath = buildCashflowSeries(makeInput({ lastDeathFractional: DEATH }));
    const wholeDeath = whole.cashflowYearly.find((r) => r.year === FROM + 1)!;
    const death = withDeath.cashflowYearly.find((r) => r.year === FROM + 1)!;
    // Same row count + identical values — no row was scaled or replaced.
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
    // FROM + 1 (the death year) is the last non-zero row; 2032 was trimmed.
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

/** Clean steady-state: makeInput() with one-off + deposits zeroed (no
 *  claim/death/start/end) — the only shape where Σ(12 Monthly) == Yearly. */
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
    // Dec anchor → a flat nominal stream is identical Jan == Dec.
    expect(c0.earned).toBeCloseTo(monthOf(c, 11).earned, 9);
    // One-off / lump-sum literal in the spike month; recurring still ÷12.
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
    // == year-by-year table math (nominal annual × Dec deflator).
    const tableEarned =
      (ANNUAL.ss + ANNUAL.pensionAnnuity + ANNUAL.partTime) * f;
    expect(yC.earned).toBeCloseTo(tableEarned, 6);
    // NOT a per-month equality — a single month ≈ Yearly ÷ 12.
    expect(monthOf(s.cashflowMonthly, 0).earned).toBeCloseTo(yC.earned / 12, 4);
  });

  it('(c) mid-year SS claim diverges from the annual rollup (table authoritative); engine covers need → no spurious shortfall', () => {
    const input = steadyInput();
    const f = input.viewDeflator(FROM, 11);
    // SS claims May of FROM (Jan-Apr no SS); engine covers net need.
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
    // Monthly prorates the claim; annual rollup authoritative (Σ<annual).
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
    // Literal spike (no ÷12) → displayed shortfall is exactly essNominal·f.
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
    // Yearly is unaffected by the monthly guard.
    expect(cashflowYearly.length).toBeGreaterThan(0);
  });
});

// ── Today's-dollars expense basis ──────────────────────────
// 3% inflation, anchored Jan 2030. `monthFactor(y,m)` is the engine's
// month-precise inflation factor; the nominal expense carries it (the
// OLD sawtooth), the `*Base` field is the flat entered real amount.
const INFL = 1.03;
const monthFactor = (year: number, m: number): number =>
  Math.pow(INFL, (year * 12 + m - FROM * 12) / 12);

/** A today-mode fixture: a single constant **non-glided** real expense
 *  ($24k/yr essential), nominal carrying month-precise inflation,
 *  `*Base` the flat entered amount. Income zeroed so the band is the
 *  pure expense reference; not funded so withdrawal is engine-actual. */
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
    // Nominal: month-precise-inflated run-rate (the OLD sawtooth
    // source). Base: the flat entered $24k/yr — no inflation.
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
    // Jan == Dec exactly: no January reset (the sawtooth is gone).
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
    // A discretionary expense whose REAL run-rate ramps within 2030
    // (12k → declining glide) while inflation also ramps month-precise.
    // base_m = nominal_m ÷ monthFactor(2030,m) exactly.
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
      // Monthly bucket divides the run-rate by 12.
      expect(m.discretionary).toBeCloseTo(
        nominalMonth / monthFactor(FROM, m.month0),
        4,
      );
    }
    // Series follows the real monthly glide ramp — NOT flat (no
    // Jan==Dec for a glide-ramping year), NOT the inflation curve.
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
    // Yearly reads `extendedExpenseRows[*].discretionaryBase`. The
    // inflation-free recompute oracle: annualBase × (1/12) × Σ glide(m)
    // — NOT a scalar nominal ÷ inflationFactor.
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

  it('Monthly year-gate funded today-mode ⇒ per-month plug, shortfallHeight 0', () => {
    // Funded year, no earned income: the displayed plug nets the real
    // expense exactly so the shortfall ribbon stays 0.
    const input = todayFixture();
    for (const [y] of input.fundedByYear) {
      input.fundedByYear.set(y, y < 2032);
    }
    const { cashflowMonthly } = buildCashflowSeries(input);
    const months2030 = cashflowMonthly.filter((r) => r.year === FROM);
    const perMonth = ANNUAL.essential / 12;
    for (const m of months2030) {
      // earned 0 ⇒ plug = real expense; totalIncome == expense.
      expect(m.withdrawal).toBeCloseTo(perMonth, 6);
      expect(m.shortfallHeight).toBe(0);
    }
  });

  it('Monthly year-gate depleted today-mode ⇒ engine perMonthWithdrawal × f, real per-month gap surfaces', () => {
    const input = todayFixture();
    // 2030 depleted: engine covers nothing, no earned income → the
    // real per-month expense is the gap.
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

  it('funded-state, no earned income: Monthly + Yearly real expense exact, shortfall 0', () => {
    const input = todayFixture();
    for (const [y] of input.fundedByYear) {
      input.fundedByYear.set(y, y < 2032);
    }
    const s = buildCashflowSeries(input);
    const perMonth = ANNUAL.essential / 12;
    for (const m of s.cashflowMonthly.filter((r) => r.year === FROM)) {
      expect(m.essential).toBeCloseTo(perMonth, 6);
      expect(m.shortfallHeight).toBe(0);
      expect(m.totalIncome).toBeCloseTo(m.total, 6); // reconciled to need
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
    // No income, no withdrawal, real expense $24k → full real gap.
    expect(yearly2030.essential).toBeCloseTo(ANNUAL.essential, 6);
    expect(yearly2030.shortfallHeight).toBeCloseTo(ANNUAL.essential, 4);
  });

  it('future-mode byte-identical: today→future flip uses the verbatim nominal path', () => {
    // Same fixture, flip only `displayMode`. The future path is the
    // prior nominal × f code; the today branches are not taken.
    const fut = todayFixture({ displayMode: 'future' });
    const today = todayFixture({ displayMode: 'today' });
    const sFut = buildCashflowSeries(fut);
    const sToday = buildCashflowSeries(today);
    // Future expense band is the month-precise-inflated nominal × f
    // (sawtooths); today's is the flat real base — they MUST differ.
    const fut2030 = sFut.cashflowMonthly.filter((r) => r.year === FROM);
    expect(fut2030[0].essential).not.toBeCloseTo(fut2030[11].essential, 2);
    const tod2030 = sToday.cashflowMonthly.filter((r) => r.year === FROM);
    expect(tod2030[0].essential).toBeCloseTo(tod2030[11].essential, 6);
    // Future-mode is byte-identical to the legacy nominal path: build
    // it through the legacy `makeInput` shape (future default) and the
    // monthly nominal series matches.
    expect(fut2030.map((r) => round6(r.essential))).toEqual(
      input2030NominalEssentials(),
    );
  });
});

// ── Taxes band + grossed-up withdrawal ────────────────
/** Set the per-year tax cash for the active years (2030 + 2031). */
function withTax(
  input: CashflowSeriesInput,
  taxNominal: number,
): CashflowSeriesInput {
  for (const [y] of input.taxCashByYear) {
    input.taxCashByYear.set(y, y < 2032 ? taxNominal : 0);
  }
  return input;
}

/** Zero ALL earned-income sources (Yearly split + Monthly stripes) so the
 *  funded plug `max(0, expense + taxes − earned)` reduces to `expense +
 *  taxes` — the gross-up is fully exercised (earned no longer dwarfs it). */
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
    // future-mode so the band is the nominal split × f and the reconcile
    // runs on pure-nominal inputs (homogeneity). Income zeroed so the
    // gross-up is fully exercised; engineWithdrawn = ordinaryNetNeed +
    // taxes so the funded reconcile ties out exactly with the engine.
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
    // Band value = nominal tax × Dec-anchor deflator.
    expect(r.taxes).toBeCloseTo(ANNUAL.taxes * f, 6);
    // Withdrawal grosses up by taxes: max(0, expense + taxes − earned)·f.
    const expectedWdraw = (expenseNom + ANNUAL.taxes - earnedNom) * f;
    expect(r.withdrawal).toBeCloseTo(expectedWdraw, 6);
    // Ties out with the engine's grossed-up `withdrawn` (≤ $1 noise floor).
    expect(Math.abs(r.withdrawal - grossWithdrawn * f)).toBeLessThanOrEqual(1);
    // Stack top + shortfall are taxes-inclusive; funded ⇒ no shortfall.
    expect(r.total).toBeCloseTo((expenseNom + ANNUAL.taxes) * f, 6);
    expect(r.shortfallHeight).toBe(0);
  });

  it('named-strategy MC run with a tax-carrying row funds the band + grosses up the withdrawal', () => {
    // Named-strategy MC now funds tax per path (the upstream suppression guard
    // is gone), so a tax-carrying resolved row lights the band and grosses up
    // the displayed withdrawal exactly like the deterministic engine.
    const input = zeroIncome(withTax(makeInput(), ANNUAL.taxes));
    const earnedNom = 0;
    const expenseNom = ANNUAL.essential + ANNUAL.discretionary;
    const grossWithdrawn = Math.max(0, expenseNom - earnedNom) + ANNUAL.taxes;
    for (const [y] of input.fundedByYear) {
      input.fundedByYear.set(y, y < 2032);
      input.engineWithdrawnByYear.set(y, y < 2032 ? grossWithdrawn : 0);
    }
    const f = input.viewDeflator(FROM, 11);
    const r = buildCashflowSeries(input).cashflowYearly.find(
      (x) => x.year === FROM,
    )!;
    // Band funds: nominal tax × Dec-anchor deflator.
    expect(r.taxes).toBeCloseTo(ANNUAL.taxes * f, 6);
    // Withdrawal grosses up by taxes.
    expect(r.withdrawal).toBeCloseTo((expenseNom + ANNUAL.taxes - earnedNom) * f, 6);
    expect(r.total).toBeCloseTo((expenseNom + ANNUAL.taxes) * f, 6);
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
    // 2030 depleted, no earned income → engine withdrawn is the actual
    // (already grossed-up) drain; band still renders; shortfall absorbs
    // the unfunded gap on the taxes-inclusive expense.
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
    // engine-actual × f (NOT grossed up again — no double-count).
    expect(r.withdrawal).toBeCloseTo(engineActual * f, 6);
    const expenseNom = ANNUAL.essential + ANNUAL.discretionary;
    const expectedShort = (expenseNom + ANNUAL.taxes) * f - r.totalIncome;
    expect(r.shortfallHeight).toBeCloseTo(expectedShort, 4);
    expect(r.taxes).toBeCloseTo(ANNUAL.taxes * f, 6);
  });

  it('monthly today-mode: Σ(12 months) taxes ≈ annual·f (steady state); funded-month plug nets shortfall to 0 with taxes', () => {
    // today-mode so the funded per-month plug `max(0, realExpense +
    // taxesMonth − earned)` runs (the future path is engine-actual, not
    // gated). Income zeroed so the plug nets to the taxes-inclusive
    // expense exactly.
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
    // Steady-state: annual tax allocated flat across 12 months.
    expect(sumTax).toBeCloseTo(ANNUAL.taxes * f, 4);
    // Funded month: plug nets income to the taxes-inclusive expense ⇒ 0.
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

// ── Two-factor deflator split: viewDeflator (earned) ≠ basisDeflator (MC) ──
// Under MC + Today's the displayed `earned` band deflates by `viewDeflator`
// while the MC-sourced taxes + reconciled withdrawal deflate by the path's own
// CPI (`basisDeflator`). The funded reconcile must still tie out
// (`totalIncome == total`), and the `earned` band must reflect `viewDeflator`
// — never the MC factor — or the band and the table diverge.
describe('buildCashflowSeries — earned uses viewDeflator, MC fields use basisDeflator', () => {
  it('funded year with SS income: totalIncome == total AND earned == earnedNominal × viewDeflator', () => {
    // Distinct factors so a mis-wired deflator surfaces immediately.
    const F_VIEW = 0.9;
    const F_MC = 0.5;
    const input = withTax(makeInput({ displayMode: 'today' }), ANNUAL.taxes);
    // SS-only earned income (a funded-year stream); keep it the only source.
    for (const [y] of input.sourceSplitByYear) {
      input.sourceSplitByYear.set(y, {
        ss: y < 2032 ? ANNUAL.ss : 0,
        pensionAnnuity: 0,
        partTime: 0,
        oneOff: 0,
      });
    }
    // Engine-grossed withdrawn = ordinary net need + taxes (nominal), so the
    // funded reconcile reproduces it. earnedNominal = SS only.
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
    // Funded-year invariant: income covers the taxes-inclusive expense.
    expect(r.totalIncome).toBeCloseTo(r.total, 4);
    expect(r.shortfallHeight).toBe(0);
    // The displayed `earned` band uses viewDeflator (0.9), NOT the MC 0.5.
    expect(r.earned).toBeCloseTo(ANNUAL.ss * F_VIEW, 6);
    // The Taxes band + the grossed-up withdrawal use basisDeflator (0.5):
    // expense (real *Base, no deflator) + taxes·fMc − earned·fView.
    expect(r.taxes).toBeCloseTo(ANNUAL.taxes * F_MC, 6);
    const expectedWdraw =
      expenseNom + ANNUAL.taxes * F_MC - ANNUAL.ss * F_VIEW;
    expect(r.withdrawal).toBeCloseTo(expectedWdraw, 4);
  });
});

/** Legacy nominal Monthly essential for 2030 = the month-precise-
 *  inflated run-rate ÷ 12 × the Dec-anchor deflator (the prior code
 *  path, unchanged in future-mode). */
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
