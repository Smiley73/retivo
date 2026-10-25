// Per-id sparse override resolver: per-key merge, clear markers, disable-wins, first-ancestor-wins and id normalization.
import { describe, expect, it } from 'vitest';
import {
  resolveExpensesForScenarioSparse,
  normalizeOverrideId,
} from './expense-override-resolution';
import type { Aggregate, ExpensePayload, ScenarioPayload } from '../db/types';
import type { ScenarioAggregate } from './scenario-resolution';

const HH = 'hh-1';

const baseExpense = (overrides: Partial<ExpensePayload> = {}): ExpensePayload => ({
  name: 'Utilities',
  amount: 400,
  frequency: 'monthly',
  classification: 'essential',
  categoryId: 'cat-utilities',
  start: { kind: 'retirementStart' },
  end: { kind: 'lifetime', whose: 'last' },
  ...overrides,
});

const expense = (
  id: string,
  payload: Partial<ExpensePayload> = {},
): Aggregate<ExpensePayload> => ({
  id,
  householdId: HH,
  aggregateType: 'expense',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-14T00:00:00Z',
  deviceId: 'd',
  payload: baseExpense(payload),
});

const scenario = (
  id: string,
  parentScenarioId: string | null,
  scenarioOverrides: Partial<ScenarioPayload> = {},
): ScenarioAggregate => ({
  id,
  householdId: HH,
  aggregateType: 'scenario',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-14T00:00:00Z',
  deviceId: 'd',
  payload: {
    name: id,
    description: '',
    parentScenarioId,
    isPrimary: parentScenarioId === null,
    notes: '',
    overrides: {},
    ...scenarioOverrides,
  },
});

describe('resolveExpensesForScenarioSparse — single scenario', () => {
  it('returns the canonical list verbatim when the scenario has no expense overrides', () => {
    const exp = [expense('e1'), expense('e2', { name: 'Mortgage', amount: 2200 })];
    const sc = scenario('s1', null);
    const result = resolveExpensesForScenarioSparse('s1', [sc], exp);
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.source === 'canonical')).toBe(true);
    expect(result.map((r) => r.id)).toEqual(['aggregate:e1', 'aggregate:e2']);
  });

  it('drops canonical entries listed in disabledIds (prefixed)', () => {
    const exp = [expense('e1'), expense('e2')];
    const sc = scenario('s1', null, {
      overrides: { expenses: { disabledIds: ['aggregate:e1'] } },
    });
    const result = resolveExpensesForScenarioSparse('s1', [sc], exp);
    expect(result.map((r) => r.id)).toEqual(['aggregate:e2']);
  });

  it('applies a patch with top-level replace (not deep merge)', () => {
    const exp = [
      expense('e1', {
        amount: 400,
        start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      }),
    ];
    const sc = scenario('s1', null, {
      overrides: {
        expenses: {
          patches: {
            'aggregate:e1': { amount: 250, start: { kind: 'year', year: 2032 } },
          },
        },
      },
    });
    const result = resolveExpensesForScenarioSparse('s1', [sc], exp);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('patched');
    expect(result[0].payload.amount).toBe(250);
    expect(result[0].payload.start).toEqual({ kind: 'year', year: 2032 });
    expect(result[0].payload.name).toBe('Utilities');
  });

  it('appends scenario-only added entries with `local:<_localId>` ids', () => {
    const sc = scenario('s1', null, {
      overrides: {
        expenses: {
          added: [
            { ...baseExpense({ name: 'Travel splurge', amount: 5000, frequency: 'yearly' }), _localId: 'l-1' },
          ],
        },
      },
    });
    const result = resolveExpensesForScenarioSparse('s1', [sc], []);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('added');
    expect(result[0].id).toBe('local:l-1');
    expect(result[0].payload).not.toHaveProperty('_localId');
  });
});

