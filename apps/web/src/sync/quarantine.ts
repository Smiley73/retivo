/**
 * Per-device quarantine record for sync rows that fail to decrypt.
 * The server stores every payload opaquely and
 * holds no household key, so it can only check envelope shape —
 * quarantine of a genuinely undecryptable row is entirely client-side.
 *
 * Kept out of `SyncContext.tsx` (a documented shape-limit exception whose
 * header requires a change adding ≥ 5 lines to re-justify it) — this module
 * owns the record-keeping; `SyncContext.tsx` only wires one call into it.
 *
 * Durable (persisted on the `deviceMetadata` singleton IDB row — a local-only,
 * non-aggregate store; adding a field needs no `DB_VERSION` bump), per-device,
 * and bounded (an attacker able to push many bad rows must not grow this list
 * without limit — oldest entries are evicted first). Never stores the
 * ciphertext, only the aggregate identity + version + a first-seen stamp.
 */
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
 * This device's last readable local copy of every aggregate a `clearFirst`
 * bootstrap just quarantined. The
 * transport has already dropped those rows from the response, so a wipe +
 * refill would delete the last copy this device can still read and never
 * bring it back; halting the refresh instead wedged the `CURSOR_EXPIRED`
 * auto-recovery forever on one poisoned row. The applier reads these BEFORE
 * `clearAllStores()` and re-puts them after — at their old local version, so
 * a later good server copy still applies over them, exactly as the
 * incremental pull path already treats a quarantined row. Tombstones are
 * preserved too (a locally-deleted row stays deleted). Rows of a type this
 * bundle does not know, or with no local copy, are simply absent.
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

/** Bound on the persisted list — an attacker able to push many undecryptable
 *  rows must not grow this list without limit. Oldest entries evicted first. */
export const MAX_QUARANTINED_ROWS = 200;

function sameAggregate(
  a: { aggregateId: string; aggregateType: string },
  b: { aggregateId: string; aggregateType: string },
): boolean {
  return a.aggregateId === b.aggregateId && a.aggregateType === b.aggregateType;
}

/**
 * Pure merge of a pull/bootstrap decrypt outcome into the existing bounded
 * list — exported for direct unit coverage. `resolved` entries (a later
 * version of the same aggregate that DID decrypt) are removed first; new
 * `quarantined` entries are then added (skipped if already present), and the
 * result is capped to {@link MAX_QUARANTINED_ROWS} by dropping the oldest
 * `firstSeenAt` entries.
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
 * Persist a pull/bootstrap decrypt outcome to the device's bounded
 * quarantine list and emit a `recordSyncWarn` breadcrumb for every newly
 * quarantined row — never the ciphertext, only aggregate identity + version.
 * A no-op when the outcome carries neither a new quarantine nor a resolution.
 *
 * If no `deviceMetadata` row exists yet (quarantine racing an unfinished
 * first bootstrap), seeds it with an empty identity rather than dropping the
 * outcome — `deviceId`/`syncCursor` are filled in by the sync loop's own
 * writes to the same singleton row.
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
