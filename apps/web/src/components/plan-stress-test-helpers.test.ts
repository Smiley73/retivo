/**
 * Unit tests for the pure helpers exported by `PlanStressTestSection` (longevity anchor).
 */
import { describe, expect, it } from 'vitest';
import { longestLivedBirthYearOf } from './PlanStressTestSection';
import type { Aggregate, HouseholdMemberPayload } from '../db/types';

// ---------------------------------------------------------------------------
// The longevity cap is anchored on a member birthdate, so what counts as
// a usable one is behaviour
// ---------------------------------------------------------------------------

describe('longestLivedBirthYearOf — only a real calendar birthdate anchors the age-105 cap', () => {
  /** A member aggregate carrying nothing but the birthdate under test. Member
   *  payloads reach this code straight off an IMPORTED workspace bundle, whose
   *  validation covers the envelope and not the field shapes, so the birthdate
   *  really can be any string (or missing entirely). */
  const member = (birthdate: unknown): Aggregate<HouseholdMemberPayload> =>
    ({ id: `m-${String(birthdate)}`, payload: { birthdate } } as unknown as Aggregate<HouseholdMemberPayload>);

  it('returns the YOUNGEST member’s birth year — they are the last one alive', () => {
    expect(longestLivedBirthYearOf([member('1955-04-02'), member('1968-11-30')])).toBe(1968);
    // Order must not matter.
    expect(longestLivedBirthYearOf([member('1968-11-30'), member('1955-04-02')])).toBe(1968);
  });

  it('ignores malformed members and anchors on the youngest VALID one', () => {
    // `9999-12-31` is the dangerous one: a four-leading-digit prefix test
    // accepts it, and being the largest "year" it would WIN the max and push
    // the longevity stress thousands of years past the plan.
    expect(
      longestLivedBirthYearOf([
        member('1968-11-30'),
        member('9999-12-31'),
        member('9999-'),
        member('1955-04-02'),
      ]),
    ).toBe(1968);
  });

  it('rejects an impossible calendar date rather than reading its year prefix', () => {
    // Each of these passes a `^\d{4}` prefix test but names no real day.
    for (const impossible of ['1968-99-99', '1968-13-01', '1968-02-30', '1967-02-29']) {
      expect(longestLivedBirthYearOf([member('1955-04-02'), member(impossible)])).toBe(1955);
    }
  });

  it('rejects an incomplete date, including a bare year', () => {
    for (const incomplete of ['1968', '1968-', '1968-11', '1968-11-3', 'not-a-date']) {
      expect(longestLivedBirthYearOf([member('1955-04-02'), member(incomplete)])).toBe(1955);
    }
  });

  it('returns null when NO member has a usable birthdate, withholding the comparison', () => {
    // `null` is what makes the surface withhold rather than guess an age: a
    // bare `Number('')` would hand the stress the year 0 as its anchor.
    expect(longestLivedBirthYearOf([])).toBeNull();
    expect(longestLivedBirthYearOf([member(''), member('1968'), member(undefined)])).toBeNull();
    expect(longestLivedBirthYearOf([member('9999-12-31'), member('1968-02-30')])).toBeNull();
  });
});
