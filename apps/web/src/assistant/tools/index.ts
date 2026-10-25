/**
 * The tab's tool handlers, by registry name. The package registry says which
 * tools exist and what they take; this map says which of them this version of
 * the app can answer, and the dispatcher answers `TOOL_NOT_SUPPORTED` for the
 * rest. Every handler is built by `toHandler`, so the envelope, the sanitizer
 * walk and the size cap are not something a tool opts into.
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
import { retivoRunWhatIf } from './what-if';

const DEFINITIONS: readonly ToolDefinition[] = [
  retivoStatus,
  retivoGetPlanData,
  retivoListScenarios,
  retivoGetScenario,
  retivoGetProjection,
  retivoGetStressTest,
  retivoCompareScenarios,
  retivoExplain,
  retivoRunWhatIf,
];

/** Registers every tool this version answers; returns the function that removes them again. */
export function registerPlanTools(register: (name: string, handler: ToolHandler) => () => void): () => void {
  const removers = DEFINITIONS.map((definition) => register(definition.name, toHandler(definition)));
  return () => {
    for (const remove of removers) remove();
  };
}
