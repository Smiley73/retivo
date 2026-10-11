/**
 * Bootstrap returns the latest workspace snapshot from S3 plus all
 * post-snapshot mutations from MutationLog, merged into a single
 * round-trip.
 *
 * Until the compactor has written a snapshot to S3, `latestSnapshotId` is
 * null and bootstrap returns an empty snapshot + the entire mutation
 * log (which is fine at single-household scale during development).
 */
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
  /**
   * The stored zero-knowledge freshness head, echoed
   * opaquely so the client can verify the MAC + set its initial pin.
   * Omitted when no head has been stored yet.
   */
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
    // Drop snapshot rows for retired aggregate types — see aggregate-types.ts.
    // The snapshot is a frozen JSON in S3, so a retired type can survive
    // there until the next compaction even after MutationLog is purged.
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
      // Echo the opaque freshness head when one is stored.
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

  /**
   * Incident-context log (householdId only — safe) for an explicit client
   * `force=true`, so forced bootstraps still show up in the logs. Extracted
   * from `bootstrap()` to keep it within the function-shape limit.
   */
  private logForcedRequest(householdId: string): void {
    this.logger.log('Forced bootstrap requested', { householdId });
  }

  /**
   * Replay every mutation since the snapshot's cursor. The cursor advances
   * past filtered rows so retired-type rows don't get refetched on every
   * bootstrap; only the row body is suppressed. Returns the replayed changes
   * plus the cursor the client should resume from. Extracted from
   * `bootstrap()` to keep it within the function-shape limit; behavior is
   * unchanged.
   */
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

  /**
   * Enforce the 5 MB compressed cap on the ACTUAL gzipped size, not an
   * uncompressed-byte estimate. Every payload is incompressible
   * ciphertext, so the old `uncompressed > 5MB × 4` allowance
   * (which assumed ~4:1 gzip on JSON) silently raised the 5 MB
   * compressed cap to ~20 MB. Bootstrap is throttled at 30/hr, so the gzip
   * CPU cost here is acceptable. Extracted from `bootstrap()` to keep it
   * within the function-shape limit; behavior is unchanged.
   */
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
