/** The MC per-year tax estimator: alive-state, withdrawal classification, RMD floor, penalties, IRMAA and ACA, with parity against the deterministic engine. */
import { describe, expect, it } from 'vitest';
import {
  advanceAfterTaxBase,
  advanceMcTaxableIncomeState,
  applyPerYearTaxForPath,
  buildKernelWholePortfolioPreTaxByOwner,
  buildPreTaxCentsByOwnerIdx,
  buildPriorPreTaxByOwnerFromIdx,
  buildYearClassification,
  classifyMcWithdrawal,
  computeMcPenaltyDollars,
  computeMcRmdFloorCents,
  countTaxpayersAge65Plus,
  creditMcConversionToBasisCarrier,
  deriveMcSurvivors,
  seedMcAggregateRothBasisCarrier,
  seedMcDesignatedRothPool,
  applyMcRothBasisOrdering,
  type McRothOrderedProfile,
  MC_AGGREGATE_ROTH_OWNER_KEY,
  type McAccountYearWithdrawal,
  type McPreTaxLedgerEntry,
  type McSurvivorState,
  type McTaxContext,
  type PerYearTaxArgs,
} from './monte-carlo-tax';
import {
  advanceBrokerageLikeBasis,
  buildMemberInputs,
  computeCashLikeInterestDollars,
} from './balance-projection-runner-tax-helpers';
import { makeCtx, REAL_BUNDLE } from './balance-projection-runner-tax-test-fixtures';
import { applyTaxYear } from './tax-integration';
import { defaultHouseholdSlcspByAge } from './tax-integration-helpers';
import { seedRothBasisCarrier } from './balance-projection-runner-roth-basis';
import type { DrawdownAccountYear } from './drawdown-engine-types';
import type { TaxMemberInput } from './tax-integration';
import type { TaxFilingPlan } from './filing-status';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from './tax-integration';
import { runMonteCarlo, type MonteCarloInput } from './monte-carlo';
import { makeMonthlyExpenseBase } from './monte-carlo.test-helpers';
import mcParityBaselines from './__fixtures__/mc-parity-baselines.json';

function makeMfjTaxContext(overrides: Partial<McTaxContext> = {}): McTaxContext {
  return {
    taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus: 'MFJ',
    members: [
      { memberId: 'primary', isoBirthdate: '1960-01-01', onMedicare: false, hasAcaCoverage: false },
      { memberId: 'secondary', isoBirthdate: '1962-01-01', onMedicare: false, hasAcaCoverage: false },
    ],
    householdSize: 2,
    inflationRatePct: 3,
    ...overrides,
  };
}

// Member flags as the per-path loop resolves them, through the production entry `deriveMcSurvivors`.
function memberFlags(
  member: TaxMemberInput,
  taxYear: number,
  retirementYear: number,
  optedOut: ReadonlySet<string> = new Set(),
  healthCoverageMonths?: McTaxContext['healthCoverageMonths'],
): TaxMemberInput {
  const taxCtx = {
    taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus: 'Single',
    members: [member],
    householdSize: 1,
    inflationRatePct: 0,
    ...(optedOut.size > 0 ? { acaMarketplaceOptOutMemberIds: [...optedOut] } : {}),
    ...(healthCoverageMonths !== undefined ? { healthCoverageMonths } : {}),
  } as unknown as McTaxContext;
  return deriveMcSurvivors(taxCtx, taxYear, retirementYear)!.survivors[0];
}

describe('applyPerYearTaxForPath — per-year alive-state', () => {
  it('survivor year (secondary deceased) → no tax math attempted with full MFJ context', () => {
    const ctx = makeMfjTaxContext({
      primaryDeathYear: 2055,
      secondaryDeathYear: 2047,
    });
    const result = applyPerYearTaxForPath({
      taxCtx: ctx,
      taxYear: 2050,
      retirementYear: 2030,
      grossSsDollars: 30_000,
      nominalExpense: 80_000,
      otherIncome: 0,
      priorBalance: 1_000_000,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
    });
    expect(result).not.toBeNull();
    const ctxBothAlive = makeMfjTaxContext();
    const bothAliveResult = applyPerYearTaxForPath({
      taxCtx: ctxBothAlive,
      taxYear: 2050,
      retirementYear: 2030,
      grossSsDollars: 30_000,
      nominalExpense: 80_000,
      otherIncome: 0,
      priorBalance: 1_000_000,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
    });
    expect(result!.fedTax).toBeGreaterThan(bothAliveResult!.fedTax);
  });

  it('both deceased in tax year → returns null (no tax math)', () => {
    const ctx = makeMfjTaxContext({
      primaryDeathYear: 2040,
      secondaryDeathYear: 2045,
    });
    const result = applyPerYearTaxForPath({
      taxCtx: ctx,
      taxYear: 2060,
      retirementYear: 2030,
      grossSsDollars: 30_000,
      nominalExpense: 80_000,
      otherIncome: 0,
      priorBalance: 500_000,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
    });
    expect(result).toBeNull();
  });

  it('survivor year — taxpayersAge65Plus recounts against living members only', () => {
    const ctx = makeMfjTaxContext({
      members: [
        { memberId: 'primary', isoBirthdate: '1960-01-01', onMedicare: false, hasAcaCoverage: false },
        { memberId: 'secondary', isoBirthdate: '1960-01-01', onMedicare: false, hasAcaCoverage: false },
      ],
      primaryDeathYear: 2055,
      secondaryDeathYear: 2030,
    });
    const result = applyPerYearTaxForPath({
      taxCtx: ctx,
      taxYear: 2035,
      retirementYear: 2030,
      grossSsDollars: 25_000,
      nominalExpense: 50_000,
      otherIncome: 0,
      priorBalance: 600_000,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
    });
    expect(result).not.toBeNull();
    expect(result!.fedTax).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result!.fedTax)).toBe(true);
  });
});

