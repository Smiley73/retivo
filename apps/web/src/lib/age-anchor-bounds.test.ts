import { describe, expect, it } from 'vitest';
import { ageSliderBounds, yearSliderBounds } from './age-anchor-bounds';
import type { Aggregate, HouseholdMemberPayload } from '../db/types';

const NOW = new Date('2026-06-29T00:00:00Z');

function member(birthdate: string): Aggregate<HouseholdMemberPayload> {
  return {
    id: 'p',
    householdId: 'h',
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd',
    payload: {
      isPrimary: true,
      firstName: 'Pat',
      lastName: 'Giver',
      email: 'p@example.test',
      birthdate,
    },
  };
}

describe('ageSliderBounds — minAgeFloor', () => {
  it('raises the min to the floor for a member younger than the floor', () => {
    const members = [member('1965-06-01')];
    const bounds = ageSliderBounds(72, 'primary', members, NOW, undefined, 70);
    expect(bounds.min).toBe(70);
  });

  it('is a no-op when the member is already older than the floor', () => {
    const members = [member('1950-01-15')];
    const bounds = ageSliderBounds(80, 'primary', members, NOW, undefined, 70);
    expect(bounds.min).toBe(76);
  });

  it('never clamps an existing value below the floor (guard wins)', () => {
    const members = [member('1965-06-01')];
    const bounds = ageSliderBounds(68, 'primary', members, NOW, undefined, 70);
    expect(bounds.min).toBe(68);
  });

  it('ignores a non-finite floor (existing current-age min)', () => {
    const members = [member('1965-06-01')];
    const noFloor = ageSliderBounds(72, 'primary', members, NOW, undefined);
    const nanFloor = ageSliderBounds(
      72,
      'primary',
      members,
      NOW,
      undefined,
      Number.NaN,
    );
    expect(noFloor.min).toBe(61);
    expect(nanFloor.min).toBe(61);
  });
});

describe('yearSliderBounds — minYearFloor', () => {
  it('raises the min to a future floor year', () => {
    const members = [member('1965-06-01')];
    const bounds = yearSliderBounds(2040, members, NOW, undefined, 2035);
    expect(bounds.min).toBe(2035);
  });

  it('is a no-op when the floor is in the past (current year wins)', () => {
    const members = [member('1965-06-01')];
    const bounds = yearSliderBounds(2040, members, NOW, undefined, 2000);
    expect(bounds.min).toBe(2026);
  });

  it('never clamps an existing value below the floor (guard wins)', () => {
    const members = [member('1965-06-01')];
    const bounds = yearSliderBounds(2030, members, NOW, undefined, 2035);
    expect(bounds.min).toBe(2030);
  });

  it('ignores a non-finite floor (existing current-year min)', () => {
    const members = [member('1965-06-01')];
    const noFloor = yearSliderBounds(2040, members, NOW, undefined);
    const nanFloor = yearSliderBounds(
      2040,
      members,
      NOW,
      undefined,
      Number.NaN,
    );
    expect(noFloor.min).toBe(2026);
    expect(nanFloor.min).toBe(2026);
  });
});
