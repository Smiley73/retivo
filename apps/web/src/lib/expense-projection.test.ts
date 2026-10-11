/**
 * Engine tests for the chart-band math. Locks the inclusive-start /
 * exclusive-end rule, month proration, COBRA + duration windows, the
 * one-off semantic, and the discretionary multiplier window.
 */
import { describe, expect, it } from 'vitest';
import {
  buildExpenseProjectionContext,
  projectExpensesByCategoryMonth,
  projectExpensesByCategoryYear,
  projectExpensesByMonth,
  projectExpensesByYear,
  type ProjectionContext,
} from './expense-projection';
import type { ResolvedExpense } from './expense-resolution';
import type { ExpensePayload } from '../db/types';

const baseCtx = (overrides: Partial<ProjectionContext> = {}): ProjectionContext => ({
  todayYear: 2026,
  retirementYear: 2030,
  primary: { birthdate: '1965-03-12' },
  secondary: { birthdate: '1968-09-03' },
  ...overrides,
});

const expense = (
  id: string,
  source: ResolvedExpense['source'],
  payload: Partial<ExpensePayload>,
): ResolvedExpense => ({
  id,
  source,
  payload: {
    name: id,
    amount: 0,
    frequency: 'monthly',
    classification: 'essential',
    categoryId: 'cat-x',
    start: { kind: 'retirementStart' },
    end: { kind: 'lifetime', whose: 'last' },
    ...payload,
  },
});