describe('classifyMcWithdrawal — per-account routing', () => {
  const acc = (o: Partial<McAccountYearWithdrawal>): McAccountYearWithdrawal => ({
    taxTreatment: 'PRE_TAX',
    accountType: 'RETIREMENT_IRA',
    withdrawalDollars: 0,
    preBalanceStartDollars: 0,
    postBalanceStartDollars: 0,
    ...o,
  });

  it('routes PRE_TAX withdrawals to the pre-tax bucket', () => {
    const cls = classifyMcWithdrawal([acc({ withdrawalDollars: 10_000 })]);
    expect(cls.preTaxDollars).toBe(10_000);
    expect(cls.rothBasisOrderedDollars).toBe(0);
    expect(cls.rothWholesaleTaxFreeDollars).toBe(0);
    expect(cls.postTaxNonRothDollars).toBe(0);
  });

  it('routes Roth IRA withdrawals to the basis-ordered Roth bucket', () => {
    const cls = classifyMcWithdrawal([
      acc({ taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA', withdrawalDollars: 8_000 }),
    ]);
    expect(cls.rothBasisOrderedDollars).toBe(8_000);
    expect(cls.rothWholesaleTaxFreeDollars).toBe(0);
    expect(cls.preTaxDollars).toBe(0);
  });

  // An inherited Roth IRA is wholesale tax-free: its dollars carry no basis state and leave the ordered pool before the carrier is touched.
  it('routes an INHERITED Roth IRA withdrawal to the wholesale tax-free bucket', () => {
    const cls = classifyMcWithdrawal([
      acc({
        taxTreatment: 'ROTH',
        accountType: 'RETIREMENT_ROTH_IRA',
        withdrawalDollars: 8_000,
        deathExemptInherited: true,
      }),
    ]);
    expect(cls.rothWholesaleTaxFreeDollars).toBe(8_000);
    expect(cls.rothBasisOrderedDollars).toBe(0);
    expect(cls.rothOrderedPenaltyExemptDollars).toBe(0);
  });

  // Only an inherited `RETIREMENT_ROTH_IRA` is wholesale tax-free; an inherited designated-Roth employer plan keeps its §402A treatment.
  it('keeps an INHERITED designated-Roth plan in the basis-ordered Roth bucket', () => {
    const cls = classifyMcWithdrawal([
      acc({
        taxTreatment: 'ROTH',
        accountType: 'RETIREMENT_ROTH_401K',
        withdrawalDollars: 8_000,
        deathExemptInherited: true,
      }),
    ]);
    expect(cls.rothBasisOrderedDollars).toBe(8_000);
    expect(cls.rothWholesaleTaxFreeDollars).toBe(0);
    // §72(t)(2)(A)(ii) still waives the 10% on the whole draw: the ordered dollars stay in the pool for the §402A split with full penalty-exempt provenance.
    expect(cls.rothOrderedPenaltyExemptDollars).toBe(8_000);
  });

  it('routes designated-Roth employer types (401k/403b/457b/TSP) to the basis-ordered Roth bucket', () => {
    for (const accountType of [
      'RETIREMENT_ROTH_401K',
      'RETIREMENT_ROTH_403B',
      'RETIREMENT_ROTH_457B',
      'RETIREMENT_ROTH_TSP',
    ] as const) {
      const cls = classifyMcWithdrawal([
        acc({ taxTreatment: 'ROTH', accountType, withdrawalDollars: 5_000 }),
      ]);
      expect(cls.rothBasisOrderedDollars).toBe(5_000);
      expect(cls.rothWholesaleTaxFreeDollars).toBe(0);
    }
  });

  it('routes brokerage POST_TAX to the LTCG-proxy non-Roth bucket; cash-like to cash-like', () => {
    const cls = classifyMcWithdrawal([
      acc({ taxTreatment: 'POST_TAX', accountType: 'BROKERAGE', withdrawalDollars: 5_000 }),
      acc({ taxTreatment: 'POST_TAX', accountType: 'SAVINGS', withdrawalDollars: 3_000 }),
    ]);
    expect(cls.postTaxNonRothDollars).toBe(5_000);
    expect(cls.postTaxCashLikeDollars).toBe(3_000);
  });

  it('splits MIXED withdrawals by the start-of-year pre/post balance ratio', () => {
    const cls = classifyMcWithdrawal([
      acc({
        taxTreatment: 'MIXED',
        accountType: 'RETIREMENT_IRA',
        withdrawalDollars: 10_000,
        preBalanceStartDollars: 75_000,
        postBalanceStartDollars: 25_000,
      }),
    ]);
    expect(cls.preTaxDollars).toBeCloseTo(7_500, 6);
    expect(cls.postTaxNonRothDollars).toBeCloseTo(2_500, 6);
  });

  it('falls back to all-pre-tax when an account carries no tax metadata', () => {
    const cls = classifyMcWithdrawal([
      acc({ taxTreatment: undefined, accountType: undefined, withdrawalDollars: 12_000 }),
    ]);
    expect(cls.preTaxDollars).toBe(12_000);
  });

  it('MIXED Roth-designated 401K splits pre to preTax, post to rothBasisOrderedDollars', () => {
    const cls = classifyMcWithdrawal([
      acc({
        taxTreatment: 'MIXED',
        accountType: 'RETIREMENT_401K',
        withdrawalDollars: 10_000,
        preBalanceStartDollars: 80_000,
        postBalanceStartDollars: 20_000,
      }),
    ]);
    expect(cls.preTaxDollars).toBeCloseTo(8_000, 6);
    expect(cls.rothBasisOrderedDollars).toBeCloseTo(2_000, 6);
    expect(cls.postTaxNonRothDollars).toBe(0);
    expect(cls.postTaxCashLikeDollars).toBe(0);
  });

  it('MIXED Roth-designated 403B/457B/TSP also route post to rothBasisOrderedDollars', () => {
    for (const accountType of [
      'RETIREMENT_403B',
      'RETIREMENT_457B',
      'RETIREMENT_TSP',
    ] as const) {
      const cls = classifyMcWithdrawal([
        acc({
          taxTreatment: 'MIXED',
          accountType,
          withdrawalDollars: 10_000,
          preBalanceStartDollars: 60_000,
          postBalanceStartDollars: 40_000,
        }),
      ]);
      expect(cls.preTaxDollars).toBeCloseTo(6_000, 6);
      expect(cls.rothBasisOrderedDollars).toBeCloseTo(4_000, 6);
      expect(cls.postTaxNonRothDollars).toBe(0);
    }
  });

  it('MIXED Roth-designated with zero total balance falls back to all-pre-tax', () => {
    const cls = classifyMcWithdrawal([
      acc({
        taxTreatment: 'MIXED',
        accountType: 'RETIREMENT_401K',
        withdrawalDollars: 5_000,
        preBalanceStartDollars: 0,
        postBalanceStartDollars: 0,
      }),
    ]);
    expect(cls.preTaxDollars).toBe(5_000);
    expect(cls.rothBasisOrderedDollars).toBe(0);
  });

  it('MIXED OTHER type (non-Roth-designated) still routes post to postTaxNonRothDollars', () => {
    const cls = classifyMcWithdrawal([
      acc({
        taxTreatment: 'MIXED',
        accountType: 'RETIREMENT_IRA',
        withdrawalDollars: 10_000,
        preBalanceStartDollars: 75_000,
        postBalanceStartDollars: 25_000,
      }),
    ]);
    expect(cls.preTaxDollars).toBeCloseTo(7_500, 6);
    expect(cls.postTaxNonRothDollars).toBeCloseTo(2_500, 6);
    expect(cls.rothBasisOrderedDollars).toBe(0);
  });

  it('is order-stable: classification is independent of array order', () => {
    const a = acc({ taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA', withdrawalDollars: 4_000 });
    const b = acc({ taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA', withdrawalDollars: 6_000 });
    expect(classifyMcWithdrawal([a, b])).toEqual(classifyMcWithdrawal([b, a]));
  });
});

describe('applyPerYearTaxForPath — tax cashflow', () => {
  // Pre-RMD member (born 1990) so the RMD-floor gross-up is inert and these cases isolate per-account classification; an RMD-age floor would force taxable income on a Roth draw.
  const ctx = makeMfjTaxContext({ filingStatus: 'Single', members: [
    { memberId: 'primary', isoBirthdate: '1990-06-15', onMedicare: false, hasAcaCoverage: false },
  ], householdSize: 1 });

  it('returns taxCashflowDollars = federal tax + IRMAA − ACA PTC, floored at zero', () => {
    const result = applyPerYearTaxForPath({
      taxCtx: ctx,
      taxYear: 2050,
      retirementYear: 2046,
      grossSsDollars: 0,
      nominalExpense: 90_000,
      otherIncome: 0,
      priorBalance: 1_000_000,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
      classification: {
        preTaxDollars: 90_000,
        postTaxNonRothDollars: 0,
        postTaxCashLikeDollars: 0,
        rothBasisOrderedDollars: 0,
        rothWholesaleTaxFreeDollars: 0,
      },
    });
    expect(result).not.toBeNull();
    expect(result!.taxCashflowDollars).toBeCloseTo(
      Math.max(0, result!.fedTax + result!.irmaa - result!.ptc),
      6,
    );
    expect(result!.taxCashflowDollars).toBeGreaterThanOrEqual(0);
  });

  it('Roth-classified drawdown funds zero tax cashflow', () => {
    const result = applyPerYearTaxForPath({
      taxCtx: ctx,
      taxYear: 2050,
      retirementYear: 2046,
      grossSsDollars: 0,
      nominalExpense: 90_000,
      otherIncome: 0,
      priorBalance: 1_000_000,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
      classification: {
        preTaxDollars: 0,
        postTaxNonRothDollars: 0,
        postTaxCashLikeDollars: 0,
        rothBasisOrderedDollars: 90_000,
        rothWholesaleTaxFreeDollars: 0,
      },
    });
    expect(result).not.toBeNull();
    expect(result!.fedTax).toBe(0);
    expect(result!.taxCashflowDollars).toBe(0);
  });
});

describe('applyPerYearTaxForPath — credit applied to premiums', () => {
  // One retired single filer, 2026: $31,300 of Social Security, a $7,200 benchmark and a Roth draw give a $5,134.20 credit and no tax to offset.
  const ctx = makeMfjTaxContext({
    filingStatus: 'Single',
    members: [{ memberId: 'primary', isoBirthdate: '1963-01-01', onMedicare: false, hasAcaCoverage: true }],
    householdSize: 1,
    acaPtcBenchmark: [{ taxYear: 2026, annualSlcspDollars: 7_200 }],
  });
  const roth = (dollars: number) => ({
    preTaxDollars: 0,
    postTaxNonRothDollars: 0,
    postTaxCashLikeDollars: 0,
    rothBasisOrderedDollars: 0,
    rothWholesaleTaxFreeDollars: dollars,
  });
  const run = (nominalExpense: number, medicalExpenseDollars?: number) =>
    applyPerYearTaxForPath({
      taxCtx: ctx,
      taxYear: 2026,
      retirementYear: 2026,
      grossSsDollars: 31_300,
      nominalExpense,
      ...(medicalExpenseDollars !== undefined ? { medicalExpenseDollars } : {}),
      otherIncome: 0,
      priorBalance: 1_000_000,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
      classification: roth(Math.max(0, nominalExpense - 31_300)),
    })!;

  it('lowers the funded cashflow by the excess and reports it as its own figure', () => {
    const result = run(71_208, 7_200);
    expect(result.ptc).toBeCloseTo(5_134.2, 2);
    expect(result.acaCreditAppliedToPremiums).toBeCloseTo(5_134.2, 2);
    expect(result.taxCashflowDollars).toBeCloseTo(-5_134.2, 2);
  });

  it('is capped by the draw and by the Medical expenses', () => {
    expect(run(33_996, 7_200).acaCreditAppliedToPremiums).toBeCloseTo(2_696, 2);
    expect(run(33_996, 7_200).taxCashflowDollars).toBeCloseTo(-2_696, 2);
    expect(run(43_000, 3_000).acaCreditAppliedToPremiums).toBeCloseTo(3_000, 2);
    expect(run(30_000, 7_200).acaCreditAppliedToPremiums).toBe(0);
  });

  it('without the Medical expenses nothing is applied and the zero floor holds', () => {
    const result = run(71_208);
    expect(result.acaCreditAppliedToPremiums).toBe(0);
    expect(result.taxCashflowDollars).toBe(0);
    expect(result.ptc).toBeCloseTo(5_134.2, 2);
  });

  it('holds the line to the MAGI above the poverty line, where the credit ends', () => {
    // No Social Security and a $17,000 pre-tax draw (108.6% of the $15,650 guideline): the line stops at the $1,350 of MAGI above the poverty line.
    const result = applyPerYearTaxForPath({
      taxCtx: ctx,
      taxYear: 2026,
      retirementYear: 2026,
      grossSsDollars: 0,
      nominalExpense: 17_000,
      medicalExpenseDollars: 7_200,
      otherIncome: 0,
      priorBalance: 1_000_000,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
      classification: { ...roth(0), preTaxDollars: 17_000 },
    })!;
    expect(result.ptc).toBeGreaterThan(5_000);
    expect(result.acaCreditAppliedToPremiums).toBeCloseTo(1_350, 1);
    expect(17_000 - result.acaCreditAppliedToPremiums).toBeGreaterThanOrEqual(15_650);
    expect(result.taxCashflowDollars).toBeCloseTo(-result.acaCreditAppliedToPremiums, 2);
  });

  it('counts the early-withdrawal penalty in what the credit offsets, as the projection does', () => {
    // A 55-year-old draws $30,000 from a traditional IRA: the $3,000 penalty is paid out of the credit before any of it lowers the draw.
    const earlyCtx = makeMfjTaxContext({
      filingStatus: 'Single',
      members: [{ memberId: 'primary', isoBirthdate: '1971-01-01', onMedicare: false, hasAcaCoverage: true }],
      householdSize: 1,
      acaPtcBenchmark: [{ taxYear: 2026, annualSlcspDollars: 7_200 }],
    });
    const result = applyPerYearTaxForPath({
      taxCtx: earlyCtx,
      taxYear: 2026,
      retirementYear: 2026,
      grossSsDollars: 0,
      nominalExpense: 30_000,
      medicalExpenseDollars: 7_200,
      otherIncome: 0,
      priorBalance: 1_000_000,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
      classification: { ...roth(0), preTaxDollars: 30_000 },
    })!;
    const penalty = 3_000;
    expect(result.acaCreditAppliedToPremiums).toBeCloseTo(result.ptc - result.fedTax - penalty, 2);
    expect(result.acaCreditAppliedToPremiums).toBeGreaterThan(0);
    expect(result.taxCashflowDollars).toBeCloseTo(-result.acaCreditAppliedToPremiums, 2);
  });

  it('keeps a negative cumulative draw from adding balance back to the RMD base', () => {
    // The credit outran the tax so far (cumulative draw below zero): the after-tax base stays the raw balance.
    expect(advanceAfterTaxBase({ base: 0, depleted: false }, 500_000, -5_000)).toEqual({
      base: 500_000,
      depleted: false,
    });
  });
});

describe('applyPerYearTaxForPath — per-owner RMD-floor grossing', () => {
  function singleMemberCtx(birthYear: number): McTaxContext {
    return makeMfjTaxContext({
      filingStatus: 'Single',
      members: [
        {
          memberId: 'primary',
          isoBirthdate: `${birthYear}-01-01`,
          onMedicare: false,
          hasAcaCoverage: false,
        },
      ],
      householdSize: 1,
    });
  }

  // A tiny net draw, well below any RMD floor on a $1.5M pre-tax base; the floor derives from `priorPreTaxByOwner`, not the whole-portfolio `priorBalance`.
  const subFloorArgs = {
    taxYear: 2024,
    retirementYear: 2020,
    grossSsDollars: 0,
    nominalExpense: 8_000,
    otherIncome: 0,
    priorBalance: 1_500_000,
    priorPreTaxByOwner: new Map<string, number>([['primary', 1_500_000_00]]),
    magiMinus2: undefined,
  } as const;

  it('RMD-age path with a sub-floor pre-tax draw grosses fedTax up to the floor', () => {
    const grossed = applyPerYearTaxForPath({ taxCtx: singleMemberCtx(1951), ...subFloorArgs });
    const underAge = applyPerYearTaxForPath({ taxCtx: singleMemberCtx(1971), ...subFloorArgs });

    expect(grossed).not.toBeNull();
    expect(underAge).not.toBeNull();
    expect(grossed!.fedTax).toBeGreaterThan(0);
    expect(grossed!.fedTax).toBeGreaterThan(underAge!.fedTax);
    expect(grossed!.taxCashflowDollars).toBeGreaterThan(0);
  });

  it('under-age path is unchanged (no floor applied below the trigger age)', () => {
    const result = applyPerYearTaxForPath({ taxCtx: singleMemberCtx(1971), ...subFloorArgs });
    expect(result).not.toBeNull();
    expect(result!.fedTax).toBe(0);
    expect(result!.taxCashflowDollars).toBe(0);
  });

  it('all-Roth/all-taxable RMD-age path has a $0 floor (no phantom RMD income)', () => {
    // Empty `priorPreTaxByOwner` (Roth-heavy or all-taxable): a whole-portfolio synthetic floor would gross $1.5M up to ~$56k; the per-owner floor is $0.
    const result = applyPerYearTaxForPath({
      taxCtx: singleMemberCtx(1951),
      ...subFloorArgs,
      priorPreTaxByOwner: new Map<string, number>(),
    });
    expect(result).not.toBeNull();
    expect(result!.fedTax).toBe(0);
    expect(result!.taxCashflowDollars).toBe(0);
  });

  it('couple floor fires on the SECONDARY when only the secondary is RMD-age', () => {
    // Primary is pre-RMD and the secondary (born 1951) owns the pre-tax, so the floor fires on the secondary's age.
    const ctx = makeMfjTaxContext({
      filingStatus: 'MFJ',
      members: [
        { memberId: 'primary', isoBirthdate: '1971-01-01', onMedicare: false, hasAcaCoverage: false },
        { memberId: 'secondary', isoBirthdate: '1951-01-01', onMedicare: false, hasAcaCoverage: false },
      ],
      householdSize: 2,
    });
    const grossed = applyPerYearTaxForPath({
      taxCtx: ctx,
      ...subFloorArgs,
      priorPreTaxByOwner: new Map<string, number>([['secondary', 1_500_000_00]]),
    });
    const noFloor = applyPerYearTaxForPath({
      taxCtx: makeMfjTaxContext({
        filingStatus: 'MFJ',
        members: [
          { memberId: 'primary', isoBirthdate: '1971-01-01', onMedicare: false, hasAcaCoverage: false },
          { memberId: 'secondary', isoBirthdate: '1971-06-01', onMedicare: false, hasAcaCoverage: false },
        ],
        householdSize: 2,
      }),
      ...subFloorArgs,
      priorPreTaxByOwner: new Map<string, number>([['secondary', 1_500_000_00]]),
    });
    expect(grossed).not.toBeNull();
    expect(noFloor).not.toBeNull();
    expect(grossed!.fedTax).toBeGreaterThan(0);
    expect(grossed!.fedTax).toBeGreaterThan(noFloor!.fedTax);
    expect(grossed!.magiDollars).toBeGreaterThan(50_000);
  });

  it('couple floor SUMS each owner\'s own per-owner floor (not max over a shared pool)', () => {
    // Both members are RMD-age and each owns a $1.5M pre-tax sub-bucket: the per-owner floors SUM (primary ≈ $56,604 at divisor 26.5, secondary ≈ $71,090 at 21.1), not a max over a shared pool.
    const coupleCtx = makeMfjTaxContext({
      filingStatus: 'MFJ',
      members: [
        { memberId: 'primary', isoBirthdate: '1951-01-01', onMedicare: false, hasAcaCoverage: false },
        { memberId: 'secondary', isoBirthdate: '1945-01-01', onMedicare: false, hasAcaCoverage: false },
      ],
      householdSize: 2,
    });
    const couple = applyPerYearTaxForPath({
      taxCtx: coupleCtx,
      ...subFloorArgs,
      priorPreTaxByOwner: new Map<string, number>([
        ['primary', 1_500_000_00],
        ['secondary', 1_500_000_00],
      ]),
    });
    const primaryOnly = applyPerYearTaxForPath({
      taxCtx: coupleCtx,
      ...subFloorArgs,
      priorPreTaxByOwner: new Map<string, number>([['primary', 1_500_000_00]]),
    });
    const secondaryOnly = applyPerYearTaxForPath({
      taxCtx: coupleCtx,
      ...subFloorArgs,
      priorPreTaxByOwner: new Map<string, number>([['secondary', 1_500_000_00]]),
    });
    expect(couple).not.toBeNull();
    expect(primaryOnly).not.toBeNull();
    expect(secondaryOnly).not.toBeNull();
    expect(secondaryOnly!.magiDollars).toBeGreaterThan(primaryOnly!.magiDollars);
    expect(couple!.magiDollars).toBeGreaterThan(secondaryOnly!.magiDollars);
    expect(couple!.magiDollars).toBeCloseTo(
      primaryOnly!.magiDollars + secondaryOnly!.magiDollars,
      6,
    );
    expect(couple!.fedTax).toBeGreaterThan(0);
  });

  it('draw already at/above the floor leaves the floor inert (taxed on the actual draw)', () => {
    // A large draw clears any floor, so max(draw, floor) is the draw: a large and a tiny pre-tax base owe the same tax.
    const aboveFloorArgs = {
      ...subFloorArgs,
      nominalExpense: 200_000, // net drawdown $200,000 — well above any floor here
    };
    const highBase = applyPerYearTaxForPath({
      taxCtx: singleMemberCtx(1951),
      ...aboveFloorArgs,
      priorPreTaxByOwner: new Map<string, number>([['primary', 1_500_000_00]]),
    });
    const tinyBase = applyPerYearTaxForPath({
      taxCtx: singleMemberCtx(1951),
      ...aboveFloorArgs,
      priorPreTaxByOwner: new Map<string, number>([['primary', 100_00]]),
    });
    expect(highBase).not.toBeNull();
    expect(tinyBase).not.toBeNull();
    expect(highBase!.fedTax).toBeCloseTo(tinyBase!.fedTax, 6);
  });
});

describe('applyPerYearTaxForPath — MC Roth basis carrier parity', () => {
  // Pre-59½ member (born 1990) so the §408A earnings above remaining basis take the 10% penalty and the RMD floor stays inert; the whole $20k draw is Roth, isolating the carrier.
  const ownerId = 'primary';
  const ctx = (): McTaxContext => ({
    taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus: 'Single',
    members: [
      { memberId: ownerId, isoBirthdate: '1990-06-15', onMedicare: false, hasAcaCoverage: false },
    ],
    householdSize: 1,
    inflationRatePct: 3,
  });

  const baseArgs = {
    taxYear: 2025,
    retirementYear: 2022,
    grossSsDollars: 0,
    nominalExpense: 20_000,
    otherIncome: 0,
    priorBalance: 1_000_000,
    priorPreTaxByOwner: new Map<string, number>(),
    magiMinus2: undefined,
    classification: {
      preTaxDollars: 0,
      postTaxNonRothDollars: 0,
      postTaxCashLikeDollars: 0,
      rothBasisOrderedDollars: 20_000,
      rothWholesaleTaxFreeDollars: 0,
    },
  } as const;

  it('pre-59½ Roth earnings excess → penalty funds extra tax cashflow', () => {
    const partialBasis = seedRothBasisCarrier(new Map([[MC_AGGREGATE_ROTH_OWNER_KEY, 10_000 * 100]]));
    const withExcess = applyPerYearTaxForPath({
      ...baseArgs,
      taxCtx: ctx(),
      rothBasisCarrier: partialBasis,
    });
    expect(withExcess).not.toBeNull();
    expect(withExcess!.taxCashflowDollars).toBeGreaterThan(0);
    const entry = partialBasis.get(MC_AGGREGATE_ROTH_OWNER_KEY)!;
    expect(entry.rothBasisRemainingCents).toBe(0);
    expect(entry.rothCumulativeWithdrawnCents).toBe(20_000 * 100);
  });

  it('full Roth basis coverage → no penalty, zero tax cashflow', () => {
    const fullBasis = seedRothBasisCarrier(new Map([[MC_AGGREGATE_ROTH_OWNER_KEY, 50_000 * 100]]));
    const noExcess = applyPerYearTaxForPath({
      ...baseArgs,
      taxCtx: ctx(),
      rothBasisCarrier: fullBasis,
    });
    expect(noExcess).not.toBeNull();
    expect(noExcess!.fedTax).toBe(0);
    expect(noExcess!.taxCashflowDollars).toBe(0);
    const entry = fullBasis.get(MC_AGGREGATE_ROTH_OWNER_KEY)!;
    expect(entry.rothBasisRemainingCents).toBe(30_000 * 100);
    expect(entry.rothCumulativeWithdrawnCents).toBe(20_000 * 100);
  });

  it('no carrier supplied → Roth draw funds zero tax (backward-compat skip)', () => {
    const noCarrier = applyPerYearTaxForPath({ ...baseArgs, taxCtx: ctx() });
    expect(noCarrier).not.toBeNull();
    expect(noCarrier!.fedTax).toBe(0);
    expect(noCarrier!.taxCashflowDollars).toBe(0);
  });

  it('a SECONDARY owner\'s Roth basis is consumed, not stranded', () => {
    // The aggregate key sums both owners' §408A basis into one carrier entry; consuming only the primary's key would strand the secondary's.
    const carrier = seedMcAggregateRothBasisCarrier(
      new Map([
        ['primary', 10_000 * 100],
        ['secondary', 10_000 * 100],
      ]),
    );
    const result = applyPerYearTaxForPath({
      ...baseArgs,
      taxCtx: ctx(),
      rothBasisCarrier: carrier,
    });
    expect(result).not.toBeNull();
    expect(result!.fedTax).toBe(0);
    expect(result!.taxCashflowDollars).toBe(0);
    const entry = carrier.get(MC_AGGREGATE_ROTH_OWNER_KEY)!;
    expect(entry.rothBasisRemainingCents).toBe(0);
    expect(entry.rothCumulativeWithdrawnCents).toBe(20_000 * 100);
  });
});

describe('creditMcConversionToBasisCarrier — Fill conversion → §408A basis', () => {
  // Converted principal credited at year-END is §408A basis for later years, as in the deterministic `creditRothConversionToBasisCarrier`; crediting before the same year's ordering would wrongly shield it.
  const ownerId = 'primary';
  const ctx = (): McTaxContext => ({
    taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus: 'Single',
    members: [
      { memberId: ownerId, isoBirthdate: '1990-06-15', onMedicare: false, hasAcaCoverage: false },
    ],
    householdSize: 1,
    inflationRatePct: 3,
  });

  const yearArgs = (taxYear: number) =>
    ({
      taxYear,
      retirementYear: 2022,
      grossSsDollars: 0,
      nominalExpense: 20_000,
      otherIncome: 0,
      priorBalance: 1_000_000,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
      classification: {
        preTaxDollars: 0,
        postTaxNonRothDollars: 0,
        postTaxCashLikeDollars: 0,
        rothBasisOrderedDollars: 20_000,
      rothWholesaleTaxFreeDollars: 0,
      },
    }) as const;

  it('converted principal credited at year-END shields a LATER-year Roth withdrawal (no earnings, no penalty)', () => {
    const carrier = seedMcAggregateRothBasisCarrier(new Map([[ownerId, 20_000 * 100]]));

    const y1 = applyPerYearTaxForPath({ ...yearArgs(2025), taxCtx: ctx(), rothBasisCarrier: carrier });
    expect(y1).not.toBeNull();
    expect(y1!.taxCashflowDollars).toBe(0); // fully covered by seeded basis
    expect(carrier.get(MC_AGGREGATE_ROTH_OWNER_KEY)!.rothBasisRemainingCents).toBe(0);

    creditMcConversionToBasisCarrier(carrier, 30_000 * 100);
    expect(carrier.get(MC_AGGREGATE_ROTH_OWNER_KEY)!.rothBasisRemainingCents).toBe(30_000 * 100);

    const y2 = applyPerYearTaxForPath({ ...yearArgs(2026), taxCtx: ctx(), rothBasisCarrier: carrier });
    expect(y2).not.toBeNull();
    expect(y2!.fedTax).toBe(0); // earningsExcess = 0 → no ordinary income
    expect(y2!.taxCashflowDollars).toBe(0); // no penalty (basis, not earnings)
    expect(carrier.get(MC_AGGREGATE_ROTH_OWNER_KEY)!.rothBasisRemainingCents).toBe(10_000 * 100);
  });

  it('WITHOUT the credit the same later-year withdrawal is re-taxed as earnings + penalty (pins the pre-fix bug)', () => {
    const carrier = seedMcAggregateRothBasisCarrier(new Map([[ownerId, 20_000 * 100]]));
    applyPerYearTaxForPath({ ...yearArgs(2025), taxCtx: ctx(), rothBasisCarrier: carrier });
    const y2 = applyPerYearTaxForPath({ ...yearArgs(2026), taxCtx: ctx(), rothBasisCarrier: carrier });
    expect(y2).not.toBeNull();
    expect(y2!.fedTax).toBeGreaterThan(0); // $20k earnings taxed as ordinary income
    expect(y2!.taxCashflowDollars).toBeGreaterThan(0); // + the 10% pre-59½ penalty
  });

  it('crediting BEFORE same-year ordering would wrongly shield the same year (guards call ordering)', () => {
    const carrier = seedMcAggregateRothBasisCarrier(new Map([[ownerId, 0]]));
    const sameYear = applyPerYearTaxForPath({ ...yearArgs(2025), taxCtx: ctx(), rothBasisCarrier: carrier });
    creditMcConversionToBasisCarrier(carrier, 30_000 * 100); // year-END, after ordering
    expect(sameYear).not.toBeNull();
    expect(sameYear!.fedTax).toBeGreaterThan(0);
    expect(sameYear!.taxCashflowDollars).toBeCloseTo(
      Math.max(0, sameYear!.fedTax + 2_000 - sameYear!.ptc),
      2,
    );
    expect(carrier.get(MC_AGGREGATE_ROTH_OWNER_KEY)!.rothBasisRemainingCents).toBe(30_000 * 100);
  });

  it('no-op when converted cents is 0 or negative', () => {
    const carrier = seedMcAggregateRothBasisCarrier(new Map([[ownerId, 5_000 * 100]]));
    creditMcConversionToBasisCarrier(carrier, 0);
    creditMcConversionToBasisCarrier(carrier, -100);
    expect(carrier.get(MC_AGGREGATE_ROTH_OWNER_KEY)!.rothBasisRemainingCents).toBe(5_000 * 100);
  });
});

describe('applyPerYearTaxForPath — MC penalty exemption parity', () => {
  const ctx = (overrides: Partial<McTaxContext> = {}): McTaxContext => ({
    taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus: 'Single',
    members: [
      { memberId: 'primary', isoBirthdate: '1990-06-15', onMedicare: false, hasAcaCoverage: false },
    ],
    householdSize: 1,
    inflationRatePct: 3,
    ...overrides,
  });

  const baseArgs = {
    taxYear: 2025,
    retirementYear: 2022,
    grossSsDollars: 0,
    nominalExpense: 40_000,
    otherIncome: 0,
    priorBalance: 1_000_000,
    priorPreTaxByOwner: new Map<string, number>(),
    magiMinus2: undefined,
    classification: {
      preTaxDollars: 40_000,
      postTaxNonRothDollars: 0,
      postTaxCashLikeDollars: 0,
      rothBasisOrderedDollars: 0,
      rothWholesaleTaxFreeDollars: 0,
    },
  } as const;

  it('pre-tax leg exempt → §72(t) penalty waived ($0), income tax unchanged', () => {
    const notExempt = applyPerYearTaxForPath({ ...baseArgs, taxCtx: ctx() });
    const exempt = applyPerYearTaxForPath({
      ...baseArgs,
      taxCtx: ctx({ mcPreTaxPenaltyAllExempt: true }),
    });
    expect(notExempt).not.toBeNull();
    expect(exempt).not.toBeNull();
    expect(notExempt!.taxCashflowDollars - exempt!.taxCashflowDollars).toBeCloseTo(4_000, 6);
    expect(exempt!.fedTax).toBeCloseTo(notExempt!.fedTax, 6);
  });

  it('Roth-earnings leg exempt → 10% penalty waived, ordinary income tax unchanged', () => {
    const rothArgs = {
      ...baseArgs,
      nominalExpense: 20_000,
      classification: {
        preTaxDollars: 0,
        postTaxNonRothDollars: 0,
        postTaxCashLikeDollars: 0,
        rothBasisOrderedDollars: 20_000,
      rothWholesaleTaxFreeDollars: 0,
      },
    } as const;
    const notExempt = applyPerYearTaxForPath({
      ...rothArgs,
      taxCtx: ctx(),
      rothBasisCarrier: seedRothBasisCarrier(new Map([[MC_AGGREGATE_ROTH_OWNER_KEY, 10_000 * 100]])),
    });
    const exempt = applyPerYearTaxForPath({
      ...rothArgs,
      taxCtx: ctx({ mcRothPenaltyAllExempt: true }),
      rothBasisCarrier: seedRothBasisCarrier(new Map([[MC_AGGREGATE_ROTH_OWNER_KEY, 10_000 * 100]])),
    });
    expect(notExempt).not.toBeNull();
    expect(exempt).not.toBeNull();
    expect(notExempt!.taxCashflowDollars - exempt!.taxCashflowDollars).toBeCloseTo(1_000, 6);
    expect(exempt!.fedTax).toBeCloseTo(notExempt!.fedTax, 6);
  });
});

describe('in-step tax second pass (runMonteCarlo TAXHEAVY)', () => {
  const firstYear = 2026;
  const horizonYear = 2056;
  const years = horizonYear - firstYear + 1;
  const stepCount = years * 12;
  const ssByYear = new Array<number>(years).fill(15_000);
  const incomeByYear = new Array<number>(years).fill(0);

  function taxHeavyInput(withTax: boolean): MonteCarloInput {
    return {
      portfolioToday: 700_000,
      accountMcLedger: [
        {
          id: 'ira',
          initialPre: 700_000,
          initialPost: 0,
          contribPre: new Float64Array(stepCount),
          contribPost: new Float64Array(stepCount),
          deposit: new Float64Array(stepCount),
          assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
          assetMixSeries: null,
          cbpPlanningReturnPct: null,
          taxTreatment: 'PRE_TAX',
          accountType: 'OTHER',
        },
      ],
      annualContribution: 0,
      firstYear,
      retirementYear: firstYear,
      horizonYear,
      monthlyExpenseBase: makeMonthlyExpenseBase(70_000, stepCount),
      ssByYear,
      incomeByYear,
      pathCount: 60,
      seed: 4321,
      strategyKind: 'taxEfficient',
      ...(withTax
        ? {
            taxContext: {
              taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
              filingStatus: 'Single' as const,
              members: [
                {
                  memberId: 'rmd-primary',
                  isoBirthdate: '1950-01-01',
                  onMedicare: true,
                  hasAcaCoverage: false,
                },
              ],
              householdSize: 1,
              inflationRatePct: 3,
            },
          }
        : {}),
    };
  }

  it('funding tax in-step lowers (or matches) success vs the no-tax baseline', () => {
    const noTax = runMonteCarlo(taxHeavyInput(false));
    const taxed = runMonteCarlo(taxHeavyInput(true));
    expect(taxed.successProbability).toBeLessThanOrEqual(noTax.successProbability);
    expect(mcParityBaselines.taxHeavy_successProbability_preFix).toBeGreaterThan(0);
  });
});

describe('applyPerYearTaxForPath — years 0–1 IRMAA bootstrap parity', () => {
  const medicareCtx = makeMfjTaxContext({
    filingStatus: 'Single',
    members: [
      { memberId: 'primary', isoBirthdate: '1951-01-01', onMedicare: false, hasAcaCoverage: false },
    ],
    householdSize: 1,
  });

  const yearArgs = {
    taxYear: 2026,
    retirementYear: 2026,
    grossSsDollars: 0,
    nominalExpense: 40_000,
    otherIncome: 0,
    priorBalance: 1_000_000,
    priorPreTaxByOwner: new Map<string, number>(),
    classification: {
      preTaxDollars: 40_000,
      postTaxNonRothDollars: 0,
      postTaxCashLikeDollars: 0,
      rothBasisOrderedDollars: 0,
      rothWholesaleTaxFreeDollars: 0,
    },
  } as const;

  it('year 0 with bootstrap (magiMinus2 high) charges NON-zero IRMAA', () => {
    const withBootstrap = applyPerYearTaxForPath({
      taxCtx: medicareCtx,
      ...yearArgs,
      magiMinus2: 300_000, // well above Single tier1 → IRMAA fires
    });
    expect(withBootstrap).not.toBeNull();
    expect(withBootstrap!.irmaa).toBeGreaterThan(0);
  });
});

describe('applyPerYearTaxForPath — windowed nominalExpense drives tax feedback', () => {
  const ctx = makeMfjTaxContext({
    filingStatus: 'Single',
    members: [
      { memberId: 'primary', isoBirthdate: '1955-01-01', onMedicare: false, hasAcaCoverage: false },
    ],
    householdSize: 1,
  });
  const base = {
    taxCtx: ctx,
    taxYear: 2026,
    retirementYear: 2026,
    grossSsDollars: 0,
    nominalExpense: 60_000,
    otherIncome: 0,
    priorBalance: 3_000_000,
    priorPreTaxByOwner: new Map<string, number>(),
    classification: {
      preTaxDollars: 60_000,
      postTaxNonRothDollars: 0,
      postTaxCashLikeDollars: 0,
      rothBasisOrderedDollars: 0,
      rothWholesaleTaxFreeDollars: 0,
    },
  } as const;

  it('a higher windowed nominalExpense raises the year drawdown → federal tax', () => {
    const low = applyPerYearTaxForPath({ ...base, magiMinus2: 0 });
    const high = applyPerYearTaxForPath({
      ...base,
      nominalExpense: 200_000,
      classification: {
        preTaxDollars: 200_000,
        postTaxNonRothDollars: 0,
        postTaxCashLikeDollars: 0,
        rothBasisOrderedDollars: 0,
        rothWholesaleTaxFreeDollars: 0,
      },
      magiMinus2: 0,
    });
    expect(low).not.toBeNull();
    expect(high).not.toBeNull();
    expect(high!.fedTax).toBeGreaterThan(low!.fedTax);
    expect(high!.taxCashflowDollars).toBeGreaterThan(low!.taxCashflowDollars);
  });

  it('the higher windowed nominalExpense lifts the year MAGI across the first Part B IRMAA tier (tolerance-free step)', () => {
    const low = applyPerYearTaxForPath({ ...base, magiMinus2: 0 })!;
    const high = applyPerYearTaxForPath({
      ...base,
      nominalExpense: 200_000,
      classification: {
        preTaxDollars: 200_000,
        postTaxNonRothDollars: 0,
        postTaxCashLikeDollars: 0,
        rothBasisOrderedDollars: 0,
        rothWholesaleTaxFreeDollars: 0,
      },
      magiMinus2: 0,
    })!;
    const irmaaLow = applyPerYearTaxForPath({ ...base, magiMinus2: low.magiDollars })!;
    const irmaaHigh = applyPerYearTaxForPath({ ...base, magiMinus2: high.magiDollars })!;
    expect(irmaaLow.irmaa).toBe(0);
    expect(irmaaHigh.irmaa).toBeGreaterThan(0);
  });

  it('the same windowed nominalExpense reproduces the same result exactly', () => {
    const a = applyPerYearTaxForPath({ ...base, magiMinus2: 0 })!;
    const b = applyPerYearTaxForPath({ ...base, magiMinus2: 0 })!;
    expect(b).toEqual(a);
  });
});

describe('no-bootstrap deterministic-vs-MC IRMAA divergence (APPROVED DEFERRAL)', () => {
  it('deterministic engine estimates NON-zero IRMAA + flag while MC charges $0', async () => {
    const { applyTaxIntegrationToDrawdownYears } = await import('./balance-projection-runner-tax');
    const { makeCtx, makeDrawdownYear, REAL_BUNDLE } = await import(
      './balance-projection-runner-tax-test-fixtures'
    );

    const detYears = [makeDrawdownYear(2026, 300_000)];
    const detCtx = makeCtx({
      primaryBirthdate: '1951-01-01', // age 75 in 2026 → on Medicare
      primaryRetirementYear: 2026,
    });
    applyTaxIntegrationToDrawdownYears(detYears, [], [], [], detCtx, REAL_BUNDLE);
    expect(detYears[0].irmaaSurchargeCents).toBeGreaterThan(0);
    expect(detYears[0].magiEstimatedFromProjection).toBe(true);

    const mcCtx = makeMfjTaxContext({
      filingStatus: 'Single',
      members: [
        { memberId: 'primary', isoBirthdate: '1951-01-01', onMedicare: false, hasAcaCoverage: false },
      ],
      householdSize: 1,
    });
    const mcYear0 = applyPerYearTaxForPath({
      taxCtx: mcCtx,
      taxYear: 2026,
      retirementYear: 2026,
      grossSsDollars: 0,
      nominalExpense: 300_000,
      otherIncome: 0,
      priorBalance: 2_000_000,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined, // no bootstrap threaded → ring undefined
      classification: {
        preTaxDollars: 300_000,
        postTaxNonRothDollars: 0,
        postTaxCashLikeDollars: 0,
        rothBasisOrderedDollars: 0,
        rothWholesaleTaxFreeDollars: 0,
      },
    });
    expect(mcYear0).not.toBeNull();
    expect(mcYear0!.irmaa).toBe(0);
  });
});

describe('applyPerYearTaxForPath — AC-(i) MC fed-tax within ≤2% of the deterministic engine', () => {
  it('a bucketed-draw named-strategy year: |mcFed − detFed| / detFed ≤ 0.02', async () => {
    const { applyTaxIntegrationToDrawdownYears } = await import('./balance-projection-runner-tax');
    const { makeCtx, makeDrawdownYear, REAL_BUNDLE } = await import(
      './balance-projection-runner-tax-test-fixtures'
    );
    const TAX_YEAR = 2026;
    const GROSS = 130_000; // bucketed (medical-heavy) nominal annual draw

    const detYears = [makeDrawdownYear(TAX_YEAR, GROSS)];
    const detCtx = makeCtx({
      withdrawalStrategy: { kind: 'taxEfficient' },
      primaryBirthdate: '1990-06-15', // age 36 → pre-RMD, pre-Medicare
      primaryRetirementYear: TAX_YEAR,
    });
    applyTaxIntegrationToDrawdownYears(detYears, [], [], [], detCtx, REAL_BUNDLE);
    const detFed = (detYears[0].federalTaxCents ?? 0) / 100;
    expect(detFed).toBeGreaterThan(0);

    const mcCtx = makeMfjTaxContext({
      filingStatus: 'Single',
      members: [
        { memberId: 'primary', isoBirthdate: '1990-06-15', onMedicare: false, hasAcaCoverage: false },
      ],
      householdSize: 1,
    });
    const mc = applyPerYearTaxForPath({
      taxCtx: mcCtx,
      taxYear: TAX_YEAR,
      retirementYear: TAX_YEAR,
      grossSsDollars: 0,
      nominalExpense: GROSS,
      otherIncome: 0,
      priorBalance: 2_000_000,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: 0,
      classification: {
        preTaxDollars: GROSS,
        postTaxNonRothDollars: 0,
        postTaxCashLikeDollars: 0,
        rothBasisOrderedDollars: 0,
        rothWholesaleTaxFreeDollars: 0,
      },
    });
    expect(mc).not.toBeNull();
    const mcFed = mc!.fedTax;
    expect(Math.abs(mcFed - detFed) / detFed).toBeLessThanOrEqual(0.02);
  });
});

describe('buildYearMemberFlags — Medicare 65th-birthday month onset', () => {
  const member = {
    memberId: 'primary',
    isoBirthdate: '1960-07-15', // turns 65 in July 2025
    onMedicare: false,
    hasAcaCoverage: false,
  };

  it('agrees with the deterministic twin for every birth month and edge input', () => {
    type StatedMonths = { partBMonths?: number; partDMonths?: number; marketplaceMonths?: number };
    type ParityInput = {
      iso: string;
      taxYear: number;
      retirementYear: number;
      stated?: StatedMonths | null;
      nullPerMember?: boolean;
    };
    const inputs: ParityInput[] = [];
    for (let month = 1; month <= 12; month += 1) {
      inputs.push({ iso: `1960-${String(month).padStart(2, '0')}-15`, taxYear: 2025, retirementYear: 2024 });
    }
    inputs.push(
      { iso: '1960-07-15', taxYear: 2026, retirementYear: 2024 },
      { iso: '1960-03-01', taxYear: 2024, retirementYear: 2024, stated: { partBMonths: 7, partDMonths: 0, marketplaceMonths: 5 } },
      { iso: '1960-07-15', taxYear: 2025, retirementYear: 2024, stated: { partBMonths: 7, partDMonths: 7, marketplaceMonths: 12 } },
      { iso: '', taxYear: 2025, retirementYear: 2024 },
      { iso: '', taxYear: 2025, retirementYear: 2024, stated: { partBMonths: 6, marketplaceMonths: 12 } },
      { iso: '1961-99-99', taxYear: 2030, retirementYear: 2024 },
      { iso: '1961-13-15', taxYear: 2030, retirementYear: 2024 },
      { iso: '1961-02-30', taxYear: 2030, retirementYear: 2024 },
      { iso: '1961-02-29', taxYear: 2030, retirementYear: 2024 },
      { iso: '1960-03-01', taxYear: 2025, retirementYear: 2024, nullPerMember: true },
      { iso: '1960-03-01', taxYear: 2025, retirementYear: 2024, stated: null },
    );
    for (const input of inputs) {
      const perMemberFor = (id: string) =>
        input.nullPerMember
          ? ({ perMember: null } as never)
          : input.stated === undefined
            ? undefined
            : { perMember: { [id]: { [input.taxYear]: input.stated } } };
      const mc = memberFlags(
        { ...member, isoBirthdate: input.iso },
        input.taxYear,
        input.retirementYear,
        new Set(),
        perMemberFor('primary') as never,
      );
      const det = buildMemberInputs(
        makeCtx({
          primaryBirthdate: input.iso,
          primaryRetirementYear: input.retirementYear,
          ...(perMemberFor('member-primary') === undefined
            ? {}
            : { healthCoverageMonths: perMemberFor('member-primary') as never }),
        }),
        input.taxYear,
        true,
        false,
      )[0];
      expect(mc.partBEnrollmentMonths).toBe(det.partBEnrollmentMonths);
      expect(mc.partDEnrollmentMonths).toBe(det.partDEnrollmentMonths);
      expect(mc.marketplaceCoverageMonths).toBe(det.marketplaceCoverageMonths);
      expect(mc.onMedicare).toBe(det.onMedicare);
      expect(mc.hasAcaCoverage).toBe(det.hasAcaCoverage);
    }
  });
});

describe('countTaxpayersAge65Plus — born-Jan-1 age-65 boundary', () => {
  const jan1_1960: TaxMemberInput = {
    memberId: 'jan1',
    isoBirthdate: '1960-01-01',
    onMedicare: false,
    hasAcaCoverage: false,
  };

  it('jan1_1960_counts_as_65plus_for_tax_year_2024', () => {
    // IRS born-Jan-1 rule: treated as reaching 65 on 2023-12-31, so it qualifies for tax year 2024, one year earlier than taxYear minus birth year.
    expect(countTaxpayersAge65Plus([jan1_1960], 2024)).toBe(1);
  });
});

describe('buildYearMemberFlags — ACA opt-out (parity)', () => {
  const RET = 2024;
  const member: TaxMemberInput = {
    memberId: 'm1',
    isoBirthdate: '1962-03-01', // age 62 in 2024 — retired pre-65, no Medicare
    onMedicare: false,
    hasAcaCoverage: false,
  };

  it('should_keep_hasAcaCoverage_true_when_not_opted_out', () => {
    const flags = memberFlags(member, 2024, RET, new Set());
    expect(flags.hasAcaCoverage).toBe(true);
  });

  it('should_force_hasAcaCoverage_false_when_the_member_id_is_opted_out', () => {
    const flags = memberFlags(member, 2024, RET, new Set(['m1']));
    expect(flags.hasAcaCoverage).toBe(false);
  });

  it('should_default_to_no_opt_out_when_the_set_arg_is_omitted (back-compat)', () => {
    const flags = memberFlags(member, 2024, RET);
    expect(flags.hasAcaCoverage).toBe(true);
  });

  it('should_gate_on_member_id_not_a_boolean — only the named member is affected', () => {
    const other: TaxMemberInput = { ...member, memberId: 'm2' };
    const optedOut = new Set(['m1']);
    expect(memberFlags(member, 2024, RET, optedOut).hasAcaCoverage).toBe(false);
    expect(memberFlags(other, 2024, RET, optedOut).hasAcaCoverage).toBe(true);
  });
});

describe('computeMcRmdFloorCents — per-owner pre-tax RMD floor', () => {
  const RMD = DEFAULT_TAX_CALIBRATION_BUNDLE.rmd;
  const owner = (memberId: string, isoBirthdate: string): TaxMemberInput => ({
    memberId,
    isoBirthdate,
    onMedicare: false,
    hasAcaCoverage: false,
  });

  it('mixed IRA+Roth at RMD age → floor on the IRA pre-tax portion only', () => {
    // The map carries only the traditional-IRA pre-tax cents (the Roth portion never enters `priorPreTaxByOwner`); age-73 divisor 26.5.
    const survivors = [owner('m1', '1951-01-01')];
    const floor = computeMcRmdFloorCents(
      new Map([['m1', 1_000_000_00]]),
      survivors,
      2024,
      RMD,
    );
    expect(floor).toBeGreaterThan(37_000_00);
    expect(floor).toBeLessThan(38_000_00);
  });

  it('couple both at RMD age → SUM of each owner\'s floor (not max over a pool)', () => {
    const survivors = [owner('m1', '1951-01-01'), owner('m2', '1945-01-01')];
    const each = new Map([
      ['m1', 1_000_000_00], // age 73 → divisor 26.5 → ≈ $37,736
      ['m2', 1_000_000_00], // age 79 → divisor 21.1 → ≈ $47,393
    ]);
    const sum = computeMcRmdFloorCents(each, survivors, 2024, RMD);
    const m1Only = computeMcRmdFloorCents(new Map([['m1', 1_000_000_00]]), survivors, 2024, RMD);
    const m2Only = computeMcRmdFloorCents(new Map([['m2', 1_000_000_00]]), survivors, 2024, RMD);
    expect(m1Only).toBeGreaterThan(0);
    expect(m2Only).toBeGreaterThan(m1Only); // older → larger
    expect(sum).toBeCloseTo(m1Only + m2Only, 0); // SUM, not max
  });

  it('couple with one below trigger → only the eligible owner contributes', () => {
    const survivors = [owner('m1', '1971-01-01'), owner('m2', '1951-01-01')]; // m1 age 53, m2 age 73
    const both = new Map([
      ['m1', 1_000_000_00], // below trigger → contributes 0
      ['m2', 1_000_000_00], // RMD-age → contributes
    ]);
    const onlyEligible = computeMcRmdFloorCents(new Map([['m2', 1_000_000_00]]), survivors, 2024, RMD);
    expect(computeMcRmdFloorCents(both, survivors, 2024, RMD)).toBe(onlyEligible);
    expect(onlyEligible).toBeGreaterThan(0);
  });

  it('no owner at RMD age → 0', () => {
    const survivors = [owner('m1', '1971-01-01'), owner('m2', '1972-01-01')];
    const both = new Map([
      ['m1', 1_000_000_00],
      ['m2', 1_000_000_00],
    ]);
    expect(computeMcRmdFloorCents(both, survivors, 2024, RMD)).toBe(0);
  });

  it('SECURE 2.0 §107 trigger age — born 1960 at age 74 → 0 (trigger is 75)', () => {
    const survivors = [owner('m1', '1960-01-01')]; // age 74 in 2034
    expect(computeMcRmdFloorCents(new Map([['m1', 1_000_000_00]]), survivors, 2034, RMD)).toBe(0);
  });

});

describe('buildPreTaxCentsByOwnerIdx — account-type filtering', () => {
  const OWNERS = ['m1'];
  const ledgerEntry = (
    id: string,
    accountType: McPreTaxLedgerEntry['accountType'],
    taxTreatment: McPreTaxLedgerEntry['taxTreatment'],
  ): McPreTaxLedgerEntry => ({ id, accountType, taxTreatment, ownerId: 'm1' });
  const acctRow = (preEnd: number, postEnd: number): DrawdownAccountYear => ({
    balance: preEnd + postEnd,
    preEnd,
    postEnd,
    withdrawn: 0,
    deposit: 0,
  });

  it('traditional IRA (PRE_TAX) pre-tax bucket is included', () => {
    const bal = new Map([['a', acctRow(500_000, 0)]]);
    const idx = buildPreTaxCentsByOwnerIdx(bal, [ledgerEntry('a', 'RETIREMENT_IRA', 'PRE_TAX')], OWNERS);
    expect(idx).toEqual([500_000_00]);
  });

  it('Roth IRA contributes 0 to the owner pre-tax total', () => {
    const bal = new Map([['a', acctRow(0, 500_000)]]);
    const idx = buildPreTaxCentsByOwnerIdx(bal, [ledgerEntry('a', 'RETIREMENT_ROTH_IRA', 'ROTH')], OWNERS);
    expect(idx).toEqual([0]);
  });

  it('brokerage contributes 0', () => {
    const bal = new Map([['a', acctRow(0, 500_000)]]);
    const idx = buildPreTaxCentsByOwnerIdx(bal, [ledgerEntry('a', 'BROKERAGE', 'POST_TAX')], OWNERS);
    expect(idx).toEqual([0]);
  });

  it('HSA contributes 0', () => {
    const bal = new Map([['a', acctRow(0, 200_000)]]);
    const idx = buildPreTaxCentsByOwnerIdx(bal, [ledgerEntry('a', 'HSA', 'HSA')], OWNERS);
    expect(idx).toEqual([0]);
  });

  it('MIXED 401k uses the pre-tax sub-bucket only (§325 Roth-designated post excluded)', () => {
    const bal = new Map([['a', acctRow(300_000, 200_000)]]);
    const idx = buildPreTaxCentsByOwnerIdx(bal, [ledgerEntry('a', 'RETIREMENT_401K', 'MIXED')], OWNERS);
    expect(idx).toEqual([300_000_00]);
  });

  it('RETIREMENT_CASH_BALANCE (PRE_TAX) is included', () => {
    const bal = new Map([['a', acctRow(400_000, 0)]]);
    const idx = buildPreTaxCentsByOwnerIdx(bal, [ledgerEntry('a', 'RETIREMENT_CASH_BALANCE', 'PRE_TAX')], OWNERS);
    expect(idx).toEqual([400_000_00]);
  });

  it('MIXED RETIREMENT_CASH_BALANCE uses the pre-tax sub-bucket only', () => {
    const bal = new Map([['a', acctRow(250_000, 150_000)]]);
    const idx = buildPreTaxCentsByOwnerIdx(bal, [ledgerEntry('a', 'RETIREMENT_CASH_BALANCE', 'MIXED')], OWNERS);
    expect(idx).toEqual([250_000_00]);
  });

  it('sums multiple qualifying accounts per owner and keys to owner position', () => {
    const ledger: McPreTaxLedgerEntry[] = [
      { id: 'a', accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX', ownerId: 'm1' },
      { id: 'b', accountType: 'RETIREMENT_401K', taxTreatment: 'PRE_TAX', ownerId: 'm2' },
      { id: 'c', accountType: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH', ownerId: 'm2' },
    ];
    const bal = new Map([
      ['a', acctRow(100_000, 0)],
      ['b', acctRow(200_000, 0)],
      ['c', acctRow(0, 50_000)],
    ]);
    const idx = buildPreTaxCentsByOwnerIdx(bal, ledger, ['m1', 'm2']);
    expect(idx).toEqual([100_000_00, 200_000_00]); // m2's Roth contributes 0
  });

  it('round-trips through buildPriorPreTaxByOwnerFromIdx (owner memberId keys)', () => {
    const map = buildPriorPreTaxByOwnerFromIdx([100_000_00, 0, 250_000_00], ['m1', 'm2', 'm3']);
    expect(map.get('m1')).toBe(100_000_00);
    expect(map.has('m2')).toBe(false); // 0 → omitted
    expect(map.get('m3')).toBe(250_000_00);
  });

  it('an absent accountBalances map yields all-zero (accumulation row)', () => {
    const idx = buildPreTaxCentsByOwnerIdx(undefined, [
      { id: 'a', accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX', ownerId: 'm1' },
    ], OWNERS);
    expect(idx).toEqual([0]);
  });
});

describe('buildKernelWholePortfolioPreTaxByOwner — kernel fallback', () => {
  const RMD = DEFAULT_TAX_CALIBRATION_BUNDLE.rmd;
  const owner = (memberId: string, isoBirthdate: string): TaxMemberInput => ({
    memberId,
    isoBirthdate,
    onMedicare: false,
    hasAcaCoverage: false,
  });

  it('assigns the whole balance to the OLDEST RMD-age owner (largest floor)', () => {
    // The no-ledger fallback reproduces the legacy max-over-survivors floor: the whole $1.5M goes to one owner and the floor equals the older owner's (smallest divisor), not the sum.
    const survivors = [owner('m1', '1951-01-01'), owner('m2', '1945-01-01')];
    const map = buildKernelWholePortfolioPreTaxByOwner(survivors, 1_500_000, 2024, RMD);
    const floor = computeMcRmdFloorCents(map, survivors, 2024, RMD);
    const olderFloor = computeMcRmdFloorCents(
      new Map([['m2', 1_500_000_00]]),
      survivors,
      2024,
      RMD,
    );
    expect(floor).toBe(olderFloor);
    const sumIfBoth =
      computeMcRmdFloorCents(new Map([['m1', 1_500_000_00]]), survivors, 2024, RMD) + olderFloor;
    expect(floor).toBeLessThan(sumIfBoth);
  });

  it('zero balance or no survivors → empty map (no floor)', () => {
    const survivors = [owner('m1', '1951-01-01')];
    expect(buildKernelWholePortfolioPreTaxByOwner(survivors, 0, 2024, RMD).size).toBe(0);
    expect(buildKernelWholePortfolioPreTaxByOwner([], 1_000_000, 2024, RMD).size).toBe(0);
  });
});

describe('computeMcRmdFloorCents — QCD per-owner RMD offset', () => {
  const RMD = DEFAULT_TAX_CALIBRATION_BUNDLE.rmd;
  const member = (id: string, iso: string): TaxMemberInput => ({
    memberId: id,
    isoBirthdate: iso,
    onMedicare: true,
    hasAcaCoverage: false,
  });

  it('reduces the owner IRA-pool floor by their offset, clamped ≥ 0', () => {
    const survivors = [member('m1', '1951-01-01')]; // age 73 in 2024 → RMD applies
    const basis = new Map([['m1', 1_500_000_00]]);
    const gross = computeMcRmdFloorCents(basis, survivors, 2024, RMD);
    expect(gross).toBeGreaterThan(0);
    const offset20k = computeMcRmdFloorCents(
      basis,
      survivors,
      2024,
      RMD,
      new Map([['m1', 20_000_00]]),
    );
    expect(offset20k).toBe(gross - 20_000_00);
    const offsetHuge = computeMcRmdFloorCents(
      basis,
      survivors,
      2024,
      RMD,
      new Map([['m1', 99_999_999_00]]),
    );
    expect(offsetHuge).toBe(0);
  });

  it('offsets ONLY the owner whose pre-tax basis is in the map (no cross-owner)', () => {
    // Both RMD-age, each owning a $1.5M IRA pool: a QCD by m1 offsets only m1's floor.
    const survivors = [member('m1', '1951-01-01'), member('m2', '1945-01-01')];
    const basis = new Map([
      ['m1', 1_500_000_00],
      ['m2', 1_500_000_00],
    ]);
    const gross = computeMcRmdFloorCents(basis, survivors, 2024, RMD);
    const m1Only = computeMcRmdFloorCents(
      basis,
      survivors,
      2024,
      RMD,
      new Map([['m1', 10_000_00]]),
    );
    expect(m1Only).toBe(gross - 10_000_00);
  });

  it('a below-trigger owner has no floor to offset (70½–72 pre-RMD)', () => {
    // Born 1953 (age 71 in 2024): QCD-eligible (70½) but not yet RMD-age (73), so an offset leaves the $0 floor at 0.
    const survivors = [member('m1', '1953-06-01')];
    const basis = new Map([['m1', 1_500_000_00]]);
    const gross = computeMcRmdFloorCents(basis, survivors, 2024, RMD);
    expect(gross).toBe(0);
    const offset = computeMcRmdFloorCents(
      basis,
      survivors,
      2024,
      RMD,
      new Map([['m1', 50_000_00]]),
    );
    expect(offset).toBe(0);
  });
});

describe('applyPerYearTaxForPath — QCD income exclusion', () => {
  function singleMemberCtx(birthYear: number): McTaxContext {
    return makeMfjTaxContext({
      filingStatus: 'Single',
      members: [
        { memberId: 'primary', isoBirthdate: `${birthYear}-01-01`, onMedicare: true, hasAcaCoverage: false },
      ],
      householdSize: 1,
    });
  }

  // An RMD-age member with a $200k pre-tax sub-bucket; the $60k draw exceeds the floor, so the exclusion (not the floor offset) is what removes the QCD from income.
  const drawArgs = {
    taxYear: 2024,
    retirementYear: 2020,
    grossSsDollars: 0,
    nominalExpense: 60_000,
    otherIncome: 0,
    priorBalance: 200_000,
    priorPreTaxByOwner: new Map<string, number>([['primary', 200_000_00]]),
    magiMinus2: undefined,
    classification: {
      preTaxDollars: 60_000,
      postTaxNonRothDollars: 0,
      postTaxCashLikeDollars: 0,
      rothBasisOrderedDollars: 0,
      rothWholesaleTaxFreeDollars: 0,
    },
  } as const;

  it('excludes the QCD from MAGI before §86 → lower MAGI + federal tax', () => {
    const noQcd = applyPerYearTaxForPath({ taxCtx: singleMemberCtx(1951), ...drawArgs });
    const withQcd = applyPerYearTaxForPath({
      taxCtx: singleMemberCtx(1951),
      ...drawArgs,
      qcdIncomeExclusionDollars: 20_000,
      qcdRmdOffsetCentsByOwner: new Map([['primary', 20_000_00]]),
    });
    expect(noQcd).not.toBeNull();
    expect(withQcd).not.toBeNull();
    expect(noQcd!.magiDollars - withQcd!.magiDollars).toBeCloseTo(20_000, 2);
    expect(withQcd!.fedTax).toBeLessThan(noQcd!.fedTax);
  });

  it('the floor offset alone (no exclusion) leaves a sub-floor draw correct', () => {
    const subFloor = {
      ...drawArgs,
      nominalExpense: 8_000,
      classification: { ...drawArgs.classification, preTaxDollars: 8_000 },
    };
    const grossUp = applyPerYearTaxForPath({ taxCtx: singleMemberCtx(1951), ...subFloor });
    const withOffset = applyPerYearTaxForPath({
      taxCtx: singleMemberCtx(1951),
      ...subFloor,
      qcdIncomeExclusionDollars: 5_000,
      qcdRmdOffsetCentsByOwner: new Map([['primary', 5_000_00]]),
    });
    expect(grossUp).not.toBeNull();
    expect(withOffset).not.toBeNull();
    expect(withOffset!.magiDollars).toBeLessThan(grossUp!.magiDollars);
  });
});

describe('advanceMcTaxableIncomeState — shared accumulator parity', () => {
  const singleCtx = (): McTaxContext => ({
    taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus: 'Single',
    members: [
      { memberId: 'primary', isoBirthdate: '1960-03-15', onMedicare: false, hasAcaCoverage: false },
    ],
    householdSize: 1,
    inflationRatePct: 3,
    assumedCostBasisFraction: 0.5,
  });

  it('reproduces the deterministic helpers exactly on identical rows', () => {
    // One brokerage (yield/basis), one CD (interest), one HSA (stays tax-free) and one pre-tax row: the MC advance must return the numbers of the deterministic helpers on the same rows.
    const rows = [
      {
        id: 'brok', taxTreatment: 'POST_TAX' as const, accountType: 'BROKERAGE' as const,
        startBalanceDollars: 500_000, endBalanceDollars: 520_000,
        withdrawnDollars: 20_000, depositDollars: 0,
      },
      {
        id: 'cd', taxTreatment: 'POST_TAX' as const, accountType: 'CD' as const,
        startBalanceDollars: 100_000, endBalanceDollars: 103_000,
        withdrawnDollars: 1_000, depositDollars: 0,
      },
      {
        id: 'hsa', taxTreatment: 'HSA' as const, accountType: 'HSA' as const,
        startBalanceDollars: 50_000, endBalanceDollars: 55_000,
        withdrawnDollars: 0, depositDollars: 0,
      },
      {
        id: 'ira', taxTreatment: 'PRE_TAX' as const, accountType: 'RETIREMENT_IRA' as const,
        startBalanceDollars: 300_000, endBalanceDollars: 310_000,
        withdrawnDollars: 10_000, depositDollars: 0,
      },
    ];
    const mcState = { basisByAccountId: new Map<string, number>(), seedBasisFraction: 0.5 };
    const mc = advanceMcTaxableIncomeState(rows, mcState, 0.02);

    const detState = { basisByAccountId: new Map<string, number>(), seedBasisFraction: 0.5 };
    const det = advanceBrokerageLikeBasis([rows[0]], detState, 0.02);
    const detInterest = computeCashLikeInterestDollars([rows[1]]);

    expect(mc.brokerageLikeStartBalanceDollars).toBe(det.startBalanceDollars);
    expect(mc.costBasisFraction).toBe(det.preWithdrawalBasisFraction);
    expect(mc.cashInterestDollars).toBe(detInterest);
    expect(mc.cashInterestDollars).toBe(4_000);
    expect(mcState.basisByAccountId.get('brok')).toBe(detState.basisByAccountId.get('brok'));
    expect(mcState.basisByAccountId.has('hsa')).toBe(false);
    expect(mcState.basisByAccountId.has('ira')).toBe(false);
  });

  it('buildMcTaxYearInput threads yield base + evolved fraction + cash interest', () => {
    const base: PerYearTaxArgs = {
      taxCtx: singleCtx(),
      taxYear: 2026,
      retirementYear: 2026,
      grossSsDollars: 0,
      nominalExpense: 60_000,
      otherIncome: 0,
      priorBalance: 0,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
      classification: {
        preTaxDollars: 0,
        postTaxNonRothDollars: 40_000,
        postTaxCashLikeDollars: 0,
        rothBasisOrderedDollars: 0,
        rothWholesaleTaxFreeDollars: 0,
      },
    };
    const withoutTaxableIncome = applyPerYearTaxForPath(base);
    const withTaxableIncome = applyPerYearTaxForPath({
      ...base,
      brokerageLikeStartBalanceDollars: 1_000_000,
      costBasisFraction: 0.25,
      cashInterestDollars: 5_000,
    });
    expect(withoutTaxableIncome).not.toBeNull();
    expect(withTaxableIncome).not.toBeNull();
    // MAGI delta = $20k yield (2% of $1M) + $5k interest + $10k extra LTCG (basis fraction 0.25 vs the static 0.5 on the $40k draw).
    expect(withTaxableIncome!.magiDollars - withoutTaxableIncome!.magiDollars).toBeCloseTo(35_000, 6);
  });
});

describe('pooled penalty — 457(b) source exemption parity', () => {
  const youngCtx = (flags: Partial<McTaxContext>): McTaxContext => ({
    taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus: 'Single',
    members: [
      { memberId: 'primary', isoBirthdate: '1980-05-20', onMedicare: false, hasAcaCoverage: false },
    ],
    householdSize: 1,
    inflationRatePct: 3,
    ...flags,
  });
  const drawArgs = (taxCtx: McTaxContext): PerYearTaxArgs => ({
    taxCtx,
    taxYear: 2026,
    retirementYear: 2026,
    grossSsDollars: 0,
    nominalExpense: 50_000,
    otherIncome: 0,
    priorBalance: 400_000,
    priorPreTaxByOwner: new Map<string, number>(),
    magiMinus2: undefined,
    classification: {
      preTaxDollars: 50_000,
      postTaxNonRothDollars: 0,
      postTaxCashLikeDollars: 0,
      rothBasisOrderedDollars: 0,
      rothWholesaleTaxFreeDollars: 0,
    },
  });

  it('an all-457(b) pre-tax household (source-exempt flag) funds NO §72(t) penalty', () => {
    // A governmental 457(b) distribution carries no 10% additional tax, so the pooled leg is waived when every pre-tax source resolved as 457(b).
    const exempt = applyPerYearTaxForPath(drawArgs(youngCtx({ mcPreTaxPenaltyAllExempt: true })));
    const penalized = applyPerYearTaxForPath(drawArgs(youngCtx({})));
    expect(exempt).not.toBeNull();
    expect(penalized).not.toBeNull();
    expect(penalized!.taxCashflowDollars - exempt!.taxCashflowDollars).toBeCloseTo(5_000, 6);
    expect(exempt!.fedTax).toBe(penalized!.fedTax);
  });
});

describe('per-source pooled penalty — mixed 457(b) pools', () => {
  const row = (o: Partial<McAccountYearWithdrawal>): McAccountYearWithdrawal => ({
    taxTreatment: 'PRE_TAX',
    accountType: 'RETIREMENT_IRA',
    withdrawalDollars: 0,
    preBalanceStartDollars: 0,
    postBalanceStartDollars: 0,
    ...o,
  });
  const youngCtx = (): McTaxContext => ({
    taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus: 'Single',
    members: [
      { memberId: 'primary', isoBirthdate: '1980-05-20', onMedicare: false, hasAcaCoverage: false },
    ],
    householdSize: 1,
    inflationRatePct: 3,
  });

  it('classifier: a mixed pre-tax pool preserves the 457(b)-sourced exempt dollars', () => {
    const cls = classifyMcWithdrawal([
      row({ accountType: 'RETIREMENT_457B', withdrawalDollars: 30_000 }),
      row({ accountType: 'RETIREMENT_IRA', withdrawalDollars: 20_000 }),
    ]);
    expect(cls.preTaxDollars).toBe(50_000);
    expect(cls.preTaxPenaltyExemptDollars).toBe(30_000);
    expect(cls.rothOrderedPenaltyExemptDollars).toBe(0);
  });

  it('classifier: a scenario-marked exempt IRA counts toward the exempt dollars', () => {
    const cls = classifyMcWithdrawal([
      row({ withdrawalDollars: 15_000, scenarioPenaltyExempt: true }),
      row({ withdrawalDollars: 25_000 }),
    ]);
    expect(cls.preTaxDollars).toBe(40_000);
    expect(cls.preTaxPenaltyExemptDollars).toBe(15_000);
  });

  it('classifier: a mixed Roth pool preserves the Roth-457(b)-sourced exempt dollars', () => {
    const cls = classifyMcWithdrawal([
      row({ taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_457B', withdrawalDollars: 12_000 }),
      row({ taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA', withdrawalDollars: 8_000 }),
    ]);
    expect(cls.rothBasisOrderedDollars).toBe(20_000);
    expect(cls.rothOrderedPenaltyExemptDollars).toBe(12_000);
    expect(cls.preTaxPenaltyExemptDollars).toBe(0);
  });

  it('classifier: MIXED governmental 457(b) pre AND post shares are both source-exempt', () => {
    const cls = classifyMcWithdrawal([
      row({
        taxTreatment: 'MIXED',
        accountType: 'RETIREMENT_457B',
        withdrawalDollars: 10_000,
        preBalanceStartDollars: 60_000,
        postBalanceStartDollars: 40_000,
      }),
    ]);
    expect(cls.preTaxDollars).toBeCloseTo(6_000, 6);
    expect(cls.preTaxPenaltyExemptDollars).toBeCloseTo(6_000, 6);
    expect(cls.rothBasisOrderedDollars).toBeCloseTo(4_000, 6);
    expect(cls.rothOrderedPenaltyExemptDollars).toBeCloseTo(4_000, 6);
  });

  it('buildYearClassification threads the ledger scenario exemption into the split', () => {
    const cls = buildYearClassification(
      [
        { taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA', scenarioPenaltyExempt: true },
        { taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' },
      ],
      [
        { withdrawalDollars: 9_000, preBalanceStartDollars: 100_000, postBalanceStartDollars: 0 },
        { withdrawalDollars: 6_000, preBalanceStartDollars: 100_000, postBalanceStartDollars: 0 },
      ],
    );
    expect(cls).toBeDefined();
    expect(cls!.preTaxDollars).toBe(15_000);
    expect(cls!.preTaxPenaltyExemptDollars).toBe(9_000);
  });

  it('mixed pre-tax pool (457(b) + IRA): only the IRA-sourced portion is penalized', () => {
    // The pooled flag stays false (mixed pool) but the per-source split penalizes only the $20k IRA share (10% x $20k = $2,000), not 10% x $50k.
    const mixedCls = classifyMcWithdrawal([
      row({ accountType: 'RETIREMENT_457B', withdrawalDollars: 30_000 }),
      row({ accountType: 'RETIREMENT_IRA', withdrawalDollars: 20_000 }),
    ]);
    const allIraCls = classifyMcWithdrawal([
      row({ accountType: 'RETIREMENT_IRA', withdrawalDollars: 50_000 }),
    ]);
    const args = (classification: typeof mixedCls): PerYearTaxArgs => ({
      taxCtx: youngCtx(),
      taxYear: 2026,
      retirementYear: 2026,
      grossSsDollars: 0,
      nominalExpense: 50_000,
      otherIncome: 0,
      priorBalance: 400_000,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
      classification,
    });
    const mixed = applyPerYearTaxForPath(args(mixedCls));
    const allIra = applyPerYearTaxForPath(args(allIraCls));
    expect(mixed).not.toBeNull();
    expect(allIra).not.toBeNull();
    expect(allIra!.taxCashflowDollars - mixed!.taxCashflowDollars).toBeCloseTo(3_000, 6);
    expect(mixed!.fedTax).toBe(allIra!.fedTax);
  });

  it('mixed Roth pool (Roth 457(b) + Roth IRA): the SOURCE-RESOLVED additional-tax base is not re-prorated', () => {
    // The ordering engine hands this leg an already source-resolved additional-tax base (the §72(t)(9) carve-out applies only to an all-457(b) pool),
    // so re-prorating it by the 457(b) withdrawal share would discount genuine IRA recapture; the mixed pool pays the same 10% as the all-IRA twin.
    const mixedCls = classifyMcWithdrawal([
      row({ taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_457B', withdrawalDollars: 12_000 }),
      row({ taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA', withdrawalDollars: 8_000 }),
    ]);
    const allIraCls = classifyMcWithdrawal([
      row({ taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA', withdrawalDollars: 20_000 }),
    ]);
    const args = (classification: typeof mixedCls): PerYearTaxArgs => ({
      taxCtx: youngCtx(),
      taxYear: 2026,
      retirementYear: 2026,
      grossSsDollars: 0,
      nominalExpense: 20_000,
      otherIncome: 0,
      priorBalance: 400_000,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
      classification,
      rothBasisCarrier: seedRothBasisCarrier(
        new Map([[MC_AGGREGATE_ROTH_OWNER_KEY, 10_000 * 100]]),
      ),
    });
    const mixed = applyPerYearTaxForPath(args(mixedCls));
    const allIra = applyPerYearTaxForPath(args(allIraCls));
    expect(mixed).not.toBeNull();
    expect(allIra).not.toBeNull();
    expect(allIra!.taxCashflowDollars - mixed!.taxCashflowDollars).toBeCloseTo(0, 6);
    expect(mixed!.fedTax).toBe(allIra!.fedTax);
  });

  // §72(t)(2)(A)(ii): a distribution on account of the original owner's death carries no 10% at any beneficiary age. The MC Roth leg once omitted
  // `deathExemptInherited`, charging the full 10% where the deterministic twin charged none.
  it('inherited designated-Roth plan: no 10% on the ordered Roth leg before 59½', () => {
    const survivorState = {
      survivors: [
        {
          memberId: 'primary',
          isoBirthdate: '1980-05-20',
          onMedicare: false,
          hasAcaCoverage: false,
        },
      ],
      filingStatus: 'Single',
    } as McSurvivorState;
    // A $20,000 pre-59½ draw from one designated-Roth plan with an unmet §402A five-year clock; $10,000 is the additional-tax base the ordering engine resolved upstream.
    const penaltyFor = (inherited: boolean): number => {
      const classification = classifyMcWithdrawal([
        row({
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_401K',
          withdrawalDollars: 20_000,
          ...(inherited ? { deathExemptInherited: true } : {}),
        }),
      ]);
      const args: PerYearTaxArgs = {
        taxCtx: youngCtx(),
        taxYear: 2026,
        retirementYear: 2026,
        grossSsDollars: 0,
        nominalExpense: 20_000,
        otherIncome: 0,
        priorBalance: 400_000,
        priorPreTaxByOwner: new Map<string, number>(),
        magiMinus2: undefined,
        classification,
      };
      return computeMcPenaltyDollars(args, survivorState, 10_000);
    };
    expect(penaltyFor(false)).toBeCloseTo(1_000, 6);
    expect(penaltyFor(true)).toBe(0);
  });

  it('funded strategy path: a mixed 457(b)+IRA household outlives an all-IRA twin (provenance reaches the funded loop)', () => {
    // Two identical runs differing only in the first account's type (457(b) vs IRA): type does not affect growth or ordering, so any balance difference is the per-source §72(t) split reaching the funded loop.
    const firstYear = 2026;
    const horizonYear = 2041;
    const years = horizonYear - firstYear + 1;
    const stepCount = years * 12;
    const ledger = (id: string, accountType: 'RETIREMENT_457B' | 'RETIREMENT_IRA') => ({
      id,
      initialPre: 300_000,
      initialPost: 0,
      contribPre: new Float64Array(stepCount),
      contribPost: new Float64Array(stepCount),
      deposit: new Float64Array(stepCount),
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
      taxTreatment: 'PRE_TAX' as const,
      accountType,
      ownerId: 'primary',
    });
    const input = (firstType: 'RETIREMENT_457B' | 'RETIREMENT_IRA'): MonteCarloInput => ({
      portfolioToday: 600_000,
      accountMcLedger: [ledger('first', firstType), ledger('ira', 'RETIREMENT_IRA')],
      annualContribution: 0,
      firstYear,
      retirementYear: firstYear,
      horizonYear,
      monthlyExpenseBase: makeMonthlyExpenseBase(50_000, stepCount),
      ssByYear: new Array<number>(years).fill(0),
      incomeByYear: new Array<number>(years).fill(0),
      pathCount: 40,
      seed: 777,
      strategyKind: 'taxEfficient',
      taxContext: {
        taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
        filingStatus: 'Single',
        members: [
          { memberId: 'primary', isoBirthdate: '1985-03-15', onMedicare: false, hasAcaCoverage: false },
        ],
        householdSize: 1,
        inflationRatePct: 3,
      },
    });
    const mixed = runMonteCarlo(input('RETIREMENT_457B'));
    const allIra = runMonteCarlo(input('RETIREMENT_IRA'));
    const last = years - 1;
    expect(mixed.percentilesNominal.p50[last]).toBeGreaterThan(
      allIra.percentilesNominal.p50[last],
    );
  });
});

describe('run-level invariants — display-exact vs funded-approximate', () => {
  const firstYear = 2026;
  const horizonYear = 2056;
  const years = horizonYear - firstYear + 1;
  const stepCount = years * 12;

  function brokerageCdInput(): MonteCarloInput {
    const ledger = (
      id: string,
      initialPost: number,
      accountType: 'BROKERAGE' | 'CD',
      cashPct: number,
    ) => ({
      id,
      initialPre: 0,
      initialPost,
      contribPre: new Float64Array(stepCount),
      contribPost: new Float64Array(stepCount),
      deposit: new Float64Array(stepCount),
      assetMix: { stocksPct: 100 - cashPct - 25, bondsPct: 25, cashPct },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
      taxTreatment: 'POST_TAX' as const,
      accountType,
      ownerId: 'p8-primary',
    });
    return {
      portfolioToday: 900_000,
      accountMcLedger: [
        { ...ledger('brok', 800_000, 'BROKERAGE', 5) },
        {
          ...ledger('cd', 100_000, 'CD', 100),
          assetMix: { stocksPct: 0, bondsPct: 0, cashPct: 100 },
        },
      ],
      annualContribution: 0,
      firstYear,
      retirementYear: firstYear,
      horizonYear,
      monthlyExpenseBase: makeMonthlyExpenseBase(60_000, stepCount),
      ssByYear: new Array<number>(years).fill(15_000),
      incomeByYear: new Array<number>(years).fill(0),
      pathCount: 60,
      seed: 4321,
      strategyKind: 'taxEfficient',
      taxContext: {
        taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
        filingStatus: 'Single' as const,
        members: [
          {
            memberId: 'p8-primary',
            isoBirthdate: '1960-03-15',
            onMedicare: false,
            hasAcaCoverage: false,
          },
        ],
        householdSize: 1,
        inflationRatePct: 3,
        assumedCostBasisFraction: 0.5,
      },
    };
  }

  it('funded bands stay at the earlier baseline (the display-only funded design)', () => {
    // The funded per-path tax keeps the shared pre-commit approximation, so success and the banded federal tax reproduce the captured baseline exactly.
    const out = runMonteCarlo(brokerageCdInput());
    expect(out.successProbability).toBe(
      mcParityBaselines.p8_brokerageCd_successProbability_preFix,
    );
    const medianCumFedTax = (out.federalTaxPercentilesByYear?.p50 ?? []).reduce(
      (s, v) => s + v,
      0,
    );
    expect(medianCumFedTax).toBe(
      mcParityBaselines.p8_brokerageCd_medianCumulativeFederalTaxBand_preFix,
    );
  });

  it('representative DISPLAY federal tax turns positive (yield drag + evolving basis + CD interest)', () => {
    // The funded banded median is $0 federal tax here (static 0.5 basis, no yield drag, no interest); the representative display carries the deterministic taxable-income model, so its stamped cents are positive.
    const out = runMonteCarlo(brokerageCdInput());
    const rep = out.representativeByBasis?.['mc-typical'];
    expect(rep).toBeDefined();
    const stampedFedCents = rep!.years.reduce((s, y) => s + (y.federalTaxCents ?? 0), 0);
    expect(stampedFedCents).toBeGreaterThan(0);
  });
});

describe('filing-plan activation — MC per-path tax', () => {
  const firstYear = 2026;
  const horizonYear = 2060;
  const years = horizonYear - firstYear + 1;
  const stepCount = years * 12;
  // The secondary dies partway through the horizon, so the survivor years are the ones the activated plan re-files.
  const secondaryDeathYear = 2045;

  function coupleInput(
    taxCtxPatch: Partial<McTaxContext>,
  ): MonteCarloInput {
    return {
      portfolioToday: 1_400_000,
      accountMcLedger: [
        {
          id: 'p11-ira',
          initialPre: 1_400_000,
          initialPost: 0,
          contribPre: new Float64Array(stepCount),
          contribPost: new Float64Array(stepCount),
          deposit: new Float64Array(stepCount),
          assetMix: { stocksPct: 60, bondsPct: 35, cashPct: 5 },
          assetMixSeries: null,
          cbpPlanningReturnPct: null,
          taxTreatment: 'PRE_TAX' as const,
          accountType: 'RETIREMENT_IRA' as const,
          ownerId: 'p11-primary',
        },
      ],
      annualContribution: 0,
      firstYear,
      retirementYear: firstYear,
      horizonYear,
      monthlyExpenseBase: makeMonthlyExpenseBase(96_000, stepCount),
      ssByYear: new Array<number>(years).fill(48_000),
      incomeByYear: new Array<number>(years).fill(0),
      pathCount: 40,
      seed: 90_210,
      strategyKind: 'taxEfficient',
      taxContext: {
        taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
        filingStatus: 'MFJ' as const,
        members: [
          {
            memberId: 'p11-primary',
            isoBirthdate: '1962-04-02',
            onMedicare: false,
            hasAcaCoverage: false,
          },
          {
            memberId: 'p11-secondary',
            isoBirthdate: '1963-09-11',
            onMedicare: false,
            hasAcaCoverage: false,
          },
        ],
        householdSize: 2,
        inflationRatePct: 2.5,
        secondaryDeathYear,
        ...taxCtxPatch,
      },
    };
  }

  const medianEndingReal = (input: MonteCarloInput): number => {
    const out = runMonteCarlo(input);
    return out.percentilesReal.p50[years - 1];
  };

  it('reproduces the legacy scalar path when the joint plan resolves identically (no death in horizon)', () => {
    // With nobody dying in the horizon a `joint` plan resolves to MFJ every year, exactly what the frozen scalar derived: activation must not move a number.
    const legacy = runMonteCarlo(
      coupleInput({ secondaryDeathYear: undefined, filingStatusOverride: 'MFJ' }),
    );
    const planned = runMonteCarlo(
      coupleInput({ secondaryDeathYear: undefined, taxFilingPlan: { kind: 'joint' } }),
    );
    expect(planned.successProbability).toBe(legacy.successProbability);
    expect(planned.percentilesReal.p50).toEqual(legacy.percentilesReal.p50);
  });

  it('applies a user-entered QSS survivor window on top of the post-death Single default', () => {
    // A year-bounded QSS window overlays the post-death Single default with the MFJ bracket mapping, which is strictly less tax.
    const singleDefault = medianEndingReal(coupleInput({ taxFilingPlan: { kind: 'joint' } }));
    const qssWindow = medianEndingReal(
      coupleInput({
        taxFilingPlan: {
          kind: 'joint',
          statusWindows: [
            {
              status: 'QSS',
              start: { kind: 'year', year: secondaryDeathYear + 1 },
              end: { kind: 'year', year: secondaryDeathYear + 3 },
            },
          ],
        },
      }),
    );
    expect(qssWindow).toBeGreaterThan(singleDefault);
  });

  it('applies a QSS window on EXACTLY its covered years (boundary)', () => {
    // `end` is exclusive: [start, end) is covered, start-1 and end are not, and the death year stays MFJ. Direction alone cannot catch an off-by-one.
    const start = secondaryDeathYear + 1;
    const end = secondaryDeathYear + 3;
    const taxCtx: McTaxContext = {
      taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
      filingStatus: 'MFJ',
      members: [
        { memberId: 'p11-primary', isoBirthdate: '1962-04-02', onMedicare: false, hasAcaCoverage: false },
        { memberId: 'p11-secondary', isoBirthdate: '1963-09-11', onMedicare: false, hasAcaCoverage: false },
      ],
      householdSize: 2,
      secondaryDeathYear,
      taxFilingPlan: {
        kind: 'joint',
        statusWindows: [
          { status: 'QSS', start: { kind: 'year', year: start }, end: { kind: 'year', year: end } },
        ],
      },
    };
    const statusIn = (taxYear: number): string | undefined =>
      deriveMcSurvivors(taxCtx, taxYear, firstYear)?.filingStatus;
    expect(statusIn(start - 1)).toBe('MFJ');
    expect(statusIn(start)).toBe('QSS');
    expect(statusIn(end - 1)).toBe('QSS');
    expect(statusIn(end)).toBe('Single');
  });

  it('withholds tax units for an unresolved two-member scalar and keeps the legacy path', () => {
    // A two-member household carrying a `Single` scalar cannot say whose tax unit is dropped, so the resolver reports no units and the legacy scalar path is kept.
    const taxCtx: McTaxContext = {
      taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
      filingStatus: 'Single',
      members: [
        { memberId: 'p11-primary', isoBirthdate: '1962-04-02', onMedicare: false, hasAcaCoverage: false },
        { memberId: 'p11-secondary', isoBirthdate: '1963-09-11', onMedicare: false, hasAcaCoverage: false },
      ],
      householdSize: 2,
      filingStatusOverride: 'Single',
      secondaryDeathYear,
    };
    const bothAlive = deriveMcSurvivors(taxCtx, 2030, firstYear);
    expect(bothAlive?.taxUnits).toBeUndefined();
    expect(bothAlive?.filingStatus).toBe('Single');
  });

  it('tiers IRMAA on the look-back return status, not the current year', () => {
    const taxCtx: McTaxContext = {
      taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
      filingStatus: 'MFJ',
      members: [
        { memberId: 'p11-primary', isoBirthdate: '1962-04-02', onMedicare: true, hasAcaCoverage: false },
        { memberId: 'p11-secondary', isoBirthdate: '1963-09-11', onMedicare: true, hasAcaCoverage: false },
      ],
      householdSize: 2,
      secondaryDeathYear: 2045,
      taxFilingPlan: { kind: 'joint' },
    };
    // 2046 is the survivor's first Single year; its IRMAA look-back is the 2044 return, filed jointly.
    const survivorFirstSingleYear = deriveMcSurvivors(taxCtx, 2046, firstYear);
    expect(survivorFirstSingleYear?.filingStatus).toBe('Single');
    expect(survivorFirstSingleYear?.irmaaLookbackFilingStatus).toBe('MFJ');
    const laterSurvivorYear = deriveMcSurvivors(taxCtx, 2048, firstYear);
    expect(laterSurvivorYear?.irmaaLookbackFilingStatus).toBe('Single');
    expect(deriveMcSurvivors(taxCtx, 2045, firstYear)?.filingStatus).toBe('MFJ');
  });
  it('runs a SEPARATE (MFS) plan end to end and lands below the joint plan', () => {
    // Spouses filing apart while having lived together lose the §86(c)(1)(C)(ii) base amounts, so Social Security is taxable from the first dollar atop halved MFS brackets: strictly more tax than the joint plan.
    const joint = medianEndingReal(coupleInput({ taxFilingPlan: { kind: 'joint' } }));
    const separate = medianEndingReal(
      coupleInput({
        taxFilingPlan: {
          kind: 'separate',
          livedTogether: true,
          units: [
            { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
            { memberId: 'secondary', filingStatus: 'MFS', householdSize: 1 },
          ],
        },
        ssSharesByYear: Array.from({ length: years }, (_, i) => ({
          year: firstYear + i,
          primaryShare: 1,
        })),
      }),
    );
    expect(separate).toBeLessThan(joint);
  });

  it('attributes gross Social Security per recipient on the MC path', () => {
    // §86 is non-linear per return, so a 50/50 split of a benefit only one spouse receives gives different funded balances than attributing it to its recipient.
    const separatePlan: TaxFilingPlan = {
      kind: 'separate',
      units: [
        { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
        { memberId: 'secondary', filingStatus: 'MFS', householdSize: 1 },
      ],
    };
    const evenSplit = medianEndingReal(coupleInput({ taxFilingPlan: separatePlan }));
    const attributed = medianEndingReal(
      coupleInput({
        taxFilingPlan: separatePlan,
        ssSharesByYear: Array.from({ length: years }, (_, i) => ({
          year: firstYear + i,
          primaryShare: 1,
        })),
      }),
    );
    expect(attributed).not.toBe(evenSplit);
  });

  it('leaves a SINGLE-return household byte-identical when SS shares are supplied', () => {
    // Attribution reaches only the multi-unit branch, so a joint household must not move.
    const shares = Array.from({ length: years }, (_, i) => ({
      year: firstYear + i,
      primaryShare: 0.8,
    }));
    const without = runMonteCarlo(coupleInput({ taxFilingPlan: { kind: 'joint' } }));
    const with_ = runMonteCarlo(
      coupleInput({ taxFilingPlan: { kind: 'joint' }, ssSharesByYear: shares }),
    );
    expect(with_.successProbability).toBe(without.successProbability);
    expect(with_.percentilesReal.p50).toEqual(without.percentilesReal.p50);
  });
});

describe('bootstrap-year IRMAA look-back per return', () => {
  const MEMBERS = [
    { memberId: 'primary', isoBirthdate: '1955-01-01', onMedicare: true, hasAcaCoverage: false },
    { memberId: 'secondary', isoBirthdate: '1955-01-01', onMedicare: true, hasAcaCoverage: false },
  ];
  // Two returns differing only in the second spouse's status: `livedTogether` puts an MFS return on the steeper separate-filer Medicare schedule while a HoH return stays on the single-filer one,
  // the smallest household whose returns tier on different ladders.
  const separatePlan = (secondStatus: 'MFS' | 'HoH'): TaxFilingPlan => ({
    kind: 'separate',
    livedTogether: true,
    units: [
      { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
      { memberId: 'secondary', filingStatus: secondStatus, householdSize: 1 },
    ],
  });
  const taxCtxFor = (secondStatus: 'MFS' | 'HoH'): McTaxContext => ({
    taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus: 'MFJ',
    members: MEMBERS,
    householdSize: 2,
    taxFilingPlan: separatePlan(secondStatus),
  });
  // One bootstrap year: no per-return ring entry yet, only the household look-back MAGI; $300k splits to $150k per return, above tier 1 on both ladders but landing on very different surcharges.
  const bootstrapYearIrmaa = (secondStatus: 'MFS' | 'HoH'): number => {
    const result = applyPerYearTaxForPath({
      taxCtx: taxCtxFor(secondStatus),
      taxYear: 2026,
      retirementYear: 2026,
      grossSsDollars: 0,
      nominalExpense: 40_000,
      otherIncome: 0,
      priorBalance: 3_000_000,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: 300_000,
      irmaaLookbackUnitsMinus2: undefined,
      classification: {
        preTaxDollars: 40_000,
        postTaxNonRothDollars: 0,
        postTaxCashLikeDollars: 0,
        rothBasisOrderedDollars: 0,
        rothWholesaleTaxFreeDollars: 0,
      },
    });
    expect(result).not.toBeNull();
    return result!.irmaa;
  };

  it('carries each return own status into the bootstrap look-back', () => {
    const state = deriveMcSurvivors(taxCtxFor('HoH'), 2026, 2026);
    expect(state?.bootstrapLookbackUnits).toEqual([
      { memberIds: ['primary'], filingStatus: 'MFS', mfsLivedWithSpouse: true },
      { memberIds: ['secondary'], filingStatus: 'HoH', mfsLivedWithSpouse: false },
    ]);
  });

  it('reports no per-return bootstrap look-back for a single-return year', () => {
    const jointCtx: McTaxContext = {
      taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
      filingStatus: 'MFJ',
      members: MEMBERS,
      householdSize: 2,
      taxFilingPlan: { kind: 'joint' },
    };
    expect(deriveMcSurvivors(jointCtx, 2026, 2026)?.bootstrapLookbackUnits).toBeUndefined();
  });

  it('does not tier a HoH spouse on the other spouse married-filing-separately schedule', () => {
    // Regression: both returns collapsed onto units[0]'s status, so the head-of-household spouse was charged the separate-filer surcharge for two years
    // and then dropped to their own schedule once the per-return ring filled.
    const bothMfs = bootstrapYearIrmaa('MFS');
    const mixed = bootstrapYearIrmaa('HoH');
    expect(bothMfs).toBeGreaterThan(0);
    expect(mixed).toBeGreaterThan(0);
    expect(mixed).toBeLessThan(bothMfs);
  });
});

describe('applyMcRothBasisOrdering — fact-based §408A / §402A regimes', () => {
  const OWNER = 'mc-p12-owner';
  const PRE_59_MEMBER: TaxMemberInput = {
    memberId: OWNER,
    isoBirthdate: '1980-01-01',
    onMedicare: false,
    hasAcaCoverage: false,
  };
  const taxCtx = (profile?: McRothOrderedProfile): McTaxContext =>
    ({
      taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
      filingStatus: 'Single',
      members: [PRE_59_MEMBER],
      householdSize: 1,
      inflationRatePct: 0,
      ...(profile !== undefined ? { rothOrderedProfile: profile } : {}),
    }) as unknown as McTaxContext;

  // The designated slice runs the shared stateful engine against a pooled carrier entry, so the pool is seeded (and across a multi-year sequence reused) exactly as the engine does.
  const args = (
    carrier: ReturnType<typeof seedMcAggregateRothBasisCarrier>,
    profile?: McRothOrderedProfile,
    over: {
      readonly taxYear?: number;
      readonly drawDollars?: number;
      readonly pool?: ReturnType<typeof seedMcDesignatedRothPool>;
      readonly designatedRothPoolBalanceDollars?: number;
    } = {},
  ) =>
    ({
      designatedRothPool: over.pool ?? seedMcDesignatedRothPool(profile),
      ...(over.designatedRothPoolBalanceDollars !== undefined
        ? { designatedRothPoolBalanceDollars: over.designatedRothPoolBalanceDollars }
        : {}),
      taxYear: over.taxYear ?? 2030,
      retirementYear: 2025,
      grossSsDollars: 0,
      nominalExpense: 10_000,
      otherIncome: 0,
      priorBalance: 500_000,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
      taxCtx: taxCtx(profile),
      rothBasisCarrier: carrier,
      classification: {
        preTaxDollars: 0,
        postTaxNonRothDollars: 0,
        postTaxCashLikeDollars: 0,
        rothBasisOrderedDollars: over.drawDollars ?? 10_000,
        rothWholesaleTaxFreeDollars: 0,
      },
    }) as unknown as Parameters<typeof applyMcRothBasisOrdering>[0];

  const profile = (over: Partial<McRothOrderedProfile> = {}): McRothOrderedProfile => ({
    iraShareOfOrderedPool: 1,
    iraConversionLots: [],
    designatedBasisCents: 0,
    designatedBalanceCents: 0,
    designatedAllGovernmental457b: false,
    ...over,
  });

  it('a Roth-IRA draw inside recorded contribution basis is tax- AND penalty-free', () => {
    const carrier = seedMcAggregateRothBasisCarrier([{ ownerId: OWNER, cents: 20_000 * 100 }]);
    const out = applyMcRothBasisOrdering(args(carrier, profile()));
    expect(out.earningsExcessDollars).toBe(0);
    expect(out.additionalTaxBaseDollars).toBe(0);
  });

  it('a conversion lot INSIDE its five-year window enters the 10% base but is NOT re-taxed as income', () => {
    // No regular basis; one $10,000 fully-taxable 2028 conversion: the 2030 draw is inside the five-tax-year window and the owner is pre-59½.
    const carrier = seedMcAggregateRothBasisCarrier(
      [],
      profile({
        iraConversionLots: [{ taxYear: 2028, taxableCents: 10_000 * 100, nontaxableCents: 0 }],
      }),
    );
    const out = applyMcRothBasisOrdering(
      args(
        carrier,
        profile({
          iraConversionLots: [{ taxYear: 2028, taxableCents: 10_000 * 100, nontaxableCents: 0 }],
        }),
      ),
    );
    expect(out.earningsExcessDollars).toBe(0);
    expect(out.additionalTaxBaseDollars).toBe(10_000);
  });

  it('the SAME lot OUTSIDE its five-year window carries no recapture', () => {
    const lots = [{ taxYear: 2020, taxableCents: 10_000 * 100, nontaxableCents: 0 }];
    const carrier = seedMcAggregateRothBasisCarrier([], profile({ iraConversionLots: lots }));
    const out = applyMcRothBasisOrdering(
      args(carrier, profile({ iraConversionLots: lots })),
    );
    expect(out.earningsExcessDollars).toBe(0);
    expect(out.additionalTaxBaseDollars).toBe(0);
  });

  it('the designated-Roth slice splits PRO RATA, not contributions-first', () => {
    const p = profile({
      iraShareOfOrderedPool: 0,
      designatedBasisCents: 50_000 * 100,
      designatedBalanceCents: 100_000 * 100,
    });
    const carrier = seedMcAggregateRothBasisCarrier([], p);
    const out = applyMcRothBasisOrdering(args(carrier, p));
    expect(out.earningsExcessDollars).toBe(5_000);
    expect(out.additionalTaxBaseDollars).toBe(5_000);
  });

  it('an all-governmental-457(b) designated pool owes income tax on growth but NO 10% (§72(t)(9))', () => {
    const p = profile({
      iraShareOfOrderedPool: 0,
      designatedBasisCents: 0,
      designatedBalanceCents: 100_000 * 100,
      designatedAllGovernmental457b: true,
    });
    const carrier = seedMcAggregateRothBasisCarrier([], p);
    const out = applyMcRothBasisOrdering(args(carrier, p));
    expect(out.earningsExcessDollars).toBe(10_000);
    expect(out.additionalTaxBaseDollars).toBe(0);
  });

  it('a designated pool with NO recorded basis treats the whole draw as growth (conservative)', () => {
    const p = profile({
      iraShareOfOrderedPool: 0,
      designatedBasisCents: 0,
      designatedBalanceCents: 100_000 * 100,
    });
    const carrier = seedMcAggregateRothBasisCarrier([], p);
    const out = applyMcRothBasisOrdering(args(carrier, p));
    expect(out.earningsExcessDollars).toBe(10_000);
    expect(out.additionalTaxBaseDollars).toBe(10_000);
  });

  it('with no profile the whole ordered draw runs the Roth-IRA path (earlier shape preserved)', () => {
    const carrier = seedMcAggregateRothBasisCarrier([{ ownerId: OWNER, cents: 4_000 * 100 }]);
    const out = applyMcRothBasisOrdering(args(carrier));
    expect(out.earningsExcessDollars).toBe(6_000);
    expect(out.additionalTaxBaseDollars).toBe(6_000);
  });

  // The designated split is stateful: the pool's remaining basis decrements on every draw, capping its lifetime shelter at the recorded basis;
  // a stateless split would re-apply a frozen fraction to every withdrawal.
  it('decrements the designated pool basis across a multi-year withdrawal sequence', () => {
    const p = profile({
      iraShareOfOrderedPool: 0,
      designatedBasisCents: 10_000 * 100,
      designatedBalanceCents: 20_000 * 100,
    });
    const carrier = seedMcAggregateRothBasisCarrier([], p);
    const pool = seedMcDesignatedRothPool(p);
    const shelteredByYear: number[] = [];
    for (let year = 2030; year < 2034; year += 1) {
      const out = applyMcRothBasisOrdering(
        args(carrier, p, {
          pool,
          taxYear: year,
          designatedRothPoolBalanceDollars: 20_000,
        }),
      );
      shelteredByYear.push(10_000 - out.earningsExcessDollars);
    }
    expect(shelteredByYear[0]).toBeCloseTo(5_000, 6);
    for (let i = 1; i < shelteredByYear.length; i += 1) {
      expect(shelteredByYear[i]).toBeLessThan(shelteredByYear[i - 1]);
    }
    const lifetime = shelteredByYear.reduce((sum, v) => sum + v, 0);
    expect(lifetime).toBeLessThanOrEqual(10_000);
    expect(pool!.entry.designatedRothBasisRemainingCents).toBeCloseTo(
      (10_000 - lifetime) * 100,
      6,
    );
  });

  // The MC designated profile carries in-plan rollover lots, so taxable rollover principal withdrawn inside its own five-tax-year §402A(c)(4)(D) window is recaptured on an MC path too.
  it('recaptures in-window taxable in-plan rollover principal on the pooled designated slice', () => {
    const inWindow = profile({
      iraShareOfOrderedPool: 0,
      designatedBasisCents: 10_000 * 100,
      designatedBalanceCents: 10_000 * 100,
      designatedFirstParticipationTaxYear: 2010, // five-year clock satisfied
      designatedInPlanRolloverLots: [
        { taxYear: 2028, taxableCents: 10_000 * 100, nontaxableCents: 0 },
      ],
    });
    const carrier = seedMcAggregateRothBasisCarrier([], inWindow);
    const out = applyMcRothBasisOrdering(
      args(carrier, inWindow, { designatedRothPoolBalanceDollars: 10_000 }),
    );
    expect(out.earningsExcessDollars).toBe(0);
    expect(out.additionalTaxBaseDollars).toBe(10_000);

    const outOfWindow = profile({
      ...inWindow,
      designatedInPlanRolloverLots: [
        { taxYear: 2020, taxableCents: 10_000 * 100, nontaxableCents: 0 },
      ],
    });
    const laterOut = applyMcRothBasisOrdering(
      args(seedMcAggregateRothBasisCarrier([], outOfWindow), outOfWindow, {
        designatedRothPoolBalanceDollars: 10_000,
      }),
    );
    expect(laterOut.additionalTaxBaseDollars).toBe(0);
  });

  // §408A's five-year period and the age-59½ event are per individual while the MC bucket pools both spouses' Roth dollars, so the pooled tests must be the ones no owner can beat.
  it('keeps the pooled Roth-IRA five-year clock and 59½ test per-owner-conservative', () => {
    const OLDER = 'primary';
    const YOUNGER = 'secondary';
    const twoOwnerCtx = (over: Partial<McRothOrderedProfile>): McTaxContext =>
      ({
        taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
        filingStatus: 'MFJ',
        members: [
          { memberId: OLDER, isoBirthdate: '1960-01-15', onMedicare: false, hasAcaCoverage: false },
          { memberId: YOUNGER, isoBirthdate: '1985-01-15', onMedicare: false, hasAcaCoverage: false },
        ],
        householdSize: 2,
        inflationRatePct: 0,
        rothOrderedProfile: profile({
          iraFirstContributionTaxYear: 2000,
          rothOwnerIds: [OLDER, YOUNGER],
          ...over,
        }),
      }) as unknown as McTaxContext;
    const carrier = seedMcAggregateRothBasisCarrier([]);
    const out = applyMcRothBasisOrdering({
      ...(args(carrier, profile({ iraFirstContributionTaxYear: 2000 })) as unknown as Record<
        string,
        unknown
      >),
      taxCtx: twoOwnerCtx({}),
    } as unknown as Parameters<typeof applyMcRothBasisOrdering>[0]);
    expect(out.earningsExcessDollars).toBe(10_000);
    expect(out.additionalTaxBaseDollars).toBe(10_000);
  });
});

describe('MC month-aware health coverage', () => {
  const HEALTH_MEMBER: TaxMemberInput = {
    memberId: 'primary',
    isoBirthdate: '1960-03-01',
    onMedicare: false,
    hasAcaCoverage: false,
  };

  it('resolves a whole Medicare year once the member is past 65', () => {
    const flags = memberFlags(HEALTH_MEMBER, 2030, 2026);
    expect(flags.onMedicare).toBe(true);
    expect(flags.partBEnrollmentMonths).toBe(12);
    expect(flags.partDEnrollmentMonths).toBe(12);
    expect(flags.marketplaceCoverageMonths).toBe(0);
  });

  it('overlays the stored Part B / Part D / Marketplace months for the year', () => {
    const healthCoverageMonths = {
      perMember: { primary: { 2024: { partBMonths: 7, partDMonths: 0, marketplaceMonths: 5 } } },
    };
    const flags = memberFlags(HEALTH_MEMBER, 2024, 2024, new Set(), healthCoverageMonths);
    expect(flags.partBEnrollmentMonths).toBe(7);
    expect(flags.partDEnrollmentMonths).toBe(0);
    expect(flags.marketplaceCoverageMonths).toBe(5);
    const other = memberFlags(HEALTH_MEMBER, 2026, 2024, new Set(), healthCoverageMonths);
    expect(other.partBEnrollmentMonths).toBe(12);
  });

  it('resolves an impossible birthdate identically through deriveMcSurvivors', () => {
    const taxCtx = {
      taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
      filingStatus: 'Single',
      members: [{ ...HEALTH_MEMBER, isoBirthdate: '1961-99-99' }],
      householdSize: 1,
      inflationRatePct: 0,
    } as unknown as McTaxContext;
    const state = deriveMcSurvivors(taxCtx, 2030, 2024);
    expect(state?.survivors[0].partBEnrollmentMonths).toBe(0);
    expect(state?.survivors[0].marketplaceCoverageMonths).toBe(0);
    expect(state?.survivors[0].onMedicare).toBe(false);
  });

  it('threads the coverage months through deriveMcSurvivors so both engines see the same year', () => {
    const taxCtx = {
      taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
      filingStatus: 'Single',
      members: [{ ...HEALTH_MEMBER, isoBirthdate: '1960-07-15' }],
      householdSize: 1,
      inflationRatePct: 0,
      healthCoverageMonths: {
        perMember: { primary: { 2025: { partBMonths: 7, partDMonths: 7, marketplaceMonths: 5 } } },
      },
    } as unknown as McTaxContext;
    const state = deriveMcSurvivors(taxCtx, 2025, 2024);
    expect(state?.survivors[0].partBEnrollmentMonths).toBe(7);
    expect(state?.survivors[0].marketplaceCoverageMonths).toBe(5);
    const wholeYear = deriveMcSurvivors(
      { ...taxCtx, healthCoverageMonths: undefined } as unknown as McTaxContext,
      2030,
      2024,
    );
    expect(state!.survivors[0].partBEnrollmentMonths!).toBeLessThan(
      wholeYear!.survivors[0].partBEnrollmentMonths!,
    );
    expect(defaultHouseholdSlcspByAge(state!.survivors, 2025)).toBeLessThan(
      defaultHouseholdSlcspByAge(
        [{ ...state!.survivors[0], marketplaceCoverageMonths: 12, partBEnrollmentMonths: 0, partDEnrollmentMonths: 0 }],
        2025,
      ),
    );
  });

  // `deriveMcSurvivors` gates each member's automatic Marketplace months on that member's own retirement year; the end-to-end parity proof lives in `balance-projection-runner-tax-helpers.test.ts`.
  describe('per-member retirement year (staggered households)', () => {
    const staggeredCtx = (
      retirementYearByMember?: readonly { memberId: string; retirementYear: number }[],
    ) =>
      ({
        taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
        filingStatus: 'MFJ',
        members: [
          // Both are pre-65 in 2028, so retirement is the only thing that can turn Marketplace coverage on.
          { memberId: 'primary', isoBirthdate: '1970-03-15', onMedicare: false, hasAcaCoverage: false },
          { memberId: 'secondary', isoBirthdate: '1972-03-15', onMedicare: false, hasAcaCoverage: false },
        ],
        householdSize: 2,
        inflationRatePct: 0,
        ...(retirementYearByMember !== undefined ? { retirementYearByMember } : {}),
      }) as unknown as McTaxContext;

    it('keeps a still-working spouse off the Marketplace while the primary is retired', () => {
      const state = deriveMcSurvivors(
        staggeredCtx([
          { memberId: 'primary', retirementYear: 2026 },
          { memberId: 'secondary', retirementYear: 2032 },
        ]),
        2028,
        2026,
      );
      expect(state?.survivors[0].marketplaceCoverageMonths).toBe(12);
      expect(state?.survivors[1].marketplaceCoverageMonths).toBe(0);
      expect(state?.survivors[1].hasAcaCoverage).toBe(false);
    });

    it('falls back to the household scalar for every member when the table is absent', () => {
      const state = deriveMcSurvivors(staggeredCtx(), 2028, 2026);
      expect(state?.survivors[0].marketplaceCoverageMonths).toBe(12);
      expect(state?.survivors[1].marketplaceCoverageMonths).toBe(12);
    });

    it('falls back for a member the table does not list, and ignores a non-finite year', () => {
      const partial = deriveMcSurvivors(
        staggeredCtx([{ memberId: 'primary', retirementYear: 2032 }]),
        2028,
        2026,
      );
      expect(partial?.survivors[0].marketplaceCoverageMonths).toBe(0);
      expect(partial?.survivors[1].marketplaceCoverageMonths).toBe(12);
      const corrupt = deriveMcSurvivors(
        staggeredCtx([{ memberId: 'secondary', retirementYear: Number.NaN }]),
        2028,
        2026,
      );
      expect(corrupt?.survivors[1].marketplaceCoverageMonths).toBe(12);
    });
  });
});

// The demo parity fixture is inert for month-aware health coverage; this case sits in the sensitive band: a single filer crossing ACA to Medicare mid-year, a look-back MAGI above IRMAA tier 1
// and a current-year ACA MAGI inside 100-400% FPL, so both engines contribute non-zero figures that must agree.
describe('integrated ACA→Medicare transition year (both engines)', () => {
  const TAX_YEAR = 2026;
  const BIRTHDATE = '1961-07-15';

  const memberSeed: TaxMemberInput = {
    memberId: 'primary',
    isoBirthdate: BIRTHDATE,
    onMedicare: false,
    hasAcaCoverage: false,
  };

  const yearInput = (members: readonly TaxMemberInput[]) => ({
    taxYear: TAX_YEAR,
    filingStatus: 'Single' as const,
    members,
    accounts: [],
    householdSize: 1,
    grossSsDollars: 0,
    // Inside 100-400% FPL for a single filer in 2026 ($62,600 at 400%), so the sliding scale, not the cliff, applies.
    preTaxWithdrawalDollars: 50_000,
    postTaxNonRothWithdrawalDollars: 0,
    postTaxCashLikeWithdrawalDollars: 0,
    rothWithdrawalDollars: 0,
    otherOrdinaryIncomeDollars: 0,
    taxExemptInterestDollars: 0,
    magiTwoYearsPriorDollars: 200_000,
    inflationRatePct: 0,
    taxpayersAge65Plus: 1,
  });

  const detMembers = buildMemberInputs(
    makeCtx({ primaryBirthdate: BIRTHDATE, primaryRetirementYear: 2024 }),
    TAX_YEAR,
    true,
    false,
  );
  const mcMembers = [memberFlags(memberSeed, TAX_YEAR, 2024)];

  it('resolves the same 6/6 month split on both engines', () => {
    expect(detMembers[0].partBEnrollmentMonths).toBe(6);
    expect(detMembers[0].marketplaceCoverageMonths).toBe(6);
    expect(mcMembers[0].partBEnrollmentMonths).toBe(detMembers[0].partBEnrollmentMonths);
    expect(mcMembers[0].marketplaceCoverageMonths).toBe(
      detMembers[0].marketplaceCoverageMonths,
    );
  });

  it('charges a NON-ZERO, half-year-prorated IRMAA surcharge on both engines', () => {
    const det = applyTaxYear(yearInput(detMembers), REAL_BUNDLE);
    const mc = applyTaxYear(yearInput(mcMembers), REAL_BUNDLE);
    expect(det.irmaaSurchargeCents).toBeGreaterThan(0);
    expect(det.irmaaSurchargeCents).toBe(mc.irmaaSurchargeCents);
    const wholeYear = applyTaxYear(
      yearInput([
        { ...detMembers[0], partBEnrollmentMonths: 12, partDEnrollmentMonths: 12 },
      ]),
      REAL_BUNDLE,
    );
    expect(det.irmaaSurchargeCents).toBeLessThan(wholeYear.irmaaSurchargeCents);
    expect(det.irmaaSurchargeCents * 2).toBeCloseTo(wholeYear.irmaaSurchargeCents, -2);
  });

  it('credits a NON-ZERO premium tax credit summed over the six covered months', () => {
    const det = applyTaxYear(yearInput(detMembers), REAL_BUNDLE);
    const mc = applyTaxYear(yearInput(mcMembers), REAL_BUNDLE);
    expect(det.acaPtcSubsidyCents).toBeGreaterThan(0);
    expect(det.acaPtcTier).toBe('sliding');
    expect(det.acaPtcSubsidyCents).toBe(mc.acaPtcSubsidyCents);
    // Six covered months credit about half the whole-year credit; without proration the full annual contribution would be subtracted from the half-year benchmark and floor it to a fraction.
    const wholeYear = applyTaxYear(
      yearInput([
        {
          ...detMembers[0],
          partBEnrollmentMonths: 0,
          partDEnrollmentMonths: 0,
          marketplaceCoverageMonths: 12,
        },
      ]),
      REAL_BUNDLE,
    );
    expect(det.acaPtcSubsidyCents * 2).toBeCloseTo(wholeYear.acaPtcSubsidyCents, -2);
  });

  it('attributes the surcharge to the beneficiary who owes it', () => {
    const det = applyTaxYear(yearInput(detMembers), REAL_BUNDLE);
    expect(det.irmaaSurchargeCentsByMember).toEqual([
      { memberId: 'member-primary', surchargeCents: det.irmaaSurchargeCents },
    ]);
  });
});
