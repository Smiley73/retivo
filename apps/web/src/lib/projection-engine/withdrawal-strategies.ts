/** No-ledger single-pool kernel withdrawal hook; production spending rules (downturn guardrails) fire in `runYearByYearStrategyAware`, so a rule wired here would no-op on real runs.
 * Drawdown order: docs/math-withdrawals.md ("Which accounts, and in what order"). */

interface WithdrawalStepContext {
  readonly stepIdx: number;
  /** Steps remaining until horizon, inclusive. */
  readonly stepsRemaining: number;
  /** Pool balance after deposit + growth, before withdrawal. */
  readonly currentBalance: number;
  /** Pool balance at the retirement-step boundary, after the CBP fold. */
  readonly initialBalance: number;
  readonly inflatedExpense: number;
  readonly income: number;
  readonly cumCpi: number;
  /** Withdrawal taken in the previous step (0 at the first drawdown step). */
  readonly priorWithdrawal: number;
}

export type WithdrawalStrategy = (ctx: WithdrawalStepContext) => number;

/** Default: the gap between gross need and non-portfolio income; negative when income exceeds expense. */
export const netNeedStrategy: WithdrawalStrategy = (ctx) =>
  ctx.inflatedExpense - ctx.income;
