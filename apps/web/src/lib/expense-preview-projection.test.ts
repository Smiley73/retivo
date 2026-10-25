import { describe, expect, it } from 'vitest';
import {
  buildPreview,
  formatShortIsoMonth,
  isoToFractionalYear,
  projectedDeathFractionalYear,
} from './expense-preview-projection';
import type { ScenarioAggregate } from './scenario-resolution';
import type {
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
} from '../db/types';
import { CHART_COLORS } from './tokens';

const member = (): Aggregate<HouseholdMemberPayload> => ({
  id: 'hm-1',
  householdId: 'hh',
  aggregateType: 'householdMember',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'dev-1',
  payload: {
    isPrimary: true,
    firstName: 'Alex',
    lastName: 'P',
    email: 'a@x.test',
    birthdate: '1965-04-15',
  },
});

const scenario = (
  id: string,
  isPrimary: boolean,
  overrides: ScenarioAggregate['payload']['overrides'],
  parentScenarioId: string | null = null,
): ScenarioAggregate => ({
  id,
  householdId: 'hh',
  aggregateType: 'scenario',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'dev-1',
  payload: {
    name: id,
    description: '',
    parentScenarioId,
    isPrimary,
    notes: '',
    overrides,
  },
});

const DRAFT: ExpensePayload = {
  name: 'Travel',
  amount: 1000,
  frequency: 'monthly',
  classification: 'discretionary',
  categoryId: 'cat-1',
  start: { kind: 'retirementStart' },
  end: { kind: 'lifetime', whose: 'primary' },
};

// The primary scenario has no retirement age, so it is unresolvable on its own; the child has one.
const PRIMARY_SCN = scenario('scn-base', true, {});
const TARGET_SCN = scenario(
  'scn-target',
  false,
  { retirementAge: { primary: { ageYears: 60, ageMonths: 2 } } },
  'scn-base',
);

describe('expense-preview-projection — date helpers', () => {
  it('projectedDeathFractionalYear returns the integer death year (death = Dec 31)', () => {
    expect(projectedDeathFractionalYear('1965-04-15', 90)).toBe(2055);
    expect(projectedDeathFractionalYear('1965-12-31', 90)).toBe(2055);
    expect(projectedDeathFractionalYear('1965-01-01', 90)).toBe(2055);
  });

  it('projectedDeathFractionalYear rejects a malformed birthdate (null contract preserved)', () => {
    expect(projectedDeathFractionalYear('not-a-date', 90)).toBeNull();
    expect(projectedDeathFractionalYear('1965-13-01', 90)).toBeNull();
  });

  it('isoToFractionalYear still returns a fractional date (unchanged)', () => {
    expect(isoToFractionalYear('1965-04-15')).toBeCloseTo(
      1965 + (3 + 14 / 30) / 12,
      6,
    );
    expect(isoToFractionalYear('bad')).toBeNull();
  });

  it('formatShortIsoMonth renders MMM YYYY, passing bad input through', () => {
    expect(formatShortIsoMonth('2031-04-01')).toBe('Apr 2031');
    expect(formatShortIsoMonth('2031-13')).toBe('2031-13');
    expect(formatShortIsoMonth('garbage')).toBe('garbage');
  });
});

describe('expense-preview-projection — buildPreview', () => {
  it('returns no-amount for a null or zero-amount draft', () => {
    expect(
      buildPreview(null, [member()], [PRIMARY_SCN, TARGET_SCN], null, 'light')
        .kind,
    ).toBe('no-amount');
    expect(
      buildPreview(
        { ...DRAFT, amount: 0 },
        [member()],
        [PRIMARY_SCN, TARGET_SCN],
        TARGET_SCN.id,
        'light',
      ).kind,
    ).toBe('no-amount');
  });

  it('returns unresolvable under the primary scenario (no retirement age)', () => {
    const result = buildPreview(
      DRAFT,
      [member()],
      [PRIMARY_SCN, TARGET_SCN],
      null,
      'light',
    );
    expect(result.kind).toBe('unresolvable');
  });

  it('returns ok with rows/markers/members under the target scenario', () => {
    const result = buildPreview(
      DRAFT,
      [member()],
      [PRIMARY_SCN, TARGET_SCN],
      TARGET_SCN.id,
      'light',
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.markers.length).toBeGreaterThan(0);
    expect(result.members).toEqual([{ firstName: 'Alex', birthYear: 1965 }]);
  });

  it('sources marker colors from the explicit theme argument', () => {
    const light = buildPreview(
      DRAFT,
      [member()],
      [PRIMARY_SCN, TARGET_SCN],
      TARGET_SCN.id,
      'light',
    );
    const dark = buildPreview(
      DRAFT,
      [member()],
      [PRIMARY_SCN, TARGET_SCN],
      TARGET_SCN.id,
      'dark',
    );
    expect(light.kind).toBe('ok');
    expect(dark.kind).toBe('ok');
    if (light.kind !== 'ok' || dark.kind !== 'ok') return;
    expect(light.markers.length).toBeGreaterThan(0);
    expect(dark.markers.length).toBe(light.markers.length);
    const lightColors = light.markers.map((m) => m.color);
    const darkColors = dark.markers.map((m) => m.color);
    expect(lightColors).not.toEqual(darkColors);
  });
});

