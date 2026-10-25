// Bootstrap: the latest S3 snapshot plus every later MutationLog mutation in one round-trip.
// Before the compactor writes a snapshot it returns an empty snapshot and the whole log.
import {
  Injectable,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import { gzipSync } from 'node:zlib';
import type { BootstrapResponseBody } from '@retirement/contracts';
import { MutationLogRepository } from '../dynamo/mutation-log.repository.js';
import { WorkspaceMetaRepository } from '../dynamo/workspace-meta.repository.js';
import type { PulledMutation } from './pull.service.js';
import { isActiveAggregateType } from './aggregate-types.js';
import {
  SnapshotsService,
  type SnapshotAggregate,
} from './snapshots.service.js';

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

interface BootstrapResponse {
  snapshotId: string | null;
  workspaceSnapshot: {
    householdId: string;
    aggregates: SnapshotAggregate[];
  };
  postSnapshotMutations: PulledMutation[];
  syncCursor: string;
  timestamp: string;
  /** The stored freshness head, echoed opaquely; omitted until one has been stored. */
  freshnessHead?: { freshnessCounter: number; cursorTag: string } | null;
}

@Injectable()
export class BootstrapService {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(
    private readonly meta: WorkspaceMetaRepository,
    private readonly log: MutationLogRepository,
    private readonly snapshots: SnapshotsService,
  ) {}

  async bootstrap(
    householdId: string,
    forced = false,
  ): Promise<BootstrapResponseBody> {
    if (forced) {
      this.logForcedRequest(householdId);
    }
    const meta = await this.meta.createIfMissing(householdId);
    const fetched = await this.snapshots.fetch(
      meta.householdId,
      meta.latestSnapshotId,
    );
    const snapshotRaw = fetched?.aggregates ?? [];
    // A frozen snapshot can still carry a retired aggregate type until the next compaction.
    const snapshot = snapshotRaw.filter((a) => {
      if (isActiveAggregateType(a.aggregateType)) return true;
      this.logger.warn(
        `Dropping snapshot row with retired aggregateType=${a.aggregateType} (id=${a.id})`,
      );
      return false;
    });

    const { changes, syncCursor } = await this.collectPostSnapshotMutations(
      meta.householdId,
      meta.latestSnapshotCursor,
    );

    const response: BootstrapResponse = {
      snapshotId: meta.latestSnapshotId,
      workspaceSnapshot: {
        householdId: meta.householdId,
        aggregates: snapshot,
      },
      postSnapshotMutations: changes,
      syncCursor,
      timestamp: new Date().toISOString(),
      ...(meta.freshnessCounter !== undefined
        ? {
            freshnessHead: {
              freshnessCounter: meta.freshnessCounter,
              cursorTag: meta.cursorTag ?? '',
            },
          }
        : {}),
    };

    this.assertWithinResponseCap(response);
    return response;
  }

  // Logs householdId only, so forced bootstraps stay visible in the logs.
  private logForcedRequest(householdId: string): void {
    this.logger.log('Forced bootstrap requested', { householdId });
  }

  // The cursor advances past filtered retired-type rows so they are not refetched on every bootstrap.
  private async collectPostSnapshotMutations(
    householdId: string,
    latestSnapshotCursor: string | null | undefined,
  ): Promise<{ changes: PulledMutation[]; syncCursor: string }> {
    const since = latestSnapshotCursor ?? '0';
    const changes: PulledMutation[] = [];
    let cursor = since;
    let sawAnyRow = false;
    while (true) {
      const page = await this.log.pageSince(householdId, cursor, 1000);
      if (page.items.length > 0) sawAnyRow = true;
      for (const row of page.items) {
        if (!isActiveAggregateType(row.aggregateType)) {
          this.logger.warn(
            `Dropping bootstrap row with retired aggregateType=${row.aggregateType} (sequenceId=${row.sequenceId})`,
          );
          continue;
        }
        changes.push({
          aggregateId: row.aggregateId,
          aggregateType: row.aggregateType,
          operation: row.operation,
          payload: safeParseJson(row.payload),
          version: row.version,
          schemaVersion: row.schemaVersion,
          updatedAt: new Date(row.timestamp).toISOString(),
          deviceId: row.deviceId,
        });
      }
      if (!page.hasMore || !page.lastSequenceId) break;
      cursor = page.lastSequenceId;
    }
    return { changes, syncCursor: sawAnyRow ? cursor : since };
  }

  // Measures the actual gzipped size: payloads are incompressible ciphertext, so an uncompressed-size allowance would let ~20 MB through the 5 MB cap.
  private assertWithinResponseCap(response: BootstrapResponse): void {
    const gzippedBytes = gzipSync(
      Buffer.from(JSON.stringify(response), 'utf8'),
    ).byteLength;
    if (gzippedBytes > MAX_RESPONSE_BYTES) {
      throw new PayloadTooLargeException({
        code: 'BOOTSTRAP_TOO_LARGE',
        message:
          'Workspace exceeds the 5 MB compressed bootstrap cap. The presigned-URL escape hatch is not implemented in v1.',
        details: { gzippedBytes },
      });
    }
  }
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
