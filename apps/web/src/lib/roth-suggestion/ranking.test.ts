import { describe, expect, it } from 'vitest';
import { rankedOrder, type RankInput } from './ranking';

function input(id: string, overrides: Partial<RankInput> = {}): RankInput {
  return {
    id,
    ranked: true,
    afterTaxTodayDollars: 1_000_000,
    totalConvertedTodayDollars: 100_000,
    bracketRate: 0.22,
    ...overrides,
  };
}

describe('rankedOrder', () => {
  it('orders by after-tax balance, best first', () => {
    const order = rankedOrder([
      input('a', { afterTaxTodayDollars: 900_000 }),
      input('b', { afterTaxTodayDollars: 1_100_000 }),
      input('c', { afterTaxTodayDollars: 1_000_000 }),
    ]);
    expect(order).toEqual(['b', 'c', 'a']);
  });

  it('leaves out a candidate whose cap was not met', () => {
    const order = rankedOrder([
      input('a', { afterTaxTodayDollars: 2_000_000, ranked: false }),
      input('b'),
    ]);
    expect(order).toEqual(['b']);
  });

  it('breaks a tie to the cent by fewer dollars converted', () => {
    const order = rankedOrder([
      input('more', { afterTaxTodayDollars: 1_000_000.004, totalConvertedTodayDollars: 300_000 }),
      input('less', { afterTaxTodayDollars: 1_000_000.001, totalConvertedTodayDollars: 200_000 }),
    ]);
    expect(order).toEqual(['less', 'more']);
  });

  it('then breaks it by the lower bracket, the current plan counting as lowest', () => {
    const order = rankedOrder([
      input('b24', { bracketRate: 0.24 }),
      input('b12', { bracketRate: 0.12 }),
      input('plan', { bracketRate: null }),
    ]);
    expect(order).toEqual(['plan', 'b12', 'b24']);
  });

  it('then keeps grid order', () => {
    expect(rankedOrder([input('first'), input('second')])).toEqual(['first', 'second']);
  });
});
