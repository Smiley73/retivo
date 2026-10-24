import { describe, expect, it } from 'vitest';
import {
  resolveEndMonth,
  resolveGlideAnchorMonth,
  type ScheduleResolveContext,
} from './schedule-resolution';
import type { ScheduleEnd } from '../db/types';

const ctx: ScheduleResolveContext = {
  retirementYear: 2030,
  retirementMonth0: 5, // June
  primary: { birthdate: '1965-03-01' }, // March 1965
  secondary: { birthdate: '1968-01-01' },
};

const expenseStart = { year: 2033, month0: 0 }; // a one-off-style start

describe('resolveGlideAnchorMonth', () => {
  it('retirementStart → the retirement (year, month0)', () => {
    expect(
      resolveGlideAnchorMonth({ kind: 'retirementStart' }, expenseStart, ctx),
    ).toEqual({ year: 2030, month0: 5 });
  });

  it('year → January of that year', () => {
    expect(
      resolveGlideAnchorMonth({ kind: 'year', year: 2044 }, expenseStart, ctx),
    ).toEqual({ year: 2044, month0: 0 });
  });

  it('age → birth month + years·12 + months', () => {
    expect(
      resolveGlideAnchorMonth(
        { kind: 'age', memberId: 'primary', years: 70, months: 0 },
        expenseStart,
        ctx,
      ),
    ).toEqual({ year: 2035, month0: 2 });
  });

  it('age → null when the referenced member has no birthdate', () => {
    expect(
      resolveGlideAnchorMonth(
        { kind: 'age', memberId: 'secondary', years: 70, months: 0 },
        expenseStart,
        { ...ctx, secondary: undefined },
      ),
    ).toBeNull();
  });

  it('durationFromExpenseStart → expense start offset by N months', () => {
    expect(
      resolveGlideAnchorMonth(
        { kind: 'durationFromExpenseStart', months: 18 },
        expenseStart,
        ctx,
      ),
    ).toEqual({ year: 2034, month0: 6 });
  });

  it('durationFromExpenseStart is per-expense (different starts → different points)', () => {
    const a = resolveGlideAnchorMonth(
      { kind: 'durationFromExpenseStart', months: 12 },
      { year: 2031, month0: 0 },
      ctx,
    );
    const b = resolveGlideAnchorMonth(
      { kind: 'durationFromExpenseStart', months: 12 },
      { year: 2041, month0: 0 },
      ctx,
    );
    expect(a).toEqual({ year: 2032, month0: 0 });
    expect(b).toEqual({ year: 2042, month0: 0 });
  });

  it('expenseEnd → the resolved expense end (via resolveEndMonth)', () => {
    const end: ScheduleEnd = {
      kind: 'age',
      memberId: 'primary',
      years: 80,
      months: 0,
    };
    expect(
      resolveGlideAnchorMonth({ kind: 'expenseEnd' }, expenseStart, ctx, end),
    ).toEqual({ year: 2045, month0: 2 });
  });

  it('expenseEnd → year-kind end resolves to the exclusive Jan-after boundary', () => {
    const end: ScheduleEnd = { kind: 'year', year: 2048 };
    expect(
      resolveGlideAnchorMonth({ kind: 'expenseEnd' }, expenseStart, ctx, end),
    ).toEqual({ year: 2049, month0: 0 });
  });

  it('expenseEnd → null when no end is threaded (one-off / not supplied)', () => {
    expect(
      resolveGlideAnchorMonth({ kind: 'expenseEnd' }, expenseStart, ctx),
    ).toBeNull();
  });

  it('expenseEnd → null when the threaded end is itself unresolvable', () => {
    const end: ScheduleEnd = {
      kind: 'age',
      memberId: 'secondary',
      years: 75,
      months: 0,
    };
    expect(
      resolveGlideAnchorMonth({ kind: 'expenseEnd' }, expenseStart, {
        ...ctx,
        secondary: undefined,
      }, end),
    ).toBeNull();
  });

  it('lifetime end (via expenseEnd) → exclusive boundary Jan 1 of deathYear + 1', () => {
    // Born March 1965, default life expectancy 95: death is Dec 31 of 2060, so the exclusive end boundary is Jan 1 2061 regardless of birth month.
    const end: ScheduleEnd = { kind: 'lifetime', whose: 'primary' };
    expect(
      resolveGlideAnchorMonth({ kind: 'expenseEnd' }, expenseStart, ctx, end),
    ).toEqual({ year: 2061, month0: 0 });
  });

  it('non-expenseEnd kinds are byte-identical with the new optional arg absent vs supplied', () => {
    const irrelevantEnd: ScheduleEnd = { kind: 'year', year: 2099 };
    for (const anchor of [
      { kind: 'retirementStart' as const },
      { kind: 'year' as const, year: 2044 },
      { kind: 'age' as const, memberId: 'primary' as const, years: 70, months: 0 },
      { kind: 'durationFromExpenseStart' as const, months: 18 },
    ]) {
      expect(
        resolveGlideAnchorMonth(anchor, expenseStart, ctx, irrelevantEnd),
      ).toEqual(resolveGlideAnchorMonth(anchor, expenseStart, ctx));
    }
  });
});

describe('resolveEndMonth — lifetime (death = Dec 31 of deathYear)', () => {
  const lifeCtx: ScheduleResolveContext = {
    retirementYear: 2030,
    primary: { birthdate: '1965-03-12' }, // March 1965
    secondary: { birthdate: '1968-09-20' }, // Sept 1968
    lifeExpectancy: { primary: 90, secondary: 95 },
  };
  const startMonth = { year: 2030, month0: 0 };

  it("whose: 'primary' → Jan 1 of (birthYear + age) + 1", () => {
    expect(
      resolveEndMonth({ kind: 'lifetime', whose: 'primary' }, startMonth, lifeCtx),
    ).toEqual({ year: 2056, month0: 0 });
  });

  it("whose: 'secondary' → Jan 1 of (birthYear + age) + 1", () => {
    expect(
      resolveEndMonth({ kind: 'lifetime', whose: 'secondary' }, startMonth, lifeCtx),
    ).toEqual({ year: 2064, month0: 0 });
  });

  it("whose: 'last' → the later member's deathYear + 1", () => {
    expect(
      resolveEndMonth({ kind: 'lifetime', whose: 'last' }, startMonth, lifeCtx),
    ).toEqual({ year: 2064, month0: 0 });
  });
});
