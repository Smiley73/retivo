/**
 * age-anchor-bounds — slider-bounds math for the schedule-anchor pickers.
 *
 * Focused coverage of the optional `minAgeFloor` / `minYearFloor` lower-bound
 * params (the mirror of the existing `maxAgeCap` / `maxYearCap` upper bounds)
 * the QCD editor uses to floor a gift window at the giver's 70½ eligibility.
 * A fixed `now` is injected so the current-age / current-year math is
 * deterministic.
 */
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
    // Born 1965 ⇒ age 61 at NOW; the 70 floor raises the slider min above it.
    const members = [member('1965-06-01')];
    const bounds = ageSliderBounds(72, 'primary', members, NOW, undefined, 70);
    expect(bounds.min).toBe(70);
  });

  it('is a no-op when the member is already older than the floor', () => {
    // Born 1950 ⇒ age 76 at NOW; the floor (70) is below the current age, so
    // the effective min stays the current age (the floor never LOWERS the min).
    const members = [member('1950-01-15')];
    const bounds = ageSliderBounds(80, 'primary', members, NOW, undefined, 70);
    expect(bounds.min).toBe(76);
  });

  it('never clamps an existing value below the floor (guard wins)', () => {
    // A stored anchor of 68 (below the 70 floor) still shows its real value —
    // the outer Math.min(floor, value) keeps the min at 68, not 70.
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
    // Age 61 at NOW; both omit / ignore the floor, so min === current age.
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
    // 2026 current year > 2000 floor ⇒ min stays the current year.
    expect(bounds.min).toBe(2026);
  });

  it('never clamps an existing value below the floor (guard wins)', () => {
    const members = [member('1965-06-01')];
    // A stored anchor of 2030 (below the 2035 floor) still shows its real value.
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
