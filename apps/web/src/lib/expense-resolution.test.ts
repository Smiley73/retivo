import { describe, expect, it } from 'vitest';
import { resolveExpensesForScenario } from './expense-resolution';
import type {
  Aggregate,
  ExpensePayload,
  ScenarioPayload,
} from '../db/types';
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

const expense = (id: string, payload: Partial<ExpensePayload> = {}): Aggregate<ExpensePayload> => ({
  id,
  householdId: HH,
  aggregateType: 'expense',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-09T00:00:00Z',
  deviceId: 'd',
  payload: baseExpense(payload),
});

const scenario = (
  id: string,
  scenarioOverrides: Partial<ScenarioPayload> = {},
): ScenarioAggregate => ({
  id,
  householdId: HH,
  aggregateType: 'scenario',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-09T00:00:00Z',
  deviceId: 'd',
  payload: {
    name: 'Base',
    description: '',
    parentScenarioId: null,
    isPrimary: true,
    notes: '',
    overrides: {},
    ...scenarioOverrides,
  },
});

describe('resolveExpensesForScenario', () => {
  it('returns the canonical list verbatim when the scenario has no expense overrides', () => {
    const exp = [expense('e1'), expense('e2', { name: 'Mortgage', amount: 2200 })];
    const sc = scenario('s1');
    const result = resolveExpensesForScenario('s1', [sc], exp);
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.source === 'canonical')).toBe(true);
    expect(result.map((r) => r.id)).toEqual(['aggregate:e1', 'aggregate:e2']);
  });

  it('silently skips a dangling disabledIds entry referencing a missing canonical id', () => {
    const exp = [expense('e1')];
    const sc = scenario('s1', {
      overrides: { expenses: { disabledIds: ['aggregate:gone'] } },
    });
    const result = resolveExpensesForScenario('s1', [sc], exp);
    expect(result.map((r) => r.id)).toEqual(['aggregate:e1']);
  });

  it('silently skips a dangling patches entry referencing a missing canonical id', () => {
    const exp = [expense('e1')];
    const sc = scenario('s1', {
      overrides: {
        expenses: {
          patches: { 'aggregate:gone': { amount: 999 } },
        },
      },
    });
    const result = resolveExpensesForScenario('s1', [sc], exp);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('aggregate:e1');
    expect(result[0].source).toBe('canonical');
  });
});
