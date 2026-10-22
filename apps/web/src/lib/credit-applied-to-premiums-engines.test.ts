/**
 * The ACA credit applied to premiums, end to end in both engines.
 *
 * One retired single filer, a Roth IRA as the only account, $31,300 of Social
 * Security and a user-entered 2026 benchmark of $7,200: no taxable Social
 * Security, $0 federal tax, ACA MAGI at 200.0% of the $15,650 poverty guideline,
 * so the credit is $5,134.20 with nothing to offset (HHS 2025 poverty guideline,
 * 2026 applicable percentages, IRC §86, Rev. Proc. 2025-32). Monthly benefits
 * are whole cents, so the projected benefit is pinned to exactly $31,300.
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

const GUIDELINE_DOLLARS = 15_650;

const BASE = { householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-01-01T00:00:00Z', deviceId: 'd' };

function member(age = 63): Aggregate<HouseholdMemberPayload> {
  return {
    ...BASE,
    id: 'm1',
    aggregateType: 'householdMember',
    payload: {
      isPrimary: true, firstName: 'Pat', lastName: 'Doe', email: 'm1@example.test', birthdate: `${2026 - age}-01-01`,
    },
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

/** A monthly expense: for life, or for its first `months` retirement months only
 *  (an uneven year, as a one-off bill or a benefit that starts mid-year makes). */
