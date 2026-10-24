import { describe, expect, it } from 'vitest';
import {
  PCT_MIN,
  PCT_MAX,
  NEUTRAL_END_PCT,
  clampPct,
  glideProblem,
  isNeutralGlide,
  memberName,
  neutralAnchor,
  neutralGlide,
} from './expense-glide-format';
import type { ScheduleResolveContext } from './schedule-resolution';
import type {
  Aggregate,
  DiscretionaryGlideOverride,
  HouseholdMemberPayload,
  ScheduleEnd,
} from '../db/types';

const member = (
  id: string,
  isPrimary: boolean,
  firstName: string,
): Aggregate<HouseholdMemberPayload> => ({
  id,
  householdId: 'h1',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-11T00:00:00Z',
  deviceId: 'd1',
  aggregateType: 'householdMember',
  payload: {
    isPrimary,
    firstName,
    lastName: '',
    email: '',
    birthdate: '1970-01-01',
  },
});

describe('neutralAnchor', () => {
  it('returns a primary age-0 anchor', () => {
    expect(neutralAnchor()).toEqual({
      kind: 'age',
      memberId: 'primary',
      years: 0,
      months: 0,
    });
  });

  it('returns a fresh object each call (no shared mutable state)', () => {
    expect(neutralAnchor()).not.toBe(neutralAnchor());
  });
});

describe('neutralGlide', () => {
  it('returns end=100 with neutral start/end anchors and no floor', () => {
    const g = neutralGlide();
    expect(g.endMultiplierPct).toBe(NEUTRAL_END_PCT);
    expect(g.glideStart).toEqual(neutralAnchor());
    expect(g.glideEnd).toEqual(neutralAnchor());
    expect(g.floor).toBeUndefined();
  });

  it('is itself a neutral (no-op) glide', () => {
    expect(isNeutralGlide(neutralGlide())).toBe(true);
  });
});

describe('isNeutralGlide', () => {
  const base = (): DiscretionaryGlideOverride => ({
    endMultiplierPct: 100,
    glideStart: { kind: 'retirementStart' },
    glideEnd: { kind: 'retirementStart' },
  });

  it('returns true when end=100 and no floor', () => {
    expect(isNeutralGlide(base())).toBe(true);
  });

  it('returns true when end=100 and floor multiplier >= 100', () => {
    expect(
      isNeutralGlide({
        ...base(),
        floor: { multiplierPct: 100, anchor: { kind: 'retirementStart' } },
      }),
    ).toBe(true);
  });

  it('returns false when end < 100 (real-terms decline)', () => {
    expect(isNeutralGlide({ ...base(), endMultiplierPct: 80 })).toBe(false);
  });

  it('returns false when an effective floor steps spending down', () => {
    expect(
      isNeutralGlide({
        ...base(),
        floor: { multiplierPct: 60, anchor: { kind: 'retirementStart' } },
      }),
    ).toBe(false);
  });

  it('returns false when end = 120 with no floor (a rise is not neutral)', () => {
    expect(isNeutralGlide({ ...base(), endMultiplierPct: 120 })).toBe(false);
  });

  it('returns true when end === 100 with no floor (the tightened no-op)', () => {
    expect(isNeutralGlide(base())).toBe(true);
  });

  it('returns false for end = 100 with floor < 100', () => {
    expect(
      isNeutralGlide({
        ...base(),
        floor: { multiplierPct: 70, anchor: { kind: 'retirementStart' } },
      }),
    ).toBe(false);
  });

  it('returns false for {end: 120, floor: 150} (an effective ceiling)', () => {
    expect(
      isNeutralGlide({
        ...base(),
        endMultiplierPct: 120,
        floor: { multiplierPct: 150, anchor: { kind: 'retirementStart' } },
      }),
    ).toBe(false);
  });
});

describe('clampPct', () => {
  it('clamps below the minimum up to PCT_MIN', () => {
    expect(clampPct(-10)).toBe(PCT_MIN);
  });

  it('clamps above the maximum (250) down to PCT_MAX (200)', () => {
    expect(clampPct(250)).toBe(PCT_MAX);
    expect(PCT_MAX).toBe(200);
  });

  it('leaves an in-range value unchanged (including a >100 rise)', () => {
    expect(clampPct(73)).toBe(73);
    expect(clampPct(150)).toBe(150);
  });
});

describe('memberName', () => {
  const members = [member('m1', true, 'Ada'), member('m2', false, 'Grace')];

  it('returns the primary first name for the primary role', () => {
    expect(memberName('primary', members)).toBe('Ada');
  });

  it('returns the secondary first name for the secondary role', () => {
    expect(memberName('secondary', members)).toBe('Grace');
  });

  it('treats an undefined role as primary', () => {
    expect(memberName(undefined, members)).toBe('Ada');
  });

  it('falls back to Primary when the primary first name is blank', () => {
    const blank = [member('m1', true, '  '), member('m2', false, 'Grace')];
    expect(memberName('primary', blank)).toBe('Primary');
  });

  it('falls back to Secondary when the members list is empty', () => {
    expect(memberName('secondary', [])).toBe('Secondary');
  });
});

