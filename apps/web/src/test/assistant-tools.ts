/**
 * Helpers for the assistant tool tests: a handler context under chosen consent
 * choices, a call that runs a registered handler the way the dispatcher does, and
 * the narrowing of a result to its envelope.
 */
import type { ToolResult } from '@retirement/assistant-protocol';
import type { ToolCallContext, ToolHandler } from '../assistant/dispatcher';
import { loadWorkspace, type DataFreshness } from '../assistant/tools/workspace';
import { monteCarloInputFor } from '../assistant/tools/stress-cache';
import { mcCacheKey, putCached } from '../db/monte-carlo-cache';
import { savedSummary } from './assistant-analysis-inputs';
import { createConsentRecord } from '../assistant/sharing/consent';
import { defaultSharingChoices, type SharingChoices } from '../assistant/sharing/switches';
import { buildShareView } from '../assistant/sharing/view';
import { registerPlanTools } from '../assistant/tools';
import { toHandler, type ToolDefinition } from '../assistant/tools/define';
import type { TaxTableFacts } from '../assistant/tools/facts';
import type { RoundingDescriptor } from '../assistant/sharing/rounding';
import type { SharingSwitchId } from '../assistant/sharing/switches';

/** Mid-June 2026 in the local zone: the tab's "today" for these tests. */
export const TEST_NOW = new Date(2026, 5, 15, 12, 0, 0);

export function choicesWith(overrides: Partial<SharingChoices> = {}): SharingChoices {
  return { ...defaultSharingChoices(), ...overrides };
}

export function toolContext(choices: SharingChoices = defaultSharingChoices(), now: Date = TEST_NOW): ToolCallContext {
  const consent = createConsentRecord({ choices, keepSignedInWhileActive: false }, 0, 1);
  return {
    signal: new AbortController().signal,
    progress: () => undefined,
    share: { consent, buildView: (source) => buildShareView(source, consent.choices, { now }) },
    now,
    connection: { assistantName: 'Test Assistant', pairedAt: Date.UTC(2026, 5, 15, 11, 0, 0) },
  };
}

const HANDLERS = new Map<string, ToolHandler>();
registerPlanTools((name, handler) => {
  HANDLERS.set(name, handler);
  return () => undefined;
});

/** The shipped handler for a registry tool. */
export function planToolHandler(name: string): ToolHandler {
  const handler = HANDLERS.get(name);
  if (handler === undefined) throw new Error(`no handler for ${name}`);
  return handler;
}

/** Runs a plan tool's handler directly, the way the dispatcher does once its own gates pass. */
export async function callPlanTool(
  name: string,
  args: Record<string, unknown> = {},
  choices: SharingChoices = defaultSharingChoices(),
  now: Date = TEST_NOW,
): Promise<ToolResult> {
  return planToolHandler(name)(args, toolContext(choices, now));
}

/** Runs a tool built outside the shipped list (one with injected workers, say) through the same `toHandler` wrapper. */
export async function callDefinition(
  definition: ToolDefinition,
  args: Record<string, unknown> = {},
  context: ToolCallContext = toolContext(),
): Promise<ToolResult> {
  return toHandler(definition)(args, context);
}

interface ToolEnvelope {
  data: Record<string, unknown>;
  assumptions: string[];
  rounding: RoundingDescriptor;
  labels: { mode: string; statement: string };
  withheld: SharingSwitchId[];
  neverShared: { statement: string; items: readonly string[] };
  disclosure: Record<'notFinancialAdvice' | 'professionalReview' | 'taxSnapshot' | 'dataNotInstructions', string>;
  engineVersion: number;
  taxTables: TaxTableFacts;
  dataAsOf: DataFreshness;
}

export function envelopeOf(result: ToolResult): ToolEnvelope {
  if (!result.ok) throw new Error(`expected an envelope, got ${result.error.code}: ${result.error.message}`);
  return result.payload as ToolEnvelope;
}

/**
 * Saves a stress-test result for `scenarioId` the way the page would, so a tool that reads the cache has
 * something to read and one that computes on a miss is not asked to (the test environment has no real worker).
 */
export async function plantSavedStressTest(scenarioId: string, seed = 4242, now: Date = TEST_NOW): Promise<void> {
  const workspace = await loadWorkspace();
  const input = monteCarloInputFor(scenarioId, { workspace, now } as unknown as Parameters<typeof monteCarloInputFor>[1]);
  if (input === null) throw new Error(`scenario ${scenarioId} cannot run a stress test`);
  await putCached(await mcCacheKey(input), savedSummary(seed));
}
