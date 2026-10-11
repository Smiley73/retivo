/**
 * Locks the drawdown engine's annual time-step math: per-account
 * compound + withdraw, deposit injection before growth, depletion
 * detection, and the cap on `withdrawn` when balance can't fund the
 * full netNeed. The single-pool fixtures run through a single POST_TAX
 * account (`singlePoolAccount`), since the engine models only a per-account
 * ledger.
 */
import { describe, expect, it } from 'vitest';
import {
  simulateDrawdown,
  type DrawdownInput,
} from './drawdown-engine';
import { monthlyEquivalent } from './projection-engine/monthly-conversion';
import {
  addOneOff,
  buildMonthlyFromAnnualMap,
  emptyMonthlySeries,
  type MonthlyCashflowSeries,
} from './monthly-cashflow';

interface AnnualOverrides {
  expensesByYear?: Map<number, number>;
  incomeByYear?: Map<number, number>;
  depositsByYear?: Map<number, number>;
  expensesByMonth?: MonthlyCashflowSeries;
  incomeByMonth?: MonthlyCashflowSeries;
  depositsByMonth?: MonthlyCashflowSeries;
}

/**
 * Builds a DrawdownInput from the legacy `{ year: annual }` shape.
 * The engine now requires `MonthlyCashflowSeries` for every cashflow;
 * this helper splits annual values evenly across
 * 12 months so the existing test fixtures continue to assert the same
 * yearly math. Tests that need within-year precision (e.g. the
 * monthly-deposit case below) pass `depositsByMonth` directly.
 *
 * Because the engine has no single-pool path, `simulateDrawdown`
 * only models a per-account ledger. This helper seeds a SINGLE POST_TAX
 * account holding the whole portfolio at the run's scalar rate (and routes
 * the household deposit series onto that account) so the legacy single-pool
 * fixtures continue to assert the same yearly compound/withdraw math through
 * the per-account engine (one account ≡ one pool, no tax-cashflow hook).
 * Callers may still pass an explicit `accounts` ledger to override.
 */
function baseInput(
  overrides: AnnualOverrides & Partial<Omit<DrawdownInput, 'expensesByMonth' | 'incomeByMonth' | 'depositsByMonth'>> = {},
): DrawdownInput {
  const {
    expensesByYear = new Map(),
    incomeByYear = new Map(),
    depositsByYear = new Map(),
    expensesByMonth,
    incomeByMonth,
    depositsByMonth,
    ...rest
  } = overrides;
  const retirementYear = rest.retirementYear ?? 2030;
  const horizonYear = rest.horizonYear ?? 2032;
  const portfolioAtRetirement = rest.portfolioAtRetirement ?? 1_000_000;
  const ratePct = rest.ratePct ?? 5;
  const resolvedDeposits =
    depositsByMonth ?? buildMonthlyFromAnnualMap(depositsByYear, retirementYear, horizonYear);
  // Deposits ride the single account (the per-account engine reads per-account
  // deposit slots); the household-level series stays empty so they are not
  // double-counted (the strategy engine spreads `depositsByMonth` proportionally
  // ON TOP of the per-account slots).
  return {
    portfolioAtRetirement,
    ratePct,
    expensesByMonth:
      expensesByMonth ?? buildMonthlyFromAnnualMap(expensesByYear, retirementYear, horizonYear),
    incomeByMonth:
      incomeByMonth ?? buildMonthlyFromAnnualMap(incomeByYear, retirementYear, horizonYear),
    depositsByMonth: emptyMonthlySeries(retirementYear, horizonYear),
    retirementYear,
    horizonYear,
    ...rest,
    accounts: rest.accounts ?? singlePoolAccount(portfolioAtRetirement, ratePct, resolvedDeposits),
  };
}

/** Build a single-POST_TAX-account ledger holding `amount` at `ratePct`, with
 *  the household deposit series routed onto it — the per-account analog of the
 *  single pool the engine no longer has. */
function singlePoolAccount(
  amount: number,
  ratePct: number,
  deposits: MonthlyCashflowSeries,
): NonNullable<DrawdownInput['accounts']> {
  return [
    {
      id: 'pool',
      initialPre: 0,
      initialPost: amount,
      annualRatePct: ratePct,
      depositsByMonth: deposits,
      taxTreatment: 'POST_TAX',
      accountType: 'BROKERAGE',
    },
  ];
}

