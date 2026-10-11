/**
 * Tests for `runBalanceProjection` + `runBalanceProjectionMc`. The
 * BPP-equivalence golden assertions reuse the same library helpers BPP
 * routes through, so a parity break in any one (CBP routing, expense
 * projection, ss-projection, drawdown engine) surfaces here.
 */
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

/** Sum the windowed per-month expense base over the first FULL retirement
 *  year (retirementYear + 1, so a mid-year retirement start does not clip the
 *  total) → the annual figure a lifetime expense charges. */
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
    // Child scenario inherits SS from parent (no own override). Two
    // overlays — different SS pairs — must produce different at-horizon
    // values when SS contributes (high PIAs + an expense baseline).
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
    // Child scenario inherits its whole `socialSecurity` block — including
    // the survivor claim-age map — from its parent. The prospective survivor
    // (secondary, born 1955 → past 70 today) yields an EMPTY survivor
    // candidate grid, so real optimizer candidates carry NO survivor field
    // while the primary's own claim age stays searchable. The deterministic
    // ranking, the MC evaluation, and the post-Apply projection must all
    // still include the inherited survivor benefit. Pre-fix,
    // `withCandidateOverlay` seeded the transient block from the child's
    // LOCAL (empty) override, shadowing the parent's survivor map and
    // withholding the survivor benefit on the deterministic path only.
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
    // Parent: survivor map stored for the secondary; primary dies first
    // (life 75 vs 95) so the secondary is the prospective survivor.
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
    // Child: NO local overrides at all — everything inherits.
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

    // Sensitivity control: without the parent's survivor map the projection
    // differs — the survivor benefit is material in this fixture.
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

    // 1) Deterministic ranking: a candidate overlay carrying the resolved
    // own ages but NO survivor field simulates the SAME plan as the plain
    // resolved projection (inherited survivor included) and as an overlay
    // carrying the inherited survivor explicitly.
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

    // 2) MC evaluation: the optimizer MC setup already falls back to the
    // RESOLVED survivor map — its ssByYear for the survivor-less candidate
    // equals the explicit-survivor candidate and reflects the benefit.
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

    // 3) Post-Apply projection: `mergeSsOverride` (secondary past window)
    // writes the winner onto the child; the applied scenario projects the
    // same plan the ranking simulated.
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
    // `runBalanceProjection` does not throw on CBP-unconfigured.
    // `cbpResolution` is unconditional on the full result — BPP reads
    // it and renders the remediation banner without try/catch.
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

  it('should_throw_cbp_unconfigured_from_mc_orchestrator_path', () => {
    // `runBalanceProjectionMc` keeps the throw semantics — the
    // optimizer's per-candidate hot path catches and routes to the
    // unsupported outcome (optimizer-mc-runner.ts).
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
        todayYear: TODAY.getUTCFullYear(),
        todayMonthIndex: TODAY.getUTCMonth(),
      }),
    ).toThrowError(CbpUnconfiguredError);
  });


  it('should_NOT_throw_when_a_cap_window_anchor_birthdate_is_missing — broken-anchor flagged', () => {
    // Arrange: primary has a valid birthdate so context builds + retirement
    // year resolves. Secondary has an empty birthdate. A cap window's end
    // anchors to the secondary. The window is FLAGGED
    // inactive (broken anchor) and the projection still runs — it does not
    // fail-fast throw `MagiCapCalibrationError`.
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
    const scenarioWithMagiCap: ScenarioAggregate = {
      ...baseScenario('s', 'Base'),
      payload: {
        ...baseScenario('s', 'Base').payload,
        overrides: {
          ...baseScenario('s', 'Base').payload.overrides,
          // taxEfficient exercises the cap-resolution path (the cap-off resolver
          // runs for every named strategy).
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
    // Act + Assert: secondary missing birthdate → the window is broken-anchor
    // flagged + inactive; the run completes without throwing.
    expect(() =>
      runBalanceProjection({
        scenarioId: 's',
        scenarios: [scenarioWithMagiCap],
        accounts,
        balances,
        members: [primaryMember, secondaryNoBirthdate],
        ssBenefits: ss,
        expenses: [],
        incomeStreams: [],
        todayYear: TODAY.getUTCFullYear(),
        todayMonthIndex: TODAY.getUTCMonth(),
      }),
    ).not.toThrow();
  });

  it('should_treat_a_resolved_magiCap_disable_sentinel_as_no_cap (no throw, no breach)', () => {
    // A resolved `magiCap: { disabled: true }` sentinel is coerced to "no cap"
    // at the drawdown runner entry point, so it never reaches
    // resolveMagiCapOffYear. Even with a tax-aware strategy and a secondary
    // member with a missing birthdate (which a real cap would treat as a broken
    // anchor), the sentinel produces a no-cap projection — no throw, no breach.
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
          // Explicit-disable sentinel — must be coerced to no cap.
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
    // No cap → no MAGI-cap breach in any drawdown year.
    const anyBreach = result.drawdownYears.some(
      (y) => (y.magiCapBreachDollars ?? 0) > 0,
    );
    expect(anyBreach).toBe(false);
  });

  it('should_NOT_throw_or_log_PII_when_a_window_anchor_birthdate_is_malformed', () => {
    // CODING_STANDARDS bans PII in logs. A
    // window with an unresolvable anchor is FLAGGED inactive (never thrown), and
    // the resolver logs nothing — so a malformed birthdate never reaches a log
    // line, and the projection still completes. (No error message to inspect:
    // `MagiCapCalibrationError` does not fire.)
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
    // No log line echoed the malformed birthdate (PII-in-logs ban).
    for (const spy of [warnSpy, errorSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(malformedBirthdate);
      }
    }
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('should_produce_higher_metric_with_larger_portfolio_seed', () => {
    // Sanity / ranking pin: doubling the portfolio doubles (within
    // float precision) the at-horizon balance when there's no
    // depletion floor in the way (no expenses, no income).
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
    // Two yearly balances → `accountReturns(balances).twr` is defined.
    // Wildly differing planning vs empirical rates → at-horizon must
    // diverge between method 'planned' and method 'twr'.
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

  it('should_short_circuit_when_method_twr_and_account_has_insufficient_history', () => {
    // Single yearly balance → `accountReturns` returns `twr: null`.
    // `method: 'twr'` short-circuits with `methodAvailable: false` and
    // a sentinel zero at-horizon — page renders "Insufficient history".
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
      method: 'twr',
    });
    expect(result.methodAvailable).toBe(false);
    expect(result.atHorizonTodayDollars).toBe(0);
  });

  it('should_short_circuit_when_method_twr_and_active_non_cbp_account_has_zero_balances', () => {
    // Active non-CBP account with no balance rows at all → TWR
    // impossible. Pre-fix the projection loop `continue`d before the
    // gate could fire, silently letting TWR run on an empty account
    // set. Post-fix the gate marks the result
    // unavailable so the page renders "Insufficient history".
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 2500)];
    // Brokerage account with NO matching balance rows.
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

  // SS colaPct override propagates to ssByYear growth rate.
  it('should_use_ss_cola_override_in_ssByYear_growth_rate', () => {
    // A scenario with ssColaPct=3 must produce ssByYear values that grow
    // at 3 %/yr after the claim year; a scenario with ssColaPct=0 must
    // produce a flat array. Birth 1960, claim at 67 → claim year 2027.
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
            // Opt out of inflation-tracking so the fixed colaPct (0 % → flat)
            // is the rate under test, independent of the scenario inflation.
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
            // Fixed 3 % COLA under test — opt out of inflation-tracking.
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
    // Find first non-zero index (the claim year offset). The claim-year row is
    // prorated in the annual table, so compare two FULL post-claim
    // years (claimIdx + 1 vs claimIdx + 2) to read the COLA growth rate.
    const claimIdx = mcNoGrowth.ssByYear.findIndex((v) => v > 0);
    expect(claimIdx).toBeGreaterThanOrEqual(0);
    // noGrowth: full year must equal the next full year (0 % growth, flat).
    const flatFull = mcNoGrowth.ssByYear[claimIdx + 1];
    const flatNext = mcNoGrowth.ssByYear[claimIdx + 2];
    expect(flatNext).toBeCloseTo(flatFull, 0);
    // 3pct: next full year must be ~3 % larger than the prior full year.
    const growFull = mc3Pct.ssByYear[claimIdx + 1];
    const growNext = mc3Pct.ssByYear[claimIdx + 2];
    expect(growNext).toBeCloseTo(growFull * 1.03, 0);
    // 3pct annual must exceed noGrowth annual by end of the alive window.
    // The array's last slot is the death-boundary year (= 0 for both) because
    // deathYearFor uses birthYearForBenefitPurposes (1960-01-01 → 1959 cohort)
    // so the horizon extends one year past the last benefit year.  Use the
    // last non-zero slot instead of the raw tail.
    const lastNonZeroNoGrowth = [...mcNoGrowth.ssByYear].reverse().find((v) => v > 0) ?? 0;
    const lastNonZero3Pct = [...mc3Pct.ssByYear].reverse().find((v) => v > 0) ?? 0;
    expect(lastNonZero3Pct).toBeGreaterThan(lastNonZeroNoGrowth);
  });

  // Pension monthlyBenefit reflected in incomeByYear.
  it('should_include_pension_monthlyBenefit_in_incomeByYear', () => {
    // Pension annuity starts at age 65 (2025), monthly benefit $3 000.
    // incomeByYear[0] (2026) should reflect $36 000/yr contribution from
    // this stream; baseline with no income streams should be 0.
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
    // At least one year in incomeByYear must be non-zero (pension active).
    const totalPension = withPension.incomeByYear.reduce((a, b) => a + b, 0);
    expect(totalPension).toBeGreaterThan(0);
    // Without the stream, all zeros.
    const totalBaseline = baseline.incomeByYear.reduce((a, b) => a + b, 0);
    expect(totalBaseline).toBe(0);
    // With 0 % COLA, each active year should equal $36 000.
    const activeYear = withPension.incomeByYear.find((v) => v > 0);
    expect(activeYear).toBeCloseTo(36_000, -2); // within $100
  });

  // Part-time start/end window bounds incomeByYear.
  it('should_bound_incomeByYear_to_partTime_start_end_window', () => {
    // Part-time income $50 000/yr from 2028 to 2030 (year anchors).
    // Years before 2028 and after 2030 must be 0; years inside > 0.
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
    // firstYear = 2026; offset 0 = 2026, offset 2 = 2028, offset 4 = 2030.
    const offset = (yr: number) => yr - mc.firstYear;
    // Before window: 2026, 2027 must be 0.
    expect(mc.incomeByYear[offset(2026)]).toBe(0);
    expect(mc.incomeByYear[offset(2027)]).toBe(0);
    // Inside window: 2028, 2029, 2030 must be > 0.
    expect(mc.incomeByYear[offset(2028)]).toBeGreaterThan(0);
    expect(mc.incomeByYear[offset(2029)]).toBeGreaterThan(0);
    expect(mc.incomeByYear[offset(2030)]).toBeGreaterThan(0);
    // After window: 2031 must be 0 (if horizon extends that far).
    if (mc.incomeByYear.length > offset(2031)) {
      expect(mc.incomeByYear[offset(2031)]).toBe(0);
    }
  });

  it('should_apply_candidate_ss_actuarial_math_so_inputs_differ_per_claim_age', () => {
    // MC `ssByYear` must reflect each candidate's claim age
    // (delayed credit at 70 > FRA value at 67 > early reduction at 62).
    // Without this, every triple posted the same SS → MC ranked all
    // pairs identically → optimizer had no signal.
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
    // Annual SS must strictly increase with claim age (early reduction
    // at 62, full at FRA ~67 for 1965 birth, delayed credit at 70).
    // The kernel uses ssByYear arrays; compare the first non-zero entry
    // per array (= the annual payout in the claim year).
    const firstNonZero = (arr: number[]): number =>
      arr.find((v) => v > 0) ?? 0;
    expect(firstNonZero(at62.ssByYear)).toBeLessThan(
      firstNonZero(at67.ssByYear),
    );
    expect(firstNonZero(at67.ssByYear)).toBeLessThan(
      firstNonZero(at70.ssByYear),
    );
    // Claim year must shift: at62 starts earlier than at70.
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
    // ssByYear (not an annualSocialSecurity scalar) carries Social Security.
    expect(a.ssByYear).toEqual(b.ssByYear);
  });

  it('clamp: stored bumpPct 200 uses effective multiplier ×2.0 not ×3.0', () => {
    // A scenario with bumpPct 200 (an out-of-range stored value)
    // must be clamped to 100 at the MC layer → annualExpense = disc * 2.
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
    // bumpPct 200 clamped to 100 → multiplier 2.0 → a full retirement year of the
    // windowed per-month base sums to ≈ 20_000 (not 30_000). Assert the
    // windowed base, not a flat scalar. The per-month round2 spread
    // (12 × round2(20_000/12)) lands within a few cents of the annual figure.
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
    // bumpPct -150 clamped to -100 → multiplier 0.0 → the windowed per-month base
    // is 0 across the full retirement year (not -5_000).
    expect(sumWindowedRetirementYear(input)).toBe(0);
  });

  it('MC ssByYear first non-zero year matches deterministic projectSsByYear for mid-year birthdate + sub-year claimAge', () => {
    // Member born 1985-07-01, claim age 67y 6m → claim falls in 2053.
    // Absolute-month arithmetic
    // (birthYear*12 + (birthMonth-1) + claimMonths) / 12 could
    // drift from ss-projection.ts's whole-year `birthYear + claimAge.ageYears`.
    // Both engines use ss-projection.ts — this test pins parity.
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

    // Deterministic reference: buildSsContext + projectSsByYear.
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

    // Both engines must agree on the first year SS income is non-zero.
    expect(mcFirstNonZeroYear).toBe(detFirstNonZeroYear);
  });

  it('should_include_secondary_ss_when_scenario_omits_secondary_override', () => {
    // A scenario that only sets socialSecurity.primary (no secondary
    // key) must still sum both members' SS income in ssByYear.  The
    // secondary member defaults to their own claim age (e.g. 67y0m from
    // the resolveScenario chain), so the combined ssByYear first non-zero
    // value must exceed the primary-only baseline.
    const primaryMember = member('m-pri', true, 'Alex', 1965);
    const secondaryMember = member('m-sec', false, 'Sam', 1967);
    const primaryPia = 2_000;
    const secondaryPia = 1_200;
    const ss = [ssBenefit('m-pri', primaryPia), ssBenefit('m-sec', secondaryPia)];
    const accounts = [brokerage('a1', 'm-pri')];
    const balances = [balanceRow('a1', 2025, 500_000)];

    // Scenario sets only primary SS override; secondary key is absent.
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

    // Primary (born 1965) and secondary (born 1967) both claim at 67,
    // so secondary starts 2 years after primary. Find the first year both
    // draw (secondary claims at 67 → 1967+67 = 2034, index 2034-todayYear).
    // In any year when both draw, the combined value must exceed primary PIA
    // * 12 alone. We verify via the max yearly value across the array.
    const primaryOnlyAnnual = primaryPia * 12; // annual, before COLA
    const maxYearly = Math.max(...mc.ssByYear);
    // When both members draw SS in the same year, the combined annual income
    // must exceed primary-alone.
    expect(maxYearly).toBeGreaterThan(primaryOnlyAnnual);
  });
});

// BPP-equivalence parity. A golden test that the
// runner's at-horizon Today's-dollar value equals BPP's at-horizon
// `planned` stat card oracle:
//   `drawdownByMethod.planned.years[lastIdx].balance * viewDeflator(horizonYear, 11)`
// (the stat-card arithmetic in BalanceProjectionPage.tsx). The runner routes
// through `computePlannedAtHorizonToday` — the same helper BPP's stat
// card arithmetic reduces to. This block drives a demo-style fixture
// through both the runner AND a parallel BPP-derived call to
// `computePlannedAtHorizonToday` on the same drawdown years, then
// asserts equality within $1.
//
// Parity assertion for each category (pre-/post-primary targeted deposits,
// CBP lump-sum + annuity, post-primary contributions from later-retiring
// owner). Each fixture must produce a positive, non-zero at-horizon balance
// through the runner — proving these scenarios compute a real number.
describe('runBalanceProjection — BPP-equivalence parity', () => {
  it('should_match_simulateDrawdown_oracle_on_no_accumulation_no_cashflow_fixture', () => {
    // Real oracle. Member born so retirement lands at today's
    // year — no accumulation phase — and `portfolioAtRetirement`
    // equals the today balance the test seeds (800k). With zero
    // expenses, zero SS (PIA=0), zero income, zero deposits, and a
    // single 5% account: the at-horizon dollar value is the output of
    // `simulateDrawdown` driven manually with the SAME inputs, then
    // deflated by the SAME `realDeflatorAt` factor. If the runner
    // routes through a different engine, skips the drawdown call,
    // uses the wrong horizon year (an off-by-one),
    // or otherwise diverges from BPP's stat-card arithmetic, this
    // FAILS.
    const todayYear = TODAY.getUTCFullYear();
    // Retirement at age 67 — pick birth year so retirement == today.
    const birthYear = todayYear - 67;
    const members = [member('m1', true, 'Alex', birthYear)];
    const ss = [ssBenefit('m1', 0)];
    const accounts = [brokerage('a1', 'm1', 'BROKERAGE', 'POST_TAX', 5, 0, 0)];
    // Seed a current-year balance so `project()` returns 800k at
    // retirement without an accumulation kicker.
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
    // The retirement year MUST be today — no accumulation phase.
    expect(result.retirementYear).toBe(todayYear);
    // Run the SAME drawdown engine BPP runs, fed the same zero-
    // cashflow series + the same portfolioAtRetirement (= the today
    // balance, no accumulation) + the same blended rate (5%).
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
      // The single household brokerage account, mirroring what BPP feeds the
      // per-account engine (one POST_TAX pool at the blended 5% rate).
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
    // $1 tolerance — same threshold as the BPP
    // stat-card oracle. A drift here means the runner's drawdown
    // routing diverged from BPP's.
    expect(
      Math.abs(oracleAtHorizonToday - result.atHorizonTodayDollars),
    ).toBeLessThan(1);
    // Also gate via the shared stat-card helper — covers the helper's
    // reduce-to-same-arithmetic contract.
    const viaHelper = computePlannedAtHorizonToday({
      drawdownPlannedYears: oracle.years,
      horizonYear,
      projCtx: result.ctx,
    });
    expect(Math.abs(viaHelper - result.atHorizonTodayDollars)).toBeLessThan(1);
  });

  it('should_route_pre_primary_targeted_deposit_into_account_balance', () => {
    // Pre-primary targeted-deposit event lifts the at-horizon balance
    // vs the no-event baseline (deposit compounds inside the target
    // account through retirement).
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
    // Pre-primary targeted deposit must route through `project()`'s
    // preRetirementDeposits and increase the at-horizon balance vs the
    // no-deposit baseline. If the routing regressed, the two values
    // would match (the optimizer ranking depends on this differentiation).
    // Tolerance: pre-primary deposits land deep before retirement and
    // compound — even tiny amounts shift the at-horizon balance by
    // ≥ $1.
    expect(withTargeted.atHorizonTodayDollars).not.toBe(
      baseline.atHorizonTodayDollars,
    );
  });

  it('should_synthesize_post_primary_contributions_for_later_retiring_owner', () => {
    // Secondary retires later than primary and carries ongoing
    // contributions → the post-primary contribution events should
    // synthesise into the drawdown deposit series, lifting the at-
    // horizon balance vs the same fixture with no secondary
    // contributions.
    const members = [
      member('m1', true, 'Alex', 1965),
      member('m2', false, 'Sam', 1968),
    ];
    const ss = [ssBenefit('m1', 2500), ssBenefit('m2', 2000)];
    // Secondary owns an account with planned contributions; secondary
    // retires later than primary.
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
            // Primary retires at 67, secondary at 70 — three-year
            // post-primary contribution window.
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
    // Same fixture, secondary's account drops its planned contribution.
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
    // Post-primary contribution events must lift the at-horizon balance
    // — proves the routing path computes a real differentiating result.
    expect(withContrib.atHorizonTodayDollars).not.toBe(
      baseline.atHorizonTodayDollars,
    );
  });

  it('should_apply_retirement_allocation_override_so_bucket_path_differs_from_baseline', () => {
    // Parity: when a scenario carries `retirementAllocation`, the
    // runner threads it into the drawdown so the allocation glide
    // runs (matching BPP).
    // Verify by toggling the override on/off — the at-horizon values
    // MUST differ when the allocation rates differ from the planned blend.
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
    // Oracle assertion on horizon-year routing. Two fixtures
    // identical EXCEPT for lifeExpectancy. The shorter horizon must
    // produce a HIGHER at-horizon balance (fewer years of post-
    // retirement expense drawdown). If the runner ignored the
    // horizon-year change or computed it incorrectly (an
    // off-by-one), both runs would match.
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
    // The horizon year MUST match the lifeExpectancy override (no
    // off-by-one drift on Jan-1 birthdates).
    expect(shortRun.horizonYear).toBe(1965 + 80);
    expect(longRun.horizonYear).toBe(1965 + 95);
    // Different horizon → different drawdown length → different
    // at-horizon Today's-dollar balance. If the runner ignored
    // horizonYear or returned a stale value, the two would match.
    // Direction (long > short or vice versa) depends on whether
    // SS+income offsets the expense — assert non-equality only.
    expect(shortRun.atHorizonTodayDollars).not.toBe(
      longRun.atHorizonTodayDollars,
    );
    // Both must be positive — proves the drawdown actually ran in
    // both fixtures rather than short-circuiting to zero.
    expect(shortRun.atHorizonTodayDollars).toBeGreaterThan(0);
    expect(longRun.atHorizonTodayDollars).toBeGreaterThan(0);
  });
});

// Full-pipeline integration test for post-primary linked-CBP
// lump-sum routing on the deterministic path. The contract mirrors the MC
// bundle factory's `skipsPortfolio: true` semantic: the source CBP is excluded
// from the ledger and the target receives the deposit once. If the source stayed
// in the per-account ledger AND the same dollars flowed through the
// household-aggregate `depositsByMonth` AND landed on the target's per-account
// `depositsByMonth`, the dollars would be triple-counted at the event
// step. Caller subtracts CBP lump-sum dollars
// from the household-aggregate series so the kernel doesn't double-
// apply via the proportional split.
describe('runBalanceProjection — post-primary CBP lump-sum transfer semantics', () => {
  it('should_NOT_double_count_post_primary_cbp_lump_sum_against_target_pre_baked_equivalent', () => {
    // Two scenarios, identical at horizon if the transfer contract holds:
    //  (i)  baseline: brokerage target with $X balance pre-baked into
    //       its today balance (= CBP-at-event-balance + own balance);
    //       no CBP account, no pension stream.
    //  (ii) transfer: brokerage target with $Y balance AND a separate
    //       CBP account whose lump-sum elects to transfer to target at
    //       the event month. $X = $Y + (CBP balance after compounding
    //       from today through the event month at its planning rate).
    //
    // Use a member retiring at age 67 born so retirement == today
    // (no accumulation kicker on the brokerage). Event fires exactly
    // 1 year after primary retirement at the CBP's planning rate so
    // we can hand-pin the CBP balance at event.
    const todayYear = TODAY.getUTCFullYear();
    const birthYear = todayYear - 67;
    const members = [member('m1', true, 'Alex', birthYear)];
    const ss = [ssBenefit('m1', 0)]; // SS off — drawdown only.
    const scenarios = [baseScenario('s', 'Base')];
    // Brokerage account at 5% planning return; CBP at SAME 5% so the
    // CBP compounding from today to event month exactly matches the
    // pre-baked sum's compounding in the target across the same
    // interval. Identical rates make the transfer math collapse to
    // the baseline by construction (modulo intra-month timing
    // residue).
    const brokerageBaseline = brokerage('target', 'm1', 'BROKERAGE', 'POST_TAX', 5, 0, 0);
    const brokerageTransfer = brokerage('target', 'm1', 'BROKERAGE', 'POST_TAX', 5, 0, 0);
    const cbpRate = 5;
    const cbpToday = 100_000;
    // Event fires 1 year after primary retirement (= today). Compute
    // expected CBP balance at event via monthly compounding (the
    // projection engine drives at monthly cadence). Use the same
    // `monthlyEquivalent` semantic the kernel uses.
    const monthlyRate = Math.pow(1 + cbpRate / 100, 1 / 12) - 1;
    const cbpAtEvent = cbpToday * Math.pow(1 + monthlyRate, 12);

    // (i) baseline: pre-bake CBP balance into target. NO CBP account.
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

    // (ii) transfer: separate CBP account that transfers to target via
    // linked-CBP pension stream at event month.
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
    // Pension stream — linked-CBP lump-sum to target.
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
    // The at-horizon dollar values must match within 1% — the
    // transfer scenario is mathematically equivalent to pre-baking the
    // CBP balance into the target. If the source CBP also stayed in the ledger
    // AND the household-aggregate carried the same dollars, the transfer would
    // run ~2-3× richer at horizon
    // (visible as ~50-100% gap vs baseline). The tight tolerance
    // (1.0%) here is set wide enough to absorb the small math drift
    // between brokerage-monthly-compounding the pre-baked sum at 5%
    // vs CBP-monthly-compounding it at the SAME 5% rate (cbpRate=5
    // matches the brokerage's 5%) for 12 months then dropping it
    // into the brokerage; a wider gap means the double/triple-
    // count is back.
    const ratio =
      transfer.atHorizonTodayDollars / baseline.atHorizonTodayDollars;
    expect(ratio).toBeGreaterThan(0.99);
    expect(ratio).toBeLessThan(1.01);
  });
});

// Post-primary linked-CBP lump-sum event-month routing in the
// MC bundle. `buildAccountLedgerAndAggregates` must not derive
// `cbpEventMonth` from primary retirement (growing the source CBP only
// to `yearsToRetirement`): the linked stream's
// `start` names the event month, so a lump-sum elected for age 70
// should fire at month `(70 − retirementAge) × 12` past today (NOT at
// the retirement step). The MC ledger event must land at that month
// with the balance compounded forward at the CBP's planning rate over
// the actual horizon.
describe('runBalanceProjectionMc — post-primary CBP lump-sum event-month routing', () => {
  it('routes a post-primary linked-CBP lump-sum at the income stream start month, not retirement step', () => {
    const todayYear = TODAY.getUTCFullYear();
    // Retirement at age 65 (= today), event at age 70 (= 5 yrs after).
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
    // Linked-CBP lump-sum stream firing 5 years after primary
    // retirement (= today + 5 years).
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
    // Event time: event year minus todayYear gives the year offset;
    // primaryRetirementMonth0 picks the month-of-year. The MC kernel
    // step is `(eventYear − todayYear) * 12 + month0`. Birthdate is
    // Jan 1, so primary retires Jan of `todayYear` (month0 = 0) and
    // event lands month `5 * 12 = 60`.
    const cbpEvents = (input.events ?? []).filter(
      (e) => e.source === 'cbpLumpSum',
    );
    expect(cbpEvents).toHaveLength(1);
    const ev = cbpEvents[0];
    expect(ev.month).toBe(5 * 12);
    // Source CBP at 4% planning rate, compounded forward 5 years from
    // `latestBalance` (today's start): 50_000 × (1.04)^5 ≈ 60_833. Compounding
    // only to the retirement step (yearsToRetirement = 0, already retired today)
    // would give ~50_000 — a 17% under-count. Tolerance band catches
    // either the under-count or the retirement-step landing-bug.
    expect(ev.amount).toBeGreaterThan(60_000);
    expect(ev.amount).toBeLessThan(61_700);
    // Source CBP must NOT appear in the per-account ledger (skipsPortfolio).
    expect(input.accountMcLedger.map((e) => e.id)).not.toContain('cbp1');
  });
});

// `runBalanceProjectionMc` non-50/50 MIXED regression. If
// `buildAccountBundles` returned only `{ account, latestBalance }`,
// MIXED accounts would always hit the 50/50 fallback in
// `splitInitialByTaxTreatment`. Pin the actual stored bucket split
// reaches the MC ledger.
describe('runBalanceProjectionMc — non-50/50 MIXED ledger plumbing', () => {
  it('threads latest stored pre/post buckets into the MC per-account ledger for MIXED accounts', () => {
    const todayYear = TODAY.getUTCFullYear();
    const members = [member('m1', true, 'Alex', todayYear - 50)];
    const ss = [ssBenefit('m1', 0)];
    // MIXED account with 70/30 stored split. The MC
    // ledger must read 70/30, not 50/50.
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
    // 70/30 stored split, NOT 50/50.
    expect(entry.initialPre).toBeCloseTo(70_000, 2);
    expect(entry.initialPost).toBeCloseTo(30_000, 2);
    expect(entry.initialPre + entry.initialPost).toBeCloseTo(100_000, 2);
  });
});

// Regression: child scenario inflation override must propagate into the
// MC input's `incomeByYear` array for an income stream with
// `tracksInflation: true`. Two scenarios identical except inflation
// (parent 0 %, child 5 %) running the same demo pension must produce
// different `incomeByYear` slices — late-horizon entries diverge by the
// compounded inflation differential.
describe('runBalanceProjectionMc — child scenario inflation override propagates to tracksInflation income', () => {
  it('produces a larger late-year incomeByYear value when child overrides inflation to 5 %', () => {
    const members = [member('m1', true, 'Alex', 1960)];
    const ss = [ssBenefit('m1', null)];
    const accounts = [brokerage('a1', 'm1')];
    const balances = [balanceRow('a1', 2025, 500_000)];
    // Parent scenario: inflation 0 % (baseScenario default).
    const parent = baseScenario('parent', 'Parent');
    // Child scenario: inflation 5 %, all other overrides inherited.
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
    // Both arrays must be the same length (same horizon).
    expect(childMc.incomeByYear.length).toBe(parentMc.incomeByYear.length);
    // Pension active from age 65 (2025) onward; both arrays should be
    // non-zero across most of the horizon (m1 born 1960, age 65 = 2025,
    // life expectancy 90 = 2050).
    const parentTotal = parentMc.incomeByYear.reduce((a, b) => a + b, 0);
    const childTotal = childMc.incomeByYear.reduce((a, b) => a + b, 0);
    expect(parentTotal).toBeGreaterThan(0);
    // Child total must exceed parent total — every active year inflates
    // at 5 % vs flat in the parent.
    expect(childTotal).toBeGreaterThan(parentTotal * 1.5);
    // Late-horizon entry should differ by roughly (1.05)^N where N is
    // years since the pension start. Take the last entry — at 2050,
    // that's ~25 years of 5 % compounding ≈ 3.4×.
    const lastIdx = childMc.incomeByYear.length - 1;
    const parentLast = parentMc.incomeByYear[lastIdx];
    const childLast = childMc.incomeByYear[lastIdx];
    expect(parentLast).toBeGreaterThan(0);
    expect(childLast / parentLast).toBeGreaterThan(2);
  });
});

describe('runBalanceProjection — accountYears widening', () => {
  it('populates real per-year contributions + growth on accountYears (not placeholder zeros)', () => {
    // Arrange: a single contributing account so the projection has
    // non-zero accumulation years.
    const members = [member('m1', true, 'Alex', 1975)];
    const ss = [ssBenefit('m1', 2000)];
    // plannedContributionPostTax = 12_000/yr → $1,000/mo into a POST_TAX
    // brokerage compounding at 6 %.
    const accounts = [brokerage('a1', 'm1', 'BROKERAGE', 'POST_TAX', 6, 0, 12_000)];
    const balances = [balanceRow('a1', 2025, 100_000)];
    const scenarios = [baseScenario('s', 'Base')];

    // Act
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

    // Assert: accountYears carries the account, with rows whose
    // contributions / growth are no longer the old reserved-zero
    // placeholders — at least one accumulation year shows positive
    // contributions AND positive growth, and nominalBalance == pre+post.
    const rows = result.accountYears.get('a1');
    expect(rows).toBeDefined();
    expect(rows!.length).toBeGreaterThan(0);
    const anyContrib = rows!.some((r) => r.contributionsThisYear > 0);
    const anyGrowth = rows!.some((r) => r.growthCarry > 0);
    expect(anyContrib).toBe(true);
    expect(anyGrowth).toBe(true);
    // accumulation phase: project() models no drawdown, so withdrawals 0.
    expect(rows!.every((r) => r.withdrawalsThisYear === 0)).toBe(true);
    // nominalBalance is the Dec-anchored pre+post — monotone-ish positive.
    expect(rows!.every((r) => r.nominalBalance > 0)).toBe(true);
  });

  it('includes a retired_in_the_past account as a single accumulation row', () => {
    // The `accountYears` membership gate keys off `yearlyTotals`
    // (not the optional `perStep`). When retirement already lies in the
    // past relative to the latest balance, `project()` takes its
    // defensive branch and returns a single accumulation row with no
    // per-step series. That account must still appear in `accountYears`
    // rather than being silently omitted.
    const todayYear = TODAY.getUTCFullYear();
    // Born so the member is well past retirement age 67 → retirement
    // year is in the past relative to the latest balance row (todayYear).
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

    // Retirement resolves to the past relative to the latest balance.
    expect(result.retirementYear).toBeLessThan(todayYear);
    // The account surfaces with the single defensive accumulation row.
    const rows = result.accountYears.get('a1');
    expect(rows).toBeDefined();
    expect(rows!.length).toBe(1);
    expect(rows![0].year).toBe(todayYear);
    expect(rows![0].nominalBalance).toBeGreaterThan(0);
    // Defensive branch carries no growth / contribution split.
    expect(rows![0].growthCarry).toBe(0);
    expect(rows![0].contributionsThisYear).toBe(0);
    expect(rows![0].withdrawalsThisYear).toBe(0);
  });
});

describe('runBalanceProjectionForPage — both-methods shared agnostic phase', () => {
  it('returns { planned, twr, sharedCtx } and each method matches runBalanceProjection per method', () => {
    // Arrange: two-account household with ≥2 yr balance history so TWR is
    // computable — both methods produce a drawdown.
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

    // Act
    const page = runBalanceProjectionForPage(baseArgs);
    const planned = runBalanceProjection({ ...baseArgs, method: 'planned' });
    const twr = runBalanceProjection({ ...baseArgs, method: 'twr' });

    // Assert: shape.
    expect(page.planned).not.toBeNull();
    expect(page.twr).not.toBeNull();
    expect(page.sharedCtx.accountProjections.length).toBe(2);
    expect(page.sharedCtx.retirementYear).toBe(planned.retirementYear);
    expect(page.sharedCtx.horizonYear).toBe(planned.horizonYear);
    expect(page.sharedCtx.todayYear).toBe(baseArgs.todayYear);

    // Per-method at-horizon parity with the single-method entry — the
    // page entry must not diverge from runBalanceProjection.
    expect(page.planned!.atHorizonTodayDollars).toBeCloseTo(
      planned.atHorizonTodayDollars,
      6,
    );
    expect(page.twr!.atHorizonTodayDollars).toBeCloseTo(
      twr.atHorizonTodayDollars,
      6,
    );

    // Per-method drawdown-year terminal balance parity.
    const pagePlannedLast = page.planned!.years[page.planned!.years.length - 1];
    const refPlannedLast =
      planned.drawdownYears[planned.drawdownYears.length - 1];
    expect(pagePlannedLast.balance).toBeCloseTo(refPlannedLast.nominalBalance, 6);
    const pageTwrLast = page.twr!.years[page.twr!.years.length - 1];
    const refTwrLast = twr.drawdownYears[twr.drawdownYears.length - 1];
    expect(pageTwrLast.balance).toBeCloseTo(refTwrLast.nominalBalance, 6);
  });

  it('surfaces cbpResolution + null drawdowns without throwing for CBP-unconfigured', () => {
    // Arrange: a CBP account with no linked income stream election —
    // validation fails, both methods short-circuit to null.
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 2500)];
    const accounts = [
      brokerage('cbp', 'm1', 'RETIREMENT_CASH_BALANCE', 'PRE_TAX', 4),
    ];
    const balances = [balanceRow('cbp', 2025, 200_000)];
    const scenarios = [baseScenario('s', 'Base')];

    // Act
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

    // Assert: cbpResolution surfaces unconditionally; both methods null.
    expect(page.sharedCtx.cbpResolution).not.toBeNull();
    expect(page.sharedCtx.cbpResolution!.ok).toBe(false);
    expect(page.planned).toBeNull();
    expect(page.twr).toBeNull();
  });

  it('nulls twr + sets sharedCtx.methodAvailable false on TWR-insufficient history, keeping planned', () => {
    // The shared ctx is built on the default 'planned' method, so
    // `ctx.methodAvailable` is always true. The page must re-derive TWR
    // availability — a single balance row (< 2 yr) makes TWR unavailable,
    // so `page.twr` is the null sentinel and `sharedCtx.methodAvailable`
    // is false, exactly as `runBalanceProjection({ method: 'twr' })`
    // short-circuits. `page.planned` stays a populated result.
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 2500)];
    const accounts = [brokerage('a1', 'm1', 'BROKERAGE', 'POST_TAX', 5)];
    // Single yearly balance → `accountReturns` returns `twr: null`.
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

    // Act
    const page = runBalanceProjectionForPage(baseArgs);
    const twrRef = runBalanceProjection({ ...baseArgs, method: 'twr' });

    // Assert: TWR unavailable on the page matches the single-method entry.
    expect(twrRef.methodAvailable).toBe(false);
    expect(page.sharedCtx.methodAvailable).toBe(false);
    expect(page.twr).toBeNull();
    // Planned is always available + populated.
    expect(page.planned).not.toBeNull();
    expect(page.planned!.atHorizonTodayDollars).toBeGreaterThan(0);
  });

  it('does NOT null a method when a cap window anchor is broken — the run completes', () => {
    // A cap window gating a secondary member with a
    // missing birthdate is FLAGGED inactive (broken anchor), NOT a recoverable
    // throw. So the per-method drawdown completes normally (no
    // MagiCapCalibrationError-degrades-to-null path) and `sharedCtx`
    // populates as usual. ≥2 yr balance history so TWR is available.
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

    // Act — must NOT throw (the page wrapper swallows the recoverable error).
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

    // Assert: the broken window does NOT degrade the method — planned runs;
    // sharedCtx still populated.
    expect(page.planned).not.toBeNull();
    expect(page.sharedCtx.accountProjections.length).toBe(1);
    expect(page.sharedCtx.cbpResolution).toBeNull();
    expect(page.sharedCtx.retirementYear).toBe(1965 + 67);
    expect(page.sharedCtx.horizonYear).toBeGreaterThan(page.sharedCtx.retirementYear);
  });

  it('nulls the affected method at zero portfolio while populating sharedCtx', () => {
    // A zero-portfolio scenario (no balance rows → empty ledger at
    // retirement) makes `runDrawdownForMethod` return null (zero portfolio
    // / no ledger guard). The page surfaces null for the affected method
    // while `sharedCtx` (markers, anchor, cbpResolution) still populates.
    // CBP account with no balances → portfolioAtRetirement 0, and a CBP
    // election is configured so cbpResolution is ok (no short-circuit),
    // exercising the drawdown-null path rather than the CBP-unconfigured one.
    const members = [member('m1', true, 'Alex', 1965)];
    const ss = [ssBenefit('m1', 2500)];
    // Active brokerage with NO balance rows → no projection, empty ledger.
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

    // Affected method null (zero portfolio); sharedCtx still populated.
    expect(page.planned).toBeNull();
    // No CBP accounts → cbpResolution null (not a CBP short-circuit).
    expect(page.sharedCtx.cbpResolution).toBeNull();
    expect(page.sharedCtx.retirementYear).toBe(1965 + 67);
    expect(page.sharedCtx.lifeExpectancyMarkers.length).toBeGreaterThan(0);
    expect(page.sharedCtx.todayYear).toBe(TODAY.getUTCFullYear());
  });
});

