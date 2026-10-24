// Reference scan: which income streams point at an account, via `linkedCbpAccountId` or `targetAccountId`, for the delete and disable guards.
// The match is structural, so a stream disabled in a scenario still counts. Callers pass tombstone-filtered streams; this does not re-filter.

import type {
  Aggregate,
  IncomeStreamPayload,
  PatchWithClears,
  ScenarioPayload,
} from '../db/types';

// A patch that clears a reference field (`null`) fails the `typeof === 'string'` check, so a cleared link stops orphaning the account.
function referencesAccount(
  payload: PatchWithClears<IncomeStreamPayload>,
  accountId: string,
): boolean {
  return (
    (typeof payload.linkedCbpAccountId === 'string' &&
      payload.linkedCbpAccountId === accountId) ||
    (typeof payload.targetAccountId === 'string' &&
      payload.targetAccountId === accountId)
  );
}

/** All uncapped reference labels (canonical streams first, then per-scenario embeds); the dialog owns the display cap. */
export function accountIncomeReferenceLabels(
  accountId: string,
  incomeStreams: Aggregate<IncomeStreamPayload>[],
  scenarios: Aggregate<ScenarioPayload>[],
): string[] {
  const labels: string[] = [];

  for (const s of incomeStreams) {
    if (referencesAccount(s.payload, accountId)) {
      labels.push(`"${s.payload.name}" (Base)`);
    }
  }

  for (const sc of scenarios) {
    const scenarioName = sc.payload.name;
    const added = sc.payload.overrides?.income?.added ?? [];
    for (const a of added) {
      if (referencesAccount(a, accountId)) {
        labels.push(`"${a.name}" (in scenario "${scenarioName}")`);
      }
    }
    const patches = sc.payload.overrides?.income?.patches ?? {};
    for (const p of Object.values(patches)) {
      if (referencesAccount(p, accountId)) {
        labels.push(`(patched in scenario "${scenarioName}")`);
      }
    }
  }

  return labels;
}
