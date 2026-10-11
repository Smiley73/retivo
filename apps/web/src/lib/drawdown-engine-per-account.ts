/**
 * Per-account drawdown branch of the household simulation.
 *
 * Strategy-aware (`taxEfficient`/`rothFirst`/`proportional`/`customOrder`): a
 * year-by-year manual stepping path that enforces the optional per-owner
 * RMD floor on PRE_TAX + MIXED-preTax accounts BEFORE strategy allocation
 * distributes the remaining net need in priority order. The strategy drives
 * which account depletes first — multi-year balance trajectories DIVERGE
 * between `taxEfficient`/`rothFirst`/`proportional` for the same scenario.
 *
 * Produces `DrawdownYear`/`DrawdownAccountYear` shapes so consumers
 * (`balance-projection-runner-tax.ts`) see one contract.
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

  // Guard: customOrder with no layout is a caller error — throw early rather
  // than silently falling back to an empty tier set inside the year loop.
  if (strategy.kind === 'customOrder' && !input.customDrawdownOrder) {
    throw new MissingCustomDrawdownOrderError();
  }

  // Build custom-order tier arrays and MAGI-cap config.
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
    // The runner pre-resolves the window list (sorted +
    // broken-anchor flagged); the engine selects ≤ 1 active window per year.
    magiCapWindows: input.magiCapWindows,
    taxCashflow: input.taxCashflow,
  });
}

/**
 * RMD floor check helper (exported). Given a pre-computed total RMD floor
 * (in dollars) and per-account withdrawal totals, compute the RMD-eligible
 * withdrawal sum and any shortfall.
 *
 * Only the unit tests call this today; no production code path does. The
 * forced-withdrawal pre-pass that enforces the floor is the separate
 * `applyRmdFloorPrePass`, which the strategy-aware year loop
 * (`drawdown-engine-per-account-strategy.ts`) runs each year against a floor
 * built from `DrawdownInput.rmdContext` (`buildPerOwnerRmdFloor`, from the
 * prior year's December balances).
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
