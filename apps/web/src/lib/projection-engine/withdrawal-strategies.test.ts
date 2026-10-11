import { describe, expect, it } from 'vitest';
import { netNeedStrategy, type WithdrawalStepContext } from './withdrawal-strategies';

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
    // Surplus income is signalled as a NEGATIVE net need (not clamped
    // to 0). The kernel clamps the recorded withdrawal to >= 0; the
    // per-account strategy engine routes the surplus to a cash-like account.
    expect(netNeedStrategy(ctx({ inflatedExpense: 100, income: 150 }))).toBe(-50);
    expect(netNeedStrategy(ctx({ inflatedExpense: 0, income: 0 }))).toBe(0);
  });
});
