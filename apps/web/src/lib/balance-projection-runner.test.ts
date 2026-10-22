/** Tests for `runBalanceProjection` and `runBalanceProjectionMc`. */
import { describe, expect, it } from 'vitest';
import {
  runBalanceProjection,
  runBalanceProjectionMc,
  runBalanceProjectionForPage,
  CbpUnconfiguredError,
  computePlannedAtHorizonToday,
} from './balance-projection-runner';
import { realDeflatorAt } from './projection-context';
import { simulateDrawdown } from './drawdown-engine';
import { buildSsContext, projectSsByYear } from './ss-projection';
import { buildOptimizerMcScenarioSetup } from './balance-projection-runner-mc';
import { mergeSsOverride } from './claim-age-optimizer/merge-ss-override';
import { resolveScenario } from './scenario-resolution';
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
import type { MonteCarloInput } from './monte-carlo';

const TODAY = new Date('2026-06-15T00:00:00Z');

// Sums the per-month expense base over the first full retirement year (retirementYear + 1).
function sumWindowedRetirementYear(input: MonteCarloInput): number {
  const yearOffset = input.retirementYear - input.firstYear + 1;
  let sum = 0;
  for (let m = yearOffset * 12; m < (yearOffset + 1) * 12; m += 1) {
    sum += input.monthlyExpenseBase[m] ?? 0;
  }
  return sum;
}

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
  companyContributions = 0,
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
      companyContributions,
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
  parentScenarioId: string | null = null,
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
      parentScenarioId,
      isPrimary: parentScenarioId === null,
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
      },
    },
  };
}

