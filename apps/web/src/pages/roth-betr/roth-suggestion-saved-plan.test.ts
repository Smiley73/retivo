/**
 * Saved-plan marker: written on save with the post-save signature, stale only
 * when something the search consumed changed, dropped when the scenario no
 * longer carries the saved ladder, and scoped per scenario id.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MagiCapWindow, ScenarioOverrides } from '../../db/types';
import { buildSuggestionCapWindows } from '../../lib/roth-betr-apply-helpers';
import { toyProjection, TOY_ROTH_ID } from '../../lib/roth-suggestion/test-fixtures';
import type { ScenarioAggregate } from '../../lib/scenario-resolution';
import {
  buildSavedPlanRecord,
  readSavedPlan,
  savedPlanStatus,
  writeSavedPlan,
} from './roth-suggestion-saved-plan';
import type { RothSuggestionData } from './roth-suggestion-view-model';

function oneYear(year: number, ceiling: number): MagiCapWindow {
  return {
    start: { kind: 'year', year },
    end: { kind: 'year', year },
    magiCeilingAnnualDollars: ceiling,
    capMode: 'fill',
    capMagiLine: 'irmaa',
    targetRothAccountId: TOY_ROTH_ID,
  };
}

const LADDER = [oneYear(2031, 150_000), oneYear(2032, 151_000), oneYear(2033, 152_000)];
const NOW = new Date(2026, 4, 17, 23, 30);

function base(): RothSuggestionData {
  return toyProjection({ couple: false });
}

/** The data after a save: the scenario carries the ladder and its version bumped. */
function afterSave(
  data: RothSuggestionData,
  ladder: readonly MagiCapWindow[] = LADDER,
  scenarioId = 'toy',
): RothSuggestionData {
  return {
    ...data,
    scenarios: data.scenarios.map((s) =>
      s.id === scenarioId
        ? {
            ...s,
            version: s.version + 1,
            payload: {
              ...s.payload,
              overrides: {
                ...s.payload.overrides,
                magiCap: { windows: buildSuggestionCapWindows(ladder) },
              },
            },
          }
        : s,
    ),
  };
}

function withChild(data: RothSuggestionData, childOverrides: ScenarioOverrides = {}): RothSuggestionData {
  const child: ScenarioAggregate = {
    ...data.scenarios[0],
    id: 'child',
    payload: {
      ...data.scenarios[0].payload,
      name: 'Child',
      parentScenarioId: 'toy',
      overrides: childOverrides,
    },
  };
  return { ...data, scenarios: [...data.scenarios, child] };
}

function savedFor(data: RothSuggestionData, scenarioId = 'toy') {
  return buildSavedPlanRecord({
    data,
    scenarioId,
    label: 'Fill the 24% bracket, kept under both lines',
    ladder: LADDER,
    now: NOW,
  });
}

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe('buildSavedPlanRecord', () => {
  it('stores comparison keys, the plan name and the local date, and no ceilings', () => {
    const record = savedFor(base());
    expect(record.label).toBe('Fill the 24% bracket, kept under both lines');
    expect(record.savedOn).toBe('2026-05-17');
    expect(Object.keys(record).sort()).toEqual(['label', 'savedOn', 'signature', 'ladderHash'].sort());
    // No ceiling, and the scenario's overrides only as a hash.
    expect(JSON.stringify(record)).not.toMatch(/150000|151000|152000|ratePct|lifeExpectancy/);
  });
});

