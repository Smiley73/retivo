/**
 * Pinned defect: unit mix between balances and expenses.
 *
 * The "unit mix" bug: pre-fix the engine emitted real (today's-dollar)
 * balances while the expense projection compounded amounts from the
 * retirement-year anchor — these two units disagreed for any non-zero
 * inflation rate, producing balance projections that didn't line up
 * with the user's entered expense amounts.
 *
 * Post-fix:
 *   1. `project()` emits **nominal** balances.
 *   2. Expense amounts are interpreted as **today's dollars** and
 *      inflated forward from `asOfMonth`.
 *   3. Applying `realDeflatorAt(...)` to a nominal year-Y amount must
 *      return the today's-dollar amount the user originally entered.
 *
 * This file tests the round-trip identity end-to-end: take a flat
 * $100k/yr expense entered in today's dollars, project it forward at
 * 3 %/yr inflation, then deflate the nominal year-by-year totals back
 * to today's dollars. The result must match $100k/yr to FP precision.
 */
import { describe, expect, it } from 'vitest';
import {
  projectExpensesByYear,
  type ProjectionContext as ExpenseProjectionContext,
} from './expense-projection';
import type { ResolvedExpense } from './expense-resolution';
import type { ExpensePayload } from '../db/types';
import {
  realDeflatorAt,
  type ProjectionContext,
} from './projection-context';

function flatYearlyExpense(amount: number): ResolvedExpense {
  return {
    id: 'e',
    source: 'canonical',
    payload: {
      name: 'flat',
      amount,
      frequency: 'yearly',
      classification: 'essential',
      categoryId: 'cat-x',
      start: { kind: 'year', year: 2026 },
      end: { kind: 'lifetime', whose: 'last' },
    } satisfies Partial<ExpensePayload> as ExpensePayload,
  };
}

describe('unit mix pin — today\'s-dollar expense round-trips through nominal projection', () => {
  it('flat $100k/yr at 3 %/yr inflation → real-deflated nominal equals $100k every year', () => {
    const TODAY_YEAR = 2026;
    const RATE_PCT = 3;

    const expenseCtx: ExpenseProjectionContext = {
      todayYear: TODAY_YEAR,
      todayMonthIndex: 0,
      retirementYear: 2030,
      primary: { birthdate: '1965-03-12' },
      secondary: { birthdate: '1968-09-03' },
      inflation: { ratePct: RATE_PCT },
    };
    const projCtx: ProjectionContext = {
      asOfYear: TODAY_YEAR,
      asOfMonthIndex: 0,
      asOfMonth: TODAY_YEAR * 12,
      firstProjectionMonth: TODAY_YEAR * 12,
      primaryRetirementMonth: 2030 * 12,
      horizonMonth: 2055 * 12,
      inflationPct: RATE_PCT,
    };

    const nominal = projectExpensesByYear([flatYearlyExpense(100_000)], expenseCtx, {
      from: 2026,
      to: 2055,
    });

    // Real-deflate each year's nominal back to today's dollars using
    // the same year-mean factor the engine used to inflate. With
    // matched factors the round-trip is exact (modulo the engine's
    // round2 truncation).
    for (const row of nominal) {
      let yearMeanFactor = 0;
      for (let m = 0; m < 12; m += 1) {
        yearMeanFactor += 1 / realDeflatorAt(projCtx, row.year, m);
      }
      yearMeanFactor /= 12;
      const realDollars = row.total / yearMeanFactor;
      expect(realDollars).toBeCloseTo(100_000, 2);
    }
  });

  it('zero-inflation path: nominal equals today\'s dollars in every year', () => {
    const expenseCtx: ExpenseProjectionContext = {
      todayYear: 2026,
      todayMonthIndex: 0,
      retirementYear: 2030,
      primary: { birthdate: '1965-03-12' },
      secondary: { birthdate: '1968-09-03' },
      inflation: { ratePct: 0 },
    };
    const nominal = projectExpensesByYear([flatYearlyExpense(100_000)], expenseCtx, {
      from: 2026,
      to: 2050,
    });
    for (const row of nominal) {
      expect(row.total).toBe(100_000);
    }
  });

  it('non-Jan anchor flows correctly through the round-trip', () => {
    const TODAY_YEAR = 2026;
    const TODAY_MONTH = 5; // June
    const RATE_PCT = 3;

    const expenseCtx: ExpenseProjectionContext = {
      todayYear: TODAY_YEAR,
      todayMonthIndex: TODAY_MONTH,
      retirementYear: 2030,
      primary: { birthdate: '1965-03-12' },
      secondary: { birthdate: '1968-09-03' },
      inflation: { ratePct: RATE_PCT },
    };
    const projCtx: ProjectionContext = {
      asOfYear: TODAY_YEAR,
      asOfMonthIndex: TODAY_MONTH,
      asOfMonth: TODAY_YEAR * 12 + TODAY_MONTH,
      firstProjectionMonth: TODAY_YEAR * 12 + TODAY_MONTH,
      primaryRetirementMonth: 2030 * 12,
      horizonMonth: 2055 * 12,
      inflationPct: RATE_PCT,
    };

    const nominal = projectExpensesByYear([flatYearlyExpense(100_000)], expenseCtx, {
      from: 2026,
      to: 2050,
    });

    for (const row of nominal) {
      let yearMeanFactor = 0;
      for (let m = 0; m < 12; m += 1) {
        yearMeanFactor += 1 / realDeflatorAt(projCtx, row.year, m);
      }
      yearMeanFactor /= 12;
      const realDollars = row.total / yearMeanFactor;
      expect(realDollars).toBeCloseTo(100_000, 2);
    }
  });
});