describe('runBalanceProjection', () => {
  it('should_return_positive_at_horizon_balance_on_simple_fixture', () => {
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 2500)];
    const accounts = [brokerage('a1', 'm1')];
    const balances = [balanceRow('a1', 2025, 800_000)];
    const scenarios = [baseScenario('s', 'Base')];
    const result = runBalanceProjection({
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
    });
    expect(result.atHorizonTodayDollars).toBeGreaterThan(0);
    expect(result.retirementYear).toBe(1965 + 67);
    expect(result.horizonYear).toBe(1965 + 90);
  });

  it('should_apply_candidate_overlay_above_inherited_ss_override', () => {
    const members = [
      member('m1', true, 'Alex', 1965),
      member('m2', false, 'Sam', 1968),
    ];
    const ss = [ssBenefit('m1', 3000), ssBenefit('m2', 2500)];
    const accounts = [brokerage('a1', 'm1')];
    const balances = [balanceRow('a1', 2025, 800_000)];
    const parent = baseScenario('parent', 'Parent');
    const child = baseScenario('child', 'Child', 'parent');
    const expenses: Aggregate<ExpensePayload>[] = [
      {
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
      },
    ];
    const childWithOverride: ScenarioAggregate = {
      ...child,
      payload: {
        ...child.payload,
        overrides: {
          ...child.payload.overrides,
          socialSecurity: undefined,
        },
      },
    };
    const scenarios = [parent, childWithOverride];
    const at62 = runBalanceProjection({
      scenarioId: childWithOverride.id,
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses,
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
      candidateOverlay: {
        socialSecurity: {
          primary: { ageYears: 62, ageMonths: 0 },
          secondary: { ageYears: 62, ageMonths: 0 },
        },
      },
    });
    const at70 = runBalanceProjection({
      scenarioId: childWithOverride.id,
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses,
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
      candidateOverlay: {
        socialSecurity: {
          primary: { ageYears: 70, ageMonths: 0 },
          secondary: { ageYears: 70, ageMonths: 0 },
        },
      },
    });
    expect(at62.atHorizonTodayDollars).not.toBe(at70.atHorizonTodayDollars);
  });

  it('an overlay without a survivor field preserves a PARENT-inherited survivor map across all three surfaces', () => {
    // A child inheriting its survivor claim-age map must keep it under an overlay with no survivor field; seeding the
    // overlay from the child's empty local override would shadow the parent's map on the deterministic path only.
    const members = [
      member('m1', true, 'Alex', 1965),
      member('m2', false, 'Sam', 1955),
    ];
    const ss = [ssBenefit('m1', 3000), ssBenefit('m2', 500)];
    const accounts = [brokerage('a1', 'm1')];
    const balances = [balanceRow('a1', 2025, 800_000)];
    const expenses: Aggregate<ExpensePayload>[] = [
      {
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
      },
    ];
    // Primary dies first (life 75 vs 95), so the secondary is the prospective survivor.
    const parentBase = baseScenario('parent', 'Parent');
    const parent: ScenarioAggregate = {
      ...parentBase,
      payload: {
        ...parentBase.payload,
        overrides: {
          ...parentBase.payload.overrides,
          lifeExpectancy: { primary: 75, secondary: 95 },
          socialSecurity: {
            primary: { ageYears: 67, ageMonths: 0 },
            secondary: { ageYears: 67, ageMonths: 0 },
            survivor: { secondary: { ageYears: 66, ageMonths: 0 } },
          },
        },
      },
    };
    const childBase = baseScenario('child', 'Child', 'parent');
    const child: ScenarioAggregate = {
      ...childBase,
      payload: { ...childBase.payload, overrides: {} },
    };
    const scenarios = [parent, child];
    const argsFor = (list: ScenarioAggregate[]) => ({
      scenarioId: 'child',
      scenarios: list,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses,
      incomeStreams: [] as Aggregate<IncomeStreamPayload>[],
      todayYear: TODAY.getUTCFullYear(),
      todayMonthIndex: TODAY.getUTCMonth(),
    });
    const ownAges = {
      primary: { ageYears: 67, ageMonths: 0 },
      secondary: { ageYears: 67, ageMonths: 0 },
    };

    // Sensitivity control: the survivor benefit is material in this fixture.
    const parentNoSurvivor: ScenarioAggregate = {
      ...parent,
      payload: {
        ...parent.payload,
        overrides: {
          ...parent.payload.overrides,
          socialSecurity: {
            primary: { ageYears: 67, ageMonths: 0 },
            secondary: { ageYears: 67, ageMonths: 0 },
          },
        },
      },
    };
    const base = runBalanceProjection(argsFor(scenarios));
    const withheld = runBalanceProjection(argsFor([parentNoSurvivor, child]));
    expect(base.atHorizonTodayDollars).not.toBe(withheld.atHorizonTodayDollars);

    // 1) Deterministic: a no-survivor overlay equals the plain and the explicit-survivor projections.
    const overlaid = runBalanceProjection({
      ...argsFor(scenarios),
      candidateOverlay: { socialSecurity: ownAges },
    });
    const overlaidExplicit = runBalanceProjection({
      ...argsFor(scenarios),
      candidateOverlay: {
        socialSecurity: {
          ...ownAges,
          survivor: { secondary: { ageYears: 66, ageMonths: 0 } },
        },
      },
    });
    expect(overlaid.atHorizonTodayDollars).toBeCloseTo(
      base.atHorizonTodayDollars,
      6,
    );
    expect(overlaid.atHorizonTodayDollars).toBeCloseTo(
      overlaidExplicit.atHorizonTodayDollars,
      6,
    );

    // 2) MC: the survivor-less candidate's ssByYear equals the explicit one and reflects the benefit.
    const setup = buildOptimizerMcScenarioSetup(argsFor(scenarios));
    const stored = setup.mcInputForCandidate({ socialSecurity: ownAges });
    const explicit = setup.mcInputForCandidate({
      socialSecurity: {
        ...ownAges,
        survivor: { secondary: { ageYears: 66, ageMonths: 0 } },
      },
    });
    expect(stored.ssByYear).toEqual(explicit.ssByYear);
    const setupNoSurvivor = buildOptimizerMcScenarioSetup(
      argsFor([parentNoSurvivor, child]),
    );
    expect(stored.ssByYear).not.toEqual(
      setupNoSurvivor.mcInputForCandidate({ socialSecurity: ownAges }).ssByYear,
    );

    // 3) Post-Apply: the merged winner projects the plan the ranking simulated.
    const merged = mergeSsOverride({
      currentResolvedOverride: resolveScenario('child', scenarios).socialSecurity,
      optimalPair: { primaryAgeYears: 67, secondaryAgeYears: null },
      hasSecondary: true,
      secondaryPastWindow: true,
    });
    expect(merged.survivor).toEqual({ secondary: { ageYears: 66, ageMonths: 0 } });
    const appliedChild: ScenarioAggregate = {
      ...child,
      payload: {
        ...child.payload,
        overrides: { ...child.payload.overrides, socialSecurity: merged },
      },
    };
    const applied = runBalanceProjection(argsFor([parent, appliedChild]));
    expect(applied.atHorizonTodayDollars).toBeCloseTo(
      overlaid.atHorizonTodayDollars,
      6,
    );
  });

  it('should_surface_cbp_unconfigured_on_result_without_throwing', () => {
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 2500)];
    const cbp = brokerage('cbp1', 'm1', 'RETIREMENT_CASH_BALANCE', 'PRE_TAX');
    const balances = [balanceRow('cbp1', 2025, 100_000)];
    const scenarios = [baseScenario('s', 'Base')];
    const result = runBalanceProjection({
      scenarioId: 's',
      scenarios,
      accounts: [cbp],
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(),
      todayMonthIndex: TODAY.getUTCMonth(),
    });
    expect(result.cbpResolution?.ok).toBe(false);
    expect(result.atHorizonTodayDollars).toBe(0);
    expect(result.todayYear).toBe(TODAY.getUTCFullYear());
    expect(result.todayMonthIndex).toBe(TODAY.getUTCMonth());
  });

  it('should_treat_a_resolved_magiCap_disable_sentinel_as_no_cap (no throw, no breach)', () => {
    // The disable sentinel is coerced to no cap, so a missing secondary birthdate never reaches the anchor resolver.
    const primaryMember = member('m1', true, 'Alex', 1965);
    const secondaryNoBirthdate: Aggregate<HouseholdMemberPayload> = {
      id: 'm2',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'householdMember',
      payload: {
        isPrimary: false,
        firstName: 'Sam',
        lastName: 'Doe',
        email: 'm2@example.test',
        birthdate: '',
      },
    };
    const scenarioWithSentinel: ScenarioAggregate = {
      ...baseScenario('s', 'Base'),
      payload: {
        ...baseScenario('s', 'Base').payload,
        overrides: {
          ...baseScenario('s', 'Base').payload.overrides,
          withdrawalStrategy: { kind: 'taxEfficient' },
          magiCap: { disabled: true },
        },
      },
    };
    const ss = [ssBenefit('m1', 2500)];
    const accounts = [brokerage('a1', 'm1')];
    const balances = [balanceRow('a1', 2025, 800_000)];
    const result = runBalanceProjection({
      scenarioId: 's',
      scenarios: [scenarioWithSentinel],
      accounts,
      balances,
      members: [primaryMember, secondaryNoBirthdate],
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(),
      todayMonthIndex: TODAY.getUTCMonth(),
    });
    const anyBreach = result.drawdownYears.some(
      (y) => (y.magiCapBreachDollars ?? 0) > 0,
    );
    expect(anyBreach).toBe(false);
  });

  it('should_NOT_throw_or_log_PII_when_a_window_anchor_birthdate_is_malformed', () => {
    // No PII in logs (CODING_STANDARDS): an unresolvable anchor flags the window inactive without logging the birthdate.
    const malformedBirthdate = 'NOT-A-DATE';
    const primaryMember = member('m1', true, 'Alex', 1965);
    const secondaryMalformed: Aggregate<HouseholdMemberPayload> = {
      id: 'm2',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'householdMember',
      payload: {
        isPrimary: false,
        firstName: 'Sam',
        lastName: 'Doe',
        email: 'm2@example.test',
        birthdate: malformedBirthdate,
      },
    };
    const scenarioWithMagiCap: ScenarioAggregate = {
      ...baseScenario('s', 'Base'),
      payload: {
        ...baseScenario('s', 'Base').payload,
        overrides: {
          ...baseScenario('s', 'Base').payload.overrides,
          withdrawalStrategy: { kind: 'taxEfficient' },
          magiCap: {
            windows: [
              {
                start: { kind: 'retirementStart' },
                end: { kind: 'age', memberId: 'secondary', years: 65, months: 0 },
                magiCeilingAnnualDollars: 15_000,
                capMode: 'minimize',
                capMagiLine: 'irmaa',
              },
            ],
          },
        },
      },
    };
    const ss = [ssBenefit('m1', 2500)];
    const accounts = [brokerage('a1', 'm1')];
    const balances = [balanceRow('a1', 2025, 800_000)];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let result: ReturnType<typeof runBalanceProjection> | null = null;
    expect(() => {
      result = runBalanceProjection({
        scenarioId: 's',
        scenarios: [scenarioWithMagiCap],
        accounts,
        balances,
        members: [primaryMember, secondaryMalformed],
        ssBenefits: ss,
        expenses: [],
        incomeStreams: [],
        todayYear: TODAY.getUTCFullYear(),
        todayMonthIndex: TODAY.getUTCMonth(),
      });
    }).not.toThrow();
    expect(result).not.toBeNull();
    for (const spy of [warnSpy, errorSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(malformedBirthdate);
      }
    }
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('should_produce_higher_metric_with_larger_portfolio_seed', () => {
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 1)]; // minimal SS so nothing else moves.
    const scenarios = [baseScenario('s', 'Base')];
    const accountsSmall = [brokerage('a1', 'm1')];
    const accountsLarge = [brokerage('a1', 'm1')];
    const balancesSmall = [balanceRow('a1', 2025, 500_000)];
    const balancesLarge = [balanceRow('a1', 2025, 1_000_000)];
    const small = runBalanceProjection({
      scenarioId: 's',
      scenarios,
      accounts: accountsSmall,
      balances: balancesSmall,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
    });
    const large = runBalanceProjection({
      scenarioId: 's',
      scenarios,
      accounts: accountsLarge,
      balances: balancesLarge,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
    });
    expect(large.atHorizonTodayDollars).toBeGreaterThan(
      small.atHorizonTodayDollars,
    );
  });

  it('should_return_different_at_horizon_for_method_planned_vs_twr_when_twr_available', () => {
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 2500)];
    const accounts = [brokerage('a1', 'm1', 'BROKERAGE', 'POST_TAX', 2)];
    const balances = [
      balanceRow('a1', 2024, 600_000),
      balanceRow('a1', 2025, 800_000),
    ];
    const scenarios = [baseScenario('s', 'Base')];
    const planned = runBalanceProjection({
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
      method: 'planned',
    });
    const twr = runBalanceProjection({
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
      method: 'twr',
    });
    expect(planned.methodAvailable).toBe(true);
    expect(twr.methodAvailable).toBe(true);
    expect(planned.atHorizonTodayDollars).not.toBe(twr.atHorizonTodayDollars);
  });

  it('should_short_circuit_when_method_twr_and_active_non_cbp_account_has_zero_balances', () => {
    // With no balance rows the TWR gate must still mark the result unavailable.
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 2500)];
    const accounts = [brokerage('a-empty', 'm1')];
    const balances: never[] = [];
    const scenarios = [baseScenario('s', 'Base')];
    const result = runBalanceProjection({
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
      method: 'twr',
    });
    expect(result.methodAvailable).toBe(false);
    expect(result.atHorizonTodayDollars).toBe(0);
  });
});

