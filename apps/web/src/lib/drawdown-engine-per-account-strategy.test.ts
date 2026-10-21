/**
 * Unit tests for the growth adapter on `runYearByYearStrategyAware`
 * (the Monte Carlo engine reuses this deterministic engine and
 * needs per-path stochastic growth).
 *
 * `runYearByYearStrategyAware` has no direct test today (only the `-cap.ts` /
 * `-helpers.ts` siblings do), so this file pins the new optional
 * `returnPctByMonth` growth path:
 *   (1) NO `returnPctByMonth` → year-end balances are bit-identical to the
 *       current scalar-`annualRatePct` growth (deterministic fallback
 *       unchanged — guards the optimizer / deterministic call path).
 *   (2) hand-set `returnPctByMonth` → year-end balance equals the hand-computed
 *       product of `1 + returnPctByMonth[i]/100` over the months (proving
 *       `applyMonthlyGrowth(state, i)` reads the series, not `monthlyRate`).
 *   (3) a `returnPctByMonth` whose every entry equals
 *       `monthlyEquivalent(annualRatePct)` reproduces case (1) (series and
 *       scalar agree when fed the same rate → no off-by-one in the month index).
 */
import { describe, expect, it } from 'vitest';
import {
  readSeriesIntoBuffer,
  runYearByYearStrategyAware,
} from './drawdown-engine-per-account-strategy';
import type { RunYearByYearArgs } from './drawdown-engine-per-account-strategy';
import {
  computeEarlyWithdrawalPenalty,
  HSA_ADDITIONAL_TAX_RATE,
  type PenaltyAccountInput,
} from './early-withdrawal-penalty';
import type {
  DrawdownAccountInput,
  DrawdownInput,
  TaxCashflowYearClassification,
  TaxCashflowYearOutcome,
} from './drawdown-engine-types';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from './tax-integration';
import type { MonthlyCashflowSeries } from './monthly-cashflow';
import { monthlyEquivalent } from './projection-engine/monthly-conversion';

const RETIREMENT_YEAR = 2030;
const YEAR_COUNT = 2;
const STEP_COUNT = YEAR_COUNT * 12;
const INITIAL_PRE = 100_000;
const ANNUAL_RATE_PCT = 7;

/** Zero per-month series anchored at the retirement year. */
function zeroSeries(): MonthlyCashflowSeries {
  return {
    startYear: RETIREMENT_YEAR,
    startMonthIndex: 0,
    values: new Float64Array(STEP_COUNT),
  };
}

function makeAccount(overrides: Partial<DrawdownAccountInput> = {}): DrawdownAccountInput {
  return {
    id: 'acct-1',
    initialPre: INITIAL_PRE,
    initialPost: 0,
    annualRatePct: ANNUAL_RATE_PCT,
    depositsByMonth: zeroSeries(),
    taxTreatment: 'PRE_TAX',
    accountType: 'RETIREMENT_401K',
    ...overrides,
  };
}

function makeArgs(account: DrawdownAccountInput): RunYearByYearArgs {
  const input: DrawdownInput = {
    portfolioAtRetirement: INITIAL_PRE,
    ratePct: ANNUAL_RATE_PCT,
    expensesByMonth: zeroSeries(),
    incomeByMonth: zeroSeries(),
    depositsByMonth: zeroSeries(),
    retirementYear: RETIREMENT_YEAR,
    horizonYear: RETIREMENT_YEAR + YEAR_COUNT - 1,
  };
  return {
    input,
    yearCount: YEAR_COUNT,
    accountsIn: [account],
    // No spending → no withdrawals → year-end balance is purely growth-driven.
    expense: new Float64Array(STEP_COUNT),
    income: new Float64Array(STEP_COUNT),
    householdDeposit: new Float64Array(STEP_COUNT),
    strategyKind: 'proportional',
  };
}

/** The shared RMD calibration snapshot — the run needs one to accept an
 *  `rmdContext`; no RMD is ever forced here (both accounts are Roth). */
const RMD_TABLES = DEFAULT_TAX_CALIBRATION_BUNDLE.rmd;

/** A no-op tax-cashflow outcome: the hook exists only to observe the trial
 *  classification the engine builds, never to raise the year's target. */
function emptyOutcome(): TaxCashflowYearOutcome {
  return {
    addedNeedDollars: 0,
    federalTaxCashNeedCents: 0,
    irmaaWithheldFromSsCents: 0,
    irmaaCashNeedCents: 0,
    acaPtcCashflowOffsetCents: 0,
    acaCreditAppliedToPremiumsCents: 0,
    totalTaxCashflowNeedCents: 0,
    taxCashflowIterations: 1,
    taxCashflowConverged: true,
    taxCashflowShortfallCents: 0,
  };
}

