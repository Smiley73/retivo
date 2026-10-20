/**
 * Reading the stress test the page already saved, for the tools that must never
 * run a simulation (compare, explain) and as the first step of the one that may.
 * The input is the page's (`buildMonteCarloInputForScenario`), the key is the
 * page's (`mcCacheKey`), and the read is `peekCached`, which leaves the entry,
 * its `lastAccessedAt` and the entry count exactly as they were.
 */
import { mcCacheKey, peekCached } from '../../db/monte-carlo-cache';
import { MC_PATH_COUNT, buildMonteCarloInputForScenario } from '../../lib/monte-carlo-scenario-input';
import type { MonteCarloInput, MonteCarloSummary } from '../../lib/monte-carlo';
import type { ToolEnv } from './define';

/** The input the Balance Projection page would run for `scenarioId` on the tab's clock; `null` when it cannot run. */
export function monteCarloInputFor(scenarioId: string, env: ToolEnv, pathCount: number = MC_PATH_COUNT): MonteCarloInput | null {
  const { workspace, now } = env;
  const input = buildMonteCarloInputForScenario({
    scenarioId,
    scenarios: workspace.scenarios,
    // No `categories`: the page's stress run ignores the medical flags and keeps the legacy `cat-medical` set, so the
    // tool's input, cache key and seed must too (see the follow-up on the page-versus-builder difference).
    inputs: {
      members: workspace.members,
      accounts: workspace.accounts,
      balances: workspace.balances,
      expenses: workspace.expenses,
      incomeStreams: workspace.incomeStreams,
      ssBenefits: workspace.ssBenefits,
    },
    todayYear: now.getFullYear(),
    todayMonthIndex: now.getMonth(),
  });
  return input === null ? null : { ...input, pathCount };
}

/** The saved summary for `input`, or `null` on a miss or a result from another engine version. */
export async function peekSummary(input: MonteCarloInput): Promise<MonteCarloSummary | null> {
  return peekCached(await mcCacheKey(input));
}

/** What compare and explain say when a scenario has no saved result, so the long call is explicit. */
export const NOT_COMPUTED = {
  reason: 'not_computed',
  note: 'No saved stress-test result exists for this scenario as it stands. Call retivo_get_stress_test to run it; that can take up to a minute.',
} as const;

/** The saved summary for a scenario, or `null` when it has none or cannot run. */
export async function peekStressSummary(scenarioId: string, env: ToolEnv): Promise<MonteCarloSummary | null> {
  const input = monteCarloInputFor(scenarioId, env);
  return input === null ? null : peekSummary(input);
}