describe('runBalanceProjectionMc', () => {
  it('should_assemble_MonteCarloInput_with_expected_anchors', () => {
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 2500)];
    const accounts = [brokerage('a1', 'm1')];
    const balances = [balanceRow('a1', 2025, 800_000)];
    const scenarios = [baseScenario('s', 'Base')];
    const input = runBalanceProjectionMc({
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
    });
    expect(input.firstYear).toBe(2026);
    expect(input.retirementYear).toBe(1965 + 67);
    expect(input.horizonYear).toBe(1965 + 90);
    expect(input.portfolioToday).toBe(800_000);
    expect(input.pathCount).toBeGreaterThan(0);
    expect(input.seed).toBe(1);
  });

  it('should_throw_cbp_unconfigured_when_validation_fails', () => {
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 2500)];
    const cbp = brokerage('cbp1', 'm1', 'RETIREMENT_CASH_BALANCE', 'PRE_TAX');
    const balances = [balanceRow('cbp1', 2025, 100_000)];
    const scenarios = [baseScenario('s', 'Base')];
    expect(() =>
      runBalanceProjectionMc({
        scenarioId: 's',
        scenarios,
        accounts: [cbp],
        balances,
        members,
        ssBenefits: ss,
        expenses: [],
        incomeStreams: [],
        todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
      }),
    ).toThrowError(CbpUnconfiguredError);
  });

  it('should_use_ss_cola_override_in_ssByYear_growth_rate', () => {
    // Birth 1960, claim at 67 → claim year 2027.
    const members = [member('m1', true, 'Alex', 1960)];
    const ss = [ssBenefit('m1', 2000)];
    const accounts = [brokerage('a1', 'm1')];
    const balances = [balanceRow('a1', 2025, 500_000)];
    const baseNoGrowth: ScenarioAggregate = {
      ...baseScenario('s0', 'NoGrowth'),
      payload: {
        ...baseScenario('s0', 'NoGrowth').payload,
        overrides: {
          ...baseScenario('s0', 'NoGrowth').payload.overrides,
          socialSecurity: {
            primary: { ageYears: 67, ageMonths: 0 },
            colaPct: 0,
            // Opt out of inflation tracking so the fixed COLA is the rate under test.
            colaTracksInflation: false,
          },
        },
      },
    };
    const base3Pct: ScenarioAggregate = {
      ...baseScenario('s3', '3pct'),
      payload: {
        ...baseScenario('s3', '3pct').payload,
        overrides: {
          ...baseScenario('s3', '3pct').payload.overrides,
          socialSecurity: {
            primary: { ageYears: 67, ageMonths: 0 },
            colaPct: 3,
            colaTracksInflation: false,
          },
        },
      },
    };
    const mcNoGrowth = runBalanceProjectionMc({
      scenarioId: 's0',
      scenarios: [baseNoGrowth],
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
    });
    const mc3Pct = runBalanceProjectionMc({
      scenarioId: 's3',
      scenarios: [base3Pct],
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
    });
    // The claim-year row is prorated, so compare two full post-claim years to read the COLA rate.
    const claimIdx = mcNoGrowth.ssByYear.findIndex((v) => v > 0);
    expect(claimIdx).toBeGreaterThanOrEqual(0);
    const flatFull = mcNoGrowth.ssByYear[claimIdx + 1];
    const flatNext = mcNoGrowth.ssByYear[claimIdx + 2];
    expect(flatNext).toBeCloseTo(flatFull, 0);
    const growFull = mc3Pct.ssByYear[claimIdx + 1];
    const growNext = mc3Pct.ssByYear[claimIdx + 2];
    expect(growNext).toBeCloseTo(growFull * 1.03, 0);
    // The last slot is the death-boundary year (0 for both: 1960-01-01 counts as the 1959 cohort), so use the last non-zero slot.
    const lastNonZeroNoGrowth = [...mcNoGrowth.ssByYear].reverse().find((v) => v > 0) ?? 0;
    const lastNonZero3Pct = [...mc3Pct.ssByYear].reverse().find((v) => v > 0) ?? 0;
    expect(lastNonZero3Pct).toBeGreaterThan(lastNonZeroNoGrowth);
  });

  it('should_include_pension_monthlyBenefit_in_incomeByYear', () => {
    // Pension starts at 65 (2025) paying $3,000 a month: incomeByYear[0] (2026) carries $36,000.
    const members = [member('m1', true, 'Alex', 1960)];
    const ss = [ssBenefit('m1', null)];
    const accounts = [brokerage('a1', 'm1')];
    const balances = [balanceRow('a1', 2025, 500_000)];
    const scenarios = [baseScenario('s', 'Base')];
    const pensionStream: Aggregate<IncomeStreamPayload> = {
      id: 'inc-pension',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'incomeStream',
      payload: {
        name: 'Pension',
        kind: 'pension',
        memberId: 'm1',
        payoutType: 'annuity',
        monthlyBenefit: 3_000,
        colaPct: 0,
        start: { kind: 'age', years: 65, months: 0 },
      } as IncomeStreamPayload,
    };
    const withPension = runBalanceProjectionMc({
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [pensionStream],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
    });
    const baseline = runBalanceProjectionMc({
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
    });
    const totalPension = withPension.incomeByYear.reduce((a, b) => a + b, 0);
    expect(totalPension).toBeGreaterThan(0);
    const totalBaseline = baseline.incomeByYear.reduce((a, b) => a + b, 0);
    expect(totalBaseline).toBe(0);
    const activeYear = withPension.incomeByYear.find((v) => v > 0);
    expect(activeYear).toBeCloseTo(36_000, -2); // within $100
  });

  it('should_bound_incomeByYear_to_partTime_start_end_window', () => {
    // Part-time $50,000 a year from 2028 to 2030.
    const members = [member('m1', true, 'Alex', 1960)];
    const ss = [ssBenefit('m1', null)];
    const accounts = [brokerage('a1', 'm1')];
    const balances = [balanceRow('a1', 2025, 500_000)];
    const scenarios = [baseScenario('s', 'Base')];
    const partTimeStream: Aggregate<IncomeStreamPayload> = {
      id: 'inc-pt',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'incomeStream',
      payload: {
        name: 'Part-time',
        kind: 'partTime',
        memberId: 'm1',
        annualAmount: 50_000,
        colaPct: 0,
        start: { kind: 'year', year: 2028 },
        end: { kind: 'year', year: 2030 },
      } as IncomeStreamPayload,
    };
    const mc = runBalanceProjectionMc({
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [partTimeStream],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
    });
    const offset = (yr: number) => yr - mc.firstYear;
    expect(mc.incomeByYear[offset(2026)]).toBe(0);
    expect(mc.incomeByYear[offset(2027)]).toBe(0);
    expect(mc.incomeByYear[offset(2028)]).toBeGreaterThan(0);
    expect(mc.incomeByYear[offset(2029)]).toBeGreaterThan(0);
    expect(mc.incomeByYear[offset(2030)]).toBeGreaterThan(0);
    if (mc.incomeByYear.length > offset(2031)) {
      expect(mc.incomeByYear[offset(2031)]).toBe(0);
    }
  });

  it('should_apply_candidate_ss_actuarial_math_so_inputs_differ_per_claim_age', () => {
    // ssByYear must vary with the claim age (70 > 67 > 62), or the optimizer ranks every pair identically.
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 3000)];
    const accounts = [brokerage('a1', 'm1')];
    const balances = [balanceRow('a1', 2025, 800_000)];
    const scenarios = [baseScenario('s', 'Base')];
    const at62 = runBalanceProjectionMc({
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
      candidateOverlay: {
        socialSecurity: { primary: { ageYears: 62, ageMonths: 0 } },
      },
    });
    const at67 = runBalanceProjectionMc({
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
      candidateOverlay: {
        socialSecurity: { primary: { ageYears: 67, ageMonths: 0 } },
      },
    });
    const at70 = runBalanceProjectionMc({
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
      candidateOverlay: {
        socialSecurity: { primary: { ageYears: 70, ageMonths: 0 } },
      },
    });
    const firstNonZero = (arr: number[]): number =>
      arr.find((v) => v > 0) ?? 0;
    expect(firstNonZero(at62.ssByYear)).toBeLessThan(
      firstNonZero(at67.ssByYear),
    );
    expect(firstNonZero(at67.ssByYear)).toBeLessThan(
      firstNonZero(at70.ssByYear),
    );
    const firstNonZeroIdx = (arr: number[]): number =>
      arr.findIndex((v) => v > 0);
    expect(firstNonZeroIdx(at62.ssByYear)).toBeLessThan(
      firstNonZeroIdx(at70.ssByYear),
    );
  });

  it('should_pin_seed_so_repeat_calls_produce_identical_inputs', () => {
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 2500)];
    const accounts = [brokerage('a1', 'm1')];
    const balances = [balanceRow('a1', 2025, 800_000)];
    const scenarios = [baseScenario('s', 'Base')];
    const a = runBalanceProjectionMc({
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
    });
    const b = runBalanceProjectionMc({
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
    });
    expect(a.seed).toBe(b.seed);
    expect(a.portfolioToday).toBe(b.portfolioToday);
    expect(a.ssByYear).toEqual(b.ssByYear);
  });

  it('clamp: stored bumpPct 200 uses effective multiplier ×2.0 not ×3.0', () => {
    // bumpPct 200 is out of range and clamps to 100, so annualExpense = disc * 2.
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 0)];
    const accounts = [brokerage('a1', 'm1')];
    const balances = [balanceRow('a1', 2025, 500_000)];
    const scenarioWithBump: ScenarioAggregate = {
      ...baseScenario('s', 'Base'),
      payload: {
        ...baseScenario('s', 'Base').payload,
        overrides: {
          ...baseScenario('s', 'Base').payload.overrides,
          discretionarySpending: { bumpPct: 200, durationYears: null },
        },
      },
    };
    const discExpense: Aggregate<ExpensePayload> = {
      id: 'disc1',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'expense',
      payload: {
        name: 'Travel',
        categoryId: 'cat-travel',
        amount: 10_000,
        frequency: 'yearly',
        classification: 'discretionary',
        start: { kind: 'retirementStart' },
        end: { kind: 'lifetime', whose: 'last' },
      },
    };
    const input = runBalanceProjectionMc({
      scenarioId: 's',
      scenarios: [scenarioWithBump],
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [discExpense],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
    });
    // Multiplier 2.0 on the clamped 100%: a full retirement year of the windowed base sums to about 20_000 (not 30_000).
    expect(sumWindowedRetirementYear(input)).toBeCloseTo(20_000, 1);
  });

  it('clamp: stored bumpPct -150 uses effective multiplier ×0.0 (floor)', () => {
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 0)];
    const accounts = [brokerage('a1', 'm1')];
    const balances = [balanceRow('a1', 2025, 500_000)];
    const scenarioWithNegBump: ScenarioAggregate = {
      ...baseScenario('s', 'Base'),
      payload: {
        ...baseScenario('s', 'Base').payload,
        overrides: {
          ...baseScenario('s', 'Base').payload.overrides,
          discretionarySpending: { bumpPct: -150, durationYears: null },
        },
      },
    };
    const discExpense: Aggregate<ExpensePayload> = {
      id: 'disc2',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'expense',
      payload: {
        name: 'Travel',
        categoryId: 'cat-travel',
        amount: 10_000,
        frequency: 'yearly',
        classification: 'discretionary',
        start: { kind: 'retirementStart' },
        end: { kind: 'lifetime', whose: 'last' },
      },
    };
    const input = runBalanceProjectionMc({
      scenarioId: 's',
      scenarios: [scenarioWithNegBump],
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [discExpense],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
    });
    // bumpPct -150 clamps to -100 (multiplier 0.0): the windowed base is 0, not -5_000.
    expect(sumWindowedRetirementYear(input)).toBe(0);
  });

  it('MC ssByYear first non-zero year matches deterministic projectSsByYear for mid-year birthdate + sub-year claimAge', () => {
    // Born 1985-07-01 claiming at 67y 6m lands in 2053; month arithmetic must not drift from ss-projection's whole-year rule.
    const memberWithMidYearBirth: Aggregate<HouseholdMemberPayload> = {
      id: 'm1',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'householdMember',
      payload: {
        isPrimary: true,
        firstName: 'Alex',
        lastName: 'Doe',
        email: 'm1@example.test',
        birthdate: '1985-07-01',
      },
    };
    const claimAge = { ageYears: 67, ageMonths: 6 };
    const pia = 2_500;
    const ss = [ssBenefit('m1', pia)];
    const accounts = [brokerage('a1', 'm1')];
    const balances = [balanceRow('a1', 2025, 500_000)];
    const scenarios = [baseScenario('s', 'Base')];

    const mc = runBalanceProjectionMc({
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members: [memberWithMidYearBirth],
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(),
      todayMonthIndex: TODAY.getUTCMonth(),
      candidateOverlay: {
        socialSecurity: { primary: claimAge },
      },
    });

    const ssCtx = buildSsContext(
      [memberWithMidYearBirth],
      ss,
      {
        claimAgePrimary: claimAge,
        lifeExpectancyPrimary: 95,
        colaPct: 2,
        benefitReductionPct: 0,
      },
    );
    expect(ssCtx).not.toBeNull();
    const todayYear = TODAY.getUTCFullYear();
    const horizonYear = todayYear + mc.ssByYear.length - 1;
    const detRows = projectSsByYear(ssCtx!, { from: todayYear, to: horizonYear });

    const mcFirstNonZeroYear = mc.ssByYear.findIndex((v) => v > 0) + todayYear;
    const detFirstNonZeroYear = detRows.findIndex((r) => r.total > 0) + todayYear;

    expect(mcFirstNonZeroYear).toBe(detFirstNonZeroYear);
  });

  it('should_include_secondary_ss_when_scenario_omits_secondary_override', () => {
    // A scenario setting only socialSecurity.primary must still sum the secondary's SS at their resolved claim age.
    const primaryMember = member('m-pri', true, 'Alex', 1965);
    const secondaryMember = member('m-sec', false, 'Sam', 1967);
    const primaryPia = 2_000;
    const secondaryPia = 1_200;
    const ss = [ssBenefit('m-pri', primaryPia), ssBenefit('m-sec', secondaryPia)];
    const accounts = [brokerage('a1', 'm-pri')];
    const balances = [balanceRow('a1', 2025, 500_000)];

    const scenarioPrimaryOnly: ScenarioAggregate = {
      ...baseScenario('s-pri-only', 'PrimaryOnlySS'),
      payload: {
        ...baseScenario('s-pri-only', 'PrimaryOnlySS').payload,
        overrides: {
          ...baseScenario('s-pri-only', 'PrimaryOnlySS').payload.overrides,
          socialSecurity: { primary: { ageYears: 67, ageMonths: 0 } },
        },
      },
    };

    const mc = runBalanceProjectionMc({
      scenarioId: 's-pri-only',
      scenarios: [scenarioPrimaryOnly],
      accounts,
      balances,
      members: [primaryMember, secondaryMember],
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(),
      todayMonthIndex: TODAY.getUTCMonth(),
    });

    // Both claim at 67 (secondary two years after primary), so once both draw the combined value exceeds primary PIA * 12.
    const primaryOnlyAnnual = primaryPia * 12; // annual, before COLA
    const maxYearly = Math.max(...mc.ssByYear);
    expect(maxYearly).toBeGreaterThan(primaryOnlyAnnual);
  });
});

