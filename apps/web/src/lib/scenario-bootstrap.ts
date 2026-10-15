/**
 * Lazy base-scenario creation. Mirrors the Household-aggregate
 * lifecycle: on first post-bootstrap render, if no Scenario rows exist
 * locally, queue a `create` mutation that seeds a base scenario named
 * "Base" with hardcoded retirement-age defaults (65y 0m, secondary
 * same as primary user). After this runs, every consumer can assume
 * the base scenario exists.
 *
 * Note: the storage flag stays `isPrimary: boolean` — that's an
 * internal payload key. Only the user-facing role term renames to
 * "base."
 */
import { listAggregates } from '../db/store';
import { queueLocalMutation } from '../sync/mutation-queue';
import { cryptoUuid } from './crypto-uuid';
import { notifyScenariosChanged } from './scenario-mutations';
import type { ScenarioPayload } from '../db/types';

/** Default name used by both the auto-creation path and the demo seed. */
export const BASE_SCENARIO_NAME = 'Base';

/** Hardcoded retirement-age defaults applied to a fresh base scenario.
 *  Defaults to same-date mode anchored on the primary so couples land
 *  in the calm, supported case (no "different dates" warning). The
 *  user can switch the anchor or pick independent ages from the modal. */
export const DEFAULT_RETIREMENT_AGE = {
  primary: { ageYears: 65, ageMonths: 0 },
  sameDateAnchor: 'primary' as const,
};

/**
 * Hardcoded Social Security claim-age defaults applied to a fresh
 * base scenario. 67y 0m is the Full Retirement Age for everyone born
 * 1960 or later — the safe "did not yet decide" default. Secondary
 * is not seeded; couples routinely claim at different ages and the
 * UI surfaces a separate input once a secondary member exists.
 */
export const DEFAULT_SOCIAL_SECURITY_CLAIM_AGE = {
  primary: { ageYears: 67, ageMonths: 0 },
};

const ensuringByHousehold = new Set<string>();

/**
 * No-op if any non-deleted scenario already exists for the household;
 * otherwise queues the base scenario `create` mutation. Idempotent
 * across concurrent calls within a single tab via a module-level set —
 * cross-tab races still possible (very rare in v1 single-user) and
 * resolved by the dual-base reconciliation pass.
 *
 * Returns the id of the freshly-created base scenario, or `null` if
 * no creation was needed.
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
        // Seed the default withdrawal strategy explicitly so new scenarios
        // never carry an absent strategy. Tax-efficient is the default.
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

