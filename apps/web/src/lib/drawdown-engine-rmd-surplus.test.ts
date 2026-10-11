/**
 * RMD surplus accounting + display tests.
 *
 * Covers the deterministic per-account strategy path only (the feature's gate):
 *   - Leak regression: held-as-cash overflow is PRESERVED in the projected
 *     balance (the year-end total = the no-surplus baseline PLUS the surplus),
 *     proving the credit-back, not just field presence.
 *   - Disposition split: a real POST_TAX-non-Roth account → `rmdReinvestedCents`;
 *     no such account → `rmdOverflowToCashCents`.
 *   - Tax invariant: the full forced RMD is classified pre-tax in BOTH
 *     dispositions — the surplus never reduces the pre-tax withdrawal.
 *   - Basis invariant: reinvested surplus flows through `DrawdownAccountYear.deposit`
 *     so the cost-basis accumulator credits it.
 *   - Spend-first across EVERY strategy kind: a held-as-cash year reduces
 *     the FOLLOWING year's forced pre-tax draw + RMD base.
 *   - Integer cents end-to-end (no penny drift).
 */
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
// Owner born 1957 → age 73 in 2030 → RMD trigger fires; Uniform Lifetime
// divisor at 73 = 26.5.
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

/** A one-year run with an IRA forced above the spending need + an optional
 *  real taxable account. 0% growth so balance arithmetic is exact. */
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
    // Held-as-cash run: only a Roth post account, so the surplus has no real
    // taxable landing site and is held in the synthetic carrier.
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
    // The forced RMD leaves the IRA, only `EXPENSE` is spent, the rest is held
    // as cash — so the portfolio total = starting total − spending (NOT
    // − the full forced RMD). The surplus is preserved.
    const startTotal = IRA + 100_000;
    expect(yr.balance).toBeCloseTo(startTotal - EXPENSE, -1);
    // The overflow surfaces and matches the surplus.
    expect((yr.rmdOverflowToCashCents ?? 0) / 100).toBeCloseTo(expectedSurplus, -1);
    // No reinvest disposition in the held-as-cash household.
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
    // Basis invariant: reinvested surplus flows through the brokerage deposit.
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
      // The pre-tax IRA withdrawal equals the full forced RMD — the surplus
      // disposition (reinvest or hold) never nets it down.
      expect(iraWd).toBeCloseTo(expectedRmd, -1);
    }
  });
});

