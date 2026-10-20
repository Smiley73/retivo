/** The package registry and the tab's handler map name the same tools, and the registry's limits fit what the tab enforces. */
import 'fake-indexeddb/auto';
import { MAX_CALL_TIMEOUT_MS, TOOL_REGISTRY, toolEntrySchema } from '@retirement/assistant-protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearMonteCarloCache } from '../../db/monte-carlo-cache';
import { clearAllStores } from '../../db/store';
import { loadDemoData } from '../../lib/demo-data-loader';
import { ANALYSIS_TEST_INPUTS, BASE_ID } from '../../test/assistant-analysis-inputs';
import { callPlanTool, plantSavedStressTest } from '../../test/assistant-tools';
import { ANALYSIS_TOOL_NAMES, PLAN_TOOL_NAMES, planToolHandlers } from '.';
import { STRESS_TEST_WALL_CLOCK_MS } from './stress-test';

describe('the tab’s handler map', () => {
  it('has a handler for every registry entry, and nothing the registry lacks', () => {
    const registered = TOOL_REGISTRY.map((entry) => entry.name);
    const handled = [...planToolHandlers().keys()];
    expect(handled.every((name) => registered.includes(name))).toBe(true);
    expect(registered.filter((name) => !handled.includes(name))).toEqual([]);
    expect([...handled].sort()).toEqual([...PLAN_TOOL_NAMES, ...ANALYSIS_TOOL_NAMES].sort());
    expect(handled).toHaveLength(8);
    expect([...ANALYSIS_TOOL_NAMES].sort()).toEqual(
      ['retivo_get_projection', 'retivo_get_stress_test', 'retivo_compare_scenarios', 'retivo_explain'].sort(),
    );
  });

  it('names tools whose registry entries parse against the descriptor schema', () => {
    for (const name of [...PLAN_TOOL_NAMES, ...ANALYSIS_TOOL_NAMES]) {
      const entry = TOOL_REGISTRY.find((candidate) => candidate.name === name);
      expect(entry, name).toBeDefined();
      expect(toolEntrySchema.safeParse(entry).success, name).toBe(true);
      expect(entry!.name).toMatch(/^retivo_[a-z_]+$/);
    }
  });
});

describe('the stress test’s limits', () => {
  const entry = TOOL_REGISTRY.find((candidate) => candidate.name === 'retivo_get_stress_test')!;

  it('is the only long-running tool, with a bridge timeout above the tab’s wall clock and inside the clamp', () => {
    expect(TOOL_REGISTRY.filter((candidate) => candidate.longRunning).map((candidate) => candidate.name)).toEqual(['retivo_get_stress_test']);
    expect(entry.timeoutMs).toBeGreaterThan(STRESS_TEST_WALL_CLOCK_MS);
    expect(entry.timeoutMs).toBeLessThanOrEqual(MAX_CALL_TIMEOUT_MS);
  });
});

describe('the analysis tools’ own test inputs', () => {
  beforeAll(async () => {
    await clearAllStores();
    await loadDemoData({ householdId: 'hh-1', email: 'a@b.example', displayName: 'Demo', todayYear: 2026 });
    // A saved result, so the stress test reads the cache and builds no worker.
    await plantSavedStressTest(BASE_ID);
  });

  afterAll(async () => {
    await clearMonteCarloCache();
    await clearAllStores();
  });

  it('has inputs for every analysis tool and for nothing else', () => {
    expect(Object.keys(ANALYSIS_TEST_INPUTS).sort()).toEqual([...ANALYSIS_TOOL_NAMES].sort());
  });

  it('are accepted by the registry entry of the same name, so an entry cannot reject what its handler is tested with', () => {
    for (const [name, inputs] of Object.entries(ANALYSIS_TEST_INPUTS)) {
      const entry = TOOL_REGISTRY.find((candidate) => candidate.name === name);
      expect(entry, name).toBeDefined();
      for (const input of inputs) expect(entry!.inputSchema.safeParse(input).success, `${name} ${JSON.stringify(input)}`).toBe(true);
    }
  });

  it('are answered by the handler with a result, not INVALID_ARGS or TOOL_NOT_SUPPORTED', async () => {
    for (const [name, inputs] of Object.entries(ANALYSIS_TEST_INPUTS)) {
      for (const input of inputs) {
        const result = await callPlanTool(name, { ...input });
        expect(result.ok, `${name} ${JSON.stringify(input)}: ${result.ok ? '' : result.error.message}`).toBe(true);
      }
    }
  });
});
