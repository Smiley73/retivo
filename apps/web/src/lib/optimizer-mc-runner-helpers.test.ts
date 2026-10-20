import { describe, expect, it } from 'vitest';
import {
  derivePiaState,
  buildTriples,
  isAlreadyAtOptimum,
  matchesCurrentClaim,
  derivePartial,
  derivePrecheckEmpty,
} from './optimizer-mc-runner-helpers';
import type {
  Aggregate,
  HouseholdMemberPayload,
  SocialSecurityBenefitPayload,
  SocialSecurityOverride,
} from '../db/types';
import type { ScenarioAggregate } from './scenario-resolution';
import type { OptimizerMcWinner } from './optimizer-mc-runner-types';

// ---------------------------------------------------------------------------
// Fixtures (mirrors optimizer-mc-runner.test.ts builder style).
// ---------------------------------------------------------------------------

const TODAY = new Date('2026-06-15T00:00:00Z');

function member(
  id: string,
  isPrimary: boolean,
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
      firstName: isPrimary ? 'Alex' : 'Sam',
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

function scenarioFixture(id: string): ScenarioAggregate {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-19T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'scenario',
    payload: {
      name: id,
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides: {
        socialSecurity: { primary: { ageYears: 67, ageMonths: 0 } },
        retirementAge: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
        },
        inflation: { ratePct: 0 },
        lifeExpectancy: { primary: 90 },
      },
    },
  };
}

const PIA = 3500;
// A member born 1965 is age 61 today → candidate grid 62..70 (9 entries).
const FULL_GRID_PAIRS = 9;

describe('derivePiaState', () => {
  it('marks both members as having a PIA when both benefits carry one', () => {
    // Arrange
    const members = [member('m1', true, 1965), member('m2', false, 1967)];
    const ss = [ssBenefit('m1', PIA), ssBenefit('m2', PIA)];

    // Act
    const state = derivePiaState(members, ss);

    // Assert
    expect(state.primaryHasPia).toBe(true);
    expect(state.secondaryHasPia).toBe(true);
    expect(state.missingPiaMembers).toEqual([]);
  });

  it('lists the secondary in missingPiaMembers when its benefit row is absent', () => {
    // Arrange: only the primary has a benefit row.
    const members = [member('m1', true, 1965), member('m2', false, 1967)];
    const ss = [ssBenefit('m1', PIA)];

    // Act
    const state = derivePiaState(members, ss);

    // Assert
    expect(state.primaryHasPia).toBe(true);
    expect(state.secondaryHasPia).toBe(false);
    expect(state.missingPiaMembers).toEqual(['m2']);
  });

  it('treats an explicit pia: null as missing', () => {
    // Arrange: the secondary has a benefit row but pia is null.
    const members = [member('m1', true, 1965), member('m2', false, 1967)];
    const ss = [ssBenefit('m1', PIA), ssBenefit('m2', null)];

    // Act
    const state = derivePiaState(members, ss);

    // Assert
    expect(state.secondaryHasPia).toBe(false);
    expect(state.missingPiaMembers).toEqual(['m2']);
  });
});