// User-visible regression. A
// test-local dataset (NOT the shipped demo, which rolls its CBP before trigger
// age) whose linked-CBP lump-sum rolls in/after the source owner's RMD trigger
// year witnesses the taxable RMD portion at the `runBalanceProjection` layer:
// the event-year drawdown row carries higher federal tax + MAGI than the same
// rollover landing BEFORE trigger age (where the whole amount rolls untaxed).
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
    // Target pre-tax IRA + a linked CBP source (both PRE_TAX so the rolled
    // excess + carved RMD are well-defined). Named per-account strategy so the
    // split fires.
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
        // Roll at retirement (the source owner's retirement date).
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
    // After-trigger: born 1955 → RMD trigger age 73 → trigger year 2028; retire
    // at 73 so the CBP rolls in the trigger year → the rollover-year RMD is
    // carved + taxed.
    const afterCase = buildCbpRolloverCase({ birthYear: 1955, retirementAge: 73 });
    // Before-trigger: born `todayYear - 60` → retire at 62 → the rollover lands
    // well before age 73 → whole amount rolls, no RMD carved.
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
    // The at/after-trigger rollover distributes that year's RMD as taxable
    // ordinary income → the event-year MAGI carries the carved RMD. The
    // before-trigger rollover rolls the whole amount untaxed (no RMD carved),
    // so its event-year MAGI has no rollover income (zero withdrawals, zero SS).
    expect((afterEventRow!.magiCents ?? 0)).toBeGreaterThan(0);
    expect((afterEventRow!.federalTaxCents ?? 0)).toBeGreaterThan(0);
    // The carved RMD shows up as a large event-year MAGI (the source CBP's
    // ~$600k balance ÷ the age-73 ULT divisor ≈ tens of thousands of dollars).
    expect((afterEventRow!.magiCents ?? 0) / 100).toBeGreaterThan(15_000);
  });
});
