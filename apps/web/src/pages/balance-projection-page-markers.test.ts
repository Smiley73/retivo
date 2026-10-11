/**
 * `resolveLastSurvivor` — who the plan's horizon belongs to.
 *
 * The market-stress "Longer life" row credits its added years to this person,
 * so picking the wrong one names a member the plan already buried. The subtle
 * case is the one this module must get right and the age-105 cap anchor
 * deliberately does NOT: the last survivor is the member who dies LATEST, which
 * is not always the youngest — an older member with a longer life expectancy
 * outlives a younger one with a shorter.
 */
import { describe, expect, it } from 'vitest';
import {
  buildExpenseDeathMarkers,
  resolveLastSurvivor,
} from './balance-projection-page-markers';
import type { Aggregate, HouseholdMemberPayload } from '../db/types';

// `firstName` takes no default: one case passes `undefined` deliberately, and
// a default would silently substitute a name and pass the test for free.
const member = (
  birthdate: unknown,
  firstName: unknown,
  isPrimary = true,
): Aggregate<HouseholdMemberPayload> =>
  ({
    id: `m-${String(birthdate)}-${String(firstName)}`,
    payload: { birthdate, firstName, isPrimary },
  }) as unknown as Aggregate<HouseholdMemberPayload>;

describe('resolveLastSurvivor', () => {
  it('picks the member who dies LAST, even when they are the older one', () => {
    // Ann 1958 + 95 (the default) = 2053; John 1975 + 70 = 2045. The plan runs
    // to 2053, so the horizon is Ann's — naming John would credit the stress's
    // added years to someone dead eight years earlier.
    expect(
      resolveLastSurvivor(member('1958-03-04', 'Ann'), member('1975-06-01', 'John', false), {
        secondary: 70,
      }),
    ).toEqual({ firstName: 'Ann', birthYear: 1958 });
  });

  it('picks the younger member in the ordinary case', () => {
    // Both on the default life expectancy: 1975 + 95 = 2070 beats 1958 + 95.
    expect(
      resolveLastSurvivor(
        member('1958-03-04', 'Ann'),
        member('1975-06-01', 'John', false),
        undefined,
      ),
    ).toEqual({ firstName: 'John', birthYear: 1975 });
  });

  it('honours a per-slot life-expectancy override on each side', () => {
    expect(
      resolveLastSurvivor(member('1960-01-01', 'Ann'), member('1960-01-01', 'John', false), {
        primary: 90,
        secondary: 100,
      }),
    ).toEqual({ firstName: 'John', birthYear: 1960 });
  });

  it('names BOTH members when they tie at the same age', () => {
    // Two members born the same year on the default life expectancy die the
    // same year and reach the horizon at the same age — the out-of-the-box
    // same-age couple. Dropping both names there left the commonest two-person
    // household with nobody credited.
    expect(
      resolveLastSurvivor(
        member('1965-03-04', 'Ann'),
        member('1965-06-01', 'John', false),
        undefined,
      ),
    ).toEqual({ firstName: 'Ann and John', birthYear: 1965 });
  });

  it('names nobody when a tie spans two DIFFERENT ages', () => {
    // Ann 1958 + 97 = 2055; John 1965 + 90 = 2055. Both reach the horizon, but
    // at 97 and 90 — there is no single age to print, so the row states the
    // elder's and credits no one.
    expect(
      resolveLastSurvivor(member('1958-03-04', 'Ann'), member('1965-06-01', 'John', false), {
        primary: 97,
        secondary: 90,
      }),
    ).toEqual({ firstName: null, birthYear: 1958 });
  });

  it('handles a one-member household', () => {
    expect(resolveLastSurvivor(member('1970-02-02', 'Ann'), null, undefined)).toEqual({
      firstName: 'Ann',
      birthYear: 1970,
    });
  });

  it('drops the name for a blank or non-string one rather than rendering "( age 97)"', () => {
    // A member reaches this off an envelope-only-validated import, so a missing
    // or non-string `firstName` is reachable despite the type.
    expect(resolveLastSurvivor(member('1970-02-02', '   '), null, undefined)).toEqual({
      firstName: null,
      birthYear: 1970,
    });
    expect(resolveLastSurvivor(member('1970-02-02', undefined), null, undefined)).toEqual({
      firstName: null,
      birthYear: 1970,
    });
    expect(resolveLastSurvivor(member('1970-02-02', 42), null, undefined)).toEqual({
      firstName: null,
      birthYear: 1970,
    });
  });

  it('declines entirely when ANY member birthdate is malformed', () => {
    // The engine's `computeHorizonYear` reads birthdates more loosely than this
    // module, and more loosely still than the cap anchor — it even falls back
    // to a bare four-digit prefix. So a member none of the three agree on can
    // OWN the horizon while being invisible here, and naming the survivor among
    // the members this CAN see credits the added years to someone the plan
    // already buried: with `1990-02-31` driving the horizon to 2058, this used
    // to answer "Ann", who dies in 2053.
    for (const bad of ['1990', '1990-', '1990-13-01', '1990-02-31', '1991-02-29', '1899-01-01']) {
      expect(
        resolveLastSurvivor(member('1958-03-04', 'Ann'), member(bad, 'Ghost', false), undefined),
      ).toBeNull();
    }
  });

  it('declines when a life expectancy is not a real number', () => {
    // `lifeExpectancy` is shape-checked nowhere on read either, so an imported
    // scenario can carry a string or a NaN. `1958 + '95'` would print an age of
    // "195895".
    for (const bad of ['95', NaN, Infinity]) {
      expect(
        resolveLastSurvivor(member('1958-03-04', 'Ann'), null, {
          primary: bad,
        } as unknown as Parameters<typeof resolveLastSurvivor>[2]),
      ).toBeNull();
    }
  });

  it('leaves the death markers as loose as the projection they annotate', () => {
    // Tightening the marker builder to the strict validator looked like the fix
    // for the divergence above, but it made the markers STRICTER than
    // `computeHorizonYear`: the member kept driving the projection while losing
    // their marker, and the charts' end year shrank below years still drawn.
    // The row declines to name anyone in that state instead.
    const ann = member('1958-03-04', 'Ann');
    const ghost = member('1990-02-31', 'Ghost', false);
    expect(buildExpenseDeathMarkers(ann, ghost, undefined, 'light')).toHaveLength(2);
    expect(resolveLastSurvivor(ann, ghost, undefined)).toBeNull();
  });

  it('does not throw building markers for a member with no usable name', () => {
    // `firstName.trim()` on an imported member without one took the whole page
    // down BEFORE the survivor fallback could matter, making that fallback
    // unreachable in practice.
    expect(() =>
      buildExpenseDeathMarkers(member('1970-02-02', undefined), null, undefined, 'light'),
    ).not.toThrow();
    expect(
      buildExpenseDeathMarkers(member('1970-02-02', undefined), null, undefined, 'light')[0].label,
    ).toBe('Primary life expectancy 95');
  });

  it('returns null when there is no primary, or no usable birthdate', () => {
    expect(resolveLastSurvivor(null, null, undefined)).toBeNull();
    expect(resolveLastSurvivor(member('', 'Ann'), null, undefined)).toBeNull();
    // A secondary alone cannot be mirrored against the engine's horizon, which
    // always includes a primary.
    expect(resolveLastSurvivor(null, member('1970-02-02', 'John', false), undefined)).toBeNull();
  });
});