// Golden parity with BPP's at-horizon stat card (last-year balance deflated to today's dollars), within $1.
describe('runBalanceProjection — BPP-equivalence parity', () => {
  it('should_match_simulateDrawdown_oracle_on_no_accumulation_no_cashflow_fixture', () => {
    // No accumulation phase (retirement today, 800k seeded, no expenses, SS or income): the at-horizon value must equal
    // simulateDrawdown run by hand with the same inputs, deflated by realDeflatorAt.
    const todayYear = TODAY.getUTCFullYear();
    const birthYear = todayYear - 67;
    const members = [member('m1', true, 'Alex', birthYear)];
    const ss = [ssBenefit('m1', 0)];
    const accounts = [brokerage('a1', 'm1', 'BROKERAGE', 'POST_TAX', 5, 0, 0)];
    const balances = [balanceRow('a1', todayYear - 1, 800_000)];
    const scenarios = [baseScenario('s', 'Base')];
    const result = runBalanceProjection({
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
    });
    expect(result.atHorizonTodayDollars).toBeGreaterThan(0);
    expect(result.retirementYear).toBe(todayYear);
    const retirementYear = result.retirementYear;
    const horizonYear = result.horizonYear;
    const length = (horizonYear - retirementYear + 1) * 12;
    const zeroSeries = {
      startYear: retirementYear,
      startMonthIndex: 0,
      values: new Float64Array(length),
    };
    const oracle = simulateDrawdown({
      portfolioAtRetirement: 800_000,
      ratePct: 5,
      expensesByMonth: zeroSeries,
      incomeByMonth: zeroSeries,
      depositsByMonth: zeroSeries,
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'taxEfficient' },
      accounts: [
        {
          id: 'a1',
          initialPre: 0,
          initialPost: 800_000,
          annualRatePct: 5,
          depositsByMonth: zeroSeries,
          taxTreatment: 'POST_TAX',
          accountType: 'BROKERAGE',
        },
      ],
    });
    expect(oracle.years.length).toBe(horizonYear - retirementYear + 1);
    const lastNominal = oracle.years[oracle.years.length - 1].balance;
    const deflator = realDeflatorAt(result.ctx, horizonYear, 11);
    const oracleAtHorizonToday = lastNominal * deflator;
    expect(
      Math.abs(oracleAtHorizonToday - result.atHorizonTodayDollars),
    ).toBeLessThan(1);
    const viaHelper = computePlannedAtHorizonToday({
      drawdownPlannedYears: oracle.years,
      horizonYear,
      projCtx: result.ctx,
    });
    expect(Math.abs(viaHelper - result.atHorizonTodayDollars)).toBeLessThan(1);
  });

  it('should_route_pre_primary_targeted_deposit_into_account_balance', () => {
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 2500)];
    const accounts = [brokerage('a1', 'm1')];
    const balances = [balanceRow('a1', 2025, 500_000)];
    const scenarios = [baseScenario('s', 'Base')];
    const targetedIncome: Aggregate<IncomeStreamPayload>[] = [
      {
        id: 'inc1',
        householdId: 'h',
        schemaVersion: 1,
        version: 1,
        updatedAt: '2026-05-01T00:00:00Z',
        deviceId: 'd',
        aggregateType: 'incomeStream',
        payload: {
          name: 'One-off deposit',
          kind: 'oneOff',
          memberId: 'm1',
          oneOffAmount: 25_000,
          start: { kind: 'year', year: 2028 },
          targetAccountId: 'a1',
        } as IncomeStreamPayload,
      },
    ];
    const withTargeted = runBalanceProjection({
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: targetedIncome,
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
    });
    const baseline = runBalanceProjection({
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
    });
    expect(withTargeted.atHorizonTodayDollars).toBeGreaterThan(0);
    expect(baseline.atHorizonTodayDollars).toBeGreaterThan(0);
    expect(withTargeted.atHorizonTodayDollars).not.toBe(
      baseline.atHorizonTodayDollars,
    );
  });

  it('should_synthesize_post_primary_contributions_for_later_retiring_owner', () => {
    const members = [
      member('m1', true, 'Alex', 1965),
      member('m2', false, 'Sam', 1968),
    ];
    const ss = [ssBenefit('m1', 2500), ssBenefit('m2', 2000)];
    const accounts = [
      brokerage('a1', 'm1'),
      brokerage('a2', 'm2', 'BROKERAGE', 'POST_TAX', 5, 0, 6_000),
    ];
    const balances = [
      balanceRow('a1', 2025, 500_000),
      balanceRow('a2', 2025, 300_000),
    ];
    const scenarios = [
      {
        ...baseScenario('s', 'Base'),
        payload: {
          ...baseScenario('s', 'Base').payload,
          overrides: {
            ...baseScenario('s', 'Base').payload.overrides,
            retirementAge: {
              primary: { ageYears: 67, ageMonths: 0 },
              secondary: { ageYears: 70, ageMonths: 0 },
            },
          },
        },
      },
    ];
    const withContrib = runBalanceProjection({
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
    });
    const accountsNoContrib = [
      brokerage('a1', 'm1'),
      brokerage('a2', 'm2', 'BROKERAGE', 'POST_TAX', 5, 0, 0),
    ];
    const baseline = runBalanceProjection({
      scenarioId: 's',
      scenarios,
      accounts: accountsNoContrib,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
    });
    expect(withContrib.atHorizonTodayDollars).toBeGreaterThan(0);
    expect(withContrib.atHorizonTodayDollars).not.toBe(
      baseline.atHorizonTodayDollars,
    );
  });

  it('should_apply_retirement_allocation_override_so_bucket_path_differs_from_baseline', () => {
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 2500)];
    const accounts = [brokerage('a1', 'm1')];
    const balances = [balanceRow('a1', 2025, 800_000)];
    const baseS = baseScenario('s', 'Base');
    const withBuckets: ScenarioAggregate = {
      ...baseS,
      payload: {
        ...baseS.payload,
        overrides: {
          ...baseS.payload.overrides,
          retirementAllocation: {
            growthRatePct: 9,
            incomeRatePct: 2,
            startGrowthPct: 80,
            endGrowthPct: 30,
            endYear: 1965 + 80,
            glideStartYear: 1965 + 70,
            incomeOnlyYear: null,
          },
        },
      },
    };
    const baseline = runBalanceProjection({
      scenarioId: 's',
      scenarios: [baseS],
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
    });
    const buckets = runBalanceProjection({
      scenarioId: 's',
      scenarios: [withBuckets],
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
    });
    expect(baseline.atHorizonTodayDollars).toBeGreaterThan(0);
    expect(buckets.atHorizonTodayDollars).toBeGreaterThan(0);
    expect(buckets.atHorizonTodayDollars).not.toBe(
      baseline.atHorizonTodayDollars,
    );
  });

  it('should_shorten_drawdown_when_horizon_year_decreases', () => {
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 3000)];
    const accounts = [brokerage('a1', 'm1', 'BROKERAGE', 'POST_TAX', 5, 0, 0)];
    const balances = [balanceRow('a1', 2025, 800_000)];
    const expenses: Aggregate<ExpensePayload>[] = [
      {
        id: 'e1',
        householdId: 'h',
        schemaVersion: 1,
        version: 1,
        updatedAt: '2026-05-01T00:00:00Z',
        deviceId: 'd',
        aggregateType: 'expense',
        payload: {
          name: 'Living',
          categoryId: 'cat',
          amount: 60_000,
          frequency: 'yearly',
          classification: 'essential',
          start: { kind: 'retirementStart' },
          end: { kind: 'lifetime', whose: 'last' },
        },
      },
    ];
    const baseS = baseScenario('s', 'Base');
    const shortLife: ScenarioAggregate = {
      ...baseS,
      payload: {
        ...baseS.payload,
        overrides: {
          ...baseS.payload.overrides,
          lifeExpectancy: { primary: 80, secondary: 80 },
        },
      },
    };
    const longLife: ScenarioAggregate = {
      ...baseS,
      payload: {
        ...baseS.payload,
        overrides: {
          ...baseS.payload.overrides,
          lifeExpectancy: { primary: 95, secondary: 95 },
        },
      },
    };
    const shortRun = runBalanceProjection({
      scenarioId: 's',
      scenarios: [shortLife],
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses,
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
    });
    const longRun = runBalanceProjection({
      scenarioId: 's',
      scenarios: [longLife],
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses,
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(), todayMonthIndex: TODAY.getUTCMonth(),
    });
    expect(shortRun.horizonYear).toBe(1965 + 80);
    expect(longRun.horizonYear).toBe(1965 + 95);
    // Direction depends on whether SS and income offset the expense, so assert inequality only.
    expect(shortRun.atHorizonTodayDollars).not.toBe(
      longRun.atHorizonTodayDollars,
    );
    expect(shortRun.atHorizonTodayDollars).toBeGreaterThan(0);
    expect(longRun.atHorizonTodayDollars).toBeGreaterThan(0);
  });
});

