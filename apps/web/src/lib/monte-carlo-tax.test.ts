/**
 * Tests for the Monte Carlo per-year tax estimator (`monte-carlo-tax.ts`).
 *
 * `applyPerYearTaxForPath` must recompute filing status, household
 * size, and the age-65 taxpayer count each year from per-year alive-state
 * derived from `primaryDeathYear` / `secondaryDeathYear`. A survivor
 * year does not receive MFJ filing + two-member IRMAA.
 */
import { describe, expect, it } from 'vitest';
import {
  advanceAfterTaxBase,
  advanceMcTaxableIncomeState,
  applyPerYearTaxForPath,
  buildKernelWholePortfolioPreTaxByOwner,
  buildPreTaxCentsByOwnerIdx,
  buildPriorPreTaxByOwnerFromIdx,
  buildYearClassification,
  buildYearMemberFlags,
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

describe('applyPerYearTaxForPath — per-year alive-state', () => {
  it('survivor year (secondary deceased) → no tax math attempted with full MFJ context', () => {
    // Primary born 1960 alive through 2055 (age 95). Secondary born 1962
    // dies in projected 2047 (age 85). Tax year 2050: only primary alive.
    const ctx = makeMfjTaxContext({
      primaryDeathYear: 2055,
      secondaryDeathYear: 2047,
    });
    // Same expense, same income — only the alive-state differs from year-1.
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
    // Compare to the same year with BOTH alive (no death years set):
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
    // Single filing → much higher tax than MFJ on the same gross.
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
    // Both members born 1960 (age 65 in 2025). Secondary dies 2030.
    // Year 2035: primary age 75 → 1 age-65+ taxpayer (was 2 when both alive).
    const ctx = makeMfjTaxContext({
      members: [
        { memberId: 'primary', isoBirthdate: '1960-01-01', onMedicare: false, hasAcaCoverage: false },
        { memberId: 'secondary', isoBirthdate: '1960-01-01', onMedicare: false, hasAcaCoverage: false },
      ],
      primaryDeathYear: 2055,
      secondaryDeathYear: 2030,
    });
    // Year 2035 — survivor. The federal-tax engine reads age-65+ count
    // for the standard-deduction add-on; with 1 survivor that's exactly 1.
    // The recompute should NOT use the original 2-member count.
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
    // The Single filing standard deduction with one age-65 add-on
    // is significantly higher than MFJ-on-same-income but lower than
    // MFJ-with-two-age-65-add-ons; the assertion below is just smoke —
    // value is positive, finite.
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

  // An INHERITED Roth IRA is wholesale tax-free: its dollars carry no basis
  // state and must leave the ordered pool BEFORE the carrier is touched.
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
    // Wholesale dollars never reach the §408A carrier, so they carry no
    // penalty-exempt accumulation on the ordered leg either.
    expect(cls.rothOrderedPenaltyExemptDollars).toBe(0);
  });

  // The scope is exactly `RETIREMENT_ROTH_IRA` AND inherited — an inherited
  // designated-Roth employer plan keeps its existing §402A treatment.
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
    // … but §72(t)(2)(A)(ii) still waives the 10% on the whole draw: the ordered
    // dollars stay in the pool for the §402A split while carrying full
    // penalty-exempt provenance (the deterministic twin's
    // `inheritedFromDeceasedOwner` short-circuit).
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
    // 80/20 pre/post balance split. $10k withdrawal → $8k pre-tax + $2k Roth-ordered.
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
    // When both pre + post balance are 0, ratio is undefined → whole draw = preTax.
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
    // RETIREMENT_IRA is not a Roth-designated type — post stays non-Roth.
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
  // Pre-RMD member (born 1990 → age 60 in 2050) so the RMD-floor gross-up
  // is inert and these routing assertions isolate the per-account
  // classification effect (Roth → $0 taxable income). At RMD age the synthetic
  // floor would force taxable income on a Roth draw — covered separately in the
  // "RMD-floor grossing" block below.
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
  // One retired single filer, 2026: $31,300 of Social Security, a $7,200
  // benchmark, a Roth draw (no income). ACA MAGI is 200.0% of the poverty
  // guideline, so the credit is $5,134.20 and there is no tax to offset.
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
    // The tax need keeps its zero floor; the cashflow is that need less the line.
    expect(result.taxCashflowDollars).toBeCloseTo(-5_134.2, 2);
  });

  it('is capped by the draw and by the Medical expenses', () => {
    // Draw: 26,796 + 7,200 − 31,300 = 2,696.
    expect(run(33_996, 7_200).acaCreditAppliedToPremiums).toBeCloseTo(2_696, 2);
    expect(run(33_996, 7_200).taxCashflowDollars).toBeCloseTo(-2_696, 2);
    // Medical: 3,000 against a 11,700 draw.
    expect(run(43_000, 3_000).acaCreditAppliedToPremiums).toBeCloseTo(3_000, 2);
    // A year Social Security already covers has no draw to lower.
    expect(run(30_000, 7_200).acaCreditAppliedToPremiums).toBe(0);
  });

  it('without the Medical expenses nothing is applied and the zero floor holds', () => {
    const result = run(71_208);
    expect(result.acaCreditAppliedToPremiums).toBe(0);
    expect(result.taxCashflowDollars).toBe(0);
    expect(result.ptc).toBeCloseTo(5_134.2, 2);
  });

  it('keeps a negative cumulative draw from adding balance back to the RMD base', () => {
    // The credit outran the tax so far (cumulative draw below zero): the
    // after-tax base is the raw balance, as `applyAfterTaxAdjustment` leaves it.
    expect(advanceAfterTaxBase({ base: 0, depleted: false }, 500_000, -5_000)).toEqual({
      base: 500_000,
      depleted: false,
    });
  });
});