describe('RMD surplus — universal spend-first across strategies', () => {
  // Two-year run: year 0 forces a large RMD beyond spending (builds held cash),
  // year 1 has spending the held cash should fund FIRST, measurably reducing
  // the year-1 forced pre-tax withdrawal vs. a no-cash baseline.
  const IRA = 1_400_000;
  const EXPENSE = 30_000;
  const HORIZON = RETIREMENT_YEAR + 1;

  for (const kind of ['taxEfficient', 'rothFirst', 'proportional'] as const) {
    // Prove cash-first ordering for each preset by a PAIRED comparison.
    // Year-0 forces a large RMD (builds held cash). Year-1 net need EXCEEDS the
    // year-1 forced RMD, so a discretionary draw IS required. We compare the
    // year-1 pre-tax (IRA) draw of the held-cash household against an identical
    // household with NO prior-year held cash (its IRA is right-sized so its
    // year-0 forces ~no surplus). With held cash present the year-1 IRA draw
    // must be STRICTLY LOWER (held cash consumed before pre-tax). This assertion
    // fails if `consumeOverflowCashFirst` is disabled.
    it(`held cash is consumed before real accounts in year 1 under ${kind} (paired baseline)`, () => {
      // Both households hold the SAME (large) IRA and Roth — the ONLY difference
      // is whether year-0 built held cash. We toggle that via the year-0 expense:
      //   - held household: LOW year-0 expense → forced RMD >> spend → surplus
      //     held as cash; AND because less was spent, MORE balance carries into
      //     year 1 (so any balance confound works AGAINST the assertion).
      //   - baseline household: year-0 expense set so the forced RMD is fully
      //     spent → ~no surplus, no prior-year held cash to consume in year 1.
      // Year-1 net need EXCEEDS the year-1 forced RMD in BOTH, so a discretionary
      // draw is required unless cash funds it first. The discretionary source
      // varies by strategy (IRA / Roth), so we assert on the strategy-agnostic
      // quantity: the TOTAL year-1 draw from the REAL accounts (IRA + Roth,
      // excluding the synthetic carrier). With held cash present that real draw
      // is STRICTLY LOWER (cash funded part of the need) — fails if
      // `consumeOverflowCashFirst` is disabled.
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

      // Held household: low year-0 expense (well below the forced RMD) → surplus.
      const held = makeRun(EXPENSE);
      // Baseline household: year-0 expense matches the forced RMD → ~no surplus.
      const baseline = makeRun(year0Rmd);

      // Sanity: the held household built cash; the baseline did not.
      expect((held.years[0].rmdOverflowToCashCents ?? 0) / 100).toBeGreaterThan(0);
      expect((baseline.years[0].rmdOverflowToCashCents ?? 0) / 100).toBeCloseTo(0, -1);

      const realDraw = (out: ReturnType<typeof simulateDrawdown>): number => {
        const bal = out.years[1].accountBalances;
        return (bal?.get('ira')?.withdrawn ?? 0) + (bal?.get('roth')?.withdrawn ?? 0);
      };
      // Held cash consumed first → strictly lower year-1 REAL-account draw, even
      // though the held household carries MORE balance into year 1.
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
    // Year 1: held cash funds the discretionary need before the customOrder
    // router would touch Roth — Roth balance is preserved through year 1.
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
    // Year 1: held cash funds the spend before the cap path draws Roth/pre-tax.
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
    // Awkward odd-dollar balances + expenses to provoke any fractional-cent
    // drift. 0% growth, no real taxable account → every year overflows to the
    // carrier and the carrier balance accumulates across years.
    const HORIZON_5Y = RETIREMENT_YEAR + 4;
    const out = runOneYear({
      iraBalance: 1_234_567,
      expenseAnnual: 21_111,
      withRealTaxable: false,
      horizonYear: HORIZON_5Y,
    });
    expect(out.years.length).toBe(5);
    for (const yr of out.years) {
      // Each year's overflow surplus is integer cents (exact, not approximate).
      const overflowCents = yr.rmdOverflowToCashCents ?? 0;
      expect(Number.isInteger(overflowCents)).toBe(true);
      // The carrier's running balance (its post bucket) is integer-cents exact.
      const carrierBal = yr.accountBalances?.get(RMD_OVERFLOW_CASH_ACCOUNT_ID)?.balance ?? 0;
      expect(Number.isInteger(Math.round(carrierBal * 100))).toBe(true);
      expect(carrierBal * 100).toBe(Math.round(carrierBal * 100));
    }
    // The carrier balance grows year-over-year (surplus accumulates, no spend).
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
    // Real input accounts for this household.
    const realIds = ['ira'];
    expect(realIds).not.toContain(RMD_OVERFLOW_CASH_ACCOUNT_ID);
    // The account-stack UI keys off the real account list (acct.id), so the
    // sum over real ids is what the per-account breakdown shows — it never
    // surfaces the synthetic carrier id.
    const stackTotal = realIds.reduce(
      (sum, id) => sum + (yr.accountBalances?.get(id)?.balance ?? 0),
      0,
    );
    // The surplus is held in the carrier, NOT in any real account, so the
    // per-account stack total is LESS than the year total by exactly the surplus.
    expect(yr.balance - stackTotal).toBeCloseTo(expectedSurplus, -1);
    // The carrier's balance is exactly the surplus (held, not in the stack).
    const carrierBal = yr.accountBalances?.get(RMD_OVERFLOW_CASH_ACCOUNT_ID)?.balance ?? 0;
    expect(carrierBal).toBeCloseTo(expectedSurplus, -1);
  });
});

/** Tax hook that adds a flat `$taxPerYear` cash need every year. Mirrors the
 *  stub used in `drawdown-engine-tax-cashflow.test.ts`. */
function flatTaxHook(taxPerYear: number): TaxCashflowHook {
  return {
    // Params unused — flat add-on independent of year/need/classification.
    solveForYear: (): TaxCashflowYearOutcome => ({
      addedNeedDollars: taxPerYear,
      federalTaxCashNeedCents: taxPerYear * 100,
      irmaaWithheldFromSsCents: 0,
      irmaaCashNeedCents: 0,
      acaPtcCashflowOffsetCents: 0,
      totalTaxCashflowNeedCents: taxPerYear * 100,
      taxCashflowIterations: 2,
      taxCashflowConverged: true,
      taxCashflowShortfallCents: 0,
    }),
  };
}

describe('RMD surplus — tax portion is NOT retained in the portfolio', () => {
  // Over-RMD year where the forced RMD exceeds spending but NOT spending+tax,
  // so the monthly RMD credit drives the discretionary target to $0 and the tax
  // cash is funded out of the forced RMD itself (never a separate withdrawal).
  // The surplus reinvested/held must exclude the tax dollars, and the ending
  // balance must reflect the tax cash LEAVING the portfolio.
  const IRA = 1_400_000;
  const ROTH = 100_000;
  const EXPENSE = 30_000;
  const TAX = 15_000;
  const forcedRmd = Math.round(IRA / DIVISOR_73); // ~52,830, well above EXPENSE
  // The surplus excludes the tax add-on. A surplus that included it would be
  // `forcedRmd − EXPENSE` (= TAX larger), so this case fails that behaviour.
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
      // No real POST_TAX-non-Roth account (only Roth) → surplus held as cash.
      accounts: [
        makeAccount({ id: 'ira', initialPre: IRA, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, RETIREMENT_YEAR, RETIREMENT_YEAR),
        makeAccount({ id: 'roth', initialPost: ROTH, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, RETIREMENT_YEAR, RETIREMENT_YEAR),
      ],
      rmdContext: makeRmdContext(['ira', 'roth']),
      taxCashflow: flatTaxHook(TAX),
    });
    const yr = out.years[0];
    // (a) Ending balance = start − spending − tax (the tax cash LEFT the
    // portfolio). Pre-fix: only − spending, overstated by exactly TAX.
    expect(yr.balance).toBeCloseTo(startTotal - EXPENSE - TAX, -1);
    // (b) The stamped surplus excludes the tax portion. Pre-fix it would be
    // `forcedRmd − EXPENSE` (TAX dollars too large).
    const stampedSurplus =
      ((yr.rmdReinvestedCents ?? 0) + (yr.rmdOverflowToCashCents ?? 0)) / 100;
    expect(stampedSurplus).toBeCloseTo(expectedSurplus, -1);
    // The full forced RMD still left the IRA (the surplus never nets it down).
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
    // The brokerage deposit equals the tax-excluded surplus, NOT forced−EXPENSE.
    const brokDeposit = yr.accountBalances?.get('brok')?.deposit ?? 0;
    expect(brokDeposit).toBeCloseTo(expectedSurplus, -1);
    // Ending balance reflects the tax cash leaving the portfolio.
    expect(yr.balance).toBeCloseTo(startTotal - EXPENSE - TAX, -1);
  });
});