describe('buildTriples', () => {
  it('excludes soft-deleted scenarios and numbers scenarioIdx/pairIdx from one', () => {
    // Arrange: one live scenario, one soft-deleted (deletedAt set).
    const members = [member('m1', true, 1965)];
    const ss = [ssBenefit('m1', PIA)];
    const live = scenarioFixture('live');
    const deleted: ScenarioAggregate = {
      ...scenarioFixture('gone'),
      deletedAt: '2026-05-20T00:00:00Z',
    };

    // Act
    const bundle = buildTriples({
      scenarios: [live, deleted],
      members,
      ssBenefits: ss,
      today: TODAY,
      stepYears: 1,
    });

    // Assert: only the live scenario produces triples; the soft-deleted one is gone.
    expect(bundle.scenarioCount).toBe(1);
    expect(bundle.list.every((t) => t.scenarioId === 'live')).toBe(true);
    expect(bundle.list).toHaveLength(FULL_GRID_PAIRS);
    // scenarioIdx is 1-based and uniform; pairIdx runs 1..9 in grid order.
    expect(bundle.list.every((t) => t.scenarioIdx === 1)).toBe(true);
    expect(bundle.list.map((t) => t.pairIdx)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(bundle.list[0].primaryAgeYears).toBe(62);
    expect(bundle.list[8].primaryAgeYears).toBe(70);
    expect(bundle.preSeededOutcomes).toEqual([]);
  });

  it('pre-seeds a zero-triple outcome when both grids are empty (no PIA / window passed)', () => {
    // Arrange: a primary with no PIA → empty primary grid; no secondary.
    // The scenario still resolves a retirement date, so this routes to the
    // past-window / missing-pia pre-seed, NOT no-retirement-date.
    const members = [member('m1', true, 1965)];
    const ss = [ssBenefit('m1', null)];

    // Act
    const bundle = buildTriples({
      scenarios: [scenarioFixture('s1')],
      members,
      ssBenefits: ss,
      today: TODAY,
      stepYears: 1,
    });

    // Assert: no triples queued; one pre-seeded result outcome (winner: null).
    expect(bundle.list).toHaveLength(0);
    expect(bundle.preSeededOutcomes).toHaveLength(1);
    const pre = bundle.preSeededOutcomes[0];
    expect(pre.scenarioId).toBe('s1');
    expect(pre.outcome.kind).toBe('result');
    if (pre.outcome.kind !== 'result') throw new Error('expected result');
    expect(pre.outcome.winner).toBeNull();
    expect(pre.outcome.missingPiaMembers).toEqual(['m1']);
  });

  it('routes an empty grid with no resolved retirement date to the no-retirement-date outcome, not missing-pia', () => {
    // Arrange: valid birthdate (precheck passes) but the scenario chain has
    // no retirementAge override AND no PIA → empty grid. The scenario-aware
    // probe must emit `empty: no-retirement-date`, not the Add-PIAs result.
    const members = [member('m1', true, 1965)];
    const ss = [ssBenefit('m1', null)];
    const noRetirementAge: ScenarioAggregate = {
      ...scenarioFixture('s1'),
      payload: {
        ...scenarioFixture('s1').payload,
        overrides: {
          socialSecurity: { primary: { ageYears: 67, ageMonths: 0 } },
          inflation: { ratePct: 0 },
          lifeExpectancy: { primary: 90 },
        },
      },
    };

    // Act
    const bundle = buildTriples({
      scenarios: [noRetirementAge],
      members,
      ssBenefits: ss,
      today: TODAY,
      stepYears: 1,
    });

    // Assert: discriminator is `empty` / `no-retirement-date` (not `result`).
    expect(bundle.list).toHaveLength(0);
    expect(bundle.preSeededOutcomes).toHaveLength(1);
    expect(bundle.preSeededOutcomes[0].outcome).toEqual({
      kind: 'empty',
      reason: 'no-retirement-date',
    });
  });

  it('shrinks the candidate grid when stepYears sub-samples it', () => {
    // Arrange: same single-member household, stepYears = 3 sub-samples
    // 62..70 (9 ages) down to indices 0,3,6 → 62, 65, 68.
    const members = [member('m1', true, 1965)];
    const ss = [ssBenefit('m1', PIA)];

    // Act
    const bundle = buildTriples({
      scenarios: [scenarioFixture('s1')],
      members,
      ssBenefits: ss,
      today: TODAY,
      stepYears: 3,
    });

    // Assert: fewer triples than the full grid; ages match the sub-sample,
    // plus the stored 67 (off the sub-sampled grid) as the extra candidate.
    expect(bundle.list.length).toBeLessThan(FULL_GRID_PAIRS);
    expect(bundle.list.map((t) => t.primaryAgeYears)).toEqual([62, 65, 68, 67]);
  });

  it('every triple carries the stored survivor claim age VERBATIM', () => {
    // Two-member household; the secondary (born 1970 → later benefit-cohort
    // death) is the prospective survivor. An in-window stored 62y6m rides
    // every triple untransformed (verbatim-or-inert — never rounded or
    // clamped), so MC evaluates exactly the map Apply preserves.
    const members = [member('m1', true, 1965), member('m2', false, 1970)];
    const ss = [ssBenefit('m1', PIA), ssBenefit('m2', 1_000)];
    const scenario = scenarioFixture('s1');
    scenario.payload.overrides.socialSecurity = {
      primary: { ageYears: 67, ageMonths: 0 },
      secondary: { ageYears: 67, ageMonths: 0 },
      survivor: { secondary: { ageYears: 62, ageMonths: 6 } },
    };

    const bundle = buildTriples({
      scenarios: [scenario],
      members,
      ssBenefits: ss,
      today: TODAY,
      stepYears: 1,
    });

    expect(bundle.list.length).toBeGreaterThan(0);
    for (const triple of bundle.list) {
      expect(triple.overlay.socialSecurity.survivor).toEqual({
        secondary: { ageYears: 62, ageMonths: 6 },
      });
    }
  });

  it('an out-of-window stored survivor age leaves the dimension inert on every triple', () => {
    // Stored 58 is below the 60–70 widow(er) window → the grid is INERT
    // (never a clamped 60): triples carry NO survivor field, so MC falls
    // back to the resolved stored section — the same value the
    // deterministic overlay and Apply read — and the paths cannot diverge.
    const members = [member('m1', true, 1965), member('m2', false, 1970)];
    const ss = [ssBenefit('m1', PIA), ssBenefit('m2', 1_000)];
    const scenario = scenarioFixture('s1');
    scenario.payload.overrides.socialSecurity = {
      primary: { ageYears: 67, ageMonths: 0 },
      secondary: { ageYears: 67, ageMonths: 0 },
      survivor: { secondary: { ageYears: 58, ageMonths: 0 } },
    };

    const bundle = buildTriples({
      scenarios: [scenario],
      members,
      ssBenefits: ss,
      today: TODAY,
      stepYears: 1,
    });

    expect(bundle.list.length).toBeGreaterThan(0);
    for (const triple of bundle.list) {
      expect(triple.overlay.socialSecurity.survivor).toBeUndefined();
    }
  });

  describe('the stored claim-age pair (extra triple)', () => {
    const monthLevel: SocialSecurityOverride = {
      primary: { ageYears: 66, ageMonths: 4 },
      secondary: { ageYears: 67, ageMonths: 0 },
    };
    const build = (
      stored: SocialSecurityOverride,
      ss = [ssBenefit('m1', PIA), ssBenefit('m2', PIA)],
    ) => {
      const scenario = scenarioFixture('s1');
      scenario.payload.overrides.socialSecurity = stored;
      return buildTriples({
        scenarios: [scenario],
        members: [member('m1', true, 1965), member('m2', false, 1968)],
        ssBenefits: ss,
        today: TODAY,
        stepYears: 1,
      });
    };

    it('appends a month-level stored pair once, counted in pairCount, with verbatim months', () => {
      const bundle = build(monthLevel);
      expect(bundle.list).toHaveLength(FULL_GRID_PAIRS * FULL_GRID_PAIRS + 1);
      expect(bundle.pairCount).toBe(FULL_GRID_PAIRS * FULL_GRID_PAIRS + 1);
      const last = bundle.list[bundle.list.length - 1];
      expect(last).toMatchObject({
        pairIdx: bundle.pairCount,
        primaryAgeYears: 66,
        primaryAgeMonths: 4,
        secondaryAgeYears: 67,
      });
      expect(last.overlay.socialSecurity.primary).toEqual({ ageYears: 66, ageMonths: 4 });
    });

    it('adds nothing for a stored whole-year pair already in the grid', () => {
      const bundle = build({
        primary: { ageYears: 66, ageMonths: 0 },
        secondary: { ageYears: 67, ageMonths: 0 },
      });
      expect(bundle.list).toHaveLength(FULL_GRID_PAIRS * FULL_GRID_PAIRS);
      expect(bundle.pairCount).toBe(FULL_GRID_PAIRS * FULL_GRID_PAIRS);
    });

    it('secondary-only fallback carries the primary months on every triple', () => {
      const bundle = build(
        { ...monthLevel, secondary: { ageYears: 67, ageMonths: 2 } },
        [ssBenefit('m1', null), ssBenefit('m2', PIA)],
      );
      expect(bundle.list).toHaveLength(FULL_GRID_PAIRS + 1);
      for (const t of bundle.list) {
        expect(t).toMatchObject({ primaryAgeYears: 66, primaryAgeMonths: 4 });
        expect(t.overlay.socialSecurity.primary).toEqual({ ageYears: 66, ageMonths: 4 });
      }
    });
  });

  it('triples stay survivor-free when no survivor age is stored', () => {
    const members = [member('m1', true, 1965), member('m2', false, 1970)];
    const ss = [ssBenefit('m1', PIA), ssBenefit('m2', 1_000)];
    const bundle = buildTriples({
      scenarios: [scenarioFixture('s1')],
      members,
      ssBenefits: ss,
      today: TODAY,
      stepYears: 1,
    });
    expect(bundle.list.length).toBeGreaterThan(0);
    for (const triple of bundle.list) {
      expect(triple.overlay.socialSecurity.survivor).toBeUndefined();
    }
  });
});

describe('isAlreadyAtOptimum', () => {
  function winner(
    primaryAgeYears: number,
    secondaryAgeYears: number | null,
  ): OptimizerMcWinner {
    return { primaryAgeYears, secondaryAgeYears, metricValue: 0.9 };
  }

  it('returns true when the winner exactly matches the resolved claim ages', () => {
    // Arrange
    const resolved: SocialSecurityOverride = {
      primary: { ageYears: 67, ageMonths: 0 },
      secondary: { ageYears: 65, ageMonths: 0 },
    };

    // Act + Assert
    expect(isAlreadyAtOptimum(winner(67, 65), resolved)).toBe(true);
  });

  it('returns false when the resolved override is undefined (boundary)', () => {
    // Arrange: no resolved override at all.
    // Act + Assert
    expect(isAlreadyAtOptimum(winner(67, 65), undefined)).toBe(false);
  });

  it('returns false when the resolved primary carries non-zero ageMonths the winner lacks', () => {
    const resolved: SocialSecurityOverride = {
      primary: { ageYears: 67, ageMonths: 6 },
    };
    expect(isAlreadyAtOptimum(winner(67, null), resolved)).toBe(false);
  });

  it('returns true for a winner carrying the same months as the resolved pair', () => {
    const resolved: SocialSecurityOverride = {
      primary: { ageYears: 67, ageMonths: 6 },
    };
    expect(
      isAlreadyAtOptimum({ ...winner(67, null), primaryAgeMonths: 6 }, resolved),
    ).toBe(true);
  });

  it('matchesCurrentClaim resolves a missing stored secondary to the fallback default', () => {
    const resolved: SocialSecurityOverride = { primary: { ageYears: 66, ageMonths: 4 } };
    expect(matchesCurrentClaim(66, 67, resolved, 4, 0)).toBe(true);
    expect(matchesCurrentClaim(66, 67, resolved, 0, 0)).toBe(false);
    expect(matchesCurrentClaim(66, 68, resolved, 4, 0)).toBe(false);
  });

  it('matchesCurrentClaim matches an unsearched (null) secondary on the primary alone', () => {
    const withSecondary: SocialSecurityOverride = {
      primary: { ageYears: 66, ageMonths: 4 },
      secondary: { ageYears: 72, ageMonths: 0 },
    };
    const withoutSecondary: SocialSecurityOverride = { primary: { ageYears: 66, ageMonths: 4 } };
    expect(matchesCurrentClaim(66, null, withSecondary, 4, 0)).toBe(true);
    expect(matchesCurrentClaim(66, null, withoutSecondary, 4, 0)).toBe(true);
    expect(matchesCurrentClaim(66, null, withSecondary, 0, 0)).toBe(false);
    expect(matchesCurrentClaim(67, null, withSecondary, 4, 0)).toBe(false);
  });
});

describe('derivePartial', () => {
  const winner: OptimizerMcWinner = {
    primaryAgeYears: 67,
    secondaryAgeYears: 65,
    metricValue: 0.9,
  };

  it('returns false on the happy path: both PIAs present and a complete winner', () => {
    // Arrange + Act + Assert
    expect(
      derivePartial({
        piaState: { primaryHasPia: true, secondaryHasPia: true },
        hasSecondary: true,
        winner,
      }),
    ).toBe(false);
  });

  it('returns true when the secondary lacks a PIA (boundary)', () => {
    expect(
      derivePartial({
        piaState: { primaryHasPia: true, secondaryHasPia: false },
        hasSecondary: true,
        winner,
      }),
    ).toBe(true);
  });

  it('returns true when the winner is null', () => {
    expect(
      derivePartial({
        piaState: { primaryHasPia: true, secondaryHasPia: true },
        hasSecondary: true,
        winner: null,
      }),
    ).toBe(true);
  });
});

describe('derivePrecheckEmpty', () => {
  it('returns null on the happy path with a primary carrying a usable birthdate', () => {
    // Arrange
    const members = [member('m1', true, 1965)];

    // Act + Assert
    expect(derivePrecheckEmpty({ members })).toBeNull();
  });

  it("returns 'no-primary-member' when no member is marked primary (boundary)", () => {
    const members = [member('m2', false, 1965)];
    expect(derivePrecheckEmpty({ members })).toBe('no-primary-member');
  });

  it("returns 'no-retirement-date' when the primary's birthdate is unusable", () => {
    // Arrange: primary present but with an empty birthdate → date math fails.
    const broken: Aggregate<HouseholdMemberPayload> = {
      ...member('m1', true, 1965),
      payload: { ...member('m1', true, 1965).payload, birthdate: '' },
    };
    expect(derivePrecheckEmpty({ members: [broken] })).toBe('no-retirement-date');
  });
});
