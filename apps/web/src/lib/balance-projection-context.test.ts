/** `buildBalanceExpenseContext` must carry the supplied `nowYear` and `nowMonthIndex` verbatim, or a mid-year page would drift from the view deflator. */
import { describe, expect, it } from 'vitest';
import { buildBalanceExpenseContext } from './balance-projection-context';

describe('buildBalanceExpenseContext', () => {
  it('anchors todayYear + todayMonthIndex to the supplied primitives (mid-year)', () => {
    const ctx = buildBalanceExpenseContext({
      nowYear: 2026,
      nowMonthIndex: 5, // June
      retirementYear: 2030,
    });
    expect(ctx.todayYear).toBe(2026);
    expect(ctx.todayMonthIndex).toBe(5);
    expect(ctx.retirementYear).toBe(2030);
    expect(ctx.extendBeyondLifetime).toBe(false);
  });

  it('passes primary + secondary birthdates through', () => {
    const ctx = buildBalanceExpenseContext({
      nowYear: 2026,
      nowMonthIndex: 0,
      retirementYear: 2030,
      primary: { birthdate: '1965-04-10' },
      secondary: { birthdate: '1967-09-22' },
    });
    expect(ctx.primary).toEqual({ birthdate: '1965-04-10' });
    expect(ctx.secondary).toEqual({ birthdate: '1967-09-22' });
  });

  it('omits primary / secondary when their birthdate is missing', () => {
    const ctx = buildBalanceExpenseContext({
      nowYear: 2026,
      nowMonthIndex: 0,
      retirementYear: 2030,
      primary: { birthdate: null },
      secondary: undefined,
    });
    expect(ctx.primary).toBeUndefined();
    expect(ctx.secondary).toBeUndefined();
  });

  it('passes scenario inflation / discretionary / lifeExpectancy through unchanged', () => {
    const inflation = { ratePct: 2.5 };
    const discretionarySpending = { bumpPct: 10, durationYears: 5 };
    const lifeExpectancy = { primary: 92, secondary: 90 };
    const ctx = buildBalanceExpenseContext({
      nowYear: 2026,
      nowMonthIndex: 0,
      retirementYear: 2030,
      inflation,
      discretionarySpending,
      lifeExpectancy,
    });
    expect(ctx.inflation).toBe(inflation);
    expect(ctx.discretionarySpending).toBe(discretionarySpending);
    expect(ctx.lifeExpectancy).toBe(lifeExpectancy);
  });

  it('passes negative bumpPct through unchanged (clamp lives downstream)', () => {
    const discretionarySpending = { bumpPct: -25, durationYears: null };
    const ctx = buildBalanceExpenseContext({
      nowYear: 2026,
      nowMonthIndex: 0,
      retirementYear: 2030,
      discretionarySpending,
    });
    // Passthrough: clamping to [-100, +100] is the engine's job.
    expect(ctx.discretionarySpending).toBe(discretionarySpending);
    expect(ctx.discretionarySpending?.bumpPct).toBe(-25);
  });

  it('passes legacy out-of-range bumpPct through unchanged (clamp lives downstream)', () => {
    // Older snapshots may store bumpPct: 200; the context layer must not clamp, so the engine applies the authoritative clamp at
    // use.
    const discretionarySpending = { bumpPct: 200, durationYears: null };
    const ctx = buildBalanceExpenseContext({
      nowYear: 2026,
      nowMonthIndex: 0,
      retirementYear: 2030,
      discretionarySpending,
    });
    expect(ctx.discretionarySpending?.bumpPct).toBe(200);
  });
});
