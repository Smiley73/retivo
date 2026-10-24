import { describe, expect, it } from 'vitest';
import { glideMultiplierFor } from './expense-glide';
import type { ScheduleResolveContext } from './schedule-resolution';
import type {
  DiscretionaryGlideOverride,
  ScheduleEnd,
  ScheduleStart,
} from '../db/types';

const ctx = (): ScheduleResolveContext => ({
  retirementYear: 2030,
  retirementMonth0: 0,
  primary: { birthdate: '1965-03-01' },
  secondary: { birthdate: '1968-01-01' },
});

const disc = (
  glide?: DiscretionaryGlideOverride,
  start: ScheduleStart = { kind: 'retirementStart' },
  end: ScheduleEnd | undefined = { kind: 'lifetime', whose: 'last' },
) => ({
  classification: 'discretionary' as const,
  frequency: 'monthly' as const,
  start,
  end,
  discretionaryGlide: glide,
});

const idx = (year: number, month0 = 0): number => year * 12 + month0;

const yearGlide = (
  endMultiplierPct: number,
  gy: number,
  ey: number,
): DiscretionaryGlideOverride => ({
  endMultiplierPct,
  glideStart: { kind: 'year', year: gy },
  glideEnd: { kind: 'year', year: ey },
});

describe('glideMultiplierFor — fail-safe / no-op', () => {
  it('returns 1 when no glide is present on the expense', () => {
    expect(glideMultiplierFor(disc(), idx(2035), ctx())).toBe(1);
  });

  it('applies the glide to an essential expense (classification-agnostic)', () => {
    const essential = {
      classification: 'essential' as const,
      frequency: 'monthly' as const,
      start: { kind: 'retirementStart' as const },
      end: { kind: 'lifetime' as const, whose: 'last' as const },
      discretionaryGlide: yearGlide(50, 2030, 2040), // 1.0 → 0.5 over 2030..2040
    };
    expect(glideMultiplierFor(essential, idx(2035), ctx())).toBeCloseTo(0.75, 6);
    expect(glideMultiplierFor(essential, idx(2040), ctx())).toBeCloseTo(0.5, 6);
  });

  it('returns 1 when a glide age anchor references an absent member', () => {
    const glide: DiscretionaryGlideOverride = {
      endMultiplierPct: 50,
      glideStart: { kind: 'age', memberId: 'secondary', years: 70, months: 0 },
      glideEnd: { kind: 'year', year: 2040 },
    };
    const c = ctx();
    c.secondary = undefined;
    expect(glideMultiplierFor(disc(glide), idx(2045), c)).toBe(1);
  });
});

describe('glideMultiplierFor — piecewise curve', () => {
  it('flat 100% before glide-start, linear to endMult, flat after', () => {
    const g = yearGlide(50, 2030, 2040); // 1.0 → 0.5 over 2030..2040
    expect(glideMultiplierFor(disc(g), idx(2029), ctx())).toBe(1); // before
    expect(glideMultiplierFor(disc(g), idx(2030), ctx())).toBe(1); // at start
    expect(glideMultiplierFor(disc(g), idx(2035), ctx())).toBeCloseTo(0.75, 6);
    expect(glideMultiplierFor(disc(g), idx(2040), ctx())).toBeCloseTo(0.5, 6);
    expect(glideMultiplierFor(disc(g), idx(2050), ctx())).toBeCloseTo(0.5, 6);
  });

  it('degenerate window (glide-start ≥ glide-end) snaps to endMult, no NaN', () => {
    const g = yearGlide(60, 2040, 2030); // start after end
    expect(glideMultiplierFor(disc(g), idx(2035), ctx())).toBe(1);
    const v = glideMultiplierFor(disc(g), idx(2045), ctx());
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeCloseTo(0.6, 6);
  });

  it('floor step overrides the glide from the floor anchor onward', () => {
    const glide: DiscretionaryGlideOverride = {
      ...yearGlide(70, 2030, 2040),
      floor: { multiplierPct: 40, anchor: { kind: 'year', year: 2050 } },
    };
    expect(glideMultiplierFor(disc(glide), idx(2045), ctx())).toBeCloseTo(0.7, 6);
    expect(glideMultiplierFor(disc(glide), idx(2050), ctx())).toBeCloseTo(0.4, 6);
    expect(glideMultiplierFor(disc(glide), idx(2060), ctx())).toBeCloseTo(0.4, 6);
  });

  it('returns 1 when a configured floor anchor is unresolvable', () => {
    const glide: DiscretionaryGlideOverride = {
      ...yearGlide(70, 2030, 2040),
      floor: {
        multiplierPct: 40,
        anchor: { kind: 'age', memberId: 'secondary', years: 90, months: 0 },
      },
    };
    const c = ctx();
    c.secondary = undefined;
    expect(glideMultiplierFor(disc(glide), idx(2045), c)).toBe(1);
  });

  it('floor at/before glide-end is ignored — normal glide curve returned', () => {
    const glide: DiscretionaryGlideOverride = {
      ...yearGlide(50, 2030, 2040),
      floor: { multiplierPct: 10, anchor: { kind: 'year', year: 2038 } },
    };
    expect(glideMultiplierFor(disc(glide), idx(2035), ctx())).toBeCloseTo(0.75, 6);
    const at2038 = 1 + (0.5 - 1) * ((2038 - 2030) / (2040 - 2030));
    expect(glideMultiplierFor(disc(glide), idx(2038), ctx())).toBeCloseTo(at2038, 6);
    expect(glideMultiplierFor(disc(glide), idx(2045), ctx())).toBeCloseTo(0.5, 6);
  });
});

