import { describe, expect, it } from 'vitest';
import { reconcileYearlyCashflow } from './yearly-cashflow-reconcile';

describe('reconcileYearlyCashflow', () => {
  it('funded steady year: withdrawal = net need, Total income == Expenses, no shortfall', () => {
    const r = reconcileYearlyCashflow({
      earned: 20_000,
      expense: 60_000,
      engineWithdrawn: 40_000,
      funded: true,
    });
    expect(r.withdrawal).toBe(40_000);
    expect(r.totalIncome).toBe(60_000);
    expect(r.totalIncome).toBe(60_000); // == expense
    expect(r.shortfall).toBe(0);
  });

  // The bug: a funded transition year where the engine's monthly-basis `withdrawn` differs from the per-year net need by a material (> $1) proration residual used to render a phantom $50 shortfall; reconciliation snaps Withdrawal to the net need.
  it('funded transition year: snaps Withdrawal to per-year net need, kills the phantom shortfall', () => {
    const r = reconcileYearlyCashflow({
      earned: 20_000,
      expense: 60_000,
      engineWithdrawn: 39_950, // monthly-basis, $50 short of the annual net need
      funded: true,
    });
    expect(r.withdrawal).toBe(40_000); // NOT 39_950
    expect(r.totalIncome).toBe(60_000); // == expense, not 59_950
    expect(r.shortfall).toBe(0); // phantom $50 gap eliminated
  });

  it('funded surplus year (earned > expense): withdrawal 0, Total income = earned > Expenses, no shortfall', () => {
    const r = reconcileYearlyCashflow({
      earned: 80_000,
      expense: 60_000,
      engineWithdrawn: 0,
      funded: true,
    });
    expect(r.withdrawal).toBe(0);
    expect(r.totalIncome).toBe(80_000);
    expect(r.totalIncome).toBeGreaterThan(60_000);
    expect(r.shortfall).toBe(0);
  });

  it('depleted year: engine-actual withdrawn + real shortfall preserved', () => {
    const r = reconcileYearlyCashflow({
      earned: 20_000,
      expense: 60_000,
      engineWithdrawn: 30_000, // capped at available balance
      funded: false,
    });
    expect(r.withdrawal).toBe(30_000);
    expect(r.totalIncome).toBe(50_000);
    expect(r.shortfall).toBe(10_000); // max(0, 60_000 − 50_000)
  });

  it('depleted transition year: not reconciled, engine-actual shortfall stands', () => {
    const r = reconcileYearlyCashflow({
      earned: 20_000,
      expense: 60_000,
      engineWithdrawn: 30_050, // monthly-basis cap in the depletion year
      funded: false,
    });
    expect(r.withdrawal).toBe(30_050);
    expect(r.totalIncome).toBe(50_050);
    expect(r.shortfall).toBeCloseTo(9_950, 6); // engine-actual, not 10_000
  });

  it('no-drawdown / no-year-row (funded=false, engineWithdrawn=0): byte-identical to legacy withdrawn ?? 0', () => {
    const r = reconcileYearlyCashflow({
      earned: 20_000,
      expense: 60_000,
      engineWithdrawn: 0,
      funded: false,
    });
    expect(r.withdrawal).toBe(0);
    expect(r.totalIncome).toBe(20_000);
    expect(r.shortfall).toBe(40_000); // max(0, 60_000 − 20_000)
  });

  it('funded zero/zero year: all zero', () => {
    const r = reconcileYearlyCashflow({
      earned: 0,
      expense: 0,
      engineWithdrawn: 0,
      funded: true,
    });
    expect(r.withdrawal).toBe(0);
    expect(r.totalIncome).toBe(0);
    expect(r.shortfall).toBe(0);
  });
});