describe('resolveExpensesForScenarioSparse — sparse inheritance', () => {
  // Pinned defect: the pre-sparse resolver could not let a child re-enable a parent-disabled expense.
  it('child re-enables a parent-disabled expense via reEnabledIds', () => {
    const exp = [expense('e1'), expense('e2')];
    const parent = scenario('parent', null, {
      overrides: { expenses: { disabledIds: ['aggregate:e1'] } },
    });
    const child = scenario('child', 'parent', {
      overrides: { expenses: { reEnabledIds: ['aggregate:e1'] } },
    });
    const result = resolveExpensesForScenarioSparse('child', [parent, child], exp);
    expect(result.map((r) => r.id)).toEqual(['aggregate:e1', 'aggregate:e2']);
  });

  it('parent patches A + child patches B → both apply (per-id first-ancestor-wins)', () => {
    const exp = [
      expense('a', { name: 'A', amount: 100 }),
      expense('b', { name: 'B', amount: 200 }),
    ];
    const parent = scenario('parent', null, {
      overrides: {
        expenses: { patches: { 'aggregate:a': { amount: 111 } } },
      },
    });
    const child = scenario('child', 'parent', {
      overrides: {
        expenses: { patches: { 'aggregate:b': { amount: 222 } } },
      },
    });
    const result = resolveExpensesForScenarioSparse(
      'child',
      [parent, child],
      exp,
    );
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.id === 'aggregate:a')?.payload.amount).toBe(111);
    expect(result.find((r) => r.id === 'aggregate:b')?.payload.amount).toBe(222);
  });

  it('child patch on the same id wins (closer-to-leaf scenario wins per-id)', () => {
    const exp = [expense('a', { amount: 100 })];
    const parent = scenario('parent', null, {
      overrides: { expenses: { patches: { 'aggregate:a': { amount: 111 } } } },
    });
    const child = scenario('child', 'parent', {
      overrides: { expenses: { patches: { 'aggregate:a': { amount: 222 } } } },
    });
    const result = resolveExpensesForScenarioSparse(
      'child',
      [parent, child],
      exp,
    );
    expect(result[0].payload.amount).toBe(222);
    expect(result[0].source).toBe('patched');
  });

  it('disable from a deeper ancestor still applies when child does not re-enable', () => {
    const exp = [expense('e1'), expense('e2')];
    const grandparent = scenario('gp', null, {
      overrides: { expenses: { disabledIds: ['aggregate:e1'] } },
    });
    const parent = scenario('p', 'gp');
    const child = scenario('c', 'p');
    const result = resolveExpensesForScenarioSparse(
      'c',
      [grandparent, parent, child],
      exp,
    );
    expect(result.map((r) => r.id)).toEqual(['aggregate:e2']);
  });

  it('parent contributes added entries when no descendant disables them', () => {
    const parent = scenario('parent', null, {
      overrides: {
        expenses: {
          added: [
            { ...baseExpense({ name: 'Parent-only', amount: 100 }), _localId: 'l-p' },
          ],
        },
      },
    });
    const child = scenario('child', 'parent', {
      overrides: {
        expenses: {
          added: [
            { ...baseExpense({ name: 'Child-only', amount: 200 }), _localId: 'l-c' },
          ],
        },
      },
    });
    const result = resolveExpensesForScenarioSparse('child', [parent, child], []);
    expect(result.map((r) => r.id).sort()).toEqual(['local:l-c', 'local:l-p']);
  });

  it('child disables a parent-added entry via local:<id> in disabledIds', () => {
    const parent = scenario('parent', null, {
      overrides: {
        expenses: {
          added: [
            { ...baseExpense({ name: 'Parent-added', amount: 100 }), _localId: 'l-p' },
          ],
        },
      },
    });
    const child = scenario('child', 'parent', {
      overrides: { expenses: { disabledIds: ['local:l-p'] } },
    });
    const result = resolveExpensesForScenarioSparse('child', [parent, child], []);
    expect(result).toHaveLength(0);
  });
});

