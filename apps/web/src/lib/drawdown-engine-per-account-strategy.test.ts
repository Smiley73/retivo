/** Unit tests for the growth adapter, the account floors and the inherited marker on `runYearByYearStrategyAware`. */
import { describe, expect, it } from 'vitest';
import {
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
    expense: new Float64Array(STEP_COUNT),
    income: new Float64Array(STEP_COUNT),
    householdDeposit: new Float64Array(STEP_COUNT),
    strategyKind: 'proportional',
  };
}

const RMD_TABLES = DEFAULT_TAX_CALIBRATION_BUNDLE.rmd;

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

function yearEndBalances(args: RunYearByYearArgs): number[] {
  const { years } = runYearByYearStrategyAware(args);
  return years.map((y) => y.balance);
}

describe('runYearByYearStrategyAware — growth adapter', () => {
  it('should_grow_on_scalar_rate_when_no_returnPctByMonth_is_supplied', () => {
    const balances = yearEndBalances(makeArgs(makeAccount()));

    const monthlyFactor = 1 + monthlyEquivalent(ANNUAL_RATE_PCT) / 100;
    const expectedYear0 = INITIAL_PRE * monthlyFactor ** 12;
    const expectedYear1 = INITIAL_PRE * monthlyFactor ** 24;

    expect(balances[0]).toBeCloseTo(expectedYear0, 6);
    expect(balances[1]).toBeCloseTo(expectedYear1, 6);
  });

  it('should_grow_on_the_per_month_series_when_returnPctByMonth_is_supplied', () => {
    // Alternating +1% / -0.5% so the product differs from any single scalar rate.
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

  // customOrder must never draw an HSA the user left excluded, even via the medical/emergency reserve passes; built-in
  // strategies still run those passes.

  function makeReserveArgs(opts: {
    strategyKind: RunYearByYearArgs['strategyKind'];
    customTiers?: ReadonlyArray<ReadonlyArray<number>>;
    excludedIndices?: ReadonlySet<number>;
  }): RunYearByYearArgs {
    const expense = new Float64Array(STEP_COUNT).fill(2_000); // $2k/mo need.
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

  function hsaWithdrawn(args: RunYearByYearArgs): number {
    const { years } = runYearByYearStrategyAware(args);
    let sum = 0;
    for (const y of years) sum += y.accountBalances?.get('hsa')?.withdrawn ?? 0;
    return sum;
  }

  it('should_leave_an_excluded_HSA_untouched_under_customOrder_even_with_medical_demand', () => {
    // The taxable account (state index 0) is the sole tier and the HSA (index 1) is excluded by default, so the reserve passes
    // must not draw it.
    const args = makeReserveArgs({
      strategyKind: 'customOrder',
      customTiers: [[0]],
      excludedIndices: new Set([1]),
    });
    expect(hsaWithdrawn(args)).toBe(0);
  });

  it('should_still_run_the_HSA_reserve_passes_for_a_built_in_strategy', () => {
    // taxEfficient holds HSA out of the ordinary tiers, but the medical pass funds the modeled demand from it: the reserve
    // passes stay on for built-in strategies.
    const args = makeReserveArgs({ strategyKind: 'taxEfficient' });
    expect(hsaWithdrawn(args)).toBeGreaterThan(0);
  });

  it('should_reproduce_the_scalar_path_when_series_equals_the_monthly_equivalent_rate', () => {
    const scalarBalances = yearEndBalances(makeArgs(makeAccount()));

    const monthlyPct = monthlyEquivalent(ANNUAL_RATE_PCT);
    const returnPctByMonth = new Float64Array(STEP_COUNT).fill(monthlyPct);
    const seriesBalances = yearEndBalances(makeArgs(makeAccount({ returnPctByMonth })));

    expect(seriesBalances[0]).toBeCloseTo(scalarBalances[0], 9);
    expect(seriesBalances[1]).toBeCloseTo(scalarBalances[1], 9);
  });
});

describe('runYearByYearStrategyAware — account floors', () => {
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
    // Single floored brokerage ($100k, floor $40k), spend $80k: the ordinary path draws the $60k above the floor and the
    // last-resort drawFloorReserve covers the other $20k, so the year is fully funded, not depleted.
    const acct = floorAccount({ id: 'broker', initialPost: 100_000, floorDollars: 40_000 });
    const { years } = runOneYear({ accounts: [acct], monthlyExpense: 80_000 / 12 });
    const row = years[0].accountBalances!.get('broker')!;
    expect(row.balance).toBeCloseTo(20_000, 4); // reserve drained below the floor
    expect(years[0].withdrawn).toBeCloseTo(80_000, 4);
    expect(years[0].depleted).toBe(false); // reserve-funded year is not depleted
  });

  it('drains a floored-only POST_TAX account all the way to $0 under a large need', () => {
    // Spending beyond the whole balance drains the reserve to $0 and leaves the year depleted.
    const acct = floorAccount({ id: 'broker', initialPost: 100_000, floorDollars: 40_000 });
    const { years } = runOneYear({ accounts: [acct], monthlyExpense: 150_000 / 12 });
    expect(years[0].accountBalances!.get('broker')!.balance).toBeCloseTo(0, 4);
    expect(years[0].withdrawn).toBeCloseTo(100_000, 4);
    expect(years[0].depleted).toBe(true); // need exceeds even the drained reserve
  });

  it('routes the floor-blocked shortfall to the next account in the order', () => {
    // Floored brokerage ($40k floor on $50k) + an unfloored pre-tax 401k, spend $40k: the brokerage supplies $10k (down to the
    // floor), the 401k the rest.
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
    // Growth at 10%/yr lifts the brokerage above its floor again, so year 1 draws the surplus.
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
    expect(years[0].accountBalances!.get('broker')!.balance).toBeGreaterThanOrEqual(40_000 - 1e-6);
    expect(years[1].accountBalances!.get('broker')!.balance).toBeGreaterThanOrEqual(40_000 - 1e-6);
    expect(years[1].withdrawn).toBeGreaterThan(0);
  });

  it('does NOT floor an ineligible PRE_TAX account carrying a stray floor entry', () => {
    const pretax = floorAccount({
      id: 'pretax', initialPre: 100_000, floorDollars: 40_000,
      taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_401K',
    });
    const { years } = runOneYear({ accounts: [pretax], monthlyExpense: 80_000 / 12 });
    expect(years[0].withdrawn).toBeCloseTo(80_000, 4);
    expect(years[0].accountBalances!.get('pretax')!.balance).toBeCloseTo(20_000, 4);
  });

  it('all-accounts-at-floor → the reserves fund the need proportionally; no NaN', () => {
    // Both accounts start at their floor, so the ordinary path draws $0 and the reserve pass splits the $50k need
    // proportionally across the $70k pool: fully funded.
    const a = floorAccount({ id: 'a', initialPost: 40_000, floorDollars: 40_000 });
    const b = floorAccount({ id: 'b', initialPost: 30_000, floorDollars: 30_000 });
    const { years } = runOneYear({ accounts: [a, b], monthlyExpense: 50_000 / 12 });
    expect(years[0].withdrawn).toBeCloseTo(50_000, 4);
    expect(Number.isFinite(years[0].balance)).toBe(true);
    // Proportional split: a draws 50k·40/70 ≈ 28.57k; b ≈ 21.43k.
    expect(years[0].accountBalances!.get('a')!.balance).toBeCloseTo(40_000 - 50_000 * (40 / 70), 3);
    expect(years[0].accountBalances!.get('b')!.balance).toBeCloseTo(30_000 - 50_000 * (30 / 70), 3);
    expect(years[0].depleted).toBe(false);
  });

  it('remains depleted only when even the drained reserves cannot cover the need', () => {
    // Total $70k against a $90k need drains both reserves to $0 and keeps the year depleted by $20k.
    const a = floorAccount({ id: 'a', initialPost: 40_000, floorDollars: 40_000 });
    const b = floorAccount({ id: 'b', initialPost: 30_000, floorDollars: 30_000 });
    const { years } = runOneYear({ accounts: [a, b], monthlyExpense: 90_000 / 12 });
    expect(years[0].withdrawn).toBeCloseTo(70_000, 4);
    expect(years[0].accountBalances!.get('a')!.balance).toBeCloseTo(0, 4);
    expect(years[0].accountBalances!.get('b')!.balance).toBeCloseTo(0, 4);
    expect(years[0].depleted).toBe(true);
  });

  it('never drains a custom-order EXCLUDED account, even as last resort', () => {
    // An excluded brokerage ($50k) is out of the withdrawal order entirely, so only the non-excluded floored one (above-floor
    // $10k + reserve $20k) funds the $60k spend; the excluded $50k stays intact and $30k is unmet.
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
    // HSA $50k, floor $40k, emergencyOnly, $20k medical demand: PASS A funds it below the floor; any emergency residual is
    // blocked at the floor.
    const hsa = floorAccount({
      id: 'hsa', initialPost: 50_000, floorDollars: 40_000,
      taxTreatment: 'HSA', accountType: 'HSA', floorHsaMode: 'emergencyOnly',
    });
    const { years } = runOneYear({
      accounts: [hsa], monthlyExpense: 20_000 / 12, medicalMonthly: 20_000 / 12,
    });
    expect(years[0].accountBalances!.get('hsa')!.balance).toBeCloseTo(30_000, 4);
    expect(years[0].withdrawn).toBeCloseTo(20_000, 4);
  });

  it("HSA emergencyOnly: reserve drains below the floor as a last resort", () => {
    // No medical demand, so the whole need is emergency: PASS B draws the $10k above the floor and the last-resort reserve pass
    // a further $15k below it; none of it is medical-qualified.
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
    // Strict mode, $20k medical demand and spend: PASS A draws only the $10k above the floor as medical-qualified, then the
    // reserve drains the remaining $10k below the floor as nonmedical.
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
    expect(row.medicalQualifiedWithdrawnCents).toBe(1_000_000);
  });

  it('customOrder + HSA-in-tier: reserve drains the HSA below its floor as last resort', () => {
    // customOrder with the HSA as the sole, non-excluded tier and no medical demand: the ordinary draw takes the $10k above the
    // floor and the reserve pass the other $15k.
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
    // A floored HSA in the earlier custom tier and a floored brokerage in the later one: buildCustomTierIndices maps the HSA
    // into tier 0 with no type filter, so phase 1 must hold every HSA out, or it would incur the pre-65 20% §223(f)(4) tax a
    // POST_TAX reserve draw avoids. The brokerage reserve ($20k) drains first, then only $10k of the HSA reserve (→ $30k).
    const hsa = floorAccount({
      id: 'hsa', initialPost: 50_000, floorDollars: 40_000,
      taxTreatment: 'HSA', accountType: 'HSA', floorHsaMode: 'emergencyOnly',
    });
    const broker = floorAccount({ id: 'broker', initialPost: 30_000, floorDollars: 20_000 });
    const { years } = runOneYear({
      accounts: [hsa, broker], monthlyExpense: 50_000 / 12,
      strategyKind: 'customOrder', customTiers: [[0], [1]],
    });
    expect(years[0].accountBalances!.get('broker')!.balance).toBeCloseTo(0, 4);
    expect(years[0].accountBalances!.get('hsa')!.balance).toBeCloseTo(30_000, 4);
    expect(years[0].withdrawn).toBeCloseTo(50_000, 4);
    expect(years[0].depleted).toBe(false);
  });

  it('customOrder: an EXCLUDED HSA floor reserve is NEVER drained, even as last resort', () => {
    // An excluded HSA is a protected medical reserve out of the withdrawal order, which the reserve pass must never touch; the
    // floored brokerage (above-floor $10k + reserve $20k) funds the $30k spend.
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
    // No medical demand, spend $25k: the ordinary emergency pass takes $10k above the floor and the reserve pass $15k below it,
    // all emergency/nonmedical, so withdrawn − medicalQualified is the full nonqualified basis.
    const hsa = floorAccount({
      id: 'hsa', initialPost: 50_000, floorDollars: 40_000,
      taxTreatment: 'HSA', accountType: 'HSA', floorHsaMode: 'emergencyOnly',
    });
    const { years } = runOneYear({ accounts: [hsa], monthlyExpense: 25_000 / 12 });
    const row = years[0].accountBalances!.get('hsa')!;
    const withdrawnCents = Math.round(row.withdrawn * 100);
    const nonqualifiedDollars = (withdrawnCents - (row.medicalQualifiedWithdrawnCents ?? 0)) / 100;
    expect(nonqualifiedDollars).toBeCloseTo(25_000, 4); // whole reserve+emergency draw
    // The reserve draw's nonqualified basis feeds the §223(f)(4) engine: 20% additional tax before 65, $0 after.
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

describe('runYearByYearStrategyAware — inherited marker on the run state', () => {
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
      // $60k/yr of spending so both Roth sources are drawn.
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
    // A subset, not a deduction: the Roth total (and so fundedDollars) is unchanged.
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
