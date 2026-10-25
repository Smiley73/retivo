// MAGI-cap window schedule save-time validation: required ceilings, non-overlap, and the broken-anchor exclusion (a window whose anchor can't resolve is dropped from the overlap math, not treated as an overlap).
import { describe, it, expect } from 'vitest';
import type { Aggregate, HouseholdMemberPayload } from '../db/types';
import {
  magiCapWindowOverlapError,
  magiCapWindowsSaveError,
  magiCapWindowTabLabels,
  magiCapWindowTimeframeError,
  type MagiCapRetirementAnchor,
} from './scenario-withdrawal-strategy-magi-cap-validation';
import type { DraftMagiCapWindow } from './scenario-withdrawal-strategy-shared';

// Real primary retirement anchor: windows resolve against it, not a synthetic year. Primary born 1965-01 retires 2030.
const anchor: MagiCapRetirementAnchor = {
  retirementYear: 2030,
  retirementMonth0: 0,
};

function member(
  isPrimary: boolean,
  birthdate: string | undefined,
): Aggregate<HouseholdMemberPayload> {
  return {
    id: isPrimary ? 'p' : 's',
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'householdMember',
    payload: {
      isPrimary,
      firstName: isPrimary ? 'John' : 'Jane',
      lastName: '',
      email: '',
      birthdate: birthdate ?? '',
    },
  };
}

// Only a primary exists, so a `secondary`-anchored age window can't resolve and is excluded from the overlap check.
const primaryOnly = [member(true, '1965-01-01')];

function yearWindow(
  startYear: number,
  endYear: number,
  ceiling: number | null = 50_000,
): DraftMagiCapWindow {
  return {
    start: { kind: 'year', year: startYear },
    end: { kind: 'year', year: endYear - 1 }, // end is inclusive-year; [start, endYear)
    magiCeilingAnnualDollars: ceiling,
    capMode: 'minimize',
    capMagiLine: 'irmaa',
  };
}

describe('magiCapWindowsSaveError — required ceilings', () => {
  it('empty windows array → no ceiling error (nothing to validate)', () => {
    expect(magiCapWindowsSaveError([], primaryOnly, anchor)).toBeNull();
  });

  it('a window with no ceiling entered → blocks save', () => {
    const windows = [yearWindow(2031, 2035, null)];
    expect(magiCapWindowsSaveError(windows, primaryOnly, anchor)).toMatch(
      /enter an annual cap/i,
    );
  });

  it('one valid window → no error', () => {
    expect(
      magiCapWindowsSaveError([yearWindow(2031, 2035)], primaryOnly, anchor),
    ).toBeNull();
  });
});

describe('magiCapWindowsSaveError / magiCapWindowOverlapError — non-overlap', () => {
  it('two non-overlapping windows → no error', () => {
    const windows = [yearWindow(2031, 2035), yearWindow(2035, 2040)];
    expect(magiCapWindowsSaveError(windows, primaryOnly, anchor)).toBeNull();
    expect(magiCapWindowOverlapError(windows, primaryOnly, anchor)).toBeNull();
  });

  it('adjacent windows (endYear === next.startYear) are NOT an overlap', () => {
    const windows = [yearWindow(2031, 2035), yearWindow(2035, 2040)];
    expect(magiCapWindowOverlapError(windows, primaryOnly, anchor)).toBeNull();
  });

  it('two overlapping windows → error', () => {
    const windows = [yearWindow(2031, 2036), yearWindow(2034, 2040)];
    expect(magiCapWindowOverlapError(windows, primaryOnly, anchor)).toMatch(
      /must not overlap/i,
    );
    expect(magiCapWindowsSaveError(windows, primaryOnly, anchor)).toMatch(
      /must not overlap/i,
    );
  });
});

