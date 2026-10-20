import 'fake-indexeddb/auto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearMonteCarloCache, mcCacheKey, monteCarloCacheCount, putCached } from '../../db/monte-carlo-cache';
import { clearAllStores, db, listAggregates, putAggregate } from '../../db/store';
import type { Aggregate, ScenarioPayload } from '../../db/types';
import { loadDemoData } from '../../lib/demo-data-loader';
import { loadProjectionInputs } from '../../lib/projection-inputs';
import { BASE_ID, DELAY_ID, EARLY_ID, savedSummary } from '../../test/assistant-analysis-inputs';
import { TEST_NOW, callPlanTool, choicesWith, envelopeOf } from '../../test/assistant-tools';
import type { ToolEnv } from './define';
import { monteCarloInputFor } from './stress-cache';
import { SCENARIO_SECTION_KEYS } from './scenario-sections';

interface Side {
  id: string;
  name?: string;
  plannedProjectionAvailable: boolean;
  endingBalanceTodayDollars: number | null;
  runOutYear: number | null;
  horizonYear: number | null;
  portfolioAtRetirementNominal: number | null;
  portfolioAtRetirementTodayDollars: number | null;
  stressTest: null | { source: string; successProbability: number; tiers: Record<string, { endingBalanceReal: number | null }> };
  reason?: string;
  note?: string;
}

interface CompareData {
  scenario: Side;
  other: Side;
  relation: { kind: string; generations?: number; parentId?: string; ancestorId?: string };
  settingDifferences: Array<{ key: string; label: string; scenario: unknown; other: unknown; note?: string }>;
  outcomeDifferences: Record<string, number | null>;
}

const CHILD_ID = 't-empty-child';
let fundsRunOutId: string;
let scenarios: Aggregate<ScenarioPayload>[];

async function compare(scenarioId: string, otherScenarioId: string, choices = choicesWith()) {
  const envelope = envelopeOf(await callPlanTool('retivo_compare_scenarios', { scenarioId, otherScenarioId }, choices));
  return { envelope, data: envelope.data as unknown as CompareData };
}

beforeAll(async () => {
  await clearAllStores();
  await loadDemoData({ householdId: 'hh-1', email: 'a@b.example', displayName: 'Demo', todayYear: 2026 });
  scenarios = (await listAggregates('scenario')) as Aggregate<ScenarioPayload>[];
  fundsRunOutId = scenarios.find((scenario) => scenario.payload.name === 'Funds Run Out')!.id;
  const base = scenarios.find((scenario) => scenario.id === BASE_ID)!;
  await putAggregate('scenario', {
    ...base,
    id: CHILD_ID,
    payload: { ...base.payload, name: 'Empty child', isPrimary: false, parentScenarioId: BASE_ID, overrides: {} },
  });
});

beforeEach(async () => {
  await clearMonteCarloCache();
});

afterAll(async () => {
  await clearMonteCarloCache();
  await clearAllStores();
});

const setOn = (id: string): Set<string> =>
  new Set(Object.keys(scenarios.find((scenario) => scenario.id === id)!.payload.overrides));

