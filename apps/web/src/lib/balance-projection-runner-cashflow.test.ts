/** Unit tests for `buildCashflowSeries` in `balance-projection-runner-cashflow.ts`. */
import { describe, expect, it } from 'vitest';
import { buildCashflowSeries } from './balance-projection-runner-cashflow';
import { buildPipelineContext } from './balance-projection-runner-context';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';
import type { ScenarioAggregate } from './scenario-resolution';
import type {
  PipelineContext,
  RunBalanceProjectionArgs,
} from './balance-projection-runner-types';

const TODAY_YEAR = 2026;
const TODAY_MONTH_INDEX = 5; // June (0-indexed).

function member(
  id: string,
  isPrimary: boolean,
  firstName: string,
  birthYear: number,
): Aggregate<HouseholdMemberPayload> {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'householdMember',
    payload: {
      isPrimary,
      firstName,
      lastName: 'Doe',
      email: `${id}@example.test`,
      birthdate: `${birthYear}-01-01`,
    },
  };
}

function ssBenefit(
  memberId: string,
  pia: number | null,
): Aggregate<SocialSecurityBenefitPayload> {
  return {
    id: `ss-${memberId}`,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'socialSecurityBenefit',
    payload: {
      householdMemberId: memberId,
      pia,
      piaAsOfDate: '2026-01-01',
      notes: null,
    },
  };
}

function brokerage(
  id: string,
  ownerId: string,
  type: AccountPayload['type'] = 'BROKERAGE',
  taxTreatment: AccountPayload['taxTreatment'] = 'POST_TAX',
  planningReturnPct = 5,
  plannedPre = 0,
  plannedPost = 0,
): Aggregate<AccountPayload> {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'account',
    payload: {
      name: id,
      type,
      ownershipType: 'INDIVIDUAL',
      taxTreatment,
      ownerId,
      institution: 'Vanguard',
      notes: '',
      planningReturnPct,
      active: true,
      plannedContributionPreTax: plannedPre,
      plannedContributionPostTax: plannedPost,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
    },
  };
}

function balanceRow(
  accountId: string,
  year: number,
  endingBalance: number,
): Aggregate<AccountBalancePayload> {
  return {
    id: `b-${accountId}-${year}`,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'accountBalance',
    payload: {
      accountId,
      year,
      lastUpdated: `${year}-12-31`,
      startingBalance: endingBalance * 0.9,
      startingBalancePreTax: null,
      startingBalancePostTax: null,
      contributionsPreTax: null,
      contributionsPostTax: null,
      companyContributions: 0,
      companyContributionsPreTax: null,
      companyContributionsPostTax: null,
      rollover: 0,
      distributions: 0,
      endingBalance,
      endingBalancePreTax: null,
      endingBalancePostTax: null,
      totalContributions: 0,
      comment: null,
    },
  };
}

function baseScenario(
  id: string,
  name: string,
  overrides: Partial<ScenarioAggregate['payload']['overrides']> = {},
): ScenarioAggregate {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'scenario',
    payload: {
      name,
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides: {
        socialSecurity: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
        },
        retirementAge: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
        },
        inflation: { ratePct: 0 },
        lifeExpectancy: { primary: 90, secondary: 90 },
        ...overrides,
      },
    },
  };
}

interface FixtureOverrides {
  readonly expenses?: ReadonlyArray<Aggregate<ExpensePayload>>;
  readonly incomeStreams?: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  readonly members?: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  readonly ssBenefits?: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  readonly accounts?: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly balances?: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly scenario?: ScenarioAggregate;
  readonly medicalCategoryIds?: ReadonlyArray<string>;
}

function buildCtx(o: FixtureOverrides = {}): {
  args: RunBalanceProjectionArgs;
  ctx: PipelineContext;
} {
  const members = o.members ?? [member('m1', true, 'Alex', 1965)];
  const ssBenefits = o.ssBenefits ?? [ssBenefit('m1', 2500)];
  const accounts = o.accounts ?? [brokerage('a1', 'm1')];
  const balances = o.balances ?? [balanceRow('a1', 2025, 800_000)];
  const scenario = o.scenario ?? baseScenario('s', 'Base');
  const args: RunBalanceProjectionArgs = {
    scenarioId: scenario.id,
    scenarios: [scenario],
    accounts,
    balances,
    members,
    ssBenefits,
    expenses: o.expenses ?? [],
    incomeStreams: o.incomeStreams ?? [],
    todayYear: TODAY_YEAR,
    todayMonthIndex: TODAY_MONTH_INDEX,
    ...(o.medicalCategoryIds
      ? { medicalCategoryIds: o.medicalCategoryIds }
      : {}),
  };
  const ctx = buildPipelineContext(args);
  if (!ctx) throw new Error('fixture failed to build a pipeline context');
  return { args, ctx };
}