describe('applyPerYearTaxForPath — per-owner RMD-floor grossing', () => {
  /** Single-member context; member born `birthYear-01-01`. */
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

  // Common args: tiny net drawdown (well below any RMD floor on a $1.5M pre-tax
  // base). The floor derives from `priorPreTaxByOwner` (per-owner
  // pre-tax cents), NOT the whole-portfolio `priorBalance`.
  const subFloorArgs = {
    taxYear: 2024,
    retirementYear: 2020,
    grossSsDollars: 0,
    nominalExpense: 8_000,
    otherIncome: 0,
    priorBalance: 1_500_000,
    // $1.5M pre-tax owned by the primary → age-73 floor ≈ $56,600 (÷26.5).
    priorPreTaxByOwner: new Map<string, number>([['primary', 1_500_000_00]]),
    magiMinus2: undefined,
  } as const;

  it('RMD-age path with a sub-floor pre-tax draw grosses fedTax up to the floor', () => {
    // Born 1951 → age 73 in 2024 → RMD applies. The $8,000 draw is far below
    // the ~$56,600 floor, so taxable income is forced up to the floor.
    const grossed = applyPerYearTaxForPath({ taxCtx: singleMemberCtx(1951), ...subFloorArgs });
    // Under-age control: born 1971 (age 53) → no RMD → taxed on the $8,000 draw.
    const underAge = applyPerYearTaxForPath({ taxCtx: singleMemberCtx(1971), ...subFloorArgs });

    expect(grossed).not.toBeNull();
    expect(underAge).not.toBeNull();
    // $56k+ of ordinary income produces federal tax; $8k (under the standard
    // deduction) produces $0 — so the grossed path owes strictly more.
    expect(grossed!.fedTax).toBeGreaterThan(0);
    expect(grossed!.fedTax).toBeGreaterThan(underAge!.fedTax);
    expect(grossed!.taxCashflowDollars).toBeGreaterThan(0);
  });

  it('under-age path is unchanged (no floor applied below the trigger age)', () => {
    // Born 1971 — far below the trigger age. Taxable income is the actual
    // $8,000 draw; an $8k single filer is under the standard deduction → $0.
    const result = applyPerYearTaxForPath({ taxCtx: singleMemberCtx(1971), ...subFloorArgs });
    expect(result).not.toBeNull();
    expect(result!.fedTax).toBe(0);
    expect(result!.taxCashflowDollars).toBe(0);
  });

  it('all-Roth/all-taxable RMD-age path has a $0 floor (no phantom RMD income)', () => {
    // RMD-age member (born 1951) but the prior portfolio carries NO pre-tax
    // sub-bucket (empty `priorPreTaxByOwner` — Roth-heavy / all-taxable). The
    // legacy whole-portfolio synthetic floor would have grossed the $1.5M to a
    // ~$56k floor; the per-owner floor correctly returns $0, so the $8k draw is
    // taxed as-is (under the standard deduction → $0).
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
    // Primary born 1971 (age 53 in 2024 → pre-RMD); secondary born 1951
    // (age 73 → RMD applies). The pre-tax is owned by the secondary, so the
    // floor fires on the secondary's age.
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
    // Control: same couple but the secondary is ALSO pre-RMD (born 1971) → no
    // member is RMD-age → floor is $0 → taxed on the actual $8,000 draw.
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
    // With the secondary RMD-age the floor forces taxable income up, producing
    // positive federal tax and a ~$56.6k MAGI. The no-floor control owes less.
    expect(grossed!.fedTax).toBeGreaterThan(0);
    expect(grossed!.fedTax).toBeGreaterThan(noFloor!.fedTax);
    expect(grossed!.magiDollars).toBeGreaterThan(50_000);
  });

  it('couple floor SUMS each owner\'s own per-owner floor (not max over a shared pool)', () => {
    // BOTH members RMD-age, EACH owning their OWN $1.5M pre-tax sub-bucket
    // (tax year 2024):
    //   primary  born 1951 → age 73 → divisor 26.5 → floor ≈ $56,604
    //   secondary born 1945 → age 79 → divisor 21.1 → floor ≈ $71,090
    // The per-owner floor SUMS them (each owner's RMD applies to their own
    // accounts) — NOT a max over a shared pool. With a large enough draw to keep
    // SS untaxed out of scope, the couple's grossed income == primaryFloor +
    // secondaryFloor.
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
    // Reference floors: each owner's floor in isolation (same couple ctx so the
    // standard deduction / age-65 add-ons match — only the owned pre-tax differs).
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
    // The two owners produce DISTINCT floors (older = larger).
    expect(secondaryOnly!.magiDollars).toBeGreaterThan(primaryOnly!.magiDollars);
    // SUM (not max): the couple's grossed income ≈ each owner's floor combined,
    // strictly more than the larger single owner's floor.
    expect(couple!.magiDollars).toBeGreaterThan(secondaryOnly!.magiDollars);
    expect(couple!.magiDollars).toBeCloseTo(
      primaryOnly!.magiDollars + secondaryOnly!.magiDollars,
      6,
    );
    expect(couple!.fedTax).toBeGreaterThan(0);
  });

  it('draw already at/above the floor leaves the floor inert (taxed on the actual draw)', () => {
    // Born 1951 (RMD age) but a large expense → net drawdown far exceeds the
    // floor, so max(draw, floor) === draw and the floor adds nothing. Compare
    // the same RMD-age member with a LARGE pre-tax base (large floor) vs a TINY
    // pre-tax base (floor ≈ 0): both clear the floor with the $200k draw, so the
    // federal tax is identical.
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
  // Single pre-59½ member (born 1990 → age 35 in 2025) so the §408A earnings
  // tranche above remaining basis is hit with the 10% pre-59½ penalty AND the
  // RMD-floor gross-up stays inert (no RMD at age 35). The whole year's
  // net drawdown is a Roth withdrawal so the only tax/penalty in play is the
  // Roth earnings split — isolating the carrier behaviour.
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

  // $20k net Roth drawdown for the year (expense $20k, no SS / other income).
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
    // Carrier seeded (under the aggregate key) with only $10k basis → $20k
    // draw consumes $10k basis, leaving $10k of earnings excess: taxed as
    // ordinary income + the 10% pre-59½ penalty, both funded into the tax
    // cashflow.
    const partialBasis = seedRothBasisCarrier(new Map([[MC_AGGREGATE_ROTH_OWNER_KEY, 10_000 * 100]]));
    const withExcess = applyPerYearTaxForPath({
      ...baseArgs,
      taxCtx: ctx(),
      rothBasisCarrier: partialBasis,
    });
    expect(withExcess).not.toBeNull();
    // $10k earnings excess is ordinary income → non-zero federal tax + a 10%
    // ($1,000) pre-59½ penalty, so the funded tax cashflow is strictly positive.
    expect(withExcess!.taxCashflowDollars).toBeGreaterThan(0);
    // The carrier was mutated in place: $10k basis fully consumed (0 remaining),
    // $20k cumulative withdrawn.
    const entry = partialBasis.get(MC_AGGREGATE_ROTH_OWNER_KEY)!;
    expect(entry.rothBasisRemainingCents).toBe(0);
    expect(entry.rothCumulativeWithdrawnCents).toBe(20_000 * 100);
  });

  it('full Roth basis coverage → no penalty, zero tax cashflow', () => {
    // Carrier seeded (under the aggregate key) with $50k basis fully covers
    // the $20k draw → $0 earnings excess → no ordinary income, no penalty, so the
    // tax cashflow is zero.
    const fullBasis = seedRothBasisCarrier(new Map([[MC_AGGREGATE_ROTH_OWNER_KEY, 50_000 * 100]]));
    const noExcess = applyPerYearTaxForPath({
      ...baseArgs,
      taxCtx: ctx(),
      rothBasisCarrier: fullBasis,
    });
    expect(noExcess).not.toBeNull();
    expect(noExcess!.fedTax).toBe(0);
    expect(noExcess!.taxCashflowDollars).toBe(0);
    // Carrier mutated: $20k basis consumed, $30k remaining, $20k cumulative.
    const entry = fullBasis.get(MC_AGGREGATE_ROTH_OWNER_KEY)!;
    expect(entry.rothBasisRemainingCents).toBe(30_000 * 100);
    expect(entry.rothCumulativeWithdrawnCents).toBe(20_000 * 100);
  });

  it('no carrier supplied → Roth draw funds zero tax (backward-compat skip)', () => {
    // Omitting the carrier (no taxContext basis) leaves the path with no Roth
    // ordering: the whole Roth draw is tax-free.
    const noCarrier = applyPerYearTaxForPath({ ...baseArgs, taxCtx: ctx() });
    expect(noCarrier).not.toBeNull();
    expect(noCarrier!.fedTax).toBe(0);
    expect(noCarrier!.taxCashflowDollars).toBe(0);
  });

  it('a SECONDARY owner\'s Roth basis is consumed, not stranded', () => {
    // Two owners each hold $10k §408A basis (primary + secondary). A carrier
    // seeded per-owner but consumed only under the primary key would strand the
    // secondary's $10k basis, so a $20k Roth draw would see only $10k
    // shielded ($10k earnings → taxed + penalized). The aggregate key sums
    // both owners' basis ($20k) into one carrier entry, so the full $20k draw is
    // shielded → $0 earnings excess → $0 tax cashflow.
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
    // Full $20k household basis shields the $20k draw → no earnings, no tax.
    expect(result!.fedTax).toBe(0);
    expect(result!.taxCashflowDollars).toBe(0);
    // The aggregate entry consumed the whole $20k summed basis.
    const entry = carrier.get(MC_AGGREGATE_ROTH_OWNER_KEY)!;
    expect(entry.rothBasisRemainingCents).toBe(0);
    expect(entry.rothCumulativeWithdrawnCents).toBe(20_000 * 100);
  });
});