describe('retivo_compare_scenarios: settings', () => {
  it('lists retirementAge for base vs "Retire early" and no setting that neither scenario sets', async () => {
    const { data } = await compare(BASE_ID, EARLY_ID);
    const keys = data.settingDifferences.map((difference) => difference.key);
    expect(keys).toContain('retirementAge');
    const retirement = data.settingDifferences.find((difference) => difference.key === 'retirementAge')!;
    expect(retirement.label).toBe('Retirement age');
    expect(retirement.scenario).toMatchObject({ primary: { ageYears: 65 } });
    expect(retirement.other).toMatchObject({ primary: { ageYears: 62 } });
    const either = new Set([...setOn(BASE_ID), ...setOn(EARLY_ID)]);
    const neither = SCENARIO_SECTION_KEYS.filter((key) => !either.has(key));
    expect(neither.length).toBeGreaterThan(5);
    for (const key of neither) expect(keys, key).not.toContain(key);
  });

  it('trims a per-account setting to the accounts that differ', async () => {
    const { data } = await compare(BASE_ID, EARLY_ID);
    const trimmed = data.settingDifferences.filter((entry) => entry.note !== undefined);
    expect(trimmed.length).toBeGreaterThan(0);
    for (const difference of trimmed) {
      const mine = (difference.scenario as { perAccount: Record<string, unknown> } | null)?.perAccount ?? {};
      const theirs = (difference.other as { perAccount: Record<string, unknown> } | null)?.perAccount ?? {};
      const ids = new Set([...Object.keys(mine), ...Object.keys(theirs)]);
      for (const id of ids) expect(JSON.stringify(mine[id]) === JSON.stringify(theirs[id]), `${difference.key} ${id}`).toBe(false);
    }
  });

  it('finds no setting difference at all for a child of base with no overrides', async () => {
    const { data } = await compare(CHILD_ID, BASE_ID);
    expect(data.settingDifferences).toEqual([]);
    // Neither runs out, so there is no run-out difference to compute; every other figure is identical.
    expect(data.outcomeDifferences.runOutYear).toBeNull();
    for (const [key, value] of Object.entries(data.outcomeDifferences)) if (key !== 'runOutYear') expect(value, key).toBe(0);
    expect(data.relation).toEqual({ kind: 'descendant_of_other', generations: 1 });
  });

  it('swapping the arguments swaps the two values of every setting', async () => {
    const forward = (await compare(BASE_ID, EARLY_ID)).data;
    const backward = (await compare(EARLY_ID, BASE_ID)).data;
    expect(backward.settingDifferences.map((entry) => entry.key)).toEqual(forward.settingDifferences.map((entry) => entry.key));
    backward.settingDifferences.forEach((entry, index) => {
      expect(entry.scenario).toEqual(forward.settingDifferences[index]!.other);
      expect(entry.other).toEqual(forward.settingDifferences[index]!.scenario);
    });
  });

  it('says how the two scenarios are related', async () => {
    expect((await compare(BASE_ID, EARLY_ID)).data.relation).toEqual({ kind: 'ancestor_of_other', generations: 1 });
    expect((await compare(EARLY_ID, BASE_ID)).data.relation).toEqual({ kind: 'descendant_of_other', generations: 1 });
    expect((await compare(fundsRunOutId, BASE_ID)).data.relation).toEqual({ kind: 'descendant_of_other', generations: 2 });
    expect((await compare(DELAY_ID, EARLY_ID)).data.relation).toEqual({ kind: 'siblings', parentId: BASE_ID });
    expect((await compare(fundsRunOutId, DELAY_ID)).data.relation).toEqual({ kind: 'shares_ancestor', ancestorId: BASE_ID });
    expect((await compare(BASE_ID, BASE_ID)).data.relation).toEqual({ kind: 'same' });
  });
});

describe('retivo_compare_scenarios: outcomes', () => {
  it('reports a run-out year on one side and null on the other, and no difference between them', async () => {
    const { data } = await compare(fundsRunOutId, BASE_ID);
    expect(data.scenario.runOutYear).not.toBeNull();
    expect(data.other.runOutYear).toBeNull();
    expect(data.outcomeDifferences.runOutYear).toBeNull();
    expect(data.scenario.name).toBe('Funds Run Out');
    expect(data.other.name).toBe('Base');
  });

  it('reads a side the page cannot project as having no outcomes, not as a failed comparison', async () => {
    const base = scenarios.find((scenario) => scenario.id === BASE_ID)!;
    await putAggregate('scenario', {
      ...base,
      id: 't-no-retirement',
      payload: { ...base.payload, name: 'No retirement age', isPrimary: false, parentScenarioId: null, overrides: {} },
    });
    const { data } = await compare(BASE_ID, 't-no-retirement');
    expect(data.other.plannedProjectionAvailable).toBe(false);
    expect(data.other.endingBalanceTodayDollars).toBeNull();
    expect(data.scenario.plannedProjectionAvailable).toBe(true);
    for (const [key, value] of Object.entries(data.outcomeDifferences)) expect(value, key).toBeNull();
    expect(data.settingDifferences.some((entry) => entry.key === 'retirementAge')).toBe(true);
  });

  it('computes every signed difference as scenario minus other', async () => {
    const { data } = await compare(BASE_ID, EARLY_ID);
    expect(data.outcomeDifferences.endingBalanceTodayDollars).toBe(data.scenario.endingBalanceTodayDollars! - data.other.endingBalanceTodayDollars!);
    expect(data.outcomeDifferences.portfolioAtRetirementNominal).toBe(
      data.scenario.portfolioAtRetirementNominal! - data.other.portfolioAtRetirementNominal!,
    );
    expect(data.outcomeDifferences.horizonYear).toBe(0);
    expect(data.outcomeDifferences.endingBalanceTodayDollars).toBeGreaterThan(0);
  });

  it('negates every signed difference when the arguments are swapped', async () => {
    for (const [a, b] of [
      [BASE_ID, EARLY_ID],
      [fundsRunOutId, BASE_ID],
      [DELAY_ID, EARLY_ID],
    ] as const) {
      const forward = (await compare(a, b)).data.outcomeDifferences;
      const backward = (await compare(b, a)).data.outcomeDifferences;
      for (const key of Object.keys(forward)) {
        const f = forward[key]!;
        const g = backward[key]!;
        if (f === null) expect(g, key).toBeNull();
        else expect(g + f, key).toBe(0);
      }
    }
  });

  it('rounds the differences and every side figure to $1,000 while exact figures are off', async () => {
    const { data } = await compare(BASE_ID, EARLY_ID, choicesWith({ exactDollars: false }));
    const dollarKeys = ['endingBalanceTodayDollars', 'portfolioAtRetirementNominal', 'portfolioAtRetirementTodayDollars'] as const;
    for (const side of [data.scenario, data.other]) {
      for (const key of dollarKeys) expect(Math.abs(side[key]! % 1000), key).toBe(0);
    }
    for (const key of dollarKeys) expect(Math.abs(data.outcomeDifferences[key]! % 1000), key).toBe(0);
  });
});

