/** The MC tax post-pass stamps federal tax, IRMAA and ACA cents onto a named strategy's drawdown rows from the real per-account splits. */
import { describe, expect, it } from 'vitest';
import { applyMcTaxToRepresentativeYears } from './monte-carlo-tax-burden';
import {
  applyPerYearTaxForPath,
  classifyMcWithdrawal,
  seedMcAggregateRothBasisCarrier,
  type McAccountYearWithdrawal,
  type McTaxContext,
  type McWithdrawalClassification,
} from './monte-carlo-tax';
import { DEFAULT_TAX_CALIBRATION_BUNDLE, dollarsToCents } from './tax-integration';
import type { DrawdownYear, DrawdownAccountYear } from './drawdown-engine-types';
import type { McTaxPostPassArgs, MonteCarloAccountLedger } from './monte-carlo-types';

const FIRST_YEAR = 2030;
const RETIREMENT_YEAR = 2030;

function mfjContext(overrides: Partial<McTaxContext> = {}): McTaxContext {
  return {
    taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus: 'MFJ',
    members: [
      { memberId: 'primary', isoBirthdate: '1955-01-01', onMedicare: false, hasAcaCoverage: false },
      { memberId: 'secondary', isoBirthdate: '1957-01-01', onMedicare: false, hasAcaCoverage: false },
    ],
    householdSize: 2,
    inflationRatePct: 3,
    ...overrides,
  };
}

function preTaxLedger(id = 'ira'): MonteCarloAccountLedger {
  return {
    id,
    initialPre: 1_000_000,
    initialPost: 0,
    contribPre: new Float64Array(),
    contribPost: new Float64Array(),
    deposit: new Float64Array(),
    assetMix: null,
    assetMixSeries: null,
    cbpPlanningReturnPct: null,
    taxTreatment: 'PRE_TAX',
    accountType: 'RETIREMENT_IRA',
    ownerId: 'primary',
  };
}

function mixedLedger(id = 'mixed-ira'): MonteCarloAccountLedger {
  return {
    ...preTaxLedger(id),
    taxTreatment: 'MIXED',
  };
}

function drawdownPhaseYear(
  year: number,
  preDollars: number,
  accountId = 'ira',
  extra: Partial<DrawdownYear> = {},
): DrawdownYear {
  const acct: DrawdownAccountYear = {
    balance: 1_000_000,
    preEnd: 1_000_000 - preDollars,
    postEnd: 0,
    withdrawn: preDollars,
    deposit: 0,
    preWithdrawnCents: dollarsToCents(preDollars),
    postWithdrawnCents: 0,
  };
  return {
    year,
    balance: 1_000_000,
    withdrawn: preDollars,
    netNeed: preDollars,
    growth: 40_000,
    deposit: 0,
    depleted: false,
    accountBalances: new Map([[accountId, acct]]),
    ...extra,
  };
}

function postPassArgs(
  years: DrawdownYear[],
  ledger: MonteCarloAccountLedger[],
  taxCtx: McTaxContext,
  overrides: Partial<McTaxPostPassArgs> = {},
): McTaxPostPassArgs {
  const horizon = years.length;
  return {
    years,
    ledger,
    taxCtx,
    firstYear: FIRST_YEAR,
    retirementYear: RETIREMENT_YEAR,
    ssByYear: new Array(horizon).fill(30_000),
    incomeByYear: new Array(horizon).fill(0),
    ...overrides,
  };
}

