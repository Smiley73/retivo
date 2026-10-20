/**
 * The tab's tool handlers, by registry name. The package registry says which
 * tools exist and what they take; this map says which of them this version of
 * the app can answer, and the dispatcher answers `TOOL_NOT_SUPPORTED` for the
 * rest. Every handler is built by `toHandler`, so the envelope, the sanitizer
 * walk and the size cap are not something a tool opts into.
 *
 * The plan and status tools read what the person recorded; the analysis tools
 * run what the Balance Projection page runs. Neither kind writes anything.
 */
import type { ToolHandler } from '../dispatcher';
import { retivoCompareScenarios } from './compare-scenarios';
import { toHandler, type ToolDefinition } from './define';
import { retivoExplain } from './explain';
import { retivoGetPlanData } from './plan-data';
import { retivoGetProjection } from './get-projection';
import { retivoGetScenario } from './get-scenario';
import { retivoGetStressTest } from './stress-test';
import { retivoListScenarios } from './list-scenarios';
import { retivoStatus } from './status';

const PLAN_DEFINITIONS: readonly ToolDefinition[] = [retivoStatus, retivoGetPlanData, retivoListScenarios, retivoGetScenario];
const ANALYSIS_DEFINITIONS: readonly ToolDefinition[] = [retivoGetProjection, retivoGetStressTest, retivoCompareScenarios, retivoExplain];

/** The plan and status tools this version answers. */
export const PLAN_TOOL_NAMES: readonly string[] = PLAN_DEFINITIONS.map((definition) => definition.name);
/** The projection, stress-test, compare and explain tools this version answers. */
export const ANALYSIS_TOOL_NAMES: readonly string[] = ANALYSIS_DEFINITIONS.map((definition) => definition.name);

export function planToolHandlers(): Map<string, ToolHandler> {
  return new Map([...PLAN_DEFINITIONS, ...ANALYSIS_DEFINITIONS].map((definition) => [definition.name, toHandler(definition)]));
}

/** Registers every tool this version answers; returns the function that removes them again. */
export function registerPlanTools(register: (name: string, handler: ToolHandler) => () => void): () => void {
  const removers = [...planToolHandlers()].map(([name, handler]) => register(name, handler));
  return () => {
    for (const remove of removers) remove();
  };
}