describe('retivo_compare_scenarios: saved stress tests', () => {
  async function plant(scenarioId: string, seed: number): Promise<{ key: string }> {
    const env = { workspace: { ...(await loadProjectionInputs()), scenarios }, now: TEST_NOW } as unknown as ToolEnv;
    const input = monteCarloInputFor(scenarioId, env)!;
    const key = await mcCacheKey(input);
    await putCached(key, savedSummary(seed));
    return { key };
  }

  it('is null with the reason and the tool to call when nothing is saved, and never writes', async () => {
    const { data } = await compare(BASE_ID, EARLY_ID);
    for (const side of [data.scenario, data.other]) {
      expect(side.stressTest).toBeNull();
      expect(side.reason).toBe('not_computed');
      expect(side.note).toContain('retivo_get_stress_test');
    }
    expect(await monteCarloCacheCount()).toBe(0);
  });

  it('carries the figures of a saved result, per side, and leaves the cache as it was', async () => {
    await plant(BASE_ID, 11);
    const before = await (await db()).getAll('monteCarloResults');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { data } = await compare(BASE_ID, EARLY_ID);
    expect(data.scenario.stressTest).toMatchObject({
      source: 'cache',
      successProbability: savedSummary().successProbability,
      tiers: { typical: { endingBalanceReal: 654_321 }, pessimistic: { endingBalanceReal: 345_678 }, badLuck: { endingBalanceReal: 12_345 } },
    });
    expect(data.scenario.reason).toBeUndefined();
    expect(data.other.stressTest).toBeNull();
    expect(data.other.reason).toBe('not_computed');
    expect(await (await db()).getAll('monteCarloResults')).toEqual(before);
  });
});

describe('retivo_compare_scenarios: arguments and sharing', () => {
  it('is INVALID_ARGS for a scenario that does not exist, without echoing it', async () => {
    const result = await callPlanTool('retivo_compare_scenarios', { scenarioId: BASE_ID, otherScenarioId: 'no-such-scenario-zz' });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    expect(JSON.stringify(result)).not.toContain('no-such-scenario-zz');
  });

  it('leaves everything out while the Scenarios switch is off', async () => {
    const { envelope } = await compare(BASE_ID, EARLY_ID, choicesWith({ scenarios: false }));
    expect(envelope.data).toEqual({ omittedSections: ['scenarios'] });
  });

  it('does not compare a setting whose own category is off, and says so', async () => {
    const all = (await compare(BASE_ID, EARLY_ID)).data.settingDifferences.map((entry) => entry.key);
    const { envelope, data } = await compare(BASE_ID, EARLY_ID, choicesWith({ accounts: false, members: false, expenses: false, income: false }));
    const keys = data.settingDifferences.map((entry) => entry.key);
    expect(keys.length).toBeLessThan(all.length);
    expect(keys).not.toContain('accountContributions');
    expect(envelope.assumptions.some((line) => /sharing switch is off are not compared/.test(line))).toBe(true);
    // Switches never change what was computed: the outcomes are the same.
    expect(data.scenario.endingBalanceTodayDollars).toBe((await compare(BASE_ID, EARLY_ID)).data.scenario.endingBalanceTodayDollars);
  });

  it('shows the scenarios’ names through the share view', async () => {
    const { data } = await compare(BASE_ID, EARLY_ID);
    expect(data.scenario.name).toBe('Base');
    expect(data.other.name).toBe('Retire early at 62');
  });
});
