/**
 * Detect scenarios the optimizer cannot compute without user action.
 *
 * With `runBalanceProjection` threading the full BPP pipeline for every
 * candidate pair, the only remaining case requiring user action *before* the
 * optimizer can run is an **unconfigured CBP** account — the user must pick a
 * lump-sum vs annuity election in Balance Projection's remediation banner
 * first. `validateCbpResolution` returns `{ ok: false }` and the runner
 * refuses; the worker pre-checks here so the page can render the Unsupported
 * callout instantly without invoking the full pipeline.
 */
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

/**
 * Returns `'cbp-unconfigured'` when the scenario has an active CBP
 * account whose election is unresolved; `null` otherwise. Single literal
 * type so callers can render the one user-facing copy directly.
 */
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
