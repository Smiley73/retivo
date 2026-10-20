/**
 * The static tool and prompt registries the bridge declares whole at start. The
 * list never changes mid-session (Codex does not refresh it) and no frame
 * carries one: a tab answers the tools it knows and returns `TOOL_NOT_SUPPORTED`
 * for the rest.
 */
import { z } from 'zod';
import { DEFAULT_CALL_TIMEOUT_MS, MAX_CALL_TIMEOUT_MS, MIN_CALL_TIMEOUT_MS } from './constants.js';
import { toolResultSchema } from './result.js';

/** One tool: input schema written once in Zod, converted to JSON Schema at the package boundary. */
export const toolEntrySchema = z.object({
  name: z.string().regex(/^retivo_[a-z_]+$/),
  description: z.string().min(1),
  inputSchema: z.custom<z.ZodObject>((value) => value instanceof z.ZodObject),
  /** What the bridge enforces for this tool; plain reads keep the default. */
  timeoutMs: z.number().int().min(MIN_CALL_TIMEOUT_MS).max(MAX_CALL_TIMEOUT_MS),
  longRunning: z.boolean(),
});
export type ToolEntry = z.infer<typeof toolEntrySchema>;

const scenarioId = z.string().min(1).max(128).describe('Id from retivo_list_scenarios.');

/** The parts of the plan `retivo_get_plan_data` can return; each one follows its own consent switch. */
export const PLAN_DATA_SECTIONS = [
  'members',
  'accounts',
  'balances',
  'income',
  'expenses',
  'socialSecurity',
  'scenarios',
] as const;
export type PlanDataSection = (typeof PLAN_DATA_SECTIONS)[number];

function readTool(name: string, description: string, inputSchema: z.ZodObject): ToolEntry {
  return toolEntrySchema.parse({ name, description, inputSchema, timeoutMs: DEFAULT_CALL_TIMEOUT_MS, longRunning: false });
}

/** The v1 read-only tools; changing this list is deliberate and reviewed. */
export const TOOL_REGISTRY: readonly ToolEntry[] = [
  readTool(
    'retivo_status',
    'Reports the connection and workspace state, the app build, the calculation engine version, the tax-table year and how fresh the data is. Call it first to learn whether the workspace is ready.',
    z.object({}),
  ),
  readTool(
    'retivo_get_plan_data',
    'Returns the plan data the person chose to share: household members, accounts and balances, income, expenses, Social Security and scenarios with their overrides. Pass sections to ask for fewer parts; a part the person turned off is left out and named in the result.',
    z.object({
      sections: z
        .array(z.enum(PLAN_DATA_SECTIONS))
        .min(1)
        .max(PLAN_DATA_SECTIONS.length)
        .optional()
        .describe('Which parts of the plan to return. Defaults to all of them.'),
    }),
  ),
  readTool(
    'retivo_list_scenarios',
    'Lists the scenarios in the plan with their ids, names, parent scenario, which one is the base scenario and the settings each one changes. Use the ids with the other scenario tools.',
    z.object({}),
  ),
  readTool(
    'retivo_get_scenario',
    "Returns one scenario's resolved inputs after inheritance. Each section says which scenario set it or which default the engine applied for anything left unset.",
    z.object({ scenarioId }),
  ),
  readTool(
    'retivo_get_projection',
    "Returns the deterministic year-by-year projection for one scenario, exactly as the app's projection page shows it.",
    z.object({ scenarioId }),
  ),
  toolEntrySchema.parse({
    name: 'retivo_get_stress_test',
    description:
      'Returns the Monte Carlo stress-test summary for one scenario: from the cache when present, otherwise computed in the open tab, which can take a while.',
    inputSchema: z.object({ scenarioId }),
    timeoutMs: 5 * 60_000,
    longRunning: true,
  }),
  readTool(
    'retivo_compare_scenarios',
    'Compares two scenarios: which inputs differ and how the outcomes differ.',
    z.object({ baseScenarioId: scenarioId, otherScenarioId: scenarioId }),
  ),
  readTool(
    'retivo_explain',
    'Explains where a headline number comes from: the inputs, the assumptions and the matching math page.',
    z.object({ scenarioId, metric: z.string().min(1).max(200).describe('The headline number to explain, in plain words.') }),
  ),
];

/** The MCP-facing JSON Schema of a result envelope, built once. MCP requires an object at the root. */
const RESULT_OUTPUT_SCHEMA = { ...z.toJSONSchema(toolResultSchema, { io: 'output' }), type: 'object' as const };

/** A tool as `tools/list` declares it. */
export interface McpToolDeclaration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown> & { type: 'object' };
  outputSchema: Record<string, unknown> & { type: 'object' };
}

/** Converts a registry entry to its MCP declaration; the same schema validates the tab's arguments. */
export function toMcpToolDeclaration(entry: ToolEntry): McpToolDeclaration {
  return {
    name: entry.name,
    description: entry.description,
    inputSchema: { ...z.toJSONSchema(entry.inputSchema, { io: 'input' }), type: 'object' },
    outputSchema: RESULT_OUTPUT_SCHEMA,
  };
}

/** A static MCP prompt, served on `prompts/get` without a round trip to the tab. */
export const promptEntrySchema = z.object({
  name: z.string().regex(/^retivo_[a-z_]+$/),
  description: z.string().min(1),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().min(1) })).min(1),
});
export type PromptEntry = z.infer<typeof promptEntrySchema>;

/** The shipped prompts; the plan-review prompt is added with its messages. */
export const PROMPTS: readonly PromptEntry[] = [];

/** A prompt as `prompts/list` declares it. */
export function toMcpPromptDeclaration(prompt: PromptEntry): { name: string; description: string } {
  return { name: prompt.name, description: prompt.description };
}
