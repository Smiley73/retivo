import { describe, expect, it } from 'vitest';
import { netNeedStrategy } from './withdrawal-strategies';

type WithdrawalStepContext = Parameters<typeof netNeedStrategy>[0];

function ctx(partial: Partial<WithdrawalStepContext>): WithdrawalStepContext {
  return {
    stepIdx: 0,
    stepsRemaining: 0,
    currentBalance: 0,
    initialBalance: 0,
    inflatedExpense: 0,
    income: 0,
    cumCpi: 1,
    priorWithdrawal: 0,
    ...partial,
  };
}

describe('netNeedStrategy', () => {
  it('returns expense − income (negative when income exceeds expense)', () => {
    expect(netNeedStrategy(ctx({ inflatedExpense: 100, income: 30 }))).toBe(70);
    // Surplus income is a negative net need, not clamped to 0: the strategy engine routes it to a cash-like account.
    expect(netNeedStrategy(ctx({ inflatedExpense: 100, income: 150 }))).toBe(-50);
    expect(netNeedStrategy(ctx({ inflatedExpense: 0, income: 0 }))).toBe(0);
  });
});
