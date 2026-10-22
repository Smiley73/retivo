import { describe, expect, it } from 'vitest';
import type { DrawdownAccountYear, DrawdownYear } from './drawdown-engine-types';
import { stampZeroConversionPoint } from './balance-projection-runner-tax-zero-point';
import { applyTaxIntegrationToDrawdownYears } from './balance-projection-runner-tax';
import {
  REAL_BUNDLE,
  makeAccountBalance,
  makeCtx,
  makeDrawdownYear,
  makeLedgerAccount,
} from './balance-projection-runner-tax-test-fixtures';

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

describe('applyTaxIntegrationToDrawdownYears — zero-conversion repricing', () => {
  // 2026 and 2027 convert and draw Roth basis that runs out over four years;
  // 2028/2029 read their MAGI through IRMAA's look-back, so a repricing that
  // leaked into the running state would move a later row.
  const accountProjections = [
    { id: 'ira', taxTreatment: 'PRE_TAX' as const, accountType: 'RETIREMENT_IRA' },
    { id: 'brok', taxTreatment: 'POST_TAX' as const, accountType: 'BROKERAGE' },
    { id: 'roth', taxTreatment: 'ROTH' as const, accountType: 'RETIREMENT_ROTH_IRA', ownerId: 'member-primary' },
    { id: 'r401k', taxTreatment: 'ROTH' as const, accountType: 'RETIREMENT_ROTH_401K', ownerId: 'member-primary' },
  ];
  const ctx = makeCtx({
    primaryBirthdate: '1958-01-01',
    primaryRetirementYear: 2026,
    accountProjections,
    magiCapTargetRothAccountId: 'roth',
    costBasisFraction: 0.5,
    rothDistributionFacts: {
      rothIraByPool: new Map([
        ['member-primary', {
          ownerId: 'member-primary',
          rothIra: { regularContributionBasisCents: 30_000 * 100, conversionLots: [] },
        }],
      ]),
      designatedByAccount: new Map([
        ['r401k', {
          accountId: 'r401k',
          ownerId: 'member-primary',
          basisCents: 50_000 * 100,
          firstParticipationTaxYear: 2024,
        }],
      ]),
    },
  });
  const ledger = [
    makeLedgerAccount('ira', 2_000_000),
    makeLedgerAccount('brok', 0, 400_000, { accountType: 'BROKERAGE', taxTreatment: 'POST_TAX' }),
    makeLedgerAccount('roth', 0, 300_000, { accountType: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH' }),
    makeLedgerAccount('r401k', 0, 100_000, { accountType: 'RETIREMENT_ROTH_401K', taxTreatment: 'ROTH' }),
  ];
  const ssRows = Array.from({ length: 4 * 12 }, (_, k) => ({
    year: 2026 + Math.floor(k / 12),
    month0: k % 12,
    total: 2_500,
    primary: 2_500,
  }));

  type Draws = Record<'ira' | 'brok' | 'roth' | 'r401k', number>;

  function row(
    year: number,
    draws: Draws,
    conversion?: { cents: number; fundingCents: ReadonlyMap<string, number> },
  ): DrawdownYear {
    const post = (balance: number, withdrawn: number) =>
      makeAccountBalance(balance, withdrawn, { postWithdrawnCents: withdrawn * 100 });
    const balances = new Map<string, DrawdownAccountYear>([
      ['ira', makeAccountBalance(2_000_000, draws.ira)],
      ['brok', post(400_000, draws.brok)],
      ['roth', post(300_000, draws.roth)],
      ['r401k', post(100_000, draws.r401k)],
    ]);
    const base = makeDrawdownYear(year, draws.ira + draws.brok + draws.roth + draws.r401k, balances);
    if (conversion === undefined) return base;
    return {
      ...base,
      rothConvertedCents: conversion.cents,
      rothConversionTaxFundingCentsByAccount: conversion.fundingCents,
    };
  }

  function rows(): DrawdownYear[] {
    return [
      row(2026, { ira: 30_000, brok: 15_000, roth: 20_000, r401k: 20_000 }, {
        cents: 120_000 * 100,
        fundingCents: new Map([['brok', 12_000 * 100]]),
      }),
      row(2027, { ira: 30_000, brok: 10_000, roth: 20_000, r401k: 20_000 }, {
        cents: 120_000 * 100,
        fundingCents: new Map([['ira', 6_000 * 100], ['brok', 6_000 * 100]]),
      }),
      row(2028, { ira: 20_000, brok: 10_000, roth: 30_000, r401k: 20_000 }),
      row(2029, { ira: 20_000, brok: 10_000, roth: 30_000, r401k: 20_000 }),
    ];
  }

  /** The row without what only the repricing touches. */
  function ownFields(year: DrawdownYear): DrawdownYear {
    const out = { ...year };
    delete out.rothConversionTaxFundingCentsByAccount;
    delete out.rothZeroConversionMagiCents;
    delete out.rothZeroConversionTaxableSsCents;
    return out;
  }

  it('leaves every row the pass prices exactly as it is without the repricing', () => {
    const repriced = rows();
    applyTaxIntegrationToDrawdownYears(repriced, ssRows, [], ledger, ctx, REAL_BUNDLE);
    const plain = rows().map((y) => {
      const out = { ...y };
      delete out.rothConversionTaxFundingCentsByAccount;
      return out;
    });
    applyTaxIntegrationToDrawdownYears(plain, ssRows, [], ledger, ctx, REAL_BUNDLE);

    // The repricing ran for both converted years and for nothing else.
    expect(repriced.map((y) => y.rothZeroConversionMagiCents !== undefined)).toEqual([true, true, false, false]);
    expect(plain.some((y) => y.rothZeroConversionMagiCents !== undefined)).toBe(false);
    // The later rows carry what a leak would move: IRMAA from the converted
    // years' MAGI.
    expect(repriced[2].irmaaSurchargeCents ?? 0).toBeGreaterThan(0);
    expect(repriced[3].irmaaSurchargeCents ?? 0).toBeGreaterThan(0);

    expect(repriced.map(ownFields)).toEqual(plain.map(ownFields));
  });
});