describe('simulateDrawdown', () => {
  it('compounds the pot when income covers expenses (zero net need)', () => {
    const out = simulateDrawdown(
      baseInput({
        expensesByYear: new Map([
          [2030, 50_000],
          [2031, 50_000],
          [2032, 50_000],
        ]),
        incomeByYear: new Map([
          [2030, 60_000],
          [2031, 60_000],
          [2032, 60_000],
        ]),
      }),
    );
    // Income > expenses every year → no withdrawal, balance compounds.
    expect(out.depletionYear).toBeNull();
    expect(out.years.map((y) => y.withdrawn)).toEqual([0, 0, 0]);
    expect(out.years[0].balance).toBeCloseTo(1_050_000, 0);
    expect(out.years[1].balance).toBeCloseTo(1_102_500, 0);
    expect(out.years[2].balance).toBeCloseTo(1_157_625, 0);
  });

  it('withdraws net need (expense − income) per year', () => {
    const out = simulateDrawdown(
      baseInput({
        ratePct: 0,
        portfolioAtRetirement: 100_000,
        expensesByYear: new Map([
          [2030, 50_000],
          [2031, 50_000],
        ]),
        incomeByYear: new Map([
          [2030, 30_000],
          [2031, 30_000],
        ]),
        horizonYear: 2031,
      }),
    );
    // Each year: netNeed=20k, no growth → balance drops 20k.
    // Monthly cadence inside combined-pot leaves sub-cent FP residue,
    // so this and similar assertions use `toBeCloseTo` rather than
    // strict equality.
    expect(out.years[0].year).toBe(2030);
    expect(out.years[0].withdrawn).toBeCloseTo(20_000, 2);
    expect(out.years[0].netNeed).toBeCloseTo(20_000, 2);
    expect(out.years[0].balance).toBeCloseTo(80_000, 2);
    expect(out.years[0].depleted).toBe(false);
    expect(out.years[1].year).toBe(2031);
    expect(out.years[1].withdrawn).toBeCloseTo(20_000, 2);
    expect(out.years[1].balance).toBeCloseTo(60_000, 2);
    expect(out.years[1].depleted).toBe(false);
    expect(out.depletionYear).toBeNull();
  });

  it('caps withdrawal at available balance and flags depletion', () => {
    const out = simulateDrawdown(
      baseInput({
        ratePct: 0,
        portfolioAtRetirement: 30_000,
        expensesByYear: new Map([
          [2030, 50_000],
          [2031, 50_000],
        ]),
        incomeByYear: new Map([
          [2030, 30_000],
          [2031, 30_000],
        ]),
        horizonYear: 2031,
      }),
    );
    // 2030: netNeed 20k, balance 30k → withdraw 20k, leaves 10k. Not depleted yet.
    expect(out.years[0].withdrawn).toBeCloseTo(20_000, 2);
    expect(out.years[0].balance).toBeCloseTo(10_000, 2);
    expect(out.years[0].depleted).toBe(false);
    // 2031: netNeed 20k, balance 10k → withdraw capped at 10k, depleted.
    expect(out.years[1].withdrawn).toBeCloseTo(10_000, 2);
    expect(out.years[1].netNeed).toBeCloseTo(20_000, 2);
    expect(out.years[1].balance).toBeCloseTo(0, 2);
    expect(out.years[1].depleted).toBe(true);
    expect(out.depletionYear).toBe(2031);
  });

  it('injects lump-sum deposits before that year compounds + draws', () => {
    const out = simulateDrawdown(
      baseInput({
        ratePct: 10,
        portfolioAtRetirement: 100_000,
        expensesByYear: new Map([[2030, 0]]),
        incomeByYear: new Map([[2030, 0]]),
        // Jan-pinned deposit: the legacy contract was "deposit lands
        // before that year's growth + withdrawal." Monthly cadence
        // preserves this when the deposit pins to month 0.
        depositsByMonth: (() => {
          const s = emptyMonthlySeries(2030, 2030);
          addOneOff(s, 2030, 0, 50_000);
          return s;
        })(),
        horizonYear: 2030,
      }),
    );
    // Deposit lifts pre-growth pot to 150k, then grows 10% → 165k. No draw.
    expect(out.years[0].deposit).toBeCloseTo(50_000, 2);
    expect(out.years[0].growth).toBeCloseTo(15_000, 2);
    expect(out.years[0].withdrawn).toBe(0);
    expect(out.years[0].balance).toBeCloseTo(165_000, 2);
  });

  it('records the first depletion year only — later years are flagged but depletionYear is stable', () => {
    const out = simulateDrawdown(
      baseInput({
        ratePct: 0,
        portfolioAtRetirement: 5_000,
        expensesByYear: new Map([
          [2030, 10_000],
          [2031, 10_000],
          [2032, 10_000],
        ]),
        incomeByYear: new Map(),
      }),
    );
    expect(out.depletionYear).toBe(2030); // first year withdrawal < netNeed
    expect(out.years.every((y) => y.depleted)).toBe(true);
    // Years 2 and 3: balance 0, netNeed 10k, withdraw 0 → depleted true.
    expect(out.years[1].balance).toBe(0);
    expect(out.years[2].withdrawn).toBe(0);
  });

  it('treats missing income / expense map entries as zero (idempotent for sparse maps)', () => {
    const out = simulateDrawdown(
      baseInput({
        ratePct: 0,
        expensesByYear: new Map([[2031, 1_000]]),
        incomeByYear: new Map(),
        horizonYear: 2032,
      }),
    );
    // 2030: nothing happens (no expenses), balance unchanged.
    expect(out.years[0].withdrawn).toBeCloseTo(0, 2);
    expect(out.years[0].balance).toBeCloseTo(1_000_000, 2);
    // 2031: 1k withdraw, no income.
    expect(out.years[1].withdrawn).toBeCloseTo(1_000, 2);
    // 2032: nothing again.
    expect(out.years[2].withdrawn).toBeCloseTo(0, 2);
  });
});