describe('glideProblem', () => {
  const ctx: ScheduleResolveContext = {
    retirementYear: 2030,
    retirementMonth0: 0,
    primary: { birthdate: '1965-03-12' },
  };

  it('rejects a glide that starts before the expense itself starts', () => {
    const g: DiscretionaryGlideOverride = {
      endMultiplierPct: 60,
      glideStart: { kind: 'year', year: 1990 },
      glideEnd: { kind: 'year', year: 2050 },
    };
    expect(glideProblem(g, ctx, { year: 2030, month0: 0 })).toMatch(
      /spending glide starts before the expense/i,
    );
  });

  it('accepts a glide whose start is at/after the expense start', () => {
    const g: DiscretionaryGlideOverride = {
      endMultiplierPct: 60,
      glideStart: { kind: 'year', year: 2030 },
      glideEnd: { kind: 'year', year: 2040 },
    };
    expect(glideProblem(g, ctx, { year: 2030, month0: 0 })).toBeNull();
  });

  it('never trips the before-expense rule for a durationFromExpenseStart start', () => {
    const g: DiscretionaryGlideOverride = {
      endMultiplierPct: 60,
      glideStart: { kind: 'durationFromExpenseStart', months: 0 },
      glideEnd: { kind: 'durationFromExpenseStart', months: 120 },
    };
    expect(glideProblem(g, ctx, { year: 2030, month0: 0 })).toBeNull();
  });

  it('still rejects an age-0 (unresolved) anchor (moved-logic regression)', () => {
    const g: DiscretionaryGlideOverride = {
      endMultiplierPct: 60,
      glideStart: { kind: 'age', memberId: 'primary', years: 0, months: 0 },
      glideEnd: { kind: 'year', year: 2050 },
    };
    expect(glideProblem(g, ctx, { year: 2030, month0: 0 })).toMatch(
      /missing an age/i,
    );
  });

  it('still rejects glide-end not strictly after glide-start (moved-logic regression)', () => {
    const g: DiscretionaryGlideOverride = {
      endMultiplierPct: 60,
      glideStart: { kind: 'year', year: 2040 },
      glideEnd: { kind: 'year', year: 2035 },
    };
    expect(glideProblem(g, ctx, { year: 2025, month0: 0 })).toMatch(
      /must end after it starts/i,
    );
  });

  // A mid-year retiree whose expense start is unresolved must be probed at the real retirement month, not a hardcoded January.
  it('rejects a year-anchored glide-start that lands before a mid-year retirement probe', () => {
    const g: DiscretionaryGlideOverride = {
      endMultiplierPct: 60,
      glideStart: { kind: 'year', year: 2030 },
      glideEnd: { kind: 'year', year: 2040 },
    };
    expect(glideProblem(g, ctx, { year: 2030, month0: 5 })).toMatch(
      /spending glide starts before the expense/i,
    );
    // Control: a January probe (the old hardcoded fallback) would not trip the rule.
    expect(glideProblem(g, ctx, { year: 2030, month0: 0 })).toBeNull();
  });
});

