/**
 * Unit tests for the "by category" expense-mode of the cashflow series
 * builder (`buildCashflowSeries` with `categoryBand` present).
 *
 * The load-bearing invariant (the residual allocation): for both
 * display modes and both granularities,
 *   Σ point.byCategory === point.essential + point.discretionary (EXACT)
 * and `point.total` (incl. taxes) + `shortfallHeight` are BYTE-IDENTICAL
 * to the no-category run (they ride on the untouched
 * essential+discretionary+taxes, never re-summed from categories).
 *
 * Also covers: mixed-cadence per-category band values (continuous +
 * one-off in the same period); the zero-total / −100% guard; and the
 * two-factor MC basis case (split rides only on the displayed band, not
 * `basisDeflator`).
 */
import { describe, expect, it } from 'vitest';
import {
  buildCashflowSeries,
  type CashflowSeriesInput,
  type SourceSplit,
} from './cashflow-series';
import { buildViewDeflator } from './view-deflator';
import type {
  ExpenseCategoryMonthlyPoint,
  ExpenseCategoryYearPoint,
  ExpenseProjectionMonthlyPoint,
  ExpenseProjectionPoint,
} from './expense-projection';
import type { IncomeMonthOutput } from './income-projection';
import type { SsMonthOutput } from './ss-projection';

const FROM = 2030;
const END = 2031;

// Two categories: Housing (continuous, $18k/yr essential) + Medical
// (continuous, $12k/yr essential, inflates faster). Their shares should
// sum to the displayed essential+discretionary band exactly.
const HOUSING = 'cat-housing';
const MEDICAL = 'cat-medical';
const ORDER = [HOUSING, MEDICAL] as const;

const ESSENTIAL = 24_000;
const DISCRETIONARY = 6_000;

function ssMonth(year: number, m: number, total: number): SsMonthOutput {
  return {
    fractionalYear: year + m / 12,
    year,
    month0: m,
    total,
    byMember: { primary: total },
  };
}

function incMonth(year: number, m: number): IncomeMonthOutput {
  return {
    fractionalYear: year + m / 12,
    year,
    month0: m,
    pensionIncome: 0,
    partTimeIncome: 0,
    oneOffIncome: 0,
    depositInflow: 0,
    total: 0,
  };
}

function expMonth(year: number, m: number): ExpenseProjectionMonthlyPoint {
  return {
    fractionalYear: year + m / 12,
    year,
    month0: m,
    essential: ESSENTIAL,
    discretionary: DISCRETIONARY,
    total: ESSENTIAL + DISCRETIONARY,
    oneOffEssential: 0,
    oneOffDiscretionary: 0,
    essentialBase: ESSENTIAL,
    discretionaryBase: DISCRETIONARY,
    oneOffEssentialBase: 0,
    oneOffDiscretionaryBase: 0,
  };
}

/** Per-month per-category split: Housing run-rate $18k/yr + Medical
 *  $12k/yr (both continuous) — plus a discretionary $6k spread onto
 *  Housing so Σ = 30k matches the band. */
function catMonth(
  year: number,
  m: number,
  housing: number,
  medical: number,
): ExpenseCategoryMonthlyPoint {
  const by = { [HOUSING]: housing, [MEDICAL]: medical };
  return {
    fractionalYear: year + m / 12,
    year,
    month0: m,
    byCategoryId: by,
    total: housing + medical,
    recurringByCategoryId: by,
    oneOffByCategoryId: {},
  };
}

function catYear(
  year: number,
  housing: number,
  medical: number,
): ExpenseCategoryYearPoint {
  return {
    year,
    byCategoryId: { [HOUSING]: housing, [MEDICAL]: medical },
    total: housing + medical,
  };
}

function buildMonthlySeries(): NonNullable<
  CashflowSeriesInput['monthlySeries']