describe('magiCapWindowTimeframeError — end must be after start', () => {
  it('a window whose end lands after its start → no error', () => {
    expect(
      magiCapWindowTimeframeError([yearWindow(2031, 2035)], primaryOnly, anchor),
    ).toBeNull();
  });

  it('a window whose end equals its start year → invalid', () => {
    // yearWindow(2035, 2035) resolves to [2035, 2035), which covers no whole year.
    expect(
      magiCapWindowTimeframeError([yearWindow(2035, 2035)], primaryOnly, anchor),
    ).toMatch(/end must come after its start/i);
  });

  it('a window whose end is before its start → invalid', () => {
    expect(
      magiCapWindowTimeframeError([yearWindow(2035, 2030)], primaryOnly, anchor),
    ).toMatch(/end must come after its start/i);
  });

  it('an inverted window also blocks the combined save gate', () => {
    expect(
      magiCapWindowsSaveError([yearWindow(2035, 2030)], primaryOnly, anchor),
    ).toMatch(/end must come after its start/i);
  });

  it('a window with an unresolvable anchor is NOT reported as a timeframe error', () => {
    const broken: DraftMagiCapWindow = {
      start: { kind: 'age', memberId: 'secondary', years: 60, months: 0 },
      end: { kind: 'age', memberId: 'secondary', years: 50, months: 0 },
      magiCeilingAnnualDollars: 40_000,
      capMode: 'minimize',
      capMagiLine: 'irmaa',
    };
    expect(magiCapWindowTimeframeError([broken], primaryOnly, anchor)).toBeNull();
  });
});

describe('magiCapWindowTabLabels — tab titles', () => {
  it('labels a resolved window with its inclusive year span (endYear - 1)', () => {
    expect(magiCapWindowTabLabels([yearWindow(2031, 2035)], primaryOnly, anchor)).toEqual([
      '2031 - 2034',
    ]);
  });

  it('labels each window independently, in order', () => {
    const windows = [yearWindow(2031, 2035), yearWindow(2035, 2040)];
    expect(magiCapWindowTabLabels(windows, primaryOnly, anchor)).toEqual([
      '2031 - 2034',
      '2035 - 2039',
    ]);
  });

  it('shows "From <startYear>" when only the start resolves (start of retirement)', () => {
    // Primary born 1965 retires 2030 and turns 65 the same year, so the default end collapses into the start year, yet the tab must still surface the retirement year the user picked, not "Window N".
    const w: DraftMagiCapWindow = {
      start: { kind: 'retirementStart' },
      end: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      magiCeilingAnnualDollars: 50_000,
      capMode: 'minimize',
      capMagiLine: 'irmaa',
    };
    expect(magiCapWindowTabLabels([w], primaryOnly, anchor)).toEqual(['From 2030']);
  });

  it('falls back to "Window N" when an anchor cannot resolve', () => {
    const broken: DraftMagiCapWindow = {
      start: { kind: 'age', memberId: 'secondary', years: 60, months: 0 },
      end: { kind: 'age', memberId: 'secondary', years: 70, months: 0 },
      magiCeilingAnnualDollars: 40_000,
      capMode: 'minimize',
      capMagiLine: 'irmaa',
    };
    expect(magiCapWindowTabLabels([yearWindow(2031, 2035), broken], primaryOnly, anchor)).toEqual([
      '2031 - 2034',
      'Window 2',
    ]);
  });
});

describe('magiCapWindowOverlapError — broken-anchor exclusion', () => {
  it('a window with an unresolvable anchor is excluded, not a false overlap', () => {
    // The broken window is `age`-anchored to the secondary member but the household has none, so the anchor can't resolve and the window drops out of the overlap math (it must not manufacture an overlap with the valid window even if it resolved to year 0).
    const broken: DraftMagiCapWindow = {
      start: { kind: 'age', memberId: 'secondary', years: 60, months: 0 },
      end: { kind: 'age', memberId: 'secondary', years: 70, months: 0 },
      magiCeilingAnnualDollars: 40_000,
      capMode: 'minimize',
      capMagiLine: 'irmaa',
    };
    const windows = [yearWindow(2031, 2035), broken];
    expect(magiCapWindowOverlapError(windows, primaryOnly, anchor)).toBeNull();
  });

  it('two valid windows still overlap-check around an excluded broken window', () => {
    const broken: DraftMagiCapWindow = {
      start: { kind: 'age', memberId: 'secondary', years: 60, months: 0 },
      end: { kind: 'age', memberId: 'secondary', years: 70, months: 0 },
      magiCeilingAnnualDollars: 40_000,
      capMode: 'minimize',
      capMagiLine: 'irmaa',
    };
    const windows = [yearWindow(2031, 2036), broken, yearWindow(2034, 2040)];
    expect(magiCapWindowOverlapError(windows, primaryOnly, anchor)).toMatch(
      /must not overlap/i,
    );
  });
});
