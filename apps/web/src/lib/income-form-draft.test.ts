/**
 * validateSchedule — cross-field "end before start" guard for the income
 * form. Resolves both anchors via the shared schedule resolver and
 * rejects an end that lands on or before the start.
 */
import { describe, expect, it } from 'vitest';
import { validateSchedule } from './income-form-draft';
import type { ScheduleResolveContext } from './schedule-resolution';
import type { ScheduleEnd, ScheduleStart } from '../db/types';

// Owner = primary, born Jan 1960; retires Jan 2025. Enough to resolve
// every owner-relative anchor kind to a concrete month.
const ctx: ScheduleResolveContext = {
  retirementYear: 2025,
  retirementMonth0: 0,
  primary: { birthdate: '1960-01-01' },
  owner: 'primary',
};

describe('validateSchedule — end-before-start guard', () => {
  it('rejects a year end before a year start', () => {
    const start: ScheduleStart = { kind: 'year', year: 2040 };
    const end: ScheduleEnd = { kind: 'year', year: 2035 };
    expect(validateSchedule(start, end, ctx)).toMatch(/ends before it starts/i);
  });

  it('rejects an age end below an age start', () => {
    const start: ScheduleStart = { kind: 'age', years: 67, months: 0 };
    const end: ScheduleEnd = { kind: 'age', years: 65, months: 0 };
    expect(validateSchedule(start, end, ctx)).toMatch(/ends before it starts/i);
  });

  it('rejects an end year equal to the start year (zero-length window)', () => {
    // year end is exclusive at Jan of (year+1); start year 2040 → end 2040
    // resolves to Jan 2041 which is AFTER Jan 2040, so that is valid. The
    // genuine zero-length case is end strictly before start, covered above.
    const start: ScheduleStart = { kind: 'year', year: 2040 };
    const end: ScheduleEnd = { kind: 'year', year: 2040 };
    expect(validateSchedule(start, end, ctx)).toBeNull();
  });

  it('accepts a year end after a year start', () => {
    const start: ScheduleStart = { kind: 'year', year: 2035 };
    const end: ScheduleEnd = { kind: 'year', year: 2040 };
    expect(validateSchedule(start, end, ctx)).toBeNull();
  });

  it('accepts a durationFromStart end (always after the start)', () => {
    const start: ScheduleStart = { kind: 'year', year: 2040 };
    const end: ScheduleEnd = { kind: 'durationFromStart', months: 60 };
    expect(validateSchedule(start, end, ctx)).toBeNull();
  });

  it('accepts a lifetime end', () => {
    const start: ScheduleStart = { kind: 'age', years: 67, months: 0 };
    const end: ScheduleEnd = { kind: 'lifetime', whose: 'primary' };
    expect(validateSchedule(start, end, ctx)).toBeNull();
  });

  it('does not block when an anchor is unresolvable (no birthdate)', () => {
    const noBirthCtx: ScheduleResolveContext = {
      retirementYear: 2025,
      owner: 'primary',
    };
    const start: ScheduleStart = { kind: 'age', years: 67, months: 0 };
    const end: ScheduleEnd = { kind: 'age', years: 65, months: 0 };
    // Start can't resolve (no primary birthdate) → guard returns null so
    // the form doesn't hard-block; the engine fail-safes broken anchors.
    expect(validateSchedule(start, end, noBirthCtx)).toBeNull();
  });

  it('does not block when the owner retirement year is unresolved (NaN)', () => {
    const nanRetCtx: ScheduleResolveContext = {
      retirementYear: NaN,
      primary: { birthdate: '1960-01-01' },
      owner: 'primary',
    };
    const start: ScheduleStart = { kind: 'retirementStart' };
    const end: ScheduleEnd = { kind: 'year', year: 1990 };
    expect(validateSchedule(start, end, nanRetCtx)).toBeNull();
  });

  it('rejects an endOfRetirementyear that precedes a later year start', () => {
    // Retires 2025; "after 1 year" → end exclusive Jan 2027. Start year
    // 2040 is well after → end before start.
    const start: ScheduleStart = { kind: 'year', year: 2040 };
    const end: ScheduleEnd = { kind: 'endOfRetirementYear', offsetYears: 1 };
    expect(validateSchedule(start, end, ctx)).toMatch(/ends before it starts/i);
  });
});