describe('buildCashflowSeries', () => {
  it('should_produce_correctly_sized_all_zero_series_for_no_expense_no_income_household', () => {
    const { args, ctx } = buildCtx({
      expenses: [],
      incomeStreams: [],
      ssBenefits: [ssBenefit('m1', null)], // no PIA → no SS rows at all.
    });

    const series = buildCashflowSeries(args, ctx);

    const expectedLength =
      (ctx.horizonYear - ctx.primaryRetirementYear + 1) * 12;
    expect(series.expensesByMonth.startYear).toBe(ctx.primaryRetirementYear);
    expect(series.expensesByMonth.values.length).toBe(expectedLength);
    expect(series.incomeByMonth.values.length).toBe(expectedLength);
    expect(series.depositsByMonth.values.length).toBe(expectedLength);
    const allZero = (v: Float64Array): boolean => v.every((x) => x === 0);
    expect(allZero(series.expensesByMonth.values)).toBe(true);
    expect(allZero(series.incomeByMonth.values)).toBe(true);
    expect(allZero(series.depositsByMonth.values)).toBe(true);
    expect(series.nonSsIncomeRows).toEqual([]);
    expect(series.targetedOneOffEvents).toEqual([]);
    expect(series.postPrimaryContributionEvents).toEqual([]);
    // A null SS PIA yields a real context whose rows are all zero.
    expect(series.expenseRows.length).toBe(expectedLength);
    expect(series.expenseRows.every((r) => r.total === 0)).toBe(true);
    expect(series.ssRows.every((r) => r.total === 0)).toBe(true);
  });

  it('should_spread_a_single_yearly_expense_as_a_monthly_run_rate_in_expensesByMonth', () => {
    // One $60k/yr essential expense, retirementStart → lifetime, zero inflation: every retirement month carries $5,000.
    const expense: Aggregate<ExpensePayload> = {
      id: 'e1',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'expense',
      payload: {
        name: 'Living',
        categoryId: 'cat-housing',
        amount: 60_000,
        frequency: 'yearly',
        classification: 'essential',
        start: { kind: 'retirementStart' },
        end: { kind: 'lifetime', whose: 'last' },
      },
    };
    const { args, ctx } = buildCtx({ expenses: [expense] });

    const series = buildCashflowSeries(args, ctx);

    const first = series.expensesByMonth.values[0];
    expect(first).toBeCloseTo(5_000, 6);
    const firstTwelve = Array.from(
      series.expensesByMonth.values.slice(0, 12),
    ).reduce((a, b) => a + b, 0);
    expect(firstTwelve).toBeCloseTo(60_000, 4);
    expect(series.expenseRows[0].total).toBeCloseTo(60_000, 4);
    expect(series.expenseRows[0].oneOffEssential).toBe(0);
  });

  it('should_keep_only_post_primary_nonzero_deposit_inflow_rows_in_targetedOneOffEvents', () => {
    // A one-off windfall deposited after primary retirement (2034 vs a 2032 retirement) must survive the targetedOneOffEvents
    // filter (post-primary and depositInflow !== 0).
    const windfall: Aggregate<IncomeStreamPayload> = {
      id: 'inc-windfall',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'incomeStream',
      payload: {
        name: 'Windfall',
        kind: 'oneOff',
        memberId: 'm1',
        oneOffAmount: 40_000,
        // targetAccountId routes the receipt to depositInflow rather than spendable income.
        targetAccountId: 'a1',
        start: { kind: 'year', year: 2034 },
      } as IncomeStreamPayload,
    };
    const { args, ctx } = buildCtx({ incomeStreams: [windfall] });

    const series = buildCashflowSeries(args, ctx);

    expect(series.targetedOneOffEvents.length).toBeGreaterThan(0);
    for (const ev of series.targetedOneOffEvents) {
      expect(ev.amount).not.toBe(0);
      expect(ev.month).toBeGreaterThanOrEqual(ctx.primaryRetirementAbsMonth);
    }
    const total = series.targetedOneOffEvents.reduce(
      (a, e) => a + e.amount,
      0,
    );
    expect(total).toBeCloseTo(40_000, 4);
    const rowDeposits = series.nonSsIncomeRows.filter(
      (r) => r.depositInflow !== 0,
    );
    expect(rowDeposits.length).toBeGreaterThan(0);
  });

  it('should_map_post_primary_contribution_abs_month_to_year_floor_and_month0_mod', () => {
    // The secondary (born 1968) retires two years after the primary (born 1965); their individual account's planned monthly
    // contributions become post-primary events for each month in [primaryRetireAbs, secondaryRetireAbs).
    const primary = member('m1', true, 'Alex', 1965);
    const secondary = member('m2', false, 'Sam', 1968);
    const secAccount = brokerage(
      'a-sec',
      'm2',
      'RETIREMENT_401K',
      'PRE_TAX',
      5,
      12_000, // $12k/yr pre-tax planned contribution → $1000/mo.
      0,
    );
    const { args, ctx } = buildCtx({
      members: [primary, secondary],
      ssBenefits: [ssBenefit('m1', 2500), ssBenefit('m2', 2000)],
      accounts: [brokerage('a1', 'm1'), secAccount],
      balances: [
        balanceRow('a1', 2025, 800_000),
        balanceRow('a-sec', 2025, 200_000),
      ],
    });

    const series = buildCashflowSeries(args, ctx);

    // Each event's absolute month round-trips to {year: floor(m/12), month0: m%12}.
    expect(series.postPrimaryContributionEvents.length).toBeGreaterThan(0);
    for (const ev of series.postPrimaryContributionEvents) {
      const year = Math.floor(ev.month / 12);
      const month0 = ev.month - year * 12;
      expect(month0).toBe(ev.month % 12);
      expect(year * 12 + month0).toBe(ev.month);
      expect(ev.month).toBeGreaterThanOrEqual(ctx.primaryRetirementAbsMonth);
      expect(ev.amount).toBeCloseTo(1_000, 6); // $12k/yr ÷ 12.
    }
  });

  it('should_derive_amountPre_and_amountPost_from_a_MIXED_secondary_account', () => {
    // A MIXED secondary account with pre-tax and designated-Roth planned contributions: each event carries the per-bucket split
    // and amount is the sum.
    const primary = member('m1', true, 'Alex', 1965);
    const secondary = member('m2', false, 'Sam', 1968);
    const PLANNED_PRE = 9_000; // $9k/yr → $750/mo pre-tax.
    const PLANNED_POST = 6_000; // $6k/yr → $500/mo designated-Roth.
    const mixedAccount = brokerage(
      'a-sec',
      'm2',
      'RETIREMENT_401K',
      'MIXED',
      5,
      PLANNED_PRE,
      PLANNED_POST,
    );
    const { args, ctx } = buildCtx({
      members: [primary, secondary],
      ssBenefits: [ssBenefit('m1', 2500), ssBenefit('m2', 2000)],
      accounts: [brokerage('a1', 'm1'), mixedAccount],
      balances: [
        balanceRow('a1', 2025, 800_000),
        balanceRow('a-sec', 2025, 200_000),
      ],
    });

    const series = buildCashflowSeries(args, ctx);

    expect(series.postPrimaryContributionEvents.length).toBeGreaterThan(0);
    for (const ev of series.postPrimaryContributionEvents) {
      expect(ev.amountPre).toBeCloseTo(PLANNED_PRE / 12, 6);
      expect(ev.amountPost).toBeCloseTo(PLANNED_POST / 12, 6);
      expect(ev.amount).toBeCloseTo((PLANNED_PRE + PLANNED_POST) / 12, 6);
      expect(ev.amount).toBeCloseTo((ev.amountPre ?? 0) + (ev.amountPost ?? 0), 6);
    }
  });

  it('should_route_a_POST_TAX_only_secondary_account_entirely_to_amountPost', () => {
    // A POST_TAX (designated-Roth) secondary account: the whole contribution is the post slice.
    const primary = member('m1', true, 'Alex', 1965);
    const secondary = member('m2', false, 'Sam', 1968);
    const PLANNED_POST = 6_000; // $6k/yr → $500/mo.
    const rothAccount = brokerage(
      'a-sec',
      'm2',
      'RETIREMENT_ROTH_IRA',
      'POST_TAX',
      5,
      0,
      PLANNED_POST,
    );
    const { args, ctx } = buildCtx({
      members: [primary, secondary],
      ssBenefits: [ssBenefit('m1', 2500), ssBenefit('m2', 2000)],
      accounts: [brokerage('a1', 'm1'), rothAccount],
      balances: [
        balanceRow('a1', 2025, 800_000),
        balanceRow('a-sec', 2025, 200_000),
      ],
    });

    const series = buildCashflowSeries(args, ctx);

    expect(series.postPrimaryContributionEvents.length).toBeGreaterThan(0);
    for (const ev of series.postPrimaryContributionEvents) {
      expect(ev.amountPre).toBe(0);
      expect(ev.amountPost).toBeCloseTo(PLANNED_POST / 12, 6);
      expect(ev.amount).toBeCloseTo(ev.amountPost ?? 0, 6);
    }
  });

  // First full-year January SS run-rate and the next January: a clean COLA step that avoids claim-year proration.
  function ssYearOverYearRatio(series: ReturnType<typeof buildCashflowSeries>): number {
    const januaries = series.ssRows.filter((r) => r.month0 === 0 && r.total > 0);
    expect(januaries.length).toBeGreaterThanOrEqual(2);
    const firstFull = januaries[0];
    const nextFull = januaries.find((r) => r.year === firstFull.year + 1);
    expect(nextFull).toBeDefined();
    return nextFull!.total / firstFull.total;
  }

  it('should_track_scenario_inflation_for_ss_cola_by_default', () => {
    // The claim age is set but colaTracksInflation is omitted: SS grows at the 2.5% scenario inflation regardless of colaPct
    // (birth 1960 → claim 2027).
    const scenarioTrack = baseScenario('s-track', 'TracksInflation', {
      socialSecurity: { primary: { ageYears: 67, ageMonths: 0 } },
      inflation: { ratePct: 2.5 },
    });
    const { args, ctx } = buildCtx({
      members: [member('m1', true, 'Alex', 1960)],
      ssBenefits: [ssBenefit('m1', 2000)],
      balances: [balanceRow('a1', 2025, 500_000)],
      scenario: scenarioTrack,
    });

    const series = buildCashflowSeries(args, ctx);

    expect(series.ssRows.length).toBeGreaterThan(0);
    expect(ssYearOverYearRatio(series)).toBeCloseTo(1.025, 3);
  });

  it('should_use_fixed_cola_pct_when_tracking_disabled', () => {
    // colaTracksInflation: false with a fixed 4% COLA (≠ 2.5% inflation): SS grows at colaPct.
    const scenarioFixed = baseScenario('s-fixed', 'FixedCola', {
      socialSecurity: {
        primary: { ageYears: 67, ageMonths: 0 },
        colaPct: 4,
        colaTracksInflation: false,
      },
      inflation: { ratePct: 2.5 },
    });
    const { args, ctx } = buildCtx({
      members: [member('m1', true, 'Alex', 1960)],
      ssBenefits: [ssBenefit('m1', 2000)],
      balances: [balanceRow('a1', 2025, 500_000)],
      scenario: scenarioFixed,
    });

    const series = buildCashflowSeries(args, ctx);

    expect(series.ssRows.length).toBeGreaterThan(0);
    expect(ssYearOverYearRatio(series)).toBeCloseTo(1.04, 3);
  });
});