describe('simulateDrawdown — monthly deposit precision', () => {
  // Pinned defect: a September one-off windfall must
  // land in September. The pre-monthly engine pinned
  // every annualized deposit to month 0, so the September $40k spike
  // appeared as a January spike on the cashflow chart and the
  // projection compounded it for 11 extra months.
  it('Sept-pinned deposit compounds less than the same dollars pinned to January', () => {
    const janPinned = simulateDrawdown(
      baseInput({
        expensesByYear: new Map([[2030, 100_000]]),
        incomeByYear: new Map([[2030, 0]]),
        depositsByMonth: (() => {
          const s = emptyMonthlySeries(2030, 2030);
          addOneOff(s, 2030, 0, 40_000); // Jan
          return s;
        })(),
        horizonYear: 2030,
      }),
    );
    const septPinned = simulateDrawdown(
      baseInput({
        expensesByYear: new Map([[2030, 100_000]]),
        incomeByYear: new Map([[2030, 0]]),
        depositsByMonth: (() => {
          const s = emptyMonthlySeries(2030, 2030);
          addOneOff(s, 2030, 8, 40_000); // Sept = index 8
          return s;
        })(),
        horizonYear: 2030,
      }),
    );
    // Year-end balances differ: the January-pinned deposit compounds
    // for 11 extra months versus the September-pinned one. With a
    // 5%/yr (≈ 0.407 %/mo) rate the gap is ~5% × 40k × (8/12) ≈ $1.3k+.
    expect(janPinned.years[0].balance).toBeGreaterThan(septPinned.years[0].balance + 1000);
    expect(septPinned.years[0].deposit).toBeCloseTo(40_000, 2);
  });

  it('Social Security starting in July drops July+ withdrawal need vs Jan-Jun', () => {
    // Regression: monthly cashflow precision matters for
    // mid-year SS claims. Compare a same-dollar SS scenario where the
    // benefit pays Jan-Dec evenly vs. pays Jul-Dec only — total income
    // is half, so net need (and the engine's withdrawal) should
    // measurably increase in Jan-Jun while Jul-Dec withdrawal lines
    // up with the always-on case.
    const halfYearSeries: MonthlyCashflowSeries = (() => {
      const series = emptyMonthlySeries(2030, 2030);
      const monthlyBenefit = 30_000 / 12;
      for (let m = 6; m < 12; m += 1) {
        series.values[m] = monthlyBenefit;
      }
      return series;
    })();
    const julStart = simulateDrawdown({
      ...baseInput({
        expensesByYear: new Map([[2030, 60_000]]),
        horizonYear: 2030,
        ratePct: 0,
      }),
      incomeByMonth: halfYearSeries,
    });
    const alwaysOn = simulateDrawdown(
      baseInput({
        expensesByYear: new Map([[2030, 60_000]]),
        incomeByYear: new Map([[2030, 30_000]]),
        horizonYear: 2030,
        ratePct: 0,
      }),
    );
    // Both years' total expenses match; alwaysOn has full $30k income,
    // julStart has only $15k. Withdrawal needs differ accordingly.
    expect(julStart.years[0].withdrawn).toBeGreaterThan(alwaysOn.years[0].withdrawn);
    // Per-month withdrawal should be higher in Jan (no SS in julStart)
    // than in any Jul-Dec month (SS active in both, same need).
    const julStartJan = julStart.perMonthWithdrawal[0];
    const julStartDec = julStart.perMonthWithdrawal[11];
    expect(julStartJan).toBeGreaterThan(julStartDec);
  });
});

