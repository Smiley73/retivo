/**
 * Per-id sparse override resolver — mirror of
 * `expense-override-resolution.test.ts` for the income section. Pins
 * the same semantics.
 */
import { describe, expect, it } from 'vitest';
import { resolveIncomeForScenarioSparse } from './income-override-resolution';
import type {
  Aggregate,
  IncomeStreamPayload,
  ScenarioPayload,
} from '../db/types';
import type { ScenarioAggregate } from './scenario-resolution';

const HH = 'hh-1';

const baseStream = (
  overrides: Partial<IncomeStreamPayload> = {},
): IncomeStreamPayload =>
  ({
    name: 'Pension',
    kind: 'pension',
    payoutType: 'annuity',
    memberId: 'primary',
    monthlyBenefit: 1000,
    start: { kind: 'age', years: 65, months: 0 },
    colaPct: 0,
    ...overrides,
  }) as IncomeStreamPayload;

const stream = (
  id: string,
  payload: Partial<IncomeStreamPayload> = {},
): Aggregate<IncomeStreamPayload> => ({
  id,
  householdId: HH,
  aggregateType: 'incomeStream',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-14T00:00:00Z',
  deviceId: 'd',
  payload: baseStream(payload),
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

describe('resolveIncomeForScenarioSparse — single scenario', () => {
  it('returns canonical streams verbatim when scenario has no income overrides', () => {
    const inc = [stream('i1'), stream('i2', { name: 'Annuity 2' })];
    const sc = scenario('s1', null);
    const result = resolveIncomeForScenarioSparse('s1', [sc], inc);
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.source === 'canonical')).toBe(true);
    expect(result.map((r) => r.id)).toEqual(['aggregate:i1', 'aggregate:i2']);
  });

  it('disables a canonical stream by prefixed id', () => {
    const inc = [stream('i1'), stream('i2')];
    const sc = scenario('s1', null, {
      overrides: { income: { disabledIds: ['aggregate:i1'] } },
    });
    const result = resolveIncomeForScenarioSparse('s1', [sc], inc);
    expect(result.map((r) => r.id)).toEqual(['aggregate:i2']);
  });

  it('applies a patch with top-level replace', () => {
    const inc = [stream('i1', { monthlyBenefit: 1000 })];
    const sc = scenario('s1', null, {
      overrides: {
        income: { patches: { 'aggregate:i1': { monthlyBenefit: 2500 } } },
      },
    });
    const result = resolveIncomeForScenarioSparse('s1', [sc], inc);
    expect(result[0].source).toBe('patched');
    expect(result[0].payload.monthlyBenefit).toBe(2500);
    expect(result[0].payload.name).toBe('Pension');
  });

  it('appends scenario-only added streams with local:<_localId> ids', () => {
    const sc = scenario('s1', null, {
      overrides: {
        income: {
          added: [
            {
              ...baseStream({ name: 'Side gig', monthlyBenefit: 500 }),
              _localId: 'l-1',
            },
          ],
        },
      },
    });
    const result = resolveIncomeForScenarioSparse('s1', [sc], []);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('added');
    expect(result[0].id).toBe('local:l-1');
    expect(result[0].payload).not.toHaveProperty('_localId');
  });
});