describe('applyMcTaxToRepresentativeYears', () => {
  it('stamps federal tax / IRMAA / ACA cents matching applyPerYearTaxForPath (methodology parity)', () => {
    const ctx = mfjContext();
    const ledger = [preTaxLedger()];
    const preDollars = 90_000;
    const years = [drawdownPhaseYear(FIRST_YEAR, preDollars)];
    applyMcTaxToRepresentativeYears(postPassArgs(years, ledger, ctx));

    const classification: McWithdrawalClassification = {
      preTaxDollars: preDollars,
      postTaxNonRothDollars: 0,
      postTaxCashLikeDollars: 0,
      rothBasisOrderedDollars: 0,
      rothWholesaleTaxFreeDollars: 0,
    };
    const expected = applyPerYearTaxForPath({
      taxCtx: ctx,
      taxYear: FIRST_YEAR,
      retirementYear: RETIREMENT_YEAR,
      grossSsDollars: 30_000,
      nominalExpense: 0,
      otherIncome: 0,
      priorBalance: 0,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
      classification,
      rothBasisCarrier: seedMcAggregateRothBasisCarrier(new Map()),
    })!;

    expect(years[0].federalTaxCents).toBe(dollarsToCents(expected.fedTax));
    expect(years[0].irmaaSurchargeCents).toBe(dollarsToCents(expected.irmaa));
    expect(years[0].acaPtcSubsidyCents).toBe(dollarsToCents(expected.ptc));
    expect(years[0].federalTaxCents!).toBeGreaterThan(0);
  });

  it('uses the per-owner rmdFloorCents override, not a larger pre-tax-pool floor', () => {
    // A $1M pre-tax pool would gross a far larger per-owner RMD floor; the row's $20k override must win.
    const ctx = mfjContext();
    const ledger = [preTaxLedger()];
    const smallDraw = 5_000;
    const perOwnerFloorCents = dollarsToCents(20_000);
    const years = [
      drawdownPhaseYear(FIRST_YEAR, smallDraw, 'ira', {
        rmdFloorCents: perOwnerFloorCents,
        balance: 1_000_000,
      }),
    ];
    applyMcTaxToRepresentativeYears(postPassArgs(years, ledger, ctx));
    const withOverride = years[0].federalTaxCents!;

    const largeFloor = applyPerYearTaxForPath({
      taxCtx: ctx,
      taxYear: FIRST_YEAR,
      retirementYear: RETIREMENT_YEAR,
      grossSsDollars: 30_000,
      nominalExpense: 0,
      otherIncome: 0,
      priorBalance: 1_000_000,
      priorPreTaxByOwner: new Map<string, number>([['primary', 1_000_000_00]]),
      magiMinus2: undefined,
      classification: {
        preTaxDollars: smallDraw,
        postTaxNonRothDollars: 0,
        postTaxCashLikeDollars: 0,
        rothBasisOrderedDollars: 0,
        rothWholesaleTaxFreeDollars: 0,
      },
      rothBasisCarrier: seedMcAggregateRothBasisCarrier(new Map()),
    })!;
    expect(withOverride).toBeLessThan(dollarsToCents(largeFloor.fedTax));
  });

  it('folds the §72(t) early-withdrawal penalty into federalTaxCents', () => {
    // Age 45 in 2030: the 10% §72(t) penalty is added to the stamped federalTaxCents, as in the deterministic chart.
    const ctx = mfjContext({
      members: [
        { memberId: 'primary', isoBirthdate: '1985-01-01', onMedicare: false, hasAcaCoverage: false },
        { memberId: 'secondary', isoBirthdate: '1985-01-01', onMedicare: false, hasAcaCoverage: false },
      ],
      householdSize: 2,
    });
    const ledger = [preTaxLedger()];
    const preDollars = 60_000;
    const years = [drawdownPhaseYear(FIRST_YEAR, preDollars)];
    applyMcTaxToRepresentativeYears(postPassArgs(years, ledger, ctx));
    const withPenalty = years[0].federalTaxCents!;

    // The kernel glue's federalTaxCents excludes the penalty (it lives in the cashflow).
    const glueOnly = applyPerYearTaxForPath({
      taxCtx: ctx,
      taxYear: FIRST_YEAR,
      retirementYear: RETIREMENT_YEAR,
      grossSsDollars: 30_000,
      nominalExpense: 0,
      otherIncome: 0,
      priorBalance: 0,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
      classification: {
        preTaxDollars: preDollars,
        postTaxNonRothDollars: 0,
        postTaxCashLikeDollars: 0,
        rothBasisOrderedDollars: 0,
        rothWholesaleTaxFreeDollars: 0,
      },
      rothBasisCarrier: seedMcAggregateRothBasisCarrier(new Map()),
    })!;
    expect(withPenalty).toBe(dollarsToCents(glueOnly.fedTax) + dollarsToCents(6_000));
  });

  it('charges $0 IRMAA for the first two taxed years with no MAGI bootstrap', () => {
    // No MAGI bootstrap: IRMAA is $0 for projection years 0-1, as in the kernel; year 2 reads year 0's MAGI.
    const ctx = mfjContext({
      members: [
        { memberId: 'primary', isoBirthdate: '1950-01-01', onMedicare: true, hasAcaCoverage: false },
        { memberId: 'secondary', isoBirthdate: '1950-01-01', onMedicare: true, hasAcaCoverage: false },
      ],
    });
    const ledger = [preTaxLedger()];
    const years = [
      drawdownPhaseYear(FIRST_YEAR, 600_000),
      drawdownPhaseYear(FIRST_YEAR + 1, 600_000),
      drawdownPhaseYear(FIRST_YEAR + 2, 600_000),
    ];
    applyMcTaxToRepresentativeYears(postPassArgs(years, ledger, ctx));
    expect(years[0].irmaaSurchargeCents).toBe(0);
    expect(years[1].irmaaSurchargeCents).toBe(0);
    expect(years[2].irmaaSurchargeCents!).toBeGreaterThan(0);
  });

  it('stamps $0 federal tax for a genuine zero / Roth-only low-income year', () => {
    const ctx = mfjContext();
    const ledger = [preTaxLedger()];
    const years = [drawdownPhaseYear(FIRST_YEAR, 100)];
    applyMcTaxToRepresentativeYears(
      postPassArgs(years, ledger, ctx, {
        ssByYear: [0],
        incomeByYear: [0],
      }),
    );
    expect(years[0].federalTaxCents).toBe(0);
  });

  it('taxes the DEPLETION year even though the depletion clamp zeroed its balance to $0', () => {
    // The depletion clamp zeroes the year's balance, but it had a real $90k withdrawal, so it is still taxed.
    const ctx = mfjContext();
    const ledger = [preTaxLedger()];
    const years = [drawdownPhaseYear(FIRST_YEAR, 90_000, 'ira', { balance: 0 })];
    applyMcTaxToRepresentativeYears(
      postPassArgs(years, ledger, ctx, { depletionYear: FIRST_YEAR }),
    );
    expect(years[0].federalTaxCents!).toBeGreaterThan(0);
    expect(years[0].irmaaSurchargeCents).toBeDefined();
    expect(years[0].acaPtcSubsidyCents).toBeDefined();
  });

  it('skips a STRICTLY-post-depletion zero-balance year (control)', () => {
    const ctx = mfjContext();
    const ledger = [preTaxLedger()];
    const depletionRow = drawdownPhaseYear(FIRST_YEAR, 90_000, 'ira', { balance: 0 });
    const postRow = drawdownPhaseYear(FIRST_YEAR + 1, 0, 'ira', {
      balance: 0,
      withdrawn: 0,
      netNeed: 0,
    });
    const years = [depletionRow, postRow];
    applyMcTaxToRepresentativeYears(
      postPassArgs(years, ledger, ctx, { depletionYear: FIRST_YEAR }),
    );
    expect(years[0].federalTaxCents!).toBeGreaterThan(0);
    expect(years[1].federalTaxCents).toBeUndefined();
    expect(years[1].irmaaSurchargeCents).toBeUndefined();
    expect(years[1].acaPtcSubsidyCents).toBeUndefined();
  });

  it('no-ops when members is empty', () => {
    const ctx = mfjContext({ members: [], householdSize: 0 });
    const ledger = [preTaxLedger()];
    const years = [drawdownPhaseYear(FIRST_YEAR, 90_000)];
    applyMcTaxToRepresentativeYears(postPassArgs(years, ledger, ctx));
    expect(years[0].federalTaxCents).toBeUndefined();
  });

  it('detect-and-skips a run whose rows lack the per-account split, leaving kernel values intact', () => {
    const ctx = mfjContext();
    const ledger = [preTaxLedger()];
    // A kernel-fallback row has no preWithdrawnCents and keeps its kernel-funded tax.
    const kernelAcct: DrawdownAccountYear = {
      balance: 1_000_000,
      preEnd: 910_000,
      postEnd: 0,
      withdrawn: 90_000,
      deposit: 0,
    };
    const years: DrawdownYear[] = [
      {
        year: FIRST_YEAR,
        balance: 1_000_000,
        withdrawn: 90_000,
        netNeed: 90_000,
        growth: 40_000,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([['ira', kernelAcct]]),
        federalTaxCents: 777_777,
        irmaaSurchargeCents: 11_111,
        acaPtcSubsidyCents: 22_222,
      },
    ];
    applyMcTaxToRepresentativeYears(postPassArgs(years, ledger, ctx));
    expect(years[0].federalTaxCents).toBe(777_777);
    expect(years[0].irmaaSurchargeCents).toBe(11_111);
    expect(years[0].acaPtcSubsidyCents).toBe(22_222);
  });

  it('leaves pre-retirement accumulation rows (no accountBalances) untouched', () => {
    const ctx = mfjContext();
    const ledger = [preTaxLedger()];
    const accumulationRow: DrawdownYear = {
      year: FIRST_YEAR - 1,
      balance: 800_000,
      withdrawn: 0,
      netNeed: 0,
      growth: 50_000,
      deposit: 10_000,
      depleted: false,
    };
    const years = [accumulationRow, drawdownPhaseYear(FIRST_YEAR, 90_000)];
    applyMcTaxToRepresentativeYears(
      postPassArgs(years, ledger, ctx, {
        ssByYear: [30_000, 30_000],
        incomeByYear: [0, 0],
      }),
    );
    expect(years[0].federalTaxCents).toBeUndefined();
    expect(years[1].federalTaxCents!).toBeGreaterThan(0);
  });

  it('display-only: mutates only the three tax-cent fields, leaving balance/withdrawn/growth untouched', () => {
    const ctx = mfjContext();
    const ledger = [preTaxLedger()];
    const row = drawdownPhaseYear(FIRST_YEAR, 90_000);
    const before = {
      balance: row.balance,
      withdrawn: row.withdrawn,
      growth: row.growth,
      netNeed: row.netNeed,
      accountBalances: row.accountBalances,
    };
    applyMcTaxToRepresentativeYears(postPassArgs([row], ledger, ctx));
    expect(row.balance).toBe(before.balance);
    expect(row.withdrawn).toBe(before.withdrawn);
    expect(row.growth).toBe(before.growth);
    expect(row.netNeed).toBe(before.netNeed);
    expect(row.accountBalances).toBe(before.accountBalances);
  });

  it('classifies a MIXED-account year using the real pre/post split — parity with classifyMcWithdrawal (MIXED branch)', () => {
    const ctx = mfjContext();
    const ledger = [mixedLedger()];
    const preWithdrawnCents = dollarsToCents(40_000);
    const postWithdrawnCents = dollarsToCents(30_000);
    const acct: DrawdownAccountYear = {
      balance: 900_000,
      preEnd: 560_000,
      postEnd: 270_000,
      withdrawn: 70_000,
      deposit: 0,
      preWithdrawnCents,
      postWithdrawnCents,
    };
    const year: DrawdownYear = {
      year: FIRST_YEAR,
      balance: 900_000,
      withdrawn: 70_000,
      netNeed: 70_000,
      growth: 40_000,
      deposit: 0,
      depleted: false,
      accountBalances: new Map([['mixed-ira', acct]]),
    };
    applyMcTaxToRepresentativeYears(postPassArgs([year], ledger, ctx));

    const mixedEntries: McAccountYearWithdrawal[] = [
      {
        taxTreatment: 'PRE_TAX',
        accountType: 'RETIREMENT_IRA',
        withdrawalDollars: 40_000,
        preBalanceStartDollars: 0,
        postBalanceStartDollars: 0,
      },
      // The post tranche rides a MIXED entry so classifyMcWithdrawal's own post-bucket rule routes it.
      {
        taxTreatment: 'MIXED',
        accountType: 'RETIREMENT_IRA',
        withdrawalDollars: 30_000,
        preBalanceStartDollars: 0,
        postBalanceStartDollars: 30_000,
      },
    ];
    const expectedClassification = classifyMcWithdrawal(mixedEntries);
    const expected = applyPerYearTaxForPath({
      taxCtx: ctx,
      taxYear: FIRST_YEAR,
      retirementYear: RETIREMENT_YEAR,
      grossSsDollars: 30_000,
      nominalExpense: 0,
      otherIncome: 0,
      priorBalance: 0,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
      classification: expectedClassification,
      rothBasisCarrier: seedMcAggregateRothBasisCarrier(new Map()),
    })!;

    expect(year.federalTaxCents).toBe(dollarsToCents(expected.fedTax));
    expect(year.irmaaSurchargeCents).toBe(dollarsToCents(expected.irmaa));
    expect(year.acaPtcSubsidyCents).toBe(dollarsToCents(expected.ptc));
    expect(expectedClassification.preTaxDollars).toBe(40_000);
  });

  it('preserves a MIXED 457(b) Roth-designated post tranche as Roth-ordered — not generic POST_TAX — with the 457(b) penalty exemption intact', () => {
    // Pre-59½ members make both penalty legs live: the 457(b) pre tranche is §72(t)-exempt, its Roth-designated post tranche is Roth-ordered (§408A),
    // and only the IRA's $20k is penalized.
    const ctx = mfjContext({
      members: [
        { memberId: 'primary', isoBirthdate: '1985-01-01', onMedicare: false, hasAcaCoverage: false },
        { memberId: 'secondary', isoBirthdate: '1985-01-01', onMedicare: false, hasAcaCoverage: false },
      ],
    });
    const mixed457b: MonteCarloAccountLedger = {
      ...preTaxLedger('mixed-457b'),
      taxTreatment: 'MIXED',
      accountType: 'RETIREMENT_457B',
      initialPost: 300_000,
    };
    const ledger = [mixed457b, preTaxLedger('ira')];
    const mixedAcct: DrawdownAccountYear = {
      balance: 900_000,
      preEnd: 560_000,
      postEnd: 270_000,
      withdrawn: 70_000,
      deposit: 0,
      preWithdrawnCents: dollarsToCents(40_000),
      postWithdrawnCents: dollarsToCents(30_000),
    };
    const iraAcct: DrawdownAccountYear = {
      balance: 980_000,
      preEnd: 980_000,
      postEnd: 0,
      withdrawn: 20_000,
      deposit: 0,
      preWithdrawnCents: dollarsToCents(20_000),
      postWithdrawnCents: 0,
    };
    const year: DrawdownYear = {
      year: FIRST_YEAR,
      balance: 1_880_000,
      withdrawn: 90_000,
      netNeed: 90_000,
      growth: 40_000,
      deposit: 0,
      depleted: false,
      accountBalances: new Map([
        ['mixed-457b', mixedAcct],
        ['ira', iraAcct],
      ]),
    };
    applyMcTaxToRepresentativeYears(postPassArgs([year], ledger, ctx));

    const expectedClassification = classifyMcWithdrawal([
      {
        taxTreatment: 'PRE_TAX',
        accountType: 'RETIREMENT_457B',
        withdrawalDollars: 40_000,
        preBalanceStartDollars: 0,
        postBalanceStartDollars: 0,
        scenarioPenaltyExempt: false,
      },
      {
        taxTreatment: 'MIXED',
        accountType: 'RETIREMENT_457B',
        withdrawalDollars: 30_000,
        preBalanceStartDollars: 0,
        postBalanceStartDollars: 30_000,
        scenarioPenaltyExempt: false,
      },
      {
        taxTreatment: 'PRE_TAX',
        accountType: 'RETIREMENT_IRA',
        withdrawalDollars: 20_000,
        preBalanceStartDollars: 980_000,
        postBalanceStartDollars: 0,
        scenarioPenaltyExempt: false,
      },
    ]);
    expect(expectedClassification.preTaxDollars).toBe(60_000);
    expect(expectedClassification.preTaxPenaltyExemptDollars).toBe(40_000);
    expect(expectedClassification.rothBasisOrderedDollars).toBe(30_000);
    expect(expectedClassification.rothOrderedPenaltyExemptDollars).toBe(30_000);
    expect(expectedClassification.postTaxNonRothDollars).toBe(0);
    expect(expectedClassification.postTaxCashLikeDollars).toBe(0);

    // With no seeded §408A basis the whole $30k Roth-ordered draw is earnings excess; only the IRA's $20k is penalized (10% = $2,000).
    const expected = applyPerYearTaxForPath({
      taxCtx: ctx,
      taxYear: FIRST_YEAR,
      retirementYear: RETIREMENT_YEAR,
      grossSsDollars: 30_000,
      nominalExpense: 0,
      otherIncome: 0,
      priorBalance: 0,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
      classification: expectedClassification,
      rothBasisCarrier: seedMcAggregateRothBasisCarrier(new Map()),
    })!;
    expect(year.federalTaxCents).toBe(
      dollarsToCents(expected.fedTax) + dollarsToCents(2_000),
    );
    expect(year.irmaaSurchargeCents).toBe(dollarsToCents(expected.irmaa));
    expect(year.acaPtcSubsidyCents).toBe(dollarsToCents(expected.ptc));

    // The old lossy POST_TAX collapse taxed the tranche as an LTCG proxy, strictly less than the Roth-ordered earnings excess.
    const collapsed = classifyMcWithdrawal([
      {
        taxTreatment: 'PRE_TAX',
        accountType: 'RETIREMENT_457B',
        withdrawalDollars: 40_000,
        preBalanceStartDollars: 0,
        postBalanceStartDollars: 0,
        scenarioPenaltyExempt: false,
      },
      {
        taxTreatment: 'POST_TAX',
        accountType: 'RETIREMENT_457B',
        withdrawalDollars: 30_000,
        preBalanceStartDollars: 0,
        postBalanceStartDollars: 0,
        scenarioPenaltyExempt: false,
      },
      {
        taxTreatment: 'PRE_TAX',
        accountType: 'RETIREMENT_IRA',
        withdrawalDollars: 20_000,
        preBalanceStartDollars: 980_000,
        postBalanceStartDollars: 0,
        scenarioPenaltyExempt: false,
      },
    ]);
    const collapsedTax = applyPerYearTaxForPath({
      taxCtx: ctx,
      taxYear: FIRST_YEAR,
      retirementYear: RETIREMENT_YEAR,
      grossSsDollars: 30_000,
      nominalExpense: 0,
      otherIncome: 0,
      priorBalance: 0,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
      classification: collapsed,
      rothBasisCarrier: seedMcAggregateRothBasisCarrier(new Map()),
    })!;
    expect(dollarsToCents(expected.fedTax)).toBeGreaterThan(
      dollarsToCents(collapsedTax.fedTax),
    );
  });
});