describe('expense-preview-projection — retirement marker gate removal', () => {
  // A `fromYear < retirementYear` gate used to suppress the retirement marker when the only expense starts at retirement.
  it('emits the teal retirement marker when the expense starts at retirement', () => {
    const result = buildPreview(
      DRAFT,
      [member()],
      [PRIMARY_SCN, TARGET_SCN],
      TARGET_SCN.id,
      'light',
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const retirementMarker = result.markers.find((m) =>
      /^Retires /.test(m.label),
    );
    expect(retirementMarker).toBeDefined();
    expect(retirementMarker?.color).toBe(CHART_COLORS.light.retirementMarker);
  });

  it('emits the death marker as the integer death year tagged kind: death', () => {
    // Born 1965 with the default life expectancy 95: death year 2060.
    const result = buildPreview(
      DRAFT,
      [member()],
      [PRIMARY_SCN, TARGET_SCN],
      TARGET_SCN.id,
      'light',
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const deathMarker = result.markers.find((m) =>
      / life expectancy /.test(m.label),
    );
    expect(deathMarker).toBeDefined();
    expect(deathMarker?.kind).toBe('death');
    expect(deathMarker?.fractionalYear).toBe(2060);
    expect(Math.floor(result.rows.at(-1)!.fractionalYear)).toBe(2060);
  });
});

describe('expense-preview-projection — glide validation', () => {
  const GLIDE_BEFORE_EXPENSE = {
    endMultiplierPct: 60,
    glideStart: { kind: 'year', year: 1990 },
    glideEnd: { kind: 'year', year: 2050 },
  } as const;

  const preview = (
    draft: ExpensePayload,
    scenarios = [PRIMARY_SCN, TARGET_SCN],
    targetId: string | null = TARGET_SCN.id,
  ) => buildPreview(draft, [member()], scenarios, targetId, 'light');

  it.each(['discretionary', 'essential'] as const)(
    'reports a glide that starts before a recurring %s expense',
    (classification) => {
      const result = preview({
        ...DRAFT,
        classification,
        discretionaryGlide: GLIDE_BEFORE_EXPENSE,
      });
      expect(result.kind).toBe('invalid-glide');
      if (result.kind !== 'invalid-glide') return;
      expect(result.message).toMatch(/spending glide starts before the expense/i);
    },
  );

  it('skips glide validation for a one-off, which is never glided and whose form hides the glide section', () => {
    const result = preview({
      ...DRAFT,
      frequency: 'oneOff',
      end: undefined,
      discretionaryGlide: GLIDE_BEFORE_EXPENSE,
    });
    expect(result.kind).toBe('ok');
  });

  it('validates an increasing glide (end > 100) but skips a neutral end === 100 glide with no floor', () => {
    const rising = preview({
      ...DRAFT,
      classification: 'essential',
      discretionaryGlide: { ...GLIDE_BEFORE_EXPENSE, endMultiplierPct: 150 },
    });
    expect(rising.kind).toBe('invalid-glide');
    const neutral = preview({
      ...DRAFT,
      discretionaryGlide: { ...GLIDE_BEFORE_EXPENSE, endMultiplierPct: 100 },
    });
    expect(neutral.kind).toBe('ok');
  });

  describe('expenseEnd that cannot resolve (end is the secondary member, who is absent)', () => {
    const UNRESOLVABLE_DRAFT: ExpensePayload = {
      ...DRAFT,
      classification: 'discretionary',
      end: { kind: 'lifetime', whose: 'secondary' },
      discretionaryGlide: {
        endMultiplierPct: 60,
        glideStart: { kind: 'retirementStart' },
        glideEnd: { kind: 'expenseEnd' },
      },
    };
    const CANON_SCN = scenario('scn-canon', true, {
      retirementAge: { primary: { ageYears: 60, ageMonths: 2 } },
    });
    const PATCH_SCN = scenario(
      'scn-patch',
      false,
      { retirementAge: { primary: { ageYears: 62, ageMonths: 0 } } },
      'scn-canon',
    );
    const ADD_SCN = scenario(
      'scn-add',
      false,
      { retirementAge: { primary: { ageYears: 58, ageMonths: 6 } } },
      'scn-canon',
    );
    const messageFor = (targetId: string | null): string => {
      const result = preview(UNRESOLVABLE_DRAFT, [CANON_SCN, PATCH_SCN, ADD_SCN], targetId);
      if (result.kind !== 'invalid-glide') throw new Error(`expected invalid-glide, got ${result.kind}`);
      return result.message;
    };

    it('surfaces the same tailored non-age message under three distinct target scenarios, without mutating the draft', () => {
      const before = structuredClone(UNRESOLVABLE_DRAFT);
      const canonical = messageFor(null);
      expect(canonical).toMatch(/can't be determined here/i);
      expect(canonical).not.toMatch(/missing an age/i);
      expect(messageFor(PATCH_SCN.id)).toBe(canonical);
      expect(messageFor(ADD_SCN.id)).toBe(canonical);
      expect(UNRESOLVABLE_DRAFT).toEqual(before);
    });
  });
});

describe('expense-preview-projection — target scenario resolution', () => {
  it('falls back to the primary scenario (no retirement age) when the target id is unknown', () => {
    const result = buildPreview(
      DRAFT,
      [member()],
      [PRIMARY_SCN, TARGET_SCN],
      'does-not-exist',
      'light',
    );
    expect(result.kind).toBe('unresolvable');
  });

  it('is unresolvable when the primary member has a blank birthdate', () => {
    const noBirth: Aggregate<HouseholdMemberPayload> = {
      ...member(),
      payload: { ...member().payload, birthdate: '' },
    };
    const result = buildPreview(DRAFT, [noBirth], [PRIMARY_SCN, TARGET_SCN], TARGET_SCN.id, 'light');
    expect(result.kind).toBe('unresolvable');
  });
});
