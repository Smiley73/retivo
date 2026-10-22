/** RMD surplus accounting tests for the deterministic per-account strategy path. */
import { describe, it, expect } from 'vitest';
import { simulateDrawdown } from './drawdown-engine';
import { singleMagiCapWindow } from './drawdown-engine-per-account-magi-cap';
import type {
  DrawdownAccountInput,
  DrawdownInput,
  RmdContextInput,
  TaxCashflowHook,
  TaxCashflowYearOutcome,
} from './drawdown-engine-types';
import type { WithdrawalStrategy } from '../db/types';
import type { MonthlyCashflowSeries } from './monthly-cashflow';
import { RMD_DIVISORS } from './rmd-divisors';
import { RMD_OVERFLOW_CASH_ACCOUNT_ID } from './drawdown-engine-per-account-strategy-helpers';

const RETIREMENT_YEAR = 2030;
// Born 1957: age 73 in 2030 triggers the RMD; Uniform Lifetime divisor 26.5.
const OWNER_ISO = '1957-06-15';
const DIVISOR_73 = 26.5;

function zeros(startYear: number, horizonYear: number): MonthlyCashflowSeries {
  const months = (horizonYear - startYear + 1) * 12;
  return { startYear, startMonthIndex: 0, values: new Float64Array(months) };
}

function uniform(
  startYear: number,
  horizonYear: number,
  monthlyValue: number,
): MonthlyCashflowSeries {
  const months = (horizonYear - startYear + 1) * 12;
  return {
    startYear,
    startMonthIndex: 0,
    values: new Float64Array(months).fill(monthlyValue),
  };
}

function makeAccount(
  overrides: Partial<DrawdownAccountInput> & { id: string },
  startYear: number,
  horizonYear: number,
): DrawdownAccountInput {
  return {
    initialPre: 0,
    initialPost: 0,
    annualRatePct: 0,
    taxTreatment: 'POST_TAX',
    accountType: 'BROKERAGE',
    depositsByMonth: zeros(startYear, horizonYear),
    ...overrides,
  };
}

function makeRmdContext(accountIds: ReadonlyArray<string>): RmdContextInput {
  const ownerByAccountId = new Map<string, string>();
  for (const id of accountIds) ownerByAccountId.set(id, 'owner-1');
  const ownerMeta = new Map<string, { isoBirthdate: string; deathYear: number }>();
  ownerMeta.set('owner-1', { isoBirthdate: OWNER_ISO, deathYear: 9999 });
  return { ownerMeta, ownerByAccountId, rmdSnapshot: RMD_DIVISORS };
}

