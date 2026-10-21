import { describe, expect, it } from 'vitest';
import type { DrawdownYear } from './drawdown-engine-types';
import { stampZeroConversionPoint } from './balance-projection-runner-tax-zero-point';

function convertedYear(overrides: Partial<DrawdownYear> = {}): DrawdownYear {
  return {
    year: 2040,
    balance: 0,
    withdrawn: 7_000,
    netNeed: 0,
    growth: 0,
    deposit: 0,
    depleted: false,
    rothConvertedCents: 5_000_000,
    rothConversionTaxFundingCentsByAccount: new Map([['hsa', 600_000]]),
    accountBalances: new Map([
      ['ira', { balance: 100, preEnd: 100, postEnd: 0, withdrawn: 1_000, deposit: 0 }],
      ['hsa', { balance: 4_000, preEnd: 0, postEnd: 4_000, withdrawn: 6_000, deposit: 0, postWithdrawnCents: 600_000 }],
    ]),
    ...overrides,
  };
}

describe('stampZeroConversionPoint', () => {
  it('prices a copy with no conversion and none of the draws that paid its tax, and stamps its figures on the row', () => {
    const year = convertedYear();
    let seen: DrawdownYear | undefined;
    stampZeroConversionPoint(year, (copy) => {
      seen = copy;
      copy.magiCents = 12_345_600;
      copy.taxableSsCents = 987_600;
    });
    expect(seen?.rothConvertedCents).toBeUndefined();
    expect(seen?.rothConversionTaxFundingCentsByAccount).toBeUndefined();
    expect(seen?.withdrawn).toBe(1_000);
    expect(seen?.accountBalances?.get('hsa')).toMatchObject({ withdrawn: 0, postWithdrawnCents: 0, postEnd: 10_000 });
    expect(seen?.accountBalances?.get('ira')).toEqual(year.accountBalances?.get('ira'));
    expect(year.rothZeroConversionMagiCents).toBe(12_345_600);
    expect(year.rothZeroConversionTaxableSsCents).toBe(987_600);
  });

  it('leaves the row itself as it was', () => {
    const year = convertedYear();
    stampZeroConversionPoint(year, (copy) => {
      copy.magiCents = 1;
      copy.taxableSsCents = 0;
    });
    expect(year.rothConvertedCents).toBe(5_000_000);
    expect(year.withdrawn).toBe(7_000);
    expect(year.magiCents).toBeUndefined();
    expect(year.accountBalances?.get('hsa')?.withdrawn).toBe(6_000);
  });

  it.each([
    ['no draws were recorded', { rothConversionTaxFundingCentsByAccount: undefined }],
    ['nothing converted', { rothConvertedCents: undefined }],
  ])('stamps nothing when %s', (_label, overrides) => {
    const year = convertedYear(overrides);
    let ran = false;
    stampZeroConversionPoint(year, () => {
      ran = true;
    });
    expect(ran).toBe(false);
    expect(year.rothZeroConversionMagiCents).toBeUndefined();
  });

  it('stamps nothing when the pass could not price the year', () => {
    const year = convertedYear();
    stampZeroConversionPoint(year, () => undefined);
    expect(year.rothZeroConversionMagiCents).toBeUndefined();
    expect(year.rothZeroConversionTaxableSsCents).toBeUndefined();
  });
});