describe('resolveExpensesForScenarioSparse — per-key chain merge', () => {
  const glide = {
    endMultiplierPct: 60,
    glideStart: { kind: 'age' as const, memberId: 'primary' as const, years: 65, months: 0 },
    glideEnd: { kind: 'age' as const, memberId: 'primary' as const, years: 80, months: 0 },
  };

  it('parent patches {amount}, child patches {discretionaryGlide} on the SAME id → both resolve', () => {
    const exp = [
      expense('a', {
        name: 'Travel',
        amount: 100,
        classification: 'discretionary',
        categoryId: 'cat-fun',
      }),
    ];
    const parent = scenario('parent', null, {
      overrides: { expenses: { patches: { 'aggregate:a': { amount: 555 } } } },
    });
    const child = scenario('child', 'parent', {
      overrides: {
        expenses: { patches: { 'aggregate:a': { discretionaryGlide: glide } } },
      },
    });
    const result = resolveExpensesForScenarioSparse(
      'child',
      [parent, child],
      exp,
    );
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('patched');
    expect(result[0].payload.amount).toBe(555);
    expect(result[0].payload.discretionaryGlide).toEqual(glide);
    expect(result[0].payload.name).toBe('Travel');
  });

  it('closest-scenario-wins per key: child {amount:2} beats parent {amount:1} while parent {categoryId} still inherits', () => {
    const exp = [expense('a', { amount: 100, categoryId: 'cat-orig' })];
    const parent = scenario('parent', null, {
      overrides: {
        expenses: {
          patches: { 'aggregate:a': { amount: 1, categoryId: 'cat-parent' } },
        },
      },
    });
    const child = scenario('child', 'parent', {
      overrides: { expenses: { patches: { 'aggregate:a': { amount: 2 } } } },
    });
    const result = resolveExpensesForScenarioSparse(
      'child',
      [parent, child],
      exp,
    );
    expect(result[0].payload.amount).toBe(2); // child wins this key
    expect(result[0].payload.categoryId).toBe('cat-parent'); // parent's key inherits
  });

  it('single-ancestor-patch resolution is byte-identical to a hand-computed {...canonical, ...patch}', () => {
    const canonical = baseExpense({
      name: 'Mortgage',
      amount: 2200,
      categoryId: 'cat-housing',
      start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
    });
    const exp: Aggregate<ExpensePayload>[] = [
      {
        id: 'a',
        householdId: HH,
        aggregateType: 'expense',
        schemaVersion: 1,
        version: 1,
        updatedAt: '2026-05-14T00:00:00Z',
        deviceId: 'd',
        payload: canonical,
      },
    ];
    const patch = { amount: 1800, start: { kind: 'year' as const, year: 2032 } };
    const sc = scenario('s1', null, {
      overrides: { expenses: { patches: { 'aggregate:a': patch } } },
    });
    const result = resolveExpensesForScenarioSparse('s1', [sc], exp);
    expect(result).toHaveLength(1);
    expect(result[0].payload).toEqual({ ...canonical, ...patch });
  });

  it('disable/re-enable resolution unchanged under the per-key merge resolver', () => {
    const exp = [expense('e1'), expense('e2')];
    const grandparent = scenario('gp', null, {
      overrides: { expenses: { disabledIds: ['aggregate:e1'] } },
    });
    const parent = scenario('p', 'gp', {
      overrides: { expenses: { reEnabledIds: ['aggregate:e1'] } },
    });
    const child = scenario('c', 'p');
    const result = resolveExpensesForScenarioSparse(
      'c',
      [grandparent, parent, child],
      exp,
    );
    expect(result.map((r) => r.id).sort()).toEqual([
      'aggregate:e1',
      'aggregate:e2',
    ]);
  });
});

describe('resolveExpensesForScenarioSparse — defensive raw-id normalization', () => {
  // A raw (un-prefixed) id resolves like its `aggregate:<raw>` form, in case a write site misses the prefix.

  it('aggregate:abc and local:abc do NOT collide (different namespaces)', () => {
    const exp = [expense('abc', { amount: 100 })];
    const sc = scenario('s1', null, {
      overrides: {
        expenses: {
          added: [
            { ...baseExpense({ name: 'Local with same uuid', amount: 200 }), _localId: 'abc' },
          ],
          disabledIds: ['local:abc'], // disables only the local entry
        },
      },
    });
    const result = resolveExpensesForScenarioSparse('s1', [sc], exp);
    expect(result.map((r) => r.id)).toEqual(['aggregate:abc']);
  });
});