// The linked source CBP leaves the ledger and its lump sum reaches the target once; staying in the ledger or the
// household-aggregate series would triple-count the dollars.
describe('runBalanceProjection — post-primary CBP lump-sum transfer semantics', () => {
  it('should_NOT_double_count_post_primary_cbp_lump_sum_against_target_pre_baked_equivalent', () => {
    // The baseline pre-bakes the CBP balance at the event into the target; the transfer scenario moves it through a linked
    // CBP at the event month.
    const todayYear = TODAY.getUTCFullYear();
    const birthYear = todayYear - 67;
    const members = [member('m1', true, 'Alex', birthYear)];
    const ss = [ssBenefit('m1', 0)]; // SS off — drawdown only.
    const scenarios = [baseScenario('s', 'Base')];
    // Same 5% on both accounts, so the transfer collapses to the baseline by construction (modulo intra-month timing).
    const brokerageBaseline = brokerage('target', 'm1', 'BROKERAGE', 'POST_TAX', 5, 0, 0);
    const brokerageTransfer = brokerage('target', 'm1', 'BROKERAGE', 'POST_TAX', 5, 0, 0);
    const cbpRate = 5;
    const cbpToday = 100_000;
    // CBP balance at the event: monthly compounding for 12 months at the CBP's planning rate.
    const monthlyRate = Math.pow(1 + cbpRate / 100, 1 / 12) - 1;
    const cbpAtEvent = cbpToday * Math.pow(1 + monthlyRate, 12);

    const baselineBalances = [
      balanceRow('target', todayYear - 1, 800_000 + cbpAtEvent),
    ];
    const baseline = runBalanceProjection({
      scenarioId: 's',
      scenarios,
      accounts: [brokerageBaseline],
      balances: baselineBalances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(),
      todayMonthIndex: TODAY.getUTCMonth(),
    });

    const cbp: Aggregate<AccountPayload> = {
      id: 'cbp1',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'account',
      payload: {
        name: 'CBP',
        type: 'RETIREMENT_CASH_BALANCE',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'POST_TAX',
        ownerId: 'm1',
        institution: 'Plan',
        notes: '',
        planningReturnPct: cbpRate,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
      },
    };
    const transferBalances = [
      balanceRow('target', todayYear - 1, 800_000),
      balanceRow('cbp1', todayYear - 1, cbpToday),
    ];
    const pensionEventYear = todayYear + 1;
    const pension: Aggregate<IncomeStreamPayload> = {
      id: 'p1',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'incomeStream',
      payload: {
        name: 'CBP Lump-Sum',
        memberId: 'm1',
        kind: 'pension',
        payoutType: 'lumpSum',
        lumpSumAmount: 0,
        linkedCbpAccountId: 'cbp1',
        targetAccountId: 'target',
        start: { kind: 'year', year: pensionEventYear },
      },
    };
    const transfer = runBalanceProjection({
      scenarioId: 's',
      scenarios,
      accounts: [brokerageTransfer, cbp],
      balances: transferBalances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [pension],
      todayYear: TODAY.getUTCFullYear(),
      todayMonthIndex: TODAY.getUTCMonth(),
    });
    expect(baseline.atHorizonTodayDollars).toBeGreaterThan(0);
    expect(transfer.atHorizonTodayDollars).toBeGreaterThan(0);
    // Within 1% of the baseline: a source CBP left in the ledger would run the transfer 50-100% richer.
    const ratio =
      transfer.atHorizonTodayDollars / baseline.atHorizonTodayDollars;
    expect(ratio).toBeGreaterThan(0.99);
    expect(ratio).toBeLessThan(1.01);
  });
});

