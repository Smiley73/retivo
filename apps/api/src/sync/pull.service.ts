/**
 * Sync pull. Range-queries MutationLog from the supplied cursor and
 * returns at most 100 mutations per page. Cursor is the last
 * sequenceId returned (KSUID); next call passes that as `since`.
 *
 * Cursor expiry: the compactor stamps `mutationLogCursorBase` on
 * WorkspaceMeta after every cursor-bound delete sweep — anything ≤ that
 * KSUID has been rolled into a snapshot and purged from MutationLog.
 * If the caller's `since` predates that watermark, an incremental pull
 * would silently miss data, so we throw `CURSOR_EXPIRED` (409) and let
 * the client auto-bootstrap to recover.
 */
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import type { PullResponseBody } from '@retirement/contracts';
import { MutationLogRepository } from '../dynamo/mutation-log.repository.js';
import { WorkspaceMetaRepository } from '../dynamo/workspace-meta.repository.js';
import type { MutationLogRow } from '../dynamo/types.js';
import { isActiveAggregateType } from './aggregate-types.js';

export interface PulledMutation {
  aggregateId: string;
  aggregateType: string;
  operation: 'create' | 'update' | 'delete';
  payload: unknown;
  version: number;
  schemaVersion: number;
  updatedAt: string;
  deviceId: string;
}

const PAGE_LIMIT = 100;

@Injectable()
export class PullService {
  private readonly logger = new Logger(PullService.name);

  constructor(
    private readonly log: MutationLogRepository,
    private readonly workspaceMeta: WorkspaceMetaRepository,
  ) {}

  async pull(householdId: string, since: string): Promise<PullResponseBody> {
    const meta = await this.workspaceMeta.find(householdId);
    const watermark = meta?.mutationLogCursorBase ?? null;
    if (watermark && since < watermark) {
      // KSUID strings are lexicographically sortable, so a string `<`
      // is a valid sequence compare. A `null` watermark means no
      // compaction has happened yet — the full log is still live, so
      // any cursor (including '0') is in range.
      throw new ConflictException({
        code: 'CURSOR_EXPIRED',
        message:
          'Local sync cursor predates server retention. Re-bootstrap required.',
      });
    }
    const result = await this.log.pageSince(householdId, since, PAGE_LIMIT);
    // Egress filter for retired aggregate types (see aggregate-types.ts).
    // Cursor still advances on filtered rows so a retired-type backlog
    // doesn't stall sync; we just don't ship the rows.
    const changes: PulledMutation[] = [];
    for (const row of result.items) {
      if (!isActiveAggregateType(row.aggregateType)) {
        this.logger.warn(
          `Skipping pulled row with retired aggregateType=${row.aggregateType} (sequenceId=${row.sequenceId})`,
        );
        continue;
      }
      changes.push(toPulled(row));
    }
    return {
      changes,
      newCursor: result.lastSequenceId ?? since,
      hasMore: result.hasMore,
      // Echo the opaque freshness head when one is stored.
      ...(meta?.freshnessCounter !== undefined
        ? {
            freshnessHead: {
              freshnessCounter: meta.freshnessCounter,
              cursorTag: meta.cursorTag ?? '',
            },
          }
        : {}),
    };
  }
}

function toPulled(row: MutationLogRow): PulledMutation {
  let payload: unknown = {};
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = {};
  }
  return {
    aggregateId: row.aggregateId,
    aggregateType: row.aggregateType,
    operation: row.operation,
    payload,
    version: row.version,
    schemaVersion: row.schemaVersion,
    updatedAt: new Date(row.timestamp).toISOString(),
    deviceId: row.deviceId,
  };
}