describe('RMD overflow carrier — receives ZERO share of real household deposits', () => {
  const IRA = 1_400_000;
  const EXPENSE = 30_000;
  const PENSION_LUMP = 40_000;
  const HORIZON = RETIREMENT_YEAR + 1;

  it('a later-year household deposit lands wholly in the real account, never in the carrier (paired)', () => {
    // Year 0 forces an RMD surplus → builds the synthetic carrier balance (no
    // real POST_TAX-non-Roth account, so it overflows to cash). The carrier DOES
    // legitimately receive its targeted RMD-surplus credit each year (which
    // surfaces in its `deposit`), so we can't assert a zero deposit. Instead we
    // run TWO identical households differing ONLY by a year-1 household deposit
    // (a pension lump sum) and assert: the carrier's year-1 deposit + balance are
    // IDENTICAL across both runs (it received ZERO share of the household
    // deposit — only its RMD-surplus credit), while the full lump sum lands in
    // the real Roth account.
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
          // Roth holds the real deposit home but is NOT a surplus sink (Roth is
          // excluded), so the RMD surplus still overflows to the synthetic carrier.
          makeAccount({ id: 'roth', initialPost: 50_000, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, RETIREMENT_YEAR, HORIZON),
        ],
        rmdContext: makeRmdContext(['ira', 'roth']),
      });
    };

    const withDeposit = makeRun(PENSION_LUMP);
    const noDeposit = makeRun(0);

    // Year 0 built carrier cash in both (overflow, no real POST_TAX-non-Roth sink).
    expect((withDeposit.years[0].rmdOverflowToCashCents ?? 0) / 100).toBeGreaterThan(0);

    const carrierDep = (out: ReturnType<typeof simulateDrawdown>): number =>
      out.years[1].accountBalances?.get(RMD_OVERFLOW_CASH_ACCOUNT_ID)?.deposit ?? 0;
    const carrierBal = (out: ReturnType<typeof simulateDrawdown>): number =>
      out.years[1].accountBalances?.get(RMD_OVERFLOW_CASH_ACCOUNT_ID)?.balance ?? 0;

    // The carrier's year-1 deposit + balance are IDENTICAL with and without the
    // household deposit — it received ZERO share of the pension lump sum (only
    // its RMD-surplus credit, which is the same in both runs at 0% growth).
    expect(carrierDep(withDeposit)).toBeCloseTo(carrierDep(noDeposit), 6);
    expect(carrierBal(withDeposit)).toBeCloseTo(carrierBal(noDeposit), 6);

    // The full pension lump sum lands WHOLLY in the REAL accounts (IRA + Roth):
    // their combined year-1 deposit rises by exactly the lump sum vs. the
    // no-deposit run (the carrier — excluded from the pro-rata pool — gets none).
    const realDep = (out: ReturnType<typeof simulateDrawdown>): number =>
      (out.years[1].accountBalances?.get('ira')?.deposit ?? 0) +
      (out.years[1].accountBalances?.get('roth')?.deposit ?? 0);
    expect(realDep(withDeposit) - realDep(noDeposit)).toBeCloseTo(PENSION_LUMP, -1);
  });
});