// The linked stream's start names the event month: a lump sum elected for age 70 fires at (70 - retirementAge) * 12
// months, not at the retirement step.
describe('runBalanceProjectionMc — post-primary CBP lump-sum event-month routing', () => {
  it('routes a post-primary linked-CBP lump-sum at the income stream start month, not retirement step', () => {
    const todayYear = TODAY.getUTCFullYear();
    const birthYear = todayYear - 65;
    const members = [member('m1', true, 'Alex', birthYear)];
    const ss = [ssBenefit('m1', 0)];
    const brokerageAcct = brokerage('target', 'm1', 'BROKERAGE', 'POST_TAX', 5, 0, 0);
    const cbpAcct: Aggregate<AccountPayload> = {
      id: 'cbp1',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'account',
      payload: {
        name: 'CBP',
        type: 'RETIREMENT_CASH_BALANCE',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'POST_TAX',
        ownerId: 'm1',
        institution: 'Plan',
        notes: '',
        planningReturnPct: 4,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
      },
    };
    const balances = [
      balanceRow('target', todayYear - 1, 100_000),
      balanceRow('cbp1', todayYear - 1, 50_000),
    ];
    const pensionEventYear = todayYear + 5;
    const pension: Aggregate<IncomeStreamPayload> = {
      id: 'p1',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'incomeStream',
      payload: {
        name: 'CBP Lump-Sum',
        memberId: 'm1',
        kind: 'pension',
        payoutType: 'lumpSum',
        lumpSumAmount: 0,
        linkedCbpAccountId: 'cbp1',
        targetAccountId: 'target',
        start: { kind: 'year', year: pensionEventYear },
      },
    };
    const scenarios = [baseScenario('s', 'Base')];
    const input = runBalanceProjectionMc({
      scenarioId: 's',
      scenarios,
      accounts: [brokerageAcct, cbpAcct],
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [pension],
      todayYear,
      todayMonthIndex: TODAY.getUTCMonth(),
    });
    // Birthdate is Jan 1, so the primary retires in January of todayYear and the event lands at month 5 * 12 = 60.
    const cbpEvents = (input.events ?? []).filter(
      (e) => e.source === 'cbpLumpSum',
    );
    expect(cbpEvents).toHaveLength(1);
    const ev = cbpEvents[0];
    expect(ev.month).toBe(5 * 12);
    // 50_000 × 1.04^5 ≈ 60_833; compounding only to the retirement step would give about 50_000, a 17% under-count.
    expect(ev.amount).toBeGreaterThan(60_000);
    expect(ev.amount).toBeLessThan(61_700);
    expect(input.accountMcLedger.map((e) => e.id)).not.toContain('cbp1');
  });
});

// A stored non-50/50 MIXED split must reach the MC ledger rather than the 50/50 fallback.
describe('runBalanceProjectionMc — non-50/50 MIXED ledger plumbing', () => {
  it('threads latest stored pre/post buckets into the MC per-account ledger for MIXED accounts', () => {
    const todayYear = TODAY.getUTCFullYear();
    const members = [member('m1', true, 'Alex', todayYear - 50)];
    const ss = [ssBenefit('m1', 0)];
    const mixed: Aggregate<AccountPayload> = {
      id: 'mixed1',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'account',
      payload: {
        name: '401k',
        type: 'RETIREMENT_401K',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'MIXED',
        ownerId: 'm1',
        institution: 'X',
        notes: '',
        planningReturnPct: 6,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      },
    };
    const balance: Aggregate<AccountBalancePayload> = {
      id: 'b-mixed1',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'accountBalance',
      payload: {
        accountId: 'mixed1',
        year: todayYear - 1,
        lastUpdated: `${todayYear - 1}-12-31`,
        startingBalance: 100_000,
        startingBalancePreTax: 70_000,
        startingBalancePostTax: 30_000,
        contributionsPreTax: null,
        contributionsPostTax: null,
        companyContributions: 0,
        companyContributionsPreTax: null,
        companyContributionsPostTax: null,
        rollover: 0,
        distributions: 0,
        endingBalance: 100_000,
        endingBalancePreTax: 70_000,
        endingBalancePostTax: 30_000,
        totalContributions: 0,
        comment: null,
      },
    };
    const scenarios = [baseScenario('s', 'Base')];
    const input = runBalanceProjectionMc({
      scenarioId: 's',
      scenarios,
      accounts: [mixed],
      balances: [balance],
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear,
      todayMonthIndex: TODAY.getUTCMonth(),
    });
    expect(input.accountMcLedger).toHaveLength(1);
    const entry = input.accountMcLedger[0];
    expect(entry.initialPre).toBeCloseTo(70_000, 2);
    expect(entry.initialPost).toBeCloseTo(30_000, 2);
    expect(entry.initialPre + entry.initialPost).toBeCloseTo(100_000, 2);
  });
});