> {
  const ssMonths: SsMonthOutput[] = [];
  const incomeMonths: IncomeMonthOutput[] = [];
  const expenseMonths: ExpenseProjectionMonthlyPoint[] = [];
  for (let y = FROM; y <= END; y += 1) {
    for (let m = 0; m < 12; m += 1) {
      ssMonths.push(ssMonth(y, m, 24_000));
      incomeMonths.push(incMonth(y, m));
      expenseMonths.push(expMonth(y, m));
    }
  }
  return { ssMonths, incomeMonths, expenseMonths };
}

function catMonthly(): ExpenseCategoryMonthlyPoint[] {
  const out: ExpenseCategoryMonthlyPoint[] = [];
  for (let y = FROM; y <= END; y += 1) {
    for (let m = 0; m < 12; m += 1) {
      // Housing carries 18k essential + 6k discretionary run-rate; Medical
      // 12k essential → Σ run-rate 36k... but the band is 30k. The residual
      // allocation rescales to the band, so absolute scale is irrelevant —
      // only the 2:1-ish ratio matters. Use 18k:12k.
      out.push(catMonth(y, m, 18_000, 12_000));
    }
  }
  return out;
}

function catYearly(): ExpenseCategoryYearPoint[] {
  const out: ExpenseCategoryYearPoint[] = [];
  for (let y = FROM; y <= END; y += 1) out.push(catYear(y, 18_000, 12_000));
  return out;
}

function extendedRows(): ExpenseProjectionPoint[] {
  return [FROM, END].map((y) => ({
    year: y,
    essential: ESSENTIAL,
    discretionary: DISCRETIONARY,
    total: ESSENTIAL + DISCRETIONARY,
    essentialBase: ESSENTIAL,
    discretionaryBase: DISCRETIONARY,
    totalBase: ESSENTIAL + DISCRETIONARY,
  }));
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
    sourceSplitByYear.set(y, {
      ss: 24_000,
      pensionAnnuity: 0,
      partTime: 0,
      oneOff: 0,
    });
    depositsByYear.set(y, 0);
    engineWithdrawnByYear.set(y, 9_000);
    taxCashByYear.set(y, 5_000);
    fundedByYear.set(y, false);
  }
  const perMonth = new Float64Array(24);
  for (let i = 0; i < 24; i += 1) perMonth[i] = 9_000 / 12;
  const deflator = buildViewDeflator('future', {
    nowYear: FROM,
    nowMonthIndex: 0,
    inflationPct: 3,
  });
  return {
    fromYear: FROM,
    drawdownEndYear: END,
    sourceSplitByYear,
    depositsByYear,
    extendedExpenseRows: extendedRows(),
    displayMode: 'future',
    engineWithdrawnByYear,
    fundedByYear,
    taxCashByYear,
    perMonthWithdrawal: perMonth,
    monthlySeries: buildMonthlySeries(),
    categoryBand: {
      monthly: catMonthly(),
      yearly: catYearly(),
      categoryOrder: [...ORDER],
    },
    viewDeflator: deflator,
    basisDeflator: (year: number) => deflator(year, 11),
    ...overrides,
  };
}

function sumBy(by: Record<string, number> | undefined): number {
  if (!by) return 0;
  return Object.values(by).reduce((a, b) => a + b, 0);
}

