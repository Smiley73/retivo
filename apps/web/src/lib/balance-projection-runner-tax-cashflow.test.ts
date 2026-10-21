/**
 * Tests for the tax-cashflow runner wiring: `buildTaxCashflowHook`
 * (the hook the drawdown engine calls to fund federal tax + IRMAA cash − ACA
 * PTC into the year's withdrawal target) and the all-pre-tax annotation
 * contract for rows without a per-account map.
 *
 * Split from `balance-projection-runner-tax.test.ts` for the 800-ln file cap;
 * shares `PipelineContext` builders via
 * `balance-projection-runner-tax-test-fixtures.ts`.
 */
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

// ---------------------------------------------------------------------------
// buildTaxCashflowHook — funds tax cashflow into the engine target
// ---------------------------------------------------------------------------

/** All-pre-tax classifier for the hook tests. */
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
    // $80k pre-tax draw in 2024 owes federal tax → positive cashflow need.
    const outcome = hook.solveForYear(0, 80_000, allPreTax);
    expect(outcome.federalTaxCashNeedCents).toBeGreaterThan(0);
    expect(outcome.addedNeedDollars).toBeGreaterThan(0);
    expect(outcome.totalTaxCashflowNeedCents).toBeGreaterThan(0);
  });

  it('withholds IRMAA from the member own SS when receiving their own benefit (no cash need)', () => {
    // Member age 71 in 2026 (on Medicare), receiving their OWN $40k SS → IRMAA
    // withheld from that benefit. A magiBootstrap seeds the year-0 IRMAA
    // look-back so the surcharge fires in the same year SS is available.
    const ctx = makeCtx({
      primaryBirthdate: '1955-01-01',
      primaryRetirementYear: 2026,
      magiBootstrapLookbackMinus2: 300_000,
      magiBootstrapLookbackMinus1: 300_000,
    });
    const hook = buildTaxCashflowHook({
      ctx,
      // grossSsForYear divides the 12-month run-rate sum by 12 → $40k/yr; the
      // whole benefit is the primary's own SS.
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
    // Medicare member (age 71 in 2026) receiving their OWN $40k SS → the IRMAA
    // surcharge is WITHHELD from that benefit (not a cash tax payment). The
    // withholding shrinks the member's SS check, so the spendable SS the
    // drawdown spends is gross − withheld. Because the income series spends
    // GROSS SS, the withheld amount must raise the portfolio draw by exactly
    // its value (addedNeedDollars = federal-tax cash + IRMAA cash + IRMAA
    // withheld). Pre-fix the withheld portion never reached the draw, so the
    // withheld IRMAA was phantom spendable income (balances overstated).
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
    // addedNeedDollars (the engine draw add-on) includes the withheld IRMAA:
    // it equals the cash tax need PLUS the withheld portion.
    const expectedAddedCents =
      outcome.totalTaxCashflowNeedCents + outcome.irmaaWithheldFromSsCents;
    expect(outcome.addedNeedDollars).toBeCloseTo(expectedAddedCents / 100, 2);
    // The withheld portion is strictly positive, so the draw add-on is strictly
    // greater than the cash-only need (no double-count: exactly cash + withheld).
    expect(outcome.addedNeedDollars).toBeGreaterThan(
      outcome.totalTaxCashflowNeedCents / 100,
    );

    // MAGI / §86 SS taxation are still computed on GROSS SS, never net of the
    // withheld surcharge. The one feedback the solver DOES apply: the
    // extra portfolio draw that funds the withheld surcharge is itself taxable
    // pre-tax income, so federal tax for the withheld year is STRICTLY HIGHER
    // than an otherwise-identical year with no IRMAA surcharge (same gross SS,
    // same ordinary draw, IRMAA look-back absent). Use a fresh hook without the
    // magiBootstrap so IRMAA is skipped (year 0, no look-back).
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
    // The withheld-funded draw is taxed → higher federal tax than the
    // no-surcharge baseline (the withheld → MAGI feedback).
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
    // Primary is on Medicare (age 71 in 2026) but has NOT claimed their own SS;
    // the secondary IS collecting a $40k SS benefit but is NOT yet on Medicare
    // (age 62 in 2026). The primary's surcharge is a CASH need — it must
    // NOT be withheld from the secondary's SS. Withholding it from the
    // secondary's benefit would understate the cash need and overstate
    // projected balances.
    const ctx = makeCtx({
      primaryBirthdate: '1955-01-01',
      secondaryBirthdate: '1964-01-01',
      primaryRetirementYear: 2026,
      magiBootstrapLookbackMinus2: 300_000,
      magiBootstrapLookbackMinus1: 300_000,
    });
    const hook = buildTaxCashflowHook({
      ctx,
      // The entire household SS run-rate is the secondary's own benefit; the
      // Medicare member (primary) has $0 own SS this year.
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
    // Pre-Medicare retiree with ACA coverage and a low draw — the PTC offset
    // can exceed federal tax but the need floors at zero.
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
    // Primary born 1900 with default life expectancy → dead well before 2030.
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
    // Pre-65 primary (age 60 in 2024) with `hsaQualifiedMedicalExpensePct: 90`
    // (10% nonqualified). No `hsaMedicalQualifiedDollars` is supplied, so this
    // synthetic draw is the EMERGENCY HSA case the percentage governs (modeled
    // medical-qualified withdrawals are always 100% qualified).
    // The solver classifies the whole draw into the cash-like
    // bucket (HSA + SAVINGS principal). Only the HSA balance share funds the
    // 20% tax; feeding the WHOLE bucket to the HSA leg would wrongly tax the
    // savings principal as nonqualified HSA income + 20%.
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

    // HSA $50k + savings $50k → HSA balance share is 50%.
    const mixedHook = buildTaxCashflowHook({
      ...baseArgs,
      ledgerAccounts: [
        makeLedgerAccount('hsa1', 0, 50_000, { accountType: 'HSA', taxTreatment: 'HSA' }),
        makeLedgerAccount('sav1', 0, 50_000, { accountType: 'SAVINGS', taxTreatment: 'POST_TAX' }),
      ],
    });
    const mixed = mixedHook.solveForYear(0, 40_000, cashLike);

    // Savings-only (no HSA ledger) → no HSA nonqualified tax at all.
    const savingsHook = buildTaxCashflowHook({
      ...baseArgs,
      ledgerAccounts: [
        makeLedgerAccount('sav1', 0, 50_000, { accountType: 'SAVINGS', taxTreatment: 'POST_TAX' }),
      ],
    });
    const savingsOnly = savingsHook.solveForYear(0, 40_000, cashLike);

    // All-HSA ledger ($100k HSA) → the whole bucket is the HSA nonqualified basis.
    const allHsaHook = buildTaxCashflowHook({
      ...baseArgs,
      ledgerAccounts: [
        makeLedgerAccount('hsa1', 0, 100_000, { accountType: 'HSA', taxTreatment: 'HSA' }),
      ],
    });
    const allHsa = allHsaHook.solveForYear(0, 40_000, cashLike);

    // Cash-like principal is $0 ordinary income, so the ONLY tax in these years
    // is the HSA 20% nonqualified additional tax. Savings-only → $0.
    expect(savingsOnly.federalTaxCashNeedCents).toBe(0);
    // All-HSA: $40k draw × 10% nonqualified × 20% = $800.
    expect(allHsa.federalTaxCashNeedCents).toBe(800 * 100);
    // Mixed 50/50: only the HSA half is the basis → $20k × 10% × 20% = $400 —
    // exactly half the all-HSA figure, proving savings principal is excluded.
    expect(mixed.federalTaxCashNeedCents).toBe(400 * 100);
  });

  it('the committed classification covers the withheld-IRMAA portion of the '
    + 'funded draw → the Roth earnings penalty includes the withheld leg', () => {
    // Two-member household so a withheld-IRMAA year can coincide with a pre-59½
    // early-withdrawal penalty (the two age windows — Medicare 65, penalty 59½ —
    // are disjoint within one member). Primary age 67 in 2026 (on Medicare,
    // receiving their OWN $40k SS → the IRMAA surcharge is WITHHELD from that
    // benefit). The Roth IRA is owned by the SECONDARY, age 58 (pre-59½), with
    // $0 §408A basis so the whole Roth draw is penalizable earnings.
    //
    // The funded draw the solver settles on is `ordinaryNeed + cashTaxNeed +
    // withheldIrmaa`. The committed classification must classify that SAME
    // full draw so the Roth earnings/penalty basis includes the withheld portion.
    // `committedTarget` must include the withheld cents: omitting them would
    // make `classify` see a smaller Roth draw and the funded penalty would
    // under-count the withheld leg.
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
    // Primary's own $40k SS → the surcharge is withheld from it (no cash need).
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

    // The surcharge is genuinely withheld from SS (not a cash need) in this year.
    expect(withheld.irmaaWithheldFromSsCents).toBeGreaterThan(0);
    expect(withheld.irmaaCashNeedCents).toBe(0);

    // Baseline: identical household + draw but NO IRMAA look-back (no surcharge),
    // so there is no withheld leg folded into the committed target.
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

    // The committed classification now covers the withheld-funded draw, so the
    // withheld year classifies MORE Roth earnings than the no-surcharge baseline
    // — the federal-tax cash need (income tax on the earnings + the 10% Roth
    // penalty on the larger committed basis) is strictly higher. Pre-fix the
    // withheld portion was excluded from the committed split, so the funded
    // penalty was the same as the baseline.
    expect(withheld.federalTaxCashNeedCents).toBeGreaterThan(
      noIrmaa.federalTaxCashNeedCents,
    );
  });
});

// ---------------------------------------------------------------------------
// Fill-mode conversion solve through the REAL hook — the outer
// bisection wrapping the inner tax surface, against actual MAGI on the line.
// ---------------------------------------------------------------------------

/** A withdrawal classification with `preTaxDollars` ordinary draw + nothing
 *  else (the conv=0 MAGI basis for the conversion solve). */
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
    // $40k of pre-tax withdrawals already, ceiling $100k, plenty of room.
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
    // $120k withdrawn already, ceiling $100k → no headroom.
    expect(hook.solveFillConversionForYear!(0, preTaxWithdrawals(120_000), 50_000, 'irmaa', 100_000)).toBe(0);
  });

  it('IRMAA Y+2 anchor: a year-Y conversion raises the year-Y MAGI that drives the Y+2 surcharge', () => {
    // Medicare-age household: the conversion solve targets the federal/IRMAA
    // line; the higher year-Y MAGI it realizes is what the 2-year look-back
    // surfaces as a surcharge in Y+2. Here we assert the solve fills against the
    // ceiling (the Y+2 tier the user pinned as their ceiling).
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
    // ACA MAGI adds back the nontaxable SS portion, so the same ceiling is hit
    // with LESS conversion on the ACA line.
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

// ---------------------------------------------------------------------------
// Conversion ordinary income reaches the displayed tax surface
// ---------------------------------------------------------------------------

describe('applyTaxIntegrationToDrawdownYears — Roth conversion ordinary income', () => {
  it('raises the displayed federal tax + MAGI by the converted amount (not a §72(t) penalty)', () => {
    const accountProjections = [
      { id: 'ira', taxTreatment: 'PRE_TAX' as const, accountType: 'RETIREMENT_IRA' },
    ];
    const balances = new Map([['ira', makeAccountBalance(500_000, 30_000)]]);
    const ctx = makeCtx({ primaryBirthdate: '1960-01-01', primaryRetirementYear: 2024, accountProjections });

    // Same $30k pre-tax withdrawal; one year additionally converts $40k.
    const noConv: DrawdownYear[] = [makeDrawdownYear(2024, 30_000, balances)];
    applyTaxIntegrationToDrawdownYears(noConv, [], [], [makeLedgerAccount('ira', 500_000)], ctx, REAL_BUNDLE);

    const withConv: DrawdownYear[] = [{ ...makeDrawdownYear(2024, 30_000, balances), rothConvertedCents: 40_000 * 100 }];
    applyTaxIntegrationToDrawdownYears(withConv, [], [], [makeLedgerAccount('ira', 500_000)], ctx, REAL_BUNDLE);

    // The conversion adds $40k of ordinary income → higher MAGI + federal tax.
    expect(withConv[0].magiCents!).toBeCloseTo(noConv[0].magiCents! + 40_000 * 100, -2);
    expect(withConv[0].federalTaxCents!).toBeGreaterThan(noConv[0].federalTaxCents!);
    // The conversion is NOT a distribution → no §72(t) early-withdrawal penalty
    // is added (the member is 64 in 2024, pre-59½ is not even at issue here, but
    // the penalty stays $0 because the conversion never enters penaltyAccounts).
    expect(withConv[0].earlyWithdrawalPenaltyCents ?? 0).toBe(noConv[0].earlyWithdrawalPenaltyCents ?? 0);
  });

  it('credits converted principal as a DATED conversion lot: never re-taxed as income, but recaptured inside its five-tax-year window', () => {
    // A pre-59½ household (born 1975 → age 49 in 2024) with ZERO seeded Roth
    // basis. Year 0 converts $50k into the target Roth; a year-2 Roth-IRA
    // withdrawal of $40k comes out of that CONVERSION basis, so it is never
    // re-taxed as ordinary income — but the conversion started its own
    // five-taxable-year §408A(d)(3)(F) clock, and 2026 is inside it, so the
    // withdrawal DOES carry the 10% recapture (crediting the conversion as
    // undated basis would let exactly this withdrawal escape recapture).
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

    // WITH the conversion credit: year 0 converts $50k; year 2 draws $40k Roth.
    const withConv: DrawdownYear[] = [
      { ...makeDrawdownYear(2024, 0, noDraw), rothConvertedCents: 50_000 * 100 },
      makeDrawdownYear(2025, 0, noDraw),
      makeDrawdownYear(2026, 40_000, rothDraw),
    ];
    applyTaxIntegrationToDrawdownYears(withConv, [], [], [makeLedgerAccount('roth', 0, 200_000, { accountType: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH' })], mkCtx(true), REAL_BUNDLE);

    // WITHOUT the conversion (no target Roth → no credit): same $40k Roth draw.
    const noConv: DrawdownYear[] = [
      makeDrawdownYear(2024, 0, noDraw),
      makeDrawdownYear(2025, 0, noDraw),
      makeDrawdownYear(2026, 40_000, rothDraw),
    ];
    applyTaxIntegrationToDrawdownYears(noConv, [], [], [makeLedgerAccount('roth', 0, 200_000, { accountType: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH' })], mkCtx(false), REAL_BUNDLE);

    // INCOME: the converted principal is basis, so the year-2 draw adds no
    // ordinary income — unlike the no-credit run, where the whole $40k is earnings.
    expect(withConv[2].magiCents ?? 0).toBeLessThan(noConv[2].magiCents ?? 0);
    expect(withConv[2].federalTaxCents ?? 0).toBeLessThan(
      noConv[2].federalTaxCents ?? 0,
    );
    // PENALTY: both runs owe 10% pre-59½ — the no-credit run on earnings, the
    // credited run on the in-window taxable converted principal (the recapture).
    expect(noConv[2].earlyWithdrawalPenaltyCents ?? 0).toBeGreaterThan(0);
    expect(withConv[2].earlyWithdrawalPenaltyCents ?? 0).toBeGreaterThan(0);

    // OUTSIDE the window (a 2031 draw, six tax years after the 2024 conversion):
    // the same converted principal is now penalty-free as well.
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
    // Medicare-age household (born 1955 → 71 in 2026). A large year-0 conversion
    // raises year-0 MAGI; IRMAA's 2-year look-back surfaces that as a Y+2 (2028)
    // surcharge. Without the conversion the same household stays under the first
    // IRMAA tier → no surcharge.
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

    // The conversion raises year-0 (2026) MAGI → a Y+2 (2028) IRMAA surcharge
    // the no-conversion baseline does not incur.
    expect(withConv[0].magiCents!).toBeGreaterThan(noConv[0].magiCents!);
    expect(withConv[2].irmaaSurchargeCents ?? 0).toBeGreaterThan(noConv[2].irmaaSurchargeCents ?? 0);
    expect(withConv[2].irmaaSurchargeCents ?? 0).toBeGreaterThan(0);
  });

  it('a conversion phases out the senior bonus, pulls NII over the NIIT threshold, and raises ACA MAGI', () => {
    // A 65+ household with taxable brokerage yield (NII). A large conversion
    // raises conversion-inclusive MAGI enough to (a) phase out the 2025-28 senior
    // bonus deduction, (b) pull MAGI over the NIIT threshold so the brokerage
    // NII is taxed, and (c) raise the post-pass ACA-style MAGI. Assert each
    // needle moves versus the no-conversion baseline.
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

    // ACA-style / post-pass MAGI rises by ~the converted amount.
    expect(withConv[0].magiCents!).toBeGreaterThan(noConv[0].magiCents! + 250_000 * 100);
    // The conversion ordinary income raises federal tax well beyond a flat-rate
    // bump (senior-bonus phase-out + NIIT on the brokerage NII both bite).
    const flatRateFloor = noConv[0].federalTaxCents! + 300_000 * 100 * 0.1;
    expect(withConv[0].federalTaxCents!).toBeGreaterThan(flatRateFloor);
    // NOT a §72(t) distribution → no early-withdrawal penalty added.
    expect(withConv[0].earlyWithdrawalPenaltyCents ?? 0).toBe(noConv[0].earlyWithdrawalPenaltyCents ?? 0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end engine ↔ solver golden: simulateDrawdown driving the REAL
// buildTaxCashflowHook converts an exact pinned amount in a cliff-landing year.
// ---------------------------------------------------------------------------

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
    // Single year (2024), $0 SS, $40k/yr spending from a large IRA, $100k IRMAA
    // ceiling. The real solver fills the conversion so realized federal/IRMAA
    // MAGI lands AT $100k: $40k pre-tax draw + ~$60k conversion. A cap-safe
    // brokerage funds the conversion's incremental tax. The converted amount is
    // a deterministic engine↔solver golden — pinned exactly.
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
    // taxEfficient draws the $40k spending from the taxable brokerage first
    // (so pre-tax withdrawals are ~$0 and only the small brokerage LTCG raises
    // withdrawals-only MAGI). The real solver then fills the conversion so
    // realized federal/IRMAA MAGI lands AT the $100k ceiling — a deterministic
    // engine↔solver golden pinned to the exact cent (rounded DOWN).
    expect(out.years[0].rothConvertedCents).toBe(7_999_954);
  });
});

// ---------------------------------------------------------------------------
// buildTaxCashflowHook — credit applied to premiums
// ---------------------------------------------------------------------------

describe('buildTaxCashflowHook — credit applied to premiums', () => {
  // A single filer aged 63 with $31,300 of Social Security and a $7,200
  // benchmark: ACA MAGI is 200.0% of the poverty guideline, the credit is
  // $5,134.20 and there is no federal tax or IRMAA to offset. Savings principal
  // draws add no income, so the credit does not move with the draw.
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

  it('keeps the draw bounded below by minus the ordinary need', () => {
    const outcome = hookFor(medicalPerMonth).solveForYear(0, 2_700, cashLike);
    expect(outcome.acaCreditAppliedToPremiumsCents).toBe(270_000);
    expect(outcome.addedNeedDollars).toBeCloseTo(-2_700, 6);
  });

  it('applies nothing without a medical series', () => {
    const outcome = hookFor().solveForYear(0, 39_900, cashLike);
    expect(outcome.acaCreditAppliedToPremiumsCents).toBe(0);
    expect(outcome.addedNeedDollars).toBe(0);
  });

  it('a conversion\'s funded tax is the same with and without an excess credit', () => {
    // The two zero-need funding solves behind `fundConversionTaxForYear` carry
    // no medical cap: with one, the conversion would lower the credit and the
    // line with it, and the difference would read as extra tax.
    const withExcess = hookFor(medicalPerMonth);
    const without = hookFor();
    withExcess.solveForYear(0, 39_900, cashLike);
    without.solveForYear(0, 39_900, cashLike);
    const funded = (hook: ReturnType<typeof hookFor>): number =>
      hook.fundConversionTaxForYear!(0, cashLike(39_900), 10_000);
    expect(funded(withExcess)).toBe(funded(without));
  });
});