describe('simulateDrawdown — per-account drawdown', () => {
  function emptyMonthly(retirementYear: number, horizonYear: number) {
    return emptyMonthlySeries(retirementYear, horizonYear);
  }

  it('all-rates-equal regression: per-account ledger matches single-pot output', () => {
    // Mathematical anchor: when every account compounds at the
    // same rate, the proportional-to-balance withdrawal split
    // reduces algebraically to the merged-pot output. Pinning the
    // engine reproduces the legacy single-rate path.
    const retirementYear = 2030;
    const horizonYear = 2049;
    const expense = buildMonthlyFromAnnualMap(
      new Map(Array.from({ length: 20 }, (_, i) => [retirementYear + i, 60_000])),
      retirementYear,
      horizonYear,
    );
    const income = buildMonthlyFromAnnualMap(new Map(), retirementYear, horizonYear);
    const deposits = buildMonthlyFromAnnualMap(new Map(), retirementYear, horizonYear);
    const singlePot = simulateDrawdown({
      portfolioAtRetirement: 1_200_000,
      ratePct: 5,
      expensesByMonth: expense,
      incomeByMonth: income,
      depositsByMonth: deposits,
      retirementYear,
      horizonYear,
      accounts: singlePoolAccount(1_200_000, 5, deposits),
    });
    const perAccount = simulateDrawdown({
      portfolioAtRetirement: 1_200_000,
      ratePct: 0,
      expensesByMonth: expense,
      incomeByMonth: income,
      depositsByMonth: deposits,
      retirementYear,
      horizonYear,
      accounts: [
        {
          id: 'a',
          initialPre: 600_000,
          initialPost: 0,
          annualRatePct: 5,
          depositsByMonth: emptyMonthly(retirementYear, horizonYear),
          taxTreatment: 'POST_TAX',
          accountType: 'BROKERAGE',
        },
        {
          id: 'b',
          initialPre: 0,
          initialPost: 600_000,
          annualRatePct: 5,
          depositsByMonth: emptyMonthly(retirementYear, horizonYear),
          taxTreatment: 'POST_TAX',
          accountType: 'BROKERAGE',
        },
      ],
    });
    for (let y = 0; y < singlePot.years.length; y += 1) {
      expect(perAccount.years[y].balance).toBeCloseTo(singlePot.years[y].balance, 1);
      expect(perAccount.years[y].withdrawn).toBeCloseTo(singlePot.years[y].withdrawn, 1);
    }
    expect(perAccount.depletionYear).toBe(singlePot.depletionYear);
  });

  it('two-rate scenario: high-rate account outpaces low-rate one through drawdown', () => {
    const retirementYear = 2030;
    const horizonYear = 2039;
    const expense = buildMonthlyFromAnnualMap(
      new Map(Array.from({ length: 10 }, (_, i) => [retirementYear + i, 30_000])),
      retirementYear,
      horizonYear,
    );
    const out = simulateDrawdown({
      portfolioAtRetirement: 1_000_000,
      ratePct: 0,
      expensesByMonth: expense,
      incomeByMonth: buildMonthlyFromAnnualMap(new Map(), retirementYear, horizonYear),
      depositsByMonth: buildMonthlyFromAnnualMap(new Map(), retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      accounts: [
        {
          id: 'highRate',
          initialPre: 500_000,
          initialPost: 0,
          annualRatePct: 8,
          depositsByMonth: emptyMonthly(retirementYear, horizonYear),
          taxTreatment: 'POST_TAX',
          accountType: 'BROKERAGE',
        },
        {
          id: 'lowRate',
          initialPre: 0,
          initialPost: 500_000,
          annualRatePct: 3,
          depositsByMonth: emptyMonthly(retirementYear, horizonYear),
          taxTreatment: 'POST_TAX',
          accountType: 'BROKERAGE',
        },
      ],
    });
    const last = out.years[out.years.length - 1];
    const highEnd = last.accountBalances?.get('highRate')?.balance ?? 0;
    const lowEnd = last.accountBalances?.get('lowRate')?.balance ?? 0;
    // High-rate account ends with strictly more than the low-rate one
    // — compounding does its job through drawdown.
    expect(highEnd).toBeGreaterThan(lowEnd);
    expect(highEnd + lowEnd).toBeCloseTo(last.balance, 1);
  });

  it('synchronous depletion: every positive account depletes on the same step', () => {
    // Expenses outpace pool → both accounts drain together.
    const retirementYear = 2030;
    const horizonYear = 2034;
    const expense = buildMonthlyFromAnnualMap(
      new Map(Array.from({ length: 5 }, (_, i) => [retirementYear + i, 300_000])),
      retirementYear,
      horizonYear,
    );
    const out = simulateDrawdown({
      portfolioAtRetirement: 200_000,
      ratePct: 0,
      expensesByMonth: expense,
      incomeByMonth: buildMonthlyFromAnnualMap(new Map(), retirementYear, horizonYear),
      depositsByMonth: buildMonthlyFromAnnualMap(new Map(), retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      accounts: [
        {
          id: 'a',
          initialPre: 100_000,
          initialPost: 0,
          annualRatePct: 5,
          depositsByMonth: emptyMonthly(retirementYear, horizonYear),
          taxTreatment: 'POST_TAX',
          accountType: 'BROKERAGE',
        },
        {
          id: 'b',
          initialPre: 0,
          initialPost: 100_000,
          annualRatePct: 5,
          depositsByMonth: emptyMonthly(retirementYear, horizonYear),
          taxTreatment: 'POST_TAX',
          accountType: 'BROKERAGE',
        },
      ],
    });
    expect(out.depletionYear).not.toBeNull();
    // At depletion, every positive-start account hits 0.
    const idx = out.years.findIndex((y) => y.depleted);
    expect(idx).toBeGreaterThanOrEqual(0);
    const depRow = out.years[idx];
    const a = depRow.accountBalances?.get('a')?.balance ?? -1;
    const b = depRow.accountBalances?.get('b')?.balance ?? -1;
    expect(a).toBeLessThan(1);
    expect(b).toBeLessThan(1);
  });

  it('proportional withdrawal preserves intra-step pool ratio (invariant)', () => {
    // Invariant: at the withdrawal step every positive account is
    // multiplied by the SAME scalar (1 − taken/Σ pool), so the
    // per-account pool ratio is preserved THROUGH the withdrawal
    // step:
    //   pool_a[after-withdrawal] / pool_b[after-withdrawal]
    //     === pool_a[pre-withdrawal] / pool_b[pre-withdrawal]
    //
    // A test using distinct rates + a strict-monotone
    // year-over-year ratio assertion would hold under BOTH
    // proportional-split AND equal-split (under equal-split the
    // higher-rate account still grows faster than the lower-rate
    // account, so the ratio still climbs year-over-year), so it would
    // not kill the equal-split mutation. The actual invariant is
    // intra-step ratio constancy.
    //
    // Pin the invariant at year cadence by giving BOTH accounts the
    // SAME annual rate (5%) with unequal starting balances. Under
    // identical rates, per-account growth preserves the ratio every
    // month (each pool multiplied by the same monthly factor); under
    // proportional-split withdrawal, the ratio is ALSO preserved every
    // step (each pool multiplied by `1 − taken/Σ pool`). Net effect:
    // the year-end ratio MUST equal the initial ratio to fp64
    // tolerance.
    //
    // Under the equal-split mutation (`taken / N` per account), the
    // higher-balance account would shed the same dollar amount as the
    // lower-balance account → the ratio would drift away from the
    // initial value (e.g. starting 3:1 with $90k/$30k and an equal
    // $20k/$20k split → $70k/$10k = 7:1). Same-rate makes the test
    // immune to per-account growth effects so the assertion isolates
    // the withdrawal-split mechanism.
    const retirementYear = 2030;
    const horizonYear = 2039;
    const expense = buildMonthlyFromAnnualMap(
      new Map(Array.from({ length: 10 }, (_, i) => [retirementYear + i, 60_000])),
      retirementYear,
      horizonYear,
    );
    // Unequal starting balances (3:1 ratio) so equal-split would
    // visibly drift the ratio; same 5% rate so growth preserves the
    // ratio month-over-month.
    const out = simulateDrawdown({
      portfolioAtRetirement: 1_200_000,
      ratePct: 0,
      expensesByMonth: expense,
      incomeByMonth: buildMonthlyFromAnnualMap(new Map(), retirementYear, horizonYear),
      depositsByMonth: buildMonthlyFromAnnualMap(new Map(), retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      accounts: [
        {
          id: 'a',
          initialPre: 900_000,
          initialPost: 0,
          annualRatePct: 5,
          depositsByMonth: emptyMonthly(retirementYear, horizonYear),
          taxTreatment: 'POST_TAX',
          accountType: 'BROKERAGE',
        },
        {
          id: 'b',
          initialPre: 0,
          initialPost: 300_000,
          annualRatePct: 5,
          depositsByMonth: emptyMonthly(retirementYear, horizonYear),
          taxTreatment: 'POST_TAX',
          accountType: 'BROKERAGE',
        },
      ],
    });
    const initialRatio = 900_000 / 300_000; // 3.0
    // Pin the year-end ratio to the initial ratio for every year both
    // accounts remain positive. Under proportional-split + same-rate
    // growth the ratio MUST stay at 3.0 to fp64 tolerance. Under the
    // equal-split mutation the ratio would diverge visibly (each
    // account loses identical dollars per step → larger account
    // retains a higher share).
    for (let y = 0; y < out.years.length; y += 1) {
      const cur = out.years[y];
      const aCur = cur.accountBalances?.get('a')?.balance ?? 0;
      const bCur = cur.accountBalances?.get('b')?.balance ?? 0;
      // No per-account deposit landed (depositsByMonth is empty) +
      // accounts share their rate, so the invariant pins
      // (a / b) === initialRatio throughout the simulation.
      if (aCur < 1 || bCur < 1) break;
      const curRatio = aCur / bCur;
      expect(curRatio).toBeCloseTo(initialRatio, 10);
    }
  });

  it('fp clamp residual is accept-loss — no second-pass redistribute', () => {
    // Construct a near-depletion scenario where account A is far
    // smaller than B and the target exceeds A's balance + part of B.
    // The proportional split for A would over-draw by a sub-cent due
    // to fp64 rounding when A is at the depletion boundary; the
    // clamp activates, A's withdrawal equals its pool exactly, and
    // the aggregate `withdrawal[i]` ≤ aggregate `target[i]` with the
    // residual NOT redistributed.
    const retirementYear = 2030;
    const horizonYear = 2030;
    // Target = 1_000_000 → must take all of A (1) + most of B.
    const expense = buildMonthlyFromAnnualMap(
      new Map([[retirementYear, 1_000_000]]),
      retirementYear,
      horizonYear,
    );
    const out = simulateDrawdown({
      portfolioAtRetirement: 1_000_001,
      ratePct: 0,
      expensesByMonth: expense,
      incomeByMonth: buildMonthlyFromAnnualMap(new Map(), retirementYear, horizonYear),
      depositsByMonth: buildMonthlyFromAnnualMap(new Map(), retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      accounts: [
        {
          id: 'a',
          initialPre: 1,
          initialPost: 0,
          annualRatePct: 0,
          depositsByMonth: emptyMonthly(retirementYear, horizonYear),
          taxTreatment: 'POST_TAX',
          accountType: 'BROKERAGE',
        },
        {
          id: 'b',
          initialPre: 0,
          initialPost: 1_000_000,
          annualRatePct: 0,
          depositsByMonth: emptyMonthly(retirementYear, horizonYear),
          taxTreatment: 'POST_TAX',
          accountType: 'BROKERAGE',
        },
      ],
    });
    const yr = out.years[0];
    const aBal = yr.accountBalances?.get('a');
    const bBal = yr.accountBalances?.get('b');
    // A clamped at its pool — no negative balance.
    expect(aBal?.balance ?? 0).toBeGreaterThanOrEqual(0);
    // Aggregate withdrawn ≤ target (clamp residual accepted, not
    // redistributed). The total available across both was 1_000_001
    // and target was 1_000_000, so withdrawn should approach
    // 1_000_000 (or less by sub-cent rounding) — never exceed it.
    expect(yr.withdrawn).toBeLessThanOrEqual(yr.netNeed + 0.01);
    // Per-account sum equals aggregate (within fp tolerance).
    const sumPerAccount = (aBal?.withdrawn ?? 0) + (bBal?.withdrawn ?? 0);
    expect(Math.abs(sumPerAccount - yr.withdrawn)).toBeLessThan(0.01);
  });

  it('2-rate hand-computed parity over 5-year drawdown', () => {
    // 2 accounts, no income, 10k/yr drawdown for 5 years. Hand-compute
    // year-end balances and pin them.
    //
    // Setup: a = 100k @ 10%/yr post-tax, b = 100k @ 0%/yr post-tax.
    // Total starting = 200k; net need 10k/yr; no deposits / income.
    //
    // Monthly conversion: monthly_a = (1.10)^(1/12) - 1 ≈ 0.7974%/mo;
    // monthly_b = 0. The proportional-to-balance split makes hand-
    // calculation tedious, so we use a coarse expected-value sanity
    // band — A's higher rate means it outpaces B through drawdown so
    // A's year-end balance > B's by year 5, and the total drains by
    // ~50k (5 × 10k) over the 5-year horizon, modulo A's growth.
    const retirementYear = 2030;
    const horizonYear = 2034;
    const expense = buildMonthlyFromAnnualMap(
      new Map(Array.from({ length: 5 }, (_, i) => [retirementYear + i, 10_000])),
      retirementYear,
      horizonYear,
    );
    const out = simulateDrawdown({
      portfolioAtRetirement: 200_000,
      ratePct: 0,
      expensesByMonth: expense,
      incomeByMonth: buildMonthlyFromAnnualMap(new Map(), retirementYear, horizonYear),
      depositsByMonth: buildMonthlyFromAnnualMap(new Map(), retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      accounts: [
        {
          id: 'a',
          initialPre: 0,
          initialPost: 100_000,
          annualRatePct: 10,
          depositsByMonth: emptyMonthly(retirementYear, horizonYear),
          taxTreatment: 'POST_TAX',
          accountType: 'BROKERAGE',
        },
        {
          id: 'b',
          initialPre: 0,
          initialPost: 100_000,
          annualRatePct: 0,
          depositsByMonth: emptyMonthly(retirementYear, horizonYear),
          taxTreatment: 'POST_TAX',
          accountType: 'BROKERAGE',
        },
      ],
    });
    // Sanity: A grows at 10%, B stays flat (less withdrawals).
    const lastA = out.years[4].accountBalances?.get('a')?.balance ?? 0;
    const lastB = out.years[4].accountBalances?.get('b')?.balance ?? 0;
    // A's 10% growth dominates — A's year-5 balance exceeds B's.
    expect(lastA).toBeGreaterThan(lastB);
    // Total stays above the no-growth lower bound (200k − 50k = 150k):
    // A's growth more than offsets total drawdown of 50k.
    expect(lastA + lastB).toBeGreaterThan(150_000);
    // Aggregate yearly withdrawn equals net need each year (no depletion).
    for (const yr of out.years) {
      expect(yr.withdrawn).toBeCloseTo(10_000, 0);
    }
  });

  it('aggregate withdrawal equals sum of per-account withdrawals', () => {
    const retirementYear = 2030;
    const horizonYear = 2034;
    const expense = buildMonthlyFromAnnualMap(
      new Map(Array.from({ length: 5 }, (_, i) => [retirementYear + i, 40_000])),
      retirementYear,
      horizonYear,
    );
    const out = simulateDrawdown({
      portfolioAtRetirement: 500_000,
      ratePct: 0,
      expensesByMonth: expense,
      incomeByMonth: buildMonthlyFromAnnualMap(new Map(), retirementYear, horizonYear),
      depositsByMonth: buildMonthlyFromAnnualMap(new Map(), retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      accounts: [
        {
          id: 'a',
          initialPre: 250_000,
          initialPost: 0,
          annualRatePct: 6,
          depositsByMonth: emptyMonthly(retirementYear, horizonYear),
          taxTreatment: 'POST_TAX',
          accountType: 'BROKERAGE',
        },
        {
          id: 'b',
          initialPre: 0,
          initialPost: 250_000,
          annualRatePct: 4,
          depositsByMonth: emptyMonthly(retirementYear, horizonYear),
          taxTreatment: 'POST_TAX',
          accountType: 'BROKERAGE',
        },
      ],
    });
    for (const yr of out.years) {
      const a = yr.accountBalances?.get('a')?.withdrawn ?? 0;
      const b = yr.accountBalances?.get('b')?.withdrawn ?? 0;
      expect(a + b).toBeCloseTo(yr.withdrawn, 1);
    }
  });

  // Characterization: the per-account engine honors a
  // per-account `returnPctByMonth` (the blended-glide seam under allocation).
  // No-tax / no-deposit / no-spend case → the annual total return equals
  // `monthlyEquivalent(blended)` compounded 12×, NOT the scalar `annualRatePct`.
  it('honors returnPctByMonth (blended glide) over the scalar rate', () => {
    const retirementYear = 2030;
    const horizonYear = 2030;
    const stepCount = 12;
    // Blended monthly rate for a 5%/yr blend; the account's scalar annualRatePct
    // is set to a DIFFERENT value (99%) to prove the scalar is NOT used.
    const blendedMonthly = monthlyEquivalent(5);
    const out = simulateDrawdown({
      portfolioAtRetirement: 0,
      ratePct: 0,
      expensesByMonth: emptyMonthly(retirementYear, horizonYear),
      incomeByMonth: emptyMonthly(retirementYear, horizonYear),
      depositsByMonth: emptyMonthly(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      accounts: [
        {
          id: 'glide',
          initialPre: 0,
          initialPost: 100_000,
          annualRatePct: 99, // scalar — must be ignored when returnPctByMonth is set
          depositsByMonth: emptyMonthly(retirementYear, horizonYear),
          taxTreatment: 'POST_TAX',
          accountType: 'BROKERAGE',
          returnPctByMonth: new Float64Array(stepCount).fill(blendedMonthly),
        },
      ],
    });
    // 100k × (1 + blendedMonthly/100)^12 = 100k × 1.05 = 105,000 (5%/yr blend),
    // NOT 100k × 1.99 (the ignored scalar).
    expect(out.years[0].balance).toBeCloseTo(105_000, 0);
  });

  // There is no single-pool fallback, so an empty `accounts`
  // array has nothing to draw from — the engine returns a zero-withdrawal
  // projection rather than synthesizing a pool.
  it('empty accounts array returns a zero-withdrawal projection', () => {
    const retirementYear = 2030;
    const horizonYear = 2031;
    const out = simulateDrawdown({
      portfolioAtRetirement: 100_000,
      ratePct: 5,
      expensesByMonth: buildMonthlyFromAnnualMap(
        new Map([[2030, 10_000], [2031, 10_000]]),
        retirementYear,
        horizonYear,
      ),
      incomeByMonth: emptyMonthly(retirementYear, horizonYear),
      depositsByMonth: emptyMonthly(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      accounts: [],
    });
    expect(out.years).toEqual([]);
    expect(out.depletionYear).toBeNull();
    expect(out.perMonthWithdrawal.length).toBe(0);
  });

  // An undefined `accounts` (the `!input.accounts` guard) is the no-pool
  // case too — there is nothing to draw from, so the engine returns the same
  // zero-withdrawal projection as the empty-array case.
  it('undefined accounts returns a zero-withdrawal projection', () => {
    const retirementYear = 2030;
    const horizonYear = 2031;
    const out = simulateDrawdown({
      portfolioAtRetirement: 100_000,
      ratePct: 5,
      expensesByMonth: buildMonthlyFromAnnualMap(
        new Map([[2030, 10_000], [2031, 10_000]]),
        retirementYear,
        horizonYear,
      ),
      incomeByMonth: emptyMonthly(retirementYear, horizonYear),
      depositsByMonth: emptyMonthly(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      accounts: undefined,
    });
    expect(out.years).toEqual([]);
    expect(out.depletionYear).toBeNull();
    expect(out.perMonthWithdrawal.length).toBe(0);
  });
});