// A child's inflation override must reach incomeByYear for an income stream with tracksInflation.
describe('runBalanceProjectionMc — child scenario inflation override propagates to tracksInflation income', () => {
  it('produces a larger late-year incomeByYear value when child overrides inflation to 5 %', () => {
    const members = [member('m1', true, 'Alex', 1960)];
    const ss = [ssBenefit('m1', null)];
    const accounts = [brokerage('a1', 'm1')];
    const balances = [balanceRow('a1', 2025, 500_000)];
    const parent = baseScenario('parent', 'Parent');
    const child: ScenarioAggregate = {
      ...baseScenario('child', 'Child', 'parent'),
      payload: {
        ...baseScenario('child', 'Child', 'parent').payload,
        overrides: {
          ...baseScenario('child', 'Child', 'parent').payload.overrides,
          inflation: { ratePct: 5 },
        },
      },
    };
    const pensionStream: Aggregate<IncomeStreamPayload> = {
      id: 'inc-pension',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'incomeStream',
      payload: {
        name: 'Pension',
        kind: 'pension',
        memberId: 'm1',
        payoutType: 'annuity',
        monthlyBenefit: 3_000,
        tracksInflation: true,
        start: { kind: 'age', years: 65, months: 0 },
      } as IncomeStreamPayload,
    };
    const args = {
      scenarios: [parent, child],
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [pensionStream],
      todayYear: TODAY.getUTCFullYear(),
      todayMonthIndex: TODAY.getUTCMonth(),
    } as const;
    const parentMc = runBalanceProjectionMc({ ...args, scenarioId: 'parent' });
    const childMc = runBalanceProjectionMc({ ...args, scenarioId: 'child' });
    expect(childMc.incomeByYear.length).toBe(parentMc.incomeByYear.length);
    const parentTotal = parentMc.incomeByYear.reduce((a, b) => a + b, 0);
    const childTotal = childMc.incomeByYear.reduce((a, b) => a + b, 0);
    expect(parentTotal).toBeGreaterThan(0);
    expect(childTotal).toBeGreaterThan(parentTotal * 1.5);
    // Last entry (2050): about 25 years of 5% compounding, roughly 3.4x.
    const lastIdx = childMc.incomeByYear.length - 1;
    const parentLast = parentMc.incomeByYear[lastIdx];
    const childLast = childMc.incomeByYear[lastIdx];
    expect(parentLast).toBeGreaterThan(0);
    expect(childLast / parentLast).toBeGreaterThan(2);
  });
});

describe('runBalanceProjection — accountYears widening', () => {
  it('populates real per-year contributions + growth on accountYears (not placeholder zeros)', () => {
    const members = [member('m1', true, 'Alex', 1975)];
    const ss = [ssBenefit('m1', 2000)];
    const accounts = [brokerage('a1', 'm1', 'BROKERAGE', 'POST_TAX', 6, 0, 12_000)];
    const balances = [balanceRow('a1', 2025, 100_000)];
    const scenarios = [baseScenario('s', 'Base')];

    const result = runBalanceProjection({
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(),
      todayMonthIndex: TODAY.getUTCMonth(),
    });

    const rows = result.accountYears.get('a1');
    expect(rows).toBeDefined();
    expect(rows!.length).toBeGreaterThan(0);
    const anyContrib = rows!.some((r) => r.contributionsThisYear > 0);
    const anyGrowth = rows!.some((r) => r.growthCarry > 0);
    expect(anyContrib).toBe(true);
    expect(anyGrowth).toBe(true);
    expect(rows!.every((r) => r.withdrawalsThisYear === 0)).toBe(true);
    expect(rows!.every((r) => r.nominalBalance > 0)).toBe(true);
  });

  it('includes a retired_in_the_past account as a single accumulation row', () => {
    // The accountYears membership gate keys off yearlyTotals, so a retired-in-the-past account (a single defensive row
    // with no per-step series) must still appear.
    const todayYear = TODAY.getUTCFullYear();
    const birthYear = todayYear - 80;
    const members = [member('m1', true, 'Alex', birthYear)];
    const ss = [ssBenefit('m1', 2000)];
    const accounts = [brokerage('a1', 'm1', 'BROKERAGE', 'POST_TAX', 5)];
    const balances = [balanceRow('a1', todayYear, 600_000)];
    const scenarios = [baseScenario('s', 'Base')];

    const result = runBalanceProjection({
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear,
      todayMonthIndex: TODAY.getUTCMonth(),
    });

    expect(result.retirementYear).toBeLessThan(todayYear);
    const rows = result.accountYears.get('a1');
    expect(rows).toBeDefined();
    expect(rows!.length).toBe(1);
    expect(rows![0].year).toBe(todayYear);
    expect(rows![0].nominalBalance).toBeGreaterThan(0);
    expect(rows![0].growthCarry).toBe(0);
    expect(rows![0].contributionsThisYear).toBe(0);
    expect(rows![0].withdrawalsThisYear).toBe(0);
  });
});

describe('runBalanceProjectionForPage — both-methods shared agnostic phase', () => {
  it('returns { planned, twr, sharedCtx } and each method matches runBalanceProjection per method', () => {
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 2500)];
    const accounts = [
      brokerage('a1', 'm1', 'BROKERAGE', 'POST_TAX', 5),
      brokerage('a2', 'm1', 'RETIREMENT_401K', 'PRE_TAX', 6),
    ];
    const balances = [
      balanceRow('a1', 2024, 400_000),
      balanceRow('a1', 2025, 440_000),
      balanceRow('a2', 2024, 300_000),
      balanceRow('a2', 2025, 330_000),
    ];
    const scenarios = [baseScenario('s', 'Base')];
    const baseArgs = {
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(),
      todayMonthIndex: TODAY.getUTCMonth(),
    };

    const page = runBalanceProjectionForPage(baseArgs);
    const planned = runBalanceProjection({ ...baseArgs, method: 'planned' });
    const twr = runBalanceProjection({ ...baseArgs, method: 'twr' });

    expect(page.planned).not.toBeNull();
    expect(page.twr).not.toBeNull();
    expect(page.sharedCtx.accountProjections.length).toBe(2);
    expect(page.sharedCtx.retirementYear).toBe(planned.retirementYear);
    expect(page.sharedCtx.horizonYear).toBe(planned.horizonYear);
    expect(page.sharedCtx.todayYear).toBe(baseArgs.todayYear);

    expect(page.planned!.atHorizonTodayDollars).toBeCloseTo(
      planned.atHorizonTodayDollars,
      6,
    );
    expect(page.twr!.atHorizonTodayDollars).toBeCloseTo(
      twr.atHorizonTodayDollars,
      6,
    );

    const pagePlannedLast = page.planned!.years[page.planned!.years.length - 1];
    const refPlannedLast =
      planned.drawdownYears[planned.drawdownYears.length - 1];
    expect(pagePlannedLast.balance).toBeCloseTo(refPlannedLast.nominalBalance, 6);
    const pageTwrLast = page.twr!.years[page.twr!.years.length - 1];
    const refTwrLast = twr.drawdownYears[twr.drawdownYears.length - 1];
    expect(pageTwrLast.balance).toBeCloseTo(refTwrLast.nominalBalance, 6);
  });

  it('surfaces cbpResolution + null drawdowns without throwing for CBP-unconfigured', () => {
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 2500)];
    const accounts = [
      brokerage('cbp', 'm1', 'RETIREMENT_CASH_BALANCE', 'PRE_TAX', 4),
    ];
    const balances = [balanceRow('cbp', 2025, 200_000)];
    const scenarios = [baseScenario('s', 'Base')];

    const page = runBalanceProjectionForPage({
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(),
      todayMonthIndex: TODAY.getUTCMonth(),
    });

    expect(page.sharedCtx.cbpResolution).not.toBeNull();
    expect(page.sharedCtx.cbpResolution!.ok).toBe(false);
    expect(page.planned).toBeNull();
    expect(page.twr).toBeNull();
  });

  it('nulls twr + sets sharedCtx.methodAvailable false on TWR-insufficient history, keeping planned', () => {
    // The shared ctx is built on 'planned', so ctx.methodAvailable is always true; the page must re-derive TWR availability.
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 2500)];
    const accounts = [brokerage('a1', 'm1', 'BROKERAGE', 'POST_TAX', 5)];
    const balances = [balanceRow('a1', 2025, 800_000)];
    const scenarios = [baseScenario('s', 'Base')];
    const baseArgs = {
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(),
      todayMonthIndex: TODAY.getUTCMonth(),
    };

    const page = runBalanceProjectionForPage(baseArgs);
    const twrRef = runBalanceProjection({ ...baseArgs, method: 'twr' });

    expect(twrRef.methodAvailable).toBe(false);
    expect(twrRef.atHorizonTodayDollars).toBe(0);
    expect(page.sharedCtx.methodAvailable).toBe(false);
    expect(page.twr).toBeNull();
    expect(page.planned).not.toBeNull();
    expect(page.planned!.atHorizonTodayDollars).toBeGreaterThan(0);
  });

  it('does NOT null a method when a cap window anchor is broken — the run completes', () => {
    // A broken cap anchor flags the window inactive instead of throwing, so no method degrades to null.
    const primaryMember = member('m1', true, 'Alex', 1965);
    const secondaryNoBirthdate: Aggregate<HouseholdMemberPayload> = {
      id: 'm2',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'householdMember',
      payload: {
        isPrimary: false,
        firstName: 'Sam',
        lastName: 'Doe',
        email: 'm2@example.test',
        birthdate: '',
      },
    };
    const ss = [ssBenefit('m1', 2500)];
    const accounts = [brokerage('a1', 'm1', 'BROKERAGE', 'POST_TAX', 5)];
    const balances = [
      balanceRow('a1', 2024, 600_000),
      balanceRow('a1', 2025, 800_000),
    ];
    const scenarioTaxEfficientBadCap: ScenarioAggregate = {
      ...baseScenario('s', 'Base'),
      payload: {
        ...baseScenario('s', 'Base').payload,
        overrides: {
          ...baseScenario('s', 'Base').payload.overrides,
          withdrawalStrategy: { kind: 'taxEfficient' },
          magiCap: {
            windows: [
              {
                start: { kind: 'retirementStart' },
                end: { kind: 'age', memberId: 'secondary', years: 65, months: 0 },
                magiCeilingAnnualDollars: 15_000,
                capMode: 'minimize',
                capMagiLine: 'irmaa',
              },
            ],
          },
        },
      },
    };

    const page = runBalanceProjectionForPage({
      scenarioId: 's',
      scenarios: [scenarioTaxEfficientBadCap],
      accounts,
      balances,
      members: [primaryMember, secondaryNoBirthdate],
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(),
      todayMonthIndex: TODAY.getUTCMonth(),
    });

    expect(page.planned).not.toBeNull();
    expect(page.sharedCtx.accountProjections.length).toBe(1);
    expect(page.sharedCtx.cbpResolution).toBeNull();
    expect(page.sharedCtx.retirementYear).toBe(1965 + 67);
    expect(page.sharedCtx.horizonYear).toBeGreaterThan(page.sharedCtx.retirementYear);
  });

  it('nulls the affected method at zero portfolio while populating sharedCtx', () => {
    // Zero portfolio makes runDrawdownForMethod return null while sharedCtx still populates; with no CBP account this is
    // not the CBP-unconfigured short-circuit.
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 2500)];
    const accounts = [brokerage('a-empty', 'm1', 'BROKERAGE', 'POST_TAX', 5)];
    const balances: never[] = [];
    const scenarios = [baseScenario('s', 'Base')];

    const page = runBalanceProjectionForPage({
      scenarioId: 's',
      scenarios,
      accounts,
      balances,
      members,
      ssBenefits: ss,
      expenses: [],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(),
      todayMonthIndex: TODAY.getUTCMonth(),
    });

    expect(page.planned).toBeNull();
    expect(page.sharedCtx.cbpResolution).toBeNull();
    expect(page.sharedCtx.retirementYear).toBe(1965 + 67);
    expect(page.sharedCtx.lifeExpectancyMarkers.length).toBeGreaterThan(0);
    expect(page.sharedCtx.todayYear).toBe(TODAY.getUTCFullYear());
  });
});

