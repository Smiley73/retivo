// Cases expense and income override resolution must satisfy identically; each kind-specific file keeps its own.
import { describe, expect, it } from 'vitest';
import { resolveExpensesForScenarioSparse } from './expense-override-resolution';
import { resolveIncomeForScenarioSparse } from './income-override-resolution';
import type {
  Aggregate,
  ExpensePayload,
  IncomeStreamPayload,
  ScenarioPayload,
} from '../db/types';
import type { ScenarioAggregate } from './scenario-resolution';

const HH = 'hh-1';

const scenario = (
  id: string,
  scenarioOverrides: Partial<ScenarioPayload>,
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
    parentScenarioId: null,
    isPrimary: true,
    notes: '',
    overrides: {},
    ...scenarioOverrides,
  },
});

interface Resolved {
  source: string;
  payload: Record<string, unknown>;
}

interface Kind {
  section: 'expenses' | 'income';
  field: 'amount' | 'monthlyBenefit';
  resolveOne: (scenarioAggregate: ScenarioAggregate, id: string, value: number) => Resolved[];
}

const expenseItem = (id: string, amount: number): Aggregate<ExpensePayload> => ({
  id,
  householdId: HH,
  aggregateType: 'expense',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-14T00:00:00Z',
  deviceId: 'd',
  payload: {
    name: 'Utilities',
    amount,
    frequency: 'monthly',
    classification: 'essential',
    categoryId: 'cat-utilities',
    start: { kind: 'retirementStart' },
    end: { kind: 'lifetime', whose: 'last' },
  },
});

const incomeItem = (id: string, monthlyBenefit: number): Aggregate<IncomeStreamPayload> => ({
  id,
  householdId: HH,
  aggregateType: 'incomeStream',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-14T00:00:00Z',
  deviceId: 'd',
  payload: {
    name: 'Pension',
    kind: 'pension',
    payoutType: 'annuity',
    memberId: 'primary',
    monthlyBenefit,
    start: { kind: 'age', years: 65, months: 0 },
    colaPct: 0,
  } as IncomeStreamPayload,
});

const KINDS: ReadonlyArray<readonly [string, Kind]> = [
  [
    'expense',
    {
      section: 'expenses',
      field: 'amount',
      resolveOne: (sc, id, value) =>
        resolveExpensesForScenarioSparse('s1', [sc], [expenseItem(id, value)]) as unknown as Resolved[],
    },
  ],
  [
    'income',
    {
      section: 'income',
      field: 'monthlyBenefit',
      resolveOne: (sc, id, value) =>
        resolveIncomeForScenarioSparse('s1', [sc], [incomeItem(id, value)]) as unknown as Resolved[],
    },
  ],
];

describe.each(KINDS)('%s override resolution — shared rules', (_name, kind) => {
  const withOverrides = (section: Record<string, unknown>) =>
    scenario('s1', { overrides: { [kind.section]: section } as ScenarioPayload['overrides'] });

  it('disable wins when the same scenario lists an id in both disabledIds and reEnabledIds', () => {
    const sc = withOverrides({
      disabledIds: ['aggregate:i1'],
      reEnabledIds: ['aggregate:i1'],
    });
    expect(kind.resolveOne(sc, 'i1', 100)).toHaveLength(0);
  });

  it('raw id "abc" in disabledIds resolves identically to "aggregate:abc"', () => {
    const sc = withOverrides({ disabledIds: ['abc'] });
    expect(kind.resolveOne(sc, 'abc', 100)).toHaveLength(0);
  });

  it('raw key "abc" in patches resolves identically to "aggregate:abc"', () => {
    const sc = withOverrides({ patches: { abc: { [kind.field]: 999 } } });
    const result = kind.resolveOne(sc, 'abc', 100);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('patched');
    expect(result[0].payload[kind.field]).toBe(999);
  });
});
