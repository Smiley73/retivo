/**
 * What a tool reads: the workspace's aggregates and how fresh they are, loaded
 * through `db/store` and `lib/projection-inputs` so it runs from a socket event
 * with no React in sight. A tool never reads anything the share view or the
 * envelope does not then filter; this module only gathers.
 */
import { listAggregates, listPendingMutations, readDeviceMetadata } from '../../db/store';
import type { Aggregate } from '../../db/types';
import { loadProjectionInputs, type ProjectionInputs } from '../../lib/projection-inputs';
import type { ScenarioAggregate } from '../../lib/scenario-resolution';
import type { ShareSource } from '../sharing/view';

export interface DataFreshness {
  /** ISO time of the last completed sync, or `null` when this device never synced. */
  lastSyncedAt: string | null;
  /** Edits made on this device that have not reached the server yet. */
  pendingLocalChanges: number;
}

export interface Workspace extends ProjectionInputs {
  /** Read only to mask the household name; never emitted. */
  households: ReadonlyArray<Aggregate>;
  scenarios: ScenarioAggregate[];
  freshness: DataFreshness;
}

/** Reads the whole workspace once. Every aggregate list comes from the store, so a deleted row is already gone. */
export async function loadWorkspace(): Promise<Workspace> {
  const [inputs, households, scenarios, metadata, pending] = await Promise.all([
    loadProjectionInputs(),
    listAggregates('household'),
    listAggregates('scenario') as Promise<ScenarioAggregate[]>,
    readDeviceMetadata(),
    listPendingMutations(),
  ]);
  return {
    ...inputs,
    households,
    scenarios,
    freshness: { lastSyncedAt: metadata?.lastSyncedAt ?? null, pendingLocalChanges: pending.length },
  };
}

/** The share view's input: every list in full, because the view masks with the members and households. */
export function shareSourceOf(workspace: Workspace): ShareSource {
  return {
    households: workspace.households,
    members: workspace.members,
    accounts: workspace.accounts,
    balances: workspace.balances,
    socialSecurity: workspace.ssBenefits,
    scenarios: workspace.scenarios,
    expenseCategories: workspace.categories,
    expenses: workspace.expenses,
    incomeStreams: workspace.incomeStreams,
  };
}
