/** Reconciles the engine's monthly-summed `withdrawn` with the per-year budget so a mid-year transition year shows no phantom shortfall. */

export interface YearlyCashflowReconcileInput {
  earned: number;
  expense: number;
  /** Engine per-year `withdrawn` (monthly basis, pool-capped); 0 when no drawdown ran. */
  engineWithdrawn: number;
  /** The engine met net need: a drawdown and a year row exist and the row is not `depleted`. */
  funded: boolean;
}

export interface YearlyCashflowReconcileResult {
  /** Displayed Withdrawal: per-year net need when funded, else engine-actual. */
  withdrawal: number;
  totalIncome: number;
  /** 0 when funded; the real post-depletion gap otherwise. */
  shortfall: number;
}

export function reconcileYearlyCashflow(
  input: YearlyCashflowReconcileInput,
): YearlyCashflowReconcileResult {
  const { earned, expense, engineWithdrawn, funded } = input;
  // Funded: snap to the per-year net need, so Total income equals Expenses (or earned, in a surplus
  // year) with no shortfall; this differs from the portfolio-flow bar (`withdrawn − rmdSurplus`) by
  // the same proration residual. Not funded: keep the engine-actual figures.
  const withdrawal = funded ? Math.max(0, expense - earned) : engineWithdrawn;
  const totalIncome = earned + withdrawal;
  const shortfall = funded ? 0 : Math.max(0, expense - totalIncome);
  return { withdrawal, totalIncome, shortfall };
}
