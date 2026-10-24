// Public name for the active IncomeStream list; delegates to `income-override-resolution.ts`.
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
