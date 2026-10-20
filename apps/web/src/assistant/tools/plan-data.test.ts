import 'fake-indexeddb/auto';
import { PLAN_DATA_SECTIONS } from '@retirement/assistant-protocol';
import { beforeAll, describe, expect, it } from 'vitest';
import { clearAllStores, listAggregates } from '../../db/store';
import { loadDemoData } from '../../lib/demo-data-loader';
import { callPlanTool, choicesWith, envelopeOf } from '../../test/assistant-tools';

const planData = async (args: Record<string, unknown> = {}, choices = choicesWith()) =>
  envelopeOf(await callPlanTool('retivo_get_plan_data', args, choices));

beforeAll(async () => {
  await clearAllStores();
  await loadDemoData({ householdId: 'hh-1', email: 'a@b.example', displayName: 'Demo', todayYear: 2026 });
});

describe('retivo_get_plan_data', () => {
  it('returns every section by default, matching the store', async () => {
    const { data, withheld } = await planData();
    expect(Object.keys(data).sort()).toEqual([...PLAN_DATA_SECTIONS].sort());
    expect(withheld).toEqual([]);
    expect((data.accounts as unknown[]).length).toBe((await listAggregates('account')).length);
    expect((data.balances as unknown[]).length).toBe((await listAggregates('accountBalance')).length);
    expect((data.members as Array<{ age?: number }>).every((member) => typeof member.age === 'number')).toBe(true);
  });

  it('returns only the sections asked for, once each', async () => {
    const { data } = await planData({ sections: ['scenarios', 'accounts', 'scenarios'] });
    expect(Object.keys(data)).toEqual(['accounts', 'scenarios']);
  });

  it('leaves out a section whose switch is off and names it, with the switch in withheld', async () => {
    const { data, withheld } = await planData({ sections: ['members', 'income', 'socialSecurity'] }, choicesWith({ income: false, socialSecurity: false }));
    expect(Object.keys(data).sort()).toEqual(['members', 'omittedSections']);
    expect(data.omittedSections).toEqual(['income', 'socialSecurity']);
    expect(withheld).toEqual(['income', 'socialSecurity']);
  });

  it('shows members as Primary and Secondary while first names are off, and keeps the ids that join the sections', async () => {
    const { data, labels } = await planData({ sections: ['members', 'accounts'] }, choicesWith({ firstNames: false }));
    expect(labels.mode).toBe('role-labels');
    const names = (data.members as Array<{ name: string }>).map((member) => member.name);
    expect(names).toEqual(['Primary', 'Secondary']);
    const owners = new Set((data.accounts as Array<{ ownerId?: string }>).map((account) => account.ownerId));
    const memberIds = (data.members as Array<{ id: string }>).map((member) => member.id);
    expect([...owners].filter((owner) => owner !== undefined).every((owner) => memberIds.includes(owner!))).toBe(true);
  });

  it('states the assumptions it relies on', async () => {
    const { assumptions } = await planData();
    expect(assumptions).toContain('Ages are whole years on 2026-06-15.');
  });
});

describe('retivo_list_scenarios', () => {
  const list = async (choices = choicesWith()) => envelopeOf(await callPlanTool('retivo_list_scenarios', {}, choices));
  type Row = { id: string; name: string; parentScenarioId: string | null; isPrimary: boolean; changes: string[] };

  it('lists id, name, parent, base flag and the settings each scenario sets itself, base first', async () => {
    const rows = (await list()).data.scenarios as Row[];
    expect(rows.map((row) => row.id)[0]).toBe('demo-scenario-base');
    const early = rows.find((row) => row.id === 'demo-scenario-early')!;
    expect(early).toMatchObject({ name: 'Retire early at 62', parentScenarioId: 'demo-scenario-base', isPrimary: false });
    expect(early.changes).toContain('retirementAge');
    expect(early.changes).not.toContain('inflation');
    expect(rows).toHaveLength((await listAggregates('scenario')).length);
  });

  it('does not name a setting whose own category is off', async () => {
    const withExpenses = (await list()).data.scenarios as Row[];
    const noExpenses = (await list(choicesWith({ expenses: false }))).data.scenarios as Row[];
    const lowest = withExpenses.find((row) => row.id === 'demo-scenario-early-no-contrib')!;
    expect(lowest.changes).toContain('expenses');
    expect(noExpenses.find((row) => row.id === lowest.id)!.changes).not.toContain('expenses');
  });

  it('answers with nothing but the omitted section while scenarios is off', async () => {
    const envelope = await list(choicesWith({ scenarios: false }));
    expect(envelope.data).toEqual({ omittedSections: ['scenarios'] });
    expect(envelope.withheld).toEqual(['scenarios']);
  });
});
