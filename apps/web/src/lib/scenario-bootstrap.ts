/**
 * Lazy base-scenario creation: on first render with no Scenario rows, queue a `create` mutation seeding a "Base" scenario with default retirement and claim ages.
 * The storage flag stays `isPrimary`; only the user-facing role name is "base".
 */
import { listAggregates } from '../db/store';
import { queueLocalMutation } from '../sync/mutation-queue';
import { cryptoUuid } from './crypto-uuid';
import { notifyScenariosChanged } from './scenario-mutations';
import type { ScenarioPayload } from '../db/types';

/** Default name used by both the auto-creation path and the demo seed. */
export const BASE_SCENARIO_NAME = 'Base';

/**
 * Default retirement age for a fresh base scenario: 65y 0m, same-date mode anchored on the primary
 * so couples land in the supported case.
 */
export const DEFAULT_RETIREMENT_AGE = {
  primary: { ageYears: 65, ageMonths: 0 },
  sameDateAnchor: 'primary' as const,
};

/**
 * Default claim age: 67y 0m, Full Retirement Age for anyone born 1960 or later; no secondary is
 * seeded.
 */
export const DEFAULT_SOCIAL_SECURITY_CLAIM_AGE = {
  primary: { ageYears: 67, ageMonths: 0 },
};

const ensuringByHousehold = new Set<string>();

/**
 * Queue the base scenario `create` unless a scenario exists; returns its id, or `null` if none was
 * needed. Concurrent calls in one tab are deduped by a module-level set; cross-tab races are
 * resolved by the dual-base reconciliation pass.
 */
export async function ensureBaseScenario(
  householdId: string,
): Promise<string | null> {
  if (ensuringByHousehold.has(householdId)) return null;
  ensuringByHousehold.add(householdId);
  try {
    const existing = await listAggregates('scenario');
    if (existing.length > 0) return null;

    const id = cryptoUuid();
    const payload: ScenarioPayload = {
      name: BASE_SCENARIO_NAME,
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides: {
        retirementAge: DEFAULT_RETIREMENT_AGE,
        socialSecurity: DEFAULT_SOCIAL_SECURITY_CLAIM_AGE,
        withdrawalStrategy: { kind: 'taxEfficient' },
      },
    };
    await queueLocalMutation<ScenarioPayload>({
      type: 'scenario',
      aggregateId: id,
      householdId,
      operation: 'create',
      expectedVersion: 0,
      payload,
    });
    notifyScenariosChanged();
    return id;
  } finally {
    ensuringByHousehold.delete(householdId);
  }
}