describe('resolveIncomeForScenarioSparse — sparse inheritance', () => {
  it('child re-enables a parent-disabled stream via reEnabledIds', () => {
    const inc = [stream('i1'), stream('i2')];
    const parent = scenario('parent', null, {
      overrides: { income: { disabledIds: ['aggregate:i1'] } },
    });
    const child = scenario('child', 'parent', {
      overrides: { income: { reEnabledIds: ['aggregate:i1'] } },
    });
    const result = resolveIncomeForScenarioSparse('child', [parent, child], inc);
    expect(result.map((r) => r.id)).toEqual(['aggregate:i1', 'aggregate:i2']);
  });

  it('parent patches A + child patches B → both apply', () => {
    const inc = [
      stream('a', { monthlyBenefit: 100 }),
      stream('b', { monthlyBenefit: 200 }),
    ];
    const parent = scenario('parent', null, {
      overrides: {
        income: { patches: { 'aggregate:a': { monthlyBenefit: 111 } } },
      },
    });
    const child = scenario('child', 'parent', {
      overrides: {
        income: { patches: { 'aggregate:b': { monthlyBenefit: 222 } } },
      },
    });
    const result = resolveIncomeForScenarioSparse(
      'child',
      [parent, child],
      inc,
    );
    expect(result.find((r) => r.id === 'aggregate:a')?.payload.monthlyBenefit).toBe(111);
    expect(result.find((r) => r.id === 'aggregate:b')?.payload.monthlyBenefit).toBe(222);
  });
});

describe('resolveIncomeForScenarioSparse — per-key chain merge', () => {
  it('parent patches {monthlyBenefit}, child patches {colaPct} on the SAME id → both resolve', () => {
    const inc = [stream('a', { monthlyBenefit: 1000, colaPct: 0 })];
    const parent = scenario('parent', null, {
      overrides: {
        income: { patches: { 'aggregate:a': { monthlyBenefit: 3000 } } },
      },
    });
    const child = scenario('child', 'parent', {
      overrides: {
        income: { patches: { 'aggregate:a': { colaPct: 2 } } },
      },
    });
    const result = resolveIncomeForScenarioSparse(
      'child',
      [parent, child],
      inc,
    );
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('patched');
    // parent's monthlyBenefit AND child's colaPct both survive the merge.
    expect(result[0].payload.monthlyBenefit).toBe(3000);
    expect(result[0].payload.colaPct).toBe(2);
    expect(result[0].payload.name).toBe('Pension'); // unpatched key inherits
  });

  it('closest-scenario-wins per key: child {monthlyBenefit:2} beats parent {monthlyBenefit:1} while parent {colaPct} inherits', () => {
    const inc = [stream('a', { monthlyBenefit: 1000, colaPct: 0 })];
    const parent = scenario('parent', null, {
      overrides: {
        income: {
          patches: { 'aggregate:a': { monthlyBenefit: 1, colaPct: 5 } },
        },
      },
    });
    const child = scenario('child', 'parent', {
      overrides: {
        income: { patches: { 'aggregate:a': { monthlyBenefit: 2 } } },
      },
    });
    const result = resolveIncomeForScenarioSparse(
      'child',
      [parent, child],
      inc,
    );
    expect(result[0].payload.monthlyBenefit).toBe(2); // child wins this key
    expect(result[0].payload.colaPct).toBe(5); // parent's key inherits
  });

  it('single-ancestor-patch resolution is byte-identical to a hand-computed {...canonical, ...patch}', () => {
    const canonical = baseStream({
      name: 'Federal pension',
      monthlyBenefit: 2400,
      colaPct: 2,
      jointAndSurvivorPct: 50,
    });
    const inc: Aggregate<IncomeStreamPayload>[] = [
      {
        id: 'a',
        householdId: HH,
        aggregateType: 'incomeStream',
        schemaVersion: 1,
        version: 1,
        updatedAt: '2026-05-14T00:00:00Z',
        deviceId: 'd',
        payload: canonical,
      },
    ];
    const patch = { monthlyBenefit: 1800, colaPct: 3 };
    const sc = scenario('s1', null, {
      overrides: { income: { patches: { 'aggregate:a': patch } } },
    });
    const result = resolveIncomeForScenarioSparse('s1', [sc], inc);
    expect(result).toHaveLength(1);
    expect(result[0].payload).toEqual({ ...canonical, ...patch });
  });
});