function monthlyExpense(
  id: string,
  categoryId: string,
  monthly: number,
  months?: number,
): Aggregate<ExpensePayload> {
  return {
    ...BASE,
    id,
    aggregateType: 'expense',
    payload: {
      name: id, categoryId, amount: monthly, frequency: 'monthly', classification: 'essential',
      start: { kind: 'retirementStart' },
      end: months === undefined ? { kind: 'lifetime', whose: 'last' } : { kind: 'durationFromStart', months },
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
  /** Medical rows (not HSA-qualified) and everything else, dollars a year. */
  readonly medical: number;
  readonly other: number;
  readonly pensionAnnual?: number;
  /** Extra non-medical monthly spending in the first `months` months only. */
  readonly shortMonthly?: { readonly amount: number; readonly months: number };
  /** Medical dollars a month for life, instead of the yearly `medical` row. */
  readonly medicalMonthly?: number;
  /** A pre-tax IRA instead of the Roth IRA. */
  readonly preTax?: boolean;
  readonly noMedicalCategory?: boolean;
  readonly noSocialSecurity?: boolean;
  /** A Roth IRA first funded in 2025: nonqualified draws, taxable earnings. */
  readonly nonqualifiedRoth?: boolean;
  /** Age at retirement on 2026-01-01 (default 63, when Social Security starts). */
  readonly age?: number;
  /** A taxable brokerage account of this balance instead of the Roth IRA. */
  readonly brokerageBalance?: number;
}

function args(h: Household): RunBalanceProjectionArgs {
  const scenario: ScenarioAggregate = {
    ...BASE,
    id: 's',
    aggregateType: 'scenario',
    payload: {
      name: 'Credit', description: '', parentScenarioId: null, isPrimary: true, notes: '',
      overrides: {
        retirementAge: { primary: { ageYears: h.age ?? 63, ageMonths: 0 } },
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
      name: 'roth',
      type: h.brokerageBalance !== undefined ? 'BROKERAGE' : h.preTax === true ? 'RETIREMENT_IRA' : 'RETIREMENT_ROTH_IRA',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: h.brokerageBalance !== undefined ? 'POST_TAX' : h.preTax === true ? 'PRE_TAX' : 'ROTH',
      ownerId: 'm1', institution: 'V', notes: '', planningReturnPct: 0, active: true,
      plannedContributionPreTax: 0, plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
      ...(h.preTax === true || h.brokerageBalance !== undefined
        ? {}
        : { rothIraFirstContributionTaxYear: h.nonqualifiedRoth === true ? 2025 : 2015 }),
    },
  };
  const balance: Aggregate<AccountBalancePayload> = {
    ...BASE,
    id: 'b-roth',
    aggregateType: 'accountBalance',
    payload: {
      accountId: 'roth', year: 2025, lastUpdated: '2025-12-31', startingBalance: h.brokerageBalance ?? 2_000_000,
      startingBalancePreTax: null, startingBalancePostTax: null, contributionsPreTax: null,
      contributionsPostTax: null, companyContributions: 0, companyContributionsPreTax: null,
      companyContributionsPostTax: null, rollover: 0, distributions: 0, endingBalance: h.brokerageBalance ?? 2_000_000,
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
    members: [member(h.age)],
    ssBenefits: h.noSocialSecurity === true ? [] : [ss],
    expenses: [
      ...(h.medicalMonthly === undefined
        ? [expense('medical', 'cat-medical', h.medical)]
        : [monthlyExpense('medical', 'cat-medical', h.medicalMonthly)]),
      ...(h.other > 0 ? [expense('living', 'cat-housing', h.other)] : []),
      ...(h.shortMonthly === undefined
        ? []
        : [monthlyExpense('short', 'cat-housing', h.shortMonthly.amount, h.shortMonthly.months)]),
    ],
    ...(h.noMedicalCategory === true ? { medicalCategoryIds: [] } : {}),
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

describe('credit applied to premiums, deterministic versus Monte Carlo', () => {
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

describe('credit applied to premiums, uneven months and the funded draw', () => {
  it('uneven year: Monte Carlo lowers the draw by the whole line, as the deterministic engine does', () => {
    // Jan-Jun spend 10,668 + 600 a month, Jul-Dec 600: the draw is 51,958 before
    // the line, and only the six deficit months can carry it.
    const h: Household = {
      medical: 0, other: 0, medicalMonthly: 600, shortMonthly: { amount: 10_668, months: 6 },
    };
    const det = detRow(h);
    const { row } = mcFirstRow(h);
    expect(det.acaCreditAppliedToPremiumsCents).toBe(cents(5_134.2));
    expect(det.withdrawn).toBeCloseTo(46_823.8, 2);
    expect(row.acaCreditAppliedToPremiumsCents).toBe(det.acaCreditAppliedToPremiumsCents);
    expect(Math.round(row.withdrawn * 100)).toBe(Math.round(det.withdrawn * 100));
  });

  it('uneven year: the cap is the draw the months make, not the year net of income', () => {
    // Annual spending 30,000 is below Social Security 31,300, but Jan-Jun draw
    // 6 x (4,400 - 2,608.33) = 10,750 and the surplus months do not offset it.
    const h: Household = {
      medical: 0, other: 0, medicalMonthly: 600, shortMonthly: { amount: 3_800, months: 6 },
    };
    const det = detRow(h);
    const { row } = mcFirstRow(h);
    expect(det.acaCreditAppliedToPremiumsCents).toBe(cents(5_134.2));
    expect(det.withdrawn).toBeCloseTo(5_615.8, 2);
    expect(row.acaCreditAppliedToPremiumsCents).toBe(det.acaCreditAppliedToPremiumsCents);
    expect(Math.round(row.withdrawn * 100)).toBe(Math.round(det.withdrawn * 100));
  });

  it('reports the line that funded the draw, not one restated after the draw fell', () => {
    // The reported line is the whole fall in the draw against the same plan with
    // no Medical category, not a credit restated from the lower pass-2 MAGI.
    const h: Household = { medical: 20_000, other: 25_000, preTax: true };
    const { row } = mcFirstRow(h);
    const { row: without } = mcFirstRow({ ...h, noMedicalCategory: true });
    expect(row.acaCreditAppliedToPremiumsCents).toBeGreaterThan(0);
    expect(without.acaCreditAppliedToPremiumsCents ?? 0).toBe(0);
    expect(Math.round((without.withdrawn - row.withdrawn) * 100)).toBe(
      row.acaCreditAppliedToPremiumsCents,
    );
  });

  it('funds the deterministic draw on the lowered amount it commits', () => {
    // A pre-tax IRA: the solver's own credit (the line plus the part spent on
    // tax) matches the credit on the draw the engine commits.
    const row = detRow({ medical: 20_000, other: 25_000, preTax: true });
    expect(row.acaCreditAppliedToPremiumsCents).toBeGreaterThan(0);
    // The solver stops within its convergence tolerance, so allow a cent or two.
    expect(
      (row.acaCreditAppliedToPremiumsCents ?? 0) + (row.acaPtcCashflowOffsetCents ?? 0),
    ).toBeCloseTo(row.acaPtcSubsidyCents ?? 0, -1);
  });
});

describe('credit applied to premiums, near the poverty line', () => {
  // No Social Security, so ACA MAGI is only what the household draws and earns;
  // a draw lowered below the guideline earns no credit, so no line may lower it there.

  it('a pre-tax draw: neither engine lowers the draw below the guideline', () => {
    // Need before the line 22,000 (140.6% of the guideline); the credit is 6,405.80
    // there, more than the 6,350 of MAGI above the guideline.
    const h: Household = { medical: 7_200, other: 14_808, preTax: true, noSocialSecurity: true };
    const det = detRow(h);
    const { row } = mcFirstRow(h);
    const { row: without } = mcFirstRow({ ...h, noMedicalCategory: true });
    for (const r of [det, row]) {
      expect(r.acaCreditAppliedToPremiumsCents).toBeGreaterThan(0);
      expect(r.withdrawn).toBeGreaterThanOrEqual(GUIDELINE_DOLLARS - 0.01);
      expect(r.acaCreditAppliedToPremiumsCents).toBeLessThanOrEqual(cents(22_008 - GUIDELINE_DOLLARS));
    }
    // The lowered draw still earns a credit on the row the engine reports.
    expect(det.acaPtcSubsidyCents).toBeGreaterThan(0);
    // The line is the whole fall in the stress test's draw.
    expect(Math.round((without.withdrawn - row.withdrawn) * 100)).toBe(
      row.acaCreditAppliedToPremiumsCents,
    );
  });

  it('a qualified Roth draw sheds no MAGI: both engines apply the whole line', () => {
    // A $15,650 pension is exactly on the guideline and the Roth draw funds the
    // rest, so lowering the draw leaves MAGI, and the credit, where they are.
    const h: Household = { medical: 7_200, other: 28_452, pensionAnnual: GUIDELINE_DOLLARS, noSocialSecurity: true };
    const det = detRow(h);
    const { row, summary } = mcFirstRow(h);
    expect(det.acaPtcSubsidyCents).toBeGreaterThan(cents(6_800));
    expect(det.acaCreditAppliedToPremiumsCents).toBe(
      (det.acaPtcSubsidyCents ?? 0) - (det.acaPtcCashflowOffsetCents ?? 0),
    );
    expect(row.acaCreditAppliedToPremiumsCents).toBe(det.acaCreditAppliedToPremiumsCents);
    expect(Math.round(row.withdrawn * 100)).toBe(Math.round(det.withdrawn * 100));
    const p50 = summary.acaCreditAppliedToPremiumsPercentilesByYear?.p50[0] ?? Number.NaN;
    expect(p50 * 100).toBeCloseTo(det.acaCreditAppliedToPremiumsCents ?? 0, 0);
  });
});

describe('credit applied to premiums, taxable Roth earnings', () => {
  it('a nonqualified Roth draw sheds its earnings as MAGI: both engines hold the line to the guideline', () => {
    // No Social Security, a Roth IRA first funded in 2025: the $7,200 of Medical
    // and $10,800 of other spending is $18,000 of need, and the taxable earnings
    // are ACA MAGI, so a draw lowered below the guideline earns no credit.
    const h: Household = { medical: 7_200, other: 10_800, nonqualifiedRoth: true, noSocialSecurity: true };
    const det = detRow(h);
    const { row } = mcFirstRow(h);
    expect(det.acaCreditAppliedToPremiumsCents).toBe(row.acaCreditAppliedToPremiumsCents);
    expect(Math.round(det.withdrawn * 100)).toBe(Math.round(row.withdrawn * 100));
    expect(det.acaPtcSubsidyCents).toBeGreaterThan(0);
  });
});

describe('credit applied to premiums, nonqualified Roth above the poverty line', () => {
  // A $20,000 pension and a Roth IRA first funded in 2025, so every dollar drawn is
  // taxable earnings and ACA MAGI is 20,000 plus the draw. The draw before any line
  // is 17,200; the lowered draw has less MAGI, so earns more credit than the line.
  const h: Household = {
    medical: 7_200, other: 30_000, pensionAnnual: 20_000, nonqualifiedRoth: true, noSocialSecurity: true,
  };

  it('both engines price it on the draw before the line, never above what the credit earns there', () => {
    const det = detRow(h);
    const earned = (det.acaPtcSubsidyCents ?? 0) - (det.federalTaxCents ?? 0);
    expect(det.acaCreditAppliedToPremiumsCents).toBeGreaterThan(0);
    expect(det.acaCreditAppliedToPremiumsCents ?? 0).toBeLessThanOrEqual(Math.max(0, earned));
    const { row } = mcFirstRow(h);
    expect(row.acaCreditAppliedToPremiumsCents).toBe(det.acaCreditAppliedToPremiumsCents);
    expect(Math.round(row.withdrawn * 100)).toBe(Math.round(det.withdrawn * 100));
  });
});

describe('credit applied to premiums, early-withdrawal penalty years', () => {
  it('the stress test counts the penalty in the offset as the projection does, so its line is not the larger', () => {
    // A 55-year-old draws a traditional IRA: the line is what is left after federal
    // tax AND the 10% penalty; the stress test prices the credit once, so its line
    // stays the smaller of the two.
    const h: Household = { medical: 7_200, other: 22_800, preTax: true, noSocialSecurity: true, age: 55 };
    const det = detRow(h);
    const { row } = mcFirstRow(h);
    expect(row.acaCreditAppliedToPremiumsCents).toBeGreaterThan(0);
    expect(row.acaCreditAppliedToPremiumsCents ?? 0).toBeLessThanOrEqual(det.acaCreditAppliedToPremiumsCents ?? 0);
  });
});

describe('credit applied to premiums, taxable brokerage near the poverty line', () => {
  it('only the gain in a brokerage draw is MAGI, so the draw can fall further before the credit ends', () => {
    // A $14,000 pension and a brokerage account at the default half basis: the $8,000
    // draw before the line puts MAGI 2,350 over the guideline, so the draw can fall by
    // 4,700 before MAGI reaches it.
    const h: Household = {
      medical: 7_200, other: 14_796, pensionAnnual: 14_000, brokerageBalance: 100_000, noSocialSecurity: true,
    };
    const det = detRow(h);
    const { row } = mcFirstRow(h);
    for (const r of [det, row]) {
      expect(r.acaCreditAppliedToPremiumsCents).toBeGreaterThan(cents(4_600));
      // The lowered draw still earns a credit: its gain keeps MAGI at the guideline.
      expect(14_000 + r.withdrawn / 2).toBeGreaterThanOrEqual(GUIDELINE_DOLLARS - 0.01);
    }
    expect(Math.abs(row.acaCreditAppliedToPremiumsCents! - det.acaCreditAppliedToPremiumsCents!)).toBeLessThanOrEqual(2);
  });
});
