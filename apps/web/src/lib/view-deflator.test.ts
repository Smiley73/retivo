/**
 * Unit tests for the page-local view-model deflator helper.
 *
 * Covers:
 *   - Identity when `mode === 'future'` (engine output passes through).
 *   - Identity when `inflationPct === 0` even in `'today'` mode.
 *   - Identity when the anchor is missing entirely.
 *   - Month-precise deflator math matches the engine's forward factor
 *     so a today's-dollar input round-trips through nominal projection
 *     back to today's-dollar display.
 *   - localStorage key + parser default semantics.
 */
import { describe, expect, it } from 'vitest';
import {
  CASHFLOW_GRANULARITY_STORAGE_KEY,
  COMPARE_CHOICE_STORAGE_KEY,
  DISPLAY_MODE_STORAGE_KEY,
  buildViewDeflator,
  parseCashflowGranularity,
  parseCompareChoices,
  parseDisplayMode,
  type CashflowGranularity,
  type DisplayMode,
} from './view-deflator';
import {
  projectExpensesByMonth,
  type ProjectionContext,
} from './expense-projection';
import type { ResolvedExpense } from './expense-resolution';

describe('buildViewDeflator — identity behaviours', () => {
  it("returns 1 for every (year, monthIndex) in 'future' mode", () => {
    const f = buildViewDeflator('future', {
      nowYear: 2026,
      nowMonthIndex: 0,
      inflationPct: 3,
    });
    expect(f(2026, 0)).toBe(1);
    expect(f(2055, 11)).toBe(1);
    expect(f(2010, 6)).toBe(1);
  });

  it("returns 1 when inflationPct is 0 even in 'today' mode", () => {
    const f = buildViewDeflator('today', {
      nowYear: 2026,
      nowMonthIndex: 5,
      inflationPct: 0,
    });
    expect(f(2026, 0)).toBe(1);
    expect(f(2050, 11)).toBe(1);
  });

  it("returns 1 when anchor is null even in 'today' mode", () => {
    const f = buildViewDeflator('today', null);
    expect(f(2050, 0)).toBe(1);
  });
});

describe("buildViewDeflator — 'today' mode month-precise math", () => {
  it('inverts the engine inflation factor exactly', () => {
    // Engine inflates today's-dollar amount at year Y month M by
    //   factor = (1 + i/100) ^ ((Y*12 + M - asOfMonth) / 12)
    // View deflator at the same (Y, M) returns 1/factor so a
    // today's-dollar input round-trips back to itself.
    const anchor = { nowYear: 2026, nowMonthIndex: 0, inflationPct: 3 };
    const deflate = buildViewDeflator('today', anchor);
    const asOfMonth = anchor.nowYear * 12 + anchor.nowMonthIndex;
    const cases: Array<[number, number]> = [
      [2026, 0],
      [2026, 11],
      [2030, 6],
      [2055, 3],
    ];
    for (const [year, monthIndex] of cases) {
      const factor = Math.pow(
        1 + anchor.inflationPct / 100,
        (year * 12 + monthIndex - asOfMonth) / 12,
      );
      expect(deflate(year, monthIndex) * factor).toBeCloseTo(1, 12);
    }
  });

  it('defaults monthIndex to 11 (Dec / year-end)', () => {
    const anchor = { nowYear: 2026, nowMonthIndex: 0, inflationPct: 3 };
    const deflate = buildViewDeflator('today', anchor);
    expect(deflate(2030)).toBeCloseTo(deflate(2030, 11), 12);
  });

  it('non-Jan anchor shifts the exponent month-precise', () => {
    // Anchor = June 2026. Year 2028 December → 30 months from anchor.
    const anchor = { nowYear: 2026, nowMonthIndex: 5, inflationPct: 3 };
    const deflate = buildViewDeflator('today', anchor);
    const expected = Math.pow(1.03, -30 / 12);
    expect(deflate(2028, 11)).toBeCloseTo(expected, 12);
  });
});

