/** The package registry and the tab's handler map name the same tools, except the ones a later row owns. */
import { TOOL_REGISTRY, toolEntrySchema } from '@retirement/assistant-protocol';
import { describe, expect, it } from 'vitest';
import { PLAN_TOOL_NAMES, planToolHandlers } from '.';

/** Registry entries whose handlers arrive with the analysis rows; this version answers them `TOOL_NOT_SUPPORTED`. */
const ANSWERED_BY_LATER_ROWS = ['retivo_get_projection', 'retivo_get_stress_test', 'retivo_compare_scenarios', 'retivo_explain'];

describe('the tab’s handler map', () => {
  it('has a handler for every registry entry this version answers, and nothing the registry lacks', () => {
    const registered = TOOL_REGISTRY.map((entry) => entry.name);
    const handled = [...planToolHandlers().keys()];
    expect(handled.every((name) => registered.includes(name))).toBe(true);
    expect(registered.filter((name) => !handled.includes(name))).toEqual(ANSWERED_BY_LATER_ROWS);
    expect([...handled].sort()).toEqual([...PLAN_TOOL_NAMES].sort());
    expect(handled).toHaveLength(4);
  });

  it('names tools whose registry entries parse against the descriptor schema', () => {
    for (const name of PLAN_TOOL_NAMES) {
      const entry = TOOL_REGISTRY.find((candidate) => candidate.name === name);
      expect(entry, name).toBeDefined();
      expect(toolEntrySchema.safeParse(entry).success, name).toBe(true);
      expect(entry!.name).toMatch(/^retivo_[a-z_]+$/);
    }
  });
});
