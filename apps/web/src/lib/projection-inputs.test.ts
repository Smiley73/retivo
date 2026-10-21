import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { clearAllStores, listAggregates } from '../db/store';
import { loadDemoData } from './demo-data-loader';
import { loadProjectionInputs } from './projection-inputs';

beforeAll(async () => {
  await clearAllStores();
  await loadDemoData({ householdId: 'hh-1', email: 'a@b.example', displayName: 'Demo', todayYear: 2026 });
});

describe('loadProjectionInputs', () => {
  it('reads the seven aggregate lists a projection runs on, straight from the store', async () => {
    const inputs = await loadProjectionInputs();
    expect(inputs.members).toEqual(await listAggregates('householdMember'));
    expect(inputs.accounts).toEqual(await listAggregates('account'));
    expect(inputs.balances).toEqual(await listAggregates('accountBalance'));
    expect(inputs.expenses).toEqual(await listAggregates('expense'));
    expect(inputs.incomeStreams).toEqual(await listAggregates('incomeStream'));
    expect(inputs.ssBenefits).toEqual(await listAggregates('socialSecurityBenefit'));
    expect(inputs.categories).toEqual(await listAggregates('expenseCategory'));
    expect(Object.keys(inputs)).toHaveLength(7);
    expect(inputs.accounts.length).toBeGreaterThan(0);
  });
});
