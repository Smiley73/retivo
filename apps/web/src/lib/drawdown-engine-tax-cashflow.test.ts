/** Engine-level tests for the `DrawdownInput.taxCashflow` hook, driven with a stub hook so assertions stay isolated from the full tax calibration. */
import { describe, it, expect } from 'vitest';
import { simulateDrawdown } from './drawdown-engine';
import { singleMagiCapWindow } from './drawdown-engine-per-account-magi-cap';
import type {
  DrawdownAccountInput,
  DrawdownInput,
  TaxCashflowHook,
  TaxCashflowYearClassification,
  TaxCashflowYearOutcome,
} from './drawdown-engine-types';
import type { MonthlyCashflowSeries } from './monthly-cashflow';
import type { RmdContextInput } from './drawdown-engine-types';
import { RMD_DIVISORS } from './rmd-divisors';

function zeros(startYear: number, horizonYear: number): MonthlyCashflowSeries {
  const months = (horizonYear - startYear + 1) * 12;
  return { startYear, startMonthIndex: 0, values: new Float64Array(months) };
}

function uniform(startYear: number, horizonYear: number, monthly: number): MonthlyCashflowSeries {
  const months = (horizonYear - startYear + 1) * 12;
  return { startYear, startMonthIndex: 0, values: new Float64Array(months).fill(monthly) };
}

function lumpMonth0(startYear: number, horizonYear: number, amount: number): MonthlyCashflowSeries {
  const months = (horizonYear - startYear + 1) * 12;
  const values = new Float64Array(months);
  values[0] = amount;
  return { startYear, startMonthIndex: 0, values };
}

function account(
  o: Partial<DrawdownAccountInput> & { id: string },
  startYear: number,
  horizonYear: number,
): DrawdownAccountInput {
  return {
    initialPre: 0,
    initialPost: 0,
    annualRatePct: 0,
    taxTreatment: 'PRE_TAX',
    accountType: 'RETIREMENT_IRA',
    depositsByMonth: zeros(startYear, horizonYear),
    ...o,
  };
}

function flatTaxHook(taxPerYear: number): {
  hook: TaxCashflowHook;
  classifications: TaxCashflowYearClassification[];
} {
  const classifications: TaxCashflowYearClassification[] = [];
  const hook: TaxCashflowHook = {
    solveForYear: (
      _yearIndex: number,
      ordinaryNetNeed: number,
      classify: (t: number) => TaxCashflowYearClassification,
    ): TaxCashflowYearOutcome => {
      classifications.push(classify(ordinaryNetNeed + taxPerYear));
      return {
        addedNeedDollars: taxPerYear,
        federalTaxCashNeedCents: taxPerYear * 100,
        irmaaWithheldFromSsCents: 0,
        irmaaCashNeedCents: 0,
        acaPtcCashflowOffsetCents: 0,
        acaCreditAppliedToPremiumsCents: 0,
        totalTaxCashflowNeedCents: taxPerYear * 100,
        taxCashflowIterations: 2,
        taxCashflowConverged: true,
        taxCashflowShortfallCents: 0,
      };
    },
  };
  return { hook, classifications };
}

function baseInput(
  accounts: DrawdownAccountInput[],
  startYear: number,
  horizonYear: number,
  monthlyExpense: number,
  hook?: TaxCashflowHook,
): DrawdownInput {
  return {
    portfolioAtRetirement: 0,
    ratePct: 0,
    expensesByMonth: uniform(startYear, horizonYear, monthlyExpense),
    incomeByMonth: zeros(startYear, horizonYear),
    depositsByMonth: zeros(startYear, horizonYear),
    retirementYear: startYear,
    horizonYear,
    withdrawalStrategy: { kind: 'proportional' },
    accounts,
    taxCashflow: hook,
  };
}

