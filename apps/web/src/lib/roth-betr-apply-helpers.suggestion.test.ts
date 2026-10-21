/**
 * Unit tests for the saved-plan write-back: a ranked suggestion's ladder as the
 * scenario's whole MAGI-cap ladder, through the shared inheritance rule.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSuggestionCap,
  buildSuggestionCapWindows,
} from './roth-betr-apply-helpers';
import { resolveScenario, type ScenarioAggregate } from './scenario-resolution';
import type {
  MagiCapOverride,
  MagiCapWindow,
  ScenarioOverrides,
} from '../db/types';

function oneYear(year: number, ceiling: number, over: Partial<MagiCapWindow> = {}): MagiCapWindow {
  return {
    start: { kind: 'year', year },
    end: { kind: 'year', year },
    magiCeilingAnnualDollars: ceiling,
    capMode: 'fill',
    capMagiLine: 'irmaa',
    targetRothAccountId: 'roth-1',
    ...over,
  };
}

const LADDER = [
  oneYear(2031, 150_000),
  oneYear(2032, 151_250),
  oneYear(2033, 0),
  oneYear(2034, 160_999),
  oneYear(2035, 162_000),
];

function scenario(
  id: string,
  parentScenarioId: string | null,
  overrides: ScenarioOverrides,
): ScenarioAggregate {
  return {
    id,
    householdId: 'h',
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd',
    payload: { name: id, description: '', parentScenarioId, isPrimary: false, notes: '', overrides },
  };
}

describe('buildSuggestionCapWindows', () => {
  it('writes one year-anchored Fill window per searched year, ascending, equal-year anchors', () => {
    const windows = buildSuggestionCapWindows([...LADDER].reverse());
    expect(windows.map((w) => (w.start.kind === 'year' ? w.start.year : null))).toEqual([
      2031, 2032, 2033, 2034, 2035,
    ]);
    for (const w of windows) {
      expect(w.start.kind).toBe('year');
      expect(w.end).toEqual(w.start);
      expect(w.capMode).toBe('fill');
      expect(Number.isInteger(w.magiCeilingAnnualDollars)).toBe(true);
    }
    // No window outside the searched span.
    expect(windows).toHaveLength(LADDER.length);
  });

  it('carries each window line and the target Roth through unchanged', () => {
    const windows = buildSuggestionCapWindows([
      oneYear(2031, 100_000, { capMagiLine: 'aca', targetRothAccountId: 'roth-2' }),
      oneYear(2032, 100_000),
    ]);
    expect(windows[0]).toMatchObject({ capMagiLine: 'aca', targetRothAccountId: 'roth-2' });
    expect(windows[1]).toMatchObject({ capMagiLine: 'irmaa', targetRothAccountId: 'roth-1' });
  });

  it('never rounds a ceiling up past the search figure, and keeps a searched zero', () => {
    const windows = buildSuggestionCapWindows([oneYear(2031, 150_000.9), oneYear(2032, 0)]);
    expect(windows.map((w) => w.magiCeilingAnnualDollars)).toEqual([150_000, 0]);
  });

  it('leaves a year outside the search with no window rather than a zero ceiling', () => {
    const windows = buildSuggestionCapWindows([oneYear(2031, 1), oneYear(2033, 1)]);
    expect(windows).toHaveLength(2);
  });

  it('refuses a ladder that is not a list of one-year Fill windows with a target', () => {
    expect(() => buildSuggestionCapWindows([])).toThrow(/no years/);
    expect(() =>
      buildSuggestionCapWindows([oneYear(2031, 1, { end: { kind: 'year', year: 2032 } })]),
    ).toThrow(/one-year Fill/);
    expect(() =>
      buildSuggestionCapWindows([oneYear(2031, 1, { start: { kind: 'retirementStart' } })]),
    ).toThrow(/one-year Fill/);
    expect(() => buildSuggestionCapWindows([oneYear(2031, 1, { capMode: 'minimize' })])).toThrow(
      /one-year Fill/,
    );
    expect(() =>
      buildSuggestionCapWindows([oneYear(2031, 1, { targetRothAccountId: undefined })]),
    ).toThrow(/one-year Fill/);
    expect(() => buildSuggestionCapWindows([oneYear(2031, 1), oneYear(2031, 2)])).toThrow(
      /same year/,
    );
  });
});

describe('buildSuggestionCap', () => {
  const parentLadder: MagiCapOverride = { windows: buildSuggestionCapWindows(LADDER) };

  it('changes nothing but magiCap, replacing the existing windows', () => {
    const local: ScenarioOverrides = {
      preRetirementRothConversions: [
        {
          sourceAccountId: 'ira',
          targetRothAccountId: 'roth-1',
          annualAmountDollars: 5_000,
          start: { kind: 'year', year: 2027 },
          end: { kind: 'age', memberId: 'primary', years: 62, months: 0 },
        },
      ],
      socialSecurity: { primary: { ageYears: 67, ageMonths: 0 } },
      magiCap: {
        windows: [
          {
            start: { kind: 'retirementStart' },
            end: { kind: 'age', memberId: 'primary', years: 75, months: 0 },
            magiCeilingAnnualDollars: 90_000,
            capMode: 'minimize',
            capMagiLine: 'irmaa',
          },
        ],
      },
    };
    const fragment = buildSuggestionCap({
      ladder: LADDER,
      localOverrides: local,
      parentCap: local.magiCap as MagiCapOverride,
    });
    expect(Object.keys(fragment)).toEqual(['magiCap']);
    const next = { ...local, ...fragment };
    const { magiCap: before, ...restBefore } = local;
    const { magiCap: after, ...restAfter } = next;
    void before;
    expect(restAfter).toEqual(restBefore);
    expect(after).toEqual(parentLadder);
  });

  it('inheritance matrix: resolving afterwards yields the saved ladder in every case', () => {
    const cases: Array<{
      name: string;
      parent: ScenarioOverrides;
      child: ScenarioOverrides;
      plan: MagiCapWindow[];
      writesKey: boolean;
    }> = [
      { name: 'base scenario', parent: {}, child: {}, plan: LADDER, writesKey: true },
      {
        name: 'child with no local cap and a plan equal to the parent ladder',
        parent: { magiCap: parentLadder },
        child: {},
        plan: LADDER,
        writesKey: false,
      },
      {
        name: 'child with no local cap and a differing plan',
        parent: { magiCap: { windows: [oneYear(2031, 99_000)] } },
        child: {},
        plan: LADDER,
        writesKey: true,
      },
      {
        name: 'child carrying the disable sentinel',
        parent: { magiCap: { windows: [oneYear(2031, 99_000)] } },
        child: { magiCap: { disabled: true } },
        plan: LADDER,
        writesKey: true,
      },
    ];
    for (const c of cases) {
      const parent = scenario('parent', null, c.parent);
      const isBase = c.name === 'base scenario';
      const child = scenario('child', isBase ? null : 'parent', c.child);
      const resolvedBefore = resolveScenario('child', [parent, child]);
      const fragment = buildSuggestionCap({
        ladder: c.plan,
        localOverrides: child.payload.overrides,
        parentCap:
          resolvedBefore.magiCap !== undefined && 'windows' in resolvedBefore.magiCap
            ? resolvedBefore.magiCap
            : undefined,
      });
      expect('magiCap' in fragment && fragment.magiCap !== undefined, c.name).toBe(c.writesKey);
      const saved = scenario('child', isBase ? null : 'parent', { ...c.child, ...fragment });
      const resolved = resolveScenario('child', [parent, saved]);
      expect(resolved.magiCap, c.name).toEqual({ windows: buildSuggestionCapWindows(c.plan) });
      // The parent is untouched.
      expect(parent.payload.overrides).toEqual(c.parent);
    }
  });
});
