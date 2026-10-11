/**
 * Withdrawal-strategy seam consumed by the projection-engine kernel
 * during drawdown. The kernel calls the strategy each drawdown step;
 * the strategy returns the *target* withdrawal amount. The kernel then
 * enforces `withdrawn = min(pool, target)` and tracks depletion.
 *
 * This seam ships only the default `netNeedStrategy` (behaviour-identical
 * to the prior combined-pot drawdown) and is the kernel's per-step
 * WITHDRAWAL-AMOUNT hook used by the no-ledger single-pool / fallback
 * kernel paths only. It is NOT the production amount-adjustment extension
 * point: production dynamic-spending rules (e.g. the downturn spending
 * guardrails) fire inside the per-account
 * strategy engine's year loop (`runYearByYearStrategyAware`), which every
 * real Monte Carlo run routes through — a rule wired here would silently
 * no-op on those runs. Add new production spending rules there, not here.
 *
 * The drawdown order is explained in docs/math-withdrawals.md ("Which accounts, and in what order").
 */

export interface WithdrawalStepContext {
  /** 0-based step index across the full run (accumulation + drawdown). */
  readonly stepIdx: number;
  /** Steps remaining until horizon (inclusive). */
  readonly stepsRemaining: number;
  /** Pool balance this step after deposit + growth, before withdrawal. */
  readonly currentBalance: number;
  /** Pool balance at the retirement-step boundary (after CBP fold). */
  readonly initialBalance: number;
  /** Step's CPI-adjusted gross expense (already inflated). */
  readonly inflatedExpense: number;
  /** Step's non-portfolio income (SS + pension + other). */
  readonly income: number;
  /** Cumulative CPI factor from `firstYear` to this step. */
  readonly cumCpi: number;
  /** Actual withdrawal taken in the previous step (0 at first drawdown
   *  step). Lets rule-based strategies anchor to the prior pull. */
  readonly priorWithdrawal: number;
}

export type WithdrawalStrategy = (ctx: WithdrawalStepContext) => number;

/** Default strategy — cover the gap between gross need and non-
 *  portfolio income. When income exceeds expense the result is
 *  negative (surplus; the proportional kernel clamps the recorded withdrawal to ≥ 0,
 *  so surplus reduces the effective draw to zero). The kernel uses this when no strategy is
 *  supplied. */
export const netNeedStrategy: WithdrawalStrategy = (ctx) =>
  ctx.inflatedExpense - ctx.income;
