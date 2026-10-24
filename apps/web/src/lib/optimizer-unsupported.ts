// Detects scenarios the optimizer cannot compute without user action: today only an unconfigured CBP election,
// pre-checked here so the page can show the Unsupported callout without running the full pipeline.

import { validateCbpResolution } from './cbp-resolution';
import type { ScenarioAggregate } from './scenario-resolution';
import type {
  AccountPayload,
  Aggregate,
  IncomeStreamPayload,
} from '../db/types';

export type UnsupportedScenarioReason = 'cbp-unconfigured';

export interface DetectUnsupportedArgs {
  readonly scenario: ScenarioAggregate;
  readonly scenarios: ReadonlyArray<ScenarioAggregate>;
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
}

/** `'cbp-unconfigured'` when an active CBP account's election is unresolved, else `null`. */
export function detectUnsupportedScenarioFeatures(
  args: DetectUnsupportedArgs,
): UnsupportedScenarioReason | null {
  const cbpAccounts = args.accounts.filter(
    (a) => a.payload.active && a.payload.type === 'RETIREMENT_CASH_BALANCE',
  );
  if (cbpAccounts.length === 0) return null;
  const validation = validateCbpResolution({
    scenarioId: args.scenario.id,
    scenarios: args.scenarios,
    accounts: cbpAccounts,
    incomeStreams: args.incomeStreams,
  });
  return validation.ok ? null : 'cbp-unconfigured';
}
