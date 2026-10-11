/**
 * Unit tests for the pure single-expense form-preview projection
 * module (extracted from `<ExpenseProjectionPreview>` so the heavy lazy
 * chart component stays a thin `React.memo` wrapper).
 *
 * Covers the `buildPreview` discriminant kinds (no-amount /
 * unresolvable / invalid-glide / ok), the target-scenario resolution
 * branch, and the pure date→fractional-year helpers. The component
 * test (`ExpenseProjectionPreview.test.tsx`) covers the React render
 * path on top of these.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPreview,
  formatShortIsoMonth,
  glideProblemForDraft,
  isoToFractionalYear,
  projectedDeathFractionalYear,
  resolveTargetCtx,
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

// Primary scenario WITHOUT a retirement age → unresolvable on its own;
// a child scenario WITH one → resolvable.
const PRIMARY_SCN = scenario('scn-base', true, {});
const TARGET_SCN = scenario(
  'scn-target',
  false,
  { retirementAge: { primary: { ageYears: 60, ageMonths: 2 } } },
  'scn-base',
);

describe('expense-preview-projection — date helpers', () => {
  it('projectedDeathFractionalYear returns the integer death year (death = Dec 31)', () => {
    // Death = Dec 31 of `deathYear`, so birth month/day are irrelevant —
    // only `birthYear + age` matters. 1965 + 90 = 2055.
    expect(projectedDeathFractionalYear('1965-04-15', 90)).toBe(2055);
    // Birth month/day do not shift the result.
    expect(projectedDeathFractionalYear('1965-12-31', 90)).toBe(2055);
    expect(projectedDeathFractionalYear('1965-01-01', 90)).toBe(2055);
  });

  it('projectedDeathFractionalYear rejects a malformed birthdate (null contract preserved)', () => {
    expect(projectedDeathFractionalYear('not-a-date', 90)).toBeNull();
    expect(projectedDeathFractionalYear('1965-13-01', 90)).toBeNull();
  });

  it('isoToFractionalYear still returns a fractional date (unchanged)', () => {
    // The retirement-marker helper keeps its fractional contract; only the
    // death-year helper dropped its fraction.
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

  // The marker colors come from the explicit `theme` arg (no
  // internal `currentChartTheme()` read) so a live theme toggle
  // re-flips them. Same inputs, different theme → different marker hex.
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
    // At least one marker color must differ between the two themes —
    // proves the color is theme-arg-sourced, not a frozen read.
    const lightColors = light.markers.map((m) => m.color);
    const darkColors = dark.markers.map((m) => m.color);
    expect(lightColors).not.toEqual(darkColors);
  });

  it('returns invalid-glide when the glide starts before the expense', () => {
    const draft: ExpensePayload = {
      ...DRAFT,
      classification: 'discretionary',
      start: { kind: 'retirementStart' },
      discretionaryGlide: {
        endMultiplierPct: 60,
        glideStart: { kind: 'year', year: 1990 },
        glideEnd: { kind: 'year', year: 2050 },
      },
    };
    const result = buildPreview(
      draft,
      [member()],
      [PRIMARY_SCN, TARGET_SCN],
      TARGET_SCN.id,
      'light',
    );
    expect(result.kind).toBe('invalid-glide');
    if (result.kind !== 'invalid-glide') return;
    expect(result.message).toMatch(/spending glide starts before the expense/i);
  });
});

describe('expense-preview-projection — retirement marker gate removal', () => {
  // The preview's `buildMarkers` (via `buildPreview`) must surface the
  // teal retirement marker on the SAME terms as the list page's
  // `buildProjection` — unconditionally whenever retirement is in the
  // chart domain, including when the (single, only) expense starts AT
  // retirement (`fromYear === retirementYear`), where the prior
  // `fromYear < retirementYear` gate suppressed it. DRAFT starts at
  // `retirementStart`, so it is exactly that boundary case.
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
    // Member born 1965, default life expectancy 95 → deathYear = 2060.
    // `buildMarkers` emits the integer death year + `kind: 'death'`; the
    // always-monthly chart (`ExpensesProjectionChartInner`) is what maps it
    // to the December sample for rendering. The expense line runs through
    // December of the death year.
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
    // The expense line runs through December of the death year (the last
    // trimmed row is in 2060).
    expect(Math.floor(result.rows.at(-1)!.fractionalYear)).toBe(2060);
  });
});

describe('expense-preview-projection — glideProblemForDraft one-off skip', () => {
  // A one-off is never glided (the engine early-returns multiplier 1 for
  // `frequency === 'oneOff'`), so an otherwise-invalid stored/inherited
  // glide must NOT surface a preview warning — it would be unfixable
  // (the form hides the glide section for one-offs).
  const rc = resolveTargetCtx(
    [member()],
    [PRIMARY_SCN, TARGET_SCN],
    TARGET_SCN.id,
  );

  it('returns no problem for a one-off draft even with an otherwise-invalid glide', () => {
    expect('kind' in rc).toBe(false);
    if ('kind' in rc) return;
    const oneOff: ExpensePayload = {
      ...DRAFT,
      frequency: 'oneOff',
      end: undefined,
      // Same shape that trips `invalid-glide` for the recurring draft
      // ("glide starts before the expense") — must be skipped here.
      discretionaryGlide: {
        endMultiplierPct: 60,
        glideStart: { kind: 'year', year: 1990 },
        glideEnd: { kind: 'year', year: 2050 },
      },
    };
    expect(glideProblemForDraft(oneOff, rc)).toBeNull();
  });

  it('still reports the problem for the same glide on a recurring draft', () => {
    expect('kind' in rc).toBe(false);
    if ('kind' in rc) return;
    const recurring: ExpensePayload = {
      ...DRAFT,
      frequency: 'monthly',
      discretionaryGlide: {
        endMultiplierPct: 60,
        glideStart: { kind: 'year', year: 1990 },
        glideEnd: { kind: 'year', year: 2050 },
      },
    };
    expect(glideProblemForDraft(recurring, rc)).toMatch(
      /spending glide starts before the expense/i,
    );
  });
});

describe('expense-preview-projection — glideProblemForDraft classification-agnostic + direction', () => {
  const rc = resolveTargetCtx(
    [member()],
    [PRIMARY_SCN, TARGET_SCN],
    TARGET_SCN.id,
  );

  it('runs the validator for a glided ESSENTIAL (no longer suppressed by classification)', () => {
    expect('kind' in rc).toBe(false);
    if ('kind' in rc) return;
    const essential: ExpensePayload = {
      ...DRAFT,
      classification: 'essential',
      frequency: 'monthly',
      discretionaryGlide: {
        endMultiplierPct: 60,
        glideStart: { kind: 'year', year: 1990 }, // before the expense → invalid
        glideEnd: { kind: 'year', year: 2050 },
      },
    };
    expect(glideProblemForDraft(essential, rc)).toMatch(
      /spending glide starts before the expense/i,
    );
  });

  it('does NOT preview-suppress an increasing glide (end > 100), but still suppresses end === 100 no-floor', () => {
    expect('kind' in rc).toBe(false);
    if ('kind' in rc) return;
    const rising: ExpensePayload = {
      ...DRAFT,
      classification: 'essential',
      frequency: 'monthly',
      discretionaryGlide: {
        endMultiplierPct: 150,
        glideStart: { kind: 'year', year: 1990 }, // before the expense → invalid
        glideEnd: { kind: 'year', year: 2050 },
      },
    };
    expect(glideProblemForDraft(rising, rc)).toMatch(
      /spending glide starts before the expense/i,
    );
    const neutral: ExpensePayload = {
      ...DRAFT,
      discretionaryGlide: {
        endMultiplierPct: 100,
        glideStart: { kind: 'year', year: 1990 },
        glideEnd: { kind: 'year', year: 2050 },
      },
    };
    // end === 100, no effective floor ⇒ neutral no-op ⇒ preview-suppressed
    // even though the anchors would otherwise be invalid.
    expect(glideProblemForDraft(neutral, rc)).toBeNull();
  });
});

describe('expense-preview-projection — expenseEnd-unresolvable parity', () => {
  // The tailored non-age message must surface identically through
  // `glideProblemForDraft` for three GENUINELY DISTINCT target
  // contexts — canonical (primary scenario), a scenario-patch child,
  // and a *different* scenario-only-add child with its own resolvable
  // retirement age — proving `draft.end` is actually threaded into the
  // validator regardless of which scenario context resolves, and no
  // state is mutated. The fixture is NON-neutral (an actually-declining
  // `endMultiplierPct: 60` glide with an unresolvable `expenseEnd`
  // glide-end), so the invariant applies: preview↔Save
  // parity is guaranteed for a non-neutral glide in every mode.
  //
  // This asserts tailored-message parity across three distinct target
  // contexts at the SHARED-VALIDATOR level only. The genuine
  // scenario-only-add Save *wiring* distinction (the form threading the
  // add-target into the Save-path validator) is covered end-to-end by
  // the existing `ExpenseFormPage` Save test
  // (`apps/web/src/pages/ExpenseFormPage.test.tsx`); it is deliberately
  // not duplicated here.
  //
  // A recurring expense whose `end` is `lifetime(secondary)` with NO
  // secondary member resolves to null ⇒ `expenseEnd` glide-end is
  // unresolvable (a recurring frequency, never a one-off).
  const UNRESOLVABLE_DRAFT: ExpensePayload = {
    ...DRAFT,
    frequency: 'monthly',
    classification: 'discretionary',
    end: { kind: 'lifetime', whose: 'secondary' },
    discretionaryGlide: {
      endMultiplierPct: 60,
      glideStart: { kind: 'retirementStart' },
      glideEnd: { kind: 'expenseEnd' },
    },
  };

  // canonical: primary scenario carries the retirement age so it
  // resolves on its own (distinct from PRIMARY_SCN which does not).
  const CANON_SCN = scenario('scn-canon', true, {
    retirementAge: { primary: { ageYears: 60, ageMonths: 2 } },
  });
  // scenario-patch: a child scenario of CANON_SCN.
  const PATCH_SCN = scenario(
    'scn-patch',
    false,
    { retirementAge: { primary: { ageYears: 62, ageMonths: 0 } } },
    'scn-canon',
  );
  // scenario-only-add: a DIFFERENT child scenario with its own,
  // distinct-but-resolvable retirement age — so the three `messageFor`
  // calls are non-identical `resolveTargetCtx`+`glideProblemForDraft`
  // invocations, not the same call twice.
  const ADD_SCN = scenario(
    'scn-add',
    false,
    { retirementAge: { primary: { ageYears: 58, ageMonths: 6 } } },
    'scn-canon',
  );
  const SCENARIOS = [CANON_SCN, PATCH_SCN, ADD_SCN];

  const messageFor = (targetId: string | null): string | null => {
    const rc = resolveTargetCtx([member()], SCENARIOS, targetId);
    expect('kind' in rc).toBe(false);
    if ('kind' in rc) return null;
    return glideProblemForDraft(UNRESOLVABLE_DRAFT, rc);
  };

  it('surfaces the identical tailored non-age message across three distinct target contexts', () => {
    const canonical = messageFor(null); // → primary scenario
    const scenarioPatch = messageFor(PATCH_SCN.id);
    const scenarioOnlyAdd = messageFor(ADD_SCN.id);
    expect(canonical).toMatch(/can't be determined here/i);
    expect(canonical).not.toMatch(/missing an age/i);
    // Byte-identical across the three genuinely distinct contexts —
    // parity for this non-neutral glide holds in every mode.
    expect(scenarioPatch).toBe(canonical);
    expect(scenarioOnlyAdd).toBe(canonical);
  });

  it('does not mutate the draft (pure validator)', () => {
    const before = structuredClone(UNRESOLVABLE_DRAFT);
    messageFor(null);
    messageFor(PATCH_SCN.id);
    messageFor(ADD_SCN.id);
    expect(UNRESOLVABLE_DRAFT).toEqual(before);
  });
});

describe('expense-preview-projection — resolveTargetCtx', () => {
  it('falls back to the primary scenario when the target id is unknown', () => {
    const rc = resolveTargetCtx(
      [member()],
      [PRIMARY_SCN, TARGET_SCN],
      'does-not-exist',
    );
    // Primary scenario has no retirement age → unresolvable.
    expect('kind' in rc && rc.kind).toBe('unresolvable');
  });

  it('resolves the bundle under a valid target scenario', () => {
    const rc = resolveTargetCtx(
      [member()],
      [PRIMARY_SCN, TARGET_SCN],
      TARGET_SCN.id,
    );
    expect('kind' in rc).toBe(false);
    if ('kind' in rc) return;
    expect(rc.primary.id).toBe('hm-1');
    expect(rc.retirementYear).toBe(2025);
  });

  it('returns unresolvable when the primary member has a blank birthdate', () => {
    const noBirth: Aggregate<HouseholdMemberPayload> = {
      ...member(),
      payload: { ...member().payload, birthdate: '' },
    };
    const rc = resolveTargetCtx([noBirth], [PRIMARY_SCN, TARGET_SCN], TARGET_SCN.id);
    expect('kind' in rc && rc.kind).toBe('unresolvable');
  });
});
