/** The plan tools behind the real dispatcher: its gates, its argument check, and what a failure may say. */
import 'fake-indexeddb/auto';
import { TOOL_REGISTRY, type TabFrame, type ToolResult } from '@retirement/assistant-protocol';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as store from '../../db/store';
import { clearAllStores } from '../../db/store';
import { seedSentinelWorkspace } from '../../test/assistant-sentinels';
import { plantSavedStressTest } from '../../test/assistant-tools';
import { defaultConsentAnswer, createConsentRecord } from '../sharing/consent';
import { CallDispatcher, type SettledCall } from '../dispatcher';
import { ANALYSIS_TOOL_NAMES, PLAN_TOOL_NAMES, registerPlanTools } from '.';

const ARGS: Record<string, Record<string, unknown>> = {
  retivo_status: {},
  retivo_get_plan_data: {},
  retivo_list_scenarios: {},
  retivo_get_scenario: { scenarioId: 'demo-scenario-base' },
  retivo_get_projection: { scenarioId: 'demo-scenario-base' },
  retivo_get_stress_test: {},
  retivo_compare_scenarios: { scenarioId: 'demo-scenario-base', otherScenarioId: 'demo-scenario-early' },
  retivo_explain: { metric: 'ending_balance' },
};

/** Every tool this version answers. The stress test reads a result planted below, so no call here builds a worker. */
const ALL_TOOL_NAMES = [...PLAN_TOOL_NAMES, ...ANALYSIS_TOOL_NAMES];

function harness(options: { ready?: boolean } = {}) {
  const sent: TabFrame[] = [];
  const settled: SettledCall[] = [];
  const consent = createConsentRecord(defaultConsentAnswer(), 0, 1);
  const dispatcher = new CallDispatcher({
    registry: TOOL_REGISTRY,
    timers: { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
    now: () => new Date(2026, 5, 15).getTime(),
    isWorkspaceReady: () => options.ready ?? true,
    getConsent: () => consent,
    appBuildId: 'test-build',
    send: (frame) => sent.push(frame),
    onSettled: (call) => settled.push(call),
  });
  registerPlanTools((name, handler) => dispatcher.register(name, handler));
  let next = 0;
  const call = async (tool: string, args: Record<string, unknown>): Promise<ToolResult> => {
    next += 1;
    const id = `call-${next}`;
    dispatcher.handleCall({ id, tool, args });
    await vi.waitFor(() => expect(sent.some((frame) => frame.type === 'result' && frame.id === id)).toBe(true));
    const frame = sent.find((candidate) => candidate.type === 'result' && candidate.id === id);
    if (frame?.type !== 'result') throw new Error('no result');
    return frame.result;
  };
  return { call, settled };
}

beforeAll(async () => {
  await clearAllStores();
  await seedSentinelWorkspace();
  await plantSavedStressTest('demo-scenario-base');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a locked or signed-out workspace', () => {
  it.each(ALL_TOOL_NAMES)('%s answers WORKSPACE_LOCKED and reads nothing', async (tool) => {
    const reads = vi.spyOn(store, 'listAggregates');
    const pending = vi.spyOn(store, 'listPendingMutations');
    const metadata = vi.spyOn(store, 'readDeviceMetadata');
    const { call } = harness({ ready: false });
    const result = await call(tool, ARGS[tool]!);
    expect(result).toMatchObject({ ok: false, error: { code: 'WORKSPACE_LOCKED' } });
    expect(reads).not.toHaveBeenCalled();
    expect(pending).not.toHaveBeenCalled();
    expect(metadata).not.toHaveBeenCalled();
  });
});

describe('arguments', () => {
  it.each([
    ['retivo_get_scenario', {}],
    ['retivo_get_scenario', { scenarioId: 7 }],
    ['retivo_get_plan_data', { sections: ['household'] }],
    ['retivo_get_plan_data', { sections: 'accounts' }],
    ['retivo_get_projection', { method: 'optimistic' }],
    ['retivo_get_projection', { fromYear: 2040.5 }],
    ['retivo_get_stress_test', { scenarioId: 7 }],
    ['retivo_compare_scenarios', { scenarioId: 'demo-scenario-base' }],
    ['retivo_compare_scenarios', { baseScenarioId: 'a', otherScenarioId: 'b' }],
    ['retivo_explain', {}],
    ['retivo_explain', { metric: 'success rate' }],
  ])('%s rejects %j as INVALID_ARGS before any read', async (tool, args) => {
    const reads = vi.spyOn(store, 'listAggregates');
    const { call } = harness();
    expect(await call(tool, args)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    expect(reads).not.toHaveBeenCalled();
  });

  it.each([
    ['retivo_get_scenario', { scenarioId: 'no-such-scenario-zz' }],
    ['retivo_get_projection', { scenarioId: 'no-such-scenario-zz' }],
    ['retivo_get_stress_test', { scenarioId: 'no-such-scenario-zz' }],
    ['retivo_compare_scenarios', { scenarioId: 'no-such-scenario-zz', otherScenarioId: 'demo-scenario-base' }],
    ['retivo_compare_scenarios', { scenarioId: 'demo-scenario-base', otherScenarioId: 'no-such-scenario-zz' }],
    ['retivo_explain', { scenarioId: 'no-such-scenario-zz', metric: 'plan_success' }],
  ])('answers INVALID_ARGS for a scenario id that does not exist in %s, without echoing it', async (tool, args) => {
    const { call, settled } = harness();
    const result = await call(tool, args);
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    expect(JSON.stringify(result)).not.toContain('no-such-scenario-zz');
    expect(settled.at(-1)).toMatchObject({ outcome: 'INVALID_ARGS', completed: false });
  });
});

describe('a handler that throws', () => {
  it('answers INTERNAL with a message that carries nothing from the failure', async () => {
    const leak = 'Zzlastname zz.sentinel@leak.example zz-device-sentinel stack at /secret/path.ts';
    vi.spyOn(store, 'listAggregates').mockRejectedValue(Object.assign(new Error(leak), { stack: leak }));
    const { call, settled } = harness();
    for (const tool of ALL_TOOL_NAMES) {
      const result = await call(tool, ARGS[tool]!);
      expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
      const text = JSON.stringify(result).toLowerCase();
      for (const sentinel of ['zzlastname', 'zz.sentinel', 'zz-device-sentinel', 'secret/path']) expect(text).not.toContain(sentinel);
    }
    expect(settled.every((call) => call.outcome === 'INTERNAL' && !call.completed)).toBe(true);
  });
});

describe('a completed call', () => {
  it.each(ALL_TOOL_NAMES)('%s is answered with an envelope and counts as completed', async (tool) => {
    const { call, settled } = harness();
    const result = await call(tool, ARGS[tool]!);
    expect(result.ok).toBe(true);
    expect(settled.at(-1)).toMatchObject({ tool, outcome: 'ok', completed: true });
    // The audited text is the result as sent, which is the whole envelope.
    expect(JSON.parse(settled.at(-1)!.payload)).toEqual(JSON.parse(JSON.stringify(result)));
  });
});