describe('glideMultiplierFor — clamps', () => {
  it('clamps endMultiplierPct and floor multiplier into 0–200', () => {
    const glide: DiscretionaryGlideOverride = {
      endMultiplierPct: 250, // → clamps to 200 ⇒ 2.0
      glideStart: { kind: 'year', year: 2030 },
      glideEnd: { kind: 'year', year: 2040 },
      floor: { multiplierPct: 300, anchor: { kind: 'year', year: 2050 } },
    };
    expect(glideMultiplierFor(disc(glide), idx(2040), ctx())).toBeCloseTo(2, 6);
    expect(glideMultiplierFor(disc(glide), idx(2055), ctx())).toBeCloseTo(2, 6);
  });
});

describe('glideMultiplierFor — increasing glide', () => {
  it('ramps 1 → endMult linearly across the window for end > 100', () => {
    const g = yearGlide(150, 2030, 2040); // 1.0 → 1.5 over 2030..2040
    expect(glideMultiplierFor(disc(g), idx(2029), ctx())).toBe(1); // before
    expect(glideMultiplierFor(disc(g), idx(2030), ctx())).toBe(1); // at start
    expect(glideMultiplierFor(disc(g), idx(2035), ctx())).toBeCloseTo(1.25, 6);
    expect(glideMultiplierFor(disc(g), idx(2040), ctx())).toBeCloseTo(1.5, 6);
    expect(glideMultiplierFor(disc(g), idx(2050), ctx())).toBeCloseTo(1.5, 6); // flat after
  });

  it('clamps an increasing endMult at 200 (end: 250 → 2.0)', () => {
    const g = yearGlide(250, 2030, 2040);
    expect(glideMultiplierFor(disc(g), idx(2040), ctx())).toBeCloseTo(2, 6);
  });

  it('steps to the ceiling after glide-end for an increasing glide (ceiling ≥ end)', () => {
    const glide: DiscretionaryGlideOverride = {
      ...yearGlide(150, 2030, 2040),
      floor: { multiplierPct: 180, anchor: { kind: 'year', year: 2050 } },
    };
    expect(glideMultiplierFor(disc(glide), idx(2045), ctx())).toBeCloseTo(1.5, 6);
    expect(glideMultiplierFor(disc(glide), idx(2050), ctx())).toBeCloseTo(1.8, 6);
    expect(glideMultiplierFor(disc(glide), idx(2060), ctx())).toBeCloseTo(1.8, 6);
  });

  it('wrong-side plateau (end=100, floor>100) is ineffective — stays 1 every month', () => {
    // A serialized end 100 with floor 150 (reachable via data import; the form rejects it) is not effective: the engine must fall through to the neutral curve so it never disagrees with `isNeutralGlide`.
    const glide: DiscretionaryGlideOverride = {
      ...yearGlide(100, 2030, 2040),
      floor: { multiplierPct: 150, anchor: { kind: 'year', year: 2050 } },
    };
    for (const y of [2029, 2035, 2040, 2045, 2050, 2060]) {
      expect(glideMultiplierFor(disc(glide), idx(y), ctx())).toBe(1);
    }
  });

  it('rising glide with a ceiling BELOW the end holds flat at the end mult, never steps down', () => {
    // A wrong-side ceiling (floor 120 below end 150) is ineffective: hold at the end multiplier, not step down.
    const glide: DiscretionaryGlideOverride = {
      ...yearGlide(150, 2030, 2040),
      floor: { multiplierPct: 120, anchor: { kind: 'year', year: 2050 } },
    };
    expect(glideMultiplierFor(disc(glide), idx(2045), ctx())).toBeCloseTo(1.5, 6);
    expect(glideMultiplierFor(disc(glide), idx(2050), ctx())).toBeCloseTo(1.5, 6);
    expect(glideMultiplierFor(disc(glide), idx(2060), ctx())).toBeCloseTo(1.5, 6);
  });

  it('end === 100 stays neutral (1) while end = 120 actually rises', () => {
    const flat = yearGlide(100, 2030, 2040);
    expect(glideMultiplierFor(disc(flat), idx(2035), ctx())).toBe(1);
    const rising = yearGlide(120, 2030, 2040);
    expect(glideMultiplierFor(disc(rising), idx(2035), ctx())).toBeCloseTo(1.1, 6);
  });

  it('degenerate increasing window (gs ≥ ge) snaps to endMult > 1', () => {
    const g = yearGlide(160, 2040, 2030); // start after end
    expect(glideMultiplierFor(disc(g), idx(2035), ctx())).toBe(1);
    const v = glideMultiplierFor(disc(g), idx(2045), ctx());
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeCloseTo(1.6, 6);
  });
});