describe('glideProblem — direction-aware floor/ceiling', () => {
  const ctx: ScheduleResolveContext = {
    retirementYear: 2030,
    retirementMonth0: 0,
    primary: { birthdate: '1965-03-12' },
  };

  it('declining glide: rejects floor% > end%, accepts floor% ≤ end%', () => {
    const tooHigh: DiscretionaryGlideOverride = {
      endMultiplierPct: 60,
      glideStart: { kind: 'year', year: 2030 },
      glideEnd: { kind: 'year', year: 2040 },
      floor: { multiplierPct: 80, anchor: { kind: 'year', year: 2050 } },
    };
    expect(glideProblem(tooHigh, ctx, { year: 2030, month0: 0 })).toMatch(
      /floor percentage can't be higher/i,
    );
    const ok: DiscretionaryGlideOverride = {
      ...tooHigh,
      floor: { multiplierPct: 40, anchor: { kind: 'year', year: 2050 } },
    };
    expect(glideProblem(ok, ctx, { year: 2030, month0: 0 })).toBeNull();
  });

  it('increasing glide: rejects ceiling% < end%, accepts ceiling% ≥ end%', () => {
    const tooLow: DiscretionaryGlideOverride = {
      endMultiplierPct: 150,
      glideStart: { kind: 'year', year: 2030 },
      glideEnd: { kind: 'year', year: 2040 },
      floor: { multiplierPct: 120, anchor: { kind: 'year', year: 2050 } },
    };
    expect(glideProblem(tooLow, ctx, { year: 2030, month0: 0 })).toMatch(
      /ceiling percentage can't be lower/i,
    );
    const ok: DiscretionaryGlideOverride = {
      ...tooLow,
      floor: { multiplierPct: 180, anchor: { kind: 'year', year: 2050 } },
    };
    expect(glideProblem(ok, ctx, { year: 2030, month0: 0 })).toBeNull();
  });

  it('increasing glide: plateau-ordering message names the "ceiling" not the "floor"', () => {
    const ceilingTooEarly: DiscretionaryGlideOverride = {
      endMultiplierPct: 150,
      glideStart: { kind: 'year', year: 2030 },
      glideEnd: { kind: 'year', year: 2040 },
      floor: { multiplierPct: 180, anchor: { kind: 'year', year: 2038 } },
    };
    expect(glideProblem(ceilingTooEarly, ctx, { year: 2030, month0: 0 })).toMatch(
      /ceiling must begin after/i,
    );
    const floorTooEarly: DiscretionaryGlideOverride = {
      endMultiplierPct: 60,
      glideStart: { kind: 'year', year: 2030 },
      glideEnd: { kind: 'year', year: 2040 },
      floor: { multiplierPct: 40, anchor: { kind: 'year', year: 2038 } },
    };
    expect(glideProblem(floorTooEarly, ctx, { year: 2030, month0: 0 })).toMatch(
      /floor must begin after/i,
    );
  });

  it('increasing glide: missing-anchor message names the "ceiling" not the "floor"', () => {
    const ceilingUnresolvable: DiscretionaryGlideOverride = {
      endMultiplierPct: 150,
      glideStart: { kind: 'year', year: 2030 },
      glideEnd: { kind: 'year', year: 2040 },
      floor: {
        multiplierPct: 180,
        anchor: { kind: 'age', memberId: 'secondary', years: 90, months: 0 },
      },
    };
    expect(
      glideProblem(ceilingUnresolvable, ctx, { year: 2030, month0: 0 }),
    ).toMatch(/ceiling is missing an age/i);
  });
});

describe('glideProblem — expenseEnd glide-end anchor', () => {
  const ctx: ScheduleResolveContext = {
    retirementYear: 2030,
    retirementMonth0: 0,
    primary: { birthdate: '1965-03-12' },
  };

  it('accepts an expenseEnd glide-end that resolves after glide-start', () => {
    const g: DiscretionaryGlideOverride = {
      endMultiplierPct: 60,
      glideStart: { kind: 'year', year: 2030 },
      glideEnd: { kind: 'expenseEnd' },
    };
    const end: ScheduleEnd = {
      kind: 'age',
      memberId: 'primary',
      years: 85,
      months: 0,
    };
    expect(glideProblem(g, ctx, { year: 2030, month0: 0 }, end)).toBeNull();
  });

  it('rejects an expenseEnd glide-end that resolves at/before glide-start', () => {
    const g: DiscretionaryGlideOverride = {
      endMultiplierPct: 60,
      glideStart: { kind: 'year', year: 2055 },
      glideEnd: { kind: 'expenseEnd' },
    };
    const end: ScheduleEnd = {
      kind: 'age',
      memberId: 'primary',
      years: 85,
      months: 0,
    };
    expect(glideProblem(g, ctx, { year: 2030, month0: 0 }, end)).toMatch(
      /must end after it starts/i,
    );
  });

  it('returns the tailored non-age message when expenseEnd is unresolvable', () => {
    const g: DiscretionaryGlideOverride = {
      endMultiplierPct: 60,
      glideStart: { kind: 'year', year: 2030 },
      glideEnd: { kind: 'expenseEnd' },
    };
    const msg = glideProblem(g, ctx, { year: 2030, month0: 0 }, undefined);
    expect(msg).toMatch(/can't be determined here/i);
    expect(msg).not.toMatch(/missing an age/i);
  });

  it('also tailors the message when the threaded end itself is unresolvable', () => {
    const g: DiscretionaryGlideOverride = {
      endMultiplierPct: 60,
      glideStart: { kind: 'year', year: 2030 },
      glideEnd: { kind: 'expenseEnd' },
    };
    const end: ScheduleEnd = {
      kind: 'age',
      memberId: 'secondary',
      years: 80,
      months: 0,
    };
    const msg = glideProblem(g, ctx, { year: 2030, month0: 0 }, end);
    expect(msg).toMatch(/can't be determined here/i);
    expect(msg).not.toMatch(/missing an age/i);
  });

  it('skips floor checks entirely when glide-end is expenseEnd', () => {
    const g: DiscretionaryGlideOverride = {
      endMultiplierPct: 60,
      glideStart: { kind: 'year', year: 2030 },
      glideEnd: { kind: 'expenseEnd' },
      floor: { multiplierPct: 90, anchor: { kind: 'year', year: 2025 } },
    };
    const end: ScheduleEnd = {
      kind: 'age',
      memberId: 'primary',
      years: 85,
      months: 0,
    };
    expect(glideProblem(g, ctx, { year: 2030, month0: 0 }, end)).toBeNull();
  });
});
