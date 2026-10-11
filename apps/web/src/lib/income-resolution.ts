/**
 * Resolves the active IncomeStream list for a given scenario.
 *
 * Thin wrapper that delegates to the per-id sparse resolver in
 * [income-override-resolution.ts]. Public name preserved for planning-engine
 * callers.
 */
import {
  resolveIncomeForScenarioSparse,
  type ResolvedIncomeStream as SparseResolvedIncomeStream,
} from './income-override-resolution';
import type { ScenarioAggregate } from './scenario-resolution';
import type { Aggregate, IncomeStreamPayload } from '../db/types';

export type ResolvedIncomeStream = SparseResolvedIncomeStream;

export function resolveIncomeForScenario(
  scenarioId: string,
  allScenarios: ScenarioAggregate[],
  canonicalIncome: Aggregate<IncomeStreamPayload>[],
): ResolvedIncomeStream[] {
  return resolveIncomeForScenarioSparse(
    scenarioId,
    allScenarios,
    canonicalIncome,
  );
}
