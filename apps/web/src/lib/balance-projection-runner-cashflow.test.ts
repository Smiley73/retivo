/**
 * Unit tests for `buildCashflowSeries` (balance-projection-runner-cashflow.ts).
 *
 * Drives the real pipeline-context builder from `Aggregate` fixtures (same
 * fixture style as `balance-projection-runner.test.ts`) so the cashflow
 * series exercises the production expense / income / SS / deposit projection
 * helpers it composes. Each test isolates one cashflow surface:
 *  - degenerate empty inputs → correctly-sized all-zero series;
 *  - a single recurring expense → golden `expensesByMonth` run-rate;
 *  - the `targetedOneOffEvents` filter (depositInflow !== 0 AND post-primary);
 *  - the post-primary contribution abs-month → {year, month0} mapping;
 *  - SS rows tracking scenario inflation by default, and honouring a fixed
 *    colaPct when `colaTracksInflation` is off.
 */
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

/** Base scenario: primary + secondary retire & claim at 67, life 90, zero
 *  inflation. Override blocks are merged in per-test. */
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

/** Build the run-args + resolved pipeline context for a fixture. */
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
    // Arrange: primary born 1965, retire at 67 (2032), horizon at 90 (2055).
    // No expenses, no income streams, minimal SS so SS rows stay tiny but
    // the zero-cashflow surfaces (expenses, deposits) are exercised.
    const { args, ctx } = buildCtx({
      expenses: [],
      incomeStreams: [],
      ssBenefits: [ssBenefit('m1', null)], // no PIA → no SS rows at all.
    });

    // Act.
    const series = buildCashflowSeries(args, ctx);

    // Assert: span retirementYear..horizonYear inclusive, monthly.
    const expectedLength =
      (ctx.horizonYear - ctx.primaryRetirementYear + 1) * 12;
    expect(series.expensesByMonth.startYear).toBe(ctx.primaryRetirementYear);
    expect(series.expensesByMonth.values.length).toBe(expectedLength);
    expect(series.incomeByMonth.values.length).toBe(expectedLength);
    expect(series.depositsByMonth.values.length).toBe(expectedLength);
    // No expenses, no income, no SS PIA → every cashflow bucket is zero.
    const allZero = (v: Float64Array): boolean => v.every((x) => x === 0);
    expect(allZero(series.expensesByMonth.values)).toBe(true);
    expect(allZero(series.incomeByMonth.values)).toBe(true);
    expect(allZero(series.depositsByMonth.values)).toBe(true);
    // No income streams short-circuit to an empty list; no targeted/
    // post-primary events with nothing to deposit.
    expect(series.nonSsIncomeRows).toEqual([]);
    expect(series.targetedOneOffEvents).toEqual([]);
    expect(series.postPrimaryContributionEvents).toEqual([]);
    // Expense + SS projection still emit one zero-valued row per month
    // (a null SS PIA yields a real context whose rows are all zero).
    expect(series.expenseRows.length).toBe(expectedLength);
    expect(series.expenseRows.every((r) => r.total === 0)).toBe(true);
    expect(series.ssRows.every((r) => r.total === 0)).toBe(true);
  });

  it('should_spread_a_single_yearly_expense_as_a_monthly_run_rate_in_expensesByMonth', () => {
    // Arrange: one $60k/yr essential expense, retirementStart → lifetime.
    // Zero inflation, so every retirement month carries the same dollars.
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

    // Act.
    const series = buildCashflowSeries(args, ctx);

    // Assert golden: the first retirement month (index 0) carries the
    // $60k/yr run-rate divided by 12 = $5000, with zero inflation.
    const first = series.expensesByMonth.values[0];
    expect(first).toBeCloseTo(5_000, 6);
    // A full year of $5000 monthly = $60k annual.
    const firstTwelve = Array.from(
      series.expensesByMonth.values.slice(0, 12),
    ).reduce((a, b) => a + b, 0);
    expect(firstTwelve).toBeCloseTo(60_000, 4);
    // The expense rows surface the same run-rate as `total`.
    expect(series.expenseRows[0].total).toBeCloseTo(60_000, 4);
    expect(series.expenseRows[0].oneOffEssential).toBe(0);
  });

  it('should_keep_only_post_primary_nonzero_deposit_inflow_rows_in_targetedOneOffEvents', () => {
    // Arrange: a one-off windfall income stream that deposits into the
    // portfolio AFTER primary retirement (2034, two years past 2032 retire).
    // Its absolute month is >= primaryRetirementAbsMonth AND its
    // depositInflow !== 0, so it must survive the targetedOneOffEvents filter.
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
        // `targetAccountId` routes the receipt to depositInflow (portfolio
        // addition) rather than spendable income.
        targetAccountId: 'a1',
        start: { kind: 'year', year: 2034 },
      } as IncomeStreamPayload,
    };
    const { args, ctx } = buildCtx({ incomeStreams: [windfall] });

    // Act.
    const series = buildCashflowSeries(args, ctx);

    // Assert: every surviving targeted event is a non-zero deposit at or
    // after the primary retirement absolute month, and the windfall amount
    // is present.
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
    // Cross-check: no surviving event is a non-deposit row (depositInflow 0).
    const rowDeposits = series.nonSsIncomeRows.filter(
      (r) => r.depositInflow !== 0,
    );
    expect(rowDeposits.length).toBeGreaterThan(0);
  });

  it('should_map_post_primary_contribution_abs_month_to_year_floor_and_month0_mod', () => {
    // Arrange: secondary works (and contributes) two years past primary's
    // retirement. Primary born 1965 → retire 2032; secondary born 1968 →
    // retire 2035. The secondary's INDIVIDUAL account's planned monthly
    // contributions become post-primary contribution events for every
    // absolute month in [primaryRetireAbs, secondaryRetireAbs).
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

    // Act.
    const series = buildCashflowSeries(args, ctx);

    // Assert: each event's stored absolute month round-trips to the
    // {year: floor(m/12), month0: m%12} mapping the deposit builder uses.
    expect(series.postPrimaryContributionEvents.length).toBeGreaterThan(0);
    for (const ev of series.postPrimaryContributionEvents) {
      const year = Math.floor(ev.month / 12);
      const month0 = ev.month - year * 12;
      expect(month0).toBe(ev.month % 12);
      expect(year * 12 + month0).toBe(ev.month);
      // Each event sits in the overlap window [primaryRetire, secondaryRetire).
      expect(ev.month).toBeGreaterThanOrEqual(ctx.primaryRetirementAbsMonth);
      expect(ev.amount).toBeCloseTo(1_000, 6); // $12k/yr ÷ 12.
    }
  });

  it('should_derive_amountPre_and_amountPost_from_a_MIXED_secondary_account', () => {
    // Arrange: secondary's INDIVIDUAL account is MIXED — both a pre-tax and a
    // post-tax (designated-Roth) planned contribution. Each post-primary event
    // must carry the per-bucket split, with `amount` the summed total.
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

    // Act.
    const series = buildCashflowSeries(args, ctx);

    // Assert: every event carries the per-bucket split, summing to `amount`.
    expect(series.postPrimaryContributionEvents.length).toBeGreaterThan(0);
    for (const ev of series.postPrimaryContributionEvents) {
      expect(ev.amountPre).toBeCloseTo(PLANNED_PRE / 12, 6);
      expect(ev.amountPost).toBeCloseTo(PLANNED_POST / 12, 6);
      expect(ev.amount).toBeCloseTo((PLANNED_PRE + PLANNED_POST) / 12, 6);
      expect(ev.amount).toBeCloseTo((ev.amountPre ?? 0) + (ev.amountPost ?? 0), 6);
    }
  });

  it('should_route_a_POST_TAX_only_secondary_account_entirely_to_amountPost', () => {
    // Arrange: a POST_TAX (designated-Roth) secondary account → the whole
    // contribution is the post slice; the pre slice is zero.
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

    // Act.
    const series = buildCashflowSeries(args, ctx);

    // Assert: amountPre === 0, amountPost === amount.
    expect(series.postPrimaryContributionEvents.length).toBeGreaterThan(0);
    for (const ev of series.postPrimaryContributionEvents) {
      expect(ev.amountPre).toBe(0);
      expect(ev.amountPost).toBeCloseTo(PLANNED_POST / 12, 6);
      expect(ev.amount).toBeCloseTo(ev.amountPost ?? 0, 6);
    }
  });

  // Helper: first full-year January SS run-rate and the same January one
  // year later, the clean COLA step (avoids claim-year proration).
  function ssYearOverYearRatio(series: ReturnType<typeof buildCashflowSeries>): number {
    const januaries = series.ssRows.filter((r) => r.month0 === 0 && r.total > 0);
    expect(januaries.length).toBeGreaterThanOrEqual(2);
    const firstFull = januaries[0];
    const nextFull = januaries.find((r) => r.year === firstFull.year + 1);
    expect(nextFull).toBeDefined();
    return nextFull!.total / firstFull.total;
  }

  it('should_track_scenario_inflation_for_ss_cola_by_default', () => {
    // Arrange: a scenario whose socialSecurity block sets the claim age but
    // omits `colaTracksInflation`. Default-on: buildSsRows must grow SS at the
    // scenario inflation rate (2.5 %), independent of any fixed colaPct.
    // Birth 1960 → claim 2027.
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
    // Arrange: opt out of inflation-tracking (`colaTracksInflation: false`)
    // and pin a fixed 4 % COLA that differs from the 2.5 % inflation rate, so
    // the SS run-rate grows at the fixed colaPct, not inflation.
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
    // General 3%; Medical defaults to general + 2pp (= 5%) via the resolver's
    // materialised default — no explicit categoryRates needed.
    const scenario = baseScenario('s', 'WithMedicalInflation', {
      inflation: { ratePct: 3 },
    });
    const med = recurring('med', 'cat-medical');
    const housing = recurring('housing', 'cat-housing');
    const { args, ctx } = buildCtx({ expenses: [med, housing], scenario });
    const series = buildCashflowSeries(args, ctx);

    // Compare against single-category runs to isolate each category's growth.
    const medCtx = buildCtx({ expenses: [med], scenario });
    const medOnly = buildCashflowSeries(medCtx.args, medCtx.ctx);
    const housingCtx = buildCtx({ expenses: [housing], scenario });
    const housingOnly = buildCashflowSeries(housingCtx.args, housingCtx.ctx);

    // At the first retirement month both are equal (factor ~1); by a later
    // year Medical (5%) outpaces Housing (3%). Pick a month ~10 years out.
    const idx = 12 * 10; // ~10 years into retirement
    expect(medOnly.expensesByMonth.values[idx]).toBeGreaterThan(
      housingOnly.expensesByMonth.values[idx],
    );
    // The combined band equals the sum of the two single-category bands
    // (per-month cent rounding leaves a sub-cent seam between the combined
    // run and the sum of two separately-rounded single-category runs).
    expect(series.expensesByMonth.values[idx]).toBeCloseTo(
      medOnly.expensesByMonth.values[idx] +
        housingOnly.expensesByMonth.values[idx],
      2,
    );
  });

  it('an explicit Medical override (= general) removes the spread', () => {
    // Force Medical to the general rate explicitly → it grows like housing.
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
    // The set carries ONLY the recreated id. A stale hard-coded cat-medical
    // path would green for the wrong reason; omitting cat-medical proves the
    // +2pp follows the threaded set.
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
    // The recreated id grew at +2pp (5%); the now-unflagged cat-medical grew
    // at the general rate (3%), so the recreated band is the larger one.
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
    // The flagged Dental grows faster (5%) than the unflagged Housing (3%).
    expect(dentalSeries.expensesByMonth.values[idx]).toBeGreaterThan(
      housingSeries.expensesByMonth.values[idx],
    );
  });
});