describe('glideMultiplierFor — value-equivalent neutral (the scenario-patch "off")', () => {
  it('endMultiplierPct:100 with NO effective floor yields 1 every active month', () => {
    const neutral: DiscretionaryGlideOverride = {
      endMultiplierPct: 100,
      glideStart: { kind: 'age', memberId: 'primary', years: 0, months: 0 },
      glideEnd: { kind: 'age', memberId: 'primary', years: 0, months: 0 },
    };
    for (const y of [2025, 2030, 2040, 2055, 2080]) {
      expect(glideMultiplierFor(disc(neutral), idx(y), ctx())).toBe(1);
    }
  });

  it('counter-case: endMultiplierPct:100 WITH an active floor<100 still steps down', () => {
    const endButFloor: DiscretionaryGlideOverride = {
      ...yearGlide(100, 2030, 2040),
      floor: { multiplierPct: 50, anchor: { kind: 'year', year: 2050 } },
    };
    expect(glideMultiplierFor(disc(endButFloor), idx(2045), ctx())).toBeCloseTo(
      1,
      6,
    ); // pre-floor: flat at end (100%)
    expect(glideMultiplierFor(disc(endButFloor), idx(2050), ctx())).toBeCloseTo(
      0.5,
      6,
    ); // floor step still applies
  });
});

describe('glideMultiplierFor — per-expense relative anchor', () => {
  it('two expenses with different starts bend at different calendar points', () => {
    const glide: DiscretionaryGlideOverride = {
      endMultiplierPct: 0,
      glideStart: { kind: 'durationFromExpenseStart', months: 0 },
      glideEnd: { kind: 'durationFromExpenseStart', months: 120 }, // 10y ramp
    };
    const early = disc(glide, { kind: 'year', year: 2030 });
    const late = disc(glide, { kind: 'year', year: 2040 });
    expect(glideMultiplierFor(early, idx(2035), ctx())).toBeCloseTo(0.5, 6);
    expect(glideMultiplierFor(late, idx(2035), ctx())).toBe(1);
    expect(glideMultiplierFor(late, idx(2045), ctx())).toBeCloseTo(0.5, 6);
  });
});