describe('creditMcConversionToBasisCarrier — Fill conversion → §408A basis', () => {
  // Single pre-59½ member (born 1990 → age 35 in 2025) so a Roth earnings
  // tranche above remaining basis would be taxed as ordinary income + the 10%
  // pre-59½ penalty. Isolates the converted-principal-as-basis behaviour: a
  // later-year Roth withdrawal beyond the SEEDED basis but within
  // (seeded + converted) must be treated as tax/penalty-free basis (mirrors the
  // deterministic `creditRothConversionToBasisCarrier`), not re-taxed earnings.
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

  // $20k net Roth drawdown each year (expense $20k, no SS / other income).
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
    // Seed only $20k §408A basis. Year 1: $20k Roth draw consumes it all (0 left).
    // Year 1 ALSO converts $30k pre-tax → target Roth (taxed as ordinary income
    // that year by the engine). Year 2: a $20k Roth draw exceeds the seeded basis
    // (now 0) but is within the $30k converted principal → fully basis-shielded.
    const carrier = seedMcAggregateRothBasisCarrier(new Map([[ownerId, 20_000 * 100]]));

    // Year 1 withdrawal (consumes the seeded $20k basis).
    const y1 = applyPerYearTaxForPath({ ...yearArgs(2025), taxCtx: ctx(), rothBasisCarrier: carrier });
    expect(y1).not.toBeNull();
    expect(y1!.taxCashflowDollars).toBe(0); // fully covered by seeded basis
    expect(carrier.get(MC_AGGREGATE_ROTH_OWNER_KEY)!.rothBasisRemainingCents).toBe(0);

    // Year-END: credit the year's $30k converted principal (the fix). MUST run
    // AFTER the same-year ordering above — converted dollars are basis only for
    // LATER years.
    creditMcConversionToBasisCarrier(carrier, 30_000 * 100);
    expect(carrier.get(MC_AGGREGATE_ROTH_OWNER_KEY)!.rothBasisRemainingCents).toBe(30_000 * 100);

    // Year 2 withdrawal: $20k Roth draw, seeded basis exhausted, but covered by
    // the credited converted principal → $0 earnings excess → $0 tax/penalty.
    const y2 = applyPerYearTaxForPath({ ...yearArgs(2026), taxCtx: ctx(), rothBasisCarrier: carrier });
    expect(y2).not.toBeNull();
    expect(y2!.fedTax).toBe(0); // earningsExcess = 0 → no ordinary income
    expect(y2!.taxCashflowDollars).toBe(0); // no penalty (basis, not earnings)
    expect(carrier.get(MC_AGGREGATE_ROTH_OWNER_KEY)!.rothBasisRemainingCents).toBe(10_000 * 100);
  });

  it('WITHOUT the credit the same later-year withdrawal is re-taxed as earnings + penalty (pins the pre-fix bug)', () => {
    // Identical setup, but DO NOT credit the converted principal. The year-2 draw
    // then sees 0 remaining basis → the full $20k is earnings → ordinary income +
    // a 10% ($2k) pre-59½ penalty: the double-taxation the fix removes.
    const carrier = seedMcAggregateRothBasisCarrier(new Map([[ownerId, 20_000 * 100]]));
    applyPerYearTaxForPath({ ...yearArgs(2025), taxCtx: ctx(), rothBasisCarrier: carrier });
    // (no creditMcConversionToBasisCarrier call here)
    const y2 = applyPerYearTaxForPath({ ...yearArgs(2026), taxCtx: ctx(), rothBasisCarrier: carrier });
    expect(y2).not.toBeNull();
    expect(y2!.fedTax).toBeGreaterThan(0); // $20k earnings taxed as ordinary income
    expect(y2!.taxCashflowDollars).toBeGreaterThan(0); // + the 10% pre-59½ penalty
  });

  it('crediting BEFORE same-year ordering would wrongly shield the same year (guards call ordering)', () => {
    // Demonstrates WHY the credit must land at year-END: if a year's converted
    // principal were credited before that same year's Roth ordering, the year's
    // own withdrawal would be wrongly shielded. Seed $0 basis, convert $30k, then
    // withdraw $20k in the SAME year. Correct (credit after) → $20k earnings taxed.
    const carrier = seedMcAggregateRothBasisCarrier(new Map([[ownerId, 0]]));
    const sameYear = applyPerYearTaxForPath({ ...yearArgs(2025), taxCtx: ctx(), rothBasisCarrier: carrier });
    creditMcConversionToBasisCarrier(carrier, 30_000 * 100); // year-END, after ordering
    expect(sameYear).not.toBeNull();
    // The same-year draw saw 0 basis → fully earnings → taxed + penalized.
    expect(sameYear!.taxCashflowDollars).toBeGreaterThan(0);
    // The converted principal is now available for NEXT year only.
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
  // Single pre-59½ member (born 1990 → age 35 in 2025) so the §72(t) 10% leg
  // is fully in force on a pre-tax draw, and the RMD-floor gross-up stays
  // inert (no RMD at age 35). A pre-tax-only draw isolates the §72(t) leg.
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
    // The $40k pre-tax draw at age 35 carries a 10% ($4,000) §72(t) penalty when
    // not exempt; the exempt path waives exactly that penalty leg.
    expect(notExempt!.taxCashflowDollars - exempt!.taxCashflowDollars).toBeCloseTo(4_000, 6);
    // Income tax (federal) is identical — only the penalty leg changed.
    expect(exempt!.fedTax).toBeCloseTo(notExempt!.fedTax, 6);
  });

  it('Roth-earnings leg exempt → 10% penalty waived, ordinary income tax unchanged', () => {
    // $20k Roth draw, only $10k basis → $10k earnings excess: ordinary income +
    // a 10% ($1,000) pre-59½ penalty. The exempt path waives only the penalty.
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
    // Penalty waived: the $1,000 10% leg disappears from the funded cashflow.
    expect(notExempt!.taxCashflowDollars - exempt!.taxCashflowDollars).toBeCloseTo(1_000, 6);
    // The ordinary-income tax on the $10k earnings tranche is unaffected.
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
    // Pass-2 expenses include the estimated tax draw, so the portfolio is
    // drained faster → success cannot exceed the no-tax run.
    expect(taxed.successProbability).toBeLessThanOrEqual(noTax.successProbability);
    expect(mcParityBaselines.taxHeavy_successProbability_preFix).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// MC years 0–1 IRMAA via the threaded MAGI bootstrap
// ---------------------------------------------------------------------------
describe('applyPerYearTaxForPath — years 0–1 IRMAA bootstrap parity', () => {
  // Single Medicare member (born 1951 → age 75 in 2026 → on Medicare). The MC
  // ring delivers the bootstrap as `magiMinus2` for projection year 0.
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

  it('year 0 WITHOUT bootstrap (magiMinus2 undefined) charges $0 IRMAA (no-bootstrap deferral)', () => {
    const noBootstrap = applyPerYearTaxForPath({
      taxCtx: medicareCtx,
      ...yearArgs,
      magiMinus2: undefined, // ring stayed undefined → MC charges $0
    });
    expect(noBootstrap).not.toBeNull();
    expect(noBootstrap!.irmaa).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Windowed nominalExpense drives tax feedback
// ---------------------------------------------------------------------------
describe('applyPerYearTaxForPath — windowed nominalExpense drives tax feedback', () => {
  // Single member born 1955 → age 71 in 2026: ON Medicare (≥65) but PRE-RMD
  // (<73), so the synthetic RMD floor does NOT gross up MAGI and the year's
  // drawdown drives MAGI directly. A higher windowed `nominalExpense` (e.g. a
  // year inside a late-life LTC window, or a faster-growing Medical bucket)
  // raises the drawdown → taxable pre-tax income → federal tax, and lifts the
  // year's MAGI across the first Part B IRMAA tier.
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
    // Windowed nominal = 60_000 (below the Single tier-1 IRMAA MAGI threshold).
    // The fully-pre-tax classification makes the whole drawdown taxable so the
    // year's `nominalExpense` moves MAGI directly.
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
      // Medical-heavy / in-window nominal spend (≈ +60% vs low) — the
      // classification mirrors the larger drawdown.
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
    // The larger modeled spend funds more tax cashflow from the portfolio.
    expect(high!.taxCashflowDollars).toBeGreaterThan(low!.taxCashflowDollars);
  });

  it('the higher windowed nominalExpense lifts the year MAGI across the first Part B IRMAA tier (tolerance-free step)', () => {
    // Feed each year's resulting MAGI as the Y+2 IRMAA look-back. The low MAGI
    // stays below tier 1 (no surcharge); the high MAGI crosses it (a discrete
    // surcharge step appears).
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

// ---------------------------------------------------------------------------
// No-bootstrap parity-INTENT (documented, tested deferral)
// ---------------------------------------------------------------------------
describe('no-bootstrap deterministic-vs-MC IRMAA divergence (APPROVED DEFERRAL)', () => {
  it('deterministic engine estimates NON-zero IRMAA + flag while MC charges $0', async () => {
    // ONE shared no-bootstrap scenario: a single member on Medicare in
    // projection year 0 with high projected income and NO stored lookback.
    const { applyTaxIntegrationToDrawdownYears } = await import('./balance-projection-runner-tax');
    const { makeCtx, makeDrawdownYear, REAL_BUNDLE } = await import(
      './balance-projection-runner-tax-test-fixtures'
    );

    // --- Deterministic engine: non-zero estimated IRMAA + disclosure flag. ---
    const detYears = [makeDrawdownYear(2026, 300_000)];
    const detCtx = makeCtx({
      primaryBirthdate: '1951-01-01', // age 75 in 2026 → on Medicare
      primaryRetirementYear: 2026,
      // no stored bootstrap → the deterministic engine estimates the look-back MAGI from the projection
    });
    applyTaxIntegrationToDrawdownYears(detYears, [], [], [], detCtx, REAL_BUNDLE);
    expect(detYears[0].irmaaSurchargeCents).toBeGreaterThan(0);
    expect(detYears[0].magiEstimatedFromProjection).toBe(true);

    // --- MC kernel: ring minus2 undefined (no bootstrap) → $0 IRMAA year 0. ---
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

// ---------------------------------------------------------------------------
// Medical-cost inflation — MC-vs-deterministic fed-tax parity (≤2%)
// ---------------------------------------------------------------------------
describe('applyPerYearTaxForPath — AC-(i) MC fed-tax within ≤2% of the deterministic engine', () => {
  it('a bucketed-draw named-strategy year: |mcFed − detFed| / detFed ≤ 0.02', async () => {
    // Drive the SAME gross ordinary draw through BOTH engines and compare the
    // federal income tax. A "bucketed-draw named-strategy year" = the higher
    // (medical-heavy) nominal spend the bucketed override produces, drawn fully
    // pre-tax under a named (taxEfficient) strategy. Single member born 1990
    // (age 36 in 2026): pre-Medicare + pre-RMD, so no IRMAA / RMD-floor gross-up
    // — the year reduces to a plain federal-tax comparison on the gross draw.
    //
    // Tax year 2026 is the LATEST published federal-tax snapshot year, so
    // `resolveFederalTaxSnapshotForYear` does NOT extrapolate/scale on either
    // side (factor = 1, inflation-independent) — both engines index the
    // identical 2026 brackets + standard deduction. DEFAULT_TAX_CALIBRATION_BUNDLE
    // and the deterministic REAL_BUNDLE share the same FEDERAL_TAX_CONFIG.
    const { applyTaxIntegrationToDrawdownYears } = await import('./balance-projection-runner-tax');
    const { makeCtx, makeDrawdownYear, REAL_BUNDLE } = await import(
      './balance-projection-runner-tax-test-fixtures'
    );
    const TAX_YEAR = 2026;
    const GROSS = 130_000; // bucketed (medical-heavy) nominal annual draw

    // --- Deterministic engine: federalTaxCents on the gross pre-tax draw. ---
    const detYears = [makeDrawdownYear(TAX_YEAR, GROSS)];
    const detCtx = makeCtx({
      withdrawalStrategy: { kind: 'taxEfficient' },
      primaryBirthdate: '1990-06-15', // age 36 → pre-RMD, pre-Medicare
      primaryRetirementYear: TAX_YEAR,
    });
    applyTaxIntegrationToDrawdownYears(detYears, [], [], [], detCtx, REAL_BUNDLE);
    const detFed = (detYears[0].federalTaxCents ?? 0) / 100;
    expect(detFed).toBeGreaterThan(0);

    // --- MC per-year estimator: fedTax on the same fully-pre-tax gross. ---
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
    // MC fed tax tracks the deterministic engine to within ≤2%.
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

  // Cross-engine parity: the MC twin and the deterministic engine resolve
  // the SAME months for the same member/year, because both call the one shared
  // resolver.
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
      // Turning-65 year and the following whole year.
      { iso: '1960-07-15', taxYear: 2026, retirementYear: 2024 },
      // Stored Part B / D / Marketplace months overlay the automatic derivation.
      { iso: '1960-03-01', taxYear: 2024, retirementYear: 2024, stated: { partBMonths: 7, partDMonths: 0, marketplaceMonths: 5 } },
      // Clamp: stated Marketplace months cannot coexist with Medicare months.
      { iso: '1960-07-15', taxYear: 2025, retirementYear: 2024, stated: { partBMonths: 7, partDMonths: 7, marketplaceMonths: 12 } },
      // Empty / impossible birthdates charge no automatic months; stated Part B survives.
      { iso: '', taxYear: 2025, retirementYear: 2024 },
      { iso: '', taxYear: 2025, retirementYear: 2024, stated: { partBMonths: 6, marketplaceMonths: 12 } },
      { iso: '1961-99-99', taxYear: 2030, retirementYear: 2024 },
      { iso: '1961-13-15', taxYear: 2030, retirementYear: 2024 },
      { iso: '1961-02-30', taxYear: 2030, retirementYear: 2024 },
      { iso: '1961-02-29', taxYear: 2030, retirementYear: 2024 },
      // Malformed imported overrides read as nothing stated.
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
      const mc = buildYearMemberFlags(
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

// ---------------------------------------------------------------------------
// Born-Jan-1 age-65 boundary (Monte Carlo twin). The age-65 standard-
// deduction COUNT follows the born-Jan-1 rule (a Jan 1 birthday attains the age
// at the end of the prior year); the birthday-MONTH Medicare entitlement only
// affects the member's Medicare months (asserted in the buildYearMemberFlags
// block above), not this count.
// ---------------------------------------------------------------------------

describe('countTaxpayersAge65Plus — born-Jan-1 age-65 boundary', () => {
  const jan1_1960: TaxMemberInput = {
    memberId: 'jan1',
    isoBirthdate: '1960-01-01',
    onMedicare: false,
    hasAcaCoverage: false,
  };

  it('jan1_1960_counts_as_65plus_for_tax_year_2024', () => {
    // IRS born-Jan-1 rule: treated as reaching 65 on 2023-12-31 → qualifies for
    // tax year 2024 (one year earlier than the naive taxYear − birthYear = 64).
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
    const flags = buildYearMemberFlags(member, 2024, RET, new Set());
    expect(flags.hasAcaCoverage).toBe(true);
  });

  it('should_force_hasAcaCoverage_false_when_the_member_id_is_opted_out', () => {
    const flags = buildYearMemberFlags(member, 2024, RET, new Set(['m1']));
    expect(flags.hasAcaCoverage).toBe(false);
  });

  it('should_default_to_no_opt_out_when_the_set_arg_is_omitted (back-compat)', () => {
    const flags = buildYearMemberFlags(member, 2024, RET);
    expect(flags.hasAcaCoverage).toBe(true);
  });

  it('should_gate_on_member_id_not_a_boolean — only the named member is affected', () => {
    const other: TaxMemberInput = { ...member, memberId: 'm2' };
    const optedOut = new Set(['m1']);
    expect(buildYearMemberFlags(member, 2024, RET, optedOut).hasAcaCoverage).toBe(false);
    expect(buildYearMemberFlags(other, 2024, RET, optedOut).hasAcaCoverage).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-owner RMD floor (computeMcRmdFloorCents) replaces the whole-portfolio
// synthetic floor.
// ---------------------------------------------------------------------------
describe('computeMcRmdFloorCents — per-owner pre-tax RMD floor', () => {
  const RMD = DEFAULT_TAX_CALIBRATION_BUNDLE.rmd;
  const owner = (memberId: string, isoBirthdate: string): TaxMemberInput => ({
    memberId,
    isoBirthdate,
    onMedicare: false,
    hasAcaCoverage: false,
  });

  it('all-Roth household at RMD age → 0 (no pre-tax balance)', () => {
    // An RMD-age member but an EMPTY pre-tax map (Roth-heavy) → $0 floor.
    const survivors = [owner('m1', '1951-01-01')]; // age 73 in 2024
    expect(computeMcRmdFloorCents(new Map(), survivors, 2024, RMD)).toBe(0);
  });

  it('all-brokerage household at RMD age → 0 (no pre-tax balance)', () => {
    // Same as all-Roth from the floor's perspective: the brokerage carries no
    // pre-tax sub-bucket, so the per-owner map is empty → $0 floor.
    const survivors = [owner('m1', '1951-01-01')];
    expect(computeMcRmdFloorCents(new Map(), survivors, 2024, RMD)).toBe(0);
  });

  it('mixed IRA+Roth at RMD age → floor on the IRA pre-tax portion only', () => {
    // The map carries ONLY the traditional-IRA pre-tax cents (the Roth portion
    // never enters `priorPreTaxByOwner`). Age-73 divisor 26.5.
    const survivors = [owner('m1', '1951-01-01')];
    const floor = computeMcRmdFloorCents(
      new Map([['m1', 1_000_000_00]]),
      survivors,
      2024,
      RMD,
    );
    // ≈ $1,000,000 / 26.5 ≈ $37,736.
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

// ---------------------------------------------------------------------------
// Per-owner pre-tax map-builder (account-type filtering).
// ---------------------------------------------------------------------------
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
    // preEnd = pre-tax, postEnd = designated-Roth → only preEnd counts.
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

// ---------------------------------------------------------------------------
// No-ledger kernel fallback whole-portfolio floor (max over owners).
// ---------------------------------------------------------------------------
describe('buildKernelWholePortfolioPreTaxByOwner — kernel fallback', () => {
  const RMD = DEFAULT_TAX_CALIBRATION_BUNDLE.rmd;
  const owner = (memberId: string, isoBirthdate: string): TaxMemberInput => ({
    memberId,
    isoBirthdate,
    onMedicare: false,
    hasAcaCoverage: false,
  });

  it('assigns the whole balance to the OLDEST RMD-age owner (largest floor)', () => {
    // The no-ledger fallback reproduces the legacy MAX-over-survivors whole-pool
    // floor through the per-owner function: the whole $1.5M is assigned to one
    // owner, and the resulting floor equals the OLDER owner's floor (smallest
    // divisor) — NOT the sum.
    const survivors = [owner('m1', '1951-01-01'), owner('m2', '1945-01-01')];
    const map = buildKernelWholePortfolioPreTaxByOwner(survivors, 1_500_000, 2024, RMD);
    const floor = computeMcRmdFloorCents(map, survivors, 2024, RMD);
    // Reference: the whole $1.5M owned by the OLDER member alone.
    const olderFloor = computeMcRmdFloorCents(
      new Map([['m2', 1_500_000_00]]),
      survivors,
      2024,
      RMD,
    );
    expect(floor).toBe(olderFloor);
    // It is NOT the sum (a single-owner map, no double-count).
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

// ---------------------------------------------------------------------------
// QCD — per-path QCD floor offset + income exclusion.
// ---------------------------------------------------------------------------
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
    // A $20k QCD offsets the floor by exactly $20k (the offset ≤ gross).
    const offset20k = computeMcRmdFloorCents(
      basis,
      survivors,
      2024,
      RMD,
      new Map([['m1', 20_000_00]]),
    );
    expect(offset20k).toBe(gross - 20_000_00);
    // An offset ≥ gross zeroes the taxable floor (never negative).
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
    // Couple, BOTH RMD-age, each owning their own $1.5M pre-tax IRA pool. A QCD
    // by m1 offsets only m1's floor; m2's floor is untouched.
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
    // Total floor drops by exactly m1's $10k offset — m2's floor never moves.
    expect(m1Only).toBe(gross - 10_000_00);
  });

  it('a below-trigger owner has no floor to offset (70½–72 pre-RMD)', () => {
    // Born 1953 → age 71 in 2024: QCD-eligible (70½) but NOT yet RMD-age (73).
    // The owner has a $0 RMD floor, so an offset leaves it at 0 (never negative).
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

  it('IRA + 401k same owner: only the IRA-pool basis is offset', () => {
    // The MC RMD floor reads `priorPreTaxByOwner` (the per-owner pre-tax sum).
    // The QCD offset only ever reduces the IRA pool's contribution — modeled
    // here as the offset applying against the owner's floor. The 401k's pre-tax
    // dollars still enforce their own RMD: an offset capped at the IRA RMD never
    // erases the employer-plan floor. With the owner's whole pre-tax basis at
    // $1.5M and an offset BELOW the gross, the floor stays positive.
    const survivors = [member('m1', '1951-01-01')];
    const basis = new Map([['m1', 1_500_000_00]]);
    const gross = computeMcRmdFloorCents(basis, survivors, 2024, RMD);
    const offset = computeMcRmdFloorCents(
      basis,
      survivors,
      2024,
      RMD,
      new Map([['m1', 5_000_00]]),
    );
    expect(offset).toBe(gross - 5_000_00);
    expect(offset).toBeGreaterThan(0); // 401k RMD still enforced
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

  // An RMD-age member with a $200k pre-tax sub-bucket. The actual pre-tax draw
  // ($60k via classification) EXCEEDS the floor, so the exclusion (not the floor
  // offset) is what removes the QCD from income.
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
    // The QCD drops MAGI by exactly the gift (1×, never 2×) and lowers fed tax.
    expect(noQcd!.magiDollars - withQcd!.magiDollars).toBeCloseTo(20_000, 2);
    expect(withQcd!.fedTax).toBeLessThan(noQcd!.fedTax);
  });

  it('the floor offset alone (no exclusion) leaves a sub-floor draw correct', () => {
    // A small draw ($8k) below the floor: the offset shrinks the floor so the
    // gross-up no longer re-adds the QCD as phantom taxable income.
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
    // The offset + exclusion lower the grossed-up MAGI vs the no-QCD floor gross-up.
    expect(withOffset!.magiDollars).toBeLessThan(grossUp!.magiDollars);
  });
});

// ---------------------------------------------------------------------------
// Taxable income + engine parity (yield drag / evolving basis /
// cash-like interest / 457(b)-source-aware pooled penalty)
// ---------------------------------------------------------------------------

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
    // One brokerage (yield/basis), one CD (interest), one HSA (excluded — stays
    // tax-free), one pre-tax (excluded). The MC advance must return the SAME
    // numbers as running the deterministic helpers directly on the same rows.
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
    // CD interest = end + withdrawn − deposits − start = 103k + 1k − 0 − 100k.
    expect(mc.cashInterestDollars).toBe(4_000);
    // The two accumulators carry the same per-account basis forward.
    expect(mcState.basisByAccountId.get('brok')).toBe(detState.basisByAccountId.get('brok'));
    // HSA + pre-tax rows never enter either set (HSA stays tax-free).
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
    // MAGI delta = $20k yield (2% × $1M, QDI + ordinary) + $5k interest
    // + $10k extra LTCG (basis fraction 0.25 vs static 0.5 on the $40k draw).
    expect(withTaxableIncome!.magiDollars - withoutTaxableIncome!.magiDollars).toBeCloseTo(35_000, 6);
  });
});

describe('pooled penalty — 457(b) source exemption parity', () => {
  const youngCtx = (flags: Partial<McTaxContext>): McTaxContext => ({
    taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus: 'Single',
    members: [
      // Born 1980 → mid-40s in 2026: squarely pre-59½.
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
    // Mirrors the deterministic engine: a governmental 457(b) distribution
    // carries no 10% additional tax, so the pooled leg is waived when
    // `resolveMcPenaltyExemptions` resolved every pre-tax source as 457(b).
    const exempt = applyPerYearTaxForPath(drawArgs(youngCtx({ mcPreTaxPenaltyAllExempt: true })));
    const penalized = applyPerYearTaxForPath(drawArgs(youngCtx({})));
    expect(exempt).not.toBeNull();
    expect(penalized).not.toBeNull();
    // The waived leg is exactly the 10% × $50k pre-59½ penalty (the MC glue
    // funds the penalty via `taxCashflowDollars`, not `fedTax`).
    expect(penalized!.taxCashflowDollars - exempt!.taxCashflowDollars).toBeCloseTo(5_000, 6);
    // Ordinary income tax is unchanged by the waiver.
    expect(exempt!.fedTax).toBe(penalized!.fedTax);
  });
});

// ---------------------------------------------------------------------------
// Per-source pooled penalty split (mixed 457(b)+penalized pools).
// The classifier preserves withdrawal provenance into the penalty-exempt
// sub-buckets, and `computeMcPenaltyDollars` penalizes only the
// non-exempt-source portion — matching the deterministic per-account engine.
// ---------------------------------------------------------------------------
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
      // Born 1980 → mid-40s in 2026: squarely pre-59½ (full 10% penalty year).
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
    // $30k 457(b) + $20k IRA. The pooled flag stays false (mixed pool), but the
    // per-source split penalizes ONLY the $20k IRA share: 10% × $20k = $2,000 —
    // NOT 10% × $50k = $5,000 (an all-or-nothing pooled penalty).
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
    // Delta = the waived 457(b)-sourced penalty share: 10% × $30k = $3,000.
    expect(allIra!.taxCashflowDollars - mixed!.taxCashflowDollars).toBeCloseTo(3_000, 6);
    // Ordinary income tax is identical — only the penalty leg differs.
    expect(mixed!.fedTax).toBe(allIra!.fedTax);
  });

  it('mixed Roth pool (Roth 457(b) + Roth IRA): the SOURCE-RESOLVED additional-tax base is not re-prorated', () => {
    // (An ALL-457(b) ordered draw is still fully exempt — the waiver is
    // all-or-nothing rather than prorated; see the sibling case below.)
    // The §408A/§402A ordering engine hands this leg an
    // ALREADY-SOURCE-RESOLVED additional-tax base (it applies the governmental
    // 457(b) §72(t)(9) carve-out at the source — only on an all-457(b) designated
    // pool, so a non-457(b) sibling's genuine penalty is never waived). Scaling that
    // base a SECOND time by the pool's non-exempt WITHDRAWAL share would discount real
    // IRA conversion recapture merely because unrelated 457(b) dollars were drawn in
    // the same year. The base flows straight through, so a mixed pool pays the
    // same 10% as an all-IRA pool on the same $10k earnings excess — the
    // conservative direction, and the only one that cannot silently drop a
    // legitimate recapture.
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
    // No re-proration → the mixed pool owes the SAME penalty as the all-IRA twin.
    expect(allIra!.taxCashflowDollars - mixed!.taxCashflowDollars).toBeCloseTo(0, 6);
    // The ordinary-income tax on the full $10k earnings excess is unchanged.
    expect(mixed!.fedTax).toBe(allIra!.fedTax);
  });

  // §72(t)(2)(A)(ii) — an INHERITED designated-Roth plan. A distribution made on
  // account of the original owner's death carries no 10% at ANY beneficiary age,
  // which is what the deterministic twin does (`computeDesignatedRothDistribution`
  // short-circuits on `inheritedFromDeceasedOwner`). The MC Roth leg omitted
  // `deathExemptInherited`, so the same beneficiary's earnings were charged the
  // full 10% on one engine and none on the other.
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
    // A $20,000 pre-59½ draw from ONE designated-Roth plan whose §402A five-year
    // participation clock is unmet, $10,000 of which is the year's additional-tax
    // base (the earnings tranche the ordering engine resolved upstream).
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
    // The beneficiary's OWN plan: the full 10% × $10,000 base.
    expect(penaltyFor(false)).toBeCloseTo(1_000, 6);
    // Inherited: the whole ordered leg is source-exempt, so no 10% at all.
    expect(penaltyFor(true)).toBe(0);
  });

  it('funded strategy path: a mixed 457(b)+IRA household outlives an all-IRA twin (provenance reaches the funded loop)', () => {
    // Two identical strategy-path runs (same seed, same balances, same member)
    // differing ONLY in the first account's TYPE: RETIREMENT_457B vs
    // RETIREMENT_IRA. Account type does not affect growth or drawdown ordering
    // (both PRE_TAX, same tier), so any funded-balance difference is purely the
    // per-source §72(t) penalty split reaching the funded per-path loop: the
    // 457(b)-sourced share of each year's pre-59½ pooled withdrawal is
    // penalty-free, so the mixed run funds less penalty and ends higher.
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
          // Born 1985 → pre-59½ across the whole horizon (through 2041, age 56).
          { memberId: 'primary', isoBirthdate: '1985-03-15', onMedicare: false, hasAcaCoverage: false },
        ],
        householdSize: 1,
        inflationRatePct: 3,
      },
    });
    const mixed = runMonteCarlo(input('RETIREMENT_457B'));
    const allIra = runMonteCarlo(input('RETIREMENT_IRA'));
    const last = years - 1;
    // Less funded penalty → strictly higher median funded balance.
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

  /** Brokerage + CD single-filer household — the captured baseline
   *  (`p8_brokerageCd_*` entries in mc-parity-baselines.json). */
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
    // The FUNDED per-path tax keeps the shared pre-commit approximation, so the
    // success probability and the banded federal tax reproduce the captured
    // baseline exactly — a silent funded-model change would break this.
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
    // The funded model's banded median above is $0 federal tax for this household
    // (static 0.5 basis, no yield drag, no interest). The representative display
    // carries the deterministic taxable-income model, so its stamped cents are
    // positive.
    const out = runMonteCarlo(brokerageCdInput());
    const rep = out.representativeByBasis?.['mc-typical'];
    expect(rep).toBeDefined();
    const stampedFedCents = rep!.years.reduce((s, y) => s + (y.federalTaxCents ?? 0), 0);
    expect(stampedFedCents).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Filing-plan activation across the MC engine
// ---------------------------------------------------------------------------

describe('filing-plan activation — MC per-path tax', () => {
  const firstYear = 2026;
  const horizonYear = 2060;
  const years = horizonYear - firstYear + 1;
  const stepCount = years * 12;
  /** The secondary spouse dies partway through the horizon, so the survivor
   *  years are the ones the activated plan re-files. */
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
    // Baseline contract: with nobody dying inside the horizon a `joint` plan
    // resolves to MFJ in every year — exactly what the frozen scalar derived —
    // so activation must not move a single number.
    expect(mcParityBaselines.p11_jointPlan_noDeath_reproducesLegacyScalar).toBe(
      'byte-identical',
    );
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
    // The plan's post-death default is `Single`; a year-bounded `QSS` window
    // overlays it with the MFJ bracket/deduction mapping for the dependent
    // years, which is strictly less tax, so the median real ending balance
    // rises. This exercises the status-window model.
    expect(mcParityBaselines.p11_survivorQssWindow_medianEndingBalanceReal_direction).toBe(
      'above-single-default',
    );
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
    // Direction alone cannot catch an off-by-one, so pin the four boundary
    // years: `end` is EXCLUSIVE, so [start, end) is covered and start-1 / end
    // are not. The death year itself stays MFJ (death-year joint treatment).
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
    // A two-member household carrying a `Single` scalar cannot say whose tax
    // unit is dropped, so the resolver refuses. The engine must NOT guess: it
    // reports no units and keeps filing exactly as the frozen scalar did while
    // the scenario editor prompts for a resolution.
    expect(mcParityBaselines.p11_unresolvedTwoMemberScalar_taxUnits).toBe(
      'withheld-legacy-path',
    );
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
    // The legacy scalar keeps producing `Single`.
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
    expect(mcParityBaselines.p11_survivorIrmaaLookbackStatus).toBe('lookback-return-status');
    // 2046 is the survivor's first `Single` year; its IRMAA look-back is the
    // 2044 return, which the couple filed jointly.
    const survivorFirstSingleYear = deriveMcSurvivors(taxCtx, 2046, firstYear);
    expect(survivorFirstSingleYear?.filingStatus).toBe('Single');
    expect(survivorFirstSingleYear?.irmaaLookbackFilingStatus).toBe('MFJ');
    // By 2048 the look-back (2046) is itself a Single return.
    const laterSurvivorYear = deriveMcSurvivors(taxCtx, 2048, firstYear);
    expect(laterSurvivorYear?.irmaaLookbackFilingStatus).toBe('Single');
    // The death year itself still files jointly (death-year joint treatment).
    expect(deriveMcSurvivors(taxCtx, 2045, firstYear)?.filingStatus).toBe('MFJ');
  });
  it('runs a SEPARATE (MFS) plan end to end and lands below the joint plan', () => {
    // The headline filing-plan feature, exercised at RUN level. Spouses who file apart
    // while having lived together lose the §86(c)(1)(C)(ii) base amounts
    // entirely, so their Social Security is taxable from the first dollar on
    // top of the halved MFS brackets — strictly more tax, so the median real
    // ending balance falls below the joint plan's.
    expect(mcParityBaselines.p11_separateMfsPlan_medianEndingBalanceReal_direction).toBe(
      'below-joint',
    );
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
        // The whole benefit is the primary's, so §86 runs on ONE return.
        ssSharesByYear: Array.from({ length: years }, (_, i) => ({
          year: firstYear + i,
          primaryShare: 1,
        })),
      }),
    );
    expect(separate).toBeLessThan(joint);
  });

  it('attributes gross Social Security per recipient on the MC path', () => {
    // §86 is non-linear PER RETURN, so a 50/50 split of a benefit only one
    // spouse receives yields a different taxable-SS figure — and therefore
    // different FUNDED balances — than attributing it to its recipient. MC used
    // to have no way to express this while the deterministic engine did.
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
    // The attribution reaches only the multi-unit branch, so threading shares
    // through a joint household must not move a single number.
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

// ---------------------------------------------------------------------------
// The BOOTSTRAP-year IRMAA look-back is per RETURN, not one collapsed
// status shared by both spouses.
// ---------------------------------------------------------------------------

describe('bootstrap-year IRMAA look-back per return', () => {
  const MEMBERS = [
    { memberId: 'primary', isoBirthdate: '1955-01-01', onMedicare: true, hasAcaCoverage: false },
    { memberId: 'secondary', isoBirthdate: '1955-01-01', onMedicare: true, hasAcaCoverage: false },
  ];
  /** Two returns, both spouses alive, differing only in the SECOND spouse's
   *  status. `livedTogether` is what puts an `MFS` return on the steeper
   *  married-filing-separately Medicare schedule while a `HoH` return stays on
   *  the single-filer one — so this pair is the smallest household whose two
   *  returns tier on genuinely different ladders. */
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
  /** One BOOTSTRAP projection year: no per-return ring entry yet, only the
   *  household-wide look-back MAGI the user stored. $300k splits to $150k per
   *  return — above the tier-1 threshold on BOTH ladders, but landing on very
   *  different surcharges. */
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
      // The bootstrap years have no per-return ring entry — the whole point.
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
    // A joint household has one return; the household-wide look-back scalars
    // already say everything there is to say, so nothing is materialized.
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
    // The regression: both returns collapsed onto `units[0]`'s status, so the
    // head-of-household spouse was charged the (much steeper) separate-filer
    // surcharge for the first two projection years and then dropped to their
    // own schedule once the per-return ring filled — a discontinuity with no
    // cause in the filing plan.
    const bothMfs = bootstrapYearIrmaa('MFS');
    const mixed = bootstrapYearIrmaa('HoH');
    expect(bothMfs).toBeGreaterThan(0);
    expect(mixed).toBeGreaterThan(0);
    expect(mixed).toBeLessThan(bothMfs);
  });
});

// ---------------------------------------------------------------------------
// Fact-based MC Roth ordering: the two regimes are genuinely different.
// ---------------------------------------------------------------------------

describe('applyMcRothBasisOrdering — fact-based §408A / §402A regimes', () => {
  const OWNER = 'mc-p12-owner';
  /** Pre-59½ owner (born 1980), so an additional-tax base exists at all. */
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

  /** A $10,000 §408A-ordered Roth draw in 2030. The designated slice runs the
   *  SHARED stateful engine against a pooled carrier entry, so the pool has to be
   *  seeded (and, across a multi-year sequence, REUSED) exactly as the engine does. */
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
    // No regular basis; one $10,000 fully-taxable conversion in 2028 → the 2030 draw
    // is inside the five-tax-year window and the owner is pre-59½.
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
    // Converted principal is never re-taxed as ordinary income …
    expect(out.earningsExcessDollars).toBe(0);
    // … but the in-window recapture IS in the 10% §72(t) base.
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
    // All-designated pool with half the balance recorded as basis. A $10,000 draw
    // therefore recovers $5,000 of basis and realises $5,000 of growth — a
    // contribution-first rule would have made the whole draw tax-free.
    const p = profile({
      iraShareOfOrderedPool: 0,
      designatedBasisCents: 50_000 * 100,
      designatedBalanceCents: 100_000 * 100,
    });
    const carrier = seedMcAggregateRothBasisCarrier([], p);
    const out = applyMcRothBasisOrdering(args(carrier, p));
    expect(out.earningsExcessDollars).toBe(5_000);
    expect(out.additionalTaxBaseDollars).toBe(5_000);
    // Without this the designated slice would share one
    // contribution-first pool, so the same draw would come out entirely tax-free.
    expect(mcParityBaselines.p12_designatedRothOrdering_preFix).toBe('contributions-first');
    expect(mcParityBaselines.p12_pureRothEmployerBasis_preFix).toBe(
      'whole-at-retirement-balance-as-basis',
    );
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
    // $4,000 basis shields $4,000; the remaining $6,000 is growth.
    expect(out.earningsExcessDollars).toBe(6_000);
    expect(out.additionalTaxBaseDollars).toBe(6_000);
    expect(mcParityBaselines.p12_noRothRmdFacts_reproducesLegacyEngine).toBe('byte-identical');
  });

  // The designated split is STATEFUL: the pool's remaining basis
  // decrements on every draw, so its LIFETIME basis shelter is capped at the
  // recorded basis. A stateless split would re-apply a frozen fraction to
  // every future withdrawal and could shelter multiples of the recorded basis.
  it('decrements the designated pool basis across a multi-year withdrawal sequence', () => {
    const p = profile({
      iraShareOfOrderedPool: 0,
      designatedBasisCents: 10_000 * 100,
      designatedBalanceCents: 20_000 * 100,
    });
    const carrier = seedMcAggregateRothBasisCarrier([], p);
    const pool = seedMcDesignatedRothPool(p);
    // Four $10,000 draws against a $20,000 pocket holding $10,000 of basis. The
    // whole sequence can shelter AT MOST the recorded $10,000.
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
    // Year 1: $10k draw / $20k balance × $10k basis = $5,000 sheltered.
    expect(shelteredByYear[0]).toBeCloseTo(5_000, 6);
    // Every later year shelters STRICTLY LESS, because the remaining basis fell.
    // A stateless split would re-apply the frozen 50% fraction and shelter
    // $5,000 EVERY year — $20,000 lifetime against $10,000 of recorded basis.
    for (let i = 1; i < shelteredByYear.length; i += 1) {
      expect(shelteredByYear[i]).toBeLessThan(shelteredByYear[i - 1]);
    }
    // Lifetime shelter can never exceed the household's recorded basis.
    const lifetime = shelteredByYear.reduce((sum, v) => sum + v, 0);
    expect(lifetime).toBeLessThanOrEqual(10_000);
    expect(pool!.entry.designatedRothBasisRemainingCents).toBeCloseTo(
      (10_000 - lifetime) * 100,
      6,
    );
  });

  // The MC designated profile carries in-plan
  // rollover lots, so taxable rollover principal withdrawn inside its own
  // five-tax-year §402A(c)(4)(D) window is recaptured on a Monte Carlo path too.
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
    // The whole draw is basis (balance === basis), so no ordinary income …
    expect(out.earningsExcessDollars).toBe(0);
    // … but the 2028 taxable rollover principal is inside its window in 2030 and
    // the owner is pre-59½, so it enters the 10% base.
    expect(out.additionalTaxBaseDollars).toBe(10_000);

    // The SAME lot outside its window carries no recapture.
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

  // §408A's five-year period and the age-59½ event are both PER
  // INDIVIDUAL, and the MC bucket pools both spouses' Roth dollars. The pooled tests
  // must therefore be the ones no owner can beat.
  it('keeps the pooled Roth-IRA five-year clock and 59½ test per-owner-conservative', () => {
    const OLDER = 'primary';
    const YOUNGER = 'secondary';
    const twoOwnerCtx = (over: Partial<McRothOrderedProfile>): McTaxContext =>
      ({
        taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
        filingStatus: 'MFJ',
        members: [
          // Older spouse is comfortably past 59½ in 2030 …
          { memberId: OLDER, isoBirthdate: '1960-01-15', onMedicare: false, hasAcaCoverage: false },
          // … the younger one is only 45.
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
    // The YOUNGER owner has not reached 59½, so the pooled draw is nonqualified and
    // penalized even though the primary member is well past it (a
    // primary-only test would make this whole draw tax- and penalty-free).
    expect(out.earningsExcessDollars).toBe(10_000);
    expect(out.additionalTaxBaseDollars).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// Month-aware health coverage crosses into the MC path
// ---------------------------------------------------------------------------

describe('MC month-aware health coverage', () => {
  const HEALTH_MEMBER: TaxMemberInput = {
    memberId: 'primary',
    isoBirthdate: '1960-03-01',
    onMedicare: false,
    hasAcaCoverage: false,
  };

  it('resolves a whole Medicare year once the member is past 65', () => {
    // 2030: the member is 70 → Medicare all year, off the Marketplace.
    const flags = buildYearMemberFlags(HEALTH_MEMBER, 2030, 2026);
    expect(flags.onMedicare).toBe(true);
    expect(flags.partBEnrollmentMonths).toBe(12);
    expect(flags.partDEnrollmentMonths).toBe(12);
    expect(flags.marketplaceCoverageMonths).toBe(0);
  });

  it('overlays the stored Part B / Part D / Marketplace months for the year', () => {
    const healthCoverageMonths = {
      perMember: { primary: { 2024: { partBMonths: 7, partDMonths: 0, marketplaceMonths: 5 } } },
    };
    // 2024 — the member is 64 all year, so nothing is Medicare-entitled and the
    // stated counts pass through untouched.
    const flags = buildYearMemberFlags(HEALTH_MEMBER, 2024, 2024, new Set(), healthCoverageMonths);
    expect(flags.partBEnrollmentMonths).toBe(7);
    expect(flags.partDEnrollmentMonths).toBe(0);
    expect(flags.marketplaceCoverageMonths).toBe(5);
    // A DIFFERENT year in the same map falls back to the automatic derivation:
    // born March 1 1960 → entitlement starts February 2025 (first-of-month
    // rule), so 2026 is a whole Medicare year.
    const other = buildYearMemberFlags(HEALTH_MEMBER, 2026, 2024, new Set(), healthCoverageMonths);
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
    // The direction pins below are asserted against REAL engine output
    // rather than against their own JSON literal.
    const wholeYear = deriveMcSurvivors(
      { ...taxCtx, healthCoverageMonths: undefined } as unknown as McTaxContext,
      2030,
      2024,
    );
    expect(mcParityBaselines.p13_partialMedicareMonths_irmaa_direction).toBe('below-whole-year');
    expect(state!.survivors[0].partBEnrollmentMonths!).toBeLessThan(
      wholeYear!.survivors[0].partBEnrollmentMonths!,
    );
    expect(mcParityBaselines.p13_partialMarketplaceMonths_benchmark_direction).toBe(
      'below-full-year',
    );
    expect(defaultHouseholdSlcspByAge(state!.survivors, 2025)).toBeLessThan(
      defaultHouseholdSlcspByAge(
        [{ ...state!.survivors[0], marketplaceCoverageMonths: 12, partBEnrollmentMonths: 0, partDEnrollmentMonths: 0 }],
        2025,
      ),
    );
  });

  // `deriveMcSurvivors` gates each member's automatic
  // Marketplace months on THAT member's own retirement year. The end-to-end
  // deterministic-vs-MC parity proof lives in
  // `balance-projection-runner-tax-helpers.test.ts`; this pins the MC
  // resolution itself, including the fallback when the table is absent.
  describe('per-member retirement year (staggered households)', () => {
    const staggeredCtx = (
      retirementYearByMember?: readonly { memberId: string; retirementYear: number }[],
    ) =>
      ({
        taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
        filingStatus: 'MFJ',
        members: [
          // Both are pre-65 in 2028, so retirement is the ONLY thing that can
          // turn Marketplace coverage on.
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
      // The listed primary is still working; the unlisted secondary keeps the
      // household scalar (retired since 2026).
      expect(partial?.survivors[0].marketplaceCoverageMonths).toBe(0);
      expect(partial?.survivors[1].marketplaceCoverageMonths).toBe(12);
      // A corrupted (NaN) entry must not read as "never retired".
      const corrupt = deriveMcSurvivors(
        staggeredCtx([{ memberId: 'secondary', retirementYear: Number.NaN }]),
        2028,
        2026,
      );
      expect(corrupt?.survivors[1].marketplaceCoverageMonths).toBe(12);
    });
  });
});

// ---------------------------------------------------------------------------
// An economically SENSITIVE integrated cross-engine case
// ---------------------------------------------------------------------------
//
// The demo BPP parity fixture is inert for month-aware health coverage (its
// MAGI sits
// above the 400% FPL cliff and far below the IRMAA tier-1 floor, so both
// engines contribute $0 either way). This case is deliberately parameterised
// INTO the sensitive band: a single filer crossing ACA → Medicare mid-year,
// with a look-back MAGI above IRMAA tier 1 and a current-year ACA MAGI inside
// 100–400% FPL, so BOTH engines contribute a non-zero figure and both
// engines must agree on it.
describe('integrated ACA→Medicare transition year (both engines)', () => {
  const TAX_YEAR = 2026;
  /** Turns 65 on 1 July 2026 → Medicare July–December, Marketplace Jan–June. */
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
    // Inside 100–400% FPL for a single filer in 2026 ($15,650 base → 400% is
    // $62,600), so the sliding scale — not the cliff — applies.
    preTaxWithdrawalDollars: 50_000,
    postTaxNonRothWithdrawalDollars: 0,
    postTaxCashLikeWithdrawalDollars: 0,
    rothWithdrawalDollars: 0,
    otherOrdinaryIncomeDollars: 0,
    taxExemptInterestDollars: 0,
    // Above the 2026 single IRMAA tier-1 floor, so a surcharge is really charged.
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
  const mcMembers = [buildYearMemberFlags(memberSeed, TAX_YEAR, 2024)];

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
    // Half a year of enrolment costs about half a whole year's surcharge.
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
    // Proration on BOTH sides: six covered months credit close to half
    // of the same household's whole-year credit. Without proration the full annual
    // contribution would be subtracted from the half-year benchmark, which would
    // floor this to a small fraction (often $0).
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
