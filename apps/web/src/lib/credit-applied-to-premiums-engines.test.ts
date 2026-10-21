/**
 * The ACA credit applied to premiums, end to end in both engines.
 *
 * One retired single filer with a Roth IRA as the only account (qualified draws,
 * $0 taxable, so the credit does not move with the draw), Social Security of
 * $31,300 a year, and a user-entered 2026 benchmark of $7,200. Provisional
 * income is $15,650, so no Social Security is taxable and the federal tax is $0;
 * ACA MAGI is $31,300, which is 200.0% of the $15,650 poverty guideline, so the
 * expected contribution is 6.60% = $2,065.80 and the credit is $5,134.20 with
 * nothing to offset. Rules: HHS 2025 poverty guideline, 2026 applicable
 * percentages, IRC §86, Rev. Proc. 2025-32.
 *
 * Social Security cannot start before 62, so the person is 63 (born 1963-01-01,
 * claiming at 63 against a full retirement age of 67). Monthly benefits are whole
 * cents, which no PIA can make add to exactly $31,300, so the projection's
 * benefit is pinned to that figure in both engines. Every number above is the
 * same for any age under 65.
 */
import { describe, expect, it, vi } from 'vitest';
import { runMonteCarlo, validateMonteCarloInput } from './monte-carlo.js';
import { applyStress } from './market-stress.js';
import {
  runBalanceProjectionForPage,
  runBalanceProjectionMc,
} from './balance-projection-runner.js';
import type { RunBalanceProjectionArgs } from './balance-projection-runner-types.js';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  SocialSecurityBenefitPayload,
} from '../db/types.js';
import type { ScenarioAggregate } from './scenario-resolution.js';

/** Claiming at 63 against an FRA of 67 pays 75% of the PIA. */
const PIA = 31_300 / 12 / 0.75;
vi.mock('./ss-projection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ss-projection')>();
  const exact = <T extends { total: number; byMember: { primary: number } }>(row: T): T =>
    row.total > 0 ? { ...row, total: 31_300, byMember: { primary: 31_300 } } : row;
  return {
    ...actual,
    projectSsByMonth: (...a: Parameters<typeof actual.projectSsByMonth>) =>
      actual.projectSsByMonth(...a).map(exact),
    projectSsByYear: (...a: Parameters<typeof actual.projectSsByYear>) =>
      actual.projectSsByYear(...a).map(exact),
  };
});