describe('per-category inflation in the expense band', () => {
  const recurring = (
    id: string,
    categoryId: string,
  ): Aggregate<ExpensePayload> => ({
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'expense',
    payload: {
      name: id,
      categoryId,
      amount: 1_000,
      frequency: 'monthly',
      classification: 'essential',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    },
  });

  it('Medical grows faster than an identical non-medical expense at the same general rate', () => {
    // General 3%; Medical defaults to general + 2pp (5%) via the resolver, with no explicit categoryRates.
    const scenario = baseScenario('s', 'WithMedicalInflation', {
      inflation: { ratePct: 3 },
    });
    const med = recurring('med', 'cat-medical');
    const housing = recurring('housing', 'cat-housing');
    const { args, ctx } = buildCtx({ expenses: [med, housing], scenario });
    const series = buildCashflowSeries(args, ctx);

    const medCtx = buildCtx({ expenses: [med], scenario });
    const medOnly = buildCashflowSeries(medCtx.args, medCtx.ctx);
    const housingCtx = buildCtx({ expenses: [housing], scenario });
    const housingOnly = buildCashflowSeries(housingCtx.args, housingCtx.ctx);

    // Equal at the first retirement month; ~10 years out Medical (5%) outpaces Housing (3%).
    const idx = 12 * 10; // ~10 years into retirement
    expect(medOnly.expensesByMonth.values[idx]).toBeGreaterThan(
      housingOnly.expensesByMonth.values[idx],
    );
    // The combined band equals the sum of the single-category bands, within the sub-cent seam of per-month rounding.
    expect(series.expensesByMonth.values[idx]).toBeCloseTo(
      medOnly.expensesByMonth.values[idx] +
        housingOnly.expensesByMonth.values[idx],
      2,
    );
  });

  it('an explicit Medical override (= general) removes the spread', () => {
    const scenario = baseScenario('s', 'MedicalEqualsGeneral', {
      inflation: { ratePct: 3, categoryRates: { 'cat-medical': 3 } },
    });
    const med = recurring('med', 'cat-medical');
    const housing = recurring('housing', 'cat-housing');
    const medCtx = buildCtx({ expenses: [med], scenario });
    const medSeries = buildCashflowSeries(medCtx.args, medCtx.ctx);
    const housingCtx = buildCtx({ expenses: [housing], scenario });
    const housingSeries = buildCashflowSeries(housingCtx.args, housingCtx.ctx);
    const idx = 12 * 10;
    expect(medSeries.expensesByMonth.values[idx]).toBeCloseTo(
      housingSeries.expensesByMonth.values[idx],
      4,
    );
  });

  it('flag follows the engine: a recreated-Medical (NEW id) in medicalCategoryIds gets +2pp; cat-medical omitted does not', () => {
    // The set carries only the recreated id, not cat-medical, so a stale hard-coded cat-medical path cannot pass.
    const scenario = baseScenario('s', 'Recreated', { inflation: { ratePct: 3 } });
    const newMed = recurring('newmed', 'cat-medical-recreated');
    const legacyMed = recurring('legacymed', 'cat-medical');
    const idx = 12 * 10;

    const newCtx = buildCtx({
      expenses: [newMed],
      scenario,
      medicalCategoryIds: ['cat-medical-recreated'],
    });
    const legacyCtx = buildCtx({
      expenses: [legacyMed],
      scenario,
      medicalCategoryIds: ['cat-medical-recreated'],
    });
    const newSeries = buildCashflowSeries(newCtx.args, newCtx.ctx);
    const legacySeries = buildCashflowSeries(legacyCtx.args, legacyCtx.ctx);
    expect(newSeries.expensesByMonth.values[idx]).toBeGreaterThan(
      legacySeries.expensesByMonth.values[idx],
    );
  });

  it('a second medical category (two flagged ids) both grow at +2pp', () => {
    const scenario = baseScenario('s', 'TwoMed', { inflation: { ratePct: 3 } });
    const dental = recurring('dental', 'cat-dental');
    const housing = recurring('housing', 'cat-housing');
    const idx = 12 * 10;
    const dentalCtx = buildCtx({
      expenses: [dental],
      scenario,
      medicalCategoryIds: ['cat-medical', 'cat-dental'],
    });
    const housingCtx = buildCtx({
      expenses: [housing],
      scenario,
      medicalCategoryIds: ['cat-medical', 'cat-dental'],
    });
    const dentalSeries = buildCashflowSeries(dentalCtx.args, dentalCtx.ctx);
    const housingSeries = buildCashflowSeries(housingCtx.args, housingCtx.ctx);
    expect(dentalSeries.expensesByMonth.values[idx]).toBeGreaterThan(
      housingSeries.expensesByMonth.values[idx],
    );
  });
});