describe('parseDisplayMode', () => {
  it("defaults to 'today' when storage is empty", () => {
    expect(parseDisplayMode(null)).toBe<DisplayMode>('today');
  });

  it("defaults to 'today' for unrecognised strings", () => {
    expect(parseDisplayMode('nominal')).toBe<DisplayMode>('today');
    expect(parseDisplayMode('')).toBe<DisplayMode>('today');
  });

  it("returns 'future' only for the literal 'future' string", () => {
    expect(parseDisplayMode('future')).toBe<DisplayMode>('future');
    expect(parseDisplayMode('today')).toBe<DisplayMode>('today');
  });
});

describe('localStorage round-trip via DISPLAY_MODE_STORAGE_KEY', () => {
  it('writes + reads the stored mode under the canonical key', () => {
    // Simulate the page's persistence side-effect without needing a
    // full React render. Confirms the key the page reads matches the
    // key it writes — a regression here would silently lose the user's
    // preference on next reload.
    const store = new Map<string, string>();
    const ls = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    };
    ls.setItem(DISPLAY_MODE_STORAGE_KEY, 'future');
    expect(parseDisplayMode(ls.getItem(DISPLAY_MODE_STORAGE_KEY))).toBe('future');
    ls.setItem(DISPLAY_MODE_STORAGE_KEY, 'today');
    expect(parseDisplayMode(ls.getItem(DISPLAY_MODE_STORAGE_KEY))).toBe('today');
  });
});

describe('parseCashflowGranularity', () => {
  it("defaults to 'yearly' when storage is empty", () => {
    expect(parseCashflowGranularity(null)).toBe<CashflowGranularity>('yearly');
  });

  it("defaults to 'yearly' for unrecognised strings", () => {
    expect(parseCashflowGranularity('annual')).toBe<CashflowGranularity>('yearly');
    expect(parseCashflowGranularity('')).toBe<CashflowGranularity>('yearly');
  });

  it("returns 'monthly' only for the literal 'monthly' string", () => {
    expect(parseCashflowGranularity('monthly')).toBe<CashflowGranularity>('monthly');
    expect(parseCashflowGranularity('yearly')).toBe<CashflowGranularity>('yearly');
  });
});