/** Year-end balances (one per year) from a run with a single account. */
function yearEndBalances(args: RunYearByYearArgs): number[] {
  const { years } = runYearByYearStrategyAware(args);
  return years.map((y) => y.balance);
}

describe('runYearByYearStrategyAware — growth adapter', () => {
  it('should_grow_on_scalar_rate_when_no_returnPctByMonth_is_supplied', () => {
    const balances = yearEndBalances(makeArgs(makeAccount()));

    // Scalar fallback: 24 months of monthlyEquivalent(7%) compounding.
    const monthlyFactor = 1 + monthlyEquivalent(ANNUAL_RATE_PCT) / 100;
    const expectedYear0 = INITIAL_PRE * monthlyFactor ** 12;
    const expectedYear1 = INITIAL_PRE * monthlyFactor ** 24;

    expect(balances[0]).toBeCloseTo(expectedYear0, 6);
    expect(balances[1]).toBeCloseTo(expectedYear1, 6);
  });

  it('should_grow_on_the_per_month_series_when_returnPctByMonth_is_supplied', () => {
    // Hand-set per-month returns: alternate +1% / -0.5% so the product differs
    // from any single scalar rate.
    const returnPctByMonth = new Float64Array(STEP_COUNT);
    for (let i = 0; i < STEP_COUNT; i += 1) {
      returnPctByMonth[i] = i % 2 === 0 ? 1 : -0.5;
    }
    const balances = yearEndBalances(makeArgs(makeAccount({ returnPctByMonth })));

    let expected0 = INITIAL_PRE;
    for (let i = 0; i < 12; i += 1) expected0 *= 1 + returnPctByMonth[i] / 100;
    let expected1 = INITIAL_PRE;
    for (let i = 0; i < 24; i += 1) expected1 *= 1 + returnPctByMonth[i] / 100;

    expect(balances[0]).toBeCloseTo(expected0, 6);
    expect(balances[1]).toBeCloseTo(expected1, 6);
  });

  // ------------------------------------------------------------------
  // customOrder must never draw an HSA the user left EXCLUDED, even via
  // the medical/emergency reserve two-pass. Built-in strategies still run the
  // reserve passes (they hold HSA out of the ORDINARY tiers but intend the
  // reserve passes to draw it).
  // ------------------------------------------------------------------

  /** A two-account ledger: a non-HSA spend source + an HSA, with a positive
   *  spending need and modeled medical demand every month. */
  function makeReserveArgs(opts: {
    strategyKind: RunYearByYearArgs['strategyKind'];
    customTiers?: ReadonlyArray<ReadonlyArray<number>>;
    excludedIndices?: ReadonlySet<number>;
  }): RunYearByYearArgs {
    const expense = new Float64Array(STEP_COUNT).fill(2_000); // $2k/mo need.
    // Medical demand $1k/mo in integer cents, aligned to (retirementYear, 0).
    const medicalDemandByMonth = new Array<number>(STEP_COUNT).fill(100_000);
    const input: DrawdownInput = {
      portfolioAtRetirement: INITIAL_PRE,
      ratePct: 0,
      expensesByMonth: { startYear: RETIREMENT_YEAR, startMonthIndex: 0, values: expense },
      incomeByMonth: zeroSeries(),
      depositsByMonth: zeroSeries(),
      retirementYear: RETIREMENT_YEAR,
      horizonYear: RETIREMENT_YEAR + YEAR_COUNT - 1,
      medicalDemandByMonth,
    };
    const taxable = makeAccount({
      id: 'taxable',
      initialPre: 0,
      initialPost: 200_000,
      annualRatePct: 0,
      taxTreatment: 'POST_TAX',
      accountType: 'BROKERAGE',
    });
    const hsa = makeAccount({
      id: 'hsa',
      initialPre: 0,
      initialPost: 50_000,
      annualRatePct: 0,
      taxTreatment: 'HSA',
      accountType: 'HSA',
    });
    return {
      input,
      yearCount: YEAR_COUNT,
      accountsIn: [taxable, hsa],
      expense,
      income: new Float64Array(STEP_COUNT),
      householdDeposit: new Float64Array(STEP_COUNT),
      strategyKind: opts.strategyKind,
      ...(opts.customTiers ? { customTiers: opts.customTiers } : {}),
      ...(opts.excludedIndices ? { excludedIndices: opts.excludedIndices } : {}),
    };
  }

  /** Sum the HSA account's withdrawal across every year. */
  function hsaWithdrawn(args: RunYearByYearArgs): number {
    const { years } = runYearByYearStrategyAware(args);
    let sum = 0;
    for (const y of years) sum += y.accountBalances?.get('hsa')?.withdrawn ?? 0;
    return sum;
  }

  it('should_leave_an_excluded_HSA_untouched_under_customOrder_even_with_medical_demand', () => {
    // customOrder: the taxable account (state index 0) is the sole tier; the HSA
    // (state index 1) is in excludedAccountIds (the DEFAULT). The medical +
    // emergency reserve passes must NOT draw it.
    const args = makeReserveArgs({
      strategyKind: 'customOrder',
      customTiers: [[0]],
      excludedIndices: new Set([1]),
    });
    expect(hsaWithdrawn(args)).toBe(0);
  });

  it('should_still_run_the_HSA_reserve_passes_for_a_built_in_strategy', () => {
    // taxEfficient holds HSA out of the ORDINARY tiers but the medical pass funds
    // the modeled demand from the HSA — so it IS drawn (the reserve passes stay
    // on for the built-in strategies; the gate applies to customOrder only).
    const args = makeReserveArgs({ strategyKind: 'taxEfficient' });
    expect(hsaWithdrawn(args)).toBeGreaterThan(0);
  });

  it('should_reproduce_the_scalar_path_when_series_equals_the_monthly_equivalent_rate', () => {
    const scalarBalances = yearEndBalances(makeArgs(makeAccount()));

    // Every month carries exactly monthlyEquivalent(annualRatePct).
    const monthlyPct = monthlyEquivalent(ANNUAL_RATE_PCT);
    const returnPctByMonth = new Float64Array(STEP_COUNT).fill(monthlyPct);
    const seriesBalances = yearEndBalances(makeArgs(makeAccount({ returnPctByMonth })));

    // Series-fed-with-the-scalar-rate must match the scalar path bit-for-bit
    // (no off-by-one in the month index).
    expect(seriesBalances[0]).toBeCloseTo(scalarBalances[0], 9);
    expect(seriesBalances[1]).toBeCloseTo(scalarBalances[1], 9);
  });
});