describe('savedPlanStatus', () => {
  it('is not stale immediately after the save, although the save bumped the scenario version', () => {
    const before = base();
    const record = savedFor(before);
    const after = afterSave(before);
    expect(after.scenarios[0].version).toBe(before.scenarios[0].version + 1);
    expect(savedPlanStatus(record, after, 'toy')).toEqual({
      label: record.label,
      savedOn: '2026-05-17',
      stale: false,
    });
  });

  it('goes stale after an edit to any aggregate the search consumed', () => {
    const before = base();
    const record = savedFor(before);
    const after = afterSave(before);
    const bump = <T extends { version: number }>(rows: readonly T[]): T[] =>
      rows.map((r, i) => (i === 0 ? { ...r, version: r.version + 1 } : r));
    const edits: Record<string, RothSuggestionData> = {
      member: { ...after, members: bump(after.members) },
      account: { ...after, accounts: bump(after.accounts) },
      balance: { ...after, balances: bump(after.balances) },
      ssBenefit: { ...after, ssBenefits: bump(after.ssBenefits) },
      expense: { ...after, expenses: bump(after.expenses) },
    };
    for (const [name, data] of Object.entries(edits)) {
      expect(savedPlanStatus(record, data, 'toy')?.stale, name).toBe(true);
    }
  });

  it('goes stale after an edit to the scenario outside its cap', () => {
    const before = base();
    const record = savedFor(before);
    const after = afterSave(before);
    const edited: RothSuggestionData = {
      ...after,
      scenarios: after.scenarios.map((s) => ({
        ...s,
        version: s.version + 1,
        payload: {
          ...s.payload,
          overrides: { ...s.payload.overrides, inflation: { ratePct: 3 } },
        },
      })),
    };
    expect(savedPlanStatus(record, edited, 'toy')?.stale).toBe(true);
  });

  it('goes stale after a parent edit a child inherits', () => {
    const before = withChild(base());
    const record = savedFor(before, 'child');
    const after = afterSave(before, LADDER, 'child');
    expect(savedPlanStatus(record, after, 'child')?.stale).toBe(false);
    const parentEdited: RothSuggestionData = {
      ...after,
      scenarios: after.scenarios.map((s) =>
        s.id === 'toy'
          ? {
              ...s,
              version: s.version + 1,
              payload: {
                ...s.payload,
                overrides: { ...s.payload.overrides, lifeExpectancy: { primary: 92, secondary: 92 } },
              },
            }
          : s,
      ),
    };
    expect(savedPlanStatus(record, parentEdited, 'child')?.stale).toBe(true);
  });

  it('drops the marker when the resolved cap no longer equals the saved ladder', () => {
    const before = base();
    const record = savedFor(before);
    const handEdited = afterSave(before, [oneYear(2031, 150_000), oneYear(2032, 151_001), oneYear(2033, 152_000)]);
    expect(savedPlanStatus(record, handEdited, 'toy')).toBeNull();
    expect(savedPlanStatus(record, before, 'toy')).toBeNull();
    const disabled: RothSuggestionData = {
      ...before,
      scenarios: before.scenarios.map((s) => ({
        ...s,
        payload: { ...s.payload, overrides: { ...s.payload.overrides, magiCap: { disabled: true } } },
      })),
    };
    expect(savedPlanStatus(record, disabled, 'toy')).toBeNull();
    expect(savedPlanStatus(null, afterSave(before), 'toy')).toBeNull();
  });

  it('keeps the marker for a child that inherits the saved ladder from its parent', () => {
    const before = withChild(base());
    const record = savedFor(before, 'child');
    // The plan was equal to the parent's ladder, so nothing was written to the child.
    const parentCarries = afterSave(before, LADDER, 'toy');
    expect(savedPlanStatus(record, parentCarries, 'child')?.stale).toBe(false);
  });
});

describe('local storage', () => {
  it('survives a reload and is scoped per scenario id', () => {
    const before = withChild(base());
    const toyRecord = savedFor(before, 'toy');
    const childRecord = { ...savedFor(before, 'child'), label: 'Another plan' };
    writeSavedPlan('toy', toyRecord);
    writeSavedPlan('child', childRecord);
    expect(readSavedPlan('toy')).toEqual(toyRecord);
    expect(readSavedPlan('child')).toEqual(childRecord);
    expect(readSavedPlan('other')).toBeNull();
  });

  it('reads a missing, unparseable or malformed value as no marker', () => {
    expect(readSavedPlan('toy')).toBeNull();
    writeSavedPlan('toy', savedFor(base()));
    const key = window.localStorage.key(0) ?? '';
    window.localStorage.setItem(key, '{not json');
    expect(readSavedPlan('toy')).toBeNull();
    window.localStorage.setItem(key, JSON.stringify({ label: 1 }));
    expect(readSavedPlan('toy')).toBeNull();
  });
});