describe('resolveExpensesForScenarioSparse — null clears an inherited key', () => {
  const glide = {
    endMultiplierPct: 60,
    glideStart: { kind: 'age' as const, memberId: 'primary' as const, years: 65, months: 0 },
    glideEnd: { kind: 'age' as const, memberId: 'primary' as const, years: 80, months: 0 },
  };

  it('a null patch on discretionaryGlide drops the inherited glide → engine default', () => {
    const exp = [
      expense('e1', { classification: 'discretionary', discretionaryGlide: glide }),
    ];
    const sc = scenario('s1', null, {
      overrides: {
        expenses: { patches: { 'aggregate:e1': { discretionaryGlide: null } } },
      },
    });
    const result = resolveExpensesForScenarioSparse('s1', [sc], exp);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('patched');
    expect(result[0].payload).not.toHaveProperty('discretionaryGlide');
    expect(result[0].payload.amount).toBe(400);
  });

  it('the null clear is scoped to its scenario — a sibling keeps the glide', () => {
    const exp = [
      expense('e1', { classification: 'discretionary', discretionaryGlide: glide }),
    ];
    const clearing = scenario('clearing', null, {
      overrides: {
        expenses: { patches: { 'aggregate:e1': { discretionaryGlide: null } } },
      },
    });
    const sibling = scenario('sibling', null);
    const cleared = resolveExpensesForScenarioSparse(
      'clearing',
      [clearing, sibling],
      exp,
    );
    const kept = resolveExpensesForScenarioSparse(
      'sibling',
      [clearing, sibling],
      exp,
    );
    expect(cleared[0].payload).not.toHaveProperty('discretionaryGlide');
    expect(kept[0].payload.discretionaryGlide).toEqual(glide);
  });

  it('chain merge: a closer null clear wins over a deeper set; a deeper clear loses to a closer set', () => {
    const exp = [expense('e1', { classification: 'discretionary' })];
    const parentSet = scenario('parentSet', null, {
      overrides: {
        expenses: { patches: { 'aggregate:e1': { discretionaryGlide: glide } } },
      },
    });
    const childClear = scenario('childClear', 'parentSet', {
      overrides: {
        expenses: { patches: { 'aggregate:e1': { discretionaryGlide: null } } },
      },
    });
    const a = resolveExpensesForScenarioSparse(
      'childClear',
      [parentSet, childClear],
      exp,
    );
    expect(a[0].payload).not.toHaveProperty('discretionaryGlide');

    const parentClear = scenario('parentClear', null, {
      overrides: {
        expenses: { patches: { 'aggregate:e1': { discretionaryGlide: null } } },
      },
    });
    const childSet = scenario('childSet', 'parentClear', {
      overrides: {
        expenses: { patches: { 'aggregate:e1': { discretionaryGlide: glide } } },
      },
    });
    const b = resolveExpensesForScenarioSparse(
      'childSet',
      [parentClear, childSet],
      exp,
    );
    expect(b[0].payload.discretionaryGlide).toEqual(glide);
  });

  it('a null-free patch resolves identically to a hand-computed shallow merge (regression guard)', () => {
    const exp = [expense('e1', { amount: 400 })];
    const sc = scenario('s1', null, {
      overrides: { expenses: { patches: { 'aggregate:e1': { amount: 999 } } } },
    });
    const result = resolveExpensesForScenarioSparse('s1', [sc], exp);
    expect(result[0].payload).toEqual({ ...baseExpense(), amount: 999 });
  });
});

describe('normalizeOverrideId', () => {
  it('prefixes a raw id as aggregate:<raw>', () => {
    expect(normalizeOverrideId('abc')).toBe('aggregate:abc');
  });
  it('passes through aggregate:<uuid> unchanged', () => {
    expect(normalizeOverrideId('aggregate:abc')).toBe('aggregate:abc');
  });
  it('passes through local:<uuid> unchanged', () => {
    expect(normalizeOverrideId('local:l-1')).toBe('local:l-1');
  });
});
