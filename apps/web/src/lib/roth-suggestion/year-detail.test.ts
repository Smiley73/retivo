import { describe, expect, it } from 'vitest';
import type { AccountPayload } from '../../db/types';
import type { DrawdownYear } from '../drawdown-engine-types';
import type { FilingStatus } from '../federal-tax';
import { computeAllInConversionCost } from '../conversion-cost-calculator';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from '../tax-integration-helpers';
import { toyAccount } from './test-fixtures';
import { buildYearDetail, type DetailYearInput, type YearDetailEnvironment } from './year-detail';
import { buildYearRecords, type AccountsById } from './year-records';
import type { YearLimits, YearRecord } from './types';

const YEAR = 2040;
const ACCOUNTS: AccountsById = new Map<string, AccountPayload>([
  ['ira', toyAccount('ira', 'm1', 'RETIREMENT_IRA', 'PRE_TAX').payload],
]);
const ENV: YearDetailEnvironment = {
  bundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
  inflationPct: 2,
  acaFplRegion: undefined,
  taxExemptInterestCents: 0,
};
const BRACKET_TOP = 300_000;
const IRMAA_LINE = 212_000;

function row(overrides: Partial<DrawdownYear> = {}, preTax = 500_000): DrawdownYear {
  return {
    year: YEAR,
    balance: 1_000_000,
    withdrawn: 0,
    netNeed: 0,
    growth: 0,
    deposit: 0,
    depleted: false,
    accountBalances: new Map([['ira', { balance: preTax, preEnd: preTax, postEnd: 0, withdrawn: 0, deposit: 0 }]]),
    ...overrides,
  };
}

function limits(binding: 'bracket' | 'irmaa'): YearLimits {
  const limitDollars = binding === 'irmaa' ? IRMAA_LINE : BRACKET_TOP;
  return {
    year: YEAR,
    bracket: {
      kind: 'bracket',
      valueDollars: BRACKET_TOP,
      bracketRate: 0.24,
      filingStatus: 'MFJ',
      bracketTopDollars: 250_000,
      standardDeductionDollars: 40_000,
      age65AddOnDollars: 10_000,
      seniorBonusDollars: 0,
    },
    irmaa:
      binding === 'irmaa'
        ? {
            kind: 'irmaa',
            applies: true,
            valueDollars: IRMAA_LINE,
            lookbackYear: YEAR + 2,
            filingStatus: 'MFJ',
            referenceTier: 'none',
            thresholdDollars: 212_000,
            scalingFactor: 1,
          }
        : { kind: 'irmaa', applies: false, reason: 'unguarded' },
    aca: { kind: 'aca', applies: false, reason: 'unguarded' },
    limitDollars,
    binding,
    engineOffsetDollars: 0,
    ceilingDollars: limitDollars,
  };
}

function yearInput(
  medicareBeneficiaries: 0 | 1 | 2,
  months = 12,
  social: { grossSsDollars: number; filingStatus: FilingStatus } = { grossSsDollars: 0, filingStatus: 'MFJ' },
): DetailYearInput {
  return {
    facts: { year: YEAR, filingStatus: social.filingStatus, householdSize: 2, age65Count: 2, members: [] },
    lookback: {
      year: YEAR + 2,
      withinHorizon: true,
      medicareBeneficiaries,
      irmaaBeneficiaries: Array.from({ length: medicareBeneficiaries }, () => ({ partBMonths: months, partDMonths: months })),
    },
    grossSsDollars: social.grossSsDollars,
    benchmarkSlcspCents: 2_000_000,
  };
}

