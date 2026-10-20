import { describe, expect, it } from 'vitest';
import type { AccountPayload } from '../../db/types';
import type { DrawdownAccountYear, DrawdownYear } from '../drawdown-engine-types';
import { buildYearRecords, preTaxDollarsAtRowEnd, type AccountsById } from './year-records';
import type { YearLimits } from './types';
import { toyAccount } from './test-fixtures';

const ACCOUNTS: AccountsById = new Map<string, AccountPayload>(
  [
    toyAccount('ira', 'm1', 'RETIREMENT_IRA', 'PRE_TAX'),
    toyAccount('k401', 'm1', 'RETIREMENT_401K', 'MIXED'),
    toyAccount('roth', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH'),
    toyAccount('brk', 'm1', 'BROKERAGE', 'POST_TAX'),
  ].map((a) => [a.id, a.payload]),
);

function balance(preEnd: number): DrawdownAccountYear {
  return { balance: preEnd, preEnd, postEnd: 0, withdrawn: 0, deposit: 0 };
}

function row(year: number, overrides: Partial<DrawdownYear> = {}, preTax = 500_000): DrawdownYear {
  return {
    year,
    balance: 1_000_000,
    withdrawn: 0,
    netNeed: 0,
    growth: 0,
    deposit: 0,
    depleted: false,
    accountBalances: new Map([
      ['ira', balance(preTax)],
      ['k401', balance(0)],
      ['roth', { ...balance(0), postEnd: 300_000 }],
      ['brk', { ...balance(0), postEnd: 200_000 }],
    ]),
    ...overrides,
  };
}

function limits(year: number, ceilingDollars: number): YearLimits {
  return {
    year,
    bracket: {
      kind: 'bracket',
      valueDollars: ceilingDollars,
      bracketRate: 0.22,
      filingStatus: 'MFJ',
      bracketTopDollars: 0,
      standardDeductionDollars: 0,
      age65AddOnDollars: 0,
      seniorBonusDollars: 0,
    },
    irmaa: { kind: 'irmaa', applies: false, reason: 'unguarded' },
    aca: { kind: 'aca', applies: false, reason: 'unguarded' },
    limitDollars: ceilingDollars,
    binding: 'bracket',
    engineOffsetDollars: 0,
    ceilingDollars,
  };
}

const WINDOW = { startYear: 2030, endYear: 2031 };

describe('preTaxDollarsAtRowEnd', () => {
  it('counts pre-tax and mixed accounts only', () => {
    const r = row(2030, {
      accountBalances: new Map([
        ['ira', balance(100)],
        ['k401', balance(40)],
        ['roth', balance(7)],
        ['brk', balance(9)],
        ['unknown', balance(11)],
      ]),
    });
    expect(preTaxDollarsAtRowEnd(r, ACCOUNTS)).toBe(140);
  });

  it('is zero for a row without account balances', () => {
    const { accountBalances, ...rest } = row(2030);
    expect(accountBalances).toBeDefined();
    expect(preTaxDollarsAtRowEnd(rest as DrawdownYear, ACCOUNTS)).toBe(0);
  });
});

describe('buildYearRecords', () => {
  function stopFor(r: DrawdownYear, ceiling = 100_000): string | null {
    const records = buildYearRecords({
      years: [r],
      window: { startYear: r.year, endYear: r.year },
      limits: [limits(r.year, ceiling)],
      accounts: ACCOUNTS,
    });
    return records[0].stop;
  }

  it('says the limit bound a year the conversion filled up to the ceiling', () => {
    expect(stopFor(row(2030, { magiCents: 10_300_000, rothConvertedCents: 4_000_000 }))).toBe('limit');
  });

  it('says withdrawals alone were at the ceiling when nothing was converted', () => {
    expect(stopFor(row(2030, { magiCents: 10_050_000 }))).toBe('withdrawals-at-ceiling');
  });

  it('says pre-tax money ran out when MAGI stopped short of the ceiling and none is left', () => {
    expect(stopFor(row(2030, { magiCents: 6_000_000, rothConvertedCents: 3_000_000 }, 0))).toBe('pre-tax-exhausted');
  });

  it('does not call a year with nothing left to convert a cliff', () => {
    expect(stopFor(row(2030, { magiCents: 10_050_000 }, 0))).toBe('pre-tax-exhausted');
  });

  it('says headroom went unused when MAGI is short of the ceiling with pre-tax money left', () => {
    expect(stopFor(row(2030, { magiCents: 6_000_000 }))).toBe('unused-headroom');
  });

  it('says the ceiling was breached ahead of every other reason', () => {
    expect(stopFor(row(2030, { magiCents: 10_300_000, rothConvertedCents: 1, magiCapBreachDollars: 12_000 }))).toBe('breach');
  });

  it('allows a $2 slack around the ceiling for the conversion solver tolerance', () => {
    expect(stopFor(row(2030, { magiCents: 9_999_900, rothConvertedCents: 5_000 }))).toBe('limit');
    expect(stopFor(row(2030, { magiCents: 9_990_000, rothConvertedCents: 5_000 }))).toBe('unused-headroom');
  });

  it('records the figures off the row in nominal cents, and the IRMAA two years on', () => {
    const rows = [
      row(2030, {
        magiCents: 10_200_000,
        rothConvertedCents: 5_000_000,
        taxableSsCents: 1_200_000,
        ssTaxationTier: 'eighty-five',
        federalTaxCents: 1_500_000,
        irmaaSurchargeCents: 7_000,
        irmaaTier: 'tier1',
        acaPtcSubsidyCents: 900_000,
        acaPtcTier: 'sliding',
        magiCapTierOverrideDollars: 4_500,
        magiCapBreachDollars: 0,
      }),
      row(2031),
      row(2032, { irmaaTier: 'tier2', irmaaSurchargeCents: 31_000 }),
    ];
    const [record] = buildYearRecords({
      years: rows,
      window: WINDOW,
      limits: [limits(2030, 100_000), limits(2031, 100_000)],
      accounts: ACCOUNTS,
    });
    expect(record).toMatchObject({
      year: 2030,
      inWindow: true,
      ceilingDollars: 100_000,
      binding: 'bracket',
      convertedCents: 5_000_000,
      magiCents: 10_200_000,
      taxableSsCents: 1_200_000,
      ssTaxationTier: 'eighty-five',
      federalTaxCents: 1_500_000,
      irmaaSurchargeCents: 7_000,
      irmaaTier: 'tier1',
      acaPtcSubsidyCents: 900_000,
      acaPtcTier: 'sliding',
      reroutedDollars: 4_500,
      breachedDollars: 0,
      lookbackIrmaaTier: 'tier2',
      lookbackIrmaaSurchargeCents: 31_000,
    });
  });

  it('adds the year after the window, with no ceiling, and skips a year the projection lacks', () => {
    const records = buildYearRecords({
      years: [row(2030), row(2032)],
      window: WINDOW,
      limits: [limits(2030, 100_000), limits(2031, 100_000)],
      accounts: ACCOUNTS,
    });
    // 2031 has no row; 2032 is the year after the window.
    expect(records.map((r) => r.year)).toEqual([2030, 2032]);
    expect(records[1]).toMatchObject({ inWindow: false, ceilingDollars: null, binding: null, limits: null, stop: 'window-ended' });
  });

  it('carries no ceiling, limit or stop on the reference, and defaults an absent field', () => {
    const records = buildYearRecords({
      years: [row(2030), row(2031)],
      window: WINDOW,
      limits: null,
      accounts: ACCOUNTS,
    });
    expect(records[0]).toMatchObject({
      ceilingDollars: null,
      binding: null,
      limits: null,
      stop: null,
      convertedCents: 0,
      magiCents: 0,
      ssTaxationTier: 'none',
      irmaaTier: 'none',
      acaPtcTier: 'below-fpl',
      lookbackIrmaaTier: null,
      lookbackIrmaaSurchargeCents: null,
    });
  });
});