describe('glideMultiplierFor — expenseEnd glide-end anchor', () => {
  it('resolves the glide-end to the expense’s own resolved end', () => {
    // Glide-end is the expense's end: age 80 of a primary born 1965-03, so 2045-03 (exclusive).
    const glide: DiscretionaryGlideOverride = {
      endMultiplierPct: 50,
      glideStart: { kind: 'year', year: 2030 },
      glideEnd: { kind: 'expenseEnd' },
    };
    const e = disc(glide, { kind: 'year', year: 2030 }, {
      kind: 'age',
      memberId: 'primary',
      years: 80,
      months: 0,
    });
    expect(glideMultiplierFor(e, idx(2030, 0), ctx())).toBe(1);
    expect(glideMultiplierFor(e, idx(2045, 2), ctx())).toBeCloseTo(0.5, 6);
    expect(glideMultiplierFor(e, idx(2050, 0), ctx())).toBeCloseTo(0.5, 6);
    const mid = glideMultiplierFor(e, idx(2037, 8), ctx());
    expect(mid).toBeLessThan(1);
    expect(mid).toBeGreaterThan(0.5);
  });

  it('a scenario patch to the expense end moves the expenseEnd glide-end (resolved-expense basis)', () => {
    // Scenario resolution applies an `end` patch upstream: an expenseEnd-anchored glide must reach endMult at the patched month (age 90, 2055-03), not the canonical one (age 80, 2045-03).
    const glide: DiscretionaryGlideOverride = {
      endMultiplierPct: 50,
      glideStart: { kind: 'year', year: 2030 },
      glideEnd: { kind: 'expenseEnd' },
    };
    const canonicalEnd: ScheduleEnd = {
      kind: 'age',
      memberId: 'primary',
      years: 80,
      months: 0,
    };
    const patchedEnd: ScheduleEnd = {
      kind: 'age',
      memberId: 'primary',
      years: 90,
      months: 0,
    };
    const canonical = disc(glide, { kind: 'year', year: 2030 }, canonicalEnd);
    const patched = disc(glide, { kind: 'year', year: 2030 }, patchedEnd);

    expect(glideMultiplierFor(canonical, idx(2045, 2), ctx())).toBeCloseTo(
      0.5,
      6,
    );
    const patchedAtCanonicalEnd = glideMultiplierFor(
      patched,
      idx(2045, 2),
      ctx(),
    );
    expect(patchedAtCanonicalEnd).toBeGreaterThan(0.5);
    expect(patchedAtCanonicalEnd).toBeLessThan(1);

    expect(glideMultiplierFor(patched, idx(2055, 2), ctx())).toBeCloseTo(
      0.5,
      6,
    );
    expect(glideMultiplierFor(patched, idx(2060, 0), ctx())).toBeCloseTo(
      0.5,
      6,
    );
  });

  it('fail-safes to 1 when the expense end is unresolvable', () => {
    const glide: DiscretionaryGlideOverride = {
      endMultiplierPct: 40,
      glideStart: { kind: 'year', year: 2030 },
      glideEnd: { kind: 'expenseEnd' },
    };
    const c = ctx();
    c.secondary = undefined;
    const e = disc(glide, { kind: 'year', year: 2030 }, {
      kind: 'age',
      memberId: 'secondary',
      years: 75,
      months: 0,
    });
    expect(glideMultiplierFor(e, idx(2050), c)).toBe(1);
  });

  it('fail-safes to 1 when end is undefined (no end threaded)', () => {
    const glide: DiscretionaryGlideOverride = {
      endMultiplierPct: 40,
      glideStart: { kind: 'year', year: 2030 },
      glideEnd: { kind: 'expenseEnd' },
    };
    // Literal fixture: the `disc` helper's default param would coerce a passed `undefined` back to the lifetime default.
    const e = {
      classification: 'discretionary' as const,
      frequency: 'monthly' as const,
      start: { kind: 'year' as const, year: 2030 },
      end: undefined,
      discretionaryGlide: glide,
    };
    expect(glideMultiplierFor(e, idx(2050), ctx())).toBe(1);
  });
});

describe('glideMultiplierFor — one-off never glided', () => {
  it('returns 1 for a one-off discretionary expense even with a full glide', () => {
    const glide = yearGlide(0, 2030, 2040); // a steep 1.0 → 0.0 glide
    const oneOff = {
      classification: 'discretionary' as const,
      frequency: 'oneOff' as const,
      start: { kind: 'year' as const, year: 2035 },
      end: undefined,
      discretionaryGlide: glide,
    };
    expect(glideMultiplierFor(oneOff, idx(2035), ctx())).toBe(1);
    expect(
      glideMultiplierFor(
        disc(glide, { kind: 'year', year: 2035 }),
        idx(2035),
        ctx(),
      ),
    ).toBeCloseTo(0.5, 6);
  });
});

describe('glideMultiplierFor — within-year ramp shape', () => {
  it('produces a strictly monotone monthly ramp inside the glide window', () => {
    const g = yearGlide(0, 2030, 2042); // 1.0 → 0.0 over 144 months
    let prev = glideMultiplierFor(disc(g), idx(2036, 0), ctx());
    for (let m = 1; m < 12; m += 1) {
      const cur = glideMultiplierFor(disc(g), idx(2036, m), ctx());
      expect(cur).toBeLessThan(prev);
      prev = cur;
    }
  });
});