function detail(args: {
  readonly engineRow: DrawdownYear;
  readonly limitSet?: YearLimits | null;
  readonly medicare?: 0 | 1 | 2;
  /** Part B and Part D months each beneficiary is enrolled in year Y+2. */
  readonly medicareMonths?: number;
  readonly social?: { grossSsDollars: number; filingStatus: FilingStatus };
  readonly window?: { startYear: number; endYear: number };
}) {
  const { engineRow, limitSet = limits('bracket'), medicare = 2, medicareMonths = 12, social, window = { startYear: YEAR, endYear: YEAR } } = args;
  const records: YearRecord[] = buildYearRecords({
    years: [engineRow],
    window,
    limits: limitSet === null ? null : [limitSet],
    accounts: ACCOUNTS,
  });
  return buildYearDetail({
    records,
    rows: [engineRow],
    years: new Map([[YEAR, yearInput(medicare, medicareMonths, social)]]),
    accounts: ACCOUNTS,
    env: ENV,
  });
}

describe('limit that stopped the year', () => {
  const FILLED = { magiCents: 29_999_900, rothConvertedCents: 10_000_000 };

  it.each([
    ['a conversion filled the bracket line', row(FILLED), 'bracket'],
    ['withdrawals alone reached the ceiling', row({ magiCents: 30_000_000 }), 'already-over'],
    ['the ceiling could not be met', row({ ...FILLED, magiCapBreachDollars: 1_000 }), 'already-over'],
    ['all the pre-tax money converted', row({ magiCents: 20_000_000, rothConvertedCents: 5_000_000 }, 0), 'pre-tax-ran-out'],
    ['the engine had no target Roth', row({ magiCents: 20_000_000, rothConversionDegradedNoTarget: true }), 'no-target'],
    ['income fell short for a reason the row does not name', row({ magiCents: 20_000_000 }), 'under-ceiling'],
  ] as const)('is a row of its own when %s', (_label, engineRow, expected) => {
    const [only] = detail({ engineRow });
    expect(only.limitKind).toBe(expected);
  });

  it('shows a $0 pre-tax year as a row with the money-ran-out reason and the full room as the amount', () => {
    const [only] = detail({ engineRow: row({ magiCents: 20_000_000, rothConvertedCents: 5_000_000 }, 0) });
    expect(only.amountDollars).toBe(50_000);
    expect(only.preTaxEndDollars).toBe(0);
    expect(only.keptUnderDollars).toBeGreaterThan(50_000);
  });

  it('reads the income before and the extra Social Security off the engine\'s zero-conversion figures when the row has them', () => {
    // Income after $300,000: $60,000 converted, $40,000 more from the withdrawals that paid the
    // tax, and a zero point of $190,000 of which $30,000 is taxable Social Security. Backing the
    // conversion out of the row would give $240,000.
    const [only] = detail({
      engineRow: row({
        magiCents: 30_000_000,
        taxableSsCents: 5_000_000,
        rothConvertedCents: 6_000_000,
        rothZeroConversionMagiCents: 19_000_000,
        rothZeroConversionTaxableSsCents: 3_000_000,
      }),
      social: { grossSsDollars: 60_000, filingStatus: 'MFJ' },
    });
    expect(only.incomeBeforeDollars).toBe(190_000);
    expect(only.incomeAfterDollars).toBe(300_000);
    expect(only.extraTaxableSsDollars).toBe(20_000);
    expect(only.taxPaymentIncomeDollars).toBe(30_000);
    expect(only.keptUnderDollars).toBe(BRACKET_TOP - 300_000);
  });

  it('falls back to backing the conversion out of the row when it carries no zero-conversion figures', () => {
    const [only] = detail({
      engineRow: row({ magiCents: 20_000_000, rothConvertedCents: 5_000_000 }),
    });
    expect(only.incomeBeforeDollars).toBe(150_000);
    expect(only.extraTaxableSsDollars).toBe(0);
    expect(only.taxPaymentIncomeDollars).toBe(0);
  });

  it('keeps the year after the window as a row that says no conversion was attempted', () => {
    const rows = buildYearDetail({
      records: buildYearRecords({
        years: [row(), row({}, 400_000)].map((r, i) => ({ ...r, year: YEAR + i })),
        window: { startYear: YEAR, endYear: YEAR },
        limits: [limits('bracket')],
        accounts: ACCOUNTS,
      }),
      rows: [row(), { ...row({}, 400_000), year: YEAR + 1 }],
      years: new Map([[YEAR, yearInput(2)]]),
      accounts: ACCOUNTS,
      env: ENV,
    });
    expect(rows.map((r) => [r.year, r.limitKind, r.inWindow])).toEqual([
      [YEAR, 'under-ceiling', true],
      [YEAR + 1, 'outside-window', false],
    ]);
    expect(rows[1]).toMatchObject({ lines: null, incomeBeforeDollars: null, filingStatus: null, crossingNote: null });
  });

  it('reads the current plan, which has no limits of ours, off its row', () => {
    const [breached] = detail({ engineRow: row({ magiCapBreachDollars: 5 }), limitSet: null });
    const [plain] = detail({ engineRow: row({ rothConvertedCents: 1_000_000 }), limitSet: null });
    expect([breached.limitKind, plain.limitKind]).toEqual(['already-over', 'plan-setting']);
    expect(plain).toMatchObject({ lines: null, limitDollars: null, keptUnderDollars: null, crossingNote: null });
  });
});