describe('projectExpensesByYear — month proration', () => {
  it('age start in March 2030 → 10 active months in 2030 + full year afterward', () => {
    // Primary born March 12, 1965 → age 65 starts March 2030.
    const exp = expense('e', 'canonical', {
      amount: 1000, // /month
      frequency: 'monthly',
      classification: 'essential',
      start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      end: { kind: 'lifetime', whose: 'primary' },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    // Inflation off so we can read the raw numbers.
    ctx.inflation = { ratePct: 0 };
    const out = projectExpensesByYear([exp], ctx, { from: 2029, to: 2031 });
    // ratePct: 0 ⇒ base == nominal (inflation is the only difference).
    expect(out[0]).toEqual({
      year: 2029,
      essential: 0,
      discretionary: 0,
      total: 0,
      essentialBase: 0,
      discretionaryBase: 0,
      totalBase: 0,
    });
    // 1000 × 12 × (10/12) = 10,000.
    expect(out[1]).toEqual({
      year: 2030,
      essential: 10000,
      discretionary: 0,
      total: 10000,
      essentialBase: 10000,
      discretionaryBase: 0,
      totalBase: 10000,
    });
    // 1000 × 12 × (12/12) = 12,000.
    expect(out[2]).toEqual({
      year: 2031,
      essential: 12000,
      discretionary: 0,
      total: 12000,
      essentialBase: 12000,
      discretionaryBase: 0,
      totalBase: 12000,
    });
  });

  it('year-kind end is inclusive of year Y: zero starting Y+1', () => {
    // "ends in year Y" → exclusive boundary at Jan 1 of (Y+1), so year
    // Y is fully active and year Y+1 is fully off.
    const exp = expense('e', 'canonical', {
      amount: 1200, // /year
      frequency: 'yearly',
      start: { kind: 'year', year: 2030 },
      end: { kind: 'year', year: 2034 },
    });
    const ctx = baseCtx();
    ctx.inflation = { ratePct: 0 };
    const out = projectExpensesByYear([exp], ctx, { from: 2034, to: 2035 });
    expect(out[0].total).toBe(1200); // year 2034 still fully active
    expect(out[1].total).toBe(0); // year 2035: exclusive boundary at Jan 1
  });
});

describe('projectExpensesByYear — COBRA-shape', () => {
  it('endOfRetirementYear(0) clips to Dec of retirement year regardless of start month', () => {
    // Retirement starts March 2030. COBRA ends end-of-2030.
    const exp = expense('cobra', 'canonical', {
      amount: 1400, // /month
      frequency: 'monthly',
      start: { kind: 'age', memberId: 'primary', years: 65, months: 0 }, // Mar 2030
      end: { kind: 'endOfRetirementYear', offsetYears: 0 },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    const out = projectExpensesByYear([exp], ctx, { from: 2030, to: 2032 });
    // 2030: months Mar–Dec = 10. 1400 × 12 × 10/12 = 14,000.
    expect(out[0].total).toBe(14000);
    // 2031+: exclusive boundary = Jan 1 2031, so zero from 2031 on.
    expect(out[1].total).toBe(0);
    expect(out[2].total).toBe(0);
  });
});

describe('projectExpensesByYear — durationFromStart', () => {
  it('clips at start + N months', () => {
    // Retirement starts March 2030; durationFromStart(months: 18) →
    // exclusive end = Sep 2031 (Mar 2030 + 18 mo).
    const exp = expense('exp', 'canonical', {
      amount: 100, // /month
      frequency: 'monthly',
      start: { kind: 'age', memberId: 'primary', years: 65, months: 0 }, // Mar 2030
      end: { kind: 'durationFromStart', months: 18 },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    const out = projectExpensesByYear([exp], ctx, { from: 2030, to: 2032 });
    // 2030: Mar–Dec = 10 months. 100 × 12 × 10/12 = 1000.
    expect(out[0].total).toBe(1000);
    // 2031: Jan–Aug = 8 months. 100 × 12 × 8/12 = 800.
    expect(out[1].total).toBe(800);
    // 2032: 0.
    expect(out[2].total).toBe(0);
  });
});

describe('projectExpensesByYear — one-off', () => {
  it('appears in event year only', () => {
    const exp = expense('car', 'canonical', {
      amount: 40000,
      frequency: 'oneOff',
      classification: 'discretionary',
      start: { kind: 'year', year: 2034 },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    const out = projectExpensesByYear([exp], ctx, { from: 2033, to: 2035 });
    expect(out[0].total).toBe(0);
    expect(out[1].total).toBe(40000);
    expect(out[1].discretionary).toBe(40000);
    expect(out[2].total).toBe(0);
  });
});

describe('projectExpensesByYear — discretionary adjustment', () => {
  it('applies only to discretionary classification, only inside the window', () => {
    const ess = expense('rent', 'canonical', {
      amount: 100,
      frequency: 'yearly',
      classification: 'essential',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const disc = expense('travel', 'canonical', {
      amount: 100,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    ctx.discretionarySpending = { bumpPct: 25, durationYears: 10 };
    const out = projectExpensesByYear([ess, disc], ctx, { from: 2030, to: 2041 });
    // Years 2030-2039: discretionary = 100 × 1.25 = 125.
    for (let y = 2030; y <= 2039; y++) {
      const row = out[y - 2030];
      expect(row.essential).toBe(100);
      expect(row.discretionary).toBe(125);
    }
    // Year 2040: outside the 10-year window (years_since_retirement = 10).
    const out2040 = out[10];
    expect(out2040.year).toBe(2040);
    expect(out2040.essential).toBe(100);
    expect(out2040.discretionary).toBe(100);
  });

  it('whole-retirement bump (durationYears = null) applies to every retirement year', () => {
    const disc = expense('travel', 'canonical', {
      amount: 100,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    ctx.discretionarySpending = { bumpPct: 50, durationYears: null };
    const out = projectExpensesByYear([disc], ctx, { from: 2030, to: 2050 });
    expect(out.every((p) => p.discretionary === 150)).toBe(true);
  });

  it('negative bumpPct (-50) produces a ×0.5 multiplier on discretionary expenses', () => {
    const disc = expense('travel', 'canonical', {
      amount: 100,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    ctx.discretionarySpending = { bumpPct: -50, durationYears: null };
    const out = projectExpensesByYear([disc], ctx, { from: 2030, to: 2035 });
    expect(out.every((p) => p.discretionary === 50)).toBe(true);
  });

  it('bumpPct = -100 zeros discretionary spending (floor at ×0)', () => {
    const disc = expense('travel', 'canonical', {
      amount: 100,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    ctx.discretionarySpending = { bumpPct: -100, durationYears: null };
    const out = projectExpensesByYear([disc], ctx, { from: 2030, to: 2035 });
    expect(out.every((p) => p.discretionary === 0)).toBe(true);
  });

  it('clamp: stored bumpPct 150 treated as 100 (×2.0 not ×2.5)', () => {
    const disc = expense('travel', 'canonical', {
      amount: 100,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    ctx.discretionarySpending = { bumpPct: 150, durationYears: null };
    const out = projectExpensesByYear([disc], ctx, { from: 2030, to: 2031 });
    // Clamped to 100 → multiplier 2.0, not 2.5.
    expect(out[0].discretionary).toBe(200);
  });

  it('clamp: stored bumpPct -150 treated as -100 (×0.0 not negative)', () => {
    const disc = expense('travel', 'canonical', {
      amount: 100,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    ctx.discretionarySpending = { bumpPct: -150, durationYears: null };
    const out = projectExpensesByYear([disc], ctx, { from: 2030, to: 2031 });
    // Clamped to -100 → multiplier 0.0, not -0.5.
    expect(out[0].discretionary).toBe(0);
  });
});

describe('projectExpensesByYear — inflation (today-anchored)', () => {
  it('compounds from todayYear forward (and back, for years before today)', () => {
    // Amounts are today's-dollar values. Factor at
    // year Y = mean of the 12 monthly factors for that year, anchored
    // at todayMonthIndex (defaults to 0 / Jan).
    const exp = expense('e', 'canonical', {
      amount: 100,
      frequency: 'yearly',
      start: { kind: 'year', year: 2026 },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const ctx = baseCtx({ todayYear: 2026, retirementYear: 2030 });
    ctx.inflation = { ratePct: 3 };
    const out = projectExpensesByYear([exp], ctx, { from: 2028, to: 2033 });
    const meanFactor = (year: number): number => {
      let sum = 0;
      for (let m = 0; m < 12; m += 1) sum += Math.pow(1.03, ((year - 2026) * 12 + m) / 12);
      return sum / 12;
    };
    expect(out[0].year).toBe(2028);
    expect(out[0].total).toBeCloseTo(100 * meanFactor(2028), 2);
    expect(out[1].total).toBeCloseTo(100 * meanFactor(2029), 2);
    expect(out[2].year).toBe(2030);
    expect(out[2].total).toBeCloseTo(100 * meanFactor(2030), 2);
    expect(out[5].total).toBeCloseTo(100 * meanFactor(2033), 2);
  });

  it('defaults to 3% when inflation is unset', () => {
    const exp = expense('e', 'canonical', {
      amount: 100,
      frequency: 'yearly',
      start: { kind: 'year', year: 2026 },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const ctx = baseCtx({ todayYear: 2026, retirementYear: 2030 });
    const out = projectExpensesByYear([exp], ctx, { from: 2030, to: 2031 });
    // year-mean factor for 2030 (4 years from todayYear=2026 anchor)
    // and 2031 (5 years).
    const meanFactor = (year: number): number => {
      let sum = 0;
      for (let m = 0; m < 12; m += 1) sum += Math.pow(1.03, ((year - 2026) * 12 + m) / 12);
      return sum / 12;
    };
    expect(out[0].total).toBeCloseTo(100 * meanFactor(2030), 2);
    expect(out[1].total).toBeCloseTo(100 * meanFactor(2031), 2);
  });

  it('ratePct: 0 keeps factor at 1.0 across all years (Expenses chart contract)', () => {
    // The Expenses page passes ratePct: 0 so the chart shows the
    // canonical schedule at face value. With a zero rate the year-mean
    // factor collapses to 1.0 regardless of anchor offset.
    const exp = expense('e', 'canonical', {
      amount: 200,
      frequency: 'yearly',
      start: { kind: 'year', year: 2026 },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const ctx = baseCtx({ todayYear: 2026, retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    const out = projectExpensesByYear([exp], ctx, { from: 2026, to: 2040 });
    expect(out.every((p) => p.total === 200)).toBe(true);
  });

  it('years before todayYear deflate (factor < 1)', () => {
    // Today=2026 with 3% inflation. Year 2022 lies 4 years before the
    // anchor → factor < 1 (the engine treats the entered amount as
    // today's dollars, so 2022 is "what would $100 today have been
    // worth back then").
    const exp = expense('e', 'canonical', {
      amount: 100,
      frequency: 'yearly',
      start: { kind: 'year', year: 2022 },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const ctx = baseCtx({ todayYear: 2026, retirementYear: 2022 });
    ctx.inflation = { ratePct: 3 };
    const out = projectExpensesByYear([exp], ctx, { from: 2022, to: 2026 });
    expect(out[0].total).toBeLessThan(100); // 2022 — 4y before anchor
    // 2026 is the anchor year — year-mean factor averages factors
    // (1.03)^(0/12) … (1.03)^(11/12) ≈ 1.0137 → ~$101.37.
    expect(out[4].total).toBeGreaterThan(100);
    expect(out[4].total).toBeLessThan(102);
  });

  it('one-off events inflate from today to the event month', () => {
    // Pre- vs post-retirement one-offs treat the entered amount as
    // today's dollars and compound to the event month. A 2028 event
    // at 3% inflation from 2026 anchor lands at ~100 * 1.03^2.
    const exp = expense('roof', 'canonical', {
      amount: 10000,
      frequency: 'oneOff',
      classification: 'discretionary',
      start: { kind: 'year', year: 2028 },
    });
    const ctx = baseCtx({ todayYear: 2026, retirementYear: 2030 });
    ctx.inflation = { ratePct: 3 };
    const out = projectExpensesByYear([exp], ctx, { from: 2028, to: 2028 });
    expect(out[0].total).toBeCloseTo(10000 * Math.pow(1.03, 2), 2);
  });

  it('non-Jan as-of-month uses month-precise exponent (pinned defect)', () => {
    // Anchor = June 2026 (todayMonthIndex: 5). A flat $100/yr expense
    // active from Jan 2026 in year 2028 → exponent = (2028*12 + 0..11
    // − (2026*12 + 5)) / 12 averaged → factor differs from a Jan-anchor
    // baseline.
    const exp = expense('e', 'canonical', {
      amount: 100,
      frequency: 'yearly',
      start: { kind: 'year', year: 2026 },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const ctx: ProjectionContext = {
      todayYear: 2026,
      todayMonthIndex: 5,
      retirementYear: 2030,
      primary: { birthdate: '1965-03-12' },
      secondary: { birthdate: '1968-09-03' },
      inflation: { ratePct: 3 },
    };
    const out = projectExpensesByYear([exp], ctx, { from: 2028, to: 2028 });
    // Manual year-mean factor with non-Jan anchor.
    let expected = 0;
    for (let m = 0; m < 12; m += 1) {
      expected += Math.pow(1.03, ((2028 * 12 + m) - (2026 * 12 + 5)) / 12);
    }
    expected = (100 * expected) / 12;
    expect(out[0].total).toBeCloseTo(expected, 2);
    // And it must differ from the Jan-anchored result by a non-trivial
    // amount — proves the asOfMonth is being read, not retirementYear.
    const janCtx: ProjectionContext = { ...ctx, todayMonthIndex: 0 };
    const janOut = projectExpensesByYear([exp], janCtx, { from: 2028, to: 2028 });
    expect(Math.abs(out[0].total - janOut[0].total)).toBeGreaterThan(0.5);
  });
});

describe('projectExpensesByMonth — month-precise transitions', () => {
  it('continuous expense steps up at start month and back to zero at end month', () => {
    // Primary born March 12, 1965 → age 65 starts March 2030.
    // Lifetime-primary end resolves to (1965 + 90, March) = March 2055
    // (DEFAULT_LIFE_EXPECTANCY_AGE = 90). We just verify the start edge
    // here; the death edge is covered separately.
    const exp = expense('e', 'canonical', {
      amount: 1000,
      frequency: 'monthly',
      classification: 'essential',
      start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      end: { kind: 'lifetime', whose: 'primary' },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    const out = projectExpensesByMonth([exp], ctx, { from: 2030, to: 2030 });
    // Jan/Feb 2030 — pre-start, zero.
    expect(out[0]).toMatchObject({ year: 2030, month0: 0, total: 0 });
    expect(out[1]).toMatchObject({ year: 2030, month0: 1, total: 0 });
    // March 2030 onward — active at $1000/mo × 12 = $12000/yr rate.
    for (let m = 2; m < 12; m++) {
      expect(out[m]).toMatchObject({
        year: 2030,
        month0: m,
        essential: 12000,
        total: 12000,
      });
    }
  });

  it('continuous expense lifetime end runs through December of the death year', () => {
    // Primary born March 12, 1965; default life expectancy 95 →
    // deathYear = 2060. Death = Dec 31 of deathYear, so the line stays
    // active through all of 2060 (Dec) and drops to zero from Jan 2061.
    const exp = expense('e', 'canonical', {
      amount: 1000,
      frequency: 'monthly',
      classification: 'essential',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'primary' },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    const out2060 = projectExpensesByMonth([exp], ctx, { from: 2060, to: 2060 });
    // Every month of the death year (2060) is still active.
    for (let m = 0; m < 12; m++) {
      expect(out2060[m].total).toBe(12000);
    }
    // 2061 — past the exclusive boundary (Jan 1 of deathYear + 1).
    const out2061 = projectExpensesByMonth([exp], ctx, { from: 2061, to: 2061 });
    for (let m = 0; m < 12; m++) {
      expect(out2061[m].total).toBe(0);
    }
  });

  it('one-off renders at literal amount for exactly one month', () => {
    const exp = expense('car', 'canonical', {
      amount: 40000,
      frequency: 'oneOff',
      classification: 'discretionary',
      // Year-anchored one-off resolves to January.
      start: { kind: 'year', year: 2034 },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    const out = projectExpensesByMonth([exp], ctx, { from: 2034, to: 2034 });
    expect(out[0]).toMatchObject({
      year: 2034,
      month0: 0,
      discretionary: 40000,
      total: 40000,
    });
    for (let m = 1; m < 12; m++) {
      expect(out[m].total).toBe(0);
    }
  });

  it('age-anchored one-off renders on the resolved birthday month at literal amount', () => {
    // Primary born March 12, 1965 → age 70 spike in March 2035.
    const exp = expense('sabbatical', 'canonical', {
      amount: 25000,
      frequency: 'oneOff',
      classification: 'discretionary',
      start: { kind: 'age', memberId: 'primary', years: 70, months: 0 },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    const out = projectExpensesByMonth([exp], ctx, { from: 2035, to: 2035 });
    // March = month0 2.
    expect(out[2]).toMatchObject({
      year: 2035,
      month0: 2,
      discretionary: 25000,
      total: 25000,
    });
    // Every other month — zero.
    for (let m = 0; m < 12; m++) {
      if (m === 2) continue;
      expect(out[m].total).toBe(0);
    }
  });

  it('retirementStart honors ctx.retirementMonth0 so monthly chart aligns with the retirement marker', () => {
    // Retirement Mar 12, 2030 → retirementMonth0 = 2 (March). A
    // retirementStart-anchored monthly expense should start in March
    // 2030, not January 2030 — so the chart's step-up lands on the
    // same x as the retirement vertical bar.
    const exp = expense('rent', 'canonical', {
      amount: 2000,
      frequency: 'monthly',
      classification: 'essential',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const ctx = baseCtx({ retirementYear: 2030, retirementMonth0: 2 });
    ctx.inflation = { ratePct: 0 };
    const out = projectExpensesByMonth([exp], ctx, { from: 2030, to: 2030 });
    // Jan, Feb 2030 — pre-retirement, zero.
    expect(out[0].total).toBe(0);
    expect(out[1].total).toBe(0);
    // March 2030 onward — active.
    for (let m = 2; m < 12; m++) {
      expect(out[m].total).toBe(24000); // $2000 × 12 annualized rate
    }
  });

  it('fractionalYear = year + month0/12', () => {
    const exp = expense('e', 'canonical', {
      amount: 100,
      frequency: 'yearly',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    const out = projectExpensesByMonth([exp], ctx, { from: 2030, to: 2030 });
    expect(out[0].fractionalYear).toBeCloseTo(2030, 6);
    expect(out[6].fractionalYear).toBeCloseTo(2030.5, 6);
    expect(out[11].fractionalYear).toBeCloseTo(2030 + 11 / 12, 6);
  });
});

describe('projectExpensesByMonth — annual rollup invariant', () => {
  // For every continuous or one-off case, the annual sum from
  // projectExpensesByYear must equal the integral of the monthly
  // rates over the same year:
  //   annual = mean(rate_m) for m=0..11.
  const yearlySum = (
    pts: ReturnType<typeof projectExpensesByMonth>,
    year: number,
  ): { essential: number; discretionary: number; total: number } => {
    const inYear = pts.filter((p) => p.year === year);
    const mean = (key: 'essential' | 'discretionary' | 'total'): number =>
      inYear.reduce((acc, p) => acc + p[key], 0) / 12;
    return {
      essential: mean('essential'),
      discretionary: mean('discretionary'),
      total: mean('total'),
    };
  };

  it('matches projectExpensesByYear for mid-year-start continuous expense', () => {
    const exp = expense('e', 'canonical', {
      amount: 1000,
      frequency: 'monthly',
      classification: 'essential',
      start: { kind: 'age', memberId: 'primary', years: 65, months: 0 }, // Mar 2030
      end: { kind: 'lifetime', whose: 'primary' },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    const monthly = projectExpensesByMonth([exp], ctx, { from: 2030, to: 2031 });
    const annual = projectExpensesByYear([exp], ctx, { from: 2030, to: 2031 });
    expect(yearlySum(monthly, 2030).total).toBeCloseTo(annual[0].total, 6);
    expect(yearlySum(monthly, 2031).total).toBeCloseTo(annual[1].total, 6);
  });

  it('one-off divergence in event year: monthly chart-mean = amount/12, annual fn = amount', () => {
    // The monthly chart intentionally renders one-offs at literal
    // amount for one month so the y-axis reads honestly. Annual rollup
    // therefore diverges by `amount × 11/12` in the event year; the
    // year-by-year table (annual fn) stays the source of truth.
    const exp = expense('car', 'canonical', {
      amount: 40000,
      frequency: 'oneOff',
      classification: 'discretionary',
      start: { kind: 'year', year: 2034 },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    const monthly = projectExpensesByMonth([exp], ctx, { from: 2034, to: 2034 });
    const annual = projectExpensesByYear([exp], ctx, { from: 2034, to: 2034 });
    expect(annual[0].total).toBe(40000);
    // Monthly mean = 40000 / 12 ≈ 3333.33; not equal to annual.
    expect(yearlySum(monthly, 2034).total).toBeCloseTo(40000 / 12, 2);
  });

  it('matches projectExpensesByYear with discretionary adjustment window', () => {
    const disc = expense('travel', 'canonical', {
      amount: 100,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    ctx.discretionarySpending = { bumpPct: 25, durationYears: 10 };
    const monthly = projectExpensesByMonth([disc], ctx, { from: 2030, to: 2041 });
    const annual = projectExpensesByYear([disc], ctx, { from: 2030, to: 2041 });
    for (const a of annual) {
      const m = yearlySum(monthly, a.year);
      expect(m.discretionary).toBeCloseTo(a.discretionary, 6);
      expect(m.total).toBeCloseTo(a.total, 6);
    }
  });

  it('matches projectExpensesByYear with non-zero inflation', () => {
    const exp = expense('e', 'canonical', {
      amount: 100,
      frequency: 'yearly',
      start: { kind: 'year', year: 2026 },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const ctx = baseCtx({ todayYear: 2026, retirementYear: 2030 });
    ctx.inflation = { ratePct: 3 };
    const monthly = projectExpensesByMonth([exp], ctx, { from: 2028, to: 2035 });
    const annual = projectExpensesByYear([exp], ctx, { from: 2028, to: 2035 });
    for (const a of annual) {
      // Tolerance 2 (= ±0.005) accounts for the annual function's
      // round2() truncation; the underlying invariant (mean of 12
      // monthly amounts ≡ annual total) holds exactly to FP precision
      // before rounding.
      expect(yearlySum(monthly, a.year).total).toBeCloseTo(a.total, 2);
    }
  });
});

describe('projectExpensesByCategoryMonth', () => {
  it('buckets monthly contributions by categoryId', () => {
    const rent = expense('rent', 'canonical', {
      amount: 2000,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: 'cat-housing',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const groceries = expense('groceries', 'canonical', {
      amount: 800,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: 'cat-food',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const travel = expense('travel', 'canonical', {
      amount: 12000,
      frequency: 'yearly',
      classification: 'discretionary',
      categoryId: 'cat-travel',
      start: { kind: 'retirementStart' },
      end: { kind: 'durationFromStart', months: 120 },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    const out = projectExpensesByCategoryMonth([rent, groceries, travel], ctx, {
      from: 2030,
      to: 2030,
    });
    expect(out[0].byCategoryId).toEqual({
      'cat-housing': 24000, // $2000 × 12 annualised
      'cat-food': 9600, // $800 × 12 annualised
      'cat-travel': 12000, // $12000/yr
    });
    expect(out[0].total).toBe(45600);
  });

  it('applies discretionary adjustment to discretionary-classified categories only', () => {
    const ess = expense('rent', 'canonical', {
      amount: 100,
      frequency: 'yearly',
      classification: 'essential',
      categoryId: 'cat-housing',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const disc = expense('travel', 'canonical', {
      amount: 100,
      frequency: 'yearly',
      classification: 'discretionary',
      categoryId: 'cat-travel',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    ctx.discretionarySpending = { bumpPct: 25, durationYears: 10 };
    const out = projectExpensesByCategoryMonth([ess, disc], ctx, {
      from: 2030,
      to: 2030,
    });
    expect(out[0].byCategoryId['cat-housing']).toBe(100);
    expect(out[0].byCategoryId['cat-travel']).toBe(125);
  });
});

describe('projectExpensesByYear — scenario-only expenses with zero canonical', () => {
  // Empty canonical no longer blocks projections.
  // The Balance Projection page used to gate the cashflow chart on
  // `canonicalExpenses.length === 0`, suppressing rendering entirely
  // when a scenario carried only `added` entries. With the resolver
  // upstream and a fixed timeline anchor, scenario-only `added`
  // resolved expenses must produce non-zero projection rows.
  it('emits non-zero rows for a scenario-only added expense with empty canonical input', () => {
    const scenarioOnly = expense('local-1', 'added', {
      amount: 500, // $500/mo
      frequency: 'monthly',
      classification: 'essential',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const out = projectExpensesByYear(
      [scenarioOnly],
      baseCtx({ inflation: { ratePct: 0 } }),
      { from: 2030, to: 2032 },
    );
    expect(out).toHaveLength(3);
    expect(out.every((p) => p.total > 0)).toBe(true);
    expect(out[0].total).toBeCloseTo(500 * 12, 2);
  });

  it('returns explicit zero-rows when neither canonical nor scenario-only expenses exist', () => {
    const out = projectExpensesByYear([], baseCtx({ inflation: { ratePct: 0 } }), {
      from: 2030,
      to: 2032,
    });
    expect(out).toHaveLength(3);
    expect(out.every((p) => p.total === 0)).toBe(true);
  });
});

describe('projectExpensesByYear — broken anchors', () => {
  it('skips an age-anchored expense whose member is missing', () => {
    const exp = expense('e', 'canonical', {
      amount: 100,
      frequency: 'monthly',
      start: { kind: 'age', memberId: 'secondary', years: 65, months: 0 },
      end: { kind: 'lifetime', whose: 'secondary' },
    });
    // Drop secondary from context entirely.
    const ctx: ProjectionContext = {
      todayYear: 2026,
      retirementYear: 2030,
      primary: { birthdate: '1965-03-12' },
      inflation: { ratePct: 0 },
    };
    const out = projectExpensesByYear([exp], ctx, { from: 2030, to: 2032 });
    expect(out.every((p) => p.total === 0)).toBe(true);
  });
});

describe('discretionary glide path — engine integration', () => {
  // The glide spec is a canonical field on the expense's own payload
  // (`discretionaryGlide`), not a scenario-level context knob. The glide
  // is classification-agnostic (essentials too); the discretionary
  // *adjustment* (`bumpPct`) stays discretionary-only.
  const essYearly = expense('rent', 'canonical', {
    amount: 100,
    frequency: 'yearly',
    classification: 'essential',
    start: { kind: 'retirementStart' },
    end: { kind: 'lifetime', whose: 'last' },
  });

  it('composes multiplicatively with the discretionary adjustment', () => {
    // Glide fully completed by 2031 (50%); flat 50% thereafter so the
    // year factor is exact. Bump 20% whole-retirement.
    const discYearly = expense('travel', 'canonical', {
      amount: 100,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
      discretionaryGlide: {
        endMultiplierPct: 50,
        glideStart: { kind: 'year', year: 2030 },
        glideEnd: { kind: 'year', year: 2031 },
      },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    ctx.discretionarySpending = { bumpPct: 20, durationYears: null };
    const out = projectExpensesByYear([essYearly, discYearly], ctx, {
      from: 2035,
      to: 2035,
    });
    // discretionary = 100 × 1.20 (bump) × 0.50 (glide) = 60.
    expect(out[0].discretionary).toBe(60);
    // essential is never scaled by bump or glide.
    expect(out[0].essential).toBe(100);
  });

  it('changing the glide does not alter the adjustment-only factor and vice versa', () => {
    const noGlide = expense('travel', 'canonical', {
      amount: 100,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    ctx.discretionarySpending = { bumpPct: 20, durationYears: null };
    const bumpOnly = projectExpensesByYear([noGlide], ctx, {
      from: 2035,
      to: 2035,
    });
    expect(bumpOnly[0].discretionary).toBe(120);
    const glided = expense('travel', 'canonical', {
      amount: 100,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
      discretionaryGlide: {
        endMultiplierPct: 50,
        glideStart: { kind: 'year', year: 2030 },
        glideEnd: { kind: 'year', year: 2031 },
      },
    });
    ctx.discretionarySpending = undefined;
    const glideOnly = projectExpensesByYear([glided], ctx, {
      from: 2035,
      to: 2035,
    });
    expect(glideOnly[0].discretionary).toBe(50);
  });

  it('absent override ⇒ engine output byte-identical to before', () => {
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    ctx.discretionarySpending = { bumpPct: 25, durationYears: null };
    const discNoGlide = expense('travel', 'canonical', {
      amount: 100,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const discUndefinedGlide = expense('travel', 'canonical', {
      amount: 100,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
      discretionaryGlide: undefined,
    });
    const without = projectExpensesByYear([essYearly, discNoGlide], ctx, {
      from: 2030,
      to: 2050,
    });
    const withUndefined = projectExpensesByYear(
      [essYearly, discUndefinedGlide],
      ctx,
      { from: 2030, to: 2050 },
    );
    expect(withUndefined).toEqual(without);
  });

  it('end=100 + floor<100 still steps spending down (routes through the per-month sum, not the neutral fast-path)', () => {
    // The tightened isNeutralGlide keeps the `noFloor` clause, so an
    // end=100 glide WITH an effective floor<100 is NOT neutral and must
    // step down at the floor anchor — byte-identical to the prior engine.
    const stepDown = expense('travel', 'canonical', {
      amount: 1000,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
      discretionaryGlide: {
        endMultiplierPct: 100,
        glideStart: { kind: 'year', year: 2030 },
        glideEnd: { kind: 'year', year: 2031 },
        floor: { multiplierPct: 40, anchor: { kind: 'year', year: 2035 } },
      },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    // Before the floor anchor: holds at 100% (1000). From 2035 on: 40%.
    const before = projectExpensesByYear([stepDown], ctx, { from: 2034, to: 2034 });
    const after = projectExpensesByYear([stepDown], ctx, { from: 2036, to: 2036 });
    expect(before[0].discretionary).toBeCloseTo(1000, 6);
    expect(after[0].discretionary).toBeCloseTo(400, 6);
  });

  it('wrong-side plateau (end=100 + floor>100) is neutral — monthly==annual==absent, no spurious rise', () => {
    // A serialized `{ endMultiplierPct: 100, floor.multiplierPct: 150 }`
    // (reachable via verbatim data-import) is direction-aware ineffective,
    // so the engine must treat it as the value-equivalent no-op: the
    // per-month glide multiplier stays 1, the annual fast-path routes it
    // through the absent path, and the monthly==annual rollup invariant
    // plus the absent-glide equivalence both hold. Before the fix
    // the per-month engine returned 1.5 while the fast-path treated it as
    // neutral 1.0, breaking both.
    const ctx = baseCtx({ todayYear: 2026, retirementYear: 2030 });
    ctx.inflation = { ratePct: 3 };
    const wrongSide = expense('travel', 'canonical', {
      amount: 12000,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      end: { kind: 'lifetime', whose: 'primary' },
      discretionaryGlide: {
        endMultiplierPct: 100,
        glideStart: { kind: 'year', year: 2030 },
        glideEnd: { kind: 'year', year: 2040 },
        floor: { multiplierPct: 150, anchor: { kind: 'year', year: 2050 } },
      },
    });
    const absentGlided = expense('travel', 'canonical', {
      amount: 12000,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      end: { kind: 'lifetime', whose: 'primary' },
      discretionaryGlide: undefined,
    });
    const withWrongSide = projectExpensesByYear([wrongSide], ctx, {
      from: 2030,
      to: 2055,
    });
    const withAbsent = projectExpensesByYear([absentGlided], ctx, {
      from: 2030,
      to: 2055,
    });
    expect(withWrongSide).toEqual(withAbsent);
    // monthly==annual rollup invariant holds for the wrong-side
    // payload across the plateau anchor year (2050) too.
    const monthly = projectExpensesByMonth([wrongSide], ctx, {
      from: 2049,
      to: 2052,
    });
    const annual = projectExpensesByYear([wrongSide], ctx, {
      from: 2049,
      to: 2052,
    });
    for (const a of annual) {
      const inYear = monthly.filter((p) => p.year === a.year);
      const mean = inYear.reduce((acc, p) => acc + p.total, 0) / 12;
      // Tolerance 1 (±0.05) absorbs the annual function's round2()
      // truncation vs. the summed-then-meaned per-month round2 amounts;
      // the underlying rollup invariant holds exactly before rounding.
      expect(mean).toBeCloseTo(a.total, 1);
    }
  });

  it('neutral no-op glide ⇒ partial-active year under inflation byte-identical to absent glide', () => {
    // ND15b regression: a scenario "glide off" patch persists the
    // value-equivalent neutral object (endMultiplierPct 100, no floor).
    // For a partial-active calendar year under non-zero inflation the
    // neutral-active path (active-month inflation×glide mean) and the
    // absent path (all-12-month inflation mean prorated) diverge unless
    // the neutral no-op is routed to the absent path too. Primary born
    // Mar 12, 1965 → age 65 starts March 2030 (10 active months).
    const ctx = baseCtx({ todayYear: 2026, retirementYear: 2030 });
    ctx.inflation = { ratePct: 3 };
    const neutralGlided = expense('travel', 'canonical', {
      amount: 12000,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      end: { kind: 'lifetime', whose: 'primary' },
      discretionaryGlide: {
        endMultiplierPct: 100,
        glideStart: { kind: 'year', year: 2030 },
        glideEnd: { kind: 'year', year: 2040 },
      },
    });
    const absentGlided = expense('travel', 'canonical', {
      amount: 12000,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      end: { kind: 'lifetime', whose: 'primary' },
      discretionaryGlide: undefined,
    });
    const withNeutral = projectExpensesByYear([neutralGlided], ctx, {
      from: 2030,
      to: 2050,
    });
    const withAbsent = projectExpensesByYear([absentGlided], ctx, {
      from: 2030,
      to: 2050,
    });
    expect(withNeutral).toEqual(withAbsent);
  });

  it('does NOT glide a one-off discretionary lump sum (one-offs never glided)', () => {
    const oneOff = expense('windfall-spend', 'canonical', {
      amount: 1000,
      frequency: 'oneOff',
      classification: 'discretionary',
      start: { kind: 'year', year: 2035 },
      discretionaryGlide: {
        endMultiplierPct: 50,
        glideStart: { kind: 'year', year: 2030 },
        glideEnd: { kind: 'year', year: 2040 },
      },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    // Behaviour reversal: a one-off is never glided — the glide
    // multiplier is 1 regardless of any stored glide, so the lump is
    // the full entered amount (was 750 under the old spike-month
    // scaling).
    const out = projectExpensesByYear([oneOff], ctx, { from: 2035, to: 2035 });
    expect(out[0].discretionary).toBe(1000);
  });

  it('annual-rollup invariant holds under a within-year-ramping glide', () => {
    // Inflation off ⇒ the year mean factor is exact, so mean(12
    // monthly points) must equal the annual total to the cent.
    const disc = expense('travel', 'canonical', {
      amount: 12000,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
      discretionaryGlide: {
        endMultiplierPct: 0,
        glideStart: { kind: 'year', year: 2030 },
        glideEnd: { kind: 'year', year: 2045 }, // ramps across 2036
      },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    const year = projectExpensesByYear([disc], ctx, { from: 2036, to: 2036 });
    const months = projectExpensesByMonth([disc], ctx, { from: 2036, to: 2036 });
    const meanMonthly =
      months.reduce((s, p) => s + p.discretionary, 0) / months.length;
    expect(Math.abs(meanMonthly - year[0].discretionary)).toBeLessThan(0.02);
  });

  it('annual-rollup invariant holds with a within-year glide ramp AND non-zero inflation', () => {
    // Both the inflation factor and the glide multiplier ramp within
    // 2036. mean(inflation·glide) ≠ mean(inflation)·mean(glide), so the
    // continuous-year path must fold them into a single combined mean.
    // This assertion fails if the year path multiplies two separate
    // monthly means together.
    const disc = expense('travel', 'canonical', {
      amount: 12000,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
      discretionaryGlide: {
        endMultiplierPct: 0,
        glideStart: { kind: 'year', year: 2030 },
        glideEnd: { kind: 'year', year: 2045 }, // ramps across 2036
      },
    });
    const ctx = baseCtx({ todayYear: 2026, retirementYear: 2030 });
    ctx.inflation = { ratePct: 3 };
    const year = projectExpensesByYear([disc], ctx, { from: 2036, to: 2036 });
    const months = projectExpensesByMonth([disc], ctx, { from: 2036, to: 2036 });
    const meanMonthly =
      months.reduce((s, p) => s + p.discretionary, 0) / months.length;
    // Tolerance mirrors the existing non-glide nonzero-inflation
    // invariant test (round2() truncation on the annual side).
    expect(Math.abs(meanMonthly - year[0].discretionary)).toBeLessThan(0.01);
  });

  it('annual-rollup invariant holds for a PARTIAL-active year under a within-year glide ramp + non-zero inflation', () => {
    // Sibling to the test above, but the asserted year is only
    // *partially* active: primary born Mar 12, 1965 → age 65 starts
    // March 2030 (month0 = 2), so 2030 has 10 active months (Mar–Dec)
    // and Jan/Feb are zero. The glide ramps linearly across 2030 too.
    // Averaging inflation·glide over all 12 calendar months and then
    // prorating by activeMonths/12 folds the (different) Jan/Feb glide
    // values into the partial year, so it must instead sum the product
    // over exactly the active months and /12. This assertion fails on
    // an all-12-months-then-prorate path and passes once the
    // continuous-year term sums over active months only.
    const disc = expense('travel', 'canonical', {
      amount: 12000,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'age', memberId: 'primary', years: 65, months: 0 }, // Mar 2030
      end: { kind: 'lifetime', whose: 'primary' },
      discretionaryGlide: {
        endMultiplierPct: 0,
        glideStart: { kind: 'year', year: 2030 },
        glideEnd: { kind: 'year', year: 2040 }, // ramps across 2030
      },
    });
    const ctx = baseCtx({ todayYear: 2026, retirementYear: 2030 });
    ctx.inflation = { ratePct: 3 };
    const year = projectExpensesByYear([disc], ctx, { from: 2030, to: 2030 });
    const months = projectExpensesByMonth([disc], ctx, { from: 2030, to: 2030 });
    const meanMonthly =
      months.reduce((s, p) => s + p.discretionary, 0) / months.length;
    expect(Math.abs(meanMonthly - year[0].discretionary)).toBeLessThan(0.01);
  });

  it('annual-rollup invariant holds for an INCREASING glide (end 200, partial-active year + inflation) — asserts .essential/.essentialBase, .discretionary===0 (a)', () => {
    // Glided ESSENTIAL, end 200 (×2.0), partial-active year (Mar 2030
    // start = 10 active months), non-zero inflation. The annual rollup
    // must equal mean(12 monthly points) to FP precision and land in the
    // ESSENTIAL bucket with a strictly-zero discretionary bucket.
    const essGlided = expense('care', 'canonical', {
      amount: 12000,
      frequency: 'yearly',
      classification: 'essential',
      start: { kind: 'age', memberId: 'primary', years: 65, months: 0 }, // Mar 2030
      end: { kind: 'lifetime', whose: 'primary' },
      discretionaryGlide: {
        endMultiplierPct: 200,
        glideStart: { kind: 'year', year: 2030 },
        glideEnd: { kind: 'year', year: 2040 }, // ramps across 2030
      },
    });
    const ctx = baseCtx({ todayYear: 2026, retirementYear: 2030 });
    ctx.inflation = { ratePct: 3 };
    const year = projectExpensesByYear([essGlided], ctx, { from: 2030, to: 2030 });
    const months = projectExpensesByMonth([essGlided], ctx, { from: 2030, to: 2030 });
    const meanEss =
      months.reduce((s, p) => s + p.essential, 0) / months.length;
    expect(Math.abs(meanEss - year[0].essential)).toBeLessThan(0.01);
    expect(year[0].discretionary).toBe(0);
    // Base (today's-dollars) tracks the rise — strictly above the entered
    // partial-year figure (10/12 × 12000 = 10000) because the glide
    // ramps the multiplier above 1 across the active months.
    const meanEssBase =
      months.reduce((s, p) => s + p.essentialBase, 0) / months.length;
    expect(Math.abs(meanEssBase - year[0].essentialBase)).toBeLessThan(0.01);
    expect(year[0].essentialBase).toBeGreaterThan(10000);
    expect(year[0].discretionaryBase).toBe(0);
  });

  it('glides an ESSENTIAL but never applies the discretionary adjustment to it (b — month + category-month)', () => {
    // Two-expense fixture inside an active bumpPct window: the essential
    // bucket EXCLUDES (1+bumpPct/100) while the discretionary bucket
    // INCLUDES it; both carry the SAME declining glide (×0.5 once
    // completed). Asserted across projectExpensesByMonth (essential vs
    // discretionary buckets) and projectExpensesByCategoryMonth.
    const glide = {
      endMultiplierPct: 50,
      glideStart: { kind: 'year' as const, year: 2030 },
      glideEnd: { kind: 'year' as const, year: 2031 }, // flat 50% by 2035
    };
    const essGlided = expense('care', 'canonical', {
      amount: 1200, // /month
      frequency: 'monthly',
      classification: 'essential',
      categoryId: 'cat-ess',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
      discretionaryGlide: glide,
    });
    const discGlided = expense('travel', 'canonical', {
      amount: 1200, // /month
      frequency: 'monthly',
      classification: 'discretionary',
      categoryId: 'cat-disc',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
      discretionaryGlide: glide,
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    ctx.discretionarySpending = { bumpPct: 20, durationYears: null };
    const months = projectExpensesByMonth([essGlided, discGlided], ctx, {
      from: 2035,
      to: 2035,
    });
    const m = months[0];
    // Run-rate $/yr at glide-complete: 1200 × 12 × 0.5 = 7200 (essential,
    // no bump); discretionary additionally × 1.20 = 8640.
    expect(m.essential).toBeCloseTo(7200, 6);
    expect(m.discretionary).toBeCloseTo(8640, 6);
    const cat = projectExpensesByCategoryMonth([essGlided, discGlided], ctx, {
      from: 2035,
      to: 2035,
    });
    const c = cat[0];
    expect(c.byCategoryId['cat-ess']).toBeCloseTo(7200, 6);
    expect(c.byCategoryId['cat-disc']).toBeCloseTo(8640, 6);
  });

  it('glided ESSENTIAL in a general+2pp (Medical) category preserves the per-step Σ_b == monthlyExpenseBase residual invariant', () => {
    // The per-category month chart must still tie to the by-classification
    // total for the same inputs: Σ category buckets == essential +
    // discretionary in every month, even with a Medical (+2pp) category
    // rate and a glided essential.
    const medGlided = expense('care', 'canonical', {
      amount: 1000,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: 'cat-medical',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
      discretionaryGlide: {
        endMultiplierPct: 150,
        glideStart: { kind: 'year', year: 2030 },
        glideEnd: { kind: 'year', year: 2040 },
      },
    });
    const ctx = baseCtx({ todayYear: 2026, retirementYear: 2030 });
    ctx.inflation = {
      ratePct: 3,
      categoryRates: new Map([['cat-medical', 5]]),
    };
    const byClass = projectExpensesByMonth([medGlided], ctx, {
      from: 2035,
      to: 2035,
    });
    const byCat = projectExpensesByCategoryMonth([medGlided], ctx, {
      from: 2035,
      to: 2035,
    });
    for (let i = 0; i < byClass.length; i += 1) {
      const sumCat = Object.values(byCat[i].byCategoryId).reduce(
        (s, v) => s + v,
        0,
      );
      expect(Math.abs(sumCat - (byClass[i].essential + byClass[i].discretionary))).toBeLessThan(0.02);
    }
  });

  it('glided ESSENTIAL nominal rise reaches the year total (downstream net-need feed)', () => {
    // A glided essential's rise must flow into the nominal essential bucket
    // (and thus into the total the drawdown engine reads as net-need). A
    // rising glide strictly raises the total vs the same expense ungilded.
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    const ungilded = expense('care', 'canonical', {
      amount: 1000,
      frequency: 'monthly',
      classification: 'essential',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const glided = expense('care', 'canonical', {
      amount: 1000,
      frequency: 'monthly',
      classification: 'essential',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
      discretionaryGlide: {
        endMultiplierPct: 150,
        glideStart: { kind: 'year', year: 2030 },
        glideEnd: { kind: 'year', year: 2031 }, // flat ×1.5 by 2035
      },
    });
    const flat = projectExpensesByYear([ungilded], ctx, { from: 2035, to: 2035 });
    const rise = projectExpensesByYear([glided], ctx, { from: 2035, to: 2035 });
    // 1000 × 12 = 12000 flat; × 1.5 = 18000 glided. Discretionary stays 0.
    expect(flat[0].total).toBeCloseTo(12000, 6);
    expect(rise[0].total).toBeCloseTo(18000, 6);
    expect(rise[0].total).toBeGreaterThan(flat[0].total);
    expect(rise[0].discretionary).toBe(0);
  });
});

describe('projectExpenses*  — additive real "base" outputs', () => {
  it('base == nominal when ratePct = 0 (inflation is the only difference) — yearly + monthly', () => {
    const ess = expense('rent', 'canonical', {
      amount: 1000,
      frequency: 'monthly',
      classification: 'essential',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const disc = expense('travel', 'canonical', {
      amount: 500,
      frequency: 'monthly',
      classification: 'discretionary',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.inflation = { ratePct: 0 };
    const year = projectExpensesByYear([ess, disc], ctx, {
      from: 2031,
      to: 2031,
    });
    expect(year[0].essentialBase).toBe(year[0].essential);
    expect(year[0].discretionaryBase).toBe(year[0].discretionary);
    expect(year[0].totalBase).toBe(year[0].total);
    const months = projectExpensesByMonth([ess, disc], ctx, {
      from: 2031,
      to: 2031,
    });
    for (const m of months) {
      expect(m.essentialBase).toBe(m.essential);
      expect(m.discretionaryBase).toBe(m.discretionary);
    }
  });

  it('base = recurring real run-rate (inflation NOT applied, bump applied) — yearly', () => {
    const disc = expense('travel', 'canonical', {
      amount: 1000,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const ctx = baseCtx({ todayYear: 2026, retirementYear: 2030 });
    ctx.inflation = { ratePct: 3 };
    ctx.discretionarySpending = { bumpPct: 20, durationYears: null };
    const year = projectExpensesByYear([disc], ctx, { from: 2035, to: 2035 });
    // Real run-rate keeps the bump, strips inflation: 1000 × 1.20.
    expect(year[0].discretionaryBase).toBeCloseTo(1200, 6);
    // Nominal still carries 3% inflation forward from 2026 → strictly
    // larger than the base.
    expect(year[0].discretionary).toBeGreaterThan(year[0].discretionaryBase);
  });

  it('one-off real literal: oneOff*Base = entered amount, no glide, no inflation — monthly', () => {
    const oneOff = expense('windfall-spend', 'canonical', {
      amount: 1000,
      frequency: 'oneOff',
      classification: 'discretionary',
      start: { kind: 'year', year: 2035 },
      discretionaryGlide: {
        endMultiplierPct: 50,
        glideStart: { kind: 'year', year: 2030 },
        glideEnd: { kind: 'year', year: 2040 },
      },
    });
    const ctx = baseCtx({ todayYear: 2026, retirementYear: 2030 });
    ctx.inflation = { ratePct: 3 };
    const months = projectExpensesByMonth([oneOff], ctx, {
      from: 2035,
      to: 2035,
    });
    const spike = months.find((m) => m.month0 === 0)!; // Jan 2035 spike
    // Behaviour reversal: a one-off is never glided ⇒ the real base is
    // the full entered amount (was 1000 × 0.75 under the old
    // spike-month glide scaling).
    expect(spike.oneOffDiscretionaryBase).toBeCloseTo(1000, 6);
    // base == nominal ÷ that single spike-month factor — the
    // glide is now 1, so this identity still holds.
    const spikeFactor = Math.pow(1.03, (2035 * 12 + 0 - 2026 * 12) / 12);
    expect(
      Math.abs(
        spike.oneOffDiscretionaryBase -
          spike.oneOffDiscretionary / spikeFactor,
      ),
    ).toBeLessThan(0.01);
  });

  it('glide kept, inflation stripped: monthly discretionaryBase == nominal-month ÷ monthFactor', () => {
    // Within-year-ramping glide + non-zero inflation: the regime
    // the annual-rollup invariant pins. Per-month base must keep the glide and
    // drop only that month's inflation factor.
    const disc = expense('travel', 'canonical', {
      amount: 12000,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
      discretionaryGlide: {
        endMultiplierPct: 0,
        glideStart: { kind: 'year', year: 2030 },
        glideEnd: { kind: 'year', year: 2045 }, // ramps across 2036
      },
    });
    const ctx = baseCtx({ todayYear: 2026, retirementYear: 2030 });
    ctx.inflation = { ratePct: 3 };
    const months = projectExpensesByMonth([disc], ctx, {
      from: 2036,
      to: 2036,
    });
    for (const m of months) {
      const monthFactor = Math.pow(
        1.03,
        (2036 * 12 + m.month0 - 2026 * 12) / 12,
      );
      // ≤$0.01: both fields are round2()'d (same sub-cent independent-
      // rounding tolerance the annual-rollup invariant tests use).
      expect(
        Math.abs(m.discretionaryBase - m.discretionary / monthFactor),
      ).toBeLessThan(0.01);
    }
    // The real series ramps within the year — NOT flat, NOT inflation.
    const jan = months.find((m) => m.month0 === 0)!.discretionaryBase;
    const dec = months.find((m) => m.month0 === 11)!.discretionaryBase;
    expect(dec).not.toBeCloseTo(jan, 2);
  });

  it('glided continuous-annual base == annualBase × (1/12) × Σ_active glide(m) — NOT a scalar ÷ inflationFactor', () => {
    // Within-year-ramping glide + non-zero inflation (the annual-rollup
    // invariant regime): mean(inflation·glide) ≠ mean(inflation)·mean(glide), so
    // no scalar inflation divisor reproduces the correct per-month-
    // glide-summed base. Oracle = the inflation-free recompute.
    const disc = expense('travel', 'canonical', {
      amount: 12000,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
      discretionaryGlide: {
        endMultiplierPct: 0,
        glideStart: { kind: 'year', year: 2030 },
        glideEnd: { kind: 'year', year: 2045 }, // ramps across 2036
      },
    });
    const ctx = baseCtx({ todayYear: 2026, retirementYear: 2030 });
    ctx.inflation = { ratePct: 3 };
    const year = projectExpensesByYear([disc], ctx, { from: 2036, to: 2036 });
    // Inflation-free recompute: annualBase × (1/12) × Σ_{m=0..11} glide.
    let glideSum = 0;
    for (let m = 0; m < 12; m += 1) {
      const t = (2036 * 12 + m - (2030 * 12 + 0)) / (2045 * 12 - 2030 * 12);
      glideSum += 1 + (0 - 1) * t; // endMultiplierPct 0 ⇒ endMult 0
    }
    const oracle = 12000 * (1 / 12) * glideSum;
    expect(year[0].discretionaryBase).toBeCloseTo(oracle, 2);
    // Prove it is NOT the scalar shortcut: nominal ÷ a single year-mean
    // inflation factor would diverge from the oracle here.
    let meanInfl = 0;
    for (let m = 0; m < 12; m += 1) {
      meanInfl += Math.pow(1.03, (2036 * 12 + m - 2026 * 12) / 12);
    }
    meanInfl /= 12;
    const scalarShortcut = year[0].discretionary / meanInfl;
    expect(Math.abs(scalarShortcut - oracle)).toBeGreaterThan(0.5);
  });

  it('Σ(12 Monthly discretionaryBase) == Yearly discretionaryBase for a glided expense (≤$0.01)', () => {
    const disc = expense('travel', 'canonical', {
      amount: 12000,
      frequency: 'yearly',
      classification: 'discretionary',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
      discretionaryGlide: {
        endMultiplierPct: 0,
        glideStart: { kind: 'year', year: 2030 },
        glideEnd: { kind: 'year', year: 2045 },
      },
    });
    const ctx = baseCtx({ todayYear: 2026, retirementYear: 2030 });
    ctx.inflation = { ratePct: 3 };
    const year = projectExpensesByYear([disc], ctx, { from: 2036, to: 2036 });
    const months = projectExpensesByMonth([disc], ctx, {
      from: 2036,
      to: 2036,
    });
    const meanMonthlyBase =
      months.reduce((s, p) => s + p.discretionaryBase, 0) / months.length;
    expect(Math.abs(meanMonthlyBase - year[0].discretionaryBase)).toBeLessThan(
      0.01,
    );
  });

  it('essentialBase TRACKS a glide on an essential; base == nominal at ratePct 0 with a glide configured', () => {
    const essGlide = expense('rent', 'canonical', {
      amount: 1000,
      frequency: 'yearly',
      classification: 'essential',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
      // The glide is now classification-agnostic — an essential's base
      // follows its real glide trajectory.
      discretionaryGlide: {
        endMultiplierPct: 0,
        glideStart: { kind: 'year', year: 2030 },
        glideEnd: { kind: 'year', year: 2045 }, // flat-completed years ramp
      },
    });
    const ctxInfl = baseCtx({ todayYear: 2026, retirementYear: 2030 });
    ctxInfl.inflation = { ratePct: 3 };
    const yearInfl = projectExpensesByYear([essGlide], ctxInfl, {
      from: 2036,
      to: 2036,
    });
    // 2036 is mid-ramp (6/15 of the way from 2030→2045 toward end 0),
    // so the real run-rate is strictly below the flat entered amount.
    expect(yearInfl[0].essentialBase).toBeGreaterThan(0);
    expect(yearInfl[0].essentialBase).toBeLessThan(1000);
    const ctxZero = baseCtx({ retirementYear: 2030 });
    ctxZero.inflation = { ratePct: 0 };
    const yearZero = projectExpensesByYear([essGlide], ctxZero, {
      from: 2036,
      to: 2036,
    });
    // base == nominal when inflation is the only difference (glide kept
    // in both).
    expect(yearZero[0].essentialBase).toBe(yearZero[0].essential);
  });
});

describe('buildExpenseProjectionContext', () => {
  it('builds a today\'s-dollars ctx with retirement year/month from the ISO (primary only)', () => {
    const ctx = buildExpenseProjectionContext({
      resolved: {
        discretionarySpending: { bumpPct: 10, durationYears: null },
        lifeExpectancy: { primary: 92 },
      },
      primary: { birthdate: '1965-03-12' },
      secondary: null,
      primaryRetirementIso: '2030-04-15',
    });
    expect(ctx.retirementYear).toBe(2030);
    expect(ctx.retirementMonth0).toBe(3); // April → index 3
    expect(ctx.inflation).toEqual({ ratePct: 0 });
    expect(ctx.primary).toEqual({ birthdate: '1965-03-12' });
    expect(ctx.secondary).toBeUndefined();
    expect(ctx.discretionarySpending).toEqual({
      bumpPct: 10,
      durationYears: null,
    });
    expect(ctx.lifeExpectancy).toEqual({ primary: 92 });
    expect(ctx.extendBeyondLifetime).toBe(false);
    expect(ctx.todayYear).toBe(new Date().getFullYear());
  });

  it('threads the secondary birthdate when present', () => {
    const ctx = buildExpenseProjectionContext({
      resolved: { lifeExpectancy: { primary: 90, secondary: 95 } },
      primary: { birthdate: '1965-03-12' },
      secondary: { birthdate: '1968-09-03' },
      primaryRetirementIso: '2031-01-01',
    });
    expect(ctx.secondary).toEqual({ birthdate: '1968-09-03' });
    expect(ctx.retirementYear).toBe(2031);
    expect(ctx.retirementMonth0).toBe(0);
  });

  it('drops members with no usable birthdate to undefined', () => {
    const ctx = buildExpenseProjectionContext({
      resolved: {},
      primary: { birthdate: null },
      secondary: { birthdate: '' },
      primaryRetirementIso: '2029-12-01',
    });
    expect(ctx.primary).toBeUndefined();
    expect(ctx.secondary).toBeUndefined();
    expect(ctx.retirementMonth0).toBe(11); // December → index 11
    expect(ctx.discretionarySpending).toBeUndefined();
    expect(ctx.lifeExpectancy).toBeUndefined();
  });

  it('falls back to month 0 on a malformed retirement ISO', () => {
    const ctx = buildExpenseProjectionContext({
      resolved: {},
      primary: { birthdate: '1965-03-12' },
      secondary: null,
      primaryRetirementIso: 'not-a-date',
    });
    expect(ctx.retirementMonth0).toBe(0);
  });
});

describe('per-category inflation', () => {
  // A simple $100/mo essential expense in a given category, active for
  // the whole projection, so the run-rate is $1200/yr × the factor.
  const catExpense = (id: string, categoryId: string): ResolvedExpense =>
    expense(id, 'canonical', {
      amount: 100,
      frequency: 'monthly',
      classification: 'essential',
      categoryId,
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });

  it('Medical inflates at general+2 while non-medical stays at general', () => {
    const med = catExpense('med', 'cat-medical');
    const food = catExpense('food', 'cat-food');
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.todayMonthIndex = 0;
    // General 3%, Medical effective 5% (general + 2pp).
    ctx.inflation = {
      ratePct: 3,
      categoryRates: new Map([['cat-medical', 5]]),
    };
    const yearOut = projectExpensesByYear([med, food], ctx, {
      from: 2031,
      to: 2031,
    });
    // Compare against single-category runs to confirm each category grows
    // at its own rate.
    const medOnly3 = projectExpensesByYear([catExpense('m', 'cat-other')], {
      ...ctx,
      inflation: { ratePct: 3 },
    }, { from: 2031, to: 2031 });
    const medOnly5 = projectExpensesByYear([catExpense('m', 'cat-other')], {
      ...ctx,
      inflation: { ratePct: 5 },
    }, { from: 2031, to: 2031 });
    // Total = Medical@5 + Food@3.
    expect(yearOut[0].essential).toBeCloseTo(
      medOnly5[0].essential + medOnly3[0].essential,
      4,
    );
  });

  it('a non-medical category with an explicit override applies that rate', () => {
    const housing = catExpense('h', 'cat-housing');
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.todayMonthIndex = 0;
    ctx.inflation = {
      ratePct: 3,
      categoryRates: new Map([['cat-housing', 6]]),
    };
    const out = projectExpensesByYear([housing], ctx, { from: 2031, to: 2031 });
    const at6 = projectExpensesByYear([catExpense('h2', 'cat-other')], {
      ...ctx,
      inflation: { ratePct: 6 },
    }, { from: 2031, to: 2031 });
    expect(out[0].essential).toBeCloseTo(at6[0].essential, 6);
  });

  it('the *Base output strips every category inflation (flat across rates)', () => {
    const med = catExpense('med', 'cat-medical');
    const food = catExpense('food', 'cat-food');
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.todayMonthIndex = 0;
    ctx.inflation = {
      ratePct: 3,
      categoryRates: new Map([['cat-medical', 9]]),
    };
    const out = projectExpensesByYear([med, food], ctx, { from: 2031, to: 2035 });
    // Two essential expenses at $1200/yr each → base is flat $2400/yr.
    for (const row of out) {
      expect(row.essentialBase).toBeCloseTo(2400, 4);
    }
  });

  it('absent categoryRates ⇒ byte-identical to the single-rate engine', () => {
    const med = catExpense('med', 'cat-medical');
    const food = catExpense('food', 'cat-food');
    const ctxWith = baseCtx({ retirementYear: 2030 });
    ctxWith.todayMonthIndex = 0;
    ctxWith.inflation = { ratePct: 3 }; // no categoryRates
    const ctxEmpty = baseCtx({ retirementYear: 2030 });
    ctxEmpty.todayMonthIndex = 0;
    ctxEmpty.inflation = { ratePct: 3, categoryRates: new Map() };
    const a = projectExpensesByYear([med, food], ctxWith, { from: 2031, to: 2040 });
    const b = projectExpensesByYear([med, food], ctxEmpty, { from: 2031, to: 2040 });
    expect(b).toEqual(a);
  });

  it('projectExpensesByCategoryMonth: Medical grows at general+2, others at general', () => {
    const med = catExpense('med', 'cat-medical');
    const food = catExpense('food', 'cat-food');
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.todayMonthIndex = 0;
    ctx.inflation = {
      ratePct: 3,
      categoryRates: new Map([['cat-medical', 5]]),
    };
    const cat = projectExpensesByCategoryMonth([med, food], ctx, {
      from: 2031,
      to: 2031,
    });
    // Single-rate references for the same month range.
    const food3 = projectExpensesByCategoryMonth([catExpense('f', 'cat-food')], {
      ...ctx,
      inflation: { ratePct: 3 },
    }, { from: 2031, to: 2031 });
    const med5 = projectExpensesByCategoryMonth([catExpense('m', 'cat-medical')], {
      ...ctx,
      inflation: { ratePct: 5 },
    }, { from: 2031, to: 2031 });
    // Pick the June sample (month0 = 5).
    const june = cat.find((p) => p.month0 === 5)!;
    const foodJune = food3.find((p) => p.month0 === 5)!;
    const medJune = med5.find((p) => p.month0 === 5)!;
    expect(june.byCategoryId['cat-food']).toBeCloseTo(
      foodJune.byCategoryId['cat-food'],
      4,
    );
    expect(june.byCategoryId['cat-medical']).toBeCloseTo(
      medJune.byCategoryId['cat-medical'],
      4,
    );
    // Medical run-rate exceeds Food's (same base amount, faster growth).
    expect(june.byCategoryId['cat-medical']).toBeGreaterThan(
      june.byCategoryId['cat-food'],
    );
  });
});

describe('projectExpensesByCategoryYear — cadence-correct annual basis', () => {
  it('Σ byCategoryId ties to projectExpensesByYear total (continuous + one-off)', () => {
    // A continuous Housing expense + a one-off Travel windfall in 2031.
    const housing = expense('h', 'canonical', {
      amount: 1_500,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: 'cat-housing',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const travel = expense('t', 'canonical', {
      amount: 40_000,
      frequency: 'oneOff',
      classification: 'discretionary',
      categoryId: 'cat-travel',
      start: { kind: 'year', year: 2031 },
      end: { kind: 'year', year: 2031 },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.todayMonthIndex = 0;
    ctx.inflation = { ratePct: 0 };
    const cat = projectExpensesByCategoryYear([housing, travel], ctx, {
      from: 2030,
      to: 2032,
    });
    const year = projectExpensesByYear([housing, travel], ctx, {
      from: 2030,
      to: 2032,
    });
    for (let i = 0; i < cat.length; i += 1) {
      const sum = Object.values(cat[i].byCategoryId).reduce((a, b) => a + b, 0);
      // Cadence-correct rollup ties to the by-classification annual total
      // to sub-cent (independent rounding orders).
      expect(sum).toBeCloseTo(year[i].total, 2);
      expect(cat[i].total).toBeCloseTo(year[i].total, 2);
    }
    // 2031 carries the FULL $40k one-off in Travel (literal annual amount,
    // NOT amount/12) — proving cadence-correctness for one-offs.
    const y2031 = cat.find((r) => r.year === 2031)!;
    expect(y2031.byCategoryId['cat-travel']).toBeCloseTo(40_000, 2);
  });
});

describe('projectExpensesByCategoryMonth — recurring/one-off split', () => {
  it('a continuous category lands fully in recurringByCategoryId with no one-off; a one-off lands in both', () => {
    const housing = expense('h', 'canonical', {
      amount: 1_500,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: 'cat-housing',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    const travel = expense('t', 'canonical', {
      amount: 40_000,
      frequency: 'oneOff',
      classification: 'discretionary',
      categoryId: 'cat-travel',
      start: { kind: 'year', year: 2031 },
      end: { kind: 'year', year: 2031 },
    });
    const ctx = baseCtx({ retirementYear: 2030 });
    ctx.todayMonthIndex = 0;
    ctx.inflation = { ratePct: 0 };
    const out = projectExpensesByCategoryMonth([housing, travel], ctx, {
      from: 2031,
      to: 2031,
    });
    // The one-off spikes in January 2031 (year-anchored).
    const jan = out.find((p) => p.month0 === 0)!;
    expect(jan.byCategoryId['cat-travel']).toBeCloseTo(40_000, 2);
    expect(jan.recurringByCategoryId['cat-travel']).toBeCloseTo(40_000, 2);
    expect(jan.oneOffByCategoryId['cat-travel']).toBeCloseTo(40_000, 2);
    // Housing is continuous: present in recurring, absent from one-off.
    expect(jan.recurringByCategoryId['cat-housing']).toBeCloseTo(18_000, 2);
    expect(jan.oneOffByCategoryId['cat-housing'] ?? 0).toBe(0);
    // A later month: no Travel one-off.
    const feb = out.find((p) => p.month0 === 1)!;
    expect(feb.oneOffByCategoryId['cat-travel'] ?? 0).toBe(0);
  });
});
