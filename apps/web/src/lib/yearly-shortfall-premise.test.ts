// Grounds the phantom-shortfall fix with the real projection helpers: in a mid-year transition year (a June first retirement year, or a mid-year income stop) the engine's monthly-basis `withdrawn` diverges from the per-year net need by more than $1 while the year is reported funded; that residual is what the old Yearly shortfall rendered.
import { describe, expect, it } from 'vitest';
import {
  projectExpensesByMonth,
  projectExpensesByYear,
  type ProjectionContext,
} from './expense-projection';
import type { ResolvedExpense } from './expense-resolution';
import {
  buildIncomeContext,
  projectIncomeByMonth,
  projectIncomeByYear,
} from './income-projection';
import type { ResolvedIncomeStream } from './income-resolution';
import {
  buildMonthlyExpenseSeries,
  buildMonthlyIncomeSeries,
} from './balance-projection-bundle';
import { emptyMonthlySeries } from './monthly-cashflow';
import { simulateDrawdown } from './drawdown-engine';
import type {
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
} from '../db/types';

const RETIREMENT_YEAR = 2050;
const RETIREMENT_MONTH0 = 5; // June — mid-year retirement.
const HORIZON_YEAR = 2070;

const memberAgg = (
  id: string,
  payload: Partial<HouseholdMemberPayload> & {
    birthdate: string;
    isPrimary: boolean;
  },
): Aggregate<HouseholdMemberPayload> => ({
  id,
  householdId: 'h',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  deviceId: 'd',
  aggregateType: 'householdMember',
  payload: {
    firstName: 'Test',
    lastName: 'Member',
    email: 't@example.test',
    ...payload,
  },
});

// Primary born June 1985 → age 65 = June 2050 (the partial first year).
// Secondary born June 1988 → age 65 = June 2053 (part-time start).
const members = [
  memberAgg('p', { birthdate: '1985-06-15', isPrimary: true }),
  memberAgg('s', { birthdate: '1988-06-15', isPrimary: false }),
];
const retirementDateByMember = new Map<
  string,
  { year: number; month0?: number }
>([
  ['p', { year: RETIREMENT_YEAR, month0: RETIREMENT_MONTH0 }],
  ['s', { year: RETIREMENT_YEAR, month0: RETIREMENT_MONTH0 }],
]);

const incomeCtxBase = buildIncomeContext(members, {
  retirementStartYear: RETIREMENT_YEAR,
  lifeExpectancyPrimary: 95,
  lifeExpectancySecondary: 95,
  retirementDateByMember,
});
const incomeMonthlyCtx = {
  ...incomeCtxBase,
  retirementMonth0: RETIREMENT_MONTH0,
};

const expenseCtx: ProjectionContext = {
  todayYear: 2026,
  retirementYear: RETIREMENT_YEAR,
  retirementMonth0: RETIREMENT_MONTH0,
  primary: { birthdate: '1985-06-15' },
  secondary: { birthdate: '1988-06-15' },
  inflation: { ratePct: 3 }, // non-zero → annual mean-factor vs per-month
};

// One always-on essential expense, retirement-anchored: active from the
// June 2050 retirement month through end of life.
const expenses: ResolvedExpense[] = [
  {
    id: 'living',
    source: 'canonical',
    payload: {
      name: 'Living expenses',
      amount: 5000,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: 'cat',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    } as ExpensePayload,
  },
];

// Secondary part-time: $36k/yr, age-65 start (June 2053), 60-month
// duration → ends June 2058 (active Jan–May 2058: a mid-year stop year).
const income: ResolvedIncomeStream[] = [
  {
    id: 'consulting',
    source: 'canonical',
    payload: {
      name: 'Consulting',
      kind: 'partTime',
      memberId: 's',
      annualAmount: 36000,
      start: { kind: 'age', years: 65, months: 0 },
      end: { kind: 'durationFromStart', months: 60 },
      colaPct: 0,
      taxable: true,
    } as IncomeStreamPayload,
  },
];

const range = { from: RETIREMENT_YEAR, to: HORIZON_YEAR };

function annualNetNeed(year: number): number {
  const ey = projectExpensesByYear(expenses, expenseCtx, range).find(
    (r) => r.year === year,
  )!;
  const iy = projectIncomeByYear(income, incomeCtxBase, range).find(
    (r) => r.year === year,
  )!;
  const earned = iy.spendable.pension + iy.spendable.partTime + iy.spendable.oneOff;
  return ey.total - earned;
}

describe('Yearly phantom-shortfall premise (real projection helpers)', () => {
  const expensesByMonth = buildMonthlyExpenseSeries({
    rows: projectExpensesByMonth(expenses, expenseCtx, range),
    retirementYear: RETIREMENT_YEAR,
    horizonYear: HORIZON_YEAR,
  });
  const incomeByMonth = buildMonthlyIncomeSeries({
    ssRows: [],
    incomeRows: projectIncomeByMonth(income, incomeMonthlyCtx, range),
    retirementYear: RETIREMENT_YEAR,
    horizonYear: HORIZON_YEAR,
  });
  const dd = simulateDrawdown({
    portfolioAtRetirement: 50_000_000, // huge → never depletes
    ratePct: 5,
    expensesByMonth,
    incomeByMonth,
    depositsByMonth: emptyMonthlySeries(RETIREMENT_YEAR, HORIZON_YEAR),
    retirementYear: RETIREMENT_YEAR,
    horizonYear: HORIZON_YEAR,
    withdrawalStrategy: { kind: 'taxEfficient' },
    accounts: [
      {
        id: 'pool',
        initialPre: 0,
        initialPost: 50_000_000,
        annualRatePct: 5,
        depositsByMonth: emptyMonthlySeries(RETIREMENT_YEAR, HORIZON_YEAR),
        taxTreatment: 'POST_TAX',
        accountType: 'BROKERAGE',
      },
    ],
  });

  it('(a) partial first retirement year: engine withdrawn diverges from annual net need by > $1, year funded', () => {
    const row = dd.years[2050 - RETIREMENT_YEAR];
    expect(row.depleted).toBe(false); // fully funded
    const residual = Math.abs(row.withdrawn - annualNetNeed(2050));
    expect(residual).toBeGreaterThan(1);
  });

  it('(b) mid-year income-stop year (part-time ends mid-2058): same divergence, year funded', () => {
    const row = dd.years[2058 - RETIREMENT_YEAR];
    expect(row.depleted).toBe(false);
    const residual = Math.abs(row.withdrawn - annualNetNeed(2058));
    expect(residual).toBeGreaterThan(1);
  });

  it('control: a steady mid-retirement year has no material divergence', () => {
    const row = dd.years[2055 - RETIREMENT_YEAR];
    expect(row.depleted).toBe(false);
    const residual = Math.abs(row.withdrawn - annualNetNeed(2055));
    expect(residual).toBeLessThan(1);
  });
});
