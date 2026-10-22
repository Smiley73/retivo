/**
 * The deterministic tax pass hands the scenario's medical inflation rate to
 * `applyTaxYear`; a production path that left the field absent would revert to
 * no growth without failing any engine test.
 */
import { describe, it, expect } from 'vitest';
import {
  applyTaxIntegrationToDrawdownYears,
  buildTaxCashflowHook,
} from './balance-projection-runner-tax';
import type { TaxCashflowYearClassification } from './drawdown-engine-types';
import {
  REAL_BUNDLE,
  makeCtx,
  makeDrawdownYear,
} from './balance-projection-runner-tax-test-fixtures';

const allPreTax = (target: number): TaxCashflowYearClassification => ({
  preTaxDollars: target,
  postTaxNonRothDollars: 0,
  postTaxCashLikeDollars: 0,
  rothDollars: 0,
  fundedDollars: target,
});

/** Born 1968 (age 60 in 2028), retired before 2028: on the Marketplace for all
 *  12 months. $33,000 of pre-tax income sits inside the credit's bands. */
const ctxWithRate = (medicalInflationRatePct: number | undefined) =>
  makeCtx({
    primaryBirthdate: '1968-01-01',
    primaryRetirementYear: 2028,
    medicalInflationRatePct,
  });

describe('medical inflation rate — deterministic tax pass', () => {
  it('the annotation pass grows the rough benchmark by exactly the medical factor', () => {
    const credit = (rate: number | undefined) => {
      const years = [makeDrawdownYear(2028, 33_000)];
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctxWithRate(rate), REAL_BUNDLE);
      return years[0].acaPtcSubsidyCents ?? 0;
    };
    const ungrown = credit(undefined);
    expect(ungrown).toBeGreaterThan(0);
    // Age-60 annual benchmark 840,000 × 1.06² = 943,824; the contribution is
    // unchanged, so the credit rises by exactly the benchmark's growth.
    expect(credit(6) - ungrown).toBe(943_824 - 840_000);
    expect(credit(0)).toBe(ungrown);
  });

  it('the funding solver prices the same grown benchmark as the annotation pass', () => {
    // The credit only offsets up to the year's tax cash need, so the draw sits
    // high enough in the bands that the credit stays below the tax it offsets.
    const offset = (rate: number | undefined) =>
      buildTaxCashflowHook({
        ctx: ctxWithRate(rate),
        ssRows: [],
        nonSsIncomeRows: [],
        ledgerAccounts: [],
        bundle: REAL_BUNDLE,
        retirementYear: 2028,
      }).solveForYear(0, 55_000, allPreTax).acaPtcCashflowOffsetCents;
    expect(offset(undefined)).toBeGreaterThan(0);
    expect(offset(6)).toBeGreaterThan(offset(undefined));
    expect(offset(6)).toBeGreaterThan(offset(2));
  });
});
