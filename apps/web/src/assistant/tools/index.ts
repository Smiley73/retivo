/**
 * The tab's tool handlers, by registry name. The package registry says which
 * tools exist and what they take; this map says which of them this version of
 * the app can answer, and the dispatcher answers `TOOL_NOT_SUPPORTED` for the
 * rest. Every handler is built by `toHandler`, so the envelope, the sanitizer
 * walk and the size cap are not something a tool opts into.
 */
import type { ToolHandler } from '../dispatcher';
import { toHandler, type ToolDefinition } from './define';
import { retivoGetPlanData } from './plan-data';
import { retivoGetScenario } from './get-scenario';
import { retivoListScenarios } from './list-scenarios';
import { retivoStatus } from './status';

const DEFINITIONS: readonly ToolDefinition[] = [retivoStatus, retivoGetPlanData, retivoListScenarios, retivoGetScenario];

/** The plan and status tools this version answers. */
export const PLAN_TOOL_NAMES: readonly string[] = DEFINITIONS.map((definition) => definition.name);

export function planToolHandlers(): Map<string, ToolHandler> {
  return new Map(DEFINITIONS.map((definition) => [definition.name, toHandler(definition)]));
}

/** Registers every plan tool; returns the function that removes them again. */
export function registerPlanTools(register: (name: string, handler: ToolHandler) => () => void): () => void {
  const removers = [...planToolHandlers()].map(([name, handler]) => register(name, handler));
  return () => {
    for (const remove of removers) remove();
  };
}