describe('anchor identity — engine × deflator round-trip', () => {
  // Cross-module contract: when the expense projection's `asOfMonth`
  // anchor (driven by `ctx.todayMonthIndex`) matches the deflator's
  // `(nowYear, nowMonthIndex)` anchor, the deflator applied at the
  // horizon to the engine's nominal series equals the entered real
  // amount — by construction. The pre-fix Balance Projection page
  // built the expense context with no `todayMonthIndex` (defaulting
  // to January) while the deflator used the current month, so this
  // identity broke off-by-months mid-year.
  const baseExpense: ResolvedExpense = {
    id: 'rent',
    source: 'canonical',
    payload: {
      name: 'rent',
      amount: 1000, // $/month, flat real
      frequency: 'monthly',
      classification: 'essential',
      categoryId: 'cat-x',
      start: { kind: 'year', year: 2026 },
      end: { kind: 'lifetime', whose: 'last' },
    },
  };

  const baseCtx = (overrides: Partial<ProjectionContext> = {}): ProjectionContext => ({
    todayYear: 2026,
    retirementYear: 2030,
    primary: { birthdate: '1965-03-12' },
    secondary: { birthdate: '1968-09-03' },
    extendBeyondLifetime: false,
    ...overrides,
  });

  it('nominal × deflator collapses exactly to the entered real amount when anchors line up (mid-year June anchor, 2% inflation)', () => {
    // June (monthIndex 5) anchor + 2% annual inflation. Compute the
    // monthly nominal series for a flat $1k/month real expense over
    // the 2026–2032 window, then apply the deflator at each month's
    // own (year, month0). For a non-glided monthly continuous expense
    // `projectExpensesByMonth` emits `annualRate × monthFactor(year,m)`
    // and the deflator returns `1 / monthFactor(year,m)` at the SAME
    // anchor — the round-trip is exact (sub-cent, only rounded-to-2dp
    // accumulator noise) at every month. The tolerance is < $1 (not
    // ~1% of $12k) so a future regression that re-introduces ANY
    // anchor drift — month-level or larger — fails here. The
    // negative-control test below pins the pre-fix Jan-vs-Jun
    // mis-anchor drift at the same sample point for comparison.
    const todayMonthIndex = 5;
    const ctx = baseCtx({
      todayMonthIndex,
      inflation: { ratePct: 2 },
    });
    const months = projectExpensesByMonth([baseExpense], ctx, {
      from: 2026,
      to: 2032,
    });
    const deflate = buildViewDeflator('today', {
      nowYear: ctx.todayYear,
      nowMonthIndex: todayMonthIndex,
      inflationPct: 2,
    });
    // Pick a handful of post-anchor months spread across the horizon.
    const samples = [
      { year: 2026, month0: 5 }, // anchor month itself
      { year: 2027, month0: 0 },
      { year: 2029, month0: 8 },
      { year: 2031, month0: 11 },
    ];
    for (const { year, month0 } of samples) {
      const point = months.find((p) => p.year === year && p.month0 === month0);
      expect(point).toBeDefined();
      const roundTrip = point!.essential * deflate(year, month0);
      expect(roundTrip).toBeCloseTo(12000, 1); // ≤ ~$0.05 drift
    }
  });

  it('engine anchored at Jan (pre-fix bug) while deflator stays at June diverges by many dollars at the same sample where the matched case is exact (negative control)', () => {
    // Pins the pre-fix bug. When the engine context anchors at January
    // (`todayMonthIndex: 0`, the inline-literal default the pre-fix
    // Balance Projection page emitted) while the deflator uses the
    // page's actual mid-year `nowMonthIndex`, the engine's
    // `monthFactor` carries a 5-month inflation surplus that the
    // (correctly-anchored) deflator can't fully strip — the round-trip
    // diverges by ~`(1.02)^(5/12) - 1` ≈ 0.83% of the entered amount,
    // i.e. ~$99 on $12k/yr at 2% inflation. The matched-anchor case
    // (test above) collapses to exact identity at the same sample
    // point — so this test asserts the buggy drift is at least a dollar
    // (provably greater than the matched case) and stays close to the
    // closed-form analytical value, catching any future regression
    // that quietly re-introduces an anchor mismatch.
    const deflatorMonthIndex = 5;
    const buggyCtx = baseCtx({
      todayMonthIndex: 0, // ← the pre-fix bug: engine anchored at Jan
      inflation: { ratePct: 2 },
    });
    const buggyMonths = projectExpensesByMonth([baseExpense], buggyCtx, {
      from: 2026,
      to: 2032,
    });
    const deflate = buildViewDeflator('today', {
      nowYear: buggyCtx.todayYear,
      nowMonthIndex: deflatorMonthIndex,
      inflationPct: 2,
    });
    const sample = { year: 2031, month0: 0 };
    const buggyPoint = buggyMonths.find(
      (p) => p.year === sample.year && p.month0 === sample.month0,
    );
    expect(buggyPoint).toBeDefined();
    const buggyRoundTrip = buggyPoint!.essential * deflate(sample.year, sample.month0);
    const buggyDrift = Math.abs(buggyRoundTrip - 12000);
    // Closed-form expected drift: 12000 × ((1.02)^(5/12) - 1) ≈ $99.65.
    const expectedDrift = 12000 * (Math.pow(1.02, 5 / 12) - 1);
    expect(buggyDrift).toBeCloseTo(expectedDrift, 0); // within $1 of analytical
    // Cross-check: the matched-anchor case at the same sample (test
    // above) round-trips to exact identity — so anything more than a
    // dollar here is provably caused by the anchor mismatch.
    expect(buggyDrift).toBeGreaterThan(1);
  });

  it('deflator × engine inflation factor collapse exactly to 1 at a matched anchor (pure identity)', () => {
    // The cross-module guarantee the deflator and engine share: when
    // their `(nowYear, nowMonthIndex)` / `(todayYear, todayMonthIndex)`
    // anchors match, the product of `deflator(year, m)` and the engine's
    // month-precise factor collapses to 1 at every `(year, m)` — this
    // is the identity the Balance Projection page relies on; the
    // engine's year-mean smoothing for continuous expenses (above) is a
    // separate, intentional approximation.
    const anchor = { nowYear: 2026, nowMonthIndex: 5, inflationPct: 2 };
    const asOfMonth = anchor.nowYear * 12 + anchor.nowMonthIndex;
    const deflate = buildViewDeflator('today', anchor);
    const inflationFactorAt = (year: number, m: number) =>
      Math.pow(1 + anchor.inflationPct / 100, (year * 12 + m - asOfMonth) / 12);
    const cases: Array<[number, number]> = [
      [2026, 5],
      [2027, 0],
      [2029, 8],
      [2031, 11],
    ];
    for (const [year, m] of cases) {
      expect(deflate(year, m) * inflationFactorAt(year, m)).toBeCloseTo(1, 12);
    }
  });

  it('collapses to identity when inflationPct = 0 (engine emits real amount, deflator = 1)', () => {
    const ctx = baseCtx({
      todayMonthIndex: 5,
      inflation: { ratePct: 0 },
    });
    const months = projectExpensesByMonth([baseExpense], ctx, {
      from: 2026,
      to: 2027,
    });
    const deflate = buildViewDeflator('today', {
      nowYear: ctx.todayYear,
      nowMonthIndex: 5,
      inflationPct: 0,
    });
    for (const point of months) {
      expect(deflate(point.year, point.month0)).toBe(1);
      expect(point.essential).toBeCloseTo(point.essentialBase, 9);
    }
  });
});

