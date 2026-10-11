/**
 * Unit tests for retirement-date arithmetic. The same-date scenario
 * mode relies on these to recompute the non-anchor's age whenever the
 * anchor's age changes.
 */
import { describe, it, expect } from 'vitest';
import {
  ageOnDate,
  resolveMemberRetirementDates,
  retirementDate,
  retirementDatesDiffer,
} from './retirement-date-math';

describe('retirementDate', () => {
  it('computes a same-day, same-month retirement date at exact age', () => {
    expect(retirementDate('1985-06-15', { ageYears: 65, ageMonths: 0 })).toBe(
      '2050-06-15',
    );
  });

  it('handles age in months that rolls into the next year', () => {
    expect(retirementDate('1985-06-15', { ageYears: 64, ageMonths: 18 })).toBe(
      '2050-12-15',
    );
  });

  it('handles age that rolls month index past 12 across multiple years', () => {
    expect(retirementDate('1985-06-15', { ageYears: 0, ageMonths: 30 })).toBe(
      '1987-12-15',
    );
  });

  it('clamps day-of-month for shorter target months (Feb 29 -> Feb 28)', () => {
    expect(retirementDate('1984-02-29', { ageYears: 1, ageMonths: 0 })).toBe(
      '1985-02-28',
    );
  });
});

describe('ageOnDate', () => {
  it('returns 0y 0m when target is the birthdate', () => {
    expect(ageOnDate('1985-06-15', '1985-06-15')).toEqual({
      ageYears: 0,
      ageMonths: 0,
    });
  });

  it('returns whole years on exact anniversary', () => {
    expect(ageOnDate('1985-06-15', '2050-06-15')).toEqual({
      ageYears: 65,
      ageMonths: 0,
    });
  });

  it('returns years + months when target lands part-way through a year', () => {
    // 1988-03-15 to 2050-06-15: 62 years, 3 months (day equal).
    expect(ageOnDate('1988-03-15', '2050-06-15')).toEqual({
      ageYears: 62,
      ageMonths: 3,
    });
  });

  it('borrows a month when day-of-month is earlier than birthday day', () => {
    // 1985-06-20 to 2050-06-15: 64y 11m (day 15 < day 20 -> borrow).
    expect(ageOnDate('1985-06-20', '2050-06-15')).toEqual({
      ageYears: 64,
      ageMonths: 11,
    });
  });

  it('clamps to 0y 0m when target precedes birthdate', () => {
    expect(ageOnDate('1990-01-01', '1985-01-01')).toEqual({
      ageYears: 0,
      ageMonths: 0,
    });
  });
});

describe('retirementDatesDiffer', () => {
  it('returns false when both members hit retirement on the same day', () => {
    // Both born same day, both retire at same age -> same date.
    expect(
      retirementDatesDiffer(
        '1985-06-15',
        { ageYears: 65, ageMonths: 0 },
        '1985-06-15',
        { ageYears: 65, ageMonths: 0 },
      ),
    ).toBe(false);
  });

  it('returns true when birthdates differ but ages match (different dates)', () => {
    expect(
      retirementDatesDiffer(
        '1985-06-15',
        { ageYears: 65, ageMonths: 0 },
        '1988-03-15',
        { ageYears: 65, ageMonths: 0 },
      ),
    ).toBe(true);
  });

  it('returns false when ages compensate exactly for the birthdate gap (same date)', () => {
    // Sam born 2y 9m after Alex. Alex retires at 65y 0m -> 2050-06-15.
    // For Sam to retire 2050-06-15, age = 62y 3m.
    expect(
      retirementDatesDiffer(
        '1985-06-15',
        { ageYears: 65, ageMonths: 0 },
        '1988-03-15',
        { ageYears: 62, ageMonths: 3 },
      ),
    ).toBe(false);
  });
});

describe('resolveMemberRetirementDates', () => {
  it('returns null per member when retirementAge is undefined', () => {
    const result = resolveMemberRetirementDates(undefined, [
      { id: 'p', isPrimary: true, birthdate: '1985-06-15' },
      { id: 's', isPrimary: false, birthdate: '1988-03-12' },
    ]);
    expect(result.get('p')).toBeNull();
    expect(result.get('s')).toBeNull();
  });

  it('returns each member\'s own birthdate+age date in independent mode', () => {
    const result = resolveMemberRetirementDates(
      {
        primary: { ageYears: 65, ageMonths: 0 },
        secondary: { ageYears: 62, ageMonths: 3 },
      },
      [
        { id: 'p', isPrimary: true, birthdate: '1985-06-15' },
        { id: 's', isPrimary: false, birthdate: '1988-03-12' },
      ],
    );
    expect(result.get('p')).toBe('2050-06-15');
    // Secondary computed independently — note the 12th, NOT the 15th.
    expect(result.get('s')).toBe('2050-06-12');
  });

  it('snaps secondary to primary\'s exact date when sameDateAnchor === primary, even with a day-of-month gap', () => {
    // Without the snap, secondary born on the 12th would land on the
    // 12th of some month; the anchor's date is on the 15th.
    const result = resolveMemberRetirementDates(
      {
        primary: { ageYears: 65, ageMonths: 0 },
        // Note: stored age is FLOORED to whole months — re-deriving the
        // secondary's date from `birthdate + age` is exactly what the
        // snap is here to prevent.
        secondary: { ageYears: 62, ageMonths: 3 },
        sameDateAnchor: 'primary',
      },
      [
        { id: 'p', isPrimary: true, birthdate: '1985-06-15' },
        { id: 's', isPrimary: false, birthdate: '1988-03-12' },
      ],
    );
    expect(result.get('p')).toBe('2050-06-15');
    expect(result.get('s')).toBe('2050-06-15');
    expect(result.get('p')).toBe(result.get('s'));
  });

  it('snaps primary to secondary\'s exact date when sameDateAnchor === secondary', () => {
    const result = resolveMemberRetirementDates(
      {
        primary: { ageYears: 65, ageMonths: 0 },
        secondary: { ageYears: 67, ageMonths: 0 },
        sameDateAnchor: 'secondary',
      },
      [
        { id: 'p', isPrimary: true, birthdate: '1985-06-15' },
        { id: 's', isPrimary: false, birthdate: '1988-03-12' },
      ],
    );
    expect(result.get('s')).toBe('2055-03-12');
    expect(result.get('p')).toBe('2055-03-12');
  });

  it('handles single-member household (no secondary) without throwing', () => {
    const result = resolveMemberRetirementDates(
      { primary: { ageYears: 65, ageMonths: 0 }, sameDateAnchor: 'primary' },
      [{ id: 'p', isPrimary: true, birthdate: '1985-06-15' }],
    );
    expect(result.get('p')).toBe('2050-06-15');
    expect(result.size).toBe(1);
  });

  it('returns null for the snap target when the anchor side cannot be computed', () => {
    // Primary age missing -> primary date is null -> snap can't apply ->
    // secondary keeps its own birthdate+age (or null if it also lacks an age).
    const result = resolveMemberRetirementDates(
      {
        secondary: { ageYears: 62, ageMonths: 3 },
        sameDateAnchor: 'primary',
      },
      [
        { id: 'p', isPrimary: true, birthdate: '1985-06-15' },
        { id: 's', isPrimary: false, birthdate: '1988-03-12' },
      ],
    );
    expect(result.get('p')).toBeNull();
    expect(result.get('s')).toBe('2050-06-12');
  });
});