describe('the crossing-cost note', () => {
  const CLIFF_YEAR = { magiCents: 21_199_900, rothConvertedCents: 7_000_000 };

  it('is carried by a year the Medicare surcharge line stopped, and by no bracket-limited year', () => {
    const [cliff] = detail({ engineRow: row(CLIFF_YEAR), limitSet: limits('irmaa') });
    const [bracket] = detail({ engineRow: row({ magiCents: 29_999_900, rothConvertedCents: 7_000_000 }) });
    expect(cliff.limitKind).toBe('irmaa');
    expect(cliff.crossingNote?.line).toBe('irmaa');
    expect(bracket.crossingNote).toBeNull();
  });

  it('prices the room between the bracket top and the cliff with the Medicare count two years on', () => {
    const engineRow = row(CLIFF_YEAR);
    const oneMember = detail({ engineRow, limitSet: limits('irmaa'), medicare: 1 })[0].crossingNote;
    const twoMembers = detail({ engineRow, limitSet: limits('irmaa'), medicare: 2 })[0].crossingNote;
    const direct = (count: 1 | 2): number =>
      computeAllInConversionCost(
        {
          year: YEAR,
          filingStatus: 'MFJ',
          conversionCents: (BRACKET_TOP - IRMAA_LINE) * 100,
          taxableIncomeCents: 0,
          magiCents: CLIFF_YEAR.magiCents,
          taxableSsCents: 0,
          grossSsAnnualCents: 0,
          taxExemptInterestCents: 0,
          beneficiariesOnMedicareCount: count,
          householdSize: 2,
          benchmarkAnnualSlcspCents: 2_000_000,
          acaCoverageMonths: 0,
          inflationRatePct: 2,
        },
        ENV.bundle,
      ).irmaaDeltaCents / 100;
    expect(oneMember?.extraConvertedDollars).toBe(BRACKET_TOP - IRMAA_LINE);
    expect(oneMember?.medicareSurchargeDollars).toBeCloseTo(direct(1), 2);
    expect(twoMembers?.medicareSurchargeDollars).toBeCloseTo(direct(2), 2);
    // The retirement-year count would have priced one member where two enrol.
    expect(twoMembers?.medicareSurchargeDollars).toBeGreaterThan(oneMember?.medicareSurchargeDollars ?? Infinity);
  });

  it('prices the surcharge for the months each member is enrolled in the year it is billed', () => {
    const engineRow = row(CLIFF_YEAR);
    const full = detail({ engineRow, limitSet: limits('irmaa'), medicareMonths: 12 })[0].crossingNote;
    const sevenMonths = detail({ engineRow, limitSet: limits('irmaa'), medicareMonths: 7 })[0].crossingNote;
    const direct = (months: number): number =>
      computeAllInConversionCost(
        {
          year: YEAR,
          filingStatus: 'MFJ',
          conversionCents: (BRACKET_TOP - IRMAA_LINE) * 100,
          taxableIncomeCents: 0,
          magiCents: CLIFF_YEAR.magiCents,
          taxableSsCents: 0,
          grossSsAnnualCents: 0,
          taxExemptInterestCents: 0,
          beneficiariesOnMedicareCount: 2,
          irmaaBeneficiaries: [
            { partBMonths: months, partDMonths: months },
            { partBMonths: months, partDMonths: months },
          ],
          householdSize: 2,
          benchmarkAnnualSlcspCents: 2_000_000,
          acaCoverageMonths: 0,
          inflationRatePct: 2,
        },
        ENV.bundle,
      ).irmaaDeltaCents / 100;
    expect(full?.medicareSurchargeDollars).toBeGreaterThan(0);
    expect(sevenMonths?.medicareSurchargeDollars).toBeCloseTo(direct(7), 2);
    // Seven of twelve months, not a whole year of surcharge.
    expect(sevenMonths?.medicareSurchargeDollars).toBeCloseTo((full?.medicareSurchargeDollars ?? NaN) * (7 / 12), 0);
  });

  it('probes at least $1 when the cliff sits on the bracket line', () => {
    const tied: YearLimits = { ...limits('irmaa'), limitDollars: BRACKET_TOP };
    const [only] = detail({ engineRow: row(CLIFF_YEAR), limitSet: tied });
    expect(only.crossingNote?.extraConvertedDollars).toBe(1);
  });
});