// The taxable RMD portion of a linked-CBP lump sum rolled in or after the owner's trigger year shows up in the
// event-year row, unlike a rollover before trigger age (which rolls untaxed).
describe('runBalanceProjection — linked-CBP rollover-year RMD split', () => {
  function buildCbpRolloverCase(opts: {
    birthYear: number;
    retirementAge: number;
  }): {
    scenarios: ScenarioAggregate[];
    accounts: Aggregate<AccountPayload>[];
    balances: Aggregate<AccountBalancePayload>[];
    members: Aggregate<HouseholdMemberPayload>[];
    ssBenefits: Aggregate<SocialSecurityBenefitPayload>[];
    incomeStreams: Aggregate<IncomeStreamPayload>[];
    eventYear: number;
  } {
    const todayYear = TODAY.getUTCFullYear();
    const members = [member('m1', true, 'Pat', opts.birthYear)];
    const ss = [ssBenefit('m1', 0)];
    // Both PRE_TAX so the rolled excess and carved RMD are well-defined; a named per-account strategy makes the split fire.
    const target = brokerage('target', 'm1', 'RETIREMENT_IRA', 'PRE_TAX', 5);
    const cbp = brokerage('cbp1', 'm1', 'RETIREMENT_CASH_BALANCE', 'PRE_TAX', 5);
    const balances = [
      balanceRow('target', todayYear - 1, 1_200_000),
      balanceRow('cbp1', todayYear - 1, 600_000),
    ];
    const retirementYear = opts.birthYear + opts.retirementAge;
    const pension: Aggregate<IncomeStreamPayload> = {
      id: 'p1',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'incomeStream',
      payload: {
        name: 'CBP Lump-Sum',
        memberId: 'm1',
        kind: 'pension',
        payoutType: 'lumpSum',
        lumpSumAmount: 0,
        linkedCbpAccountId: 'cbp1',
        targetAccountId: 'target',
        start: { kind: 'retirementStart' },
      },
    };
    const scenario: ScenarioAggregate = {
      id: 's',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'scenario',
      payload: {
        name: 'CBP Rollover',
        description: '',
        parentScenarioId: null,
        isPrimary: true,
        notes: '',
        overrides: {
          retirementAge: { primary: { ageYears: opts.retirementAge, ageMonths: 0 } },
          socialSecurity: { primary: { ageYears: opts.retirementAge, ageMonths: 0 } },
          inflation: { ratePct: 0 },
          lifeExpectancy: { primary: 95 },
          withdrawalStrategy: { kind: 'taxEfficient' },
        },
      },
    };
    return {
      scenarios: [scenario],
      accounts: [target, cbp],
      balances,
      members,
      ssBenefits: ss,
      incomeStreams: [pension],
      eventYear: retirementYear,
    };
  }

  it('witnesses a higher event-year federal tax + MAGI when the rollover lands at/after trigger age', () => {
    const todayYear = TODAY.getUTCFullYear();
    // Born 1955: RMD trigger age 73 is 2028; retiring at 73 rolls the CBP in the trigger year, so that year's RMD is carved
    // and taxed.
    const afterCase = buildCbpRolloverCase({ birthYear: 1955, retirementAge: 73 });
    // Retiring at 62 rolls the whole amount before age 73, so no RMD is carved.
    const beforeCase = buildCbpRolloverCase({
      birthYear: todayYear - 60,
      retirementAge: 62,
    });

    const afterResult = runBalanceProjection({
      scenarioId: 's',
      scenarios: afterCase.scenarios,
      accounts: afterCase.accounts,
      balances: afterCase.balances,
      members: afterCase.members,
      ssBenefits: afterCase.ssBenefits,
      expenses: [],
      incomeStreams: afterCase.incomeStreams,
      todayYear,
      todayMonthIndex: TODAY.getUTCMonth(),
      method: 'planned',
    });
    const beforeResult = runBalanceProjection({
      scenarioId: 's',
      scenarios: beforeCase.scenarios,
      accounts: beforeCase.accounts,
      balances: beforeCase.balances,
      members: beforeCase.members,
      ssBenefits: beforeCase.ssBenefits,
      expenses: [],
      incomeStreams: beforeCase.incomeStreams,
      todayYear,
      todayMonthIndex: TODAY.getUTCMonth(),
      method: 'planned',
    });

    const afterEventRow = afterResult.drawdownYears.find(
      (y) => y.year === afterCase.eventYear,
    );
    const beforeEventRow = beforeResult.drawdownYears.find(
      (y) => y.year === beforeCase.eventYear,
    );
    expect(afterEventRow).toBeTruthy();
    expect(beforeEventRow).toBeTruthy();
    // The carved RMD lands in the event-year MAGI; the before-trigger rollover has no rollover income.
    expect((afterEventRow!.magiCents ?? 0)).toBeGreaterThan(0);
    expect((afterEventRow!.federalTaxCents ?? 0)).toBeGreaterThan(0);
    // ~$600k CBP over the age-73 divisor is tens of thousands of dollars.
    expect((afterEventRow!.magiCents ?? 0) / 100).toBeGreaterThan(15_000);
  });
});