describe('drawdown engine — tax cashflow', () => {
  it('federal tax increases the same-year withdrawal (per-account path)', () => {
    const accts = [account({ id: 'ira', initialPre: 1_000_000 }, 2040, 2040)];
    const noTax = simulateDrawdown(baseInput([...accts.map((a) => ({ ...a }))], 2040, 2040, 1_000));
    const accts2 = [account({ id: 'ira', initialPre: 1_000_000 }, 2040, 2040)];
    const { hook } = flatTaxHook(5_000);
    const withTax = simulateDrawdown(baseInput(accts2, 2040, 2040, 1_000, hook));
    // $12k ordinary + $5k tax = $17k withdrawn vs $12k.
    expect(withTax.years[0].withdrawn).toBeGreaterThan(noTax.years[0].withdrawn);
    expect(withTax.years[0].withdrawn).toBeCloseTo(noTax.years[0].withdrawn + 5_000, 0);
    expect(withTax.years[0].balance).toBeLessThan(noTax.years[0].balance);
    expect(withTax.years[0].federalTaxCashNeedCents).toBe(500_000);
    expect(withTax.years[0].totalTaxCashflowNeedCents).toBe(500_000);
  });

  it('a proportional single-pre-tax pool receives tax cashflow and the ending balance shifts', () => {
    const mk = (): DrawdownAccountInput[] => [
      account({ id: 'ira', initialPre: 500_000 }, 2040, 2040),
    ];
    const noTax = simulateDrawdown({
      ...baseInput(mk(), 2040, 2040, 2_000),
      withdrawalStrategy: { kind: 'proportional' },
    });
    const { hook } = flatTaxHook(8_000);
    const withTax = simulateDrawdown({
      ...baseInput(mk(), 2040, 2040, 2_000, hook),
      withdrawalStrategy: { kind: 'proportional' },
    });
    expect(withTax.years[0].withdrawn).toBeGreaterThan(noTax.years[0].withdrawn);
    expect(withTax.years[0].balance).toBeLessThan(noTax.years[0].balance);
    expect(withTax.years[0].totalTaxCashflowNeedCents).toBe(800_000);
  });

  it('depletes when the pool cannot fund the grossed-up tax draw', () => {
    // A tiny pool against a large tax need cannot supply the grossed-up draw, so the year reads depleted.
    const accts = [account({ id: 'ira', initialPre: 20_000 }, 2040, 2040)];
    const { hook } = flatTaxHook(50_000);
    const out = simulateDrawdown({
      ...baseInput(accts, 2040, 2040, 2_000, hook),
      withdrawalStrategy: { kind: 'proportional' },
    });
    // $24k ordinary + $50k tax = $74k target vs a $20k pool.
    expect(out.years[0].depleted).toBe(true);
    expect(out.years[0].withdrawn).toBeLessThan(out.years[0].netNeed);
  });

  it('classifies a single pre-tax draw as all pre-tax', () => {
    const accts = [account({ id: 'ira', initialPre: 500_000 }, 2040, 2040)];
    const { hook, classifications } = flatTaxHook(3_000);
    simulateDrawdown({
      ...baseInput(accts, 2040, 2040, 2_000, hook),
      withdrawalStrategy: { kind: 'proportional' },
    });
    expect(classifications[0].preTaxDollars).toBeGreaterThan(0);
    expect(classifications[0].postTaxNonRothDollars).toBe(0);
    expect(classifications[0].rothDollars).toBe(0);
  });

  it('depletion can move earlier once taxes are funded', () => {
    // A portfolio that barely covers 3 years of ordinary spending but not the added tax: depletion appears with tax and is
    // absent without.
    const mk = (): DrawdownAccountInput[] => [
      account({ id: 'ira', initialPre: 75_000 }, 2040, 2042),
    ];
    const noTax = simulateDrawdown(baseInput(mk(), 2040, 2042, 2_000));
    const { hook } = flatTaxHook(6_000);
    const withTax = simulateDrawdown(baseInput(mk(), 2040, 2042, 2_000, hook));
    // $24k/yr × 3 = $72k < $75k.
    expect(noTax.depletionYear).toBeNull();
    // +$6k/yr tax → $30k/yr depletes inside the horizon.
    expect(withTax.depletionYear).not.toBeNull();
  });

  it('routes tax-funding to taxable before capped pre-tax under a MAGI cap', () => {
    // taxEfficient draws POST_TAX first; under a MAGI cap the tax-funding portion still prefers taxable, so there is no breach
    // while taxable can cover it.
    const start = 2040;
    const horizon = 2040;
    const accts: DrawdownAccountInput[] = [
      account({ id: 'brok', initialPre: 0, initialPost: 200_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }, start, horizon),
      account({ id: 'ira', initialPre: 200_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, start, horizon),
    ];
    const { hook } = flatTaxHook(10_000);
    const out = simulateDrawdown({
      ...baseInput(accts, start, horizon, 1_000, hook),
      withdrawalStrategy: { kind: 'taxEfficient' },
      magiCapWindows: singleMagiCapWindow(
        { start: { kind: 'retirementStart' }, end: { kind: 'age', memberId: 'primary', years: 200, months: 0 }, magiCeilingAnnualDollars: 5_000, capMode: 'minimize', capMagiLine: 'irmaa' },
        9999,
      ),
    });
    // Ordinary $12k + tax $10k = $22k, all coverable from the $200k taxable bucket.
    expect(out.years[0].magiCapBreachDollars ?? 0).toBe(0);
  });

  it('cap-aware TRIAL classifier diverts over-cap pre-tax to taxable', () => {
    // rothFirst tier order [Roth, PRE_TAX, taxable]: without cap-awareness the trial would drain the PRE_TAX IRA before the
    // brokerage and classify the whole $22k as pre-tax, overstating tax; with the cap threaded in, only $5k is pre-tax.
    const start = 2040;
    const horizon = 2040;
    const accts: DrawdownAccountInput[] = [
      account({ id: 'ira', initialPre: 200_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, start, horizon),
      account({ id: 'brok', initialPre: 0, initialPost: 200_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }, start, horizon),
    ];
    const { hook, classifications } = flatTaxHook(10_000);
    simulateDrawdown({
      ...baseInput(accts, start, horizon, 1_000, hook),
      withdrawalStrategy: { kind: 'rothFirst' },
      magiCapWindows: singleMagiCapWindow(
        { start: { kind: 'retirementStart' }, end: { kind: 'age', memberId: 'primary', years: 200, months: 0 }, magiCeilingAnnualDollars: 5_000, capMode: 'minimize', capMagiLine: 'irmaa' },
        9999,
      ),
    });
    const cls = classifications[0];
    expect(cls.preTaxDollars).toBeLessThanOrEqual(5_000 + 1e-6);
    expect(cls.postTaxNonRothDollars).toBeGreaterThan(0);
  });

  it('uses the post-RMD pre-tax pool exactly once in the trial classifier', () => {
    // The RMD pre-pass mutates the live run state before the trial classifier runs, so the classifier's state is already
    // post-RMD; subtracting the RMD-forced pre-tax a second time would understate the pre-tax pool and the trial's funded
    // classification against the committing draw.
    const start = 2040;
    const horizon = 2040;
    // Owner born 1950: RMD trigger age 73; age 90 in 2040 (divisor ~12.2).
    const ownerId = 'owner-1';
    const rmdContext: RmdContextInput = {
      ownerMeta: new Map([
        [ownerId, { isoBirthdate: '1950-01-01', deathYear: 2100 }],
      ]),
      ownerByAccountId: new Map([['ira', ownerId]]),
      rmdSnapshot: RMD_DIVISORS,
    };
    // A tight pool: the post-RMD pre-tax pool is less than the discretionary target, so a double subtraction would under-fund
    // the trial by exactly the RMD.
    const accts = [
      account(
        { id: 'ira', initialPre: 70_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' },
        start,
        horizon,
      ),
    ];
    const { hook, classifications } = flatTaxHook(60_000);
    const out = simulateDrawdown({
      ...baseInput(accts, start, horizon, 1_000, hook),
      withdrawalStrategy: { kind: 'proportional' },
      rmdContext,
    });
    const committedWithdrawn = out.years[0].withdrawn;
    const cls = classifications[0];
    // The whole pool is PRE_TAX, so the trial's funded and pre-tax classification must equal the committing draw (the post-RMD
    // pool consumed once).
    expect(cls.fundedDollars).toBeCloseTo(committedWithdrawn, 0);
    expect(cls.preTaxDollars).toBeCloseTo(committedWithdrawn, 0);
    expect(cls.fundedDollars).toBeCloseTo(70_000, 0);
  });

  it('trial classifies a same-year taxable deposit as taxable, not pre-tax', () => {
    // taxEfficient tier order [POST_TAX-non-Roth, PRE_TAX, Roth]: the brokerage starts empty but receives a $60k lump sum in
    // month 0, which the committing path applies before the withdrawal, so the $22k draw ($12k + $10k tax) comes from the
    // taxable brokerage. The trial must mirror the within-year deposit rather than drain the PRE_TAX IRA from year-start state.
    const start = 2040;
    const horizon = 2040;
    const accts: DrawdownAccountInput[] = [
      {
        ...account(
          { id: 'brok', initialPre: 0, initialPost: 0, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' },
          start,
          horizon,
        ),
        depositsByMonth: lumpMonth0(start, horizon, 60_000),
      },
      account({ id: 'ira', initialPre: 500_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, start, horizon),
    ];
    const { hook, classifications } = flatTaxHook(10_000);
    simulateDrawdown({
      ...baseInput(accts, start, horizon, 1_000, hook),
      withdrawalStrategy: { kind: 'taxEfficient' },
    });
    const cls = classifications[0];
    expect(cls.postTaxNonRothDollars).toBeGreaterThan(0);
    expect(cls.preTaxDollars).toBeLessThan(1);
  });

  it('breaches the cap once taxable depletes funding the tax draw', () => {
    // A small taxable bucket is consumed by ordinary spending, so the tax-funding portion forces a capped pre-tax draw and
    // breaches the cap.
    const start = 2040;
    const horizon = 2040;
    const accts: DrawdownAccountInput[] = [
      account({ id: 'brok', initialPre: 0, initialPost: 8_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }, start, horizon),
      account({ id: 'ira', initialPre: 500_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, start, horizon),
    ];
    const { hook } = flatTaxHook(10_000);
    const out = simulateDrawdown({
      ...baseInput(accts, start, horizon, 2_000, hook),
      withdrawalStrategy: { kind: 'taxEfficient' },
      // $5k pre-tax cap; ordinary $24k + tax $10k = $34k with only $8k taxable, so at least $26k comes from the capped IRA.
      magiCapWindows: singleMagiCapWindow(
        { start: { kind: 'retirementStart' }, end: { kind: 'age', memberId: 'primary', years: 200, months: 0 }, magiCeilingAnnualDollars: 5_000, capMode: 'minimize', capMagiLine: 'irmaa' },
        9999,
      ),
    });
    expect(out.years[0].magiCapBreachDollars ?? 0).toBeGreaterThan(0);
  });
});

function creditHook(line: number): TaxCashflowHook {
  return {
    solveForYear: (): TaxCashflowYearOutcome => ({
      addedNeedDollars: -line,
      federalTaxCashNeedCents: 0,
      irmaaWithheldFromSsCents: 0,
      irmaaCashNeedCents: 0,
      acaPtcCashflowOffsetCents: 0,
      acaCreditAppliedToPremiumsCents: line * 100,
      totalTaxCashflowNeedCents: 0,
      taxCashflowIterations: 1,
      taxCashflowConverged: true,
      taxCashflowShortfallCents: 0,
    }),
  };
}

describe('drawdown engine — credit applied to premiums (negative add-on)', () => {
  const ira = (): DrawdownAccountInput[] => [account({ id: 'ira', initialPre: 1_000_000 }, 2040, 2040)];

  it('lowers the same-year withdrawal by the line and stamps it on the row', () => {
    const base = simulateDrawdown(baseInput(ira(), 2040, 2040, 1_000));
    const credited = simulateDrawdown(baseInput(ira(), 2040, 2040, 1_000, creditHook(3_000)));
    expect(credited.years[0].withdrawn).toBeCloseTo(base.years[0].withdrawn - 3_000, 6);
    expect(credited.years[0].balance).toBeCloseTo(base.years[0].balance + 3_000, 6);
    expect(credited.years[0].acaCreditAppliedToPremiumsCents).toBe(300_000);
    expect(credited.years[0].depleted).toBe(false);
  });

  it('spreads the line over the months in proportion to each month\'s need and never goes negative', () => {
    // Spending only in the first six months: a line spread evenly over twelve months would drive the idle months negative.
    const expensesByMonth = uniform(2040, 2040, 2_000);
    expensesByMonth.values.fill(0, 6);
    const run = (hook?: TaxCashflowHook) =>
      simulateDrawdown({ ...baseInput(ira(), 2040, 2040, 0, hook), expensesByMonth });
    const base = run();
    const credited = run(creditHook(6_000));
    expect(base.years[0].withdrawn).toBeCloseTo(12_000, 6);
    expect(credited.years[0].withdrawn).toBeCloseTo(6_000, 6);
    // Each of the six spending months draws half as much; the rest stay at zero.
    const monthly = Array.from(credited.perMonthWithdrawal);
    for (let m = 0; m < 6; m += 1) expect(monthly[m]).toBeCloseTo(1_000, 6);
    for (let m = 6; m < 12; m += 1) expect(monthly[m]).toBe(0);
  });

  it('with no line the year is byte-identical to a run without the hook', () => {
    const base = simulateDrawdown(baseInput(ira(), 2040, 2040, 1_000));
    const zero = simulateDrawdown(baseInput(ira(), 2040, 2040, 1_000, creditHook(0)));
    expect(zero.years[0].withdrawn).toBe(base.years[0].withdrawn);
    expect(zero.years[0].balance).toBe(base.years[0].balance);
    expect(Array.from(zero.perMonthWithdrawal)).toEqual(Array.from(base.perMonthWithdrawal));
  });
});