function runOneYear(opts: {
  iraBalance: number;
  expenseAnnual: number;
  withRealTaxable: boolean;
  strategy?: WithdrawalStrategy;
  horizonYear?: number;
}): ReturnType<typeof simulateDrawdown> {
  const horizonYear = opts.horizonYear ?? RETIREMENT_YEAR;
  const accounts: DrawdownAccountInput[] = [
    makeAccount(
      { id: 'ira', initialPre: opts.iraBalance, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' },
      RETIREMENT_YEAR,
      horizonYear,
    ),
  ];
  const accountIds = ['ira'];
  if (opts.withRealTaxable) {
    accounts.push(
      makeAccount(
        { id: 'brok', initialPost: 50_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' },
        RETIREMENT_YEAR,
        horizonYear,
      ),
    );
    accountIds.push('brok');
  }
  const input: DrawdownInput = {
    portfolioAtRetirement: opts.iraBalance + (opts.withRealTaxable ? 50_000 : 0),
    ratePct: 0,
    expensesByMonth: uniform(RETIREMENT_YEAR, horizonYear, opts.expenseAnnual / 12),
    incomeByMonth: zeros(RETIREMENT_YEAR, horizonYear),
    depositsByMonth: zeros(RETIREMENT_YEAR, horizonYear),
    retirementYear: RETIREMENT_YEAR,
    horizonYear,
    withdrawalStrategy: opts.strategy ?? { kind: 'taxEfficient' },
    accounts,
    rmdContext: makeRmdContext(accountIds),
  };
  return simulateDrawdown(input);
}

describe('RMD surplus — held-as-cash leak regression', () => {
  const IRA = 1_400_000;
  const EXPENSE = 30_000;
  const expectedRmd = Math.round(IRA / DIVISOR_73);
  const expectedSurplus = expectedRmd - EXPENSE;

  it('preserves the held-as-cash overflow in the year-end balance (= baseline + surplus)', () => {
    // Held-as-cash run: only a Roth post account, so the surplus has no taxable landing site and is held in the synthetic
    // carrier.
    const held = simulateDrawdown({
      portfolioAtRetirement: IRA + 100_000,
      ratePct: 0,
      expensesByMonth: uniform(RETIREMENT_YEAR, RETIREMENT_YEAR, EXPENSE / 12),
      incomeByMonth: zeros(RETIREMENT_YEAR, RETIREMENT_YEAR),
      depositsByMonth: zeros(RETIREMENT_YEAR, RETIREMENT_YEAR),
      retirementYear: RETIREMENT_YEAR,
      horizonYear: RETIREMENT_YEAR,
      withdrawalStrategy: { kind: 'taxEfficient' },
      accounts: [
        makeAccount({ id: 'ira', initialPre: IRA, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, RETIREMENT_YEAR, RETIREMENT_YEAR),
        makeAccount({ id: 'roth', initialPost: 100_000, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, RETIREMENT_YEAR, RETIREMENT_YEAR),
      ],
      rmdContext: makeRmdContext(['ira', 'roth']),
    });
    const yr = held.years[0];
    // Only EXPENSE is spent and the rest is held as cash, so the total = start − spending, not start − the full forced RMD.
    const startTotal = IRA + 100_000;
    expect(yr.balance).toBeCloseTo(startTotal - EXPENSE, -1);
    expect((yr.rmdOverflowToCashCents ?? 0) / 100).toBeCloseTo(expectedSurplus, -1);
    expect(yr.rmdReinvestedCents ?? 0).toBe(0);
  });
});

describe('RMD surplus — disposition split', () => {
  const IRA = 1_400_000;
  const EXPENSE = 30_000;
  const expectedSurplus = Math.round(IRA / DIVISOR_73) - EXPENSE;

  it('reinvest household → rmdReinvestedCents set, overflow 0, surplus in deposit (basis invariant)', () => {
    const out = runOneYear({ iraBalance: IRA, expenseAnnual: EXPENSE, withRealTaxable: true });
    const yr = out.years[0];
    expect((yr.rmdReinvestedCents ?? 0) / 100).toBeCloseTo(expectedSurplus, -1);
    expect(yr.rmdOverflowToCashCents ?? 0).toBe(0);
    const brokDeposit = yr.accountBalances?.get('brok')?.deposit ?? 0;
    expect(brokDeposit).toBeCloseTo(expectedSurplus, -1);
  });

  it('held-as-cash household → rmdOverflowToCashCents set, reinvest 0', () => {
    const out = runOneYear({ iraBalance: IRA, expenseAnnual: EXPENSE, withRealTaxable: false });
    const yr = out.years[0];
    expect((yr.rmdOverflowToCashCents ?? 0) / 100).toBeCloseTo(expectedSurplus, -1);
    expect(yr.rmdReinvestedCents ?? 0).toBe(0);
  });
});

describe('RMD surplus — tax invariant (full forced RMD stays pre-tax)', () => {
  const IRA = 1_400_000;
  const EXPENSE = 30_000;
  const expectedRmd = Math.round(IRA / DIVISOR_73);

  it('the full forced RMD is the pre-tax IRA withdrawal in BOTH dispositions', () => {
    for (const withRealTaxable of [true, false]) {
      const out = runOneYear({ iraBalance: IRA, expenseAnnual: EXPENSE, withRealTaxable });
      const yr = out.years[0];
      const iraWd = yr.accountBalances?.get('ira')?.withdrawn ?? 0;
      // The pre-tax IRA withdrawal equals the full forced RMD; the surplus disposition never nets it down.
      expect(iraWd).toBeCloseTo(expectedRmd, -1);
    }
  });
});

describe('RMD surplus — universal spend-first across strategies', () => {
  // Year 0 forces an RMD beyond spending (building held cash); year 1's spending should fund from that cash first, reducing
  // the forced pre-tax draw against a no-cash baseline.
  const IRA = 1_400_000;
  const EXPENSE = 30_000;
  const HORIZON = RETIREMENT_YEAR + 1;

  for (const kind of ['taxEfficient', 'rothFirst', 'proportional'] as const) {
    it(`held cash is consumed before real accounts in year 1 under ${kind} (paired baseline)`, () => {
      // Same IRA and Roth in both households; only year-0 spending differs (held: a low expense builds held cash; baseline: the
      // expense equals the forced RMD, so no surplus). Year-1 need exceeds the forced RMD in both, so the strategy-agnostic
      // real-account draw (IRA + Roth, excluding the carrier) must be strictly lower with held cash; this fails if
      // consumeOverflowCashFirst is disabled.
      const Y1_EXPENSE = 90_000;
      const year0Rmd = Math.round(IRA / DIVISOR_73);
      const months = (HORIZON - RETIREMENT_YEAR + 1) * 12;

      const makeRun = (year0Expense: number): ReturnType<typeof simulateDrawdown> => {
        const expVals = new Float64Array(months);
        for (let m = 0; m < 12; m += 1) expVals[m] = year0Expense / 12;
        for (let m = 12; m < 24; m += 1) expVals[m] = Y1_EXPENSE / 12;
        return simulateDrawdown({
          portfolioAtRetirement: IRA + 100_000,
          ratePct: 0,
          expensesByMonth: { startYear: RETIREMENT_YEAR, startMonthIndex: 0, values: expVals },
          incomeByMonth: zeros(RETIREMENT_YEAR, HORIZON),
          depositsByMonth: zeros(RETIREMENT_YEAR, HORIZON),
          retirementYear: RETIREMENT_YEAR,
          horizonYear: HORIZON,
          withdrawalStrategy: { kind },
          accounts: [
            makeAccount({ id: 'ira', initialPre: IRA, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, RETIREMENT_YEAR, HORIZON),
            makeAccount({ id: 'roth', initialPost: 100_000, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, RETIREMENT_YEAR, HORIZON),
          ],
          rmdContext: makeRmdContext(['ira', 'roth']),
        });
      };

      const held = makeRun(EXPENSE);
      const baseline = makeRun(year0Rmd);

      expect((held.years[0].rmdOverflowToCashCents ?? 0) / 100).toBeGreaterThan(0);
      expect((baseline.years[0].rmdOverflowToCashCents ?? 0) / 100).toBeCloseTo(0, -1);

      const realDraw = (out: ReturnType<typeof simulateDrawdown>): number => {
        const bal = out.years[1].accountBalances;
        return (bal?.get('ira')?.withdrawn ?? 0) + (bal?.get('roth')?.withdrawn ?? 0);
      };
      // Held cash is consumed first, so the real-account draw is strictly lower despite the held household carrying more balance
      // into year 1.
      expect(realDraw(held)).toBeLessThan(realDraw(baseline) - 1);
    });
  }

  it('held cash is consumed before pre-tax under customOrder', () => {
    const accounts: DrawdownAccountInput[] = [
      makeAccount({ id: 'ira', initialPre: IRA, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, RETIREMENT_YEAR, HORIZON),
      makeAccount({ id: 'roth', initialPost: 100_000, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, RETIREMENT_YEAR, HORIZON),
    ];
    const out = simulateDrawdown({
      portfolioAtRetirement: IRA + 100_000,
      ratePct: 0,
      expensesByMonth: uniform(RETIREMENT_YEAR, HORIZON, EXPENSE / 12),
      incomeByMonth: zeros(RETIREMENT_YEAR, HORIZON),
      depositsByMonth: zeros(RETIREMENT_YEAR, HORIZON),
      retirementYear: RETIREMENT_YEAR,
      horizonYear: HORIZON,
      withdrawalStrategy: { kind: 'customOrder' },
      customDrawdownOrder: { tiers: [['roth'], ['ira']], excludedAccountIds: [] },
      accounts,
      rmdContext: makeRmdContext(['ira', 'roth']),
    });
    const y0 = out.years[0];
    expect((y0.rmdOverflowToCashCents ?? 0) / 100).toBeGreaterThan(0);
    // Year 1: held cash funds the need before the customOrder router would touch Roth, so Roth is preserved.
    const y1RothBal = out.years[1].accountBalances?.get('roth')?.balance ?? 0;
    expect(y1RothBal).toBeCloseTo(100_000, -2);
  });

  it('held cash is consumed before pre-tax under an active MAGI cap', () => {
    const accounts: DrawdownAccountInput[] = [
      makeAccount({ id: 'ira', initialPre: IRA, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, RETIREMENT_YEAR, HORIZON),
      makeAccount({ id: 'roth', initialPost: 100_000, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, RETIREMENT_YEAR, HORIZON),
    ];
    const out = simulateDrawdown({
      portfolioAtRetirement: IRA + 100_000,
      ratePct: 0,
      expensesByMonth: uniform(RETIREMENT_YEAR, HORIZON, EXPENSE / 12),
      incomeByMonth: zeros(RETIREMENT_YEAR, HORIZON),
      depositsByMonth: zeros(RETIREMENT_YEAR, HORIZON),
      retirementYear: RETIREMENT_YEAR,
      horizonYear: HORIZON,
      withdrawalStrategy: { kind: 'taxEfficient' },
      magiCapWindows: singleMagiCapWindow(
        { start: { kind: 'retirementStart' }, end: { kind: 'age', memberId: 'primary', years: 200, months: 0 }, magiCeilingAnnualDollars: 60_000, capMode: 'minimize', capMagiLine: 'irmaa' },
        9999,
      ),
      accounts,
      rmdContext: makeRmdContext(['ira', 'roth']),
    });
    const y0 = out.years[0];
    expect((y0.rmdOverflowToCashCents ?? 0) / 100).toBeGreaterThan(0);
    // Year 1: held cash funds the spend before the cap path draws Roth or pre-tax.
    const y1RothBal = out.years[1].accountBalances?.get('roth')?.balance ?? 0;
    expect(y1RothBal).toBeCloseTo(100_000, -2);
  });
});

describe('RMD surplus — integer cents, no penny drift', () => {
  it('surplus fields are whole integers', () => {
    const out = runOneYear({ iraBalance: 1_234_567, expenseAnnual: 21_111, withRealTaxable: false });
    const yr = out.years[0];
    const cents = yr.rmdOverflowToCashCents ?? 0;
    expect(Number.isInteger(cents)).toBe(true);
  });

  it('carrier surplus cents stay integer-exact across a multi-year held-as-cash run', () => {
    // Odd-dollar balances and expenses provoke any fractional-cent drift; with no real taxable account every year overflows to
    // the carrier.
    const HORIZON_5Y = RETIREMENT_YEAR + 4;
    const out = runOneYear({
      iraBalance: 1_234_567,
      expenseAnnual: 21_111,
      withRealTaxable: false,
      horizonYear: HORIZON_5Y,
    });
    expect(out.years.length).toBe(5);
    for (const yr of out.years) {
      const overflowCents = yr.rmdOverflowToCashCents ?? 0;
      expect(Number.isInteger(overflowCents)).toBe(true);
      const carrierBal = yr.accountBalances?.get(RMD_OVERFLOW_CASH_ACCOUNT_ID)?.balance ?? 0;
      expect(Number.isInteger(Math.round(carrierBal * 100))).toBe(true);
      expect(carrierBal * 100).toBe(Math.round(carrierBal * 100));
    }
    const carrierByYear = out.years.map(
      (yr) => yr.accountBalances?.get(RMD_OVERFLOW_CASH_ACCOUNT_ID)?.balance ?? 0,
    );
    for (let i = 1; i < carrierByYear.length; i += 1) {
      expect(carrierByYear[i]).toBeGreaterThan(carrierByYear[i - 1]);
    }
  });
});

describe('RMD surplus — synthetic carrier excluded from per-account breakdown', () => {
  const IRA = 1_400_000;
  const EXPENSE = 30_000;
  const expectedSurplus = Math.round(IRA / DIVISOR_73) - EXPENSE;

  it('the carrier id is NOT a real input account, so the account-stack (keyed on real ids) excludes it while the total balance still includes the surplus', () => {
    const out = runOneYear({ iraBalance: IRA, expenseAnnual: EXPENSE, withRealTaxable: false });
    const yr = out.years[0];
    const realIds = ['ira'];
    expect(realIds).not.toContain(RMD_OVERFLOW_CASH_ACCOUNT_ID);
    // The account-stack UI keys off real account ids, so it never surfaces the synthetic carrier.
    const stackTotal = realIds.reduce(
      (sum, id) => sum + (yr.accountBalances?.get(id)?.balance ?? 0),
      0,
    );
    // The surplus sits in the carrier, not in a real account, so the stack total is less than the year total by exactly the
    // surplus.
    expect(yr.balance - stackTotal).toBeCloseTo(expectedSurplus, -1);
    const carrierBal = yr.accountBalances?.get(RMD_OVERFLOW_CASH_ACCOUNT_ID)?.balance ?? 0;
    expect(carrierBal).toBeCloseTo(expectedSurplus, -1);
  });
});

function flatTaxHook(taxPerYear: number): TaxCashflowHook {
  return {
    solveForYear: (): TaxCashflowYearOutcome => ({
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
    }),
  };
}

describe('RMD surplus — tax portion is NOT retained in the portfolio', () => {
  // The forced RMD exceeds spending but not spending + tax, so the monthly RMD credit drives the discretionary target to $0
  // and the tax cash is funded from the forced RMD itself; the surplus must exclude the tax dollars and the ending balance
  // reflects the tax leaving the portfolio.
  const IRA = 1_400_000;
  const ROTH = 100_000;
  const EXPENSE = 30_000;
  const TAX = 15_000;
  const forcedRmd = Math.round(IRA / DIVISOR_73); // ~52,830, well above EXPENSE
  const expectedSurplus = forcedRmd - EXPENSE - TAX;

  it('held-as-cash surplus excludes the tax portion and the tax cash leaves the portfolio', () => {
    const startTotal = IRA + ROTH;
    const out = simulateDrawdown({
      portfolioAtRetirement: startTotal,
      ratePct: 0,
      expensesByMonth: uniform(RETIREMENT_YEAR, RETIREMENT_YEAR, EXPENSE / 12),
      incomeByMonth: zeros(RETIREMENT_YEAR, RETIREMENT_YEAR),
      depositsByMonth: zeros(RETIREMENT_YEAR, RETIREMENT_YEAR),
      retirementYear: RETIREMENT_YEAR,
      horizonYear: RETIREMENT_YEAR,
      withdrawalStrategy: { kind: 'taxEfficient' },
      accounts: [
        makeAccount({ id: 'ira', initialPre: IRA, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, RETIREMENT_YEAR, RETIREMENT_YEAR),
        makeAccount({ id: 'roth', initialPost: ROTH, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, RETIREMENT_YEAR, RETIREMENT_YEAR),
      ],
      rmdContext: makeRmdContext(['ira', 'roth']),
      taxCashflow: flatTaxHook(TAX),
    });
    const yr = out.years[0];
    expect(yr.balance).toBeCloseTo(startTotal - EXPENSE - TAX, -1);
    const stampedSurplus =
      ((yr.rmdReinvestedCents ?? 0) + (yr.rmdOverflowToCashCents ?? 0)) / 100;
    expect(stampedSurplus).toBeCloseTo(expectedSurplus, -1);
    const iraWd = yr.accountBalances?.get('ira')?.withdrawn ?? 0;
    expect(iraWd).toBeCloseTo(forcedRmd, -1);
  });

  it('reinvest household: tax portion excluded from rmdReinvestedCents + the brokerage deposit', () => {
    const BROK = 50_000;
    const startTotal = IRA + BROK;
    const out = simulateDrawdown({
      portfolioAtRetirement: startTotal,
      ratePct: 0,
      expensesByMonth: uniform(RETIREMENT_YEAR, RETIREMENT_YEAR, EXPENSE / 12),
      incomeByMonth: zeros(RETIREMENT_YEAR, RETIREMENT_YEAR),
      depositsByMonth: zeros(RETIREMENT_YEAR, RETIREMENT_YEAR),
      retirementYear: RETIREMENT_YEAR,
      horizonYear: RETIREMENT_YEAR,
      withdrawalStrategy: { kind: 'rothFirst' },
      accounts: [
        makeAccount({ id: 'ira', initialPre: IRA, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, RETIREMENT_YEAR, RETIREMENT_YEAR),
        makeAccount({ id: 'brok', initialPost: BROK, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }, RETIREMENT_YEAR, RETIREMENT_YEAR),
      ],
      rmdContext: makeRmdContext(['ira', 'brok']),
      taxCashflow: flatTaxHook(TAX),
    });
    const yr = out.years[0];
    expect((yr.rmdReinvestedCents ?? 0) / 100).toBeCloseTo(expectedSurplus, -1);
    expect(yr.rmdOverflowToCashCents ?? 0).toBe(0);
    const brokDeposit = yr.accountBalances?.get('brok')?.deposit ?? 0;
    expect(brokDeposit).toBeCloseTo(expectedSurplus, -1);
    expect(yr.balance).toBeCloseTo(startTotal - EXPENSE - TAX, -1);
  });
});

describe('RMD overflow carrier — receives ZERO share of real household deposits', () => {
  const IRA = 1_400_000;
  const EXPENSE = 30_000;
  const PENSION_LUMP = 40_000;
  const HORIZON = RETIREMENT_YEAR + 1;

  it('a later-year household deposit lands wholly in the real account, never in the carrier (paired)', () => {
    // The carrier legitimately receives its RMD-surplus credit each year, so compare two households differing only by a year-1
    // pension lump sum: the carrier's year-1 deposit and balance are identical across them (zero share of the household
    // deposit) while the full lump sum lands in the real Roth account.
    const makeRun = (lumpSum: number): ReturnType<typeof simulateDrawdown> => {
      const months = (HORIZON - RETIREMENT_YEAR + 1) * 12;
      const deposits = new Float64Array(months);
      deposits[12] = lumpSum; // year-1 month 0 pension lump sum
      return simulateDrawdown({
        portfolioAtRetirement: IRA + 50_000,
        ratePct: 0,
        expensesByMonth: uniform(RETIREMENT_YEAR, HORIZON, EXPENSE / 12),
        incomeByMonth: zeros(RETIREMENT_YEAR, HORIZON),
        depositsByMonth: { startYear: RETIREMENT_YEAR, startMonthIndex: 0, values: deposits },
        retirementYear: RETIREMENT_YEAR,
        horizonYear: HORIZON,
        withdrawalStrategy: { kind: 'taxEfficient' },
        accounts: [
          makeAccount({ id: 'ira', initialPre: IRA, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, RETIREMENT_YEAR, HORIZON),
          // Roth holds the real deposit home but is not a surplus sink, so the RMD surplus still overflows to the carrier.
          makeAccount({ id: 'roth', initialPost: 50_000, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, RETIREMENT_YEAR, HORIZON),
        ],
        rmdContext: makeRmdContext(['ira', 'roth']),
      });
    };

    const withDeposit = makeRun(PENSION_LUMP);
    const noDeposit = makeRun(0);

    expect((withDeposit.years[0].rmdOverflowToCashCents ?? 0) / 100).toBeGreaterThan(0);

    const carrierDep = (out: ReturnType<typeof simulateDrawdown>): number =>
      out.years[1].accountBalances?.get(RMD_OVERFLOW_CASH_ACCOUNT_ID)?.deposit ?? 0;
    const carrierBal = (out: ReturnType<typeof simulateDrawdown>): number =>
      out.years[1].accountBalances?.get(RMD_OVERFLOW_CASH_ACCOUNT_ID)?.balance ?? 0;

    expect(carrierDep(withDeposit)).toBeCloseTo(carrierDep(noDeposit), 6);
    expect(carrierBal(withDeposit)).toBeCloseTo(carrierBal(noDeposit), 6);

    // The lump sum lands wholly in the real accounts (IRA + Roth): their combined year-1 deposit rises by exactly the lump sum.
    const realDep = (out: ReturnType<typeof simulateDrawdown>): number =>
      (out.years[1].accountBalances?.get('ira')?.deposit ?? 0) +
      (out.years[1].accountBalances?.get('roth')?.deposit ?? 0);
    expect(realDep(withDeposit) - realDep(noDeposit)).toBeCloseTo(PENSION_LUMP, -1);
  });
});

describe('RMD surplus — a negative add-on (credit applied to premiums) is more surplus to put back', () => {
  const IRA = 1_400_000;
  const ROTH = 100_000;
  const EXPENSE = 30_000;
  const LINE = 5_000;
  const forcedRmd = Math.round(IRA / DIVISOR_73);

  it('the surplus grows by the line and the forced RMD still leaves the IRA in full', () => {
    const run = (taxCashflow?: TaxCashflowHook) =>
      simulateDrawdown({
        portfolioAtRetirement: IRA + ROTH,
        ratePct: 0,
        expensesByMonth: uniform(RETIREMENT_YEAR, RETIREMENT_YEAR, EXPENSE / 12),
        incomeByMonth: zeros(RETIREMENT_YEAR, RETIREMENT_YEAR),
        depositsByMonth: zeros(RETIREMENT_YEAR, RETIREMENT_YEAR),
        retirementYear: RETIREMENT_YEAR,
        horizonYear: RETIREMENT_YEAR,
        withdrawalStrategy: { kind: 'taxEfficient' },
        accounts: [
          makeAccount({ id: 'ira', initialPre: IRA, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, RETIREMENT_YEAR, RETIREMENT_YEAR),
          makeAccount({ id: 'roth', initialPost: ROTH, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, RETIREMENT_YEAR, RETIREMENT_YEAR),
        ],
        rmdContext: makeRmdContext(['ira', 'roth']),
        ...(taxCashflow ? { taxCashflow } : {}),
      });
    const surplusOf = (yr: { rmdReinvestedCents?: number; rmdOverflowToCashCents?: number }): number =>
      ((yr.rmdReinvestedCents ?? 0) + (yr.rmdOverflowToCashCents ?? 0)) / 100;
    const base = run().years[0];
    const credited = run({
      solveForYear: (): TaxCashflowYearOutcome => ({
        addedNeedDollars: -LINE,
        federalTaxCashNeedCents: 0,
        irmaaWithheldFromSsCents: 0,
        irmaaCashNeedCents: 0,
        acaPtcCashflowOffsetCents: 0,
        acaCreditAppliedToPremiumsCents: LINE * 100,
        totalTaxCashflowNeedCents: 0,
        taxCashflowIterations: 1,
        taxCashflowConverged: true,
        taxCashflowShortfallCents: 0,
      }),
    }).years[0];
    expect(surplusOf(base)).toBeCloseTo(forcedRmd - EXPENSE, -1);
    expect(surplusOf(credited)).toBeCloseTo(forcedRmd - EXPENSE + LINE, -1);
    expect(credited.accountBalances?.get('ira')?.withdrawn).toBeCloseTo(
      base.accountBalances?.get('ira')?.withdrawn ?? 0,
      6,
    );
  });
});