describe('the income on the limit line', () => {
  it('adds back nothing when the year has no Social Security', () => {
    const [only] = detail({ engineRow: row({ magiCents: 20_000_000, rothConvertedCents: 5_000_000 }) });
    expect(only.incomeBeforeDollars).toBe(150_000);
    expect(only.incomeAfterDollars).toBe(200_000);
    expect(only.extraTaxableSsDollars).toBe(0);
    expect(only.filingStatus).toBe('MFJ');
  });

  // §86 worked by hand: provisional income = other income + half the benefit.
  // $30,000 of benefits, $20,000 of other income, then a $40,000 conversion.
  //   Before: $20,000 + $15,000 = $35,000.
  //   After:  $60,000 + $15,000 = $75,000, past both tiers, so 85% of the benefit
  //           is taxable: $25,500.
  const AFTER = { magiCents: 8_550_000, rothConvertedCents: 4_000_000, taxableSsCents: 2_550_000 };
  const GROSS_SS = 30_000;

  it('takes the benefit taxed before the conversion from the joint thresholds on a joint return', () => {
    // Joint: 50% of the $3,000 above $32,000 is $1,500 taxable before.
    const [only] = detail({ engineRow: row(AFTER), social: { grossSsDollars: GROSS_SS, filingStatus: 'MFJ' } });
    expect(only.incomeBeforeDollars).toBe(21_500);
    expect(only.incomeAfterDollars).toBe(85_500);
    expect(only.extraTaxableSsDollars).toBe(24_000);
  });

  it('takes the benefit taxed before the conversion from the single thresholds on a single return', () => {
    // Single: 85% of the $1,000 above $34,000 plus the $4,500 from the 50% tier is $5,350.
    const [only] = detail({ engineRow: row(AFTER), social: { grossSsDollars: GROSS_SS, filingStatus: 'Single' } });
    expect(only.incomeBeforeDollars).toBe(25_350);
    expect(only.extraTaxableSsDollars).toBe(20_150);
  });

  it('taxes none of the benefit before a conversion that starts under the base amount', () => {
    // Single, $10,000 of other income: provisional income $25,000 is at the base amount.
    const [only] = detail({
      engineRow: row({ magiCents: 6_235_000, rothConvertedCents: 3_000_000, taxableSsCents: 2_235_000 }),
      social: { grossSsDollars: GROSS_SS, filingStatus: 'Single' },
    });
    expect(only.incomeBeforeDollars).toBe(10_000);
    expect(only.extraTaxableSsDollars).toBe(22_350);
  });
});
