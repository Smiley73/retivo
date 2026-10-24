// Per-device quarantine of sync rows that fail to decrypt (the server holds no household key, so this is client-side).
// Persisted on the `deviceMetadata` row (no `DB_VERSION` bump), bounded with oldest evicted first; never stores ciphertext.
import {
  getAggregateIncludingDeleted,
  isKnownAggregateType,
  updateDeviceMetadata,
} from '../db/store.js';
import { recordSyncWarn } from '../lib/diagnostics/logger.js';
import type {
  Aggregate,
  AggregateType,
  DeviceMetadata,
  QuarantinedSyncRow,
} from '../db/types.js';

export type { QuarantinedSyncRow };

/**
 * This device's last readable local copy of every aggregate a `clearFirst` bootstrap just quarantined. The transport
 * already dropped those rows from the response, so a wipe and refill would delete the last readable copy for good, and
 * halting the refresh instead wedged `CURSOR_EXPIRED` auto-recovery on one poisoned row. The applier reads these before
 * `clearAllStores()` and re-puts them after, at their old local version so a later good server copy still applies over
 * them (tombstones included). Unknown types and rows with no local copy are absent.
 */
export async function readQuarantinedLocalCopies(
  quarantined: readonly { aggregateId: string; aggregateType: string }[],
): Promise<{ type: AggregateType; row: Aggregate }[]> {
  const copies: { type: AggregateType; row: Aggregate }[] = [];
  for (const { aggregateId, aggregateType } of quarantined) {
    if (!isKnownAggregateType(aggregateType)) continue;
    const row = await getAggregateIncludingDeleted(aggregateType, aggregateId);
    if (row) copies.push({ type: aggregateType, row });
  }
  return copies;
}

/** Bound on the persisted list; oldest entries are evicted first. */
export const MAX_QUARANTINED_ROWS = 200;

function sameAggregate(
  a: { aggregateId: string; aggregateType: string },
  b: { aggregateId: string; aggregateType: string },
): boolean {
  return a.aggregateId === b.aggregateId && a.aggregateType === b.aggregateType;
}

/**
 * Pure merge of a decrypt outcome into the bounded list: `resolved` entries are removed, new `quarantined` ones added
 * (skipping duplicates), then capped at {@link MAX_QUARANTINED_ROWS} by dropping the oldest `firstSeenAt`.
 */
export function applyQuarantineOutcome(
  existing: readonly QuarantinedSyncRow[] | undefined,
  outcome: {
    quarantined: readonly Omit<QuarantinedSyncRow, 'firstSeenAt'>[];
    resolved: readonly { aggregateId: string; aggregateType: string }[];
  },
  now: number,
): QuarantinedSyncRow[] {
  let list = (existing ?? []).filter(
    (row) => !outcome.resolved.some((r) => sameAggregate(r, row)),
  );
  for (const entry of outcome.quarantined) {
    if (list.some((row) => sameAggregate(row, entry))) continue;
    list = [...list, { ...entry, firstSeenAt: now }];
  }
  if (list.length > MAX_QUARANTINED_ROWS) {
    list = [...list]
      .sort((a, b) => a.firstSeenAt - b.firstSeenAt)
      .slice(list.length - MAX_QUARANTINED_ROWS);
  }
  return list;
}

/**
 * Persists a decrypt outcome to the bounded list and emits a `recordSyncWarn` breadcrumb per newly quarantined row
 * (identity and version, never ciphertext). A no-op when there is nothing new or resolved. With no `deviceMetadata` row
 * yet (quarantine racing the first bootstrap) it seeds an empty identity that the sync loop's own writes fill in.
 */
export async function recordDecryptOutcome(outcome: {
  quarantined: readonly Omit<QuarantinedSyncRow, 'firstSeenAt'>[];
  resolved: readonly { aggregateId: string; aggregateType: string }[];
}): Promise<void> {
  if (outcome.quarantined.length === 0 && outcome.resolved.length === 0) return;
  for (const entry of outcome.quarantined) {
    recordSyncWarn('[sync] quarantined undecryptable row', {
      aggregateId: entry.aggregateId,
      aggregateType: entry.aggregateType,
      version: entry.version,
    });
  }
  await updateDeviceMetadata((current) => {
    const base: DeviceMetadata =
      current ?? { deviceId: '', syncCursor: '', lastSyncedAt: null, displayName: '' };
    return {
      ...base,
      quarantinedRows: applyQuarantineOutcome(base.quarantinedRows, outcome, Date.now()),
    };
  });
}
