import { describe, expect, it } from 'vitest';
import { validateSchedule } from './income-form-draft';
import type { ScheduleResolveContext } from './schedule-resolution';
import type { ScheduleEnd, ScheduleStart } from '../db/types';

// Owner is the primary, born Jan 1960, retiring Jan 2025.
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
    // An unresolvable start returns null so the form does not hard-block; the engine fail-safes broken anchors.
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
    const start: ScheduleStart = { kind: 'year', year: 2040 };
    const end: ScheduleEnd = { kind: 'endOfRetirementYear', offsetYears: 1 };
    expect(validateSchedule(start, end, ctx)).toMatch(/ends before it starts/i);
  });
});