// ---------------------------------------------------------------------------
// Per-account minimum-balance floor.
// ---------------------------------------------------------------------------

describe('runYearByYearStrategyAware — account floors', () => {
  // A 0%-growth single-year run so balances are pure withdrawal arithmetic.
  const RET = 2030;
  const flatZeroSeries = (): MonthlyCashflowSeries => ({
    startYear: RET,
    startMonthIndex: 0,
    values: new Float64Array(12),
  });
  function floorAccount(overrides: Partial<DrawdownAccountInput>): DrawdownAccountInput {
    return {
      id: 'x',
      initialPre: 0,
      initialPost: 0,
      annualRatePct: 0,
      depositsByMonth: flatZeroSeries(),
      taxTreatment: 'POST_TAX',
      accountType: 'BROKERAGE',
      ...overrides,
    };
  }
  /** Run one year with a flat monthly expense (no income), returning the engine
   *  result. `medical` (dollars/month, integer cents in input) drives the HSA
   *  medical pass. */
  function runOneYear(args: {
    accounts: DrawdownAccountInput[];
    monthlyExpense: number;
    strategyKind?: RunYearByYearArgs['strategyKind'];
    medicalMonthly?: number;
    customTiers?: ReadonlyArray<ReadonlyArray<number>>;
    excludedIndices?: ReadonlySet<number>;
  }) {
    const expense = new Float64Array(12).fill(args.monthlyExpense);
    const medicalCents = args.medicalMonthly
      ? new Array<number>(12).fill(Math.round(args.medicalMonthly * 100))
      : undefined;
    const input: DrawdownInput = {
      portfolioAtRetirement: 0,
      ratePct: 0,
      expensesByMonth: { startYear: RET, startMonthIndex: 0, values: expense },
      incomeByMonth: flatZeroSeries(),
      depositsByMonth: flatZeroSeries(),
      retirementYear: RET,
      horizonYear: RET,
      ...(medicalCents ? { medicalDemandByMonth: medicalCents } : {}),
    };
    return runYearByYearStrategyAware({
      input,
      yearCount: 1,
      accountsIn: args.accounts,
      expense,
      income: new Float64Array(12),
      householdDeposit: new Float64Array(12),
      strategyKind: args.strategyKind ?? 'taxEfficient',
      ...(args.customTiers ? { customTiers: args.customTiers } : {}),
      ...(args.excludedIndices ? { excludedIndices: args.excludedIndices } : {}),
    });
  }

  it('draws a floored POST_TAX reserve as a LAST RESORT once nothing else remains', () => {
    // Single floored brokerage, $100k, floor $40k. Spend $80k/yr. The ordinary
    // path draws only the $60k above the floor; the remaining $20k need then
    // drains the protected reserve as a last resort (drawFloorReserve). The year
    // is FULLY funded, so it is NOT depleted.
    const acct = floorAccount({ id: 'broker', initialPost: 100_000, floorDollars: 40_000 });
    const { years } = runOneYear({ accounts: [acct], monthlyExpense: 80_000 / 12 });
    const row = years[0].accountBalances!.get('broker')!;
    expect(row.balance).toBeCloseTo(20_000, 4); // reserve drained below the floor
    expect(years[0].withdrawn).toBeCloseTo(80_000, 4);
    expect(years[0].depleted).toBe(false); // reserve-funded year is not depleted
  });

  it('drains a floored-only POST_TAX account all the way to $0 under a large need', () => {
    // Spend more than the whole balance → the reserve drains to $0 and the year
    // is depleted only because even the reserve cannot cover the full need.
    const acct = floorAccount({ id: 'broker', initialPost: 100_000, floorDollars: 40_000 });
    const { years } = runOneYear({ accounts: [acct], monthlyExpense: 150_000 / 12 });
    expect(years[0].accountBalances!.get('broker')!.balance).toBeCloseTo(0, 4);
    expect(years[0].withdrawn).toBeCloseTo(100_000, 4);
    expect(years[0].depleted).toBe(true); // need exceeds even the drained reserve
  });

  it('routes the floor-blocked shortfall to the next account in the order', () => {
    // Floored brokerage ($40k floor on $50k) + an unfloored pre-tax 401k. Spend
    // $40k: brokerage supplies $10k (down to floor), 401k supplies the rest.
    const broker = floorAccount({ id: 'broker', initialPost: 50_000, floorDollars: 40_000 });
    const pretax = floorAccount({
      id: 'pretax', initialPre: 100_000, taxTreatment: 'PRE_TAX',
      accountType: 'RETIREMENT_401K',
    });
    const { years } = runOneYear({
      accounts: [broker, pretax], monthlyExpense: 40_000 / 12, strategyKind: 'taxEfficient',
    });
    const brokerRow = years[0].accountBalances!.get('broker')!;
    const pretaxRow = years[0].accountBalances!.get('pretax')!;
    expect(brokerRow.balance).toBeCloseTo(40_000, 4); // brokerage stops at floor
    expect(pretaxRow.withdrawn).toBeCloseTo(30_000, 4); // 401k funds the rest
    expect(years[0].depleted).toBe(false); // fully funded — no unmet need
  });

  it('floor re-entry: a floored account contributes max(0, balance − floor) each year', () => {
    // Brokerage $50k, floor $40k, growing 10%/yr, modest spend. Year 1 should
    // draw the surplus above the floor again as growth lifts it back up.
    const broker = floorAccount({
      id: 'broker', initialPost: 50_000, floorDollars: 40_000, annualRatePct: 10,
    });
    const expense = new Float64Array(24).fill(5_000 / 12); // $5k/yr
    const input: DrawdownInput = {
      portfolioAtRetirement: 0, ratePct: 0,
      expensesByMonth: { startYear: RET, startMonthIndex: 0, values: expense },
      incomeByMonth: { startYear: RET, startMonthIndex: 0, values: new Float64Array(24) },
      depositsByMonth: { startYear: RET, startMonthIndex: 0, values: new Float64Array(24) },
      retirementYear: RET, horizonYear: RET + 1,
    };
    const { years } = runYearByYearStrategyAware({
      input, yearCount: 2, accountsIn: [broker],
      expense, income: new Float64Array(24), householdDeposit: new Float64Array(24),
      strategyKind: 'taxEfficient',
    });
    // Never below the floor in either year.
    expect(years[0].accountBalances!.get('broker')!.balance).toBeGreaterThanOrEqual(40_000 - 1e-6);
    expect(years[1].accountBalances!.get('broker')!.balance).toBeGreaterThanOrEqual(40_000 - 1e-6);
    // Year 1 still drew SOMETHING (growth re-opened the surplus above the floor).
    expect(years[1].withdrawn).toBeGreaterThan(0);
  });

  it('does NOT floor an ineligible PRE_TAX account carrying a stray floor entry', () => {
    // A PRE_TAX account is floor-INELIGIBLE — the engine predicate ignores the
    // floor, so the full balance is drawable.
    const pretax = floorAccount({
      id: 'pretax', initialPre: 100_000, floorDollars: 40_000,
      taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_401K',
    });
    const { years } = runOneYear({ accounts: [pretax], monthlyExpense: 80_000 / 12 });
    // Drew the full $80k despite the (ignored) floor.
    expect(years[0].withdrawn).toBeCloseTo(80_000, 4);
    expect(years[0].accountBalances!.get('pretax')!.balance).toBeCloseTo(20_000, 4);
  });

  it('all-accounts-at-floor → the reserves fund the need proportionally; no NaN', () => {
    // Both accounts start AT their floor, so the ordinary path draws $0. The
    // last-resort reserve pass then splits the $50k need proportionally across
    // the two floor reserves ($40k + $30k = $70k pool ≥ $50k need), so the year
    // is fully funded (not depleted).
    const a = floorAccount({ id: 'a', initialPost: 40_000, floorDollars: 40_000 });
    const b = floorAccount({ id: 'b', initialPost: 30_000, floorDollars: 30_000 });
    const { years } = runOneYear({ accounts: [a, b], monthlyExpense: 50_000 / 12 });
    expect(years[0].withdrawn).toBeCloseTo(50_000, 4);
    expect(Number.isFinite(years[0].balance)).toBe(true);
    // Proportional split: a → 50k·40/70 ≈ 28.57k drawn (11.43k left); b → 21.43k
    // drawn (8.57k left).
    expect(years[0].accountBalances!.get('a')!.balance).toBeCloseTo(40_000 - 50_000 * (40 / 70), 3);
    expect(years[0].accountBalances!.get('b')!.balance).toBeCloseTo(30_000 - 50_000 * (30 / 70), 3);
    expect(years[0].depleted).toBe(false);
  });

  it('remains depleted only when even the drained reserves cannot cover the need', () => {
    // Both at floor, total $70k, but the need is $90k → reserves drain to $0 and
    // the $20k shortfall keeps the year depleted.
    const a = floorAccount({ id: 'a', initialPost: 40_000, floorDollars: 40_000 });
    const b = floorAccount({ id: 'b', initialPost: 30_000, floorDollars: 30_000 });
    const { years } = runOneYear({ accounts: [a, b], monthlyExpense: 90_000 / 12 });
    expect(years[0].withdrawn).toBeCloseTo(70_000, 4);
    expect(years[0].accountBalances!.get('a')!.balance).toBeCloseTo(0, 4);
    expect(years[0].accountBalances!.get('b')!.balance).toBeCloseTo(0, 4);
    expect(years[0].depleted).toBe(true);
  });

  it('never drains a custom-order EXCLUDED account, even as last resort', () => {
    // Excluded brokerage ($50k) + a floored, non-excluded brokerage ($30k floor
    // $20k). Spend $60k. The excluded account is out of the withdrawal order
    // entirely (stronger than a floor), so only the non-excluded account —
    // ordinary above-floor $10k + reserve $20k = $30k — funds the need; the
    // excluded $50k stays fully intact and the residual $30k need is depleted.
    const excluded = floorAccount({ id: 'excl', initialPost: 50_000 });
    const floored = floorAccount({ id: 'keep', initialPost: 30_000, floorDollars: 20_000 });
    const { years } = runOneYear({
      accounts: [excluded, floored], monthlyExpense: 60_000 / 12,
      strategyKind: 'customOrder', customTiers: [[1]], excludedIndices: new Set([0]),
    });
    expect(years[0].accountBalances!.get('excl')!.balance).toBeCloseTo(50_000, 4); // untouched
    expect(years[0].accountBalances!.get('keep')!.balance).toBeCloseTo(0, 4); // reserve drained
    expect(years[0].withdrawn).toBeCloseTo(30_000, 4);
    expect(years[0].depleted).toBe(true);
  });

  it("HSA emergencyOnly: medical draw (PASS A) may go below floor; emergency (PASS B) blocked", () => {
    // HSA $50k, floor $40k, emergencyOnly. $20k of medical demand → PASS A funds
    // it (below the floor); any emergency residual is blocked at the floor.
    const hsa = floorAccount({
      id: 'hsa', initialPost: 50_000, floorDollars: 40_000,
      taxTreatment: 'HSA', accountType: 'HSA', floorHsaMode: 'emergencyOnly',
    });
    const { years } = runOneYear({
      accounts: [hsa], monthlyExpense: 20_000 / 12, medicalMonthly: 20_000 / 12,
    });
    // PASS A drew the full $20k medical, taking the balance to $30k (below floor).
    expect(years[0].accountBalances!.get('hsa')!.balance).toBeCloseTo(30_000, 4);
    expect(years[0].withdrawn).toBeCloseTo(20_000, 4);
  });

  it("HSA emergencyOnly: reserve drains below the floor as a last resort", () => {
    // HSA $50k, floor $40k, emergencyOnly, NO medical demand. The whole need is
    // emergency: PASS B draws the $10k above the floor, then the last-resort
    // reserve pass drains a further $15k BELOW the floor to fully fund the year.
    // None of the HSA draw is medical-qualified (no demand), so the whole $25k is
    // emergency/nonmedical (residual rule) — no medicalQualifiedWithdrawnCents.
    const hsa = floorAccount({
      id: 'hsa', initialPost: 50_000, floorDollars: 40_000,
      taxTreatment: 'HSA', accountType: 'HSA', floorHsaMode: 'emergencyOnly',
    });
    const { years } = runOneYear({ accounts: [hsa], monthlyExpense: 25_000 / 12 });
    const row = years[0].accountBalances!.get('hsa')!;
    expect(row.balance).toBeCloseTo(25_000, 4); // $10k above-floor + $15k reserve
    expect(years[0].withdrawn).toBeCloseTo(25_000, 4);
    expect(years[0].depleted).toBe(false);
    expect(row.medicalQualifiedWithdrawnCents ?? 0).toBe(0); // all nonmedical
  });

  it("HSA strict: reserve drains below the floor as a last resort, medical residual preserved", () => {
    // HSA $50k, floor $40k, strict, $20k medical demand, spend $20k. PASS A
    // (strict) draws only the $10k above the floor as medical-qualified. The
    // remaining $10k need then drains the reserve BELOW the floor (nonmedical).
    // The medical-qualified draw ($10k) is UNCHANGED by the reserve pass.
    const hsa = floorAccount({
      id: 'hsa', initialPost: 50_000, floorDollars: 40_000,
      taxTreatment: 'HSA', accountType: 'HSA', floorHsaMode: 'strict',
    });
    const { years } = runOneYear({
      accounts: [hsa], monthlyExpense: 20_000 / 12, medicalMonthly: 20_000 / 12,
    });
    const row = years[0].accountBalances!.get('hsa')!;
    expect(row.balance).toBeCloseTo(30_000, 4); // $10k medical + $10k reserve
    expect(years[0].withdrawn).toBeCloseTo(20_000, 4);
    expect(years[0].depleted).toBe(false);
    // PASS A medical-qualified stays exactly $10k — the reserve draw is nonmedical.
    expect(row.medicalQualifiedWithdrawnCents).toBe(1_000_000);
  });

  it('customOrder + HSA-in-tier: reserve drains the HSA below its floor as last resort', () => {
    // HSA $50k, floor $40k, emergencyOnly, sole custom tier (index 0), NOT
    // excluded, NO medical demand. The ordinary custom-tier draw takes the $10k
    // above the floor; the last-resort reserve pass then drains $15k more below
    // the floor to fully fund the $25k need.
    const hsa = floorAccount({
      id: 'hsa', initialPost: 50_000, floorDollars: 40_000,
      taxTreatment: 'HSA', accountType: 'HSA', floorHsaMode: 'emergencyOnly',
    });
    const { years } = runOneYear({
      accounts: [hsa], monthlyExpense: 25_000 / 12,
      strategyKind: 'customOrder', customTiers: [[0]],
    });
    expect(years[0].accountBalances!.get('hsa')!.balance).toBeCloseTo(25_000, 4);
    expect(years[0].withdrawn).toBeCloseTo(25_000, 4);
    expect(years[0].depleted).toBe(false);
  });

  it('customOrder: a floored HSA in an EARLIER tier drains only AFTER a later-tier POST_TAX reserve', () => {
    // Custom tiers put a floored HSA (index 0) in the EARLIER tier and a floored
    // POST_TAX brokerage (index 1) in the LATER tier. Both are floor-eligible and
    // non-excluded. `buildCustomTierIndices` maps the HSA's state index straight
    // into tier 0 with no type filter, so a naive phase-1 loop would drain the
    // HSA's reserve first — incurring the pre-65 20% §223(f)(4) additional tax a
    // POST_TAX reserve draw avoids. The fix holds every HSA out of phase 1: the
    // brokerage reserve (later tier) must fully drain BEFORE the HSA reserve is
    // touched at all.
    //   HSA $50k floor $40k emergencyOnly: ordinary above-floor draw $10k → $40k.
    //   Brokerage $30k floor $20k: ordinary above-floor draw $10k → $20k (= floor,
    //     $20k reserve). Spend $50k → $20k ordinary + $30k unmet.
    //   Phase 1 drains the brokerage reserve $20k → $0; phase 2 then draws just
    //   $10k of the HSA reserve → $30k. (Under the bug the HSA would drop to $10k
    //   and the brokerage would stay at its $20k floor.)
    const hsa = floorAccount({
      id: 'hsa', initialPost: 50_000, floorDollars: 40_000,
      taxTreatment: 'HSA', accountType: 'HSA', floorHsaMode: 'emergencyOnly',
    });
    const broker = floorAccount({ id: 'broker', initialPost: 30_000, floorDollars: 20_000 });
    const { years } = runOneYear({
      accounts: [hsa, broker], monthlyExpense: 50_000 / 12,
      strategyKind: 'customOrder', customTiers: [[0], [1]],
    });
    // Brokerage reserve fully drained first…
    expect(years[0].accountBalances!.get('broker')!.balance).toBeCloseTo(0, 4);
    // …and only the residual $10k of the HSA reserve is touched (not $30k).
    expect(years[0].accountBalances!.get('hsa')!.balance).toBeCloseTo(30_000, 4);
    expect(years[0].withdrawn).toBeCloseTo(50_000, 4);
    expect(years[0].depleted).toBe(false);
  });

  it('customOrder: an EXCLUDED HSA floor reserve is NEVER drained, even as last resort', () => {
    // HSA $50k, floor $40k, EXCLUDED (index 0), plus a floored brokerage. The
    // excluded HSA is a protected medical reserve out of the withdrawal order
    // entirely — the reserve pass must never touch it. Spend $30k; only
    // the brokerage (above-floor $10k + reserve $20k) funds it.
    const hsa = floorAccount({
      id: 'hsa', initialPost: 50_000, floorDollars: 40_000,
      taxTreatment: 'HSA', accountType: 'HSA', floorHsaMode: 'emergencyOnly',
    });
    const broker = floorAccount({ id: 'broker', initialPost: 30_000, floorDollars: 20_000 });
    const { years } = runOneYear({
      accounts: [hsa, broker], monthlyExpense: 30_000 / 12,
      strategyKind: 'customOrder', customTiers: [[1]], excludedIndices: new Set([0]),
    });
    expect(years[0].accountBalances!.get('hsa')!.balance).toBeCloseTo(50_000, 4); // untouched
    expect(years[0].accountBalances!.get('broker')!.balance).toBeCloseTo(0, 4);
    expect(years[0].withdrawn).toBeCloseTo(30_000, 4);
    expect(years[0].depleted).toBe(false);
  });

  it('a below-floor HSA reserve draw is nonqualified → 20% §223(f)(4) tax pre-65, none post-65', () => {
    // HSA $50k, floor $40k, emergencyOnly, NO medical demand, spend $25k. The
    // ordinary emergency pass takes $10k above the floor and the reserve pass a
    // further $15k below it — all $25k is emergency/nonmedical (no medical
    // demand), so `withdrawn − medicalQualified` is the full nonqualified basis.
    const hsa = floorAccount({
      id: 'hsa', initialPost: 50_000, floorDollars: 40_000,
      taxTreatment: 'HSA', accountType: 'HSA', floorHsaMode: 'emergencyOnly',
    });
    const { years } = runOneYear({ accounts: [hsa], monthlyExpense: 25_000 / 12 });
    const row = years[0].accountBalances!.get('hsa')!;
    const withdrawnCents = Math.round(row.withdrawn * 100);
    const nonqualifiedDollars = (withdrawnCents - (row.medicalQualifiedWithdrawnCents ?? 0)) / 100;
    expect(nonqualifiedDollars).toBeCloseTo(25_000, 4); // whole reserve+emergency draw
    // Feed the reserve draw's nonqualified basis into the actual §223(f)(4)
    // engine: 20% additional tax BEFORE 65, $0 AFTER 65.
    const acct = (birthdate: string): PenaltyAccountInput[] => [
      { id: 'hsa', type: 'HSA', penaltyBasisDollars: nonqualifiedDollars, ownerBirthdate: birthdate },
    ];
    const pre65 = computeEarlyWithdrawalPenalty(acct('1980-06-15'), RET, []);
    expect(pre65.hsaAdditionalTaxDollars).toBeCloseTo(25_000 * HSA_ADDITIONAL_TAX_RATE, 4);
    const post65 = computeEarlyWithdrawalPenalty(acct('1955-06-15'), RET, []);
    expect(post65.hsaAdditionalTaxDollars).toBe(0);
  });

  it('no floor set reproduces the unfloored draw (byte-identical default)', () => {
    const floored = floorAccount({ id: 'broker', initialPost: 100_000 });
    const { years } = runOneYear({ accounts: [floored], monthlyExpense: 80_000 / 12 });
    expect(years[0].accountBalances!.get('broker')!.balance).toBeCloseTo(20_000, 4);
    expect(years[0].withdrawn).toBeCloseTo(80_000, 4);
  });
});