describe('buildPipelineContext — working-years Roth-conversion basis separation', () => {
  // Guard: the working-years converted principal must seed ONLY the
  // SEPARATE `preRetirementConversionBasisCentsByOwner` map. The
  // `rothBasisCentsByOwner` map (threaded into the MC tax context, which does
  // NOT model the conversion deposit legs) must stay byte-for-byte identical to
  // the no-conversion case — otherwise MC Roth withdrawals would be shielded
  // from tax the MC Roth balance never received (Monte Carlo is out of scope).
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

    // The MC-seeding map is byte-identical with and without conversions.
    expect([...withConv.rothBasisCentsByOwner.entries()]).toEqual(
      [...without.rothBasisCentsByOwner.entries()],
    );

    // The conversion basis lands in the SEPARATE map: 3 working years (2026,
    // 2027, 2028 — end is inclusive, retire=2032 so all three are working years)
    // × $20,000 = $60,000 = 6,000,000 cents for owner m1.
    expect(withConv.preRetirementConversionBasisCentsByOwner.get('m1')).toBe(
      6_000_000,
    );
    // Absent any conversion, the separate map is empty.
    expect(without.preRetirementConversionBasisCentsByOwner.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// HSA-qualified filter in buildMedicalDemandByMonth. Tests verify the
// deterministic cashflow builder applies the isHsaQualifiedMedical
// predicate correctly.
// ---------------------------------------------------------------------------
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

  // medicalDemandByMonth is in CENTS (integer, per `Math.round(monthly * 100)`
  // in buildMedicalDemandByMonth). Convert to dollars for comparisons.
  function sumDemandDollars(series: ReturnType<typeof buildCashflowSeries>): number {
    if (!series.medicalDemandByMonth) return 0;
    return series.medicalDemandByMonth.reduce((a, b) => a + b, 0) / 100;
  }

  it('a legacy/absent medical row produces zero HSA medical demand', () => {
    // A medical expense with no hsaQualified field is treated as not-qualified.
    const { args, ctx } = buildCtx({
      expenses: [medExp('e-legacy', 600)], // absent
      medicalCategoryIds: ['cat-medical'],
    });
    const series = buildCashflowSeries(args, ctx);
    expect(sumDemandDollars(series)).toBe(0);
    expect(series.medicalDemandByMonth?.every((v) => v === 0)).toBe(true);
  });

  it('only hsaQualified === true rows contribute to medical demand', () => {
    // One qualified ($500/mo) and one not-qualified ($800/mo) medical expense.
    // Only the qualified row should contribute to medicalDemandByMonth.
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
    // Mixed includes a non-qualified row but demand equals qual-only.
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
    // Non-medical category with hsaQualified=true must not appear in demand.
    const { args, ctx } = buildCtx({
      expenses: [medExp('e-housing', 2_000, true, 'cat-housing')],
      medicalCategoryIds: ['cat-medical'],
    });
    const series = buildCashflowSeries(args, ctx);
    expect(sumDemandDollars(series)).toBe(0);
  });

  it('qualified demand is always ≤ total expense (strict-subset invariant)', () => {
    // One qualified and one non-qualified medical expense.
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
