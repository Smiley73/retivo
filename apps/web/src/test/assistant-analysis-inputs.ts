/**
 * The arguments the analysis tools' own tests call them with, in one place so the registry test can prove the
 * package's input schema accepts every one of them: an entry whose schema rejects what its handler is tested with
 * would reach agents as INVALID_ARGS on a current app, which the dispatcher's generic tests cannot tell apart.
 */
import { TOOL_REGISTRY, toMcpToolDeclaration, type ExplainMetric } from '@retirement/assistant-protocol';
import type { ScenarioOverrides } from '../db/types';
import { ENGINE_VERSION, type MonteCarloSummary } from '../lib/monte-carlo';
import { MC_PATH_COUNT } from '../lib/monte-carlo-scenario-input';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

export const BASE_ID = 'demo-scenario-base';
export const EARLY_ID = 'demo-scenario-early';
export const DELAY_ID = 'demo-scenario-delay';
export const NO_CONTRIB_ID = 'demo-scenario-early-no-contrib';

/** The metrics `retivo_explain` accepts, read from the schema the agent receives. */
export const EXPLAIN_METRICS = (
  toMcpToolDeclaration(TOOL_REGISTRY.find((entry) => entry.name === 'retivo_explain')!).inputSchema.properties as { metric: { enum: ExplainMetric[] } }
).metric.enum;

export const ANALYSIS_TEST_INPUTS: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>> = {
  retivo_get_projection: [
    {},
    { scenarioId: BASE_ID },
    { scenarioId: EARLY_ID, method: 'planned', fromYear: 2040, toYear: 2050 },
    { scenarioId: BASE_ID, method: 'historical' },
  ],
  retivo_get_stress_test: [{}, { scenarioId: BASE_ID }],
  retivo_compare_scenarios: [
    { scenarioId: BASE_ID, otherScenarioId: EARLY_ID },
    { scenarioId: NO_CONTRIB_ID, otherScenarioId: BASE_ID },
  ],
  retivo_explain: [...EXPLAIN_METRICS.map((metric) => ({ scenarioId: BASE_ID, metric })), { metric: 'ending_balance' }],
  // No `stressTest: true`: the registry test has no worker to compute one.
  retivo_run_what_if: [
    { baseScenarioId: BASE_ID, overrides: {} },
    { baseScenarioId: BASE_ID, overrides: { retirementAge: { primary: { ageYears: 62 } }, socialSecurity: { primary: { ageYears: 70 } } } },
    { baseScenarioId: EARLY_ID, overrides: { inflation: { ratePct: 4 } }, fromYear: 2040, toYear: 2045 },
  ],
};

/** An unsaved child of `parent` carrying `overrides`, the shape `retivo_run_what_if` gives its throwaway. */
export function whatIfChildOf(parent: ScenarioAggregate, overrides: ScenarioOverrides): ScenarioAggregate {
  return { ...parent, id: 't-what-if', payload: { ...parent.payload, isPrimary: false, parentScenarioId: parent.id, overrides } };
}

/** A saved stress-test summary with distinctive figures, for tests that plant one in the cache. */
export function savedSummary(seed = 4242): MonteCarloSummary {
  return {
    engineVersion: ENGINE_VERSION,
    seed,
    pathCount: MC_PATH_COUNT,
    computedAt: Date.UTC(2026, 5, 1, 12, 0, 0),
    firstYear: 2026,
    horizonYears: 3,
    percentilesNominal: { p10: [10, 11, 12], p25: [20, 21, 22], p50: [30, 31, 32] },
    percentilesReal: { p10: [100_100, 110_200, 120_300], p25: [200_100, 210_200, 220_300], p50: [300_100, 310_200, 320_300] },
    successProbability: 0.9137,
    medianDepletionYear: null,
    p10DepletionYear: 2071,
    p25DepletionYear: null,
    medianEndingBalanceNominal: 1_234_567,
    medianEndingBalanceReal: 654_321,
    p10EndingBalanceNominal: 23_456,
    p10EndingBalanceReal: 12_345,
    p25EndingBalanceNominal: 456_789,
    p25EndingBalanceReal: 345_678,
    failureYearHistogram: [],
    endingBalanceHistogramNominal: [],
    endingBalanceHistogramReal: [],
    plannedOverlay: [],
  };
}
