/**
 * The demo dataset as search inputs, pinned to a fixed "today" so a search is
 * reproducible, the way `PlanStressTestSection.parity.test.ts` drives the
 * runner. Importing it requires `fake-indexeddb/auto` first.
 */
import { clearAllStores, listAggregates } from '../../db/store';
import { DEFAULT_LIFE_EXPECTANCY_AGE } from '../../db/types';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  ScenarioPayload,
  SocialSecurityBenefitPayload,
} from '../../db/types';
import { loadDemoData } from '../demo-data-loader';
import { resolveScenario } from '../scenario-resolution';
import type { RothSuggestionDeathAges, RothSuggestionProjectionInput } from './types';

export const DEMO_TODAY_YEAR = 2026;
/** May, the anchor the Monte Carlo parity fixtures use. */
export const DEMO_TODAY_MONTH = 4;
export const DEMO_TARGET_ROTH_ID = 'demo-account-john-roth-ira';
export const DEMO_EARLY_SCENARIO_ID = 'demo-scenario-early';

/** Loads the demo household into the (fake) store and reads it back. */
export async function loadDemoProjection(scenarioId: string): Promise<RothSuggestionProjectionInput> {
  await clearAllStores();
  await loadDemoData({
    householdId: 'roth-suggestion',
    email: 'demo@example.test',
    displayName: 'Demo User',
    todayYear: DEMO_TODAY_YEAR,
  });
  const read = async <T>(type: Parameters<typeof listAggregates>[0]): Promise<T[]> =>
    (await listAggregates(type)) as unknown as T[];
  return {
    scenarios: await read<Aggregate<ScenarioPayload>>('scenario'),
    selectedScenarioId: scenarioId,
    accounts: await read<Aggregate<AccountPayload>>('account'),
    balances: await read<Aggregate<AccountBalancePayload>>('accountBalance'),
    members: await read<Aggregate<HouseholdMemberPayload>>('householdMember'),
    ssBenefits: await read<Aggregate<SocialSecurityBenefitPayload>>('socialSecurityBenefit'),
    expenses: await read<Aggregate<ExpensePayload>>('expense'),
    incomeStreams: await read<Aggregate<IncomeStreamPayload>>('incomeStream'),
    todayYear: DEMO_TODAY_YEAR,
    todayMonthIndex: DEMO_TODAY_MONTH,
  };
}

/** The scenario's resolved life expectancies, the ages that make the search's
 *  reference candidate the plan the page already shows. */
export function resolvedDeathAges(projection: RothSuggestionProjectionInput): RothSuggestionDeathAges {
  const life = resolveScenario(projection.selectedScenarioId, [...projection.scenarios]).lifeExpectancy;
  return {
    primary: life?.primary ?? DEFAULT_LIFE_EXPECTANCY_AGE,
    ...(life?.secondary !== undefined ? { secondary: life.secondary } : {}),
  };
}
