// Sync pull: range-queries MutationLog from the cursor, 100 per page. A `since` below `mutationLogCursorBase` throws
// CURSOR_EXPIRED (409), since an incremental pull would silently miss compacted data.
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
      // KSUID strings sort lexically, so string `<` compares them. A null watermark means nothing was compacted, so any cursor is in range.
      throw new ConflictException({
        code: 'CURSOR_EXPIRED',
        message:
          'Local sync cursor predates server retention. Re-bootstrap required.',
      });
    }
    const result = await this.log.pageSince(householdId, since, PAGE_LIMIT);
    // The cursor advances past retired-type rows so a backlog of them cannot stall sync.
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
