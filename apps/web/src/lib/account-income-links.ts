/**
 * Structural reference scan: which income streams point at an account.
 *
 * An account cannot be deleted or disabled while any income stream is
 * paid *from* it (`linkedCbpAccountId`) or deposits *into* it
 * (`targetAccountId`). This pure helper returns the ordered, uncapped
 * list of human-readable reference labels — canonical streams first,
 * then per-scenario embeds — for both the AccountsPage delete guard and
 * the AccountFormModal disable guard (DRY, single scan).
 *
 * It mirrors the ExpenseCategoriesPage category-reference scan
 * one-for-one (canonical pass, then per-scenario added[]/patches[*]).
 * The match is **structural** (the field points at the id) and is
 * independent of scenario disable/resolve state — a disabled-in-scenario
 * stream still orphans the account on delete.
 *
 * Caller contract: pass tombstone-filtered `listAggregates`
 * output — the store already drops `deletedAt` rows at db/store.ts. This
 * helper does NOT re-filter; passing an unfiltered list would silently
 * count deleted streams.
 */
import type {
  Aggregate,
  IncomeStreamPayload,
  PatchWithClears,
  ScenarioPayload,
} from '../db/types';

/** True when this (full or partial) income payload structurally
 *  references `accountId` via either reference field. `targetAccountId`
 *  is optional on oneOff; `linkedCbpAccountId` optional on pension —
 *  both count only when set to a string equal to the account id. A
 *  patch that *clears* a reference field (value `null`) fails
 *  the `typeof === 'string'` check, so a cleared link no longer counts as
 *  a reference — the scenario stops orphaning the account, as intended. */
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

/**
 * All ordered, uncapped reference labels for income streams that point
 * at `accountId`. Empty array when nothing references it. The dialog
 * owns the display cap — never slice here.
 */
export function accountIncomeReferenceLabels(
  accountId: string,
  incomeStreams: Aggregate<IncomeStreamPayload>[],
  scenarios: Aggregate<ScenarioPayload>[],
): string[] {
  const labels: string[] = [];

  // Canonical streams first.
  for (const s of incomeStreams) {
    if (referencesAccount(s.payload, accountId)) {
      labels.push(`"${s.payload.name}" (Base)`);
    }
  }

  // Then per-scenario embeds: added[] entries (full payloads), then
  // patches[*] (partial payloads that may flip a reference field).
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