describe('resolveIncomeForScenarioSparse — null clears an inherited key', () => {
  it('a null patch on linkedCbpAccountId drops the inherited key from the resolved payload', () => {
    const inc = [
      stream('i1', { linkedCbpAccountId: 'acc-cbp', monthlyBenefit: 1000 }),
    ];
    const sc = scenario('s1', null, {
      overrides: {
        income: { patches: { 'aggregate:i1': { linkedCbpAccountId: null } } },
      },
    });
    const result = resolveIncomeForScenarioSparse('s1', [sc], inc);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('patched');
    expect(result[0].payload).not.toHaveProperty('linkedCbpAccountId');
    // Other canonical keys still inherit.
    expect(result[0].payload.monthlyBenefit).toBe(1000);
  });

  it('the null clear is scoped to its scenario — a sibling scenario keeps the link', () => {
    const inc = [stream('i1', { linkedCbpAccountId: 'acc-cbp' })];
    const clearing = scenario('clearing', null, {
      overrides: {
        income: { patches: { 'aggregate:i1': { linkedCbpAccountId: null } } },
      },
    });
    const sibling = scenario('sibling', null);
    const cleared = resolveIncomeForScenarioSparse(
      'clearing',
      [clearing, sibling],
      inc,
    );
    const kept = resolveIncomeForScenarioSparse(
      'sibling',
      [clearing, sibling],
      inc,
    );
    expect(cleared[0].payload).not.toHaveProperty('linkedCbpAccountId');
    expect(kept[0].payload.linkedCbpAccountId).toBe('acc-cbp');
    expect(kept[0].source).toBe('canonical');
  });

  it('chain merge: a closer null clear wins over a deeper set', () => {
    const inc = [stream('i1', { linkedCbpAccountId: 'acc-canonical' })];
    const parent = scenario('parent', null, {
      overrides: {
        income: {
          patches: { 'aggregate:i1': { linkedCbpAccountId: 'acc-parent' } },
        },
      },
    });
    const child = scenario('child', 'parent', {
      overrides: {
        income: { patches: { 'aggregate:i1': { linkedCbpAccountId: null } } },
      },
    });
    const result = resolveIncomeForScenarioSparse('child', [parent, child], inc);
    // Child's clear is closest → the key is dropped despite the parent set.
    expect(result[0].payload).not.toHaveProperty('linkedCbpAccountId');
  });

  it('chain merge: a deeper null clear loses to a closer set', () => {
    const inc = [stream('i1', { linkedCbpAccountId: 'acc-canonical' })];
    const parent = scenario('parent', null, {
      overrides: {
        income: { patches: { 'aggregate:i1': { linkedCbpAccountId: null } } },
      },
    });
    const child = scenario('child', 'parent', {
      overrides: {
        income: {
          patches: { 'aggregate:i1': { linkedCbpAccountId: 'acc-child' } },
        },
      },
    });
    const result = resolveIncomeForScenarioSparse('child', [parent, child], inc);
    // Child's set is closest → it wins over the deeper clear.
    expect(result[0].payload.linkedCbpAccountId).toBe('acc-child');
  });

  it('a null clear applies to a scenario-only added row too', () => {
    const sc = scenario('s1', null, {
      overrides: {
        income: {
          added: [
            {
              ...baseStream({ name: 'Side gig', linkedCbpAccountId: 'acc-x' }),
              _localId: 'l-1',
            },
          ],
          patches: { 'local:l-1': { linkedCbpAccountId: null } },
        },
      },
    });
    const result = resolveIncomeForScenarioSparse('s1', [sc], []);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('added');
    expect(result[0].payload).not.toHaveProperty('linkedCbpAccountId');
  });

  it('a null-free patch resolves byte-identically to the un-widened merge (regression guard)', () => {
    const inc = [stream('i1', { monthlyBenefit: 1000 })];
    const sc = scenario('s1', null, {
      overrides: {
        income: { patches: { 'aggregate:i1': { monthlyBenefit: 2500 } } },
      },
    });
    const result = resolveIncomeForScenarioSparse('s1', [sc], inc);
    expect(result[0].payload).toEqual(baseStream({ monthlyBenefit: 2500 }));
  });
});