const BASE = { householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-01-01T00:00:00Z', deviceId: 'd' };

function member(): Aggregate<HouseholdMemberPayload> {
  return {
    ...BASE,
    id: 'm1',
    aggregateType: 'householdMember',
    payload: { isPrimary: true, firstName: 'Pat', lastName: 'Doe', email: 'm1@example.test', birthdate: '1963-01-01' },
  };
}

function expense(id: string, categoryId: string, amount: number): Aggregate<ExpensePayload> {
  return {
    ...BASE,
    id,
    aggregateType: 'expense',
    payload: {
      name: id, categoryId, amount, frequency: 'yearly', classification: 'essential',
      start: { kind: 'retirementStart' }, end: { kind: 'lifetime', whose: 'last' },
    },
  };
}

/** A fixed pension with no COLA, paid from the first retirement month: ordinary
 *  income for case E. */
function pension(annual: number): Aggregate<IncomeStreamPayload> {
  return {
    ...BASE,
    id: 'pension',
    aggregateType: 'incomeStream',
    payload: {
      name: 'pension', kind: 'pension', payoutType: 'annuity', memberId: 'm1',
      monthlyBenefit: annual / 12, start: { kind: 'age', years: 63, months: 0 },
      colaPct: 0, jointAndSurvivorPct: 0,
    },
  };
}

interface Household {
  /** Medical rows (not HSA-qualified), dollars a year. */
  readonly medical: number;
  /** Everything else, dollars a year. */
  readonly other: number;
  readonly pensionAnnual?: number;
}

function args(h: Household): RunBalanceProjectionArgs {
  const scenario: ScenarioAggregate = {
    ...BASE,
    id: 's',
    aggregateType: 'scenario',
    payload: {
      name: 'Credit', description: '', parentScenarioId: null, isPrimary: true, notes: '',
      overrides: {
        retirementAge: { primary: { ageYears: 63, ageMonths: 0 } },
        socialSecurity: { primary: { ageYears: 63, ageMonths: 0 }, colaPct: 0 },
        inflation: { ratePct: 0, categoryRates: { 'cat-medical': 0 } },
        lifeExpectancy: { primary: 70 },
        withdrawalStrategy: { kind: 'taxEfficient' },
        acaPtcBenchmark: [{ taxYear: 2026, annualSlcspDollars: 7_200 }],
      },
    },
  };
  const account: Aggregate<AccountPayload> = {
    ...BASE,
    id: 'roth',
    aggregateType: 'account',
    payload: {
      name: 'roth', type: 'RETIREMENT_ROTH_IRA', ownershipType: 'INDIVIDUAL', taxTreatment: 'ROTH',
      ownerId: 'm1', institution: 'V', notes: '', planningReturnPct: 0, active: true,
      plannedContributionPreTax: 0, plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
      rothIraFirstContributionTaxYear: 2015,
    },
  };
  const balance: Aggregate<AccountBalancePayload> = {
    ...BASE,
    id: 'b-roth',
    aggregateType: 'accountBalance',
    payload: {
      accountId: 'roth', year: 2025, lastUpdated: '2025-12-31', startingBalance: 2_000_000,
      startingBalancePreTax: null, startingBalancePostTax: null, contributionsPreTax: null,
      contributionsPostTax: null, companyContributions: 0, companyContributionsPreTax: null,
      companyContributionsPostTax: null, rollover: 0, distributions: 0, endingBalance: 2_000_000,
      endingBalancePreTax: null, endingBalancePostTax: null, totalContributions: 0, comment: null,
    },
  };
  const ss: Aggregate<SocialSecurityBenefitPayload> = {
    ...BASE,
    id: 'ss-m1',
    aggregateType: 'socialSecurityBenefit',
    payload: { householdMemberId: 'm1', pia: PIA, piaAsOfDate: '2026-01-01', notes: null },
  };
  return {
    scenarioId: 's',
    scenarios: [scenario],
    accounts: [account],
    balances: [balance],
    members: [member()],
    ssBenefits: [ss],
    expenses: [
      expense('medical', 'cat-medical', h.medical),
      expense('living', 'cat-housing', h.other),
    ],
    incomeStreams: h.pensionAnnual === undefined ? [] : [pension(h.pensionAnnual)],
    todayYear: 2026,
    todayMonthIndex: 0,
  };
}

function detRow(h: Household) {
  const years = runBalanceProjectionForPage(args(h)).planned?.years ?? [];
  const row = years[0];
  if (row === undefined) throw new Error('expected a first retirement year');
  return row;
}

/** [need before the line, line, draw after, dropped] in cents for one household. */
const cents = (dollars: number): number => Math.round(dollars * 100);

describe('credit applied to premiums, deterministic engine', () => {
  it('A: all-deficit year, the whole excess lowers the draw', () => {
    // Need before the line: 64,000 + 7,200 − 31,300 = 39,900.
    const row = detRow({ medical: 7_200, other: 64_000 });
    expect(row.acaPtcSubsidyCents).toBe(cents(5_134.2));
    expect(row.acaPtcCashflowOffsetCents).toBe(0);
    expect(row.acaCreditAppliedToPremiumsCents).toBe(cents(5_134.2));
    expect(row.withdrawn).toBeCloseTo(34_765.8, 2);
    expect(row.totalTaxCashflowNeedCents).toBe(0);
  });

  it('B: partial deficit, the line is capped at the draw and the rest is dropped', () => {
    // Need before the line: 26,800 + 7,200 − 31,300 = 2,700.
    const row = detRow({ medical: 7_200, other: 26_800 });
    expect(row.acaCreditAppliedToPremiumsCents).toBe(cents(2_700));
    expect(row.withdrawn).toBeCloseTo(0, 2);
    expect(row.totalTaxCashflowNeedCents).toBe(0);
  });

  it('C: Social Security already covers spending, nothing to lower', () => {
    const before = detRow({ medical: 7_200, other: 22_800 });
    expect(before.acaCreditAppliedToPremiumsCents).toBe(0);
    expect(before.withdrawn).toBeCloseTo(0, 2);
    expect(before.totalTaxCashflowNeedCents).toBe(0);
  });

  it('D: the Medical expenses bind', () => {
    // Need before the line: 40,000 + 3,000 − 31,300 = 11,700.
    const row = detRow({ medical: 3_000, other: 40_000 });
    expect(row.acaCreditAppliedToPremiumsCents).toBe(cents(3_000));
    expect(row.withdrawn).toBeCloseTo(8_700, 2);
    expect(row.totalTaxCashflowNeedCents).toBe(0);
  });

  it('E: a pension makes federal tax use part of the credit first', () => {
    // Provisional income 35,650 → taxable Social Security 5,902.50; AGI 25,902.50;
    // taxable income 9,802.50; federal tax 980.25. ACA MAGI 51,300 (327.8% of the
    // poverty guideline) → expected contribution 5,109.48, credit 2,090.52; the
    // offset is 980.25 and the excess 1,110.27. Need: 60,000 − 51,300 = 8,700.
    const row = detRow({ medical: 7_200, other: 52_800, pensionAnnual: 20_000 });
    expect(row.acaPtcSubsidyCents).toBe(cents(2_090.52));
    expect(row.federalTaxCashNeedCents).toBe(cents(980.25));
    expect(row.acaPtcCashflowOffsetCents).toBe(cents(980.25));
    expect(row.totalTaxCashflowNeedCents).toBe(0);
    expect(row.acaCreditAppliedToPremiumsCents).toBe(cents(1_110.27));
    expect(row.withdrawn).toBeCloseTo(7_589.73, 2);
  });
});

describe('credit applied to premiums, deterministic versus Monte Carlo', () => {
  /** One injected-flat path, zero CPI: the representative first retirement row. */
  function mcFirstRow(h: Household) {
    const input = runBalanceProjectionMc(args(h));
    const steps = (input.horizonYear - input.firstYear + 1) * 12;
    const summary = runMonteCarlo({
      ...input,
      pathCount: 1,
      seed: 1,
      injectedReturns: new Float64Array(steps),
      injectedCpi: new Float64Array(steps),
    });
    const row = summary.representativeByBasis?.['mc-typical']?.years.find((y) => y.year === 2026);
    if (row === undefined) throw new Error('expected a first retirement row');
    return { row, summary };
  }

  // The stress test rounds each month's expense base to the cent while the
  // deterministic series does not, so these households spend a whole number of
  // cents a month (annual figures divisible by 12) to compare to the cent.
  it.each([
    ['A', { medical: 7_200, other: 64_008 }, 5_134.2],
    ['B', { medical: 7_200, other: 26_796 }, 2_696],
    ['C', { medical: 7_200, other: 22_800 }, 0],
  ])('case %s: same withdrawn and line to the cent', (_name, h, line) => {
    const det = detRow(h);
    const { row, summary } = mcFirstRow(h);
    expect(det.acaCreditAppliedToPremiumsCents).toBe(cents(line));
    expect(row.acaCreditAppliedToPremiumsCents).toBe(det.acaCreditAppliedToPremiumsCents);
    expect(Math.round(row.withdrawn * 100)).toBe(Math.round(det.withdrawn * 100));
    const p50 = summary.acaCreditAppliedToPremiumsPercentilesByYear?.p50[0] ?? Number.NaN;
    expect(p50).toBeCloseTo(line, 2);
  });
});

describe('credit applied to premiums, Monte Carlo input', () => {
  const household: Household = { medical: 7_200, other: 64_008 };
  const sumYear = (series: readonly number[] | undefined, year0: number): number =>
    (series ?? []).slice(year0 * 12, year0 * 12 + 12).reduce((a, b) => a + b, 0);

  /** The household plus a second medical category at its own inflation rate. */
  function twoRateArgs(medicalCategoryIds: string[]): RunBalanceProjectionArgs {
    const base = args(household);
    const scenario = base.scenarios[0];
    return {
      ...base,
      medicalCategoryIds,
      expenses: [...base.expenses, expense('med2', 'cat-med2', 3_600)],
      scenarios: [
        {
          ...scenario,
          payload: {
            ...scenario.payload,
            overrides: {
              ...scenario.payload.overrides,
              inflation: { ratePct: 0, categoryRates: { 'cat-medical': 0, 'cat-med2': 6 } },
            },
          },
        },
      ],
    };
  }

  it('carries every isMedical row, not just the HSA-qualified subset', () => {
    const input = runBalanceProjectionMc(args(household));
    expect(sumYear(input.monthlyMedicalExpenseBase, 0)).toBeCloseTo(7_200, 2);
    // Nothing is HSA-qualified here, so the HSA demand base is absent.
    expect(input.monthlyMedicalDemandBase).toBeUndefined();
    expect(input.monthlyMedicalExpenseBase).toHaveLength(input.monthlyExpenseBase.length);
  });

  it('is absent when the plan flags no medical category', () => {
    const input = runBalanceProjectionMc({ ...args(household), medicalCategoryIds: [] });
    expect(input.monthlyMedicalExpenseBase).toBeUndefined();
    expect(input.medicalExpenseRatePct).toBeUndefined();
    expect(input.monthlyMedicalExpenseBucketsBase).toBeUndefined();
  });

  it('emits per-rate buckets in rate order whichever way the categories are listed', () => {
    const forward = runBalanceProjectionMc(twoRateArgs(['cat-medical', 'cat-med2']));
    const reversed = runBalanceProjectionMc(twoRateArgs(['cat-med2', 'cat-medical']));
    expect(forward.monthlyMedicalExpenseBucketsBase?.map((b) => b.ratePct)).toEqual([0, 6]);
    expect(reversed.monthlyMedicalExpenseBucketsBase).toEqual(forward.monthlyMedicalExpenseBucketsBase);
  });

  it('is rejected when a series has the wrong length', () => {
    const input = runBalanceProjectionMc(args(household));
    const short = input.monthlyMedicalExpenseBase!.slice(1);
    expect(() => validateMonteCarloInput({ ...input, monthlyMedicalExpenseBase: short })).toThrow(
      /monthlyMedicalExpenseBase/,
    );
    const buckets = runBalanceProjectionMc(twoRateArgs(['cat-medical', 'cat-med2']));
    expect(() =>
      validateMonteCarloInput({
        ...buckets,
        monthlyMedicalExpenseBucketsBase: buckets.monthlyMedicalExpenseBucketsBase!.map((b) => ({
          ratePct: b.ratePct,
          amount: b.amount.slice(1),
        })),
      }),
    ).toThrow(/monthlyMedicalExpenseBucketsBase/);
  });

  it('runs the Longer-life stress case on a household carrying the field', () => {
    const input = runBalanceProjectionMc(twoRateArgs(['cat-medical', 'cat-med2']));
    const stressed = applyStress(input, 'longerLife', { longestLivedBirthYear: 1963 });
    expect(stressed.horizonYear).toBeGreaterThan(input.horizonYear);
    const steps = (stressed.horizonYear - stressed.firstYear + 1) * 12;
    expect(stressed.monthlyMedicalExpenseBase).toHaveLength(steps);
    for (const b of stressed.monthlyMedicalExpenseBucketsBase ?? []) expect(b.amount).toHaveLength(steps);
    expect(() => validateMonteCarloInput(stressed)).not.toThrow();
    expect(() => runMonteCarlo({ ...stressed, pathCount: 3, seed: 1 })).not.toThrow();
  });
});
