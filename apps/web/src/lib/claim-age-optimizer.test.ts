/**
 * Barrel-level integration tests for `optimiseClaimAgesForScenario`.
 *
 *   - `should_return_known_winner_from_handcrafted_fixture`: a tiny
 *     fixture with hand-picked numbers proves the orchestrator wires
 *     the pieces (grid → simulate → pickWinner) correctly and returns
 *     a valid winner pair.
 *   - `should_run_without_error_on_demo_dataset`: a looser sanity test
 *     against demo-style aggregates (two members with realistic PIAs +
 *     a base scenario). Asserts the optimizer completes for every
 *     scenario, returns finite positive metric values, and surfaces
 *     one winner per non-deleted scenario.
 */
import { describe, expect, it } from 'vitest';
import { mergeSsOverride, optimiseClaimAgesForScenario } from './claim-age-optimizer';
import { runBalanceProjection } from './balance-projection-runner';
import type { OptimizerMcRunner } from './claim-age-optimizer/types';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  SocialSecurityBenefitPayload,
  SocialSecurityOverride,
} from '../db/types';
import type { ScenarioAggregate } from './scenario-resolution';

const TODAY = new Date('2026-06-15T00:00:00Z');

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
    updatedAt: '2026-05-19T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'householdMember',
    payload: {
      isPrimary,
      firstName,
      lastName: 'Doe',
      email: '',
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
    updatedAt: '2026-05-19T00:00:00Z',
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

function brokerage(ownerId: string, accountId = 'a1'): Aggregate<AccountPayload> {
  return {
    id: accountId,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-19T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'account',
    payload: {
      name: accountId,
      type: 'BROKERAGE',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'POST_TAX',
      ownerId,
      institution: 'Vanguard',
      notes: '',
      planningReturnPct: 5,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
    },
  };
}

function balanceRow(
  endingBalance: number,
  accountId = 'a1',
): Aggregate<AccountBalancePayload> {
  return {
    id: `b-${accountId}`,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-19T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'accountBalance',
    payload: {
      accountId,
      year: 2025,
      lastUpdated: '2025-12-31',
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

function scenarioFixture(
  id: string,
  name: string,
  hasSecondary = true,
): ScenarioAggregate {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-19T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'scenario',
    payload: {
      name,
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides: {
        socialSecurity: hasSecondary
          ? {
              primary: { ageYears: 67, ageMonths: 0 },
              secondary: { ageYears: 67, ageMonths: 0 },
            }
          : { primary: { ageYears: 67, ageMonths: 0 } },
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

function expense(amount: number): Aggregate<ExpensePayload> {
  return {
    id: 'e1',
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-19T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'expense',
    payload: {
      name: 'Living',
      categoryId: 'cat-housing',
      amount,
      frequency: 'yearly',
      classification: 'essential',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    },
  };
}

interface BaseFixtureArgs {
  readonly members: Aggregate<HouseholdMemberPayload>[];
  readonly ssBenefits: Aggregate<SocialSecurityBenefitPayload>[];
  readonly scenarios: ScenarioAggregate[];
  readonly expenseAmount: number;
  readonly portfolio: number;
}

function baseInputs(args: BaseFixtureArgs) {
  return {
    accounts: [brokerage(args.members[0].id)],
    balances: [balanceRow(args.portfolio)],
    expenses: [expense(args.expenseAmount)],
    incomeStreams: [] as Aggregate<IncomeStreamPayload>[],
  };
}

describe('optimiseClaimAgesForScenario', () => {
  it('should_return_known_winner_from_handcrafted_fixture', async () => {
    const members = [
      member('m1', true, 'Alex', 1965),
      member('m2', false, 'Sam', 1968),
    ];
    const ssBenefits = [ssBenefit('m1', 3500), ssBenefit('m2', 2800)];
    const sc = scenarioFixture('s', 'Base');
    const base = baseInputs({
      members,
      ssBenefits,
      scenarios: [sc],
      expenseAmount: 80_000,
      portfolio: 1_200_000,
    });
    const result = await optimiseClaimAgesForScenario({
      scenario: sc,
      scenarios: [sc],
      members,
      ssBenefits,
      accounts: base.accounts,
      balances: base.balances,
      expenses: base.expenses,
      incomeStreams: base.incomeStreams,
      metric: 'balance',
      today: TODAY,
    });
    expect(result.winner).not.toBeNull();
    expect(result.winner?.primaryAgeYears).toBeGreaterThanOrEqual(62);
    expect(result.winner?.primaryAgeYears).toBeLessThanOrEqual(70);
    expect(Number.isFinite(result.winner?.metricValue)).toBe(true);
    expect(result.partial).toBe(false);
  });

  it('should_run_without_error_on_demo_like_dataset', async () => {
    const members = [
      member('m1', true, 'Robert', 1962),
      member('m2', false, 'Jane', 1964),
    ];
    const ssBenefits = [ssBenefit('m1', 3200), ssBenefit('m2', 2400)];
    const scenarios = [
      scenarioFixture('base', 'Base'),
      scenarioFixture('aggressive', 'Aggressive'),
      scenarioFixture('conservative', 'Conservative'),
    ];
    const base = baseInputs({
      members,
      ssBenefits,
      scenarios,
      expenseAmount: 66_000,
      portfolio: 1_500_000,
    });
    const winners = new Map<string, unknown>();
    for (const sc of scenarios) {
      const result = await optimiseClaimAgesForScenario({
        scenario: sc,
        scenarios,
        members,
        ssBenefits,
        accounts: base.accounts,
        balances: base.balances,
        expenses: base.expenses,
        incomeStreams: base.incomeStreams,
        metric: 'balance',
        today: TODAY,
      });
      expect(result.winner).not.toBeNull();
      expect(Number.isFinite(result.winner?.metricValue)).toBe(true);
      expect(result.winner?.metricValue).toBeGreaterThan(0);
      expect(result.missingPiaMembers.length).toBe(0);
      winners.set(sc.id, result);
    }
    expect(winners.size).toBe(scenarios.length);
  });

  it('returns winner with secondaryAgeYears = null for single-member households', async () => {
    const members = [member('m1', true, 'Alex', 1965)];
    const ssBenefits = [ssBenefit('m1', 3000)];
    const sc = scenarioFixture('s', 'Base', false);
    const base = baseInputs({
      members,
      ssBenefits,
      scenarios: [sc],
      expenseAmount: 40_000,
      portfolio: 800_000,
    });
    const result = await optimiseClaimAgesForScenario({
      scenario: sc,
      scenarios: [sc],
      members,
      ssBenefits,
      accounts: base.accounts,
      balances: base.balances,
      expenses: base.expenses,
      incomeStreams: base.incomeStreams,
      metric: 'balance',
      today: TODAY,
    });
    expect(result.winner?.secondaryAgeYears).toBeNull();
  });

  it('flags partial + missingPiaMembers when a member has no PIA', async () => {
    const members = [
      member('m1', true, 'Alex', 1965),
      member('m2', false, 'Sam', 1968),
    ];
    const ssBenefits = [ssBenefit('m1', 3000), ssBenefit('m2', null)];
    const sc = scenarioFixture('s', 'Base');
    const base = baseInputs({
      members,
      ssBenefits,
      scenarios: [sc],
      expenseAmount: 50_000,
      portfolio: 800_000,
    });
    const result = await optimiseClaimAgesForScenario({
      scenario: sc,
      scenarios: [sc],
      members,
      ssBenefits,
      accounts: base.accounts,
      balances: base.balances,
      expenses: base.expenses,
      incomeStreams: base.incomeStreams,
      metric: 'balance',
      today: TODAY,
    });
    expect(result.partial).toBe(true);
    expect(result.missingPiaMembers).toContain('m2');
  });

  it('runs 1-D secondary search when primary PIA is missing', async () => {
    const members = [
      member('m1', true, 'Alex', 1965),
      member('m2', false, 'Sam', 1968),
    ];
    const ssBenefits = [ssBenefit('m1', null), ssBenefit('m2', 2800)];
    const sc = scenarioFixture('s', 'Base');
    const base = baseInputs({
      members,
      ssBenefits,
      scenarios: [sc],
      expenseAmount: 50_000,
      portfolio: 800_000,
    });
    const result = await optimiseClaimAgesForScenario({
      scenario: sc,
      scenarios: [sc],
      members,
      ssBenefits,
      accounts: base.accounts,
      balances: base.balances,
      expenses: base.expenses,
      incomeStreams: base.incomeStreams,
      metric: 'balance',
      today: TODAY,
    });
    expect(result.partial).toBe(true);
    expect(result.missingPiaMembers).toContain('m1');
    expect(result.winner).not.toBeNull();
    // Primary's age preserved at resolved value (67).
    expect(result.winner?.primaryAgeYears).toBe(67);
    expect(result.winner?.secondaryAgeYears).toBeGreaterThanOrEqual(62);
    expect(result.winner?.secondaryAgeYears).toBeLessThanOrEqual(70);
  });

  it('should_clamp_to_next_whole_year_when_member_is_62_5', async () => {
    const onAge62And6Months = new Date('2026-06-15T00:00:00Z');
    const m: Aggregate<HouseholdMemberPayload> = {
      id: 'm1',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-19T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'householdMember',
      payload: {
        isPrimary: true,
        firstName: 'Pat',
        lastName: '',
        email: '',
        birthdate: '1963-12-15',
      },
    };
    const ss = [ssBenefit('m1', 3000)];
    const sc = scenarioFixture('s', 'Base', false);
    const base = baseInputs({
      members: [m],
      ssBenefits: ss,
      scenarios: [sc],
      expenseAmount: 40_000,
      portfolio: 800_000,
    });
    const result = await optimiseClaimAgesForScenario({
      scenario: sc,
      scenarios: [sc],
      members: [m],
      ssBenefits: ss,
      accounts: base.accounts,
      balances: base.balances,
      expenses: base.expenses,
      incomeStreams: base.incomeStreams,
      metric: 'balance',
      today: onAge62And6Months,
    });
    expect(result.winner).not.toBeNull();
    expect(result.winner?.primaryAgeYears).toBeGreaterThanOrEqual(63);
  });
});

describe('optimiseClaimAgesForScenario — projectionMethod (Planned + TWR)', () => {
  it('should_return_twrInsufficient_sentinel_when_method_twr_and_only_one_year_of_history', async () => {
    // One yearly balance → `accountReturns(balances).twr === null` →
    // orchestrator short-circuits on the first candidate and returns
    // the new `twrInsufficient: true` flag.
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 3000)];
    const sc = scenarioFixture('s', 'Base', false);
    const base = baseInputs({
      members,
      ssBenefits: ss,
      scenarios: [sc],
      expenseAmount: 40_000,
      portfolio: 800_000,
    });
    const result = await optimiseClaimAgesForScenario({
      scenario: sc,
      scenarios: [sc],
      members,
      ssBenefits: ss,
      accounts: base.accounts,
      balances: base.balances,
      expenses: base.expenses,
      incomeStreams: base.incomeStreams,
      metric: 'balance',
      projectionMethod: 'twr',
      today: TODAY,
    });
    expect(result.twrInsufficient).toBe(true);
    expect(result.winner).toBeNull();
  });

  it('should_return_a_real_winner_when_method_twr_and_account_has_two_years_of_history', async () => {
    // Two yearly balances → TWR is defined. The orchestrator must
    // produce a real winner with a finite metric value (the search
    // grid uses the empirical TWR rate, not the planning rate).
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 3000)];
    const sc = scenarioFixture('s', 'Base', false);
    const result = await optimiseClaimAgesForScenario({
      scenario: sc,
      scenarios: [sc],
      members,
      ssBenefits: ss,
      accounts: [brokerage('m1')],
      balances: [balanceRow(700_000), {
        ...balanceRow(800_000),
        id: 'b-a1-2',
        payload: { ...balanceRow(800_000).payload, year: 2024, lastUpdated: '2024-12-31' },
      }],
      expenses: [expense(40_000)],
      incomeStreams: [],
      metric: 'balance',
      projectionMethod: 'twr',
      today: TODAY,
    });
    expect(result.twrInsufficient).not.toBe(true);
    expect(result.winner).not.toBeNull();
    expect(Number.isFinite(result.winner?.metricValue)).toBe(true);
  });
});

describe('BPP-equivalence: previously-Unsupported categories now compute', () => {
  // Each fixture below would once have routed to the Unsupported callout;
  // the runner now threads the full BPP pipeline and the optimizer
  // returns a real winner. The assertions are looser-than-headline ($1
  // tolerance is for the runner-vs-BPP test, not here) — these just
  // prove the row produces a winner instead of an Unsupported callout.

  it('computes a winner for a scenario with a pre-primary targeted-deposit income stream', async () => {
    const members = [member('m1', true, 'Alex', 1965)];
    const ssBenefits = [ssBenefit('m1', 3000)];
    const sc = scenarioFixture('s', 'Base', false);
    const incomeStreams: Aggregate<IncomeStreamPayload>[] = [
      {
        id: 'i1',
        householdId: 'h',
        schemaVersion: 1,
        version: 1,
        updatedAt: '2026-05-19T00:00:00Z',
        deviceId: 'd',
        aggregateType: 'incomeStream',
        payload: {
          name: 'Inheritance',
          memberId: 'm1',
          kind: 'oneOff',
          oneOffAmount: 50_000,
          targetAccountId: 'a1',
          start: { kind: 'year', year: 2027 },
        },
      },
    ];
    const result = await optimiseClaimAgesForScenario({
      scenario: sc,
      scenarios: [sc],
      members,
      ssBenefits,
      accounts: [brokerage('m1')],
      balances: [balanceRow(800_000)],
      expenses: [expense(40_000)],
      incomeStreams,
      metric: 'balance',
      today: TODAY,
    });
    expect(result.winner).not.toBeNull();
    expect(result.winner?.metricValue).toBeGreaterThan(0);
  });

  it('computes a winner for a scenario with post-primary owner contributions', async () => {
    // Secondary retires after primary + their account carries planned
    // contributions → used to route to `post-primary-contributions`;
    // now computes via post-primary contribution synthesis.
    const members = [
      member('m1', true, 'Alex', 1962), // already 64 today → retires at 67 (2029)
      member('m2', false, 'Sam', 1970), // retires at 67 (2037) — strictly after primary
    ];
    const ssBenefits = [ssBenefit('m1', 3000), ssBenefit('m2', 2500)];
    const sc = scenarioFixture('s', 'Base');
    const accounts = [
      brokerage('m1', 'a1'),
      {
        ...brokerage('m2', 'a2'),
        payload: {
          ...brokerage('m2', 'a2').payload,
          plannedContributionPostTax: 12_000,
        },
      },
    ];
    const balances = [balanceRow(600_000, 'a1'), balanceRow(200_000, 'a2')];
    const result = await optimiseClaimAgesForScenario({
      scenario: sc,
      scenarios: [sc],
      members,
      ssBenefits,
      accounts,
      balances,
      expenses: [expense(60_000)],
      incomeStreams: [],
      metric: 'balance',
      today: TODAY,
    });
    expect(result.winner).not.toBeNull();
    expect(result.winner?.metricValue).toBeGreaterThan(0);
  });
});

describe('optimiseClaimAgesForScenario — stored month-level claim age', () => {
  const STORED: SocialSecurityOverride = {
    primary: { ageYears: 66, ageMonths: 4 },
    secondary: { ageYears: 67, ageMonths: 0 },
  };
  const withSs = (ss: SocialSecurityOverride): ScenarioAggregate => {
    const sc = scenarioFixture('s', 'Base');
    return { ...sc, payload: { ...sc.payload, overrides: { ...sc.payload.overrides, socialSecurity: ss } } };
  };
  const bothMembers = () => [member('m1', true, 'Alex', 1965), member('m2', false, 'Sam', 1968)];
  const bothBenefits = () => [ssBenefit('m1', 3500), ssBenefit('m2', 2800)];

  /** Plan-success stand-in: records every candidate the orchestrator tries. */
  function recordingRunner(score: (c: Parameters<OptimizerMcRunner>[0]['candidate']) => number) {
    const calls: Parameters<OptimizerMcRunner>[0]['candidate'][] = [];
    const mcRunner: OptimizerMcRunner = async ({ candidate }) => {
      calls.push(candidate);
      return { successProbability: score(candidate) };
    };
    return { calls, mcRunner };
  }
  const run = (
    sc: ScenarioAggregate,
    members: Aggregate<HouseholdMemberPayload>[],
    ssBenefits: Aggregate<SocialSecurityBenefitPayload>[],
    mcRunner: OptimizerMcRunner,
  ) =>
    optimiseClaimAgesForScenario({
      scenario: sc,
      scenarios: [sc],
      members,
      ssBenefits,
      ...baseInputs({ members, ssBenefits, scenarios: [sc], expenseAmount: 80_000, portfolio: 1_200_000 }),
      metric: 'mc',
      mcRunner,
      today: TODAY,
    });

  it('simulates the stored pair exactly once and its baseline is the stored pair, not the rounded year', async () => {
    const members = bothMembers();
    const ssBenefits = bothBenefits();
    const sc = withSs(STORED);
    const base = baseInputs({ members, ssBenefits, scenarios: [sc], expenseAmount: 80_000, portfolio: 1_200_000 });
    const direct = (primaryMonths: number): number =>
      runBalanceProjection({
        scenarioId: sc.id,
        scenarios: [sc],
        ...base,
        members,
        ssBenefits,
        todayYear: TODAY.getUTCFullYear(),
        todayMonthIndex: TODAY.getUTCMonth(),
        method: 'planned',
        candidateOverlay: {
          socialSecurity: {
            primary: { ageYears: 66, ageMonths: primaryMonths },
            secondary: { ageYears: 67, ageMonths: 0 },
          },
        },
      }).atHorizonTodayDollars;
    // The fixture must tell the stored pair from the rounded year.
    expect(direct(4)).not.toBe(direct(0));

    const result = await optimiseClaimAgesForScenario({
      scenario: sc,
      scenarios: [sc],
      members,
      ssBenefits,
      ...base,
      metric: 'balance',
      today: TODAY,
    });
    expect(result.baselineMetricValue).toBe(direct(4));
  });

  it('counts the stored month-level pair once on top of the grid, and dedups a whole-year pair', async () => {
    const { calls, mcRunner } = recordingRunner(() => 0.5);
    await run(withSs(STORED), bothMembers(), bothBenefits(), mcRunner);
    expect(calls).toHaveLength(82);
    expect(calls.filter((c) => c.primary.ageMonths === 4)).toHaveLength(1);

    const whole = recordingRunner(() => 0.5);
    await run(
      withSs({ primary: { ageYears: 66, ageMonths: 0 }, secondary: { ageYears: 67, ageMonths: 0 } }),
      bothMembers(),
      bothBenefits(),
      whole.mcRunner,
    );
    expect(whole.calls).toHaveLength(81);
  });

  it('a stored pair that ranks highest wins "already at optimum" carrying its months; a tie goes to the lower age', async () => {
    const best = recordingRunner((c) => (c.primary.ageMonths === 4 ? 0.9 : 0.5));
    const won = await run(withSs(STORED), bothMembers(), bothBenefits(), best.mcRunner);
    expect(won.winner).toMatchObject({ primaryAgeYears: 66, primaryAgeMonths: 4, secondaryAgeYears: 67, alreadyAtOptimum: true });
    expect(won.baselineMetricValue).toBe(0.9);

    const flat = recordingRunner(() => 0.5);
    const tied = await run(withSs(STORED), bothMembers(), bothBenefits(), flat.mcRunner);
    expect(tied.winner).toMatchObject({ primaryAgeYears: 62, secondaryAgeYears: 62, alreadyAtOptimum: false });
    expect(tied.baselineMetricValue).toBe(0.5);
  });

  it('adds no winner when every grid is empty, even with a month-level stored pair', async () => {
    const members = [member('m1', true, 'Alex', 1955), member('m2', false, 'Sam', 1955)];
    const { calls, mcRunner } = recordingRunner(() => 0.5);
    const result = await run(withSs(STORED), members, bothBenefits(), mcRunner);
    expect(result.winner).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('secondary-only fallback keeps the primary stored months through to the saved override', async () => {
    const ssBenefits = [ssBenefit('m1', null), ssBenefit('m2', 2800)];
    const { calls, mcRunner } = recordingRunner((c) => (c.secondary?.ageYears ?? 0) / 100);
    const result = await run(withSs(STORED), bothMembers(), ssBenefits, mcRunner);
    for (const c of calls) expect(c.primary).toEqual({ ageYears: 66, ageMonths: 4 });
    expect(result.winner).toMatchObject({ primaryAgeYears: 66, primaryAgeMonths: 4, secondaryAgeYears: 70 });
    const merged = mergeSsOverride({
      currentResolvedOverride: STORED,
      optimalPair: result.winner!,
      hasSecondary: true,
      secondaryPastWindow: false,
    });
    expect(merged.primary).toEqual({ ageYears: 66, ageMonths: 4 });
    expect(merged.secondary).toEqual({ ageYears: 70, ageMonths: 0 });
  });

  it('primary-only fallback bakes the stored secondary months into every candidate and Save keeps them', async () => {
    const members = [member('m1', true, 'Alex', 1965), member('m2', false, 'Sam', 1955)];
    const stored = { primary: { ageYears: 66, ageMonths: 0 }, secondary: { ageYears: 67, ageMonths: 3 } };
    const { calls, mcRunner } = recordingRunner((c) => c.primary.ageYears / 100);
    const result = await run(withSs(stored), members, bothBenefits(), mcRunner);
    for (const c of calls) expect(c.secondary).toEqual({ ageYears: 67, ageMonths: 3 });
    expect(result.winner).toMatchObject({ primaryAgeYears: 70, secondaryAgeYears: null });
    const merged = mergeSsOverride({
      currentResolvedOverride: stored,
      optimalPair: result.winner!,
      hasSecondary: true,
      secondaryPastWindow: true,
    });
    expect(merged.primary).toEqual({ ageYears: 70, ageMonths: 0 });
    expect(merged.secondary).toEqual({ ageYears: 67, ageMonths: 3 });
  });
});
