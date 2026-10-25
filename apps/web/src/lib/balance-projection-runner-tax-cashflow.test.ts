/** Tests for `buildTaxCashflowHook` and the Roth-conversion tax surface in the tax-cashflow runner wiring. */
import { describe, it, expect } from 'vitest';
import {
  applyTaxIntegrationToDrawdownYears,
  buildTaxCashflowHook,
} from './balance-projection-runner-tax';
import { simulateDrawdown } from './drawdown-engine';
import { singleMagiCapWindow } from './drawdown-engine-per-account-magi-cap';
import type {
  DrawdownAccountInput,
  DrawdownInput,
  DrawdownYear,
  TaxCashflowYearClassification,
} from './drawdown-engine-types';
import type { MagiCapWindow } from '../db/types';
import {
  REAL_BUNDLE,
  makeAccountBalance,
  makeCtx,
  makeDrawdownYear,
  makeLedgerAccount,
} from './balance-projection-runner-tax-test-fixtures';

function allPreTax(target: number): TaxCashflowYearClassification {
  return {
    preTaxDollars: target,
    postTaxNonRothDollars: 0,
    postTaxCashLikeDollars: 0,
    rothDollars: 0,
    fundedDollars: target,
  };
}

describe('buildTaxCashflowHook', () => {
  it('federal tax produces a positive same-year cashflow need', () => {
    const ctx = makeCtx({ primaryBirthdate: '1960-01-01', primaryRetirementYear: 2024 });
    const hook = buildTaxCashflowHook({
      ctx,
      ssRows: [],
      nonSsIncomeRows: [],
      ledgerAccounts: [],
      bundle: REAL_BUNDLE,
      retirementYear: 2024,
    });
    const outcome = hook.solveForYear(0, 80_000, allPreTax);
    expect(outcome.federalTaxCashNeedCents).toBeGreaterThan(0);
    expect(outcome.addedNeedDollars).toBeGreaterThan(0);
    expect(outcome.totalTaxCashflowNeedCents).toBeGreaterThan(0);
  });

  it('withholds IRMAA from the member own SS when receiving their own benefit (no cash need)', () => {
    // Age 71 in 2026 (on Medicare) receiving their own $40k SS: IRMAA is withheld from that benefit; a magiBootstrap seeds the
    // year-0 look-back so the surcharge fires.
    const ctx = makeCtx({
      primaryBirthdate: '1955-01-01',
      primaryRetirementYear: 2026,
      magiBootstrapLookbackMinus2: 300_000,
      magiBootstrapLookbackMinus1: 300_000,
    });
    const hook = buildTaxCashflowHook({
      ctx,
      // grossSsForYear divides the 12-month run-rate sum by 12 → $40k/yr, all the primary's own SS.
      ssRows: Array.from({ length: 12 }, (_, m) => ({
        year: 2026,
        month0: m,
        total: 40_000,
        primary: 40_000,
      })),
      nonSsIncomeRows: [],
      ledgerAccounts: [],
      bundle: REAL_BUNDLE,
      retirementYear: 2026,
    });
    const outcome = hook.solveForYear(0, 20_000, allPreTax);
    expect(outcome.irmaaWithheldFromSsCents).toBeGreaterThan(0);
    expect(outcome.irmaaCashNeedCents).toBe(0);
  });

  it('withheld IRMAA still raises the portfolio draw (addedNeedDollars), while gross SS funds MAGI', () => {
    // A Medicare member receiving their own SS has IRMAA withheld from the benefit, but the income series spends gross SS, so
    // the withheld amount must raise the portfolio draw by exactly its value (addedNeedDollars = federal-tax cash + IRMAA
    // cash + IRMAA withheld).
    const ctx = makeCtx({
      primaryBirthdate: '1955-01-01',
      primaryRetirementYear: 2026,
      magiBootstrapLookbackMinus2: 300_000,
      magiBootstrapLookbackMinus1: 300_000,
    });
    const ssRows = Array.from({ length: 12 }, (_, m) => ({
      year: 2026,
      month0: m,
      total: 40_000,
      primary: 40_000,
    }));
    const hook = buildTaxCashflowHook({
      ctx,
      ssRows,
      nonSsIncomeRows: [],
      ledgerAccounts: [],
      bundle: REAL_BUNDLE,
      retirementYear: 2026,
    });
    const outcome = hook.solveForYear(0, 20_000, allPreTax);
    expect(outcome.irmaaWithheldFromSsCents).toBeGreaterThan(0);
    expect(outcome.irmaaCashNeedCents).toBe(0);
    const expectedAddedCents =
      outcome.totalTaxCashflowNeedCents + outcome.irmaaWithheldFromSsCents;
    expect(outcome.addedNeedDollars).toBeCloseTo(expectedAddedCents / 100, 2);
    expect(outcome.addedNeedDollars).toBeGreaterThan(
      outcome.totalTaxCashflowNeedCents / 100,
    );

    // MAGI and §86 stay on gross SS, but the extra draw that funds the withheld surcharge is itself taxable pre-tax income, so
    // federal tax is strictly higher than an identical year with no surcharge (a fresh hook without the magiBootstrap skips
    // IRMAA).
    const noIrmaaCtx = makeCtx({
      primaryBirthdate: '1955-01-01',
      primaryRetirementYear: 2026,
    });
    const noIrmaaHook = buildTaxCashflowHook({
      ctx: noIrmaaCtx,
      ssRows,
      nonSsIncomeRows: [],
      ledgerAccounts: [],
      bundle: REAL_BUNDLE,
      retirementYear: 2026,
    });
    const noIrmaaOutcome = noIrmaaHook.solveForYear(0, 20_000, allPreTax);
    expect(noIrmaaOutcome.irmaaWithheldFromSsCents).toBe(0);
    expect(noIrmaaOutcome.irmaaCashNeedCents).toBe(0);
    expect(outcome.federalTaxCashNeedCents).toBeGreaterThan(
      noIrmaaOutcome.federalTaxCashNeedCents,
    );
  });

  it('treats IRMAA as a cash need when on Medicare but not receiving their own SS', () => {
    const ctx = makeCtx({
      primaryBirthdate: '1955-01-01',
      primaryRetirementYear: 2026,
      magiBootstrapLookbackMinus2: 300_000,
      magiBootstrapLookbackMinus1: 300_000,
    });
    const hook = buildTaxCashflowHook({
      ctx,
      ssRows: [], // no SS → no own benefit to withhold from
      nonSsIncomeRows: [],
      ledgerAccounts: [],
      bundle: REAL_BUNDLE,
      retirementYear: 2026,
    });
    const outcome = hook.solveForYear(0, 20_000, allPreTax);
    expect(outcome.irmaaCashNeedCents).toBeGreaterThan(0);
    expect(outcome.irmaaWithheldFromSsCents).toBe(0);
  });

  it('mixed household: the Medicare member who delays SS pays IRMAA as cash, '
    + 'never withheld from the spouse collecting SS', () => {
    // The primary is on Medicare (71) but has not claimed SS; the secondary (62, not on Medicare) collects $40k. The primary's
    // surcharge is a cash need and must not be withheld from the secondary's SS.
    const ctx = makeCtx({
      primaryBirthdate: '1955-01-01',
      secondaryBirthdate: '1964-01-01',
      primaryRetirementYear: 2026,
      magiBootstrapLookbackMinus2: 300_000,
      magiBootstrapLookbackMinus1: 300_000,
    });
    const hook = buildTaxCashflowHook({
      ctx,
      ssRows: Array.from({ length: 12 }, (_, m) => ({
        year: 2026,
        month0: m,
        total: 40_000,
        primary: 0,
        secondary: 40_000,
      })),
      nonSsIncomeRows: [],
      ledgerAccounts: [],
      bundle: REAL_BUNDLE,
      retirementYear: 2026,
    });
    const outcome = hook.solveForYear(0, 20_000, allPreTax);
    expect(outcome.irmaaCashNeedCents).toBeGreaterThan(0);
    expect(outcome.irmaaWithheldFromSsCents).toBe(0);
  });

  it('never produces a negative tax cashflow need (ACA offset floored)', () => {
    const ctx = makeCtx({ primaryBirthdate: '1965-01-01', primaryRetirementYear: 2030 });
    const hook = buildTaxCashflowHook({
      ctx,
      ssRows: [],
      nonSsIncomeRows: [],
      ledgerAccounts: [],
      bundle: REAL_BUNDLE,
      retirementYear: 2030,
    });
    const outcome = hook.solveForYear(0, 30_000, allPreTax);
    expect(outcome.totalTaxCashflowNeedCents).toBeGreaterThanOrEqual(0);
    expect(outcome.addedNeedDollars).toBeGreaterThanOrEqual(0);
  });

  it('a dead year (no living members) funds no tax', () => {
    const ctx = makeCtx({ primaryBirthdate: '1900-01-01', primaryRetirementYear: 2030 });
    const hook = buildTaxCashflowHook({
      ctx,
      ssRows: [],
      nonSsIncomeRows: [],
      ledgerAccounts: [],
      bundle: REAL_BUNDLE,
      retirementYear: 2030,
    });
    const outcome = hook.solveForYear(0, 50_000, allPreTax);
    expect(outcome.addedNeedDollars).toBe(0);
    expect(outcome.totalTaxCashflowNeedCents).toBe(0);
  });

  it('only the HSA share of the cash-like bucket incurs the nonqualified 20% '
    + 'additional tax — savings/CD/MM principal is not over-taxed', () => {
    // Pre-65 primary (60 in 2024) with hsaQualifiedMedicalExpensePct 90 and no hsaMedicalQualifiedDollars: the emergency HSA case
    // the percentage governs. The cash-like bucket (HSA + SAVINGS) is classified whole, but only the HSA balance share funds
    // the 20% tax; feeding the whole bucket would tax savings principal as nonqualified HSA income.
    const cashLike = (target: number): TaxCashflowYearClassification => ({
      preTaxDollars: 0,
      postTaxNonRothDollars: 0,
      postTaxCashLikeDollars: target,
      rothDollars: 0,
      fundedDollars: target,
    });
    const baseArgs = {
      ctx: makeCtx({
        primaryBirthdate: '1964-01-01', // age 60 in 2024 → pre-65 HSA penalty
        primaryRetirementYear: 2024,
        hsaQualifiedMedicalExpensePct: 90,
        accountProjections: [
          { id: 'hsa1', taxTreatment: 'HSA' as const, accountType: 'HSA' },
          { id: 'sav1', taxTreatment: 'POST_TAX' as const, accountType: 'SAVINGS' },
        ],
      }),
      ssRows: [],
      nonSsIncomeRows: [],
      bundle: REAL_BUNDLE,
      retirementYear: 2024,
    };

    const mixedHook = buildTaxCashflowHook({
      ...baseArgs,
      ledgerAccounts: [
        makeLedgerAccount('hsa1', 0, 50_000, { accountType: 'HSA', taxTreatment: 'HSA' }),
        makeLedgerAccount('sav1', 0, 50_000, { accountType: 'SAVINGS', taxTreatment: 'POST_TAX' }),
      ],
    });
    const mixed = mixedHook.solveForYear(0, 40_000, cashLike);

    const savingsHook = buildTaxCashflowHook({
      ...baseArgs,
      ledgerAccounts: [
        makeLedgerAccount('sav1', 0, 50_000, { accountType: 'SAVINGS', taxTreatment: 'POST_TAX' }),
      ],
    });
    const savingsOnly = savingsHook.solveForYear(0, 40_000, cashLike);

    const allHsaHook = buildTaxCashflowHook({
      ...baseArgs,
      ledgerAccounts: [
        makeLedgerAccount('hsa1', 0, 100_000, { accountType: 'HSA', taxTreatment: 'HSA' }),
      ],
    });
    const allHsa = allHsaHook.solveForYear(0, 40_000, cashLike);

    expect(savingsOnly.federalTaxCashNeedCents).toBe(0);
    // All-HSA: $40k draw × 10% nonqualified × 20% = $800.
    expect(allHsa.federalTaxCashNeedCents).toBe(800 * 100);
    // Mixed 50/50: $20k × 10% × 20% = $400, half the all-HSA figure (savings principal excluded).
    expect(mixed.federalTaxCashNeedCents).toBe(400 * 100);
  });

  it('the committed classification covers the withheld-IRMAA portion of the '
    + 'funded draw → the Roth earnings penalty includes the withheld leg', () => {
    // Primary (67, on Medicare, own $40k SS so IRMAA is withheld) and secondary (58, owner of a Roth IRA with $0 §408A basis, so
    // the whole draw is penalizable earnings). The funded draw is ordinaryNeed + cashTaxNeed + withheldIrmaa, and the
    // committed classification must cover that same draw, or the funded penalty under-counts the withheld leg.
    const rothClassify = (target: number): TaxCashflowYearClassification => ({
      preTaxDollars: 0,
      postTaxNonRothDollars: 0,
      postTaxCashLikeDollars: 0,
      rothDollars: target,
      fundedDollars: target,
    });
    const makeWithheldCtx = (): ReturnType<typeof makeCtx> =>
      makeCtx({
        primaryBirthdate: '1959-01-01', // age 67 in 2026 → Medicare + IRMAA
        secondaryBirthdate: '1968-01-01', // age 58 in 2026 → pre-59½
        primaryRetirementYear: 2026,
        magiBootstrapLookbackMinus2: 300_000, // seed the year-0 IRMAA look-back
        accountProjections: [
          {
            id: 'roth1',
            taxTreatment: 'ROTH',
            accountType: 'RETIREMENT_ROTH_IRA',
            ownerId: 'member-secondary',
          },
        ],
        rothBasisCentsByOwner: new Map([['member-secondary', 0]]), // all earnings
      });
    const ledgerAccounts = [
      makeLedgerAccount('roth1', 0, 100_000, {
        accountType: 'RETIREMENT_ROTH_IRA',
        taxTreatment: 'ROTH',
      }),
    ];
    const withheldSsRows = Array.from({ length: 12 }, (_, m) => ({
      year: 2026,
      month0: m,
      total: 40_000,
      primary: 40_000,
    }));
    const withheldHook = buildTaxCashflowHook({
      ctx: makeWithheldCtx(),
      ssRows: withheldSsRows,
      nonSsIncomeRows: [],
      ledgerAccounts,
      bundle: REAL_BUNDLE,
      retirementYear: 2026,
    });
    const withheld = withheldHook.solveForYear(0, 30_000, rothClassify);

    expect(withheld.irmaaWithheldFromSsCents).toBeGreaterThan(0);
    expect(withheld.irmaaCashNeedCents).toBe(0);

    const noIrmaaCtx = makeCtx({
      primaryBirthdate: '1959-01-01',
      secondaryBirthdate: '1968-01-01',
      primaryRetirementYear: 2026,
      accountProjections: [
        { id: 'roth1', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA', ownerId: 'member-secondary' },
      ],
      rothBasisCentsByOwner: new Map([['member-secondary', 0]]),
    });
    const noIrmaaHook = buildTaxCashflowHook({
      ctx: noIrmaaCtx,
      ssRows: withheldSsRows,
      nonSsIncomeRows: [],
      ledgerAccounts,
      bundle: REAL_BUNDLE,
      retirementYear: 2026,
    });
    const noIrmaa = noIrmaaHook.solveForYear(0, 30_000, rothClassify);
    expect(noIrmaa.irmaaWithheldFromSsCents).toBe(0);

    // The withheld year classifies more Roth earnings than the no-surcharge baseline, so its federal-tax cash need (income tax
    // plus the 10% Roth penalty) is strictly higher.
    expect(withheld.federalTaxCashNeedCents).toBeGreaterThan(
      noIrmaa.federalTaxCashNeedCents,
    );
  });
});

function preTaxWithdrawals(preTaxDollars: number): TaxCashflowYearClassification {
  return {
    preTaxDollars,
    postTaxNonRothDollars: 0,
    postTaxCashLikeDollars: 0,
    rothDollars: 0,
    fundedDollars: preTaxDollars,
  };
}

describe('buildTaxCashflowHook — solveFillConversionForYear', () => {
  it('sizes the conversion so realized federal/IRMAA MAGI lands at the ceiling, not above', () => {
    const ctx = makeCtx({ primaryBirthdate: '1960-01-01', primaryRetirementYear: 2024 });
    const hook = buildTaxCashflowHook({
      ctx, ssRows: [], nonSsIncomeRows: [], ledgerAccounts: [],
      bundle: REAL_BUNDLE, retirementYear: 2024,
    });
    const conv = hook.solveFillConversionForYear!(0, preTaxWithdrawals(40_000), 200_000, 'irmaa', 100_000);
    // No SS → MAGI(conv) = 40k + conv (slope 1.0) → fills to ~$60k.
    expect(conv).toBeGreaterThan(59_000);
    expect(conv).toBeLessThanOrEqual(60_000);
  });

  it('converts zero when withdrawals-only MAGI already exceeds the ceiling', () => {
    const ctx = makeCtx({ primaryBirthdate: '1960-01-01', primaryRetirementYear: 2024 });
    const hook = buildTaxCashflowHook({
      ctx, ssRows: [], nonSsIncomeRows: [], ledgerAccounts: [],
      bundle: REAL_BUNDLE, retirementYear: 2024,
    });
    expect(hook.solveFillConversionForYear!(0, preTaxWithdrawals(120_000), 50_000, 'irmaa', 100_000)).toBe(0);
  });

  it('IRMAA Y+2 anchor: a year-Y conversion raises the year-Y MAGI that drives the Y+2 surcharge', () => {
    const ctx = makeCtx({ primaryBirthdate: '1955-01-01', primaryRetirementYear: 2026 });
    const hook = buildTaxCashflowHook({
      ctx, ssRows: [], nonSsIncomeRows: [], ledgerAccounts: [],
      bundle: REAL_BUNDLE, retirementYear: 2026,
    });
    const conv = hook.solveFillConversionForYear!(0, preTaxWithdrawals(30_000), 150_000, 'irmaa', 103_000);
    // No SS → fills 30k → ~103k ceiling, i.e. ~$73k converted.
    expect(conv).toBeGreaterThan(72_000);
    expect(conv).toBeLessThanOrEqual(73_000);
  });

  it('the ACA line converts fewer dollars than the IRMAA line for an SS household', () => {
    // ACA MAGI adds back the nontaxable SS portion, so the same ceiling is hit with less conversion on the ACA line.
    const ctx = makeCtx({ primaryBirthdate: '1958-01-01', primaryRetirementYear: 2030 });
    const ssRows = Array.from({ length: 12 }, (_, m) => ({ year: 2030, month0: m, total: 30_000, primary: 30_000 }));
    const hook = buildTaxCashflowHook({
      ctx, ssRows, nonSsIncomeRows: [], ledgerAccounts: [],
      bundle: REAL_BUNDLE, retirementYear: 2030,
    });
    const irmaa = hook.solveFillConversionForYear!(0, preTaxWithdrawals(10_000), 150_000, 'irmaa', 70_000);
    const aca = hook.solveFillConversionForYear!(0, preTaxWithdrawals(10_000), 150_000, 'aca', 70_000);
    expect(aca).toBeLessThan(irmaa);
  });

  it('returns 0 when offered no room', () => {
    const ctx = makeCtx({ primaryBirthdate: '1960-01-01', primaryRetirementYear: 2024 });
    const hook = buildTaxCashflowHook({
      ctx, ssRows: [], nonSsIncomeRows: [], ledgerAccounts: [],
      bundle: REAL_BUNDLE, retirementYear: 2024,
    });
    expect(hook.solveFillConversionForYear!(0, preTaxWithdrawals(40_000), 0, 'irmaa', 100_000)).toBe(0);
  });
});

describe('applyTaxIntegrationToDrawdownYears — Roth conversion ordinary income', () => {
  it('raises the displayed federal tax + MAGI by the converted amount (not a §72(t) penalty)', () => {
    const accountProjections = [
      { id: 'ira', taxTreatment: 'PRE_TAX' as const, accountType: 'RETIREMENT_IRA' },
    ];
    const balances = new Map([['ira', makeAccountBalance(500_000, 30_000)]]);
    const ctx = makeCtx({ primaryBirthdate: '1960-01-01', primaryRetirementYear: 2024, accountProjections });

    const noConv: DrawdownYear[] = [makeDrawdownYear(2024, 30_000, balances)];
    applyTaxIntegrationToDrawdownYears(noConv, [], [], [makeLedgerAccount('ira', 500_000)], ctx, REAL_BUNDLE);

    const withConv: DrawdownYear[] = [{ ...makeDrawdownYear(2024, 30_000, balances), rothConvertedCents: 40_000 * 100 }];
    applyTaxIntegrationToDrawdownYears(withConv, [], [], [makeLedgerAccount('ira', 500_000)], ctx, REAL_BUNDLE);

    expect(withConv[0].magiCents!).toBeCloseTo(noConv[0].magiCents! + 40_000 * 100, -2);
    expect(withConv[0].federalTaxCents!).toBeGreaterThan(noConv[0].federalTaxCents!);
    // A conversion is not a distribution: no §72(t) penalty is added.
    expect(withConv[0].earlyWithdrawalPenaltyCents ?? 0).toBe(noConv[0].earlyWithdrawalPenaltyCents ?? 0);
  });

  it('credits converted principal as a DATED conversion lot: never re-taxed as income, but recaptured inside its five-tax-year window', () => {
    // Born 1975 (49 in 2024) with $0 seeded Roth basis converts $50k in year 0; a $40k year-2 Roth-IRA draw comes out of that
    // conversion basis, so it is never re-taxed, but 2026 is inside the conversion's five-taxable-year clock
    // (§408A(d)(3)(F)), so it carries the 10% recapture. Undated basis would escape it.
    const accountProjections = [
      { id: 'roth', taxTreatment: 'ROTH' as const, accountType: 'RETIREMENT_ROTH_IRA', ownerId: 'member-primary' },
    ];
    const rothDraw = new Map([['roth', makeAccountBalance(200_000, 40_000)]]);
    const noDraw = new Map([['roth', makeAccountBalance(200_000, 0)]]);
    const mkCtx = (withTarget: boolean) =>
      makeCtx({
        primaryBirthdate: '1975-01-01',
        primaryRetirementYear: 2024,
        accountProjections,
        rothBasisCentsByOwner: new Map([['member-primary', 0]]),
        magiCapTargetRothAccountId: withTarget ? 'roth' : undefined,
      });

    const withConv: DrawdownYear[] = [
      { ...makeDrawdownYear(2024, 0, noDraw), rothConvertedCents: 50_000 * 100 },
      makeDrawdownYear(2025, 0, noDraw),
      makeDrawdownYear(2026, 40_000, rothDraw),
    ];
    applyTaxIntegrationToDrawdownYears(withConv, [], [], [makeLedgerAccount('roth', 0, 200_000, { accountType: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH' })], mkCtx(true), REAL_BUNDLE);

    const noConv: DrawdownYear[] = [
      makeDrawdownYear(2024, 0, noDraw),
      makeDrawdownYear(2025, 0, noDraw),
      makeDrawdownYear(2026, 40_000, rothDraw),
    ];
    applyTaxIntegrationToDrawdownYears(noConv, [], [], [makeLedgerAccount('roth', 0, 200_000, { accountType: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH' })], mkCtx(false), REAL_BUNDLE);

    // INCOME: the converted principal is basis, so the year-2 draw adds no ordinary income, unlike the no-credit run.
    expect(withConv[2].magiCents ?? 0).toBeLessThan(noConv[2].magiCents ?? 0);
    expect(withConv[2].federalTaxCents ?? 0).toBeLessThan(
      noConv[2].federalTaxCents ?? 0,
    );
    // PENALTY: both owe 10% pre-59½ (no-credit on earnings, credited on in-window converted principal).
    expect(noConv[2].earlyWithdrawalPenaltyCents ?? 0).toBeGreaterThan(0);
    expect(withConv[2].earlyWithdrawalPenaltyCents ?? 0).toBeGreaterThan(0);

    // A 2031 draw (six tax years after the conversion) is outside the window, so it is penalty-free too.
    const laterDraw: DrawdownYear[] = [
      { ...makeDrawdownYear(2024, 0, noDraw), rothConvertedCents: 50_000 * 100 },
      ...[2025, 2026, 2027, 2028, 2029, 2030].map((y) => makeDrawdownYear(y, 0, noDraw)),
      makeDrawdownYear(2031, 40_000, rothDraw),
    ];
    applyTaxIntegrationToDrawdownYears(
      laterDraw,
      [],
      [],
      [
        makeLedgerAccount('roth', 0, 200_000, {
          accountType: 'RETIREMENT_ROTH_IRA',
          taxTreatment: 'ROTH',
        }),
      ],
      mkCtx(true),
      REAL_BUNDLE,
    );
    expect(laterDraw[laterDraw.length - 1].earlyWithdrawalPenaltyCents ?? 0).toBe(0);
  });

  it('a year-Y conversion drives a Y+2 IRMAA surcharge via the 2-year look-back', () => {
    // Born 1955 (71 in 2026): a large year-0 conversion raises year-0 MAGI, which the 2-year look-back surfaces as a 2028
    // surcharge; without it the household stays under the first IRMAA tier.
    const accountProjections = [
      { id: 'ira', taxTreatment: 'PRE_TAX' as const, accountType: 'RETIREMENT_IRA' },
    ];
    const balances = new Map([['ira', makeAccountBalance(2_000_000, 10_000)]]);
    const ssRows = Array.from({ length: 36 }, (_, k) => ({
      year: 2026 + Math.floor(k / 12),
      month0: k % 12,
      total: 40_000,
      primary: 40_000,
    }));
    const ctx = makeCtx({ primaryBirthdate: '1955-01-01', primaryRetirementYear: 2026, accountProjections });
    const ledger = [makeLedgerAccount('ira', 2_000_000)];

    const mkYears = (conv0: number): DrawdownYear[] => [
      { ...makeDrawdownYear(2026, 10_000, balances), rothConvertedCents: conv0 },
      makeDrawdownYear(2027, 10_000, balances),
      makeDrawdownYear(2028, 10_000, balances),
    ];

    const noConv = mkYears(0);
    applyTaxIntegrationToDrawdownYears(noConv, ssRows, [], ledger, ctx, REAL_BUNDLE);
    const withConv = mkYears(200_000 * 100);
    applyTaxIntegrationToDrawdownYears(withConv, ssRows, [], ledger, ctx, REAL_BUNDLE);

    expect(withConv[0].magiCents!).toBeGreaterThan(noConv[0].magiCents!);
    expect(withConv[2].irmaaSurchargeCents ?? 0).toBeGreaterThan(noConv[2].irmaaSurchargeCents ?? 0);
    expect(withConv[2].irmaaSurchargeCents ?? 0).toBeGreaterThan(0);
  });

  it('a conversion phases out the senior bonus, pulls NII over the NIIT threshold, and raises ACA MAGI', () => {
    // A 65+ household with brokerage NII: a large conversion phases out the 2025-28 senior bonus, pulls MAGI over the NIIT
    // threshold and raises the ACA-style MAGI; assert each against the no-conversion baseline.
    const accountProjections = [
      { id: 'ira', taxTreatment: 'PRE_TAX' as const, accountType: 'RETIREMENT_IRA' },
      { id: 'brok', taxTreatment: 'POST_TAX' as const, accountType: 'BROKERAGE' },
    ];
    const balances = new Map([
      ['ira', makeAccountBalance(2_000_000, 20_000)],
      ['brok', makeAccountBalance(1_000_000, 0)],
    ]);
    const ctx = makeCtx({ primaryBirthdate: '1958-01-01', primaryRetirementYear: 2026, accountProjections });
    const ledger = [
      makeLedgerAccount('ira', 2_000_000),
      makeLedgerAccount('brok', 0, 1_000_000, { accountType: 'BROKERAGE', taxTreatment: 'POST_TAX' }),
    ];

    const noConv: DrawdownYear[] = [makeDrawdownYear(2026, 20_000, balances)];
    applyTaxIntegrationToDrawdownYears(noConv, [], [], ledger, ctx, REAL_BUNDLE);
    const withConv: DrawdownYear[] = [
      { ...makeDrawdownYear(2026, 20_000, balances), rothConvertedCents: 300_000 * 100 },
    ];
    applyTaxIntegrationToDrawdownYears(withConv, [], [], ledger, ctx, REAL_BUNDLE);

    expect(withConv[0].magiCents!).toBeGreaterThan(noConv[0].magiCents! + 250_000 * 100);
    // The conversion lifts federal tax beyond a flat-rate bump (senior-bonus phase-out and NIIT both bite).
    const flatRateFloor = noConv[0].federalTaxCents! + 300_000 * 100 * 0.1;
    expect(withConv[0].federalTaxCents!).toBeGreaterThan(flatRateFloor);
    expect(withConv[0].earlyWithdrawalPenaltyCents ?? 0).toBe(noConv[0].earlyWithdrawalPenaltyCents ?? 0);
  });
});

describe('simulateDrawdown × real buildTaxCashflowHook — Fill conversion golden', () => {
  function series(startYear: number, horizonYear: number, monthly: number) {
    const months = (horizonYear - startYear + 1) * 12;
    return { startYear, startMonthIndex: 0, values: new Float64Array(months).fill(monthly) };
  }
  function acct(o: Partial<DrawdownAccountInput> & { id: string }, sy: number, hy: number): DrawdownAccountInput {
    return {
      initialPre: 0,
      initialPost: 0,
      annualRatePct: 0,
      taxTreatment: 'PRE_TAX',
      accountType: 'RETIREMENT_IRA',
      depositsByMonth: series(sy, hy, 0),
      ...o,
    };
  }

  it('converts an exact pinned amount filling the IRMAA ceiling from real-solver MAGI', () => {
    // Single year 2024, $0 SS, $40k/yr from a large IRA, $100k IRMAA ceiling: the solver fills the conversion so realized MAGI
    // lands at $100k ($40k pre-tax draw + ~$60k conversion); a cap-safe brokerage funds the conversion's tax.
    const ctx = makeCtx({ primaryBirthdate: '1960-01-01', primaryRetirementYear: 2024 });
    const hook = buildTaxCashflowHook({
      ctx, ssRows: [], nonSsIncomeRows: [], ledgerAccounts: [],
      bundle: REAL_BUNDLE, retirementYear: 2024,
    });
    const accounts = [
      acct({ id: 'ira', initialPre: 5_000_000 }, 2024, 2024),
      acct({ id: 'brok', initialPost: 500_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }, 2024, 2024),
      acct({ id: 'roth', initialPost: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2024, 2024),
    ];
    const magiCapWindow: MagiCapWindow = {
      start: { kind: 'retirementStart' },
      end: { kind: 'age', memberId: 'primary', years: 75, months: 0 },
      magiCeilingAnnualDollars: 100_000,
      capMode: 'fill',
      capMagiLine: 'irmaa',
      targetRothAccountId: 'roth',
    };
    const input: DrawdownInput = {
      portfolioAtRetirement: 0,
      ratePct: 0,
      expensesByMonth: series(2024, 2024, 40_000 / 12),
      incomeByMonth: series(2024, 2024, 0),
      depositsByMonth: series(2024, 2024, 0),
      retirementYear: 2024,
      horizonYear: 2024,
      withdrawalStrategy: { kind: 'taxEfficient' },
      accounts,
      taxCashflow: hook,
      magiCapWindows: singleMagiCapWindow(magiCapWindow, 2050),
    };
    const out = simulateDrawdown(input);
    // taxEfficient draws the $40k from the brokerage first, so only its small LTCG raises withdrawals-only MAGI; the solver then
    // fills to the $100k ceiling, pinned to the exact cent (rounded down).
    expect(out.years[0].rothConvertedCents).toBe(7_999_954);
  });
});

describe('buildTaxCashflowHook — credit applied to premiums', () => {
  // A single filer aged 63 with $31,300 of SS and a $7,200 benchmark gets a $5,134.20 credit with no federal tax or IRMAA to
  // offset.
  const cashLike = (target: number): TaxCashflowYearClassification => ({
    preTaxDollars: 0,
    postTaxNonRothDollars: 0,
    postTaxCashLikeDollars: target,
    rothDollars: 0,
    fundedDollars: target,
  });

  function hookFor(medicalExpenseByMonthCents?: ReadonlyArray<number>) {
    const ctx = makeCtx({ primaryBirthdate: '1963-01-01', primaryRetirementYear: 2026 });
    (ctx.resolvedScenario as { acaPtcBenchmark: unknown }).acaPtcBenchmark = [
      { taxYear: 2026, annualSlcspDollars: 7_200 },
    ];
    return buildTaxCashflowHook({
      ctx,
      ssRows: Array.from({ length: 12 }, (_, m) => ({
        year: 2026,
        month0: m,
        total: 31_300,
        primary: 31_300,
      })),
      nonSsIncomeRows: [],
      ledgerAccounts: [],
      bundle: REAL_BUNDLE,
      retirementYear: 2026,
      ...(medicalExpenseByMonthCents !== undefined ? { medicalExpenseByMonthCents } : {}),
    });
  }

  const medicalPerMonth = Array.from({ length: 12 }, () => 60_000); // $7,200 a year

  it('lowers the draw by the line and reports it on the outcome', () => {
    const outcome = hookFor(medicalPerMonth).solveForYear(0, 39_900, cashLike);
    expect(outcome.acaCreditAppliedToPremiumsCents).toBe(513_420);
    expect(outcome.totalTaxCashflowNeedCents).toBe(0);
    expect(outcome.addedNeedDollars).toBeCloseTo(-5_134.2, 6);
  });

  it('a conversion\'s funded tax is the same with and without an excess credit', () => {
    // The two zero-need funding solves behind fundConversionTaxForYear carry no medical cap: with one, the conversion would
    // lower the credit and read as extra tax.
    const withExcess = hookFor(medicalPerMonth);
    const without = hookFor();
    withExcess.solveForYear(0, 39_900, cashLike);
    without.solveForYear(0, 39_900, cashLike);
    const funded = (hook: ReturnType<typeof hookFor>): number =>
      hook.fundConversionTaxForYear!(0, cashLike(39_900), 10_000);
    expect(funded(withExcess)).toBe(funded(without));
  });
});
