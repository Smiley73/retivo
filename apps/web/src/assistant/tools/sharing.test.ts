/**
 * Every plan tool, under every consent variant, against a workspace with strings
 * planted in each field: never-shareable strings are absent whatever the switches
 * say, a category string is present only while its switches are on, no first name
 * survives role labels, and rounding holds on every dollar figure. The assertions
 * read the serialized result, so a field added later and never classified fails
 * here instead of reaching an assistant.
 */
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { clearAllStores, listAggregates } from '../../db/store';
import { CATEGORY_SENTINELS, NEVER_SHAREABLE, SCENARIO_SENTINEL_ID, seedSentinelWorkspace } from '../../test/assistant-sentinels';
import { callPlanTool, choicesWith, envelopeOf, plantSavedStressTest } from '../../test/assistant-tools';
import {
  ACCOUNT_CLASSIFICATION,
  BALANCE_CLASSIFICATION,
  EXPENSE_CLASSIFICATION,
  INCOME_CLASSIFICATION,
  SCENARIO_CLASSIFICATION,
  SOCIAL_SECURITY_CLASSIFICATION,
  type Classification,
} from '../sharing/classification';
import { SHARING_SWITCH_IDS, type SharingChoices } from '../sharing/switches';

const CALLS: ReadonlyArray<{ tool: string; args: Record<string, unknown> }> = [
  { tool: 'retivo_status', args: {} },
  { tool: 'retivo_get_plan_data', args: {} },
  { tool: 'retivo_list_scenarios', args: {} },
  { tool: 'retivo_get_scenario', args: { scenarioId: SCENARIO_SENTINEL_ID } },
  { tool: 'retivo_get_projection', args: {} },
  { tool: 'retivo_get_projection', args: { scenarioId: SCENARIO_SENTINEL_ID } },
  // A saved result is planted below, so the tool reads the cache and never needs a worker.
  { tool: 'retivo_get_stress_test', args: {} },
  { tool: 'retivo_compare_scenarios', args: { scenarioId: 'demo-scenario-base', otherScenarioId: SCENARIO_SENTINEL_ID } },
  { tool: 'retivo_explain', args: { scenarioId: SCENARIO_SENTINEL_ID, metric: 'ending_balance' } },
];

const VARIANTS: ReadonlyArray<{ label: string; choices: SharingChoices }> = [
  { label: 'every switch on', choices: choicesWith() },
  ...SHARING_SWITCH_IDS.map((id) => ({ label: `${id} off`, choices: choicesWith({ [id]: false }) })),
  { label: 'every switch off', choices: choicesWith(Object.fromEntries(SHARING_SWITCH_IDS.map((id) => [id, false]))) },
];

/** Every key whose classification is a dollar figure, annual, monthly and per-period, at any depth. */
function dollarKeys(): { annual: Set<string>; monthly: Set<string>; period: Set<string> } {
  const annual = new Set<string>();
  const monthly = new Set<string>();
  const period = new Set<string>();
  const visit = (key: string, classification: Classification): void => {
    if (classification.kind === 'dollars') annual.add(key);
    else if (classification.kind === 'monthlyDollars') monthly.add(key);
    else if (classification.kind === 'periodDollars') period.add(key);
    else if (classification.kind === 'object') for (const [inner, field] of Object.entries(classification.fields)) visit(inner, field);
    else if (classification.kind === 'array') visit(key, classification.item);
    else if (classification.kind === 'record') visit(key, classification.value);
    else if (classification.kind === 'gated') visit(key, classification.shape);
  };
  for (const map of [ACCOUNT_CLASSIFICATION, BALANCE_CLASSIFICATION, EXPENSE_CLASSIFICATION, INCOME_CLASSIFICATION, SOCIAL_SECURITY_CLASSIFICATION, SCENARIO_CLASSIFICATION]) {
    for (const [key, field] of Object.entries(map)) visit(key, field);
  }
  return { annual, monthly, period };
}

function numbersAt(value: unknown, keys: ReadonlySet<string>, found: number[] = []): number[] {
  if (Array.isArray(value)) for (const item of value as unknown[]) numbersAt(item, keys, found);
  else if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      if (keys.has(key) && typeof inner === 'number') found.push(inner);
      numbersAt(inner, keys, found);
    }
  }
  return found;
}

beforeAll(async () => {
  await clearAllStores();
  await seedSentinelWorkspace();
  await plantSavedStressTest('demo-scenario-base');
});

describe.each(CALLS)('$tool', ({ tool, args }) => {
  it.each(VARIANTS)('with $label: nothing never-shareable, each category only while on', async ({ choices }) => {
    const result = await callPlanTool(tool, args, choices);
    const text = JSON.stringify(result);
    const lower = text.toLowerCase();
    for (const [name, sentinel] of Object.entries(NEVER_SHAREABLE)) expect(lower.includes(sentinel.toLowerCase()), name).toBe(false);
    for (const { token, requires, tools } of CATEGORY_SENTINELS) {
      const expected = tools.includes(tool) && requires.every((id) => choices[id]);
      expect(text.includes(token), `${token} with ${requires.join('+')}`).toBe(expected);
    }
  });

  it('rounds annual figures to $1,000 and monthly ones to $100 while exact figures are off', async () => {
    const { annual, monthly, period } = dollarKeys();
    const envelope = envelopeOf(await callPlanTool(tool, args, choicesWith({ exactDollars: false })));
    const annualValues = numbersAt(envelope.data, annual);
    const monthlyValues = numbersAt(envelope.data, monthly);
    for (const value of annualValues) expect(Math.abs(value % 1000), String(value)).toBe(0);
    for (const value of monthlyValues) expect(Math.abs(value % 100), String(value)).toBe(0);
    // An expense amount is a per-period figure: at least a multiple of $100, whatever its frequency.
    const periodValues = numbersAt(envelope.data, period);
    for (const value of periodValues) expect(Math.abs(value % 100), String(value)).toBe(0);
    expect(envelope.rounding).toMatchObject({ exact: false, stepDollars: 1000, monthlyStepDollars: 100 });
    if (tool === 'retivo_get_plan_data') {
      expect(annualValues.length).toBeGreaterThan(20);
      expect(monthlyValues.length).toBeGreaterThan(0);
      expect(periodValues.length).toBeGreaterThan(0);
    }
  });

  it('carries the exact stored figure while exact figures are on', async () => {
    if (tool !== 'retivo_get_plan_data') return;
    const envelope = envelopeOf(await callPlanTool(tool, args, choicesWith()));
    const stored = await listAggregates('account');
    const rows = envelope.data.accounts as Array<{ id: string; plannedContributionPreTax?: number }>;
    expect(rows).toHaveLength(stored.length);
    for (const account of stored) {
      expect(rows.find((row) => row.id === account.id)?.plannedContributionPreTax).toBe(account.payload.plannedContributionPreTax);
    }
    expect(envelope.rounding.exact).toBe(true);
  });
});
