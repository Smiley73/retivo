import { describe, expect, it } from 'vitest';
import type { Aggregate, AggregateType, ExpensePayload, HouseholdMemberPayload, IncomeStreamPayload, ScenarioPayload } from '../db/types';
import { buildReportData, type BuildReportDataInput } from './report-data';
import type { ScenarioAggregate } from './scenario-resolution';

const HH = 'household-ordering';
const NOW = new Date('2026-06-06T18:34:00Z');
const aggregate = <T extends Record<string, unknown>>(
  aggregateType: AggregateType, id: string, payload: T,
): Aggregate<T> => ({
  aggregateType, id, payload, householdId: HH, schemaVersion: 1,
  version: 1, updatedAt: NOW.toISOString(), deviceId: 'device',
});
const member = (id: string, isPrimary: boolean, birthdate: string) =>
  aggregate<HouseholdMemberPayload>('householdMember', id, {
    isPrimary, firstName: id, lastName: '', email: '', birthdate,
  });
const expense = (id: string, overrides: Partial<ExpensePayload> = {}) =>
  aggregate<ExpensePayload>('expense', id, {
    name: id, amount: 100, frequency: 'monthly', classification: 'essential',
    categoryId: 'cat', start: { kind: 'retirementStart' },
    end: { kind: 'durationFromStart', months: 12 }, ...overrides,
  });
const income = (id: string, memberId: string) =>
  aggregate<IncomeStreamPayload>('incomeStream', id, {
    name: id, memberId, kind: 'partTime', annualAmount: 1_000,
    start: { kind: 'retirementStart' }, end: { kind: 'year', year: 2040 }, colaPct: 0,
  });
const scenario = (
  id: string, overrides: ScenarioPayload['overrides'], parentScenarioId: string | null = null,
): ScenarioAggregate => aggregate<ScenarioPayload>('scenario', id, {
  name: id, description: '', parentScenarioId, isPrimary: parentScenarioId === null,
  notes: '', overrides,
});
const base = scenario('base', {
  retirementAge: {
    primary: { ageYears: 65, ageMonths: 0 },
    secondary: { ageYears: 65, ageMonths: 0 },
  },
  lifeExpectancy: { primary: 90, secondary: 95 },
});
const input = (overrides: Partial<BuildReportDataInput> = {}): BuildReportDataInput => ({
  household: undefined,
  members: [member('primary', true, '1965-03-12'), member('secondary', false, '1968-09-03')],
  accounts: [], expenses: [], expenseCategoryNameById: new Map([['cat', 'Other']]),
  incomeStreams: [], socialSecurity: [], scenarios: [base], activeScenarioId: base.id,
  ...overrides,
});
describe('buildReportData ordering metadata', () => {
  it('uses selected-scenario schedule patches, lifetime, and one-off dates', () => {
    const alt = scenario('alt', {
      lifeExpectancy: { primary: 80, secondary: 95 },
      expenses: { patches: { 'aggregate:lifetime': { start: { kind: 'year', year: 2032 } } } },
    }, base.id);
    const report = buildReportData(input({
      scenarios: [base, alt], activeScenarioId: alt.id,
      expenses: [
        expense('lifetime', { end: { kind: 'lifetime', whose: 'primary' } }),
        expense('one-off', { frequency: 'oneOff', start: { kind: 'age', memberId: 'secondary', years: 70, months: 2 }, end: undefined }),
      ],
    }), NOW);
    expect(report.expenses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'aggregate:lifetime', effectiveStartMonth: 2032 * 12, effectiveEndMonth: 2046 * 12 }),
      expect.objectContaining({ id: 'aggregate:one-off', effectiveStartMonth: 2038 * 12 + 10, effectiveEndMonth: 2038 * 12 + 10 }),
    ]));
  });
  it('keeps unresolved dates null and assigns income owner ranks', () => {
    const report = buildReportData(input({
      members: [member('primary', true, ''), member('secondary', false, '1968-09-03')],
      expenses: [expense('retirement')],
      incomeStreams: [income('orphan', 'missing'), income('secondary', 'secondary'), income('primary', 'primary')],
    }), NOW);
    expect(report.expenses[0]).toMatchObject({ effectiveStartMonth: null, effectiveEndMonth: null });
    expect(report.incomeStreams.map(({ id, ownerSortRank }) => [id, ownerSortRank]))
      .toEqual([['aggregate:orphan', 2], ['aggregate:secondary', 1], ['aggregate:primary', 0]]);
  });
});