describe('buildPipelineContext — working-years Roth-conversion basis separation', () => {
  // The working-years converted principal seeds only preRetirementConversionBasisCentsByOwner; rothBasisCentsByOwner (threaded
  // into the MC tax context, which does not model the conversion deposit legs) must stay identical to the no-conversion
  // case, or MC Roth withdrawals would be shielded from tax the MC Roth balance never received.
  function conversionFixture(withConversion: boolean): PipelineContext {
    const m1 = member('m1', true, 'Alex', 1965); // retire 67 → 2032; works 2026-31
    const src = brokerage('pre', 'm1', 'RETIREMENT_401K', 'PRE_TAX', 5);
    const roth = brokerage('roth', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH', 5);
    const overrides = withConversion
      ? {
          preRetirementRothConversions: [
            {
              sourceAccountId: 'pre',
              targetRothAccountId: 'roth',
              annualAmountDollars: 20_000,
              start: { kind: 'year' as const, year: 2026 },
              end: { kind: 'year' as const, year: 2028 }, // active 2026, 2027, 2028
            },
          ],
        }
      : {};
    const { ctx } = buildCtx({
      members: [m1],
      ssBenefits: [ssBenefit('m1', 2500)],
      accounts: [src, roth],
      balances: [balanceRow('pre', 2025, 400_000), balanceRow('roth', 2025, 50_000)],
      scenario: baseScenario('s', 'Base', overrides),
    });
    return ctx;
  }

  it('keeps rothBasisCentsByOwner (MC seed) identical and folds conversion basis into the separate map', () => {
    const without = conversionFixture(false);
    const withConv = conversionFixture(true);

    expect([...withConv.rothBasisCentsByOwner.entries()]).toEqual(
      [...without.rothBasisCentsByOwner.entries()],
    );

    // 3 working years (2026-2028; retire 2032) × $20,000 = $60,000 = 6,000,000 cents for m1.
    expect(withConv.preRetirementConversionBasisCentsByOwner.get('m1')).toBe(
      6_000_000,
    );
    expect(without.preRetirementConversionBasisCentsByOwner.size).toBe(0);
  });
});

describe('buildCashflowSeries — hsaQualified filter on medicalDemandByMonth', () => {
  const medExp = (
    id: string,
    amount: number,
    hsaQualified?: boolean,
    categoryId = 'cat-medical',
  ): Aggregate<ExpensePayload> => ({
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'expense',
    payload: {
      name: id,
      categoryId,
      amount,
      frequency: 'monthly',
      classification: 'essential',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
      ...(hsaQualified !== undefined ? { hsaQualified } : {}),
    },
  });

  // medicalDemandByMonth is in cents; convert to dollars for comparisons.
  function sumDemandDollars(series: ReturnType<typeof buildCashflowSeries>): number {
    if (!series.medicalDemandByMonth) return 0;
    return series.medicalDemandByMonth.reduce((a, b) => a + b, 0) / 100;
  }

  it('a legacy/absent medical row produces zero HSA medical demand', () => {
    const { args, ctx } = buildCtx({
      expenses: [medExp('e-legacy', 600)], // absent
      medicalCategoryIds: ['cat-medical'],
    });
    const series = buildCashflowSeries(args, ctx);
    expect(sumDemandDollars(series)).toBe(0);
    expect(series.medicalDemandByMonth?.every((v) => v === 0)).toBe(true);
  });

  it('only hsaQualified === true rows contribute to medical demand', () => {
    const { args: argsQual, ctx: ctxQual } = buildCtx({
      expenses: [medExp('e-q', 500, true)],
      medicalCategoryIds: ['cat-medical'],
    });
    const { args: argsMixed, ctx: ctxMixed } = buildCtx({
      expenses: [medExp('e-q', 500, true), medExp('e-nq', 800, false)],
      medicalCategoryIds: ['cat-medical'],
    });
    const qualOnly = buildCashflowSeries(argsQual, ctxQual);
    const mixed = buildCashflowSeries(argsMixed, ctxMixed);
    expect(sumDemandDollars(mixed)).toBeCloseTo(sumDemandDollars(qualOnly), 0);
  });

  it('hsaQualified === false row leaves zero demand', () => {
    const { args, ctx } = buildCtx({
      expenses: [medExp('e-nq', 1_200, false)],
      medicalCategoryIds: ['cat-medical'],
    });
    const series = buildCashflowSeries(args, ctx);
    expect(sumDemandDollars(series)).toBe(0);
  });

  it('non-medical row with hsaQualified=true is ignored by the demand builder', () => {
    const { args, ctx } = buildCtx({
      expenses: [medExp('e-housing', 2_000, true, 'cat-housing')],
      medicalCategoryIds: ['cat-medical'],
    });
    const series = buildCashflowSeries(args, ctx);
    expect(sumDemandDollars(series)).toBe(0);
  });

  it('qualified demand is always ≤ total expense (strict-subset invariant)', () => {
    const expenses = [
      medExp('e-q', 500, true),
      medExp('e-nq', 800, false),
    ];
    const { args, ctx } = buildCtx({ expenses, medicalCategoryIds: ['cat-medical'] });
    const series = buildCashflowSeries(args, ctx);
    const demandSum = sumDemandDollars(series);
    const expenseSum = Array.from(series.expensesByMonth.values).reduce((a, b) => a + b, 0);
    expect(demandSum).toBeLessThanOrEqual(expenseSum + 0.01); // allow $0.01 rounding
    expect(demandSum).toBeGreaterThan(0);
  });
});