describe('localStorage round-trip via CASHFLOW_GRANULARITY_STORAGE_KEY', () => {
  it('writes + reads the stored granularity under the canonical key', () => {
    const store = new Map<string, string>();
    const ls = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    };
    ls.setItem(CASHFLOW_GRANULARITY_STORAGE_KEY, 'monthly');
    expect(
      parseCashflowGranularity(ls.getItem(CASHFLOW_GRANULARITY_STORAGE_KEY)),
    ).toBe('monthly');
    ls.setItem(CASHFLOW_GRANULARITY_STORAGE_KEY, 'yearly');
    expect(
      parseCashflowGranularity(ls.getItem(CASHFLOW_GRANULARITY_STORAGE_KEY)),
    ).toBe('yearly');
  });
});

describe('parseCompareChoices', () => {
  it('keeps the same retivo.balanceProjection. prefix as the display mode key', () => {
    expect(COMPARE_CHOICE_STORAGE_KEY.startsWith('retivo.balanceProjection.')).toBe(true);
  });

  it('reads a viewed-id to comparison-id object as a map', () => {
    const map = parseCompareChoices('{"a":"b","c":"d"}');
    expect([...map]).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it.each([null, '', '{not json', '[]', '["a"]', '7', '"text"', 'null', 'true'])(
    'reads %j as empty without throwing',
    (stored) => {
      expect(parseCompareChoices(stored).size).toBe(0);
    },
  );

  it('drops entries whose value is not a string and keeps the rest', () => {
    const map = parseCompareChoices('{"a":"b","c":7,"d":null,"e":{"x":1}}');
    expect([...map]).toEqual([['a', 'b']]);
  });

  it('treats __proto__ as an ordinary key', () => {
    const map = parseCompareChoices('{"__proto__":"x"}');
    expect(map.get('__proto__')).toBe('x');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});
