/**
 * Per-account drawdown branch: strategy-aware year-by-year stepping that enforces the per-owner RMD floor
 * before allocating the net need.
 */
import type { MonthlyCashflowSeries } from './monthly-cashflow';
import type {
  DrawdownAccountInput,
  DrawdownInput,
  DrawdownOutput,
} from './drawdown-engine-types';
import type { WithdrawalStrategy as ScenarioWithdrawalStrategy } from '../db/types';
import { runYearByYearStrategyAware } from './drawdown-engine-per-account-strategy';
import {
  MissingCustomDrawdownOrderError,
  buildCustomTierIndices,
} from './drawdown-engine-per-account-magi-cap';

export {  MissingCustomDrawdownOrderError };

export function simulatePerAccountMonthly(
  input: DrawdownInput,
  yearCount: number,
): DrawdownOutput {
  const stepCount = yearCount * 12;
  const accountsIn = input.accounts!;
  const strategy: ScenarioWithdrawalStrategy =
    input.withdrawalStrategy ?? { kind: 'taxEfficient' };

  if (import.meta.env.DEV) {
    assertSeriesShape(input.expensesByMonth, input.retirementYear, yearCount, 'expensesByMonth');
    assertSeriesShape(input.incomeByMonth, input.retirementYear, yearCount, 'incomeByMonth');
    for (const a of accountsIn) {
      assertSeriesShape(
        a.depositsByMonth,
        input.retirementYear,
        yearCount,
        `accounts[${a.id}].depositsByMonth`,
      );
    }
  }

  const expense = readSeriesIntoBuffer(input.expensesByMonth, stepCount);
  const income = readSeriesIntoBuffer(input.incomeByMonth, stepCount);
  const householdDeposit = readSeriesIntoBuffer(input.depositsByMonth, stepCount);

  if (strategy.kind === 'customOrder' && !input.customDrawdownOrder) {
    throw new MissingCustomDrawdownOrderError();
  }

  const { customTiers, excludedIndices } =
    strategy.kind === 'customOrder' && input.customDrawdownOrder
      ? buildCustomTierIndices(accountsIn, input.customDrawdownOrder.tiers, input.customDrawdownOrder.excludedAccountIds)
      : { customTiers: undefined, excludedIndices: undefined };

  return runYearByYearStrategyAware({
    input,
    yearCount,
    accountsIn,
    expense,
    income,
    householdDeposit,
    strategyKind: strategy.kind,
    rmdContext: input.rmdContext,
    qcdContext: input.qcdContext,
    customTiers,
    excludedIndices,
    magiCapWindows: input.magiCapWindows,
    taxCashflow: input.taxCashflow,
  });
}

/**
 * RMD floor check: from the total RMD floor (dollars) and per-account withdrawal totals, returns the
 * RMD-eligible withdrawal sum and any shortfall.
 */
export function rmdFloorEnforcePrePass(args: {
  accounts: ReadonlyArray<DrawdownAccountInput>;
  withdrawnByAccountId: ReadonlyMap<string, number>;
  rmdFloorDollars: number;
}): { rmdEligibleWithdrawn: number; rmdShortfall: number } {
  const { accounts, withdrawnByAccountId, rmdFloorDollars } = args;
  const RMD_ELIGIBLE_TREATMENTS = new Set<string>(['PRE_TAX']);
  let rmdEligibleWithdrawn = 0;
  for (const a of accounts) {
    if (!RMD_ELIGIBLE_TREATMENTS.has(a.taxTreatment)) continue;
    rmdEligibleWithdrawn += withdrawnByAccountId.get(a.id) ?? 0;
  }
  const rmdShortfall = Math.max(0, rmdFloorDollars - rmdEligibleWithdrawn);
  return { rmdEligibleWithdrawn, rmdShortfall };
}

function readSeriesIntoBuffer(series: MonthlyCashflowSeries, stepCount: number): Float64Array {
  const out = new Float64Array(stepCount);
  for (let i = 0; i < stepCount; i += 1) {
    if (i >= 0 && i < series.values.length) out[i] = series.values[i];
  }
  return out;
}

function assertSeriesShape(
  series: MonthlyCashflowSeries,
  retirementYear: number,
  yearCount: number,
  label: string,
): void {
  if (series.startYear !== retirementYear || series.startMonthIndex !== 0) {
    throw new Error(
      `drawdown-engine: ${label} must start at (${retirementYear}, 0); ` +
        `got (${series.startYear}, ${series.startMonthIndex})`,
    );
  }
  const expected = yearCount * 12;
  if (series.values.length !== expected) {
    throw new Error(
      `drawdown-engine: ${label} must have length ${expected}; ` +
        `got ${series.values.length}`,
    );
  }
}
