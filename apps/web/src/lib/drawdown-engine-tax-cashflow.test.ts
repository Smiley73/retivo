/**
 * Engine-level tests for the tax-cashflow integration: the
 * `DrawdownInput.taxCashflow` hook raises each year's withdrawal target so
 * federal tax + the IRMAA cash portion (minus the ACA PTC offset) are funded
 * from the portfolio on the per-account strategy path.
 *
 * These drive `simulateDrawdown` directly with a stub hook so the assertions
 * are deterministic and isolated from the full tax calibration; the solver's
 * own math is covered in `tax-cashflow-solver.test.ts` and the end-to-end
 * runner wiring in `balance-projection-runner-tax-cashflow.test.ts`.
 */
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

/** A deposit series carrying a single lump sum in month 0 of `startYear`. */
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

/** Hook that adds a flat `$taxPerYear` cash need every year and records the
 *  classification it was handed for each year (for assertions). */
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
    // Ending balance is lower by the funded tax.
    expect(withTax.years[0].balance).toBeLessThan(noTax.years[0].balance);
    // Diagnostic fields are stamped on the row.
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
    // Tiny pool, large tax need: the engine cannot supply the grossed-up draw,
    // so the year reads depleted (the pool can fund neither the ordinary need
    // nor the funded tax on top of it).
    const accts = [account({ id: 'ira', initialPre: 20_000 }, 2040, 2040)];
    const { hook } = flatTaxHook(50_000);
    const out = simulateDrawdown({
      ...baseInput(accts, 2040, 2040, 2_000, hook),
      withdrawalStrategy: { kind: 'proportional' },
    });
    // $24k ordinary + $50k tax = $74k target vs a $20k pool → the year depletes
    // and cannot fund the full grossed-up target.
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
    // A single pre-tax account reports the whole target as pre-tax.
    expect(classifications[0].preTaxDollars).toBeGreaterThan(0);
    expect(classifications[0].postTaxNonRothDollars).toBe(0);
    expect(classifications[0].rothDollars).toBe(0);
  });

  it('depletion can move earlier once taxes are funded', () => {
    // A portfolio that just barely covers ordinary spending over 3 years but
    // not the added tax — depletion appears with tax, absent without.
    const mk = (): DrawdownAccountInput[] => [
      account({ id: 'ira', initialPre: 75_000 }, 2040, 2042),
    ];
    const noTax = simulateDrawdown(baseInput(mk(), 2040, 2042, 2_000));
    const { hook } = flatTaxHook(6_000);
    const withTax = simulateDrawdown(baseInput(mk(), 2040, 2042, 2_000, hook));
    // $24k/yr ordinary over 3 yrs = $72k < $75k → no depletion without tax.
    expect(noTax.depletionYear).toBeNull();
    // +$6k/yr tax → $30k/yr → depletes inside the horizon with tax.
    expect(withTax.depletionYear).not.toBeNull();
  });

  it('routes tax-funding to taxable before capped pre-tax under a MAGI cap', () => {
    // taxEfficient draws POST_TAX first; with a MAGI cap, the tax-funding
    // portion still prefers taxable, so no breach while taxable can cover it.
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
    // Ordinary $12k + tax $10k = $22k, all coverable from the $200k taxable
    // bucket (taxEfficient tier-0) → cap not breached.
    expect(out.years[0].magiCapBreachDollars ?? 0).toBe(0);
  });

  it('cap-aware TRIAL classifier diverts over-cap pre-tax to taxable', () => {
    // rothFirst tier order = [Roth, PRE_TAX, taxable]. WITHOUT cap-awareness the
    // trial classifier drains the PRE_TAX IRA (tier 1) before the taxable
    // brokerage (tier 2), classifying the whole $22k draw as pre-tax and
    // OVERSTATING the tax. WITH the cap threaded into the trial, only
    // the $5k cap is pre-tax; the rest diverts to the taxable brokerage.
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
    // Pre-tax draw stays within the $5k cap; the over-cap remainder is taxable.
    expect(cls.preTaxDollars).toBeLessThanOrEqual(5_000 + 1e-6);
    expect(cls.postTaxNonRothDollars).toBeGreaterThan(0);
  });

  it('uses the post-RMD pre-tax pool exactly once in the trial classifier', () => {
    // RMD-active year: an owner old enough to force an RMD draw. The RMD
    // pre-pass mutates the live run state (state.pre -= rmdDraw) BEFORE the
    // trial classifier runs, so `state` handed to the classifier is already
    // post-RMD. Pre-fix the classifier subtracted the RMD-forced pre-tax a
    // SECOND time, understating the pre-tax pool → the trial reported a lower
    // funded / pre-tax classification than the committing draw actually
    // produces (understating federal tax + IRMAA, under-funding the draw).
    const start = 2040;
    const horizon = 2040;
    // Owner born 1950 → RMD trigger age 73; age 90 in 2040 (divisor ~12.2).
    const ownerId = 'owner-1';
    const rmdContext: RmdContextInput = {
      ownerMeta: new Map([
        [ownerId, { isoBirthdate: '1950-01-01', deathYear: 2100 }],
      ]),
      ownerByAccountId: new Map([['ira', ownerId]]),
      rmdSnapshot: RMD_DIVISORS,
    };
    // Tight pool: after the RMD pre-pass the remaining pre-tax pool is LESS
    // than the discretionary target, so a (buggy) double-subtraction makes the
    // trial under-fund by exactly the RMD amount.
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
    // The whole pool is PRE_TAX, so every funded dollar is pre-tax. The trial's
    // funded + pre-tax classification must equal the committing draw — i.e. the
    // post-RMD pool is consumed once, not net of a phantom second RMD subtraction.
    expect(cls.fundedDollars).toBeCloseTo(committedWithdrawn, 0);
    expect(cls.preTaxDollars).toBeCloseTo(committedWithdrawn, 0);
    // Concretely: the pool ($70k) fully funds, NOT $70k minus a doubled RMD.
    expect(cls.fundedDollars).toBeCloseTo(70_000, 0);
  });

  it('trial classifies a same-year taxable deposit as taxable, not pre-tax', () => {
    // taxEfficient tier order = [POST_TAX-non-Roth, PRE_TAX, Roth]. The
    // brokerage starts the year EMPTY (post = 0) but receives a $60k CBP-style
    // lump-sum deposit in month 0. The committing path applies the deposit
    // BEFORE the monthly withdrawal, so the whole year's draw ($12k ordinary +
    // $10k tax = $22k) comes from the now-funded taxable brokerage (tier 0) —
    // NOT the pre-tax IRA. The trial classifier must mirror the within-year
    // deposit so it classifies the draw as taxable, not pre-tax.
    //
    // PRE-FIX: the trial copies year-START state (brokerage post = 0), so tier 0
    // is empty and the trial drains the PRE_TAX IRA → classifies $22k as pre-tax
    // (over-pre-tax), overstating MAGI / federal tax.
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
    // The whole $22k draw is funded from the $60k taxable deposit → taxable,
    // essentially zero pre-tax.
    expect(cls.postTaxNonRothDollars).toBeGreaterThan(0);
    expect(cls.preTaxDollars).toBeLessThan(1);
  });

  it('breaches the cap once taxable depletes funding the tax draw', () => {
    // Small taxable bucket: ordinary spending consumes it, so the tax-funding
    // portion forces a capped pre-tax draw → the cap is breached.
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
      // $5k pre-tax cap; ordinary $24k + tax $10k = $34k, only $8k taxable →
      // ≥ $26k must come from the capped IRA, far above the $5k cap.
      magiCapWindows: singleMagiCapWindow(
        { start: { kind: 'retirementStart' }, end: { kind: 'age', memberId: 'primary', years: 200, months: 0 }, magiCeilingAnnualDollars: 5_000, capMode: 'minimize', capMagiLine: 'irmaa' },
        9999,
      ),
    });
    expect(out.years[0].magiCapBreachDollars ?? 0).toBeGreaterThan(0);
  });
});
