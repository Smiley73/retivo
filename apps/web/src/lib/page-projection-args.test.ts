import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { clearAllStores, listAggregates } from '../db/store';
import { loadDemoData } from './demo-data-loader';
import { assemblePageProjection, type PageProjectionInputs } from './page-projection-args';
import { loadProjectionInputs } from './projection-inputs';
import { medicalCategoryIdsFrom } from './expense-category-resolvers';
import type { ScenarioAggregate } from './scenario-resolution';

let base: PageProjectionInputs;

beforeAll(async () => {
  await clearAllStores();
  await loadDemoData({ householdId: 'hh-1', email: 'a@b.example', displayName: 'Demo', todayYear: 2026 });
  const inputs = await loadProjectionInputs();
  base = {
    ...inputs,
    scenarios: (await listAggregates('scenario')) as ScenarioAggregate[],
    selectedScenarioId: 'demo-scenario-base',
    todayYear: 2026,
    todayMonthIndex: 5,
  };
});

describe('assemblePageProjection', () => {
  it('resolves the scenario and builds the runner arguments the page runs on', () => {
    const assembly = assemblePageProjection(base);
    expect(assembly.canRun).toBe(true);
    expect(assembly.resolved.retirementAge).toBeDefined();
    expect(assembly.primaryMember?.payload.isPrimary).toBe(true);
    expect(assembly.args).toMatchObject({ scenarioId: 'demo-scenario-base', method: 'planned', todayYear: 2026, todayMonthIndex: 5 });
    expect(assembly.args.accounts).toHaveLength(base.accounts.length);
    expect(assembly.medicalCategoryIds).toEqual(medicalCategoryIdsFrom([...(base.categories ?? [])]));
    expect(assembly.args.medicalCategoryIds).toEqual(assembly.medicalCategoryIds);
    expect(assembly.hasAnyRealBalance).toBe(true);
    expect(assembly.primaryRetirementAbsMonth).toBeGreaterThan(2000 * 12);
  });

  it('leaves the medical ids off the arguments when no category source is given', () => {
    const assembly = assemblePageProjection({ ...base, categories: undefined });
    expect(assembly.medicalCategoryIds).toBeUndefined();
    expect('medicalCategoryIds' in assembly.args).toBe(false);
  });

  it('cannot run without a primary member or without an active account', () => {
    expect(assemblePageProjection({ ...base, members: [] }).canRun).toBe(false);
    const inactive = base.accounts.map((account) => ({ ...account, payload: { ...account.payload, active: false } }));
    const assembly = assemblePageProjection({ ...base, accounts: inactive });
    expect(assembly.canRun).toBe(false);
    expect(assembly.hiddenInactiveCount).toBe(base.accounts.length);
    expect(assembly.hasAnyRealBalance).toBe(false);
  });

  it('counts an active account with no real balance as hidden for lack of history', () => {
    const assembly = assemblePageProjection({ ...base, balances: [] });
    expect(assembly.hiddenZeroHistoryCount).toBe(base.accounts.filter((account) => account.payload.active).length);
  });

  it('throws for a scenario id that does not exist, as the page always has', () => {
    expect(() => assemblePageProjection({ ...base, selectedScenarioId: 'nope' })).toThrow(/unknown scenario id/);
  });
});