describe('readSeriesIntoBuffer — deposit double-copy fast path', () => {
  it('returns the SAME Float64Array reference when it is already exact-length', () => {
    const values = new Float64Array([1, 2, 3, 4]);
    const series: MonthlyCashflowSeries = { startYear: 2030, startMonthIndex: 0, values };
    // Exact-length typed input → no defensive copy (reference reuse). The MC
    // caller's per-path buffers are private + read-only downstream, so aliasing
    // is safe.
    expect(readSeriesIntoBuffer(series, 4)).toBe(values);
  });

  it('still zero-pads a SHORTER array via the copy path (behavior preserved)', () => {
    const values = new Float64Array([1, 2]);
    const series: MonthlyCashflowSeries = { startYear: 2030, startMonthIndex: 0, values };
    const out = readSeriesIntoBuffer(series, 4);
    expect(out).not.toBe(values); // copy path, not the fast path
    expect(Array.from(out)).toEqual([1, 2, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// The FUNDING pass's inherited marker. `classifyAccountDraw` buckets a draw
// off `AccountRunState`, which carried `taxTreatment` and `accountType` and no
// inherited marker; the aggregate the solver receives has already lost the
// distinction by the time the runner sees it. The marker is sourced from the RMD
// context both engines already build, so no new serialized Monte Carlo input
// field is introduced.
// ---------------------------------------------------------------------------

describe('runYearByYearStrategyAware — inherited marker on the run state', () => {
  /** Capture the year-0 trial classification the engine hands the solver. */
  function classifyYear0(inheritedAccountIds: readonly string[]): TaxCashflowYearClassification {
    const rothIra = makeAccount({
      id: 'roth-inherited',
      initialPre: 0,
      initialPost: 200_000,
      taxTreatment: 'ROTH',
      accountType: 'RETIREMENT_ROTH_IRA',
    });
    const roth401k = makeAccount({
      id: 'roth-401k',
      initialPre: 0,
      initialPost: 200_000,
      taxTreatment: 'ROTH',
      accountType: 'RETIREMENT_ROTH_401K',
    });
    const captured: TaxCashflowYearClassification[] = [];
    const base = makeArgs(rothIra);
    const rmdFactsByAccountId = Object.fromEntries(
      inheritedAccountIds.map((id) => [id, { inheritedAccount: true }]),
    );
    runYearByYearStrategyAware({
      ...base,
      accountsIn: [rothIra, roth401k],
      // $60k/yr of spending so both Roth sources are actually drawn.
      expense: new Float64Array(STEP_COUNT).fill(5_000),
      rmdContext: {
        ownerMeta: new Map(),
        ownerByAccountId: new Map([
          ['roth-inherited', 'm1'],
          ['roth-401k', 'm1'],
        ]),
        rmdSnapshot: RMD_TABLES,
        rmdFactsByAccountId,
      },
      taxCashflow: {
        solveForYear: (_yearIndex, ordinaryNetNeedDollars, classify) => {
          captured.push(classify(ordinaryNetNeedDollars));
          return emptyOutcome();
        },
      },
    });
    expect(captured.length).toBeGreaterThan(0);
    return captured[0];
  }

  it('routes an inherited Roth IRA draw into the tax-free SUBSET of the Roth tranche', () => {
    const cls = classifyYear0(['roth-inherited']);
    // A SUBSET, not a deduction: the Roth total (and so `fundedDollars`) is
    // unchanged, and only the carrier consumption downstream shrinks.
    expect(cls.rothDollars).toBeGreaterThan(0);
    expect(cls.rothInheritedTaxFreeDollars).toBeGreaterThan(0);
    expect(cls.rothInheritedTaxFreeDollars!).toBeLessThan(cls.rothDollars);
    expect(cls.fundedDollars).toBeGreaterThanOrEqual(cls.rothDollars);
  });

  it('emits no subset when the household records no inherited account', () => {
    const cls = classifyYear0([]);
    expect(cls.rothDollars).toBeGreaterThan(0);
    expect(cls.rothInheritedTaxFreeDollars).toBeUndefined();
  });

  it('leaves an inherited DESIGNATED-Roth plan out of the subset (§402A unchanged)', () => {
    const cls = classifyYear0(['roth-401k']);
    expect(cls.rothDollars).toBeGreaterThan(0);
    expect(cls.rothInheritedTaxFreeDollars).toBeUndefined();
  });
});
