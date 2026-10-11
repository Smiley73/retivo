/**
 * Per-year budget-vs-engine reconciliation for the Balance Projection
 * Yearly cashflow band, income-breakdown withdrawal layer, and
 * year-by-year table.
 *
 * The drawdown engine computes `withdrawn` on a per-MONTH basis
 * (Σ monthly expense − Σ monthly income, capped at the pool). The Yearly
 * surfaces compare it against per-YEAR projections (`projectExpensesByYear`
 * / `projectIncomeByYear`). In a mid-year transition year (the partial
 * first retirement year, a mid-year income start/stop) the two projection
 * helpers prorate the boundary differently, so the engine `withdrawn`
 * diverges from the per-year net need and a phantom shortfall renders even
 * though the portfolio fully funded the year.
 *
 * `funded` (= the engine met its net need that year: a drawdown exists, a
 * year row exists, and `!row.depleted`) → snap the displayed Withdrawal to
 * the per-year net need so the budget reconciles and no phantom shortfall
 * shows. Not funded (no drawdown, no row past horizon, or genuinely
 * depleted) → keep the engine-actual `withdrawn` and the real shortfall.
 * The reconciled figure is the household BUDGET view; actual portfolio
 * outflow stays the engine's `years[].withdrawn` (Annual Portfolio Flow
 * chart + Balance column).
 *
 * Consequence (intended, not a bug): the funded Withdrawal this returns is a
 * DIFFERENT quantity from the Annual Portfolio Flow chart's withdrawal bar
 * (`withdrawn − rmdSurplus`). Both use the same units / deflator, but the bar
 * is the engine's actual monthly-summed annual draw while this is the per-year
 * budget plug — so in a mid-year transition year they differ by the same
 * proration / timing residual this snap absorbs. See
 * balance-projection-page-yearly-flow-budget-decomposition.test.ts.
 *
 * table Withdrawal / Shortfall columns.
 */
export interface YearlyCashflowReconcileInput {
  /** Method-independent earned income for the year (annual basis). */
  earned: number;
  /** Per-year projected expenses for the year (annual basis). */
  expense: number;
  /** Drawdown engine's per-year `withdrawn` (monthly basis, pool-capped);
   *  0 when no drawdown ran for the method or no row exists for the year. */
  engineWithdrawn: number;
  /** True iff the engine fully met net need this year: drawdown exists, a
   *  year row exists, and the row is not `depleted`. */
  funded: boolean;
}

export interface YearlyCashflowReconcileResult {
  /** Displayed Withdrawal: per-year net need when funded, else engine-actual. */
  withdrawal: number;
  /** earned + withdrawal. */
  totalIncome: number;
  /** 0 when funded; the real post-depletion gap otherwise. */
  shortfall: number;
}

export function reconcileYearlyCashflow(
  input: YearlyCashflowReconcileInput,
): YearlyCashflowReconcileResult {
  const { earned, expense, engineWithdrawn, funded } = input;
  // Funded → snap to the per-year net need (RD2): Total income == Expenses
  // when expense ≥ earned; a surplus year (earned > expense) yields
  // withdrawal 0 and Total income = earned (> Expenses). Either way no
  // shortfall — the engine proved the year is fully funded.
  // Not funded → engine-actual (RD1/RD3): identical to the legacy
  // `withdrawn ?? 0` math, so the real post-depletion gap is preserved.
  const withdrawal = funded ? Math.max(0, expense - earned) : engineWithdrawn;
  const totalIncome = earned + withdrawal;
  const shortfall = funded ? 0 : Math.max(0, expense - totalIncome);
  return { withdrawal, totalIncome, shortfall };
}