describe('buildCashflowSeries — by-category tie-out invariant', () => {
  for (const displayMode of ['today', 'future'] as const) {
    it(`Σ byCategory === essential+discretionary exactly (${displayMode}, both granularities)`, () => {
      const { cashflowMonthly, cashflowYearly } = buildCashflowSeries(
        makeInput({ displayMode }),
      );
      for (const rows of [cashflowMonthly, cashflowYearly]) {
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) {
          expect(r.byCategory).toBeDefined();
          // EXACT equality (===, no tolerance) by residual allocation.
          expect(sumBy(r.byCategory)).toBe(r.essential + r.discretionary);
        }
      }
    });
  }

  it('total + shortfallHeight are byte-identical to the no-category run', () => {
    const withCat = buildCashflowSeries(makeInput());
    const noCat = buildCashflowSeries(makeInput({ categoryBand: undefined }));
    for (const key of ['cashflowMonthly', 'cashflowYearly'] as const) {
      const a = withCat[key];
      const b = noCat[key];
      expect(a.length).toBe(b.length);
      for (let i = 0; i < a.length; i += 1) {
        expect(a[i].total).toBe(b[i].total);
        expect(a[i].shortfallHeight).toBe(b[i].shortfallHeight);
        expect(a[i].essential).toBe(b[i].essential);
        expect(a[i].discretionary).toBe(b[i].discretionary);
        expect(a[i].taxes).toBe(b[i].taxes);
        // The no-category run carries no byCategory map.
        expect(b[i].byCategory).toBeUndefined();
      }
    }
  });

  it('no -0 in any byCategory value', () => {
    const { cashflowYearly } = buildCashflowSeries(makeInput());
    for (const r of cashflowYearly) {
      for (const v of Object.values(r.byCategory ?? {})) {
        expect(Object.is(v, -0)).toBe(false);
      }
    }
  });
});

describe('buildCashflowSeries — mixed-cadence per-category', () => {
  it('Monthly: a continuous category + a one-off category in the same month weight by monthlyBucket, not raw run-rate', () => {
    // One month with Housing continuous ($18k/yr run-rate → $1,500/mo via
    // monthlyBucket) and Medical a $12k one-off spike (literal $12k that
    // month). monthlyBucket(recurring=12k, spike=12k) === 12k (the whole
    // amount stays literal, NOT ÷12). So the share weights are 1,500 :
    // 12,000 — Medical dominates the month, the correct cadence weight.
    const monthly: ExpenseCategoryMonthlyPoint[] = [];
    for (let y = FROM; y <= END; y += 1) {
      for (let m = 0; m < 12; m += 1) {
        const spikeMonth = y === FROM && m === 5; // Jun 2030
        monthly.push({
          fractionalYear: y + m / 12,
          year: y,
          month0: m,
          byCategoryId: spikeMonth
            ? { [HOUSING]: 18_000, [MEDICAL]: 12_000 }
            : { [HOUSING]: 18_000, [MEDICAL]: 0 },
          total: spikeMonth ? 30_000 : 18_000,
          recurringByCategoryId: spikeMonth
            ? { [HOUSING]: 18_000, [MEDICAL]: 12_000 }
            : { [HOUSING]: 18_000, [MEDICAL]: 0 },
          oneOffByCategoryId: spikeMonth ? { [MEDICAL]: 12_000 } : {},
        });
      }
    }
    const input = makeInput({
      categoryBand: { monthly, yearly: catYearly(), categoryOrder: [...ORDER] },
    });
    const { cashflowMonthly } = buildCashflowSeries(input);
    const jun = cashflowMonthly.find(
      (r) => r.year === FROM && r.month0 === 5,
    )!;
    // Band: essential+discretionary monthly = 30k/12 = 2,500.
    const band = jun.essential + jun.discretionary;
    // Share weights: Housing monthlyBucket(18k,0)=1,500; Medical
    // monthlyBucket(12k,12k)=12,000. Medical share = 12000/13500.
    const medicalShare = (12_000 / 13_500) * band;
    expect(jun.byCategory![MEDICAL]).toBeCloseTo(medicalShare, 6);
    // Σ still exact.
    expect(sumBy(jun.byCategory)).toBe(band);
    // A non-spike month: Medical contributes 0 (run-rate 0).
    const jul = cashflowMonthly.find(
      (r) => r.year === FROM && r.month0 === 6,
    )!;
    expect(jul.byCategory![MEDICAL] ?? 0).toBe(0);
  });
});

