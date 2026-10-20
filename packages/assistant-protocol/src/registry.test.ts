import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_CALL_TIMEOUT_MS, MAX_CALL_TIMEOUT_MS, MIN_CALL_TIMEOUT_MS } from './constants.js';
import {
  PLAN_DATA_SECTIONS,
  PROMPTS,
  TOOL_REGISTRY,
  promptEntrySchema,
  toMcpPromptDeclaration,
  toMcpToolDeclaration,
  toolEntrySchema,
} from './registry.js';

describe('tool registry', () => {
  it('seeds exactly the v1 tools', () => {
    expect(TOOL_REGISTRY.map((tool) => tool.name)).toEqual([
      'retivo_status',
      'retivo_get_plan_data',
      'retivo_list_scenarios',
      'retivo_get_scenario',
      'retivo_get_projection',
      'retivo_get_stress_test',
      'retivo_compare_scenarios',
      'retivo_explain',
    ]);
  });

  it('has unique names that match the pattern', () => {
    const names = TOOL_REGISTRY.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^retivo_[a-z_]+$/);
  });

  it('keeps timeouts inside the clamp and long-running tools above the default', () => {
    for (const tool of TOOL_REGISTRY) {
      expect(tool.timeoutMs).toBeGreaterThanOrEqual(MIN_CALL_TIMEOUT_MS);
      expect(tool.timeoutMs).toBeLessThanOrEqual(MAX_CALL_TIMEOUT_MS);
      if (tool.longRunning) expect(tool.timeoutMs).toBeGreaterThan(DEFAULT_CALL_TIMEOUT_MS);
    }
  });

  it('rejects a timeout outside the clamp and a bad name', () => {
    const base = { name: 'retivo_x', description: 'd', inputSchema: z.object({}), timeoutMs: 5_000, longRunning: false };
    expect(toolEntrySchema.safeParse(base).success).toBe(true);
    expect(toolEntrySchema.safeParse({ ...base, timeoutMs: MIN_CALL_TIMEOUT_MS - 1 }).success).toBe(false);
    expect(toolEntrySchema.safeParse({ ...base, timeoutMs: MAX_CALL_TIMEOUT_MS + 1 }).success).toBe(false);
    expect(toolEntrySchema.safeParse({ ...base, name: 'status' }).success).toBe(false);
  });

  it('declares every tool with an object input schema and an object result schema', () => {
    for (const tool of TOOL_REGISTRY) {
      const declaration = toMcpToolDeclaration(tool);
      expect(declaration.name).toBe(tool.name);
      expect(declaration.description).toBe(tool.description);
      expect(declaration.inputSchema.type).toBe('object');
      expect(declaration.outputSchema.type).toBe('object');
    }
  });

  it('validates tab-side arguments with the schema the declaration came from', () => {
    const scenario = TOOL_REGISTRY.find((tool) => tool.name === 'retivo_get_scenario')!;
    expect(scenario.inputSchema.safeParse({ scenarioId: 's1' }).success).toBe(true);
    expect(scenario.inputSchema.safeParse({}).success).toBe(false);
    expect(toMcpToolDeclaration(scenario).inputSchema.required).toEqual(['scenarioId']);
  });
});

describe('the plan and status tools', () => {
  const NAMES = ['retivo_status', 'retivo_get_plan_data', 'retivo_list_scenarios', 'retivo_get_scenario'];
  const entry = (name: string) => TOOL_REGISTRY.find((tool) => tool.name === name)!;

  it('parse against the descriptor schema as plain reads on the default timeout', () => {
    for (const name of NAMES) {
      const tool = entry(name);
      expect(toolEntrySchema.safeParse(tool).success, name).toBe(true);
      expect(tool.name).toMatch(/^retivo_[a-z_]+$/);
      expect(tool.longRunning).toBe(false);
      expect(tool.timeoutMs).toBe(DEFAULT_CALL_TIMEOUT_MS);
    }
  });

  it('validate the same arguments through the Zod object and the JSON Schema derived from it', () => {
    const cases: Array<{ tool: string; args: unknown; valid: boolean }> = [
      { tool: 'retivo_status', args: {}, valid: true },
      { tool: 'retivo_get_plan_data', args: {}, valid: true },
      { tool: 'retivo_get_plan_data', args: { sections: ['accounts', 'scenarios'] }, valid: true },
      { tool: 'retivo_get_plan_data', args: { sections: ['household'] }, valid: false },
      { tool: 'retivo_get_plan_data', args: { sections: [] }, valid: false },
      { tool: 'retivo_get_plan_data', args: { sections: 'accounts' }, valid: false },
      { tool: 'retivo_list_scenarios', args: {}, valid: true },
      { tool: 'retivo_get_scenario', args: { scenarioId: 's1' }, valid: true },
      { tool: 'retivo_get_scenario', args: {}, valid: false },
      { tool: 'retivo_get_scenario', args: { scenarioId: 7 }, valid: false },
      { tool: 'retivo_get_scenario', args: { scenarioId: '' }, valid: false },
    ];
    for (const { tool, args, valid } of cases) {
      const fromZod = entry(tool).inputSchema.safeParse(args).success;
      // Rebuilt from the JSON Schema the agent receives, so a hand-edited declaration would disagree.
      const fromJsonSchema = z.fromJSONSchema(toMcpToolDeclaration(entry(tool)).inputSchema).safeParse(args).success;
      expect({ tool, args, fromZod }).toEqual({ tool, args, fromZod: valid });
      expect({ tool, args, fromJsonSchema }).toEqual({ tool, args, fromJsonSchema: valid });
    }
  });

  it('advertises the section names the tab understands', () => {
    const schema = toMcpToolDeclaration(entry('retivo_get_plan_data')).inputSchema as unknown as {
      properties: { sections: { items: { enum: string[] } } };
    };
    expect(schema.properties.sections.items.enum).toEqual([...PLAN_DATA_SECTIONS]);
  });
});

describe('prompt registry', () => {
  it('ships an empty list and converts a prompt to its MCP declaration', () => {
    expect(PROMPTS).toEqual([]);
    const prompt = promptEntrySchema.parse({
      name: 'retivo_example',
      description: 'An example.',
      messages: [{ role: 'user', text: 'Hello' }],
    });
    expect(toMcpPromptDeclaration(prompt)).toEqual({ name: 'retivo_example', description: 'An example.' });
  });
});