describe('buildCashflowSeries — zero-total + -100% guard', () => {
  it('a period with no expense emits empty byCategory', () => {
    const monthly = catMonthly().map((r) => ({
      ...r,
      byCategoryId: { [HOUSING]: 0, [MEDICAL]: 0 },
      recurringByCategoryId: { [HOUSING]: 0, [MEDICAL]: 0 },
      total: 0,
    }));
    const expenseMonths = buildMonthlySeries().expenseMonths.map((r) => ({
      ...r,
      essential: 0,
      discretionary: 0,
      total: 0,
      essentialBase: 0,
      discretionaryBase: 0,
    }));
    const input = makeInput({
      monthlySeries: { ...buildMonthlySeries(), expenseMonths },
      categoryBand: { monthly, yearly: catYearly(), categoryOrder: [...ORDER] },
    });
    const { cashflowMonthly } = buildCashflowSeries(input);
    for (const r of cashflowMonthly) {
      expect(r.essential + r.discretionary).toBe(0);
      expect(r.byCategory).toEqual({});
    }
  });
});

describe('buildCashflowSeries — orphan-category redistribution (deleted category)', () => {
  const ORPHAN = 'cat-orphan';

  it('redistributes spend from a category absent from categoryOrder across the present ones (Σ === band, orphan absent)', () => {
    // A third category (catOrphan) carries real spend in the band-basis
    // per-category maps, but `categoryOrder` lists only the two present
    // categories — simulating an expense whose category was deleted, so
    // `assembleCategoryMeta` dropped it from categoryMeta/categoryOrder.
    const yearly: ExpenseCategoryYearPoint[] = [];
    for (let y = FROM; y <= END; y += 1) {
      yearly.push({
        year: y,
        byCategoryId: { [HOUSING]: 18_000, [MEDICAL]: 12_000, [ORPHAN]: 10_000 },
        total: 40_000,
      });
    }
    const monthly: ExpenseCategoryMonthlyPoint[] = [];
    for (let y = FROM; y <= END; y += 1) {
      for (let m = 0; m < 12; m += 1) {
        const by = { [HOUSING]: 18_000, [MEDICAL]: 12_000, [ORPHAN]: 10_000 };
        monthly.push({
          fractionalYear: y + m / 12,
          year: y,
          month0: m,
          byCategoryId: by,
          total: 40_000,
          recurringByCategoryId: by,
          oneOffByCategoryId: {},
        });
      }
    }
    const input = makeInput({
      // categoryOrder EXCLUDES the orphan id (only HOUSING + MEDICAL present).
      categoryBand: { monthly, yearly, categoryOrder: [...ORDER] },
    });
    const { cashflowYearly } = buildCashflowSeries(input);
    expect(cashflowYearly.length).toBeGreaterThan(0);
    for (const r of cashflowYearly) {
      const band = r.essential + r.discretionary;
      // The FULL band is still allocated across the present categories
      // (Σ === band exactly) — the orphan's 10k share is silently
      // redistributed across Housing + Medical, overstating them.
      expect(sumBy(r.byCategory)).toBe(band);
      // The orphan id never appears as a result key.
      expect(r.byCategory).toBeDefined();
      expect(Object.keys(r.byCategory!)).toEqual([HOUSING, MEDICAL]);
      expect(r.byCategory![ORPHAN]).toBeUndefined();
    }
  });
});

describe('buildCashflowSeries — two-factor MC basis', () => {
  it('the category split rides on the displayed band, not basisDeflator', () => {
    // viewDeflator (earned band) ≠ basisDeflator (MC withdrawal/taxes).
    const viewDeflator = buildViewDeflator('today', {
      nowYear: FROM,
      nowMonthIndex: 0,
      inflationPct: 0,
    });
    // A path CPI that diverges from the flat view deflator.
    const basisDeflator = (year: number): number =>
      1 / Math.pow(1.07, year - FROM);
    const input = makeInput({
      displayMode: 'today',
      viewDeflator,
      basisDeflator,
    });
    const { cashflowYearly } = buildCashflowSeries(input);
    for (const r of cashflowYearly) {
      // Tie-out holds regardless of the divergent basisDeflator.
      expect(sumBy(r.byCategory)).toBe(r.essential + r.discretionary);
    }
  });
});
